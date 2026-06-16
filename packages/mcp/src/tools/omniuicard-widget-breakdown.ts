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
 *     every response.
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

import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix for the OmniUiCard node type. */
const OMNI_UI_CARD_PREFIX = 'OmniUiCard:';

/** Root element name in the source `.ouc-meta.xml` file. */
const ROOT_ELEMENT = 'OmniUiCard';

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
 * Walk every state in the parsed propertySetConfig and build the
 * tool's `states[]` payload. State indexes preserve the JSON's
 * declared order (the propertySetConfig-parsing disclosure axis).
 * Non-object states are skipped defensively.
 */
const buildStates = (
  propertySetConfig: Readonly<Record<string, unknown>> | null,
): OmniUiCardState[] => {
  if (propertySetConfig === null) return [];
  const statesRaw = propertySetConfig['states'];
  if (!Array.isArray(statesRaw)) return [];
  const states: OmniUiCardState[] = [];
  for (let i = 0; i < statesRaw.length; i += 1) {
    const state = statesRaw[i];
    if (typeof state !== 'object' || state === null) continue;
    const stateObj = state as Record<string, unknown>;
    const name = typeof stateObj['name'] === 'string' ? stateObj['name'] : '';
    // The widget root is `components.layer-0.children`. v3.2 walks
    // only `layer-0` — production cards in the recon use the
    // layer-0 root exclusively. Other layers (legacy) would surface
    // as zero widgets; the propertySetConfig-parsing disclosure
    // covers the limitation.
    let widgets: readonly OmniUiCardWidget[] = [];
    const componentsRaw = stateObj['components'];
    if (typeof componentsRaw === 'object' && componentsRaw !== null) {
      const layer0 = (componentsRaw as Record<string, unknown>)['layer-0'];
      if (typeof layer0 === 'object' && layer0 !== null) {
        widgets = walkWidgets((layer0 as Record<string, unknown>)['children']);
      }
    }
    states.push({
      name,
      stateIndex: i,
      widgetCount: countWidgets(widgets),
      widgets,
    });
  }
  return states;
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
 * Read + validate the source `.ouc-meta.xml`, parse the
 * propertySetConfig JSON, and walk the states. Returns an empty
 * states[] when the file is missing, malformed, or carries an
 * empty / non-parseable propertySetConfig — the tool degrades
 * gracefully because the metadata + dispatchedActions + boundaries
 * sections are still meaningful without the widget tree.
 *
 * fast-xml-parser's entity processor is configured the same way the
 * v3.2 R2 extractor configures it: the FlexCard propertySetConfig
 * blob is the most entity-heavy v3.2 metadata shape and needs the
 * raised 50000-expansion cap.
 */
const buildStatesFromSourceXml = async (
  sourcePath: string,
): Promise<readonly OmniUiCardState[]> => {
  let xmlText: string;
  try {
    xmlText = await readFile(sourcePath, 'utf-8');
  } catch {
    return [];
  }
  if (XMLValidator.validate(xmlText) !== true) {
    return [];
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
    return [];
  }
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) return [];
  const rootObj = root as Record<string, unknown>;
  const propertySetConfig = parseJsonBlob(rootObj['propertySetConfig']);
  return buildStates(propertySetConfig);
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
  // the XML on disk is the canonical source.
  const states = await buildStatesFromSourceXml(
    resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath),
  );

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
      boundaries: [
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
