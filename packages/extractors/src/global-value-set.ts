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

const GLOBAL_VALUE_SET_FILE_SUFFIX = '.globalValueSet-meta.xml';
const ROOT_ELEMENT = 'GlobalValueSet';
const REQUIRED_ELEMENTS = ['masterLabel'] as const;
const PER_VALUE_REQUIRED_ELEMENTS = ['fullName', 'default'] as const;

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise. Used for `<customValue>` entries —
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

/** Locate the `<GlobalValueSet>` root and verify required children. */
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
 * Validate each `<customValue>` entry carries the required scalars
 * (`<fullName>`, `<default>`) per `GlobalValueSet.md`. v1.2 surfaces
 * only the count in `properties.valueCount`; per-value details are
 * out of scope, but the well-formedness check still runs so a
 * truncated source file doesn't silently produce a healthy-looking
 * node with an under-counted `valueCount`.
 */
const validateCustomValues = (
  rootObj: Record<string, unknown>,
  path: string,
): Result<readonly string[], ExtractorError> => {
  const values = toArray(rootObj['customValue']).filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
  );
  for (const value of values) {
    for (const required of PER_VALUE_REQUIRED_ELEMENTS) {
      if (value[required] === undefined) {
        return err({
          kind: 'malformed-input',
          path,
          message: `missing required element: <${required}>`,
        });
      }
    }
  }
  // P14-USAGE-gvs-edge: surface the per-value fullNames, not just the count —
  // a GlobalValueSet that only said "valueCount: 4" could never answer
  // "what values are in this picklist?" for the fields that use it.
  return ok(values.map((v) => String(unwrapSingle(v['fullName']))));
};

/**
 * Extract a Node from a single Salesforce Global Value Set file.
 *
 * Reads `<masterLabel>` (required) and optional `<description>` and
 * `<sorted>` into the node's properties. Per-value entries (`<customValue>`)
 * are counted into `properties.valueCount` AND their `<fullName>`s surfaced
 * as `properties.values` (P14-USAGE-gvs-edge — the answer to "what values
 * are in this picklist?" for GlobalValueSet-driven fields); each entry is
 * validated for its required sub-elements (`<fullName>`, `<default>`), with
 * other per-value details (label, default, isActive) still out of scope. A
 * file with zero `<customValue>` entries is the documented happy path for
 * placeholder sets and yields `valueCount: 0`.
 *
 * Returns one `Node` of type `'GlobalValueSet'` and zero edges. The
 * reciprocal `usesValueSet` edge (`CustomField -> GlobalValueSet`) is
 * emitted by the CustomField extractor (REAL as of P14-USAGE-gvs-edge —
 * this comment described that edge for two minor versions while no code
 * emitted it; FINDINGS P-GVS-EDGE); this extractor only emits the node.
 *
 * Error cases (per vendored `GlobalValueSet.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<GlobalValueSet>`, the
 *     required `<masterLabel>` is missing, or any `<customValue>` entry
 *     lacks `<fullName>` or `<default>`
 *
 * @example
 *   const result = await extractGlobalValueSet(
 *     'force-app/main/default/globalValueSets/Country_Codes.globalValueSet-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'GlobalValueSet:Country_Codes'
 */
export const extractGlobalValueSet = async (
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

  const valuesResult = validateCustomValues(rootObj, path);
  if (!valuesResult.ok) return valuesResult;
  const values = valuesResult.value;
  const valueCount = values.length;

  const apiName = deriveComponentApiName(path, GLOBAL_VALUE_SET_FILE_SUFFIX);
  const masterLabel = String(unwrapSingle(rootObj['masterLabel']));

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'GlobalValueSet',
    apiName,
    label: masterLabel,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      masterLabel,
      description: optionalString(rootObj, 'description'),
      sorted: coerceBoolean(unwrapSingle(rootObj['sorted'])),
      restricted: coerceBoolean(unwrapSingle(rootObj['restricted'])),
      valueCount,
      values,
    },
  };

  return ok({ nodes: [node], edges: [] });
};
