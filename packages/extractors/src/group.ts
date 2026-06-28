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

const GROUP_FILE_SUFFIX = '.group-meta.xml';
const ROOT_ELEMENT = 'Group';
const EXTRACTOR_SOURCE = 'group-extractor';
// Only <name> is genuinely required. `doesSendEmailToMembers` and
// `doesIncludeBosses` are OPTIONAL boolean attributes (default false) that real
// groups routinely omit; the read sites already coerce a missing value to false.
// Requiring them errored on groups that omit them (4 on a real govt-org refresh).
const REQUIRED_ELEMENTS = ['name'] as const;

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Single-occurrence Group elements
 * (`<name>`, `<doesSendEmailToMembers>`, etc.) use this helper.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a single-element
 * array otherwise. Used for `<emails>` and `<related>` which may appear
 * zero, one, or many times.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Coerce an XML scalar to a boolean. The Salesforce default for unset
 * boolean elements is `false`, so anything that isn't the literal `true`
 * (or its string form) collapses to `false`.
 */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
};

/**
 * CR-CAP-12 — variant table mapping a `<related>` row's `<type>`
 * (`GroupTypeEnum`) to the canonical `hasMember` edge target id prefix and any
 * extra edge properties. This MIRRORS the sharing-rules `<sharedTo>` variant
 * table so the membership topology a group declares is shaped identically to
 * the access topology a sharing rule declares: a Role-and-subordinates member
 * carries the SAME `inheritance: 'subordinates'` marker a
 * `roleAndSubordinates` sharing target does, and a nested `Group` member is a
 * plain `Group:{ref}` (transitive — a membership walk can recurse through it).
 *
 * Resolution rules per row:
 *   - `User`                         → `User:{ref}` — a dangling-by-design
 *     target (there is NO `User` ComponentType, exactly as the sharing-rules
 *     synthetic groups are dangling). No extra props.
 *   - `Role`                         → `Role:{ref}` (the named role only).
 *   - `RoleAndSubordinates`          → `Role:{ref}` + `inheritance:
 *     'subordinates'` (reaches the role AND every role below it — the same
 *     marker `why_cant`'s owner-rule path already understands).
 *   - `RoleAndSubordinatesInternal`  → `Role:{ref}` +
 *     `inheritance: 'subordinatesInternal'`.
 *   - `Group`                        → `Group:{ref}` — a resolvable nested
 *     group, enabling membership transitivity.
 *   - `Territory` / `TerritoryAndSubordinates` → `Territory:{ref}` +
 *     `resolvable: false` so consumers DISCLOSE rather than silently treat the
 *     member as resolved (no Territory ComponentType — dangling-by-design).
 *
 * An UNRECOGNISED `<type>` (e.g. `Organization`, `PRMOrganization`) is counted
 * in `memberCount` but emits NO edge and carries no synthetic — the count stays
 * honest while the unmodeled topology is simply not asserted.
 */
interface MemberVariantSpec {
  readonly idPrefix: 'User' | 'Role' | 'Group' | 'Territory';
  readonly extraProps: Readonly<Record<string, unknown>>;
}

const MEMBER_VARIANT_TABLE: Readonly<Record<string, MemberVariantSpec>> = {
  User: { idPrefix: 'User', extraProps: {} },
  Role: { idPrefix: 'Role', extraProps: {} },
  RoleAndSubordinates: {
    idPrefix: 'Role',
    extraProps: { inheritance: 'subordinates' },
  },
  RoleAndSubordinatesInternal: {
    idPrefix: 'Role',
    extraProps: { inheritance: 'subordinatesInternal' },
  },
  Group: { idPrefix: 'Group', extraProps: {} },
  Territory: { idPrefix: 'Territory', extraProps: { resolvable: false } },
  TerritoryAndSubordinates: {
    idPrefix: 'Territory',
    extraProps: { resolvable: false, inheritance: 'subordinates' },
  },
};

/**
 * Build the `hasMember` edges for a group from its `<related>` rows.
 *
 * Each `<related>` row carries a `<type>` (`GroupTypeEnum`) and a
 * `<members>` reference (the API name of the related principal — for a User
 * member this is the username, for a Role / Group it is the role / group API
 * name). A row whose `<type>` resolves in `MEMBER_VARIANT_TABLE` yields one
 * `hasMember` edge from the group to the resolved member id; a row with an
 * unrecognised type or a missing reference yields no edge (it is still counted
 * by the caller's `memberCount`). Edges are `declared` — the `<related>` row IS
 * the declaration, mirroring the sharing-rules `sharedWith` sibling.
 */
const buildMemberEdges = (
  related: readonly unknown[],
  groupId: string,
): Edge[] => {
  const edges: Edge[] = [];
  for (const rowRaw of related) {
    if (typeof rowRaw !== 'object' || rowRaw === null) continue;
    const row = rowRaw as Record<string, unknown>;
    const typeRaw = unwrapSingle(row['type']);
    if (typeRaw === undefined || typeRaw === null) continue;
    const spec = MEMBER_VARIANT_TABLE[String(typeRaw)];
    if (spec === undefined) continue; // counted, but topology not asserted
    // The reference child is `<members>` in the GroupMembers schema; tolerate
    // the legacy `<reference>` shape some hand-authored fixtures use.
    const refRaw =
      unwrapSingle(row['members']) ?? unwrapSingle(row['reference']);
    if (refRaw === undefined || refRaw === null || refRaw === '') continue;
    edges.push({
      fromId: groupId,
      toId: `${spec.idPrefix}:${String(refRaw)}`,
      edgeType: 'hasMember',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { memberType: String(typeRaw), ...spec.extraProps },
    });
  }
  return edges;
};

/**
 * Read and strictly-validate a file as XML. fast-xml-parser's `parse()`
 * is permissive (it silently truncates on mismatched tags), so we
 * validate first to surface malformed input as `parse-error` rather than
 * a misleading partial extraction.
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

/** Locate the `<Group>` root and verify required children per `Group.md`. */
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
  for (const required of REQUIRED_ELEMENTS) {
    if (rootObj[required] === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: `missing required element: <${required}>`,
      });
    }
  }
  return ok(rootObj);
};

/**
 * Extract a Node from a single Salesforce `*.group-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<Group>` root per the
 * vendored `Group.md` spec, and returns an `ExtractionResult` containing
 * one `Node` of type `'Group'` plus one `hasMember` edge per resolvable
 * `<related>` row (CR-CAP-12). The `properties.memberCount` row count is
 * KEPT (it counts every `<related>` row, including the unmodeled types the
 * edge pass skips); the edges are ADDITIVE. Each edge target follows the
 * sharing-rules variant logic: `User:{ref}` (dangling — no User
 * ComponentType), `Role:{ref}`, `Role:{ref}` with
 * `inheritance: 'subordinates'` for `RoleAndSubordinates`, a nested
 * `Group:{ref}` (transitive), and a `Territory:{ref}` synthetic carrying
 * `resolvable: false`. Edges are `declared` confidence — the `<related>`
 * row is the declaration, matching the sharing-rules `sharedWith` sibling.
 *
 * The canonical ID derives from the filename, not from the `<name>`
 * element. `<name>` is the human-readable display label; the filename's
 * basename (minus `.group-meta.xml`) is the API name.
 *
 * Role-derived groups, "Role and Subordinates" pseudo-groups, and the
 * synthetic pseudo-groups `AllInternalUsers`, `AllCustomerPortalUsers`,
 * and `PartnerUsers` are **not** emitted by this extractor. They appear
 * in the graph only as the synthetic targets of `sharedWith` edges
 * produced by the SharingRule extractor.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root or
 * any of `<name>`, `<doesSendEmailToMembers>`, `<doesIncludeBosses>`
 * missing).
 *
 * @example
 *   const result = await extractGroup(
 *     'force-app/main/default/groups/SalesLeadership.group-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'Group:SalesLeadership'
 *   }
 */
export const extractGroup = async (
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
  // cap). Catch it here so a single pathological file becomes a
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

  const apiName = deriveComponentApiName(path, GROUP_FILE_SUFFIX);
  const label = String(unwrapSingle(rootObj['name']));

  // Per Group.md "Optional repeated elements": `<emails>` collects to a
  // `string[]` (empty array when absent). `<related>` rows are BOTH counted
  // (`memberCount`, kept) AND resolved into `hasMember` edges (CR-CAP-12).
  const emails = toArray(rootObj['emails']).map((value) => String(value));
  const related = toArray(rootObj['related']);
  const memberCount = related.length;
  const groupId = `${ROOT_ELEMENT}:${apiName}`;
  const edges = buildMemberEdges(related, groupId);

  const node: Node = {
    id: groupId,
    type: 'Group',
    apiName,
    label,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      description: optionalString(rootObj, 'description'),
      doesSendEmailToMembers: coerceBoolean(
        unwrapSingle(rootObj['doesSendEmailToMembers']),
      ),
      doesIncludeBosses: coerceBoolean(unwrapSingle(rootObj['doesIncludeBosses'])),
      emails,
      memberCount,
    },
  };

  return ok({ nodes: [node], edges });
};
