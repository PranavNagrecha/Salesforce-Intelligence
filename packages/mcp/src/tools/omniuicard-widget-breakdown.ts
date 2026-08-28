/**
 * Handler for the `sfi.omniuicard_widget_breakdown` MCP tool.
 *
 * v3.2 R3 — the FlexCard / OmniUiCard widget-canvas breakdown surface.
 * Given an OmniUiCard canonical id, returns:
 *
 *   - `metadata` — the card's identity (`omniUiCardType`, `authorName`,
 *     `versionNumber`, `isActive`, `isManagedUsingStdDesigner`).
 *   - `states[]` — each state's name + recursive widget tree (parsed
 *     from the source XML's `<propertySetConfig>` JSON blob).
 *   - `dataSource` — `dataSourceConfig.dataSource.type` +
 *     `contextVariables[]` from the node properties the v3.2 R2
 *     extractor stamped on (mirrors what the extractor parsed).
 *   - `dispatchedActions[]` — the `dispatchesOmniAction` edges the
 *     extractor emitted for Action widgets whose
 *     `stateAction.type` is `OmniScript` or `Integration Procedure`.
 *   - `boundaries[]` — verbatim disclosures the v3.2 honesty axis
 *     mandates: the propertySetConfig-parsing caveat AND the
 *     Native-vs-Vlocity legacy boundary. Surfaced unconditionally on
 *     every response. When the widget-tree re-parse could not run, or
 *     ran and disagreed with the aggregates the extractor stamped on
 *     the node, a blind-spot / drift disclosure LEADS the list — an
 *     empty `states[]` is otherwise indistinguishable from a card
 *     that genuinely has no states.
 *
 * Why this tool re-reads XML (instead of pulling widget tree from
 * the node):
 *
 *   The v3.2 R2 OmniUiCard extractor (journal 0170) deliberately
 *   stores per-card *aggregates* on `Node.properties` (`stateCount`,
 *   `widgetCount`, `embeddedScriptCount`, `dataSourceType`,
 *   `dataSourceContextVariables`) but not the full widget tree. The
 *   propertySetConfig JSON for a real-org FlexCard runs into the
 *   tens-of-kilobytes range; stamping it onto every OmniUiCard node
 *   would inflate the graph DB without being load-bearing for the
 *   v3.2 edge / aggregate-count surface. The XML on disk is the
 *   canonical source; this tool walks `node.sourcePath` and
 *   re-parses the propertySetConfig blob on demand. Per
 *   `OmniUiCard.md` §"Widget breakdown — what the v3.2 tool returns",
 *   the widget tree the tool surfaces follows the JSON's declared
 *   order, not the visual designer's drag-drop order — the
 *   propertySetConfig-parsing disclosure surfaces verbatim on every
 *   response.
 *
 * Edge composition:
 *
 *   The `dispatchedActions[]` list comes from the graph
 *   (`listEdges(card, direction: 'out', edgeType: 'dispatchesOmniAction')`),
 *   NOT from re-walking the JSON. This keeps the tool's emitted
 *   dispatch list byte-equal to the extractor's edge emission —
 *   parallel re-parsing in the tool would silently drift if the
 *   extractor's dedupe / sort discipline changed.
 *
 * @see PLAN-v3.2.md §4 (sfi.omniuicard_widget_breakdown).
 * @see docs/vendor/salesforce-metadata/OmniUiCard.md
 */

import { readFile } from 'node:fs/promises';

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  familyWasExtracted,
  notExtractedFamilyDisclosure,
} from './absence-disclosure.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix for the OmniUiCard node type. */
const OMNI_UI_CARD_PREFIX = 'OmniUiCard:';

/** Root element name in the source `.ouc-meta.xml` file. */
const ROOT_ELEMENT = 'OmniUiCard';

/**
 * The widget-layer key v3.2 walks. FlexCards historically support multiple
 * visual layers; both this tool and the v3.2 R2 extractor walk `layer-0`
 * only, so a state that hangs its widgets off any other layer is NOT WALKED
 * — and because the extractor shares the limitation, its `widgetCount`
 * aggregate agrees at zero and the cross-check below cannot catch it. That
 * case gets its own disclosure.
 */
const WALKED_LAYER_KEY = 'layer-0';

/**
 * The node property the v3.2 R2 extractor ALWAYS stamps (see
 * `packages/extractors/src/omni-ui-card.ts` — it is an unconditional literal
 * in the node's `properties` bag, written as `0` when the card genuinely has
 * no states). Its ABSENCE therefore means the vault was built by a refresh
 * that predates the extractor, never that the card is empty. This is the R1
 * sentinel for {@link familyWasExtracted}.
 */
const STATE_COUNT_SENTINEL = 'stateCount';

/** The extractor's recursive widget total, stamped alongside {@link STATE_COUNT_SENTINEL}. */
const WIDGET_COUNT_PROPERTY = 'widgetCount';

/**
 * The extractor's own parse-warning list, also always stamped (`[]` when the
 * parse was clean). A non-empty list is the extractor telling us, from the
 * refresh that built this vault, that it could not read part of this card.
 */
const EXTRACTION_WARNINGS_PROPERTY = 'omniUiCardExtractionWarnings';

/**
 * Verbatim disclosure for the propertySetConfig parsing axis. Per
 * `OmniUiCard.md` §"Widget breakdown — what the v3.2 tool returns",
 * surfaced ALWAYS on every response so consumers know widget order
 * follows the JSON's declared order, not the designer's drag-drop
 * sequence. The skill renders this verbatim.
 */
const PROPERTY_SET_CONFIG_PARSING_DISCLOSURE =
  'widget breakdown parses the propertySetConfig JSON blob. ' +
  'FlexCard authors can edit the raw blob in the OmniStudio ' +
  "designer; widget order in the breakdown follows the JSON's " +
  "declared order, not the visual designer's drag-drop order.";

/**
 * Verbatim disclosure for the Native-vs-Vlocity-Legacy detection
 * axis (PLAN-v3.2 §4 honesty axis 1; Q180 anchor). Surfaced ALWAYS
 * on every v3.2 tool response. v3.2's extractors recognize the
 * Industries Native XML shape only; mid-migration orgs (Native +
 * Vlocity-managed-package side-by-side) may show partial coverage.
 */
const NATIVE_VS_VLOCITY_DISCLOSURE =
  'v3.2 recognizes Industries Native XML shapes (file extensions ' +
  '`.os-meta.xml`, `.oip-meta.xml`, `.rpt-meta.xml`, ' +
  '`.ouc-meta.xml`, `.decisionTable-meta.xml`). Legacy ' +
  'Vlocity-managed-package components (namespace `vlocity_cmt__`) ' +
  'are NOT extracted by v3.2. Mid-migration orgs may show partial ' +
  'coverage.';

/**
 * Zod schema for the `sfi.omniuicard_widget_breakdown` tool input.
 *
 *   - `omniUiCardId`: required, non-empty string. The canonical
 *     OmniUiCard id (`OmniUiCard:{ApiName}`). The `OmniUiCard:`
 *     prefix is enforced at the handler boundary; non-OmniUiCard
 *     ids surface as `invalid-query`. Unknown but well-formed ids
 *     surface as `component-not-found`.
 */
export const omniuicardWidgetBreakdownInputSchema = z.object({
  omniUiCardId: z.string().min(1),
});

/** Parsed input shape, inferred from `omniuicardWidgetBreakdownInputSchema`. */
export type OmniuicardWidgetBreakdownInput = z.infer<
  typeof omniuicardWidgetBreakdownInputSchema
>;

/**
 * One widget in the recursive widget tree. Block / Datatable Row /
 * Section containers carry nested `children`; leaf widgets carry an
 * empty `children` array. Field order matches PLAN-v3.2 §4
 * `OmniUiCardWidget` verbatim.
 */
export interface OmniUiCardWidget {
  readonly name: string;
  readonly element: string;
  readonly elementLabel: string;
  readonly type: string;
  readonly children: readonly OmniUiCardWidget[];
}

/**
 * One state in the FlexCard's `propertySetConfig.states[]`. The
 * `widgetCount` is the recursive count (container widgets contribute
 * their own count plus the counts of their children) — matches the
 * v3.2 R2 extractor's per-state aggregate semantics. `widgets[]` is
 * the root of the recursive tree under
 * `components["layer-0"].children`.
 */
export interface OmniUiCardState {
  readonly name: string;
  readonly stateIndex: number;
  readonly widgetCount: number;
  readonly widgets: readonly OmniUiCardWidget[];
}

/**
 * One dispatched OmniScript / Integration Procedure call. Sourced
 * from the `dispatchesOmniAction` edges the v3.2 R2 extractor
 * emitted for Action widgets in `actionList[].stateAction`. The
 * `targetId` is the canonical id the extractor stamped on the edge;
 * the `targetRawName` is the verbatim string the source JSON
 * carried.
 */
export interface OmniUiCardDispatchedAction {
  readonly stateName: string;
  readonly stateIndex: number;
  readonly widgetLabel: string | null;
  readonly actionListIndex: number;
  readonly actionType: 'OmniScript' | 'Integration Procedure';
  readonly targetId: ComponentId;
  readonly targetRawName: string;
  readonly confidence: 'declared' | 'parsed';
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface OmniuicardWidgetBreakdownOutput {
  readonly omniUiCardId: ComponentId;
  readonly apiName: string;
  readonly metadata: {
    readonly omniUiCardType: string | null;
    readonly authorName: string | null;
    readonly versionNumber: number | null;
    readonly isActive: boolean;
    readonly isManagedUsingStdDesigner: boolean;
  };
  readonly states: readonly OmniUiCardState[];
  readonly dataSource: {
    readonly type: string | null;
    readonly contextVariables: readonly string[];
  };
  readonly dispatchedActions: readonly OmniUiCardDispatchedAction[];
  readonly boundaries: readonly string[];
}

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence elements. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Best-effort parse of an HTML-entity-escaped JSON string from the
 * XML's `<propertySetConfig>` element. fast-xml-parser (with the
 * entity processor enabled below) decodes `&quot;` → `"` before we
 * see the string, so the input here is plain JSON. Malformed blobs
 * (rare; Salesforce's exporter is reliable) return `null` rather
 * than throwing — the tool degrades to an empty states[] list.
 */
const parseJsonBlob = (
  raw: unknown,
): Readonly<Record<string, unknown>> | null => {
  const v = unwrapSingle(raw);
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    if (typeof v === 'object') return v as Readonly<Record<string, unknown>>;
    return null;
  }
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Readonly<Record<string, unknown>>;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Recursively walk one widget tree starting at the supplied
 * `children` array. Each entry produces one `OmniUiCardWidget`; the
 * widget's own `children` field is the recursive walk of its nested
 * `children` (Block / Datatable Row containers). Non-object entries
 * are skipped — the JSON is well-typed in practice but a defensive
 * guard avoids surprises on hand-edited cards.
 *
 * Order is preserved verbatim from the JSON (matches the
 * propertySetConfig-parsing disclosure).
 */
const walkWidgets = (rawChildren: unknown): OmniUiCardWidget[] => {
  if (!Array.isArray(rawChildren)) return [];
  const widgets: OmniUiCardWidget[] = [];
  for (const child of rawChildren) {
    if (typeof child !== 'object' || child === null) continue;
    const widget = child as Record<string, unknown>;
    widgets.push({
      name: typeof widget['name'] === 'string' ? widget['name'] : '',
      element: typeof widget['element'] === 'string' ? widget['element'] : '',
      elementLabel:
        typeof widget['elementLabel'] === 'string' ? widget['elementLabel'] : '',
      type: typeof widget['type'] === 'string' ? widget['type'] : '',
      children: walkWidgets(widget['children']),
    });
  }
  return widgets;
};

/**
 * Count widgets recursively to mirror the v3.2 R2 extractor's
 * per-state `widgetCount` semantics: each widget counts as one, and
 * container widgets contribute their own count plus the counts of
 * their children. Used to populate `OmniUiCardState.widgetCount`.
 */
const countWidgets = (widgets: readonly OmniUiCardWidget[]): number => {
  let total = 0;
  for (const widget of widgets) {
    total += 1 + countWidgets(widget.children);
  }
  return total;
};

/**
 * The result of walking `propertySetConfig.states[]`: the tool's `states[]`
 * payload PLUS the names of the states whose widgets were never walked
 * because they hang off a layer other than {@link WALKED_LAYER_KEY}. Those
 * states surface with an empty `widgets[]` that means NOT WALKED, which is a
 * different fact from "this state declares no widgets" and must be reported
 * as such.
 */
interface BuiltStates {
  readonly states: readonly OmniUiCardState[];
  readonly unwalkedLayerStates: readonly string[];
}

/**
 * Walk every state in the parsed propertySetConfig and build the
 * tool's `states[]` payload. State indexes preserve the JSON's
 * declared order (the propertySetConfig-parsing disclosure axis).
 * Non-object states are skipped defensively.
 */
const buildStates = (statesRaw: readonly unknown[]): BuiltStates => {
  const states: OmniUiCardState[] = [];
  const unwalkedLayerStates: string[] = [];
  for (let i = 0; i < statesRaw.length; i += 1) {
    const state = statesRaw[i];
    if (typeof state !== 'object' || state === null) continue;
    const stateObj = state as Record<string, unknown>;
    const name = typeof stateObj['name'] === 'string' ? stateObj['name'] : '';
    // The widget root is `components.layer-0.children`. v3.2 walks
    // only `layer-0` — production cards in the recon use the
    // layer-0 root exclusively. A state that declares OTHER layers and
    // no `layer-0` is recorded so the caller can say so out loud.
    let widgets: readonly OmniUiCardWidget[] = [];
    const componentsRaw = stateObj['components'];
    if (typeof componentsRaw === 'object' && componentsRaw !== null) {
      const components = componentsRaw as Record<string, unknown>;
      const layer0 = components[WALKED_LAYER_KEY];
      if (typeof layer0 === 'object' && layer0 !== null) {
        widgets = walkWidgets((layer0 as Record<string, unknown>)['children']);
      } else if (Object.keys(components).length > 0) {
        unwalkedLayerStates.push(name.length > 0 ? name : `#${i}`);
      }
    }
    states.push({
      name,
      stateIndex: i,
      widgetCount: countWidgets(widgets),
      widgets,
    });
  }
  return { states, unwalkedLayerStates };
};

/**
 * Read a string-array property from the OmniUiCard node, filtering
 * out non-string entries. The v3.2 R2 extractor stores
 * `dataSourceContextVariables` as `readonly string[]` per the
 * extractor's parsing; this guard re-validates the runtime shape
 * because graph round-trips through canonical JSON do not enforce
 * the property type.
 */
const readStringArrayProperty = (
  node: Node,
  key: string,
): readonly string[] => {
  const raw = node.properties[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
};

/**
 * Read a typed string property from the node properties bag; return
 * `null` when missing or non-string. Mirrors the defensive read
 * pattern other v2.x / v3.x tools use to round-trip through the
 * graph's `properties_json` column.
 */
const readNullableStringProperty = (node: Node, key: string): string | null => {
  const raw = node.properties[key];
  return typeof raw === 'string' ? raw : null;
};

/**
 * Read a typed number property from the node properties bag; return
 * `null` when missing or non-number.
 */
const readNullableNumberProperty = (node: Node, key: string): number | null => {
  const raw = node.properties[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

/** Read a boolean property; missing / non-boolean values become `false`. */
const readBooleanProperty = (node: Node, key: string): boolean =>
  node.properties[key] === true;

/**
 * Project one `dispatchesOmniAction` edge into the tool's
 * `OmniUiCardDispatchedAction` shape. Each edge carries the action
 * widget context the extractor stamped on (`stateName`,
 * `stateIndex`, `widgetLabel`, `actionListIndex`, `actionType`,
 * `targetRawName`); the projection re-validates the runtime types
 * because graph round-trip does not enforce them.
 *
 * The `actionType` field is narrowed to the two values the
 * extractor emits (`OmniScript` | `Integration Procedure`); edges
 * with any other value (defensive — should not occur) become
 * `null` and are filtered out by the caller.
 */
const projectDispatchedAction = (
  edge: Edge,
): OmniUiCardDispatchedAction | null => {
  const props = edge.properties;
  const actionType = props['actionType'];
  if (actionType !== 'OmniScript' && actionType !== 'Integration Procedure') {
    return null;
  }
  const stateName = typeof props['stateName'] === 'string' ? props['stateName'] : '';
  const stateIndex =
    typeof props['stateIndex'] === 'number' && Number.isFinite(props['stateIndex'])
      ? (props['stateIndex'] as number)
      : 0;
  const widgetLabelRaw = props['widgetLabel'];
  const widgetLabel = typeof widgetLabelRaw === 'string' ? widgetLabelRaw : null;
  const actionListIndex =
    typeof props['actionListIndex'] === 'number' &&
    Number.isFinite(props['actionListIndex'])
      ? (props['actionListIndex'] as number)
      : 0;
  const targetRawName =
    typeof props['targetRawName'] === 'string' ? props['targetRawName'] : '';
  return {
    stateName,
    stateIndex,
    widgetLabel,
    actionListIndex,
    actionType,
    targetId: edge.toId,
    targetRawName,
    confidence: edge.confidence as 'declared' | 'parsed',
  };
};

/**
 * Order dispatched actions deterministically for byte-stable output:
 * by `stateIndex` ascending, then `actionListIndex` ascending, then
 * `targetId` ascending. The extractor's edge dedupe + sort discipline
 * keeps the upstream order stable; this re-sort defends against any
 * downstream graph-layer re-ordering (DuckDB `ORDER BY to_id`).
 */
const sortDispatchedActions = (
  actions: readonly OmniUiCardDispatchedAction[],
): OmniUiCardDispatchedAction[] => {
  const sorted = [...actions];
  sorted.sort((a, b) => {
    if (a.stateIndex !== b.stateIndex) return a.stateIndex - b.stateIndex;
    if (a.actionListIndex !== b.actionListIndex) {
      return a.actionListIndex - b.actionListIndex;
    }
    if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
    return 0;
  });
  return sorted;
};

/**
 * Why the widget tree could not be walked. Six distinct conditions used to
 * collapse into the same `states: []`, which is exactly the answer a
 * genuinely empty card gives — so a host asking "what widgets are on this
 * FlexCard?" could not tell "we looked and it has none" from "we never
 * looked". Each cause now carries its own clause.
 */
type WidgetTreeFailure =
  | 'source-unreadable'
  | 'malformed-xml'
  | 'parser-threw'
  | 'no-root-element'
  | 'property-set-config-unparseable'
  | 'states-not-an-array';

/** Outcome of {@link buildStatesFromSourceXml}: a real walk, or a named blind spot. */
type WidgetTreeOutcome =
  | ({ readonly kind: 'parsed' } & BuiltStates)
  | { readonly kind: 'blind'; readonly cause: WidgetTreeFailure };

/**
 * The blind-spot clause for each cause, in the voice of the disclosure
 * sentence built by {@link widgetTreeDisclosures}. Kept as one table so a
 * new failure branch cannot be added without giving the host words for it.
 */
const WIDGET_TREE_FAILURE_CLAUSE: Readonly<Record<WidgetTreeFailure, string>> = {
  'source-unreadable':
    "the card's source file could not be read from this vault — the refresh " +
    'did not retrieve it, or it was removed after the refresh',
  'malformed-xml':
    "the card's source file is not well-formed XML and was rejected by the validator",
  'parser-threw': "the XML parser threw while reading the card's source file",
  'no-root-element': `the card's source file carries no \`${ROOT_ELEMENT}\` root element`,
  'property-set-config-unparseable':
    'the `propertySetConfig` blob is absent, empty, or not parseable JSON',
  'states-not-an-array':
    'the `propertySetConfig` blob carries no `states` array',
};

/**
 * Read + validate the source `.ouc-meta.xml`, parse the
 * propertySetConfig JSON, and walk the states.
 *
 * Every failure path returns a NAMED cause rather than an empty list: the
 * metadata + dispatchedActions sections are still meaningful without the
 * widget tree, but the empty `states[]` they sit next to must never be read
 * as a verified zero.
 *
 * fast-xml-parser's entity processor is configured the same way the
 * v3.2 R2 extractor configures it: the FlexCard propertySetConfig
 * blob is the most entity-heavy v3.2 metadata shape and needs the
 * raised 50000-expansion cap.
 */
const buildStatesFromSourceXml = async (
  sourcePath: string,
): Promise<WidgetTreeOutcome> => {
  let xmlText: string;
  try {
    xmlText = await readFile(sourcePath, 'utf-8');
  } catch {
    return { kind: 'blind', cause: 'source-unreadable' };
  }
  if (XMLValidator.validate(xmlText) !== true) {
    return { kind: 'blind', cause: 'malformed-xml' };
  }
  // Same parser configuration as the v3.2 R2 extractor — see
  // `extractors/src/omni-ui-card.ts` for the inline rationale on the
  // 50000-expansion cap.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 50000 },
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlText) as Record<string, unknown>;
  } catch {
    return { kind: 'blind', cause: 'parser-threw' };
  }
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return { kind: 'blind', cause: 'no-root-element' };
  }
  const rootObj = root as Record<string, unknown>;
  const propertySetConfig = parseJsonBlob(rootObj['propertySetConfig']);
  if (propertySetConfig === null) {
    return { kind: 'blind', cause: 'property-set-config-unparseable' };
  }
  const statesRaw = propertySetConfig['states'];
  if (!Array.isArray(statesRaw)) {
    return { kind: 'blind', cause: 'states-not-an-array' };
  }
  return { kind: 'parsed', ...buildStates(statesRaw) };
};

/**
 * Build the disclosures that make an empty / partial `states[]` legible.
 *
 * Four independent facts, in the order a reader needs them:
 *
 *   1. R1 — the node carries no `stateCount` at all, so the whole family was
 *      never extracted (shared {@link notExtractedFamilyDisclosure}).
 *   2. The walk failed for a named reason, and the extractor's OWN aggregates
 *      (`stateCount` / `widgetCount`) say what the refresh saw at the time.
 *      This is the derived cross-check: the answer was on the node all along.
 *   3. The walk succeeded but DISAGREES with those aggregates — the file on
 *      disk is not the file the refresh read.
 *   4. Some state's widgets hang off a layer this version does not walk.
 *
 * Returns an empty array when the card parsed clean and agrees with the
 * vault: hedging a verified answer is as dishonest as hiding a blind spot.
 */
const widgetTreeDisclosures = (
  node: Node,
  outcome: WidgetTreeOutcome,
  states: readonly OmniUiCardState[],
): readonly string[] => {
  const disclosures: string[] = [];
  const extracted = familyWasExtracted(node.properties, STATE_COUNT_SENTINEL);
  if (!extracted) {
    disclosures.push(
      notExtractedFamilyDisclosure({
        subject: 'FlexCard states and widgets',
        verb: 'parsed',
        pluralSubject: true,
        sentinelProperty: STATE_COUNT_SENTINEL,
        containers: [node.id],
        surface: '`states` / `states[].widgets`',
        zeroReading: '"this card declares no states and no widgets"',
      }),
    );
  }
  const recordedStates = readNullableNumberProperty(node, STATE_COUNT_SENTINEL);
  const recordedWidgets = readNullableNumberProperty(node, WIDGET_COUNT_PROPERTY);
  const parsedWidgets = states.reduce((total, s) => total + s.widgetCount, 0);
  const recordedClause =
    recordedStates === null
      ? ''
      : ` The refresh that built this vault recorded \`${STATE_COUNT_SENTINEL}: ` +
        `${recordedStates}\` / \`${WIDGET_COUNT_PROPERTY}: ${recordedWidgets ?? 0}\` ` +
        'for this card.';

  if (outcome.kind === 'blind') {
    disclosures.push(
      `The widget tree was NOT parsed — ${WIDGET_TREE_FAILURE_CLAUSE[outcome.cause]}. ` +
        '`states` is a BLIND SPOT here, NEVER a verified "this card declares no ' +
        `states and no widgets".${recordedClause} Re-run \`/sfi-refresh\`.`,
    );
  } else if (extracted && recordedStates !== null && recordedStates !== states.length) {
    disclosures.push(
      `DRIFT: the source XML on disk parses to ${states.length} state(s), but the ` +
        `refresh recorded \`${STATE_COUNT_SENTINEL}: ${recordedStates}\` for this card. ` +
        'The file changed after the refresh, so `states` describes the file on disk, ' +
        'NOT the vault the rest of this answer is built from. Re-run `/sfi-refresh`.',
    );
  } else if (
    extracted &&
    recordedWidgets !== null &&
    recordedWidgets !== parsedWidgets
  ) {
    disclosures.push(
      `DRIFT: the source XML on disk parses to ${parsedWidgets} widget(s), but the ` +
        `refresh recorded \`${WIDGET_COUNT_PROPERTY}: ${recordedWidgets}\` for this card. ` +
        'The file changed after the refresh, so `states[].widgets` describes the file ' +
        'on disk, NOT the vault the rest of this answer is built from. ' +
        'Re-run `/sfi-refresh`.',
    );
  }

  if (outcome.kind === 'parsed' && outcome.unwalkedLayerStates.length > 0) {
    disclosures.push(
      `${outcome.unwalkedLayerStates.length} state(s) hang their widgets off a ` +
        `component layer other than \`${WALKED_LAYER_KEY}\` ` +
        `(${outcome.unwalkedLayerStates.join(', ')}); v3.2 walks \`${WALKED_LAYER_KEY}\` ` +
        'only, so their `widgets` list is empty because it was NOT walked, NEVER ' +
        'because the state is empty. The extractor shares this limitation, so its ' +
        `\`${WIDGET_COUNT_PROPERTY}\` aggregate cannot contradict it either.`,
    );
  }

  const warnings = readStringArrayProperty(node, EXTRACTION_WARNINGS_PROPERTY);
  if (warnings.length > 0) {
    disclosures.push(
      `The extractor recorded ${warnings.length} parse warning(s) for this card at ` +
        `refresh time: ${warnings.join('; ')}. Anything those warnings cover is ` +
        'missing from this answer.',
    );
  }
  return disclosures;
};

/**
 * The `sfi.omniuicard_widget_breakdown` MCP tool. Returns the
 * OmniUiCard's identity, parsed state list (with recursive widget
 * tree), declared data source, dispatched OmniScript / IP calls,
 * and the verbatim v3.2 boundary disclosures.
 *
 * Error cascade:
 *
 *   1. Non-`OmniUiCard:` prefix → `invalid-query`.
 *   2. Graph query failure → `internal` (re-wraps the graph error).
 *   3. Well-formed id but no matching node → `component-not-found`.
 *   4. Node found but wrong `type` → `component-not-found`.
 *
 * @example
 *   const r = await omniuicardWidgetBreakdownHandler(ctx, {
 *     omniUiCardId: 'OmniUiCard:AccountLinkingIntro_Developer_1',
 *   });
 *   if (r.ok) console.log(r.value.data.states.length);
 */
export const omniuicardWidgetBreakdownHandler = async (
  ctx: Context,
  input: OmniuicardWidgetBreakdownInput,
): Promise<
  Result<McpResponse<OmniuicardWidgetBreakdownOutput>, McpError>
> => {
  if (!input.omniUiCardId.startsWith(OMNI_UI_CARD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `omniUiCardId must start with '${OMNI_UI_CARD_PREFIX}'; got '${input.omniUiCardId}'`,
      path: 'omniUiCardId',
    });
  }

  const nodeResult = await getNodeById(ctx.graph, input.omniUiCardId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  const node = nodeResult.value;
  if (node === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, input.omniUiCardId, 'OmniUiCard'),
      path: input.omniUiCardId,
    });
  }
  if (node.type !== 'OmniUiCard') {
    return err({
      kind: 'component-not-found',
      message: `no OmniUiCard with id ${input.omniUiCardId}`,
      path: input.omniUiCardId,
    });
  }

  // Pull the dispatchesOmniAction edges from the graph. The
  // extractor's emission discipline (dedupe + sort by to_id) is the
  // source of truth; we re-sort by (stateIndex, actionListIndex,
  // targetId) for the tool's preferred narrative order.
  const edgesResult = await listEdges(ctx.graph, input.omniUiCardId, {
    direction: 'out',
    edgeType: 'dispatchesOmniAction',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph edge query failed: ${edgesResult.error.message}`,
    });
  }
  const dispatchedActions: OmniUiCardDispatchedAction[] = [];
  for (const edge of edgesResult.value) {
    const projected = projectDispatchedAction(edge);
    if (projected !== null) {
      dispatchedActions.push(projected);
    }
  }

  // Re-parse the source XML to surface the widget tree. The v3.2 R2
  // extractor stores aggregates on the node but not the full tree;
  // the XML on disk is the canonical source. When that re-parse fails
  // the node's own aggregates are the cross-check that keeps the empty
  // `states[]` from reading as a verified zero.
  const outcome = await buildStatesFromSourceXml(
    resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath),
  );
  const states = outcome.kind === 'parsed' ? outcome.states : [];
  const widgetTreeBoundaries = widgetTreeDisclosures(node, outcome, states);

  return ok({
    data: {
      omniUiCardId: node.id,
      apiName: node.apiName,
      metadata: {
        omniUiCardType: readNullableStringProperty(node, 'omniUiCardType'),
        authorName: readNullableStringProperty(node, 'authorName'),
        versionNumber: readNullableNumberProperty(node, 'versionNumber'),
        isActive: readBooleanProperty(node, 'isActive'),
        isManagedUsingStdDesigner: readBooleanProperty(
          node,
          'isManagedUsingStdDesigner',
        ),
      },
      states,
      dataSource: {
        type: readNullableStringProperty(node, 'dataSourceType'),
        contextVariables: readStringArrayProperty(
          node,
          'dataSourceContextVariables',
        ),
      },
      dispatchedActions: sortDispatchedActions(dispatchedActions),
      // Blind-spot / drift disclosures lead: they mute the answer above
      // them. The two verbatim v3.2 contract disclosures follow and are
      // still surfaced unconditionally on every response.
      boundaries: [
        ...widgetTreeBoundaries,
        PROPERTY_SET_CONFIG_PARSING_DISCLOSURE,
        NATIVE_VS_VLOCITY_DISCLOSURE,
      ],
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
