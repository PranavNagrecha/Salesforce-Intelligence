/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
  findClonePatternsHandler,
  findClonePatternsInputSchema,
} from '../../src/tools/find-clone-patterns.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-fcp',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Opportunity', type: 'CustomObject', apiName: 'Opportunity' }),
    makeNode({ id: 'CustomObject:Quote', type: 'CustomObject', apiName: 'Quote' }),
    makeNode({ id: 'CustomObject:Lead', type: 'CustomObject', apiName: 'Lead' }),
    makeNode({ id: 'CustomObject:Case', type: 'CustomObject', apiName: 'Case' }),
    makeNode({
      id: 'CustomField:Opportunity.Amount__c',
      type: 'CustomField',
      apiName: 'Opportunity.Amount__c',
      parentId: 'CustomObject:Opportunity',
    }),
    makeNode({
      id: 'CustomField:Quote.GrandTotal__c',
      type: 'CustomField',
      apiName: 'Quote.GrandTotal__c',
      parentId: 'CustomObject:Quote',
    }),
    makeNode({ id: 'ApexClass:CloneHelper', type: 'ApexClass', apiName: 'CloneHelper' }),
    makeNode({
      id: 'ApexClass:OpportunityCloneService',
      type: 'ApexClass',
      apiName: 'OpportunityCloneService',
    }),
    makeNode({
      id: 'ApexClass:QuoteCloneService',
      type: 'ApexClass',
      apiName: 'QuoteCloneService',
    }),
    makeNode({
      id: 'ApexClass:UnrelatedService',
      type: 'ApexClass',
      apiName: 'UnrelatedService',
    }),
    makeNode({
      id: 'Flow:Auto_Assign_Lead',
      type: 'Flow',
      apiName: 'Auto_Assign_Lead',
    }),
    makeNode({
      id: 'Flow:Auto_Assign_Case',
      type: 'Flow',
      apiName: 'Auto_Assign_Case',
    }),
    makeNode({
      id: 'Flow:Send_Welcome',
      type: 'Flow',
      apiName: 'Send_Welcome',
    }),
  ],
  edges: [
    // OpportunityCloneService: callsApex CloneHelper, reads/writes Amount
    makeEdge({
      fromId: 'ApexClass:OpportunityCloneService',
      toId: 'ApexClass:CloneHelper',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:OpportunityCloneService',
      toId: 'CustomField:Opportunity.Amount__c',
      edgeType: 'readsFrom',
    }),
    makeEdge({
      fromId: 'ApexClass:OpportunityCloneService',
      toId: 'CustomField:Opportunity.Amount__c',
      edgeType: 'writesTo',
    }),
    // QuoteCloneService: callsApex CloneHelper, reads/writes GrandTotal
    makeEdge({
      fromId: 'ApexClass:QuoteCloneService',
      toId: 'ApexClass:CloneHelper',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:QuoteCloneService',
      toId: 'CustomField:Quote.GrandTotal__c',
      edgeType: 'readsFrom',
    }),
    makeEdge({
      fromId: 'ApexClass:QuoteCloneService',
      toId: 'CustomField:Quote.GrandTotal__c',
      edgeType: 'writesTo',
    }),
    // UnrelatedService: completely different shape
    // (no edges, so jaccard = 0 against the seed)

    // Auto_Assign_Lead: triggers on Lead, calls CloneHelper, reads/writes Amount
    makeEdge({
      fromId: 'Flow:Auto_Assign_Lead',
      toId: 'CustomObject:Lead',
      edgeType: 'triggersOn',
    }),
    makeEdge({
      fromId: 'Flow:Auto_Assign_Lead',
      toId: 'ApexClass:CloneHelper',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'Flow:Auto_Assign_Lead',
      toId: 'CustomField:Opportunity.Amount__c',
      edgeType: 'readsFrom',
    }),
    // Auto_Assign_Case: same pattern as Lead but different object
    makeEdge({
      fromId: 'Flow:Auto_Assign_Case',
      toId: 'CustomObject:Case',
      edgeType: 'triggersOn',
    }),
    makeEdge({
      fromId: 'Flow:Auto_Assign_Case',
      toId: 'ApexClass:CloneHelper',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'Flow:Auto_Assign_Case',
      toId: 'CustomField:Opportunity.Amount__c',
      edgeType: 'readsFrom',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fcp-'));
  const opened = await openGraph(join(tempDir, 'fcp.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('findClonePatternsHandler', () => {
  it('ranks QuoteCloneService as similar to OpportunityCloneService', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.matches.map((m) => m.componentId);
    expect(ids).toContain('ApexClass:QuoteCloneService');
  });

  it('every match carries confidence: heuristic', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of r.value.data.matches) {
      expect(m.confidence).toBe('heuristic');
    }
  });

  it('similarityBreakdown shows callsApex Jaccard = 1 when both call same helper', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const quote = r.value.data.matches.find(
      (m) => m.componentId === 'ApexClass:QuoteCloneService',
    );
    expect(quote?.similarityBreakdown.callsApexJaccard).toBeCloseTo(1, 5);
  });

  it('readsFromJaccard and writesToJaccard are 0 when sets are disjoint', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const quote = r.value.data.matches.find(
      (m) => m.componentId === 'ApexClass:QuoteCloneService',
    );
    // Opportunity reads Amount, Quote reads GrandTotal — completely
    // disjoint sets, so Jaccard = 0.
    expect(quote?.similarityBreakdown.readsFromJaccard).toBe(0);
    expect(quote?.similarityBreakdown.writesToJaccard).toBe(0);
  });

  it("score equals 0.40 * callsApexJaccard when reads/writes disjoint", async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const quote = r.value.data.matches.find(
      (m) => m.componentId === 'ApexClass:QuoteCloneService',
    );
    expect(quote?.score).toBeCloseTo(0.4, 5);
  });

  it('surfaces the verbatim structural-not-behavioral disclosure', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('approximates structural shape');
    expect(joined).toContain('have you considered');
  });

  it('excludes the seed itself from matches', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seedId = 'ApexClass:OpportunityCloneService';
    for (const m of r.value.data.matches) {
      expect(m.componentId).not.toBe(seedId);
    }
  });

  it('returns invalid-query for a non-Apex / non-Flow prefix', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'CustomField:Foo.Bar__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for unknown id', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:DoesNotExist',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('ranks Auto_Assign_Case as similar to Auto_Assign_Lead', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'Flow:Auto_Assign_Lead',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.matches.map((m) => m.componentId);
    expect(ids).toContain('Flow:Auto_Assign_Case');
  });

  it('Flow seed reports triggeredObject', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'Flow:Auto_Assign_Lead',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.seedFingerprint?.triggeredObject).toBe(
      'CustomObject:Lead',
    );
  });

  it('Flow comparison sets triggeredObjectMatch=false when objects differ', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'Flow:Auto_Assign_Lead',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const caseFlow = r.value.data.matches.find(
      (m) => m.componentId === 'Flow:Auto_Assign_Case',
    );
    expect(caseFlow?.similarityBreakdown.triggeredObjectMatch).toBe(false);
  });

  it('filters out matches below minScore', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
      minScore: 0.99,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBe(0);
  });

  it('sorts by score DESC with componentId ASC tiebreaker', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const matches = r.value.data.matches ?? [];
    for (let i = 1; i < matches.length; i += 1) {
      const a = matches[i - 1];
      const b = matches[i];
      if (a !== undefined && b !== undefined) {
        if (a.score === b.score) {
          expect(a.componentId.localeCompare(b.componentId)).toBeLessThan(0);
        } else {
          expect(a.score).toBeGreaterThan(b.score);
        }
      }
    }
  });

  it('returns seedFingerprint summary', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:OpportunityCloneService',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('seed');
    expect(r.value.data.seedFingerprint?.kind).toBe('apex');
    expect(r.value.data.seedFingerprint?.callsApexCount ?? 0).toBeGreaterThan(0);
  });

  // ===========================================================================
  // R1 (0.3.3 honesty census, line 581): a seed whose fingerprint is
  // COMPLETELY empty (no callsApex/readsFrom/writesTo edges at all) makes
  // `jaccard` return 0 against every candidate by its empty-set guard — a
  // mathematically guaranteed `totalCount: 0`, not a searched-and-genuinely-
  // unique zero. `ApexClass:CloneHelper` in the top-level fixture is a
  // callee only — it has no OUTGOING edges — so its fingerprint is the
  // {calls:0, reads:0, writes:0} case.
  // ===========================================================================
  it('does not read a structurally-empty seed fingerprint as "no clones" (R1)', async () => {
    const r = await findClonePatternsHandler(ctx, {
      componentId: 'ApexClass:CloneHelper',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The empty-set jaccard guard guarantees zero matches — confirm the
    // reproduction premise before asserting on the disclosure.
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.seedFingerprint?.callsApexCount).toBe(0);
    expect(r.value.data.seedFingerprint?.readsFromCount).toBe(0);
    expect(r.value.data.seedFingerprint?.writesToCount).toBe(0);
    const joined = r.value.data.boundaries.join(' ');
    // The SMALL_CLASS wording warns about the OPPOSITE failure mode (false
    // positives from trivial overlap) and must not be the disclosure attached
    // to a comparison that could not be made at all.
    expect(joined).not.toContain('will match many other single-method utility classes');
    // A distinct empty-fingerprint boundary must explain the zero could not
    // be a genuine comparison.
    expect(joined).toMatch(/fingerprint is completely empty|could not be meaningfully made|not comparable/i);
  });

  // The test that used to sit here was named "still emits the small-class
  // disclosure for a genuinely single-edge seed" but re-queried the SAME
  // 0-edge `ApexClass:CloneHelper` and asserted that disclosure was ABSENT —
  // the opposite of its name, and a duplicate of the mutual-exclusion
  // assertion in the test above. It was vacuous: mutating `seedEdgeTotal === 1`
  // to `=== 999999` (i.e. deleting SMALL_CLASS_DISCLOSURE) left the whole file
  // green. The preserved `=== 1` half is now covered for real, on a seed with
  // exactly one outgoing edge, in the
  // "empty vs single-edge seed boundaries (R1)" block below.
});

describe('findClonePatternsInputSchema', () => {
  it('accepts a valid Apex id', () => {
    expect(
      findClonePatternsInputSchema.safeParse({ componentId: 'ApexClass:Foo' })
        .success,
    ).toBe(true);
  });

  it('accepts an empty input — componentId omitted is cluster mode (P4-clone-patterns)', () => {
    expect(findClonePatternsInputSchema.safeParse({}).success).toBe(true);
    expect(
      findClonePatternsInputSchema.safeParse({ type: 'ApexClass' }).success,
    ).toBe(true);
  });

  it('rejects limit above 50', () => {
    expect(
      findClonePatternsInputSchema.safeParse({
        componentId: 'ApexClass:Foo',
        limit: 51,
      }).success,
    ).toBe(false);
  });
});

// =============================================================================
// P4-clone-patterns: seedless cluster mode groups near-duplicates org-wide.
// =============================================================================

describe('findClonePatternsHandler: cluster mode (P4-clone-patterns)', () => {
  let dir2: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-fcp-clusters-'));
    const opened = await openGraph(join(dir2, 'c.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    const cls = (name: string): Node =>
      makeNode({ id: `ApexClass:${name}`, type: 'ApexClass', apiName: name });
    const calls = (from: string, to: string): Edge =>
      makeEdge({ fromId: `ApexClass:${from}`, toId: `ApexClass:${to}`, edgeType: 'callsApex' });
    const reads = (from: string, field: string): Edge =>
      makeEdge({ fromId: `ApexClass:${from}`, toId: `CustomField:${field}`, edgeType: 'readsFrom' });
    const writes = (from: string, field: string): Edge =>
      makeEdge({ fromId: `ApexClass:${from}`, toId: `CustomField:${field}`, edgeType: 'writesTo' });
    // TwinA and TwinB call the same helpers, read the same fields, AND write the
    // same field → identical fingerprints (score 1.0). Loner shares nothing →
    // its own (dropped) singleton.
    const seed2: ExtractionResult = {
      nodes: [cls('TwinA'), cls('TwinB'), cls('Loner'), cls('HelperX'), cls('HelperY')],
      edges: [
        calls('TwinA', 'HelperX'), calls('TwinA', 'HelperY'),
        reads('TwinA', 'Account.Industry__c'), reads('TwinA', 'Account.Region__c'),
        writes('TwinA', 'Account.Status__c'),
        calls('TwinB', 'HelperX'), calls('TwinB', 'HelperY'),
        reads('TwinB', 'Account.Industry__c'), reads('TwinB', 'Account.Region__c'),
        writes('TwinB', 'Account.Status__c'),
        calls('Loner', 'HelperX'),
        reads('Loner', 'Case.Status__c'),
      ],
    };
    const imp = await importExtractionResults(store2, [seed2]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx2 = { vaultRoot: dir2, manifest: MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('groups the known duplicates into one cluster with a stable clusterId', async () => {
    const r = await findClonePatternsHandler(ctx2, { type: 'ApexClass' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('clusters');
    const clusters = r.value.data.clusters ?? [];
    // Exactly one cluster: {TwinA, TwinB}. Loner/HelperX/HelperY don't pair.
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.clusterId).toBe('clone-cluster-0');
    expect(clusters[0]?.members.map((m) => m.componentId).sort()).toEqual([
      'ApexClass:TwinA',
      'ApexClass:TwinB',
    ]);
    expect(clusters[0]?.topScore).toBeGreaterThan(0.9); // identical fingerprints
    expect(r.value.data.scannedCount).toBe(5);
  });

  it('honours minScore — a high threshold dissolves loose clusters', async () => {
    const r = await findClonePatternsHandler(ctx2, { type: 'ApexClass', minScore: 0.999 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // TwinA/TwinB are identical (score 1.0) so they still cluster at 0.999.
    expect((r.value.data.clusters ?? []).length).toBe(1);
  });
});

// =============================================================================
// R6 (0.3.3 honesty census, line 342): SEED mode's per-type walk had a
// private, undisclosed hand-rolled ceiling (PAGE_SIZE * MAX_PAGES = 10,000)
// with no `truncated` flag and no boundary entry — unlike cluster mode, which
// already discloses its own MAX_CLUSTER_NODES cap. Reproducing the REAL
// 10,000-node cap directly would mean seeding 10,001+ fixture nodes, so this
// exercises the shared `scanAllNodesOfTypes` ceiling at a small scale via the
// same `SFI_NODE_SCAN_LIMIT` (window) / `SFI_CLONE_PATTERNS_SCAN_MAX`
// (residual ceiling) override pair the sibling `flow_fault_audit` full-scan
// migration test uses (0.3.3) — the mechanism under test is identical
// (`scanAllNodesOfTypes`'s CR-P3 bounded probe), only the constants differ.
// =============================================================================

describe('findClonePatternsHandler: seed-mode scan ceiling is disclosed (R6)', () => {
  let dir3: string;
  let store3: GraphStore;
  let ctx3: Context;

  beforeAll(async () => {
    dir3 = mkdtempSync(join(tmpdir(), 'sfi-mcp-fcp-ceiling-'));
    const opened = await openGraph(join(dir3, 'ceiling.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store3 = opened.value;
    // 6 ApexClass nodes, no edges (fingerprint shape is irrelevant — this
    // test only asserts on scan-completeness disclosure, never on matches).
    const nodes: Node[] = Array.from({ length: 6 }, (_, i) =>
      makeNode({
        id: `ApexClass:CeilingProbe${String(i).padStart(2, '0')}`,
        type: 'ApexClass',
        apiName: `CeilingProbe${String(i).padStart(2, '0')}`,
      }),
    );
    const imp = await importExtractionResults(store3, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx3 = { vaultRoot: dir3, manifest: MANIFEST, graph: store3 };
  });

  afterAll(async () => {
    await closeGraph(store3);
    rmSync(dir3, { recursive: true, force: true });
  });

  const withSmallCeiling = async <T>(
    windowSize: string,
    ceiling: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const prevWindow = process.env['SFI_NODE_SCAN_LIMIT'];
    const prevCeiling = process.env['SFI_CLONE_PATTERNS_SCAN_MAX'];
    process.env['SFI_NODE_SCAN_LIMIT'] = windowSize;
    process.env['SFI_CLONE_PATTERNS_SCAN_MAX'] = ceiling;
    try {
      return await fn();
    } finally {
      if (prevWindow === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prevWindow;
      if (prevCeiling === undefined) delete process.env['SFI_CLONE_PATTERNS_SCAN_MAX'];
      else process.env['SFI_CLONE_PATTERNS_SCAN_MAX'] = prevCeiling;
    }
  };

  it('a seed-mode scan that stops short of the whole type DISCLOSES it', async () => {
    await withSmallCeiling('2', '3', async () => {
      const r = await findClonePatternsHandler(ctx3, {
        componentId: 'ApexClass:CeilingProbe00',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const joined = r.value.data.boundaries.join(' ');
      expect(joined).toMatch(/capped|truncat|INCOMPLETE/i);
    });
  });

  it('a seed-mode scan that covers the WHOLE type discloses nothing extra', async () => {
    await withSmallCeiling('500', '20000', async () => {
      const r = await findClonePatternsHandler(ctx3, {
        componentId: 'ApexClass:CeilingProbe00',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const joined = r.value.data.boundaries.join(' ');
      expect(joined).not.toMatch(/capped|truncat|INCOMPLETE/i);
    });
  });
});

// =============================================================================
// R1 follow-up (0.3.3 adversarial verification of the R1 split): the
// empty-fingerprint boundary is only honest when the comparison really was
// impossible. `seedEdgeTotal` sums callsApex + readsFrom + writesTo ONLY, but
// `scorePair`'s Flow branch also scores a 0.20-weighted `triggeredObject`
// match, and the `score < minScore` filter is a STRICT compare — so a
// trigger-only Flow (score 0.20) and ANY seed queried at `minScore: 0` (score
// 0.00) both return a NON-EMPTY match list. A boundary asserting `matches: []`
// / `totalCount: 0` alongside those rows contradicts the payload printed next
// to it. This block also gives the PRESERVED half of the `<= 1` split (the
// genuinely single-edge seed) the coverage it lacked.
// =============================================================================

describe('findClonePatternsHandler: empty vs single-edge seed boundaries (R1)', () => {
  let dir4: string;
  let store4: GraphStore;
  let ctx4: Context;

  beforeAll(async () => {
    dir4 = mkdtempSync(join(tmpdir(), 'sfi-mcp-fcp-r1-'));
    const opened = await openGraph(join(dir4, 'r1.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store4 = opened.value;
    const seed4: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
        // Callee has NO outgoing edges → the genuinely empty apex fingerprint.
        makeNode({ id: 'ApexClass:Callee', type: 'ApexClass', apiName: 'Callee' }),
        // LoneCaller / OtherLoneCaller have EXACTLY ONE outgoing edge each.
        makeNode({ id: 'ApexClass:LoneCaller', type: 'ApexClass', apiName: 'LoneCaller' }),
        makeNode({
          id: 'ApexClass:OtherLoneCaller',
          type: 'ApexClass',
          apiName: 'OtherLoneCaller',
        }),
        // Two flows whose ONLY outgoing edge is triggersOn, on the same object.
        makeNode({ id: 'Flow:TriggerOnlyA', type: 'Flow', apiName: 'TriggerOnlyA' }),
        makeNode({ id: 'Flow:TriggerOnlyB', type: 'Flow', apiName: 'TriggerOnlyB' }),
        // A flow with no outgoing edges at all, not even triggersOn.
        makeNode({ id: 'Flow:BareFlow', type: 'Flow', apiName: 'BareFlow' }),
      ],
      edges: [
        makeEdge({
          fromId: 'ApexClass:LoneCaller',
          toId: 'ApexClass:Callee',
          edgeType: 'callsApex',
        }),
        makeEdge({
          fromId: 'ApexClass:OtherLoneCaller',
          toId: 'ApexClass:Callee',
          edgeType: 'callsApex',
        }),
        makeEdge({
          fromId: 'Flow:TriggerOnlyA',
          toId: 'CustomObject:Account',
          edgeType: 'triggersOn',
        }),
        makeEdge({
          fromId: 'Flow:TriggerOnlyB',
          toId: 'CustomObject:Account',
          edgeType: 'triggersOn',
        }),
      ],
    };
    const imp = await importExtractionResults(store4, [seed4]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx4 = { vaultRoot: dir4, manifest: MANIFEST, graph: store4 };
  });

  afterAll(async () => {
    await closeGraph(store4);
    rmSync(dir4, { recursive: true, force: true });
  });

  it('emits the small-class disclosure for a genuinely single-edge seed', async () => {
    const r = await findClonePatternsHandler(ctx4, {
      componentId: 'ApexClass:LoneCaller',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Pin the premise: EXACTLY ONE outgoing structural edge, so this is the
    // preserved `=== 1` half of the split, not the `=== 0` half.
    expect(r.value.data.seedFingerprint?.callsApexCount).toBe(1);
    expect(r.value.data.seedFingerprint?.readsFromCount).toBe(0);
    expect(r.value.data.seedFingerprint?.writesToCount).toBe(0);
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain(
      'structural similarity is less meaningful for small classes',
    );
    expect(joined).not.toMatch(/fingerprint is completely empty/i);
  });

  it('never claims the comparison was impossible while returning matches (trigger-only Flow)', async () => {
    const r = await findClonePatternsHandler(ctx4, {
      componentId: 'Flow:TriggerOnlyA',
      minScore: 0.2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Premise: the 0.20-weighted triggeredObject dimension DOES score, so the
    // list is not empty even though all three edge sets are empty.
    expect(r.value.data.totalCount).toBe(1);
    expect(r.value.data.matches[0]?.componentId).toBe('Flow:TriggerOnlyB');
    expect(r.value.data.matches[0]?.score).toBeCloseTo(0.2, 5);
    expect(r.value.data.matches[0]?.similarityBreakdown.triggeredObjectMatch).toBe(true);
    const joined = r.value.data.boundaries.join(' ');
    // THE INVARIANT: a boundary saying the comparison could not be made may
    // never appear next to a non-empty match list.
    expect(joined).not.toMatch(
      /could not be meaningfully made|nothing to compare|is NOT evidence this (class|flow) is structurally unique/i,
    );
    expect(joined).not.toMatch(/fingerprint is completely empty/i);
    // Apex-scanner wording must never fire on a Flow.
    expect(joined).not.toMatch(/Apex scanner/i);
    // The honest boundary for this shape: the 0.20 score ceiling.
    expect(joined).toMatch(/0\.20/);
  });

  it('gives a Flow-worded empty disclosure to a flow with no edges at all', async () => {
    const r = await findClonePatternsHandler(ctx4, {
      componentId: 'Flow:BareFlow',
      minScore: 0.2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.seedFingerprint?.triggeredObject).toBeNull();
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/fingerprint is completely empty/i);
    // "the class was never parsed by the Apex scanner" must not fire on a Flow.
    expect(joined).not.toMatch(/Apex scanner/i);
    expect(joined).not.toMatch(/\bclass\b/i);
  });

  it('empty-fingerprint disclosure states the score guarantee, not an empty-list guarantee', async () => {
    // `score < minScore` is STRICT, so minScore 0 admits every 0.00-scoring
    // candidate: an empty apex fingerprint returns a NON-EMPTY match list.
    const r = await findClonePatternsHandler(ctx4, {
      componentId: 'ApexClass:Callee',
      minScore: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBeGreaterThan(0);
    for (const m of r.value.data.matches) expect(m.score).toBe(0);
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/fingerprint is completely empty/i);
    // The guarantee that is actually true for every minScore: a 0.00 score.
    expect(joined).toContain('exactly 0.00');
    // The claim that is FALSE here — an empty payload — must not be asserted.
    expect(joined).not.toContain('`matches: []` / `totalCount: 0`');
  });
});

// =============================================================================
// R6 regression guard (0.3.3 adversarial verification): `scanAllNodesOfTypes`
// appends a WHOLE window BEFORE testing `scannedThisType >= maxNodes`, so
// passing MAX_CLUSTER_NODES (800) with the default 500-node window returns up
// to 1000 nodes. Cluster mode is O(n²) in that count and its `capped`
// disclosure quotes 800 verbatim, so the walk's overshoot must be truncated by
// the caller or the tool both exceeds its documented bound AND prints a
// boundary contradicting the `scannedCount` beside it.
// =============================================================================

describe('findClonePatternsHandler: cluster mode honours its O(n²) bound (R6)', () => {
  let dir5: string;
  let store5: GraphStore;
  let ctx5: Context;

  beforeAll(async () => {
    dir5 = mkdtempSync(join(tmpdir(), 'sfi-mcp-fcp-cap-'));
    const opened = await openGraph(join(dir5, 'cap.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store5 = opened.value;
    // 900 edge-free ApexClass nodes: past the 800 O(n²) bound, but under the
    // 1000-node window boundary the shared walk overshoots to.
    const nodes: Node[] = Array.from({ length: 900 }, (_, i) =>
      makeNode({
        id: `ApexClass:Bulk${String(i).padStart(4, '0')}`,
        type: 'ApexClass',
        apiName: `Bulk${String(i).padStart(4, '0')}`,
      }),
    );
    const imp = await importExtractionResults(store5, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx5 = { vaultRoot: dir5, manifest: MANIFEST, graph: store5 };
  });

  afterAll(async () => {
    await closeGraph(store5);
    rmSync(dir5, { recursive: true, force: true });
  });

  it('never scans past MAX_CLUSTER_NODES and discloses the cap', async () => {
    const r = await findClonePatternsHandler(ctx5, { type: 'ApexClass' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.scannedCount).toBe(800);
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('cluster scan capped at the first 800 ApexClass nodes');
  });
});
