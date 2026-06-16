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

const NAMED_CRED_FILE_SUFFIX = '.namedCredential-meta.xml';
const ROOT_ELEMENT = 'NamedCredential';
// <endpoint> is OPTIONAL: new-style Named Credentials (namedCredentialType=
// SecuredEndpoint, API 56+) have no top-level <endpoint> — the URL lives in a
// <namedCredentialParameters> entry with parameterName=Url (resolveEndpoint
// below reads it). Only <label> is genuinely required.
const REQUIRED_ELEMENTS = ['label'] as const;

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Resolve the credential's endpoint URL. Legacy Named Credentials carry it in a
 * top-level `<endpoint>`; new-style (SecuredEndpoint) ones carry it in a
 * `<namedCredentialParameters>` entry with `parameterName === 'Url'`. Returns
 * `null` when neither is present.
 */
const resolveEndpoint = (rootObj: Record<string, unknown>): string | null => {
  const direct = unwrapSingle(rootObj['endpoint']);
  if (direct !== undefined && direct !== null && String(direct) !== '') {
    return String(direct);
  }
  const rawParams = rootObj['namedCredentialParameters'];
  const params = Array.isArray(rawParams)
    ? rawParams
    : rawParams === undefined || rawParams === null
      ? []
      : [rawParams];
  for (const param of params) {
    if (typeof param !== 'object' || param === null) continue;
    const obj = param as Record<string, unknown>;
    if (String(unwrapSingle(obj['parameterName']) ?? '') === 'Url') {
      const value = unwrapSingle(obj['parameterValue']);
      if (value !== undefined && value !== null) return String(value);
    }
  }
  return null;
};

/** Coerce an XML scalar to boolean; non-`true` values become false (per SF defaults). */
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

/** Locate the `<NamedCredential>` root and verify required children. */
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
 * Extract a Node from a single Salesforce Named Credential file.
 *
 * Reads `<label>`, `<endpoint>`, and seven optional authentication
 * properties (`principalType`, `protocol`, `username`,
 * `generateAuthorizationHeader`, `allowMergeFieldsInBody`,
 * `allowMergeFieldsInHeader`, `calloutOptionsGenerateAuthorizationHeader`).
 *
 * Returns one `Node` of type `'NamedCredential'` and zero edges. The
 * endpoint URL is a string, not a graph node; linking to referenced
 * components is deferred to v0.3.
 *
 * Error cases (per vendored `NamedCredential.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<NamedCredential>` or a
 *     required element (`<label>` or `<endpoint>`) is missing
 *
 * @example
 *   const result = await extractNamedCredential(
 *     'force-app/main/default/namedCredentials/External_Api.namedCredential-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'NamedCredential:External_Api'
 */
export const extractNamedCredential = async (
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

  const apiName = deriveComponentApiName(path, NAMED_CRED_FILE_SUFFIX);

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'NamedCredential',
    apiName,
    label: String(unwrapSingle(rootObj['label'])),
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      endpoint: resolveEndpoint(rootObj),
      principalType: optionalString(rootObj, 'principalType'),
      protocol: optionalString(rootObj, 'protocol'),
      username: optionalString(rootObj, 'username'),
      generateAuthorizationHeader: coerceBoolean(
        unwrapSingle(rootObj['generateAuthorizationHeader']),
      ),
      allowMergeFieldsInBody: coerceBoolean(
        unwrapSingle(rootObj['allowMergeFieldsInBody']),
      ),
      allowMergeFieldsInHeader: coerceBoolean(
        unwrapSingle(rootObj['allowMergeFieldsInHeader']),
      ),
      calloutOptionsGenerateAuthorizationHeader: coerceBoolean(
        unwrapSingle(rootObj['calloutOptionsGenerateAuthorizationHeader']),
      ),
    },
  };

  return ok({ nodes: [node], edges: [] });
};
