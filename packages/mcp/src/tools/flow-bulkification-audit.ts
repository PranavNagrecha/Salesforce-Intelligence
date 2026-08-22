/**
 * Handler for the `sfi.flow_bulkification_audit` MCP tool.
 *
 * Ports `sfi.governor_limit_risks`' proven "DML / SOQL inside a loop" concept
 * from Apex to FLOWS, where the Apex-only governor scan is blind (its
 * `SCANNED_TYPES` are `ApexClass` / `ApexTrigger` only). A record-triggered or
 * autolaunched Flow that performs a record Create / Update / Delete — or a Get
 * Records lookup — INSIDE a Loop body runs one DML / one SOQL per iteration, the
 * classic bulkification anti-pattern that trips the per-transaction DML (150) /
 * SOQL (100) governor limits at scale. This tool walks each Flow's DECLARED
 * connector graph and flags:
 *
 *   - `dml-in-loop`            — a Create / Update / Delete element whose canvas
 *     name sits inside a Loop's body (reachable from `nextValueConnector`
 *     before control returns to the loop / exits via `noMoreValuesConnector`).
 *     One DML per iteration. HIGH severity.
 *   - `get-records-in-loop`    — a Get Records (lookup) element inside a Loop
 *     body. One SOQL per iteration. HIGH severity.
 *   - `filterless-get-records` — a Get Records (lookup) ANYWHERE with no filter
 *     / where clause: an unbounded query smell. MEDIUM severity.
 *   - `subflow-in-loop`          — a Subflow element inside a Loop body. The
 *     called flow runs once per iteration and whatever DML / SOQL IT performs is
 *     multiplied by the iteration count. MEDIUM severity, because the callee's
 *     body is a DIFFERENT flow and is NOT opened here — the per-iteration
 *     invocation is proven, the DML inside it is not.
 *   - `action-in-loop`           — an `<actionCalls>` element (invocable Apex,
 *     email, platform action) inside a Loop body. Same shape, same reason: one
 *     invocation per iteration, callee body not modeled at all. MEDIUM.
 *
 * BULKIFICATION-AUDIT-RECORDOPS-ONLY. The detector used to iterate
 * `projection.recordOps` and NOTHING else, so a `Loop -> Subflow(DML)` or
 * `Loop -> Action(Apex DML)` flow — the most common real-world bulkification
 * bug — returned zero risks and read as clean. The two rules above close the
 * detection half. The `loopBodyCoverage` census closes the other half: every
 * response now states how many loop bodies were walked and how many held a
 * subflow, an action, or a canvas element type the projection does not model,
 * so a ZERO is a measured zero rather than an unexamined one.
 *
 * The detection is factored into a PURE function
 * ({@link detectFlowBulkificationRisks}) that takes a parsed
 * {@link FlowGraphProjection} and returns the risks — so it is unit-testable
 * with hand-built synthetic projections, no vault required. The handler is the
 * thin MCP wrapper: it iterates every `Flow` node, reads + projects the
 * `.flow-meta.xml` ON DEMAND (the `flow_graph` read-source-on-demand pattern —
 * nothing persisted), runs the pure detector, aggregates, and pages the output.
 *
 * Honesty spine:
 *   - **Confidence is `declared`, NOT `heuristic`.** The connector graph is
 *     declared metadata (unlike the Apex governor scan's heuristic recognizers),
 *     so loop-body membership is structural fact, not a guess. The trust block
 *     is an `offlineTrust` snapshot.
 *   - **"iteration count unknown at rest."** A Loop may run 0 or many times, so
 *     a DML/Get inside it is a STATIC Flow-SHAPE smell, not a proven runtime
 *     governor-limit breach. This is the verbatim boundary — the tool does NOT
 *     claim "conditions not evaluated" (that is `flow_trace`'s caveat, and the
 *     wrong one here).
 *   - **A Flow whose source is missing / unparseable is a NAMED blind spot**
 *     (`soundness.blindSpots`, kind `unparsed-flow`) — never silently dropped,
 *     so an empty finding list is honest about what it could not read.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import type {
  Connector,
  FlowGraphProjection,
  Loop,
  RecordOp,
} from '@sf-intelligence/extractors';
import { parseFlowGraphSource } from '@sf-intelligence/extractors';
import { z } from 'zod';

import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';
// The activation-status boundary + the two status readers are imported (not
// pasted) so the prose in BOTH flow audits is character-for-character the same
// sentence and can never drift apart.
import {
  FLOW_ACTIVATION_STATUS_DISCLOSURE,
  flowIsRunnable,
  readFlowStatus,
} from './flow-fault-audit.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

/** Inclusive upper bound on `limit` (the shared enumeration-style cap). */
const FLOW_BULK_MAX_LIMIT = 500;
/** Default `limit` when the caller omits it. The slice is over FLOWS. */
const FLOW_BULK_DEFAULT_LIMIT = 100;

/**
 * The three rule ids this tool emits. `dml-in-loop` / `get-records-in-loop` are
 * the Flow-side siblings of the Apex `dml-in-loop` / `soql-in-loop` governor
 * rules; `filterless-get-records` is the Flow unbounded-query smell.
 */
export type FlowBulkRule =
  | 'dml-in-loop'
  | 'get-records-in-loop'
  | 'filterless-get-records'
  | 'subflow-in-loop'
  | 'action-in-loop';

/** Two-tier severity — loop anti-patterns are HIGH, filterless queries MEDIUM. */
export type FlowBulkSeverity = 'high' | 'medium';

/**
 * The verbatim iteration-count boundary. Contains the exact phrase
 * "iteration count unknown at rest" — the correct honesty caveat for this tool
 * (a static loop-shape smell, NOT a proven limit breach). Deliberately NOT the
 * "conditions not evaluated" caveat, which belongs to `flow_trace`.
 */
const FLOW_BULK_ITERATION_DISCLOSURE =
  'iteration count unknown at rest — a Loop element may run 0 or many times, so a DML / Get inside a loop body is a STATIC Flow-shape smell (one operation per iteration against the per-transaction DML/SOQL governor limits), NOT a proven governor-limit breach at runtime. A filterless Get Records is an unbounded-query smell for the same reason. Verify against expected collection sizes.';

/**
 * The verbatim confidence boundary. The connector graph is DECLARED metadata,
 * so loop-body membership is structural — `declared` confidence, unlike the
 * Apex governor scan's `heuristic` recognizers.
 */
const FLOW_BULK_CONFIDENCE_DISCLOSURE =
  'Findings are read from the Flow\'s declared connector graph (confidence: declared) — loop-body membership is structural, not heuristic like the Apex governor_limit_risks scan. Collection sizes and record volumes are unknown at rest.';

/**
 * Zod schema for the `sfi.flow_bulkification_audit` tool input.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100 inside the
 *     handler. The slice is over FLOWS, not individual findings — a Flow with 7
 *     risks counts as 1 entry in the limit budget.
 *   - `offset`: optional zero-based offset for paging the FLOW list forward.
 *   - `objectApiName` / `object` / `objectId` / `componentId`: the
 *     interchangeable OBJECT identifiers a router / host reaches for
 *     (BULKIFICATION-AUDIT-DROPS-OBJECT-SCOPE). A record-triggered Flow carries
 *     `properties.triggerObject`, so its findings ARE attributable to an object
 *     — exactly as the `flow_fault_audit` sibling already proves. With a scope
 *     the sweep narrows to record-triggered flows on that object and echoes
 *     `appliedScope`; without one the response is byte-identical to the bare
 *     pre-scope shape. A `componentId` carrying a NON-object prefix is refused,
 *     never silently widened back to org-wide (this tool has no reverse mode).
 */
export const flowBulkificationAuditInputSchema = z.object({
  limit: z.number().int().min(1).max(FLOW_BULK_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  objectApiName: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type FlowBulkificationAuditInput = z.infer<
  typeof flowBulkificationAuditInputSchema
>;

/** One bulkification risk found inside a single Flow. */
export interface FlowBulkRisk {
  readonly rule: FlowBulkRule;
  readonly severity: FlowBulkSeverity;
  /** The offending canvas element's real `<name>` (the Get / DML element). */
  readonly location: string;
  /**
   * The Loop element (`<name>`) whose body contains `location`, or `null` for a
   * `filterless-get-records` that sits OUTSIDE any loop. For a lookup that is
   * BOTH in a loop and filterless, the loop findings carry the loop name and the
   * filterless finding carries it too.
   */
  readonly loop: string | null;
  /** The record-op's target SObject (`null` when the projection could not resolve it). */
  readonly object: string | null;
  /**
   * For `subflow-in-loop` / `action-in-loop`: what the loop body invokes once
   * per iteration — the target flow's api name, or `{actionType}:{actionName}`.
   * Absent on the three record-op rules, whose work is IN this flow.
   *
   * Its body is deliberately NOT opened here. A subflow's DML lives in a
   * different flow (audit it by its own entry in this same tool); an invocable
   * action's body is Apex or a platform action this projection cannot see at
   * all. So the finding proves the per-iteration INVOCATION and says plainly
   * that the work inside it was not checked — it never claims the callee is
   * clean, and never claims it is dirty.
   */
  readonly callee?: string;
  /** Human-readable, org-agnostic explanation. */
  readonly explanation: string;
}

/**
 * What the loop-body walk actually examined, per response. Present ALWAYS, so a
 * zero risk count is a MEASURED zero.
 *
 * Before this existed the detector looked only at record ops; a loop body full
 * of subflows and invocable actions produced `soundness.complete: true` and
 * `staticCoverage: 'full'`, which said "checked and clean" about elements it
 * had never looked at.
 */
export interface FlowBulkLoopBodyCoverage {
  /** Loop elements whose body was walked across every scanned flow. */
  readonly loopsScanned: number;
  /** Of those, how many hold at least one Subflow element. */
  readonly loopsWithSubflow: number;
  /** Of those, how many hold at least one `<actionCalls>` element. */
  readonly loopsWithAction: number;
  /**
   * Of those, how many hold at least one canvas element whose TYPE the flow
   * projection does not model (collection filter / sort, wait, custom
   * elements). Those cannot be classified either way — named, never counted as
   * clean. See `FlowGraphProjection.unmodeled`.
   */
  readonly loopsWithUnmodeledElement: number;
  /**
   * Names of the unmodeled element types found inside loop bodies, deduped and
   * sorted, capped at {@link UNMODELED_IN_LOOP_CAP}. Empty when there are none.
   */
  readonly unmodeledElementsInLoops: readonly string[];
  /** True when the cap above trimmed the list. */
  readonly unmodeledElementsTruncated: boolean;
}

/** One per-Flow entry: identity + its risks. Mirrors the governor per-class entry. */
export interface FlowBulkFlowEntry {
  readonly componentId: ComponentId;
  readonly apiName: string;
  /**
   * FLOW-AUDITS-IGNORE-ACTIVATION-STATUS: the Flow's recorded activation status
   * (`Active` / `Draft` / `Obsolete` / `InvalidDraft` / …), or `null` when this
   * vault does not record one. `null` is UNKNOWN — never coerced to `'Active'`.
   */
  readonly status: string | null;
  /**
   * `true` when `status === 'Active'`, `false` for any other RECORDED status,
   * and `null` when `status` is `null`. An unknown status must never collapse
   * to `false`, mirroring `find_dead_code`'s
   * `COALESCE(status,'') NOT IN ('Obsolete','InvalidDraft')` rule that an
   * unknown-status flow is treated as in-use.
   */
  readonly isRunnable: boolean | null;
  readonly risks: readonly FlowBulkRisk[];
}

/** A named blind spot: a Flow whose source could not be read / parsed. */
export interface FlowBulkBlindSpot {
  readonly kind: 'unparsed-flow';
  readonly componentIds: readonly ComponentId[];
  readonly note: string;
}

/** Uniform soundness envelope (mirrors the static-analysis `Soundness` shape). */
export interface FlowBulkSoundness {
  readonly complete: boolean;
  readonly blindSpots: readonly FlowBulkBlindSpot[];
  readonly staticCoverage: 'full' | 'partial';
}

/** Output payload. */
export interface FlowBulkificationAuditOutput {
  /**
   * Present ONLY on an object-scoped call
   * (BULKIFICATION-AUDIT-DROPS-OBJECT-SCOPE) — echoes the object the sweep was
   * narrowed to (record-triggered flows whose `triggerObject` is that object)
   * so a host never reads a scoped answer as org-wide. Absent on the bare call,
   * keeping that response byte-identical. `object` is the canonical
   * `CustomObject:` id; `mode` is always `component` when present.
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
  /** Per-Flow entries with at least one risk, sorted by componentId ASC (sliced by `limit`). */
  readonly flows: readonly FlowBulkFlowEntry[];
  /** Flows with >=1 risk BEFORE the `limit` slice. */
  readonly totalFlowCount: number;
  /** Flows actually scanned (read + projected) this run. */
  readonly scannedFlowCount: number;
  /** Total risks across all flagged flows (FULL, pre-slice). */
  readonly totalRiskCount: number;
  /** Per-rule counter across the FULL matched set. */
  readonly byRule: Readonly<Record<string, number>>;
  /** Verbatim honesty disclosures; empty when nothing matched and no blind spot. */
  readonly boundaries: readonly string[];
  /** True when the FLOW-level slice was trimmed to `limit`. */
  readonly truncated: boolean;
  /** Static blind spots: `complete: false` when a Flow's source could not be parsed. */
  readonly soundness: FlowBulkSoundness;
  /** What the loop-body walk examined — so a zero is a measured zero. */
  readonly loopBodyCoverage: FlowBulkLoopBodyCoverage;
  /** Provenance / confidence / completeness for the answer. */
  readonly trust: TrustSummary;
  /** Page size applied. Present only on a PAGED response (`truncated` or `offset > 0`). */
  readonly limit?: number;
  /** Zero-based offset of the first returned flow. Present only when paged. */
  readonly offset?: number;
  /** Offset to pass on the next call. Present only when `truncated`. */
  readonly nextOffset?: number;
}

// ---------------------------------------------------------------------------
// The PURE detector — unit-testable without a vault.
// ---------------------------------------------------------------------------

/** True when a Get Records (lookup) has NO filter / where clause (unbounded). */
const isFilterlessLookup = (op: RecordOp): boolean =>
  op.kind === 'lookup' &&
  op.filters.length === 0 &&
  (op.filterLogic === null || op.filterLogic.trim() === '');

/**
 * Build an adjacency map `elementName -> outgoing connectors` from the
 * authoritative `connectors[]` graph. Multiple edges from one element (default +
 * fault, or a decision's rule branches) all collect under the same key.
 */
const buildAdjacency = (
  connectors: readonly Connector[],
): ReadonlyMap<string, readonly Connector[]> => {
  const adjacency = new Map<string, Connector[]>();
  for (const c of connectors) {
    const list = adjacency.get(c.from);
    if (list === undefined) adjacency.set(c.from, [c]);
    else list.push(c);
  }
  return adjacency;
};

/**
 * Compute the set of element names inside ONE loop's body. The body is
 * everything reachable from `nextValueConnectsTo`, following outgoing
 * connectors, BOUNDED by two stop nodes: the loop element itself (the back-edge
 * that closes the iteration) and the loop's `noMoreValuesConnectsTo` target (the
 * exit path, which runs AFTER the loop, not per-iteration). A body element that
 * connects only to those boundaries — or that is a nested loop — is walked
 * fully, so a DML inside a nested loop still lands in the outer body. Cycle-safe
 * via the visited set.
 */
export const computeLoopBody = (
  loop: Loop,
  adjacency: ReadonlyMap<string, readonly Connector[]>,
): ReadonlySet<string> => {
  const boundary = new Set<string>([loop.name]);
  if (loop.noMoreValuesConnectsTo !== null) {
    boundary.add(loop.noMoreValuesConnectsTo);
  }
  const body = new Set<string>();
  const start = loop.nextValueConnectsTo;
  if (start === null || boundary.has(start)) return body;
  const queue: string[] = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (body.has(node)) continue;
    body.add(node);
    for (const conn of adjacency.get(node) ?? []) {
      const to = conn.to;
      if (boundary.has(to) || body.has(to)) continue;
      queue.push(to);
    }
  }
  return body;
};

/**
 * PURE bulkification detector. Given a parsed {@link FlowGraphProjection},
 * returns every DML-in-loop / Get-in-loop / filterless-Get risk, sorted
 * deterministically by `(location, rule)`. No I/O, no graph — the tool handler
 * and the unit tests both call this.
 *
 * A record op inside a NESTED loop is attributed to the INNERMOST loop that
 * contains it (the smallest body set), so the cited loop is the tightest one.
 * A filterless lookup that also sits in a loop yields BOTH a loop finding and
 * the filterless finding (two distinct smells).
 */
export const detectFlowBulkificationRisks = (
  projection: FlowGraphProjection,
): readonly FlowBulkRisk[] => detectFlowBulkification(projection).risks;

/**
 * Per-flow loop-body census, summed across the scan by the handler.
 * `unmodeledElementsInLoops` is the raw (uncapped, unsorted) set for one flow.
 */
export interface FlowBulkLoopBodyTally {
  readonly loopsScanned: number;
  readonly loopsWithSubflow: number;
  readonly loopsWithAction: number;
  readonly loopsWithUnmodeledElement: number;
  readonly unmodeledElementsInLoops: readonly string[];
}

/**
 * The full pure pass: the risks AND the census of what the loop-body walk
 * looked at. {@link detectFlowBulkificationRisks} is the risks-only projection
 * of this, kept because it is the unit-test and public entry point.
 */
export const detectFlowBulkification = (
  projection: FlowGraphProjection,
): {
  readonly risks: readonly FlowBulkRisk[];
  readonly loopBody: FlowBulkLoopBodyTally;
} => {
  const adjacency = buildAdjacency(projection.connectors);

  // Per-loop body sets, keyed by loop name.
  const loopBodies = new Map<string, ReadonlySet<string>>();
  for (const loop of projection.loops) {
    loopBodies.set(loop.name, computeLoopBody(loop, adjacency));
  }

  const risks: FlowBulkRisk[] = [];

  for (const op of projection.recordOps) {
    // Which loops contain this record op? Pick the innermost (smallest body).
    let innermostLoop: string | null = null;
    let innermostSize = Number.POSITIVE_INFINITY;
    for (const [loopName, body] of loopBodies) {
      if (body.has(op.name) && body.size < innermostSize) {
        innermostLoop = loopName;
        innermostSize = body.size;
      }
    }

    const inLoop = innermostLoop !== null;
    const isDml =
      op.kind === 'create' || op.kind === 'update' || op.kind === 'delete';
    const isLookup = op.kind === 'lookup';

    if (inLoop && isDml) {
      risks.push({
        rule: 'dml-in-loop',
        severity: 'high',
        location: op.name,
        loop: innermostLoop,
        object: op.object,
        explanation: `Record ${op.kind} '${op.name}' runs inside the body of loop '${innermostLoop ?? ''}', so it performs one DML per iteration — at scale this trips the 150-DML-per-transaction governor limit. Move the DML after the loop and operate on a collection.`,
      });
    }
    if (inLoop && isLookup) {
      risks.push({
        rule: 'get-records-in-loop',
        severity: 'high',
        location: op.name,
        loop: innermostLoop,
        object: op.object,
        explanation: `Get Records '${op.name}' runs inside the body of loop '${innermostLoop ?? ''}', so it issues one SOQL query per iteration — at scale this trips the 100-SOQL-per-transaction governor limit. Query before the loop and map results in memory.`,
      });
    }
    if (isFilterlessLookup(op)) {
      risks.push({
        rule: 'filterless-get-records',
        severity: 'medium',
        location: op.name,
        loop: innermostLoop,
        object: op.object,
        explanation: `Get Records '${op.name}' has no filter / where clause, so it is an unbounded query that returns every record of ${op.object ?? 'the object'} — add filter conditions to bound the result set.`,
      });
    }
  }

  // BULKIFICATION-AUDIT-RECORDOPS-ONLY — the elements the loop over
  // `projection.recordOps` above structurally cannot see. A Subflow or an
  // `<actionCalls>` in a loop body runs once per iteration exactly like a DML
  // does; the difference is only that the WORK it performs lives in another
  // flow or in Apex, which this projection does not hold. So the finding proves
  // the invocation and names the callee, and its severity is MEDIUM rather than
  // HIGH precisely because the DML inside the callee is unproven here — not
  // absent, unproven. `innermostLoopFor` reuses the same innermost-wins rule as
  // the record-op walk so a nested loop cites the tightest loop.
  const innermostLoopFor = (elementName: string): string | null => {
    let innermost: string | null = null;
    let size = Number.POSITIVE_INFINITY;
    for (const [loopName, body] of loopBodies) {
      if (body.has(elementName) && body.size < size) {
        innermost = loopName;
        size = body.size;
      }
    }
    return innermost;
  };

  for (const subflow of projection.subflows) {
    const loop = innermostLoopFor(subflow.name);
    if (loop === null) continue;
    risks.push({
      rule: 'subflow-in-loop',
      severity: 'medium',
      location: subflow.name,
      loop,
      object: null,
      callee: subflow.targetFlowId,
      explanation: `Subflow '${subflow.name}' is invoked inside the body of loop '${loop}', so the called flow '${subflow.targetFlowId}' runs once per iteration and every DML / Get Records IT performs is multiplied by the iteration count. This audit did NOT open the called flow — its body is a separate flow, so this finding is "invoked per iteration", never "the callee is clean". Read '${subflow.targetFlowId}''s own entry in this audit${subflow.resolved ? '' : ' — note the target flow was not resolved in this vault, so it may not have one'}, then move the work out of the loop or bulkify the callee.`,
    });
  }

  for (const action of projection.actions) {
    const loop = innermostLoopFor(action.name);
    if (loop === null) continue;
    const callee = `${action.actionType ?? 'unknown-type'}:${action.actionName ?? 'unknown-action'}`;
    risks.push({
      rule: 'action-in-loop',
      severity: 'medium',
      location: action.name,
      loop,
      object: null,
      callee,
      explanation: `Action '${action.name}' (${callee}) is invoked inside the body of loop '${loop}', so it runs once per iteration. What the action DOES — Apex DML, a callout, an email send — is not modeled by the flow projection at all, so this finding is "invoked per iteration", never a claim that the action is safe. For an Apex invocable, audit the class with governor_limit_risks; otherwise move the invocation out of the loop and pass a collection.`,
    });
  }

  risks.sort((a, b) =>
    a.location !== b.location
      ? a.location < b.location
        ? -1
        : 1
      : a.rule < b.rule
        ? -1
        : a.rule > b.rule
          ? 1
          : 0,
  );

  // The census. Counted over LOOPS (not elements) because the question a reader
  // asks is "did you look inside the loops", and a loop with three subflows is
  // one loop that was looked into.
  const unmodeledNames = new Set(projection.unmodeled);
  const subflowNames = new Set(projection.subflows.map((f) => f.name));
  const actionNames = new Set(projection.actions.map((a) => a.name));
  let loopsWithSubflow = 0;
  let loopsWithAction = 0;
  let loopsWithUnmodeledElement = 0;
  const unmodeledInLoops = new Set<string>();
  for (const body of loopBodies.values()) {
    let sawSubflow = false;
    let sawAction = false;
    let sawUnmodeled = false;
    for (const element of body) {
      if (subflowNames.has(element)) sawSubflow = true;
      if (actionNames.has(element)) sawAction = true;
      if (unmodeledNames.has(element)) {
        sawUnmodeled = true;
        unmodeledInLoops.add(element);
      }
    }
    if (sawSubflow) loopsWithSubflow += 1;
    if (sawAction) loopsWithAction += 1;
    if (sawUnmodeled) loopsWithUnmodeledElement += 1;
  }

  return {
    risks,
    loopBody: {
      loopsScanned: loopBodies.size,
      loopsWithSubflow,
      loopsWithAction,
      loopsWithUnmodeledElement,
      unmodeledElementsInLoops: [...unmodeledInLoops],
    },
  };
};

// ---------------------------------------------------------------------------
// The MCP handler.
// ---------------------------------------------------------------------------

const FLOW_UNPARSED_NOTE =
  'Source could not be read / parsed for these Flows (missing or malformed `.flow-meta.xml`), so their loop bodies were NOT scanned — an empty finding for them is "not checked", not proven clean. Re-run /sfi-refresh.';

/** Cap on the unmodeled-element names echoed back in `loopBodyCoverage`. */
const UNMODELED_IN_LOOP_CAP = 25;

/**
 * BULKIFICATION-AUDIT-DROPS-OBJECT-SCOPE — the verbatim boundary emitted ONLY
 * on an object-scoped call. Product copy; do not reword. It names what the
 * scope EXCLUDED, so an empty scoped result can never be mistaken for an empty
 * org-wide one.
 */
const scopedToObjectNote = (object: string): string =>
  `Scoped to record-triggered flows whose triggerObject is ${object}. Screen, ` +
  'autolaunched, scheduled, and platform-event flows have no single object and ' +
  'are EXCLUDED from this scoped view — run the bare audit for them.';

/**
 * The verbatim callee boundary — the honest half of `subflow-in-loop` /
 * `action-in-loop`. Emitted whenever a loop body held a subflow or an action,
 * whether or not that produced a finding, because the reader's question is what
 * was and was not established.
 */
const FLOW_BULK_CALLEE_DISCLOSURE =
  'A `subflow-in-loop` / `action-in-loop` finding proves the per-iteration INVOCATION only. The callee\'s body is NOT opened by this audit — a Subflow\'s DML lives in a different Flow (read that flow\'s own entry here), and an invocable Action\'s body is Apex or a platform action the Flow projection cannot see at all (audit the class with `governor_limit_risks`). So such a finding is never a claim that the callee performs DML, and its absence is never a claim that it does not.';

/**
 * The verbatim loop-body coverage statement. Emitted on EVERY response — a
 * measured zero has to be stated to be a zero rather than an omission.
 */
const loopBodyCoverageNote = (coverage: FlowBulkLoopBodyCoverage): string =>
  `Loop-body coverage: ${coverage.loopsScanned} loop body/bodies walked across the scanned Flows — ${coverage.loopsWithSubflow} contained a Subflow, ${coverage.loopsWithAction} contained an invocable Action, ${coverage.loopsWithUnmodeledElement} contained a canvas element type this projection does not model${coverage.unmodeledElementsInLoops.length > 0 ? ` (${coverage.unmodeledElementsInLoops.join(', ')}${coverage.unmodeledElementsTruncated ? ', …' : ''})` : ''}. Record Create / Update / Delete / Get inside those bodies is detected structurally; a Subflow or Action inside them is detected as an invocation but its callee body is not opened; an unmodeled element inside them is NOT classified either way.`;

/**
 * Read + project ONE Flow's source on demand and run the pure detector.
 * Returns `null` (and records the blind spot via the caller) when the source is
 * missing / unreadable / unparseable — never throws.
 */
const auditOneFlow = async (
  ctx: Context,
  node: Node,
): Promise<{
  readonly risks: readonly FlowBulkRisk[];
  readonly loopBody: FlowBulkLoopBodyTally;
} | null> => {
  if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) {
    return null;
  }
  let xml: string;
  try {
    xml = await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
  } catch {
    return null;
  }
  const projected = parseFlowGraphSource(xml);
  if (!projected.ok) return null;
  return detectFlowBulkification(projected.value);
};

/**
 * The `sfi.flow_bulkification_audit` MCP tool. Iterates every `Flow` node,
 * projects its declared connector graph on demand, and flags DML / Get inside
 * loops + filterless Get Records. See the module JSDoc for the rule subset and
 * the honesty spine.
 *
 * @example
 *   const r = await flowBulkificationAuditHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.totalRiskCount);
 */
export const flowBulkificationAuditHandler = async (
  ctx: Context,
  input: FlowBulkificationAuditInput,
): Promise<Result<McpResponse<FlowBulkificationAuditOutput>, McpError>> => {
  const limit = input.limit ?? FLOW_BULK_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  // BULKIFICATION-AUDIT-DROPS-OBJECT-SCOPE: resolve the optional object scope
  // (and verify the object exists) BEFORE scanning, exactly as the
  // `flow_fault_audit` sibling does. `null` = bare org-wide call
  // (byte-identical); a resolved scope narrows the sweep to record-triggered
  // flows on that object; an unresolvable / absent object → `invalid-query`.
  // `unhandledPrefix: 'refuse'` because this tool has NO reverse mode: a
  // `componentId` with a non-object prefix would otherwise be dropped and the
  // caller would silently get the org-wide report.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input, {
    unhandledPrefix: 'refuse',
  });
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;

  const scan = await scanAllNodesOfTypes(ctx.graph, ['Flow']);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }

  const entries: FlowBulkFlowEntry[] = [];
  const byRule: Record<string, number> = {};
  const unparsedIds: ComponentId[] = [];
  let totalRiskCount = 0;
  let scannedFlowCount = 0;

  let loopsScanned = 0;
  let loopsWithSubflow = 0;
  let loopsWithAction = 0;
  let loopsWithUnmodeledElement = 0;
  const unmodeledInLoops = new Set<string>();

  for (const node of scan.value.nodes) {
    // Object-scoped: keep only flows that RUN ON the scoped object — a
    // record-triggered flow's `triggerObject` (bare api name). Screen /
    // autolaunched / scheduled / platform-event flows have no `triggerObject`
    // and are correctly excluded; the scope boundary below says so out loud so
    // an empty scoped result is never read as an empty org-wide one.
    if (scope !== null && node.properties['triggerObject'] !== scope.object) {
      continue;
    }
    scannedFlowCount += 1;
    const audited = await auditOneFlow(ctx, node);
    if (audited === null) {
      unparsedIds.push(node.id);
      continue;
    }
    loopsScanned += audited.loopBody.loopsScanned;
    loopsWithSubflow += audited.loopBody.loopsWithSubflow;
    loopsWithAction += audited.loopBody.loopsWithAction;
    loopsWithUnmodeledElement += audited.loopBody.loopsWithUnmodeledElement;
    for (const name of audited.loopBody.unmodeledElementsInLoops) {
      unmodeledInLoops.add(name);
    }
    const { risks } = audited;
    if (risks.length === 0) continue;
    for (const risk of risks) {
      byRule[risk.rule] = (byRule[risk.rule] ?? 0) + 1;
      totalRiskCount += 1;
    }
    // FLOW-AUDITS-IGNORE-ACTIVATION-STATUS: a Draft / Obsolete flow's
    // bulkification findings are LATENT, not live. `status: null` means the
    // vault does not record one — UNKNOWN, never `'Active'`, never `false`.
    const status = readFlowStatus(node.properties);
    entries.push({
      componentId: node.id,
      apiName: node.apiName,
      status,
      isRunnable: flowIsRunnable(status),
      risks,
    });
  }

  const sortedUnmodeled = [...unmodeledInLoops].sort();
  const loopBodyCoverage: FlowBulkLoopBodyCoverage = {
    loopsScanned,
    loopsWithSubflow,
    loopsWithAction,
    loopsWithUnmodeledElement,
    unmodeledElementsInLoops: sortedUnmodeled.slice(0, UNMODELED_IN_LOOP_CAP),
    unmodeledElementsTruncated: sortedUnmodeled.length > UNMODELED_IN_LOOP_CAP,
  };

  entries.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );

  const slice = entries.slice(offset, offset + limit);
  const truncated = offset + slice.length < entries.length;

  const soundness: FlowBulkSoundness =
    unparsedIds.length === 0
      ? { complete: true, blindSpots: [], staticCoverage: 'full' }
      : {
          complete: false,
          blindSpots: [
            {
              kind: 'unparsed-flow',
              componentIds: [...unparsedIds].sort(),
              note: FLOW_UNPARSED_NOTE,
            },
          ],
          staticCoverage: 'partial',
        };

  const boundaries: string[] = [];
  if (entries.length > 0) {
    boundaries.push(FLOW_BULK_ITERATION_DISCLOSURE, FLOW_BULK_CONFIDENCE_DISCLOSURE);
  }
  // BULKIFICATION-AUDIT-RECORDOPS-ONLY. Stated on EVERY response, findings or
  // not: the whole defect was that a loop body full of subflows and actions
  // produced a clean-looking zero, so the count of what was walked is exactly
  // the sentence a reader needed and did not get.
  boundaries.push(loopBodyCoverageNote(loopBodyCoverage));
  // FLOW-AUDITS-IGNORE-ACTIVATION-STATUS. Unconditional, like the coverage note
  // above: it describes how the audit REPORTS status, which is true whether or
  // not anything was flagged.
  boundaries.push(FLOW_ACTIVATION_STATUS_DISCLOSURE);
  // BULKIFICATION-AUDIT-DROPS-OBJECT-SCOPE: only on a scoped call, and it names
  // what the scope EXCLUDED — an empty scoped result must be distinguishable
  // from an empty org-wide one.
  if (scope !== null) {
    boundaries.push(scopedToObjectNote(scope.object));
  }
  if (loopBodyCoverage.loopsWithSubflow > 0 || loopBodyCoverage.loopsWithAction > 0) {
    boundaries.push(FLOW_BULK_CALLEE_DISCLOSURE);
  }
  if (scan.value.scanIncomplete) {
    boundaries.push(
      scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit()),
    );
  }
  if (unparsedIds.length > 0) {
    boundaries.push(FLOW_UNPARSED_NOTE);
  }

  // An unmodeled canvas element inside a loop body is a real static blind spot:
  // the projection cannot say whether it performs work, so the loop cannot be
  // called clean. Report `partial` rather than let the trust block say the scan
  // saw everything it walked past.
  const missingCoverage: string[] = [];
  if (unparsedIds.length > 0) missingCoverage.push('Flow (unparseable source)');
  if (loopBodyCoverage.loopsWithUnmodeledElement > 0) {
    missingCoverage.push('Flow loop body (canvas element type not modeled)');
  }
  const completeness: TrustSummary['completeness'] =
    missingCoverage.length === 0
      ? { status: 'complete' }
      : { status: 'partial', missingCoverage };

  const isPaged = truncated || offset > 0;

  return ok({
    data: {
      // appliedScope FIRST + only when scoped, so a bare call omits the whole
      // block (the pre-scope shape) and a scoped one can never be read as
      // org-wide.
      ...(scope !== null
        ? { appliedScope: { object: scope.componentId, mode: 'component' as const } }
        : {}),
      flows: slice,
      totalFlowCount: entries.length,
      scannedFlowCount,
      totalRiskCount,
      byRule,
      boundaries,
      truncated,
      soundness,
      loopBodyCoverage,
      trust: offlineTrust(ctx, completeness),
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + slice.length } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
