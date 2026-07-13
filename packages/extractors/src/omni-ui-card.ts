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

/**
 * v3.2 OmniUiCard (FlexCard) extractor.
 *
 * Reads a single Salesforce Industries `*.ouc-meta.xml` file — the
 * widget-canvas primitive of OmniStudio — and produces:
 *
 *   - One `Node` of type `'OmniUiCard'` carrying the card's identity
 *     (authorName, name, versionNumber, omniUiCardType) plus a parsed
 *     summary of the `<propertySetConfig>` JSON body (state count,
 *     recursive widget count, embedded-OmniScript count) and the
 *     declared `<dataSourceConfig>` data source.
 *   - Zero-to-many `dispatchesOmniAction` edges (confidence `parsed`,
 *     source `omni-ui-card`). A card dispatches downstream OmniStudio
 *     components two ways, both modeled:
 *       - Action widgets (recursively, including widgets nested inside
 *         Block / Datatable Row containers) whose
 *         `property.actionList[].stateAction.type` is:
 *           · `OmniScript` → `OmniScript:{omniType.Name}` (the designer's
 *             canonical `{Type}/{SubType}/{Language}` form, verbatim;
 *             resolution to a vaulted OmniScript id is deferred to the
 *             v3.2 R3 MCP tool).
 *           · `Integration Procedure` →
 *             `OmniIntegrationProcedure:{integrationProcedureKey}`.
 *           · `DataAction` whose stringified-JSON `message` blob wraps a
 *             DataRaptor → `OmniDataTransform:{bundle}`.
 *       - The card's own `dataSource` (`<dataSourceConfig>`), when its
 *         `type` is `DataRaptor` → `OmniDataTransform:{value.bundle}`.
 *         This is the card's passive data-load on render; without it,
 *         impact analysis silently omits cards that load through a
 *         DataRaptor (8 such cards in a real state-agency org recon, e.g.
 *         openPdfPOC_Developer_2 → IEEGetDocContentVersion).
 *
 * Edge emission rules (and disclosed boundaries):
 *   - DataRaptor (OmniDataTransform) dispatches are emitted from BOTH the
 *     card `dataSource` and DataAction `message` blobs, for consistency
 *     with the OmniScript / Integration Procedure extractors (which emit
 *     `dispatchesOmniAction` -> `OmniDataTransform:{bundle}` for their
 *     DataRaptor steps). This closes the v3.2 gap where a card's
 *     DataRaptor dependency was invisible to impact analysis.
 *   - `Web Page` and `Custom` actions carry no OmniStudio target and stay
 *     silent.
 *   - NOT MODELED in this DataRaptor-scoped pass (real dependencies a
 *     consumer must not assume are covered): a card→Integration Procedure
 *     dependency expressed through the `dataSource` (`type:
 *     IntegrationProcedures`, `value.ipMethod`) or a DataAction `message`
 *     (inner `type: IntegrationProcedures`) — 225 + 57 such references in
 *     a real state-agency org recon — and a card→Apex dependency via an `ApexRemote`
 *     dataSource / DataAction message. These are tracked as follow-up;
 *     only DataRaptor edges land here.
 *   - The DataRaptor edge target uses the unversioned `bundle` name
 *     exactly as the OmniScript / IP extractors do (e.g.
 *     `OmniDataTransform:IEEGetDocContentVersion`), while the DataRaptor
 *     *node* id carries the file's version suffix
 *     (`OmniDataTransform:IEEGetDocContentVersion_1`). Reconciling the two
 *     is a shared downstream concern across all OmniStudio extractors, not
 *     specific to cards.
 *
 * The `<propertySetConfig>` element carries an HTML-entity-escaped JSON
 * blob. fast-xml-parser (with the configured `processEntities`) decodes
 * `&quot;` → `"` so the input to `JSON.parse` is plain JSON. Malformed
 * blobs become per-card warnings rather than hard failures — the v3.2
 * "best-effort JSON parsing" honesty axis.
 *
 * @see docs/vendor/salesforce-metadata/OmniUiCard.md
 * @see PLAN-v3.2.md §3 (contracts), §4 (sfi.omniuicard_widget_breakdown).
 */
const OMNI_UI_CARD_FILE_SUFFIX = '.ouc-meta.xml';
const ROOT_ELEMENT = 'OmniUiCard';
const NODE_TYPE = 'OmniUiCard';
const EXTRACTOR_SOURCE = 'omni-ui-card';

/**
 * Widget `name` discriminant for widgets that may dispatch downstream
 * OmniStudio actions. The FlexCard widget tree uses `name: 'Action'` for
 * the button/action widget; only Action widgets carry `actionList[]`.
 */
const ACTION_WIDGET_NAME = 'Action';

/**
 * `stateAction.type` values that emit `dispatchesOmniAction` edges.
 * `OmniScript` / `Integration Procedure` target the dispatched process;
 * `DataAction` targets a DataRaptor when its `message` blob wraps one
 * (see {@link buildDataActionEdge}). `Web Page` and `Custom` actions
 * carry no OmniStudio dispatch target and stay silent. `DataAction`
 * actions that wrap an `ApexRemote` or `IntegrationProcedures` call are
 * real dependencies too but are NOT modeled here — see the file-header
 * "Edge emission rules" disclosure.
 */
const OMNISCRIPT_ACTION_TYPE = 'OmniScript';
const IP_ACTION_TYPE = 'Integration Procedure';
const DATA_ACTION_TYPE = 'DataAction';

/**
 * The `dataSource.type` / DataAction-`message`-`type` discriminant for a
 * DataRaptor (OmniDataTransform) load. A card whose own `dataSource` is a
 * DataRaptor — or whose DataAction widget loads one — depends on that
 * DataRaptor exactly as an OmniScript / Integration Procedure does, and is
 * modeled with the same `dispatchesOmniAction` -> `OmniDataTransform:{bundle}`
 * edge for cross-tool consistency.
 */
const DATARAPTOR_TYPE = 'DataRaptor';

/**
 * Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence
 * children. The parser emits an array when an element repeats and a
 * scalar/object otherwise; the OmniUiCard top-level elements
 * (`<authorName>`, `<name>`, `<propertySetConfig>`, etc.) are
 * single-occurrence.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Coerce an XML scalar element to a nullable string. */
const toNullableString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null) return null;
  // fast-xml-parser surfaces `<x xsi:nil="true"/>` as `{}`; treat any
  // non-string-coercible scalar as null.
  if (typeof v === 'object') return null;
  const s = String(v);
  return s.length > 0 ? s : null;
};

/** Coerce an XML scalar element to boolean; non-`true` values become false. */
const coerceBoolean = (value: unknown): boolean => {
  const v = unwrapSingle(value);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
};

/** Coerce an XML scalar to a finite number; returns `null` when not parseable. */
const toNullableNumber = (value: unknown): number | null => {
  const v = unwrapSingle(value);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

/**
 * Best-effort parse of an HTML-entity-escaped JSON string from the XML.
 * fast-xml-parser (with the entity processor enabled below) decodes
 * `&quot;` into `"` so the input here is plain JSON; the only failure
 * mode is occasional Salesforce exporter quirks (rare). Failures produce
 * `null` and append a warning rather than aborting extraction.
 *
 * Returns the parsed JSON unchanged when it's already an object
 * (fast-xml-parser sometimes structures empty `{}` blobs).
 */
const parseJsonBlob = (
  raw: unknown,
  warnings: string[],
  contextLabel: string,
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
  } catch (cause: unknown) {
    warnings.push(
      `failed to parse ${contextLabel} JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return null;
  }
};

/** A widget node as surfaced by `collectWidgets` (recursive). */
interface ParsedWidget {
  readonly name: string;
  readonly elementLabel: string | null;
  readonly stateIndex: number;
  readonly stateName: string;
  readonly property: Readonly<Record<string, unknown>> | null;
}

/** A parsed state's surface as returned by `collectStates`. */
interface ParsedState {
  readonly name: string;
  readonly stateIndex: number;
  readonly widgetCount: number;
  readonly embeddedScriptCount: number;
}

/**
 * Recursively walk a single state's widget tree and emit:
 *   - Every Action widget (for downstream edge emission).
 *   - The total recursive widget count.
 *   - The total recursive count of widgets whose `type === 'omniscript'`
 *     (embedded OmniScripts, surfaced as `embeddedScriptCount`).
 *
 * Walks both `children` (the documented Block / Datatable Row nesting)
 * and `components.layer-0.children` (state-root nesting). Container
 * widgets count themselves and contribute their children's counts.
 */
const walkWidgets = (
  rawChildren: unknown,
  stateIndex: number,
  stateName: string,
  out: {
    actionWidgets: ParsedWidget[];
    widgetCount: number;
    embeddedScriptCount: number;
  },
): void => {
  if (!Array.isArray(rawChildren)) return;
  for (const child of rawChildren) {
    if (typeof child !== 'object' || child === null) continue;
    const widget = child as Record<string, unknown>;
    out.widgetCount += 1;
    const name = typeof widget['name'] === 'string' ? widget['name'] : '';
    const widgetType =
      typeof widget['type'] === 'string' ? widget['type'] : '';
    // FlexCards expose embedded OmniScripts via widget `type` of
    // `omniscript` (lowercase). Count them so the node property can
    // surface the "how many embedded scripts does this card carry"
    // metric without re-walking.
    if (widgetType === 'omniscript') {
      out.embeddedScriptCount += 1;
    }
    if (name === ACTION_WIDGET_NAME) {
      const propertyRaw = widget['property'];
      const property =
        typeof propertyRaw === 'object' && propertyRaw !== null
          ? (propertyRaw as Readonly<Record<string, unknown>>)
          : null;
      const elementLabel =
        typeof widget['elementLabel'] === 'string'
          ? widget['elementLabel']
          : null;
      out.actionWidgets.push({
        name,
        elementLabel,
        stateIndex,
        stateName,
        property,
      });
    }
    // Container widgets carry their nested widgets in `children`. Walk
    // those too — Block widgets in particular hold the bulk of
    // Action-widget edges in Globex's fixtures.
    walkWidgets(widget['children'], stateIndex, stateName, out);
  }
};

/**
 * Walk every state in `states[]` and aggregate per-state counts plus the
 * full flat list of Action widgets (for downstream edge emission).
 * State indexes preserve the JSON's declared order (matches the
 * propertySetConfig parsing-disclosure verbatim).
 */
const collectStates = (
  states: readonly unknown[],
): {
  readonly stateSummaries: readonly ParsedState[];
  readonly actionWidgets: readonly ParsedWidget[];
  readonly totalWidgetCount: number;
  readonly totalEmbeddedScriptCount: number;
} => {
  const summaries: ParsedState[] = [];
  const allActionWidgets: ParsedWidget[] = [];
  let totalWidgetCount = 0;
  let totalEmbeddedScriptCount = 0;
  for (let i = 0; i < states.length; i += 1) {
    const state = states[i];
    if (typeof state !== 'object' || state === null) continue;
    const stateObj = state as Record<string, unknown>;
    const stateName =
      typeof stateObj['name'] === 'string' ? stateObj['name'] : '';
    const perState = {
      actionWidgets: [] as ParsedWidget[],
      widgetCount: 0,
      embeddedScriptCount: 0,
    };
    // The widget root is `components.layer-0.children`. The doc shows
    // this nesting because FlexCards support multiple visual layers
    // historically; v3.2 only walks `layer-0` (production cards in the
    // recon use the layer-0 root exclusively).
    const componentsRaw = stateObj['components'];
    if (typeof componentsRaw === 'object' && componentsRaw !== null) {
      const layer0 = (componentsRaw as Record<string, unknown>)['layer-0'];
      if (typeof layer0 === 'object' && layer0 !== null) {
        walkWidgets(
          (layer0 as Record<string, unknown>)['children'],
          i,
          stateName,
          perState,
        );
      }
    }
    summaries.push({
      name: stateName,
      stateIndex: i,
      widgetCount: perState.widgetCount,
      embeddedScriptCount: perState.embeddedScriptCount,
    });
    allActionWidgets.push(...perState.actionWidgets);
    totalWidgetCount += perState.widgetCount;
    totalEmbeddedScriptCount += perState.embeddedScriptCount;
  }
  return {
    stateSummaries: summaries,
    actionWidgets: allActionWidgets,
    totalWidgetCount,
    totalEmbeddedScriptCount,
  };
};

/**
 * Resolve a `DataAction` Action-widget entry to a DataRaptor dispatch
 * edge. A DataAction stores its data operation in a stringified-JSON
 * `message` blob of the shape
 * `{"type":"DataRaptor"|"ApexRemote"|"IntegrationProcedures","value":{…}}`.
 * When that inner `type` is `DataRaptor`, `value.bundle` is the DataRaptor
 * name and we emit the same `dispatchesOmniAction` ->
 * `OmniDataTransform:{bundle}` edge the card's DataRaptor dataSource emits
 * (confidence `parsed` — the target lives inside the JSON blob).
 *
 * Returns `null` for non-DataRaptor message types (`ApexRemote` /
 * `IntegrationProcedures` — deliberately not modeled here) and for a
 * missing/unparseable `message`. A DataRaptor message with no `bundle`
 * is a dangling dispatch, recorded as a warning rather than an edge.
 */
const buildDataActionEdge = (
  cardId: string,
  widget: ParsedWidget,
  stateAction: Readonly<Record<string, unknown>>,
  actionListIndex: number,
  warnings: string[],
): Edge | null => {
  const messageRaw = stateAction['message'];
  if (typeof messageRaw !== 'string' || messageRaw.trim().length === 0) {
    return null;
  }
  let message: unknown;
  try {
    message = JSON.parse(messageRaw);
  } catch {
    // Best-effort: a malformed DataAction message is not an edge. Not
    // warned — DataAction message blobs are abundant and mostly Apex / IP,
    // so a parse hiccup on a non-DataRaptor blob isn't actionable.
    return null;
  }
  if (typeof message !== 'object' || message === null) return null;
  const msg = message as Record<string, unknown>;
  if (msg['type'] !== DATARAPTOR_TYPE) return null;
  const value = msg['value'];
  const bundle =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)['bundle']
      : undefined;
  if (typeof bundle !== 'string' || bundle.length === 0) {
    warnings.push(
      `DataAction in ${widget.stateName}/${widget.elementLabel ?? '?'} loads a DataRaptor with no bundle`,
    );
    return null;
  }
  return {
    fromId: cardId,
    toId: `OmniDataTransform:${bundle}`,
    edgeType: 'dispatchesOmniAction',
    confidence: 'parsed',
    source: EXTRACTOR_SOURCE,
    properties: {
      stateName: widget.stateName,
      stateIndex: widget.stateIndex,
      widgetLabel: widget.elementLabel,
      actionListIndex,
      actionType: DATA_ACTION_TYPE,
      dataActionType: DATARAPTOR_TYPE,
      targetRawName: bundle,
    },
  };
};

/**
 * Build the card-level dispatch edge from the card's own `dataSource`.
 * A FlexCard whose `dataSourceConfig.dataSource.type === 'DataRaptor'`
 * loads its data by invoking that DataRaptor when it renders — the same
 * downstream dependency the OmniScript / Integration Procedure extractors
 * model as `dispatchesOmniAction` -> `OmniDataTransform:{bundle}`. Without
 * this edge, "what uses DataRaptor X?" silently omits every card that
 * loads through it (8 cards in a real state-agency org recon, including the
 * openPdfPOC cards -> IEEGetDocContentVersion).
 *
 * Only the DataRaptor dataSource type emits here. `IntegrationProcedures`
 * (-> OmniIntegrationProcedure) and `ApexRemote` (-> ApexClass) data
 * sources are real card dependencies too but are deliberately NOT modeled
 * in this DataRaptor-scoped change — see the file-header "Edge emission
 * rules" disclosure. Returns `null` when the dataSource is absent, is not
 * a DataRaptor, or carries no `value.bundle`.
 */
const buildDataSourceEdge = (
  cardId: string,
  dataSource: Readonly<Record<string, unknown>> | null,
): Edge | null => {
  if (dataSource === null || dataSource['type'] !== DATARAPTOR_TYPE) {
    return null;
  }
  const value = dataSource['value'];
  const bundle =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)['bundle']
      : undefined;
  if (typeof bundle !== 'string' || bundle.length === 0) return null;
  return {
    fromId: cardId,
    toId: `OmniDataTransform:${bundle}`,
    edgeType: 'dispatchesOmniAction',
    confidence: 'parsed',
    source: EXTRACTOR_SOURCE,
    properties: {
      dispatchSource: 'dataSource',
      dataSourceType: DATARAPTOR_TYPE,
      targetRawName: bundle,
    },
  };
};

/**
 * Read `actionList[]` from an Action widget's `property` blob and emit
 * one `dispatchesOmniAction` edge per qualifying entry. Per
 * `OmniUiCard.md` §"Resolving dispatchesOmniAction from Action widgets":
 *
 *   - `stateAction.type === 'OmniScript'` →
 *     `OmniScript:{stateAction.omniType.Name}`. The omniType.Name uses
 *     the designer's `{Type}/{SubType}/{Language}` canonical form;
 *     v3.2 surfaces it verbatim. Resolution to a vaulted OmniScript id
 *     is the v3.2 R3 MCP tool's job.
 *   - `stateAction.type === 'Integration Procedure'` →
 *     `OmniIntegrationProcedure:{stateAction.integrationProcedureKey}`.
 *   - `stateAction.type === 'DataAction'` whose `message` blob wraps a
 *     DataRaptor → `OmniDataTransform:{bundle}` (see
 *     {@link buildDataActionEdge}). Apex / IP DataAction messages and
 *     `Web Page` / `Custom` actions emit nothing.
 *
 * Confidence is always `parsed` (the target name lives inside the
 * propertySetConfig JSON blob).
 */
const buildEdgesForWidget = (
  cardId: string,
  widget: ParsedWidget,
  warnings: string[],
): Edge[] => {
  if (widget.property === null) return [];
  const actionListRaw = widget.property['actionList'];
  if (!Array.isArray(actionListRaw)) return [];
  const edges: Edge[] = [];
  for (let i = 0; i < actionListRaw.length; i += 1) {
    const entry = actionListRaw[i];
    if (typeof entry !== 'object' || entry === null) continue;
    const stateActionRaw = (entry as Record<string, unknown>)['stateAction'];
    if (typeof stateActionRaw !== 'object' || stateActionRaw === null) continue;
    const stateAction = stateActionRaw as Record<string, unknown>;
    const actionType = stateAction['type'];
    if (typeof actionType !== 'string') continue;
    // DataAction widgets carry their data operation in a stringified-JSON
    // `message` blob; a DataRaptor load there is the same dependency the
    // card's own DataRaptor dataSource models. ApexRemote / IP message
    // blobs stay silent (see the file-header "Edge emission rules").
    if (actionType === DATA_ACTION_TYPE) {
      const dataActionEdge = buildDataActionEdge(
        cardId,
        widget,
        stateAction,
        i,
        warnings,
      );
      if (dataActionEdge !== null) edges.push(dataActionEdge);
      continue;
    }
    if (
      actionType !== OMNISCRIPT_ACTION_TYPE &&
      actionType !== IP_ACTION_TYPE
    ) {
      continue;
    }
    let toId: string | null = null;
    let targetRawName: string | null = null;
    if (actionType === OMNISCRIPT_ACTION_TYPE) {
      const omniType = stateAction['omniType'];
      if (
        typeof omniType === 'object' &&
        omniType !== null &&
        typeof (omniType as Record<string, unknown>)['Name'] === 'string'
      ) {
        targetRawName = String((omniType as Record<string, unknown>)['Name']);
        if (targetRawName.length > 0) {
          toId = `OmniScript:${targetRawName}`;
        }
      }
      if (toId === null) {
        warnings.push(
          `OmniScript action in ${widget.stateName}/${widget.elementLabel ?? '?'} has no omniType.Name`,
        );
        continue;
      }
    } else {
      // Integration Procedure
      const key = stateAction['integrationProcedureKey'];
      if (typeof key === 'string' && key.length > 0) {
        targetRawName = key;
        toId = `OmniIntegrationProcedure:${key}`;
      }
      if (toId === null) {
        warnings.push(
          `Integration Procedure action in ${widget.stateName}/${widget.elementLabel ?? '?'} has no integrationProcedureKey`,
        );
        continue;
      }
    }
    edges.push({
      fromId: cardId,
      toId,
      edgeType: 'dispatchesOmniAction',
      confidence: 'parsed',
      source: EXTRACTOR_SOURCE,
      properties: {
        stateName: widget.stateName,
        stateIndex: widget.stateIndex,
        widgetLabel: widget.elementLabel,
        actionListIndex: i,
        actionType,
        targetRawName,
      },
    });
  }
  return edges;
};

/**
 * Deduplicate edges by `(fromId, toId, edgeType, source)` and sort for
 * stable byte-equal test output: by `toId` ascending, then `edgeType`
 * ascending. The first occurrence's `properties` payload wins — Action
 * widgets that link to the same downstream component twice (e.g., from
 * two states) keep the first state's context as the canonical record.
 */
const dedupeAndSortEdges = (edges: readonly Edge[]): Edge[] => {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const edge of edges) {
    const key = `${edge.fromId}|${edge.toId}|${edge.edgeType}|${edge.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  out.sort((a, b) => {
    if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
    if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
    return 0;
  });
  return out;
};

/**
 * Read and strictly-validate a file as XML. Validates before parsing so
 * malformed input surfaces as `parse-error` (fast-xml-parser's
 * `parse()` silently truncates on mismatched tags).
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

/** Locate and validate the `<OmniUiCard>` root. */
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
  return ok(root as Record<string, unknown>);
};

/**
 * Extract a single Salesforce Industries OmniUiCard (`.ouc-meta.xml`)
 * file into a Node + zero-to-many `dispatchesOmniAction` edges.
 *
 * Defensive: malformed `propertySetConfig` JSON, missing Action widget
 * targets, and similar per-widget noise collect into
 * `node.properties.omniUiCardExtractionWarnings` rather than failing
 * the whole extraction. The root-element check still hard-fails.
 *
 * Edge emission (see the file-header "Edge emission rules" for the full
 * rules and disclosed boundaries); all at confidence `parsed`:
 *   - Action widget `stateAction.type === 'OmniScript'` →
 *     `OmniScript:{omniType.Name}`.
 *   - Action widget `stateAction.type === 'Integration Procedure'` →
 *     `OmniIntegrationProcedure:{integrationProcedureKey}`.
 *   - Action widget `stateAction.type === 'DataAction'` whose `message`
 *     wraps a DataRaptor → `OmniDataTransform:{bundle}`.
 *   - The card's own `dataSource` of `type` `DataRaptor` →
 *     `OmniDataTransform:{value.bundle}`.
 *
 * @example
 *   const result = await extractOmniUiCard(
 *     'force-app/main/default/omniUiCard/AccountLinkingIntro_Developer_1.ouc-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'OmniUiCard:AccountLinkingIntro_Developer_1'
 *   }
 */
export const extractOmniUiCard = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. FlexCards are the
  // most entity-heavy v3.2 metadata shape: a single card commonly
  // carries 200+ widgets × ~10 entity references each, and the
  // largest Globex FlexCards (NoticeDetails / common footers /
  // PreScreenerResults) hit 20k+ entity expansions. Raised to 50000
  // to accept production-scale Industries FlexCards while preserving
  // a ceiling against pathological inputs — the default 1000 (and
  // the Flow / Profile 10000) underfit FlexCards specifically.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 50000 },
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

  const apiName = deriveComponentApiName(path, OMNI_UI_CARD_FILE_SUFFIX);
  const cardId = `${NODE_TYPE}:${apiName}`;

  const warnings: string[] = [];

  // Top-level XML elements. The card's identity lives here; the bulk of
  // the structural content lives inside propertySetConfig.
  const nameLabel = toNullableString(rootObj['name']);
  const authorName = toNullableString(rootObj['authorName']);
  const versionNumber = toNullableNumber(rootObj['versionNumber']);
  const omniUiCardType = toNullableString(rootObj['omniUiCardType']);

  // Parse the two JSON blobs. Both are HTML-entity-escaped in the
  // source XML; fast-xml-parser's entity processor decodes them
  // before we see the string.
  const dataSourceConfig = parseJsonBlob(
    rootObj['dataSourceConfig'],
    warnings,
    'dataSourceConfig',
  );
  const propertySetConfig = parseJsonBlob(
    rootObj['propertySetConfig'],
    warnings,
    'propertySetConfig',
  );

  // Pull dataSource details from the dataSourceConfig blob.
  // Shape per the vendored doc:
  //   { dataSource: { type, value, orderBy, contextVariables } }
  let dataSourceType: string | null = null;
  let dataSourceContextVariables: readonly string[] = [];
  // Kept for the card-level dispatch edge: a DataRaptor dataSource is a
  // real downstream dependency (see buildDataSourceEdge).
  let dataSourceObj: Record<string, unknown> | null = null;
  if (dataSourceConfig !== null) {
    const ds = dataSourceConfig['dataSource'];
    if (typeof ds === 'object' && ds !== null) {
      const dsObj = ds as Record<string, unknown>;
      dataSourceObj = dsObj;
      if (typeof dsObj['type'] === 'string' && dsObj['type'].length > 0) {
        dataSourceType = dsObj['type'];
      }
      if (Array.isArray(dsObj['contextVariables'])) {
        dataSourceContextVariables = dsObj['contextVariables']
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v);
      }
    }
  }

  // Walk the states[] array from propertySetConfig and aggregate
  // per-state counts plus the flat list of Action widgets.
  let stateCount = 0;
  let widgetCount = 0;
  let embeddedScriptCount = 0;
  let actionWidgets: readonly ParsedWidget[] = [];
  if (propertySetConfig !== null) {
    const statesRaw = propertySetConfig['states'];
    if (Array.isArray(statesRaw)) {
      stateCount = statesRaw.length;
      const collected = collectStates(statesRaw);
      widgetCount = collected.totalWidgetCount;
      embeddedScriptCount = collected.totalEmbeddedScriptCount;
      actionWidgets = collected.actionWidgets;
    }
  }

  // Emit one dispatchesOmniAction edge per qualifying Action widget
  // entry. Dedupe across states (a card with the same Start button on
  // two states emits one edge, not two — the duplicate would mask the
  // real edge count from impact-analysis tools).
  const rawEdges: Edge[] = [];
  for (const widget of actionWidgets) {
    rawEdges.push(...buildEdgesForWidget(cardId, widget, warnings));
  }
  // The card's own `dataSource`, when it's a DataRaptor, is a downstream
  // dispatch just like the OmniScript / IP extractors model — emit it so
  // "what uses DataRaptor X?" includes cards that load through it.
  const dataSourceEdge = buildDataSourceEdge(cardId, dataSourceObj);
  if (dataSourceEdge !== null) rawEdges.push(dataSourceEdge);
  const edges = dedupeAndSortEdges(rawEdges);

  const node: Node = {
    id: cardId,
    type: 'OmniUiCard',
    apiName,
    label: nameLabel,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      omniUiCardType,
      authorName,
      versionNumber,
      isActive: coerceBoolean(rootObj['isActive']),
      isManagedUsingStdDesigner: coerceBoolean(
        rootObj['isManagedUsingStdDesigner'],
      ),
      name: nameLabel,
      stateCount,
      widgetCount,
      embeddedScriptCount,
      dataSourceType,
      dataSourceContextVariables,
      omniUiCardExtractionWarnings: warnings,
    },
  };

  return ok({ nodes: [node], edges });
};
