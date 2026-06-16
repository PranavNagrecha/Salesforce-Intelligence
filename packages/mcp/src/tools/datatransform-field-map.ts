/**
 * Handler for the `sfi.datatransform_field_map` MCP tool.
 *
 * The third of five v3.2 OmniStudio composition tools (per PLAN-v3.2
 * §4): given an `OmniDataTransform:` canonical id, return the
 * DataRaptor's source-object → target-object field mapping table plus
 * the operation-type metadata (Extract / Load / Transform). The
 * v3.2-R2c extractor (journal 0167) emits the OmniDataTransform node
 * and per-DataRaptor `references` edges to the SObjects each field
 * mapping touches; this tool composes those signals plus a fresh re-
 * parse of the source XML into a readable per-row mapping table.
 *
 * Composition recipe:
 *   1. Resolve the canonical id to the OmniDataTransform node via
 *      `getNodeById`. Refuse with `invalid-query` when the prefix is
 *      wrong, `component-not-found` when the id is unknown.
 *   2. Re-read the source XML from `node.sourcePath` (the same file the
 *      v3.2-R2c extractor parsed at refresh time). The mapping rows
 *      themselves are NOT stored on the node — the extractor surfaces
 *      only top-level metadata + edges, so the per-row table comes
 *      directly from the XML. Failing to read the file surfaces as a
 *      structured `internal` error so consumers can distinguish vault-
 *      drift from genuinely missing data.
 *   3. Walk every `<omniDataTransformItem>` row, project it to a
 *      `FieldMapping`, and tag each row's confidence per the
 *      doc-prescribed honesty axis:
 *        - `declared` when both `inputFieldName` and `outputFieldName`
 *          arrive as direct XML elements with no colon-prefix path
 *          (the alias is fully qualified in the element itself), AND
 *          when the row carries a direct `<inputObjectName>` /
 *          `<outputObjectName>` (the extractor's `declared`-confidence
 *          edge surface).
 *        - `parsed` when either path uses the
 *          `{ObjectAlias}:{fieldPath}` convention — the extractor
 *          surfaces these as `parsed`-confidence edges per
 *          `OmniDataTransform.md`, because the alias is designer-
 *          controlled and may not correspond to a real SObject. The
 *          per-row classification mirrors the edge-level
 *          `declared`/`parsed` split documented in journal 0167.
 *
 * Per-row confidence is the load-bearing honesty axis for this tool.
 * Consumers seeing a `declared` row know the alias appears as a real
 * XML element; consumers seeing a `parsed` row know the alias was
 * inferred from a colon-prefix path and may not resolve to a vaulted
 * SObject.
 *
 * Operation-type fallback: `OmniDataTransform.md` declares
 * `<interfaceClass>` as the canonical Extract / Load / Transform
 * discriminant, but the live Globex org observed in journal 0167
 * uses `<type>` instead. The v3.2-R2c extractor surfaces both under
 * `properties.interfaceClass` (with `<type>` fallback) AND
 * `properties.operationType` (raw `<type>` element). This tool
 * surfaces both verbatim so callers can disambiguate org vintages
 * without re-parsing the XML.
 *
 * Refusal posture:
 *   - Non-`OmniDataTransform:` prefix → `invalid-query`.
 *   - Well-formed prefix, unknown id → `component-not-found`.
 *   - Source file missing or unreadable at query time → `internal`.
 *   - Malformed XML at query time (rare; the file is committed) →
 *     `internal`.
 *
 * No `dispatchesOmniAction` edges are surfaced: DataRaptors are leaf-
 * of-the-chain per `OmniDataTransform.md` §"Edge emission rules".
 */

import { readFile } from 'node:fs/promises';

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

import type { Context } from '../server.js';

import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix for the OmniDataTransform node type. */
const NODE_PREFIX = 'OmniDataTransform:';

/** XML root element for the `.rpt-meta.xml` files this tool re-parses. */
const ROOT_ELEMENT = 'OmniDataTransform';

/** Child element carrying one field-mapping row inside the XML. */
const ITEM_ELEMENT = 'omniDataTransformItem';

/**
 * Zod schema for the `sfi.datatransform_field_map` tool input.
 *
 *   - `dataTransformId`: required, non-empty string. The canonical
 *     OmniDataTransform id (e.g.,
 *     `OmniDataTransform:DRGetIncomeApplicationById_1`). The
 *     prefix-must-match-`OmniDataTransform:` rule is enforced at the
 *     handler boundary because JSON Schema / Zod cannot express the
 *     "prefix == <constant>" constraint cleanly; non-matching prefixes
 *     surface as `invalid-query`.
 */
export const datatransformFieldMapInputSchema = z.object({
  dataTransformId: z.string().min(1),
});

/** Parsed input shape. */
export type DatatransformFieldMapInput = z.infer<
  typeof datatransformFieldMapInputSchema
>;

/**
 * One field-mapping row projected from a single
 * `<omniDataTransformItem>` element. The shape mirrors PLAN-v3.2 §4
 * with the addition of per-row `confidence` (the v3.2 honesty axis).
 */
export interface FieldMapping {
  /** Mapping row name (e.g., `MapId`). Designer-controlled. */
  readonly name: string;
  /** Source path verbatim from `<inputFieldName>` (e.g., `IncomeApp:Id`). */
  readonly sourceField: string;
  /** Destination path verbatim from `<outputFieldName>`. */
  readonly targetField: string;
  /**
   * The output container: `json` (output is a JSON payload) or an
   * SObject API name (output is an SObject record). Surfaced verbatim
   * per `OmniDataTransform.md`.
   */
  readonly outputObjectName: string | null;
  /**
   * Per-row confidence. `declared` when both fields arrive as direct
   * XML elements with no colon-prefix alias; `parsed` when either path
   * uses the colon-separated `{ObjectAlias}:{fieldPath}` convention
   * (the alias is designer-controlled and may not resolve to a real
   * SObject API name). Mirrors the edge-level confidence split the
   * v3.2-R2c extractor emits per journal 0167.
   */
  readonly confidence: ConfidenceLevel;
  /**
   * Boolean flags surfaced verbatim from the XML row. Default `false`
   * when the element is absent (per OmniDataTransform.md schema
   * defaults).
   */
  readonly upsertKey: boolean;
  readonly requiredForUpsert: boolean;
  readonly disabled: boolean;
}

/**
 * Top-level metadata block. Fields mirror the OmniDataTransform-node
 * properties the v3.2-R2c extractor emits; surfaced together here so
 * callers do not need a second `sfi.get_component` round-trip.
 */
export interface FieldMapMetadata {
  /** From `<inputType>` (e.g., `JSON`, `SObject`). */
  readonly inputType: string | null;
  /**
   * From `<interfaceClass>` with `<type>` fallback. Canonical Extract /
   * Load / Transform classification per OmniDataTransform.md.
   */
  readonly interfaceClass: string | null;
  /** Raw `<active>` flag (defaults to `false` when absent). */
  readonly active: boolean;
  readonly assignmentRulesUsed: boolean;
  readonly nullInputsIncludedInOutput: boolean;
  /** Verbatim `<description>` element when present. */
  readonly description: string | null;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface DatatransformFieldMapOutput {
  readonly dataTransformId: ComponentId;
  readonly apiName: string;
  readonly metadata: FieldMapMetadata;
  /**
   * Top-level `<sourceObject>` element, surfaced separately so callers
   * can render the "source object" axis verbatim. Null when the XML
   * has no top-level `<sourceObject>` element (typical for JSON-input
   * DataRaptors).
   */
  readonly sourceObject: string | null;
  /**
   * Best-effort target object (Load variant): the unique non-`json`
   * `<outputObjectName>` value seen across all rows. Null when every
   * row's output container is `json` (the Extract / Transform shape)
   * or when no rows are present. Multiple distinct SObject targets
   * collapse to the first (alphabetical) — consumers needing the full
   * list walk `mappings[].outputObjectName`.
   */
  readonly targetObject: string | null;
  /**
   * The Extract / Load / Transform classification key. Pinned
   * separately from `metadata.interfaceClass` because journal 0167's
   * doc-vs-actual finding observed Globex populating
   * `<type>Extract</type>` while the doc declares `<interfaceClass>`
   * as the discriminant. The extractor falls back from `interfaceClass`
   * to `type`; this field surfaces the raw `<type>` element when
   * present so downstream tools can disambiguate.
   */
  readonly operationType: string | null;
  /** Per-row field mappings, ordered as they appear in the XML. */
  readonly mappings: readonly FieldMapping[];
  /**
   * `<expectedInputJson>` verbatim when present. The designer's saved
   * sample input payload — load-bearing for downstream documentation
   * tools. HTML-entity-escaped JSON; callers decode as needed.
   */
  readonly inputSampleJson: string | null;
  /** `<expectedOutputJson>` verbatim when present. */
  readonly outputSampleJson: string | null;
  /**
   * Honesty disclosures surfaced verbatim. Always populated. The
   * Native-vs-Vlocity disclosure surfaces on every response per
   * PLAN-v3.2 §4 honesty axis 1; the per-row-confidence disclosure
   * surfaces verbatim per the v3.2-R2c extractor's
   * `declared`/`parsed` axis.
   */
  readonly boundaries: readonly string[];
}

/**
 * The Native-vs-Vlocity-Legacy disclosure surfaced on every v3.2 tool
 * response per PLAN-v3.2 §4 honesty axis 1. Verbatim phrasing pinned
 * by Q180; downstream renderers re-emit unchanged.
 */
const NATIVE_VS_VLOCITY_DISCLOSURE =
  'v3.2 recognizes Industries Native XML shapes (file extensions ' +
  '`.os-meta.xml`, `.oip-meta.xml`, `.rpt-meta.xml`, `.ouc-meta.xml`, ' +
  '`.decisionTable-meta.xml`). Legacy Vlocity-managed-package ' +
  'components (namespace `vlocity_cmt__`) are NOT extracted by v3.2. ' +
  'Mid-migration orgs may show partial coverage.';

/**
 * The per-row confidence disclosure. Surfaces the v3.2-R2c
 * `declared`/`parsed` axis so consumers know what a mapping's
 * confidence tag means without re-reading OmniDataTransform.md.
 */
const PER_ROW_CONFIDENCE_DISCLOSURE =
  'Per-mapping confidence reflects how the source/target field path ' +
  'was extracted. `declared` rows came from direct XML elements ' +
  '(`<inputFieldName>` / `<outputFieldName>` without a colon-prefix ' +
  'alias); `parsed` rows used the designer-controlled ' +
  '`{ObjectAlias}:{fieldPath}` convention — the alias may not ' +
  'correspond to a real SObject API name.';

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

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (
  container: Record<string, unknown>,
  key: string,
): string | null => {
  const raw = unwrapSingle(container[key]);
  return raw === undefined ? null : String(raw);
};

/** Coerce an XML scalar to boolean; non-`true` values become false. */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/**
 * Classify a row's confidence. The v3.2-R2c extractor emits
 * `parsed`-confidence reference edges for colon-prefix aliases (per
 * OmniDataTransform.md §"Field-name path conventions"); this tool's
 * per-row classification mirrors that split. A row whose input OR
 * output path uses the colon-separated alias convention is `parsed`;
 * one whose paths are flat (no `:` separator) is `declared`.
 *
 * Rationale: the colon prefix is designer-controlled — it may name a
 * vaulted SObject (high confidence), an arbitrary JSON key (no
 * SObject), or a transient alias the IP/OmniScript caller resolves at
 * runtime. The extractor encodes that uncertainty in the edge
 * confidence; the tool surfaces it row-by-row.
 */
const classifyRowConfidence = (
  inputFieldName: string | null,
  outputFieldName: string | null,
): ConfidenceLevel => {
  const hasColonAlias = (path: string | null): boolean => {
    if (path === null) return false;
    const idx = path.indexOf(':');
    // Colon must be present AND have a non-empty alias before it.
    // A path like `:Field` (empty alias) is treated as flat per the
    // extractor's `colonAlias` helper.
    return idx > 0;
  };
  if (hasColonAlias(inputFieldName) || hasColonAlias(outputFieldName)) {
    return 'parsed';
  }
  return 'declared';
};

/**
 * Pick the best-effort target SObject for the response's top-level
 * `targetObject` field: the first non-`json` `<outputObjectName>` seen
 * across the rows, alphabetized for determinism. Returns null when
 * every row's output container is `json` (the Extract / Transform
 * shape) or when no rows have an explicit `outputObjectName`.
 *
 * The `json` / `JSON` / `Formula` / `formula` placeholders are filtered
 * because they don't correspond to real SObjects; this mirrors the
 * `NON_SOBJECT_OBJECT_NAMES` set in the v3.2-R2c extractor so the two
 * surfaces stay consistent.
 */
const pickTargetObject = (
  mappings: readonly FieldMapping[],
): string | null => {
  const candidates = new Set<string>();
  for (const mapping of mappings) {
    const name = mapping.outputObjectName;
    if (name === null) continue;
    const lowered = name.toLowerCase();
    if (lowered === 'json' || lowered === 'formula' || name === '') continue;
    candidates.add(name);
  }
  if (candidates.size === 0) return null;
  // Alphabetize for determinism. Callers needing the full set walk
  // `mappings[].outputObjectName`.
  const sorted = [...candidates].sort();
  return sorted[0] ?? null;
};

/**
 * Read and strictly-validate the XML file backing an OmniDataTransform
 * node. Validates before parsing so malformed input surfaces as a
 * clean error rather than the fast-xml-parser truncation behavior.
 *
 * Returns the parsed root object on success. Returns an `McpError` on
 * any failure — `internal` for I/O errors (file disappeared between
 * refresh and query, permission denied) and `internal` for malformed
 * XML (rare; the file is committed but local edits could break it).
 */
const readDataTransformXml = async (
  path: string,
): Promise<Result<Record<string, unknown>, McpError>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(path, 'utf-8');
  } catch (cause: unknown) {
    return err({
      kind: 'internal',
      message: `failed to read OmniDataTransform source at ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      path,
    });
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return err({
      kind: 'internal',
      message: `malformed XML at ${path}: ${validation.err.msg}`,
      path,
    });
  }

  // Local trusted disk content; XXE not a concern. Cap matches the
  // v3.2-R2c extractor (`processEntities.maxTotalExpansions: 10000`)
  // so the two surfaces accept the same inputs.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlText) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'internal',
      message: `failed to parse OmniDataTransform XML at ${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      path,
    });
  }

  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'internal',
      message: `expected <${ROOT_ELEMENT}> root at ${path}`,
      path,
    });
  }
  return ok(root as Record<string, unknown>);
};

/**
 * Project the parsed XML root into the metadata block. Mirrors the
 * v3.2-R2c extractor's property mapping so consumers see the same
 * values whether they hit this tool or `sfi.get_component`.
 */
const buildMetadata = (root: Record<string, unknown>): FieldMapMetadata => {
  const interfaceClassElement = optionalString(root, 'interfaceClass');
  const operationTypeElement = optionalString(root, 'type');
  // Doc canonical key is `interfaceClass`; org observed in Globex
  // emits the same discriminant under `<type>`. Fall back to `<type>`
  // when `interfaceClass` is absent so the canonical key is never null
  // for orgs that use the alternate element name.
  const interfaceClass = interfaceClassElement ?? operationTypeElement;
  return {
    inputType: optionalString(root, 'inputType'),
    interfaceClass,
    active: coerceBoolean(unwrapSingle(root['active'])),
    assignmentRulesUsed: coerceBoolean(
      unwrapSingle(root['assignmentRulesUsed']),
    ),
    nullInputsIncludedInOutput: coerceBoolean(
      unwrapSingle(root['nullInputsIncludedInOutput']),
    ),
    description: optionalString(root, 'description'),
  };
};

/**
 * Project one `<omniDataTransformItem>` row into a `FieldMapping`.
 * Defensive on the row's missing-element axis: empty strings surface
 * when the source XML omits `<inputFieldName>` / `<outputFieldName>`
 * rather than synthesizing a label. The per-row confidence is computed
 * from the colon-prefix presence as documented in this module's JSDoc.
 */
const buildFieldMapping = (item: Record<string, unknown>): FieldMapping => {
  const inputFieldName = optionalString(item, 'inputFieldName');
  const outputFieldName = optionalString(item, 'outputFieldName');
  // Formula rows carry a literal `<outputFieldName>Formula</outputFieldName>`
  // placeholder; the real computed-output location lives in
  // `<formulaResultPath>` (e.g. `LoopBlock1:SerialList:PBC`). Prefer it as
  // the target — otherwise every formula row collapses to an identical,
  // useless `targetField: 'Formula'`, hiding which distinct outputs the
  // DataRaptor actually computes.
  const formulaResultPath = optionalString(item, 'formulaResultPath');
  return {
    name: optionalString(item, 'name') ?? '',
    sourceField: inputFieldName ?? '',
    targetField: formulaResultPath ?? outputFieldName ?? '',
    outputObjectName: optionalString(item, 'outputObjectName'),
    confidence: classifyRowConfidence(inputFieldName, outputFieldName),
    upsertKey: coerceBoolean(unwrapSingle(item['upsertKey'])),
    requiredForUpsert: coerceBoolean(
      unwrapSingle(item['requiredForUpsert']),
    ),
    disabled: coerceBoolean(unwrapSingle(item['disabled'])),
  };
};

/**
 * Walk the parsed root and emit one `FieldMapping` per
 * `<omniDataTransformItem>` row. Rows are emitted in document order
 * (the XML's row sequence — designer-controlled). Callers that need
 * `outputCreationSequence` ordering can sort the returned array
 * themselves.
 */
const buildMappings = (
  root: Record<string, unknown>,
): readonly FieldMapping[] => {
  const items = toArray(root[ITEM_ELEMENT]).filter(
    (i): i is Record<string, unknown> => typeof i === 'object' && i !== null,
  );
  return items.map(buildFieldMapping);
};

/**
 * Build the boundaries[] disclosure array. Both disclosures surface
 * unconditionally on every response — the Native-vs-Vlocity disclosure
 * is the v3.2-wide honesty anchor (Q180), and the per-row confidence
 * disclosure documents what the `confidence` tag on each mapping means
 * without re-reading OmniDataTransform.md.
 */
const buildBoundaries = (): readonly string[] => [
  NATIVE_VS_VLOCITY_DISCLOSURE,
  PER_ROW_CONFIDENCE_DISCLOSURE,
];

/**
 * The `sfi.datatransform_field_map` MCP tool. Returns the per-row
 * source-to-target field mapping for one OmniDataTransform plus the
 * operation-type metadata. See the module JSDoc for the composition
 * recipe, the refusal cascade, and the honesty-axis design.
 *
 * @example
 *   const r = await datatransformFieldMapHandler(ctx, {
 *     dataTransformId: 'OmniDataTransform:DRGetIncomeApplicationById_1',
 *   });
 *   if (r.ok) console.log(r.value.data.mappings.length);
 */
export const datatransformFieldMapHandler = async (
  ctx: Context,
  input: DatatransformFieldMapInput,
): Promise<Result<McpResponse<DatatransformFieldMapOutput>, McpError>> => {
  if (!input.dataTransformId.startsWith(NODE_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `dataTransformId must start with '${NODE_PREFIX}'; got '${input.dataTransformId}'`,
      path: 'dataTransformId',
    });
  }

  const nodeResult = await getNodeById(ctx.graph, input.dataTransformId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  const node: Node | null = nodeResult.value;
  if (node === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, input.dataTransformId, 'OmniDataTransform'),
      path: input.dataTransformId,
    });
  }

  // Defensive: the prefix pins the expected type, but the graph round-
  // trip could in principle return a node with a different `type`.
  // Treat that as `component-not-found` since the caller's request
  // cannot be satisfied by what the vault holds.
  if (node.type !== 'OmniDataTransform') {
    return err({
      kind: 'component-not-found',
      message: `node ${input.dataTransformId} is not an OmniDataTransform (type=${node.type})`,
      path: input.dataTransformId,
    });
  }

  // Re-read the source XML. The mapping rows are NOT stored on the
  // node — the v3.2-R2c extractor surfaces only top-level metadata +
  // references edges, so per-row data comes directly from the file.
  const xmlResult = await readDataTransformXml(
    resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath),
  );
  if (!xmlResult.ok) return xmlResult;
  const root = xmlResult.value;

  const mappings = buildMappings(root);
  const metadata = buildMetadata(root);
  const sourceObject = optionalString(root, 'sourceObject');
  const targetObject = pickTargetObject(mappings);
  const operationType = optionalString(root, 'type');

  return ok({
    data: {
      dataTransformId: node.id,
      apiName: node.apiName,
      metadata,
      sourceObject,
      targetObject,
      operationType,
      mappings,
      inputSampleJson: optionalString(root, 'expectedInputJson'),
      outputSampleJson: optionalString(root, 'expectedOutputJson'),
      boundaries: buildBoundaries(),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
