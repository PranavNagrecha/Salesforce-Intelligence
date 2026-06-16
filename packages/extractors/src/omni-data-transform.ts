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

const FILE_SUFFIX = '.rpt-meta.xml';
const ROOT_ELEMENT = 'OmniDataTransform';
const NODE_TYPE = 'OmniDataTransform';
const EXTRACTOR_SOURCE = 'omni-data-transform';
const ITEM_ELEMENT = 'omniDataTransformItem';
const REQUIRED_ELEMENTS = ['name'] as const;

/**
 * Output-object-name values that DO NOT correspond to a real SObject
 * API name. `json` (lowercase) is the discriminant for JSON-output rows;
 * `Formula` flags rows whose output is a literal formula expression.
 * These are filtered before emitting `references` edges to SObjects.
 */
const NON_SOBJECT_OBJECT_NAMES: ReadonlySet<string> = new Set([
  'json',
  'JSON',
  'Formula',
  'formula',
  '',
]);

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise. Required for `<omniDataTransformItem>`
 * children: one item parses as a scalar object, two or more parse as
 * an array.
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
const optionalString = (
  container: Record<string, unknown>,
  key: string,
): string | null => {
  const raw = unwrapSingle(container[key]);
  return raw === undefined ? null : String(raw);
};

/**
 * Return `<element>` parsed as a number, or `null` when absent or
 * non-numeric. `versionNumber` arrives as a float-shaped string
 * (`1.0`); parseFloat handles both float and integer shapes.
 */
const optionalNumber = (
  container: Record<string, unknown>,
  key: string,
): number | null => {
  const raw = unwrapSingle(container[key]);
  if (raw === undefined || raw === null) return null;
  const parsed = Number.parseFloat(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
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
 * Locate the `<OmniDataTransform>` root and verify required children per
 * `OmniDataTransform.md`. The only required element is `<name>` — every
 * other top-level element is optional (per OmniDataTransform.md §
 * "Required elements" / "Optional top-level elements").
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
 * Extract the alias portion of a colon-separated field path. Per
 * `OmniDataTransform.md` §"Field-name path conventions":
 *
 *   `{ObjectAlias}:{fieldOrPath}` — the alias is a designer-chosen
 *   alias for the input or output object.
 *
 * Returns the alias string when a colon is present and the alias
 * portion is non-empty; otherwise returns `null` (flat paths without
 * a colon, or paths whose colon sits at the start, are not SObject
 * candidates).
 */
const colonAlias = (path: string | null): string | null => {
  if (path === null) return null;
  const idx = path.indexOf(':');
  if (idx <= 0) return null;
  return path.slice(0, idx);
};

/**
 * Build a `references` edge from this DataRaptor to a CustomObject with
 * the given API name. `confidence` discriminates direct XML element
 * references (`declared`) from colon-prefix parses of field paths
 * (`parsed`); the doc warns that colon-prefix names are designer-chosen
 * aliases and may not correspond to real SObject API names, so the
 * confidence reflects the inferred-vs-stated distinction.
 *
 * The `role` property records which surface the reference came from
 * (`sourceObject` / `inputObject` / `outputObject` / `inputPathAlias` /
 * `outputPathAlias`), so downstream impact-analysis tools can prefer
 * higher-fidelity surfaces when ranking.
 */
const buildSObjectReferenceEdge = (
  fromId: string,
  targetApiName: string,
  confidence: 'declared' | 'parsed',
  role: string,
): Edge => ({
  fromId,
  toId: `CustomObject:${targetApiName}`,
  edgeType: 'references',
  confidence,
  source: EXTRACTOR_SOURCE,
  properties: { role },
});

/**
 * Walk every `<omniDataTransformItem>` row and the top-level
 * `<sourceObject>` element, collect distinct SObject candidates, and
 * emit one `references` edge per candidate.
 *
 * Per PLAN-v3.2 R2c task spec: this LEAF extractor emits `references`
 * edges to source/target SObjects via the field-mapping rows (parsing
 * the colon-separated path convention) PLUS the direct SObject element
 * surfaces (`<sourceObject>`, `<inputObjectName>`, `<outputObjectName>`).
 *
 * Per `OmniDataTransform.md` §"Edge emission rules": NO
 * `dispatchesOmniAction` edges — DataRaptors are leaf-of-the-chain.
 *
 * De-duplication: one edge per (target api name, confidence, role)
 * triple. Stable order: edges sorted by `(toId, confidence, role)` so
 * golden tests are deterministic regardless of XML row ordering.
 *
 * Filtering: synthetic placeholders `json` / `JSON` / `Formula` /
 * `formula` and the empty string never produce edges. These are
 * documented in `OmniDataTransform.md` as discriminants for
 * JSON-output rows and formula-output rows; treating them as SObject
 * names would produce nonsensical dangling edges.
 */
const buildEdges = (
  rootObj: Record<string, unknown>,
  items: readonly Record<string, unknown>[],
  fromId: string,
): Edge[] => {
  // (targetApiName, confidence, role) -> Edge
  const dedup = new Map<string, Edge>();
  const addEdge = (
    targetApiName: string | null,
    confidence: 'declared' | 'parsed',
    role: string,
  ): void => {
    if (targetApiName === null) return;
    if (NON_SOBJECT_OBJECT_NAMES.has(targetApiName)) return;
    const key = `${targetApiName}|${confidence}|${role}`;
    if (dedup.has(key)) return;
    dedup.set(
      key,
      buildSObjectReferenceEdge(fromId, targetApiName, confidence, role),
    );
  };

  // Top-level <sourceObject> — declared confidence (direct XML element).
  addEdge(optionalString(rootObj, 'sourceObject'), 'declared', 'sourceObject');

  for (const item of items) {
    // Item-level <inputObjectName> — declared confidence (direct XML element).
    addEdge(optionalString(item, 'inputObjectName'), 'declared', 'inputObject');
    // Item-level <outputObjectName> — declared confidence; filtered for
    // the `json` / `Formula` placeholders that are NOT SObject names.
    addEdge(
      optionalString(item, 'outputObjectName'),
      'declared',
      'outputObject',
    );
    // Colon-prefix of <inputFieldName> path — parsed confidence (alias
    // may not be a real SObject API name; the path convention is
    // designer-controlled per OmniDataTransform.md).
    addEdge(
      colonAlias(optionalString(item, 'inputFieldName')),
      'parsed',
      'inputPathAlias',
    );
    // Colon-prefix of <outputFieldName> path — parsed confidence.
    addEdge(
      colonAlias(optionalString(item, 'outputFieldName')),
      'parsed',
      'outputPathAlias',
    );
  }

  return [...dedup.values()].sort((a, b) => {
    if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
    if (a.confidence !== b.confidence) return a.confidence < b.confidence ? -1 : 1;
    const aRole = String((a.properties as { role?: string }).role ?? '');
    const bRole = String((b.properties as { role?: string }).role ?? '');
    return aRole < bRole ? -1 : aRole > bRole ? 1 : 0;
  });
};

/**
 * Extract a Node and `references` edges from a single Salesforce
 * `*.rpt-meta.xml` file (OmniDataTransform — the DataRaptor mapping
 * primitive of Salesforce Industries).
 *
 * Per `OmniDataTransform.md`, the XML root is `<OmniDataTransform>` in
 * the `http://soap.sforce.com/2006/04/metadata` namespace; the only
 * required top-level element is `<name>`. The extractor surfaces:
 *
 *   - Identity: `<name>` (the canonical DataRaptor name; matches the
 *     `bundle` field of IP / OmniScript callers) and `<uniqueName>`
 *     (versioned form, e.g., `DRGetIncomeApplicationById_1`).
 *   - Per-type properties: `inputType`, `interfaceClass`,
 *     `transformItemCount`, `active`, `assignmentRulesUsed`,
 *     `nullInputsIncludedInOutput`, `description`, plus
 *     `versionNumber`, `expectedInputJson`, `expectedOutputJson` (the
 *     last two are HTML-entity-escaped JSON blobs surfaced verbatim
 *     per the doc).
 *   - Edges: zero or more `references` edges to `CustomObject:*` per
 *     the rules in `buildEdges` above.
 *
 * v3.2 design choice: `interfaceClass` is the doc's canonical
 * classification key (Extract / Load / Transform), but the source XML
 * observed in Globex populates a top-level `<type>` element with
 * that same discriminant (e.g., `<type>Extract</type>`,
 * `<type>Load</type>`). When `<interfaceClass>` is absent but `<type>`
 * is present, the latter is surfaced under both `interfaceClass`
 * (canonical key per the doc) AND `operationType` (raw element name,
 * for tools that want to disambiguate the source surface). This avoids
 * the "null property when org-vintage uses a different element name"
 * silent gap.
 *
 * Per `OmniDataTransform.md` §"Edge emission rules": this extractor
 * does NOT emit `dispatchesOmniAction` edges. DataRaptors are
 * leaf-of-the-chain; their callers (OmniScript, OmniIntegrationProcedure,
 * OmniUiCard) emit `dispatchesOmniAction` toward them.
 *
 * Error cases (per vendored `OmniDataTransform.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<OmniDataTransform>` or
 *     `<name>` is missing
 *
 * @example
 *   const result = await extractOmniDataTransform(
 *     'force-app/main/default/omniDataTransforms/DRGetIncomeApplicationById_1.rpt-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0]!.id);
 *     // => 'OmniDataTransform:DRGetIncomeApplicationById_1'
 *   }
 */
export const extractOmniDataTransform = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale OmniStudio XML (designer JSON
  // blobs can carry lots of HTML entities).
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

  // The api-name is the filename stem (e.g., `DRGetIncomeApplicationById_1`).
  // Per OmniDataTransform.md, the file naming convention is
  // `{Name}_{VersionNumber}.rpt-meta.xml`; the stem is the canonical
  // versioned identity, matching the Salesforce metadata API's
  // fullName for the component.
  const apiName = deriveComponentApiName(path, FILE_SUFFIX);
  const nodeId = `${NODE_TYPE}:${apiName}`;

  const name = String(unwrapSingle(rootObj['name']));
  const uniqueName = optionalString(rootObj, 'uniqueName');
  const description = optionalString(rootObj, 'description');
  const interfaceClassElement = optionalString(rootObj, 'interfaceClass');
  const operationType = optionalString(rootObj, 'type');
  // Doc canonical key is `interfaceClass`; org observed in Globex
  // emits the same discriminant under `<type>`. Fall back to `<type>`
  // when `interfaceClass` is absent so the canonical key is never null
  // for orgs that use the alternate element name.
  const interfaceClass = interfaceClassElement ?? operationType;

  const items = toArray(rootObj[ITEM_ELEMENT]).filter(
    (i): i is Record<string, unknown> => typeof i === 'object' && i !== null,
  );

  const node: Node = {
    id: nodeId,
    type: 'OmniDataTransform',
    apiName,
    label: description ?? name,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      name,
      uniqueName,
      description,
      active: coerceBoolean(unwrapSingle(rootObj['active'])),
      inputType: optionalString(rootObj, 'inputType'),
      outputType: optionalString(rootObj, 'outputType'),
      interfaceClass,
      // Raw `<type>` element surfaced separately so downstream tools
      // that need to distinguish the two source surfaces can. Same
      // value as `interfaceClass` for the observed Globex orgs;
      // may differ in future Salesforce releases that populate both.
      operationType,
      transformItemCount: items.length,
      assignmentRulesUsed: coerceBoolean(
        unwrapSingle(rootObj['assignmentRulesUsed']),
      ),
      nullInputsIncludedInOutput: coerceBoolean(
        unwrapSingle(rootObj['nullInputsIncludedInOutput']),
      ),
      deletedOnSuccess: coerceBoolean(
        unwrapSingle(rootObj['deletedOnSuccess']),
      ),
      errorIgnored: coerceBoolean(unwrapSingle(rootObj['errorIgnored'])),
      fieldLevelSecurityEnabled: coerceBoolean(
        unwrapSingle(rootObj['fieldLevelSecurityEnabled']),
      ),
      isManagedUsingStdDesigner: coerceBoolean(
        unwrapSingle(rootObj['isManagedUsingStdDesigner']),
      ),
      rollbackOnError: coerceBoolean(unwrapSingle(rootObj['rollbackOnError'])),
      sourceObject: optionalString(rootObj, 'sourceObject'),
      sourceObjectDefault: coerceBoolean(
        unwrapSingle(rootObj['sourceObjectDefault']),
      ),
      versionNumber: optionalNumber(rootObj, 'versionNumber'),
      // The designer-saved sample payloads. Surfaced verbatim per
      // `OmniDataTransform.md` — extractors do not decode the
      // HTML-entity-escaped JSON because consumers may want the raw
      // form (e.g., for round-trip writes) or the parsed form
      // (downstream tools handle the parse themselves to keep the
      // extractor surface small).
      expectedInputJson: optionalString(rootObj, 'expectedInputJson'),
      expectedOutputJson: optionalString(rootObj, 'expectedOutputJson'),
    },
  };

  const edges = buildEdges(rootObj, items, nodeId);

  return ok({ nodes: [node], edges });
};
