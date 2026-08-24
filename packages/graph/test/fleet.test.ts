/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { Node } from '@sf-intelligence/contracts';

import { fleetResolve } from '../src/fleet.js';
import { importExtractionResults } from '../src/import.js';
import { initSchema } from '../src/schema.js';

const node = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
  type: 'CustomObject',
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const mkVault = async (dbPath: string, nodes: readonly Node[]): Promise<void> => {
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const init = await initSchema(connection);
  if (!init.ok) throw new Error(init.error.message);
  const store = { connection, instance };
  const imp = await importExtractionResults(store, [{ nodes, edges: [] }]);
  if (!imp.ok) throw new Error(imp.error.message);
  connection.disconnectSync();
  instance.closeSync();
};

let tempDir: string;
let dbA: string;
let dbB: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-fleet-'));
  mkdirSync(join(tempDir, 'a'));
  mkdirSync(join(tempDir, 'b'));
  dbA = join(tempDir, 'a', 'graph.duckdb');
  dbB = join(tempDir, 'b', 'graph.duckdb');
  await mkVault(dbA, [
    node({ id: 'CustomObject:Payment__c', apiName: 'Payment__c', label: 'Payment' }),
  ]);
  await mkVault(dbB, [
    node({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
  ]);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('fleetResolve', () => {
  it('reports which vaults contain a match and which do not', async () => {
    const results = await fleetResolve(
      [
        { key: 'orgA', graphDbPath: dbA },
        { key: 'orgB', graphDbPath: dbB },
      ],
      'paymnet',
    );
    const a = results.find((r) => r.vault === 'orgA');
    const b = results.find((r) => r.vault === 'orgB');
    expect(a?.disposition).toBe('exact');
    expect(a?.top?.id).toBe('CustomObject:Payment__c');
    expect(b?.disposition).toBe('none');
    expect(b?.top).toBeNull();
  });

  it('preserves input order', async () => {
    const results = await fleetResolve(
      [
        { key: 'orgB', graphDbPath: dbB },
        { key: 'orgA', graphDbPath: dbA },
      ],
      'account',
    );
    expect(results.map((r) => r.vault)).toEqual(['orgB', 'orgA']);
  });

  it('marks an unreadable vault as unavailable without throwing', async () => {
    const results = await fleetResolve(
      [{ key: 'missing', graphDbPath: join(tempDir, 'nope', 'graph.duckdb') }],
      'payment',
    );
    expect(results[0]?.disposition).toBe('unavailable');
    expect(results[0]?.error).toBeDefined();
  });
});
