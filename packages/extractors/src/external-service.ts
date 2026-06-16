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

const EXTERNAL_SERVICE_FILE_SUFFIX = '.externalServiceRegistration-meta.xml';
const ROOT_ELEMENT = 'ExternalServiceRegistration';
const NODE_TYPE = 'ExternalService';
const EXTRACTOR_SOURCE = 'external-service';
const REQUIRED_ELEMENTS = ['label', 'schemaType', 'status'] as const;

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

/**
 * Locate the `<ExternalServiceRegistration>` root and verify required
 * children per `ExternalService.md`. Note: the metadata-XML root tag is
 * `<ExternalServiceRegistration>` (matching the Salesforce metadata
 * type name) but the ComponentType in the v1.5 contract is the shorter
 * `ExternalService`.
 */
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
 * `*.externalServiceRegistration-meta.xml` file.
 *
 * Reads `<label>`, `<schemaType>`, `<status>` (all required), the
 * schema-source elements `<schemaUrl>` and inline `<schema>` (renamed
 * to `schemaInline` in the properties map per the vendored doc to
 * avoid frontmatter overload of the word `schema`), and a documented
 * set of optional properties (`<description>`, `<namedCredential>`,
 * `<serviceBinding>`, `<systemVersion>`, `<registrationProviderType>`).
 *
 * The XML root tag is `<ExternalServiceRegistration>` (the Salesforce
 * metadata-type name) but the canonical-ID prefix is `ExternalService`
 * (the shorter conversational name carried in the v1.5 contract). The
 * extractor does NOT validate which of `<schemaUrl>` / `<schema>` is
 * present — both may be absent, or both present, and the renderer
 * surfaces whichever it sees as a property.
 *
 * Emits one `references` edge from this service to
 * `NamedCredential:{namedCredential}` when the `<namedCredential>`
 * element is set. The edge confidence is `declared` (the binding is
 * explicit in the metadata XML); v1.5 does NOT validate that the
 * named credential exists in the extracted set — dangling edges are
 * surfaced per the v0.1 dangling-edge policy. The edge's
 * `properties.role` is `'credential'` per the task spec.
 *
 * Error cases (per vendored `ExternalService.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<ExternalServiceRegistration>`
 *     or a required element (`<label>`, `<schemaType>`, `<status>`)
 *     is missing
 *
 * @example
 *   const result = await extractExternalService(
 *     'force-app/main/default/externalServiceRegistrations/Weather_Service.externalServiceRegistration-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'ExternalService:Weather_Service'
 */
export const extractExternalService = async (
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

  const apiName = deriveComponentApiName(path, EXTERNAL_SERVICE_FILE_SUFFIX);
  const nodeId = `${NODE_TYPE}:${apiName}`;
  const namedCredential = optionalString(rootObj, 'namedCredential');

  const node: Node = {
    id: nodeId,
    type: 'ExternalService',
    apiName,
    label: String(unwrapSingle(rootObj['label'])),
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      schemaType: String(unwrapSingle(rootObj['schemaType'])),
      schemaUrl: optionalString(rootObj, 'schemaUrl'),
      // The XML element name `<schema>` is renamed to `schemaInline`
      // in the properties map per the vendored doc — `schema:` is
      // overloaded in the Markdown vault's frontmatter for
      // metadata-shape declarations, so the rename avoids reader
      // confusion at render time.
      schemaInline: optionalString(rootObj, 'schema'),
      status: String(unwrapSingle(rootObj['status'])),
      description: optionalString(rootObj, 'description'),
      namedCredential,
      serviceBinding: optionalString(rootObj, 'serviceBinding'),
      systemVersion: optionalString(rootObj, 'systemVersion'),
      registrationProviderType: optionalString(
        rootObj,
        'registrationProviderType',
      ),
    },
  };

  // Per `ExternalService.md` §Edges: emit one `references` edge to
  // `NamedCredential:{namedCredential}` when `<namedCredential>` is
  // set. When absent, zero edges are emitted. Edge confidence is
  // `declared` (the binding is explicit in the metadata XML).
  const edges: Edge[] =
    namedCredential === null
      ? []
      : [
          {
            fromId: nodeId,
            toId: `NamedCredential:${namedCredential}`,
            edgeType: 'references',
            confidence: 'declared',
            source: EXTRACTOR_SOURCE,
            properties: { role: 'credential' },
          },
        ];

  return ok({ nodes: [node], edges });
};
