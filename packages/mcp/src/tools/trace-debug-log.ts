/**
 * Handler for the `sfi.trace_debug_log` MCP tool — READ a pasted Apex debug log
 * as the EVENT STREAM it is, and project the four things a developer actually
 * opens a log to learn:
 *
 *   1. the execution TIMELINE (ordered, nested, with wall durations),
 *   2. WHERE THE TIME WENT (per code unit and per method, DB and callout wait
 *      subtracted so "CPU" means CPU),
 *   3. WHICH AUTOMATION FIRED and in what ORDER (triggers, validation rules,
 *      workflow rules, flow interviews, flow elements — as the log recorded
 *      them, not as an order-of-execution model predicts),
 *   4. CONSUMPTION BY PHASE plus the per-limit actual/allowed table the
 *      platform itself wrote into `CUMULATIVE_LIMIT_USAGE`.
 *
 * Where `sfi.explain_debug_log` answers "WHICH COMPONENT is this log about" by
 * resolving names to graph nodes, this answers "WHAT HAPPENED, in what order,
 * and what did it cost". The stream parsing is the shared primitive
 * `parseApexDebugLog` in `@sf-intelligence/parsers` — this module adds only the
 * projections and the vault resolution.
 *
 * ZERO ORG ACCESS. Input is pasted text; the only vault reads are node lookups
 * to turn a name in the log into a canonical component id. A log from an org
 * this vault has never seen still parses — every component simply reports
 * unresolved rather than being invented.
 *
 * THE HONESTY CONTRACT (each of these is structural, not a footnote):
 *
 *  - **Absent is not "did not happen".** A log records only the categories its
 *    DebugLevel enabled. `capture.notLogged[]` names every category set to
 *    NONE (or never declared) and the events that were therefore never
 *    written, so `automationOrder: []` under `WORKFLOW=NONE` reads as "not
 *    logged", never "nothing fired". Any consumer that reports an empty
 *    section without reading `capture.notLogged` is misreporting.
 *  - **Wall time is not CPU time.** The `(nanos)` column is elapsed time.
 *    `cpuEstimateMs` = wall minus SOQL/SOSL/DML/callout spans; it is
 *    `heuristic`, and the platform's own figure (`CPU time` in `limits[]`) is
 *    the DECLARED number when the log carries it.
 *  - **Salesforce record ids never resolve offline.** VERIFIED: the vault's
 *    Tooling enricher folds back only `{componentId, lastModifiedDate,
 *    lastModifiedBy, apiVersion}` — no durable ids. So a
 *    `CODE_UNIT_STARTED|[EXTERNAL]|Flow:301...` unit is reported
 *    `identity: 'unresolvable'` on ANY org after ANY refresh, and no refresh
 *    can change that. Flow identity therefore comes from
 *    `FLOW_START_INTERVIEW_BEGIN|1|<name>`, which is a MasterLabel and NOT an
 *    API name — matched to a `Flow:` node by exact label and typed
 *    `heuristic`, never `declared`.
 *  - **Logs truncate.** A skipped section or the 20 MB ceiling makes every
 *    count a floor; `truncation` says so and unpaired frames report a null
 *    duration rather than a guessed one.
 *  - **How logs are CREATED is out of scope, and says so.** TraceFlag,
 *    DebugLevel, monitored users and retention are Tooling-API / Setup state,
 *    not metadata: neither `TraceFlag` nor `DebugLevel` is a modeled
 *    ComponentType in this product. `logCreation` states that boundary and the
 *    platform rules verbatim instead of omitting half the question.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import {
  apexClassOfSignature,
  debugLogCoverage,
  descendantNanosByKind,
  frameSelfNanos,
  indexFrames,
  NON_CPU_FRAME_KINDS,
  parseApexDebugLog,
  type CodeUnitKind,
  type DebugLogCategory,
  type DebugLogFrame,
  type DebugLogLevel,
  type ParsedApexDebugLog,
} from '@sf-intelligence/parsers';
import { z } from 'zod';

import type { Context } from '../server.js';

import { mergeInputAliases } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

// ---------------------------------------------------------------------------
// Caps — every list is byte-budgeted, every cap is reported
// ---------------------------------------------------------------------------

/** Default number of timeline spans returned. */
const DEFAULT_TIMELINE_LIMIT = 60;
/** Longest span name kept on the timeline before it is elided. */
const MAX_SPAN_NAME = 200;
/** Longest string value kept inside a timeline span's `detail`. */
const MAX_DETAIL_STRING = 160;
/** Hard ceiling on timeline spans. */
const MAX_TIMELINE_LIMIT = 400;
/** Default maximum frame depth shown on the timeline. */
const DEFAULT_TIMELINE_DEPTH = 4;
/** Hot spots (exclusive-time leaders) returned. */
const MAX_HOT_SPOTS = 20;
/** Automation steps returned. */
const MAX_AUTOMATION_STEPS = 60;
/** Per-unit time-attribution rows returned. */
const MAX_ATTRIBUTION_ROWS = 25;
/** Slowest individual queries returned. */
/**
 * Ceiling on the aggregated limit table. Sorted most-consumed first, so this
 * trims the quietest metrics, never the one that blew. Anything dropped is
 * named in `boundaries[]` — a silent cap on this list is what let a 15.7x
 * understatement read as a complete answer.
 */
const MAX_LIMIT_ROWS = 60;

const MAX_SLOWEST = 10;
/** Distinct component names resolved against the graph. */
const MAX_RESOLUTIONS = 60;

/** Verbatim honesty disclosure, surfaced on every response. */
const TRACE_DEBUG_LOG_DISCLOSURE =
  "This READS a pasted Apex debug log as an event stream (timestamped `EVENT|payload` lines under a header declaring the per-category log LEVELS) and projects the timeline, time attribution, automation firing order, per-phase consumption, and the platform's own limit table. It is 100% OFFLINE — the pasted text is the only input; the vault is read solely to turn names into canonical component ids. THREE THINGS IT STRUCTURALLY CANNOT DO: (1) A log records ONLY the categories its DebugLevel enabled — every category at NONE (or undeclared) is listed in `capture.notLogged`, and an empty section for such a category means NOT LOGGED, never 'did not happen'. (2) The `(nanos)` column is WALL time, so `cpuEstimateMs` (wall minus the SOQL/SOSL/DML/callout spans inside a unit) is HEURISTIC; the DECLARED CPU figure is the `CPU time` row of `limits[]` when the log carried a CUMULATIVE_LIMIT_USAGE block. (3) Salesforce RECORD IDS never resolve offline — a `Flow:301...` code unit reports `identity: 'unresolvable'` on any org after any refresh; flow identity instead comes from FLOW_START_INTERVIEW_BEGIN, which carries a MasterLabel, matched by exact label and typed `heuristic`, never `declared`. A truncated log makes every count a FLOOR (`truncation`), and a span that never closed reports a null duration rather than a guessed one. How logs are CREATED (TraceFlag / DebugLevel / monitored users / retention) is NOT modeled by this product — `logCreation` states that boundary rather than omitting the question.";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const traceDebugLogInputBaseSchema = z.object({
  logText: z.string().min(1),
  /** Max timeline spans returned (default 60, max 400). */
  limit: z.number().int().min(1).max(MAX_TIMELINE_LIMIT).optional(),
  /** Max frame depth shown on the timeline (default 4). 0 = top level only. */
  maxDepth: z.number().int().min(0).max(50).optional(),
  /** Set false to omit the span-by-span timeline and keep only the rollups. */
  includeTimeline: z.boolean().optional(),
});

/**
 * `sfi.trace_debug_log` input. As with `sfi.explain_debug_log`, a host that
 * pasted a log naturally reaches for `debugLog` / `log` / `text` / `content`
 * instead of the canonical `logText`; those are merged before validation
 * (canonical wins) via the shared alias normalizer, so a paste under a guessed
 * key is not hard-failed. A call with NO log text still fails closed with the
 * named `logText: Required` `invalid-query`.
 */
export const traceDebugLogInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [
      { canonical: 'logText', aliases: ['debugLog', 'log', 'text', 'content'] },
    ]),
  traceDebugLogInputBaseSchema,
);

export type TraceDebugLogInput = z.infer<typeof traceDebugLogInputSchema>;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/**
 * How confidently a name in the log maps to a component in this vault. The last
 * two are DIFFERENT KINDS of "no id", and conflating them is the mistake this
 * product exists not to make:
 *   - `not-in-vault` — a real component type was looked up and this vault does
 *     not hold it. A refresh (or a wider retrieve scope) could close that.
 *   - `not-a-component` — the span is not a separate metadata component in ANY
 *     org (a flow ELEMENT lives inside its Flow's XML; a `WF_RULE_EVAL` header
 *     is an evaluation container). Nothing was looked up because there is
 *     nothing to look up, and no refresh will ever change that.
 *   - `unresolvable` — the log identifies it only by a Salesforce record id,
 *     which is never stored offline. Also unfixable by any refresh.
 */
export type LogIdentity =
  | 'declared'
  | 'heuristic'
  | 'not-in-vault'
  | 'not-a-component'
  | 'unresolvable'
  | 'ambiguous';

/** One category's capture status — the "absent means NOT LOGGED" surface. */
export interface CaptureCategory {
  readonly category: DebugLogCategory;
  readonly level: DebugLogLevel | null;
  readonly eventsSeen: number;
  readonly meaning: string;
}

/** One span on the execution timeline. */
export interface TimelineSpan {
  readonly order: number;
  readonly depth: number;
  readonly kind: string;
  readonly name: string;
  readonly startMs: number | null;
  readonly durationMs: number | null;
  /** Exclusive wall time — this span minus its children. */
  readonly selfMs: number | null;
  /** True when the span never closed (truncation, or a thrown exception). */
  readonly incomplete: boolean;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/** Where the time went, per code unit / interview / workflow evaluation. */
export interface UnitAttribution {
  readonly unit: string;
  readonly kind: string;
  readonly componentId: ComponentId | null;
  readonly identity: LogIdentity;
  readonly wallMs: number | null;
  readonly soqlMs: number;
  readonly dmlMs: number;
  readonly calloutMs: number;
  /** wall minus (soql + dml + callout). HEURISTIC — wall-derived, not platform CPU. */
  readonly cpuEstimateMs: number | null;
  readonly soqlCount: number;
  readonly dmlCount: number;
  readonly calloutCount: number;
  /** True when this unit, or a span inside it, never closed. */
  readonly incomplete: boolean;
}

/** A method / element that burned exclusive (non-DB, non-callout) wall time. */
export interface HotSpot {
  readonly name: string;
  readonly kind: string;
  readonly invocations: number;
  /** Sum of exclusive wall time across every invocation. */
  readonly selfMs: number;
  /** Share of the transaction's total elapsed wall time. */
  readonly pctOfElapsed: number | null;
  readonly componentId: ComponentId | null;
  readonly identity: LogIdentity;
}

/** One automation the log recorded, in firing order. */
export interface AutomationStep {
  readonly order: number;
  readonly kind:
    | 'apex-trigger'
    | 'flow-interview'
    | 'workflow-rule'
    | 'validation-rule'
    | 'apex-code-unit'
    | 'flow-code-unit'
    | 'other-code-unit';
  readonly name: string;
  readonly componentId: ComponentId | null;
  readonly identity: LogIdentity;
  readonly identityWhy: string;
  readonly startMs: number | null;
  readonly durationMs: number | null;
  readonly incomplete: boolean;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  /** For a flow interview: the elements it executed, in order. */
  readonly steps: readonly string[];
}

/** Consumption rolled up to a transaction phase. */
export interface PhaseConsumption {
  readonly phase: string;
  readonly unitCount: number;
  readonly wallMs: number;
  readonly cpuEstimateMs: number;
  readonly soqlCount: number;
  readonly soqlMs: number;
  readonly dmlCount: number;
  readonly dmlMs: number;
  readonly calloutCount: number;
  readonly calloutMs: number;
  readonly incomplete: boolean;
}

/** One `CUMULATIVE_LIMIT_USAGE` / `LIMIT_USAGE_FOR_NS` row. */
export interface LimitConsumption {
  readonly namespace: string;
  readonly metric: string;
  readonly used: number;
  readonly allowed: number;
  readonly pctUsed: number;
  readonly exceeded: boolean;
}

/** A name in the log and what happened when it was looked up in the vault. */
export interface LogComponentResolution {
  readonly nameInLog: string;
  readonly componentId: ComponentId | null;
  readonly type: ComponentType | null;
  readonly identity: LogIdentity;
  readonly why: string;
}

export interface TraceDebugLogOutput {
  readonly logShape: 'apex-debug-log' | 'not-a-debug-log';
  readonly capture: {
    readonly headerDeclared: boolean;
    readonly apiVersion: string | null;
    readonly levels: Readonly<Partial<Record<DebugLogCategory, DebugLogLevel>>>;
    /** Categories at NONE or never declared — their events were NOT written. */
    /** Categories the header set to NONE — their events were never written. */
    readonly notLogged: readonly CaptureCategory[];
    /**
     * Categories the header did not mention at all. Their capture is UNKNOWN —
     * this is NOT the same claim as `notLogged`, and an empty section for one
     * of these proves nothing in either direction.
     */
    readonly notDeclared: readonly CaptureCategory[];
    /**
     * Declared ABOVE NONE, but below the level some of their events need.
     * Levels are cumulative, so "not NONE" never meant "fully captured":
     * `WORKFLOW=INFO` writes flow interviews but NOT the FINE+ flow ELEMENTS.
     */
    readonly partiallyCaptured: readonly CaptureCategory[];
    readonly loggedCategories: readonly DebugLogCategory[];
    /**
     * `CATEGORY,LEVEL` pairs the header declared that this build does not
     * model. Their coverage is UNKNOWN — neither logged nor not-logged.
     */
    readonly unmodeledCategories: readonly string[];
  };
  readonly transaction: {
    readonly entryPoint: string | null;
    readonly entryPointKind: CodeUnitKind | null;
    /** True when no `execution` frame closed, so `elapsedMs` is the file span. */
    readonly elapsedIsFileSpan: boolean;
    /** Last-minus-first across every line, including any non-transaction prelude. */
    readonly fileSpanMs: number | null;
    readonly elapsedMs: number | null;
    readonly eventCount: number;
    readonly frameCount: number;
    readonly firstTimestamp: string | null;
    readonly lastTimestamp: string | null;
  };
  readonly timeline: readonly TimelineSpan[];
  readonly timelineTruncated: boolean;
  readonly timeAttribution: readonly UnitAttribution[];
  readonly hotSpots: readonly HotSpot[];
  readonly automationOrder: readonly AutomationStep[];
  readonly automationTruncated: boolean;
  readonly phases: readonly PhaseConsumption[];
  readonly database: {
    readonly soqlCount: number;
    readonly soqlMs: number;
    readonly soqlRows: number | null;
    readonly dmlCount: number;
    readonly dmlMs: number;
    readonly dmlRows: number | null;
    readonly calloutCount: number;
    readonly calloutMs: number;
    readonly slowestQueries: readonly {
      readonly query: string;
      readonly ms: number;
      readonly rows: number | null;
      readonly repeated: number;
    }[];
  };
  readonly limits: readonly LimitConsumption[];
  readonly limitsSource: string | null;
  readonly errors: readonly {
    readonly kind: string;
    readonly message: string;
    readonly atMs: number | null;
    readonly stack: readonly string[];
  }[];
  readonly truncation: {
    readonly truncated: boolean;
    readonly maximumSizeReached: boolean;
    readonly skippedBytes: number | null;
    readonly markers: readonly string[];
    readonly meaning: string | null;
  };
  readonly componentResolution: readonly LogComponentResolution[];
  readonly logCreation: {
    readonly modeledByThisProduct: false;
    readonly boundary: string;
    readonly platformRules: readonly string[];
  };
  readonly parseCaveats: readonly {
    readonly kind: string;
    readonly detail: string;
    readonly count: number;
  }[];
  /** Present ONLY when something in this answer is provably incomplete. */
  readonly coverageCaveat: string | null;
  readonly confidence: 'declared' | 'heuristic';
  readonly disclosure: string;
  readonly boundaries: readonly string[];
  readonly nextSteps: readonly string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const nsToMs = (n: number | null): number | null => (n === null ? null : round3(n / 1e6));

const msOf = (n: number): number => round3(n / 1e6);

/**
 * The transaction's entry point: the outermost `code-unit` frame. Null when
 * APEX_CODE was not logged — which means "not in this log", never "the
 * transaction had no entry point".
 */
const entryPointOf = (parsed: ParsedApexDebugLog): DebugLogFrame | null =>
  parsed.frames.find((f) => f.kind === 'code-unit') ?? null;

const elide = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

/**
 * Byte-trim a frame's `detail` for the timeline. `query` is dropped because the
 * span's `name` IS the query text — keeping both doubles the cost of the
 * largest field in a log and pushes the response onto the global size backstop
 * (which would then silently drop timeline rows). Nothing else is removed.
 */
const timelineDetail = (
  frame: DebugLogFrame,
): Readonly<Record<string, string | number | boolean | null>> => {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(frame.detail)) {
    if (k === 'query') continue;
    out[k] = typeof v === 'string' ? elide(v, MAX_DETAIL_STRING) : v;
  }
  return out;
};

/** Phase label for a top-level attributed frame. */
const phaseOf = (frame: DebugLogFrame): string => {
  if (frame.kind === 'validation-rule') return 'validation-rules';
  if (frame.kind === 'workflow-eval') return 'workflow-rules';
  if (frame.kind === 'flow-interview') return 'flows';
  if (frame.kind === 'code-unit') {
    const event = frame.detail['triggerEvent'];
    if (typeof event === 'string') {
      if (/^before/i.test(event)) return 'before-save-apex-triggers';
      if (/^after/i.test(event)) return 'after-save-apex-triggers';
      return `apex-triggers (${event})`;
    }
    if (frame.codeUnitKind === 'flow') return 'flows';
    if (frame.codeUnitKind === 'workflow') return 'workflow-rules';
    if (frame.codeUnitKind === 'validation') return 'validation-rules';
    return `apex (${frame.codeUnitKind ?? 'other'})`;
  }
  return 'other';
};

/** The frame kinds the phase / attribution rollups anchor on. */
const ATTRIBUTABLE_KINDS: ReadonlySet<string> = new Set([
  'code-unit',
  'flow-interview',
  'workflow-eval',
  'validation-rule',
]);

const AUTOMATION_KIND: Readonly<Record<string, AutomationStep['kind']>> = Object.freeze({
  'flow-interview': 'flow-interview',
  'workflow-eval': 'workflow-rule',
  'validation-rule': 'validation-rule',
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * The `sfi.trace_debug_log` MCP tool. Parses a pasted Apex debug log into an
 * ordered, depth-tracked event stream and returns the timeline, time
 * attribution, automation firing order, per-phase consumption, and the limit
 * table. See the module JSDoc for the honesty contract.
 *
 * @example
 *   const r = await traceDebugLogHandler(ctx, { logText: pasted });
 *   if (r.ok) {
 *     r.value.data.capture.notLogged;    // read FIRST — absence vs not-logged
 *     r.value.data.automationOrder;      // what fired, in order
 *     r.value.data.hotSpots[0]?.selfMs;  // where the time went
 *   }
 */
export const traceDebugLogHandler = async (
  ctx: Context,
  input: TraceDebugLogInput,
): Promise<Result<McpResponse<TraceDebugLogOutput>, McpError>> => {
  const parsed = parseApexDebugLog(input.logText);
  const byId = indexFrames(parsed.frames);
  const coverage = debugLogCoverage(parsed);
  const boundaries: string[] = [];
  const nextSteps: string[] = [];

  const asCapture = (c: (typeof coverage)[number]): CaptureCategory => ({
    category: c.category,
    level: c.level,
    eventsSeen: c.eventsSeen,
    meaning: c.meaning,
  });
  // `notLogged` means DELIBERATELY SILENCED — the header set the category to
  // NONE, so its events were definitively never written. A category the header
  // simply did not MENTION is a different claim: its capture is UNKNOWN, and
  // calling that "not captured" asserts something the log does not say. Real
  // headers routinely omit categories (NBA, WAVE, DATA_ACCESS), so conflating
  // the two filled the list with noise AND overstated what was known.
  const notLogged: CaptureCategory[] = coverage
    .filter((c) => c.level === 'NONE')
    .map(asCapture);
  const notDeclared: CaptureCategory[] = coverage
    .filter((c) => c.level === null && c.eventsGoverned.length > 0)
    .map(asCapture);
  // Declared above NONE but at a level too low for some of its events.
  const partiallyCaptured: CaptureCategory[] = coverage
    .filter((c) => c.logged && c.eventsBelowLevel.length > 0)
    .map(asCapture);
  const loggedCategories = coverage.filter((c) => c.logged).map((c) => c.category);

  // -------------------------------------------------------------------------
  // Component resolution. Names to canonical ids, each with its OWN identity
  // grade. Nothing is invented: a name absent from the vault says so.
  // -------------------------------------------------------------------------
  const resolutions: LogComponentResolution[] = [];
  const idFor = new Map<string, { readonly id: ComponentId; readonly identity: LogIdentity }>();
  const seenNames = new Set<string>();

  const resolveExact = async (
    nameInLog: string,
    id: ComponentId,
    kindLabel: string,
  ): Promise<Result<true, McpError>> => {
    if (seenNames.has(nameInLog) || resolutions.length >= MAX_RESOLUTIONS) return ok(true);
    seenNames.add(nameInLog);
    const nodeR = await getNodeById(ctx.graph, id);
    if (!nodeR.ok) return err({ kind: 'internal', message: nodeR.error.message });
    if (nodeR.value === null) {
      resolutions.push({
        nameInLog,
        componentId: null,
        type: null,
        identity: 'not-in-vault',
        why: await phantomAwareNotFoundMessage(ctx, id, kindLabel),
      });
      return ok(true);
    }
    idFor.set(nameInLog, { id: nodeR.value.id, identity: 'declared' });
    resolutions.push({
      nameInLog,
      componentId: nodeR.value.id,
      type: nodeR.value.type,
      identity: 'declared',
      why: `The log names this ${kindLabel} directly, and the vault holds a component with that exact API name.`,
    });
    return ok(true);
  };

  // Apex triggers and classes named by the stream.
  for (const frame of parsed.frames) {
    if (frame.kind === 'code-unit') {
      const trig = frame.detail['triggerName'] ?? frame.detail['triggerMarker'];
      if (typeof trig === 'string' && trig !== '') {
        const r = await resolveExact(trig, `ApexTrigger:${trig}` as ComponentId, 'ApexTrigger');
        if (!r.ok) return err(r.error);
      } else if (frame.codeUnitKind === 'apex-method') {
        const cls = apexClassOfSignature(frame.name);
        if (cls !== null) {
          const r = await resolveExact(cls, `ApexClass:${cls}` as ComponentId, 'ApexClass');
          if (!r.ok) return err(r.error);
        }
      }
    } else if (frame.kind === 'method' || frame.kind === 'constructor') {
      const cls = apexClassOfSignature(frame.name);
      if (cls !== null) {
        const r = await resolveExact(cls, `ApexClass:${cls}` as ComponentId, 'ApexClass');
        if (!r.ok) return err(r.error);
      }
    }
  }

  // Flow interviews. `FLOW_START_INTERVIEW_BEGIN|1|<name>` carries a
  // MasterLabel, NOT an API name, so this is an exact-LABEL match and stays
  // HEURISTIC even when it hits. Two flows may legitimately share a label.
  const interviewLabels = new Set(
    parsed.frames.filter((f) => f.kind === 'flow-interview' && f.name !== '').map((f) => f.name),
  );
  if (interviewLabels.size > 0) {
    const labelIndex = new Map<string, ComponentId[]>();
    const flowsR = await scanAllNodesOfTypes(ctx.graph, ['Flow']);
    if (!flowsR.ok) return err({ kind: 'internal', message: flowsR.error.message });
    for (const node of flowsR.value.nodes) {
      const key = (node.label ?? node.apiName).trim().toLowerCase();
      labelIndex.set(key, [...(labelIndex.get(key) ?? []), node.id]);
    }
    if (flowsR.value.scanIncomplete) {
      boundaries.push(
        `${fullScanTruncationNote(flowsR.value.incompleteTypes)} A flow beyond that cap reports not-in-vault even if it exists in this org.`,
      );
    }
    for (const label of interviewLabels) {
      if (seenNames.has(label) || resolutions.length >= MAX_RESOLUTIONS) continue;
      seenNames.add(label);
      const hits = labelIndex.get(label.trim().toLowerCase()) ?? [];
      const only = hits[0];
      if (hits.length === 1 && only !== undefined) {
        idFor.set(label, { id: only, identity: 'heuristic' });
        resolutions.push({
          nameInLog: label,
          componentId: only,
          type: 'Flow' as ComponentType,
          identity: 'heuristic',
          why: 'FLOW_START_INTERVIEW_BEGIN carries the flow MasterLabel, not its API name. This is an EXACT-LABEL match onto one Flow node — likely right, but a label is not a durable identifier; confirm the API name before acting.',
        });
      } else if (hits.length > 1) {
        resolutions.push({
          nameInLog: label,
          componentId: null,
          type: 'Flow' as ComponentType,
          identity: 'ambiguous',
          why: `${hits.length} Flow nodes share the MasterLabel "${label}" (${hits.slice(0, 4).join(', ')}). The log does not carry an API name, so which one ran is UNKNOWN offline.`,
        });
      } else {
        resolutions.push({
          nameInLog: label,
          componentId: null,
          type: 'Flow' as ComponentType,
          identity: 'not-in-vault',
          why: `No Flow in this vault carries the MasterLabel "${label}". The label may have been renamed since the refresh, the flow may be managed / not retrieved, or the log may come from a different org. Not fabricating a match.`,
        });
      }
    }
  }

  // Validation rules. `VALIDATION_RULE|<id>|<DeveloperName>` gives the rule's
  // developer name but NOT its object, while a component id is
  // `ValidationRule:{Object}.{Name}`. A unique suffix match supplies the missing
  // object, so the hit is HEURISTIC (the object was inferred, not logged); two
  // objects carrying the same rule name is `ambiguous`, never a coin flip.
  const ruleNames = new Set(
    parsed.frames.filter((f) => f.kind === 'validation-rule' && f.name !== '').map((f) => f.name),
  );
  // The objects this transaction's Apex triggers ran on. When the log names
  // EXACTLY ONE, it can disambiguate a rule developer name shared across
  // objects — still heuristic (a transaction can touch objects whose triggers
  // never logged), but strictly better than refusing. Two or more objects and
  // the answer stays `ambiguous` rather than picking one.
  const triggerObjects = new Set(
    parsed.frames
      .map((f) => f.detail['objectApiName'])
      .filter((o): o is string => typeof o === 'string' && o !== ''),
  );
  const soleObject = triggerObjects.size === 1 ? [...triggerObjects][0] : undefined;
  if (ruleNames.size > 0) {
    const bySuffix = new Map<string, ComponentId[]>();
    const rulesR = await scanAllNodesOfTypes(ctx.graph, ['ValidationRule']);
    if (!rulesR.ok) return err({ kind: 'internal', message: rulesR.error.message });
    for (const node of rulesR.value.nodes) {
      const short = (node.apiName.split('.').pop() ?? node.apiName).trim().toLowerCase();
      bySuffix.set(short, [...(bySuffix.get(short) ?? []), node.id]);
    }
    if (rulesR.value.scanIncomplete) {
      boundaries.push(
        `${fullScanTruncationNote(rulesR.value.incompleteTypes)} A rule beyond that cap reports not-in-vault even if it exists in this org.`,
      );
    }
    for (const name of ruleNames) {
      if (seenNames.has(name) || resolutions.length >= MAX_RESOLUTIONS) continue;
      seenNames.add(name);
      const hits = bySuffix.get(name.trim().toLowerCase()) ?? [];
      const only = hits[0];
      if (hits.length === 1 && only !== undefined) {
        idFor.set(name, { id: only, identity: 'heuristic' });
        resolutions.push({
          nameInLog: name,
          componentId: only,
          type: 'ValidationRule' as ComponentType,
          identity: 'heuristic',
          why: 'VALIDATION_RULE names the rule but not its object; the object was inferred from the one vault rule with this developer name. Confirm the object before acting.',
        });
      } else if (hits.length > 1) {
        const onObject =
          soleObject === undefined
            ? undefined
            : hits.find((h) => h.startsWith(`ValidationRule:${soleObject}.`));
        if (onObject !== undefined) {
          idFor.set(name, { id: onObject, identity: 'heuristic' });
          resolutions.push({
            nameInLog: name,
            componentId: onObject,
            type: 'ValidationRule' as ComponentType,
            identity: 'heuristic',
            why: `${hits.length} validation rules in this vault share the developer name "${name}" (${hits.slice(0, 4).join(', ')}). The log does not say which object, so this picked the one on ${soleObject} — the only object any Apex trigger in this log ran on. A rule on an object whose trigger did not log would be missed; confirm before acting.`,
          });
        } else {
          resolutions.push({
            nameInLog: name,
            componentId: null,
            type: 'ValidationRule' as ComponentType,
            identity: 'ambiguous',
            why: `${hits.length} validation rules in this vault share the developer name "${name}" (${hits.slice(0, 4).join(', ')}). The log does not say which object${soleObject === undefined && triggerObjects.size > 1 ? ` and this transaction touched ${triggerObjects.size} objects` : ''}, so which one ran is UNKNOWN offline.`,
          });
        }
      } else {
        resolutions.push({
          nameInLog: name,
          componentId: null,
          type: 'ValidationRule' as ComponentType,
          identity: 'not-in-vault',
          why: `No ValidationRule in this vault carries the developer name "${name}" — managed, not retrieved, renamed since the refresh, or from a different org. Not fabricating a match.`,
        });
      }
    }
  }

  // `CODE_UNIT_STARTED|[EXTERNAL]|Flow:301...` — a record id. VERIFIED
  // unresolvable: the Tooling enricher folds back no durable ids, so no
  // refresh on any org can ever make this resolve.
  for (const frame of parsed.frames) {
    if (frame.kind !== 'code-unit') continue;
    if (!/^(?:Flow|Workflow|Validation)[:.]/i.test(frame.name)) continue;
    if (seenNames.has(frame.name) || resolutions.length >= MAX_RESOLUTIONS) continue;
    seenNames.add(frame.name);
    resolutions.push({
      nameInLog: frame.name,
      componentId: null,
      type: null,
      identity: 'unresolvable',
      why: 'This code unit is identified in the log ONLY by a Salesforce record id. Record ids are never stored in the vault — the Tooling enricher folds back only { componentId, lastModifiedDate, lastModifiedBy, apiVersion } — so the identity is unresolvable offline on any org after any refresh. This is NOT a coverage gap a refresh can close.',
    });
  }

  // A name NEVER looked up is `not-a-component`, not `not-in-vault`: reporting a
  // flow element as absent-from-the-vault would invent a coverage gap that no
  // refresh can close, which is precisely the conflation this product forbids.
  const identityOf = (name: string): { readonly id: ComponentId | null; readonly identity: LogIdentity } => {
    const hit = idFor.get(name);
    if (hit !== undefined) return { id: hit.id, identity: hit.identity };
    const res = resolutions.find((r) => r.nameInLog === name);
    return { id: null, identity: res?.identity ?? 'not-a-component' };
  };

  // -------------------------------------------------------------------------
  // Timeline
  // -------------------------------------------------------------------------
  const timelineLimit = input.limit ?? DEFAULT_TIMELINE_LIMIT;
  const maxDepth = input.maxDepth ?? DEFAULT_TIMELINE_DEPTH;
  const includeTimeline = input.includeTimeline ?? true;
  const eligible = parsed.frames.filter((f) => f.depth <= maxDepth);
  const timeline: TimelineSpan[] = includeTimeline
    ? eligible.slice(0, timelineLimit).map((f, i) => ({
        order: i + 1,
        depth: f.depth,
        kind: f.kind,
        name: elide(f.name, MAX_SPAN_NAME),
        startMs:
          f.startNanos === null || parsed.firstNanos === null
            ? null
            : msOf(f.startNanos - parsed.firstNanos),
        durationMs: nsToMs(f.durationNanos),
        selfMs: nsToMs(frameSelfNanos(f, byId)),
        incomplete: f.unpaired,
        detail: timelineDetail(f),
      }))
    : [];
  const timelineTruncated = includeTimeline && eligible.length > timelineLimit;

  // -------------------------------------------------------------------------
  // Attribution and phases. A frame is attributed only when NO ancestor was,
  // so a flow inside an after-trigger stays inside that trigger's wall time
  // and is never double counted.
  // -------------------------------------------------------------------------
  const attributedIds = new Set<number>();
  const hasAttributedAncestor = (frame: DebugLogFrame): boolean => {
    let cursor = frame.parentId;
    while (cursor !== null) {
      if (attributedIds.has(cursor)) return true;
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return false;
  };

  const attribution: UnitAttribution[] = [];
  const phaseAcc = new Map<string, PhaseConsumption>();
  for (const frame of parsed.frames) {
    if (!ATTRIBUTABLE_KINDS.has(frame.kind)) continue;
    if (hasAttributedAncestor(frame)) continue;
    attributedIds.add(frame.id);

    const soql = descendantNanosByKind(frame, byId, ['soql', 'sosl']);
    const dml = descendantNanosByKind(frame, byId, ['dml']);
    const callout = descendantNanosByKind(frame, byId, ['callout']);
    const wallMs = nsToMs(frame.durationNanos);
    const nonCpuMs = msOf(soql.nanos + dml.nanos + callout.nanos);
    const cpuEstimateMs = wallMs === null ? null : Math.max(0, round3(wallMs - nonCpuMs));
    const incomplete =
      frame.unpaired ||
      soql.unpairedCount > 0 ||
      dml.unpairedCount > 0 ||
      callout.unpairedCount > 0;
    const ident = identityOf(
      typeof frame.detail['triggerName'] === 'string'
        ? frame.detail['triggerName']
        : frame.name,
    );

    if (attribution.length < MAX_ATTRIBUTION_ROWS) {
      attribution.push({
        unit: frame.name,
        kind: frame.kind,
        componentId: ident.id,
        identity: ident.identity,
        wallMs,
        soqlMs: msOf(soql.nanos),
        dmlMs: msOf(dml.nanos),
        calloutMs: msOf(callout.nanos),
        cpuEstimateMs,
        soqlCount: soql.count,
        dmlCount: dml.count,
        calloutCount: callout.count,
        incomplete,
      });
    }

    const phase = phaseOf(frame);
    const prev = phaseAcc.get(phase);
    phaseAcc.set(phase, {
      phase,
      unitCount: (prev?.unitCount ?? 0) + 1,
      wallMs: round3((prev?.wallMs ?? 0) + (wallMs ?? 0)),
      cpuEstimateMs: round3((prev?.cpuEstimateMs ?? 0) + (cpuEstimateMs ?? 0)),
      soqlCount: (prev?.soqlCount ?? 0) + soql.count,
      soqlMs: round3((prev?.soqlMs ?? 0) + msOf(soql.nanos)),
      dmlCount: (prev?.dmlCount ?? 0) + dml.count,
      dmlMs: round3((prev?.dmlMs ?? 0) + msOf(dml.nanos)),
      calloutCount: (prev?.calloutCount ?? 0) + callout.count,
      calloutMs: round3((prev?.calloutMs ?? 0) + msOf(callout.nanos)),
      incomplete: (prev?.incomplete ?? false) || incomplete,
    });
  }
  attribution.sort((a, b) => (b.wallMs ?? -1) - (a.wallMs ?? -1));
  const phases = [...phaseAcc.values()].sort((a, b) => b.wallMs - a.wallMs);

  // -------------------------------------------------------------------------
  // Hot spots — exclusive wall time by name. SOQL/DML/callout spans are their
  // own frames, so their time never lands on a caller's self time; they are
  // reported in `database` instead of competing for the CPU leaderboard.
  // -------------------------------------------------------------------------
  const hotAcc = new Map<
    string,
    { readonly kind: string; readonly name: string; invocations: number; selfNanos: number }
  >();
  for (const frame of parsed.frames) {
    if ((NON_CPU_FRAME_KINDS as readonly string[]).includes(frame.kind)) continue;
    if (frame.kind === 'execution') continue;
    const self = frameSelfNanos(frame, byId);
    if (self === null) continue;
    const key = `${frame.kind}\u001f${frame.name}`;
    const prev = hotAcc.get(key);
    hotAcc.set(key, {
      kind: frame.kind,
      name: frame.name,
      invocations: (prev?.invocations ?? 0) + 1,
      selfNanos: (prev?.selfNanos ?? 0) + self,
    });
  }
  const hotSpots: HotSpot[] = [...hotAcc.values()]
    .map((v) => {
      const cls =
        v.kind === 'method' || v.kind === 'constructor' ? apexClassOfSignature(v.name) : null;
      const ident = identityOf(cls ?? v.name);
      return {
        name: elide(v.name, MAX_SPAN_NAME),
        kind: v.kind,
        invocations: v.invocations,
        selfMs: msOf(v.selfNanos),
        pctOfElapsed:
          parsed.elapsedNanos === null || parsed.elapsedNanos === 0
            ? null
            : Math.round((v.selfNanos / parsed.elapsedNanos) * 1000) / 10,
        componentId: ident.id,
        identity: ident.identity,
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, MAX_HOT_SPOTS);

  // -------------------------------------------------------------------------
  // Automation firing order — every automation frame, in stream order.
  // -------------------------------------------------------------------------
  const automationFrames = parsed.frames.filter(
    (f) =>
      f.kind === 'flow-interview' ||
      f.kind === 'workflow-eval' ||
      f.kind === 'validation-rule' ||
      f.kind === 'code-unit',
  );
  const automationOrder: AutomationStep[] = automationFrames
    .slice(0, MAX_AUTOMATION_STEPS)
    .map((f, i) => {
      const trig =
        typeof f.detail['triggerName'] === 'string' ? f.detail['triggerName'] : null;
      const ident = identityOf(trig ?? f.name);
      const kind: AutomationStep['kind'] =
        AUTOMATION_KIND[f.kind] ??
        (trig !== null
          ? 'apex-trigger'
          : f.codeUnitKind === 'flow'
            ? 'flow-code-unit'
            : f.codeUnitKind === 'apex-method' || f.codeUnitKind === 'anonymous'
              ? 'apex-code-unit'
              : 'other-code-unit');
      const steps =
        f.kind === 'flow-interview'
          ? f.childIds
              .map((cid) => byId.get(cid))
              .filter((c): c is DebugLogFrame => c !== undefined && c.kind === 'flow-element')
              .map((c) => `${String(c.detail['elementType'] ?? 'FlowElement')}: ${c.name}`)
          : [];
      const why =
        ident.identity === 'declared'
          ? 'Named in the log and present in this vault under that exact API name.'
          : ident.identity === 'heuristic'
            ? 'Matched by MasterLabel — the log does not carry the flow API name. Likely, not certain.'
            : ident.identity === 'unresolvable'
              ? 'Identified in the log only by a Salesforce record id, which never resolves offline on any org.'
              : ident.identity === 'ambiguous'
                ? 'Several vault components share this label, so which one ran is unknown offline.'
                : ident.identity === 'not-a-component'
                  ? 'Not a separate metadata component in ANY org (a flow element lives inside its Flow, a WF_RULE_EVAL header is an evaluation container), so there is nothing to resolve — this is not a coverage gap a refresh can close.'
                  : 'Named in the log but absent from this vault (managed / not retrieved / renamed). Not fabricating a match.';
      return {
        order: i + 1,
        kind,
        name: elide(f.name, MAX_SPAN_NAME),
        componentId: ident.id,
        identity: ident.identity,
        identityWhy: why,
        startMs:
          f.startNanos === null || parsed.firstNanos === null
            ? null
            : msOf(f.startNanos - parsed.firstNanos),
        durationMs: nsToMs(f.durationNanos),
        incomplete: f.unpaired,
        detail: f.detail,
        steps,
      };
    });

  // -------------------------------------------------------------------------
  // Database and callouts
  // -------------------------------------------------------------------------
  const soqlFrames = parsed.frames.filter((f) => f.kind === 'soql' || f.kind === 'sosl');
  const dmlFrames = parsed.frames.filter((f) => f.kind === 'dml');
  const calloutFrames = parsed.frames.filter((f) => f.kind === 'callout');
  const sumNanos = (fs: readonly DebugLogFrame[]): number =>
    fs.reduce((n, f) => n + (f.durationNanos ?? 0), 0);
  const sumRows = (fs: readonly DebugLogFrame[]): number | null => {
    let total = 0;
    let any = false;
    for (const f of fs) {
      const r = f.detail['rows'];
      if (typeof r === 'number') {
        total += r;
        any = true;
      }
    }
    return any ? total : null;
  };
  const queryAcc = new Map<
    string,
    { ms: number; rows: number | null; repeated: number }
  >();
  for (const f of soqlFrames) {
    const prev = queryAcc.get(f.name);
    const rows = typeof f.detail['rows'] === 'number' ? f.detail['rows'] : null;
    queryAcc.set(f.name, {
      ms: (prev?.ms ?? 0) + (f.durationNanos === null ? 0 : msOf(f.durationNanos)),
      rows: rows === null ? (prev?.rows ?? null) : (prev?.rows ?? 0) + rows,
      repeated: (prev?.repeated ?? 0) + 1,
    });
  }
  const slowestQueries = [...queryAcc.entries()]
    .map(([query, v]) => ({
      query: query.length > 400 ? `${query.slice(0, 400)}...` : query,
      ms: round3(v.ms),
      rows: v.rows,
      repeated: v.repeated,
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, MAX_SLOWEST);

  // -------------------------------------------------------------------------
  // Limits
  // -------------------------------------------------------------------------
  // PEAK per (namespace, metric), not one row per snapshot. A transaction
  // writes a CUMULATIVE_LIMIT_USAGE block at the end of MANY code units, so a
  // real 1 MB log produced 2,418 rows across 52 blocks and 4 namespaces — a
  // 312 KB payload against a 45 KB budget. The global guard then tail-trimmed
  // it to the FIRST 10 rows: the snapshot nearest the START of the
  // transaction, i.e. the least useful reading, while this tool's own
  // `truncation` still reported a clean answer. Measured consequence: peak CPU
  // 2,100/10,000 (21%) reported as 134 (1.3%), a 15.7x understatement, with
  // three of four namespaces vanishing entirely. Consumption is monotonic
  // within a transaction, so the PEAK is the answer to "what did this
  // transaction consume".
  const peakByKey = new Map<string, (typeof parsed.limits)[number]>();
  for (const l of parsed.limits) {
    const key = `${l.namespace}\u0000${l.metric}`;
    const prev = peakByKey.get(key);
    if (prev === undefined || l.used > prev.used) peakByKey.set(key, l);
  }
  const allLimits: LimitConsumption[] = [...peakByKey.values()]
    .map((l) => ({
      namespace: l.namespace,
      metric: l.metric,
      used: l.used,
      allowed: l.allowed,
      pctUsed: l.allowed === 0 ? 0 : Math.round((l.used / l.allowed) * 1000) / 10,
      exceeded: l.exceeded,
    }))
    // Most-consumed first, so a cap can never hide the limit that matters.
    .sort((a, b) => b.pctUsed - a.pctUsed || b.used - a.used);
  const limits: LimitConsumption[] = allLimits.slice(0, MAX_LIMIT_ROWS);
  const limitRowsDropped = allLimits.length - limits.length;
  const limitSnapshotCount = parsed.limits.length;
  const limitsSource = parsed.limits[0]?.source ?? null;

  // -------------------------------------------------------------------------
  // Boundaries, caveats, next steps
  // -------------------------------------------------------------------------
  const entry = entryPointOf(parsed);
  // The TRANSACTION's own frame — the basis for elapsed time, and the way to
  // tell a log with no transaction body from one whose transaction did nothing.
  const executionFrame = parsed.frames.find((f) => f.kind === 'execution');

  if (!parsed.isDebugLog) {
    boundaries.push(
      'No timestamped `HH:MM:SS.mmm (nanos)|EVENT|...` lines were found, so this text is not an Apex debug-log event stream. A bare stack trace or error banner belongs to sfi.explain_debug_log / sfi.explain_error, which decode a NAME back to a component.',
    );
    nextSteps.push(
      'If you have the full log, paste it including the header line (`57.0 APEX_CODE,FINE;...`) and the timestamped event lines.',
    );
    nextSteps.push(
      'sfi.explain_debug_log decodes a bare stack trace or a governor-limit exception.',
    );
  }

  if (notLogged.length > 0) {
    boundaries.push(
      `NOT LOGGED in this transaction: ${notLogged.map((c) => `${c.category}=NONE`).join(', ')}. ` +
        'Any section of this answer that is empty for one of those categories means the events were NEVER WRITTEN — not that nothing of that kind happened. Re-run with the category above NONE to see it.',
    );
  }
  if (partiallyCaptured.length > 0) {
    boundaries.push(
      `PARTIALLY captured: ${partiallyCaptured.map((c) => `${c.category}=${c.level ?? '?'}`).join(', ')}. ` +
        'Debug levels are CUMULATIVE, so a category above NONE can still be too low to write some of its events — WORKFLOW=INFO records that a flow ran but NOT its individual elements, and APEX_CODE=DEBUG (the default for Apex tests) records no METHOD_ENTRY at all. Read each category\'s `meaning` for exactly which event types were skipped: anything empty for them is NOT CAPTURED, never "did not happen".',
    );
  }
  if (notDeclared.length > 0) {
    boundaries.push(
      `NOT DECLARED by this log's header: ${notDeclared.map((c) => c.category).join(', ')}. ` +
        'The header did not mention these at all, so whether their events would have been written is UNKNOWN — this is weaker than NOT LOGGED, and an empty section for one of them proves nothing either way.',
    );
  }
  if (parsed.truncation.truncated) {
    boundaries.push(
      'This log is TRUNCATED (the platform skipped a section, or hit the 20 MB ceiling). Every count, duration and ordering here is a FLOOR over the surviving text, not the whole transaction.',
    );
  }
  if (attribution.some((a) => a.cpuEstimateMs !== null)) {
    boundaries.push(
      "cpuEstimateMs is HEURISTIC: it is WALL time (the log's nanosecond column) minus the SOQL/SOSL/DML/callout spans inside the unit. It is not the platform's CPU accounting — the DECLARED figure is the `CPU time` row of `limits[]` when the log carried a CUMULATIVE_LIMIT_USAGE block.",
    );
  }
  if (parsed.frames.some((f) => f.unpaired)) {
    boundaries.push(
      "Some spans never closed (truncation, or the transaction died inside them). Their duration is reported null rather than inferred, so a parent's selfMs OVERSTATES its own cost by the unknown child time.",
    );
  }
  if (resolutions.some((r) => r.identity === 'heuristic')) {
    boundaries.push(
      'Flow identity is HEURISTIC: FLOW_START_INTERVIEW_BEGIN carries the flow MasterLabel, not its API name, so a flow is matched by exact label. A renamed label, or two flows sharing one, breaks that match — confirm the API name before acting.',
    );
  }
  if (resolutions.some((r) => r.identity === 'unresolvable')) {
    boundaries.push(
      'One or more code units are identified in the log ONLY by a Salesforce record id. Record ids are never stored in the vault, so those identities are unresolvable OFFLINE ON ANY ORG — this is not a coverage gap a refresh can close.',
    );
  }
  // A log with no execution unit has no transaction to describe. Every empty
  // section below would otherwise read as "nothing fired" — measured on 4 of
  // 18 real logs, which are a header plus a single USER_INFO line.
  if (parsed.isDebugLog && executionFrame === undefined) {
    boundaries.push(
      'This log contains NO execution unit (no EXECUTION_STARTED/CODE_UNIT_STARTED pair), so there is no transaction body here to analyse. Every empty section below means NOTHING WAS CAPTURED, not that nothing ran — the trace flag was probably active without the transaction being logged, or only the header survived the paste.',
    );
    nextSteps.push(
      'Check the log length in Setup > Debug Logs: a log of a few hundred bytes carries a header and little else. Re-run the operation with an active trace flag to capture the transaction.',
    );
  }

  // The parser's structural caveats are honesty signals, not diagnostics — a
  // mis-paired or unbounded stream makes the numbers below wrong, and that has
  // to be said HERE rather than left in a field nothing reads.
  for (const caveat of parsed.parseCaveats) {
    if (
      caveat.kind === 'orphan-close' ||
      caveat.kind === 'close-name-mismatch' ||
      caveat.kind === 'negative-duration' ||
      caveat.kind === 'event-cap-reached'
    ) {
      boundaries.push(
        `LOG STRUCTURE (${caveat.kind}): ${caveat.detail} Durations and the hot-spot ranking below are affected — treat them as a FLOOR, not a measurement.`,
      );
    }
  }

  if (limitRowsDropped > 0) {
    boundaries.push(
      `The limit table was aggregated to the PEAK per namespace+metric across ${limitSnapshotCount.toLocaleString('en-US')} snapshot row(s), and the ${limitRowsDropped.toLocaleString('en-US')} least-consumed metric(s) were then dropped to fit. Rows are sorted most-consumed first, so nothing that approached its ceiling is hidden.`,
    );
  }

  if (parsed.header.unrecognizedCategories.length > 0) {
    boundaries.push(
      `The header declares ${parsed.header.unrecognizedCategories.length} category this build does NOT model (${parsed.header.unrecognizedCategories.join(', ')}). Its events are neither counted nor listed above, and nothing here can be read as evidence about it either way.`,
    );
  }

  if (limits.length === 0 && parsed.isDebugLog) {
    const profiling = coverage.find((c) => c.category === 'APEX_PROFILING');
    boundaries.push(
      profiling !== undefined && !profiling.logged
        ? `No limit table here: APEX_PROFILING=${profiling.level ?? 'undeclared'}, so CUMULATIVE_LIMIT_USAGE was NOT LOGGED. That is not "nothing was consumed".`
        : (parsed.eventCounts['CUMULATIVE_LIMIT_USAGE'] ?? 0) > 0
          ? 'A CUMULATIVE_LIMIT_USAGE block IS present but carries no LIMIT_USAGE_FOR_NS rows, so this transaction reported no per-namespace consumption. That is a reading of the block, not "nothing was consumed".'
          : 'No CUMULATIVE_LIMIT_USAGE block is present in the pasted text — the limit table may have been trimmed off the paste rather than absent from the run.',
    );
  }

  const coverageCaveat =
    notLogged.length > 0 ||
    partiallyCaptured.length > 0 ||
    parsed.truncation.truncated ||
    !parsed.header.declared
      ? [
          !parsed.header.declared
            ? 'This log carries no header line, so which categories were captured is UNKNOWN — no empty section below can be read as "nothing happened".'
            : null,
          notLogged.length > 0
            ? `${notLogged.length} DebugLevel categor${notLogged.length === 1 ? 'y was' : 'ies were'} set to NONE (${notLogged.map((c) => c.category).join(', ')}); their events were never written.`
            : null,
          partiallyCaptured.length > 0
            ? `${partiallyCaptured.length} categor${partiallyCaptured.length === 1 ? 'y was' : 'ies were'} captured only PARTIALLY (${partiallyCaptured.map((c) => `${c.category}=${c.level ?? '?'}`).join(', ')}) — the level was too low for some of their event types, so sections that are empty for those events were NOT CAPTURED.`
            : null,
          parsed.truncation.truncated
            ? `The platform truncated this log${parsed.truncation.skippedBytes !== null ? ` (${parsed.truncation.skippedBytes.toLocaleString('en-US')} bytes skipped)` : ''}, so counts and orderings are floors.`
            : null,
        ]
          .filter((s): s is string => s !== null)
          .join(' ')
      : null;

  if (parsed.isDebugLog) {
    nextSteps.push(
      'sfi.explain_debug_log cross-references the SAME log against the static governor_limit_risks scan to name the soql/dml-in-loop finding behind a fired limit.',
    );
    const firstTriggerObject = automationOrder.find(
      (s) => s.kind === 'apex-trigger' && typeof s.detail['objectApiName'] === 'string',
    )?.detail['objectApiName'];
    if (typeof firstTriggerObject === 'string') {
      nextSteps.push(
        `sfi.what_happens_on_save on CustomObject:${firstTriggerObject} enumerates every trigger/flow DECLARED on that object, so you can compare what should fire with what this log shows firing.`,
      );
    }
    const topHot = hotSpots[0];
    if (topHot !== undefined && topHot.componentId !== null) {
      nextSteps.push(
        `sfi.explain_apex_method / sfi.call_graph on ${topHot.componentId} shows the code behind the biggest exclusive-time consumer in this log.`,
      );
    }
  }

  const output: TraceDebugLogOutput = {
    logShape: parsed.isDebugLog ? 'apex-debug-log' : 'not-a-debug-log',
    capture: {
      headerDeclared: parsed.header.declared,
      apiVersion: parsed.header.apiVersion,
      levels: parsed.header.levels,
      notLogged,
      notDeclared,
      partiallyCaptured,
      loggedCategories,
      // Categories the header DECLARED that this build does not model.
      // `DATA_ACCESS` appears in every header of a real org sample, and was
      // being dropped silently — a tool whose contract is "absent is not
      // did-not-happen" cannot discard a category the user's own header names.
      unmodeledCategories: parsed.header.unrecognizedCategories,
    },
    transaction: {
      entryPoint: entry?.name ?? null,
      entryPointKind: entry?.codeUnitKind ?? null,
      // The TRANSACTION's own span, from the `execution` frame — NOT the
      // whole pasted file. `parsed.elapsedNanos` is last-minus-first across
      // every line, and real logs carry a long pre-EXECUTION_STARTED prelude:
      // measured on a real 247 KB log, 2,956 ms of a 2,990 ms file span sat
      // BEFORE the transaction began, so this reported 2,990 ms for a
      // transaction that ran 34.4 ms — an 87x overstatement of the single
      // number this tool exists to produce, which `pctOfElapsed` then divides
      // by. `fileSpanMs` keeps the old figure, named for what it is.
      elapsedMs: nsToMs(executionFrame?.durationNanos ?? parsed.elapsedNanos),
      elapsedIsFileSpan: executionFrame?.durationNanos === undefined || executionFrame.durationNanos === null,
      fileSpanMs: nsToMs(parsed.elapsedNanos),
      eventCount: parsed.events.length,
      frameCount: parsed.frames.length,
      firstTimestamp: parsed.events[0]?.timestamp ?? null,
      lastTimestamp: parsed.events[parsed.events.length - 1]?.timestamp ?? null,
    },
    timeline,
    timelineTruncated,
    timeAttribution: attribution,
    hotSpots,
    automationOrder,
    automationTruncated: automationFrames.length > MAX_AUTOMATION_STEPS,
    phases,
    database: {
      soqlCount: soqlFrames.length,
      soqlMs: msOf(sumNanos(soqlFrames)),
      soqlRows: sumRows(soqlFrames),
      dmlCount: dmlFrames.length,
      dmlMs: msOf(sumNanos(dmlFrames)),
      dmlRows: sumRows(dmlFrames),
      calloutCount: calloutFrames.length,
      calloutMs: msOf(sumNanos(calloutFrames)),
      slowestQueries,
    },
    limits,
    limitsSource,
    errors: parsed.errors.map((e) => ({
      kind: e.kind,
      message: e.message,
      atMs:
        e.nanos === null || parsed.firstNanos === null ? null : msOf(e.nanos - parsed.firstNanos),
      stack: e.stack,
    })),
    truncation: {
      truncated: parsed.truncation.truncated,
      maximumSizeReached: parsed.truncation.maximumSizeReached,
      skippedBytes: parsed.truncation.skippedBytes,
      markers: parsed.truncation.markers,
      meaning: parsed.truncation.truncated
        ? 'The platform stopped writing, or dropped a section of, this log. Counts, durations and firing order are FLOORS over the surviving text — a component that fired inside the skipped region is simply not here.'
        : null,
    },
    componentResolution: resolutions,
    logCreation: {
      modeledByThisProduct: false,
      boundary:
        'HOW debug logs are created is NOT modeled by this product and cannot be read from this vault. A log is written only while a TraceFlag is active for a traced entity, pointing at a DebugLevel that sets the per-category levels. TraceFlag and DebugLevel are Tooling-API / Setup state, and neither is a ComponentType this product extracts (verified: neither name appears in the modeled type set). So which users are monitored, which trace flags are active, when they expire, and which logs exist in the org are ALL unknown here — this tool reads only the log text you paste.',
      platformRules: [
        'A debug log is produced only while a TraceFlag is ACTIVE for the entity that ran; TracedEntityType is one of USER, APEX_CLASS, APEX_TRIGGER, AUTOMATED_PROCESS or PLATFORM_INTEGRATION. No active trace flag means no log at all — not an empty log.',
        'The TraceFlag points at a DebugLevel, which sets the level (NONE through FINEST) for each of the ten categories: APEX_CODE, APEX_PROFILING, CALLOUT, DB, NBA, SYSTEM, VALIDATION, VISUALFORCE, WAVE, WORKFLOW. `capture.levels` above is the level set that was in force for THIS log.',
        'User trace flags are time-boxed — Setup > Debug Logs > Monitored Users sets a start and an expiration, and a user trace flag expires within 24 hours of its start. An expired trace flag silently stops producing logs.',
        'A single log is capped at 20 MB; past that the platform drops part of the log and marks it, which is what `truncation` above reports.',
        'Retained logs are capped per org (Salesforce documents a rolling allocation, oldest overwritten) and monitoring debug logs are retained for 7 days, so a log you cannot find may simply have aged out.',
        'These are PLATFORM rules quoted for orientation — they are NOT readings from your org. Verify trace flags, monitored users and retention in Setup or via the Tooling API; this product cannot confirm any of them.',
      ],
    },
    parseCaveats: parsed.parseCaveats.map((c) => ({
      kind: c.kind,
      detail: c.detail,
      count: c.count,
    })),
    coverageCaveat,
    confidence: 'heuristic',
    disclosure: TRACE_DEBUG_LOG_DISCLOSURE,
    boundaries,
    nextSteps,
  };

  return ok({
    data: output,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
