/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, ExtractionResult, Node } from '@sf-intelligence/contracts';

import {
  clearFacts,
  closeGraph,
  copyFacts,
  importExtractionResults,
  isFactFresh,
  openGraph,
  readFacts,
  replaceFactsForMetricSource,
  writeFacts,
  type Fact,
  type GraphStore,
} from '../src/index.js';

/**
 * P13-FACTS-store — the facts table lives OUTSIDE the metadata graph: the
 * import path never touches it (facts survive a re-import), facts writes
 * never change nodes/edges (the A7 comparison surface), and freshness is a
 * read-side policy with an injectable clock.
 */

const ALPHA = 'CustomObject:Alpha__c' as ComponentId;
const BETA = 'CustomObject:Beta__c' as ComponentId;

const fact = (overrides: Partial<Fact>): Fact => ({
  subjectId: ALPHA,
  metric: 'recordCount',
  value: 1234,
  capturedAt: '2026-06-09T20:00:00.000Z',
  method: 'rest-recordcount',
  source: 'refresh-with-data-shape',
  ...overrides,
});

const makeNode = (id: string): Node =>
  ({
    id,
    type: 'CustomObject',
    apiName: id.split(':')[1],
    label: null,
    parentId: null,
    sourcePath: `objects/${id.split(':')[1]}.object`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
  }) as never;

const EXTRACTION: ExtractionResult = {
  nodes: [makeNode('CustomObject:Alpha__c'), makeNode('CustomObject:Beta__c')],
  edges: [],
} as never;

let tempDir: string;
let store: GraphStore;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-facts-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [EXTRACTION]);
  if (!imported.ok) throw new Error(imported.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const nodesDigest = async (): Promise<string> => {
  const reader = await store.connection.runAndReadAll(
    'SELECT * FROM nodes ORDER BY id',
  );
  const edges = await store.connection.runAndReadAll(
    'SELECT * FROM edges ORDER BY from_id, to_id, edge_type, source',
  );
  return JSON.stringify([reader.getRowObjectsJS(), edges.getRowObjectsJS()]);
};

describe('facts store', () => {
  it('round-trips values with JSON fidelity and reads newest-first', async () => {
    const w = await writeFacts(store, [
      fact({}),
      fact({
        subjectId: BETA,
        metric: 'fillRate',
        value: { field: 'Beta__c.Score__c', rate: 0.42, sampled: true },
        capturedAt: '2026-06-09T21:00:00.000Z',
        method: 'recent-sample',
      }),
    ]);
    expect(w.ok && w.value).toBe(2);
    const all = await readFacts(store);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(2);
    expect(all.value[0]?.subjectId).toBe(BETA); // newer capture first
    expect(all.value[0]?.value).toEqual({ field: 'Beta__c.Score__c', rate: 0.42, sampled: true });
    expect(all.value[1]?.value).toBe(1234);
  });

  it('upserts on (subject, metric, source) — a re-capture replaces, never duplicates', async () => {
    const w = await writeFacts(store, [
      fact({ value: 2000, capturedAt: '2026-06-10T01:00:00.000Z' }),
    ]);
    expect(w.ok).toBe(true);
    const rows = await readFacts(store, { subjectId: ALPHA, metric: 'recordCount' });
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]?.value).toBe(2000);
    expect(rows.value[0]?.capturedAt).toBe('2026-06-10T01:00:00.000Z');
  });

  it('filters by subject / metric / source', async () => {
    const bySubject = await readFacts(store, { subjectId: BETA });
    expect(bySubject.ok && bySubject.value.every((f) => f.subjectId === BETA)).toBe(true);
    const byMetric = await readFacts(store, { metric: 'recordCount' });
    expect(byMetric.ok && byMetric.value.every((f) => f.metric === 'recordCount')).toBe(true);
    const bySource = await readFacts(store, { source: 'no-such-source' });
    expect(bySource.ok && bySource.value).toHaveLength(0);
  });

  it('facts writes never change nodes/edges, and a metadata re-import never touches facts', async () => {
    const before = await nodesDigest();
    await writeFacts(store, [fact({ metric: 'firedLast30d', value: 7 })]);
    expect(await nodesDigest()).toBe(before); // A7 surface untouched by facts

    const reimport = await importExtractionResults(store, [EXTRACTION]);
    expect(reimport.ok).toBe(true);
    const after = await readFacts(store);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.length).toBeGreaterThanOrEqual(3); // facts survived the import
  });

  it('copies the complete facts table into a replacement graph', async () => {
    const opened = await openGraph(join(tempDir, 'replacement.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const before = await readFacts(store, { limit: 2000 });
      if (!before.ok) throw new Error(before.error.message);
      const copied = await copyFacts(store, opened.value);
      expect(copied.ok && copied.value).toBe(before.value.length);
      const after = await readFacts(opened.value, { limit: 2000 });
      expect(after.ok && after.value).toEqual(before.value);
    } finally {
      await closeGraph(opened.value);
    }
  });

  it('atomically replaces one metric/source scope and removes stale rows', async () => {
    await writeFacts(store, [
      fact({ subjectId: ALPHA, metric: 'activeHolders', value: 9 }),
      fact({ subjectId: BETA, metric: 'activeHolders', value: 3 }),
      fact({ subjectId: BETA, metric: 'fillRate', value: 0.5 }),
    ]);
    const replaced = await replaceFactsForMetricSource(
      store,
      'activeHolders',
      'refresh-with-data-shape',
      [fact({ subjectId: ALPHA, metric: 'activeHolders', value: 0 })],
    );
    expect(replaced.ok && replaced.value).toBe(1);
    const holders = await readFacts(store, { metric: 'activeHolders' });
    expect(holders.ok && holders.value).toHaveLength(1);
    expect(holders.ok && holders.value[0]?.value).toBe(0);
    const fills = await readFacts(store, { metric: 'fillRate' });
    expect(fills.ok && fills.value.length).toBeGreaterThanOrEqual(1);
  });

  it('clearFacts scopes to a source, then clears all', async () => {
    await writeFacts(store, [
      fact({ subjectId: BETA, metric: 'recordCount', source: 'watch-daemon' }),
    ]);
    const scoped = await clearFacts(store, 'watch-daemon');
    expect(scoped.ok && scoped.value).toBe(1);
    const remaining = await readFacts(store);
    expect(remaining.ok && remaining.value.length).toBeGreaterThanOrEqual(3);
    const all = await clearFacts(store);
    expect(all.ok).toBe(true);
    const empty = await readFacts(store);
    expect(empty.ok && empty.value).toHaveLength(0);
  });

  it('isFactFresh is a pure, injectable-clock TTL check', () => {
    const f = { capturedAt: '2026-06-01T00:00:00.000Z' };
    expect(isFactFresh(f, 7, '2026-06-05T00:00:00.000Z')).toBe(true);
    expect(isFactFresh(f, 7, '2026-06-09T00:00:00.001Z')).toBe(false);
    expect(isFactFresh({ capturedAt: 'garbage' }, 7, '2026-06-05T00:00:00.000Z')).toBe(false);
  });
});
