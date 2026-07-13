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

const SKILL_FILE_SUFFIX = '.skill-meta.xml';
const ROOT_ELEMENT = 'Skill';
const EXTRACTOR_SOURCE = 'skill-extractor';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise. Used for `<profile>`/`<user>` which may
 * appear zero, one, or many times inside `<assignments>`.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
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
 * Extract a Node and edges from a single Salesforce `*.skill-meta.xml` file
 * (one file per skill, flat top-level `skills/` folder — verified against
 * the Metadata API Developer Guide's Skill reference, API version 28.0+).
 *
 * Finding #38 (corrected recipe): `Skill` is one of the three genuine FSL
 * Metadata API types (alongside `FieldServiceSettings` and
 * `TimeSheetTemplate`) — used both for Field Service skill-based routing and
 * for Omni-Channel/chat agent skill routing (the type is shared, not
 * FSL-exclusive). `ServiceResourceSkill` (the record-level assignment of a
 * Skill to a ServiceResource) is a separate, DATA-holding standard SObject —
 * out of scope here; see `STANDARD_OBJECTS_TO_MODEL`.
 *
 * Reads `<label>` (falls back to the file's own API name when absent — the
 * XML has no strictly-required elements per the documented schema),
 * `<description>`, and `<skillType>` (available since API v58.0). The
 * `<assignments>` block is read for both its children:
 *   - `<profiles><profile>` — a real `Profile` node. Each distinct value
 *     emits a `references` edge (DECLARED confidence — the assignment is
 *     explicit in the XML) to `Profile:{name}`, mirrored onto
 *     `properties.assignedProfiles` (deduplicated + sorted).
 *   - `<users><user>` — a username with NO corresponding ComponentType in
 *     this vault (no `User` node type exists), so it is captured VERBATIM
 *     as `properties.assignedUsernames` (deduplicated + sorted) with NO edge
 *     minted — mirroring `PresenceUserConfig`'s existing precedent of never
 *     fabricating a `User:` node/edge from an unconfirmed id shape.
 *
 * Both array properties are OMITTED (not emitted as an empty array) when
 * the corresponding assignment block is absent — "extracted, none present"
 * reads differently from "not modeled".
 *
 * Error cases:
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root element isn't `<Skill>`
 *
 * @example
 *   const result = await extractSkill(
 *     'force-app/main/default/skills/Electrical.skill-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'Skill:Electrical'
 */
export const extractSkill = async (
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
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion cap).
  // Catch it so a single pathological file becomes a per-file `parse-error`
  // rather than aborting the refresh pipeline.
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

  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const rootObj = root as Record<string, unknown>;

  const apiName = deriveComponentApiName(path, SKILL_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;
  const label = optionalString(rootObj, 'label');

  // `<assignments>` is a single-occurrence child holding the two repeatable
  // grant lists. Absent entirely on a skill with no assignments yet.
  const assignments = unwrapSingle(rootObj['assignments']);
  const assignmentsObj =
    typeof assignments === 'object' && assignments !== null
      ? (assignments as Record<string, unknown>)
      : null;

  const profilesBlock = assignmentsObj !== null ? unwrapSingle(assignmentsObj['profiles']) : undefined;
  const profilesObj =
    typeof profilesBlock === 'object' && profilesBlock !== null
      ? (profilesBlock as Record<string, unknown>)
      : null;
  const assignedProfiles = [
    ...new Set(toArray(profilesObj?.['profile']).map((v) => String(v))),
  ].sort();

  const usersBlock = assignmentsObj !== null ? unwrapSingle(assignmentsObj['users']) : undefined;
  const usersObj =
    typeof usersBlock === 'object' && usersBlock !== null
      ? (usersBlock as Record<string, unknown>)
      : null;
  const assignedUsernames = [
    ...new Set(toArray(usersObj?.['user']).map((v) => String(v))),
  ].sort();

  const node: Node = {
    id: nodeId,
    type: 'Skill',
    apiName,
    label: label ?? apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      description: optionalString(rootObj, 'description'),
      skillType: optionalString(rootObj, 'skillType'),
      ...(assignedProfiles.length > 0 ? { assignedProfiles } : {}),
      ...(assignedUsernames.length > 0 ? { assignedUsernames } : {}),
    },
  };

  // One DECLARED `references` edge per distinct assigned Profile. Usernames
  // never mint an edge — see doc comment above.
  const edges: Edge[] = assignedProfiles.map((profileName) => ({
    fromId: nodeId,
    toId: `Profile:${profileName}`,
    edgeType: 'references',
    confidence: 'declared',
    source: EXTRACTOR_SOURCE,
    properties: { referenceKind: 'skillProfileAssignment' },
  }));

  return ok({ nodes: [node], edges });
};
