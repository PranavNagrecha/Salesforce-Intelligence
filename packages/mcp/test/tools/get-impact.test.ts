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
  getImpactHandler,
  getImpactInputSchema,
} from '../../src/tools/get-impact.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 1,
    CustomField: 1,
    ValidationRule: 1,
    Flow: 1,
  },
  edges: { parentOf: 1, references: 2, readsFrom: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: 'Account',
  parentId: null,
  sourcePath: 'objects/Account/Account.object-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>,
): Edge => ({
  edgeType: 'references',
  confidence: 'parsed',
  source: 'extractor:references',
  properties: {},
  ...overrides,
});

// Impact scenario built around `CustomField:Account.Industry__c`:
//   - Account is the parent of Industry__c (parentOf, outgoing from
//     Industry's POV — included only when we don't restrict edgeTypes).
//   - IndustryVR is a ValidationRule that --references--> Industry__c
//     (1 hop incoming).
//   - SegmentField is another formula CustomField that
//     --references--> Industry__c (1 hop incoming).
//   - SegmentFlow --readsFrom--> SegmentField (2 hops incoming to
//     Industry, only reachable when hops>=2).
//   - UnrelatedTrigger does not touch Industry; it must never appear.
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      apiName: 'Account',
      label: 'Account',
    }),
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Account.Segment__c',
      type: 'CustomField',
      apiName: 'Segment__c',
      label: 'Segment',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Segment__c.field-meta.xml',
    }),
    makeNode({
      id: 'ValidationRule:Account.IndustryVR',
      type: 'ValidationRule',
      apiName: 'IndustryVR',
      label: 'IndustryVR',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/validationRules/IndustryVR.validationRule-meta.xml',
    }),
    makeNode({
      id: 'Flow:SegmentFlow',
      type: 'Flow',
      apiName: 'SegmentFlow',
      label: 'SegmentFlow',
      sourcePath: 'flows/SegmentFlow.flow-meta.xml',
    }),
    makeNode({
      id: 'ApexTrigger:UnrelatedTrigger',
      type: 'ApexTrigger',
      apiName: 'UnrelatedTrigger',
      label: 'UnrelatedTrigger',
      sourcePath: 'triggers/UnrelatedTrigger.trigger',
    }),
  ],
  edges: [
    // parentOf is outgoing from Account, so it appears as INCOMING to
    // Industry__c when we walk hop-1 incoming with no edgeTypes filter.
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'extractor:custom-object',
    }),
    makeEdge({
      fromId: 'ValidationRule:Account.IndustryVR',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
      properties: { tokenizedFromField: true, formulaLength: 42 },
    }),
    makeEdge({
      fromId: 'CustomField:Account.Segment__c',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
      properties: { tokenizedFromField: true, formulaLength: 28 },
    }),
    // 2-hop: SegmentFlow reads Segment__c; only reached at hops>=2.
    makeEdge({
      fromId: 'Flow:SegmentFlow',
      toId: 'CustomField:Account.Segment__c',
      edgeType: 'readsFrom',
      confidence: 'parsed',
      source: 'extractor:flow',
    }),
    // Unrelated edge that must never appear in any Industry-rooted walk.
    makeEdge({
      fromId: 'ApexTrigger:UnrelatedTrigger',
      toId: 'CustomObject:Account',
      edgeType: 'triggersOn',
      confidence: 'parsed',
      source: 'extractor:apex-trigger',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-impact-'));
  const dbPath = join(tempDir, 'get-impact.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('getImpactHandler', () => {
  it('returns the 1-hop dependents of a field, walking incoming edges only', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Hop-1 incoming to Industry__c: Account (parentOf), IndustryVR
    // (references), Segment__c (references). The root is always
    // included; total = 4 nodes.
    const nodeIds = result.value.data.impact.nodes.map((n) => n.id);
    expect(nodeIds).toContain('CustomField:Account.Industry__c');
    expect(nodeIds).toContain('CustomObject:Account');
    expect(nodeIds).toContain('ValidationRule:Account.IndustryVR');
    expect(nodeIds).toContain('CustomField:Account.Segment__c');
    expect(nodeIds).not.toContain('Flow:SegmentFlow'); // 2 hops away
    expect(nodeIds).not.toContain('ApexTrigger:UnrelatedTrigger');
    expect(result.value.data.impact.nodes.length).toBe(4);
    // 3 incoming edges to Industry: parentOf + 2x references.
    expect(result.value.data.impact.edges.length).toBe(3);
    for (const edge of result.value.data.impact.edges) {
      expect(edge.toId).toBe('CustomField:Account.Industry__c');
    }
    // Edge types actually traversed, alphabetical.
    expect(result.value.data.traversedEdgeTypes).toEqual([
      'parentOf',
      'references',
    ]);
    expect(result.value.data.truncated).toBe(false);
    expect(result.value.data.estimatedPayloadBytes).toBeGreaterThan(0);
    expect(result.value.data.disclosure).toContain('Complete impact slice');
    expect(result.value.data.disclosure).toContain('estimated JSON payload');
    // A field target has no inbound lookups — the object-only lookup caveat
    // must NOT appear here.
    expect(result.value.data.disclosure).not.toContain('lookupTo');
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('discloses that lookup relationships are modeled as lookupTo edges when the target is a CustomObject', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Lookup / master-detail relationships are modeled as `lookupTo` edges, so
    // get_impact on an OBJECT includes inbound lookup fields when the vault has
    // them. The disclosure names the edge + a freshness caveat (re-refresh if an
    // object shows none) rather than claiming lookups are unmodeled.
    expect(result.value.data.disclosure).toContain('lookupTo');
    expect(result.value.data.disclosure).toContain('lookup');
  });

  it('reaches the 2-hop dependent (SegmentFlow) when hops=2', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nodeIds = result.value.data.impact.nodes.map((n) => n.id);
    expect(nodeIds).toContain('Flow:SegmentFlow');
    // 2-hop also drags in the `triggersOn` edge from UnrelatedTrigger to
    // Account (which is a hop-1 dependent of Industry__c).
    expect(nodeIds).toContain('ApexTrigger:UnrelatedTrigger');
    // 5 incoming edges total: 3 to Industry + 1 to Segment + 1 to
    // Account. Edges are deduped on (from, to, type, source).
    expect(result.value.data.impact.edges.length).toBe(5);
    expect(result.value.data.traversedEdgeTypes).toEqual([
      'parentOf',
      'readsFrom',
      'references',
      'triggersOn',
    ]);
  });

  it('defaults to hops=2 when the caller omits it', async () => {
    const omitted = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
    });
    const explicit = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 2,
    });
    expect(omitted.ok).toBe(true);
    expect(explicit.ok).toBe(true);
    if (!omitted.ok || !explicit.ok) return;
    expect(omitted.value.data.impact.nodes.length).toBe(
      explicit.value.data.impact.nodes.length,
    );
    expect(omitted.value.data.impact.edges.length).toBe(
      explicit.value.data.impact.edges.length,
    );
  });

  it('narrows the walk when edgeTypes filters references only', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 1,
      edgeTypes: ['references'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the 2 references edges; parentOf is excluded.
    expect(result.value.data.impact.edges.length).toBe(2);
    for (const edge of result.value.data.impact.edges) {
      expect(edge.edgeType).toBe('references');
    }
    // Nodes: Industry__c + 2 referencers = 3.
    const nodeIds = result.value.data.impact.nodes.map((n) => n.id);
    expect(nodeIds).toContain('ValidationRule:Account.IndustryVR');
    expect(nodeIds).toContain('CustomField:Account.Segment__c');
    expect(nodeIds).not.toContain('CustomObject:Account');
    expect(result.value.data.traversedEdgeTypes).toEqual(['references']);
  });

  it('returns the deterministic sort: nodes by id, edges by (from,to,type,source)', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nodeIds = result.value.data.impact.nodes.map((n) => n.id);
    const sortedCopy = [...nodeIds].sort();
    expect(nodeIds).toEqual(sortedCopy);
    const edgeKeys = result.value.data.impact.edges.map(
      (e) => `${e.fromId}|${e.toId}|${e.edgeType}|${e.source}`,
    );
    const sortedEdgeKeys = [...edgeKeys].sort();
    expect(edgeKeys).toEqual(sortedEdgeKeys);
  });

  it('warns when grantedBy edges inflate payload despite count caps', async () => {
    const heavyDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-impact-heavy-'));
    try {
      const dbPath = join(heavyDir, 'heavy-impact.db');
      const opened = await openGraph(dbPath);
      if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
      const heavyStore = opened.value;

      const fieldId = 'CustomField:Account.HeavyField__c';
      const profileNodes: Node[] = [];
      const grantedByEdges: Edge[] = [];
      for (let i = 0; i < 150; i++) {
        const profileId = `Profile:HeavyProfile${i}`;
        profileNodes.push(
          makeNode({
            id: profileId,
            type: 'Profile',
            apiName: `HeavyProfile${i}`,
            label: `Heavy Profile ${i}`,
            sourcePath: `profiles/HeavyProfile${i}.profile-meta.xml`,
            properties: {
              layoutAssignments: Array.from({ length: 40 }, (_, idx) => ({
                layout: `Account-Layout-${i}-${idx}-${'x'.repeat(120)}`,
                recordType: null,
              })),
            },
          }),
        );
        grantedByEdges.push(
          makeEdge({
            fromId: profileId,
            toId: fieldId,
            edgeType: 'grantedBy',
            confidence: 'declared',
            source: 'profile-extractor',
            properties: { editable: true, readable: true },
          }),
        );
      }

      const heavySeed: ExtractionResult = {
        nodes: [
          makeNode({
            id: 'CustomObject:Account',
            apiName: 'Account',
            label: 'Account',
          }),
          makeNode({
            id: fieldId,
            type: 'CustomField',
            apiName: 'HeavyField__c',
            label: 'Heavy Field',
            parentId: 'CustomObject:Account',
            sourcePath: 'objects/Account/fields/HeavyField__c.field-meta.xml',
          }),
          ...profileNodes,
        ],
        edges: grantedByEdges,
      };

      const imported = await importExtractionResults(heavyStore, [heavySeed]);
      if (!imported.ok) {
        throw new Error(`heavy seed import failed: ${imported.error.message}`);
      }

      const heavyCtx: Context = {
        vaultRoot: heavyDir,
        manifest: FIXTURE_MANIFEST,
        graph: heavyStore,
      };

      const result = await getImpactHandler(heavyCtx, {
        componentId: fieldId,
        hops: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // 150 fat Profile nodes (each a 40-row layoutAssignments matrix): per-node
      // slimming summarises the oversized property to an `{__omitted}` marker,
      // but 150 slimmed nodes + edges still exceed the ~28 KB MCP response
      // budget, so the hard byte cap trims the slice and marks it truncated.
      expect(result.value.data.truncated).toBe(true);
      // Bug 14: the truncation caveat is also promoted into a structured
      // summary field (not only the prose disclosure), so a caller reading the
      // summary still learns the slice is partial, why, and how to widen it.
      const tr = result.value.data.truncationReason;
      expect(tr).toBeDefined();
      expect(['node-cap', 'edge-cap', 'payload-budget']).toContain(tr?.reason);
      expect(tr?.nodeCap).toBe(200);
      expect(tr?.edgeCap).toBe(400);
      expect(tr?.remedy).toMatch(/PARTIAL/);
      expect(result.value.data.impact.nodes.length).toBeLessThanOrEqual(200);
      expect(result.value.data.impact.edges.length).toBeLessThanOrEqual(400);
      // The serialized slice is now GUARANTEED consumable by the MCP client
      // (the old 150 KB bound was an order of magnitude over the real limit).
      expect(result.value.data.estimatedPayloadBytes).toBeLessThanOrEqual(28_000);
      expect(result.value.data.payloadSlimmed).toBe(true);
      expect(result.value.data.disclosure).toContain('summarised');
      expect(result.value.data.disclosure).toContain('sfi.get_component');
      expect(result.value.data.disclosure).toContain('estimated JSON payload');
      // The fat property is now a marker, not the full 40-row array.
      const heavyProfile = result.value.data.impact.nodes.find(
        (n) => n.type === 'Profile',
      );
      expect(
        (heavyProfile?.properties as Record<string, unknown> | undefined)
          ?.layoutAssignments,
      ).toMatchObject({ __omitted: true });

      await closeGraph(heavyStore);
    } finally {
      rmSync(heavyDir, { recursive: true, force: true });
    }
  });

  it('returns an empty impact set for an unknown componentId', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.DoesNotExist__c',
    });
    // The graph has no incoming edges to an absent node, and the root
    // does not resolve to a Node row, so both lists are empty.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.impact.nodes.length).toBe(0);
    expect(result.value.data.impact.edges.length).toBe(0);
    expect(result.value.data.traversedEdgeTypes.length).toBe(0);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });
});

describe('getImpactInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = getImpactInputSchema.safeParse({
      componentId: 'CustomField:Account.Industry__c',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts hops at the upper bound (3)', () => {
    const parsed = getImpactInputSchema.safeParse({
      componentId: 'CustomField:Account.Industry__c',
      hops: 3,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects hops greater than 3', () => {
    const parsed = getImpactInputSchema.safeParse({
      componentId: 'CustomField:Account.Industry__c',
      hops: 4,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects hops=0', () => {
    const parsed = getImpactInputSchema.safeParse({
      componentId: 'CustomField:Account.Industry__c',
      hops: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty componentId', () => {
    const parsed = getImpactInputSchema.safeParse({ componentId: '' });
    expect(parsed.success).toBe(false);
  });

  it('allows impact on a vaulted non-PascalCase ApexClass (GRF-01 pkb_Controller)', async () => {
    const seed: ExtractionResult = {
      nodes: [
        {
          id: 'ApexClass:pkb_Controller',
          type: 'ApexClass',
          apiName: 'pkb_Controller',
          label: null,
          parentId: null,
          sourcePath: 'pkb_Controller.cls',
          lastModifiedDate: null,
          lastModifiedBy: null,
          apiVersion: null,
          properties: {},
        },
        {
          id: 'ApexClass:Caller',
          type: 'ApexClass',
          apiName: 'Caller',
          label: null,
          parentId: null,
          sourcePath: 'Caller.cls',
          lastModifiedDate: null,
          lastModifiedBy: null,
          apiVersion: null,
          properties: {},
        },
      ],
      edges: [
        {
          fromId: 'ApexClass:Caller',
          toId: 'ApexClass:pkb_Controller',
          edgeType: 'callsApex',
          confidence: 'heuristic',
          source: 'apex-scanner',
          properties: {},
        },
      ],
    };
    const imp = await importExtractionResults(store, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    const r = await getImpactHandler(ctx, { componentId: 'ApexClass:pkb_Controller' });
    expect(r.ok).toBe(true);
  });

  it('refuses an un-type-resolved Apex receiver root as invalid-query (P14-PHANTOM-edges)', async () => {
    // CustomField:app.Id / ApexClass:oldMap are heuristic-scanner parse
    // artifacts keyed on local variables — walking "what depends on them"
    // would dress parse noise up as a blast radius.
    for (const componentId of ['CustomField:app.Id', 'ApexClass:oldMap']) {
      const r = await getImpactHandler(ctx, { componentId });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe('invalid-query');
      expect(r.error.message).toMatch(/parse artifact/);
    }
    // Real PascalCase / namespaced ids are untouched by the guard.
    const real = await getImpactHandler(ctx, { componentId: 'CustomField:Account.Industry__c' });
    expect(real.ok).toBe(true);
  });

  it('rejects an unknown edge type in the edgeTypes filter', () => {
    const parsed = getImpactInputSchema.safeParse({
      componentId: 'CustomField:Account.Industry__c',
      edgeTypes: ['notARealEdge'],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an empty edgeTypes array', () => {
    // An empty array is well-formed (Zod-wise). The handler treats it as
    // "no filter", matching the behavior when the key is omitted.
    const parsed = getImpactInputSchema.safeParse({
      componentId: 'CustomField:Account.Industry__c',
      edgeTypes: [],
    });
    expect(parsed.success).toBe(true);
  });
});

// =============================================================================
// P4-C5: get_impact returns full Edge objects, so the method-level callers of
// an Apex method are visible via the callsApex edge's `methods` property.
// =============================================================================

describe('getImpactHandler: method-level callers via callsApex methods[] (P4-C5)', () => {
  let dir2: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-impact-methods-'));
    const opened = await openGraph(join(dir2, 'gi.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    const seed2: ExtractionResult = {
      nodes: [
        makeNode({ id: 'ApexClass:Handler', type: 'ApexClass', apiName: 'Handler' }),
        makeNode({ id: 'ApexClass:Caller', type: 'ApexClass', apiName: 'Caller' }),
      ],
      edges: [
        makeEdge({
          fromId: 'ApexClass:Caller',
          toId: 'ApexClass:Handler',
          edgeType: 'callsApex',
          confidence: 'heuristic',
          source: 'apex-scanner',
          properties: { methods: ['deleteRecord', 'save'], methodName: 'deleteRecord' },
        }),
      ],
    };
    const imported = await importExtractionResults(store2, [seed2]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx2 = { vaultRoot: dir2, manifest: FIXTURE_MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('surfaces the callsApex edge with its methods[] so method-level callers are visible', async () => {
    const result = await getImpactHandler(ctx2, {
      componentId: 'ApexClass:Handler',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const callEdge = result.value.data.impact.edges.find(
      (e) => e.edgeType === 'callsApex' && e.fromId === 'ApexClass:Caller',
    );
    expect(callEdge).toBeDefined();
    expect(callEdge?.properties['methods']).toEqual(['deleteRecord', 'save']);
  });
});
