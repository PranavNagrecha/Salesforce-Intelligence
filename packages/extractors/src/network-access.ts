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

const NETWORK_ACCESS_FILE_SUFFIX = '.networkAccess-meta.xml';
const ROOT_ELEMENT = 'NetworkAccess';
const REQUIRED_ELEMENTS = ['startAddress', 'endAddress'] as const;

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

/** Locate the `<NetworkAccess>` root and verify required children per `NetworkAccess.md`. */
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
 * Extract a Node from a single Salesforce `*.networkAccess-meta.xml`
 * file.
 *
 * Reads `<startAddress>` and `<endAddress>` (both required) and the
 * optional `<description>`. NetworkAccess entries carry no `<label>`
 * element in the XML; the `Node.label` falls back to the filename's
 * API name per `NetworkAccess.md` §"Node field mapping".
 *
 * **Important: `NetworkAccess` is the IP-range trust list, NOT the
 * Network / Experience Cloud Site metadata family.** The two share
 * the XML-namespace prefix `Network` but are otherwise unrelated. The
 * Salesforce admin UI calls these "Trusted IP Ranges"; the
 * conversational name is "trusted IPs." Experience Cloud Sites are a
 * separate `Network` ComponentType (out of v1.5 scope).
 *
 * Returns one `Node` of type `'NetworkAccess'` and zero edges. The
 * v1.5 integration map surfaces these as stand-alone trust ranges
 * under the `networkAccesses[]` summary array. The extractor does
 * NOT validate IP-address syntax or that `startAddress <= endAddress`
 * — Salesforce performs both checks at deploy time, and the offline
 * extractor's job is to surface the source faithfully.
 *
 * Error cases (per vendored `NetworkAccess.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<NetworkAccess>` or a
 *     required element (`<startAddress>` or `<endAddress>`) is missing
 *
 * @example
 *   const result = await extractNetworkAccess(
 *     'force-app/main/default/networkAccesses/Corporate_VPN.networkAccess-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'NetworkAccess:Corporate_VPN'
 */
export const extractNetworkAccess = async (
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

  const apiName = deriveComponentApiName(path, NETWORK_ACCESS_FILE_SUFFIX);

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'NetworkAccess',
    apiName,
    // Per `NetworkAccess.md`: the XML has no `<label>` element, so
    // `label` falls back to the API name. The architect-integration-
    // topology skill cites the `description` (when set) otherwise the
    // start/end IP pair.
    label: apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      startAddress: String(unwrapSingle(rootObj['startAddress'])),
      endAddress: String(unwrapSingle(rootObj['endAddress'])),
      description: optionalString(rootObj, 'description'),
    },
  };

  return ok({ nodes: [node], edges: [] });
};
