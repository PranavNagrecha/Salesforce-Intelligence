import { readFile } from 'node:fs/promises';

import type {
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const ROOT_ELEMENT = 'CustomLabels';
const LABEL_ELEMENT = 'labels';
const PER_LABEL_REQUIRED_ELEMENTS = ['fullName', 'value'] as const;
const DEFAULT_LANGUAGE = 'en_US';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise. Required for the multi-entry
 * `<labels>` pattern: a single label parses as a scalar object, two or
 * more parse as an array.
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
const optionalString = (container: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(container[key]);
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
 * Locate and validate the `<CustomLabels>` root in a parsed XML tree.
 *
 * A file with a `<CustomLabels>` root but zero `<labels>` children is a
 * documented happy path (not an error). fast-xml-parser represents
 * `<CustomLabels/>` and `<CustomLabels></CustomLabels>` as an empty
 * string rather than an empty object; both shapes count as a valid empty
 * root and yield zero nodes. A missing `<CustomLabels>` key is the only
 * malformed case here.
 */
const validateRoot = (
  parsed: Record<string, unknown>,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  if (!(ROOT_ELEMENT in parsed)) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root === 'object' && root !== null) {
    return ok(root as Record<string, unknown>);
  }
  // `<CustomLabels/>` / `<CustomLabels></CustomLabels>` — empty but valid.
  if (root === '' || root === null || root === undefined) {
    return ok({});
  }
  return err({
    kind: 'malformed-input',
    path,
    message: `expected <${ROOT_ELEMENT}> root`,
  });
};

/**
 * Validate a single `<labels>` child object carries the required
 * scalars and build its Node. Per `CustomLabel.md`, both `<fullName>`
 * and `<value>` are required; optional `<language>`, `<protected>`,
 * `<shortDescription>`, and `<categories>` flow into properties with
 * their documented defaults.
 *
 * The Node's `label` field prefers `<shortDescription>` over
 * `<fullName>` per the spec — admins use shortDescription as the
 * human-facing summary in Setup; `<value>` is often the translated
 * string itself (long, formatted, may contain merge fields).
 */
const buildLabelNode = (
  label: Record<string, unknown>,
  path: string,
): Result<Node, ExtractorError> => {
  for (const required of PER_LABEL_REQUIRED_ELEMENTS) {
    if (label[required] === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: `missing required element: <${required}>`,
      });
    }
  }
  const fullName = String(unwrapSingle(label['fullName']));
  const value = String(unwrapSingle(label['value']));
  const shortDescription = optionalString(label, 'shortDescription');
  const languageRaw = unwrapSingle(label['language']);
  const language =
    languageRaw === undefined ? DEFAULT_LANGUAGE : String(languageRaw);

  const node: Node = {
    id: `CustomLabel:${fullName}`,
    type: 'CustomLabel',
    apiName: fullName,
    label: shortDescription ?? fullName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      value,
      language,
      protected: coerceBoolean(unwrapSingle(label['protected'])),
      shortDescription,
      categories: optionalString(label, 'categories'),
    },
  };
  return ok(node);
};

/**
 * Extract Nodes from a single Salesforce `CustomLabels.labels-meta.xml`
 * file (one-file-many-entries pattern, mirroring Layout's `layoutSections`).
 *
 * Reads the file, parses it as XML, validates the `<CustomLabels>` root
 * per the vendored `CustomLabel.md` spec, and returns one Node per
 * `<labels>` child. The root file itself produces no node; only the
 * per-label children do. A file with `<CustomLabels>` root and zero
 * `<labels>` children is a documented happy path (an empty scaffold
 * retained for package structure) and yields zero nodes.
 *
 * Each Node carries `value`, `language` (default `en_US`), `protected`
 * (default `false`), `shortDescription`, and `categories` (raw
 * comma-separated string per Salesforce's serialization) in its
 * `properties` map.
 *
 * Zero edges are produced in v1.2. Reference edges from Apex / Aura /
 * LWC / Visualforce / Flow callers into the labels they invoke are
 * deferred to v1.4.
 *
 * Error cases (per vendored `CustomLabel.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<CustomLabels>` or any
 *     `<labels>` child is missing `<fullName>` or `<value>`
 *
 * @example
 *   const result = await extractCustomLabel(
 *     'force-app/main/default/labels/CustomLabels.labels-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'CustomLabel:WelcomeMessage'
 *   }
 */
export const extractCustomLabel = async (
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

  const labels = toArray(rootObj[LABEL_ELEMENT]).filter(
    (l): l is Record<string, unknown> => typeof l === 'object' && l !== null,
  );

  const nodes: Node[] = [];
  for (const label of labels) {
    const built = buildLabelNode(label, path);
    if (!built.ok) return built;
    nodes.push(built.value);
  }

  return ok({ nodes, edges: [] });
};
