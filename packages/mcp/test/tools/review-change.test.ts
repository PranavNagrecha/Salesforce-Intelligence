/// <reference types="vitest/globals" />

/**
 * R6-16 — `sfi.review_change`: the deploy-gate review over a change set.
 *
 * Proves the classification table (deleted-with-dependents = blocking,
 * clean-component = safe, modified-with-heuristic-readers = review, …), the
 * grantedBy/parentOf dependent-exclusion (access ≠ usage), the coverage-caveat
 * behaviour (a zero-dependent result for an un-retrieved family reads "not
 * checked" → review), the tests_for_change composition, the most-dangerous-first
 * ordering, and the row-cap byte budget.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  classify,
  reviewChangeHandler,
  reviewChangeInputSchema,
} from '../../src/tools/review-change.js';

// ---------------------------------------------------------------------------
// Coverage rows (mirrors empty-traversal-coverage-caveat.test.ts). A requested,
// retrieved:0, un-confirmed row reads PARTIAL; retrieved:1 reads COMPLETE.
// ---------------------------------------------------------------------------

const coveredRow = (type: string): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 1,
  errored: false,
  neverModeled: false,
});
const partialRow = (type: string): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 0,
  errored: false,
  neverModeled: false,
});

const FAMILIES = ['ApexClass', 'ApexTrigger', 'CustomField', 'Flow', 'CustomObject', 'Profile'];
const COMPLETE_COVERAGE: readonly CoverageEntry[] = FAMILIES.map(coveredRow);
/** CustomField NOT retrieved, the rest covered → a field change with 0 deps = not-checked. */
const FIELD_PARTIAL_COVERAGE: readonly CoverageEntry[] = FAMILIES.map((t) =>
  t === 'CustomField' ? partialRow(t) : coveredRow(t),
);

const manifestWith = (coverage: readonly CoverageEntry[] | undefined): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-29T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 4, CustomField: 3 },
  edges: {},
  sourceTreeHash: 'sha256:fixture-review-change',
  ...(coverage !== undefined
    ? { coverage, coverageComputedAt: '2026-05-29T12:00:00.000Z' }
    : {}),
});

// ---------------------------------------------------------------------------
// Synthetic graph.
//   OrderService      ← CheckoutController (callsApex, declared)  [firm dependent]
//                     ← OrderServiceTest   (callsApex, declared)  [test + dependent]
//   LonelyService     — isolated (no incoming edges)
//   Account.Rating__c ← HeuristicReader    (readsFrom, heuristic) [heuristic-only reader]
//                     ← Account            (parentOf) — EXCLUDED
//   Account.Firm__c   ← FirmFlow           (readsFrom, parsed)    [firm reader]
//                     ← Account            (parentOf) — EXCLUDED
//   Account.Granted__c← Admin              (grantedBy) — EXCLUDED
//                     ← Account            (parentOf) — EXCLUDED
// ---------------------------------------------------------------------------

const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const makeEdge = (
  o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({ confidence: 'declared', source: 'unit-test', properties: {}, ...o });

const SEED: ExtractionResult = {
  nodes: [
    makeNode({ id: 'ApexClass:OrderService', apiName: 'OrderService', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:CheckoutController', apiName: 'CheckoutController', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:OrderServiceTest', apiName: 'OrderServiceTest', properties: { isTest: true } }),
    makeNode({ id: 'ApexClass:LonelyService', apiName: 'LonelyService', properties: { isTest: false } }),
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({ id: 'CustomField:Account.Rating__c', type: 'CustomField', apiName: 'Rating__c', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'CustomField:Account.Firm__c', type: 'CustomField', apiName: 'Firm__c', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'CustomField:Account.Granted__c', type: 'CustomField', apiName: 'Granted__c', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'ApexClass:HeuristicReader', apiName: 'HeuristicReader', properties: { isTest: false } }),
    makeNode({ id: 'Flow:FirmFlow', type: 'Flow', apiName: 'FirmFlow' }),
    makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
  ],
  edges: [
    makeEdge({ fromId: 'ApexClass:CheckoutController', toId: 'ApexClass:OrderService', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:OrderServiceTest', toId: 'ApexClass:OrderService', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:HeuristicReader', toId: 'CustomField:Account.Rating__c', edgeType: 'readsFrom', confidence: 'heuristic', source: 'apex-scanner' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Rating__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'Flow:FirmFlow', toId: 'CustomField:Account.Firm__c', edgeType: 'readsFrom', confidence: 'parsed', source: 'flow-extractor' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Firm__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'Profile:Admin', toId: 'CustomField:Account.Granted__c', edgeType: 'grantedBy' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Granted__c', edgeType: 'parentOf' }),
  ],
};

let dir: string;
let store: GraphStore;
const ctxWith = (coverage: readonly CoverageEntry[] | undefined): Context => ({
  vaultRoot: dir,
  manifest: manifestWith(coverage),
  graph: store,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-review-change-'));
  const opened = await openGraph(join(dir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [SEED]);
  if (!imp.ok) throw new Error(imp.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

describe('reviewChangeHandler — classification', () => {
  it('deleted component WITH dependents = blocking (drives the exit-code gate)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('blocking');
    // CheckoutController + OrderServiceTest are firm dependents; nothing excluded.
    expect(c?.dependentCount).toBe(2);
    expect(r.value.data.overallVerdict).toBe('blocking');
    expect(r.value.data.summary.blocking).toBe(1);
    expect(r.value.data.recommendation).toMatch(/DEPLOY GATE/);
  });

  it('clean modified component (0 deps, family covered) = safe, no coverage caveat', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('safe');
    expect(c?.dependentCount).toBe(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
    expect(r.value.data.overallVerdict).toBe('safe');
  });

  it('modified field with HEURISTIC-only readers = review (not risky)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Rating__c', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('review');
    expect(c?.dependentCount).toBe(1); // parentOf excluded; only the heuristic reader
    expect(c?.weakestDependentConfidence).toBe('heuristic');
  });

  it('modified field with a FIRM (parsed) reader = risky', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Firm__c', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('risky');
    expect(c?.dependentCount).toBe(1);
    expect(c?.weakestDependentConfidence).toBe('parsed');
  });

  it('excludes grantedBy and parentOf from dependents (access ≠ usage)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Granted__c', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    // Only a Profile grantedBy edge + a parentOf edge → both excluded → 0 deps.
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).toBe('safe');
  });

  it('deleted with 0 deps but PARTIAL coverage = review + top-level coverage caveat', async () => {
    const r = await reviewChangeHandler(ctxWith(FIELD_PARTIAL_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Granted__c', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).toBe('review');
    expect(c?.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toEqual(
      expect.arrayContaining(['CustomField']),
    );
  });

  it('added component NOT in the vault = safe (forward refs not analysed)', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'BrandNewService', changeKind: 'added' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('safe');
    expect(c?.inVault).toBe(false);
    expect(c?.reason).toMatch(/not analysed for their own contents|forward references/i);
  });

  it('added component that COLLIDES with an existing id = review', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'added' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('review');
    expect(c?.inVault).toBe(true);
    expect(c?.reason).toMatch(/name collision|already exists/i);
  });

  it('modified but NOT in vault = review + counted in notInVault', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'GhostClass', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('review');
    expect(c?.inVault).toBe(false);
    expect(r.value.data.summary.notInVault).toBe(1);
  });
});

describe('reviewChangeHandler — tests_for_change composition', () => {
  it('maps covering tests to a modified Apex class and unions them', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.testCoverage).toBe('covered');
    expect(c?.selectedTests).toContain('ApexClass:OrderServiceTest');
    expect(r.value.data.selectedTests).toContain('ApexClass:OrderServiceTest');
    expect(r.value.data.summary.testsToRun).toBeGreaterThanOrEqual(1);
  });

  it('marks a non-Apex change as not-applicable for tests', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'CustomField', apiName: 'Account.Firm__c', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.testCoverage).toBe('not-applicable');
  });

  it('counts an uncovered changed Apex class', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.testCoverage).toBe('uncovered');
    expect(r.value.data.summary.uncoveredApex).toBe(1);
  });
});

describe('reviewChangeHandler — ordering and byte budget', () => {
  it('orders most-dangerous first', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [
        { type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }, // safe
        { type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' }, // blocking
        { type: 'CustomField', apiName: 'Account.Firm__c', changeKind: 'modified' }, // risky
        { type: 'CustomField', apiName: 'Account.Rating__c', changeKind: 'modified' }, // review
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const verdicts = r.value.data.reviewed.map((c) => c.verdict);
    expect(verdicts).toEqual(['blocking', 'risky', 'review', 'safe']);
  });

  it('caps the inlined rows at `limit` while keeping full summary tallies + truncated flag', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [
        { type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' }, // blocking
        { type: 'CustomField', apiName: 'Account.Firm__c', changeKind: 'modified' }, // risky
        { type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }, // safe
      ],
      limit: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed.length).toBe(1);
    // The blocking row survives the cap (sorts first) — the gate is never hidden.
    expect(r.value.data.reviewed[0]?.verdict).toBe('blocking');
    expect(r.value.data.summary.total).toBe(3);
    expect(r.value.data.summary.blocking).toBe(1);
    expect(r.value.data.summary.truncated).toBe(true);
    expect(r.value.data.overallVerdict).toBe('blocking');
  });

  it('surfaces the verbatim disclosure and boundaries', async () => {
    const r = await reviewChangeHandler(ctxWith(COMPLETE_COVERAGE), {
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/LAST VAULT REFRESH/);
    expect(r.value.data.disclosure).toMatch(/access.?usage|grantedBy/);
    expect(r.value.data.disclosure).toMatch(/SELECTION ≠ VALIDATION/);
    expect(r.value.data.boundaries.length).toBeGreaterThanOrEqual(3);
  });
});

describe('classify — pins every row of the table', () => {
  const base = { inVault: true, dependentCount: 0, allHeuristic: false, weakest: null, familyCovered: true } as const;

  it('deleted + deps → blocking', () => {
    expect(classify({ ...base, changeKind: 'deleted', dependentCount: 2, weakest: 'declared' }).verdict).toBe('blocking');
  });
  it('deleted + 0 deps + covered → safe', () => {
    expect(classify({ ...base, changeKind: 'deleted' }).verdict).toBe('safe');
  });
  it('deleted + 0 deps + NOT covered → review', () => {
    expect(classify({ ...base, changeKind: 'deleted', familyCovered: false }).verdict).toBe('review');
  });
  it('deleted + not in vault → review', () => {
    expect(classify({ ...base, changeKind: 'deleted', inVault: false }).verdict).toBe('review');
  });
  it('modified + firm deps → risky', () => {
    expect(classify({ ...base, changeKind: 'modified', dependentCount: 1, weakest: 'parsed' }).verdict).toBe('risky');
  });
  it('modified + heuristic-only deps → review', () => {
    expect(classify({ ...base, changeKind: 'modified', dependentCount: 1, allHeuristic: true, weakest: 'heuristic' }).verdict).toBe('review');
  });
  it('modified + 0 deps + covered → safe', () => {
    expect(classify({ ...base, changeKind: 'modified' }).verdict).toBe('safe');
  });
  it('modified + 0 deps + NOT covered → review', () => {
    expect(classify({ ...base, changeKind: 'modified', familyCovered: false }).verdict).toBe('review');
  });
  it('modified + not in vault → review', () => {
    expect(classify({ ...base, changeKind: 'modified', inVault: false }).verdict).toBe('review');
  });
  it('added + not in vault → safe', () => {
    expect(classify({ ...base, changeKind: 'added', inVault: false }).verdict).toBe('safe');
  });
  it('added + in vault (collision) → review', () => {
    expect(classify({ ...base, changeKind: 'added' }).verdict).toBe('review');
  });
});

describe('reviewChangeInputSchema', () => {
  it('accepts a well-formed change set', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ type: 'ApexClass', apiName: 'X', changeKind: 'modified' }],
      }).success,
    ).toBe(true);
  });
  it('rejects an empty component list', () => {
    expect(reviewChangeInputSchema.safeParse({ components: [] }).success).toBe(false);
  });
  it('rejects an unknown changeKind', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ type: 'ApexClass', apiName: 'X', changeKind: 'renamed' }],
      }).success,
    ).toBe(false);
  });
});
