/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import {
  saveSnapshot,
  type Snapshot,
  type SnapshotEdge,
  type SnapshotNode,
} from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import {
  diffSnapshotsHandler,
  diffSnapshotsInputSchema,
} from '../../src/tools/diff-snapshots.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Materialise a snapshot in-memory from a node + edge list using the
 *  same fields/hash-input as `captureSnapshotGraph`. The hashes here
 *  are hand-rolled to keep the test self-contained — what matters for
 *  the diff is whether two snapshots' hashes agree, not the exact
 *  bytes. */
const buildSnapshot = (
  label: string,
  nodes: readonly { id: string; type: string; apiName: string; label?: string | null; propertiesHash: string }[],
  edges: readonly { fromId: string; toId: string; edgeType: string; source: string; propertiesHash: string }[],
): Snapshot => ({
  meta: {
    label,
    createdAt: '2026-05-27T00:00:00.000Z',
    sourceTreeHash: 'sha256:fixture',
    componentCount: nodes.length,
    edgeCount: edges.length,
  },
  manifest: FIXTURE_MANIFEST,
  nodes: nodes.map((n) => ({
    id: n.id as SnapshotNode['id'],
    type: n.type as SnapshotNode['type'],
    apiName: n.apiName,
    label: n.label ?? null,
    propertiesHash: n.propertiesHash,
  })),
  edges: edges.map((e) => ({
    fromId: e.fromId as SnapshotEdge['fromId'],
    toId: e.toId as SnapshotEdge['toId'],
    edgeType: e.edgeType as SnapshotEdge['edgeType'],
    source: e.source,
    propertiesHash: e.propertiesHash,
  })),
});

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-diff-snapshots-'));
  const dbPath = join(tempDir, 'diff-snapshots.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
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

describe('diffSnapshotsHandler — identical snapshots', () => {
  it('returns empty added/removed/modified when both labels point at the same content', async () => {
    const snap = buildSnapshot(
      'identical-a',
      [
        { id: 'CustomObject:A', type: 'CustomObject', apiName: 'A', propertiesHash: 'hash-a' },
        { id: 'CustomObject:B', type: 'CustomObject', apiName: 'B', propertiesHash: 'hash-b' },
      ],
      [],
    );
    const saveA = await saveSnapshot(tempDir, { ...snap, meta: { ...snap.meta, label: 'identical-a' } });
    expect(saveA.ok).toBe(true);
    const saveB = await saveSnapshot(tempDir, { ...snap, meta: { ...snap.meta, label: 'identical-b' } });
    expect(saveB.ok).toBe(true);
    const result = await diffSnapshotsHandler(ctx, {
      fromLabel: 'identical-a',
      toLabel: 'identical-b',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
    expect(d.summary).toEqual({ addedCount: 0, removedCount: 0, modifiedCount: 0 });
    expect(d.truncated).toBe(false);
  });
});

describe('diffSnapshotsHandler — added components', () => {
  it('lists ids present in to-snapshot but not in from-snapshot under added', async () => {
    const fromSnap = buildSnapshot(
      'added-from',
      [{ id: 'CustomObject:Existing', type: 'CustomObject', apiName: 'Existing', propertiesHash: 'h-x' }],
      [],
    );
    const toSnap = buildSnapshot(
      'added-to',
      [
        { id: 'CustomObject:Existing', type: 'CustomObject', apiName: 'Existing', propertiesHash: 'h-x' },
        { id: 'CustomObject:NewlyAdded', type: 'CustomObject', apiName: 'NewlyAdded', propertiesHash: 'h-n' },
        { id: 'CustomField:Existing.New__c', type: 'CustomField', apiName: 'New__c', propertiesHash: 'h-f' },
      ],
      [],
    );
    expect((await saveSnapshot(tempDir, fromSnap)).ok).toBe(true);
    expect((await saveSnapshot(tempDir, toSnap)).ok).toBe(true);

    const result = await diffSnapshotsHandler(ctx, {
      fromLabel: 'added-from',
      toLabel: 'added-to',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.added.map((c) => c.id)).toEqual([
      'CustomField:Existing.New__c',
      'CustomObject:NewlyAdded',
    ]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
    expect(d.summary.addedCount).toBe(2);
  });
});

describe('diffSnapshotsHandler — removed components', () => {
  it('lists ids present in from-snapshot but not in to-snapshot under removed', async () => {
    const fromSnap = buildSnapshot(
      'removed-from',
      [
        { id: 'CustomObject:Kept', type: 'CustomObject', apiName: 'Kept', propertiesHash: 'h-k' },
        { id: 'CustomObject:Deleted', type: 'CustomObject', apiName: 'Deleted', propertiesHash: 'h-d' },
      ],
      [],
    );
    const toSnap = buildSnapshot(
      'removed-to',
      [{ id: 'CustomObject:Kept', type: 'CustomObject', apiName: 'Kept', propertiesHash: 'h-k' }],
      [],
    );
    expect((await saveSnapshot(tempDir, fromSnap)).ok).toBe(true);
    expect((await saveSnapshot(tempDir, toSnap)).ok).toBe(true);

    const result = await diffSnapshotsHandler(ctx, {
      fromLabel: 'removed-from',
      toLabel: 'removed-to',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.added).toEqual([]);
    expect(d.removed.map((c) => c.id)).toEqual(['CustomObject:Deleted']);
    expect(d.modified).toEqual([]);
    expect(d.summary.removedCount).toBe(1);
  });
});

describe('diffSnapshotsHandler — modified components', () => {
  it('lists ids present in both snapshots whose propertiesHash changed under modified', async () => {
    const fromSnap = buildSnapshot(
      'modified-from',
      [
        { id: 'CustomObject:Same', type: 'CustomObject', apiName: 'Same', propertiesHash: 'h-same' },
        { id: 'CustomObject:Changed', type: 'CustomObject', apiName: 'Changed', propertiesHash: 'h-before' },
      ],
      [],
    );
    const toSnap = buildSnapshot(
      'modified-to',
      [
        { id: 'CustomObject:Same', type: 'CustomObject', apiName: 'Same', propertiesHash: 'h-same' },
        { id: 'CustomObject:Changed', type: 'CustomObject', apiName: 'Changed', propertiesHash: 'h-after' },
      ],
      [],
    );
    expect((await saveSnapshot(tempDir, fromSnap)).ok).toBe(true);
    expect((await saveSnapshot(tempDir, toSnap)).ok).toBe(true);

    const result = await diffSnapshotsHandler(ctx, {
      fromLabel: 'modified-from',
      toLabel: 'modified-to',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.modified.map((c) => c.id)).toEqual(['CustomObject:Changed']);
    expect(d.summary.modifiedCount).toBe(1);
  });
});

describe('diffSnapshotsHandler — current as toLabel', () => {
  /** Seed the live graph with a node that the persisted from-snapshot doesn't have,
   *  so the "current" capture reports it as `added`. */
  const liveSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'CustomObject:LiveOnly', apiName: 'LiveOnly' }),
    ],
    edges: [],
  };

  beforeAll(async () => {
    const imported = await importExtractionResults(store, [liveSeed]);
    if (!imported.ok) {
      throw new Error(`live seed failed: ${imported.error.message}`);
    }
  });

  it("captures the live graph transiently when toLabel === 'current'", async () => {
    const fromSnap = buildSnapshot(
      'current-from',
      // Empty from-snapshot — every live node should be added.
      [],
      [],
    );
    expect((await saveSnapshot(tempDir, fromSnap)).ok).toBe(true);
    const result = await diffSnapshotsHandler(ctx, {
      fromLabel: 'current-from',
      toLabel: 'current',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.added.map((c) => c.id)).toContain('CustomObject:LiveOnly');
    // No persisted 'current' snapshot should have been written.
    expect(d.toLabel).toBe('current');
  });
});

describe('diffSnapshotsHandler — invalid snapshots', () => {
  it('returns invalid-query when fromLabel is unknown', async () => {
    const result = await diffSnapshotsHandler(ctx, {
      fromLabel: 'never-captured-A',
      toLabel: 'never-captured-B',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('never-captured-A');
  });

  it('returns invalid-query when toLabel is unknown but fromLabel exists', async () => {
    const fromSnap = buildSnapshot('valid-from', [], []);
    expect((await saveSnapshot(tempDir, fromSnap)).ok).toBe(true);
    const result = await diffSnapshotsHandler(ctx, {
      fromLabel: 'valid-from',
      toLabel: 'still-missing',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('still-missing');
  });
});

describe('diffSnapshotsHandler — limit + truncated', () => {
  it('trims emitted arrays to limit and flips truncated when totals exceed it', async () => {
    // 5 added components; limit=2 -> 2 of each emitted, truncated=true.
    const fromSnap = buildSnapshot('trunc-from', [], []);
    const toSnap = buildSnapshot(
      'trunc-to',
      [
        { id: 'CustomObject:T1', type: 'CustomObject', apiName: 'T1', propertiesHash: 'h-1' },
        { id: 'CustomObject:T2', type: 'CustomObject', apiName: 'T2', propertiesHash: 'h-2' },
        { id: 'CustomObject:T3', type: 'CustomObject', apiName: 'T3', propertiesHash: 'h-3' },
        { id: 'CustomObject:T4', type: 'CustomObject', apiName: 'T4', propertiesHash: 'h-4' },
        { id: 'CustomObject:T5', type: 'CustomObject', apiName: 'T5', propertiesHash: 'h-5' },
      ],
      [],
    );
    expect((await saveSnapshot(tempDir, fromSnap)).ok).toBe(true);
    expect((await saveSnapshot(tempDir, toSnap)).ok).toBe(true);
    const result = await diffSnapshotsHandler(ctx, {
      fromLabel: 'trunc-from',
      toLabel: 'trunc-to',
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.added.length).toBe(2);
    expect(d.summary.addedCount).toBe(5);
    expect(d.truncated).toBe(true);
  });
});

describe('diffSnapshotsInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = diffSnapshotsInputSchema.safeParse({
      fromLabel: 'a',
      toLabel: 'b',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects missing fromLabel', () => {
    const parsed = diffSnapshotsInputSchema.safeParse({ toLabel: 'b' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit above 500', () => {
    const parsed = diffSnapshotsInputSchema.safeParse({
      fromLabel: 'a',
      toLabel: 'b',
      limit: 501,
    });
    expect(parsed.success).toBe(false);
  });
});
