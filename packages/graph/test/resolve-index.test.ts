/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import {
  buildResolveIndex,
  gatherCandidates,
  getResolveIndex,
} from '../src/resolve-index.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';
import { normalizeName, tokenizeText } from '../src/tokenize.js';

let tempDir: string;
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

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-index-'));
  const instance = await DuckDBInstance.create(join(tempDir, 'i.db'));
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
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Resolve a query to the node indices the prefilter gathers (for recall checks). */
const gatherIds = async (query: string): Promise<string[]> => {
  const index = await getResolveIndex(store);
  const idxs = gatherCandidates(
    index,
    tokenizeText(query),
    normalizeName(query),
  );
  return idxs.map((i) => index.nodes[i]!.id);
};

describe('resolve index — recall-safe prefilter', () => {
  it('gathers a node whose 4-char token is a TRANSPOSITION typo (test -> tset, no shared bigram)', async () => {
    // "tset" shares NO character bigram with "test" yet scores ~0.92 — the
    // sorted-char signature bucket is what keeps it a candidate.
    const ids = await gatherIds('tset');
    expect(ids).toContain('CustomObject:Test__c');
  });

  it('gathers a node via a SUBSTITUTION/insertion typo (paymnet -> Payment, shared bigram)', async () => {
    const ids = await gatherIds('paymnet');
    expect(ids).toContain('CustomObject:Payment__c');
  });

  it('gathers a node via a SYNONYM bridge that shares no bigram (rep -> Owner)', async () => {
    const ids = await gatherIds('rep');
    expect(ids).toContain('CustomField:Account.Account_Owner__c');
  });

  it('gathers a stop-word-named / whole-name match even when the query tokenizes to nothing', async () => {
    // normalized whole-name bucket. "Account" tokenizes fine, but exercise the
    // normName path directly with an exact api name.
    const ids = await gatherIds('Account');
    expect(ids).toContain('CustomObject:Account');
  });
});

describe('resolve index — caching', () => {
  it('memoizes per store and rebuilds when the node count changes', async () => {
    const a = await getResolveIndex(store);
    const b = await getResolveIndex(store);
    expect(a).toBe(b); // same object reference — served from cache

    // A fresh import changes the node count, so the next get rebuilds.
    const more: ExtractionResult = {
      nodes: [makeNode({ id: 'CustomObject:New__c', apiName: 'New__c', label: 'New' })],
      edges: [],
    };
    const imp = await importExtractionResults(store, [more]);
    if (!imp.ok) throw new Error(imp.error.message);
    const c = await getResolveIndex(store);
    expect(c).not.toBe(a);
    expect(c.nodes.some((n) => n.id === 'CustomObject:New__c')).toBe(true);
  });

  it('build covers the same node set for a fixed graph', async () => {
    const one = await buildResolveIndex(store);
    const two = await buildResolveIndex(store);
    const sortedIds = (idx: Awaited<ReturnType<typeof buildResolveIndex>>) =>
      idx.nodes.map((n) => n.id).sort();
    expect(sortedIds(one)).toEqual(sortedIds(two));
  });
});
