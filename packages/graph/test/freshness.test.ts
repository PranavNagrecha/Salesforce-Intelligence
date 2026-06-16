/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import { freshnessSummary } from '../src/queries.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

const n = (
  id: string,
  lastModifiedDate: string | null,
): Node => ({
  id,
  type: 'CustomObject',
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

let tempDir: string;
let store: GraphStore;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-fresh-'));
  const instance = await DuckDBInstance.create(join(tempDir, 'g.db'));
  const connection = await instance.connect();
  const init = await initSchema(connection);
  if (!init.ok) throw new Error(init.error.message);
  store = { connection, instance };
  const seed: ExtractionResult = {
    nodes: [
      n('CustomObject:Old', '2024-01-01T00:00:00.000Z'),
      n('CustomObject:New', '2026-05-01T00:00:00.000Z'),
      n('CustomObject:Unknown', null),
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

describe('freshnessSummary', () => {
  it('reports coverage of known vs unknown lastModifiedDate', async () => {
    const r = await freshnessSummary(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(3);
    expect(r.value.withKnownDate).toBe(2);
    expect(r.value.unknownDate).toBe(1);
    expect(r.value.coveragePct).toBeCloseTo(66.7, 1);
  });

  it('surfaces the oldest and newest dated components', async () => {
    const r = await freshnessSummary(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.oldest[0]?.id).toBe('CustomObject:Old');
    expect(r.value.newest[0]?.id).toBe('CustomObject:New');
  });
});
