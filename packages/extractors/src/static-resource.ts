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

const STATIC_RESOURCE_FILE_SUFFIX = '.resource-meta.xml';
const ROOT_ELEMENT = 'StaticResource';
const REQUIRED_ELEMENTS = ['cacheControl'] as const;
const ALLOWED_CACHE_CONTROL = ['Private', 'Public'] as const;

type CacheControl = (typeof ALLOWED_CACHE_CONTROL)[number];

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

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

/** Locate the `<StaticResource>` root and verify required children. */
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
 * Extract a Node from a single Salesforce Static Resource sidecar file.
 *
 * Reads the `.resource-meta.xml` sidecar only; the companion binary
 * asset (`.zip`, `.png`, `.js`, etc.) is intentionally NOT read in v1.2,
 * so `properties.fileSize` is always `null`. Downstream consumers must
 * treat `null` as "size unknown," not "size zero." (Per `StaticResource.md`:
 * "an implementation may choose to default `fileSize` to `null`
 * unconditionally if reading the binary's size is impractical.")
 *
 * `<cacheControl>` is required and must be one of `Private` or `Public`
 * — any other value surfaces as `malformed-input`. Optional
 * `<contentType>` and `<description>` flow through verbatim, with
 * `null` when absent. The Node's `label` is the resource's API name
 * (StaticResource has no `<label>` element in the Metadata API).
 *
 * Returns one `Node` of type `'StaticResource'` and zero edges.
 * Reference edges from Visualforce / Lightning / Apex callers into the
 * resources they invoke (`{!$Resource.X}`, `<lightning:resource>`) are
 * deferred to v1.4.
 *
 * Error cases (per vendored `StaticResource.md`):
 *   - `file-not-found` if the sidecar file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<StaticResource>`,
 *     `<cacheControl>` is missing, or `<cacheControl>` is present but
 *     outside `{Private, Public}`
 *
 * @example
 *   const result = await extractStaticResource(
 *     'force-app/main/default/staticresources/PortalAssets.resource-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'StaticResource:PortalAssets'
 */
export const extractStaticResource = async (
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

  const cacheControlValue = String(unwrapSingle(rootObj['cacheControl']));
  if (!ALLOWED_CACHE_CONTROL.includes(cacheControlValue as CacheControl)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid cacheControl: ${cacheControlValue}`,
    });
  }

  const apiName = deriveComponentApiName(path, STATIC_RESOURCE_FILE_SUFFIX);

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'StaticResource',
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      cacheControl: cacheControlValue,
      contentType: optionalString(rootObj, 'contentType'),
      description: optionalString(rootObj, 'description'),
      fileSize: null,
    },
  };

  return ok({ nodes: [node], edges: [] });
};
