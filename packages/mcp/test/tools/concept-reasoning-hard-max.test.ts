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
  cachedReasoningCount,
  CONCEPT_BLOCK_HARD_MAX_BYTES,
  CONCEPT_GROUNDED_SAMPLE_CAP,
  COMPACT_CLAIM_TEXT_CAP,
  markGraphImmutableForReasoning,
  projectConceptReasoning,
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

const buildSyntheticReasonResult = (
  interpretations: readonly Interpretation[] = [buildOversizedInterpretation()],
): ReasonAboutComponentResult => {
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
    interpretations: [...interpretations],
    selectedRules: [],
    rulesFired: interpretations.length,
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
      rulesConsidered: Math.max(1, interpretations.length),
      rulesFired: interpretations.length,
      rulesCheckedClean: interpretations.length === 0 ? 1 : 0,
      rulesNotApplicable: 0,
      rulesNotEvaluable: 0,
      conceptsFired: interpretations.map((i) => i.concept),
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
      // PERF-3: the claim is KEPT with a sampled citation list (the true count
      // in `groundedInTotal`) instead of being dropped to fit.
      expect(reserved.envelope.claims).toHaveLength(1);
      expect(reserved.envelope.claims[0]!.groundedIn.length).toBeLessThanOrEqual(
        CONCEPT_GROUNDED_SAMPLE_CAP,
      );
      expect(reserved.envelope.claims[0]!.groundedInTotal).toBe(400);
      expect(reserved.envelope.disclosure).toContain('groundedInTotal');
      expect(reserved.reservationCapped).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

/** A realistic hub claim: ~2 KB of prose enumerating grant holders, 30 ids. */
const longClaim = (n: number): Interpretation => ({
  ruleId: `test-only-long-rule-${String(n).padStart(2, '0')}`,
  concept: `test-only-long-concept-${String(n)}`,
  claim: `Synthetic claim ${String(n)} naming many grant holders: ` + 'Profile:Example_Profile, '.repeat(80),
  groundedIn: Array.from(
    { length: 30 },
    (_u, i) => `PermissionSet:Example_Permission_Set_${String(i)}` as ComponentId,
  ),
  confidence: 'declared',
  coverageCaveat: null,
  modelVersion: 'test',
  provenance: 'offline_snapshot',
});

describe('buildReservedConceptReasoning — claims first, prose last (PERF-3 / ADM-6)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: ReasonContext;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-concept-claimsfirst-'));
    const opened = await openGraph(join(dir, 'claimsfirst.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: a hub with 15 long claims keeps several of them, not 0', async () => {
    // Before: claims were halved 15 -> 7 -> 3 -> 1 -> 0 around ~4 KB of fixed
    // prose, so the block showed "0 of 15 claims" (measured on standard objects).
    const claims = Array.from({ length: 15 }, (_u, i) => longClaim(i));
    const spy = vi
      .spyOn(knowledgeIndex, 'reasonAboutComponent')
      .mockResolvedValue(ok(buildSyntheticReasonResult(claims)));
    try {
      const reserved = await buildReservedConceptReasoning(ctx, HUGE_OBJECT);
      expect(reserved).not.toBeNull();
      if (reserved === null) return;
      expect(reserved.reservedBytes).toBeLessThanOrEqual(CONCEPT_BLOCK_HARD_MAX_BYTES);
      expect(reserved.envelope.claims.length).toBeGreaterThanOrEqual(3);
      expect(reserved.envelope.claimsTruncated?.total).toBe(15);
      for (const c of reserved.envelope.claims) {
        expect(c.claim.length).toBeLessThanOrEqual(COMPACT_CLAIM_TEXT_CAP);
      }
      expect(reserved.envelope.disclosure).toContain('to fit the response budget');
      expect(reserved.envelope.disclosure).toContain("name: 'sfi.interpret'");
    } finally {
      spy.mockRestore();
    }
  });

  it('FAIL-BEFORE/PASS-AFTER: a component where nothing fired gets a compact block', async () => {
    // Realistic shape: a partial-coverage vault with 20 missing families and
    // 30 rules that could not be evaluated (measured block before: ~4.3 KB).
    const base = buildSyntheticReasonResult([]);
    const missing = Array.from({ length: 20 }, (_u, i) => `ExampleFamily${String(i)}`);
    const gappy: ReasonAboutComponentResult = {
      ...base,
      aggSummary: { ...base.aggSummary, status: 'partial', missingCoverage: missing },
      aggCoverage: { status: 'partial', caveat: `Coverage is partial: ${missing.join(', ')} not retrieved.` },
      completenessStatus: 'partial',
      coverageReport: {
        ...base.coverageReport,
        rulesConsidered: 31,
        rulesNotEvaluable: 30,
        conceptsNotEvaluable: Array.from({ length: 30 }, (_u, i) => ({
          ruleId: `rule:test-only/unevaluable-${String(i)}`,
          concept: `test-only-unevaluable-${String(i)}`,
          missingCoverage: [missing[i % 20]!],
          reason: 'vault-coverage-missing' as const,
        })),
        summary: 'test-only synthetic coverage summary. '.repeat(10),
      },
    };
    const spy = vi
      .spyOn(knowledgeIndex, 'reasonAboutComponent')
      .mockResolvedValue(ok(gappy));
    try {
      const reserved = await buildReservedConceptReasoning(ctx, HUGE_OBJECT);
      expect(reserved).not.toBeNull();
      if (reserved === null) return;
      // Before: the full prose block was returned around zero claims.
      const full = projectConceptReasoning(ctx, gappy);
      const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
      expect(reserved.reservedBytes).toBeLessThan(fullBytes * 0.6);
      expect(reserved.envelope.claims).toHaveLength(0);
      // The honesty axis survives: none-fired warning, counts, absence.
      expect(reserved.envelope.disclosure).toContain('No concept rule fired');
      expect(reserved.envelope.disclosure).toContain('sfi.interpret');
      expect(reserved.envelope.completeness.rulesConsidered).toBe(31);
      expect(reserved.envelope.completeness.rulesNotEvaluableByReason['vault-coverage-missing']).toBe(30);
      expect(reserved.envelope.coverage.missingCoverage).toEqual(missing);
      expect(reserved.envelope.absence).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('FAIL-BEFORE/PASS-AFTER: reasoning over the server read-only graph runs once per component', async () => {
    const spy = vi
      .spyOn(knowledgeIndex, 'reasonAboutComponent')
      .mockResolvedValue(ok(buildSyntheticReasonResult([longClaim(1)])));
    try {
      // An unregistered graph (a caller that may mutate it) is never cached.
      await buildReservedConceptReasoning(ctx, HUGE_OBJECT);
      await buildReservedConceptReasoning(ctx, HUGE_OBJECT);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(cachedReasoningCount(store)).toBe(0);

      markGraphImmutableForReasoning(store);
      spy.mockClear();
      const first = await buildReservedConceptReasoning(ctx, HUGE_OBJECT);
      const second = await buildReservedConceptReasoning(ctx, HUGE_OBJECT);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(cachedReasoningCount(store)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
