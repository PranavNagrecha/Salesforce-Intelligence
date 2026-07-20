/// <reference types="vitest/globals" />

/**
 * EPIC-1 — chained-interpretation substrate proofs.
 *
 * Synthetic priors only (no vault). Proves:
 *   1. requiredConcepts ALL-present ⇒ one chained Interpretation;
 *   2. groundedIn is the UNION of matched priors' citations;
 *   3. confidence = weakest(rule.maxConfidence, …priors);
 *   4. missing any required concept ⇒ [];
 *   5. the shipped demo chain (async ∩ soql-injection) is wired.
 */

import type { ChainedRule, ConfidenceLevel, Interpretation } from '@sf-intelligence/contracts';

import { CHAINED_RULES } from '../../src/knowledge/chained-rules.js';
import { CONCEPTS, CONCEPT_RULES, MODEL_VERSION } from '../../src/knowledge/loader.js';
import {
  chainInterpret,
  interpret,
  weakest,
  type Coverage,
  type GroundedSlice,
} from '../../src/knowledge/reason.js';

const prior = (
  concept: string,
  groundedIn: string[],
  confidence: ConfidenceLevel | 'unknown' = 'declared',
  ruleId = `rule:prior/${concept}`,
): Interpretation => ({
  ruleId,
  concept,
  claim: `prior claim for ${concept}`,
  groundedIn,
  confidence,
  coverageCaveat: null,
  modelVersion: MODEL_VERSION,
  provenance: 'offline_snapshot',
});

const demoRule = (): ChainedRule => {
  const rule = CHAINED_RULES.find((r) => r.id === 'chain:async-boundary+soql-injection');
  if (rule === undefined) throw new Error('demo chained rule missing');
  return rule;
};

describe('chainInterpret — EPIC-1 substrate', () => {
  it('fires when every requiredConcepts id is present among priors', () => {
    const rule: ChainedRule = {
      id: 'chain:test/a+b',
      concept: 'concept:test-chain',
      requiredConcepts: ['concept:a', 'concept:b'],
      interpretation: '{ids} composes A and B.',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    const out = chainInterpret(
      [
        prior('concept:a', ['ApexClass:Ns__A'], 'declared'),
        prior('concept:b', ['ApexClass:Ns__B'], 'parsed'),
      ],
      [rule],
    );
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.ruleId).toBe('chain:test/a+b');
    expect(only.concept).toBe('concept:test-chain');
    expect(only.groundedIn).toEqual(['ApexClass:Ns__A', 'ApexClass:Ns__B']);
    expect(only.confidence).toBe(weakest('declared', 'declared', 'parsed'));
    expect(only.confidence).toBe('parsed');
    expect(only.claim).toContain('ApexClass:Ns__A');
    expect(only.claim).toContain('ApexClass:Ns__B');
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('unions ALL matching priors for a required concept (multi-fire)', () => {
    const rule: ChainedRule = {
      id: 'chain:test/a+b-multi',
      concept: 'concept:test-chain',
      requiredConcepts: ['concept:a', 'concept:b'],
      interpretation: 'composed over {ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    const out = chainInterpret(
      [
        prior('concept:a', ['ApexClass:Ns__A1'], 'declared', 'rule:a/1'),
        prior('concept:a', ['ApexClass:Ns__A2'], 'heuristic', 'rule:a/2'),
        prior('concept:b', ['ApexClass:Ns__B'], 'declared'),
      ],
      [rule],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([
      'ApexClass:Ns__A1',
      'ApexClass:Ns__A2',
      'ApexClass:Ns__B',
    ]);
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('dedupes overlapping groundedIn across priors', () => {
    const rule: ChainedRule = {
      id: 'chain:test/overlap',
      concept: 'concept:test-chain',
      requiredConcepts: ['concept:a', 'concept:b'],
      interpretation: '{ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    const out = chainInterpret(
      [
        prior('concept:a', ['ApexClass:Ns__Same'], 'declared'),
        prior('concept:b', ['ApexClass:Ns__Same'], 'declared'),
      ],
      [rule],
    );
    expect(out[0]!.groundedIn).toEqual(['ApexClass:Ns__Same']);
  });

  it('does NOT fire when any required concept is missing', () => {
    const rule: ChainedRule = {
      id: 'chain:test/missing',
      concept: 'concept:test-chain',
      requiredConcepts: ['concept:a', 'concept:b'],
      interpretation: '{ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    expect(chainInterpret([prior('concept:a', ['ApexClass:Ns__A'])], [rule])).toEqual([]);
    expect(chainInterpret([], [rule])).toEqual([]);
  });

  it('does NOT fire on empty requiredConcepts (fail closed)', () => {
    const rule: ChainedRule = {
      id: 'chain:test/empty-req',
      concept: 'concept:test-chain',
      requiredConcepts: [],
      interpretation: '{ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    expect(
      chainInterpret([prior('concept:a', ['ApexClass:Ns__A'])], [rule]),
    ).toEqual([]);
  });

  it('caps confidence to unknown when any matched prior is unknown', () => {
    const rule: ChainedRule = {
      id: 'chain:test/unknown',
      concept: 'concept:test-chain',
      requiredConcepts: ['concept:a', 'concept:b'],
      interpretation: '{ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    const out = chainInterpret(
      [
        prior('concept:a', ['ApexClass:Ns__A'], 'declared'),
        prior('concept:b', ['ApexClass:Ns__B'], 'unknown'),
      ],
      [rule],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe('unknown');
  });

  it('skips a chain whose concept already fired in the first pass', () => {
    const rule: ChainedRule = {
      id: 'chain:test/already',
      concept: 'concept:a',
      requiredConcepts: ['concept:b'],
      interpretation: '{ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    expect(
      chainInterpret(
        [
          prior('concept:a', ['ApexClass:Ns__A']),
          prior('concept:b', ['ApexClass:Ns__B']),
        ],
        [rule],
      ),
    ).toEqual([]);
  });

  it('joins non-null coverage caveats from matched priors', () => {
    const rule: ChainedRule = {
      id: 'chain:test/caveat',
      concept: 'concept:test-chain',
      requiredConcepts: ['concept:a', 'concept:b'],
      interpretation: '{ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    const a = prior('concept:a', ['ApexClass:Ns__A']);
    const b: Interpretation = {
      ...prior('concept:b', ['ApexClass:Ns__B']),
      coverageCaveat: 'partial ApexClass coverage.',
    };
    const out = chainInterpret([a, b], [rule]);
    expect(out[0]!.coverageCaveat).toBe('partial ApexClass coverage.');
  });
});

describe('CHAINED_RULES — demo async ∩ soql-injection', () => {
  const rule = demoRule();

  it('ships exactly the demo chain bound to the curated amplification concept', () => {
    expect(CHAINED_RULES).toHaveLength(1);
    expect(rule.requiredConcepts).toEqual([
      'concept:async-boundary',
      'concept:apex-soql-injection-surface',
    ]);
    expect(rule.concept).toBe('concept:async-soql-injection-amplification');
    expect(rule.maxConfidence).toBe('heuristic');
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('code-quality-defect');
    expect(CONCEPTS[rule.concept]!.severity).toBe('high');
  });

  it('emits the amplification claim when both priors fire, citing the union at weakest', () => {
    const out = chainInterpret(
      [
        prior('concept:async-boundary', ['ApexClass:Ns__Job'], 'declared'),
        prior(
          'concept:apex-soql-injection-surface',
          ['ApexClass:Ns__Job'],
          'heuristic',
        ),
      ],
      CHAINED_RULES,
    );
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.ruleId).toBe('chain:async-boundary+soql-injection');
    expect(only.concept).toBe('concept:async-soql-injection-amplification');
    expect(only.groundedIn).toEqual(['ApexClass:Ns__Job']);
    expect(only.confidence).toBe(weakest('heuristic', 'declared', 'heuristic'));
    expect(only.confidence).toBe('heuristic');
    expect(only.claim).toContain('ApexClass:Ns__Job');
    expect(only.claim).toMatch(/SOQL-injection/i);
    expect(only.claim).toMatch(/async/i);
  });

  it('does NOT fire when only one of the two priors is present', () => {
    expect(
      chainInterpret(
        [prior('concept:async-boundary', ['ApexClass:Ns__Job'], 'declared')],
        CHAINED_RULES,
      ),
    ).toEqual([]);
    expect(
      chainInterpret(
        [
          prior(
            'concept:apex-soql-injection-surface',
            ['ApexClass:Ns__Job'],
            'heuristic',
          ),
        ],
        CHAINED_RULES,
      ),
    ).toEqual([]);
  });

  it('seed: first-pass CONCEPT_RULES → chainInterpret on a queueable+injection class', () => {
    const JOB = 'ApexClass:Ns__InjectingQueueable';
    const slice: GroundedSlice = {
      nodes: [
        {
          id: JOB,
          type: 'ApexClass',
          apiName: 'Ns__InjectingQueueable',
          label: null,
          parentId: null,
          sourcePath: 'synthetic/Ns__InjectingQueueable',
          lastModifiedDate: null,
          lastModifiedBy: null,
          apiVersion: null,
          properties: {
            isQueueable: true,
            isTest: false,
            qualityIssues: [
              {
                rule: 'soql-injection',
                severity: 'critical',
                location: 'line 12',
                confidence: 'heuristic',
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const coverage: Coverage = { status: 'complete', caveat: null };
    const firstPass: Interpretation[] = [];
    for (const conceptRule of CONCEPT_RULES) {
      firstPass.push(...interpret(conceptRule, slice, coverage, JOB));
    }
    const conceptsFired = new Set(firstPass.map((i) => i.concept));
    expect(conceptsFired.has('concept:async-boundary')).toBe(true);
    expect(conceptsFired.has('concept:apex-soql-injection-surface')).toBe(true);

    const chained = chainInterpret(firstPass, CHAINED_RULES);
    expect(chained).toHaveLength(1);
    expect(chained[0]!.concept).toBe('concept:async-soql-injection-amplification');
    expect(chained[0]!.groundedIn).toContain(JOB);
    expect(chained[0]!.confidence).toBe('heuristic');
  });
});
