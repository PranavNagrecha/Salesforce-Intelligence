/**
 * RM-1a — the pure, deterministic reasoning engine.
 *
 * Given a curated {@link ConceptRule} (structural, org-agnostic — no component
 * ids) and a caller-assembled {@link GroundedSlice} of the org's `Node`s and
 * `Edge`s, `interpret` emits zero or one {@link Interpretation}: a grounded,
 * cited claim whose confidence is COMPUTED from the weakest matched edge, never
 * asserted.
 *
 * Honesty is by construction:
 *   - No citation ⇒ no claim (a non-absence rule that matches nothing yields `[]`).
 *   - `confidence = weakest(rule.maxConfidence, …matchedEdgeConfidences)` — the
 *     interpretation can never be more confident than its weakest ground.
 *   - An `absenceShaped` rule whose bind MATCHES (a dependency exists) yields
 *     `[]` — its "none/safe" conclusion is void, and it never cites the very
 *     dependency that contradicts it.
 *   - An `absenceShaped` rule under non-complete coverage is downgraded to a
 *     "not checked" claim with `confidence: 'unknown'` — it NEVER emits a
 *     "none/safe" conclusion the coverage can't support.
 *
 * This module is PURE: no I/O, no clock, no graph query layer. The caller
 * assembles the slice and computes coverage; the engine only reasons over what
 * it is handed. Everything is deterministic — same inputs, same output.
 */

import type {
  ArrayElementClause,
  ChainedRule,
  ComponentId,
  CompoundRule,
  ConceptRule,
  ConditionKind,
  ConfidenceLevel,
  Edge,
  Interpretation,
  Node,
  Remediation,
  RuleAggregate,
  RulePredicate,
  SupersedesRule,
  WhereClause,
} from '@sf-intelligence/contracts';

import { isActiveSoeFirer } from '../tools/soe-active.js';

import { MODEL_VERSION } from './loader.js';
import {
  isSynchronousSavePhase,
  phaseOfAutomation,
  phaseOrdinal,
  type SaveOrderPhase,
} from './save-order-phase.js';

/**
 * The minimal grounded input the caller assembles from the graph. The engine
 * reasons ONLY over these arrays; it never queries the graph itself.
 */
export interface GroundedSlice {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
}

/**
 * Coverage of the families a rule depends on, computed by the caller (e.g. a
 * `summarizeCoverage` helper) and passed in so the engine stays pure.
 */
export interface Coverage {
  readonly status: 'complete' | 'partial' | 'unknown';
  readonly caveat: string | null;
}

/** Total order over {@link ConfidenceLevel}: `declared` > `parsed` > `heuristic`. */
const CONFIDENCE_RANK: Readonly<Record<ConfidenceLevel, number>> = {
  heuristic: 0,
  parsed: 1,
  declared: 2,
};

/**
 * The WEAKEST (lowest in the `declared > parsed > heuristic` order) of the
 * supplied confidence levels. With no arguments it returns `declared` (the
 * identity element), so a rule whose bind matched no edges keeps its declared
 * ceiling. This is how an interpretation's confidence is DERIVED — never
 * asserted — so it can never exceed its weakest ground.
 */
export const weakest = (...levels: ConfidenceLevel[]): ConfidenceLevel =>
  levels.reduce<ConfidenceLevel>(
    (lowest, level) => (CONFIDENCE_RANK[level] < CONFIDENCE_RANK[lowest] ? level : lowest),
    'declared',
  );

/**
 * One matched EDGE and the citation endpoints it contributed (post
 * `componentTypes` filter + F6 self-citation guard). The witness-partition path
 * (REASONING-ASYNC-TEST-CALLER-BLEED) reads these to classify each matched edge
 * by an endpoint-node property; the scalar path derives its flat `ids` /
 * `edgeConfidences` from the same records, so the two can never diverge.
 */
interface MatchedEdge {
  readonly edge: Edge;
  readonly endpoints: readonly ComponentId[];
}

/**
 * The matched ids (verbatim) and each matched edge's confidence. For an
 * edge-shaped predicate `matchedEdges` carries one record per contributing edge
 * (in match order); a node-shaped predicate leaves it empty. `ids` and
 * `edgeConfidences` are DERIVED from `matchedEdges` for the edge branch, so the
 * flat outputs are byte-identical to the pre-record loop.
 */
interface BindResult {
  readonly ids: readonly ComponentId[];
  readonly edgeConfidences: readonly ConfidenceLevel[];
  readonly matchedEdges: readonly MatchedEdge[];
}

/**
 * Parse the object segment out of a canonical `Type:Object.…` id — the token
 * between the first `:` and the first `.`. Returns `null` for an id with no
 * `.` (e.g. `Flow:MyFlow`, `ApexClass:Foo`), i.e. no object scope to read. Used
 * by the same-object join scope: on the KEY (X) side a `null` means "cannot
 * verify same-object" and the coupling is excluded. On the FIRER (F) side a
 * `null` (a Flow) is NOT the end of the road — the firer's object is then taken
 * from its `triggersOn` edge (see {@link objectOfTriggersOnTarget}); only a
 * firer with neither an object segment nor a resolvable `triggersOn` object is
 * conservatively excluded.
 */
const OBJECT_OF_ID_RE = /^[A-Za-z][A-Za-z0-9_]*:([^.]+)\./;
const objectOfId = (id: ComponentId): string | null =>
  OBJECT_OF_ID_RE.exec(id)?.[1] ?? null;

/**
 * The object name of a `triggersOn` edge's target — a `CustomObject:{Object}` id
 * yields `{Object}`. The same-object join scope uses this to derive a
 * record-triggered Flow firer's object from its `triggersOn` edge: a Flow id
 * (`Flow:{ApiName}`) carries NO object segment, so {@link objectOfId} returns
 * null for it, but the vault records the Flow's target SObject via
 * `Flow --triggersOn--> CustomObject:{Object}` (flow.ts `buildStartEdge`).
 * Returns `null` for a target that is not a `CustomObject:` id, so a firer with
 * no resolvable object stays object-less and is conservatively excluded.
 */
const TRIGGERS_ON_TARGET_RE = /^CustomObject:(.+)$/;
const objectOfTriggersOnTarget = (id: ComponentId): string | null =>
  TRIGGERS_ON_TARGET_RE.exec(id)?.[1] ?? null;

/**
 * A PROVEN cross-phase relationship for a coupling (EC-5). Present when both
 * phases were confidently derived (see {@link phaseOfAutomation}), the FIRER
 * phase is a synchronous save phase (see {@link isSynchronousSavePhase} — so an
 * ApprovalProcess firer never qualifies), and the writer/firer ordinals differ:
 *   - `writer-earlier`: `phaseOrdinal(writer) < phaseOrdinal(firer)` — W's write
 *     is visible to F (computed-gate upgrade).
 *   - `writer-later`: `phaseOrdinal(writer) > phaseOrdinal(firer)` AND writer is
 *     also synchronous — F's gate runs BEFORE W writes, so F can never observe
 *     W's value on this save (C10 invisibility).
 * Absent otherwise (phase-agnostic coupling, never an unprovable ordering).
 */
interface CrossPhase {
  readonly writerPhase: SaveOrderPhase;
  readonly firerPhase: SaveOrderPhase;
  /** EC-5 — which side of the phase order was proven. */
  readonly direction: 'writer-earlier' | 'writer-later';
}

/** One grounded coupling (F, X, W) plus the two joined edges' confidences. */
interface JoinTriple {
  readonly firerId: ComponentId;
  readonly fieldId: ComponentId;
  readonly writerId: ComponentId;
  readonly edgeConfidences: readonly ConfidenceLevel[];
  /** Set only when the coupling is a PROVABLE cross-phase computed gate. */
  readonly crossPhase?: CrossPhase;
}

/**
 * Accumulator variant of {@link JoinTriple} whose `edgeConfidences` is mutated
 * in place as duplicate witnesses of the same (F, X, W) collapse to the WEAKEST
 * level (FIX 4). Structurally assignable to a `JoinTriple` on read-out. The
 * `crossPhase` verdict is a function of the (F, W) node identities alone — the
 * same across every witness of a given (F, X, W) — so it is computed once when
 * the triple is first created and never revised on dedup.
 */
interface MutableJoinTriple {
  readonly firerId: ComponentId;
  readonly fieldId: ComponentId;
  readonly writerId: ComponentId;
  edgeConfidences: ConfidenceLevel[];
  readonly crossPhase?: CrossPhase;
}

/**
 * Evaluate a multi-edge {@link RuleJoin} against a grounded slice (RM-loop).
 *
 * Deterministic and pure over the slice. Reconstructs, for every firer F reached
 * by a `bind.edgeType` (`firesWhen`) edge whose `to` is an intermediary of
 * `join.throughType` (`ConditionalContext`):
 *   1. the shared keys X — the string members of the intermediary's
 *      `join.throughKeyArray` (`fieldRefs`) array property (array-membership
 *      expansion the scalar matchers cannot do);
 *   2. the writers W — the `from` endpoints of `W --join.writeEdgeType--> X`
 *      (`writesTo`) edges into each X, constrained to `join.writerTypes`;
 * then intersects on X and emits one {@link JoinTriple} per grounded (F, X, W),
 * applying `join.sameObject` (object(F) === object(X)) and `join.excludeSelf`
 * (W ≠ F). A cited endpoint (X or W) that does NOT resolve to a node in the
 * slice is dropped (never fabricated), mirroring the scalar path's
 * dangling-endpoint honesty. Output is sorted by (firer, field, writer) so the
 * interpretation order is reproducible.
 *
 * Same-object scope resolves the FIRER's object two ways: from its own id's
 * object segment (`WorkflowRule:Object.Rule` → `Object`) OR, when the firer id
 * carries no segment (a record-triggered `Flow`), from its `triggersOn` edge
 * target (`Flow --triggersOn--> CustomObject:{Object}`). A Flow with no
 * resolvable `triggersOn` object is conservatively excluded, never guessed.
 *
 * Dedup keeps the WEAKEST confidence across duplicate witnesses: a single
 * (F, X, W) reachable via edges of differing confidence is emitted once, at the
 * weakest of every witnessing (firesWhen, writesTo) pair — a heuristic witness
 * caps the coupling even when a stronger witness also exists.
 */
const runJoin = (
  bind: RulePredicate,
  slice: GroundedSlice,
  rootId?: ComponentId,
): readonly JoinTriple[] => {
  const join = bind.join;
  if (join === undefined) return [];

  const nodesById = new Map<ComponentId, Node>();
  for (const node of slice.nodes) nodesById.set(node.id, node);

  // Index each automation's `triggersOn` edge ONCE, capturing two grounded
  // signals keyed by the edge's `from` (the firer/writer):
  //   - the OBJECT it targets (FIX 2) — so a record-triggered Flow (whose id has
  //     no object segment) can still be same-object scoped;
  //   - the record-trigger TIMING (`triggerType`, e.g. `RecordBeforeSave`) —
  //     which {@link phaseOfAutomation} needs to split a Flow into before- vs
  //     after-save for the cross-phase upgrade (RM-loop PASS 2).
  // Both F and W can be record-triggered Flows, so this indexes every triggersOn
  // edge in the slice, not just the firers'.
  const objectByTriggersOn = new Map<ComponentId, string>();
  const triggerTypeByTriggersOn = new Map<ComponentId, string>();
  for (const e of slice.edges) {
    if (e.edgeType !== 'triggersOn') continue;
    const obj = objectOfTriggersOnTarget(e.toId);
    if (obj !== null) objectByTriggersOn.set(e.fromId, obj);
    const tt = e.properties['triggerType'];
    if (typeof tt === 'string') triggerTypeByTriggersOn.set(e.fromId, tt);
  }

  // Writer side: index `writesTo` edges by their target key X (the `to`
  // endpoint), keeping each writer W (`from`) that resolves in the slice and, if
  // constrained, is one of `join.writerTypes`.
  const kinds =
    join.throughConditionKinds !== undefined ? new Set(join.throughConditionKinds) : null;
  const writerTypes = join.writerTypes !== undefined ? new Set(join.writerTypes) : null;
  const writersByKey = new Map<ComponentId, { readonly writerId: ComponentId; readonly confidence: ConfidenceLevel }[]>();
  for (const edge of slice.edges) {
    if (edge.edgeType !== join.writeEdgeType) continue;
    const writerNode = nodesById.get(edge.fromId);
    if (writerNode === undefined) continue; // never cite an unresolved writer
    if (writerTypes !== null && !writerTypes.has(writerNode.type)) continue;
    // P1-A REASONING-COUPLED-FIELD-WRITE-DEAD-PLANE — test-writer plane gate. A
    // TEST class (`isTest === true`, an unconditionally-present ApexClass boolean)
    // writes the field only while a test runs, so it never establishes a
    // PRODUCTION write path; excluding it here keeps a test-only writer out of
    // EVERY coupling (never conflated into a live production coupling). Only
    // ApexClass carries `isTest`, so a Flow / rule writer is never dropped. Gated
    // by `join.excludeTestWriter` so any other join rule is byte-identical.
    if (join.excludeTestWriter === true && writerNode.properties['isTest'] === true) continue;
    // REASONING-COUPLED-FIELD-WRITE-DEAD-PLANE — inactive-writer plane gate (the
    // WRITER-side twin of the active-firer gate below). A PROVABLY-INACTIVE writer
    // (a Draft/Obsolete/Inactive Flow, an Inactive ApexTrigger, an inactive
    // WorkflowRule/ApprovalProcess — the shared SOE `isActiveSoeFirer` predicate)
    // does NOT run, so it establishes no live "also writes" path; dropping it here
    // keeps a dead Flow writer out of every coupling. This closes the residual an
    // `isTest` check cannot: an Obsolete Flow carries no `isTest`, so only this
    // liveness gate excludes it. A status-less / always-live writer (e.g. a
    // production ApexClass) is KEPT (isActiveSoeFirer returns true — only a
    // provably-dead writer is dropped). Gated by `join.excludeInactiveWriter` so
    // any other join rule is byte-identical.
    if (join.excludeInactiveWriter === true && !isActiveSoeFirer(writerNode)) continue;
    const bucket = writersByKey.get(edge.toId) ?? [];
    bucket.push({ writerId: edge.fromId, confidence: edge.confidence });
    writersByKey.set(edge.toId, bucket);
  }

  // Keyed by `${F} ${X} ${W}` so a coupling reached via multiple witnesses is
  // emitted once; `edgeConfidences` keeps the WEAKEST across those witnesses.
  const byKey = new Map<string, MutableJoinTriple>();
  for (const edge of slice.edges) {
    if (edge.edgeType !== bind.edgeType) continue; // the firesWhen via-edge
    // FIX 1 (join branch) — root-scope for symmetry with the node/edge branches:
    // the coupled-write rule is FIRER-anchored, so a firesWhen via-edge only counts
    // when its firer IS the queried root (`fromId === rootId`). Every shipped fire
    // already has root === F, so this is behavior-preserving today; it forecloses a
    // future hop dragging a NEIGHBOR's firesWhen edge into an object slice and
    // firing a coupling the anchor does not own (the same class FIX 1 closes for
    // nodes/edges). With no `rootId` (raw-predicate unit tests) it scans all firers.
    if (rootId !== undefined && edge.fromId !== rootId) continue;
    const firerId = edge.fromId;
    if (bind.componentTypes !== undefined) {
      const firerType = nodesById.get(firerId)?.type;
      if (firerType === undefined || !bind.componentTypes.includes(firerType)) continue;
    }
    // P1-A REASONING-COUPLED-FIELD-WRITE-DEAD-PLANE — active-firer liveness gate.
    // A PROVABLY-INACTIVE firer (a Draft/Obsolete Flow, an inactive VR / workflow /
    // approval / assignment / auto-response / escalation rule, an Inactive
    // ApexTrigger — the shared SOE `isActiveSoeFirer` predicate) does NOT run, so
    // it owns no live coupling; dropping its firesWhen via-edge here means an
    // inactive gate is never cited as a live production coupling. Gated by
    // `join.excludeInactiveFirer`; a status-less / always-live firer is KEPT
    // (isActiveSoeFirer returns true), so only a provably-dead gate is dropped.
    if (join.excludeInactiveFirer === true) {
      const firerNodeForLiveness = nodesById.get(firerId);
      if (firerNodeForLiveness !== undefined && !isActiveSoeFirer(firerNodeForLiveness)) continue;
    }
    const through = nodesById.get(edge.toId);
    if (through === undefined || through.type !== join.throughType) continue;
    if (kinds !== null && !kinds.has(through.properties['kind'] as ConditionKind)) continue;
    const keyArray = through.properties[join.throughKeyArray];
    if (!Array.isArray(keyArray)) continue;

    // FIX 2 — resolve the firer's object from its id segment OR, for an
    // object-less firer (a record-triggered Flow), from its `triggersOn` edge.
    const firerObject = join.sameObject
      ? objectOfId(firerId) ?? objectByTriggersOn.get(firerId) ?? null
      : null;
    // RM-loop PASS 2 — the firer's save-order phase (once per firer edge). Null
    // when it cannot be confidently placed; then no coupling off this firer can
    // upgrade to cross-phase.
    const firerNode = nodesById.get(firerId);
    const firerPhase =
      firerNode !== undefined
        ? phaseOfAutomation(firerNode, triggerTypeByTriggersOn.get(firerId))
        : null;
    for (const rawKey of keyArray) {
      if (typeof rawKey !== 'string') continue;
      const fieldId = rawKey as ComponentId;
      if (nodesById.get(fieldId) === undefined) continue; // never cite an unresolved key
      if (join.sameObject) {
        const keyObject = objectOfId(fieldId);
        if (firerObject === null || keyObject === null || firerObject !== keyObject) continue;
      }
      const writers = writersByKey.get(fieldId);
      if (writers === undefined) continue;
      for (const writer of writers) {
        if (join.excludeSelf && writer.writerId === firerId) continue;
        const dedupeKey = `${firerId}${fieldId}${writer.writerId}`;
        const existing = byKey.get(dedupeKey);
        if (existing === undefined) {
          // RM-loop PASS 2 — PROVE cross-phase, else leave it a plain coupling.
          // Upgrade ONLY when phase(F) and phase(W) are both confidently derived,
          // the FIRER runs within the synchronous save (NOT post-save-approval —
          // an approval firer evaluates on a separate SUBMIT, so it never
          // co-fires with the save's writers and must not upgrade), AND phase(W)
          // is strictly earlier than phase(F). Any doubt (null on either side,
          // non-synchronous firer, equal, or reverse order) ⇒ no `crossPhase` ⇒
          // the honest phase-agnostic coupling claim.
          const writerNode = nodesById.get(writer.writerId);
          const writerPhase =
            writerNode !== undefined
              ? phaseOfAutomation(writerNode, triggerTypeByTriggersOn.get(writer.writerId))
              : null;
          // EC-5 — prove writer-earlier OR writer-later when both phases are
          // derived and the FIRER is a synchronous save phase. Writer must also
          // be synchronous for writer-later (same-save invisibility); for
          // writer-earlier the writer is necessarily sync because it is strictly
          // before a sync firer.
          let crossPhase: CrossPhase | undefined;
          if (
            firerPhase !== null &&
            writerPhase !== null &&
            isSynchronousSavePhase(firerPhase)
          ) {
            const wOrd = phaseOrdinal(writerPhase);
            const fOrd = phaseOrdinal(firerPhase);
            if (wOrd < fOrd) {
              crossPhase = { writerPhase, firerPhase, direction: 'writer-earlier' };
            } else if (wOrd > fOrd && isSynchronousSavePhase(writerPhase)) {
              crossPhase = { writerPhase, firerPhase, direction: 'writer-later' };
            }
          }
          byKey.set(dedupeKey, {
            firerId,
            fieldId,
            writerId: writer.writerId,
            edgeConfidences: [edge.confidence, writer.confidence],
            ...(crossPhase !== undefined ? { crossPhase } : {}),
          });
        } else {
          // FIX 4 — a duplicate witness for the same (F, X, W) keeps the WEAKEST
          // confidence (never first-seen), collapsed to a single level.
          existing.edgeConfidences = [
            weakest(...existing.edgeConfidences, edge.confidence, writer.confidence),
          ];
        }
      }
    }
  }

  const triples: JoinTriple[] = [...byKey.values()];
  triples.sort((a, b) => {
    if (a.firerId !== b.firerId) return a.firerId < b.firerId ? -1 : 1;
    if (a.fieldId !== b.fieldId) return a.fieldId < b.fieldId ? -1 : 1;
    if (a.writerId !== b.writerId) return a.writerId < b.writerId ? -1 : 1;
    return 0;
  });
  return triples;
};

/**
 * Apply ONE scalar comparison operator to an ALREADY-RESOLVED value. Shared by
 * the scalar {@link WhereClause} path ({@link clauseHolds} passes
 * `properties[key]`) AND by the `anyElement` existential ({@link
 * anyElementInnerHolds} passes each array element / element sub-property), so the
 * two can never diverge on operator semantics. Discriminates on WHICH operator
 * key is present (the validator guarantees exactly one). `equals` is checked
 * FIRST and is byte-identical to the pre-operator primitive (`actual === equals`,
 * strict, no coercion). Comparisons are all strict `===` / `!==`:
 *   - `in`    → the array CONTAINS `actual` (SameValueZero via `Array.includes`);
 *   - `notIn` → the array does NOT contain `actual` (matches when `actual` is
 *               `undefined` — an absent property/element — mirroring `!==`);
 *   - `neq`   → `actual !== neq` (likewise matches on an absent value);
 *   - `isNull`→ NULLISH test (NOT falsy): `isNull: true` holds when `actual` is
 *               `null` OR `undefined` (present-as-null OR absent — both mean "no
 *               value here"); `isNull: false` holds for any PRESENT value,
 *               INCLUDING `false` / `0` / `''` (those are present, not nullish).
 *   - `isEmpty`→ EMPTY-ARRAY test (EC-11; WhereClause only): `isEmpty: true`
 *               holds when `actual` is a PRESENT array with `length === 0`;
 *               `isEmpty: false` holds for a PRESENT array with `length > 0`.
 *               Non-array / null / absent ⇒ false either polarity (never equate
 *               missing with empty). Not valid on {@link ArrayElementClause}.
 * An unrecognized clause shape (no known scalar operator key — e.g. an
 * `anyElement`-only clause, or something unreachable past the validator) FAILS
 * CLOSED (matches nothing), never match-all.
 */
const scalarOpHolds = (
  actual: unknown,
  clause: WhereClause | ArrayElementClause,
): boolean => {
  if ('equals' in clause) return actual === clause.equals;
  if ('in' in clause) return clause.in.includes(actual);
  if ('notIn' in clause) return !clause.notIn.includes(actual);
  if ('neq' in clause) return actual !== clause.neq;
  if ('isNull' in clause) {
    const nullish = actual === null || actual === undefined;
    return clause.isNull ? nullish : !nullish;
  }
  if ('isEmpty' in clause) {
    if (!Array.isArray(actual)) return false;
    return clause.isEmpty ? actual.length === 0 : actual.length > 0;
  }
  return false;
};

/**
 * Evaluate an `anyElement` INNER clause against ONE array element. Two modes,
 * selected by whether the inner carries a `key`:
 *   - OBJECT-element mode (`inner.key` PRESENT): the element must be a non-null
 *     object; the operator matches `element[inner.key]` (a non-object / null
 *     element does NOT match — never a thrown property access). This is the
 *     `qualityIssues[].rule ∈ {…}` shape.
 *   - SCALAR-array mode (`inner.key` ABSENT): the element IS the value; the
 *     operator matches it directly. This is the `ApexTrigger.events` `string[]`
 *     membership shape.
 * Both modes delegate the operator comparison to {@link scalarOpHolds}, so inner
 * `in` / `equals` / `neq` / `notIn` behave IDENTICALLY to the top-level scalar
 * clause.
 */
const anyElementInnerHolds = (el: unknown, inner: ArrayElementClause): boolean => {
  if (inner.key !== undefined) {
    if (el === null || typeof el !== 'object') return false;
    return scalarOpHolds((el as Record<string, unknown>)[inner.key], inner);
  }
  return scalarOpHolds(el, inner);
};

/**
 * Does ONE {@link WhereClause} hold against a property bag? The scalar operators
 * (`equals` / `in` / `notIn` / `neq` / `isNull`) resolve `properties[key]` and
 * delegate to {@link scalarOpHolds} — byte-identical to before for every existing
 * clause. The `anyElement` operator is the EXISTENTIAL array-element matcher: it
 * requires `properties[key]` to be an ARRAY and holds iff SOME element satisfies
 * the inner clause (`Array.some`). A NON-ARRAY value (including `undefined` for an
 * absent property) short-circuits to `false`, and a `some` over an EMPTY array is
 * `false`, so the existential NEVER fires on "no elements" — it is an honest
 * "exists an element that matches", never a vacuous match.
 */
const clauseHolds = (
  properties: Readonly<Record<string, unknown>>,
  clause: WhereClause,
): boolean => {
  const actual = properties[clause.key];
  if ('anyElement' in clause) {
    return Array.isArray(actual) && actual.some((el) => anyElementInnerHolds(el, clause.anyElement));
  }
  return scalarOpHolds(actual, clause);
};

export const matchesWhere = (
  properties: Readonly<Record<string, unknown>>,
  where: WhereClause | readonly WhereClause[] | undefined,
): boolean => {
  // `undefined` ⇒ unconstrained (unchanged). A scalar clause is normalized to a
  // one-clause list, so a scalar-`equals` clause is byte-identical to before
  // (`properties[key] === equals`); a non-empty array ANDs every clause. Each
  // clause is evaluated by {@link clauseHolds}, which keeps the equals path
  // untouched and only reaches an operator branch when `equals` is absent.
  // (`Array.isArray` does not narrow a `readonly` array out of the else branch,
  // so the scalar is cast, not relied on to narrow.)
  //
  // Fail-CLOSED on an empty clause list: `[].every(...) === true` would
  // match-all every node/edge, so a malformed empty-clause rule would fabricate
  // a cited claim on 100% of the graph. `assertBind` already rejects `[]` at
  // build and the parity gate byte-compares, so this is unreachable through the
  // normal flow — but since every rule now shares this primitive, the length
  // guard makes a malformed empty-clause rule match NOTHING (safe) rather than
  // EVERYTHING even if the gate is bypassed.
  if (where === undefined) return true;
  const clauses = Array.isArray(where) ? where : [where as WhereClause];
  return clauses.length > 0 && clauses.every((w) => clauseHolds(properties, w));
};

const matchesOrder = (
  properties: Readonly<Record<string, unknown>>,
  order: number | undefined,
): boolean => order === undefined || properties['order'] === order;

/**
 * Evaluate a structural {@link RulePredicate} against a grounded slice.
 *
 * When `bind.edgeType` is set the predicate matches EDGES: an edge matches when
 * its type equals `edgeType`, every `whereProperty` / `edgeWhereProperty` /
 * `order` constraint holds (both `whereProperty` and `edgeWhereProperty` are
 * checked against the EDGE's own `properties` in this branch; `edgeWhereProperty`
 * exists so a rule can bind an edge by one of its own properties — e.g. a
 * `lookupTo` edge with `relationshipType === 'MasterDetail'`),
 * and — if `componentTypes` is set — at least one endpoint resolves (in the
 * slice) to a node of one of those types. The cited ids are the matched edges'
 * endpoints (deduped, in slice / from-then-to order); when `componentTypes` is
 * set ONLY the endpoints whose node type is in that set are cited (so an
 * automation → object edge cites the automation, not the object it references),
 * otherwise both endpoints are cited. Each matched edge contributes its
 * confidence.
 *
 * Otherwise the predicate matches NODES by type (`componentTypes`) /
 * `conditionKind` (via `properties.kind`) / `whereProperty` / `order` — every
 * supplied criterion is conjunctive, so a `componentTypes`-constrained node
 * predicate matches a node only when its type is in the set AND the other
 * checks hold. Node matches carry no confidence (only edges do). A predicate
 * with no node-applicable criterion matches nothing (we never match
 * "everything").
 *
 * FIX 1 — root scoping (BOTH branches): a predicate reasons about the QUERIED
 * component only. When `rootId` is supplied the node branch considers the root
 * node ALONE, and the edge branch considers only edges INCIDENT to the root
 * (`fromId === rootId || toId === rootId`), so a neighbor — or a neighbor's edge —
 * dragged into the slice by a 2-hop expansion (a join's gated Summary/formula
 * field, or the junction aggregate's `root-children-outgoing` child-field
 * `lookupTo` edges) can never be (mis)claimed as if it belonged to the queried
 * component. Originally only the node branch was scoped, on the assumption that
 * edge rules always center on the root; the junction aggregate's shared-slice
 * expansion broke that assumption for co-selected edge rules (a redundant
 * `master-detail-cascade` fire on a junction anchor), so the edge branch is now
 * scoped too. With no `rootId` (raw-predicate unit tests) both branches restore
 * the pre-fix scan-everything behavior.
 */
const runBind = (bind: RulePredicate, slice: GroundedSlice, rootId?: ComponentId): BindResult => {
  const nodesById = new Map<ComponentId, Node>();
  for (const node of slice.nodes) nodesById.set(node.id, node);

  // Edge-shaped predicate.
  if (bind.edgeType !== undefined) {
    const componentTypes = bind.componentTypes;
    const matchedEdges: MatchedEdge[] = [];
    for (const edge of slice.edges) {
      if (edge.edgeType !== bind.edgeType) continue;
      // FIX 1 (edge branch) — root-scope: an edge rule reasons about the QUERIED
      // component, so it may only consider edges INCIDENT to the root. A
      // slice-expanding rule (the junction aggregate's `root-children-outgoing`
      // 2-hop, interpret.ts b3) drags the root OBJECT's CHILD FIELDS' outgoing
      // `lookupTo` edges into the SHARED slice; without this guard the edge-shaped
      // `master-detail-cascade` rule would ALSO scan them and fire redundantly on a
      // junction anchor (4 ids stuffed into a singular-voiced template). Scoping to
      // incident edges keeps md-cascade's OWN legit fires green: a child-MD-FIELD
      // anchor cites its OUTGOING edge (`fromId === rootId`) and a parent-OBJECT
      // anchor its INCOMING edges (`toId === rootId`) — both incident. With no
      // `rootId` (raw-predicate unit tests) the pre-fix scan-every-edge behavior
      // stands. This mirrors FIX 1's node-branch root scoping below.
      if (rootId !== undefined && edge.fromId !== rootId && edge.toId !== rootId) continue;
      if (!matchesWhere(edge.properties, bind.whereProperty)) continue;
      if (!matchesWhere(edge.properties, bind.edgeWhereProperty)) continue;
      if (!matchesOrder(edge.properties, bind.order)) continue;
      // EC-4 — endpoint-node whereProperty on a plain edge. Fail closed when the
      // endpoint node is absent from the slice or does not satisfy the clause.
      if (bind.toWhereProperty !== undefined) {
        const toNode = nodesById.get(edge.toId);
        if (toNode === undefined || !matchesWhere(toNode.properties, bind.toWhereProperty)) continue;
      }
      if (bind.fromWhereProperty !== undefined) {
        const fromNode = nodesById.get(edge.fromId);
        if (fromNode === undefined || !matchesWhere(fromNode.properties, bind.fromWhereProperty)) continue;
      }
      // EC-7 — curated endpoint-object name-set on the `to` endpoint.
      if (bind.toObjectIn !== undefined) {
        const obj = objectOfTriggersOnTarget(edge.toId) ?? objectOfId(edge.toId);
        if (obj === null || !bind.toObjectIn.includes(obj)) continue;
      }
      // EC-16 — endpoint-node TYPE gate. `componentTypes` scopes only which
      // endpoints are CITED (an edge matches if ANY endpoint qualifies), so a
      // rule that asserts a relationship OF a specific endpoint type (a grant
      // FROM a Profile, a reference TO a CustomPermission) must gate the edge on
      // that endpoint's type — otherwise it fires on ANY incident edge whose
      // OTHER endpoint is a cited type. Fail closed when the endpoint node is
      // absent from the slice.
      if (bind.toTypeIn !== undefined) {
        const toNode = nodesById.get(edge.toId);
        if (toNode === undefined || !bind.toTypeIn.includes(toNode.type)) continue;
      }
      if (bind.fromTypeIn !== undefined) {
        const fromNode = nodesById.get(edge.fromId);
        if (fromNode === undefined || !bind.fromTypeIn.includes(fromNode.type)) continue;
      }

      // Which endpoints this matched edge contributes as CITATIONS. With no
      // `componentTypes` constraint both endpoints are cited (legacy behavior).
      // With a constraint, ONLY endpoints whose node type (looked up in the
      // slice) is in the set — so a `triggersOn` (automation → object) edge
      // under `componentTypes: [automations]` cites the automation, NEVER the
      // object it fires on. The edge matches only if ≥1 endpoint qualifies.
      let endpoints: ComponentId[];
      if (componentTypes === undefined) {
        endpoints = [edge.fromId, edge.toId];
      } else {
        endpoints = [edge.fromId, edge.toId].filter((endpoint) => {
          const type = nodesById.get(endpoint)?.type;
          return type !== undefined && componentTypes.includes(type);
        });
        if (endpoints.length === 0) continue;
      }

      // ANCHOR SELF-CITATION GUARD (F6). When the ONLY citation this edge
      // contributes is the queried anchor itself AND the edge's OTHER endpoint is
      // present in the slice but is not a cited type, the edge is a degenerate
      // self-reference: it would fire an "any of [self]" claim. This is exactly an
      // automation anchor's OWN OUTGOING `triggersOn --> CustomObject` edge under a
      // rule whose `componentTypes` cite automations — the status-code
      // cross-reference must fire on an OBJECT anchor (the object's INCOMING
      // `triggersOn` from its save-automations), never on an automation anchor's
      // outgoing edge (where the object endpoint is not a cited type, so only the
      // automation itself qualifies). Skip it.
      //
      // An edge whose OTHER endpoint is ABSENT from the slice is deliberately NOT
      // skipped: that is a legitimately-dangling relationship target (e.g. a
      // master-detail parent object not retrieved into the vault — see
      // concept-rules.yaml `master-detail-cascade`), where the anchored child
      // field is the genuine subject and the relationship claim still holds. The
      // grounded-vs-dangling distinction is what separates the degenerate
      // self-reference from the valid single-endpoint relationship claim.
      if (rootId !== undefined && endpoints.length === 1 && endpoints[0] === rootId) {
        const otherId = edge.fromId === rootId ? edge.toId : edge.fromId;
        if (otherId !== rootId && nodesById.has(otherId)) continue;
      }

      matchedEdges.push({ edge, endpoints });
    }
    // Derive the flat scalar outputs from the matched records: one confidence
    // per matched edge, endpoints deduped in from-then-to / match order. This is
    // byte-identical to the prior inline accumulation (same order, same dedup) —
    // the records only ALSO retain per-edge structure for the witness partition.
    const ids: ComponentId[] = [];
    const seen = new Set<ComponentId>();
    const edgeConfidences: ConfidenceLevel[] = [];
    for (const { edge, endpoints } of matchedEdges) {
      edgeConfidences.push(edge.confidence);
      for (const endpoint of endpoints) {
        if (!seen.has(endpoint)) {
          seen.add(endpoint);
          ids.push(endpoint);
        }
      }
    }
    return { ids, edgeConfidences, matchedEdges };
  }

  // Node-shaped predicate — require at least one node criterion.
  const hasNodeCriterion =
    bind.componentTypes !== undefined ||
    bind.conditionKind !== undefined ||
    bind.whereProperty !== undefined ||
    bind.order !== undefined;
  if (!hasNodeCriterion) return { ids: [], edgeConfidences: [], matchedEdges: [] };

  // FIX 1 — when a root id is supplied, a node-shaped rule matches the root node
  // ONLY (never a neighbor); with none supplied it scans every slice node.
  const candidates: readonly Node[] =
    rootId === undefined
      ? slice.nodes
      : nodesById.has(rootId)
        ? [nodesById.get(rootId)!]
        : [];

  const ids: ComponentId[] = [];
  const seen = new Set<ComponentId>();
  for (const node of candidates) {
    if (bind.componentTypes !== undefined && !bind.componentTypes.includes(node.type)) continue;
    if (bind.conditionKind !== undefined && node.properties['kind'] !== bind.conditionKind) continue;
    if (!matchesWhere(node.properties, bind.whereProperty)) continue;
    if (!matchesOrder(node.properties, bind.order)) continue;
    if (!seen.has(node.id)) {
      seen.add(node.id);
      ids.push(node.id);
    }
  }
  return { ids, edgeConfidences: [], matchedEdges: [] };
};

/**
 * Deterministic template fill. `{ids}` → the matched ids joined with `, `;
 * positional `{0}`, `{1}`, … → the id at that index; a NAMED token present in
 * `named` (e.g. `{writerPhase}` / `{firerPhase}` for a cross-phase claim) → its
 * value. An out-of-range positional token, an unknown named token, or any other
 * `{…}` is left verbatim (unchanged from the prior `{ids}`/`{n}`-only behavior).
 */
const fill = (
  template: string,
  ids: readonly ComponentId[],
  named: Readonly<Record<string, string>> = {},
): string =>
  // EC-13 — also match `{prop:key}` tokens (colon inside braces) for node-property
  // interpolation. Legacy `{ids}` / `{0}` / named phase tokens stay unchanged.
  template.replace(/\{([\w:]+)\}/g, (match, token: string) => {
    if (token === 'ids') return ids.join(', ');
    if (/^\d+$/.test(token)) {
      const index = Number(token);
      return index < ids.length ? ids[index]! : match;
    }
    return token in named ? named[token]! : match;
  });

/** Collect `{prop:key}` → string(value) from a node's properties for EC-13 fill. */
const propNamedFromNode = (n: Node | undefined): Record<string, string> => {
  if (n === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(n.properties)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[`prop:${key}`] = String(value);
    }
  }
  return out;
};

/**
 * Interpret a multi-edge JOIN rule (RM-loop). Emits ONE {@link Interpretation}
 * per grounded (F, X, W) coupling — `groundedIn: [F, X, W]`, the interpretation
 * template filled positionally (`{0}` firer, `{1}` field, `{2}` writer), and
 * `confidence = weakest(rule.maxConfidence, …the two joined edges)` per triple —
 * so an Apex (`heuristic`) `writesTo` drags that coupling to `heuristic` while a
 * `parsed`/`declared` one keeps the ceiling. A join rule is presence-shaped: no
 * coupling ⇒ `[]` (no citation, no claim), and coverage never turns it into an
 * absence conclusion. Pure and deterministic over the slice.
 *
 * RM-loop PASS 2 — when the engine can PROVE a coupling is cross-phase (the
 * triple carries a `crossPhase`) AND the rule supplies an
 * `interpretationCrossPhase` template, the UPGRADED claim is rendered (with the
 * `{writerPhase}` / `{firerPhase}` names filled) instead of the phase-agnostic
 * `interpretation`. Phase derivation adds NO edge, so `confidence` is unchanged
 * (still the weakest of the rule ceiling and the two joined edges).
 */
const interpretJoin = (
  rule: ConceptRule,
  slice: GroundedSlice,
  rootId?: ComponentId,
): Interpretation[] => {
  const phaseFilter = rule.bind.join?.phaseFilter;
  return runJoin(rule.bind, slice, rootId)
    .filter((triple) => {
      // EC-5 — optional phase-direction filter (C10 uses writer-later only).
      if (phaseFilter === undefined) return true;
      return triple.crossPhase?.direction === phaseFilter;
    })
    .map((triple): Interpretation => {
      const groundedIn: readonly ComponentId[] = [triple.firerId, triple.fieldId, triple.writerId];
      // Earlier-only upgrade: the shipped coupling rule's interpretationCrossPhase
      // must NOT fire on a writer-later triple (that is C10's claim).
      const upgrade =
        triple.crossPhase?.direction === 'writer-earlier' &&
        rule.interpretationCrossPhase !== undefined;
      const template = upgrade ? rule.interpretationCrossPhase! : rule.interpretation;
      const named: Readonly<Record<string, string>> =
        triple.crossPhase !== undefined
          ? {
              writerPhase: triple.crossPhase.writerPhase,
              firerPhase: triple.crossPhase.firerPhase,
            }
          : {};
      return {
        ruleId: rule.id,
        concept: rule.concept,
        claim: fill(template, groundedIn, named),
        groundedIn,
        confidence: weakest(rule.maxConfidence, ...triple.edgeConfidences),
        coverageCaveat: null,
        modelVersion: MODEL_VERSION,
        provenance: 'offline_snapshot',
      };
    });
};

/**
 * Object scope of an edge target id — `CustomObject:X` → `X`, or
 * `Type:Object.…` → `Object`. Returns null when the id carries no object scope.
 */
const objectScopeOfEndpoint = (id: ComponentId): string | null =>
  objectOfTriggersOnTarget(id) ?? objectOfId(id);

/**
 * EC-6 / EC-11 — single-node dual-edge object-scope. The root must be the `from`
 * of both edgeTypeA and edgeTypeB. `sameObject: true` requires matching object
 * scopes (C11); `sameObject: false` requires DIFFERENT object scopes (D4). Emits
 * one interpretation citing `[root, targetA, targetB]` for the first matching
 * pair (presence-shaped; no match ⇒ `[]`). Unparseable scopes fail closed.
 */

/**
 * EC-8 — present-A / absent-B anti-join. Finds present-side matches (via the
 * enclosing predicate), then fires only when NO correlating absent-side edge
 * exists. Because the fire condition IS absence of B, incomplete coverage is
 * ALWAYS downgraded to "not checked" (never a confident inert/gap/safe claim).
 */
const interpretAntiJoin = (
  rule: ConceptRule,
  slice: GroundedSlice,
  coverage: Coverage,
  rootId?: ComponentId,
): Interpretation[] => {
  const anti = rule.bind.antiJoin;
  if (anti === undefined) return [];

  const nodesById = new Map(slice.nodes.map((n) => [n.id, n]));
  const triggerTypeByFrom = new Map<ComponentId, string>();
  for (const e of slice.edges) {
    if (e.edgeType !== 'triggersOn') continue;
    const tt = e.properties['triggerType'];
    if (typeof tt === 'string') triggerTypeByFrom.set(e.fromId, tt);
  }

  const phaseIn =
    anti.absentFromPhaseIn !== undefined ? new Set(anti.absentFromPhaseIn) : null;
  const absentFromTypes =
    anti.absentFromTypes !== undefined ? new Set(anti.absentFromTypes) : null;
  const absentToTypes =
    anti.absentToTypes !== undefined ? new Set(anti.absentToTypes) : null;

  const absentEdgeMatches = (edge: Edge, expectedFrom: ComponentId | null, expectedTo: ComponentId | null): boolean => {
    if (edge.edgeType !== anti.absentEdgeType) return false;
    if (expectedFrom !== null && edge.fromId !== expectedFrom) return false;
    if (expectedTo !== null && edge.toId !== expectedTo) return false;
    if (anti.absentEdgeWhereProperty !== undefined) {
      if (!matchesWhere(edge.properties, anti.absentEdgeWhereProperty)) return false;
    }
    const fromNode = nodesById.get(edge.fromId);
    const toNode = nodesById.get(edge.toId);
    // Never treat a dangling absent endpoint as canceling — unresolved ≠ present.
    if (fromNode === undefined || toNode === undefined) return false;
    if (absentFromTypes !== null && !absentFromTypes.has(fromNode.type)) return false;
    if (absentToTypes !== null && !absentToTypes.has(toNode.type)) return false;
    if (!matchesWhere(fromNode.properties, anti.absentFromWhereProperty)) return false;
    if (!matchesWhere(toNode.properties, anti.absentToWhereProperty)) return false;
    if (phaseIn !== null) {
      const phase = phaseOfAutomation(fromNode, triggerTypeByFrom.get(edge.fromId));
      if (phase === null || !phaseIn.has(phase)) return false;
    }
    return true;
  };

  const hasAbsent = (expectedFrom: ComponentId | null, expectedTo: ComponentId | null): boolean => {
    for (const edge of slice.edges) {
      if (absentEdgeMatches(edge, expectedFrom, expectedTo)) return true;
    }
    return false;
  };

  type PresentHit = {
    readonly groundedIn: readonly ComponentId[];
    readonly edgeConfidences: readonly ConfidenceLevel[];
    readonly expectedAbsentFrom: ComponentId | null;
    readonly expectedAbsentTo: ComponentId | null;
  };
  const hits: PresentHit[] = [];

  if (rule.bind.edgeType !== undefined) {
    // EDGE-shaped present side.
    for (const edge of slice.edges) {
      if (edge.edgeType !== rule.bind.edgeType) continue;
      if (anti.correlate === 'sameFromToRoot') {
        // Present targets the root's parent object; root must be supplied.
        if (rootId === undefined) continue;
        const rootObj = objectOfId(rootId);
        if (rootObj === null) continue;
        const parentObjId = `CustomObject:${rootObj}` as ComponentId;
        if (edge.toId !== parentObjId) continue;
        // Root-scope: grantor may be either endpoint; require the present edge
        // to be the object grant for this field's parent (not field-incident).
      } else if (rootId !== undefined) {
        // Standard edge root-scope: edge must be incident to the root.
        if (edge.fromId !== rootId && edge.toId !== rootId) continue;
      }
      const fromNode = nodesById.get(edge.fromId);
      const toNode = nodesById.get(edge.toId);
      if (fromNode === undefined || toNode === undefined) continue;
      if (rule.bind.componentTypes !== undefined) {
        const ok =
          rule.bind.componentTypes.includes(fromNode.type) ||
          rule.bind.componentTypes.includes(toNode.type);
        if (!ok) continue;
      }
      if (!matchesWhere(edge.properties, rule.bind.edgeWhereProperty)) continue;
      if (!matchesWhere(edge.properties, rule.bind.whereProperty)) continue;
      if (rule.bind.toWhereProperty !== undefined) {
        if (!matchesWhere(toNode.properties, rule.bind.toWhereProperty)) continue;
      }
      if (rule.bind.fromWhereProperty !== undefined) {
        if (!matchesWhere(fromNode.properties, rule.bind.fromWhereProperty)) continue;
      }
      // EC-16 — endpoint-node TYPE gate (parity with the plain-edge branch).
      if (rule.bind.toTypeIn !== undefined && !rule.bind.toTypeIn.includes(toNode.type)) continue;
      if (rule.bind.fromTypeIn !== undefined && !rule.bind.fromTypeIn.includes(fromNode.type)) continue;

      let expectedFrom: ComponentId | null = null;
      let expectedTo: ComponentId | null = null;
      if (anti.correlate === 'sameFrom') {
        expectedFrom = edge.fromId;
      } else if (anti.correlate === 'sameTo') {
        expectedTo = edge.toId;
      } else if (anti.correlate === 'sameFromToPresentObject') {
        const obj = objectOfId(edge.toId);
        if (obj === null) continue;
        expectedFrom = edge.fromId;
        expectedTo = `CustomObject:${obj}` as ComponentId;
      } else if (anti.correlate === 'sameFromToRoot') {
        if (rootId === undefined) continue;
        expectedFrom = edge.fromId;
        expectedTo = rootId;
      }

      // Citation: both endpoints of the present edge (and root when distinct).
      const grounded: ComponentId[] = [];
      for (const id of [edge.fromId, edge.toId, rootId]) {
        if (id !== undefined && !grounded.includes(id)) grounded.push(id);
      }
      hits.push({
        groundedIn: grounded,
        edgeConfidences: [edge.confidence],
        expectedAbsentFrom: expectedFrom,
        expectedAbsentTo: expectedTo,
      });
    }
  } else {
    // NODE-shaped present side (C17).
    if (rootId === undefined) return [];
    const root = nodesById.get(rootId);
    if (root === undefined) return [];
    if (
      rule.bind.componentTypes !== undefined &&
      !rule.bind.componentTypes.includes(root.type)
    ) {
      return [];
    }
    if (!matchesWhere(root.properties, rule.bind.whereProperty)) return [];

    let expectedFrom: ComponentId | null = null;
    let expectedTo: ComponentId | null = null;
    if (anti.correlate === 'sameTo' || anti.correlate === 'sameFromToRoot') {
      expectedTo = rootId;
    } else if (anti.correlate === 'sameFrom') {
      expectedFrom = rootId;
    } else if (anti.correlate === 'sameFromToPresentObject') {
      const obj = objectOfId(rootId);
      if (obj === null) return [];
      expectedFrom = rootId;
      expectedTo = `CustomObject:${obj}` as ComponentId;
    }
    hits.push({
      groundedIn: [rootId],
      edgeConfidences: [],
      expectedAbsentFrom: expectedFrom,
      expectedAbsentTo: expectedTo,
    });
  }

  // Keep only present hits whose correlating absent edge is truly missing.
  const surviving = hits.filter(
    (h) => !hasAbsent(h.expectedAbsentFrom, h.expectedAbsentTo),
  );
  if (surviving.length === 0) return [];

  // Absence-shaped honesty: never claim inert/gap/safe under incomplete coverage.
  if (coverage.status !== 'complete') {
    const groundedIn = surviving[0]!.groundedIn;
    return [
      {
        ruleId: rule.id,
        concept: rule.concept,
        claim:
          `not checked — coverage is ${coverage.status}; the absence-based conclusion ` +
          `for ${rule.concept} was not verified.`,
        groundedIn,
        confidence: 'unknown',
        coverageCaveat: coverage.caveat,
        modelVersion: MODEL_VERSION,
        provenance: 'offline_snapshot',
      },
    ];
  }

  // One interpretation per surviving present hit (dedupe by groundedIn join).
  const seen = new Set<string>();
  const out: Interpretation[] = [];
  for (const hit of surviving) {
    const key = hit.groundedIn.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ruleId: rule.id,
      concept: rule.concept,
      claim: fill(rule.interpretation, hit.groundedIn),
      groundedIn: hit.groundedIn,
      confidence: weakest(rule.maxConfidence, ...hit.edgeConfidences),
      coverageCaveat: null,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    });
  }
  return out;
};

/**
 * EC-9 — set-difference JOIN. Collect INCLUDE and SUBTRACT outgoing edge sets
 * from the root; fire when include is non-empty and (by default) subtract is
 * also non-empty. Citations: root + sorted include targets + sorted subtract
 * targets. STRUCTURAL only — does not expand grants vs muted* properties.
 */
const interpretSetDifference = (
  rule: ConceptRule,
  slice: GroundedSlice,
  rootId?: ComponentId,
): Interpretation[] => {
  const sd = rule.bind.setDifference;
  if (sd === undefined) return [];
  if (rootId === undefined) return [];

  const nodesById = new Map(slice.nodes.map((n) => [n.id, n]));
  const root = nodesById.get(rootId);
  if (root === undefined) return [];

  if (
    rule.bind.componentTypes !== undefined &&
    !rule.bind.componentTypes.includes(root.type)
  ) {
    return [];
  }
  if (!matchesWhere(root.properties, rule.bind.whereProperty)) return [];

  const includeToTypes =
    sd.includeToTypes !== undefined ? new Set(sd.includeToTypes) : null;
  const subtractToTypes =
    sd.subtractToTypes !== undefined ? new Set(sd.subtractToTypes) : null;

  const collectSide = (
    edgeType: Edge['edgeType'],
    edgeWhere: { readonly key: string; readonly equals: unknown } | undefined,
    toTypes: Set<Node['type']> | null,
  ): { readonly ids: ComponentId[]; readonly confidences: ConfidenceLevel[] } => {
    const ids: ComponentId[] = [];
    const confidences: ConfidenceLevel[] = [];
    for (const edge of slice.edges) {
      if (edge.edgeType !== edgeType) continue;
      if (edge.fromId !== rootId) continue;
      if (edgeWhere !== undefined && !matchesWhere(edge.properties, edgeWhere)) continue;
      const toNode = nodesById.get(edge.toId);
      // Dangling endpoint ≠ present member/mute — fail closed.
      if (toNode === undefined) continue;
      if (toTypes !== null && !toTypes.has(toNode.type)) continue;
      if (!ids.includes(edge.toId)) {
        ids.push(edge.toId);
        confidences.push(edge.confidence);
      }
    }
    return { ids, confidences };
  };

  const include = collectSide(
    sd.includeEdgeType,
    sd.includeEdgeWhereProperty,
    includeToTypes,
  );
  const subtract = collectSide(
    sd.subtractEdgeType,
    sd.subtractEdgeWhereProperty,
    subtractToTypes,
  );

  if (include.ids.length === 0) return [];
  const requireBoth = sd.requireBothNonEmpty !== false;
  if (requireBoth && subtract.ids.length === 0) return [];

  const includeSorted = [...include.ids].sort();
  const subtractSorted = [...subtract.ids].sort();
  const groundedIn: readonly ComponentId[] = [
    rootId,
    ...includeSorted,
    ...subtractSorted,
  ];

  return [
    {
      ruleId: rule.id,
      concept: rule.concept,
      claim: fill(rule.interpretation, groundedIn),
      groundedIn,
      confidence: weakest(
        rule.maxConfidence,
        ...include.confidences,
        ...subtract.confidences,
      ),
      coverageCaveat: null,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    },
  ];
};

/**
 * Salesforce OWD / external-sharing-model permissiveness ranks (EC-12). Higher
 * = more permissive. Tokens not in this table fail closed (unknown shape).
 * ControlledByParent / ControlledByCampaign share Private's floor — they are
 * not independently "wider" baselines.
 */
const OWD_PERMISSIVENESS_RANK: Readonly<Record<string, number>> = {
  Private: 0,
  ControlledByParent: 0,
  ControlledByCampaign: 0,
  Read: 1,
  ReadWrite: 2,
  ReadWriteTransfer: 3,
  FullAccess: 4,
};

const rankOfOwd = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const rank = OWD_PERMISSIVENESS_RANK[value];
  return rank === undefined ? null : rank;
};

const propertyCompareOpHolds = (
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq',
  left: number,
  right: number,
): boolean => {
  switch (op) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
  }
};

/**
 * EC-12 — property-vs-property comparison on one root node. Both property
 * values must be present and rankable under the named table; otherwise fail
 * closed. Presence-shaped (no match ⇒ `[]`).
 */
const interpretPropertyCompare = (
  rule: ConceptRule,
  slice: GroundedSlice,
  rootId?: ComponentId,
): Interpretation[] => {
  const pc = rule.bind.propertyCompare;
  if (pc === undefined) return [];
  if (rootId === undefined) return [];

  const root = slice.nodes.find((n) => n.id === rootId);
  if (root === undefined) return [];

  if (
    rule.bind.componentTypes !== undefined &&
    !rule.bind.componentTypes.includes(root.type)
  ) {
    return [];
  }
  if (!matchesWhere(root.properties, rule.bind.whereProperty)) return [];

  let leftRank: number | null = null;
  let rightRank: number | null = null;
  if (pc.rankTable === 'owdPermissiveness') {
    leftRank = rankOfOwd(root.properties[pc.leftKey]);
    rightRank = rankOfOwd(root.properties[pc.rightKey]);
  }
  if (leftRank === null || rightRank === null) return [];
  if (!propertyCompareOpHolds(pc.op, leftRank, rightRank)) return [];

  const groundedIn: readonly ComponentId[] = [rootId];
  return [
    {
      ruleId: rule.id,
      concept: rule.concept,
      claim: fill(rule.interpretation, groundedIn, propNamedFromNode(root)),
      groundedIn,
      confidence: rule.maxConfidence,
      coverageCaveat: null,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    },
  ];
};

/**
 * D9 / property-equals-endpoint — compare a NODE PROPERTY on the root (an object
 * API name, e.g. a Flow's declared `triggerObject`) to the OBJECT SCOPE of one
 * of the root's outgoing `endpointEdgeType` edges, optionally gated by the
 * endpoint edge's own properties (`endpointEdgeWhereProperty`, e.g. a DML
 * `operation` set). Fires on the FIRST endpoint whose parsed object scope
 * `equal`s (or, with `notEqual`, differs from) the node-property value, citing
 * `[root, endpoint]`.
 *
 * This is the honest complement to EC-6 {@link interpretDualEdge}
 * `sameObject:true`: dualEdge derives the trigger object from a `triggersOn`
 * EDGE and matches ANY `writesTo` — including a record-triggered Flow's
 * before-save in-place `$Record` field assignment (`operation:
 * beforeSaveFieldAssignment`), which mutates the triggering record in memory and
 * does NOT re-enter the save. This path instead grounds the trigger object on
 * the DECLARED node property and lets the rule gate the write to an actual DML
 * statement, so `concept:flow-self-dml-reentry` isolates genuine self-DML
 * re-entry from a non-reentrant in-place assignment. A blank/absent node
 * property or an endpoint whose scope cannot be parsed fails closed.
 * Presence-shaped (no match ⇒ `[]`).
 */
const interpretPropertyEqualsEndpoint = (
  rule: ConceptRule,
  slice: GroundedSlice,
  rootId?: ComponentId,
): Interpretation[] => {
  const pee = rule.bind.propertyEqualsEndpoint;
  if (pee === undefined) return [];
  if (rootId === undefined) return [];

  const root = slice.nodes.find((n) => n.id === rootId);
  if (root === undefined) return [];

  if (
    rule.bind.componentTypes !== undefined &&
    !rule.bind.componentTypes.includes(root.type)
  ) {
    return [];
  }
  if (!matchesWhere(root.properties, rule.bind.whereProperty)) return [];
  if (pee.excludeInactive === true && !isActiveSoeFirer(root)) return [];

  const nodeValue = root.properties[pee.nodeProperty];
  if (typeof nodeValue !== 'string' || nodeValue.length === 0) return [];

  const edges = slice.edges.filter(
    (e) => e.edgeType === pee.endpointEdgeType && e.fromId === rootId,
  );
  for (const edge of edges) {
    if (!matchesWhere(edge.properties, pee.endpointEdgeWhereProperty)) continue;
    const endpointObject = objectScopeOfEndpoint(edge.toId);
    if (endpointObject === null) continue;
    const isEqual = endpointObject === nodeValue;
    if (pee.relation === 'equal' ? !isEqual : isEqual) continue;
    const groundedIn: readonly ComponentId[] = [rootId, edge.toId];
    const operation = edge.properties['operation'];
    const named: Readonly<Record<string, string>> = {
      ...propNamedFromNode(root),
      writeOp: typeof operation === 'string' && operation.length > 0 ? operation : 'write',
    };
    return [
      {
        ruleId: rule.id,
        concept: rule.concept,
        claim: fill(rule.interpretation, groundedIn, named),
        groundedIn,
        confidence: weakest(rule.maxConfidence, edge.confidence),
        coverageCaveat: null,
        modelVersion: MODEL_VERSION,
        provenance: 'offline_snapshot',
      },
    ];
  }
  return [];
};

/**
 * Field API name from a `CustomField:Object.Field` id (everything after the
 * first `.`). Returns null when the id is not a CustomField with a field
 * segment — fail closed for fieldJoin sibling resolution.
 */
const FIELD_API_OF_ID_RE = /^CustomField:[^.]+\.(.+)$/;
const fieldApiOfId = (id: ComponentId): string | null =>
  FIELD_API_OF_ID_RE.exec(id)?.[1] ?? null;

/**
 * Collect string element values from an array-of-objects property. Non-array /
 * empty / non-object elements / empty strings are skipped. Optional
 * equals-only element filter (right side of orphan set-diff).
 */
const collectArrayElementStrings = (
  raw: unknown,
  elementKey: string,
  elementWhere?: { readonly key: string; readonly equals: unknown },
): Set<string> => {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const el of raw) {
    if (el === null || typeof el !== 'object' || Array.isArray(el)) continue;
    const rec = el as Record<string, unknown>;
    if (elementWhere !== undefined && rec[elementWhere.key] !== elementWhere.equals) {
      continue;
    }
    const v = rec[elementKey];
    if (typeof v === 'string' && v.length > 0) out.add(v);
  }
  return out;
};

/**
 * EC-10 — intra-object name-based field join (+ optional orphan set-diff).
 * Resolves a sibling CustomField on the same object by API name from
 * `nameProperty`, then fires when orphanSetDiff's left − right is non-empty.
 * Missing sibling / ungrounded right array ⇒ fail closed.
 */
const interpretFieldJoin = (
  rule: ConceptRule,
  slice: GroundedSlice,
  rootId?: ComponentId,
): Interpretation[] => {
  const fj = rule.bind.fieldJoin;
  if (fj === undefined) return [];
  if (rootId === undefined) return [];

  const root = slice.nodes.find((n) => n.id === rootId);
  if (root === undefined) return [];

  if (
    rule.bind.componentTypes !== undefined &&
    !rule.bind.componentTypes.includes(root.type)
  ) {
    return [];
  }
  if (!matchesWhere(root.properties, rule.bind.whereProperty)) return [];

  const siblingName = root.properties[fj.nameProperty];
  if (typeof siblingName !== 'string' || siblingName.length === 0) return [];

  const rootObject = objectOfId(rootId);
  if (rootObject === null) return [];

  const sibling = slice.nodes.find((n) => {
    if (n.type !== 'CustomField' || n.id === rootId) return false;
    if (objectOfId(n.id) !== rootObject) return false;
    return fieldApiOfId(n.id) === siblingName;
  });
  if (sibling === undefined) return [];

  const od = fj.orphanSetDiff;
  if (od === undefined) {
    // Name-join only (no set-diff) — presence of the sibling is enough.
    const groundedIn: readonly ComponentId[] = [rootId, sibling.id];
    return [
      {
        ruleId: rule.id,
        concept: rule.concept,
        claim: fill(rule.interpretation, groundedIn, propNamedFromNode(root)),
        groundedIn,
        confidence: rule.maxConfidence,
        coverageCaveat: null,
        modelVersion: MODEL_VERSION,
        provenance: 'offline_snapshot',
      },
    ];
  }

  // Fail closed when the sibling's right array is absent/null — cannot prove
  // orphans without a grounded controlling value set (e.g. GVS-only fields).
  const rightRaw = sibling.properties[od.rightArrayKey];
  if (!Array.isArray(rightRaw)) return [];

  const left = collectArrayElementStrings(
    root.properties[od.leftArrayKey],
    od.leftElementKey,
  );
  if (left.size === 0) return [];

  const right = collectArrayElementStrings(
    rightRaw,
    od.rightElementKey,
    od.rightElementWhere,
  );

  const orphans: string[] = [];
  for (const v of left) {
    if (!right.has(v)) orphans.push(v);
  }
  orphans.sort();
  if (orphans.length === 0) return [];

  const groundedIn: readonly ComponentId[] = [rootId, sibling.id];
  return [
    {
      ruleId: rule.id,
      concept: rule.concept,
      claim: fill(rule.interpretation, groundedIn, {
        ...propNamedFromNode(root),
        orphanValues: orphans.join(', '),
      }),
      groundedIn,
      confidence: rule.maxConfidence,
      coverageCaveat: null,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    },
  ];
};

const interpretDualEdge = (
  rule: ConceptRule,
  slice: GroundedSlice,
  rootId?: ComponentId,
): Interpretation[] => {
  const dual = rule.bind.dualEdge;
  if (dual === undefined) return [];
  if (rootId === undefined) return [];

  const nodesById = new Map(slice.nodes.map((n) => [n.id, n]));
  const root = nodesById.get(rootId);
  if (root === undefined) return [];

  // Apply outer node filters (componentTypes / whereProperty) to the root.
  if (
    rule.bind.componentTypes !== undefined &&
    !rule.bind.componentTypes.includes(root.type)
  ) {
    return [];
  }
  if (!matchesWhere(root.properties, rule.bind.whereProperty)) return [];
  if (dual.excludeInactive === true && !isActiveSoeFirer(root)) return [];

  const edgesA = slice.edges.filter(
    (e) => e.edgeType === dual.edgeTypeA && e.fromId === rootId,
  );
  const edgesB = slice.edges.filter(
    (e) => e.edgeType === dual.edgeTypeB && e.fromId === rootId,
  );
  if (edgesA.length === 0 || edgesB.length === 0) return [];

  for (const edgeA of edgesA) {
    const objA = objectScopeOfEndpoint(edgeA.toId);
    // Both polarities need a parseable trigger-side object scope.
    if (objA === null) continue;
    for (const edgeB of edgesB) {
      const objB = objectScopeOfEndpoint(edgeB.toId);
      if (objB === null) continue;
      if (dual.sameObject) {
        if (objB !== objA) continue;
      } else {
        // EC-11 — require CROSS-object (never unconstrained when sameObject:false).
        if (objB === objA) continue;
      }
      const groundedIn: readonly ComponentId[] = [rootId, edgeA.toId, edgeB.toId];
      return [
        {
          ruleId: rule.id,
          concept: rule.concept,
          claim: fill(rule.interpretation, groundedIn),
          groundedIn,
          confidence: weakest(rule.maxConfidence, edgeA.confidence, edgeB.confidence),
          coverageCaveat: null,
          modelVersion: MODEL_VERSION,
          provenance: 'offline_snapshot',
        },
      ];
    }
  }
  return [];
};

/**
 * EC-11 / D3 — cross-object cascade-save (a NEW 2-edge join, distinct from
 * {@link interpretDualEdge}). The writer root W is the `from` of a
 * `writerTriggerEdge` (giving its OWN trigger object A) and a `writeEdge` to a
 * target on a DIFFERENT object B (B ≠ A), AND object B is itself the `to` of at
 * least one INCOMING automation edge (one of `targetIncomingEdgeTypes`) from a
 * node OTHER than W — that incoming automation is the second edge the single-node
 * dual-edge cannot express. When all three hold, a save on B triggered by the
 * cross-object write runs B's full save order inside the SAME transaction,
 * sharing the governor budget. Emits ONE interpretation citing
 * `[W, writeTargetOnB, automationOnB]` for the first matching pair.
 *
 * Honesty / fail-closed:
 *   - No parseable trigger-object scope for W ⇒ `[]` (cannot prove cross-object).
 *   - A same-object write (B === A) ⇒ skipped (that is C11 / dualEdge territory).
 *   - An unparseable write target or incoming-automation target scope ⇒ skipped.
 *   - `excludeInactive` drops a provably-inactive writer AND requires the
 *     target-side automation node to be present and NOT provably inactive.
 *   - `excludeBeforeSaveFlowWriter` drops a RecordBeforeSave Flow writer (its
 *     cross-object DML is a no-op — that is D4's claim, not a real cascade).
 *   - The claim is a DECLARED structural shape: it does NOT prove the write runs
 *     at runtime or that any governor limit is actually breached.
 */
const interpretCrossObjectCascade = (
  rule: ConceptRule,
  slice: GroundedSlice,
  rootId?: ComponentId,
): Interpretation[] => {
  const cc = rule.bind.crossObjectCascade;
  if (cc === undefined) return [];
  if (rootId === undefined) return [];

  const nodesById = new Map(slice.nodes.map((n) => [n.id, n]));
  const root = nodesById.get(rootId);
  if (root === undefined) return [];

  if (
    rule.bind.componentTypes !== undefined &&
    !rule.bind.componentTypes.includes(root.type)
  ) {
    return [];
  }
  if (!matchesWhere(root.properties, rule.bind.whereProperty)) return [];
  if (cc.excludeInactive === true && !isActiveSoeFirer(root)) return [];

  const triggerEdges = slice.edges.filter(
    (e) => e.edgeType === cc.writerTriggerEdge && e.fromId === rootId,
  );
  const objectsA = new Set<string>();
  for (const edge of triggerEdges) {
    const objA = objectScopeOfEndpoint(edge.toId);
    if (objA !== null) objectsA.add(objA);
  }
  if (objectsA.size === 0) return [];

  if (cc.excludeBeforeSaveFlowWriter === true && root.type === 'Flow') {
    const triggerType = triggerEdges
      .map((e) =>
        typeof e.properties.triggerType === 'string' ? e.properties.triggerType : undefined,
      )
      .find((t) => t !== undefined);
    if (phaseOfAutomation(root, triggerType) === 'before-save-flows') return [];
  }

  const writeEdges = slice.edges.filter(
    (e) => e.edgeType === cc.writeEdge && e.fromId === rootId,
  );

  for (const writeEdge of writeEdges) {
    const objB = objectScopeOfEndpoint(writeEdge.toId);
    if (objB === null) continue;
    if (objectsA.has(objB)) continue;

    for (const incoming of slice.edges) {
      if (!cc.targetIncomingEdgeTypes.includes(incoming.edgeType)) continue;
      if (incoming.fromId === rootId) continue;
      const targetObj = objectScopeOfEndpoint(incoming.toId);
      if (targetObj === null || targetObj !== objB) continue;
      if (cc.excludeInactive === true) {
        const firer = nodesById.get(incoming.fromId);
        if (firer === undefined || !isActiveSoeFirer(firer)) continue;
      }
      const groundedIn: readonly ComponentId[] = [rootId, writeEdge.toId, incoming.fromId];
      return [
        {
          ruleId: rule.id,
          concept: rule.concept,
          claim: fill(rule.interpretation, groundedIn),
          groundedIn,
          confidence: weakest(rule.maxConfidence, writeEdge.confidence, incoming.confidence),
          coverageCaveat: null,
          modelVersion: MODEL_VERSION,
          provenance: 'offline_snapshot',
        },
      ];
    }
  }
  return [];
};

/**
 * The three record-triggered-Flow trigger CONTEXTS a `triggersOn` edge can carry
 * — the ONLY contexts in which two active flows on one object can co-execute in
 * an undefined order (a genuine automation collision). Mirrors the extractor's
 * `RECORD_TRIGGER_TYPES` (`extractors/src/flow.ts`): `RecordBeforeSave`,
 * `RecordAfterSave`, `RecordBeforeDelete` are the only `triggerType`s that emit a
 * `triggersOn` edge, and a record-triggered Flow always carries exactly one.
 */
type TriggerContext = 'before-save' | 'after-save' | 'before-delete';

/** Deterministic emit order over {@link TriggerContext} (save timing, then delete). */
const TRIGGER_CONTEXTS: readonly TriggerContext[] = [
  'before-save',
  'after-save',
  'before-delete',
];

/**
 * Map a record-trigger `triggerType` to its exact {@link TriggerContext}, or
 * `null` when the value is absent/unknown.
 *
 *   - `RecordBeforeSave`   → `before-save`
 *   - `RecordAfterSave`    → `after-save`
 *   - `RecordBeforeDelete` → `before-delete`
 *   - anything else / absent → `null`
 *
 * These are the ONLY three record-trigger types the Flow extractor emits a
 * `triggersOn` edge for (`RECORD_TRIGGER_TYPES`). A `before-delete` flow runs on
 * the DELETE path and can NEVER co-execute with a save-timing flow, so it is a
 * bucket of its OWN — folding it into a save bucket (the pre-fix `!= 'before'
 * ⇒ after` catch-all) fabricated false "two flows in the same save phase"
 * collisions between a `RecordAfterSave` and a `RecordBeforeDelete` flow (the
 * HIGH cry-wolf bug). Returning `null` for an absent/unknown value means such an
 * edge is NOT counted toward ANY collision (honesty by construction — we never
 * fold an unplaceable trigger type into a save bucket to inflate a count).
 */
const triggerContextOf = (triggerType: unknown): TriggerContext | null => {
  switch (triggerType) {
    case 'RecordBeforeSave':
      return 'before-save';
    case 'RecordAfterSave':
      return 'after-save';
    case 'RecordBeforeDelete':
      return 'before-delete';
    default:
      return null;
  }
};

/**
 * The concrete DML operations a stacked-flows bucket can co-fire on. Two flows
 * "run in an undefined order on one save" ONLY when they execute on the SAME
 * concrete DML operation — an insert, an update, or a delete. A single record
 * save is exactly one of these, so the set of flows firing on it is exactly one
 * of the buckets below.
 */
type DmlEvent = 'insert' | 'update' | 'delete';

/** Deterministic emit order over {@link DmlEvent} (save events, then delete). */
const DML_EVENTS: readonly DmlEvent[] = ['insert', 'update', 'delete'];

/**
 * The DML operation(s) a record-triggered Flow fires on within a given
 * {@link TriggerContext}, derived from its `recordTriggerType`
 * (REASONING-STACKED-FLOWS-IGNORES-RECORD-TRIGGER-TYPE).
 *
 *   - a `before-delete` flow fires only on the DELETE path, so it is always the
 *     single `delete` event regardless of `recordTriggerType` — before-delete is
 *     a bucket of its own and never splits;
 *   - a save-timing (`before-save` / `after-save`) flow fires on:
 *       * `Create`            → `insert` only,
 *       * `Update`            → `update` only,
 *       * `CreateAndUpdate`   → BOTH `insert` and `update` (it participates in
 *                               each event bucket — this is why a CreateAndUpdate
 *                               flow can co-fire with a Create-only flow on insert
 *                               AND with an Update-only flow on update),
 *       * anything else/absent → conservatively BOTH events. A real record-
 *         triggered save flow always carries one of the three values above; an
 *         unknown one is placed in both rather than dropped, so a genuinely-firing
 *         flow is never silently excluded from a real stack (never an under-report
 *         of a collision, and never a fabricated single-event exclusion).
 *
 * This is what stops the cry-wolf bug: a Create-ONLY flow lands ONLY in `insert`
 * and an Update-ONLY flow ONLY in `update`, so two mutually-exclusive flows never
 * share a bucket and never fabricate a same-save collision.
 */
const dmlEventsOf = (recordTriggerType: unknown, context: TriggerContext): readonly DmlEvent[] => {
  if (context === 'before-delete') return ['delete'];
  switch (recordTriggerType) {
    case 'Create':
      return ['insert'];
    case 'Update':
      return ['update'];
    case 'CreateAndUpdate':
      return ['insert', 'update'];
    default:
      return ['insert', 'update'];
  }
};

/**
 * Separator joining a {@link TriggerContext} with a {@link DmlEvent} into a
 * compound bucket key (`before-save insert`) for the event-split stacked-flows
 * path. Both tokens are closed sets that never contain a space, so a compound key
 * never collides with a bare-context key (the non-event-split path) or the
 * NUL-prefixed {@link SINGLE_GROUP} sentinel.
 */
const EVENT_KEY_SEP = ' ';

/** Whether a group's `count` satisfies the aggregate `op` against `threshold`. */
const aggregateOpHolds = (
  op: RuleAggregate['op'],
  count: number,
  threshold: number | undefined,
): boolean => {
  if (op === undefined || threshold === undefined) return false;
  switch (op) {
    case 'gte':
      return count >= threshold;
    case 'eq':
      return count === threshold;
  }
};

/** Normalize a {@link WhereClause} bind to a non-empty clause list (ANDed). */
const whereClauses = (where: WhereClause | readonly WhereClause[]): readonly WhereClause[] =>
  (Array.isArray(where) ? where : [where]) as readonly WhereClause[];

/**
 * EC-14 — ordinal/first-match aggregate (D10). Evaluates counted edges in
 * ascending `ordinalEdgeProperty` order; fires when a broad catch-all entry
 * precedes at least one specific later entry. FAIL CLOSED on any counted edge
 * missing the ordinal or any `broadEntryWhere` property key.
 */
const interpretFirstMatchOrdinal = (
  rule: ConceptRule,
  slice: GroundedSlice,
  coverage: Coverage,
  rootId: ComponentId,
  agg: RuleAggregate,
): Interpretation[] => {
  const fmo = agg.firstMatchOrdinal;
  if (fmo === undefined) return [];

  const nodesById = new Map<ComponentId, Node>();
  for (const node of slice.nodes) nodesById.set(node.id, node);
  const rootNode = nodesById.get(rootId);
  if (rootNode === undefined) return [];
  if (!matchesWhere(rootNode.properties, rule.bind.whereProperty)) return [];

  const componentTypes = rule.bind.componentTypes;
  const edgeSource = agg.edgeSource ?? 'root-incident';
  const countDistinctEndpoint = agg.countDistinctEndpoint ?? 'from';
  const broadClauses = whereClauses(fmo.broadEntryWhere);
  const broadKeys = broadClauses.map((c) => c.key);

  interface RankedEdge {
    readonly edge: Edge;
    readonly ordinal: number;
    readonly countedId: ComponentId;
    readonly isBroad: boolean;
  }
  const ranked: RankedEdge[] = [];

  for (const edge of slice.edges) {
    if (edge.edgeType !== rule.bind.edgeType) continue;
    if (!matchesWhere(edge.properties, agg.countedEdgeWhereProperty)) continue;

    if (edgeSource === 'root-incident') {
      if (edge.toId !== rootId) continue;
    } else if (edgeSource === 'root-outgoing') {
      if (edge.fromId !== rootId) continue;
    } else {
      const fromNode = nodesById.get(edge.fromId);
      if (fromNode === undefined) continue;
      if (fromNode.parentId !== rootId) continue;
    }

    const ordinal = edge.properties[fmo.ordinalEdgeProperty];
    if (typeof ordinal !== 'number') return []; // fail closed — ordering not grounded

    for (const key of broadKeys) {
      if (!(key in edge.properties)) return []; // fail closed — broad shape unknown
    }

    const countedId = countDistinctEndpoint === 'to' ? edge.toId : edge.fromId;
    const countedNode = nodesById.get(countedId);
    if (countedNode === undefined) continue;
    if (componentTypes !== undefined && !componentTypes.includes(countedNode.type)) continue;
    if (!matchesWhere(countedNode.properties, agg.endpointWhereProperty)) continue;

    ranked.push({
      edge,
      ordinal,
      countedId,
      isBroad: matchesWhere(edge.properties, fmo.broadEntryWhere),
    });
  }

  if (ranked.length < 2) return [];

  ranked.sort((a, b) => a.ordinal - b.ordinal || a.countedId.localeCompare(b.countedId));

  const broadIdx = ranked.findIndex((r) => r.isBroad);
  if (broadIdx === -1) return [];

  const starved = ranked.slice(broadIdx + 1).filter((r) => !r.isBroad);
  if (starved.length === 0) return [];

  const broad = ranked[broadIdx]!;
  const citedTargets = [...new Set(starved.map((r) => r.countedId))].sort();
  const groundedIn = [rootId, broad.countedId, ...citedTargets];
  const coverageCaveat = coverage.status === 'complete' ? null : coverage.caveat;

  return [
    {
      ruleId: rule.id,
      concept: rule.concept,
      claim: fill(rule.interpretation, groundedIn, {
        broadOrdinal: String(broad.ordinal),
        starvedCount: String(starved.length),
        object: rootId,
      }),
      groundedIn,
      confidence: weakest(
        rule.maxConfidence,
        broad.edge.confidence,
        ...starved.map((r) => r.edge.confidence),
      ),
      coverageCaveat,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    },
  ];
};

/**
 * The sentinel group key for an aggregate with no `groupByEdgeProperty`: a
 * SINGLE undifferentiated bucket over every surviving edge (the junction-object
 * count — no trigger-context bucketing). Distinct from any {@link TriggerContext}
 * value, so the grouped stacked-flows path is untouched.
 */
const SINGLE_GROUP = 'single-group';

/**
 * Interpret an AGGREGATE group-count rule (RM-loop) for the queried ROOT node.
 * Deterministic and pure over the slice.
 *
 * Matches every `rule.bind.edgeType` edge INCOMING to `rootId` whose `from`
 * endpoint (the firer) resolves in the slice to a `rule.bind.componentTypes`
 * node, then FILTERS the counted endpoints by `aggregate.endpointWhereProperty`
 * against the ENDPOINT NODE's own property — the LOAD-BEARING active filter
 * (`status === 'Active'`): an obsolete / draft / invalid-draft Flow VERSION (or
 * a status-less endpoint) is never counted, so the rule cannot cry wolf over
 * dead metadata. Surviving edges are GROUPED by `aggregate.groupByEdgeProperty`
 * — a record-trigger `triggerType` mapped to its exact {@link TriggerContext}
 * (before-save / after-save / before-delete). The three contexts are DISJOINT:
 * a `before-delete` flow runs only on the DELETE path, so it never co-executes
 * with a save-timing flow — bucketing it separately is what stops the HIGH
 * cry-wolf bug where a `RecordAfterSave` + a `RecordBeforeDelete` flow falsely
 * read as "two flows in the same save phase". An absent/unknown trigger type
 * ({@link triggerContextOf} returns `null`) is NOT counted toward any context —
 * it can never inflate a collision. For each group whose DISTINCT-endpoint count
 * satisfies `op threshold`, emits ONE interpretation:
 *   - `groundedIn` cites the group's FIRER ids (the stacked automations — the
 *     thing to fix) followed by the ROOT as context (never as a culprit);
 *   - the template is filled with `{ids}` (the firer ids), `{object}` (the
 *     root), `{count}` (the REAL group size, so a 2-flow object self-discloses a
 *     mild note and a 16-flow object a strong one), and `{timing}` (the actual
 *     context: before-save / after-save / before-delete — NEVER a hardcoded
 *     "save phase", which is false for the delete path); and
 *   - `confidence = weakest(rule.maxConfidence, …the group's counted edges)`.
 *
 * FIX 4 — when the slice was TRUNCATED (its incident `triggersOn` fan-out was
 * capped, so the caller's `coverage` is downgraded below `complete`), the count
 * is a FLOOR: real collisions may be larger than reported (an UNDER-claim, never
 * cry-wolf). The caller's `coverage.caveat` is surfaced on each interpretation's
 * `coverageCaveat` so the under-count is disclosed rather than presented as
 * exact; under `complete` coverage it stays `null`.
 *
 * A root-scoped rule: with no `rootId` (raw-predicate unit tests) there is no
 * object to anchor the incoming-edge count on, so it yields `[]`. Groups are
 * emitted before-save → after-save → before-delete and firer ids sorted, so the
 * output is reproducible.
 *
 * GENERALIZATION (junction objects) — the aggregate is a bounded generalization
 * of the shipped stacked-flows count, driven by four ADDITIVE `RuleAggregate`
 * knobs whose defaults reproduce the path above byte-for-byte:
 *   - `edgeSource: 'root-children-outgoing'` counts edges hanging off the root
 *     OBJECT's OWN fields (FROM node a `CustomField` with `parentId === rootId`)
 *     rather than edges incident to the object node — because a master-detail
 *     `lookupTo` edge lives on the child's FIELD, so an object's junction node
 *     has ZERO incident master-detail edges;
 *   - `countedEdgeWhereProperty` filters the counted edge by its OWN property
 *     (`relationshipType === 'MasterDetail'`, so a plain lookup never counts);
 *   - `countDistinctEndpoint: 'to'` dedups the TARGET (distinct PARENT object),
 *     so two master-detail fields at the same parent count as ONE;
 *   - `op: 'eq'` tests EXACT cardinality (exactly two masters — three is not a
 *     junction); and no `groupByEdgeProperty` forms ONE undifferentiated group.
 * The ungrouped path cites [root, …sorted parents] (`{0}` the junction, `{1}`/
 * `{2}` the masters); the grouped path is unchanged (firers first, root last).
 */
const interpretAggregate = (
  rule: ConceptRule,
  slice: GroundedSlice,
  coverage: Coverage,
  rootId: ComponentId | undefined,
): Interpretation[] => {
  const agg = rule.bind.aggregate;
  if (agg === undefined || rootId === undefined) return [];
  if (agg.firstMatchOrdinal !== undefined) {
    return interpretFirstMatchOrdinal(rule, slice, coverage, rootId, agg);
  }

  const nodesById = new Map<ComponentId, Node>();
  for (const node of slice.nodes) nodesById.set(node.id, node);
  if (!nodesById.has(rootId)) return []; // the root must resolve in the slice
  const rootNode = nodesById.get(rootId)!;
  if (!matchesWhere(rootNode.properties, rule.bind.whereProperty)) return [];

  const componentTypes = rule.bind.componentTypes;
  // Defaults preserve the shipped stacked-flows path exactly: incident edges,
  // firer (`from`) endpoint deduped. `root-children-outgoing` + `to` is the
  // junction generalization (edges off the root object's OWN fields, distinct
  // parent endpoint).
  const edgeSource = agg.edgeSource ?? 'root-incident';
  const countDistinctEndpoint = agg.countDistinctEndpoint ?? 'from';

  interface Group {
    readonly ids: ComponentId[];
    readonly seen: Set<ComponentId>;
    readonly edgeConfidences: ConfidenceLevel[];
  }
  // Keyed by TriggerContext for the grouped (stacked-flows) path, or by the
  // {@link SINGLE_GROUP} sentinel for the ungrouped (junction) path.
  const groups = new Map<string, Group>();

  for (const edge of slice.edges) {
    if (edge.edgeType !== rule.bind.edgeType) continue; // the counted via-edge
    // Counted-edge OWN-property filter (junction: relationshipType===MasterDetail).
    // Undefined ⇒ unconstrained, so the shipped path is byte-identical.
    if (!matchesWhere(edge.properties, agg.countedEdgeWhereProperty)) continue;

    // Anchor selection. `root-incident` (default): the counted edge is INCOMING
    // to the root (`edge.toId === rootId`) — the shipped stacked-flows shape.
    // `root-outgoing`: the counted edge leaves the root (`edge.fromId ===
    // rootId`) — parentOf SharingRule children, subflow references, etc.
    // `root-children-outgoing`: the counted edge hangs off one of the root
    // OBJECT's own fields — its FROM node is a CustomField whose `parentId` is
    // the root (the junction 2-hop: object → its fields → their parents).
    if (edgeSource === 'root-incident') {
      if (edge.toId !== rootId) continue;
    } else if (edgeSource === 'root-outgoing') {
      if (edge.fromId !== rootId) continue;
    } else {
      const fromNode = nodesById.get(edge.fromId);
      if (fromNode === undefined) continue; // the child field must resolve
      if (fromNode.parentId !== rootId) continue; // a field of THIS object only
    }

    // The COUNTED endpoint — deduped, active-filtered, cited. `from` (default)
    // is the firer; `to` is the target (junction: the distinct PARENT object).
    const countedId = countDistinctEndpoint === 'to' ? edge.toId : edge.fromId;
    const countedNode = nodesById.get(countedId);
    if (countedNode === undefined) continue; // never count an unresolved endpoint
    if (componentTypes !== undefined && !componentTypes.includes(countedNode.type)) continue;
    // Active filter (LOAD-BEARING for stacked-flows) — matched against the
    // ENDPOINT NODE's own property. Undefined ⇒ no filter (junction needs none).
    if (!matchesWhere(countedNode.properties, agg.endpointWhereProperty)) continue;

    // Grouping. No `groupByEdgeProperty` ⇒ ONE undifferentiated group (junction:
    // count distinct parents, no bucketing). Otherwise bucket by the edge's
    // trigger context; an absent/unknown trigger type places in NO context —
    // never folded into a save bucket, so it can never inflate a collision.
    // With `eventSplitByProperty` set (REASONING-STACKED-FLOWS-IGNORES-RECORD-
    // TRIGGER-TYPE), each timing context is further split by the concrete DML
    // event(s) the flow fires on (from `recordTriggerType`): a CreateAndUpdate
    // flow lands in BOTH the insert and update buckets, a Create-only flow ONLY
    // in insert, an Update-only flow ONLY in update — so an edge can contribute to
    // MULTIPLE keys, and two mutually-exclusive flows never share one.
    let groupKeys: readonly string[];
    if (agg.groupByEdgeProperty === undefined) {
      groupKeys = [SINGLE_GROUP];
    } else {
      const context = triggerContextOf(edge.properties[agg.groupByEdgeProperty]);
      if (context === null) continue;
      if (agg.eventSplitByProperty === undefined) {
        groupKeys = [context];
      } else {
        const events = dmlEventsOf(edge.properties[agg.eventSplitByProperty], context);
        if (events.length === 0) continue; // unplaceable — never fabricated into a bucket
        groupKeys = events.map((ev) => `${context}${EVENT_KEY_SEP}${ev}`);
      }
    }

    for (const groupKey of groupKeys) {
      let group = groups.get(groupKey);
      if (group === undefined) {
        group = { ids: [], seen: new Set(), edgeConfidences: [] };
        groups.set(groupKey, group);
      }
      // Distinct-endpoint dedup: an endpoint reachable by multiple counted edges
      // is counted ONCE (the count is over DISTINCT endpoints, not edges) — so a
      // duplicate edge (or two master-detail fields to the SAME parent) can never
      // inflate the count.
      if (!group.seen.has(countedId)) {
        group.seen.add(countedId);
        group.ids.push(countedId);
      }
      group.edgeConfidences.push(edge.confidence);
    }
  }

  // FIX 4 — a truncated slice under-counts; surface the caller's caveat so the
  // count reads as a floor. `null` under complete coverage (the common case).
  const coverageCaveat = coverage.status === 'complete' ? null : coverage.caveat;

  // The ungrouped (junction) path cites the ROOT first (`{0}` = the junction
  // object), then the sorted counted endpoints (`{1}`/`{2}` = the two masters).
  // The grouped (stacked-flows) path cites the FIRERS first, the root trailing
  // as context — never as the culprit. Emit order: the single group, else the
  // three trigger contexts (before-save → after-save → before-delete).
  const rootFirst = edgeSource === 'root-children-outgoing';
  const out: Interpretation[] = [];

  // Emit one interpretation for a (possibly merged) group. Threshold is checked
  // by the caller. Citation order + named-token fill are shared by every path, so
  // the junction and non-event-split stacked-flows emits stay byte-identical.
  const pushGroup = (group: Group, named: Record<string, string>): void => {
    const countedIds = [...group.ids].sort();
    const groundedIn = rootFirst ? [rootId, ...countedIds] : [...countedIds, rootId];
    // Positional fill array: the citation order, so `{0}`/`{1}`/`{2}` resolve to
    // [root, …parents] for junction; the grouped path fills by NAMED tokens
    // ({object}/{count}/{timing}/{event}) and ignores positionals.
    const fillIds = rootFirst ? groundedIn : countedIds;
    out.push({
      ruleId: rule.id,
      concept: rule.concept,
      claim: fill(rule.interpretation, fillIds, { ...named, count: String(group.ids.length) }),
      groundedIn,
      confidence: weakest(rule.maxConfidence, ...group.edgeConfidences),
      coverageCaveat,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    });
  };

  if (agg.groupByEdgeProperty !== undefined && agg.eventSplitByProperty !== undefined) {
    // EVENT-SPLIT path (REASONING-STACKED-FLOWS-IGNORES-RECORD-TRIGGER-TYPE). For
    // each timing context, take its qualifying per-DML-event buckets, then MERGE
    // buckets with IDENTICAL membership into one — an all-CreateAndUpdate stack
    // collides on BOTH insert and update with the SAME flow set, so it is reported
    // ONCE as "insert or update", never doubled; a mixed stack (e.g. insert 3 /
    // update 2) stays two separate honest claims. A Create-only + Update-only pair
    // never shares a bucket, so it no longer fabricates a same-save collision.
    for (const context of TRIGGER_CONTEXTS) {
      const bySignature = new Map<string, { readonly events: DmlEvent[]; readonly group: Group }>();
      const signatureOrder: string[] = [];
      for (const event of DML_EVENTS) {
        const group = groups.get(`${context}${EVENT_KEY_SEP}${event}`);
        if (group === undefined) continue;
        if (!aggregateOpHolds(agg.op, group.ids.length, agg.threshold)) continue;
        const signature = [...group.ids].sort().join(', ');
        const existing = bySignature.get(signature);
        if (existing === undefined) {
          bySignature.set(signature, {
            events: [event],
            group: { ids: [...group.ids], seen: new Set(), edgeConfidences: [...group.edgeConfidences] },
          });
          signatureOrder.push(signature);
        } else {
          // Identical membership → same flow set colliding on another event.
          existing.events.push(event);
          existing.group.edgeConfidences.push(...group.edgeConfidences);
        }
      }
      for (const signature of signatureOrder) {
        const { events, group } = bySignature.get(signature)!;
        pushGroup(group, { object: rootId, timing: context, event: events.join(' or ') });
      }
    }
    return out;
  }

  // SINGLE_GROUP (junction) or per-context (non-event-split stacked-flows) —
  // byte-identical to the pre-generalization emit.
  const emitOrder: readonly string[] =
    agg.groupByEdgeProperty === undefined ? [SINGLE_GROUP] : TRIGGER_CONTEXTS;
  for (const groupKey of emitOrder) {
    const group = groups.get(groupKey);
    if (group === undefined) continue;
    if (!aggregateOpHolds(agg.op, group.ids.length, agg.threshold)) continue;
    const named: Record<string, string> = { object: rootId };
    if (groupKey !== SINGLE_GROUP) named['timing'] = groupKey;
    pushGroup(group, named);
  }
  return out;
};

/**
 * Does a `root-children-outgoing` AGGREGATE rule DROP a counted edge because its
 * counted endpoint is a PHANTOM (a node absent from the slice)? Mirrors the exact
 * drop inside {@link interpretAggregate} (the `countedNode === undefined` guard):
 * for the junction rule the counted endpoint is a master-detail PARENT object, so
 * a parent NOT retrieved into the vault silently lowers the distinct-parent count
 * below the `eq 2` threshold and the rule fails to fire — with NO citation and NO
 * interpretation to hang a caveat on. The caller ({@link interpretHandler})
 * surfaces this as a coverage/limitations note so a "complete coverage" signal can
 * never co-occur with a SILENT junction non-detection. Junctions to standard or
 * managed objects (common) are exactly the un-pulled-parent case, so this is live
 * on any vault with an un-retrieved master.
 *
 * Deterministic and pure over the slice. Returns `false` for a non-aggregate rule,
 * a `root-incident` aggregate (its counted endpoint is the always-present firer,
 * a different concern), or when every counted endpoint resolves. Only the counted
 * endpoint's absence is the miss: the child FIELD must resolve (its own drop is a
 * different, non-junction gap) and belong to the root, matching the engine's path.
 */
export const aggregateHasUnresolvedCountedEndpoint = (
  rule: ConceptRule,
  slice: GroundedSlice,
  rootId: ComponentId | undefined,
): boolean => {
  const agg = rule.bind.aggregate;
  if (agg === undefined || rootId === undefined) return false;
  if ((agg.edgeSource ?? 'root-incident') !== 'root-children-outgoing') return false;

  const nodesById = new Map<ComponentId, Node>();
  for (const node of slice.nodes) nodesById.set(node.id, node);
  if (!nodesById.has(rootId)) return false;

  const countDistinctEndpoint = agg.countDistinctEndpoint ?? 'from';
  for (const edge of slice.edges) {
    if (edge.edgeType !== rule.bind.edgeType) continue;
    if (!matchesWhere(edge.properties, agg.countedEdgeWhereProperty)) continue;
    const fromNode = nodesById.get(edge.fromId);
    if (fromNode === undefined) continue; // the child field must resolve (engine drops it too)
    if (fromNode.parentId !== rootId) continue; // a field of THIS object only
    const countedId = countDistinctEndpoint === 'to' ? edge.toId : edge.fromId;
    if (!nodesById.has(countedId)) return true; // the counted endpoint is a phantom → silent miss
  }
  return false;
};

/**
 * Interpret a witness-partitioned EDGE rule. Pure and deterministic over the
 * already-matched edges. Serves two guards through one mechanism (see
 * {@link RuleWitnessPartition.witnessKind}):
 *   - `property` (REASONING-ASYNC-TEST-CALLER-BLEED) — classify each matched edge
 *     by a BOOLEAN property (`witnessProperty`, e.g. `isTest`) on its ROLE
 *     endpoint (the `from`/dispatcher of a `dispatchesAsync` edge).
 *   - `inactive-firer` (REASONING-STATUS-CODE-CITES-INACTIVE-AUTOMATION) —
 *     classify by the shared SOE `isActiveSoeFirer` liveness predicate on the
 *     role endpoint (the `from`/firer of a `triggersOn` edge): a Draft/Obsolete
 *     Flow or Inactive trigger is a witness, a status-less/active firer is not.
 *
 * A WITNESS edge is one the mode marks as such; a non-matching / false / absent /
 * dangling role endpoint is a PRIMARY edge (the classification only ever fires on
 * a node KNOWN to be a witness, so it can never DOWN-grade a real relationship on
 * missing evidence). Then:
 *   - PRODUCTION-ONLY (no witness edges) — the base {@link ConceptRule.interpretation}
 *     over ALL matched endpoints. Byte-identical to the scalar edge path: the
 *     endpoints, dedup order, and `weakest(...)` confidence all coincide.
 *   - MIXED (some production + some witness) — the base interpretation over the
 *     PRODUCTION endpoints ONLY (the test dispatchers never enter the production
 *     reachability citation), plus `interpretationMixedWitnessSuffix` disclosing
 *     the excluded witness role-endpoints (`{witnessIds}`). Confidence is the
 *     weakest of the PRODUCTION edges (the disclosed witnesses do not drag it).
 *   - WITNESS-ONLY (no production edges) — `interpretationWitnessOnly` over the
 *     witness endpoints (`{ids}`): asserts test-only reachability, NEVER a
 *     production dispatch path, and still cites the witnesses (nothing hidden).
 *
 * Presence-shaped by construction: zero matched edges ⇒ `[]` (no citation, no
 * claim), mirroring the scalar path.
 */
const interpretWitnessPartition = (
  rule: ConceptRule,
  bindResult: BindResult,
  slice: GroundedSlice,
): Interpretation[] => {
  const wp = rule.witnessPartition!;
  const nodesById = new Map<ComponentId, Node>();
  for (const n of slice.nodes) nodesById.set(n.id, n);

  const roleIdOf = (m: MatchedEdge): ComponentId =>
    wp.roleEndpoint === 'from' ? m.edge.fromId : m.edge.toId;
  // Classify a matched edge as a WITNESS (excluded from the primary claim) by the
  // configured mode. `property` (default) — the async test-caller guard: the role
  // node carries `witnessProperty === true`. `inactive-firer` — the P1-B liveness
  // guard: the role node is PROVABLY INACTIVE under the shared SOE predicate.
  // `system-perm-holder` (REASONING-VIEW-MODIFY-ALL-MIXES-SYSTEM-PERMS) — the role
  // node's `witnessArrayProperty` array CONTAINS `witnessArrayMember` (e.g. the
  // grantor's `userPermissions` includes `ViewAllData`), so its object-level grant
  // is indistinguishable from the broader system permission. In EVERY mode a role
  // node ABSENT from the slice (dangling), or lacking the marker, is NOT a witness
  // — the classification only ever fires on a node KNOWN to be a witness, so the
  // primary plane is never DOWN-graded on missing evidence.
  const witnessKind = wp.witnessKind ?? 'property';
  const isWitnessEdge = (m: MatchedEdge): boolean => {
    const roleNode = nodesById.get(roleIdOf(m));
    if (roleNode === undefined) return false;
    if (witnessKind === 'inactive-firer') return !isActiveSoeFirer(roleNode);
    if (witnessKind === 'system-perm-holder') {
      const arr = roleNode.properties[wp.witnessArrayProperty!];
      if (!Array.isArray(arr)) return false;
      // ANY configured member present ⇒ witness (an OR): the view-all rule counts
      // both ViewAllData and ModifyAllData holders (both confer read-all-data).
      return wp.witnessArrayMember!.some((member) => arr.includes(member));
    }
    return roleNode.properties[wp.witnessProperty!] === true;
  };

  const productionEdges = bindResult.matchedEdges.filter((m) => !isWitnessEdge(m));
  const witnessEdges = bindResult.matchedEdges.filter((m) => isWitnessEdge(m));

  // Dedup a record list's cited endpoints in match / from-then-to order (mirrors
  // runBind's flat `ids`, so the production-only partition equals the scalar path).
  const dedupEndpoints = (records: readonly MatchedEdge[]): ComponentId[] => {
    const seen = new Set<ComponentId>();
    const out: ComponentId[] = [];
    for (const r of records) {
      for (const endpoint of r.endpoints) {
        if (!seen.has(endpoint)) {
          seen.add(endpoint);
          out.push(endpoint);
        }
      }
    }
    return out;
  };
  // Dedup the ROLE endpoints (the test dispatchers) for the mixed disclosure.
  const dedupRoleIds = (records: readonly MatchedEdge[]): ComponentId[] => {
    const seen = new Set<ComponentId>();
    const out: ComponentId[] = [];
    for (const r of records) {
      const roleId = roleIdOf(r);
      if (!seen.has(roleId)) {
        seen.add(roleId);
        out.push(roleId);
      }
    }
    return out;
  };

  const emit = (
    claim: string,
    groundedIn: readonly ComponentId[],
    edgeConfidences: readonly ConfidenceLevel[],
  ): Interpretation[] => [
    {
      ruleId: rule.id,
      concept: rule.concept,
      claim,
      groundedIn,
      confidence: weakest(rule.maxConfidence, ...edgeConfidences),
      coverageCaveat: null,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    },
  ];

  // ≥1 production dispatch → a production claim grounded in the PRODUCTION
  // endpoints ONLY. Test dispatchers, if any, are disclosed but never conflated
  // into the production reachability set.
  if (productionEdges.length > 0) {
    const prodIds = dedupEndpoints(productionEdges);
    const prodConfidences = productionEdges.map((m) => m.edge.confidence);
    let claim = fill(rule.interpretation, prodIds);
    if (witnessEdges.length > 0) {
      const witnessIds = dedupRoleIds(witnessEdges);
      claim += ` ${fill(wp.interpretationMixedWitnessSuffix, [], { witnessIds: witnessIds.join(', ') })}`;
    }
    return emit(claim, prodIds, prodConfidences);
  }

  // TEST-ONLY (witness edges, no production) → refuse a production dispatch path;
  // disclose the test-only reachability, still citing the witnesses + target.
  if (witnessEdges.length > 0) {
    const witnessCitedIds = dedupEndpoints(witnessEdges);
    const witnessConfidences = witnessEdges.map((m) => m.edge.confidence);
    return emit(fill(wp.interpretationWitnessOnly, witnessCitedIds), witnessCitedIds, witnessConfidences);
  }

  // No matched edges → no citation, no claim.
  return [];
};

/**
 * Interpret one {@link ConceptRule} against a grounded slice under a
 * caller-computed {@link Coverage}. Returns exactly one {@link Interpretation}
 * when the rule fires, or `[]` when a non-absence rule matched no ids OR when an
 * `absenceShaped` rule's bind matched (its "none/safe" conclusion is void). A
 * rule whose `bind` carries a `join` is dispatched to the pure multi-edge join
 * path ({@link interpretJoin}) — which can emit MANY interpretations (one per
 * grounded coupling); a rule whose `bind` carries an `aggregate` is dispatched
 * to the pure group-count path ({@link interpretAggregate}) — which can emit one
 * interpretation per qualifying group; a rule whose `bind` carries an `antiJoin`
 * is dispatched to {@link interpretAntiJoin} (present-A / absent-B, EC-8) with
 * absence-shaped coverage honesty; a rule whose `bind` carries a `setDifference`
 * is dispatched to {@link interpretSetDifference} (INCLUDE − SUBTRACT, EC-9); a
 * rule whose `bind` carries a `propertyCompare` is dispatched to
 * {@link interpretPropertyCompare} (property-vs-property, EC-12); a rule whose
 * `bind` carries a `fieldJoin` is dispatched to {@link interpretFieldJoin}
 * (intra-object name-based field join, EC-10); a rule whose `bind` carries a
 * `propertyEqualsEndpoint` is dispatched to
 * {@link interpretPropertyEqualsEndpoint} (node-property vs outgoing-endpoint
 * object scope, D9 flow-self-dml-reentry). A
 * rule carrying a `witnessPartition` is dispatched to
 * {@link interpretWitnessPartition} (production vs test-witness edges), which
 * reads the same `runBind` matched edges. None of these touch the scalar
 * bind/absence logic below, and a rule with none of them is unchanged.
 *
 * @param rule     the curated, org-agnostic rule.
 * @param slice    the caller-assembled grounded nodes + edges.
 * @param coverage coverage of the families the rule depends on (caller-computed).
 * @param rootId   the QUERIED component id (FIX 1). Node-shaped rules match this
 *                 node ONLY; the EDGE branch considers only edges INCIDENT to the
 *                 root; and the JOIN branch counts only firesWhen via-edges whose
 *                 firer IS the root — so a neighbor (or a neighbor's edge) dragged
 *                 into the slice by a 2-hop expansion is never (mis)claimed. An
 *                 AGGREGATE rule REQUIRES it: it counts the edges INCOMING to
 *                 this root, so a raw-predicate call without a root yields `[]`.
 *                 Omitting it (raw-predicate unit tests) restores the prior
 *                 scan-everything matching; the `sfi.interpret` tool always
 *                 passes it.
 */
const interpretRaw = (
  rule: ConceptRule,
  slice: GroundedSlice,
  coverage: Coverage,
  rootId?: ComponentId,
): Interpretation[] => {
  if (rule.bind.join !== undefined) return interpretJoin(rule, slice, rootId);
  if (rule.bind.aggregate !== undefined) return interpretAggregate(rule, slice, coverage, rootId);
  if (rule.bind.dualEdge !== undefined) return interpretDualEdge(rule, slice, rootId);
  if (rule.bind.antiJoin !== undefined) return interpretAntiJoin(rule, slice, coverage, rootId);
  if (rule.bind.setDifference !== undefined) return interpretSetDifference(rule, slice, rootId);
  if (rule.bind.propertyCompare !== undefined) return interpretPropertyCompare(rule, slice, rootId);
  if (rule.bind.fieldJoin !== undefined) return interpretFieldJoin(rule, slice, rootId);
  if (rule.bind.propertyEqualsEndpoint !== undefined) {
    return interpretPropertyEqualsEndpoint(rule, slice, rootId);
  }
  if (rule.bind.crossObjectCascade !== undefined) {
    return interpretCrossObjectCascade(rule, slice, rootId);
  }

  const bindResult = runBind(rule.bind, slice, rootId);

  // A witness-partitioned EDGE rule (REASONING-ASYNC-TEST-CALLER-BLEED) routes to
  // the dedicated production-vs-test-witness path. Every other rule has no
  // `witnessPartition`, so it skips this and the scalar logic below is unchanged.
  if (rule.witnessPartition !== undefined) return interpretWitnessPartition(rule, bindResult, slice);

  const { ids, edgeConfidences } = bindResult;

  // No citation ⇒ no claim (unless the rule reasons about ABSENCE).
  if (ids.length === 0 && !rule.absenceShaped) return [];

  // An absence-shaped rule concludes "none/safe". If its bind MATCHED, the
  // absence is FALSE — a dependency exists — so the absence conclusion is VOID.
  // We must never emit a "safe/none" claim while citing the very dependency
  // that contradicts it; surfacing that "found" dependency is a different
  // (non-absence) rule's job.
  if (rule.absenceShaped && ids.length > 0) return [];

  let confidence: ConfidenceLevel | 'unknown' = weakest(rule.maxConfidence, ...edgeConfidences);
  let coverageCaveat: string | null = null;
  let claim: string;

  if (rule.absenceShaped && coverage.status !== 'complete') {
    // Absence under partial / unknown coverage MUST NOT assert "none/safe".
    confidence = 'unknown';
    coverageCaveat = coverage.caveat;
    claim =
      `not checked — coverage is ${coverage.status}; the absence-based conclusion ` +
      `for ${rule.concept} was not verified.`;
  } else {
    const rootNode =
      rootId !== undefined ? slice.nodes.find((n) => n.id === rootId) : undefined;
    claim = fill(rule.interpretation, ids, propNamedFromNode(rootNode));
  }

  return [
    {
      ruleId: rule.id,
      concept: rule.concept,
      claim,
      groundedIn: ids,
      confidence,
      coverageCaveat,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    },
  ];
};

/**
 * CITED-REMEDIATION — build the grounded {@link Remediation} for a fired claim
 * from the rule's AUTHORED {@link ConceptRule.remediation}. Each ordered step
 * template is FILLED from the claim's own `groundedIn` (the same `{ids}` /
 * positional `{0}` fill the claim uses), and the fix carries the claim's
 * `groundedIn` + `confidence` VERBATIM — so a remediation is cited by exactly the
 * same components and can never read stronger than the finding.
 *
 * Honesty by construction:
 *   - Returns `undefined` when the rule authored no remediation — the engine
 *     NEVER fabricates a generic fix.
 *   - Returns `undefined` for a claim whose `confidence` is `'unknown'` (a
 *     coverage-gated "not checked" absence claim): an unverified finding gets no
 *     fix steps. (None of the shipped remediation rules are absence-shaped, so
 *     this is a defensive guard, not a live path.)
 *   - The `steps` are fix STEPS ONLY — nothing here asserts the finding is
 *     closed; `whatIfTool` (when authored) merely points at a tool that can MODEL
 *     the counterfactual.
 */
const buildRemediation = (
  rule: ConceptRule,
  groundedIn: readonly ComponentId[],
  confidence: ConfidenceLevel | 'unknown',
): Remediation | undefined => {
  const rem = rule.remediation;
  if (rem === undefined) return undefined;
  if (confidence === 'unknown') return undefined;
  return {
    steps: rem.steps.map((step) => fill(step, groundedIn)),
    confidence,
    groundedIn,
    ...(rem.whatIfTool !== undefined ? { whatIfTool: rem.whatIfTool } : {}),
  };
};

/**
 * CITED-REMEDIATION — attach the rule's authored remediation onto every
 * interpretation it emitted. Pure, and byte-identical to `interpretRaw` for any
 * rule WITHOUT authored remediation (the common case): the array is returned
 * untouched. Applied uniformly across ALL emit paths (scalar / join / aggregate /
 * dualEdge / antiJoin / setDifference / propertyCompare / fieldJoin /
 * propertyEqualsEndpoint / crossObjectCascade / witnessPartition) because it maps
 * over the already-emitted claims — each fix is filled from that claim's own
 * `groundedIn` and stamped with its `confidence`.
 */
const attachRemediation = (
  rule: ConceptRule,
  interps: Interpretation[],
): Interpretation[] => {
  if (rule.remediation === undefined) return interps;
  return interps.map((it) => {
    const remediation = buildRemediation(rule, it.groundedIn, it.confidence);
    return remediation === undefined ? it : { ...it, remediation };
  });
};

/**
 * Interpret one {@link ConceptRule} against a grounded slice — the public entry
 * point. Delegates to the pure per-shape engine ({@link interpretRaw}) and then
 * attaches any AUTHORED {@link RuleRemediation} to the emitted claims
 * ({@link attachRemediation}). A rule with no remediation is byte-identical to
 * the pre-remediation engine; a rule with one emits a cited, confidence-tiered,
 * dependency-ordered fix on each claim it fires. Same signature, same
 * determinism.
 */
export const interpret = (
  rule: ConceptRule,
  slice: GroundedSlice,
  coverage: Coverage,
  rootId?: ComponentId,
): Interpretation[] => attachRemediation(rule, interpretRaw(rule, slice, coverage, rootId));

/**
 * EPIC-1 — second-pass chained interpretation.
 *
 * Binds a {@link ChainedRule} over already-emitted {@link Interpretation}[]
 * (concept-output → concept-input). Fires when every `requiredConcepts` id is
 * present ≥1 times among `priors`, then emits ONE additional Interpretation
 * citing the UNION of matched priors' `groundedIn` at
 * `weakest(rule.maxConfidence, …priorConfidences)` — or `'unknown'` if any
 * matched prior is unknown. Coverage caveats from matched priors are joined.
 *
 * Honesty invariants:
 *   - no matched prior / empty requiredConcepts ⇒ no claim;
 *   - never invents citations — only unions priors' groundedIn;
 *   - confidence never exceeds the weakest matched prior (or the rule ceiling);
 *   - one pass only: outputs are NOT fed back into chaining (EPIC-2+).
 *
 * Pure and deterministic. Does not touch the grounded slice.
 */
export const chainInterpret = (
  priors: readonly Interpretation[],
  rules: readonly ChainedRule[],
): Interpretation[] => {
  if (priors.length === 0 || rules.length === 0) return [];

  const byConcept = new Map<string, Interpretation[]>();
  for (const prior of priors) {
    const bucket = byConcept.get(prior.concept);
    if (bucket === undefined) byConcept.set(prior.concept, [prior]);
    else bucket.push(prior);
  }

  const out: Interpretation[] = [];
  for (const rule of rules) {
    if (rule.requiredConcepts.length === 0) continue;
    // Fail closed if the chain concept already fired in the first pass.
    if (byConcept.has(rule.concept)) continue;

    const matched: Interpretation[] = [];
    let allPresent = true;
    for (const conceptId of rule.requiredConcepts) {
      const hits = byConcept.get(conceptId);
      if (hits === undefined || hits.length === 0) {
        allPresent = false;
        break;
      }
      matched.push(...hits);
    }
    if (!allPresent || matched.length === 0) continue;

    const groundedSeen = new Set<ComponentId>();
    const groundedIn: ComponentId[] = [];
    for (const m of matched) {
      for (const id of m.groundedIn) {
        if (!groundedSeen.has(id)) {
          groundedSeen.add(id);
          groundedIn.push(id);
        }
      }
    }
    // Presence-shaped: no citation ⇒ no claim (even if concepts matched with empty groundedIn).
    if (groundedIn.length === 0 && !rule.absenceShaped) continue;

    const priorConfs = matched.map((m) => m.confidence);
    let confidence: ConfidenceLevel | 'unknown';
    if (priorConfs.some((c) => c === 'unknown')) {
      confidence = 'unknown';
    } else {
      confidence = weakest(
        rule.maxConfidence,
        ...(priorConfs as ConfidenceLevel[]),
      );
    }

    const caveats = matched
      .map((m) => m.coverageCaveat)
      .filter((c): c is string => c !== null && c.length > 0);
    const coverageCaveat = caveats.length > 0 ? caveats.join(' ') : null;

    const claim = fill(rule.interpretation, groundedIn);
    out.push({
      ruleId: rule.id,
      concept: rule.concept,
      claim,
      groundedIn,
      confidence,
      coverageCaveat,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    });
  }
  return out;
};

/**
 * EPIC-2 — cross-concept, same-anchor composition.
 *
 * Binds a {@link CompoundRule} over already-emitted {@link Interpretation}[]
 * (first-pass + EPIC-1 chained). Unlike {@link chainInterpret} — which fires on
 * the GLOBAL presence of its required concepts — a compound rule fires only when
 * ≥2 required concepts CO-FIRE ON ONE ANCHOR: a component id present in the
 * `groundedIn` of at least one prior of EVERY required concept. It then emits ONE
 * reconciled Interpretation PER shared anchor, citing the UNION of the priors
 * that actually cite that anchor, at
 * `weakest(rule.maxConfidence, …participatingPriorConfidences)` (or `'unknown'`
 * if any participating prior is unknown). Coverage caveats of the participating
 * priors are joined.
 *
 * This generalizes the hand-coded same-anchor AND-binds (e.g.
 * `system-context-external-surface`) and delivers the NET-ACCESS-INTERSECTION
 * headline: a widen signal ∩ a narrow OWD baseline reconciled to ONE per-object
 * posture.
 *
 * Honesty invariants (mirroring {@link chainInterpret}):
 *   - empty `requiredConcepts` ⇒ no claim (fail closed);
 *   - the compound concept already firing in the priors ⇒ skip (no re-derivation);
 *   - a required concept with no prior, OR no id shared across every required
 *     concept's priors (in `sameAnchor` mode) ⇒ no claim;
 *   - never invents citations — the compound `groundedIn` is exactly the union of
 *     the participating priors' `groundedIn`;
 *   - confidence never exceeds the weakest participating prior (or the ceiling);
 *   - one pass only: compound outputs are NOT re-fed into composition.
 *
 * Pure and deterministic. Does not touch the grounded slice. With
 * `sameAnchor: false` it degrades to a chain-style single global-union claim.
 */
export const compoundInterpret = (
  priors: readonly Interpretation[],
  rules: readonly CompoundRule[],
): Interpretation[] => {
  if (priors.length === 0 || rules.length === 0) return [];

  const byConcept = new Map<string, Interpretation[]>();
  for (const prior of priors) {
    const bucket = byConcept.get(prior.concept);
    if (bucket === undefined) byConcept.set(prior.concept, [prior]);
    else bucket.push(prior);
  }

  // Build ONE compound Interpretation from a set of participating priors and an
  // (optional) shared anchor id — the union of their citations at the weakest of
  // the rule ceiling and every participant, joined coverage caveats.
  const composeClaim = (
    rule: CompoundRule,
    participating: readonly Interpretation[],
    anchor: ComponentId | '',
  ): Interpretation | null => {
    const groundedSeen = new Set<ComponentId>();
    const groundedIn: ComponentId[] = [];
    for (const p of participating) {
      for (const id of p.groundedIn) {
        if (!groundedSeen.has(id)) {
          groundedSeen.add(id);
          groundedIn.push(id);
        }
      }
    }
    // Presence-shaped: no citation ⇒ no claim.
    if (groundedIn.length === 0 && !rule.absenceShaped) return null;

    const confs = participating.map((p) => p.confidence);
    const confidence: ConfidenceLevel | 'unknown' = confs.some((c) => c === 'unknown')
      ? 'unknown'
      : weakest(rule.maxConfidence, ...(confs as ConfidenceLevel[]));

    const caveats = participating
      .map((p) => p.coverageCaveat)
      .filter((c): c is string => c !== null && c.length > 0);
    const coverageCaveat = caveats.length > 0 ? caveats.join(' ') : null;

    return {
      ruleId: rule.id,
      concept: rule.concept,
      claim: fill(rule.interpretation, groundedIn, { anchor }),
      groundedIn,
      confidence,
      coverageCaveat,
      modelVersion: MODEL_VERSION,
      provenance: 'offline_snapshot',
    };
  };

  const out: Interpretation[] = [];
  for (const rule of rules) {
    if (rule.requiredConcepts.length === 0) continue; // fail closed
    // Fail closed if the compound concept already fired earlier.
    if (byConcept.has(rule.concept)) continue;

    // Every required concept must contribute ≥1 prior.
    const perConcept: Interpretation[][] = [];
    let allPresent = true;
    for (const conceptId of rule.requiredConcepts) {
      const hits = byConcept.get(conceptId);
      if (hits === undefined || hits.length === 0) {
        allPresent = false;
        break;
      }
      perConcept.push(hits);
    }
    if (!allPresent) continue;

    if (!rule.sameAnchor) {
      // Chain-style: one claim over the global union of all matched priors.
      const compound = composeClaim(rule, perConcept.flat(), '');
      if (compound !== null) out.push(compound);
      continue;
    }

    // Same-anchor: an anchor is an id present in ≥1 prior of EVERY required
    // concept. Intersect the per-concept anchor-id sets.
    let anchorSet: Set<ComponentId> | null = null;
    for (const hits of perConcept) {
      const idsForConcept = new Set<ComponentId>();
      for (const h of hits) for (const id of h.groundedIn) idsForConcept.add(id);
      if (anchorSet === null) {
        anchorSet = idsForConcept;
      } else {
        for (const id of [...anchorSet]) {
          if (!idsForConcept.has(id)) anchorSet.delete(id);
        }
      }
    }
    const anchors = anchorSet === null ? [] : [...anchorSet].sort();
    for (const anchor of anchors) {
      // Participate only the priors (of the required concepts) that cite THIS
      // anchor — so the compound cites exactly what it composed, never a prior
      // that happens to share a concept but a different anchor.
      const participating = perConcept
        .flat()
        .filter((p) => p.groundedIn.includes(anchor));
      const compound = composeClaim(rule, participating, anchor);
      if (compound !== null) out.push(compound);
    }
  }
  return out;
};

/** True when two interpretations share ≥1 groundedIn component id. */
const anchorOverlaps = (a: Interpretation, b: Interpretation): boolean => {
  for (const id of a.groundedIn) {
    if (b.groundedIn.includes(id)) return true;
  }
  return false;
};

/** Whether a {@link SupersedesRule}'s overlap requirement holds for this pair. */
const supersedesOverlap = (
  rule: SupersedesRule,
  stronger: Interpretation,
  weaker: Interpretation,
): boolean => {
  const anchor = anchorOverlaps(stronger, weaker);
  const topic = rule.refinesTopic !== undefined && rule.refinesTopic.length > 0;
  switch (rule.overlap) {
    case 'anchor':
      return anchor;
    case 'topic':
      return topic;
    case 'either':
      return anchor || topic;
  }
};

/**
 * EPIC-3 — conflict-resolution (supersedes) pass.
 *
 * Applies curated {@link SupersedesRule} edges AFTER the first pass and after
 * {@link chainInterpret} + {@link compoundInterpret}. When a stronger /
 * more-specific concept co-fires with a broader overlapping one and the rule's
 * overlap requirement holds, the weaker interpretation is DEMOTED (stamped
 * `supersededBy`, claim/citations BYTE-IDENTICAL) or DROPPED (`mode: 'drop'`).
 *
 * Honesty invariants:
 *   - never rewrites `claim`, `groundedIn`, or `confidence` on a demoted prior;
 *   - never invents citations — only marks or removes already-grounded claims;
 *   - no overlap (per rule.overlap) ⇒ no supersession;
 *   - one pass only — superseded outputs are not re-fed.
 *
 * Pure and deterministic. Does not touch the grounded slice.
 */
export const reconcile = (
  interpretations: readonly Interpretation[],
  rules: readonly SupersedesRule[],
): Interpretation[] => {
  if (interpretations.length === 0 || rules.length === 0) return [...interpretations];

  const byConcept = new Map<string, Interpretation[]>();
  for (const i of interpretations) {
    const bucket = byConcept.get(i.concept);
    if (bucket === undefined) byConcept.set(i.concept, [i]);
    else bucket.push(i);
  }

  const toDrop = new Set<Interpretation>();
  const demote = new Map<Interpretation, string>();

  for (const rule of rules) {
    const strongerHits = byConcept.get(rule.strongerConcept);
    const weakerHits = byConcept.get(rule.supersededConcept);
    if (strongerHits === undefined || weakerHits === undefined) continue;

    for (const weak of weakerHits) {
      if (toDrop.has(weak) || demote.has(weak)) continue;
      const matched = strongerHits.some((strong) => supersedesOverlap(rule, strong, weak));
      if (!matched) continue;
      if (rule.mode === 'drop') toDrop.add(weak);
      else demote.set(weak, rule.id);
    }
  }

  const out: Interpretation[] = [];
  for (const i of interpretations) {
    if (toDrop.has(i)) continue;
    const sid = demote.get(i);
    out.push(sid === undefined ? i : { ...i, supersededBy: sid });
  }
  return out;
};
