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

import { deriveDotSplitObjectAndApiName } from './path-utils.js';

const CMD_FILE_SUFFIX = '.md-meta.xml';
const ROOT_ELEMENT = 'CustomMetadata';
const EXTRACTOR_SOURCE = 'custom-metadata-record-extractor';
const ATTRIBUTE_PREFIX = '@_';
const TEXT_KEY = '#text';
const MASKED_LITERAL = '***';

/**
 * Per-`<values>` entry, as produced by `extractValueEntry`.
 *
 * The shape is intentionally identical to CustomSettingRecord's so the
 * `sfi.lookup_record` MCP tool can return a uniform payload for both
 * record types (per `CustomMetadataRecord.md` §"Node properties map").
 */
interface ValueEntry {
  readonly field: string;
  readonly value: string | number | boolean | null;
  readonly valueType: 'number' | 'string' | 'boolean' | 'null' | 'unknown';
  readonly isMasked: boolean;
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
 * array otherwise. Used for `<values>` which repeats once per field.
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
 * Locate the `<CustomMetadata>` root and verify required children per
 * `CustomMetadataRecord.md`. `<label>` and `<protected>` are the only
 * top-level required elements; `<values>` is variable-arity.
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
  if (rootObj['label'] === undefined) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <label>',
    });
  }
  if (rootObj['protected'] === undefined) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <protected>',
    });
  }
  const protectedRaw = unwrapSingle(rootObj['protected']);
  const protectedStr =
    typeof protectedRaw === 'string'
      ? protectedRaw.toLowerCase()
      : typeof protectedRaw === 'boolean'
        ? String(protectedRaw)
        : '';
  if (protectedStr !== 'true' && protectedStr !== 'false') {
    return err({
      kind: 'malformed-input',
      path,
      message: `invalid protected: ${String(protectedRaw)}`,
    });
  }
  return ok(rootObj);
};

/**
 * Map an `xsi:type` wire-format discriminator to the extractor's
 * `valueType` token. Salesforce serializes types as `xsd:double`,
 * `xsd:string`, `xsd:boolean`, `xsd:date`, etc. Per the doc table,
 * dates are stored as strings (downstream consumers parse).
 */
const mapXsiType = (
  xsiType: string | null,
): 'number' | 'string' | 'boolean' | 'unknown' => {
  if (xsiType === null) return 'unknown';
  const lower = xsiType.toLowerCase();
  if (lower.endsWith(':double') || lower.endsWith(':int') || lower.endsWith(':long') || lower.endsWith(':decimal')) {
    return 'number';
  }
  if (lower.endsWith(':boolean')) {
    return 'boolean';
  }
  if (lower.endsWith(':string') || lower.endsWith(':date') || lower.endsWith(':datetime')) {
    return 'string';
  }
  return 'unknown';
};

/**
 * Extract a single `<values>` entry's `(field, value, valueType, isMasked)`
 * tuple. Required: `<field>` child. Variable: the `<value>` child may be
 * absent (semantically null), self-closing with `xsi:nil="true"` (null),
 * carry the literal `***` (managed-package masked value), or carry typed
 * content discriminated by `xsi:type`.
 *
 * Returns an `ExtractorError` (`malformed-input`) when `<field>` is missing.
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

  // The `<value>` element is optional. Absent → null. Present-but-self-
  // closing also presents as undefined in fast-xml-parser output when the
  // element has no text and no attributes, and as an object carrying only
  // attribute keys when it is `<value xsi:nil="true"/>`. Both shapes route
  // through this branch.
  const rawValue = entry['value'];
  if (rawValue === undefined) {
    return ok({ field, value: null, valueType: 'null', isMasked: false });
  }
  const valueNode = unwrapSingle(rawValue);

  // The `<value>` may parse as a scalar (`<value>foo</value>` -> `"foo"`),
  // as an object (`<value xsi:type="xsd:string">foo</value>` ->
  // `{ "@_xsi:type": "xsd:string", "#text": "foo" }`), or as `null` /
  // empty-string for self-closing forms. Each shape collapses to a
  // `(textContent, xsiType, xsiNil)` triple below.
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
    // Scalar shape: the value is the text content directly.
    textContent = String(valueNode);
  }

  if (xsiNil) {
    return ok({ field, value: null, valueType: 'null', isMasked: false });
  }

  if (textContent === null || textContent === '') {
    // No xsi:nil but no content either — treat as null per the doc's
    // "absent value" semantics. valueType is `null` because nothing
    // identifies a type discriminator.
    return ok({ field, value: null, valueType: 'null', isMasked: false });
  }

  // Managed-package masked content: Salesforce serializes protected
  // values as the three-character literal `***` when the record is in a
  // managed package. The extractor MUST NOT fabricate the underlying
  // value (per PLAN-v1.6.md §3) — collapse to `value: null, isMasked: true`.
  if (textContent === MASKED_LITERAL) {
    const valueType = mapXsiType(xsiType);
    return ok({
      field,
      value: null,
      // Preserve a non-null valueType when xsi:type announced one; this is
      // the cue the skill uses to describe the masked value's shape
      // ("a masked string", "a masked number") without leaking content.
      valueType: valueType === 'unknown' ? 'string' : valueType,
      isMasked: true,
    });
  }

  const valueType = mapXsiType(xsiType);
  if (valueType === 'number') {
    const n = Number(textContent);
    if (Number.isFinite(n)) {
      return ok({ field, value: n, valueType: 'number', isMasked: false });
    }
    // Non-finite numeric — fall through to unknown rather than silently
    // coerce to NaN.
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
  // No xsi:type discriminator. Per the doc, the extractor would normally
  // fall back to the parent CustomField's dataType; that join is the
  // skill-layer responsibility. Here we surface the raw text content
  // with valueType: 'unknown' so the downstream consumer can resolve.
  return ok({ field, value: textContent, valueType: 'unknown', isMasked: false });
};

/**
 * Extract a Node and one `parentOf` edge from a single Salesforce
 * `customMetadata/{Type}.{Record}.md-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<CustomMetadata>` root
 * per the vendored `CustomMetadataRecord.md` spec, and returns an
 * `ExtractionResult` containing one `Node` of type `'CustomMetadataRecord'`
 * and one `parentOf` edge from `CustomObject:{TypeApiName}` (mirroring
 * v1.0's CustomField parentOf pattern).
 *
 * The canonical ID derives from the filename — `{TypeApiName}` and
 * `{RecordName}` are obtained by splitting the basename (minus
 * `.md-meta.xml`) on the first dot. The `__mdt` suffix is preserved in
 * both the canonical id and the `parentId` so the edge's `fromId`
 * visually aligns with the v1.0 type definition's id.
 *
 * Per-value handling follows the `<value>` shape table in the doc:
 * the literal `***` collapses to `{ value: null, isMasked: true }` (the
 * managed-package masked-content path); `xsi:nil="true"` and absent
 * `<value>` elements collapse to `{ value: null, isMasked: false }`;
 * typed scalars route through `xsi:type` to `number` / `string` /
 * `boolean` / `unknown` per the wire-format discriminator.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing required element, filename not splittable on a dot, or any
 * `<values>` entry missing `<field>`).
 *
 * @example
 *   const result = await extractCustomMetadataRecord(
 *     'tests/fixtures/synthetic-v1.6/customMetadata/Marketo_Api_Setting__mdt.Default.md-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'CustomMetadataRecord:Marketo_Api_Setting__mdt.Default'
 *   }
 */
export const extractCustomMetadataRecord = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = deriveDotSplitObjectAndApiName(path, CMD_FILE_SUFFIX);
  if (pathParts === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot split filename into type and record name',
    });
  }
  const { objectApiName: typeApiName, apiName: recordName } = pathParts;

  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is too
  // tight for production-scale CMD XML. Attributes are required here to
  // read `xsi:type` (the value-type discriminator) and `xsi:nil` (the
  // null marker); no other extractor parses attributes today, so the
  // option is enabled locally rather than as a shared default.
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

  const label = String(unwrapSingle(rootObj['label']));
  const isProtected = coerceBoolean(unwrapSingle(rootObj['protected']));

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
  const hasMaskedValues = values.some((v) => v.isMasked);

  const parentId = `CustomObject:${typeApiName}`;
  const nodeId = `CustomMetadataRecord:${typeApiName}.${recordName}`;
  const compositeApiName = `${typeApiName}.${recordName}`;

  const node: Node = {
    id: nodeId,
    type: 'CustomMetadataRecord',
    apiName: compositeApiName,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      label,
      protected: isProtected,
      recordName,
      typeApiName,
      valuesCount: values.length,
      values,
      hasMaskedValues,
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
