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

const EXTERNAL_DATA_SOURCE_FILE_SUFFIX = '.dataSource-meta.xml';
const ROOT_ELEMENT = 'ExternalDataSource';
const NODE_TYPE = 'ExternalDataSource';
const EXTRACTOR_SOURCE = 'external-data-source';
const REQUIRED_ELEMENTS = ['endpoint', 'type', 'isWritable'] as const;

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

/** Locate the `<ExternalDataSource>` root and verify required children per `ExternalDataSource.md`. */
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
 * `*.dataSource-meta.xml` file.
 *
 * Reads `<endpoint>`, `<type>`, `<isWritable>` (all required), and a
 * documented set of optional properties (`<label>`, `<authProvider>`,
 * `<credentialUser>`, `<principalType>`, `<protocol>`, `<repository>`).
 *
 * The XML `<type>` element is renamed to the `dataSourceType` property
 * to avoid collision with the contract-level `Node.type` field — per
 * `ExternalDataSource.md` §"Node properties map", which calls out the
 * rename explicitly so the renderer can surface the adapter-type as
 * "Adapter type" without confusion.
 *
 * Emits one `references` edge from this data source to
 * `AuthProvider:{authProvider}` when the `<authProvider>` element is
 * set. The edge confidence is `declared` (the binding is explicit in
 * the metadata XML); v1.5 does NOT validate that the named provider
 * exists in the extracted set — dangling edges are surfaced per the
 * v0.1 dangling-edge policy. The edge's `properties.role` is `'auth'`
 * per the task spec.
 *
 * Error cases (per vendored `ExternalDataSource.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<ExternalDataSource>` or a
 *     required element (`<endpoint>`, `<type>`, `<isWritable>`)
 *     is missing
 *
 * @example
 *   const result = await extractExternalDataSource(
 *     'force-app/main/default/dataSources/ERP_Connect.dataSource-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'ExternalDataSource:ERP_Connect'
 */
export const extractExternalDataSource = async (
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

  const apiName = deriveComponentApiName(path, EXTERNAL_DATA_SOURCE_FILE_SUFFIX);
  const nodeId = `${NODE_TYPE}:${apiName}`;
  const labelElement = optionalString(rootObj, 'label');
  const authProvider = optionalString(rootObj, 'authProvider');

  const node: Node = {
    id: nodeId,
    type: 'ExternalDataSource',
    apiName,
    // Per `ExternalDataSource.md`: `<label>` is optional in the XML;
    // when absent, label falls back to the API name (consistent with
    // RemoteSiteSetting / CspTrustedSite / NetworkAccess behaviour
    // across the v1.5 family).
    label: labelElement ?? apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      endpoint: String(unwrapSingle(rootObj['endpoint'])),
      // `<type>` is renamed to `dataSourceType` to avoid collision with
      // `Node.type` at the contract level. See vendored doc §"Node
      // properties map" for the renderer rationale.
      dataSourceType: String(unwrapSingle(rootObj['type'])),
      isWritable: coerceBoolean(unwrapSingle(rootObj['isWritable'])),
      authProvider,
      credentialUser: optionalString(rootObj, 'credentialUser'),
      principalType: optionalString(rootObj, 'principalType'),
      protocol: optionalString(rootObj, 'protocol'),
      repository: optionalString(rootObj, 'repository'),
    },
  };

  // Per `ExternalDataSource.md` §Edges: emit one `references` edge to
  // `AuthProvider:{authProvider}` when `<authProvider>` is set. When
  // absent, zero edges are emitted. Edge confidence is `declared`
  // (the binding is explicit in the metadata XML).
  const edges: Edge[] =
    authProvider === null
      ? []
      : [
          {
            fromId: nodeId,
            toId: `AuthProvider:${authProvider}`,
            edgeType: 'references',
            confidence: 'declared',
            source: EXTRACTOR_SOURCE,
            properties: { role: 'auth' },
          },
        ];

  return ok({ nodes: [node], edges });
};
