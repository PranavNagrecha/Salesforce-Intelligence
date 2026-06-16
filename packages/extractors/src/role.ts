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

const ROLE_FILE_SUFFIX = '.role-meta.xml';
const ROOT_ELEMENT = 'Role';
const EXTRACTOR_SOURCE = 'role-extractor';
const REQUIRED_ELEMENTS = ['name'] as const;

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Every Role element the extractor reads is
 * single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

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

/** Locate the `<Role>` root and verify required children per `Role.md`. */
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
 * Extract a Node and (at most one) edge from a single Salesforce
 * `*.role-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<Role>` root per the
 * vendored `Role.md` spec, and returns an `ExtractionResult` containing
 * one `Node` of type `'Role'` and either zero or one `inheritsFrom`
 * edges (one when `<parentRole>` is present, zero otherwise — a role at
 * the top of the hierarchy is the documented happy path).
 *
 * The canonical ID derives from the filename, not from the `<name>`
 * element. `<name>` is the human-readable display label; the filename's
 * basename (minus `.role-meta.xml`) is the API name. The `<parentRole>`
 * element, when present, also carries the parent role's API name (not
 * its display name).
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root or
 * missing `<name>`).
 *
 * @example
 *   const result = await extractRole(
 *     'force-app/main/default/roles/VP_Sales.role-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'Role:VP_Sales'
 *   }
 */
export const extractRole = async (
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

  const apiName = deriveComponentApiName(path, ROLE_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;
  const label = String(unwrapSingle(rootObj['name']));
  const parentRole = optionalString(rootObj, 'parentRole');
  const parentId = parentRole === null ? null : `${ROOT_ELEMENT}:${parentRole}`;

  const node: Node = {
    id: nodeId,
    type: 'Role',
    apiName,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      caseAccessLevel: optionalString(rootObj, 'caseAccessLevel'),
      contactAccessLevel: optionalString(rootObj, 'contactAccessLevel'),
      opportunityAccessLevel: optionalString(rootObj, 'opportunityAccessLevel'),
      mayForecastManagerShare: coerceBoolean(
        unwrapSingle(rootObj['mayForecastManagerShare']),
      ),
      description: optionalString(rootObj, 'description'),
    },
  };

  // Per Role.md "Edges": one `inheritsFrom` edge is emitted only when
  // `<parentRole>` is present. A role at the top of the hierarchy
  // produces zero edges — this is the documented happy path.
  const edges: Edge[] =
    parentRole === null
      ? []
      : [
          {
            fromId: nodeId,
            toId: `${ROOT_ELEMENT}:${parentRole}`,
            edgeType: 'inheritsFrom',
            confidence: 'declared',
            source: EXTRACTOR_SOURCE,
            properties: {},
          },
        ];

  return ok({ nodes: [node], edges });
};
