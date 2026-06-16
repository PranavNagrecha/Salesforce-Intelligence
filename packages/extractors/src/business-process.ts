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

const BUSINESS_PROCESS_FILE_SUFFIX = '.businessProcess-meta.xml';
const BUSINESS_PROCESSES_DIR_NAME = 'businessProcesses';
const ROOT_ELEMENT = 'BusinessProcess';
const EXTRACTOR_SOURCE = 'business-process-extractor';
const REQUIRED_ELEMENTS = ['fullName', 'isActive'] as const;

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Single-occurrence BusinessProcess elements
 * use this helper.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a single-element
 * array otherwise. Used for `<values>` (stage entries) which may repeat
 * once per stage.
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
 * Locate the `<BusinessProcess>` root and verify required children per
 * `BusinessProcess.md`.
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
 * Extract a Node and one edge from a single Salesforce
 * `*.businessProcess-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<BusinessProcess>`
 * root per the vendored `BusinessProcess.md` spec, and returns an
 * `ExtractionResult` containing one `Node` of type `'BusinessProcess'`
 * and one `parentOf` edge from the enclosing CustomObject.
 *
 * The node `label` mirrors the basename-derived `BusinessProcessName`
 * because BusinessProcess metadata has no separate `<label>` element.
 * `properties.stageCount` is the count of `<values>` entries (each one
 * declares a stage in the process); v1.2 does not emit field-level
 * picklist-value edges, that lands in v1.3.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing required element, or unrecognized DX path layout).
 *
 * @example
 *   const result = await extractBusinessProcess(
 *     'tests/fixtures/synthetic-v1.2/objects/Opportunity/businessProcesses/Sales_Process.businessProcess-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'BusinessProcess:Opportunity.Sales_Process'
 *   }
 */
export const extractBusinessProcess = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = deriveNestedObjectAndApiName(
    path,
    BUSINESS_PROCESS_FILE_SUFFIX,
    BUSINESS_PROCESSES_DIR_NAME,
  );
  if (pathParts === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot resolve parent object from path',
    });
  }
  const { objectApiName, apiName: businessProcessName } = pathParts;

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
  const nodeId = `${ROOT_ELEMENT}:${objectApiName}.${businessProcessName}`;
  const compositeApiName = `${objectApiName}.${businessProcessName}`;
  const fullName = String(unwrapSingle(rootObj['fullName']));
  const isActive = coerceBoolean(unwrapSingle(rootObj['isActive']));
  const stageCount = toArray(rootObj['values']).length;

  const node: Node = {
    id: nodeId,
    type: 'BusinessProcess',
    apiName: compositeApiName,
    label: businessProcessName,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      fullName,
      isActive,
      description: optionalString(rootObj, 'description'),
      stageCount,
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

  return ok({ nodes: [node], edges });
};
