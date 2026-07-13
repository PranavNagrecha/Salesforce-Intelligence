/**
 * Handler for the `sfi.automation_collisions` MCP tool.
 *
 * The "is my org fighting itself?" tool for ONE object. `automation_build_advisor`
 * (see `automation-build-advisor.ts`, the closest sibling) flags OBJECT-level
 * hazards — multiple record-triggered Flows on one object, mixed Apex+Flow
 * automation. It does NOT look at what those automations actually WRITE, so it
 * misses two silent failure modes:
 *
 *   1. **Field-level write collisions** — two or more DISTINCT automations
 *      (record-triggered Flow, ApexTrigger, WorkflowRule) writing the SAME
 *      field on the SAME object. Salesforce does not arbitrate between them;
 *      whichever runs last in the (often unordered) sequence wins, silently
 *      discarding the other's write.
 *   2. **Save-recursion cycles** — an automation on object O writes a field
 *      back onto O itself (the classic workflow-field-update / after-trigger
 *      re-trigger), or writes a field on object P whose own automation writes
 *      a field back onto O — a potential infinite-loop / governor-limit risk
 *      the platform only partially guards against.
 *
 * Composition:
 *   - Gathers the object's incoming `triggersOn` edges (record-triggered
 *     Flows, ApexTriggers, WorkflowRules — the SAME gathering approach as
 *     `automation_build_advisor`) and each firer's outgoing `writesTo` edges.
 *   - **Collisions**: groups same-object field writes by target `CustomField`
 *     id; 2+ distinct writer components on one field is a finding.
 *   - **Cycles**: a bounded (depth-capped) walk over `triggersOn` +
 *     `writesTo` edges, starting at the queried object, looking for a write
 *     path that returns to the object it started from. A same-object
 *     self-write (X triggersOn O and writesTo a field on O) is the depth-1
 *     special case and the most common real-world shape.
 *
 * **Honesty axis** (load-bearing, see BOUNDARY_* below):
 *   - Every listed component is a real vault node reached via `triggersOn` /
 *     `writesTo` edges — never a fabricated execution trace.
 *   - Field-update / entry CONDITIONS are NOT evaluated: two writers with
 *     mutually exclusive criteria are still listed as a collision.
 *   - Confidence varies per writer (Flow / WorkflowRule field writes are
 *     `parsed` from declared XML; ApexTrigger writes are `heuristic` static
 *     analysis). A finding carries the WEAKEST confidence among its
 *     contributing writers, labeled explicitly.
 *   - Only automation wired directly via `triggersOn` on an object is walked
 *     — ApprovalProcess field updates and Apex writes performed by a HELPER
 *     CLASS called FROM a trigger (rather than the trigger itself) are out of
 *     scope for this v1.
 *   - Salesforce's own recursion guards — a record-triggered Flow's "do not
 *     re-trigger the flow that started this update" setting, and the
 *     platform's workflow-rule re-evaluation limits — are NOT captured by the
 *     extractors and are therefore NOT evaluated here. A listed cycle is a
 *     POTENTIAL loop the org's structure allows, not proof it fires.
 *   - A same-object write from a BEFORE-save automation (before-trigger,
 *     before-save Flow) is excluded from cycle detection: it folds into the
 *     record's single pending INSERT/UPDATE rather than causing a second
 *     save, so it is not a recursion candidate.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { isUnresolvedFieldReceiver } from './apex-receiver.js';
import { argsFingerprint, paginate, type PaginateBinding } from './page-cursor.js';
import { isActiveSoeFirer } from './soe-active.js';

/** Default and max number of collisions / cycles returned per list. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Bounded-walk knobs for the recursion-cycle search (see BOUNDARY_DEPTH_CAP). */
const CYCLE_DEPTH_CAP = 4;
const CYCLE_EXPLORE_CAP = 300;

const TOOL_NAME = 'sfi.automation_collisions';

/** The `triggersOn` firer families this tool walks — mirrors `automation_build_advisor`. */
type AutomationKind = 'Flow' | 'ApexTrigger' | 'WorkflowRule';

/** When (relative to the database write) a firer's writes take effect. */
type WriteTiming = 'before' | 'after' | 'post-save' | 'unknown';

/** Zod schema for the `sfi.automation_collisions` tool input. */
export const automationCollisionsInputSchema = z.object({
  object: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type AutomationCollisionsInput = z.infer<typeof automationCollisionsInputSchema>;

/** One automation writing a field a collision/cycle finding names. */
export interface AutomationWriter {
  readonly componentId: ComponentId;
  readonly componentType: AutomationKind;
  readonly active: boolean;
  /** The `writesTo` edge's own confidence — `parsed` (Flow/WorkflowRule XML) or `heuristic` (Apex scanner). */
  readonly confidence: ConfidenceLevel;
  /** Firing timing relative to the database write, when modeled; `'unknown'` otherwise. */
  readonly timing: WriteTiming;
}

/** A field with 2+ distinct automations writing it on the same trigger event. */
export interface FieldCollision {
  readonly fieldId: ComponentId;
  readonly fieldApiName: string;
  readonly writers: readonly AutomationWriter[];
  readonly activeWriterCount: number;
  /** The WEAKEST confidence across `writers` — a heuristic Apex write drags the whole finding down. */
  readonly weakestConfidence: ConfidenceLevel;
  readonly severity: 'info' | 'medium' | 'high';
}

/** One hop in a recursion-cycle path: an automation writing from one object onto another (or itself). */
export interface RecursionHop {
  readonly automationId: ComponentId;
  readonly automationType: AutomationKind;
  readonly fromObject: string;
  readonly toObject: string;
  readonly fieldId: ComponentId;
  readonly active: boolean;
  readonly confidence: ConfidenceLevel;
}

/** A potential save-recursion loop: `self-write` (depth 1, same object) or `multi-object` (2+ hops). */
export interface RecursionCycle {
  readonly kind: 'self-write' | 'multi-object';
  readonly path: readonly RecursionHop[];
  readonly weakestConfidence: ConfidenceLevel;
  readonly allActive: boolean;
  readonly severity: 'info' | 'medium' | 'high';
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface AutomationCollisionsOutput {
  readonly object: string;
  readonly objectModeled: boolean;
  readonly collisions: readonly FieldCollision[];
  readonly cycles: readonly RecursionCycle[];
  readonly summary: {
    readonly automationsScanned: number;
    readonly fieldsWithMultipleWriters: number;
    readonly cyclesFound: number;
    readonly collisionsTruncated: boolean;
    readonly cyclesTruncated: boolean;
  };
  readonly boundaries: readonly string[];
}

/** Strongest -> weakest. Mirrors `hybrid-trust.ts`'s rank, scoped locally to writesTo-edge confidence. */
const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  declared: 0,
  parsed: 1,
  heuristic: 2,
};

/** The weaker (more cautious) of two writesTo-edge confidence tiers. */
const weaker = (a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel =>
  CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;

const byComponentId = (a: { componentId: ComponentId }, b: { componentId: ComponentId }): number =>
  a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0;

/** Parse the object api name out of a `CustomField:{Object}.{Field}` canonical id. */
const OBJECT_FROM_FIELD_RE = /^CustomField:([^.]+)\./;
const objectOfFieldId = (fieldId: ComponentId): string | null =>
  OBJECT_FROM_FIELD_RE.exec(fieldId)?.[1] ?? null;

/** One `triggersOn` firer resolved against the object it targets, with active + timing derived. */
interface FirerDescriptor {
  readonly id: ComponentId;
  readonly type: AutomationKind;
  readonly active: boolean;
  readonly timing: WriteTiming;
}

/**
 * Gather the `triggersOn` firers for one object — record-triggered Flows,
 * ApexTriggers, WorkflowRules — the SAME edge family `automation_build_advisor`
 * walks. Reused both for the queried object and for every object reached
 * during the recursion-cycle walk.
 */
const gatherFirersForObject = async (
  ctx: Context,
  objectApiName: string,
): Promise<Result<readonly FirerDescriptor[], string>> => {
  const objectId: ComponentId = `CustomObject:${objectApiName}`;
  const inResult = await listEdges(ctx.graph, objectId, {
    direction: 'in',
    edgeType: 'triggersOn',
  });
  if (!inResult.ok) return err(inResult.error.message);

  const firers: FirerDescriptor[] = [];
  for (const triggerEdge of inResult.value) {
    const nodeResult = await getNodeById(ctx.graph, triggerEdge.fromId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    const firerNode = nodeResult.value;
    if (firerNode === null) continue;

    if (firerNode.type === 'Flow') {
      const timing: WriteTiming =
        triggerEdge.properties['triggerType'] === 'RecordBeforeSave' ? 'before' : 'after';
      firers.push({
        id: firerNode.id,
        type: 'Flow',
        active: isActiveSoeFirer(firerNode),
        timing,
      });
    } else if (firerNode.type === 'ApexTrigger') {
      const events = firerNode.properties['events'];
      const eventList = Array.isArray(events) ? events : [];
      const hasBefore = eventList.some((e) => typeof e === 'string' && e.startsWith('before '));
      const hasAfter = eventList.some((e) => typeof e === 'string' && e.startsWith('after '));
      // A trigger that fires in BOTH timings can write in either handler; the
      // scanner's writesTo edge does not carry per-event attribution, so a
      // trigger with any `after` handler is conservatively treated as `after`
      // (the recursion-relevant case) rather than silently downgraded to
      // `before`. Pure before-only triggers are `before`; neither -> `unknown`.
      const timing: WriteTiming = hasAfter ? 'after' : hasBefore ? 'before' : 'unknown';
      firers.push({
        id: firerNode.id,
        type: 'ApexTrigger',
        active: isActiveSoeFirer(firerNode),
        timing,
      });
    } else if (firerNode.type === 'WorkflowRule') {
      // Workflow field updates always run in the post-save-workflows SOE phase.
      firers.push({
        id: firerNode.id,
        type: 'WorkflowRule',
        active: isActiveSoeFirer(firerNode),
        timing: 'post-save',
      });
    }
  }
  return ok(firers);
};

/**
 * Gather a firer's field-level `writesTo` edges (any target object — the
 * cycle walk needs cross-object writes; the collision grouper filters to the
 * queried object itself). Drops heuristic-scanner edges to an UNRESOLVED
 * receiver (`this.x`, a lowercase local-var alias) — the same segregation
 * `what_happens_on_save` / `field_provenance` apply — so a parse artifact
 * never reads as a real field write.
 */
const gatherFieldWritesForFirer = async (
  ctx: Context,
  firerId: ComponentId,
): Promise<Result<readonly { readonly toId: ComponentId; readonly confidence: ConfidenceLevel }[], string>> => {
  const edgesResult = await listEdges(ctx.graph, firerId, {
    direction: 'out',
    edgeType: 'writesTo',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const out: { toId: ComponentId; confidence: ConfidenceLevel }[] = [];
  for (const writeEdge of edgesResult.value) {
    if (!writeEdge.toId.startsWith('CustomField:')) continue; // object-level writesTo (recordCreate) — not a field write
    if (isUnresolvedFieldReceiver(writeEdge.toId)) continue;
    out.push({ toId: writeEdge.toId, confidence: writeEdge.confidence });
  }
  return ok(out);
};

const collisionSeverity = (
  activeWriterCount: number,
  weakestConfidence: ConfidenceLevel,
): FieldCollision['severity'] => {
  if (activeWriterCount >= 2) return weakestConfidence === 'heuristic' ? 'medium' : 'high';
  if (activeWriterCount === 1) return 'medium'; // a dormant writer would collide if reactivated
  return 'info'; // every contributing writer is inactive today
};

const cycleSeverity = (
  allActive: boolean,
  weakestConfidence: ConfidenceLevel,
): RecursionCycle['severity'] => {
  if (!allActive) return 'info'; // the loop cannot fire until every hop is reactivated
  return weakestConfidence === 'heuristic' ? 'medium' : 'high';
};

const collisionSort = (a: FieldCollision, b: FieldCollision): number => {
  const rank = (c: FieldCollision): number => (c.severity === 'high' ? 0 : c.severity === 'medium' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return a.fieldApiName < b.fieldApiName ? -1 : a.fieldApiName > b.fieldApiName ? 1 : 0;
};

const cycleSort = (a: RecursionCycle, b: RecursionCycle): number => {
  const rank = (c: RecursionCycle): number => (c.severity === 'high' ? 0 : c.severity === 'medium' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  const aKey = a.path[0]?.automationId ?? '';
  const bKey = b.path[0]?.automationId ?? '';
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
};

/**
 * Bounded BFS from `originObject` over `triggersOn` -> `writesTo` edges,
 * looking for a field-write path that returns to `originObject`. Depth
 * capped at {@link CYCLE_DEPTH_CAP} hops; a same-object write from a
 * BEFORE-timing firer is excluded (see module JSDoc). Defensively capped at
 * {@link CYCLE_EXPLORE_CAP} firer expansions so a densely-automated org
 * cannot make one call scan unboundedly.
 */
const findRecursionCycles = async (
  ctx: Context,
  originObject: string,
  originFirers: readonly FirerDescriptor[],
): Promise<Result<{ readonly cycles: readonly RecursionCycle[]; readonly exploreCapHit: boolean }, string>> => {
  const cycles: RecursionCycle[] = [];
  const seenCycleKeys = new Set<string>();
  const firerCache = new Map<string, readonly FirerDescriptor[]>([[originObject, originFirers]]);
  let explored = 0;
  let capHit = false;

  interface QueueItem {
    readonly currentObject: string;
    readonly path: readonly RecursionHop[];
  }
  const queue: QueueItem[] = [{ currentObject: originObject, path: [] }];

  while (queue.length > 0 && !capHit) {
    const item = queue.shift();
    if (item === undefined) break;
    if (item.path.length >= CYCLE_DEPTH_CAP) continue;

    let firers = firerCache.get(item.currentObject);
    if (firers === undefined) {
      const firersResult = await gatherFirersForObject(ctx, item.currentObject);
      if (!firersResult.ok) return err(firersResult.error);
      firers = firersResult.value;
      firerCache.set(item.currentObject, firers);
    }

    for (const firer of firers) {
      if (explored >= CYCLE_EXPLORE_CAP) {
        capHit = true;
        break;
      }
      explored += 1;
      const writesResult = await gatherFieldWritesForFirer(ctx, firer.id);
      if (!writesResult.ok) return err(writesResult.error);

      for (const write of writesResult.value) {
        const targetObject = objectOfFieldId(write.toId);
        if (targetObject === null) continue;
        const sameObjectHop = targetObject === item.currentObject;
        // A before-save write to $Record folds into the single pending save —
        // it never causes a second, re-entrant save of the same object.
        if (sameObjectHop && firer.timing === 'before') continue;

        const hop: RecursionHop = {
          automationId: firer.id,
          automationType: firer.type,
          fromObject: item.currentObject,
          toObject: targetObject,
          fieldId: write.toId,
          active: firer.active,
          confidence: write.confidence,
        };
        const newPath = [...item.path, hop];

        if (targetObject === originObject) {
          const key = newPath.map((h) => `${h.automationId}>${h.fieldId}`).join('|');
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            const allActive = newPath.every((h) => h.active);
            const weakestConf = newPath.reduce<ConfidenceLevel>(
              (acc, h) => weaker(acc, h.confidence),
              'declared',
            );
            cycles.push({
              kind: newPath.length === 1 ? 'self-write' : 'multi-object',
              path: newPath,
              weakestConfidence: weakestConf,
              allActive,
              severity: cycleSeverity(allActive, weakestConf),
            });
          }
          // Don't extend past a closed loop — further hops from the origin
          // are already explored as fresh queue entries from the top.
          continue;
        }
        queue.push({ currentObject: targetObject, path: newPath });
      }
    }
  }

  return ok({ cycles, exploreCapHit: capHit });
};

const STATIC_BOUNDARIES: readonly string[] = Object.freeze([
  'Every listed automation is a real vault node reached via `triggersOn` / `writesTo` edges — not a fabricated execution trace. Field-update and entry CONDITIONS on Flows, WorkflowRules, and ApexTriggers are NOT evaluated: two writers with mutually exclusive criteria are still listed as a collision.',
  'Confidence varies per writer: Flow and WorkflowRule field writes are `parsed` from declared XML; ApexTrigger writes are `heuristic` static analysis (regex/AST field-access scanning) that may include false positives or miss dynamic/reflective writes. Every collision and cycle finding carries the WEAKEST confidence among its contributing writers.',
  "Only automation wired directly via `triggersOn` on the object is scanned (record-triggered Flow, ApexTrigger, WorkflowRule) — ApprovalProcess field updates and Apex writes performed by a HELPER CLASS the trigger calls (rather than the trigger itself) are out of scope for this v1 and are not walked.",
  `Recursion cycles are a BOUNDED graph walk: depth capped at ${CYCLE_DEPTH_CAP} hops from the queried object, and at most ${CYCLE_EXPLORE_CAP} automation expansions. Salesforce's own recursion guards — a record-triggered Flow's "do not re-trigger the flow that started this update" setting, and the platform's workflow-rule re-evaluation limits — are NOT captured by the extractors and are NOT evaluated here. A listed cycle is a POTENTIAL loop the org's structure allows, not proof it fires at runtime.`,
  'A same-object write from a BEFORE-save automation (before-trigger, before-save Flow) is excluded from cycle detection — it modifies the record before the single pending INSERT/UPDATE rather than causing a second save. Only AFTER-trigger / after-save-Flow / post-save-workflow writes back to the same object are flagged as potential recursion.',
]);

/**
 * The `sfi.automation_collisions` MCP tool. See module JSDoc for the
 * composition and honesty axis.
 *
 * @example
 *   const r = await automationCollisionsHandler(ctx, { object: 'Account' });
 *   if (r.ok) for (const c of r.value.data.collisions) console.log(c.fieldApiName, c.writers);
 */
export const automationCollisionsHandler = async (
  ctx: Context,
  input: AutomationCollisionsInput,
): Promise<Result<McpResponse<AutomationCollisionsOutput>, McpError>> => {
  const objectApiName = input.object;
  const objectId: ComponentId = `CustomObject:${objectApiName}`;

  const objNodeResult = await getNodeById(ctx.graph, objectId);
  if (!objNodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${objNodeResult.error.message}` });
  }

  const firersResult = await gatherFirersForObject(ctx, objectApiName);
  if (!firersResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${firersResult.error}` });
  }
  const firers = firersResult.value;
  const objectModeled = objNodeResult.value !== null || firers.length > 0;

  // --- Field-level write collisions (same-object writes only) ---
  const fieldWriters = new Map<ComponentId, AutomationWriter[]>();
  for (const firer of firers) {
    const writesResult = await gatherFieldWritesForFirer(ctx, firer.id);
    if (!writesResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${writesResult.error}` });
    }
    for (const write of writesResult.value) {
      if (objectOfFieldId(write.toId) !== objectApiName) continue;
      const bucket = fieldWriters.get(write.toId) ?? [];
      if (!bucket.some((w) => w.componentId === firer.id)) {
        bucket.push({
          componentId: firer.id,
          componentType: firer.type,
          active: firer.active,
          confidence: write.confidence,
          timing: firer.timing,
        });
      }
      fieldWriters.set(write.toId, bucket);
    }
  }

  const fieldPrefix = `CustomField:${objectApiName}.`;
  const allCollisions: FieldCollision[] = [];
  for (const [fieldId, writers] of fieldWriters) {
    if (writers.length < 2) continue;
    const sortedWriters = [...writers].sort(byComponentId);
    const weakestConfidence = sortedWriters.reduce<ConfidenceLevel>(
      (acc, w) => weaker(acc, w.confidence),
      'declared',
    );
    const activeWriterCount = sortedWriters.filter((w) => w.active).length;
    allCollisions.push({
      fieldId,
      fieldApiName: fieldId.startsWith(fieldPrefix) ? fieldId.slice(fieldPrefix.length) : fieldId,
      writers: sortedWriters,
      activeWriterCount,
      weakestConfidence,
      severity: collisionSeverity(activeWriterCount, weakestConfidence),
    });
  }
  allCollisions.sort(collisionSort);

  // --- Save-recursion cycles ---
  const cyclesResult = await findRecursionCycles(ctx, objectApiName, firers);
  if (!cyclesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${cyclesResult.error}` });
  }
  const allCycles = [...cyclesResult.value.cycles].sort(cycleSort);

  // --- Byte-budget + limit the two findings lists (CR-22 `paginate`, no
  // resumable cursor exposed — this tool's input contract is intentionally
  // just `{ object, limit }`; a truncated list tells the caller to narrow the
  // object or raise `limit` rather than page with a cursor). ---
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const binding: PaginateBinding = {
    tool: TOOL_NAME,
    vaultHash: ctx.manifest.sourceTreeHash,
    argsFingerprint: argsFingerprint({ object: objectApiName }),
  };
  const collisionsPage = paginate(allCollisions, { limit, binding });
  const cyclesPage = paginate(allCycles, { limit, binding });
  const collisionsTruncated = collisionsPage.pageInfo.hasMore || collisionsPage.byteTrimmed;
  const cyclesTruncated = cyclesPage.pageInfo.hasMore || cyclesPage.byteTrimmed;

  const boundaries: string[] = [...STATIC_BOUNDARIES];
  if (cyclesResult.value.exploreCapHit) {
    boundaries.push(
      `The recursion walk hit its defensive ${CYCLE_EXPLORE_CAP}-expansion cap before exhausting every path on this densely-automated object graph — some longer or more branching cycles may exist beyond what is listed.`,
    );
  }
  if (collisionsTruncated) {
    boundaries.push(
      `Collisions truncated to ${limit} of ${allCollisions.length} fields — raise \`limit\` (max ${MAX_LIMIT}) to see more.`,
    );
  }
  if (cyclesTruncated) {
    boundaries.push(
      `Cycles truncated to ${limit} of ${allCycles.length} — raise \`limit\` (max ${MAX_LIMIT}) to see more.`,
    );
  }

  return ok({
    data: {
      object: objectApiName,
      objectModeled,
      collisions: collisionsPage.items,
      cycles: cyclesPage.items,
      summary: {
        automationsScanned: firers.length,
        fieldsWithMultipleWriters: allCollisions.length,
        cyclesFound: allCycles.length,
        collisionsTruncated,
        cyclesTruncated,
      },
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
