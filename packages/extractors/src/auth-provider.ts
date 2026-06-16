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

const AUTH_PROVIDER_FILE_SUFFIX = '.authprovider-meta.xml';
const ROOT_ELEMENT = 'AuthProvider';
const REQUIRED_ELEMENTS = ['friendlyName', 'providerType'] as const;

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

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

/** Locate the `<AuthProvider>` root and verify required children per `AuthProvider.md`. */
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
 * Extract a Node from a single Salesforce `*.authprovider-meta.xml` file.
 *
 * Reads `<friendlyName>` (becomes `Node.label`) and `<providerType>`,
 * plus a documented set of optional properties (`executionUser`,
 * `defaultScopes`, `icon`, `includeOrgIdInIdentifier`, `plugin`,
 * `portal`, `registrationHandler`, `sendAccessTokenInHeader`,
 * `sendClientCredentialsInHeader`). The `<providerType>` value is
 * surfaced verbatim — Salesforce extends the allowed set over time and
 * v1.5 deliberately does not validate against it.
 *
 * Returns one `Node` of type `'AuthProvider'` and zero edges. Per
 * `AuthProvider.md` §Edges, Auth Providers are the *target* of
 * `references` edges emitted by `ExternalDataSource` and
 * `NamedCredential`; they do not reference other components themselves.
 * The `registrationHandler` and `executionUser` properties name an
 * ApexClass and a User respectively but v1.5 does NOT emit edges for
 * either — both are string bindings that the architect-integration-
 * topology skill surfaces as plain properties.
 *
 * Error cases (per vendored `AuthProvider.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<AuthProvider>` or a
 *     required element (`<friendlyName>` or `<providerType>`) is missing
 *
 * @example
 *   const result = await extractAuthProvider(
 *     'force-app/main/default/authproviders/Corporate_SSO.authprovider-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'AuthProvider:Corporate_SSO'
 */
export const extractAuthProvider = async (
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

  const apiName = deriveComponentApiName(path, AUTH_PROVIDER_FILE_SUFFIX);

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'AuthProvider',
    apiName,
    label: String(unwrapSingle(rootObj['friendlyName'])),
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      providerType: String(unwrapSingle(rootObj['providerType'])),
      executionUser: optionalString(rootObj, 'executionUser'),
      defaultScopes: optionalString(rootObj, 'defaultScopes'),
      icon: optionalString(rootObj, 'icon'),
      includeOrgIdInIdentifier: coerceBoolean(
        unwrapSingle(rootObj['includeOrgIdInIdentifier']),
      ),
      plugin: optionalString(rootObj, 'plugin'),
      portal: optionalString(rootObj, 'portal'),
      registrationHandler: optionalString(rootObj, 'registrationHandler'),
      sendAccessTokenInHeader: coerceBoolean(
        unwrapSingle(rootObj['sendAccessTokenInHeader']),
      ),
      sendClientCredentialsInHeader: coerceBoolean(
        unwrapSingle(rootObj['sendClientCredentialsInHeader']),
      ),
    },
  };

  return ok({ nodes: [node], edges: [] });
};
