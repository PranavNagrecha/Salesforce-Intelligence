/**
 * Handler for the `sfi.downstream_effects` MCP tool.
 *
 * Answers the developer's "what does calling this class ultimately do?"
 * question. Composes a downstream `callsApex` walk from `classApiName`,
 * then for every reachable class (including the root) surfaces the
 * SIDE EFFECTS its outgoing edges describe:
 *
 *   - `writesTo` → field write
 *   - `dispatchesAsync` → enqueued Queueable / Schedulable / Batchable
 *     / `@future` job
 *   - `sendsEmail` → email template invocation
 *
 * (`callsApex` edges drive the reachability walk but are NOT surfaced as
 * effects — the caller wants the EFFECTS, not the call chain; HTTP callouts
 * are out of scope per the disclosure.)
 *
 * **Composition model**:
 *   1. BFS downstream over `callsApex` from the root, bounded by
 *      `maxDepth`. The walk reuses the same cycle-detection logic as
 *      `sfi.call_graph` but only collects the node set (the call edges
 *      themselves are not surfaced — the caller wants the EFFECTS,
 *      not the chain).
 *   2. For each reachable class, list outgoing `writesTo`,
 *      `dispatchesAsync`, and `sendsEmail` edges. Each one becomes a
 *      `DownstreamEffect` entry categorised by edgeType.
 *   3. Categorisation: `field-write` for `writesTo`, `async-dispatch`
 *      for `dispatchesAsync`, `email` for `sendsEmail`. Callouts are
 *      NOT a separate v2.7 edge type (no `Apex.Http.send` extractor
 *      yet); the disclosure surfaces this gap explicitly.
 *
 * **CustomObject root (RTG-04)**:
 *   When a `CustomObject:` id is passed instead of an Apex id, the tool
 *   discovers automation via the graph's two attachment patterns (mirrors
 *   `sfi.order_of_execution`):
 *     - incoming `triggersOn` → ApexTrigger, Flow, WorkflowRule
 *     - outgoing `parentOf` → ApprovalProcess (parented on the object;
 *       ApprovalProcess does NOT emit `triggersOn`)
 *   For each firer: collect direct `writesTo` / `sendsEmail` /
 *   `dispatchesAsync` edges (Flow field updates, WorkflowRule alerts,
 *   ApprovalProcess step emails), then BFS `callsApex` to surface Apex
 *   side effects from workflow/approval/flow actions and trigger handlers.
 *   The `automationNodes` list and flattened `effects` slice together
 *   answer "what automation runs on this object and what does it do".
 *
 * **Granularity (v2.7 honesty boundary)**: the underlying call walk
 * operates at CLASS granularity. The disclosure carries the verbatim
 * promise of method-level edge resolution in v2.7.1.
 *
 * Implementation notes:
 *   - `getNodeById` resolves each effect's `targetId` for `apiName` /
 *     `type` enrichment; sparse-graph misses are dropped.
 *   - Output is sorted by `(sourceClassId, category, targetId)` ASC
 *     for deterministic output.
 *   - Unknown root surfaces as `component-not-found`. Invalid prefix
 *     surfaces as `invalid-query`.
 */

import type {
  ComponentId,
  ComponentType,
  EdgeType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { edgeMethods } from './calls-apex-methods.js';
import { coercePrefix } from './coerce-id.js';
import { mergeInputAliases } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Inclusive upper bound on `maxDepth`. */
const DOWNSTREAM_EFFECTS_MAX_DEPTH = 5;
/** Default `maxDepth` when the caller omits it. */
const DOWNSTREAM_EFFECTS_DEFAULT_DEPTH = 3;

/** Canonical id prefixes the tool accepts. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';

/** Firers discovered via incoming `triggersOn` on the object. */
const TRIGGERS_ON_AUTOMATION_TYPES = new Set<ComponentType>([
  'ApexTrigger',
  'Flow',
  'WorkflowRule',
]);

/** Firers discovered via outgoing `parentOf` from the object (no `triggersOn`). */
const PARENTED_AUTOMATION_TYPES = new Set<ComponentType>(['ApprovalProcess']);

/**
 * Verbatim v2.7 honesty disclosure. Method-level call resolution is
 * deferred to v2.7.1; callouts are out of scope until v2.7.x ships an
 * `Apex.Http.send` recognizer.
 */
/**
 * Appended to the disclosure when the effects list is EMPTY
 * (P14-USAGE-downstream-effects-honesty): with Apex email, HTTP callouts,
 * and record deletes invisible to the three modeled effect edges, an empty
 * list is "no MODELED effects" — never "this code has no side effects".
 */
const EMPTY_EFFECTS_NOTE =
  ' EMPTY effects list = no MODELED effects found — NOT "this code has no side effects": Apex email (Messaging.sendEmail), HTTP callouts, and DML deletes are all invisible to the modeled effect edges, so a class doing any of those reports zero effects here. Read the class source before concluding it is side-effect-free.';

const DOWNSTREAM_DISCLOSURE =
  'downstream_effects walks downstream callsApex from the root. Optional `method` narrows the root\'s DIRECT outgoing calls to edges whose `methods[]` (P4-C5) include that target method — e.g. `method: "deleteRecord"` follows only callees invoked via `deleteRecord` from the root class; deeper hops are unfiltered (their methods belong to other targets). The CALLER-side method (which method of the root body performs each call) is available on AST-extracted callsApex edges via `callerMethods` (surfaced by call_graph) but downstream_effects does NOT surface it here. HTTP callouts (Http.send, HTTPRequest invocation) are NOT recognized as effects. Of the three effect edges, only field writes and async dispatch originate from Apex; the `sendsEmail` edge is DECLARATIVE-only (WorkflowRule / ApprovalProcess / AutoResponseRule / AssignmentRule / EscalationRule → EmailTemplate), so Apex email via `Messaging.sendEmail()` is INVISIBLE here — an Apex-rooted walk reports email:0 even for a class that sends email. DML record deletes are likewise not modeled. The async-dispatch category now includes CLASS-GRANULAR `@future` edges (CR-CAP-09, `properties.dispatchMechanism: "future"`, `granularity: "class"`, heuristic): they fire when the called class has SOME `@future` method, not necessarily the invoked one, so async-dispatch may OVER-attribute a `@future` hop to a synchronous call. Cross-check the class source for `Messaging.sendEmail`, deletes, and callouts before treating the effect list as complete.';

/** Side-effect categories surfaced in the output. */
export type DownstreamEffectCategory =
  | 'field-write'
  | 'async-dispatch'
  | 'email';

/**
 * Zod schema for the `sfi.downstream_effects` tool input.
 *
 *   - `classApiName`: required, non-empty string. The canonical
 *     ApexClass / ApexTrigger / CustomObject id; non-matching prefixes
 *     surface as `invalid-query` at the handler boundary.
 *   - `maxDepth`: optional integer in `[1, 5]`. Defaults to 3.
 *   - `method`: optional. When set, only the root's direct `callsApex`
 *     edges whose `methods[]` include this target method are followed
 *     (mirrors `sfi.call_graph` downstream + `method` filter).
 */
const downstreamEffectsInputBaseSchema = z.object({
  classApiName: z.string().min(1),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(DOWNSTREAM_EFFECTS_MAX_DEPTH)
    .optional(),
  method: z.string().min(1).optional(),
});

export const downstreamEffectsInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [
      { canonical: 'classApiName', aliases: ['componentId'] },
    ]),
  downstreamEffectsInputBaseSchema,
);

/** Parsed input shape. */
export type DownstreamEffectsInput = z.infer<
  typeof downstreamEffectsInputSchema
>;

/** One categorized side effect surfaced from a reachable class. */
export interface DownstreamEffect {
  readonly sourceClassId: ComponentId;
  readonly sourceClassApiName: string;
  readonly category: DownstreamEffectCategory;
  readonly targetId: ComponentId;
  readonly targetType: ComponentType | null;
  readonly targetApiName: string | null;
  readonly edgeType: EdgeType;
  readonly edgeSource: string;
}

/** Per-category counter across the full effects slice. */
export interface DownstreamEffectsSummary {
  readonly fieldWrite: number;
  readonly asyncDispatch: number;
  readonly email: number;
}

/**
 * A single automation node attached to a CustomObject via `triggersOn`.
 * Returned only when the root is a `CustomObject:` id (RTG-04).
 */
export interface AutomationNode {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface DownstreamEffectsOutput {
  readonly rootId: ComponentId;
  readonly reachableClassCount: number;
  readonly effects: readonly DownstreamEffect[];
  readonly summary: DownstreamEffectsSummary;
  readonly disclosure: string;
  /**
   * Present only when `rootId` is a `CustomObject:` id (RTG-04).
   * Lists ApexTrigger / Flow / WorkflowRule (via `triggersOn`) and
   * ApprovalProcess (via `parentOf`). The `effects` slice merges direct
   * declarative side effects plus Apex effects reachable through each
   * firer's `callsApex` chain.
   */
  readonly automationNodes?: readonly AutomationNode[];
}

const isApexCallable = (id: string): boolean =>
  id.startsWith(APEX_CLASS_PREFIX) || id.startsWith(APEX_TRIGGER_PREFIX);

const isCustomObject = (id: string): boolean =>
  id.startsWith(CUSTOM_OBJECT_PREFIX);

const isAcceptedRoot = (id: string): boolean =>
  isApexCallable(id) || isCustomObject(id);

/**
 * Discover automation firers on a CustomObject using both graph attachment
 * patterns (RTG-04). ApprovalProcess is parented (`parentOf`); everything
 * else in scope attaches via `triggersOn`.
 */
const collectAutomationNodesForObject = async (
  ctx: Context,
  objectId: ComponentId,
): Promise<Result<Node[], string>> => {
  const byId = new Map<ComponentId, Node>();

  const triggersOnResult = await listEdges(ctx.graph, objectId, {
    direction: 'in',
    edgeType: 'triggersOn',
  });
  if (!triggersOnResult.ok) return err(triggersOnResult.error.message);
  // ONE batched fetch of every triggersOn source, replacing the per-edge
  // `getNodeById` N+1. `byId` is keyed by node id and re-sorted below, so the
  // per-edge Map lookup preserves the old null-skip + type-filter result.
  const triggerNodesResult = await listNodesByIds(
    ctx.graph,
    triggersOnResult.value.map((e) => e.fromId),
  );
  if (!triggerNodesResult.ok) return err(triggerNodesResult.error.message);
  const triggerNodeById = new Map(triggerNodesResult.value.map((n) => [n.id, n]));
  for (const edge of triggersOnResult.value) {
    const node = triggerNodeById.get(edge.fromId);
    if (node === undefined) continue;
    if (!TRIGGERS_ON_AUTOMATION_TYPES.has(node.type)) continue;
    byId.set(node.id, node);
  }

  const parentOfResult = await listEdges(ctx.graph, objectId, {
    direction: 'out',
    edgeType: 'parentOf',
  });
  if (!parentOfResult.ok) return err(parentOfResult.error.message);
  // ONE batched fetch of every parentOf child, replacing the per-edge
  // `getNodeById` N+1.
  const parentNodesResult = await listNodesByIds(
    ctx.graph,
    parentOfResult.value.map((e) => e.toId),
  );
  if (!parentNodesResult.ok) return err(parentNodesResult.error.message);
  const parentNodeById = new Map(parentNodesResult.value.map((n) => [n.id, n]));
  for (const edge of parentOfResult.value) {
    const node = parentNodeById.get(edge.toId);
    if (node === undefined) continue;
    if (!PARENTED_AUTOMATION_TYPES.has(node.type)) continue;
    byId.set(node.id, node);
  }

  return ok(
    [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
};

/**
 * BFS downstream from `rootId` over outgoing `callsApex` edges; returns
 * the set of reachable class ids (including the root). Bounded by
 * `maxDepth`; visited set prevents cycles.
 */
const collectReachableClasses = async (
  ctx: Context,
  rootId: ComponentId,
  maxDepth: number,
  /** P15: narrow root's direct callsApex edges to those invoking this method. */
  method: string | undefined,
): Promise<Result<Set<ComponentId>, string>> => {
  const visited = new Set<ComponentId>([rootId]);
  let frontier: ComponentId[] = [rootId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: ComponentId[] = [];
    // ONE batched fetch of the WHOLE frontier's outgoing callsApex edges,
    // replacing the per-frontier-node `listEdges` N+1. The returned reachability
    // is a Set — order-independent — and each per-node bucket carries the same
    // edges the old per-node `listEdges` returned, so the method-narrowed root
    // filter and the visited-set dedup produce the identical closure. Query
    // count is now one per DEPTH LEVEL, not one per frontier node.
    const edgeBatch = await listEdgesForNodes(ctx.graph, frontier, {
      direction: 'out',
      edgeTypes: ['callsApex'],
    });
    if (!edgeBatch.ok) return err(edgeBatch.error.message);
    for (const id of frontier) {
      for (const edge of edgeBatch.value.get(id) ?? []) {
        if (
          id === rootId &&
          method !== undefined &&
          !edgeMethods(edge).includes(method)
        ) {
          continue;
        }
        if (visited.has(edge.toId)) continue;
        visited.add(edge.toId);
        next.push(edge.toId);
      }
    }
    frontier = next;
  }
  return ok(visited);
};

/** Translate an edge type into its effect category, or null when it isn't a tracked effect. */
const categoryOf = (edgeType: EdgeType): DownstreamEffectCategory | null => {
  if (edgeType === 'writesTo') return 'field-write';
  if (edgeType === 'dispatchesAsync') return 'async-dispatch';
  if (edgeType === 'sendsEmail') return 'email';
  return null;
};

/**
 * Batched form: for EVERY (class id, apiName) entry, collect every outgoing
 * edge whose type categorises as a side effect, resolving each target node's
 * identity for the `targetType` / `targetApiName` fields.
 *
 * Two round-trips total regardless of class count: ONE `listEdgesForNodes` over
 * all class ids' outgoing edges, then ONE `listNodesByIds` over the distinct
 * effect-edge targets — replacing the former per-class `listEdges` + per-edge
 * `getNodeById` double N+1. Each per-class bucket is sorted by the FULL
 * (to_id, edge_type, from_id, source) order (from_id fixed per bucket), matching
 * the old per-class `listEdges(out)` order; the null-target skip is preserved
 * via a Map miss. The caller sorts (and, for the object path, dedupes) the
 * result, so effect order across classes is normalised regardless.
 */
const collectEffectsForClasses = async (
  ctx: Context,
  entries: readonly { readonly id: ComponentId; readonly apiName: string }[],
): Promise<Result<DownstreamEffect[], string>> => {
  if (entries.length === 0) return ok([]);
  const edgeBatch = await listEdgesForNodes(
    ctx.graph,
    entries.map((e) => e.id),
    { direction: 'out' },
  );
  if (!edgeBatch.ok) return err(edgeBatch.error.message);
  // Collect every categorised effect-edge target for ONE node batch.
  const targetIds: ComponentId[] = [];
  for (const entry of entries) {
    for (const edge of edgeBatch.value.get(entry.id) ?? []) {
      if (categoryOf(edge.edgeType) === null) continue;
      targetIds.push(edge.toId);
    }
  }
  const targetsRes = await listNodesByIds(ctx.graph, targetIds);
  if (!targetsRes.ok) return err(targetsRes.error.message);
  const targetById = new Map(targetsRes.value.map((n) => [n.id, n]));

  const effects: DownstreamEffect[] = [];
  for (const entry of entries) {
    for (const edge of edgeBatch.value.get(entry.id) ?? []) {
      const category = categoryOf(edge.edgeType);
      if (category === null) continue;
      const target = targetById.get(edge.toId);
      // Sparse-graph / unresolved-target case: the v0.3 apex-scanner emits
      // heuristic `writesTo` / `readsFrom` edges to `CustomField:<localVar>.*`
      // when it cannot resolve the receiver's object (the edge carries
      // `targetMissing: true`); that target node does not exist in the graph.
      // Mirror `what_if_disable_trigger`'s null-target handling and drop these
      // rather than surfacing a downstream effect with a null
      // `targetType`/`targetApiName` — counting a "field-write" to a field
      // that isn't in the graph over-reports the downstream surface.
      if (target === undefined) continue;
      effects.push({
        sourceClassId: entry.id,
        sourceClassApiName: entry.apiName,
        category,
        targetId: edge.toId,
        targetType: target.type,
        targetApiName: target.apiName,
        edgeType: edge.edgeType,
        edgeSource: edge.source,
      });
    }
  }
  return ok(effects);
};

/** Comparator: sourceClassId, category, targetId. */
const compareEffects = (a: DownstreamEffect, b: DownstreamEffect): number => {
  if (a.sourceClassId !== b.sourceClassId) {
    return a.sourceClassId < b.sourceClassId ? -1 : 1;
  }
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
};

/** Stable key for deduping identical effect rows from overlapping walks. */
const effectDedupeKey = (e: DownstreamEffect): string =>
  `${e.sourceClassId}\0${e.category}\0${e.targetId}\0${e.edgeType}\0${e.edgeSource}`;

/** Apex ids in a reachability set (excludes Flow / WorkflowRule / etc.). */
const countApexReachable = (ids: Iterable<ComponentId>): number => {
  let n = 0;
  for (const id of ids) {
    if (id.startsWith(APEX_CLASS_PREFIX) || id.startsWith(APEX_TRIGGER_PREFIX)) {
      n += 1;
    }
  }
  return n;
};

const dedupeEffects = (
  effects: readonly DownstreamEffect[],
): DownstreamEffect[] => {
  const seen = new Set<string>();
  const out: DownstreamEffect[] = [];
  for (const e of effects) {
    const key = effectDedupeKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
};

/** Fold the effects list into per-category counters. */
const buildSummary = (
  effects: readonly DownstreamEffect[],
): DownstreamEffectsSummary => {
  let fieldWrite = 0;
  let asyncDispatch = 0;
  let email = 0;
  for (const e of effects) {
    if (e.category === 'field-write') fieldWrite += 1;
    else if (e.category === 'async-dispatch') asyncDispatch += 1;
    else if (e.category === 'email') email += 1;
  }
  return { fieldWrite, asyncDispatch, email };
};

/**
 * Shared helper: resolve `apiName` for each id in `classIds`, returning
 * a map suitable for `collectEffectsForClass`. Mutates `apiNameByClass`
 * in place and returns it for convenience.
 */
const resolveApiNames = async (
  ctx: Context,
  classIds: Iterable<ComponentId>,
  apiNameByClass: Map<ComponentId, string>,
): Promise<Result<Map<ComponentId, string>, string>> => {
  // ONE batched fetch of every not-yet-resolved class node, replacing the
  // per-class `getNodeById` N+1. A missing id is dropped (its apiName stays
  // unset), matching the old null-skip; `apiNameByClass` is a Map so order is
  // irrelevant.
  const missing = [...classIds].filter((id) => !apiNameByClass.has(id));
  const nodesResult = await listNodesByIds(ctx.graph, missing);
  if (!nodesResult.ok) return err(nodesResult.error.message);
  for (const node of nodesResult.value) {
    apiNameByClass.set(node.id, node.apiName);
  }
  return ok(apiNameByClass);
};

/**
 * The `sfi.downstream_effects` MCP tool. Walks downstream `callsApex`
 * from the root class, then surfaces the writesTo / dispatchesAsync /
 * sendsEmail edges of every reachable class as categorised side
 * effects.
 *
 * When given a `CustomObject:` root (RTG-04), discovers automation via
 * `triggersOn` and `parentOf`, collects declarative effects per firer,
 * and walks `callsApex` from every firer for Apex-originated effects.
 *
 * @example
 *   const r = await downstreamEffectsHandler(ctx, {
 *     classApiName: 'ApexClass:OrderService',
 *   });
 *   if (r.ok) console.log(r.value.data.summary);
 */
export const downstreamEffectsHandler = async (
  ctx: Context,
  input: DownstreamEffectsInput,
): Promise<Result<McpResponse<DownstreamEffectsOutput>, McpError>> => {
  // Accept CustomObject prefix as-is; coerce bare names to ApexClass (default).
  const coerced = isCustomObject(input.classApiName)
    ? input.classApiName
    : coercePrefix(input.classApiName, [APEX_CLASS_PREFIX, APEX_TRIGGER_PREFIX]);

  if (!isAcceptedRoot(coerced)) {
    return err({
      kind: 'invalid-query',
      message: `classApiName must be an ApexClass/ApexTrigger/CustomObject id (e.g. '${APEX_CLASS_PREFIX}Foo', '${CUSTOM_OBJECT_PREFIX}Account') or a bare class name (e.g. 'Foo'); got '${input.classApiName}'`,
      path: 'classApiName',
    });
  }
  const rootId = coerced as ComponentId;
  const maxDepth = input.maxDepth ?? DOWNSTREAM_EFFECTS_DEFAULT_DEPTH;

  const rootRes = await getNodeById(ctx.graph, rootId);
  if (!rootRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${rootRes.error.message}`,
    });
  }
  if (rootRes.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(
        ctx,
        rootId,
        'ApexClass, ApexTrigger, or CustomObject',
      ),
      path: rootId,
    });
  }

  // ── CustomObject root path (RTG-04) ──────────────────────────────────────
  if (isCustomObject(rootId)) {
    const automationRes = await collectAutomationNodesForObject(ctx, rootId);
    if (!automationRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${automationRes.error}`,
      });
    }
    const automationNodes = automationRes.value;

    const allEffects: DownstreamEffect[] = [];
    const reachableUnion = new Set<ComponentId>();

    // Direct declarative side effects (Flow writes, WorkflowRule /
    // ApprovalProcess emails, etc.) for every non-ApexTrigger firer, batched.
    // ApexTrigger body effects are picked up via the callsApex walk below to
    // avoid double-counting.
    const directRes = await collectEffectsForClasses(
      ctx,
      automationNodes
        .filter((node) => node.type !== 'ApexTrigger')
        .map((node) => ({ id: node.id, apiName: node.apiName })),
    );
    if (!directRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${directRes.error}`,
      });
    }
    allEffects.push(...directRes.value);

    for (const node of automationNodes) {
      const reachableRes = await collectReachableClasses(
        ctx,
        node.id,
        maxDepth,
        undefined,
      );
      if (!reachableRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${reachableRes.error}`,
        });
      }
      for (const id of reachableRes.value) reachableUnion.add(id);
    }

    const apiNameByClass = new Map<ComponentId, string>();
    const namesRes = await resolveApiNames(ctx, reachableUnion, apiNameByClass);
    if (!namesRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${namesRes.error}`,
      });
    }

    const reachableEffectsRes = await collectEffectsForClasses(
      ctx,
      [...reachableUnion].map((classId) => ({
        id: classId,
        apiName: apiNameByClass.get(classId) ?? '',
      })),
    );
    if (!reachableEffectsRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${reachableEffectsRes.error}`,
      });
    }
    allEffects.push(...reachableEffectsRes.value);

    const dedupedEffects = dedupeEffects(allEffects);
    dedupedEffects.sort(compareEffects);

    return ok({
      data: {
        rootId,
        reachableClassCount: countApexReachable(reachableUnion),
        effects: dedupedEffects,
        summary: buildSummary(dedupedEffects),
        automationNodes: automationNodes.map((n) => ({
          id: n.id,
          type: n.type,
          apiName: n.apiName,
        })),
        disclosure:
          dedupedEffects.length === 0
            ? DOWNSTREAM_DISCLOSURE + EMPTY_EFFECTS_NOTE
            : DOWNSTREAM_DISCLOSURE,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // ── ApexClass / ApexTrigger root path (original) ─────────────────────────
  const reachableRes = await collectReachableClasses(
    ctx,
    rootId,
    maxDepth,
    input.method,
  );
  if (!reachableRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${reachableRes.error}`,
    });
  }
  const reachable = reachableRes.value;

  // Resolve each reachable class's apiName so the per-class effect
  // entries can cite it without a roundtrip.
  const apiNameByClass = new Map<ComponentId, string>();
  apiNameByClass.set(rootId, rootRes.value.apiName);
  const namesRes = await resolveApiNames(ctx, reachable, apiNameByClass);
  if (!namesRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${namesRes.error}`,
    });
  }

  const effectsRes = await collectEffectsForClasses(
    ctx,
    [...reachable].map((classId) => ({
      id: classId,
      apiName: apiNameByClass.get(classId) ?? '',
    })),
  );
  if (!effectsRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${effectsRes.error}`,
    });
  }
  const allEffects = [...effectsRes.value];
  allEffects.sort(compareEffects);

  return ok({
    data: {
      rootId,
      reachableClassCount: reachable.size,
      effects: allEffects,
      summary: buildSummary(allEffects),
      disclosure:
        allEffects.length === 0
          ? DOWNSTREAM_DISCLOSURE + EMPTY_EFFECTS_NOTE
          : DOWNSTREAM_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

