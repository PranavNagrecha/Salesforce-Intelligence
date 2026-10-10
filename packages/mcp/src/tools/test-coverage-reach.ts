/**
 * TEST-COVERAGE-REACH — the ONE answer to "which test classes exercise this
 * Apex?", shared by `apex_test_coverage`, `test_coverage_gaps` and
 * `tests_for_change` (and the trigger join `test_coverage_for_method` uses).
 *
 * Those tools used to walk different edge sets — `callsApex` only, or
 * `callsApex`+`dispatchesAsync`, or every usage edge — so the same class was
 * "untested" in one and covered in another. Two gaps were common to all of
 * them:
 *
 *   1. a test that runs a Batch / Queueable / Schedulable, instantiates a class
 *      or reads its statics reaches it through `dispatchesAsync`, `references`
 *      or `inheritsFrom`, not `callsApex`;
 *   2. a test that does DML on an object fires that object's trigger, which
 *      calls the handler — there is no call edge from the test at all.
 *
 * {@link findCoveringTests} walks UPSTREAM from the target over
 * {@link TEST_REACH_EDGE_TYPES} (Apex sources only; a test class is a SINK, never
 * a relay), then adds the TRIGGER HOP: for every ApexTrigger on the path, the
 * test classes that write a field of (or the record of) the object it fires on.
 * Trigger-hop hits are `heuristic` — a field write in a test is strong evidence
 * of DML, not proof of it — and are marked `via: 'via-trigger'`.
 *
 * Query count: one batched edge query plus one batched node query per depth
 * level, plus a constant handful for the trigger hop.
 */

import { readFile } from 'node:fs/promises';

import type { ComponentId, ConfidenceLevel, EdgeType, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  type GraphStore,
  isHiddenUnresolved,
  listChildren,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import { familyWasExtracted } from './absence-disclosure.js';
import { stripApexComments } from './apex-dml-index.js';
import { weakerConfidence } from './apex-reachability.js';

/**
 * In-edge types that carry "this Apex uses that Apex". Sorted ascending so a
 * batched bucket's visitation order is stable. `references` covers `new X()`,
 * static access and type use; `inheritsFrom` covers a test subclassing it.
 */
export const TEST_REACH_EDGE_TYPES: readonly EdgeType[] = [
  'callsApex',
  'dispatchesAsync',
  'inheritsFrom',
  'references',
];

/** The two edge types the trigger hop joins through (named in viaEdgeTypes). */
export const TRIGGER_HOP_EDGE_TYPES: readonly EdgeType[] = ['references', 'triggersOn', 'writesTo'];

export type CoverageVia = 'direct' | 'transitive' | 'via-trigger';

export interface CoveringTestHit {
  readonly testId: ComponentId;
  readonly apiName: string;
  /** Hops from the target; a trigger-hop hit is one past its trigger. */
  readonly depth: number;
  readonly via: CoverageVia;
  /** Weakest edge confidence on the path; `heuristic` for every trigger-hop hit. */
  readonly confidence: ConfidenceLevel;
  readonly viaEdgeTypes: readonly EdgeType[];
  /** Trigger-hop only: the trigger whose object the test writes. */
  readonly viaTrigger?: ComponentId;
  readonly viaObject?: ComponentId;
  /**
   * Trigger-hop only: the test's OWN source shows DML but none of the
   * trigger's event verbs (an insert-only test on an update trigger). Still
   * credited — code it calls (a service's `update`, a workflow field update,
   * an after-save flow) can fire the trigger — but weaker evidence.
   */
  readonly eventMismatch?: true;
}

const isApexId = (id: string): boolean =>
  id.startsWith('ApexClass:') || id.startsWith('ApexTrigger:');

/** `CustomObject:X` / `CustomField:X.F` → `CustomObject:X`. */
const objectOf = (id: string): ComponentId | null => {
  if (id.startsWith('CustomObject:')) return id as ComponentId;
  if (id.startsWith('CustomField:')) {
    const rest = id.slice('CustomField:'.length);
    const dot = rest.indexOf('.');
    return dot > 0 ? (`CustomObject:${rest.slice(0, dot)}` as ComponentId) : null;
  }
  return null;
};

export interface TriggerTestWriter {
  readonly testId: ComponentId;
  readonly apiName: string;
  readonly objectId: ComponentId;
  /** See {@link CoveringTestHit.eventMismatch}. */
  readonly eventMismatch?: true;
}

/** Options for the trigger hop. */
export interface TriggerHopOptions {
  /**
   * Vault root. When given, a test whose OWN source shows DML but no verb that
   * fires the trigger's events (an insert-only test on an `after update`
   * trigger) is marked `eventMismatch` — still credited, since code it calls
   * can fire the trigger. Without it no writer is marked.
   */
  readonly vaultRoot?: string;
  /** Per-request cache of test id → DML verbs (null = unreadable / none seen). */
  readonly verbCache?: Map<ComponentId, ReadonlySet<string> | null>;
}

/** DML statement / `Database.<op>(` → the trigger event verbs it fires. */
const DML_VERB_EVENTS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/\binsert\s+[\w([]|\bDatabase\s*\.\s*insert\s*\(/i, ['insert']],
  [/\bupdate\s+[\w([]|\bDatabase\s*\.\s*update\s*\(/i, ['update']],
  [/\bupsert\s+[\w([]|\bDatabase\s*\.\s*upsert\s*\(/i, ['insert', 'update']],
  [/\bdelete\s+[\w([]|\bDatabase\s*\.\s*delete\s*\(/i, ['delete']],
  [/\bundelete\s+[\w([]|\bDatabase\s*\.\s*undelete\s*\(/i, ['undelete']],
  [/\bmerge\s+[\w([]|\bDatabase\s*\.\s*merge\s*\(/i, ['update', 'delete']],
];

/**
 * Trigger event verbs the test's OWN source can fire, or `null` when the
 * source is unreadable or shows no DML at all (e.g. it inserts through a data
 * factory) — `null` never refutes a trigger-hop credit.
 */
const testDmlVerbs = async (
  test: Node,
  opts: TriggerHopOptions,
): Promise<ReadonlySet<string> | null> => {
  const cached = opts.verbCache?.get(test.id);
  if (cached !== undefined) return cached;
  let verbs: ReadonlySet<string> | null = null;
  if (opts.vaultRoot !== undefined && typeof test.sourcePath === 'string' && test.sourcePath.length > 0) {
    try {
      const raw = await readFile(resolveVaultSourcePath(opts.vaultRoot, test.sourcePath), 'utf-8');
      // Comments and string literals cannot fire a trigger.
      const code = stripApexComments(raw).replace(/'(?:\\.|[^'\\])*'/g, "''");
      const found = new Set<string>();
      for (const [re, events] of DML_VERB_EVENTS) if (re.test(code)) for (const e of events) found.add(e);
      verbs = found.size > 0 ? found : null;
    } catch {
      verbs = null;
    }
  }
  opts.verbCache?.set(test.id, verbs);
  return verbs;
};

/** `['before update', 'after update']` → `{'update'}`; null when unknown. */
const eventList = (v: unknown): readonly unknown[] | null =>
  Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
const triggerEventVerbs = (trigger: Node | undefined): ReadonlySet<string> | null => {
  // Never-extracted events are "unknown", which never refutes a credit.
  if (trigger === undefined || !familyWasExtracted(trigger.properties, 'events')) return null;
  const list = eventList(trigger.properties['events']);
  if (list === null) return null;
  const verbs = new Set<string>();
  for (const e of list) {
    if (typeof e !== 'string') continue;
    const verb = e.trim().split(/\s+/).pop()?.toLowerCase();
    if (verb !== undefined && verb.length > 0) verbs.add(verb);
  }
  return verbs.size > 0 ? verbs : null;
};

/**
 * For each trigger, the TEST classes that write the object it fires on (the
 * object node itself or any of its fields). The single implementation of the
 * trigger/DML join — `test_coverage_for_method` reads it too.
 */
export const testsWritingTriggerObjects = async (
  graph: GraphStore,
  triggerIds: readonly ComponentId[],
  opts: TriggerHopOptions = {},
): Promise<Result<ReadonlyMap<ComponentId, readonly TriggerTestWriter[]>, string>> => {
  const out = new Map<ComponentId, TriggerTestWriter[]>();
  if (triggerIds.length === 0) return ok(out);
  const firesOn = await listEdgesForNodes(graph, triggerIds, {
    direction: 'out',
    edgeTypes: ['triggersOn'],
  });
  if (!firesOn.ok) return err(firesOn.error.message);
  const objectsByTrigger = new Map<ComponentId, ComponentId[]>();
  const objects = new Set<ComponentId>();
  for (const [triggerId, edges] of firesOn.value) {
    const objs = edges.map((e) => e.toId).filter((id) => id.startsWith('CustomObject:'));
    objectsByTrigger.set(triggerId, objs);
    for (const o of objs) objects.add(o);
  }
  if (objects.size === 0) return ok(out);
  const dmlTargetObject = new Map<ComponentId, ComponentId>();
  for (const objectId of [...objects].sort()) {
    dmlTargetObject.set(objectId, objectId);
    const fields = await listChildren(graph, objectId);
    if (!fields.ok) return err(fields.error.message);
    for (const field of fields.value) dmlTargetObject.set(field.id, objectId);
  }
  // A field write, OR a reference to the object type itself (`new Obj__c(F = x)`
  // name-value construction carries no per-field write edge) — in a TEST class
  // either is strong evidence the test creates or updates a record.
  const writers = await listEdgesForNodes(graph, [...dmlTargetObject.keys()], {
    direction: 'in',
    edgeTypes: ['references', 'writesTo'],
  });
  if (!writers.ok) return err(writers.error.message);
  const objectsByWriter = new Map<ComponentId, Set<ComponentId>>();
  for (const [target, edges] of writers.value) {
    const objectId = dmlTargetObject.get(target) ?? objectOf(target);
    if (objectId === null) continue;
    for (const edge of edges) {
      if (!isApexId(edge.fromId)) continue;
      if (edge.edgeType === 'references' && target !== objectId) continue;
      const seen = objectsByWriter.get(edge.fromId) ?? new Set<ComponentId>();
      seen.add(objectId);
      objectsByWriter.set(edge.fromId, seen);
    }
  }
  const writerNodes = await listNodesByIds(graph, [...objectsByWriter.keys()]);
  if (!writerNodes.ok) return err(writerNodes.error.message);
  const testWriters = writerNodes.value.filter((n) => n.properties['isTest'] === true);
  const triggerNodes =
    opts.vaultRoot !== undefined ? await listNodesByIds(graph, [...objectsByTrigger.keys()]) : null;
  if (triggerNodes !== null && !triggerNodes.ok) return err(triggerNodes.error.message);
  const triggerById = new Map((triggerNodes?.value ?? []).map((n) => [n.id, n]));
  for (const [triggerId, objs] of objectsByTrigger) {
    const list: TriggerTestWriter[] = [];
    const fires = triggerEventVerbs(triggerById.get(triggerId));
    for (const t of testWriters) {
      const written = objectsByWriter.get(t.id) ?? new Set<ComponentId>();
      const objectId = objs.find((o) => written.has(o));
      if (objectId === undefined) continue;
      // Event check: a test whose own DML shows none of this trigger's events
      // (only `insert` against an update-only trigger) is MARKED, never
      // dropped — `insert o; Service.approve(o.Id)` fires an update trigger
      // through the service's DML, as do workflow field updates and after-save
      // flows. Dropping it turned a covered change into "no test covers this".
      let eventMismatch = false;
      if (fires !== null) {
        const verbs = await testDmlVerbs(t, opts);
        eventMismatch = verbs !== null && ![...verbs].some((v) => fires.has(v));
      }
      list.push({ testId: t.id, apiName: t.apiName, objectId, ...(eventMismatch ? { eventMismatch: true as const } : {}) });
    }
    list.sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
    out.set(triggerId, list);
  }
  return ok(out);
};

interface Discovered {
  readonly depth: number;
  readonly confidence: ConfidenceLevel;
  readonly viaEdgeTypes: readonly EdgeType[];
}

/**
 * Every test class that exercises `targetId`, keyed by test id, shortest path
 * first. The target itself is never its own coverer. See the module JSDoc.
 */
export const findCoveringTests = async (
  graph: GraphStore,
  targetId: ComponentId,
  opts: { readonly maxDepth: number } & TriggerHopOptions,
): Promise<Result<Map<ComponentId, CoveringTestHit>, string>> => {
  const hits = new Map<ComponentId, CoveringTestHit>();
  const discovered = new Map<ComponentId, Discovered>([
    [targetId, { depth: 0, confidence: 'declared', viaEdgeTypes: [] }],
  ]);
  const triggers: ComponentId[] = targetId.startsWith('ApexTrigger:') ? [targetId] : [];
  let frontier: ComponentId[] = [targetId];
  for (let depth = 0; depth < opts.maxDepth && frontier.length > 0; depth += 1) {
    const batch = await listEdgesForNodes(graph, frontier, {
      direction: 'in',
      edgeTypes: TEST_REACH_EDGE_TYPES,
    });
    if (!batch.ok) return err(batch.error.message);
    const fresh: ComponentId[] = [];
    for (const id of frontier) {
      const from = discovered.get(id);
      if (from === undefined) continue;
      for (const edge of batch.value.get(id) ?? []) {
        if (isHiddenUnresolved(edge)) continue;
        if (!isApexId(edge.fromId) || discovered.has(edge.fromId)) continue;
        discovered.set(edge.fromId, {
          depth: depth + 1,
          confidence: weakerConfidence(from.confidence, edge.confidence),
          viaEdgeTypes: [...new Set([...from.viaEdgeTypes, edge.edgeType])].sort(),
        });
        fresh.push(edge.fromId);
      }
    }
    const nodes = await listNodesByIds(graph, fresh);
    if (!nodes.ok) return err(nodes.error.message);
    const byId = new Map(nodes.value.map((n) => [n.id, n]));
    const next: ComponentId[] = [];
    for (const id of fresh) {
      const n = byId.get(id);
      const d = discovered.get(id);
      if (n === undefined || d === undefined) continue;
      if (n.properties['isTest'] === true) {
        // A test is a coverage SINK: record it, never walk through it.
        hits.set(id, {
          testId: id,
          apiName: n.apiName,
          depth: d.depth,
          via: d.depth === 1 ? 'direct' : 'transitive',
          confidence: d.confidence,
          viaEdgeTypes: d.viaEdgeTypes,
        });
        continue;
      }
      if (id.startsWith('ApexTrigger:')) triggers.push(id);
      next.push(id);
    }
    frontier = next;
  }

  const writers = await testsWritingTriggerObjects(graph, triggers, opts);
  if (!writers.ok) return writers;
  for (const triggerId of triggers) {
    const t = discovered.get(triggerId);
    if (t === undefined) continue;
    for (const w of writers.value.get(triggerId) ?? []) {
      if (w.testId === targetId) continue;
      const prior = hits.get(w.testId);
      if (prior !== undefined && prior.depth <= t.depth + 1) continue;
      hits.set(w.testId, {
        testId: w.testId,
        apiName: w.apiName,
        depth: t.depth + 1,
        via: 'via-trigger',
        confidence: 'heuristic',
        viaEdgeTypes: [...new Set([...t.viaEdgeTypes, ...TRIGGER_HOP_EDGE_TYPES])].sort(),
        viaTrigger: triggerId,
        viaObject: w.objectId,
        ...(w.eventMismatch === true ? { eventMismatch: true as const } : {}),
      });
    }
  }
  return ok(hits);
};
