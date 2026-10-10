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

import { extractCardDataPack, isDataPackSource } from './datapack-extract.js';
import { type ApexRemoteCall, apexRemoteTarget, buildApexRemoteEdges, literalObjectArgs } from './omnistudio/remote.js';
import { readStaticSoql } from './omnistudio/soql.js';
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
 *         `type` is `DataRaptor` → `OmniDataTransform:{value.bundle}`, or
 *         `IntegrationProcedures` → `OmniIntegrationProcedure:{value.ipMethod}`.
 *         This is the card's passive data-load on render; without it,
 *         impact analysis silently omits cards that load through a
 *         DataRaptor or an Integration Procedure (in a real state-agency
 *         org recon most data-backed cards load through an IP).
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
 *   - Integration Procedure loads are modeled the same way: a `dataSource`
 *     or DataAction `message` whose `type` is `IntegrationProcedures` names
 *     the IP by `value.ipMethod` (its `Type_SubType` key) and emits
 *     `dispatchesOmniAction` -> `OmniIntegrationProcedure:{ipMethod}`.
 *   - An `ApexRemote` dataSource or DataAction message runs an Apex class:
 *     one aggregated `callsApex` edge per class (`omnistudio/remote.ts`),
 *     every routed `remoteMethod` in `methods[]`.
 *   - A `Query` dataSource (static SOQL in `value.query`) emits `readsFrom`
 *     edges to the queried object and each plain field it names; relationship
 *     paths are left on the node (`unresolvedTraversalRefs`) for the graph
 *     import to resolve or drop.
 *   - Every target is the caller's KEY — the unversioned `bundle` name
 *     (`OmniDataTransform:AcmeGetDocument`) or the IP key — exactly as the
 *     OmniScript / IP extractors emit it, while the node ids carry the
 *     file's version suffix (`OmniDataTransform:AcmeGetDocument_1`). The
 *     graph import resolves each key onto the versioned node that runs
 *     (`@sf-intelligence/graph` omni-resolve), for every OmniStudio caller.
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
/** A `{Label.Name}` custom-label merge token inside FlexCard definition JSON. */
const FLEXCARD_LABEL_TOKEN = /\{Label\.([A-Za-z][A-Za-z0-9_]*)\}/g;

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
 * The `dataSource.type` / DataAction-`message`-`type` discriminant for an
 * Integration Procedure load. The IP is named by `value.ipMethod` — its
 * `Type_SubType` key, the same key an OmniScript IP Action uses.
 */
const INTEGRATION_PROCEDURES_TYPE = 'IntegrationProcedures';

/** The data-source / DataAction discriminant for an Apex call (`value.remoteClass` / `remoteMethod`). */
const APEX_REMOTE_TYPE = 'ApexRemote';

/** The data-source discriminant for a static SOQL query (`value.query`). */
const QUERY_TYPE = 'Query';

/**
 * Field-level reads of a card's SOQL data source: `readsFrom` the queried
 * object and each plain field it names (SELECT, WHERE, ORDER BY / GROUP BY).
 * Relationship paths go to the import (`unresolvedTraversalRefs`), which
 * resolves them against the vault's lookups or drops them.
 */
const buildQueryReads = (
  cardId: string,
  dataSource: Readonly<Record<string, unknown>> | null,
): { readonly edges: readonly Edge[]; readonly traversals: readonly { object: string; path: string; access: 'read' }[] } => {
  if (dataSource === null || dataSource['type'] !== QUERY_TYPE) return { edges: [], traversals: [] };
  const value = typeof dataSource['value'] === 'object' && dataSource['value'] !== null ? (dataSource['value'] as Record<string, unknown>) : {};
  const read = readStaticSoql(value['query']);
  if (read === null) return { edges: [], traversals: [] };
  const props = { dispatchSource: 'dataSource', dataSourceType: QUERY_TYPE, mechanism: 'flexcard-soql' };
  return {
    edges: [
      { fromId: cardId, toId: `CustomObject:${read.object}`, edgeType: 'readsFrom', confidence: 'parsed', source: EXTRACTOR_SOURCE, properties: props },
      ...read.fields.map(
        (f): Edge => ({ fromId: cardId, toId: `CustomField:${read.object}.${f}`, edgeType: 'readsFrom', confidence: 'parsed', source: EXTRACTOR_SOURCE, properties: props }),
      ),
    ],
    traversals: read.traversals.map((path) => ({ object: read.object, path, access: 'read' as const })),
  };
};

/** The OmniStudio target of one data load, or why there is none. */
type LoadTarget =
  | { readonly kind: 'target'; readonly toId: string; readonly loadType: string; readonly raw: string }
  | { readonly kind: 'missing-key'; readonly loadType: string }
  | { readonly kind: 'not-modeled' };

/**
 * Resolve the target of a DataRaptor or Integration Procedure load from a
 * `{ type, value }` data-source shape — a card `dataSource` or a DataAction
 * `message`. `ApexRemote` and every other type are `not-modeled`.
 */
const loadTarget = (type: unknown, value: unknown): LoadTarget => {
  const v =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  if (type === DATARAPTOR_TYPE) {
    const bundle = v['bundle'];
    if (typeof bundle !== 'string' || bundle.length === 0) {
      return { kind: 'missing-key', loadType: DATARAPTOR_TYPE };
    }
    return { kind: 'target', toId: `OmniDataTransform:${bundle}`, loadType: DATARAPTOR_TYPE, raw: bundle };
  }
  if (type === INTEGRATION_PROCEDURES_TYPE) {
    const ipMethod = v['ipMethod'];
    if (typeof ipMethod !== 'string' || ipMethod.trim().length === 0) {
      return { kind: 'missing-key', loadType: INTEGRATION_PROCEDURES_TYPE };
    }
    const key = ipMethod.trim();
    return {
      kind: 'target',
      toId: `OmniIntegrationProcedure:${key}`,
      loadType: INTEGRATION_PROCEDURES_TYPE,
      raw: key,
    };
  }
  return { kind: 'not-modeled' };
};

/**
 * Resolve a `DataAction` Action-widget entry to a dispatch edge. A
 * DataAction stores its data operation in a stringified-JSON `message` blob
 * of the shape
 * `{"type":"DataRaptor"|"ApexRemote"|"IntegrationProcedures","value":{…}}`:
 *   - `DataRaptor` → `OmniDataTransform:{value.bundle}`;
 *   - `IntegrationProcedures` → `OmniIntegrationProcedure:{value.ipMethod}`.
 * Both are the same dependency the card's own data source models
 * (confidence `parsed` — the target lives inside the JSON blob).
 *
 * Returns `null` for `ApexRemote` (not modeled — see the file header) and
 * for a missing/unparseable `message`. A DataRaptor / IP message with no
 * key is a dangling dispatch, recorded as a warning rather than an edge.
 */
const buildDataActionEdge = (
  cardId: string,
  widget: ParsedWidget,
  stateAction: Readonly<Record<string, unknown>>,
  actionListIndex: number,
  warnings: string[],
  apexCalls: ApexRemoteCall[],
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
    // so a parse hiccup on one isn't actionable.
    return null;
  }
  if (typeof message !== 'object' || message === null) return null;
  const msg = message as Record<string, unknown>;
  // An `ApexRemote` DataAction runs an Apex class: collected here, emitted as
  // one aggregated `callsApex` edge per class by the caller.
  if (msg['type'] === APEX_REMOTE_TYPE) {
    const value = typeof msg['value'] === 'object' && msg['value'] !== null ? (msg['value'] as Record<string, unknown>) : {};
    const target = apexRemoteTarget(value['remoteClass']);
    if (target !== null) {
      apexCalls.push({
        target,
        remoteMethod: typeof value['remoteMethod'] === 'string' ? value['remoteMethod'] : null,
        site: `${widget.stateName}/${widget.elementLabel ?? '?'}#${actionListIndex}`,
        siteType: DATA_ACTION_TYPE,
        objectArgs: literalObjectArgs(value),
      });
    }
    return null;
  }
  const target = loadTarget(msg['type'], msg['value']);
  if (target.kind === 'not-modeled') return null;
  if (target.kind === 'missing-key') {
    warnings.push(
      target.loadType === DATARAPTOR_TYPE
        ? `DataAction in ${widget.stateName}/${widget.elementLabel ?? '?'} loads a DataRaptor with no bundle`
        : `DataAction in ${widget.stateName}/${widget.elementLabel ?? '?'} calls an Integration Procedure with no ipMethod`,
    );
    return null;
  }
  return {
    fromId: cardId,
    toId: target.toId,
    edgeType: 'dispatchesOmniAction',
    confidence: 'parsed',
    source: EXTRACTOR_SOURCE,
    properties: {
      stateName: widget.stateName,
      stateIndex: widget.stateIndex,
      widgetLabel: widget.elementLabel,
      actionListIndex,
      actionType: DATA_ACTION_TYPE,
      dataActionType: target.loadType,
      targetRawName: target.raw,
    },
  };
};

/**
 * Build the card-level dispatch edge from the card's own `dataSource`. A
 * FlexCard whose `dataSourceConfig.dataSource.type` is `DataRaptor` or
 * `IntegrationProcedures` loads its data by invoking that component when it
 * renders — the same downstream dependency an OmniScript models as
 * `dispatchesOmniAction`. Without this edge, "what uses DataRaptor / IP X?"
 * silently omits every card that loads through it.
 *
 * `ApexRemote` (-> ApexClass) data sources are real card dependencies too but
 * are NOT modeled here — see the file-header "Edge emission rules". Returns
 * `null` when the dataSource is absent, of another type, or names no target.
 */
const buildDataSourceEdge = (
  cardId: string,
  dataSource: Readonly<Record<string, unknown>> | null,
): Edge | null => {
  if (dataSource === null) return null;
  const target = loadTarget(dataSource['type'], dataSource['value']);
  if (target.kind !== 'target') return null;
  return {
    fromId: cardId,
    toId: target.toId,
    edgeType: 'dispatchesOmniAction',
    confidence: 'parsed',
    source: EXTRACTOR_SOURCE,
    properties: {
      dispatchSource: 'dataSource',
      dataSourceType: target.loadType,
      targetRawName: target.raw,
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
  apexCalls: ApexRemoteCall[],
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
        apexCalls,
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
 *     'force-app/main/default/omniUiCard/AcmeEnrollmentIntro_Developer_1.ouc-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'OmniUiCard:AcmeEnrollmentIntro_Developer_1'
 *   }
 */
export const extractOmniUiCard = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  // A managed-package (Vlocity) Card export: a DataPack folder or its main file.
  if (await isDataPackSource(path)) return extractCardDataPack(path, extractOmniUiCardRoot);
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
  return extractOmniUiCardRoot(rootResult.value, path, deriveComponentApiName(path, OMNI_UI_CARD_FILE_SUFFIX));
};

/**
 * The extraction over the parsed `<OmniUiCard>` root — the seam a converted
 * source (a managed-package Card DataPack) enters through.
 */
export const extractOmniUiCardRoot = (
  rootObj: Record<string, unknown>,
  path: string,
  apiName: string,
): Result<ExtractionResult, ExtractorError> => {
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
  const apexCalls: ApexRemoteCall[] = [];
  for (const widget of actionWidgets) {
    rawEdges.push(...buildEdgesForWidget(cardId, widget, warnings, apexCalls));
  }
  // The card's own `dataSource`, when it's a DataRaptor, is a downstream
  // dispatch just like the OmniScript / IP extractors model — emit it so
  // "what uses DataRaptor X?" includes cards that load through it.
  const dataSourceEdge = buildDataSourceEdge(cardId, dataSourceObj);
  if (dataSourceEdge !== null) rawEdges.push(dataSourceEdge);
  // An `ApexRemote` data source runs an Apex class when the card renders.
  if (dataSourceObj !== null && dataSourceObj['type'] === APEX_REMOTE_TYPE) {
    const value =
      typeof dataSourceObj['value'] === 'object' && dataSourceObj['value'] !== null
        ? (dataSourceObj['value'] as Record<string, unknown>)
        : {};
    const target = apexRemoteTarget(value['remoteClass']);
    if (target !== null) {
      apexCalls.push({
        target,
        remoteMethod: typeof value['remoteMethod'] === 'string' ? value['remoteMethod'] : null,
        site: 'dataSource',
        siteType: 'dataSource',
        objectArgs: literalObjectArgs(value),
      });
    }
  }
  const queryReads = buildQueryReads(cardId, dataSourceObj);
  rawEdges.push(...queryReads.edges);
  rawEdges.push(...buildApexRemoteEdges(cardId, apexCalls, EXTRACTOR_SOURCE));
  // FLEXCARD-LABEL-REFS-UNGRAPHED: a card names custom labels as `{Label.X}`
  // merge tokens (text, action URLs) anywhere in its definition JSON; none
  // reached the label, so "where is this label used" missed every card.
  for (const m of JSON.stringify(rootObj).matchAll(FLEXCARD_LABEL_TOKEN)) {
    if (m[1] === undefined) continue;
    rawEdges.push({
      fromId: cardId,
      toId: `CustomLabel:${m[1]}`,
      edgeType: 'references',
      confidence: 'parsed',
      source: EXTRACTOR_SOURCE,
      properties: { referenceKind: 'customLabel' },
    });
  }
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
      // OMIT-when-empty: SOQL relationship paths the graph import resolves.
      ...(queryReads.traversals.length > 0 ? { unresolvedTraversalRefs: queryReads.traversals } : {}),
    },
  };

  return ok({ nodes: [node], edges });
};
