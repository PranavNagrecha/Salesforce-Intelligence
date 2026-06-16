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
  getSubgraphHandler,
  getSubgraphInputSchema,
} from '../../src/tools/get-subgraph.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 2, ApexTrigger: 1 },
  edges: { parentOf: 2, triggersOn: 1 },
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
  edgeType: 'parentOf',
  confidence: 'declared',
  source: 'extractor:custom-object',
  properties: {},
  ...overrides,
});

// Account has two CustomField children (parentOf edges, 1 hop away). One
// of those fields is referenced by a Trigger via `triggersOn` (2 hops
// from Account). This shape lets us exercise the 1-hop, 2-hop, and
// default-hops cases in a single fixture.
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      apiName: 'Account',
      label: 'Account',
    }),
    makeNode({
      id: 'CustomField:Account.AlphaField__c',
      type: 'CustomField',
      apiName: 'AlphaField__c',
      label: 'Alpha',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/AlphaField__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Account.BetaField__c',
      type: 'CustomField',
      apiName: 'BetaField__c',
      label: 'Beta',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/BetaField__c.field-meta.xml',
    }),
    makeNode({
      id: 'ApexTrigger:AlphaFieldTrigger',
      type: 'ApexTrigger',
      apiName: 'AlphaFieldTrigger',
      label: 'AlphaFieldTrigger',
      sourcePath: 'triggers/AlphaFieldTrigger.trigger',
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.AlphaField__c',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'extractor:custom-object',
    }),
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.BetaField__c',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'extractor:custom-object',
    }),
    makeEdge({
      fromId: 'ApexTrigger:AlphaFieldTrigger',
      toId: 'CustomField:Account.AlphaField__c',
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
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-subgraph-'));
  const dbPath = join(tempDir, 'get-subgraph.db');
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

describe('getSubgraphHandler', () => {
  it('returns the root plus its 1-hop neighbors for the seed', async () => {
    const result = await getSubgraphHandler(ctx, {
      rootId: 'CustomObject:Account',
      hops: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Account + 2 child fields = 3 nodes; the two parentOf edges = 2 edges.
    // The Trigger lives 2 hops away and must not appear in a 1-hop slice.
    expect(result.value.data.nodes.length).toBe(3);
    expect(result.value.data.edges.length).toBe(2);
    const nodeIds = result.value.data.nodes.map((n) => n.id);
    expect(nodeIds).toContain('CustomObject:Account');
    expect(nodeIds).toContain('CustomField:Account.AlphaField__c');
    expect(nodeIds).toContain('CustomField:Account.BetaField__c');
    expect(nodeIds).not.toContain('ApexTrigger:AlphaFieldTrigger');
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-27T14:33:08Z');
    // A small slice is not clipped; the disclosure is always present.
    expect(result.value.data.truncated).toBe(false);
    expect(typeof result.value.data.disclosure).toBe('string');
    expect(result.value.data.disclosure.length).toBeGreaterThan(0);
  });

  it('reaches the trigger 2 hops away when hops=2', async () => {
    const result = await getSubgraphHandler(ctx, {
      rootId: 'CustomObject:Account',
      hops: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Account → fields (hop 1) → trigger via field (hop 2). All four
    // nodes and all three edges in the seed are in the connected slice.
    expect(result.value.data.nodes.length).toBe(4);
    expect(result.value.data.edges.length).toBe(3);
    const nodeIds = result.value.data.nodes.map((n) => n.id);
    expect(nodeIds).toContain('ApexTrigger:AlphaFieldTrigger');
  });

  it('defaults to hops=1 when the caller omits it', async () => {
    // Omitting `hops` must produce the same slice as explicit `hops: 1`;
    // the default lives in the handler so this guards against a silent
    // change in the contract.
    const omitted = await getSubgraphHandler(ctx, {
      rootId: 'CustomObject:Account',
    });
    const explicit = await getSubgraphHandler(ctx, {
      rootId: 'CustomObject:Account',
      hops: 1,
    });
    expect(omitted.ok).toBe(true);
    expect(explicit.ok).toBe(true);
    if (!omitted.ok || !explicit.ok) return;
    expect(omitted.value.data.nodes.length).toBe(
      explicit.value.data.nodes.length,
    );
    expect(omitted.value.data.edges.length).toBe(
      explicit.value.data.edges.length,
    );
    const omittedIds = omitted.value.data.nodes.map((n) => n.id).sort();
    const explicitIds = explicit.value.data.nodes.map((n) => n.id).sort();
    expect(omittedIds).toEqual(explicitIds);
  });

  it('returns an empty subgraph for an unknown rootId', async () => {
    const result = await getSubgraphHandler(ctx, {
      rootId: 'CustomObject:DoesNotExist',
    });
    // `graph.getSubgraph` cannot distinguish "missing root" from "root
    // with no incident edges"; both surface here as an empty subgraph.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.nodes.length).toBe(0);
    expect(result.value.data.edges.length).toBe(0);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('slims fat nodes and trims to the byte budget on a hub (response stays consumable)', async () => {
    // A hub root with many fat PermissionSet nodes (each a ~2.7 KB inlined grant
    // matrix). The node/edge COUNT caps alone would still let a ~500 KB slice
    // through; the byte budget must keep the serialized slice consumable.
    const heavyDir = mkdtempSync(join(tmpdir(), 'sfi-subgraph-heavy-'));
    const opened = await openGraph(join(heavyDir, 'heavy.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const heavyStore = opened.value;
    try {
      const ROOT = 'CustomObject:HubObj';
      const fatMatrix = Array.from({ length: 60 }, (_, i) => ({
        object: `Obj_${i}__c`,
        read: true,
        edit: i % 2 === 0,
      }));
      const nodes: Node[] = [
        makeNode({ id: ROOT, type: 'CustomObject', apiName: 'HubObj' }),
      ];
      const edges: Edge[] = [];
      for (let i = 0; i < 250; i += 1) {
        const pid = `PermissionSet:PS_${String(i).padStart(3, '0')}`;
        nodes.push(
          makeNode({
            id: pid,
            type: 'PermissionSet',
            apiName: `PS_${i}`,
            properties: { grants: fatMatrix },
          }),
        );
        edges.push(makeEdge({ fromId: pid, toId: ROOT, edgeType: 'grantedBy' }));
      }
      const imported = await importExtractionResults(heavyStore, [
        { nodes, edges },
      ]);
      if (!imported.ok) throw new Error(imported.error.message);
      const heavyCtx: Context = {
        vaultRoot: heavyDir,
        manifest: FIXTURE_MANIFEST,
        graph: heavyStore,
      };
      const result = await getSubgraphHandler(heavyCtx, {
        rootId: ROOT,
        hops: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { nodes: outNodes, edges: outEdges, truncated, disclosure } =
        result.value.data;
      // The serialized slice fits the MCP response budget (was ~500 KB).
      const bytes = Buffer.byteLength(
        JSON.stringify({ nodes: outNodes, edges: outEdges }),
        'utf8',
      );
      expect(bytes).toBeLessThanOrEqual(28_000);
      expect(truncated).toBe(true);
      expect(disclosure).toContain('budget');
      // A surviving fat node's matrix is summarised, not inlined.
      const fatNode = outNodes.find((n) => n.type === 'PermissionSet');
      expect(
        (fatNode?.properties as Record<string, unknown> | undefined)?.grants,
      ).toMatchObject({ __omitted: true });
    } finally {
      await closeGraph(heavyStore);
      rmSync(heavyDir, { recursive: true, force: true });
    }
  });
});

describe('getSubgraphInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = getSubgraphInputSchema.safeParse({
      rootId: 'CustomObject:Account',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts hops at the upper bound (3)', () => {
    const parsed = getSubgraphInputSchema.safeParse({
      rootId: 'CustomObject:Account',
      hops: 3,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects hops greater than 3', () => {
    const parsed = getSubgraphInputSchema.safeParse({
      rootId: 'CustomObject:Account',
      hops: 4,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects hops=0', () => {
    const parsed = getSubgraphInputSchema.safeParse({
      rootId: 'CustomObject:Account',
      hops: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative hops value', () => {
    const parsed = getSubgraphInputSchema.safeParse({
      rootId: 'CustomObject:Account',
      hops: -1,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer hops value', () => {
    const parsed = getSubgraphInputSchema.safeParse({
      rootId: 'CustomObject:Account',
      hops: 1.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty rootId string', () => {
    const parsed = getSubgraphInputSchema.safeParse({ rootId: '' });
    expect(parsed.success).toBe(false);
  });
});
