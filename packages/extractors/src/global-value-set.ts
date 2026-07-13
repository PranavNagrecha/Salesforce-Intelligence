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

/**
 * Coerce a `<customValue>`'s `<isActive>` element with a default of `true` —
 * the INVERSE default of {@link coerceBoolean}. Salesforce DX-source OMITS
 * `<isActive>` for ACTIVE values and only writes `<isActive>false</isActive>`
 * on a value an admin has explicitly deactivated (confirmed against a real
 * production-scale org's GlobalValueSet source: active entries carry no
 * `<isActive>` element at all; deactivated ones carry `false`). Identical in
 * spirit to `coerceIsActiveDefaultTrue` in custom-field.ts — kept as a
 * separate local helper (not shared) matching this package's per-file
 * convention (see `toNullableString` et al., duplicated per extractor rather
 * than centralized). Reusing the `false`-defaulting `coerceBoolean` here
 * would mark every active value inactive on every real GlobalValueSet.
 */
const coerceIsActiveDefaultTrue = (value: unknown): boolean => {
  const v = unwrapSingle(value);
  return v === undefined ? true : coerceBoolean(v);
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
 * One resolved `<customValue>` entry (H10 shape — CR-10b): the value's API
 * name, activation status, and the optional display label / default flag
 * when the source recorded them. Mirrors `PicklistValue` in custom-field.ts
 * (the CustomField inline picklist) and `StandardValueEntry` in
 * standard-value-set.ts exactly, so a GlobalValueSet-resolved value and an
 * inline-defined one are shaped alike for downstream consumers.
 *
 * `isActive: false` marks a DEACTIVATED value — RETAINED, not selectable for
 * new records, but existing records may still hold it. Deactivated values
 * are NEVER filtered out of `properties.values`: an admin asking "what
 * values are (or were) in this value set?" needs the full picture, and
 * every other picklist-value-shaped property this vault emits (CustomField
 * inline `picklistValues`, `StandardValueSet.values`) follows the same
 * retain-and-mark rule — silently dropping GlobalValueSet's inactive
 * entries would be the one inconsistent exception.
 */
interface GlobalValueSetValueEntry {
  readonly value: string;
  readonly isActive: boolean;
  readonly label?: string;
  readonly default?: boolean;
}

/**
 * Validate each `<customValue>` entry carries the required scalars
 * (`<fullName>`, `<default>`) per `GlobalValueSet.md`, and read each into
 * the H10 value shape `{value, isActive, label?, default?}` (CR-10b —
 * `label`/`default` are OMIT-when-absent, mirroring custom-field.ts's inline
 * picklist reader, though `default` is validated required above so it is
 * present on every well-formed entry in practice). The well-formedness check
 * still runs first so a truncated source file doesn't silently produce a
 * healthy-looking node with an under-counted `valueCount`.
 */
const validateAndReadCustomValues = (
  rootObj: Record<string, unknown>,
  path: string,
): Result<readonly GlobalValueSetValueEntry[], ExtractorError> => {
  const rawValues = toArray(rootObj['customValue']).filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
  );
  for (const value of rawValues) {
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
  // P14-USAGE-gvs-edge: surface the per-value entries, not just the count —
  // a GlobalValueSet that only said "valueCount: 4" could never answer
  // "what values are in this picklist?" for the fields that use it.
  return ok(
    rawValues.map((v) => {
      const value = String(unwrapSingle(v['fullName']));
      const isActive = coerceIsActiveDefaultTrue(v['isActive']);
      const label = optionalString(v, 'label');
      const out: GlobalValueSetValueEntry = { value, isActive };
      return {
        ...out,
        ...(label !== null ? { label } : {}),
        ...(unwrapSingle(v['default']) !== undefined
          ? { default: coerceBoolean(unwrapSingle(v['default'])) }
          : {}),
      };
    }),
  );
};

/**
 * Extract a Node from a single Salesforce Global Value Set file.
 *
 * Reads `<masterLabel>` (required) and optional `<description>` and
 * `<sorted>` into the node's properties. Per-value entries (`<customValue>`)
 * are counted into `properties.valueCount` AND read into `properties.values`
 * as `{value, isActive, label?, default?}` (P14-USAGE-gvs-edge + CR-10b —
 * the answer to "what values are in this picklist?" for GlobalValueSet-driven
 * fields, now with the same honest activation status the CustomField inline
 * picklist and StandardValueSet extractors carry — see
 * {@link GlobalValueSetValueEntry}); each entry is validated for its
 * required sub-elements (`<fullName>`, `<default>`). Deactivated values
 * (`<isActive>false</isActive>`) are RETAINED, never filtered out. A file
 * with zero `<customValue>` entries is the documented happy path for
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
 *   if (result.ok) console.log(result.value.nodes[0].properties['values']);
 *   // => [{ value: 'US', isActive: true, label: 'United States', default: false }, ...]
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

  const valuesResult = validateAndReadCustomValues(rootObj, path);
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
