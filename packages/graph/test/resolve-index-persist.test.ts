/// <reference types="vitest/globals" />

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import {
  buildResolveIndex,
  deserializeResolveIndex,
  gatherCandidates,
  getResolveIndex,
  persistResolveIndexArtifact,
  resolveIndexPathForGraph,
  serializeResolveIndex,
  tryLoadResolveIndexArtifact,
  writeResolveIndexArtifact,
} from '../src/resolve-index.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';
import { normalizeName, tokenizeText } from '../src/tokenize.js';

let tempDir: string;
let dbPath: string;
let store: GraphStore;

const makeNode = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
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

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Test__c', apiName: 'Test__c', label: 'Test' }),
    makeNode({ id: 'CustomObject:Payment__c', apiName: 'Payment__c', label: 'Payment' }),
    makeNode({
      id: 'CustomField:Account.Account_Owner__c',
      type: 'CustomField',
      apiName: 'Account_Owner__c',
      label: 'Account Owner',
    }),
    makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
  ],
  edges: [],
};

const gatherIds = async (
  index: Awaited<ReturnType<typeof buildResolveIndex>>,
  query: string,
): Promise<string[]> => {
  const idxs = gatherCandidates(index, tokenizeText(query), normalizeName(query));
  return idxs.map((i) => index.nodes[i]!.id);
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-index-persist-'));
  dbPath = join(tempDir, 'graph.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const init = await initSchema(connection);
  if (!init.ok) throw new Error(init.error.message);
  store = { connection, instance };
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
});

afterAll(() => {
  store.connection.disconnectSync();
  store.instance.closeSync();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('resolve index — persistence', () => {
  it('serializes and deserializes a round trip', async () => {
    const built = await buildResolveIndex(store);
    const raw = serializeResolveIndex(built);
    const loaded = deserializeResolveIndex(raw);
    expect(loaded).not.toBeNull();
    expect(loaded!.nodeCount).toBe(built.nodeCount);
    expect(await gatherIds(loaded!, 'paymnet')).toEqual(await gatherIds(built, 'paymnet'));
  });

  it('writes resolve-index.json beside the graph db path', async () => {
    const built = await buildResolveIndex(store);
    await writeResolveIndexArtifact(dbPath, built);
    const path = resolveIndexPathForGraph(dbPath);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.nodeCount).toBe(built.nodeCount);
  });

  it('getResolveIndex loads from disk on a cold store handle', async () => {
    const built = await buildResolveIndex(store);
    await persistResolveIndexArtifact(dbPath, store);
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    const cold: GraphStore = { connection, instance };
    try {
      const loaded = await getResolveIndex(cold, { graphDbPath: dbPath });
      expect(loaded.nodeCount).toBe(built.nodeCount);
      expect(await gatherIds(loaded, 'Account')).toContain('CustomObject:Account');
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }
  });

  it('tryLoad rejects stale artifacts when the node count changes', async () => {
    await persistResolveIndexArtifact(dbPath, store);
    const more: ExtractionResult = {
      nodes: [makeNode({ id: 'CustomObject:New__c', apiName: 'New__c', label: 'New' })],
      edges: [],
    };
    const imp = await importExtractionResults(store, [more]);
    if (!imp.ok) throw new Error(imp.error.message);
    const stale = await tryLoadResolveIndexArtifact(dbPath, store);
    expect(stale).toBeNull();
  });
});
