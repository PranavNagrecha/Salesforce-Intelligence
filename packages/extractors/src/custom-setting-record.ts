import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

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

const CSR_FILE_SUFFIX = '.dataset-meta.xml';
const ROOT_ELEMENT = 'CustomSettingRecord';
const EXTRACTOR_SOURCE = 'custom-setting-record-extractor';
const ATTRIBUTE_PREFIX = '@_';
const TEXT_KEY = '#text';

/**
 * Per-`<values>` entry shape, identical to CustomMetadataRecord's so the
 * `sfi.lookup_record` MCP tool can return a uniform payload for both
 * record types. `isMasked` is always `false` for CustomSetting records
 * (per `CustomSettingRecord.md` §"Variable fields"): Custom Settings do
 * not participate in managed-package `protected` field semantics.
 */
interface ValueEntry {
  readonly field: string;
  readonly value: string | number | boolean | null;
  readonly valueType: 'number' | 'string' | 'boolean' | 'null' | 'unknown';
  readonly isMasked: false;
}

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Single-occurrence elements use this helper.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a single-element
 * array otherwise.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Coerce an XML scalar to a boolean.
 */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/**
 * Read and strictly-validate a file as XML.
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
 * Locate the `<CustomSettingRecord>` root and verify the required `<name>`
 * element per `CustomSettingRecord.md`. `<setupOwnerId>` is required for
 * Hierarchy Custom Settings only; the extractor cannot reliably know the
 * variant without the parent type, so it surfaces whatever is present
 * and lets the skill layer reconcile.
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
  const nameRaw = unwrapSingle(rootObj['name']);
  if (nameRaw === undefined || nameRaw === null || nameRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required field: Name',
    });
  }
  return ok(rootObj);
};

/**
 * Map an `xsi:type` wire-format discriminator to the extractor's
 * `valueType` token.
 */
const mapXsiType = (
  xsiType: string | null,
): 'number' | 'string' | 'boolean' | 'unknown' => {
  if (xsiType === null) return 'unknown';
  const lower = xsiType.toLowerCase();
  if (
    lower.endsWith(':double') ||
    lower.endsWith(':int') ||
    lower.endsWith(':long') ||
    lower.endsWith(':decimal')
  ) {
    return 'number';
  }
  if (lower.endsWith(':boolean')) {
    return 'boolean';
  }
  if (
    lower.endsWith(':string') ||
    lower.endsWith(':date') ||
    lower.endsWith(':datetime')
  ) {
    return 'string';
  }
  return 'unknown';
};

/**
 * Extract a single `<values>` entry's tuple. Required: `<field>` child.
 * Variable: the `<value>` child may be absent (null), self-closing with
 * `xsi:nil="true"` (null), or carry typed content discriminated by
 * `xsi:type`. Unlike CustomMetadataRecord, no masked-content branch
 * applies (CustomSetting records never carry `***` from the metadata layer).
 */
const extractValueEntry = (
  entry: Record<string, unknown>,
  index: number,
  path: string,
): Result<ValueEntry, ExtractorError> => {
  const fieldRaw = unwrapSingle(entry['field']);
  if (fieldRaw === undefined || fieldRaw === null || fieldRaw === '') {
    return err({
      kind: 'malformed-input',
      path,
      message: `missing required element: <field> in <values> entry ${index}`,
    });
  }
  const field = String(fieldRaw);

  const rawValue = entry['value'];
  if (rawValue === undefined) {
    return ok({ field, value: null, valueType: 'null', isMasked: false });
  }
  const valueNode = unwrapSingle(rawValue);

  let textContent: string | null = null;
  let xsiType: string | null = null;
  let xsiNil = false;

  if (valueNode === null || valueNode === undefined) {
    textContent = null;
  } else if (typeof valueNode === 'object') {
    const obj = valueNode as Record<string, unknown>;
    const typeAttr = obj[`${ATTRIBUTE_PREFIX}xsi:type`];
    if (typeof typeAttr === 'string') xsiType = typeAttr;
    const nilAttr = obj[`${ATTRIBUTE_PREFIX}xsi:nil`];
    if (
      nilAttr === true ||
      (typeof nilAttr === 'string' && nilAttr.toLowerCase() === 'true')
    ) {
      xsiNil = true;
    }
    const text = obj[TEXT_KEY];
    if (text !== undefined && text !== null) {
      textContent = String(text);
    }
  } else {
    textContent = String(valueNode);
  }

  if (xsiNil) {
    return ok({ field, value: null, valueType: 'null', isMasked: false });
  }

  if (textContent === null || textContent === '') {
    return ok({ field, value: null, valueType: 'null', isMasked: false });
  }

  const valueType = mapXsiType(xsiType);
  if (valueType === 'number') {
    const n = Number(textContent);
    if (Number.isFinite(n)) {
      return ok({ field, value: n, valueType: 'number', isMasked: false });
    }
    return ok({ field, value: textContent, valueType: 'unknown', isMasked: false });
  }
  if (valueType === 'boolean') {
    return ok({
      field,
      value: coerceBoolean(textContent),
      valueType: 'boolean',
      isMasked: false,
    });
  }
  if (valueType === 'string') {
    return ok({ field, value: textContent, valueType: 'string', isMasked: false });
  }
  return ok({ field, value: textContent, valueType: 'unknown', isMasked: false });
};

/**
 * Derive `{TypeApiName}` from the XML file path. Per
 * `CustomSettingRecord.md` Shape 2, the file lives at
 * `customSettings/{TypeApiName}/{RecordName}.dataset-meta.xml`. The
 * TypeApiName is the immediate parent directory name; the RecordName is
 * the basename with the `.dataset-meta.xml` suffix stripped.
 *
 * Validates that the type name ends in `__c` — the CustomSetting variant
 * is gated on this suffix per the doc.
 */
const derivePathParts = (
  path: string,
): Result<{ typeApiName: string; recordName: string }, ExtractorError> => {
  const recordName = deriveComponentApiName(path, CSR_FILE_SUFFIX);
  const typeApiName = basename(dirname(path));
  if (typeApiName.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot derive TypeApiName from path',
    });
  }
  if (!typeApiName.endsWith('__c')) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected __c CustomSetting type; got: ${typeApiName}`,
    });
  }
  return ok({ typeApiName, recordName });
};

/**
 * Extract a Node and one `parentOf` edge from a single Salesforce
 * Custom Setting record XML file.
 *
 * **v1.6 boundary**: Custom Setting records are NOT a first-class
 * Salesforce DX metadata file shape — they live as data in the org and
 * require `sf data tree:export` or `sf data query` to materialize. This
 * extractor handles the rare case where records ARE present in the
 * source tree as per-record XML (Shape 2 in
 * `CustomSettingRecord.md`). The common case is honestly disclosed at
 * the `sfi.lookup_record` tool layer, which routes the user to
 * `sf data query`.
 *
 * Reads `customSettings/{TypeApiName}/{RecordName}.dataset-meta.xml`,
 * parses it as XML, validates the `<CustomSettingRecord>` root per the
 * vendored doc, and returns an `ExtractionResult` with one Node of type
 * `'CustomSettingRecord'` and one `parentOf` edge from
 * `CustomObject:{TypeApiName}` (with `__c` suffix preserved).
 *
 * `customSettingType` is left `null` — the variant ('List' / 'Hierarchy')
 * is read from the parent CustomObject's `properties.customSettingsType`
 * by the skill layer at query time; per-extractor join would require
 * cross-file state that v1.6 does not introduce. `setupOwnerId` is
 * passed through verbatim when present (relevant only for Hierarchy
 * records) and `null` otherwise.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<name>`, type API name not ending in `__c`, or any `<values>`
 * entry missing `<field>`).
 *
 * @example
 *   const result = await extractCustomSettingRecord(
 *     'tests/fixtures/synthetic-v1.6/customSettings/Marketo_Api_Settings__c/SystemDefault.dataset-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'CustomSettingRecord:Marketo_Api_Settings__c.SystemDefault'
 *   }
 */
export const extractCustomSettingRecord = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = derivePathParts(path);
  if (!pathParts.ok) return pathParts;
  const { typeApiName, recordName: pathRecordName } = pathParts.value;

  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTRIBUTE_PREFIX,
    textNodeName: TEXT_KEY,
    parseTagValue: false,
    parseAttributeValue: false,
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

  // Prefer the in-XML `<name>` over the filename-derived record name
  // when they differ. The doc's canonical-id rule keys off the XML `name`
  // (the row's DeveloperName); the filename is a vault-layout convention.
  const xmlNameRaw = unwrapSingle(rootObj['name']);
  const recordName = String(xmlNameRaw);
  // The filename-derived record name is preserved as a sanity-check
  // signal for debugging — silently ignored when they disagree. The
  // doc does not require a hard mismatch error for this XML shape
  // (Shape 2 is org-local convention; not the canonical MDAPI shape).
  void pathRecordName;

  const setupOwnerIdRaw = unwrapSingle(rootObj['setupOwnerId']);
  const setupOwnerId =
    setupOwnerIdRaw === undefined ||
    setupOwnerIdRaw === null ||
    setupOwnerIdRaw === ''
      ? null
      : String(setupOwnerIdRaw);

  const valueEntries = toArray(rootObj['values']).filter(
    (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
  );
  const values: ValueEntry[] = [];
  for (let i = 0; i < valueEntries.length; i += 1) {
    const entry = valueEntries[i]!;
    const extracted = extractValueEntry(entry, i, path);
    if (!extracted.ok) return extracted;
    values.push(extracted.value);
  }

  const parentId = `CustomObject:${typeApiName}`;
  const nodeId = `CustomSettingRecord:${typeApiName}.${recordName}`;
  const compositeApiName = `${typeApiName}.${recordName}`;

  // Custom Setting records have no per-row label distinct from Name —
  // the doc explicitly sets `label = apiName`. Surface that here.
  const node: Node = {
    id: nodeId,
    type: 'CustomSettingRecord',
    apiName: compositeApiName,
    label: compositeApiName,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      recordName,
      typeApiName,
      customSettingType: null,
      setupOwnerId,
      valuesCount: values.length,
      values,
      hasMaskedValues: false,
    },
  };

  const parentEdge: Edge = {
    fromId: parentId,
    toId: nodeId,
    edgeType: 'parentOf',
    confidence: 'declared',
    source: EXTRACTOR_SOURCE,
    properties: {},
  };

  return ok({ nodes: [node], edges: [parentEdge] });
};
