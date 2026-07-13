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

const STANDARD_VALUE_SET_FILE_SUFFIX = '.standardValueSet-meta.xml';
const ROOT_ELEMENT = 'StandardValueSet';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise. Used for `<standardValue>` entries —
 * Salesforce serializes a single value as a scalar object and multiple
 * values as an array, so the extractor must tolerate both shapes.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Coerce an XML scalar to boolean; non-`true` values become false (per SF defaults). */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
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

/** One resolved `<standardValue>` entry: `fullName` (the display value — a StandardValue has no separate `<label>`) + activation status. */
interface StandardValueEntry {
  readonly apiName: string;
  readonly active: boolean;
}

/**
 * Validate each `<standardValue>` entry carries the one truly required
 * scalar (`<fullName>`) per the Metadata API Developer Guide's StandardValue
 * field reference (`fullName`, `groupingString`, `default`, `isActive` — only
 * `fullName` is unconditional). `<isActive>` defaults to `true` when absent
 * (Salesforce omits it for the common case: an active value); `<default>` is
 * read but not surfaced (v0.1 scope is "what values exist and are they
 * active", not "which one is the field's default").
 */
const validateAndReadStandardValues = (
  rootObj: Record<string, unknown>,
  path: string,
): Result<readonly StandardValueEntry[], ExtractorError> => {
  const rawValues = toArray(rootObj['standardValue']).filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
  );
  const entries: StandardValueEntry[] = [];
  for (const value of rawValues) {
    const fullName = unwrapSingle(value['fullName']);
    if (fullName === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <fullName>',
      });
    }
    const isActiveRaw = unwrapSingle(value['isActive']);
    entries.push({
      apiName: String(fullName),
      // Absent <isActive> means the value is active — Salesforce only emits
      // the element for values an admin has explicitly deactivated.
      active: isActiveRaw === undefined ? true : coerceBoolean(isActiveRaw),
    });
  }
  return ok(entries);
};

/**
 * Extract a Node from a single Salesforce Standard Value Set file — the
 * org-wide definition of a STANDARD picklist's value set (Industry,
 * LeadSource, OpportunityStage, …). This is the standard-field counterpart to
 * `GlobalValueSet` (custom, org-wide) and a CustomField's inline `<picklist>`
 * (custom, field-scoped) — before R6-08 the standard-picklist family was
 * entirely unmodeled: zero ComponentType, zero extraction.
 *
 * Reads `<sorted>` (defaults `false` when absent, same convention as
 * GlobalValueSet) and each `<standardValue>` entry into
 * `properties.values` as `{ apiName, active }` — the Metadata API's
 * `StandardValue` has no separate `<label>` field (unlike GlobalValueSet's
 * `<customValue>`, which does carry one in practice), so `fullName` doubles
 * as the value's display text. `properties.valueCount` mirrors the array
 * length for direct reads without counting client-side.
 *
 * EDGE-LESS by design (see the `ComponentType` union doc in
 * `@sf-intelligence/contracts`): unlike GlobalValueSet, a standard field's
 * binding to its StandardValueSet is implicit (Salesforce wires it
 * internally by the field's own type), not a declared metadata pointer this
 * extractor can read an edge from — emitting one would be a fabricated
 * inference, not a parsed fact.
 *
 * A file with zero `<standardValue>` entries is tolerated (mirrors
 * GlobalValueSet's placeholder-set leniency) and yields `valueCount: 0`,
 * even though real Salesforce metadata always carries at least one value.
 *
 * Error cases:
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<StandardValueSet>`, or any
 *     `<standardValue>` entry lacks `<fullName>`
 *
 * @example
 *   const r = await extractStandardValueSet(
 *     'standardValueSets/LeadSource.standardValueSet-meta.xml',
 *   );
 *   if (r.ok) console.log(r.value.nodes[0].properties.values);
 *   // => [{ apiName: 'Web', active: true }, ...]
 */
export const extractStandardValueSet = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is too tight
  // for a large standard value set (e.g. Country/State postal-code sets).
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

  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({ kind: 'malformed-input', path, message: `expected <${ROOT_ELEMENT}> root` });
  }
  const rootObj = root as Record<string, unknown>;

  const valuesResult = validateAndReadStandardValues(rootObj, path);
  if (!valuesResult.ok) return valuesResult;
  const values = valuesResult.value;

  const apiName = deriveComponentApiName(path, STANDARD_VALUE_SET_FILE_SUFFIX);
  const sorted = coerceBoolean(unwrapSingle(rootObj['sorted']));

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'StandardValueSet',
    apiName,
    label: null,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      sorted,
      valueCount: values.length,
      values,
    },
  };

  return ok({ nodes: [node], edges: [] });
};
