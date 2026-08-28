/// <reference types="vitest/globals" />

/**
 * CONCEPT-BLOCK-HARD-MAX-NOT-HARD — a fitted concept-reasoning block must
 * never exceed `CONCEPT_BLOCK_HARD_MAX_BYTES`, even when a SINGLE claim
 * (measured 7,819 B on a real object) is already larger than the ceiling on
 * its own.
 *
 * `buildReservedConceptReasoning`'s claim-halving loop used to stop at
 * `claimCap > 1`, so a one-claim envelope that was still oversized fell
 * straight through untouched and was returned as-is — the "hard" max was not
 * hard. This is a HERMETIC, single-purpose regression test: rather than
 * trying to coax the 195-rule concept model into naturally emitting one
 * aggregated claim over hundreds of grounded ids (the real-world shape that
 * produced the 7,819 B measurement — a chained rule unioning many prior
 * matches' `groundedIn`), it spies on `reasonAboutComponent` — the ONE
 * traversal `buildReservedConceptReasoning` calls — and substitutes a
 * synthetic result carrying one deliberately oversized claim. That isolates
 * the byte-ceiling CONTRACT under test from the concept model's content,
 * which is free to change without this test needing to track it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, Interpretation, Node, VaultManifest } from '@sf-intelligence/contracts';
import { ok } from '@sf-intelligence/core';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import * as knowledgeIndex from '../../src/knowledge/index.js';
import type {
  Coverage,
  ReasonAboutComponentResult,
  ReasonContext,
} from '../../src/knowledge/index.js';
import {
  buildReservedConceptReasoning,
  CONCEPT_BLOCK_HARD_MAX_BYTES,
} from '../../src/tools/concept-reasoning.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-hard-max',
};

const HUGE_OBJECT = 'CustomObject:HardMaxObject__c' as ComponentId;

/**
 * One synthetic claim whose serialized size alone exceeds
 * `CONCEPT_BLOCK_HARD_MAX_BYTES` (6,000 B) — reproducing the measured
 * "a hub's chained claim unions hundreds of grounded ids" shape without
 * depending on which real concept rule happens to produce it.
 */
const buildOversizedInterpretation = (): Interpretation => {
  const groundedIn: ComponentId[] = Array.from(
    { length: 400 },
    (_unused, i) =>
      `CustomField:HardMaxObject__c.Padding_Field_${String(i).padStart(4, '0')}_to_inflate_bytes__c` as ComponentId,
  );
  return {
    ruleId: 'test-only-oversized-chain-rule',
    concept: 'test-only-oversized-concept',
    claim:
      'Synthetic claim engineered to exceed the 6,000-byte hard max on its own, ' +
      'reproducing the measured 7,819-byte-against-6,000-byte-stop defect deterministically.',
    groundedIn,
    confidence: 'declared',
    coverageCaveat: null,
    modelVersion: 'test',
    provenance: 'offline_snapshot',
  };
};

const buildSyntheticReasonResult = (): ReasonAboutComponentResult => {
  const coverage: Coverage = { status: 'complete', caveat: null };
  return {
    componentId: HUGE_OBJECT,
    componentType: 'CustomObject',
    rootNode: {
      id: HUGE_OBJECT,
      type: 'CustomObject',
      apiName: 'HardMaxObject__c',
      label: null,
      parentId: null,
      sourcePath: 'test-only',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    } as Node,
    interpretations: [buildOversizedInterpretation()],
    selectedRules: [],
    rulesFired: 1,
    sliceTruncated: false,
    truncatedExpansions: [],
    slice: { nodes: [], edges: [] },
    unionCoverageTypes: [],
    aggSummary: {
      coverageKnown: true,
      status: 'complete',
      coveredTypes: [],
      partialTypes: [],
      notModeledTypes: [],
      missingCoverage: [],
    },
    aggCoverage: coverage,
    junctionEndpointUnresolved: false,
    junctionMissNote: null,
    completenessStatus: 'complete',
    topCoverageCaveat: null,
    coverageReport: {
      rulesConsidered: 1,
      rulesFired: 1,
      rulesCheckedClean: 0,
      rulesNotApplicable: 0,
      rulesNotEvaluable: 0,
      conceptsFired: ['test-only-oversized-concept'],
      conceptsCheckedClean: [],
      conceptsNotApplicable: [],
      conceptsNotEvaluable: [],
      noRuleCoversComponentType: false,
      sliceTruncated: false,
      summary: 'test-only synthetic coverage summary.',
    },
  };
};

describe('buildReservedConceptReasoning — the hard max actually holds', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: ReasonContext;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-concept-hardmax-'));
    const opened = await openGraph(join(dir, 'hardmax.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('never returns a block larger than CONCEPT_BLOCK_HARD_MAX_BYTES, even for one oversized claim', async () => {
    const spy = vi
      .spyOn(knowledgeIndex, 'reasonAboutComponent')
      .mockResolvedValue(ok(buildSyntheticReasonResult()));
    try {
      const reserved = await buildReservedConceptReasoning(ctx, HUGE_OBJECT);
      expect(reserved).not.toBeNull();
      if (reserved === null) return;
      expect(
        reserved.reservedBytes,
        `hard max breached: ${reserved.reservedBytes} > ${CONCEPT_BLOCK_HARD_MAX_BYTES}`,
      ).toBeLessThanOrEqual(CONCEPT_BLOCK_HARD_MAX_BYTES);
      // Honest, not silent: the claim that would not fit is disclosed as
      // dropped-to-fit-budget (`claimsTruncated`), never silently cut.
      expect(reserved.envelope.claims).toHaveLength(0);
      expect(reserved.envelope.claimsTruncated).toEqual({ returned: 0, total: 1 });
      expect(reserved.envelope.disclosure).toContain('to fit the response budget');
      expect(reserved.reservationCapped).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
