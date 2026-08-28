/**
 * `reasonAboutComponent` — the ONE code path that runs the deterministic
 * concept-rule engine for a single component.
 *
 * WHY THIS FILE EXISTS. Before it, the whole reasoning plane (142 concepts /
 * 193 rules) was reachable through exactly one leaf tool, `sfi.interpret`:
 * `interpret()` was imported by a single file, no other tool composed it, and
 * 133 of the 193 rules are node-shaped — under `runBind`'s root scoping they can
 * only fire on the component the caller already named. The expertise was built
 * and unplugged. This module lifts the slice assembly + rule evaluation out of
 * the tool handler so ANY component-anchored tool can carry concept claims in
 * its own answer, with `sfi.interpret` refactored onto the same path (its output
 * is byte-unchanged — it is now a thin projection of this helper).
 *
 * WHAT IT DOES. Given one component id it:
 *
 *   1. resolves the root `Node` (or reports `component-not-found`, leaving the
 *      phantom-aware wording to the caller, which owns the vault context);
 *   2. assembles a minimal {@link GroundedSlice} — the root node plus every edge
 *      of the types the selected rules bind on (DERIVED from `CONCEPT_RULES`,
 *      not hardcoded) and every one of those edges' endpoint nodes, plus the
 *      five conditional second hops (JOIN / `root-children-outgoing` AGGREGATE /
 *      EC-8 anti-join / EC-11 crossObjectCascade) that specific rule shapes
 *      need. Every hop is batched — no N+1 — and each runs ONLY when a rule of
 *      that shape is selected;
 *   3. runs each applicable {@link ConceptRule} through the pure engine under a
 *      per-rule coverage adapted from `summarizeCoverage`, then the chained
 *      (EPIC-1), compound (EPIC-2) and reconcile (EPIC-3) passes; and
 *   4. builds an honest {@link ConceptCoverageReport} that separates
 *      "checked and found nothing" from "never checked".
 *
 * THE COVERAGE REPORT IS THE HONESTY CONTRACT. A composed tool that surfaces
 * concept claims must never imply the component was analysed and found clean
 * when in fact no rule even applies to its type. Every selected rule lands in
 * exactly one bucket, in this precedence order:
 *
 *   - `fired`            — the rule emitted ≥1 interpretation.
 *   - `notApplicable`    — the rule PROVABLY cannot match this root. Reachable
 *                          ONLY from the node-scoped bind categories, where
 *                          `componentTypes` genuinely gates the root and the
 *                          answer needs no reference to the assembled slice.
 *                          Never checked, and correctly so.
 *   - `notEvaluable`     — everything we could not PROVE. Two reasons, both
 *                          reported as unknown: `vault-coverage-missing` (the
 *                          vault never retrieved a family the rule reads) and
 *                          `shape-not-provable` (an edge / multi-edge shape
 *                          whose bound types are absent from the slice, or a
 *                          bind shape the classifier does not understand).
 *   - `checkedClean`     — the rule was really evaluated against a slice that
 *                          carried the shape it binds on, and matched nothing.
 *
 * The asymmetry is deliberate. "Not applicable" reads to a user as CORRECTLY
 * SKIPPED; "not evaluable" reads as I DO NOT KNOW. Manufacturing the former out
 * of the latter is the exact defect this contract exists to prevent, so the
 * classifier fails toward unknown and a bind shape it does not understand can
 * never reach the skipped bucket (see `decideApplicability`).
 *
 * `noRuleCoversComponentType` is the blunt case the honesty contract names
 * explicitly: TRUE when not one selected rule was applicable to this component
 * type. A caller MUST surface that rather than rendering an empty claim list as
 * a clean bill of health.
 *
 * Pure-as-possible: the only impurity is the batched graph reads in step 2.
 * Given the same slice the classification and the interpretations are
 * deterministic. Offline and read-only — it never touches the org.
 */

import type {
  ComponentId,
  ComponentType,
  ConceptRule,
  Edge,
  EdgeType,
  Interpretation,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  type GraphStore,
  listEdgesForNodes,
  listNodesByIds,
  type ResolveCandidate,
  resolveComponents,
} from '@sf-intelligence/graph';
import {
  type CoverageSummary,
  type ExtendedVaultManifest,
  summarizeCoverage,
  vaultPaths,
} from '@sf-intelligence/vault';

import { CHAINED_RULES } from './chained-rules.js';
import { COMPOUND_RULES } from './compound-rules.js';
import { CONCEPT_RULES } from './loader.js';
import {
  aggregateHasUnresolvedCountedEndpoint,
  chainInterpret,
  compoundInterpret,
  type Coverage,
  type GroundedSlice,
  interpret,
  reconcile,
} from './reason.js';
import { SUPERSEDES_RULES } from './supersedes-rules.js';

/**
 * The slice of the MCP `Context` this helper needs. Declared structurally so the
 * knowledge plane never imports the server module (and so a unit test can hand
 * it a two-field literal).
 */
export interface ReasonContext {
  readonly graph: GraphStore;
  readonly manifest: ExtendedVaultManifest;
  /**
   * Vault root, used ONLY to hand the shared resolver its on-disk
   * `resolve-index.json` when a natural identifier has to be resolved to a
   * canonical id. Optional: without it resolution still works, just from an
   * in-memory index. Never read for anything else.
   */
  readonly vaultRoot?: string;
}

/**
 * Cap on the number of bound-type edges pulled into a single slice. A hub
 * (a heavily-referenced object) can carry thousands of `triggersOn` /
 * `lookupTo` edges; beyond this we mark the slice truncated and hold coverage
 * to `partial` so an absence-based rule can never claim `complete` over a
 * clipped slice.
 */
export const SLICE_EDGE_CAP = 1_000;

/**
 * Cap on the second-hop expansions (join shared keys, second-ground edges,
 * child-field fan-out, anti-join grants, cascade targets). Exceeding it marks
 * the slice truncated (holding coverage to at most `partial`) and under-reports
 * rather than scanning unboundedly — presence-shaped, so a missed coupling is
 * disclosed, never a false absence.
 */
export const JOIN_FANOUT_CAP = 1_000;

/**
 * Every place the slice assembly can CLIP its own evidence, NAMED.
 *
 * The caps themselves are fine — a hub with 40k incident edges must not be
 * pulled whole. What was NOT fine is that hitting one was invisible past a bare
 * boolean: six copies of `if (sliceEdges.length >= edges.length +
 * JOIN_FANOUT_CAP) { sliceTruncated = true; break; }`, each recording only THAT
 * something was dropped, never WHERE. A caller could not tell a clipped 1-hop
 * (the root's own evidence is short) from a clipped cascade expansion (a
 * second-hop enrichment is short) — two very different answers.
 */
export type SliceExpansion =
  /** The root's own incident bound-type edges, clipped at {@link SLICE_EDGE_CAP}. */
  | 'root-incident-edges'
  /** JOIN — shared keys read off an intermediary's key array. */
  | 'join-shared-keys'
  /** JOIN — second-ground (`writesTo`-shaped) edges into those keys. */
  | 'join-second-ground-edges'
  /** AGGREGATE `root-children-outgoing` — the child fields' counted edges. */
  | 'aggregate-child-field-edges'
  /** EC-8 anti-join, C15 arm2 — grants into the field's parent object. */
  | 'anti-join-root-object-grants'
  /** EC-8 anti-join, C15 arm1 — each present grantor's outgoing object grants. */
  | 'anti-join-present-object-grants'
  /** EC-11 crossObjectCascade — firers incident to the written-to objects. */
  | 'cascade-target-firers';

/**
 * THE ONE PLACE THE FAN-OUT CAP IS APPLIED, and the ledger of where it bit.
 *
 * Every expansion asks this object whether it may admit one more item instead
 * of re-deciding `>= JOIN_FANOUT_CAP` for itself. That matters beyond tidiness:
 * the decision and the DISCLOSURE of the decision are now the same statement,
 * so a new expansion cannot be added that clips silently — there is no way to
 * clip except through a call that records the site.
 */
export interface SliceBudget {
  /**
   * May this expansion push one more EDGE? `sliceEdgeCount` is the CURRENT
   * `sliceEdges.length`; the budget subtracts the 1-hop base itself, so no
   * caller re-derives `edges.length + CAP`.
   */
  admitEdge(expansion: SliceExpansion, sliceEdgeCount: number): boolean;
  /** May this expansion admit one more non-edge item (a shared key)? */
  admitItem(expansion: SliceExpansion, itemCount: number): boolean;
  /** Record a clip decided elsewhere (the 1-hop cap, which is a different constant). */
  clip(expansion: SliceExpansion): void;
  /** TRUE once ANY expansion clipped. The old `sliceTruncated` boolean, derived. */
  readonly truncated: boolean;
  /** WHICH expansions clipped. Sorted, deduped. Empty exactly when not truncated. */
  readonly expansions: readonly SliceExpansion[];
}

/** Build a budget over a slice whose 1-hop base already holds `baseEdgeCount` edges. */
export const createSliceBudget = (baseEdgeCount: number): SliceBudget => {
  const clipped = new Set<SliceExpansion>();
  const admit = (expansion: SliceExpansion, used: number): boolean => {
    if (used < JOIN_FANOUT_CAP) return true;
    clipped.add(expansion);
    return false;
  };
  return {
    admitEdge: (expansion, sliceEdgeCount) => admit(expansion, sliceEdgeCount - baseEdgeCount),
    admitItem: (expansion, itemCount) => admit(expansion, itemCount),
    clip: (expansion) => {
      clipped.add(expansion);
    },
    get truncated(): boolean {
      return clipped.size > 0;
    },
    get expansions(): readonly SliceExpansion[] {
      return [...clipped].sort();
    },
  };
};

/**
 * One candidate a natural identifier resolved to. Mirrors the shared resolver's
 * shape so a caller can render a clarification without re-querying.
 */
export interface AnchorCandidate {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly parentApiName: string | null;
  readonly score: number;
}

/**
 * Failure modes of {@link reasonAboutComponent}. `ambiguous-identifier` is a
 * NAMED failure on purpose: a natural identifier that matches several
 * components must produce a clarification, never a silent pick and never an
 * empty result that reads as "nothing to say about this".
 */
export type ReasonComponentError =
  | { readonly kind: 'component-not-found'; readonly componentId: ComponentId }
  | {
      readonly kind: 'ambiguous-identifier';
      readonly identifier: string;
      readonly candidates: readonly AnchorCandidate[];
    }
  | { readonly kind: 'internal'; readonly message: string };

/** Optional narrowing / tuning for a single {@link reasonAboutComponent} run. */
export interface ReasonAboutComponentOptions {
  /** Additive filter — keep only rules whose `concept` is listed. `[]` matches none. */
  readonly concepts?: readonly string[];
  /** Additive filter — keep only rules whose `id` is listed. `[]` matches none. */
  readonly ruleIds?: readonly string[];
  /**
   * Pre-resolved root node. When a composing tool has ALREADY fetched the node
   * (every one of them has), pass it to skip a redundant `getNodeById`. It must
   * be the node for `componentId`; a mismatched node is a caller bug.
   */
  readonly rootNode?: Node;
  /**
   * QUESTION→ANCHOR BRIDGE. When `true` (the default) an identifier that does
   * not resolve as a canonical id is put through the SHARED resolver
   * (`resolveComponents`, the same one `sfi.resolve` and 80+ other tools use),
   * so `Account.Foo__c`, a bare object name, or a class name all work.
   *
   * Byte-identical for a canonical id that exists: the direct `getNodeById` is
   * tried FIRST and the resolver is never reached. Pass `false` to require an
   * exact canonical id (a composing tool that already resolved its own anchor
   * has no use for a second attempt).
   */
  readonly resolveIdentifier?: boolean;
}

/**
 * Why a rule could not be evaluated. ALL of these are "unknown", never
 * "skipped", and they name DIFFERENT remedies:
 *
 *   - `vault-coverage-missing` — the vault never retrieved a metadata family
 *     this rule reads. Remedy: refresh the vault.
 *   - `shape-not-provable` — the classifier could not PROVE the rule
 *     inapplicable to this root: an edge / multi-edge shape whose bound types
 *     are absent from the assembled slice, or a bind shape the classifier does
 *     not understand at all. Remedy: none — it is a limit of the classifier.
 *   - `slice-truncated` — the rule's shape WAS present and the vault DID carry
 *     its families; the assembled evidence was clipped at a cap before it ran.
 *     Remedy: ask about a narrower anchor. Distinct from both of the above on
 *     purpose: telling a user to refresh a vault that is complete, or that the
 *     model has no rule shape for their component, is the wrong instruction.
 *
 * DERIVED from {@link UNEVALUABLE_REASONS} rather than written twice, so a
 * consumer that must enumerate the reasons cannot drift from this list — see
 * {@link zeroUnevaluableCounts}.
 */
export const UNEVALUABLE_REASONS = [
  'vault-coverage-missing',
  'shape-not-provable',
  'slice-truncated',
] as const;

export type UnevaluableReason = (typeof UNEVALUABLE_REASONS)[number];

/**
 * A zeroed count-by-reason record, covering EVERY reason by construction.
 *
 * Exists so no consumer has to hand-write the key set (the hand-written copy in
 * `concept-reasoning.ts` is exactly the kind of second copy that goes stale the
 * moment a reason is added).
 */
export const zeroUnevaluableCounts = (): Record<UnevaluableReason, number> =>
  Object.fromEntries(UNEVALUABLE_REASONS.map((r) => [r, 0])) as Record<
    UnevaluableReason,
    number
  >;

/** One rule that could NOT be evaluated. Distinct from "evaluated, found nothing". */
export interface UnevaluableRule {
  readonly ruleId: string;
  readonly concept: string;
  /**
   * The metadata families this rule depends on that are absent from the vault.
   * EMPTY for `shape-not-provable` and `slice-truncated` — nothing was missing
   * from the VAULT in either case, and an empty list must never be read as a
   * retrieval gap (whose remedy is the opposite advice).
   */
  readonly missingCoverage: readonly string[];
  readonly reason: UnevaluableReason;
}

/**
 * Which concept layers were checked, which were not applicable, and which could
 * not be evaluated at all. "Not checked" and "checked and found nothing" are
 * deliberately different fields — a composed answer must be able to say which.
 */
export interface ConceptCoverageReport {
  /** Rules selected for this run (after the additive filters). */
  readonly rulesConsidered: number;
  /**
   * SELECTED rules that emitted ≥1 interpretation. Deliberately narrower than
   * {@link ReasonAboutComponentResult.rulesFired}, which also counts the
   * chained / compound second-pass rules — those are not in `selectedRules`, so
   * they cannot participate in this four-way partition.
   */
  readonly rulesFired: number;
  /** Rules really evaluated against a slice carrying their shape, matching nothing. */
  readonly rulesCheckedClean: number;
  /**
   * Rules PROVABLY unable to match this root — a node-scoped bind category whose
   * `componentTypes` excludes the root's type. Nothing inferred ever lands here.
   */
  readonly rulesNotApplicable: number;
  /**
   * Rules that could NOT be evaluated: the vault lacks their metadata, or their
   * bind shape could not be proven inapplicable. Both mean "unknown".
   */
  readonly rulesNotEvaluable: number;
  /** Concept ids that produced a claim. Sorted, deduped. */
  readonly conceptsFired: readonly string[];
  /** Concept ids checked against real data that produced nothing. Sorted, deduped. */
  readonly conceptsCheckedClean: readonly string[];
  /** Concept ids PROVABLY inapplicable to this component type. Sorted, deduped. */
  readonly conceptsNotApplicable: readonly string[];
  /** Rules that could not be evaluated, with the families that were missing. */
  readonly conceptsNotEvaluable: readonly UnevaluableRule[];
  /**
   * TRUE when NOT ONE selected rule could be shown applicable to this component
   * — every rule was either provably inapplicable or undeterminable. The caller
   * MUST say so: an empty claim list here is SILENCE, not a clean bill of
   * health. Deliberately worded as "nothing was checked" rather than "the model
   * has no rule for this type", because the undetermined rules are exactly the
   * ones we cannot make that stronger claim about.
   */
  readonly noRuleCoversComponentType: boolean;
  /** The slice hit a cap, so absence conclusions are held to at most `partial`. */
  readonly sliceTruncated: boolean;
  /** One-sentence, caller-renderable summary of the four buckets. */
  readonly summary: string;
}

/** Everything one reasoning run produced. */
export interface ReasonAboutComponentResult {
  readonly componentId: ComponentId;
  /**
   * Present ONLY when the caller's identifier was NOT a canonical id that
   * resolved directly, and the shared resolver mapped it to `componentId`.
   * Absent on the canonical path, so a canonical call is byte-unchanged. A
   * caller that surfaces claims MUST disclose this — the user named one thing
   * and got an answer about another, even if the mapping was unambiguous.
   */
  readonly resolvedFrom?: {
    readonly identifier: string;
    readonly matchKind: string;
    readonly score: number;
  };
  readonly componentType: ComponentType;
  readonly rootNode: Node;
  /** Post-reconcile interpretations, VERBATIM from the engine. */
  readonly interpretations: readonly Interpretation[];
  /** The rules this run selected (pre-chain/compound/supersedes). */
  readonly selectedRules: readonly ConceptRule[];
  /** Distinct rule ids that fired. */
  readonly rulesFired: number;
  /** TRUE when ANY expansion clipped. Derived from {@link truncatedExpansions}. */
  readonly sliceTruncated: boolean;
  /**
   * WHICH expansions clipped. REQUIRED, never optional, and empty exactly when
   * `sliceTruncated` is false — a consumer that wants to know whether the
   * shortfall is in the root's own evidence or in a second-hop enrichment reads
   * this rather than guessing from a boolean.
   */
  readonly truncatedExpansions: readonly SliceExpansion[];
  readonly slice: GroundedSlice;
  /** Union of the selected rules' `dependsOnCoverage`, deduped. */
  readonly unionCoverageTypes: readonly ComponentType[];
  readonly aggSummary: CoverageSummary;
  readonly aggCoverage: Coverage;
  /** A counted master-detail parent was not retrieved — junction detection may miss. */
  readonly junctionEndpointUnresolved: boolean;
  readonly junctionMissNote: string | null;
  readonly completenessStatus: Coverage['status'];
  readonly topCoverageCaveat: string | null;
  readonly coverageReport: ConceptCoverageReport;
}

/**
 * Map the vault {@link CoverageSummary} onto the engine's {@link Coverage}.
 * `caveat` is null exactly when the (post-truncation) status is `complete`,
 * else a string naming the missing families and any truncation. When the slice
 * was truncated a `complete` status is forced down to `partial` so an
 * absence-shaped rule can never conclude "none/safe" over a clipped slice.
 */
export const adaptCoverage = (summary: CoverageSummary, truncated: boolean): Coverage => {
  const status: Coverage['status'] =
    truncated && summary.status === 'complete' ? 'partial' : summary.status;
  if (status === 'complete') return { status, caveat: null };
  const missing =
    summary.missingCoverage.length > 0
      ? `not fully modeled: ${summary.missingCoverage.join(', ')}`
      : '';
  const clip = truncated ? 'graph slice truncated at the hub cap' : '';
  const detail = [missing, clip].filter((s) => s.length > 0).join('; ');
  return {
    status,
    caveat: `coverage is ${status}${detail.length > 0 ? ` — ${detail}` : ''}.`,
  };
};

/** Distinct edge types the given rules BIND on (derived, not hardcoded). */
const boundEdgeTypes = (rules: readonly ConceptRule[]): EdgeType[] => {
  const set = new Set<EdgeType>();
  for (const rule of rules) {
    if (rule.bind.edgeType !== undefined) set.add(rule.bind.edgeType);
    if (rule.bind.dualEdge !== undefined) {
      set.add(rule.bind.dualEdge.edgeTypeA);
      set.add(rule.bind.dualEdge.edgeTypeB);
    }
    // EC-8 — node-shaped anti-joins (C17) bind no present edgeType; the absent
    // side (e.g. writesTo) must still be fetched into the 1-hop slice.
    if (rule.bind.antiJoin !== undefined) {
      set.add(rule.bind.antiJoin.absentEdgeType);
      if (rule.bind.edgeType !== undefined) set.add(rule.bind.edgeType);
    }
    // EC-9 — set-difference JOIN: both include and subtract edge types.
    if (rule.bind.setDifference !== undefined) {
      set.add(rule.bind.setDifference.includeEdgeType);
      set.add(rule.bind.setDifference.subtractEdgeType);
    }
    if (rule.bind.crossObjectCascade !== undefined) {
      set.add(rule.bind.crossObjectCascade.writerTriggerEdge);
      set.add(rule.bind.crossObjectCascade.writeEdge);
    }
  }
  return [...set];
};

/** Distinct second-ground edge types the given rules' JOIN sub-predicates bind on. */
const joinWriteEdgeTypes = (rules: readonly ConceptRule[]): EdgeType[] => {
  const set = new Set<EdgeType>();
  for (const rule of rules) {
    if (rule.bind.join !== undefined) set.add(rule.bind.join.writeEdgeType);
  }
  return [...set];
};

/** Does this rule use any of the multi-edge sub-predicates the engine routes on? */
const hasSubShape = (rule: ConceptRule): boolean =>
  rule.bind.join !== undefined ||
  rule.bind.aggregate !== undefined ||
  rule.bind.dualEdge !== undefined ||
  rule.bind.antiJoin !== undefined ||
  rule.bind.setDifference !== undefined ||
  rule.bind.propertyCompare !== undefined ||
  rule.bind.fieldJoin !== undefined ||
  rule.bind.propertyEqualsEndpoint !== undefined ||
  rule.bind.crossObjectCascade !== undefined;

/**
 * The bind categories, as the engine actually dispatches them:
 *
 *   - `node`         — plain node predicate. `runBind` scopes it to the root
 *                      node, so `componentTypes` decides it OUTRIGHT.
 *   - `node-present` — a sub-shape whose PRESENT side is the root node (an
 *                      anti-join with no present `edgeType`). `componentTypes`
 *                      gates the root again, so this too is decidable.
 *   - `edge`         — plain edge predicate. `runBind` scopes it to edges
 *                      INCIDENT to the root; `componentTypes` here selects
 *                      which ENDPOINT is cited, NOT the root's own type (the
 *                      status-code rule fires on an OBJECT anchor while citing
 *                      automations), so the root type must NOT gate it. Only
 *                      INFERABLE from the assembled slice.
 *   - `multi-edge`   — every other sub-shape. These reason across the second
 *                      hops the slice assembly added for them. Also only
 *                      INFERABLE.
 *
 * The first two are the PROVABLE set (see {@link PROVABLE_CATEGORIES}); the
 * last two are not. That split is load-bearing — see
 * {@link decideApplicability}.
 */
type BindCategory = 'node' | 'edge' | 'node-present' | 'multi-edge';

/**
 * The ONLY categories whose inapplicability is a PROOF rather than an
 * inference: both scope the match to the root NODE, so `componentTypes` decides
 * the question outright with no reference to the assembled slice.
 *
 * A category NOT in this set can never reach the `not-applicable` bucket. Adding
 * a category here is asserting "a rule of this shape provably cannot match a
 * root of the wrong type" — do not add one without that proof.
 */
const PROVABLE_CATEGORIES: ReadonlySet<BindCategory | 'unknown'> = new Set<
  BindCategory | 'unknown'
>(['node', 'node-present']);

/**
 * The categories whose evaluation READS THE SLICE EDGES, and which a clipped
 * slice can therefore STARVE — they matched nothing because the evidence was
 * cut short, not because there was nothing to match.
 *
 * `node` is deliberately ABSENT, and that omission is the precision half of the
 * fix. `runBind`'s node branch scopes the match to THE ROOT NODE ONLY (see
 * `reason.ts`: with a `rootId` it evaluates `[nodesById.get(rootId)]`), and the
 * root node is in every assembled slice unconditionally. No edge cap can starve
 * it, so demoting it on truncation would manufacture a false "unknown" — the
 * opposite dishonesty, and just as wrong as the one being fixed here.
 *
 * `node-present` IS listed: its PRESENT side is the root node, but the anti-join
 * still reads incident edges of the absent type out of the 1-hop slice, and a
 * clip can remove them.
 */
const EDGE_READING_CATEGORIES: ReadonlySet<BindCategory | 'unknown'> = new Set<
  BindCategory | 'unknown'
>(['edge', 'multi-edge', 'node-present']);

/**
 * Does this bind carry at least one criterion the NODE branch of `runBind`
 * actually reads? Mirrors that function's own `hasNodeCriterion` guard: with
 * none of these present the node branch returns empty and the rule can never
 * fire, so a bind that looks node-shaped only because it has no `edgeType` and
 * no RECOGNIZED sub-shape is not a node predicate at all — it is a shape this
 * classifier does not understand.
 */
const hasNodeCriterion = (rule: ConceptRule): boolean =>
  rule.bind.componentTypes !== undefined ||
  rule.bind.conditionKind !== undefined ||
  rule.bind.whereProperty !== undefined ||
  rule.bind.order !== undefined;

const bindCategory = (rule: ConceptRule): BindCategory | 'unknown' => {
  const sub = hasSubShape(rule);
  if (!sub) {
    if (rule.bind.edgeType !== undefined) return 'edge';
    // A bind with neither an edgeType nor any node criterion is NOT a node
    // predicate — it is an unrecognized shape. Fail it into the inferred branch
    // so it can only ever reach `undetermined`.
    return hasNodeCriterion(rule) ? 'node' : 'unknown';
  }
  if (rule.bind.edgeType === undefined && rule.bind.componentTypes !== undefined) {
    return 'node-present';
  }
  return 'multi-edge';
};

/**
 * How confident are we that this rule cannot match this root?
 *
 *   - `applicable`     — it can (or we cannot rule it out on the cheap path);
 *   - `proven-inapplicable` — a PROOF from the root's component type alone;
 *   - `undetermined`   — we inferred "probably not" from the assembled slice,
 *                        or we do not understand the rule's shape at all.
 */
type ApplicabilityVerdict = 'applicable' | 'proven-inapplicable' | 'undetermined';

/**
 * Decide applicability, FAILING TOWARD `undetermined`.
 *
 * This is deliberately split into a PROVABLE branch and an INFERRED branch, and
 * the two produce DIFFERENT verdicts, because the two failure directions are not
 * equally bad in this product. "Not applicable" reads to a user as *correctly
 * skipped* — a rule that was right to ignore. "Could not determine" reads as *I
 * do not know*. Misclassifying an unknown as "correctly skipped" is the worse
 * error by far: it manufactures false confidence out of ignorance, which is the
 * exact defect the whole concept-model honesty contract exists to prevent.
 *
 * So ONLY the two node-scoped categories — where `componentTypes` genuinely
 * gates the root and the answer needs no reference to the assembled slice — may
 * return `proven-inapplicable`. The edge / multi-edge branches INFER from "the
 * slice carried no edge of a bound type", which is true in practice but is a
 * statement about the SLICE, not about the RULE; they return `undetermined`.
 *
 * The `default` arm is the forward guard: a bind category this function does not
 * understand (a future rule shape that reads something other than nodes and
 * edges) falls through to `undetermined` and can NEVER silently inherit the
 * provable branch.
 */
const decideApplicability = (
  rule: ConceptRule,
  rootType: ComponentType,
  incidentEdgeTypes: ReadonlySet<EdgeType>,
  sliceEdgeTypes: ReadonlySet<EdgeType>,
): ApplicabilityVerdict => {
  const category = bindCategory(rule);

  // ---- PROVABLE branch ------------------------------------------------
  // Guarded by the explicit set, not by the switch arms, so a new category
  // cannot join it by accident.
  if (PROVABLE_CATEGORIES.has(category)) {
    const typeGate =
      rule.bind.componentTypes === undefined ||
      rule.bind.componentTypes.includes(rootType);
    return typeGate ? 'applicable' : 'proven-inapplicable';
  }

  // ---- INFERRED branch ------------------------------------------------
  // Never returns `proven-inapplicable`: the strongest negative available here
  // is `undetermined`.
  switch (category) {
    case 'edge': {
      const bound = rule.bind.edgeType;
      if (bound === undefined) return 'undetermined';
      return incidentEdgeTypes.has(bound) ? 'applicable' : 'undetermined';
    }
    case 'multi-edge': {
      const bound = boundEdgeTypes([rule]);
      if (bound.length === 0) return 'applicable';
      return bound.some((t) => sliceEdgeTypes.has(t)) ? 'applicable' : 'undetermined';
    }
    default:
      // Unknown shape — degrade to "I could not determine", never to "skipped".
      return 'undetermined';
  }
};

/**
 * Classify every selected rule into exactly one honesty bucket. Pure — it reads
 * the already-assembled slice and the already-emitted interpretations, and
 * makes no graph call.
 *
 * The precedence (fired > notEvaluable > notApplicable > checkedClean) is
 * deliberate: a rule that produced a claim IS evidence regardless of coverage,
 * but a rule that produced nothing must never be reported as "clean" when the
 * data it needs was never retrieved.
 */
export const classifyRuleCoverage = (args: {
  readonly rootType: ComponentType;
  readonly selectedRules: readonly ConceptRule[];
  readonly interpretations: readonly Interpretation[];
  readonly slice: GroundedSlice;
  readonly rootId: ComponentId;
  readonly missingCoverageTypes: ReadonlySet<string>;
  /**
   * Whether the vault holds ANY coverage rows. Decides which remedy the summary
   * names — see the gate below; the two cases need opposite advice.
   */
  readonly coverageKnown: boolean;
  /**
   * The assembled slice hit a cap. NOT merely cosmetic here: a rule that reads
   * slice edges and matched nothing over a CLIPPED slice has not been evaluated
   * — it has been starved — and may not be counted `checkedClean`.
   */
  readonly sliceTruncated: boolean;
}): ConceptCoverageReport => {
  const firedRuleIds = new Set(args.interpretations.map((i) => i.ruleId));

  // Edge types INCIDENT to the root — the same scoping `runBind`'s edge branch
  // applies, so a plain edge rule bound on a type the root has none of provably
  // cannot match. `sliceEdgeTypes` is the wider set (including the second-hop
  // edges) the multi-edge shapes legitimately reason over.
  const incidentEdgeTypes = new Set<EdgeType>();
  const sliceEdgeTypes = new Set<EdgeType>();
  for (const edge of args.slice.edges) {
    sliceEdgeTypes.add(edge.edgeType);
    if (edge.fromId === args.rootId || edge.toId === args.rootId) {
      incidentEdgeTypes.add(edge.edgeType);
    }
  }

  const conceptsFired = new Set<string>();
  const conceptsCheckedClean = new Set<string>();
  const conceptsNotApplicable = new Set<string>();
  const notEvaluable: UnevaluableRule[] = [];
  let rulesFiredCount = 0;
  let rulesCheckedClean = 0;
  let rulesNotApplicable = 0;
  let applicableRules = 0;

  for (const rule of args.selectedRules) {
    const category = bindCategory(rule);
    const verdict = decideApplicability(
      rule,
      args.rootType,
      incidentEdgeTypes,
      sliceEdgeTypes,
    );
    if (verdict === 'applicable') applicableRules += 1;

    // 1. FIRED wins outright — a rule that produced a claim IS evidence.
    if (firedRuleIds.has(rule.id)) {
      rulesFiredCount += 1;
      conceptsFired.add(rule.concept);
      continue;
    }

    // 2. PROVABLY not applicable — the ONLY path into the "correctly skipped"
    //    bucket, and only ever reached from `PROVABLE_CATEGORIES`.
    if (verdict === 'proven-inapplicable') {
      rulesNotApplicable += 1;
      conceptsNotApplicable.add(rule.concept);
      continue;
    }

    // 3. The vault lacks the metadata this rule reads — cannot be evaluated.
    const missing = rule.dependsOnCoverage.filter((t) => args.missingCoverageTypes.has(t));
    if (missing.length > 0) {
      notEvaluable.push({
        ruleId: rule.id,
        concept: rule.concept,
        missingCoverage: [...missing].sort(),
        reason: 'vault-coverage-missing',
      });
      continue;
    }

    // 4. We INFERRED the rule probably could not match, but did not prove it —
    //    or we do not understand its shape. Either way: "could not determine",
    //    never "correctly skipped".
    if (verdict === 'undetermined') {
      notEvaluable.push({
        ruleId: rule.id,
        concept: rule.concept,
        missingCoverage: [],
        reason: 'shape-not-provable',
      });
      continue;
    }

    // 5. STARVED BY THE CLIP. The rule's shape was present, the vault carried
    //    its families, and it still matched nothing — but the slice it ran
    //    against was CUT SHORT at a cap, so "matched nothing" is an artifact of
    //    the clip and not a finding. This is the whole point of the bucket
    //    split: `checkedClean` is a POSITIVE assertion ("really evaluated
    //    against a slice carrying the shape it binds on, and matched nothing")
    //    and a clipped slice cannot support it.
    //
    //    A machine consumer reads these COUNTS and never reads the prose
    //    caveat; that is exactly how a truncated access-control slice produced
    //    a confident wrong answer. So the disclosure is the bucket itself plus
    //    a typed `reason`, not a sentence appended to a summary.
    if (args.sliceTruncated && EDGE_READING_CATEGORIES.has(category)) {
      notEvaluable.push({
        ruleId: rule.id,
        concept: rule.concept,
        missingCoverage: [],
        reason: 'slice-truncated',
      });
      continue;
    }

    // 6. Applicable, evaluated against real data, matched nothing.
    rulesCheckedClean += 1;
    conceptsCheckedClean.add(rule.concept);
  }

  const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();
  // A concept can have several rules; report it under the STRONGEST bucket it
  // reached so the three lists stay disjoint and readable.
  const firedList = sorted(conceptsFired);
  const cleanList = sorted(conceptsCheckedClean).filter((c) => !conceptsFired.has(c));
  const naList = sorted(conceptsNotApplicable).filter(
    (c) => !conceptsFired.has(c) && !conceptsCheckedClean.has(c),
  );
  const noRuleCoversComponentType = applicableRules === 0;
  const coverageMissingCount = notEvaluable.filter(
    (r) => r.reason === 'vault-coverage-missing',
  ).length;
  const truncationStarvedCount = notEvaluable.filter(
    (r) => r.reason === 'slice-truncated',
  ).length;
  const notProvableCount =
    notEvaluable.length - coverageMissingCount - truncationStarvedCount;

  // D5 — when the vault itself is the blocker, the disclosure must name the
  // REMEDY, not just the wall of "unknown". A vault refreshed before coverage
  // rows existed reports every family as unconfirmed, which is honest but
  // useless without the next step.
  //
  // The remedy is GATED on whether the vault has coverage rows at all, because
  // the two cases need OPPOSITE advice and getting it backwards actively harms:
  //   - `coverageKnown === false` (no rows) — a snapshot predating coverage
  //     tracking. `sfi refresh --no-pull` recomputes coverage from what is
  //     already on disk, no org access, and is exactly right.
  //   - `coverageKnown === true` (rows exist, some families unconfirmed) —
  //     `--no-pull` would leave `retrieveConfirmed` false on every row and
  //     REGRESS coverage (measured: 5 missing families -> 17 on a healthy
  //     vault). Only a real retrieve fixes it.
  const vaultRemedy =
    coverageMissingCount === 0
      ? ''
      : args.coverageKnown
        ? ' Those families are not confirmed retrieved in this vault. Run a full `sfi refresh` to ' +
          're-retrieve them — do NOT use `--no-pull` here, which would leave every family ' +
          'unconfirmed and make coverage strictly worse.'
        : ' This vault carries NO retrieval record at all — a snapshot taken before coverage ' +
          'tracking existed, so every family reads as unconfirmed. Re-run `sfi refresh --no-pull` ' +
          'to recompute coverage from the existing snapshot (no org access needed) and these ' +
          'layers become checkable.';
  // NO shared-container remedy is appended here, and adding one back needs a
  // reachable case first. A `retrievedNotParsedTypes` member (today only
  // SessionSettings / FieldServiceSettings) cannot reach the
  // `vault-coverage-missing` bucket above on any coherent vault: every rule
  // that declares one in `dependsOnCoverage` also binds `componentTypes` to
  // that same type, and that is a `node` bind — a PROVABLE category — so a root
  // of any other type exits at step 2 as `proven-inapplicable` and never
  // reaches step 3. The one root that WOULD reach step 3 is the
  // shared-container type itself, which needs its own node in the graph; that
  // node exists only once its member file was parsed, which is exactly what
  // keeps the type OUT of `retrievedNotParsedTypes` (that set requires
  // `retrieved === 0`). The two conditions are mutually exclusive, so the
  // remedy sentence that used to live here was unreachable text — and it was
  // false as well, claiming the type's files were on disk unread when the
  // shared container had simply come back without them. The reachable, true
  // disclosure of that state is the one `sfi.coverage_report` and
  // `sfi.health_check` emit, and the family still reaches THIS answer through
  // `missingCoverage` (the caveat on `trust.completeness`).
  // `reason-component.test.ts` carries the invariant test that fails the moment
  // a rule makes the case reachable.
  const summary = noRuleCoversComponentType
    ? `NOTHING was checked for this ${args.rootType}: of ${args.selectedRules.length} concept ` +
      `rules, ${rulesNotApplicable} are provably inapplicable to this component type and ` +
      `${notEvaluable.length} could not be evaluated at all. This is silence, NOT a finding ` +
      `of "no issues".${vaultRemedy}`
    : `${rulesFiredCount} of ${args.selectedRules.length} concept rules fired; ` +
      `${rulesCheckedClean} were evaluated against this component and found nothing; ` +
      `${rulesNotApplicable} are provably inapplicable to a ${args.rootType} and were never ` +
      `checked; ${coverageMissingCount} could not be evaluated because the metadata they ` +
      `depend on is absent from this vault; ${notProvableCount} could not be evaluated ` +
      `because their bind shape could not be proven inapplicable here (reported as unknown, ` +
      `never as skipped)` +
      (args.sliceTruncated
        ? `; ${truncationStarvedCount} could not be evaluated because the graph slice was ` +
          'truncated at its cap — CUT SHORT before their evidence was complete. They are reported as ' +
          'unknown, NOT as clean. Any absence conclusion here is partial at best.'
        : '.') +
      vaultRemedy;

  return {
    rulesConsidered: args.selectedRules.length,
    rulesFired: rulesFiredCount,
    rulesCheckedClean,
    rulesNotApplicable,
    rulesNotEvaluable: notEvaluable.length,
    conceptsFired: firedList,
    conceptsCheckedClean: cleanList,
    conceptsNotApplicable: naList,
    conceptsNotEvaluable: [...notEvaluable].sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    noRuleCoversComponentType,
    sliceTruncated: args.sliceTruncated,
    summary,
  };
};

/** Max candidates pulled when bridging a natural identifier to an anchor. */
const ANCHOR_CANDIDATE_LIMIT = 8;

/**
 * A canonical component id — `Type:Name`, the exact form `getNodeById` takes.
 * An identifier matching this is treated as EXACT: a miss is not-found, never a
 * cue to fuzzy-match onto a neighbour.
 */
const CANONICAL_ID_RE = /^[A-Za-z][A-Za-z0-9_]*:.+$/;

const toAnchorCandidate = (c: ResolveCandidate): AnchorCandidate => ({
  componentId: c.id,
  type: c.type,
  apiName: c.apiName,
  parentApiName: c.parentApiName,
  score: c.score,
});

/**
 * QUESTION→ANCHOR BRIDGE — map a natural identifier onto a canonical component.
 *
 * The reasoning plane used to be reachable only by callers who ALREADY knew a
 * canonical id (`CustomField:Account.Foo__c`). That is the wrong bar for a
 * question-shaped ask: a user says "Account.Foo__c", or an object name, or a
 * class name. This routes those through `resolveComponents` — the SAME shared
 * resolver `sfi.resolve` and the rest of the tool surface use — so nothing new
 * is invented and no router mapping is touched.
 *
 * Honesty rules, in order:
 *   - it is only ever reached AFTER a direct `getNodeById` miss, so a canonical
 *     id that exists never pays for it and never changes behavior;
 *   - `ambiguous` is a NAMED failure carrying the candidates, never a silent
 *     pick of the top score and never an empty success that would read as
 *     "nothing to say about this component";
 *   - `none` is `component-not-found`, so the caller can render its existing
 *     phantom-aware message;
 *   - a resolved hit is stamped `resolvedFrom` so the answer can say the user
 *     named one thing and got an answer about another.
 */
const resolveAnchor = async (
  ctx: ReasonContext,
  identifier: string,
): Promise<
  Result<
    {
      readonly node: Node;
      readonly resolvedFrom: NonNullable<ReasonAboutComponentResult['resolvedFrom']>;
    },
    ReasonComponentError
  >
> => {
  const graphDbPath =
    ctx.vaultRoot !== undefined ? vaultPaths(ctx.vaultRoot).graphDb : undefined;
  const res = await resolveComponents(ctx.graph, identifier, {
    limit: ANCHOR_CANDIDATE_LIMIT,
    ...(graphDbPath !== undefined ? { graphDbPath } : {}),
  });
  if (!res.ok) {
    return err({ kind: 'internal', message: `resolve failed: ${res.error.message}` });
  }

  const { disposition, candidates } = res.value;
  if (disposition === 'none' || candidates.length === 0) {
    return err({ kind: 'component-not-found', componentId: identifier as ComponentId });
  }
  if (disposition === 'ambiguous') {
    return err({
      kind: 'ambiguous-identifier',
      identifier,
      candidates: candidates.map(toAnchorCandidate),
    });
  }

  const top = candidates[0]!;
  const nodeRes = await getNodeById(ctx.graph, top.id);
  if (!nodeRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeRes.error.message}` });
  }
  // The resolver indexes the graph, so a resolved id with no node is a torn
  // index, not a user error — fail as not-found rather than pretending.
  if (nodeRes.value === null) {
    return err({ kind: 'component-not-found', componentId: identifier as ComponentId });
  }
  return ok({
    node: nodeRes.value,
    resolvedFrom: { identifier, matchKind: top.matchKind, score: top.score },
  });
};

/**
 * Run the concept rules for ONE component and report both the claims and what
 * was (and was not) checked.
 *
 * @example
 *   const r = await reasonAboutComponent(ctx, 'CustomField:Acme__c.Amount__c' as ComponentId);
 *   if (r.ok) {
 *     console.log(r.value.interpretations);          // cited claims
 *     console.log(r.value.coverageReport.summary);   // what was checked
 *   }
 */
export const reasonAboutComponent = async (
  ctx: ReasonContext,
  componentId: ComponentId,
  opts: ReasonAboutComponentOptions = {},
): Promise<Result<ReasonAboutComponentResult, ReasonComponentError>> => {
  // (a) resolve the root node (skipped when the caller already has it).
  let rootNode: Node;
  let anchorId: ComponentId = componentId;
  let resolvedFrom: ReasonAboutComponentResult['resolvedFrom'];
  if (opts.rootNode !== undefined) {
    rootNode = opts.rootNode;
  } else {
    const rootRes = await getNodeById(ctx.graph, componentId);
    if (!rootRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${rootRes.error.message}`,
      });
    }
    if (rootRes.value !== null) {
      // Canonical id that exists — the resolver is NEVER reached, so this path
      // is byte-identical to the pre-bridge behavior.
      rootNode = rootRes.value;
    } else {
      // QUESTION→ANCHOR BRIDGE. The id did not resolve directly; put the raw
      // identifier through the SHARED resolver the rest of the product uses.
      //
      // A CANONICAL-shaped id (`Type:Name`) is deliberately NOT bridged: the
      // caller named an exact component, so a miss is a genuine
      // `component-not-found` — the caller's phantom-aware message is the right
      // answer, and fuzzy-matching an exact id onto a similarly-named neighbour
      // would be a silent substitution, not a resolution.
      if (opts.resolveIdentifier === false || CANONICAL_ID_RE.test(componentId)) {
        return err({ kind: 'component-not-found', componentId });
      }
      const bridged = await resolveAnchor(ctx, componentId);
      if (!bridged.ok) return bridged;
      anchorId = bridged.value.node.id;
      rootNode = bridged.value.node;
      resolvedFrom = bridged.value.resolvedFrom;
    }
  }

  // (c) select applicable rules (all, narrowed by the additive filters). An
  // empty filter ARRAY matches none; an omitted filter is unconstrained.
  const conceptFilter = opts.concepts;
  const ruleIdFilter = opts.ruleIds;
  const selectedRules = CONCEPT_RULES.filter(
    (rule) =>
      (conceptFilter === undefined || conceptFilter.includes(rule.concept)) &&
      (ruleIdFilter === undefined || ruleIdFilter.includes(rule.id)),
  );

  // (b) assemble the slice — targeted + batched, no N+1. Fetch only the edge
  // types the selected rules bind on, then every endpoint node those edges
  // touch (endpoint nodes are REQUIRED: the engine drops an edge endpoint whose
  // node is absent from `slice.nodes`).
  const edgeTypes = boundEdgeTypes(selectedRules);
  let edges: readonly Edge[] = [];
  let rootIncidentClipped = false;
  if (edgeTypes.length > 0) {
    const edgeRes = await listEdgesForNodes(ctx.graph, [anchorId], {
      direction: 'both',
      edgeTypes,
    });
    if (!edgeRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${edgeRes.error.message}`,
      });
    }
    const incident = edgeRes.value.get(anchorId) ?? [];
    if (incident.length > SLICE_EDGE_CAP) {
      rootIncidentClipped = true;
      edges = incident.slice(0, SLICE_EDGE_CAP);
    } else {
      edges = incident;
    }
  }

  // THE ONE BOUNDARY. Every expansion below asks this for permission instead of
  // re-deciding the cap for itself, so there is exactly one place that can clip
  // and exactly one place that records having clipped.
  const budget = createSliceBudget(edges.length);
  if (rootIncidentClipped) budget.clip('root-incident-edges');

  const endpointIds = new Set<ComponentId>();
  for (const edge of edges) {
    if (edge.fromId !== anchorId) endpointIds.add(edge.fromId);
    if (edge.toId !== anchorId) endpointIds.add(edge.toId);
  }
  const endpointRes = await listNodesByIds(ctx.graph, [...endpointIds]);
  if (!endpointRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${endpointRes.error.message}`,
    });
  }

  // Base (1-hop) slice: the root + its bound-type edges + those edges' endpoint
  // nodes. Non-join rules reason over exactly this, unchanged.
  const sliceNodes: Node[] = [rootNode, ...endpointRes.value];
  const sliceEdges: Edge[] = [...edges];

  // (b2) Second hop — ONLY for JOIN rules. The 1-hop slice already contains the
  // firer's via-edges (`firesWhen`, pulled by `boundEdgeTypes`) and their
  // intermediary (`ConditionalContext`) endpoint nodes, but NOT the writers of
  // the fields those intermediaries gate on. Expand: read each intermediary's
  // shared-key array (`fieldRefs`) → fetch the second-ground (`writesTo`) edges
  // INTO those keys → pull the writer + key nodes. Batched (one edge query, one
  // node query); no N+1. This runs only when a join rule is selected, so
  // non-join queries keep the exact 1-hop behavior above.
  const joinRules = selectedRules.filter((rule) => rule.bind.join !== undefined);
  if (joinRules.length > 0) {
    const nodeById = new Map<ComponentId, Node>(sliceNodes.map((n) => [n.id, n]));
    const throughTypes = new Set(joinRules.map((r) => r.bind.join!.throughType));
    const viaEdgeTypes = new Set(
      joinRules.flatMap((r) => (r.bind.edgeType !== undefined ? [r.bind.edgeType] : [])),
    );
    const keyArrayProps = [...new Set(joinRules.map((r) => r.bind.join!.throughKeyArray))];

    // FIX 2 — a record-triggered Flow firer's id carries no object segment; the
    // engine derives its same-object scope from the firer's `triggersOn` edge
    // (`Flow --triggersOn--> CustomObject`). When the status-code rule is also
    // selected, `triggersOn` is already a bound edge type and the 1-hop pulled
    // that edge + its object node; fetch them here only when it is NOT (a
    // join-only `ruleIds`/`concepts` selection) so the join is self-sufficient.
    if (!edgeTypes.includes('triggersOn' as EdgeType)) {
      const trigRes = await listEdgesForNodes(ctx.graph, [anchorId], {
        direction: 'out',
        edgeTypes: ['triggersOn' as EdgeType],
      });
      if (!trigRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${trigRes.error.message}`,
        });
      }
      const objIds = new Set<ComponentId>();
      for (const trigEdge of trigRes.value.get(anchorId) ?? []) {
        sliceEdges.push(trigEdge);
        if (!nodeById.has(trigEdge.toId)) objIds.add(trigEdge.toId);
      }
      if (objIds.size > 0) {
        const objRes = await listNodesByIds(ctx.graph, [...objIds]);
        if (!objRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${objRes.error.message}`,
          });
        }
        for (const objNode of objRes.value) {
          sliceNodes.push(objNode);
          nodeById.set(objNode.id, objNode);
        }
      }
    }

    // Shared keys X reached from F through its intermediary nodes.
    const keyIds = new Set<ComponentId>();
    for (const edge of sliceEdges) {
      if (edge.fromId !== anchorId) continue;
      if (!viaEdgeTypes.has(edge.edgeType)) continue;
      const through = nodeById.get(edge.toId);
      if (through === undefined || !throughTypes.has(through.type)) continue;
      for (const prop of keyArrayProps) {
        const arr = through.properties[prop];
        if (!Array.isArray(arr)) continue;
        for (const raw of arr) {
          if (typeof raw !== 'string') continue;
          // `continue`, not `break` — the original kept scanning the array and
          // merely recorded the clip; preserved verbatim.
          if (!budget.admitItem('join-shared-keys', keyIds.size)) continue;
          keyIds.add(raw as ComponentId);
        }
      }
    }

    const writeEdgeTypes = joinWriteEdgeTypes(joinRules);
    if (keyIds.size > 0 && writeEdgeTypes.length > 0) {
      const writeRes = await listEdgesForNodes(ctx.graph, [...keyIds], {
        direction: 'in',
        edgeTypes: writeEdgeTypes,
      });
      if (!writeRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${writeRes.error.message}`,
        });
      }
      const writerIds = new Set<ComponentId>();
      for (const keyId of keyIds) {
        for (const writeEdge of writeRes.value.get(keyId) ?? []) {
          if (!budget.admitEdge('join-second-ground-edges', sliceEdges.length)) break;
          sliceEdges.push(writeEdge);
          writerIds.add(writeEdge.fromId);
        }
      }
      // Pull the key (X) + writer (W) nodes not already resolved in the slice —
      // the engine drops any endpoint whose node is absent, so both are REQUIRED
      // for a coupling to be cited.
      const needNodeIds = [...new Set<ComponentId>([...keyIds, ...writerIds])].filter(
        (id) => !nodeById.has(id),
      );
      if (needNodeIds.length > 0) {
        const joinNodesRes = await listNodesByIds(ctx.graph, needNodeIds);
        if (!joinNodesRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${joinNodesRes.error.message}`,
          });
        }
        sliceNodes.push(...joinNodesRes.value);
      }

      // RM-loop PASS 2 — pull each writer W's OUTGOING `triggersOn` edge so the
      // engine can PLACE a record-triggered Flow writer in the save order
      // (its before/after-save timing lives on that edge's `triggerType`, and a
      // Flow id carries no timing). The firer F's own `triggersOn` edge is
      // already in the slice (via the 1-hop status-code binding or the join-only
      // block above), so only the writers need it here. ONE batched query (no
      // N+1); the CustomObject targets are NOT pulled as nodes — the engine reads
      // only the edge's `triggerType`, never the target node. ApexTrigger / rule
      // / approval writers place from their own node, so a Flow-less writer just
      // has no `triggersOn` edge and is placed (or left unplaceable) accordingly.
      if (writerIds.size > 0) {
        const writerTrigRes = await listEdgesForNodes(ctx.graph, [...writerIds], {
          direction: 'out',
          edgeTypes: ['triggersOn' as EdgeType],
        });
        if (!writerTrigRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${writerTrigRes.error.message}`,
          });
        }
        for (const writerId of writerIds) {
          for (const trigEdge of writerTrigRes.value.get(writerId) ?? []) {
            sliceEdges.push(trigEdge);
          }
        }
      }
    }
  }

  // (b3) Second hop — ONLY for AGGREGATE rules that count edges off the root
  // OBJECT's OWN fields (`edgeSource: 'root-children-outgoing'`, e.g. the
  // junction-object rule counting distinct master-detail parents). The 1-hop
  // slice pulls edges INCIDENT to the object node, but a master-detail `lookupTo`
  // edge hangs off the object's CHILD FIELD, so the object node carries ZERO of
  // them. Expand: pull the root's child fields (via `parentOf`), then their
  // OUTGOING counted edges + the parent nodes those edges cite. Batched (one edge
  // query per hop, one node query); runs only when such a rule is selected, so
  // every other query keeps the exact 1-hop behavior above.
  const childOutgoingAggRules = selectedRules.filter(
    (rule) => rule.bind.aggregate?.edgeSource === 'root-children-outgoing',
  );
  if (childOutgoingAggRules.length > 0) {
    const nodeById = new Map<ComponentId, Node>(sliceNodes.map((n) => [n.id, n]));
    const countedEdgeTypes = [
      ...new Set(
        childOutgoingAggRules.flatMap((r) =>
          r.bind.edgeType !== undefined ? [r.bind.edgeType] : [],
        ),
      ),
    ];
    // 1) the root object's child fields (CustomObject --parentOf--> CustomField).
    const childRes = await listEdgesForNodes(ctx.graph, [anchorId], {
      direction: 'out',
      edgeTypes: ['parentOf' as EdgeType],
    });
    if (!childRes.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${childRes.error.message}` });
    }
    const childFieldIds = new Set<ComponentId>();
    for (const childEdge of childRes.value.get(anchorId) ?? []) {
      childFieldIds.add(childEdge.toId);
    }
    // 2) those fields' OUTGOING counted edges (lookupTo) + the field/parent nodes
    // each cited edge needs (the engine drops an edge whose endpoint node is
    // absent, so the child field — for the `parentId === root` test — and the
    // parent object — the citation — are both REQUIRED).
    if (childFieldIds.size > 0 && countedEdgeTypes.length > 0) {
      const fieldEdgeRes = await listEdgesForNodes(ctx.graph, [...childFieldIds], {
        direction: 'out',
        edgeTypes: countedEdgeTypes,
      });
      if (!fieldEdgeRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${fieldEdgeRes.error.message}`,
        });
      }
      const needIds = new Set<ComponentId>();
      for (const fieldId of childFieldIds) {
        for (const fieldEdge of fieldEdgeRes.value.get(fieldId) ?? []) {
          if (!budget.admitEdge('aggregate-child-field-edges', sliceEdges.length)) break;
          sliceEdges.push(fieldEdge);
          needIds.add(fieldEdge.fromId);
          needIds.add(fieldEdge.toId);
        }
      }
      const needNodeIds = [...needIds].filter((id) => !nodeById.has(id));
      if (needNodeIds.length > 0) {
        const aggNodesRes = await listNodesByIds(ctx.graph, needNodeIds);
        if (!aggNodesRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${aggNodesRes.error.message}`,
          });
        }
        sliceNodes.push(...aggNodesRes.value);
      }
    }
  }

  // (b4) Second hop — ONLY for EC-8 anti-join rules. Two shapes:
  //   - sameFromToPresentObject (C15 arm1): present field FLS grants are in the
  //     1-hop slice; pull each grantor's OUTGOING grantedBy edges so the engine
  //     can see whether the parent object also has allowEdit.
  //   - sameFromToRoot (C15 arm2): present object CRUD grants are NOT incident to
  //     a field root — fetch grantedBy INTO CustomObject:{objectOf(root)}.
  //   - sameTo + absentFromPhaseIn (C17): present is the field node; 1-hop already
  //     pulled incoming writesTo; pull each writer's triggersOn for phase placement.
  const antiJoinRules = selectedRules.filter((rule) => rule.bind.antiJoin !== undefined);
  if (antiJoinRules.length > 0) {
    const nodeById = new Map<ComponentId, Node>(sliceNodes.map((n) => [n.id, n]));
    const needEdgeTypes = [
      ...new Set(antiJoinRules.map((r) => r.bind.antiJoin!.absentEdgeType)),
    ];
    const needsPhase = antiJoinRules.some(
      (r) => r.bind.antiJoin!.absentFromPhaseIn !== undefined,
    );
    const needsPresentObject = antiJoinRules.some(
      (r) => r.bind.antiJoin!.correlate === 'sameFromToPresentObject',
    );
    const needsRootObjectPresent = antiJoinRules.some(
      (r) => r.bind.antiJoin!.correlate === 'sameFromToRoot',
    );

    // C15 arm2 — object grants into the field's parent object.
    if (needsRootObjectPresent) {
      const objMatch = /^[A-Za-z][A-Za-z0-9_]*:([^.]+)\./.exec(anchorId);
      if (objMatch !== null) {
        const parentObjId = `CustomObject:${objMatch[1]}` as ComponentId;
        const objGrantRes = await listEdgesForNodes(ctx.graph, [parentObjId], {
          direction: 'in',
          edgeTypes: needEdgeTypes,
        });
        if (!objGrantRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${objGrantRes.error.message}`,
          });
        }
        const grantorIds = new Set<ComponentId>();
        for (const gEdge of objGrantRes.value.get(parentObjId) ?? []) {
          if (!budget.admitEdge('anti-join-root-object-grants', sliceEdges.length)) break;
          sliceEdges.push(gEdge);
          grantorIds.add(gEdge.fromId);
        }
        const needIds = [...grantorIds, parentObjId].filter((id) => !nodeById.has(id));
        if (needIds.length > 0) {
          const nRes = await listNodesByIds(ctx.graph, needIds);
          if (!nRes.ok) {
            return err({
              kind: 'internal',
              message: `graph query failed: ${nRes.error.message}`,
            });
          }
          for (const n of nRes.value) {
            sliceNodes.push(n);
            nodeById.set(n.id, n);
          }
        }
      }
    }

    // C15 arm1 — from each present grantor, pull outgoing absentEdgeType edges
    // (object grants) + the parent object node.
    if (needsPresentObject) {
      const grantorIds = new Set<ComponentId>();
      for (const edge of sliceEdges) {
        if (edge.toId === anchorId) grantorIds.add(edge.fromId);
        if (edge.fromId === anchorId) grantorIds.add(edge.toId);
      }
      if (grantorIds.size > 0) {
        const outRes = await listEdgesForNodes(ctx.graph, [...grantorIds], {
          direction: 'out',
          edgeTypes: needEdgeTypes,
        });
        if (!outRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${outRes.error.message}`,
          });
        }
        const objIds = new Set<ComponentId>();
        for (const grantorId of grantorIds) {
          for (const gEdge of outRes.value.get(grantorId) ?? []) {
            if (!budget.admitEdge('anti-join-present-object-grants', sliceEdges.length)) break;
            sliceEdges.push(gEdge);
            objIds.add(gEdge.toId);
          }
        }
        const needIds = [...objIds].filter((id) => !nodeById.has(id));
        if (needIds.length > 0) {
          const nRes = await listNodesByIds(ctx.graph, needIds);
          if (!nRes.ok) {
            return err({
              kind: 'internal',
              message: `graph query failed: ${nRes.error.message}`,
            });
          }
          for (const n of nRes.value) {
            sliceNodes.push(n);
            nodeById.set(n.id, n);
          }
        }
      }
    }

    // C17 — pull writers' triggersOn so phaseOfAutomation can place before-save.
    if (needsPhase) {
      const writerIds = new Set<ComponentId>();
      for (const edge of sliceEdges) {
        if (needEdgeTypes.includes(edge.edgeType) && edge.toId === anchorId) {
          writerIds.add(edge.fromId);
        }
      }
      if (writerIds.size > 0) {
        const trigRes = await listEdgesForNodes(ctx.graph, [...writerIds], {
          direction: 'out',
          edgeTypes: ['triggersOn' as EdgeType],
        });
        if (!trigRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${trigRes.error.message}`,
          });
        }
        for (const writerId of writerIds) {
          for (const trigEdge of trigRes.value.get(writerId) ?? []) {
            sliceEdges.push(trigEdge);
          }
        }
      }
    }
  }

  // (b5) Second hop — ONLY for EC-11 crossObjectCascade rules (D3). The 1-hop
  // slice pulls the writer's OUTGOING writerTriggerEdge + writeEdge, but the
  // INCOMING automation on the TARGET object B (triggersOn / firesWhen from a
  // firer ≠ W) is NOT incident to W — it hangs off CustomObject:B. Expand: from
  // each cross-object write target, resolve object B → fetch INCOMING
  // targetIncomingEdgeTypes edges + their firer nodes. Batched; runs only when
  // such a rule is selected.
  const cascadeRules = selectedRules.filter(
    (rule) => rule.bind.crossObjectCascade !== undefined,
  );
  if (cascadeRules.length > 0) {
    const nodeById = new Map<ComponentId, Node>(sliceNodes.map((n) => [n.id, n]));
    const writeEdgeTypes = new Set(
      cascadeRules.map((r) => r.bind.crossObjectCascade!.writeEdge),
    );
    const incomingTypes = [
      ...new Set(
        cascadeRules.flatMap((r) => r.bind.crossObjectCascade!.targetIncomingEdgeTypes),
      ),
    ];
    const FIELD_OBJECT_RE = /^[A-Za-z][A-Za-z0-9_]*:([^.]+)\./;
    const CUSTOM_OBJECT_RE = /^CustomObject:(.+)$/;
    const targetObjIds = new Set<ComponentId>();
    for (const edge of sliceEdges) {
      if (edge.fromId !== anchorId) continue;
      if (!writeEdgeTypes.has(edge.edgeType)) continue;
      const fieldMatch = FIELD_OBJECT_RE.exec(edge.toId);
      if (fieldMatch !== null) {
        targetObjIds.add(`CustomObject:${fieldMatch[1]}` as ComponentId);
        continue;
      }
      if (CUSTOM_OBJECT_RE.test(edge.toId)) targetObjIds.add(edge.toId);
    }
    if (targetObjIds.size > 0 && incomingTypes.length > 0) {
      const inRes = await listEdgesForNodes(ctx.graph, [...targetObjIds], {
        direction: 'in',
        edgeTypes: incomingTypes,
      });
      if (!inRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${inRes.error.message}`,
        });
      }
      const firerIds = new Set<ComponentId>();
      for (const objId of targetObjIds) {
        for (const inEdge of inRes.value.get(objId) ?? []) {
          if (inEdge.fromId === anchorId) continue;
          if (!budget.admitEdge('cascade-target-firers', sliceEdges.length)) break;
          sliceEdges.push(inEdge);
          firerIds.add(inEdge.fromId);
        }
      }
      const needIds = [...firerIds].filter((id) => !nodeById.has(id));
      if (needIds.length > 0) {
        const firerRes = await listNodesByIds(ctx.graph, needIds);
        if (!firerRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${firerRes.error.message}`,
          });
        }
        sliceNodes.push(...firerRes.value);
      }
    }
  }

  const slice: GroundedSlice = { nodes: sliceNodes, edges: sliceEdges };
  // DERIVED from the ledger, never assigned: the boolean and the list of clip
  // sites can no longer disagree.
  const sliceTruncated = budget.truncated;
  const truncatedExpansions = budget.expansions;

  // (d)+(e) per-rule coverage → interpret → flatten (claims VERBATIM).
  const interpretations: Interpretation[] = [];
  for (const rule of selectedRules) {
    const coverage = adaptCoverage(
      summarizeCoverage(ctx.manifest, rule.dependsOnCoverage),
      sliceTruncated,
    );
    // FIX 1 — pass the queried root so a node-shaped rule reasons about THIS
    // component only, never a neighbor the 2-hop join expansion dragged in.
    interpretations.push(...interpret(rule, slice, coverage, anchorId));
  }

  // EPIC-1 — second pass: bind ChainedRules over emitted interpretations
  // (concept-output → concept-input). One pass only; chain outputs are not
  // re-fed. Citations are the union of matched priors; confidence is weakest().
  interpretations.push(...chainInterpret(interpretations, CHAINED_RULES));

  // EPIC-2 — third pass: bind CompoundRules over the emitted interpretations
  // (first-pass + chained), firing only where ≥2 required concepts CO-FIRE ON
  // ONE ANCHOR. Emits one reconciled compound per shared anchor citing the union
  // of the priors that cite that anchor at weakest(). One pass only; compound
  // outputs are not re-fed. Delivers net-access-intersection (widen ∩ narrow →
  // one per-object posture).
  interpretations.push(...compoundInterpret(interpretations, COMPOUND_RULES));

  // EPIC-3 — fourth pass: reconcile superseded weaker claims after first-pass +
  // chain + compound. Demotes (stamps supersededBy) or drops redundant broader
  // interpretations when a stronger co-fires with anchor/topic overlap. Never
  // rewrites claim or groundedIn on demoted priors.
  const interpretationsReconciled = reconcile(interpretations, SUPERSEDES_RULES);

  const rulesFired = new Set(interpretationsReconciled.map((i) => i.ruleId)).size;

  // Aggregate coverage over the union of the selected rules' dependencies —
  // drives the trust block + the top-level coverage caveat.
  const unionCoverageTypes = [
    ...new Set(selectedRules.flatMap((rule) => rule.dependsOnCoverage)),
  ];
  const aggSummary = summarizeCoverage(ctx.manifest, unionCoverageTypes);
  const aggCoverage = adaptCoverage(aggSummary, sliceTruncated);

  // #2 — a bound counted junction endpoint (a master-detail PARENT) NOT retrieved
  // into the vault makes the distinct-parent count UNDER-report: a real two-master
  // junction can go silently undetected — no citation, no interpretation, so no
  // per-rule caveat ever surfaces. "complete coverage" must never sit beside such
  // a silent non-detection, so when a `root-children-outgoing` aggregate rule drops
  // a phantom counted endpoint, hold the aggregate completeness OFF `complete` and
  // disclose the miss EVEN WHEN no rule fired. This touches only the TOP-LEVEL
  // trust/coverage block; the per-rule interpretation objects (incl. any co-selected
  // automation-collision claim) are byte-unchanged.
  const junctionEndpointUnresolved = childOutgoingAggRules.some((rule) =>
    aggregateHasUnresolvedCountedEndpoint(rule, slice, anchorId),
  );
  const junctionMissNote: string | null = junctionEndpointUnresolved
    ? 'A master-detail parent of this object was not retrieved into the vault, so junction ' +
      '(two-master) detection may be incomplete — a real many-to-many junction can go undetected here.'
    : null;
  const completenessStatus: Coverage['status'] =
    junctionEndpointUnresolved && aggCoverage.status === 'complete' ? 'partial' : aggCoverage.status;
  // The rendered / top-level caveat carries BOTH the general coverage caveat and
  // the junction-miss note (either may be null).
  const topCoverageCaveat: string | null =
    aggCoverage.caveat !== null && junctionMissNote !== null
      ? `${aggCoverage.caveat} ${junctionMissNote}`
      : (aggCoverage.caveat ?? junctionMissNote);

  // (f) honesty classification — which layers were checked vs skipped vs
  // unevaluable. Pure; no extra graph read.
  const coverageReport = classifyRuleCoverage({
    rootType: rootNode.type,
    selectedRules,
    interpretations: interpretationsReconciled,
    slice,
    rootId: anchorId,
    missingCoverageTypes: new Set(aggSummary.missingCoverage),
    coverageKnown: aggSummary.coverageKnown,
    sliceTruncated,
  });

  return ok({
    componentId: anchorId,
    ...(resolvedFrom !== undefined ? { resolvedFrom } : {}),
    componentType: rootNode.type,
    rootNode,
    interpretations: interpretationsReconciled,
    selectedRules,
    rulesFired,
    sliceTruncated,
    truncatedExpansions,
    slice,
    unionCoverageTypes,
    aggSummary,
    aggCoverage,
    junctionEndpointUnresolved,
    junctionMissNote,
    completenessStatus,
    topCoverageCaveat,
    coverageReport,
  });
};
