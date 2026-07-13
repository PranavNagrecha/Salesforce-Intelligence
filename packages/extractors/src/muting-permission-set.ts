import { readFile } from 'node:fs/promises';

import type {
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName } from './path-utils.js';

const MUTING_FILE_SUFFIX = '.mutingpermissionset-meta.xml';
const ROOT_ELEMENT = 'MutingPermissionSet';

/** The six object-permission flags a muting set can remove, in canonical order. */
const OBJECT_FLAGS = [
  'allowCreate',
  'allowRead',
  'allowEdit',
  'allowDelete',
  'viewAllRecords',
  'modifyAllRecords',
] as const;
type ObjectFlag = (typeof OBJECT_FLAGS)[number];

/** One object-permission mute: `true` means the group is DENIED that flag. */
export interface MutedObjectPermission {
  readonly object: string;
  readonly allowCreate: boolean;
  readonly allowRead: boolean;
  readonly allowEdit: boolean;
  readonly allowDelete: boolean;
  readonly viewAllRecords: boolean;
  readonly modifyAllRecords: boolean;
}

/** One FLS mute: `true` means the group is DENIED that read/write on the field. */
export interface MutedFieldPermission {
  readonly field: string;
  readonly readable: boolean;
  readonly editable: boolean;
}

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
 * silently truncates). Mirrors the permission-set extractor's reader.
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

/** Locate the `<MutingPermissionSet>` root object (no required child element). */
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
  return ok(root as Record<string, unknown>);
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

/**
 * Collect `<objectPermissions>` mutes. In a muting permission set a `true`
 * flag means "MUTE (deny) this permission on the object" — the inverse read of
 * a permission set, whose `true` means "grant". Entries that mute NO flag are
 * skipped (they subtract nothing). Sorted by object for determinism.
 */
const collectMutedObjectPermissions = (
  rootObj: Record<string, unknown>,
): MutedObjectPermission[] => {
  const out: MutedObjectPermission[] = [];
  for (const entry of iterEntries(rootObj, 'objectPermissions')) {
    const flags: Record<ObjectFlag, boolean> = {
      allowCreate: coerceBoolean(unwrapSingle(entry['allowCreate'])),
      allowRead: coerceBoolean(unwrapSingle(entry['allowRead'])),
      allowEdit: coerceBoolean(unwrapSingle(entry['allowEdit'])),
      allowDelete: coerceBoolean(unwrapSingle(entry['allowDelete'])),
      viewAllRecords: coerceBoolean(unwrapSingle(entry['viewAllRecords'])),
      modifyAllRecords: coerceBoolean(unwrapSingle(entry['modifyAllRecords'])),
    };
    if (!OBJECT_FLAGS.some((f) => flags[f])) continue;
    const object = String(unwrapSingle(entry['object']) ?? '');
    if (object.length === 0) continue;
    out.push({ object, ...flags });
  }
  return out.sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));
};

/**
 * Collect `<fieldPermissions>` mutes (`readable` / `editable`, `true` = muted).
 * Entries that mute neither are skipped. A `<field>` lacking the `Object.Field`
 * dot is `malformed-input` (mirrors the permission-set extractor's guard).
 */
const collectMutedFieldPermissions = (
  rootObj: Record<string, unknown>,
  path: string,
): Result<MutedFieldPermission[], ExtractorError> => {
  const out: MutedFieldPermission[] = [];
  for (const entry of iterEntries(rootObj, 'fieldPermissions')) {
    const field = String(unwrapSingle(entry['field']) ?? '');
    if (!field.includes('.')) {
      return err({
        kind: 'malformed-input',
        path,
        message: `field reference ${field} not in Object.Field form`,
      });
    }
    const readable = coerceBoolean(unwrapSingle(entry['readable']));
    const editable = coerceBoolean(unwrapSingle(entry['editable']));
    if (!readable && !editable) continue;
    out.push({ field, readable, editable });
  }
  return ok(out.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)));
};

/**
 * Collect names under `element` whose `<enabled>` is `true` (muted). Shared by
 * `<userPermissions>`, `<customPermissions>`, and `<classAccesses>` (the last
 * keyed by `<apexClass>` rather than `<name>`). De-duplicated + sorted.
 */
const collectEnabledNames = (
  rootObj: Record<string, unknown>,
  element: string,
  nameKey: string,
): string[] => {
  const names = new Set<string>();
  for (const entry of iterEntries(rootObj, element)) {
    if (!coerceBoolean(unwrapSingle(entry['enabled']))) continue;
    const raw = unwrapSingle(entry[nameKey]);
    if (raw === undefined || raw === null) continue;
    const name = String(raw);
    if (name.length > 0) names.add(name);
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/**
 * Extract a MutingPermissionSet node from a `*.mutingpermissionset-meta.xml`
 * file, capturing the permission classes it MUTES so a consumer can subtract
 * them from a PermissionSetGroup's member union (muting is group-scoped).
 *
 * The muting file mirrors permission-set XML, but a `true` value means the
 * permission is DENIED (removed from the group), not granted. This extractor
 * therefore reads the SAME child collections as the permission-set extractor
 * (`objectPermissions`, `fieldPermissions`, `userPermissions`,
 * `customPermissions`, `classAccesses`) and surfaces the muted set on
 * `node.properties`:
 *
 *   - `mutedObjectPermissions`: `{ object, allowCreate, ... }[]` (flag `true` = denied)
 *   - `mutedFieldPermissions`:  `{ field, readable, editable }[]` (`true` = denied)
 *   - `mutedUserPermissions`:   system-permission names denied (`string[]`)
 *   - `mutedCustomPermissions`: custom-permission names denied (`string[]`)
 *   - `mutedApexClasses`:       Apex classes whose access is denied (`string[]`)
 *   - `muted*Count`:            per-family counts for quick summary reads
 *
 * Muted permissions are surfaced as NODE PROPERTIES, never as `grantedBy`
 * edges, so no grant-walking consumer (`who_can_access_object`, the CRUD/FLS
 * audits) ever mistakes a MUTE for a GRANT. `effective_permissions` reads these
 * properties and subtracts them within the owning group.
 *
 * Record-type visibility is intentionally NOT modeled: a MutingPermissionSet
 * cannot mute record-type visibility, so there is nothing to subtract there.
 *
 * Returns `file-not-found`, `parse-error`, or `malformed-input` (wrong root, or
 * a `<field>` lacking the `Object.Field` dot) on the documented failure modes.
 *
 * @example
 *   const r = await extractMutingPermissionSet('mutingpermissionsets/Deny_Delete.mutingpermissionset-meta.xml');
 *   if (r.ok) console.log(r.value.nodes[0].properties['mutedObjectPermissions']);
 */
export const extractMutingPermissionSet = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Raise the entity-expansion
  // cap so production-scale muting XML never trips fast-xml-parser's default.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
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

  const apiName = deriveComponentApiName(path, MUTING_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;

  const mutedObjectPermissions = collectMutedObjectPermissions(rootObj);
  const mutedFieldResult = collectMutedFieldPermissions(rootObj, path);
  if (!mutedFieldResult.ok) return mutedFieldResult;
  const mutedFieldPermissions = mutedFieldResult.value;
  const mutedUserPermissions = collectEnabledNames(rootObj, 'userPermissions', 'name');
  const mutedCustomPermissions = collectEnabledNames(rootObj, 'customPermissions', 'name');
  const mutedApexClasses = collectEnabledNames(rootObj, 'classAccesses', 'apexClass');

  const descriptionRaw = unwrapSingle(rootObj['description']);
  const labelRaw = unwrapSingle(rootObj['label']);

  const node: Node = {
    id: nodeId,
    type: 'MutingPermissionSet',
    apiName,
    label: labelRaw === undefined || labelRaw === null ? null : String(labelRaw),
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      description: descriptionRaw === undefined ? null : String(descriptionRaw),
      mutedObjectPermissions,
      mutedFieldPermissions,
      mutedUserPermissions,
      mutedCustomPermissions,
      mutedApexClasses,
      mutedObjectCount: mutedObjectPermissions.length,
      mutedFieldCount: mutedFieldPermissions.length,
      mutedUserPermissionCount: mutedUserPermissions.length,
      mutedCustomPermissionCount: mutedCustomPermissions.length,
      mutedApexClassCount: mutedApexClasses.length,
    },
  };

  return ok({ nodes: [node], edges: [] });
};
