/// <reference types="vitest/globals" />

/**
 * EPIC-2 — cross-concept, same-anchor composition proofs.
 *
 * Synthetic priors + one seed slice (no vault). Proves:
 *   1. required concepts co-firing on ONE shared anchor ⇒ one compound;
 *   2. groundedIn is the UNION of the participating priors' citations;
 *   3. confidence = weakest(rule.maxConfidence, …participating);
 *   4. concepts present but on DIFFERENT anchors ⇒ [] (the same-anchor gate);
 *   5. fires ONCE PER shared anchor;
 *   6. fail-closed corners (missing concept, empty requiredConcepts, unknown,
 *      already-fired, coverage caveats, sameAnchor:false global union);
 *   7. the shipped demo compound (net-access-intersection) is wired and fires
 *      from the first-pass CONCEPT_RULES on a Private object with ≥2 sharing rules.
 */

import type {
  CompoundRule,
  ConfidenceLevel,
  Edge,
  Interpretation,
  Node,
} from '@sf-intelligence/contracts';

import { COMPOUND_RULES } from '../../src/knowledge/compound-rules.js';
import { CONCEPTS, CONCEPT_RULES, MODEL_VERSION } from '../../src/knowledge/loader.js';
import {
  compoundInterpret,
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

const rule = (over: Partial<CompoundRule> = {}): CompoundRule => ({
  id: 'compound:test/a+b',
  concept: 'concept:test-compound',
  requiredConcepts: ['concept:a', 'concept:b'],
  sameAnchor: true,
  interpretation: 'net over {anchor}: {ids}',
  maxConfidence: 'declared',
  absenceShaped: false,
  dependsOnCoverage: ['CustomObject'],
  ...over,
});

const OBJ = 'CustomObject:Ns__Acme__c';
const OBJ2 = 'CustomObject:Ns__Beta__c';
const RULE_A = 'SharingRule:Ns__Acme__c.WidenSales';
const RULE_B = 'SharingRule:Ns__Acme__c.WidenSupport';

describe('compoundInterpret — EPIC-2 same-anchor composition', () => {
  it('fires when required concepts co-fire on ONE shared anchor', () => {
    const out = compoundInterpret(
      [
        prior('concept:a', [OBJ], 'declared'),
        prior('concept:b', [RULE_A, RULE_B, OBJ], 'declared'),
      ],
      [rule()],
    );
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.ruleId).toBe('compound:test/a+b');
    expect(only.concept).toBe('concept:test-compound');
    // Union of the participating priors' citations (anchor first, then the widen ids).
    expect(only.groundedIn).toEqual([OBJ, RULE_A, RULE_B]);
    // {anchor} is filled with the shared anchor id; {ids} with the union.
    expect(only.claim).toContain(`net over ${OBJ}`);
    expect(only.claim).toContain(RULE_A);
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('confidence = weakest(rule.maxConfidence, …participating priors)', () => {
    const out = compoundInterpret(
      [
        prior('concept:a', [OBJ], 'declared'),
        prior('concept:b', [RULE_A, OBJ], 'parsed'),
      ],
      [rule()],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(weakest('declared', 'declared', 'parsed'));
    expect(out[0]!.confidence).toBe('parsed');
  });

  it('does NOT fire when the concepts co-fire on DIFFERENT anchors (no shared id)', () => {
    const out = compoundInterpret(
      [
        prior('concept:a', [OBJ], 'declared'),
        // concept:b is present, but cites a DIFFERENT object — no shared anchor.
        prior('concept:b', [RULE_A, RULE_B, OBJ2], 'declared'),
      ],
      [rule()],
    );
    expect(out).toEqual([]);
  });

  it('participating union EXCLUDES a same-concept prior on a different anchor', () => {
    const out = compoundInterpret(
      [
        prior('concept:a', [OBJ], 'declared'),
        prior('concept:b', [RULE_A, OBJ], 'declared', 'rule:b/on-acme'),
        // A second concept:b prior on a DIFFERENT object must not leak into the
        // OBJ compound's citation union.
        prior('concept:b', [OBJ2], 'declared', 'rule:b/on-beta'),
      ],
      [rule()],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([OBJ, RULE_A]);
    expect(out[0]!.groundedIn).not.toContain(OBJ2);
  });

  it('fires ONCE PER shared anchor (two objects each co-fire → two compounds)', () => {
    const out = compoundInterpret(
      [
        prior('concept:a', [OBJ], 'declared'),
        prior('concept:b', [RULE_A, OBJ], 'declared'),
        prior('concept:a', [OBJ2], 'declared'),
        prior('concept:b', [OBJ2], 'declared'),
      ],
      [rule()],
    );
    expect(out).toHaveLength(2);
    // Anchors are emitted sorted for determinism.
    expect(out.map((i) => i.claim.includes(OBJ))).toContain(true);
    expect(out.map((i) => i.claim.includes(OBJ2))).toContain(true);
    const beta = out.find((i) => i.claim.includes(`net over ${OBJ2}`))!;
    expect(beta.groundedIn).toEqual([OBJ2]);
  });

  it('does NOT fire when any required concept is missing', () => {
    expect(compoundInterpret([prior('concept:a', [OBJ])], [rule()])).toEqual([]);
    expect(compoundInterpret([], [rule()])).toEqual([]);
  });

  it('fails closed on empty requiredConcepts', () => {
    const out = compoundInterpret(
      [prior('concept:a', [OBJ]), prior('concept:b', [OBJ])],
      [rule({ requiredConcepts: [] })],
    );
    expect(out).toEqual([]);
  });

  it('caps confidence to unknown when any participating prior is unknown', () => {
    const out = compoundInterpret(
      [
        prior('concept:a', [OBJ], 'declared'),
        prior('concept:b', [RULE_A, OBJ], 'unknown'),
      ],
      [rule()],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe('unknown');
  });

  it('skips a compound whose concept already fired among the priors', () => {
    const out = compoundInterpret(
      [
        prior('concept:a', [OBJ]),
        prior('concept:b', [OBJ]),
        prior('concept:test-compound', [OBJ]),
      ],
      [rule()],
    );
    expect(out).toEqual([]);
  });

  it('joins non-null coverage caveats from the participating priors', () => {
    const a = prior('concept:a', [OBJ]);
    const b: Interpretation = {
      ...prior('concept:b', [RULE_A, OBJ]),
      coverageCaveat: 'partial SharingRule coverage.',
    };
    const out = compoundInterpret([a, b], [rule()]);
    expect(out[0]!.coverageCaveat).toBe('partial SharingRule coverage.');
  });

  it('sameAnchor:false degrades to a chain-style global union (one claim, no anchor gate)', () => {
    const out = compoundInterpret(
      [
        prior('concept:a', [OBJ], 'declared'),
        // Different anchor — but sameAnchor:false unions globally.
        prior('concept:b', [OBJ2], 'parsed'),
      ],
      [rule({ sameAnchor: false })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([OBJ, OBJ2]);
    expect(out[0]!.confidence).toBe('parsed');
    // {anchor} is empty in global-union mode (no single shared anchor).
    expect(out[0]!.claim).toContain('net over :');
  });
});

describe('COMPOUND_RULES — demo net-access-intersection', () => {
  const demo = COMPOUND_RULES.find((r) => r.id === 'compound:net-access-intersection');

  it('ships exactly the net-access-intersection compound bound to the curated concept', () => {
    expect(COMPOUND_RULES).toHaveLength(1);
    expect(demo).toBeDefined();
    expect(demo!.sameAnchor).toBe(true);
    expect(demo!.requiredConcepts).toEqual([
      'concept:owd-sharing-posture',
      'concept:object-widened-by-sharing-rule-count',
    ]);
    expect(demo!.concept).toBe('concept:net-access-intersection');
    expect(demo!.maxConfidence).toBe('declared');
    expect(CONCEPTS[demo!.concept]).toBeDefined();
    expect(CONCEPTS[demo!.concept]!.kind).toBe('access-mechanism');
    expect(CONCEPTS[demo!.concept]!.severity).toBe('medium');
  });

  it('emits the reconciled posture when both priors co-fire on one object anchor', () => {
    const out = compoundInterpret(
      [
        prior('concept:owd-sharing-posture', [OBJ], 'declared'),
        prior(
          'concept:object-widened-by-sharing-rule-count',
          [RULE_A, RULE_B, OBJ],
          'declared',
        ),
      ],
      COMPOUND_RULES,
    );
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:net-access-intersection');
    expect(only.groundedIn).toEqual([OBJ, RULE_A, RULE_B]);
    expect(only.confidence).toBe('declared');
    expect(only.claim).toContain(OBJ);
    expect(only.claim).toMatch(/net effective access|widen|reconcil/i);
  });

  it('does NOT fire when only the OWD baseline (no widening) is present', () => {
    expect(
      compoundInterpret(
        [prior('concept:owd-sharing-posture', [OBJ], 'declared')],
        COMPOUND_RULES,
      ),
    ).toEqual([]);
  });

  it('seed: first-pass CONCEPT_RULES → compoundInterpret on a Private object with ≥2 sharing rules', () => {
    const node = (id: string, type: Node['type'], properties: Record<string, unknown>): Node => ({
      id,
      type,
      apiName: id.split(':')[1] ?? id,
      label: null,
      parentId: null,
      sourcePath: `synthetic/${id}`,
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties,
    });
    const edge = (fromId: string, toId: string): Edge => ({
      fromId,
      toId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'synthetic-test',
      properties: {},
    });

    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject', { sharingModel: 'Private' }),
        node(RULE_A, 'SharingRule', { ruleType: 'owner' }),
        node(RULE_B, 'SharingRule', { ruleType: 'owner' }),
      ],
      edges: [edge(OBJ, RULE_A), edge(OBJ, RULE_B)],
    };
    const coverage: Coverage = { status: 'complete', caveat: null };

    const firstPass: Interpretation[] = [];
    for (const conceptRule of CONCEPT_RULES) {
      firstPass.push(...interpret(conceptRule, slice, coverage, OBJ));
    }
    const conceptsFired = new Set(firstPass.map((i) => i.concept));
    expect(conceptsFired.has('concept:owd-sharing-posture')).toBe(true);
    expect(conceptsFired.has('concept:object-widened-by-sharing-rule-count')).toBe(true);

    const compound = compoundInterpret(firstPass, COMPOUND_RULES);
    expect(compound).toHaveLength(1);
    expect(compound[0]!.concept).toBe('concept:net-access-intersection');
    expect(compound[0]!.groundedIn).toContain(OBJ);
    expect(compound[0]!.groundedIn).toContain(RULE_A);
    expect(compound[0]!.groundedIn).toContain(RULE_B);
    expect(compound[0]!.confidence).toBe('declared');
  });
});
