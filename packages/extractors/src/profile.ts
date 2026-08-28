import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const PROFILE_FILE_SUFFIX = '.profile-meta.xml';
const ROOT_ELEMENT = 'Profile';
const EXTRACTOR_SOURCE = 'profile-extractor';

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
 * Derive the Profile's API name from its filename. Profile names may
 * contain spaces and URL-encoded characters (e.g., `%20`, `%2F`); these
 * are decoded before forming the canonical ID. Malformed escape sequences
 * surface as `malformed-input`.
 */
const deriveProfileName = (
  path: string,
): Result<string, ExtractorError> => {
  const base = basename(path);
  const stem = base.endsWith(PROFILE_FILE_SUFFIX)
    ? base.slice(0, base.length - PROFILE_FILE_SUFFIX.length)
    : base;
  try {
    return ok(decodeURIComponent(stem));
  } catch {
    return err({
      kind: 'malformed-input',
      path,
      message: 'malformed URL encoding in filename',
    });
  }
};

/**
 * Read and strictly-validate a file as XML. fast-xml-parser's `parse()`
 * silently truncates on mismatched tags; we validate first so malformed
 * input surfaces as `parse-error` rather than a misleading partial result.
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

/** Locate `<Profile>` root and verify the required `<userLicense>` element. */
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
  if (rootObj['userLicense'] === undefined) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <userLicense>',
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
 * the Visualforce pages this profile may LOAD.
 *
 * GUEST-PAGE-ACCESS: this was the one access element the profile walk skipped,
 * and its absence was load-bearing. `sfi.guest_exposure_report` composes guest
 * reach out of this profile's `grantedBy` edges, so with no
 * `Profile -> VisualforcePage` edge in the graph a page a GUEST profile enables
 * could never become a finding — that tool shipped a permanent
 * "the profile extractor emits no such edge" disclosure in place of an answer,
 * while the `<pageAccesses>` blocks sat in the retrieved XML the whole time.
 * A Visualforce page RUNS its controller Apex, so an enabled page on an
 * internet-facing site's guest profile is a real guest-reachable CODE surface,
 * not a cosmetic grant.
 *
 * Shape and guards are identical to {@link buildClassEdges}: element
 * `<pageAccesses><apexPage>X</apexPage><enabled>true|false</enabled>`
 * (VERIFIED against retrieved profile source), the `<enabled>` gate is
 * mandatory (`enabled=false` grants nothing), and an empty `<apexPage>` is
 * dropped rather than minting a `VisualforcePage:` id with no name. The target
 * id is the flat `VisualforcePage:{apexPage}` the VisualforcePage extractor
 * mints; a page name with no retrieved definition becomes a `targetMissing`
 * edge the consumer discloses, never a fabricated node.
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
 * the flows (autolaunched / screen) this profile/permission set may RUN. The
 * `flowAccess: true` marker on the edge distinguishes a run grant from a code
 * (`enabled`) grant. Answers "what flows can this user launch" + (reverse) "who
 * can run this flow". (P11-USER-ability-run)
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
 * `<enabled>` true — the custom permissions this profile CONFERS. Element shape
 * `<customPermissions><name>X</name><enabled>true|false</enabled>` (VERIFIED
 * against real source; the `<enabled>` gate is mandatory — `enabled=false`
 * confers nothing). Symmetric with the permission-set extractor; this vault has
 * 0 profiles using the element, but the Salesforce schema is identical so the
 * parse is forward-looking. The target id is the flat `CustomPermission:{name}`
 * (CR-CAP-15's definition node); a name with no definition becomes a
 * `targetMissing` edge the consumer discloses (no fabricated node).
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

/** Weekday field-name prefixes for `<loginHours>`, in metadata declaration order. */
const LOGIN_HOURS_DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** One declared per-weekday `<loginHours>` window, verbatim off the source XML. */
interface LoginHoursWindow {
  readonly day: string;
  readonly startTime: string;
  readonly endTime: string;
}

/**
 * Read the per-weekday windows off an already-unwrapped `<loginHours>` object.
 * Salesforce declares one `{day}Start`/`{day}End` pair (minutes since
 * midnight, GMT) per restricted weekday; a day with no pair is unrestricted
 * (full 24-hour access), so only complete `Start`+`End` pairs are kept — a
 * lone/partial pair is skipped rather than emitting a half-formed window.
 */
const collectLoginHoursWindows = (
  loginHoursObj: Record<string, unknown>,
): LoginHoursWindow[] => {
  const windows: LoginHoursWindow[] = [];
  for (const day of LOGIN_HOURS_DAYS) {
    const prefix = day.toLowerCase();
    const start = unwrapSingle(loginHoursObj[`${prefix}Start`]);
    const end = unwrapSingle(loginHoursObj[`${prefix}End`]);
    if (start === undefined || start === null) continue;
    if (end === undefined || end === null) continue;
    windows.push({ day, startTime: String(start), endTime: String(end) });
  }
  return windows;
};

/**
 * Collect the profile's login-security restrictions onto properties (login is a
 * Profile-only concern — permission sets don't carry it). `loginHours` is the
 * per-weekday allowed window(s), read off `<loginHours>`'s `{day}Start`/
 * `{day}End` children via {@link collectLoginHoursWindows}; `loginIpRanges` the
 * allowed IP CIDR ranges. Both are surfaced as a count + the raw entries so a
 * tool can answer "is this profile login-restricted". Always present
 * (`{ loginHours: [], loginIpRanges: [] }` when absent) so a consumer can tell
 * "extracted, none" from "never extracted".
 */
const collectLoginRestrictions = (
  rootObj: Record<string, unknown>,
): {
  loginIpRanges: Array<Record<string, string>>;
  loginHoursDefined: boolean;
  loginHours: LoginHoursWindow[];
} => {
  const loginIpRanges: Array<Record<string, string>> = [];
  for (const entry of iterEntries(rootObj, 'loginIpRanges')) {
    const start = unwrapSingle(entry['startAddress']);
    const end = unwrapSingle(entry['endAddress']);
    if (start === undefined || start === null) continue;
    loginIpRanges.push({ startAddress: String(start), endAddress: String(end ?? start) });
  }
  // <loginHours> is a single element with per-weekday <mondayStart>/<mondayEnd>
  // etc. children; its presence means the profile restricts login windows, and
  // the individual weekday pairs (read by collectLoginHoursWindows) ARE those windows.
  const loginHoursRaw = unwrapSingle(rootObj['loginHours']);
  const loginHoursDefined = loginHoursRaw !== undefined && loginHoursRaw !== null;
  const loginHours =
    loginHoursDefined && typeof loginHoursRaw === 'object'
      ? collectLoginHoursWindows(loginHoursRaw as Record<string, unknown>)
      : [];
  return { loginIpRanges, loginHoursDefined, loginHours };
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

/** One entry under `properties.layoutAssignments`. */
interface LayoutAssignmentEntry {
  readonly layout: string;
  readonly recordType: string | null;
}

/** One entry under `properties.recordTypeVisibilities`. */
interface RecordTypeVisibilityEntry {
  readonly recordType: string;
  readonly default: boolean;
  readonly visible: boolean | null;
}

/** One entry under `properties.applicationVisibilities`. */
interface ApplicationVisibilityEntry {
  readonly application: string;
  readonly default: boolean;
  readonly visible: boolean;
}

/** One entry under `properties.tabVisibilities`. */
interface TabVisibilityEntry {
  readonly tab: string;
  readonly visibility: string;
}

/**
 * Collect `<layoutAssignments>` entries verbatim from the profile XML.
 * Each entry preserves the raw `<layout>` form (`Object-Layout Name`)
 * so the `sfi.layout_for_user` MCP tool can parse it as-is. Missing
 * `<recordType>` surfaces as `null` (the "default for object" state).
 * Always returns an array; `[]` when the element is absent. The
 * always-present shape lets the tool distinguish "extractor ran, no
 * entries found" from "extractor never populated the property".
 */
const collectLayoutAssignments = (
  rootObj: Record<string, unknown>,
): LayoutAssignmentEntry[] => {
  const out: LayoutAssignmentEntry[] = [];
  for (const entry of iterEntries(rootObj, 'layoutAssignments')) {
    const layoutRaw = unwrapSingle(entry['layout']);
    if (layoutRaw === undefined || layoutRaw === null) continue;
    const recordTypeRaw = unwrapSingle(entry['recordType']);
    const recordType =
      recordTypeRaw === undefined || recordTypeRaw === null
        ? null
        : String(recordTypeRaw);
    out.push({ layout: String(layoutRaw), recordType });
  }
  return out;
};

/**
 * Collect `<recordTypeVisibilities>` entries verbatim from the profile XML.
 * `<default>` is always present per the Salesforce schema. `<visible>` was
 * added in a later API version and may be absent on older orgs — surface
 * that as `null` so downstream tools can distinguish "absent" from "false".
 * Always returns an array; `[]` when the element is absent.
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

/**
 * Collect `<applicationVisibilities>` entries verbatim. Each carries
 * `<application>` (the CustomApplication api name), `<default>` (is this the
 * profile's default app), and `<visible>` (can the profile open it). Always
 * returns an array; `[]` when absent — the always-present shape lets the
 * app/tab tools distinguish "extracted, none" from "never extracted".
 */
const collectApplicationVisibilities = (
  rootObj: Record<string, unknown>,
): ApplicationVisibilityEntry[] => {
  const out: ApplicationVisibilityEntry[] = [];
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
 * Collect `<tabVisibilities>` entries verbatim. Each carries `<tab>` (the tab
 * api name) and `<visibility>` (the verbatim `DefaultOn` | `DefaultOff` |
 * `Hidden` enum). Always returns an array; `[]` when absent.
 */
const collectTabVisibilities = (
  rootObj: Record<string, unknown>,
): TabVisibilityEntry[] => {
  const out: TabVisibilityEntry[] = [];
  for (const entry of iterEntries(rootObj, 'tabVisibilities')) {
    const tabRaw = unwrapSingle(entry['tab']);
    const visibilityRaw = unwrapSingle(entry['visibility']);
    if (tabRaw === undefined || tabRaw === null) continue;
    if (visibilityRaw === undefined || visibilityRaw === null) continue;
    out.push({ tab: String(tabRaw), visibility: String(visibilityRaw) });
  }
  return out;
};

interface GrantCounts {
  readonly objectGrantCount: number;
  readonly fieldGrantCount: number;
  readonly classGrantCount: number;
  readonly pageGrantCount: number;
  readonly userPermissions: readonly string[];
  readonly layoutAssignments: readonly LayoutAssignmentEntry[];
  readonly recordTypeVisibilities: readonly RecordTypeVisibilityEntry[];
  readonly applicationVisibilities: readonly ApplicationVisibilityEntry[];
  readonly tabVisibilities: readonly TabVisibilityEntry[];
  readonly flowGrantCount: number;
  readonly customPermissionGrantCount: number;
  readonly loginIpRanges: readonly Record<string, string>[];
  readonly loginHoursDefined: boolean;
  readonly loginHours: readonly LoginHoursWindow[];
}

/** Assemble the `properties` map for a Profile node. */
const buildProperties = (
  rootObj: Record<string, unknown>,
  counts: GrantCounts,
): Readonly<Record<string, unknown>> => {
  const descriptionRaw = unwrapSingle(rootObj['description']);
  return {
    description: descriptionRaw === undefined ? null : String(descriptionRaw),
    userLicense: String(unwrapSingle(rootObj['userLicense'])),
    custom: coerceBoolean(unwrapSingle(rootObj['custom'])),
    ...counts,
  };
};

/**
 * Extract a Node and edges from a `*.profile-meta.xml` file.
 *
 * Profiles are treated as permission containers in v0.1 (login hours, IP
 * ranges, UI defaults, and other non-permission aspects are out of scope).
 * Walks four permission collections under `<Profile>` to emit `grantedBy`
 * edges (sorted by `toId`): `objectPermissions` -> `CustomObject:{object}`
 * (all-false skipped); `fieldPermissions` -> `CustomField:{Object.Field}`
 * (both-false skipped); `classAccesses` -> `ApexClass:{apexClass}`
 * (disabled skipped); `flowAccesses` -> `Flow:{flow}` (disabled skipped);
 * `customPermissions` -> `CustomPermission:{name}` (`enabled=false` skipped,
 * CR-CAP-10). Enabled `userPermissions` names are collected onto
 * `Node.properties.userPermissions` (sorted) rather than as edges, since
 * system permissions don't correspond to graph nodes in v0.1.
 *
 * Two non-permission collections surface on `Node.properties` for the
 * `sfi.layout_for_user` MCP tool:
 *
 *   - `<layoutAssignments>` -> `properties.layoutAssignments` (array of
 *     `{ layout, recordType }`). `layout` is the raw XML form
 *     (`Object-Layout Name`); `recordType` is `null` for the profile's
 *     default assignment for an object.
 *   - `<recordTypeVisibilities>` -> `properties.recordTypeVisibilities`
 *     (array of `{ recordType, default, visible }`). `visible` is `null`
 *     when the element is absent (older orgs predate the API version
 *     that added it).
 *
 * Both arrays are always emitted (`[]` when the source XML has zero
 * entries). The always-present shape lets `sfi.layout_for_user`
 * distinguish "no entries" from "extractor never populated this".
 *
 * The profile's API name comes from the filename (minus the suffix), with
 * URL-encoded characters decoded. Profiles have no `<label>` element; the
 * decoded name is used for both `apiName` and `label`.
 *
 * Returns an `ExtractorError` for documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<userLicense>`, a `<field>` value lacking the `Object.Field`
 * dot, or a malformed URL-encoding sequence in the filename).
 *
 * @example
 *   const result = await extractProfile(
 *     'profiles/System%20Administrator.profile-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'Profile:System Administrator'
 */
export const extractProfile = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const nameResult = deriveProfileName(path);
  if (!nameResult.ok) return nameResult;
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

  const apiName = nameResult.value;
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
  const layoutAssignments = collectLayoutAssignments(rootObj);
  const recordTypeVisibilities = collectRecordTypeVisibilities(rootObj);
  const applicationVisibilities = collectApplicationVisibilities(rootObj);
  const tabVisibilities = collectTabVisibilities(rootObj);
  const { loginIpRanges, loginHoursDefined, loginHours } = collectLoginRestrictions(rootObj);

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
    type: 'Profile',
    apiName,
    label: apiName,
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
      layoutAssignments,
      recordTypeVisibilities,
      applicationVisibilities,
      tabVisibilities,
      flowGrantCount: flowEdges.length,
      customPermissionGrantCount: customPermissionEdges.length,
      loginIpRanges,
      loginHoursDefined,
      loginHours,
    }),
  };

  return ok({ nodes: [node], edges });
};
