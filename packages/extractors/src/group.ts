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

const GROUP_FILE_SUFFIX = '.group-meta.xml';
const ROOT_ELEMENT = 'Group';
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
 * one `Node` of type `'Group'` and **zero edges**. v1.1 defers deep
 * `<related>` member resolution to v1.2 — only the row count is
 * surfaced as `properties.memberCount`.
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
  // `string[]` (empty array when absent). `<related>` rows are counted
  // only; deep member resolution is deferred to v1.2.
  const emails = toArray(rootObj['emails']).map((value) => String(value));
  const memberCount = toArray(rootObj['related']).length;

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
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

  return ok({ nodes: [node], edges: [] });
};
