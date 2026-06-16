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
