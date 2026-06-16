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
 *   | Outgoing edge | What it represented | Impact category    | Verdict   |
 *   |---------------|---------------------|--------------------|-----------|
 *   | triggersOn    | The object the trigger listens to | metadata-blocker | blocking |
 *   | callsApex     | Apex classes the trigger invokes  | code-needs-update | risky |
 *   | dispatchesAsync | Async jobs the trigger queues   | code-needs-update | risky |
 *   | readsFrom     | Fields the trigger reads          | code-needs-update | risky |
 *   | writesTo      | Fields the trigger writes         | metadata-blocker | blocking |
 *   | listensTo     | Platform Event subscription       | metadata-blocker | blocking |
 *
 * The verdict differential between `readsFrom` (`risky`) and `writesTo`
 * (`blocking`) reflects the fail-conservative posture: a write the
 * trigger silently stops doing is a behavior change other downstream
 * automation may rely on; a read the trigger silently stops doing
 * usually just means the trigger no longer evaluates a guard. Both
 * are surfaced; the verdict difference drives renderer grouping.
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
 * **Aggregate verdict.** Mirrors R2a's `WhatIfChangeFieldType` and
 * the sibling `WhatIfDeactivateFlow`:
 *   - `safe` if there are NO impacts at all (a trigger that fires but
 *     does nothing of consequence — should never happen with the v0.1
 *     extractor's mandatory `triggersOn` emission).
 *   - `blocking` if ANY `metadata-blocker` impact appears (the
 *     declared `triggersOn` to the parent object plus any writes/Platform
 *     Event subscription).
 *   - `risky` if no `metadata-blocker` but at least one
 *     `code-needs-update` impact.
 *
 * **Honesty axis.** v2.3 surfaces the verbatim disclosure per the
 * WhatIfSemantics.md fail-conservative posture. Disabling is a
 * runtime metadata flag, not a deletion: the trigger remains in the
 * org and a later re-enable restores every effect listed. The v0.3
 * apex-scanner's edge confidence is `heuristic` for most outgoing
 * edges (regex-based token-pair extraction); the caller should
 * spot-check the trigger body when a finding's confidence is
 * `heuristic`. Indirect dispatch via trigger frameworks
 * (TriggerHandler base class, fflib) is partially invisible to the
 * heuristic walker — the WhatIfSemantics.md "Trigger framework
 * recognition partial" boundary disclosure applies.
 *
 * Implementation notes:
 *   - `triggerId` is required to start with `ApexTrigger:`. Other
 *     prefixes return `invalid-query` at the handler boundary.
 *   - Unknown ids resolve to `component-not-found`.
 *   - For each outgoing edge, `getNodeById(edge.toId)` resolves the
 *     downstream node's identity. Sparse-graph misses are silently
 *     dropped — matches the tolerance every other composition tool
 *     uses.
 *   - The `triggersOn` edge is surfaced both as the `parentObject`
 *     scalar (the renderer's "automation on Account" line) AND as an
 *     impact entry (the structural diff the deactivation produces).
 *     Surfacing it twice keeps the impact list complete while giving
 *     the renderer fast access to the parent identity.
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
  | 'configuration-only';

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

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfDisableTriggerOutput {
  readonly triggerId: ComponentId;
  readonly apiName: string;
  readonly status: string;
  readonly parentObject: ComponentId | null;
  readonly events: readonly string[];
  readonly impacts: readonly WhatIfImpactItem[];
  readonly verdict: Verdict;
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
  "v2.3 what-if analysis is composition over the v2.2 vault state. Disabling a trigger stops every action listed in impacts; the trigger definition remains in the org and a later re-enable restores the effects. The v0.3 apex-scanner's edge confidence is heuristic for most outgoing edges; spot-check the trigger body when a finding's confidence is heuristic. Indirect dispatch via trigger framework base classes (TriggerHandler, fflib) may be partially invisible to the recognizer.";

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
 * Classify one outgoing edge into a `(category, verdict)` pair. The
 * rule table is documented in the module JSDoc above.
 *   - `triggersOn` and `listensTo` are declared metadata: disabling
 *     the trigger removes the runtime handler for the SObject /
 *     Platform Event subscription. Blocking.
 *   - `writesTo` is metadata-declared from the v0.3 apex-scanner;
 *     stopping a write is a behavior change other automation may
 *     depend on. Blocking.
 *   - `callsApex` and `dispatchesAsync` are code-needs-update: the
 *     called class may have side effects the trigger's deactivation
 *     now skips.
 *   - `readsFrom` is also code-needs-update with `risky`: stopping a
 *     read usually just means the trigger no longer evaluates a guard,
 *     but the caller still wants to see the finding.
 *   - Unknown edge types fall through to `configuration-only` /
 *     `risky` so the caller still sees the finding rather than the
 *     tool silently dropping it.
 */
const classifyOutgoingEdge = (
  edge: Edge,
): { category: Category; verdict: Verdict } => {
  switch (edge.edgeType) {
    case 'triggersOn':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    case 'listensTo':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    case 'writesTo':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    case 'callsApex':
      return { category: 'code-needs-update', verdict: 'risky' };
    case 'dispatchesAsync':
      return { category: 'code-needs-update', verdict: 'risky' };
    case 'readsFrom':
      return { category: 'code-needs-update', verdict: 'risky' };
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
  const verb =
    edge.edgeType === 'writesTo'
      ? 'writes to'
      : edge.edgeType === 'readsFrom'
        ? 'reads from'
        : edge.edgeType === 'callsApex'
          ? 'calls'
          : edge.edgeType === 'dispatchesAsync'
            ? 'dispatches async'
            : edge.edgeType === 'triggersOn'
              ? 'triggers on'
              : edge.edgeType === 'listensTo'
                ? 'subscribes to platform event'
                : 'references';
  return `ApexTrigger '${triggerApiName}' ${verb} ${toNode.type} '${toNode.apiName}'; disabling the trigger stops this action.`;
};

/**
 * Aggregate the per-impact verdicts into the headline severity. The
 * cascade mirrors R2a's `aggregateVerdict`.
 */
const aggregateVerdict = (impacts: readonly WhatIfImpactItem[]): Verdict => {
  if (impacts.length === 0) return 'safe';
  for (const impact of impacts) {
    if (impact.category === 'metadata-blocker') return 'blocking';
  }
  for (const impact of impacts) {
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

  const parentObjectResult = await findParentObject(ctx, triggerId);
  if (!parentObjectResult.ok) {
    return err({ kind: 'internal', message: parentObjectResult.error });
  }

  const rawVerdict = aggregateVerdict(sortedImpacts);
  const coverage = attachCoverageToWhatIf(
    ctx,
    TRIGGER_DISABLE_REQUIRED_COVERAGE,
    'Trigger disable impact',
    rawVerdict,
  );

  return ok({
    data: {
      triggerId,
      apiName: triggerNode.apiName,
      status: readTriggerStatus(triggerNode),
      parentObject: parentObjectResult.value,
      events: readTriggerEvents(triggerNode),
      impacts: sortedImpacts,
      verdict: coverage.verdict as Verdict,
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
