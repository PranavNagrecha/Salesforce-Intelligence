/**
 * Handler for the `sfi.what_if_disable_trigger` MCP tool.
 *
 * v2.3 R2b — the second of three component-level what-if composers.
 * Given an ApexTrigger canonical id (`ApexTrigger:{Name}`), enumerates
 * the downstream impact of disabling the trigger: every outgoing edge
 * the trigger has becomes a potential lost-effect when the trigger no
 * longer fires. Sibling of `what_if_deactivate_flow`: the deactivation
 * semantic is identical (the metadata definition remains in the org,
 * the runtime stops firing), but the impact surfaces differ because
 * triggers are Apex bodies rather than declarative XML.
 *
 * **What disabling breaks.** Disabling a trigger means none of its
 * before/after handlers run anymore. The composer walks each outgoing
 * edge type the trigger emits and projects a per-edge
 * `WhatIfImpactItem`:
 *
 *   | Outgoing edge   | What it represented               | Impact category   | Verdict  |
 *   |-----------------|-----------------------------------|-------------------|----------|
 *   | triggersOn      | The object the trigger listens to | NOT an impact — `entryPoints` | — |
 *   | listensTo       | Platform Event subscription       | NOT an impact — `entryPoints` | — |
 *   | callsApex       | Apex classes the trigger invokes  | code-needs-update | risky    |
 *   | dispatchesAsync | Async jobs the trigger queues     | code-needs-update | risky    |
 *   | readsFrom       | Fields the trigger reads          | input-only        | NONE     |
 *   | writesTo        | Fields the trigger writes         | metadata-blocker  | blocking |
 *
 * **An entry point is not a dependent.** `triggersOn` and `listensTo`
 * name the trigger's OWN ATTACHMENT POINT, not something downstream of
 * it. Every trigger has exactly one `triggersOn`, so classifying it
 * `blocking` made the verdict unconditional — measured org-wide, every
 * trigger returned `blocking` and the headline therefore carried no
 * information. Both edge types are RECATEGORISED (never dropped) into
 * the `entryPoints` block, which reports the same identities under a
 * label that says what they actually are.
 *
 * **`readsFrom` is an INPUT, not an effect.** Reading a field is an
 * input to this automation, not a downstream consequence of it: the
 * field is unchanged and nothing downstream of the field is affected.
 * It is surfaced with `category: 'input-only'` and contributes NOTHING
 * to the verdict. `writesTo` keeps `blocking` — a write other
 * automation may consume is fail-conservative and correct.
 *
 * **The parent-object axis.** Triggers attach to exactly one
 * SObject via the declared `triggersOn` edge. The response surfaces
 * the parent object separately so the renderer can render "automation
 * on Account will lose this handler" without the caller having to
 * filter the impacts array for the `CustomObject:Account` row.
 *
 * **The events axis.** Each trigger's `properties.events` array
 * carries the lifecycle phases it listens to (`before insert`,
 * `after update`, etc.). The response surfaces this so the renderer
 * can render "the before-insert + after-update handler will no longer
 * fire on this object". Empty array surfaces when the extractor did
 * not populate the property (the v0.1 ApexTrigger extractor always
 * populates events, so the empty case should only occur for malformed
 * trigger headers).
 *
 * **Two axes: runtime state and dependency structure.** The response
 * carries BOTH, because they answer different questions and a single
 * word cannot.
 *
 *   - `structuralVerdict` is what the dependency structure says, over
 *     the VERDICT-BEARING impacts only (`input-only` entries are
 *     excluded). Cascade, mirroring R2a's `aggregateVerdict`:
 *       * `safe` when there is no verdict-bearing impact at all — and
 *         then `notProvenHarmless` states what that `safe` does and does
 *         not prove, because `safe` alone over-claims.
 *       * `blocking` if ANY `metadata-blocker` impact appears (a write
 *         other automation may consume).
 *       * `risky` if no `metadata-blocker` but at least one
 *         `code-needs-update` impact.
 *   - `verdict` is the HEADLINE and consults `runtimeState`: a trigger
 *     that does not run today gets `already-inactive`, because telling
 *     the caller "disabling this would break things" about a handler
 *     that is already off is false. `already-inactive` says the one true
 *     thing (it is already off) WITHOUT claiming the second (nothing
 *     depends on it) — the dependents are still listed in `impacts` and
 *     still described by `structuralVerdict`.
 *   - `runtimeState.currentlyRunning` is `null`, never `false`, when the
 *     vault does not record a status: absence is UNKNOWN, not "off".
 *
 * Only `structuralVerdict` is coverage-downgraded ({@link
 * attachCoverageToWhatIf}); being switched off is not a
 * coverage-dependent claim, so `already-inactive` is never downgraded.
 *
 * **Honesty axis.** v2.3 applies a fail-conservative approach when
 * disclosing impact. Disabling is a runtime metadata flag, not a
 * deletion: the trigger remains in the org and a later re-enable
 * restores every effect listed. The v0.3 apex-scanner's edge
 * confidence is `heuristic` for most outgoing edges (regex-based
 * token-pair extraction); the caller should spot-check the trigger
 * body when a finding's confidence is `heuristic`. Indirect dispatch
 * via trigger frameworks (TriggerHandler base class, fflib) is
 * partially invisible to the heuristic walker — trigger framework
 * recognition is incomplete and should be manually verified.
 *
 * Implementation notes:
 *   - `triggerId` is required to start with `ApexTrigger:`. Other
 *     prefixes return `invalid-query` at the handler boundary.
 *   - Unknown ids resolve to `component-not-found`.
 *   - For each outgoing edge, `getNodeById(edge.toId)` resolves the
 *     downstream node's identity. Sparse-graph misses are silently
 *     dropped — matches the tolerance every other composition tool
 *     uses.
 *   - The `triggersOn` edge is surfaced as the `parentObject` scalar
 *     (the renderer's "automation on Account" line) AND as an
 *     `entryPoints` row. It is NOT an impact: it is where the trigger
 *     attaches, not something the trigger affects.
 *   - Impacts are sorted by `(category, componentId)` ASC for
 *     deterministic output.
 */

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  attachCoverageToWhatIf,
  type CoverageCaveat,
  TRIGGER_DISABLE_REQUIRED_COVERAGE,
  type Verdict,
} from './coverage-trust.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix for the ApexTrigger node type. */
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/**
 * One finding category in the `WhatIfImpactItem` shape, mirroring
 * R2a's `what-if-change-field-type.ts` and R2b's
 * `what-if-deactivate-flow.ts`. The composer module uses the same
 * union across every v2.3 tool so the `architect-what-if-analysis`
 * skill can group by category uniformly.
 */
type Category =
  | 'metadata-blocker'
  | 'code-needs-update'
  | 'integration-touch'
  | 'test-class-update'
  | 'invisible-risk'
  | 'configuration-only'
  /**
   * A dependency THIS trigger consumes (a field it reads), not a dependent
   * on it. Surfaced for completeness and EXCLUDED from the verdict — see
   * {@link isVerdictBearing}.
   */
  | 'input-only';

/**
 * One impact entry in the response's `impacts` array. Mirrors the
 * `WhatIfImpactItem` interface in R2a's `what-if-change-field-type.ts`
 * — scoped to the fields v2.3 R2 populates.
 */
export interface WhatIfImpactItem {
  readonly category: Category;
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly confidence: ConfidenceLevel;
  readonly explanation: string;
}

/**
 * One ENTRY POINT of the trigger — where the runtime hands control TO it.
 * `triggersOn` (the SObject the handler is attached to) and `listensTo` (the
 * Platform Event it subscribes to) used to be reported as `impacts`, which
 * made every trigger read `blocking`: an entry point is not a dependent.
 * They are recategorised here rather than dropped, so the identity a caller
 * used to read out of `impacts` is still in the response.
 */
export interface WhatIfEntryPoint {
  readonly kind: 'triggersOn' | 'listensTo';
  readonly componentId: ComponentId;
  readonly note: string;
}

/**
 * The RUNTIME-STATE axis — does this component run in the org today? Separate
 * from the dependency structure because they are different questions.
 *
 *   - `status` is the vault's recorded activation status, or `null` when the
 *     vault does not carry one. Never `''` — an empty string reads as a value.
 *   - `currentlyRunning` is `true` / `false` only when the status says so, and
 *     `null` when it is absent or unrecognised. NEVER a fabricated `false`.
 *   - `note` states, in one sentence, what that means for the verdict.
 */
export interface WhatIfRuntimeState {
  readonly status: string | null;
  readonly currentlyRunning: boolean | null;
  readonly note: string;
}

/**
 * The headline verdict vocabulary for this tool: the shared what-if
 * {@link Verdict} plus `already-inactive`.
 *
 * `already-inactive` is a FOURTH word on purpose. `safe` already means "no
 * impacts at all" and is coverage-downgraded to `review`, so reusing it would
 * make an inactive-but-heavily-depended-on trigger read identically to a
 * genuinely inert one. `already-inactive` asserts only that the component does
 * not run today; what depends on it is reported by `structuralVerdict` and
 * `impacts`.
 */
export type TriggerDisableVerdict = Verdict | 'already-inactive';

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfDisableTriggerOutput {
  readonly triggerId: ComponentId;
  readonly apiName: string;
  readonly status: string;
  readonly parentObject: ComponentId | null;
  readonly events: readonly string[];
  /** Where the runtime enters this trigger. NOT impacts — see {@link WhatIfEntryPoint}. */
  readonly entryPoints: readonly WhatIfEntryPoint[];
  readonly impacts: readonly WhatIfImpactItem[];
  /** Does it run today? Its own axis; see {@link WhatIfRuntimeState}. */
  readonly runtimeState: WhatIfRuntimeState;
  /** HEADLINE. `already-inactive` when the trigger does not run today. */
  readonly verdict: TriggerDisableVerdict;
  /** What the dependency structure says, independent of runtime state. */
  readonly structuralVerdict: Verdict;
  /**
   * Present exactly when `structuralVerdict === 'safe'` — i.e. when no
   * verdict-bearing impact was found. States what that `safe` does NOT prove,
   * because an empty result is a statement about the edge types walked, not a
   * proof of harmlessness.
   */
  readonly notProvenHarmless?: string;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

/**
 * The verbatim disclosure surfaced in every response. Frozen so the
 * test suite can assert the exact string; rephrasing during rendering
 * is a code-review concern, not silent drift. The phrasing mirrors
 * R2a's `what-if-change-field-type.ts` disclosure to keep the v2.3
 * tool surface uniform, with the trigger-specific
 * "trigger-framework-partial" caveat appended.
 */
const DISCLOSURE =
  "v2.3 what-if analysis is composition over the v2.2 vault state. Disabling a trigger stops the downstream effects listed in impacts; entries with category 'input-only' are dependencies the trigger CONSUMES (fields it reads) and stop nothing downstream, and entryPoints names where the trigger attaches rather than anything it affects. The trigger definition remains in the org and a later re-enable restores the effects. The v0.3 apex-scanner's edge confidence is heuristic for most outgoing edges; spot-check the trigger body when a finding's confidence is heuristic. Indirect dispatch via trigger framework base classes (TriggerHandler, fflib) may be partially invisible to the recognizer.";

/**
 * Verbatim: what a `safe` structural verdict does NOT prove. Emitted whenever
 * there is no verdict-bearing impact, because `safe` on its own over-claims —
 * absence of a modelled edge is a statement about the edge types walked.
 */
const NOT_PROVEN_HARMLESS =
  'No downstream effect is visible in this vault. That is a statement about the edge types walked (writesTo, callsApex, dispatchesAsync, sendsEmail, subflow references), not a proof that disabling is harmless — dynamic dispatch, managed-package callers, and framework wiring are invisible here.';

/** Verbatim: the vault records no activation status, so "runs today" is UNKNOWN. */
const UNKNOWN_RUNTIME_STATE_NOTE =
  "This component's activation status is not recorded in this vault, so whether it runs today is UNKNOWN — not assumed active and not assumed inactive. Treat the verdict as the structural answer only, and confirm the status in the org.";

/**
 * Zod schema for the `sfi.what_if_disable_trigger` tool input.
 *
 *   - `triggerId`: required, non-empty string. The canonical
 *     ApexTrigger id (`ApexTrigger:{Name}`). Non-`ApexTrigger:`
 *     prefixes surface as `invalid-query` from the handler; unknown
 *     but well-formed ids surface as `component-not-found`.
 */
export const whatIfDisableTriggerInputSchema = z.object({
  triggerId: z.string().min(1),
});

/** Parsed input shape, inferred from the Zod schema. */
export type WhatIfDisableTriggerInput = z.infer<
  typeof whatIfDisableTriggerInputSchema
>;

/**
 * Pull the trigger's `status` property. The ApexTrigger extractor
 * enforces the `Active` / `Inactive` enum at extraction time; the
 * empty-string fallback shouldn't fire in practice but keeps the
 * response shape stable for malformed inputs.
 */
const readTriggerStatus = (node: Node): string => {
  const raw = node.properties['status'];
  return typeof raw === 'string' ? raw : '';
};

/**
 * Pull the trigger's `events` property — the lifecycle phases the
 * trigger listens to (`before insert`, `after update`, etc.). The v0.1
 * extractor always populates this from the parsed trigger header; the
 * empty-array fallback keeps the response shape stable for malformed
 * headers.
 */
const readTriggerEvents = (node: Node): readonly string[] => {
  const raw = node.properties['events'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string');
};

/**
 * The trigger's own ENTRY POINTS, mapped to the verbatim `entryPoints` note.
 * An edge type in this table is where the runtime hands control TO the
 * trigger, so it is never an impact — it is recategorised, not dropped.
 */
const ENTRY_POINT_NOTES: Readonly<Record<string, string>> = Object.freeze({
  triggersOn:
    'the object this trigger attaches to; disabling removes the handler here',
  listensTo:
    'the Platform Event this trigger subscribes to; disabling removes the subscription here',
});

/** The `entryPoints` note for an edge type, or `undefined` when it is a real impact. */
const entryPointNoteFor = (edgeType: string): string | undefined =>
  ENTRY_POINT_NOTES[edgeType];

/**
 * Classify one outgoing edge into a `(category, verdict)` pair. The
 * rule table is documented in the module JSDoc above. Entry-point edge
 * types ({@link ENTRY_POINT_NOTES}) never reach this function.
 *   - `writesTo` is metadata-declared from the v0.3 apex-scanner;
 *     stopping a write is a behavior change other automation may
 *     depend on. Blocking.
 *   - `callsApex` and `dispatchesAsync` are code-needs-update: the
 *     called class may have side effects the trigger's deactivation
 *     now skips.
 *   - `readsFrom` is `input-only`: a field the trigger CONSUMES. It is
 *     surfaced (nothing is dropped) but contributes NOTHING to the
 *     verdict — the field is unchanged and nothing downstream of it is
 *     affected, so rating a read `risky` was a category error.
 *   - Unknown edge types fall through to `configuration-only` /
 *     `risky` so the caller still sees the finding rather than the
 *     tool silently dropping it.
 */
const classifyOutgoingEdge = (
  edge: Edge,
): { category: Category; verdict: Verdict } => {
  switch (edge.edgeType) {
    case 'writesTo':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    case 'callsApex':
      return { category: 'code-needs-update', verdict: 'risky' };
    case 'dispatchesAsync':
      return { category: 'code-needs-update', verdict: 'risky' };
    case 'readsFrom':
      // `input-only` carries no verdict; see {@link isVerdictBearing}.
      return { category: 'input-only', verdict: 'safe' };
    default:
      return { category: 'configuration-only', verdict: 'risky' };
  }
};

/**
 * Synthesise the per-finding `explanation` string. The phrasing
 * mirrors the sibling `what_if_deactivate_flow` shape so the renderer
 * can rely on a uniform "the trigger does X to Y" shape across the
 * v2.3 surface.
 */
const buildExplanation = (
  toNode: Node,
  edge: Edge,
  triggerApiName: string,
): string => {
  // A read is an INPUT to this trigger, not an action with downstream
  // consequences. The old sentence ("…stops this action.") was factually
  // wrong: disabling the trigger removes the read, and that is all.
  if (edge.edgeType === 'readsFrom') {
    return `ApexTrigger '${triggerApiName}' reads ${toNode.type} '${toNode.apiName}'. Disabling the trigger removes that read; '${toNode.apiName}' itself is unchanged and nothing downstream of it is affected. Listed because it is a dependency of this trigger, not a dependent on it.`;
  }
  const verb =
    edge.edgeType === 'writesTo'
      ? 'writes to'
      : edge.edgeType === 'callsApex'
        ? 'calls'
        : edge.edgeType === 'dispatchesAsync'
          ? 'dispatches async'
          : 'references';
  return `ApexTrigger '${triggerApiName}' ${verb} ${toNode.type} '${toNode.apiName}'; disabling the trigger stops this action.`;
};

/**
 * TRUE when an impact is a DEPENDENT of this trigger — something downstream
 * that stops. `input-only` entries are dependencies the trigger CONSUMES and
 * are excluded: they are reported, but they never move the verdict.
 */
const isVerdictBearing = (impact: WhatIfImpactItem): boolean =>
  impact.category !== 'input-only';

/**
 * Aggregate the verdict-bearing impacts into the STRUCTURAL severity. The
 * cascade mirrors R2a's `aggregateVerdict`; the filter is what stops an
 * input-only read from producing a downstream-effect verdict.
 */
const aggregateVerdict = (impacts: readonly WhatIfImpactItem[]): Verdict => {
  const dependents = impacts.filter(isVerdictBearing);
  if (dependents.length === 0) return 'safe';
  for (const impact of dependents) {
    if (impact.category === 'metadata-blocker') return 'blocking';
  }
  for (const impact of dependents) {
    if (
      impact.category === 'code-needs-update' ||
      impact.category === 'integration-touch'
    ) {
      return 'risky';
    }
  }
  return 'risky';
};

/**
 * Resolve the RUNTIME-STATE axis from the trigger's recorded status.
 *
 * The ApexTrigger extractor writes the `Active` / `Inactive` enum. Anything
 * else — an absent property, an empty string, an unrecognised value — yields
 * `currentlyRunning: null` with the UNKNOWN note. A fabricated `false` here
 * would assert "this trigger is off" on the strength of a missing property,
 * which is exactly the absence-as-fact error this tool exists to avoid.
 *
 * @param dependentCount the number of VERDICT-BEARING impacts — the things
 *   that would be affected if the trigger were re-enabled.
 */
const resolveRuntimeState = (
  status: string,
  dependentCount: number,
): WhatIfRuntimeState => {
  if (status === 'Active') {
    return {
      status,
      currentlyRunning: true,
      note: 'This ApexTrigger is Active — it runs in the org today, so the headline verdict is the structural verdict.',
    };
  }
  if (status === 'Inactive') {
    return {
      status,
      currentlyRunning: false,
      note: `This ApexTrigger is ${status} — it does not run in the org today, so disabling it changes no runtime behaviour. structuralVerdict below describes what WOULD stop if it were Active. That is NOT a claim that nothing depends on it: ${dependentCount} dependent(s) are listed in impacts, and they will be affected if it is ever reactivated.`,
    };
  }
  return {
    status: status.length > 0 ? status : null,
    currentlyRunning: null,
    note: UNKNOWN_RUNTIME_STATE_NOTE,
  };
};

/**
 * Comparator for the deterministic impact sort. Sort first by
 * `category` ASC then by `componentId` ASC so related blockers stay
 * grouped in the rendered output.
 */
const compareImpacts = (a: WhatIfImpactItem, b: WhatIfImpactItem): number => {
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  return 0;
};

/**
 * Find the trigger's `triggersOn` target — the
 * `CustomObject:{ApiName}` the trigger handler attaches to. Returns
 * `null` for triggers without a declared `triggersOn` (which should
 * not happen in practice with the v0.1 extractor — every trigger
 * emits the edge declaratively) and sparse-graph misses. The renderer
 * uses the scalar for the "automation on Account" line; the impacts
 * array carries the same identity for the structural-diff path.
 */
const findParentObject = async (
  ctx: Context,
  triggerId: ComponentId,
): Promise<Result<ComponentId | null, string>> => {
  const edgesResult = await listEdges(ctx.graph, triggerId, {
    direction: 'out',
    edgeType: 'triggersOn',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const firstEdge = edgesResult.value[0];
  if (firstEdge === undefined) return ok(null);
  return ok(firstEdge.toId);
};

/**
 * The `sfi.what_if_disable_trigger` MCP tool. Given an ApexTrigger
 * id, returns the structured downstream impact, the parent object,
 * the lifecycle events affected, an aggregated severity verdict, and
 * the verbatim boundary disclosure. See the module JSDoc for the
 * classification rules.
 *
 * @example
 *   const r = await whatIfDisableTriggerHandler(ctx, {
 *     triggerId: 'ApexTrigger:AccountTrigger',
 *   });
 *   if (r.ok) console.log(r.value.data.parentObject, r.value.data.events);
 */
export const whatIfDisableTriggerHandler = async (
  ctx: Context,
  input: WhatIfDisableTriggerInput,
): Promise<Result<McpResponse<WhatIfDisableTriggerOutput>, McpError>> => {
  if (!input.triggerId.startsWith(APEX_TRIGGER_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `triggerId must start with '${APEX_TRIGGER_PREFIX}'; got '${input.triggerId}'`,
      path: 'triggerId',
    });
  }

  const triggerId = input.triggerId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, triggerId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, triggerId, 'ApexTrigger'),
      path: triggerId,
    });
  }

  const triggerNode = nodeResult.value;

  // Defensive: the prefix pins the expected type, but the graph
  // round-trip could in principle return a different `type`. Treat
  // that as `component-not-found` since the caller's request cannot
  // be satisfied by what the vault holds.
  if (triggerNode.type !== 'ApexTrigger') {
    return err({
      kind: 'component-not-found',
      message: `node ${triggerId} is not an ApexTrigger (type=${triggerNode.type})`,
      path: triggerId,
    });
  }

  // Walk every outgoing edge; each non-structural one is a potential
  // impact.
  const edgesResult = await listEdges(ctx.graph, triggerId, {
    direction: 'out',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  const impacts: WhatIfImpactItem[] = [];
  const entryPoints: WhatIfEntryPoint[] = [];
  for (const edge of edgesResult.value) {
    // `parentOf` is structural — the trigger's container relationship —
    // and never an impact. `firesWhen` is the deferred v2.0a.1
    // apex-scanner if-guard surface; if a future enricher emits it
    // from a trigger we'd want to skip it here too (mirrors
    // `what-if-deactivate-flow`'s handling).
    if (edge.edgeType === 'parentOf' || edge.edgeType === 'firesWhen') continue;
    const toResult = await getNodeById(ctx.graph, edge.toId);
    if (!toResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${toResult.error.message}`,
      });
    }
    const toNode = toResult.value;
    if (toNode === null) {
      // Sparse-graph case: drop silently.
      continue;
    }
    // The trigger's OWN entry points are recategorised here, not dropped: the
    // node is resolved first, so an `entryPoints` row can never name an id the
    // graph has no node for.
    const entryNote = entryPointNoteFor(edge.edgeType);
    if (entryNote !== undefined) {
      entryPoints.push({
        kind: edge.edgeType as WhatIfEntryPoint['kind'],
        componentId: toNode.id,
        note: entryNote,
      });
      continue;
    }
    const { category } = classifyOutgoingEdge(edge);
    impacts.push({
      category,
      componentId: toNode.id,
      componentType: toNode.type,
      apiName: toNode.apiName,
      confidence: edge.confidence,
      explanation: buildExplanation(toNode, edge, triggerNode.apiName),
    });
  }

  const sortedImpacts = [...impacts].sort(compareImpacts);
  const sortedEntryPoints = [...entryPoints].sort((a, b) =>
    a.kind !== b.kind
      ? a.kind < b.kind
        ? -1
        : 1
      : a.componentId < b.componentId
        ? -1
        : a.componentId > b.componentId
          ? 1
          : 0,
  );

  const parentObjectResult = await findParentObject(ctx, triggerId);
  if (!parentObjectResult.ok) {
    return err({ kind: 'internal', message: parentObjectResult.error });
  }

  // The STRUCTURAL axis is what gets coverage-downgraded: "nothing depends on
  // this" is a coverage-dependent claim. "It is already switched off" is not,
  // so the headline `already-inactive` is never downgraded.
  const rawVerdict = aggregateVerdict(sortedImpacts);
  const coverage = attachCoverageToWhatIf(
    ctx,
    TRIGGER_DISABLE_REQUIRED_COVERAGE,
    'Trigger disable impact',
    rawVerdict,
  );
  const structuralVerdict = coverage.verdict as Verdict;

  const status = readTriggerStatus(triggerNode);
  const dependentCount = sortedImpacts.filter(isVerdictBearing).length;
  const runtimeState = resolveRuntimeState(status, dependentCount);
  // `currentlyRunning === null` (status unknown) deliberately does NOT take
  // this branch: an unrecorded status is not evidence the trigger is off.
  const verdict: TriggerDisableVerdict =
    runtimeState.currentlyRunning === false
      ? 'already-inactive'
      : structuralVerdict;

  return ok({
    data: {
      triggerId,
      apiName: triggerNode.apiName,
      status,
      parentObject: parentObjectResult.value,
      events: readTriggerEvents(triggerNode),
      entryPoints: sortedEntryPoints,
      impacts: sortedImpacts,
      runtimeState,
      verdict,
      structuralVerdict,
      ...(dependentCount === 0
        ? { notProvenHarmless: NOT_PROVEN_HARMLESS }
        : {}),
      ...(coverage.coverageCaveat !== undefined
        ? { coverageCaveat: coverage.coverageCaveat }
        : {}),
      trust: coverage.trust,
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
