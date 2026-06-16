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

import { deriveNestedObjectAndApiName } from './path-utils.js';

const RECORD_TYPE_FILE_SUFFIX = '.recordType-meta.xml';
const RECORD_TYPES_DIR_NAME = 'recordTypes';
const ROOT_ELEMENT = 'RecordType';
const EXTRACTOR_SOURCE = 'record-type-extractor';
const REQUIRED_ELEMENTS = ['fullName', 'label', 'active'] as const;

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Single-occurrence RecordType elements use
 * this helper.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a single-element
 * array otherwise. Used for `<picklistValues>` which may repeat once per
 * picklist field on the parent object.
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
  if (raw === undefined || raw === null) return null;
  return String(raw);
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

/**
 * Locate the `<RecordType>` root and verify required children per
 * `RecordType.md`.
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
 * Extract a Node and edges from a single Salesforce
 * `*.recordType-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<RecordType>` root per
 * the vendored `RecordType.md` spec, and returns an `ExtractionResult`
 * containing one `Node` of type `'RecordType'`, one `parentOf` edge from
 * the enclosing CustomObject, and an optional `references` edge to a
 * BusinessProcess when `<businessProcess>` is set.
 *
 * The canonical ID derives from the path (grandparent directory) and
 * filename, not from the `<fullName>` element — the doc explicitly notes
 * that the filename wins for canonical ID construction and `<fullName>`
 * is preserved in `properties.fullName` for diagnostics only.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing required element, or unrecognized DX path layout).
 *
 * @example
 *   const result = await extractRecordType(
 *     'tests/fixtures/edu-org/source/main/default/objects/Faculty_List__c/recordTypes/Course.recordType-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'RecordType:Faculty_List__c.Course'
 *   }
 */
export const extractRecordType = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = deriveNestedObjectAndApiName(
    path,
    RECORD_TYPE_FILE_SUFFIX,
    RECORD_TYPES_DIR_NAME,
  );
  if (pathParts === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot resolve parent object from path',
    });
  }
  const { objectApiName, apiName: recordTypeName } = pathParts;

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

  const parentId = `CustomObject:${objectApiName}`;
  const nodeId = `${ROOT_ELEMENT}:${objectApiName}.${recordTypeName}`;
  const compositeApiName = `${objectApiName}.${recordTypeName}`;
  const label = String(unwrapSingle(rootObj['label']));
  const fullName = String(unwrapSingle(rootObj['fullName']));
  const active = coerceBoolean(unwrapSingle(rootObj['active']));
  const businessProcess = optionalString(rootObj, 'businessProcess');
  const picklistFieldCount = toArray(rootObj['picklistValues']).length;

  const node: Node = {
    id: nodeId,
    type: 'RecordType',
    apiName: compositeApiName,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      fullName,
      label,
      active,
      description: optionalString(rootObj, 'description'),
      businessProcess,
      picklistFieldCount,
    },
  };

  const edges: Edge[] = [
    {
      fromId: parentId,
      toId: nodeId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    },
  ];

  // Per RecordType.md "Edges": emit a `references` edge to the
  // BusinessProcess only when `<businessProcess>` is present and non-empty.
  // The BusinessProcess node may or may not have been extracted; dangling
  // `references` edges are tolerated by the graph store.
  if (businessProcess !== null && businessProcess.length > 0) {
    edges.push({
      fromId: nodeId,
      toId: `BusinessProcess:${objectApiName}.${businessProcess}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    });
  }

  return ok({ nodes: [node], edges });
};
