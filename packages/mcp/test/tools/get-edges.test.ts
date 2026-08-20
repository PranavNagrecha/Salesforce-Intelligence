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
  getEdgesHandler,
  getEdgesInputSchema,
} from '../../src/tools/get-edges.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3, CustomField: 1, Flow: 1 },
  edges: { parentOf: 1, references: 1, triggersOn: 1 },
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

// A → B (parentOf, declared), A → C (references, parsed), and a third
// triggersOn edge from a Flow into A that we use to exercise the
// direction='in' branch independently of the two outgoing edges above.
const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:A', apiName: 'A', label: 'A' }),
    makeNode({ id: 'CustomObject:B', apiName: 'B', label: 'B' }),
    makeNode({ id: 'CustomObject:C', apiName: 'C', label: 'C' }),
    makeNode({
      id: 'Flow:Triggered',
      type: 'Flow',
      apiName: 'Triggered',
      label: 'Triggered Flow',
      sourcePath: 'flows/Triggered.flow-meta.xml',
    }),
    makeNode({
      id: 'CustomField:A.Region__c',
      type: 'CustomField',
      apiName: 'Region__c',
      label: 'Region',
      parentId: 'CustomObject:A',
      sourcePath: 'objects/A/fields/Region__c.field-meta.xml',
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'CustomObject:A',
      toId: 'CustomObject:B',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'extractor:custom-object',
    }),
    makeEdge({
      fromId: 'CustomObject:A',
      toId: 'CustomObject:C',
      edgeType: 'references',
      confidence: 'parsed',
      source: 'extractor:references',
    }),
    makeEdge({
      fromId: 'Flow:Triggered',
      toId: 'CustomObject:A',
      edgeType: 'triggersOn',
      confidence: 'parsed',
      source: 'extractor:flow',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-edges-'));
  const dbPath = join(tempDir, 'get-edges.db');
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

describe('getEdgesHandler', () => {
  it('returns every incident edge when no direction filter is provided', async () => {
    const result = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Two outgoing (A→B, A→C) and one incoming (Flow→A) = 3 total.
    expect(result.value.data.edges.length).toBe(3);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-27T14:33:08Z');
  });

  it('returns only outgoing edges when direction=out', async () => {
    const result = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:A',
      direction: 'out',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.edges.length).toBe(2);
    for (const edge of result.value.data.edges) {
      expect(edge.fromId).toBe('CustomObject:A');
    }
  });

  it('returns only incoming edges when direction=in', async () => {
    const result = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:B',
      direction: 'in',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only A→B targets B.
    expect(result.value.data.edges.length).toBe(1);
    expect(result.value.data.edges[0]!.toId).toBe('CustomObject:B');
    expect(result.value.data.edges[0]!.fromId).toBe('CustomObject:A');
  });

  it('returns both directions when direction=both', async () => {
    const result = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:A',
      direction: 'both',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same result as omitting direction (the underlying default).
    expect(result.value.data.edges.length).toBe(3);
  });

  it('filters by edgeType', async () => {
    const result = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:A',
      edgeType: 'triggersOn',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.edges.length).toBe(1);
    expect(result.value.data.edges[0]!.edgeType).toBe('triggersOn');
  });

  it('filters by confidence', async () => {
    const result = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:A',
      confidence: 'declared',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the A→B parentOf edge is declared; the other two are parsed.
    expect(result.value.data.edges.length).toBe(1);
    expect(result.value.data.edges[0]!.confidence).toBe('declared');
  });

  it('returns an empty edge list when the nodeId is unknown', async () => {
    const result = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:DoesNotExist',
    });
    // listEdges cannot distinguish "no node" from "node has no edges";
    // both surface as a successful empty result.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.edges.length).toBe(0);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });
});

describe('getEdgesHandler — pagination (P10-A2)', () => {
  it('carries paging metadata on an unfiltered call (small node: all returned)', async () => {
    const result = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.edges.length).toBe(3);
    expect(d.totalCount).toBe(3);
    expect(d.hasMore).toBe(false);
    expect(d.nextOffset).toBeNull();
  });

  it('caps the page at `limit` and reports the true total + next cursor', async () => {
    const result = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A', limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.edges.length).toBe(2);
    expect(d.totalCount).toBe(3); // total is unpaged
    expect(d.hasMore).toBe(true);
    expect(d.nextOffset).toBe(2);
  });

  it('advances past the offset and exhausts the list', async () => {
    const result = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A', limit: 2, offset: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.edges.length).toBe(1); // 3 total, offset 2 → 1 left
    expect(d.totalCount).toBe(3);
    expect(d.hasMore).toBe(false);
    expect(d.nextOffset).toBeNull();
  });

  it('offset past the end returns an empty page with the true total', async () => {
    const result = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A', offset: 99 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.edges.length).toBe(0);
    expect(d.totalCount).toBe(3);
    expect(d.hasMore).toBe(false);
  });
});

describe('getEdgesHandler — CR-22 continuation cursor', () => {
  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const result = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // The pre-CR-22 shape: no nextCursor, no pageInfo, no note keys at all.
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect('note' in d).toBe(false);
    expect(Object.keys(d).sort()).toEqual(['edges', 'hasMore', 'nextOffset', 'totalCount']);
  });

  it('a truncated (over-limit) page emits a nextCursor that resumes the next page', async () => {
    const first = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A', limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const d1 = first.value.data;
    expect(d1.edges.length).toBe(2);
    expect(d1.hasMore).toBe(true);
    expect(d1.nextOffset).toBe(2);
    expect(typeof d1.nextCursor).toBe('string');
    expect(d1.pageInfo?.nextCursor).toBe(d1.nextCursor);

    // Resume with the opaque cursor (no offset).
    const second = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:A',
      limit: 2,
      cursor: d1.nextCursor as string,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const d2 = second.value.data;
    expect(d2.edges.length).toBe(1);
    expect(d2.hasMore).toBe(false);
    // No new cursor on the exhausted final page.
    expect('nextCursor' in d2).toBe(false);

    // The two pages concat to the full result with NO gaps/dupes.
    const ids = (es: typeof d1.edges) =>
      es.map((e) => `${e.fromId}|${e.toId}|${e.edgeType}|${e.source}`);
    const combined = [...ids(d1.edges), ...ids(d2.edges)];
    expect(new Set(combined).size).toBe(3); // no dupes
    const full = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A' });
    if (!full.ok) return;
    expect(combined.sort()).toEqual(ids(full.value.data.edges).sort()); // no gaps
  });

  it('rejects a cursor minted for a DIFFERENT query (changed filter)', async () => {
    const first = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A', limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    // Replay the cursor against the same tool/vault but a NARROWED query
    // (added an edgeType filter) → fingerprint mismatch → invalid-query.
    const replay = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:A',
      limit: 2,
      edgeType: 'parentOf',
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:A',
      cursor: 'not-a-real-cursor',
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.kind).toBe('invalid-query');
  });
});

describe('getEdgesInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = getEdgesInputSchema.safeParse({ nodeId: 'CustomObject:A' });
    expect(parsed.success).toBe(true);
  });

  it('accepts limit + offset and rejects out-of-range paging args', () => {
    expect(getEdgesInputSchema.safeParse({ nodeId: 'CustomObject:A', limit: 50, offset: 10 }).success).toBe(true);
    expect(getEdgesInputSchema.safeParse({ nodeId: 'CustomObject:A', limit: 0 }).success).toBe(false);
    expect(getEdgesInputSchema.safeParse({ nodeId: 'CustomObject:A', limit: 1001 }).success).toBe(false);
    expect(getEdgesInputSchema.safeParse({ nodeId: 'CustomObject:A', offset: -1 }).success).toBe(false);
  });

  it('rejects an empty nodeId string', () => {
    const parsed = getEdgesInputSchema.safeParse({ nodeId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown edgeType', () => {
    const parsed = getEdgesInputSchema.safeParse({
      nodeId: 'CustomObject:A',
      edgeType: 'notARealEdge',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts dispatchesOmniAction (the v3.2 OmniStudio edge) as an edgeType', () => {
    // Regression: this edge type (the dominant edge in an OmniStudio org) was
    // missing from the hand-listed enum, so the filter was rejected even though
    // the graph returns the edge. The enum now derives from contracts EDGE_TYPES.
    const parsed = getEdgesInputSchema.safeParse({
      nodeId: 'OmniScript:Foo',
      edgeType: 'dispatchesOmniAction',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown direction', () => {
    const parsed = getEdgesInputSchema.safeParse({
      nodeId: 'CustomObject:A',
      direction: 'sideways',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown confidence', () => {
    const parsed = getEdgesInputSchema.safeParse({
      nodeId: 'CustomObject:A',
      confidence: 'maybe',
    });
    expect(parsed.success).toBe(false);
  });

  it('normalizes the documented incoming/outgoing direction aliases (B3)', () => {
    const inc = getEdgesInputSchema.safeParse({
      nodeId: 'CustomObject:A',
      direction: 'incoming',
    });
    expect(inc.success).toBe(true);
    if (inc.success) expect(inc.data.direction).toBe('in');

    const out = getEdgesInputSchema.safeParse({
      nodeId: 'CustomObject:A',
      direction: 'outgoing',
    });
    expect(out.success).toBe(true);
    if (out.success) expect(out.data.direction).toBe('out');
  });
});

describe('sfi.get_edges — an unproduced edge type is disclosed, not silently empty', () => {
  // UNPRODUCED-EDGE-TYPE-READS-AS-PROVEN-NONE.
  //
  // `coversTest` is declared in the contract but emitted by ZERO extractors, so
  // `get_edges { edgeType: 'coversTest' }` is empty BY CONSTRUCTION. Without a
  // disclosure that empty list reads as "nothing covers this class" — the exact
  // proven-none-vs-not-checked conflation this product exists to prevent.
  //
  // `what_if_change_method_signature` was fixed for this; `get_edges` and
  // `get_impact` were not, even though both advertise the type as a selectable
  // filter. An earlier contract comment asserted the what-if tool was "the only
  // such consumer today", which was false when written.
  it('FAIL-BEFORE/PASS-AFTER: discloses that coversTest has no producer', async () => {
    const result = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:A',
      edgeType: 'coversTest',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data as { edges: readonly unknown[]; unproducedEdgeType?: string };

    // The empty result is real…
    expect(data.edges).toEqual([]);
    // …and it now says WHY, in a way that cannot be read as a proven none.
    expect(data.unproducedEdgeType).toBeDefined();
    expect(data.unproducedEdgeType).toMatch(/coversTest/);
    expect(data.unproducedEdgeType).toMatch(/EMPTY BY CONSTRUCTION/);
    expect(data.unproducedEdgeType).toMatch(/never as .*there is none/);
    // It must also distinguish itself from a coverage gap, which a refresh CAN close.
    expect(data.unproducedEdgeType).toMatch(/cannot populate it/);
  });

  it('stays byte-identical for a produced edge type (no new field)', async () => {
    const result = await getEdgesHandler(ctx, {
      nodeId: 'CustomObject:A',
      edgeType: 'parentOf',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data).not.toHaveProperty('unproducedEdgeType');
  });

  it('stays byte-identical when no edgeType filter is supplied', async () => {
    const result = await getEdgesHandler(ctx, { nodeId: 'CustomObject:A' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data).not.toHaveProperty('unproducedEdgeType');
  });
});
