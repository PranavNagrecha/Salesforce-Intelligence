/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import { contributorsSummary } from '../src/queries.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

const n = (
  id: string,
  by: string | null,
  date: string | null,
): Node => ({
  id,
  type: 'ApexClass',
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: date,
  lastModifiedBy: by,
  apiVersion: null,
  properties: {},
});

let tempDir: string;
let store: GraphStore;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-contrib-'));
  const instance = await DuckDBInstance.create(join(tempDir, 'g.db'));
  const connection = await instance.connect();
  const init = await initSchema(connection);
  if (!init.ok) throw new Error(init.error.message);
  store = { connection, instance };
  const seed: ExtractionResult = {
    nodes: [
      n('ApexClass:A1', 'userA', '2024-01-01T00:00:00.000Z'),
      n('ApexClass:A2', 'userA', '2025-06-01T00:00:00.000Z'),
      n('ApexClass:A3', 'userA', '2026-01-01T00:00:00.000Z'),
      n('ApexClass:B1', 'userB', '2025-01-01T00:00:00.000Z'),
      n('ApexClass:B2', 'userB', '2025-02-01T00:00:00.000Z'),
      n('ApexClass:Anon', null, null),
    ],
    edges: [],
  };
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
});

afterAll(() => {
  store.connection.disconnectSync();
  store.instance.closeSync();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('contributorsSummary', () => {
  it('ranks contributors by component count and counts unknown authors', async () => {
    const r = await contributorsSummary(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.totalWithAuthor).toBe(5);
    expect(r.value.totalUnknownAuthor).toBe(1);
    expect(r.value.contributors[0]?.author).toBe('userA');
    expect(r.value.contributors[0]?.componentCount).toBe(3);
    expect(r.value.contributors[1]?.author).toBe('userB');
    expect(r.value.contributors[1]?.componentCount).toBe(2);
  });

  it('reports each contributor most-recent change date and sample ids', async () => {
    const r = await contributorsSummary(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const userA = r.value.contributors.find((c) => c.author === 'userA');
    expect(userA?.mostRecentDate).toBe('2026-01-01T00:00:00.000Z');
    expect((userA?.sampleIds.length ?? 0)).toBeGreaterThan(0);
  });
});
