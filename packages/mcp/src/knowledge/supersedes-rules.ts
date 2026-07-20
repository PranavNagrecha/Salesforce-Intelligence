/**
 * EPIC-3 — curated conflict-resolution (supersedes) edges.
 *
 * Each {@link SupersedesRule} names a STRONGER / more-specific concept that
 * SUPERSEDES a broader, overlapping one when both co-fire over a shared anchor
 * (or a curated topic). The reconciliation pass ({@link reconcile}) applies
 * these AFTER the first pass and after `chainInterpret`, so the sharper claim is
 * surfaced without the weaker one crowding it — WITHOUT ever rewriting or
 * re-grounding a claim (the weaker one is DEMOTED with a `supersededBy` marker,
 * never stripped of its citations).
 *
 * Every edge below is between EXISTING, curated concepts whose OWN summaries
 * already state the subsumption — the reconciliation just makes that curated
 * relationship operational:
 *
 *   1+2. `system-context-external-surface` is, by its own definition, the
 *        INTERSECTION of `apex-sharing-mode` (`without sharing`) AND
 *        `external-api-surface` (an @RestResource/@AuraEnabled/@InvocableMethod
 *        entry point). When the composed security-review claim fires on a class,
 *        the two component claims on that SAME class are redundant beside it, so
 *        each is superseded (demoted) — the composed claim carries their meaning
 *        plus the amplification. (Two edges: one per component concept.)
 *
 *   3.   `apex-async-amplified-governor-risk` is, by its own definition, the
 *        composition of an async boundary (Queueable/Batch) with the in-loop
 *        SOQL/DML pattern that `apex-bulkification-gap` recognizes — the same
 *        governor gap "AMPLIFIED at async scale". On a class where the amplified
 *        claim fires, the plain bulkification claim is the weaker overlapping
 *        form, so it is superseded (demoted).
 *
 * All three use `anchor` overlap: supersession applies only when the two
 * interpretations share a grounded component (the same ApexClass), never on a
 * coincidental co-fire. `refinesTopic` is recorded for auditability and for the
 * `topic`/`either` overlap modes the engine also supports.
 *
 * DEFERRED (see EPIC-3 note): full composed confidence/coverage calculus
 * (path-aware `min`, coverage-union keyed to composition shape), declarative
 * YAML codegen, and EPIC-2 `CompoundRule` integration (not on this branch).
 */

import type { SupersedesRule } from '@sf-intelligence/contracts';

export const SUPERSEDES_RULES: readonly SupersedesRule[] = Object.freeze<SupersedesRule[]>([
  {
    id: 'supersedes:system-context-external-surface>external-api-surface',
    strongerConcept: 'concept:system-context-external-surface',
    supersededConcept: 'concept:external-api-surface',
    overlap: 'anchor',
    refinesTopic: 'apex-external-access-posture',
    mode: 'demote',
    rationale:
      'system-context-external-surface IS the intersection of `without sharing` and an ' +
      'external entry point; it subsumes the plain external-api-surface claim on the same ' +
      'class (that class is externally reachable) and adds the system-context amplification.',
  },
  {
    id: 'supersedes:system-context-external-surface>apex-sharing-mode',
    strongerConcept: 'concept:system-context-external-surface',
    supersededConcept: 'concept:apex-sharing-mode',
    overlap: 'anchor',
    refinesTopic: 'apex-external-access-posture',
    mode: 'demote',
    rationale:
      'system-context-external-surface already encodes the `without sharing` posture as one ' +
      'half of its intersection, so the standalone apex-sharing-mode claim on the same class ' +
      'is the weaker overlapping form and is demoted beneath the composed security-review claim.',
  },
  {
    id: 'supersedes:apex-async-amplified-governor-risk>apex-bulkification-gap',
    strongerConcept: 'concept:apex-async-amplified-governor-risk',
    supersededConcept: 'concept:apex-bulkification-gap',
    overlap: 'anchor',
    refinesTopic: 'apex-governor-limit-risk',
    mode: 'demote',
    rationale:
      'apex-async-amplified-governor-risk composes the async boundary with the very in-loop ' +
      'SOQL/DML pattern apex-bulkification-gap recognizes — the same gap AMPLIFIED at async ' +
      'scale — so the plain bulkification claim on the same class is the weaker overlapping form.',
  },
]);
