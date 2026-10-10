/// <reference types="vitest/globals" />

/**
 * PERF-7 — `sfi.interpret` on a hub object (15-25 claims of 1.5-3.6 KB each,
 * every claim serialized three times) built a 160-210 KB payload and then
 * returned only `oversize`. The concept-reasoning block in every composed tool
 * points the host at `sfi.interpret` for the full claims, so the host got no
 * claims from either surface.
 *
 * Hermetic: `reasonAboutComponent` is replaced with a synthetic hub result so
 * the test pins the paging / budget CONTRACT, not the concept model's content.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, Interpretation, Node } from '@sf-intelligence/contracts';
import { ok } from '@sf-intelligence/core';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';
import type { ExtendedVaultManifest } from '@sf-intelligence/vault';

import * as knowledgeIndex from '../../src/knowledge/index.js';
import type { ReasonAboutComponentResult } from '../../src/knowledge/index.js';
import type { Context } from '../../src/server.js';
import { interpretHandler } from '../../src/tools/interpret.js';
import { toolLocalPayloadBudgetBytes } from '../../src/tools/response-budget.js';

const HUB = 'CustomObject:Invoice__c' as ComponentId;

const MANIFEST = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-interpret-paging',
} as unknown as ExtendedVaultManifest;

/** A realistic hub claim: ~2.5 KB of prose naming grant holders, 60 ids. */
const hubClaim = (n: number): Interpretation => ({
  ruleId: `rule:test-only/hub-${String(n).padStart(2, '0')}`,
  concept: `test-only-hub-${String(n)}`,
  claim: `Synthetic hub claim ${String(n)}: ` + 'PermissionSet:Example_Grant_Holder, '.repeat(70),
  groundedIn: Array.from(
    { length: 60 },
    (_u, i) => `PermissionSet:Example_Permission_Set_Number_${String(i)}` as ComponentId,
  ),
  confidence: 'declared',
  coverageCaveat: null,
  modelVersion: 'test',
  provenance: 'offline_snapshot',
});

const hubResult = (count: number): ReasonAboutComponentResult => {
  const interpretations = Array.from({ length: count }, (_u, i) => hubClaim(i));
  return {
    componentId: HUB,
    componentType: 'CustomObject',
    rootNode: { id: HUB, type: 'CustomObject', apiName: 'Invoice__c', properties: {} } as unknown as Node,
    interpretations,
    selectedRules: [],
    rulesFired: count,
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
    aggCoverage: { status: 'complete', caveat: null },
    junctionEndpointUnresolved: false,
    junctionMissNote: null,
    completenessStatus: 'complete',
    topCoverageCaveat: null,
    coverageReport: {
      rulesConsidered: count,
      rulesFired: count,
      rulesCheckedClean: 0,
      rulesNotApplicable: 0,
      rulesNotEvaluable: 0,
      conceptsFired: interpretations.map((i) => i.concept),
      conceptsCheckedClean: [],
      conceptsNotApplicable: [],
      conceptsNotEvaluable: [],
      noRuleCoversComponentType: false,
      sliceTruncated: false,
      summary: 'test-only synthetic summary.',
    },
  } as unknown as ReasonAboutComponentResult;
};

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('sfi.interpret — pages claims and fits the budget itself (PERF-7)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-interpret-paging-'));
    const opened = await openGraph(join(dir, 'paging.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store } as unknown as Context;
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: a 20-claim hub answers within budget with a next page, never oversize', async () => {
    const spy = vi
      .spyOn(knowledgeIndex, 'reasonAboutComponent')
      .mockResolvedValue(ok(hubResult(20)));
    try {
      const r = await interpretHandler(ctx, { componentId: HUB });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      // Before: every claim three times, uncapped — ~200 KB, then `oversize`.
      expect(bytes(d)).toBeLessThanOrEqual(toolLocalPayloadBudgetBytes());
      expect(d.page.total).toBe(20);
      expect(d.page.returned).toBeGreaterThanOrEqual(1);
      expect(d.interpretations).toHaveLength(d.page.returned);
      expect(d.page.nextOffset).toBe(d.page.returned);
      expect(d.interpretations[0]!.groundedInTotal).toBe(60);
      expect(d.interpretations[0]!.groundedIn.length).toBeLessThan(60);
      expect(d.evidenceEnvelope.claims).toHaveLength(d.page.returned);
      expect(d.disclosure).toContain(`offset: ${String(d.page.nextOffset)}`);
      // Counts describe the WHOLE result, not the page.
      expect(d.rulesFired).toBe(20);
    } finally {
      spy.mockRestore();
    }
  });

  it('offset walks to the next page and the last page has no nextOffset', async () => {
    const spy = vi
      .spyOn(knowledgeIndex, 'reasonAboutComponent')
      .mockResolvedValue(ok(hubResult(3)));
    try {
      const first = await interpretHandler(ctx, { componentId: HUB, limit: 2, groundedInLimit: 3 });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.data.page).toMatchObject({ offset: 0, returned: 2, total: 3, nextOffset: 2 });
      const second = await interpretHandler(ctx, { componentId: HUB, limit: 2, offset: 2, groundedInLimit: 3 });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.data.page).toMatchObject({ offset: 2, returned: 1, total: 3, nextOffset: null });
      expect(second.value.data.interpretations[0]!.ruleId).toBe('rule:test-only/hub-02');
      // A partial page says so in `rendered`, which a host may relay alone.
      expect(first.value.data.rendered).toContain('Showing claims 1-2 of 3');
    } finally {
      spy.mockRestore();
    }
  });

  // FAIL-BEFORE/PASS-AFTER: an offset past the end rendered "No concept rule
  // fired" and the envelope's absence note said the same — false, 3 fired.
  it('an offset past the last claim never reads as "no rule fired"', async () => {
    const spy = vi
      .spyOn(knowledgeIndex, 'reasonAboutComponent')
      .mockResolvedValue(ok(hubResult(3)));
    try {
      const r = await interpretHandler(ctx, { componentId: HUB, limit: 2, offset: 40, groundedInLimit: 3 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      expect(d.page).toMatchObject({ returned: 0, total: 3 });
      expect(d.rendered).not.toContain('No concept rule fired');
      expect(d.rendered).toContain('past the last of 3');
      expect(d.evidenceEnvelope.absence?.note).not.toContain('No concept rule fired');
      expect(d.evidenceEnvelope.absence?.note).toContain('3 fired');
      expect(d.disclosure).toContain('past the last of 3');
    } finally {
      spy.mockRestore();
    }
  });
});
