/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER (eval A01): `what_happens_on_save` attached every
 * claim the concept engine fired on the object — three sharing / CRUD claims
 * on a save-order answer. A composing tool now passes a `relevance` scope:
 * off-topic claims leave `claims`, are counted in `offTopicClaimsOmitted`, and
 * the disclosure keeps the uncapped `sfi.interpret` pointer.
 */

import type { ComponentId, Interpretation, Node, VaultManifest } from '@sf-intelligence/contracts';
import type { GraphStore } from '@sf-intelligence/graph';

import type { ReasonAboutComponentResult, ReasonContext } from '../../src/knowledge/index.js';
import { NONE_FIRED_NOTE, projectConceptReasoning } from '../../src/tools/concept-reasoning.js';
import { saveOrderConceptRelevance } from '../../src/tools/what-happens-on-save.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-relevance',
};
const OBJ = 'CustomObject:Ledger_Entry__c' as ComponentId;
const ctx = { vaultRoot: '/nonexistent', manifest: MANIFEST, graph: {} as GraphStore } as ReasonContext;

const claim = (concept: string, n: number): Interpretation => ({
  ruleId: `test-rule-${String(n)}`,
  concept,
  claim: `Synthetic claim ${String(n)} about ${concept}.`,
  groundedIn: [OBJ],
  confidence: 'declared',
  coverageCaveat: null,
  modelVersion: 'test',
  provenance: 'offline_snapshot',
});

const reasoned = (interpretations: readonly Interpretation[]): ReasonAboutComponentResult =>
  ({
    componentId: OBJ,
    componentType: 'CustomObject',
    rootNode: { id: OBJ, type: 'CustomObject', apiName: 'Ledger_Entry__c', label: null, parentId: null, sourcePath: 'x', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: {} } as Node,
    interpretations: [...interpretations],
    selectedRules: [],
    rulesFired: interpretations.length,
    sliceTruncated: false,
    truncatedExpansions: [],
    slice: { nodes: [], edges: [] },
    unionCoverageTypes: [],
    aggSummary: { coverageKnown: true, status: 'complete', coveredTypes: [], partialTypes: [], notModeledTypes: [], missingCoverage: [] },
    aggCoverage: { status: 'complete', caveat: null },
    junctionEndpointUnresolved: false,
    junctionMissNote: null,
    completenessStatus: 'complete',
    topCoverageCaveat: null,
    coverageReport: {
      rulesConsidered: interpretations.length,
      rulesFired: interpretations.length,
      rulesCheckedClean: 0,
      rulesNotApplicable: 0,
      rulesNotEvaluable: 0,
      conceptsFired: interpretations.map((i) => i.concept),
      conceptsCheckedClean: [],
      conceptsNotApplicable: [],
      conceptsNotEvaluable: [],
      noRuleCoversComponentType: false,
      sliceTruncated: false,
      summary: 'synthetic summary.',
    },
  }) as unknown as ReasonAboutComponentResult;

const MIXED = [
  claim('concept:owd-sharing-posture', 1),
  claim('concept:object-crud-grant-layer', 2),
  claim('concept:automation-collision', 3),
];

describe('concept reasoning — relevance scope', () => {
  it('keeps only on-topic claims and counts the rest by kind', () => {
    const env = projectConceptReasoning(ctx, reasoned(MIXED), { relevance: saveOrderConceptRelevance('update') });
    expect(env.claims.map((c) => c.concept)).toEqual(['concept:automation-collision']);
    expect(env.offTopicClaimsOmitted).toEqual({ count: 2, byKind: { 'access-mechanism': 2 } });
    expect(env.disclosure).toContain('not about save order');
    expect(env.disclosure).toContain("sfi.interpret', args: { componentId: 'CustomObject:Ledger_Entry__c'");
    // Counts describe the whole run, not the filtered view.
    expect(env.completeness.rulesFired).toBe(3);
  });

  it('when nothing on-topic fired it never says "no rule fired"', () => {
    const env = projectConceptReasoning(ctx, reasoned(MIXED.slice(0, 2)), {
      compact: true,
      relevance: saveOrderConceptRelevance('insert'),
    });
    expect(env.claims).toEqual([]);
    expect(env.disclosure).not.toContain(NONE_FIRED_NOTE.trim());
    expect(env.disclosure).toContain('2 fired claim(s) about other topics');
  });

  it('a delete keeps relationship claims (cascade) that an update drops', () => {
    const rows = [claim('concept:relationship', 1)];
    expect(projectConceptReasoning(ctx, reasoned(rows), { relevance: saveOrderConceptRelevance('delete') }).claims).toHaveLength(1);
    expect(projectConceptReasoning(ctx, reasoned(rows), { relevance: saveOrderConceptRelevance('update') }).claims).toHaveLength(0);
  });

  it('without a relevance scope every claim is kept (other composing tools unchanged)', () => {
    const env = projectConceptReasoning(ctx, reasoned(MIXED));
    expect(env.claims).toHaveLength(3);
    expect(env.offTopicClaimsOmitted).toBeUndefined();
  });

  it('keeps a claim whose concept the model cannot classify', () => {
    const env = projectConceptReasoning(ctx, reasoned([claim('test-only-unknown-concept', 9)]), {
      relevance: saveOrderConceptRelevance('update'),
    });
    expect(env.claims).toHaveLength(1);
  });
});
