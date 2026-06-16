/**
 * Handler for the `sfi.what_if_deactivate_flow` MCP tool.
 *
 * v2.3 R2b — the first of three component-level what-if composers.
 * Given a Flow canonical id (`Flow:{ApiName}`), enumerates the
 * downstream impact of deactivating the Flow: every outgoing edge the
 * Flow has becomes a potential lost-effect when the Flow no longer
 * fires. Pairs with R2a's field-level tools (`what_if_change_field_type`,
 * `what_if_remove_picklist_value`, `what_if_make_field_required`) and
 * R2c's profile-level tools (`what_if_merge_profiles`,
 * `what_if_split_profile`) to complete the v2.3 what-if catalogue.
 *
 * **What deactivation breaks.** Deactivating a Flow means none of its
 * actions run anymore. The composer walks each outgoing edge type the
 * Flow emits and projects a per-edge `WhatIfImpactItem`:
 *
 *   | Outgoing edge | What it represented | Impact category    | Verdict   |
 *   |---------------|---------------------|--------------------|-----------|
 *   | triggersOn    | The object the Flow listened to | metadata-blocker | blocking |
 *   | callsApex     | Apex action calls the Flow made | code-needs-update | risky |
 *   | readsFrom     | Record lookups the Flow performed | metadata-blocker | blocking |
 *   | writesTo      | Record writes (creates/updates/deletes) | metadata-blocker | blocking |
 *   | sendsEmail    | Email templates the Flow sent     | metadata-blocker | blocking |
 *
 * Outgoing structural edges (`parentOf`, `firesWhen`) are NOT impacts:
 * they describe the Flow's own composition, not its downstream effect.
 * `firesWhen` IS surfaced separately in the response's `firingConditions`
 * field — those are the conditions under which the Flow currently fires
 * (the conditions the deactivation would silence), and the caller may
 * want to render them so the user understands what gating logic is
 * being removed.
 *
 * **Aggregate verdict.** Mirrors R2a's `WhatIfChangeFieldType` verdict
 * cascade:
 *   - `safe` if there are NO impacts at all (a Flow that exists but
 *     does nothing — the deactivation has no observable effect).
 *   - `blocking` if ANY `metadata-blocker` impact appears (record
 *     writes / reads / triggers / email sends would silently stop).
 *   - `risky` if no `metadata-blocker` but at least one
 *     `code-needs-update` impact (Apex calls the Flow made are now
 *     skipped; downstream callers may not realise the side-effect path
 *     stopped).
 *   - `unknown` is reserved (never returned by this tool — the Flow
 *     either has impacts or it doesn't).
 *
 * **Honesty axis.** v2.3 surfaces the verbatim disclosure per the
 * WhatIfSemantics.md fail-conservative posture. Deactivation does NOT
 * delete the Flow — its definition remains in the org and a later
 * reactivation restores every effect listed. Apex code that conditionally
 * invokes the Flow's outputs (via `Flow.Interview` or an
 * `@InvocableMethod` chain) is invisible to the heuristic walker; the
 * caller should spot-check Apex callers via `sfi.find_code_usages`
 * targeting the Flow id.
 *
 * Implementation notes:
 *   - `flowId` is required to start with `Flow:`. Other prefixes return
 *     `invalid-query` at the handler boundary. The Zod schema can only
 *     enforce non-emptiness; the prefix check lives in this module.
 *   - Unknown ids resolve to `component-not-found`. The graph cannot
 *     distinguish "Flow never existed" from "Flow was deleted between
 *     vault refresh and tool invocation".
 *   - For each outgoing edge, `getNodeById(edge.toId)` resolves the
 *     downstream node's identity (`type`, `apiName`). Sparse-graph
 *     misses (an edge whose target was dropped) are silently skipped —
 *     matches the tolerance every other composition tool uses.
 *   - The `firingConditions` array is sourced from the Flow's outgoing
 *     `firesWhen` edges (the v2.0a ConditionalContext primitive). Each
 *     entry carries the synthetic conditionContextId and the parsed
 *     expression so the renderer can inline the gating predicate
 *     without an extra graph roundtrip.
 *   - Impacts are sorted by `(category, componentId)` ASC for
 *     deterministic output. The category tiebreaker keeps related
 *     blockers grouped together when the renderer flattens the list.
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
import { getNodeById, listEdges, resolveComponents } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import {
  attachCoverageToWhatIf,
  type CoverageCaveat,
  FLOW_DEACTIVATION_REQUIRED_COVERAGE,
  type Verdict,
} from './coverage-trust.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix for the Flow node type. */
const FLOW_PREFIX = 'Flow:';

/**
 * One finding category in the `WhatIfImpactItem` shape, mirroring
 * R2a's `what-if-change-field-type.ts` definition. The composer module
 * uses the same union across every v2.3 tool so the
 * `architect-what-if-analysis` skill can group by category uniformly.
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
 * — scoped to the fields v2.3 R2 populates. The full R1b contract
 * (with `location` + `suggestedAction`) is deferred to the R1b plan
 * worker.
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
 * One condition currently gating the Flow's firing. Sourced from the
 * Flow's outgoing `firesWhen` edges (the v2.0a ConditionalContext
 * primitive). Each entry carries the synthetic conditionContextId and
 * the parsed expression so the renderer can inline the predicate
 * without an extra graph traversal. The caller may render this list
 * before the impacts to set context ("the Flow currently fires when
 * X; deactivating it stops these effects").
 */
export interface WhatIfDeactivateFlowFiringCondition {
  readonly conditionContextId: ComponentId;
  readonly expression: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfDeactivateFlowOutput {
  readonly flowId: ComponentId;
  readonly apiName: string;
  readonly status: string;
  readonly firingConditions: readonly WhatIfDeactivateFlowFiringCondition[];
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
 * tool surface uniform.
 */
const DISCLOSURE =
  "v2.3 what-if analysis is composition over the v2.2 vault state. Deactivating a Flow stops every action listed in impacts; the Flow's definition remains in the org and a later reactivation restores the effects. Apex code that conditionally invokes the Flow via Flow.Interview or @InvocableMethod chains is invisible to the heuristic walker; review callers via sfi.find_code_usages targeting the Flow id before relying on this finding.";

/**
 * Zod schema for the `sfi.what_if_deactivate_flow` tool input.
 *
 *   - `flowId`: required, non-empty string. Accepts three forms:
 *       1. Canonical Flow id (`Flow:{ApiName}`) — looked up directly.
 *       2. Bare API name (`{ApiName}`) — coerced to `Flow:{ApiName}`.
 *       3. Flow label or partial name (e.g. `"Consent Flow"`) — when the
 *          direct lookup finds nothing, the handler does an internal fuzzy
 *          search (resolveComponents filtered to `Flow` type) and returns
 *          a single-match auto-resolve, a multiple-candidates list, or a
 *          no-match error as appropriate.
 */
export const whatIfDeactivateFlowInputSchema = z.object({
  flowId: z.string().min(1),
});

/** Parsed input shape, inferred from the Zod schema. */
export type WhatIfDeactivateFlowInput = z.infer<
  typeof whatIfDeactivateFlowInputSchema
>;

/**
 * Strip the canonical-id prefix to surface the bare ApiName the
 * renderer wants. Malformed ids (no colon) pass through verbatim so
 * the response shape stays stable.
 */
const stripPrefix = (id: ComponentId): string => {
  const colonIdx = id.indexOf(':');
  return colonIdx < 0 ? id : id.slice(colonIdx + 1);
};

/**
 * Pull the Flow's `status` property. The Flow extractor enforces the
 * `Active` / `Draft` / `Obsolete` / `InvalidDraft` enum at extraction
 * time; the empty-string fallback shouldn't fire in practice but keeps
 * the response shape stable for malformed inputs.
 */
const readFlowStatus = (node: Node): string => {
  const raw = node.properties['status'];
  return typeof raw === 'string' ? raw : '';
};

/**
 * Classify one outgoing edge into a `(category, verdict)` pair. The
 * rule table is documented in the module JSDoc above. `triggersOn`,
 * `readsFrom`, `writesTo`, and `sendsEmail` are metadata-declared
 * (the Flow XML names them literally) so the verdict is `blocking`;
 * `callsApex` is `code-needs-update` because the called Apex class
 * may have side effects the Flow's deactivation now skips. Unknown
 * edge types fall through to `configuration-only` / `risky` so the
 * caller still sees the finding rather than the tool silently
 * dropping it.
 */
const classifyOutgoingEdge = (
  edge: Edge,
): { category: Category; verdict: Verdict } => {
  switch (edge.edgeType) {
    case 'triggersOn':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    case 'callsApex':
      return { category: 'code-needs-update', verdict: 'risky' };
    case 'readsFrom':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    case 'writesTo':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    case 'sendsEmail':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    default:
      return { category: 'configuration-only', verdict: 'risky' };
  }
};

/**
 * Synthesise the per-finding `explanation` string. The phrasing
 * mirrors R2a's `what-if-change-field-type.ts` `buildExplanation` so
 * the renderer can rely on a uniform "the Flow does X to component Y"
 * shape across the v2.3 surface.
 */
const buildExplanation = (
  toNode: Node,
  edge: Edge,
  flowApiName: string,
): string => {
  const verb =
    edge.edgeType === 'writesTo'
      ? 'writes to'
      : edge.edgeType === 'readsFrom'
        ? 'reads from'
        : edge.edgeType === 'callsApex'
          ? 'calls'
          : edge.edgeType === 'triggersOn'
            ? 'triggers on'
            : edge.edgeType === 'sendsEmail'
              ? 'sends email via'
              : 'references';
  return `Flow '${flowApiName}' ${verb} ${toNode.type} '${toNode.apiName}'; deactivating the Flow stops this action.`;
};

/**
 * Aggregate the per-impact verdicts into the headline severity. The
 * cascade mirrors R2a's `aggregateVerdict`:
 *   - empty impacts → `safe`.
 *   - any `metadata-blocker` → `blocking`.
 *   - any non-blocker `code-needs-update` / `integration-touch` → `risky`.
 *   - only `configuration-only` → `risky` (the finding still warrants
 *     attention even though the deploy itself won't fail).
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
 * Surface every `firesWhen` ConditionalContext the Flow points at.
 * Each entry carries the synthetic conditionContextId and the parsed
 * expression text. Sparse-graph misses (an edge whose target
 * ConditionalContext was dropped) are silently skipped. Mirrors
 * `explain-flow.ts`'s `collectTriggerConditions` shape so callers can
 * reuse the same renderer code for both tools.
 */
const collectFiringConditions = async (
  ctx: Context,
  flowId: ComponentId,
): Promise<Result<readonly WhatIfDeactivateFlowFiringCondition[], string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'firesWhen',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const out: WhatIfDeactivateFlowFiringCondition[] = [];
  for (const edge of edgesResult.value) {
    const nodeResult = await getNodeById(ctx.graph, edge.toId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    if (nodeResult.value === null) continue;
    const expressionRaw = nodeResult.value.properties['expression'];
    out.push({
      conditionContextId: nodeResult.value.id,
      expression: typeof expressionRaw === 'string' ? expressionRaw : '',
    });
  }
  return ok(out);
};

/**
 * Core impact-analysis logic given an already-resolved Flow node and its
 * canonical id. Extracted so the fuzzy-resolution path can delegate here
 * without duplicating the edge-walk.
 */
const whatIfDeactivateFlowFromNode = async (
  ctx: Context,
  flowId: ComponentId,
  flowNode: Node,
): Promise<Result<McpResponse<WhatIfDeactivateFlowOutput>, McpError>> => {
  // Walk every outgoing edge; each non-structural one is a potential
  // impact.
  const edgesResult = await listEdges(ctx.graph, flowId, {
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
    // Structural edges: `parentOf` is the Flow's container relationship,
    // `firesWhen` is the gating-condition primitive surfaced separately
    // in `firingConditions`. Neither is a downstream impact.
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
      // Sparse-graph case: the edge points at an id the graph has no
      // node row for. Drop silently — matches the tolerance every
      // other composition tool uses.
      continue;
    }
    const { category } = classifyOutgoingEdge(edge);
    impacts.push({
      category,
      componentId: toNode.id,
      componentType: toNode.type,
      apiName: toNode.apiName,
      confidence: edge.confidence,
      explanation: buildExplanation(toNode, edge, flowNode.apiName),
    });
  }

  // Second hop (bug 15): if this flow PUBLISHES a platform event (a `writesTo`
  // edge to a `__e` object — a recordCreate on the event), deactivating it
  // stops that event from firing, so every flow / trigger that SUBSCRIBES to
  // the event (an incoming `listensTo` edge) loses its trigger. Those
  // subscribers are not reachable by the single outgoing-edge walk above —
  // they sit one hop past the event object — so surface them explicitly.
  const seenSubscribers = new Set<string>(impacts.map((i) => i.componentId));
  for (const edge of edgesResult.value) {
    if (edge.edgeType !== 'writesTo') continue;
    if (!edge.toId.startsWith('CustomObject:') || !edge.toId.endsWith('__e')) continue;
    const subsResult = await listEdges(ctx.graph, edge.toId, {
      direction: 'in',
      edgeType: 'listensTo',
    });
    if (!subsResult.ok) {
      return err({ kind: 'internal', message: subsResult.error.message });
    }
    const eventApiName = edge.toId.slice('CustomObject:'.length);
    for (const sub of subsResult.value) {
      if (sub.fromId === flowId || seenSubscribers.has(sub.fromId)) continue;
      const subResult = await getNodeById(ctx.graph, sub.fromId);
      if (!subResult.ok) {
        return err({ kind: 'internal', message: subResult.error.message });
      }
      const subNode = subResult.value;
      if (subNode === null) continue;
      seenSubscribers.add(subNode.id);
      impacts.push({
        category: 'metadata-blocker',
        componentId: subNode.id,
        componentType: subNode.type,
        apiName: subNode.apiName,
        confidence: 'heuristic',
        explanation:
          `Subscribes to the platform event ${eventApiName}, which this flow ` +
          `publishes. Deactivating this flow stops that event, so this ` +
          `subscriber will no longer be triggered by it.`,
      });
    }
  }

  const sortedImpacts = [...impacts].sort(compareImpacts);

  const firingConditionsResult = await collectFiringConditions(ctx, flowId);
  if (!firingConditionsResult.ok) {
    return err({ kind: 'internal', message: firingConditionsResult.error });
  }

  const rawVerdict = aggregateVerdict(sortedImpacts);
  const coverage = attachCoverageToWhatIf(
    ctx,
    FLOW_DEACTIVATION_REQUIRED_COVERAGE,
    'Flow deactivation impact',
    rawVerdict,
  );

  // The deactivation tool surfaces a stripped apiName for caller
  // convenience (so the renderer can render "Flow X" rather than
  // "Flow:X"). The node's own `apiName` field already carries this,
  // but we run it through `stripPrefix` as a defensive guard against
  // extractor drift.
  const apiName =
    flowNode.apiName.length > 0 ? flowNode.apiName : stripPrefix(flowId);

  return ok({
    data: {
      flowId,
      apiName,
      status: readFlowStatus(flowNode),
      firingConditions: firingConditionsResult.value,
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

/**
 * The `sfi.what_if_deactivate_flow` MCP tool. Given a Flow id, label, or
 * partial name, returns the structured downstream impact, the current firing
 * conditions, an aggregated severity verdict, and the verbatim boundary
 * disclosure. See the module JSDoc for the classification rules.
 *
 * When a non-canonical input is passed (e.g. a flow label like "Consent Flow"
 * or a partial api name), the handler attempts an internal fuzzy resolution
 * via `resolveComponents` filtered to Flow type before falling through to
 * `component-not-found`.
 *
 * @example
 *   const r = await whatIfDeactivateFlowHandler(ctx, {
 *     flowId: 'Flow:Account_Notify',
 *   });
 *   if (r.ok) console.log(r.value.data.verdict, r.value.data.impacts.length);
 */
export const whatIfDeactivateFlowHandler = async (
  ctx: Context,
  input: WhatIfDeactivateFlowInput,
): Promise<Result<McpResponse<WhatIfDeactivateFlowOutput>, McpError>> => {
  const coercedFlowId = coercePrefix(input.flowId, [FLOW_PREFIX]);
  if (!coercedFlowId.startsWith(FLOW_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `flowId must be a Flow id (e.g. '${FLOW_PREFIX}My_Flow'), a bare flow api name, or a flow label; got '${input.flowId}'`,
      path: 'flowId',
    });
  }

  const flowId = coercedFlowId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, flowId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    // Canonical `Flow:ApiName` that misses is a hard not-found — do NOT fuzzy
    // retry on the full id string (would false-positive match unrelated flows).
    if (input.flowId.startsWith(FLOW_PREFIX)) {
      return err({
        kind: 'component-not-found',
        message: `No flow found with id '${flowId}'. Use sfi.list_components with type Flow to see available flows.`,
        path: 'flowId',
      });
    }
    // Bare api name / label / partial name: fuzzy resolve via resolveComponents.
    const fuzzyResult = await resolveComponents(ctx.graph, input.flowId, {
      types: ['Flow'],
      limit: 5,
    });
    if (!fuzzyResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${fuzzyResult.error.message}`,
      });
    }
    const { disposition, candidates } = fuzzyResult.value;
    if (disposition === 'none' || candidates.length === 0) {
      return err({
        kind: 'component-not-found',
        message: `No flow found matching '${input.flowId}'. Use sfi.list_components with type Flow to see available flows.`,
        path: 'flowId',
      });
    }
    if (disposition === 'ambiguous' || candidates.length > 1) {
      const list = candidates
        .map((c) => `  • ${c.id}${c.label ? ` (${c.label})` : ''}`)
        .join('\n');
      return err({
        kind: 'invalid-query',
        message: `Multiple flows match '${input.flowId}'. Specify one of:\n${list}`,
        path: 'flowId',
      });
    }
    // disposition === 'exact' and exactly one candidate — auto-resolve.
    const resolvedId = candidates[0]!.id as ComponentId;
    const resolvedNodeResult = await getNodeById(ctx.graph, resolvedId);
    if (!resolvedNodeResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${resolvedNodeResult.error.message}`,
      });
    }
    if (resolvedNodeResult.value === null) {
      return err({
        kind: 'component-not-found',
        message: await phantomAwareNotFoundMessage(ctx, resolvedId, 'Flow'),
        path: resolvedId,
      });
    }
    const resolvedFlowNode = resolvedNodeResult.value;
    if (resolvedFlowNode.type !== 'Flow') {
      return err({
        kind: 'component-not-found',
        message: `resolved node ${resolvedId} is not a Flow (type=${resolvedFlowNode.type})`,
        path: 'flowId',
      });
    }
    return whatIfDeactivateFlowFromNode(ctx, resolvedId, resolvedFlowNode);
  }

  const flowNode = nodeResult.value;

  // Defensive: the prefix pins the expected type, but the graph
  // round-trip could in principle return a different `type`. Treat
  // that as `component-not-found` since the caller's request cannot
  // be satisfied by what the vault holds.
  if (flowNode.type !== 'Flow') {
    return err({
      kind: 'component-not-found',
      message: `node ${flowId} is not a Flow (type=${flowNode.type})`,
      path: flowId,
    });
  }

  return whatIfDeactivateFlowFromNode(ctx, flowId, flowNode);
};
