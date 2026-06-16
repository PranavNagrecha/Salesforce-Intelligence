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

const CSP_TRUSTED_SITE_FILE_SUFFIX = '.cspTrustedSite-meta.xml';
const ROOT_ELEMENT = 'CspTrustedSite';
const REQUIRED_ELEMENTS = ['endpointUrl', 'isActive', 'context'] as const;

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

/** Locate the `<CspTrustedSite>` root and verify required children per `CspTrustedSite.md`. */
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
 * Extract a Node from a single Salesforce `*.cspTrustedSite-meta.xml`
 * file.
 *
 * Reads `<endpointUrl>`, `<isActive>`, `<context>` (all required),
 * optional `<description>`, and the seven `<isApplicableTo*>` booleans
 * mapping to CSP directives (`connect-src`, `font-src`, `frame-src`,
 * `img-src`, `media-src`, `script-src`, `style-src`). CSP Trusted Sites
 * carry no `<label>` element in the XML; the `Node.label` falls back
 * to the filename's API name per `CspTrustedSite.md` §"Node field
 * mapping".
 *
 * Returns one `Node` of type `'CspTrustedSite'` and zero edges. CSP
 * Trusted Sites govern inbound browser fetches and have no inter-
 * component references. v1.5 does NOT correlate LWC `fetch()` calls
 * to specific CSP entries (a runtime browser concern; the v1.4 LWC
 * scanner does not detect URL strings in JS source — see
 * `CspTrustedSite.md` for the deferral rationale).
 *
 * Error cases (per vendored `CspTrustedSite.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<CspTrustedSite>` or a
 *     required element (`<endpointUrl>`, `<isActive>`, `<context>`)
 *     is missing
 *
 * @example
 *   const result = await extractCspTrustedSite(
 *     'force-app/main/default/cspTrustedSites/Stripe_JS.cspTrustedSite-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'CspTrustedSite:Stripe_JS'
 */
export const extractCspTrustedSite = async (
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

  const apiName = deriveComponentApiName(path, CSP_TRUSTED_SITE_FILE_SUFFIX);

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'CspTrustedSite',
    apiName,
    // Per `CspTrustedSite.md`: the XML has no `<label>` element, so
    // `label` falls back to the API name. The architect-integration-
    // topology skill cites the `endpointUrl` property in reporting.
    label: apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      endpointUrl: String(unwrapSingle(rootObj['endpointUrl'])),
      isActive: coerceBoolean(unwrapSingle(rootObj['isActive'])),
      context: String(unwrapSingle(rootObj['context'])),
      description: optionalString(rootObj, 'description'),
      isApplicableToConnectSrc: coerceBoolean(
        unwrapSingle(rootObj['isApplicableToConnectSrc']),
      ),
      isApplicableToFontSrc: coerceBoolean(
        unwrapSingle(rootObj['isApplicableToFontSrc']),
      ),
      isApplicableToFrameSrc: coerceBoolean(
        unwrapSingle(rootObj['isApplicableToFrameSrc']),
      ),
      isApplicableToImgSrc: coerceBoolean(
        unwrapSingle(rootObj['isApplicableToImgSrc']),
      ),
      isApplicableToMediaSrc: coerceBoolean(
        unwrapSingle(rootObj['isApplicableToMediaSrc']),
      ),
      isApplicableToScriptSrc: coerceBoolean(
        unwrapSingle(rootObj['isApplicableToScriptSrc']),
      ),
      isApplicableToStyleSrc: coerceBoolean(
        unwrapSingle(rootObj['isApplicableToStyleSrc']),
      ),
    },
  };

  return ok({ nodes: [node], edges: [] });
};
