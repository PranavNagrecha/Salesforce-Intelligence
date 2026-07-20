/**
 * EPIC-2 — curated cross-concept COMPOSITION rules (same-anchor co-fire).
 *
 * Where the EPIC-1 {@link ChainedRule} substrate fires on the GLOBAL presence of
 * its required concepts (concept-output → concept-input, anchor-agnostic), a
 * {@link CompoundRule} fires only when ≥2 required concepts CO-FIRE ON ONE ANCHOR
 * — an id cited by a prior of EVERY required concept — and emits ONE reconciled
 * compound narrative per shared anchor at `weakest()`. This generalizes the
 * hand-coded same-anchor AND-binds (e.g. `system-context-external-surface`,
 * `apex-async-amplified-governor-risk`) into a declarative shape.
 *
 * Kept as a frozen TypeScript catalog for the EPIC-2 substrate (mirroring
 * `chained-rules.ts`). DEFERRED: declarative YAML `CompoundRule` codegen folded
 * into the concept-model pipeline, a full severity/precedence matrix, and EPIC-3
 * supersession (a compound superseding the priors it composes).
 */

import type { CompoundRule } from '@sf-intelligence/contracts';

/**
 * Demo compound: NET-ACCESS-INTERSECTION.
 *
 * On ONE CustomObject anchor, the RESTRICTED OWD baseline (`owd-sharing-posture`
 * = Private / Controlled by Parent, the NARROW side) co-fires with the add-only
 * widening surface (`object-widened-by-sharing-rule-count`, ≥2 sharing rules, the
 * WIDEN side). Both cite the object id, so they intersect on that anchor. The
 * compound reconciles them into one per-object NET posture: a restrictive
 * baseline layered with N add-only widenings — the effective access is broader
 * than the OWD alone implies, and the exact reach is a record-level question the
 * offline vault cannot resolve.
 *
 * Chosen because BOTH priors ship as first-pass ConceptRules that genuinely
 * anchor on the same CustomObject (the OWD node rule cites the object; the
 * sharing-rule-count aggregate cites its SharingRule children AND the object),
 * so the same-anchor intersection is real, not contrived. Confidence ceiling is
 * `declared` — both priors are declared metadata facts, and the compound asserts
 * only their reconciliation plus an explicit not-determinable-offline caveat, so
 * `weakest()` keeps the honest declared level without over- or under-stating it.
 */
export const COMPOUND_RULES: readonly CompoundRule[] = Object.freeze<CompoundRule[]>([
  {
    id: 'compound:net-access-intersection',
    concept: 'concept:net-access-intersection',
    requiredConcepts: [
      'concept:owd-sharing-posture',
      'concept:object-widened-by-sharing-rule-count',
    ],
    sameAnchor: true,
    interpretation:
      '{anchor} has a restrictive org-wide default AND an add-only sharing-rule widening surface ' +
      'on the SAME object — the widen-union ∩ narrow baseline reconciled to one net posture. Its ' +
      'baseline access is restrictive, but sharing rules layer additional grants on top (they can ' +
      'only ADD access, never restrict below the OWD), so the NET effective access is broader than ' +
      'the OWD alone implies. This composes two grounded prior interpretations (owd-sharing-posture ' +
      '∩ object-widened-by-sharing-rule-count) that co-fire on this object; it names the reconciled ' +
      'posture structurally, NOT a per-record or per-user reach — which records each rule actually ' +
      'widens depends on live field values and role/group membership the offline vault cannot ' +
      'evaluate. Grounded in: {ids}.',
    maxConfidence: 'declared',
    absenceShaped: false,
    // EPIC-3 ranking HINTS (engine ignores them): a reconciled access posture is
    // a review-worthy medium signal; precedence orders it below a proven exposure.
    severity: 'medium',
    precedence: 10,
    dependsOnCoverage: ['CustomObject', 'SharingRule'],
  },
]);
