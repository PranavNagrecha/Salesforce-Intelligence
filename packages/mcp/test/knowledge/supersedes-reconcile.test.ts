/// <reference types="vitest/globals" />

/**
 * EPIC-3 — conflict-resolution (supersedes) substrate proofs.
 *
 * Synthetic priors only (no vault). Proves:
 *   1. anchor overlap + stronger co-fire ⇒ demote (supersededBy stamped);
 *   2. no anchor overlap ⇒ weaker untouched;
 *   3. mode:drop removes the weaker interpretation;
 *   4. demote preserves claim / groundedIn / confidence byte-identical;
 *   5. topic / either overlap modes;
 *   6. shipped curated edges (system-context, async-amplified).
 */

import type { ConfidenceLevel, Interpretation, SupersedesRule } from '@sf-intelligence/contracts';

import { MODEL_VERSION } from '../../src/knowledge/loader.js';
import { reconcile } from '../../src/knowledge/reason.js';
import { SUPERSEDES_RULES } from '../../src/knowledge/supersedes-rules.js';

const prior = (
  concept: string,
  groundedIn: string[],
  confidence: ConfidenceLevel | 'unknown' = 'declared',
  ruleId = `rule:prior/${concept}`,
): Interpretation => ({
  ruleId,
  concept,
  claim: `prior claim for ${concept} on ${groundedIn.join(',')}`,
  groundedIn,
  confidence,
  coverageCaveat: null,
  modelVersion: MODEL_VERSION,
  provenance: 'offline_snapshot',
});

const rule = (over: Partial<SupersedesRule> = {}): SupersedesRule => ({
  id: 'supersedes:test/strong>weak',
  strongerConcept: 'concept:strong',
  supersededConcept: 'concept:weak',
  overlap: 'anchor',
  mode: 'demote',
  rationale: 'test edge',
  ...over,
});

describe('reconcile — EPIC-3 supersedes pass', () => {
  it('demotes the weaker interpretation when stronger co-fires on a shared anchor', () => {
    const anchor = 'ApexClass:Ns__Svc';
    const priors = [
      prior('concept:strong', [anchor]),
      prior('concept:weak', [anchor]),
    ];
    const out = reconcile(priors, [rule()]);
    expect(out).toHaveLength(2);
    const weak = out.find((i) => i.concept === 'concept:weak');
    const strong = out.find((i) => i.concept === 'concept:strong');
    expect(strong!.supersededBy).toBeUndefined();
    expect(weak!.supersededBy).toBe('supersedes:test/strong>weak');
  });

  it('leaves the weaker interpretation untouched when anchors do not overlap', () => {
    const priors = [
      prior('concept:strong', ['ApexClass:Ns__A']),
      prior('concept:weak', ['ApexClass:Ns__B']),
    ];
    const out = reconcile(priors, [rule()]);
    expect(out).toHaveLength(2);
    expect(out.every((i) => i.supersededBy === undefined)).toBe(true);
  });

  it('drops the weaker interpretation when mode is drop', () => {
    const anchor = 'ApexClass:Ns__Svc';
    const priors = [
      prior('concept:strong', [anchor]),
      prior('concept:weak', [anchor]),
    ];
    const out = reconcile(priors, [rule({ mode: 'drop' })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:strong');
  });

  it('preserves claim, groundedIn, and confidence byte-identical on demote', () => {
    const anchor = 'ApexClass:Ns__Svc';
    const weak = prior('concept:weak', [anchor], 'heuristic');
    const priors = [prior('concept:strong', [anchor]), weak];
    const out = reconcile(priors, [rule()]);
    const demoted = out.find((i) => i.concept === 'concept:weak')!;
    expect(demoted.claim).toBe(weak.claim);
    expect(demoted.groundedIn).toEqual(weak.groundedIn);
    expect(demoted.confidence).toBe('heuristic');
    expect(demoted.ruleId).toBe(weak.ruleId);
  });

  it('topic overlap supersedes on co-presence when refinesTopic is set (no shared anchor)', () => {
    const priors = [
      prior('concept:strong', ['ApexClass:Ns__A']),
      prior('concept:weak', ['ApexClass:Ns__B']),
    ];
    const out = reconcile(
      priors,
      [rule({ overlap: 'topic', refinesTopic: 'apex-external-access-posture' })],
    );
    expect(out.find((i) => i.concept === 'concept:weak')!.supersededBy).toBe(
      'supersedes:test/strong>weak',
    );
  });

  it('either overlap applies on anchor OR topic', () => {
    const priors = [
      prior('concept:strong', ['ApexClass:Ns__A']),
      prior('concept:weak', ['ApexClass:Ns__B']),
    ];
    const out = reconcile(
      priors,
      [rule({ overlap: 'either', refinesTopic: 'apex-governor-limit-risk' })],
    );
    expect(out.find((i) => i.concept === 'concept:weak')!.supersededBy).toBeDefined();
  });

  it('is a no-op when rules are empty', () => {
    const priors = [prior('concept:a', ['ApexClass:X'])];
    expect(reconcile(priors, [])).toEqual(priors);
  });

  it('does not supersede when the stronger concept is absent', () => {
    const priors = [prior('concept:weak', ['ApexClass:X'])];
    const out = reconcile(priors, [rule()]);
    expect(out[0]!.supersededBy).toBeUndefined();
  });
});

describe('SUPERSEDES_RULES — curated edges', () => {
  it('ships ≥3 curated supersedes edges', () => {
    expect(SUPERSEDES_RULES.length).toBeGreaterThanOrEqual(3);
  });

  it('demotes external-api-surface when system-context-external-surface co-fires on same anchor', () => {
    const anchor = 'ApexClass:AdminBypassApiService';
    const priors = [
      prior('concept:system-context-external-surface', [anchor], 'declared', 'rule:compound/sysctx'),
      prior('concept:external-api-surface', [anchor], 'declared', 'rule:external-api-surface/aura'),
      prior('concept:apex-sharing-mode', [anchor], 'declared', 'rule:apex-sharing/without'),
    ];
    const out = reconcile(priors, SUPERSEDES_RULES);
    const compound = out.find((i) => i.concept === 'concept:system-context-external-surface');
    const ext = out.find((i) => i.concept === 'concept:external-api-surface');
    const sharing = out.find((i) => i.concept === 'concept:apex-sharing-mode');
    expect(compound!.supersededBy).toBeUndefined();
    expect(ext!.supersededBy).toBe('supersedes:system-context-external-surface>external-api-surface');
    expect(sharing!.supersededBy).toBe('supersedes:system-context-external-surface>apex-sharing-mode');
  });

  it('demotes apex-bulkification-gap when apex-async-amplified-governor-risk co-fires on same anchor', () => {
    const anchor = 'ApexClass:BatchWorker';
    const priors = [
      prior(
        'concept:apex-async-amplified-governor-risk',
        [anchor],
        'heuristic',
        'rule:async/amplified',
      ),
      prior('concept:apex-bulkification-gap', [anchor], 'heuristic', 'rule:apex/bulk-gap'),
    ];
    const out = reconcile(priors, SUPERSEDES_RULES);
    expect(
      out.find((i) => i.concept === 'concept:apex-bulkification-gap')!.supersededBy,
    ).toBe('supersedes:apex-async-amplified-governor-risk>apex-bulkification-gap');
    expect(
      out.find((i) => i.concept === 'concept:apex-async-amplified-governor-risk')!.supersededBy,
    ).toBeUndefined();
  });
});
