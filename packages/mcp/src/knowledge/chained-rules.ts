/**
 * EPIC-1 — curated chained-interpretation rules (concept-output → concept-input).
 *
 * These are the second-pass substrate: each rule fires when prior
 * {@link Interpretation}s already named every `requiredConcepts` id. They are
 * NOT graph predicates (contrast hand-coded AND-binds like
 * `system-context-external-surface` / `apex-async-amplified-governor-risk`).
 *
 * Kept as a frozen TypeScript catalog for the EPIC-1 substrate. EPIC-2 will
 * generalize into declarative YAML `CompoundRule` (co-fire on one anchor,
 * severity/precedence, net-access-intersection) and fold codegen into the
 * concept-model pipeline.
 */

import type { ChainedRule } from '@sf-intelligence/contracts';

/**
 * Demo chain: async-boundary ∩ soql-injection-surface → amplified review priority.
 * Both priors already ship as first-pass ConceptRules on ApexClass.
 */
export const CHAINED_RULES: readonly ChainedRule[] = Object.freeze<ChainedRule[]>([
  {
    id: 'chain:async-boundary+soql-injection',
    concept: 'concept:async-soql-injection-amplification',
    requiredConcepts: [
      'concept:async-boundary',
      'concept:apex-soql-injection-surface',
    ],
    interpretation:
      '{ids} is structurally async AND carries a recognized SOQL-injection risk pattern — ' +
      'the injection-shaped dynamic query can execute in a SEPARATE transaction from the ' +
      'enqueueing save (governor limits reset at the async boundary; a fault on that path ' +
      'cannot roll back the original save). This composes two grounded prior interpretations ' +
      '(async-boundary ∩ soql-injection-surface); it is HEURISTIC (tokenized Apex, not a ' +
      'compiler AST) and NOT a proven exploit. Confirm whether caller-controllable input ' +
      'reaches the dynamic query and whether the async path runs in production.',
    maxConfidence: 'heuristic',
    absenceShaped: false,
    dependsOnCoverage: ['ApexClass'],
  },
]);
