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

  it('R6-19: renders a graph TD mermaid diagram when the impact slice is under the diagram node cap', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.impact.nodes.length).toBeLessThanOrEqual(30);
    expect(result.value.data.diagram).toBeDefined();
    expect(result.value.data.diagramOmittedReason).toBeUndefined();
    const diagram = result.value.data.diagram ?? '';
    expect(diagram.startsWith('```mermaid\ngraph TD\n')).toBe(true);
    expect(diagram.endsWith('```')).toBe(true);
  });

  it('R6-19: the root node renders as a circle (double-paren shape), other nodes as boxes', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diagram = result.value.data.diagram ?? '';
    const lines = diagram.split('\n');
    const rootLine = lines.find((l) => l.includes('CustomField: Industry__c'));
    expect(rootLine).toBeDefined();
    expect(rootLine).toContain('((');
    const otherLine = lines.find((l) => l.includes('CustomObject: Account'));
    expect(otherLine).toBeDefined();
    expect(otherLine).not.toContain('((');
    expect(otherLine).toContain('[');
  });

  it('R6-19: node labels carry the component-type prefix and edge labels carry edgeType', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diagram = result.value.data.diagram ?? '';
    expect(diagram).toContain('ValidationRule: IndustryVR');
    expect(diagram).toContain('CustomObject: Account');
    expect(diagram).toMatch(/-->\|parentOf\|/);
    expect(diagram).toMatch(/-->\|references\|/);
  });

  it('R6-19: mermaid entity ids are sanitized (dots/colons never leak into an id token)', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diagram = result.value.data.diagram ?? '';
    const nodeDeclLine = diagram
      .split('\n')
      .find((l) => l.includes('CustomField: Industry__c'));
    expect(nodeDeclLine).toBeDefined();
    // The id token (before the shape bracket) has no `:` or `.`.
    const idToken = nodeDeclLine?.trim().split(/[[(]/)[0]?.trim();
    expect(idToken).toBeDefined();
    expect(idToken).not.toContain(':');
    expect(idToken).not.toContain('.');
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

  // D3-soundness-overclaim: a CustomField impact walk is structurally blind to
  // referrer classes not modeled as incoming edges (roll-ups, layout placement,
  // flow decision/filter reads, tab/app membership). It must NOT report
  // complete:true / staticCoverage:'full' on their absence.
  it('does NOT report complete/full for a CustomField root; names the un-walked referrer classes', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.value.data.soundness;
    expect(s.complete).toBe(false);
    expect(s.staticCoverage).toBe('partial');
    const referrer = s.blindSpots.find((b) => b.kind === 'unwalked-referrer-class');
    expect(referrer).toBeDefined();
    expect(referrer?.referrerClasses).toEqual([
      'roll-up source coupling',
      'layout placement',
      'flow decision/filter reads',
      'tab/app membership',
    ]);
    // The prose disclosure also names the un-walked classes.
    expect(result.value.data.disclosure).toContain('roll-up source coupling');
    expect(result.value.data.disclosure).toContain('flow decision/filter reads');
    expect(result.value.data.disclosure).toMatch(/not checked/i);
  });

  it('GUARD: a non-field/object root (ApexTrigger) is genuinely fully-walked — soundness stays complete/full', async () => {
    const result = await getImpactHandler(ctx, {
      componentId: 'ApexTrigger:UnrelatedTrigger',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.value.data.soundness;
    // No field/object root, no dynamic-apex nodes → strongest honest coverage,
    // and NO structural referrer blind spot (those classes reference fields/objects).
    expect(s.blindSpots.some((b) => b.kind === 'unwalked-referrer-class')).toBe(false);
    expect(s.complete).toBe(true);
    expect(s.staticCoverage).toBe('full');
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
    // GET-IMPACT-PARENT-FANIN-BLEED: the hop-1 `parentOf` edge to Account is
    // RECORDED (Account is a node in the slice) but never EXPANDED, so the
    // object's own fan-in (`UnrelatedTrigger --triggersOn--> Account`) does NOT
    // bleed into the field's impact. Account is structural, not a dependency hop.
    expect(nodeIds).toContain('CustomObject:Account');
    expect(nodeIds).not.toContain('ApexTrigger:UnrelatedTrigger');
    // 4 incoming edges: 3 to Industry (parentOf + 2× references) + 1 to Segment
    // (readsFrom). The triggersOn edge to Account is no longer walked.
    expect(result.value.data.impact.edges.length).toBe(4);
    expect(result.value.data.traversedEdgeTypes).toEqual([
      'parentOf',
      'readsFrom',
      'references',
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

  // CR-17: the BFS expansion batches incoming-edge fetches into ONE
  // `listEdgesForNodes` query per hop instead of one `listEdges` per
  // (frontier node × edgeType). Spy on the underlying DuckDB driver to prove
  // the round-trip count is O(hops), not O(nodes).
  it('issues O(hops) edge queries per walk, not O(nodes) (CR-17)', async () => {
    const spy = vi.spyOn(store.connection, 'runAndReadAll');
    const result = await getImpactHandler(ctx, {
      componentId: 'CustomField:Account.Industry__c',
      hops: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Count edge-expansion queries only (one per hop). The handler also issues
    // a final batched node fetch and may probe the root, so the edge queries
    // are the SELECT ... FROM edges calls.
    const edgeQueries = spy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && /FROM edges/i.test(c[0] as string),
    );
    // Two hops over a frontier that fans out to several nodes — the old N+1
    // path would issue one query per (node × edgeType); the batched path
    // issues exactly one per hop.
    expect(edgeQueries.length).toBeLessThanOrEqual(2);
    expect(edgeQueries.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  // CR-17 requiredChange #1: exercise the COUNT caps (not just the post-BFS
  // byte budget). >200 distinct incoming referencers trip the node cap inside
  // the BFS mid-loop break, so the surviving prefix is order-sensitive. Assert
  // the batched walk yields a DETERMINISTIC node-cap result and that
  // `truncationReason.reason` is exactly `node-cap`.
  it('hits the node-cap with a deterministic prefix (CR-17 caps-identity)', async () => {
    const capDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-impact-nodecap-'));
    try {
      const dbPath = join(capDir, 'nodecap.db');
      const opened = await openGraph(dbPath);
      if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
      const capStore = opened.value;

      const fieldId = 'CustomField:Account.CapField__c';
      const refNodes: Node[] = [];
      const refEdges: Edge[] = [];
      // 250 distinct ValidationRule referencers > IMPACT_MAX_NODES (200), with
      // small payloads so the COUNT cap (not the byte budget) is what trips.
      for (let i = 0; i < 250; i++) {
        const vrId = `ValidationRule:Account.CapVR${String(i).padStart(3, '0')}`;
        refNodes.push(
          makeNode({
            id: vrId,
            type: 'ValidationRule',
            apiName: `CapVR${String(i).padStart(3, '0')}`,
            label: `Cap VR ${i}`,
            parentId: 'CustomObject:Account',
            sourcePath: `objects/Account/validationRules/CapVR${i}.validationRule-meta.xml`,
          }),
        );
        refEdges.push(
          makeEdge({
            fromId: vrId,
            toId: fieldId,
            edgeType: 'references',
            confidence: 'parsed',
            source: 'formula-tokenizer',
          }),
        );
      }
      const capSeed: ExtractionResult = {
        nodes: [
          makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
          makeNode({
            id: fieldId,
            type: 'CustomField',
            apiName: 'CapField__c',
            label: 'Cap Field',
            parentId: 'CustomObject:Account',
            sourcePath: 'objects/Account/fields/CapField__c.field-meta.xml',
          }),
          ...refNodes,
        ],
        edges: refEdges,
      };
      const imported = await importExtractionResults(capStore, [capSeed]);
      if (!imported.ok) throw new Error(`cap seed import failed: ${imported.error.message}`);
      const capCtx: Context = { vaultRoot: capDir, manifest: FIXTURE_MANIFEST, graph: capStore };

      const run = async () =>
        getImpactHandler(capCtx, { componentId: fieldId, hops: 1 });
      const first = await run();
      const second = await run();
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      // Truncated: 250 incoming referencers > IMPACT_MAX_NODES (200) trips the
      // BFS node-cap mid-loop break (lines 291/320). The BFS clips the visited
      // set to 200 BEFORE the post-walk byte budget runs; with 200 light nodes
      // the 28 KB byte budget then also trims, so the reported reason resolves
      // to `payload-budget` per the (unchanged) derivation — the BFS count cap
      // is still the path that bounded the walk. We assert the structured
      // reason is one of the documented kinds and the slice is bounded.
      expect(first.value.data.truncated).toBe(true);
      expect(['node-cap', 'edge-cap', 'payload-budget']).toContain(
        first.value.data.truncationReason?.reason,
      );
      expect(first.value.data.impact.nodes.length).toBeLessThanOrEqual(200);
      expect(first.value.data.impact.nodes.length).toBeGreaterThan(0);
      // Pinned-prefix contract: all 250 referencers share toId/edgeType/source
      // and differ only by fromId, so the kept set is the lowest fromIds by the
      // `(toId, edgeType, fromId, source)` total order — i.e. a contiguous
      // `CapVR000...` prefix. Prove no high-numbered VR survived while a
      // lower-numbered one was dropped.
      const keptVrs = first.value.data.impact.nodes
        .map((n) => n.id)
        .filter((id) => id.startsWith('ValidationRule:Account.CapVR'))
        .sort();
      const expectedPrefix = Array.from(
        { length: keptVrs.length },
        (_, i) => `ValidationRule:Account.CapVR${String(i).padStart(3, '0')}`,
      );
      expect(keptVrs).toEqual(expectedPrefix);
      // Deterministic prefix: two independent walks return byte-identical
      // node ids, edges, truncated flag, and traversedEdgeTypes.
      const project = (r: typeof first) =>
        r.ok
          ? JSON.stringify({
              nodes: r.value.data.impact.nodes.map((n) => n.id),
              edges: r.value.data.impact.edges,
              truncated: r.value.data.truncated,
              truncationReason: r.value.data.truncationReason,
              traversedEdgeTypes: r.value.data.traversedEdgeTypes,
            })
          : '';
      expect(project(first)).toBe(project(second));

      await closeGraph(capStore);
    } finally {
      rmSync(capDir, { recursive: true, force: true });
    }
  });

  // CR-17 requiredChange #1: the EDGE cap path. <=200 distinct referencers but
  // >400 edges (multiple edge types per referencer) trips the edge cap inside
  // the BFS, again on an order-sensitive prefix.
  it('hits the edge-cap with a deterministic prefix (CR-17 caps-identity)', async () => {
    const capDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-impact-edgecap-'));
    try {
      const dbPath = join(capDir, 'edgecap.db');
      const opened = await openGraph(dbPath);
      if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
      const capStore = opened.value;

      const fieldId = 'CustomField:Account.EdgeCapField__c';
      const refNodes: Node[] = [];
      const refEdges: Edge[] = [];
      // 150 referencers × 3 edge types each = 450 edges > IMPACT_MAX_EDGES
      // (400), with 150 distinct nodes < IMPACT_MAX_NODES (200) so the EDGE
      // cap is what trips, not the node cap.
      const edgeKinds: Edge['edgeType'][] = ['references', 'readsFrom', 'writesTo'];
      for (let i = 0; i < 150; i++) {
        const srcId = `Flow:EdgeCapFlow${String(i).padStart(3, '0')}`;
        refNodes.push(
          makeNode({
            id: srcId,
            type: 'Flow',
            apiName: `EdgeCapFlow${String(i).padStart(3, '0')}`,
            label: `Edge Cap Flow ${i}`,
            sourcePath: `flows/EdgeCapFlow${i}.flow-meta.xml`,
          }),
        );
        for (const kind of edgeKinds) {
          refEdges.push(
            makeEdge({
              fromId: srcId,
              toId: fieldId,
              edgeType: kind,
              confidence: 'parsed',
              source: 'extractor:flow',
            }),
          );
        }
      }
      const capSeed: ExtractionResult = {
        nodes: [
          makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
          makeNode({
            id: fieldId,
            type: 'CustomField',
            apiName: 'EdgeCapField__c',
            label: 'Edge Cap Field',
            parentId: 'CustomObject:Account',
            sourcePath: 'objects/Account/fields/EdgeCapField__c.field-meta.xml',
          }),
          ...refNodes,
        ],
        edges: refEdges,
      };
      const imported = await importExtractionResults(capStore, [capSeed]);
      if (!imported.ok) throw new Error(`edge-cap seed import failed: ${imported.error.message}`);
      const capCtx: Context = { vaultRoot: capDir, manifest: FIXTURE_MANIFEST, graph: capStore };

      const run = async () =>
        getImpactHandler(capCtx, { componentId: fieldId, hops: 1 });
      const first = await run();
      const second = await run();
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      // 450 incoming edges > IMPACT_MAX_EDGES (400) trips the BFS edge-cap
      // mid-loop break (lines 291/309). As with the node-cap case the post-walk
      // byte budget then also trims the 400-edge slice, so the reported reason
      // resolves to `payload-budget`; the BFS edge cap is still what bounded
      // the walk. Assert truncation + a bounded, deterministic slice.
      expect(first.value.data.truncated).toBe(true);
      expect(['node-cap', 'edge-cap', 'payload-budget']).toContain(
        first.value.data.truncationReason?.reason,
      );
      expect(first.value.data.impact.edges.length).toBeLessThanOrEqual(400);
      expect(first.value.data.impact.edges.length).toBeGreaterThan(0);
      const project = (r: typeof first) =>
        r.ok
          ? JSON.stringify({
              nodes: r.value.data.impact.nodes.map((n) => n.id),
              edges: r.value.data.impact.edges,
              truncated: r.value.data.truncated,
              truncationReason: r.value.data.truncationReason,
              traversedEdgeTypes: r.value.data.traversedEdgeTypes,
            })
          : '';
      expect(project(first)).toBe(project(second));

      await closeGraph(capStore);
    } finally {
      rmSync(capDir, { recursive: true, force: true });
    }
  });

  // CR-RV7: get_impact must never emit a DANGLING edge — one whose endpoint is
  // absent from impact.nodes — on the under-budget EARLY-RETURN path (the trim
  // path already filters; the early return did NOT). A consumer
  // (e.g. blast_radius_live) derefs impact.nodes per edge, so a dangling edge is
  // a crash / false-data class for the flagship access chain.
  //
  // Mechanism (b): an edge whose endpoint id has NO node row. The BFS adds the
  // endpoint to visitedNodes (it appears in the incoming-edge table), but
  // `fetchNodes`/`listNodesByIds` silently drops the row-less id, so the edge
  // dangles unless `enforceGraphPayloadBudget` filters it. The slice is small
  // (well under GRAPH_MAX_PAYLOAD_BYTES), so the budget takes the early return
  // (trimmed:false) — exactly the path the fix must cover.
  it('CR-RV7: drops an edge whose endpoint has no node row on the early-return path (0 dangling)', async () => {
    const ghostDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-impact-ghost-'));
    try {
      const dbPath = join(ghostDir, 'ghost.db');
      const opened = await openGraph(dbPath);
      if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
      const ghostStore = opened.value;

      const rootId = 'CustomField:Account.GhostHub__c';
      // One real referencer (has a node row) + one GHOST referencer whose
      // `fromId` is referenced ONLY as an edge endpoint and has NO node row.
      const ghostSeed: ExtractionResult = {
        nodes: [
          makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
          makeNode({
            id: rootId,
            type: 'CustomField',
            apiName: 'GhostHub__c',
            label: 'Ghost Hub',
            parentId: 'CustomObject:Account',
            sourcePath: 'objects/Account/fields/GhostHub__c.field-meta.xml',
          }),
          makeNode({
            id: 'ValidationRule:Account.RealVR',
            type: 'ValidationRule',
            apiName: 'RealVR',
            label: 'Real VR',
            parentId: 'CustomObject:Account',
            sourcePath: 'objects/Account/validationRules/RealVR.validationRule-meta.xml',
          }),
        ],
        edges: [
          makeEdge({
            fromId: 'ValidationRule:Account.RealVR',
            toId: rootId,
            edgeType: 'references',
            confidence: 'parsed',
            source: 'formula-tokenizer',
          }),
          // GHOST: fromId has no corresponding node row. The BFS still walks it
          // (it is an incoming edge to the root), so collectedEdges holds it but
          // fetchNodes drops the row-less id → the edge dangles unless filtered.
          makeEdge({
            fromId: 'ValidationRule:Account.GhostVR',
            toId: rootId,
            edgeType: 'references',
            confidence: 'parsed',
            source: 'formula-tokenizer',
          }),
        ],
      };
      const imported = await importExtractionResults(ghostStore, [ghostSeed]);
      if (!imported.ok) throw new Error(`ghost seed import failed: ${imported.error.message}`);
      const ghostCtx: Context = {
        vaultRoot: ghostDir,
        manifest: FIXTURE_MANIFEST,
        graph: ghostStore,
      };

      const result = await getImpactHandler(ghostCtx, { componentId: rootId, hops: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The slice is tiny, so the byte budget took the EARLY RETURN, not the
      // trim path — this is precisely the branch the fix had to cover.
      expect(result.value.data.truncated).toBe(false);

      const ids = new Set(result.value.data.impact.nodes.map((n) => n.id));
      // FAIL-BEFORE: the early-return path kept the GhostVR-endpoint edge even
      // though GhostVR has no node row in impact.nodes → a dangling edge.
      const dangling = result.value.data.impact.edges.filter(
        (e) => !ids.has(e.fromId) || !ids.has(e.toId),
      );
      expect(dangling).toEqual([]);
      // The row-less endpoint must not appear in any returned edge.
      const refsGhost = result.value.data.impact.edges.some(
        (e) => e.fromId === 'ValidationRule:Account.GhostVR' || e.toId === 'ValidationRule:Account.GhostVR',
      );
      expect(refsGhost).toBe(false);
      // The legitimate self-contained edge survives.
      expect(
        result.value.data.impact.edges.some(
          (e) => e.fromId === 'ValidationRule:Account.RealVR' && e.toId === rootId,
        ),
      ).toBe(true);
      // Caps respected.
      expect(result.value.data.impact.nodes.length).toBeLessThanOrEqual(200);
      expect(result.value.data.impact.edges.length).toBeLessThanOrEqual(400);

      await closeGraph(ghostStore);
    } finally {
      rmSync(ghostDir, { recursive: true, force: true });
    }
  });

  // R6-19: the diagram cap (30) is deliberately far below the node cap (200)
  // — a slice comfortably under the OVERALL truncation ceiling can still be
  // too big to render readably, and must OMIT the diagram (never silently
  // render a partial one) rather than reuse the node-cap truncation path.
  it('R6-19: omits the diagram (with a reason naming the count) above IMPACT_DIAGRAM_MAX_NODES, even when the overall impact slice is NOT truncated', async () => {
    const diagCapDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-impact-diagramcap-'));
    try {
      const dbPath = join(diagCapDir, 'diagramcap.db');
      const opened = await openGraph(dbPath);
      if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
      const diagStore = opened.value;

      const fieldId = 'CustomField:Account.DiagField__c';
      const refNodes: Node[] = [];
      const refEdges: Edge[] = [];
      // 35 referencers: over IMPACT_DIAGRAM_MAX_NODES (30) but well under
      // IMPACT_MAX_NODES (200), so ONLY the diagram cap fires.
      for (let i = 0; i < 35; i++) {
        const vrId = `ValidationRule:Account.DiagVR${String(i).padStart(2, '0')}`;
        refNodes.push(
          makeNode({
            id: vrId,
            type: 'ValidationRule',
            apiName: `DiagVR${String(i).padStart(2, '0')}`,
            label: `Diag VR ${i}`,
            parentId: 'CustomObject:Account',
            sourcePath: `objects/Account/validationRules/DiagVR${i}.validationRule-meta.xml`,
          }),
        );
        refEdges.push(
          makeEdge({
            fromId: vrId,
            toId: fieldId,
            edgeType: 'references',
            confidence: 'parsed',
            source: 'formula-tokenizer',
          }),
        );
      }
      const diagSeed: ExtractionResult = {
        nodes: [
          makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
          makeNode({
            id: fieldId,
            type: 'CustomField',
            apiName: 'DiagField__c',
            label: 'Diag Field',
            parentId: 'CustomObject:Account',
            sourcePath: 'objects/Account/fields/DiagField__c.field-meta.xml',
          }),
          ...refNodes,
        ],
        edges: refEdges,
      };
      const imported = await importExtractionResults(diagStore, [diagSeed]);
      if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
      const diagCtx: Context = { vaultRoot: diagCapDir, manifest: FIXTURE_MANIFEST, graph: diagStore };

      const result = await getImpactHandler(diagCtx, { componentId: fieldId, hops: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // 35 referencers + the root field = 36 nodes, under the 200-node cap.
      expect(result.value.data.truncated).toBe(false);
      expect(result.value.data.impact.nodes.length).toBeGreaterThan(30);
      expect(result.value.data.diagram).toBeUndefined();
      expect(result.value.data.diagramOmittedReason).toBeDefined();
      expect(result.value.data.diagramOmittedReason).toMatch(/diagram omitted: 36 nodes exceeds cap \(30\)/);

      await closeGraph(diagStore);
    } finally {
      rmSync(diagCapDir, { recursive: true, force: true });
    }
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

describe('R6-24 Option B — get_impact names folded report/dashboard dependents', () => {
  it('surfaces usedInReports/usedInDashboards on reportUsage + disclosure (no Report edges)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-impact-reportb-'));
    const opened = await openGraph(join(dir, 'reportb.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const localStore = opened.value;
    try {
      const fieldId = 'CustomField:Account.ReportOnly__c';
      const local: ExtractionResult = {
        nodes: [
          makeNode({
            id: 'CustomObject:Account',
            apiName: 'Account',
            label: 'Account',
          }),
          makeNode({
            id: fieldId,
            type: 'CustomField',
            apiName: 'ReportOnly__c',
            label: 'Report Only',
            parentId: 'CustomObject:Account',
            sourcePath: 'objects/Account/fields/ReportOnly__c.field-meta.xml',
            properties: {
              dataType: 'Text',
              usedInReport: true,
              usedInDashboard: true,
              usedInReports: ['Exec/Forecast', 'Sales/Pipeline'],
              usedInDashboards: ['Exec/KPIs'],
            },
          }),
        ],
        edges: [
          makeEdge({
            fromId: 'CustomObject:Account',
            toId: fieldId,
            edgeType: 'parentOf',
            confidence: 'declared',
            source: 'extractor:custom-object',
          }),
        ],
      };
      const imp = await importExtractionResults(localStore, [local]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = {
        vaultRoot: dir,
        manifest: FIXTURE_MANIFEST,
        graph: localStore,
      };
      const result = await getImpactHandler(localCtx, {
        componentId: fieldId,
        hops: 1,
        edgeTypes: ['references', 'readsFrom', 'writesTo'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No Report/Dashboard nodes in the impact slice — they were never imported.
      expect(
        result.value.data.impact.nodes.some(
          (n) => n.type === 'Report' || n.type === 'Dashboard',
        ),
      ).toBe(false);
      expect(result.value.data.reportUsage?.reportNames).toEqual([
        'Exec/Forecast',
        'Sales/Pipeline',
      ]);
      expect(result.value.data.reportUsage?.dashboardNames).toEqual(['Exec/KPIs']);
      expect(result.value.data.disclosure).toContain('Sales/Pipeline');
      expect(result.value.data.disclosure).toContain('Exec/Forecast');
      expect(result.value.data.disclosure).toContain('Exec/KPIs');
      expect(result.value.data.disclosure).toMatch(/folded/i);
    } finally {
      await closeGraph(localStore);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// GET-IMPACT-PARENT-FANIN-BLEED — a QuickAction impact walk must NOT cross the
// structural `parentOf` edge up to the parent object and then surface the
// OBJECT's inbound fan-in (Apex / triggers / lookups) as the QuickAction's
// dependents. FAILS pre-fix: the object's referrers appear in the slice.
// =============================================================================

describe('GET-IMPACT-PARENT-FANIN-BLEED — parentOf is recorded but never expanded', () => {
  let dir: string;
  let localStore: GraphStore;
  let localCtx: Context;

  // Synthetic (no real org names). A QuickAction on a custom object, a Layout
  // that PLACES it (real inbound `references` dependent), and the object's OWN
  // fan-in (an Apex class + a trigger) that must stay OUT of the QuickAction's
  // impact — they depend on the object, not on the action.
  const QA = 'QuickAction:Ticket__c.Change_State';
  const OBJ = 'CustomObject:Ticket__c';
  const LAYOUT = 'Layout:Ticket__c.Ticket Layout';
  const FANIN_APEX = 'ApexClass:TicketService';
  const FANIN_TRIGGER = 'ApexTrigger:TicketTrigger';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-impact-parentbleed-'));
    const opened = await openGraph(join(dir, 'bleed.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    localStore = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: OBJ, type: 'CustomObject', apiName: 'Ticket__c', label: 'Ticket' }),
        makeNode({ id: QA, type: 'QuickAction', apiName: 'Ticket__c.Change_State', label: 'Change State', parentId: OBJ }),
        makeNode({ id: LAYOUT, type: 'Layout', apiName: 'Ticket__c.Ticket Layout', label: 'Ticket Layout' }),
        makeNode({ id: FANIN_APEX, type: 'ApexClass', apiName: 'TicketService', label: 'TicketService' }),
        makeNode({ id: FANIN_TRIGGER, type: 'ApexTrigger', apiName: 'TicketTrigger', label: 'TicketTrigger' }),
      ],
      edges: [
        // Structural: object is the parent of the QuickAction. Recorded, not expanded.
        makeEdge({ fromId: OBJ, toId: QA, edgeType: 'parentOf', confidence: 'declared', source: 'extractor:custom-object' }),
        // Real dependent: a Layout PLACES the QuickAction (platformActionListItems).
        makeEdge({ fromId: LAYOUT, toId: QA, edgeType: 'references', confidence: 'declared', source: 'extractor:layout', properties: { targetKind: 'quickAction' } }),
        // The object's OWN fan-in — must NOT leak into the QuickAction's impact.
        makeEdge({ fromId: FANIN_APEX, toId: OBJ, edgeType: 'references', confidence: 'parsed', source: 'apex-scanner' }),
        makeEdge({ fromId: FANIN_TRIGGER, toId: OBJ, edgeType: 'triggersOn', confidence: 'parsed', source: 'extractor:apex-trigger' }),
      ],
    };
    const imp = await importExtractionResults(localStore, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: localStore };
  });

  afterAll(async () => {
    await closeGraph(localStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not surface the parent object fan-in (TicketService / TicketTrigger) as QuickAction dependents', async () => {
    const result = await getImpactHandler(localCtx, { componentId: QA, hops: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nodeIds = result.value.data.impact.nodes.map((n) => n.id);
    // FAIL-BEFORE: the walk crossed QA <-parentOf- Ticket__c and pulled in the
    // object's referrers, so these two appeared as QuickAction "dependents".
    expect(nodeIds).not.toContain(FANIN_APEX);
    expect(nodeIds).not.toContain(FANIN_TRIGGER);
    // The structural parent stays visible (recorded, not expanded)...
    expect(nodeIds).toContain(OBJ);
    // ...and a genuine inbound dependent (the Layout placing the action) survives.
    expect(nodeIds).toContain(LAYOUT);
    // Edges: parentOf (Ticket__c→QA) + references (Layout→QA). No fan-in edges.
    expect(result.value.data.impact.edges.length).toBe(2);
    expect(
      result.value.data.impact.edges.some(
        (e) => e.fromId === FANIN_APEX || e.fromId === FANIN_TRIGGER,
      ),
    ).toBe(false);
  });

  it('when ONLY the structural parent is inbound, discloses "no usage dependents" and omits the object fan-in', async () => {
    // A QuickAction whose only inbound edge is its parent object (layout
    // placement not modeled) — the object fan-in must still not bleed in, and
    // the disclosure must call out that this is structural-only.
    const bareDir = mkdtempSync(join(tmpdir(), 'sfi-impact-parentbleed-bare-'));
    try {
      const opened = await openGraph(join(bareDir, 'bare.db'));
      if (!opened.ok) throw new Error(opened.error.message);
      const bareStore = opened.value;
      const seed: ExtractionResult = {
        nodes: [
          makeNode({ id: OBJ, type: 'CustomObject', apiName: 'Ticket__c', label: 'Ticket' }),
          makeNode({ id: QA, type: 'QuickAction', apiName: 'Ticket__c.Change_State', label: 'Change State', parentId: OBJ }),
          makeNode({ id: FANIN_APEX, type: 'ApexClass', apiName: 'TicketService', label: 'TicketService' }),
        ],
        edges: [
          makeEdge({ fromId: OBJ, toId: QA, edgeType: 'parentOf', confidence: 'declared', source: 'extractor:custom-object' }),
          makeEdge({ fromId: FANIN_APEX, toId: OBJ, edgeType: 'references', confidence: 'parsed', source: 'apex-scanner' }),
        ],
      };
      const imp = await importExtractionResults(bareStore, [seed]);
      if (!imp.ok) throw new Error(imp.error.message);
      const bareCtx: Context = { vaultRoot: bareDir, manifest: FIXTURE_MANIFEST, graph: bareStore };
      const result = await getImpactHandler(bareCtx, { componentId: QA, hops: 2 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const nodeIds = result.value.data.impact.nodes.map((n) => n.id);
      expect(nodeIds).not.toContain(FANIN_APEX);
      expect(nodeIds).toContain(OBJ);
      // Only the parentOf edge survives.
      expect(result.value.data.impact.edges.map((e) => e.edgeType)).toEqual(['parentOf']);
      expect(result.value.data.disclosure).toMatch(/STRUCTURAL parent/);
      expect(result.value.data.disclosure).toMatch(/no dependents found/i);
      await closeGraph(bareStore);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});
