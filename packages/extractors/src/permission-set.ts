import { readFile } from 'node:fs/promises';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName } from './path-utils.js';

const PERMSET_FILE_SUFFIX = '.permissionset-meta.xml';
const ROOT_ELEMENT = 'PermissionSet';
const EXTRACTOR_SOURCE = 'permission-set-extractor';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Normalize an XML child into an array; `[]` for undefined/null. */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Coerce an XML scalar to boolean; non-`true` values (per SF defaults) become false. */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/**
 * Read and strictly-validate a file as XML. Validates before parsing so
 * malformed input surfaces as `parse-error` (fast-xml-parser's `parse()`
 * silently truncates).
 */
const readAndValidateXml = async (
  path: string,
): Promise<Result<string, ExtractorError>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(path, 'utf-8');
  } catch (cause: unknown) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      (cause as { code?: string }).code === 'ENOENT'
    ) {
      return err({ kind: 'file-not-found', path, message: 'file not found' });
    }
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return err({ kind: 'parse-error', path, message: validation.err.msg });
  }
  return ok(xmlText);
};

/** Locate `<PermissionSet>` root and verify the required `<label>` element. */
const validateRoot = (
  parsed: Record<string, unknown>,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const rootObj = root as Record<string, unknown>;
  if (rootObj['label'] === undefined) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <label>',
    });
  }
  return ok(rootObj);
};

/** Iterate object-valued XML entries under `rootObj[key]` (array or scalar). */
function* iterEntries(
  rootObj: Record<string, unknown>,
  key: string,
): Generator<Record<string, unknown>> {
  for (const raw of toArray(rootObj[key])) {
    if (typeof raw === 'object' && raw !== null) yield raw as Record<string, unknown>;
  }
}

/** Construct a `grantedBy` edge with this extractor's standard envelope. */
const grantedByEdge = (
  fromId: string,
  toId: string,
  properties: Readonly<Record<string, unknown>>,
): Edge => ({
  fromId,
  toId,
  edgeType: 'grantedBy',
  confidence: 'declared',
  source: EXTRACTOR_SOURCE,
  properties,
});

/** Emit one `grantedBy` edge per `<objectPermissions>` entry granting any permission. */
const buildObjectEdges = (
  rootObj: Record<string, unknown>,
  fromId: string,
): Edge[] => {
  const edges: Edge[] = [];
  for (const entry of iterEntries(rootObj, 'objectPermissions')) {
    const flags = {
      allowCreate: coerceBoolean(unwrapSingle(entry['allowCreate'])),
      allowDelete: coerceBoolean(unwrapSingle(entry['allowDelete'])),
      allowEdit: coerceBoolean(unwrapSingle(entry['allowEdit'])),
      allowRead: coerceBoolean(unwrapSingle(entry['allowRead'])),
      modifyAllRecords: coerceBoolean(unwrapSingle(entry['modifyAllRecords'])),
      viewAllRecords: coerceBoolean(unwrapSingle(entry['viewAllRecords'])),
    };
    if (!Object.values(flags).some((v) => v)) continue;
    const object = String(unwrapSingle(entry['object']) ?? '');
    edges.push(grantedByEdge(fromId, `CustomObject:${object}`, flags));
  }
  return edges;
};

/**
 * Emit one `grantedBy` edge per `<fieldPermissions>` with `editable` or
 * `readable` true. Returns `malformed-input` if any `<field>` lacks an
 * `Object.Field` dot.
 */
const buildFieldEdges = (
  rootObj: Record<string, unknown>,
  fromId: string,
  path: string,
): Result<Edge[], ExtractorError> => {
  const edges: Edge[] = [];
  for (const entry of iterEntries(rootObj, 'fieldPermissions')) {
    const field = String(unwrapSingle(entry['field']) ?? '');
    if (!field.includes('.')) {
      return err({
        kind: 'malformed-input',
        path,
        message: `field reference ${field} not in Object.Field form`,
      });
    }
    const editable = coerceBoolean(unwrapSingle(entry['editable']));
    const readable = coerceBoolean(unwrapSingle(entry['readable']));
    if (!editable && !readable) continue;
    edges.push(grantedByEdge(fromId, `CustomField:${field}`, { editable, readable }));
  }
  return ok(edges);
};

/** Emit one `grantedBy` edge per `<classAccesses>` entry with `<enabled>` true. */
const buildClassEdges = (
  rootObj: Record<string, unknown>,
  fromId: string,
): Edge[] => {
  const edges: Edge[] = [];
  for (const entry of iterEntries(rootObj, 'classAccesses')) {
    if (!coerceBoolean(unwrapSingle(entry['enabled']))) continue;
    const apexClass = String(unwrapSingle(entry['apexClass']) ?? '');
    edges.push(grantedByEdge(fromId, `ApexClass:${apexClass}`, { enabled: true }));
  }
  return edges;
};

/**
 * Emit one `grantedBy` edge per `<pageAccesses>` entry with `<enabled>` true —
 * the Visualforce pages this permission set lets a user LOAD.
 *
 * GUEST-PAGE-ACCESS parity with the profile extractor: `<pageAccesses>` was the
 * one access element neither container walked, so no `grantedBy` edge to a
 * `VisualforcePage` existed anywhere in the graph and no consumer could answer
 * "who can load this page". A Visualforce page RUNS its controller Apex, so the
 * grant is a code-reachability grant, not a cosmetic one. Same shape and the
 * same `<enabled>` gate as `classAccesses` above; an empty `<apexPage>` is
 * dropped rather than minting a nameless id.
 */
const buildPageEdges = (
  rootObj: Record<string, unknown>,
  fromId: string,
): Edge[] => {
  const edges: Edge[] = [];
  for (const entry of iterEntries(rootObj, 'pageAccesses')) {
    if (!coerceBoolean(unwrapSingle(entry['enabled']))) continue;
    const apexPage = String(unwrapSingle(entry['apexPage']) ?? '');
    if (apexPage.length === 0) continue;
    edges.push(grantedByEdge(fromId, `VisualforcePage:${apexPage}`, { enabled: true }));
  }
  return edges;
};

/**
 * Emit one `grantedBy` edge per `<flowAccesses>` entry with `<enabled>` true —
 * the flows this permission set lets a user RUN (`flowAccess: true` marker).
 * (P11-USER-ability-run)
 */
const buildFlowEdges = (
  rootObj: Record<string, unknown>,
  fromId: string,
): Edge[] => {
  const edges: Edge[] = [];
  for (const entry of iterEntries(rootObj, 'flowAccesses')) {
    if (!coerceBoolean(unwrapSingle(entry['enabled']))) continue;
    const flow = String(unwrapSingle(entry['flow']) ?? '');
    if (flow.length === 0) continue;
    edges.push(grantedByEdge(fromId, `Flow:${flow}`, { flowAccess: true }));
  }
  return edges;
};

/**
 * CR-CAP-10: emit one `grantedBy` edge per `<customPermissions>` entry with
 * `<enabled>` true — the custom permissions this permission set CONFERS. The
 * grant element is `<customPermissions>` with `<name>` (the CustomPermission
 * DeveloperName) and `<enabled>` (the gate, identical to classAccesses /
 * flowAccesses). `enabled=false` confers nothing and is skipped. The edge
 * target id is the flat `CustomPermission:{name}` (CR-CAP-15's definition node);
 * a managed-package name whose definition is not in the vault produces a
 * `targetMissing` edge the consumer discloses (it does NOT fabricate a node).
 */
const buildCustomPermissionEdges = (
  rootObj: Record<string, unknown>,
  fromId: string,
): Edge[] => {
  const edges: Edge[] = [];
  for (const entry of iterEntries(rootObj, 'customPermissions')) {
    if (!coerceBoolean(unwrapSingle(entry['enabled']))) continue;
    const name = String(unwrapSingle(entry['name']) ?? '');
    if (name.length === 0) continue;
    edges.push(grantedByEdge(fromId, `CustomPermission:${name}`, { enabled: true }));
  }
  return edges;
};

/**
 * Return enabled `<userPermissions>` names, sorted alphabetically. Surfaced
 * on `Node.properties.userPermissions` rather than as edges because system
 * permissions don't correspond to graph nodes in v0.1.
 */
const collectEnabledUserPermissions = (
  rootObj: Record<string, unknown>,
): string[] => {
  const names: string[] = [];
  for (const entry of iterEntries(rootObj, 'userPermissions')) {
    if (!coerceBoolean(unwrapSingle(entry['enabled']))) continue;
    const name = unwrapSingle(entry['name']);
    if (name === undefined || name === null) continue;
    names.push(String(name));
  }
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/**
 * Collect `<applicationVisibilities>` entries (PermissionSets can grant app
 * access too). Each carries `<application>` + `<visible>` (`<default>` is not
 * meaningful on a permission set, so it is coerced and kept for shape parity).
 * Always returns an array; `[]` when absent.
 */
const collectApplicationVisibilities = (
  rootObj: Record<string, unknown>,
): Array<{ application: string; default: boolean; visible: boolean }> => {
  const out: Array<{ application: string; default: boolean; visible: boolean }> = [];
  for (const entry of iterEntries(rootObj, 'applicationVisibilities')) {
    const appRaw = unwrapSingle(entry['application']);
    if (appRaw === undefined || appRaw === null) continue;
    out.push({
      application: String(appRaw),
      default: coerceBoolean(unwrapSingle(entry['default'])),
      visible: coerceBoolean(unwrapSingle(entry['visible'])),
    });
  }
  return out;
};

/**
 * Collect `<tabSettings>` (the PermissionSet element name for tab visibility —
 * Profiles use `<tabVisibilities>`). Each carries `<tab>` + `<visibility>`
 * (`Available` | `Visible` | `None` on a permission set). Normalised onto the
 * same `properties.tabVisibilities` key as Profiles so the consumer tools read
 * one surface. Always returns an array; `[]` when absent.
 */
const collectTabVisibilities = (
  rootObj: Record<string, unknown>,
): Array<{ tab: string; visibility: string }> => {
  const out: Array<{ tab: string; visibility: string }> = [];
  for (const element of ['tabSettings', 'tabVisibilities']) {
    for (const entry of iterEntries(rootObj, element)) {
      const tabRaw = unwrapSingle(entry['tab']);
      const visibilityRaw = unwrapSingle(entry['visibility']);
      if (tabRaw === undefined || tabRaw === null) continue;
      if (visibilityRaw === undefined || visibilityRaw === null) continue;
      out.push({ tab: String(tabRaw), visibility: String(visibilityRaw) });
    }
  }
  return out;
};

/** One entry under `properties.recordTypeVisibilities`. */
interface RecordTypeVisibilityEntry {
  readonly recordType: string;
  readonly default: boolean;
  readonly visible: boolean | null;
}

/**
 * Collect `<recordTypeVisibilities>` entries verbatim from the permission set
 * XML. `<default>` is always present per the Salesforce schema. `<visible>` was
 * added in a later API version and may be absent on older orgs — surface that
 * as `null` so downstream tools can distinguish "absent" from "false". Mirror
 * of the profile extractor's helper so `recordtype_availability`,
 * `layout_for_user`, and `why_cant_user_see_record` read one shape from both
 * Profile and PermissionSet nodes. Always returns an array; `[]` when the
 * element is absent (so tools tell "extracted, none" from "never extracted").
 */
const collectRecordTypeVisibilities = (
  rootObj: Record<string, unknown>,
): RecordTypeVisibilityEntry[] => {
  const out: RecordTypeVisibilityEntry[] = [];
  for (const entry of iterEntries(rootObj, 'recordTypeVisibilities')) {
    const recordTypeRaw = unwrapSingle(entry['recordType']);
    if (recordTypeRaw === undefined || recordTypeRaw === null) continue;
    const visibleRaw = unwrapSingle(entry['visible']);
    const visible =
      visibleRaw === undefined || visibleRaw === null
        ? null
        : coerceBoolean(visibleRaw);
    out.push({
      recordType: String(recordTypeRaw),
      default: coerceBoolean(unwrapSingle(entry['default'])),
      visible,
    });
  }
  return out;
};

interface GrantCounts {
  readonly objectGrantCount: number;
  readonly fieldGrantCount: number;
  readonly classGrantCount: number;
  readonly pageGrantCount: number;
  readonly userPermissions: readonly string[];
  readonly recordTypeVisibilities: readonly RecordTypeVisibilityEntry[];
  readonly applicationVisibilities: readonly { application: string; default: boolean; visible: boolean }[];
  readonly tabVisibilities: readonly { tab: string; visibility: string }[];
  readonly flowGrantCount: number;
  readonly customPermissionGrantCount: number;
}

/** Assemble the `properties` map for a PermissionSet node. */
const buildProperties = (
  rootObj: Record<string, unknown>,
  counts: GrantCounts,
): Readonly<Record<string, unknown>> => {
  const descriptionRaw = unwrapSingle(rootObj['description']);
  const licenseRaw = unwrapSingle(rootObj['license']);
  return {
    description: descriptionRaw === undefined ? null : String(descriptionRaw),
    license: licenseRaw === undefined ? null : String(licenseRaw),
    hasActivationRequired: coerceBoolean(unwrapSingle(rootObj['hasActivationRequired'])),
    ...counts,
  };
};

/**
 * Extract a Node and edges from a `*.permissionset-meta.xml` file.
 *
 * Walks four permission collections under `<PermissionSet>` to emit
 * `grantedBy` edges (sorted by `toId` for determinism):
 *
 *   - `objectPermissions` -> `CustomObject:{object}` (all-false skipped)
 *   - `fieldPermissions` -> `CustomField:{Object.Field}` (both-false skipped)
 *   - `classAccesses` -> `ApexClass:{apexClass}` (disabled skipped)
 *   - `flowAccesses` -> `Flow:{flow}` (disabled skipped)
 *   - `customPermissions` -> `CustomPermission:{name}` (`enabled=false` skipped) (CR-CAP-10)
 *
 * `userPermissions` are surfaced on `Node.properties.userPermissions`
 * (sorted) rather than as edges since system permissions don't correspond
 * to graph nodes in v0.1.
 *
 * `<recordTypeVisibilities>` surfaces on `Node.properties.recordTypeVisibilities`
 * (array of `{ recordType, default, visible }`, verbatim order). `visible` is
 * `null` when the element is absent (older orgs predate the API version that
 * added it). Always present (`[]` when the source XML has zero entries) so the
 * `recordtype_availability` / `layout_for_user` / `why_cant_user_see_record`
 * tools read the SAME shape from PermissionSet nodes as from Profile nodes,
 * rather than under-reporting permission-set record-type grants.
 *
 * Returns an `ExtractorError` for documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<label>`, or a `<field>` value lacking the `Object.Field` dot).
 *
 * @example
 *   const result = await extractPermissionSet(
 *     'permissionsets/Conga_Custom_Admin.permissionset-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'PermissionSet:Conga_Custom_Admin'
 */
export const extractPermissionSet = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale Profile/PermissionSet/Layout XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion
  // cap of 1000). Catch it here so a single pathological file becomes a
  // per-file `parse-error` rather than aborting the refresh pipeline.
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlResult.value) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const rootResult = validateRoot(parsed, path);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const apiName = deriveComponentApiName(path, PERMSET_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;

  const objectEdges = buildObjectEdges(rootObj, nodeId);
  const fieldEdgesResult = buildFieldEdges(rootObj, nodeId, path);
  if (!fieldEdgesResult.ok) return fieldEdgesResult;
  const fieldEdges = fieldEdgesResult.value;
  const classEdges = buildClassEdges(rootObj, nodeId);
  const pageEdges = buildPageEdges(rootObj, nodeId);
  const flowEdges = buildFlowEdges(rootObj, nodeId);
  const customPermissionEdges = buildCustomPermissionEdges(rootObj, nodeId);
  const userPermissions = collectEnabledUserPermissions(rootObj);
  const recordTypeVisibilities = collectRecordTypeVisibilities(rootObj);
  const applicationVisibilities = collectApplicationVisibilities(rootObj);
  const tabVisibilities = collectTabVisibilities(rootObj);

  const edges: Edge[] = [
    ...objectEdges,
    ...fieldEdges,
    ...classEdges,
    ...pageEdges,
    ...flowEdges,
    ...customPermissionEdges,
  ].sort(
    (a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0),
  );

  const node: Node = {
    id: nodeId,
    type: 'PermissionSet',
    apiName,
    label: String(unwrapSingle(rootObj['label'])),
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: buildProperties(rootObj, {
      objectGrantCount: objectEdges.length,
      fieldGrantCount: fieldEdges.length,
      classGrantCount: classEdges.length,
      pageGrantCount: pageEdges.length,
      userPermissions,
      recordTypeVisibilities,
      applicationVisibilities,
      tabVisibilities,
      flowGrantCount: flowEdges.length,
      customPermissionGrantCount: customPermissionEdges.length,
    }),
  };

  return ok({ nodes: [node], edges });
};
