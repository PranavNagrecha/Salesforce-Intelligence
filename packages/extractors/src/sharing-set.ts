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

const SHARING_SET_FILE_SUFFIX = '.sharingSet-meta.xml';
const ROOT_ELEMENT = 'SharingSet';
const EXTRACTOR_SOURCE = 'sharing-set-extractor';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise. Used for `<accessMappings>` and
 * `<profiles>`, which may appear zero, one, or many times.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Return `<element>`'s inner text as a string, or `null` when the element is
 * absent or empty.
 *
 * An element that parses to an OBJECT (an unexpected nested shape) also reads
 * `null` rather than being stringified — `String({})` yields the literal
 * `"[object Object]"`, which is an invented value, and this codebase treats an
 * invented value as worse than a missing one.
 */
const optionalString = (
  container: Record<string, unknown>,
  key: string,
): string | null => {
  const raw = unwrapSingle(container[key]);
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'object') return null;
  return String(raw);
};

/**
 * Read and strictly-validate a file as XML. Validates before parsing so
 * malformed input surfaces as `parse-error` (fast-xml-parser's `parse()`
 * silently truncates on mismatched tags).
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

/**
 * Locate and validate the `<SharingSet>` root in a parsed XML tree.
 *
 * A root with NO children is a valid (if degenerate) file — every element
 * below `<SharingSet>` is optional — and fast-xml-parser renders both
 * `<SharingSet/>` and `<SharingSet></SharingSet>` as an empty STRING rather
 * than an empty object. Both shapes therefore count as a valid empty root and
 * yield a node with null/empty properties; rejecting them would drop a real
 * (if unconfigured) component from the vault entirely. This mirrors the
 * `<SharingRules>` empty-root handling in `sharing-rules.ts`. A missing
 * `<SharingSet>` key is the only malformed case.
 */
const validateRoot = (
  parsed: Record<string, unknown>,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  if (!(ROOT_ELEMENT in parsed)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root === 'object' && root !== null) {
    return ok(root as Record<string, unknown>);
  }
  // `<SharingSet/>` / `<SharingSet></SharingSet>` — empty but valid.
  if (root === '' || root === null || root === undefined) {
    return ok({});
  }
  return err({
    kind: 'malformed-input',
    path,
    message: `expected <${ROOT_ELEMENT}> root`,
  });
};

/**
 * One `<accessMappings>` block: which object the sharing set grants on, at
 * what access level, and the USER-side / TARGET-side fields whose values must
 * match for a portal user to reach a record.
 *
 * Every member is nullable because every child element is optional in
 * practice: a half-configured mapping is a real state a real org can be in,
 * and reporting a fabricated `''` / `'Read'` for an element the XML never
 * declared would be a lie about the org's sharing posture.
 */
export interface SharingSetAccessMapping {
  readonly object: string | null;
  readonly accessLevel: string | null;
  readonly userField: string | null;
  readonly objectField: string | null;
}

/**
 * Parse the `<accessMappings>` blocks into the ordered mapping list.
 *
 * Blocks that parse to a non-object (a self-closing `<accessMappings/>`,
 * which fast-xml-parser renders as `''`) carry no information at all and are
 * skipped — mirroring the sharing-rules `parseCriteriaItems` precedent. A
 * block that IS an object is ALWAYS kept, even when `<object>` is absent: the
 * mapping's other declared values are real data, and dropping the whole block
 * would silently under-report the set's configuration. Such a block simply
 * mints no edge (there is no target to point at).
 */
const parseAccessMappings = (
  rootObj: Record<string, unknown>,
): readonly SharingSetAccessMapping[] => {
  const mappings: SharingSetAccessMapping[] = [];
  for (const raw of toArray(rootObj['accessMappings'])) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as Record<string, unknown>;
    mappings.push({
      object: optionalString(block, 'object'),
      accessLevel: optionalString(block, 'accessLevel'),
      userField: optionalString(block, 'userField'),
      objectField: optionalString(block, 'objectField'),
    });
  }
  return mappings;
};

/**
 * Read the granted profile names out of `<profiles>`, accepting BOTH shapes
 * the element is seen in:
 *
 *   - `<profiles>Partner_Community_User</profiles>` (repeatable scalar — the
 *     `string[]` shape the Metadata API documents for `SharingSet.profiles`)
 *   - `<profiles><profile>Partner_Community_User</profile></profiles>` (a
 *     wrapper element holding repeatable `<profile>` children, the shape the
 *     other assignment-carrying types — `Skill`, `PresenceUserConfig` — use)
 *
 * No SharingSet metadata was available to read from a real org when this was
 * written, so committing to one shape would have been a guess that silently
 * extracts NOTHING if the guess is wrong. Accepting both costs three lines and
 * cannot mis-read either shape: a scalar child and a wrapper object are
 * disjoint at the type level.
 *
 * Returns the names deduplicated and sorted for deterministic output.
 */
const parseProfiles = (rootObj: Record<string, unknown>): readonly string[] => {
  const names = new Set<string>();
  for (const raw of toArray(rootObj['profiles'])) {
    if (typeof raw === 'object' && raw !== null) {
      // Wrapper shape: `<profiles><profile>…</profile></profiles>`.
      for (const inner of toArray((raw as Record<string, unknown>)['profile'])) {
        if (inner === undefined || inner === null || typeof inner === 'object') continue;
        const name = String(inner);
        if (name.length > 0) names.add(name);
      }
      continue;
    }
    // Scalar shape: `<profiles>…</profiles>`.
    if (raw === undefined || raw === null) continue;
    const name = String(raw);
    if (name.length > 0) names.add(name);
  }
  return [...names].sort();
};

/**
 * Build the `sharedWith` edges, one per DISTINCT target object named by an
 * access mapping (first-appearance order preserved).
 *
 * Deduplication is required, not cosmetic: the edges table's primary key is
 * `(from_id, to_id, edge_type, source)`, so two mappings on the same object
 * would collide and the second silently overwrite the first. When a single
 * mapping owns the object, its `accessLevel` / `userField` / `objectField`
 * ride on the edge; when SEVERAL mappings share one object the per-mapping
 * values are deliberately OMITTED and only `mappingCount` is carried — reading
 * the first block's fields onto an edge that represents several is the
 * first-occurrence misattribution this codebase has already been bitten by
 * (see the EntitlementProcess `<milestones>` note in contracts). The node's
 * `accessMappings` array stays the authoritative per-mapping record.
 */
const buildObjectEdges = (
  nodeId: string,
  mappings: readonly SharingSetAccessMapping[],
): readonly Edge[] => {
  const byObject = new Map<string, SharingSetAccessMapping[]>();
  for (const mapping of mappings) {
    if (mapping.object === null) continue;
    const bucket = byObject.get(mapping.object);
    if (bucket === undefined) byObject.set(mapping.object, [mapping]);
    else bucket.push(mapping);
  }
  return [...byObject].map(([object, forObject]) => {
    const only = forObject.length === 1 ? forObject[0] : undefined;
    return {
      fromId: nodeId,
      toId: `CustomObject:${object}`,
      edgeType: 'sharedWith' as const,
      confidence: 'declared' as const,
      source: EXTRACTOR_SOURCE,
      properties: {
        relationship: 'sharingSetAccess',
        mappingCount: forObject.length,
        ...(only !== undefined
          ? {
              accessLevel: only.accessLevel,
              userField: only.userField,
              objectField: only.objectField,
            }
          : {}),
      },
    };
  });
};

/**
 * Extract a Node and edges from a single Salesforce `*.sharingSet-meta.xml`
 * file (one file per sharing set, flat top-level `sharingSets/` folder).
 *
 * A SharingSet is how an Experience Cloud / portal user gets record access
 * WITHOUT a sharing rule: each `<accessMappings>` block names a target object
 * plus a pair of fields — one on the USER (`<userField>`, e.g.
 * `Contact.Account`) and one on the target RECORD (`<objectField>`) — and a
 * portal user reaches a record when the two values match. `<profiles>` names
 * the portal profiles the set applies to.
 *
 * Emits ONE `'SharingSet'` node carrying:
 *   - `description` — `<description>`, `null` when absent.
 *   - `accessMappings` — every `<accessMappings>` block as
 *     `{ object, accessLevel, userField, objectField }`, each member `null`
 *     when its element is absent. NEVER defaulted: an absent `<accessLevel>`
 *     is `null`, not `'Read'`, because a fabricated access level would
 *     misstate the org's real sharing posture.
 *   - `profiles` — the deduplicated, sorted granted profile names.
 * Both arrays are ALWAYS present (empty when nothing was declared): an empty
 * array says "extracted, none present", which is a different and weaker claim
 * than the type being absent from the vault entirely.
 *
 * Edges (all `declared` — the XML block IS the declaration):
 *   - `sharedWith` from this set to `CustomObject:{object}`, one per DISTINCT
 *     mapped object. Reuses the SAME EdgeType the SharingRule and Queue
 *     extractors already emit toward an access target; no new EdgeType is
 *     introduced. `properties.relationship` is `'sharingSetAccess'` so a
 *     consumer can tell a set's grant from a queue's `'queueOwner'` ownership.
 *   - `grantedBy` from `Profile:{name}` to this set, one per granted profile.
 *     Direction follows the universal `grantedBy` convention in this codebase
 *     (`fromId` is the granting container, `toId` is what its holders reach):
 *     holding one of these profiles is exactly what qualifies a portal user
 *     for the set's access. The `Profile:` node may be absent from the vault
 *     (dangling-by-design, like the sharing-rules `Group:` targets).
 *
 * Honesty boundary: the EXISTENCE and CONFIGURATION of a sharing set are
 * declarable from metadata; whether it grants a SPECIFIC user access to a
 * SPECIFIC record is not — that needs the record's `<objectField>` value and
 * the user's `<userField>` value, both live record data. Consumers must keep
 * an `unknown` verdict on applicability while reporting the declared mapping.
 *
 * Error cases:
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root element isn't `<SharingSet>`
 *
 * No element below the root is treated as required: a set with no access
 * mappings, no profiles, no description, and no `<name>` extracts cleanly to a
 * node with `null`/empty properties rather than failing the whole file — up to
 * and including a childless `<SharingSet/>`.
 *
 * @example
 *   const result = await extractSharingSet(
 *     'force-app/main/default/sharingSets/Partner_Access.sharingSet-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'SharingSet:Partner_Access'
 */
export const extractSharingSet = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is too
  // tight for production-scale metadata XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator doesn't
  // enforce (e.g., fast-xml-parser's default entity-expansion cap). Catch it
  // so a single pathological file becomes a per-file `parse-error` rather
  // than aborting the refresh pipeline.
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

  const apiName = deriveComponentApiName(path, SHARING_SET_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;
  const accessMappings = parseAccessMappings(rootObj);
  const profiles = parseProfiles(rootObj);

  const node: Node = {
    id: nodeId,
    type: 'SharingSet',
    apiName,
    // `<name>` is the set's display label; the FILE's basename is the API
    // name. An absent `<name>` stays `null` rather than echoing the api name,
    // so "no label declared" never reads as a real label.
    label: optionalString(rootObj, 'name'),
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      description: optionalString(rootObj, 'description'),
      accessMappings,
      profiles,
    },
  };

  // One `grantedBy` edge per granted profile. `profiles` is already
  // deduplicated, so the edge PK cannot collide.
  const profileEdges: Edge[] = profiles.map((profileName) => ({
    fromId: `Profile:${profileName}`,
    toId: nodeId,
    edgeType: 'grantedBy',
    confidence: 'declared',
    source: EXTRACTOR_SOURCE,
    properties: { sharingSetAccess: true },
  }));

  return ok({
    nodes: [node],
    edges: [...buildObjectEdges(nodeId, accessMappings), ...profileEdges],
  });
};
