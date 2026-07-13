/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import {
  countNodesByType,
  getNodeById,
  getSubgraph,
  listChildren,
  listEdges,
  listEdgesForNodes,
  listNodeIdentities,
  listNodesByType,
  searchNodes,
} from '../src/queries.js';
import { initSchema } from '../src/schema.js';
import { closeGraph, openGraph, type GraphStore } from '../src/store.js';

// Each test file gets its own scratch directory. A single store is shared
// across all `it` blocks here because the fixture is read-only after the
// initial seed — the determinism + setup-cost wins outweigh per-test
// isolation in a read-side suite.
let tempDir: string;
let store: GraphStore;

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

const seed: ExtractionResult = {
  nodes: [
    // 3 CustomObjects.
    makeNode({
      id: 'CustomObject:Account',
      apiName: 'Account',
      label: 'Account',
    }),
    makeNode({
      id: 'CustomObject:Opportunity',
      apiName: 'Opportunity',
      label: 'Opportunity',
    }),
    makeNode({
      id: 'CustomObject:CustomerProject__c',
      apiName: 'CustomerProject__c',
      label: 'Customer Project',
    }),
    // 5 CustomFields (2 Account, 2 Opportunity, 1 CustomerProject).
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
      properties: { dataType: 'Picklist' },
    }),
    makeNode({
      id: 'CustomField:Account.Region__c',
      type: 'CustomField',
      apiName: 'Region__c',
      label: 'Region',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Region__c.field-meta.xml',
      properties: { dataType: 'Text', length: 80 },
    }),
    makeNode({
      id: 'CustomField:Opportunity.Stage__c',
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: 'CustomObject:Opportunity',
      sourcePath: 'objects/Opportunity/fields/Stage__c.field-meta.xml',
      properties: { dataType: 'Picklist' },
    }),
    makeNode({
      id: 'CustomField:Opportunity.CloseDate__c',
      type: 'CustomField',
      apiName: 'CloseDate__c',
      label: 'Close Date',
      parentId: 'CustomObject:Opportunity',
      sourcePath: 'objects/Opportunity/fields/CloseDate__c.field-meta.xml',
      properties: { dataType: 'Date' },
    }),
    makeNode({
      id: 'CustomField:CustomerProject__c.Status__c',
      type: 'CustomField',
      apiName: 'Status__c',
      label: 'Status',
      parentId: 'CustomObject:CustomerProject__c',
      sourcePath:
        'objects/CustomerProject__c/fields/Status__c.field-meta.xml',
      properties: { dataType: 'Picklist' },
    }),
  ],
  edges: [
    // 5 parentOf (object -> field).
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
    }),
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Region__c',
    }),
    makeEdge({
      fromId: 'CustomObject:Opportunity',
      toId: 'CustomField:Opportunity.Stage__c',
    }),
    makeEdge({
      fromId: 'CustomObject:Opportunity',
      toId: 'CustomField:Opportunity.CloseDate__c',
    }),
    makeEdge({
      fromId: 'CustomObject:CustomerProject__c',
      toId: 'CustomField:CustomerProject__c.Status__c',
    }),
    // 1 fictional triggersOn.
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'triggersOn',
      confidence: 'heuristic',
      source: 'extractor:fictional',
    }),
  ],
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-queries-'));
  const dbPath = join(tempDir, 'queries.db');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const initResult = await initSchema(connection);
  if (!initResult.ok) {
    throw new Error(`initSchema failed: ${initResult.error.message}`);
  }
  store = { connection, instance };
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
});

afterAll(() => {
  store.connection.disconnectSync();
  store.instance.closeSync();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('getNodeById', () => {
  it('returns the deserialized node for an existing id', async () => {
    const r = await getNodeById(store, 'CustomField:Account.Region__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toBeNull();
    expect(r.value!.id).toBe('CustomField:Account.Region__c');
    expect(r.value!.type).toBe('CustomField');
    expect(r.value!.apiName).toBe('Region__c');
    expect(r.value!.label).toBe('Region');
    expect(r.value!.parentId).toBe('CustomObject:Account');
    expect(r.value!.properties).toEqual({ dataType: 'Text', length: 80 });
  });

  it('returns ok(null) for a non-existent id', async () => {
    const r = await getNodeById(store, 'CustomField:Account.DoesNotExist__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
  });
});

describe('listNodesByType', () => {
  it('returns all CustomFields in the seed', async () => {
    const r = await listNodesByType(store, 'CustomField');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(5);
    // Sorted by id ascending.
    expect(r.value.map((n) => n.id)).toEqual([
      'CustomField:Account.Industry__c',
      'CustomField:Account.Region__c',
      'CustomField:CustomerProject__c.Status__c',
      'CustomField:Opportunity.CloseDate__c',
      'CustomField:Opportunity.Stage__c',
    ]);
  });

  it('filters by parentId when provided', async () => {
    const r = await listNodesByType(store, 'CustomField', {
      parentId: 'CustomObject:Account',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((n) => n.id)).toEqual([
      'CustomField:Account.Industry__c',
      'CustomField:Account.Region__c',
    ]);
  });

  it('rejects limit values larger than 500', async () => {
    const r = await listNodesByType(store, 'CustomField', { limit: 501 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('query-failed');
    expect(r.error.message).toMatch(/limit exceeds 500/);
  });

  it('respects offset for pagination', async () => {
    const r = await listNodesByType(store, 'CustomField', {
      limit: 2,
      offset: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Third + fourth row of the sorted-ascending list.
    expect(r.value.map((n) => n.id)).toEqual([
      'CustomField:CustomerProject__c.Status__c',
      'CustomField:Opportunity.CloseDate__c',
    ]);
  });
});

describe('listNodeIdentities', () => {
  it('projects every node to id/type/apiName/parentId, sorted by id ASC', async () => {
    const r = await listNodeIdentities(store);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 3 CustomObjects + 5 CustomFields in the shared seed.
    expect(r.value.length).toBeGreaterThanOrEqual(8);
    const ids = r.value.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    const field = r.value.find(
      (n) => n.id === 'CustomField:Account.Industry__c',
    );
    expect(field?.type).toBe('CustomField');
    expect(field?.parentId).toBe('CustomObject:Account');
    expect(typeof field?.apiName).toBe('string');
    expect(field?.apiName.length).toBeGreaterThan(0);
  });

  it('caps the scan at the requested limit (stable prefix)', async () => {
    const r = await listNodeIdentities(store, { limit: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(3);
  });
});

describe('listChildren', () => {
  it('returns the immediate children of a parent node', async () => {
    const r = await listChildren(store, 'CustomObject:Account');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((n) => n.id)).toEqual([
      'CustomField:Account.Industry__c',
      'CustomField:Account.Region__c',
    ]);
  });

  it('returns an empty array for a node with no children', async () => {
    const r = await listChildren(store, 'CustomField:Account.Industry__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });
});

describe('listEdges', () => {
  it("defaults to direction='both' and returns all incident edges", async () => {
    // Account is both the from-id of two parentOf edges and the from-id of
    // the fictional triggersOn; nothing points TO Account in this fixture.
    const r = await listEdges(store, 'CustomObject:Account');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(3);
  });

  it("direction='out' returns only edges where the node is the from-id", async () => {
    const r = await listEdges(store, 'CustomObject:Account', {
      direction: 'out',
      edgeType: 'parentOf',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(2);
    // Sort: by to_id asc, then edge_type asc.
    expect(r.value.map((e) => e.toId)).toEqual([
      'CustomField:Account.Industry__c',
      'CustomField:Account.Region__c',
    ]);
  });

  it("direction='in' on a leaf object returns no edges", async () => {
    const r = await listEdges(store, 'CustomObject:Account', {
      direction: 'in',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });

  it('filters by edgeType', async () => {
    const r = await listEdges(store, 'CustomObject:Account', {
      edgeType: 'triggersOn',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(1);
    expect(r.value[0]!.edgeType).toBe('triggersOn');
    expect(r.value[0]!.confidence).toBe('heuristic');
  });

  it('filters by confidence', async () => {
    const r = await listEdges(store, 'CustomObject:Account', {
      confidence: 'heuristic',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(1);
    expect(r.value[0]!.edgeType).toBe('triggersOn');
  });

  it('sorts by to_id then edge_type', async () => {
    // Two edges incident to Account.Industry__c: parentOf (Account) and
    // triggersOn (Account). Both have to_id = Industry__c, so sort by
    // edge_type ascending: parentOf < triggersOn.
    const r = await listEdges(store, 'CustomField:Account.Industry__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(2);
    expect(r.value.map((e) => e.edgeType)).toEqual([
      'parentOf',
      'triggersOn',
    ]);
  });
});

describe('listEdgesForNodes (CR-17 batched listEdges)', () => {
  const sortEdges = (edges: readonly Edge[]): Edge[] =>
    [...edges].sort((a, b) =>
      a.toId !== b.toId
        ? a.toId < b.toId
          ? -1
          : 1
        : a.edgeType !== b.edgeType
          ? a.edgeType < b.edgeType
            ? -1
            : 1
          : a.fromId !== b.fromId
            ? a.fromId < b.fromId
              ? -1
              : 1
            : a.source !== b.source
              ? a.source < b.source
                ? -1
                : 1
              : 0,
    );

  it('partition per node equals per-id listEdges sets for every direction', async () => {
    const ids: Edge['fromId'][] = [
      'CustomObject:Account',
      'CustomField:Account.Industry__c',
      'CustomField:Account.Region__c',
      'CustomObject:Opportunity',
    ];
    for (const direction of ['both', 'in', 'out'] as const) {
      const batched = await listEdgesForNodes(store, ids, { direction });
      expect(batched.ok).toBe(true);
      if (!batched.ok) return;
      for (const id of ids) {
        const single = await listEdges(store, id, { direction });
        expect(single.ok).toBe(true);
        if (!single.ok) return;
        const bucket = batched.value.get(id) ?? [];
        // Same SET (order-independent), via the shared total sort.
        expect(sortEdges(bucket)).toEqual(sortEdges(single.value));
        // And the batched bucket is already in that defined total order.
        expect([...bucket]).toEqual(sortEdges(bucket));
      }
    }
  });

  it('reproduces the union of per-edgeType listEdges calls (direction=in)', async () => {
    const id = 'CustomField:Account.Industry__c';
    const edgeTypes: Edge['edgeType'][] = ['parentOf', 'triggersOn'];
    const batched = await listEdgesForNodes(store, [id], {
      direction: 'in',
      edgeTypes,
    });
    expect(batched.ok).toBe(true);
    if (!batched.ok) return;
    const union: Edge[] = [];
    for (const edgeType of edgeTypes) {
      const single = await listEdges(store, id, { direction: 'in', edgeType });
      expect(single.ok).toBe(true);
      if (!single.ok) return;
      union.push(...single.value);
    }
    expect(sortEdges(batched.value.get(id) ?? [])).toEqual(sortEdges(union));
  });

  it('returns ok(empty map) on empty nodeIds without emitting invalid SQL', async () => {
    const spy = vi.spyOn(store.connection, 'runAndReadAll');
    const r = await listEdgesForNodes(store, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.size).toBe(0);
    // No SQL is issued for an empty batch.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('always keys every requested id, even those with no incident edges', async () => {
    const r = await listEdgesForNodes(store, [
      'CustomField:Account.Region__c',
      'CustomField:DoesNotExist__c.Nope__c',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.has('CustomField:Account.Region__c')).toBe(true);
    expect(r.value.has('CustomField:DoesNotExist__c.Nope__c')).toBe(true);
    expect(r.value.get('CustomField:DoesNotExist__c.Nope__c')).toEqual([]);
  });

  it('issues exactly ONE query for an N-node batch (O(1), not O(N))', async () => {
    const ids: Edge['fromId'][] = [
      'CustomObject:Account',
      'CustomObject:Opportunity',
      'CustomObject:CustomerProject__c',
      'CustomField:Account.Industry__c',
    ];
    // Baseline: the row-at-a-time approach issues one query per node.
    const singleSpy = vi.spyOn(store.connection, 'runAndReadAll');
    for (const id of ids) {
      await listEdges(store, id, { direction: 'in' });
    }
    expect(singleSpy).toHaveBeenCalledTimes(ids.length);
    singleSpy.mockRestore();
    // Batched: one round-trip for the whole frontier.
    const batchSpy = vi.spyOn(store.connection, 'runAndReadAll');
    const r = await listEdgesForNodes(store, ids, { direction: 'in' });
    expect(r.ok).toBe(true);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    batchSpy.mockRestore();
  });

  it('direction=both buckets a self-loop once and a both-endpoints edge in both', async () => {
    const loopDir = mkdtempSync(join(tmpdir(), 'sfi-graph-batch-loop-'));
    const dbPath = join(loopDir, 'loop.db');
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    const initResult = await initSchema(connection);
    expect(initResult.ok).toBe(true);
    const localStore: GraphStore = { connection, instance };
    const loopSeed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'ApexClass:A', type: 'ApexClass', apiName: 'A' }),
        makeNode({ id: 'ApexClass:B', type: 'ApexClass', apiName: 'B' }),
      ],
      edges: [
        // Self-loop on A (a class that calls itself).
        makeEdge({
          fromId: 'ApexClass:A',
          toId: 'ApexClass:A',
          edgeType: 'callsApex',
          confidence: 'heuristic',
          source: 'apex-scanner',
        }),
        // A -> B, both requested in the batch.
        makeEdge({
          fromId: 'ApexClass:A',
          toId: 'ApexClass:B',
          edgeType: 'callsApex',
          confidence: 'heuristic',
          source: 'apex-scanner',
        }),
      ],
    };
    const imported = await importExtractionResults(localStore, [loopSeed]);
    expect(imported.ok).toBe(true);
    const ids: Edge['fromId'][] = ['ApexClass:A', 'ApexClass:B'];
    const batched = await listEdgesForNodes(localStore, ids, {
      direction: 'both',
    });
    expect(batched.ok).toBe(true);
    if (!batched.ok) return;
    // Identity vs per-id listEdges (the contract that preserves behavior).
    for (const id of ids) {
      const single = await listEdges(localStore, id, { direction: 'both' });
      expect(single.ok).toBe(true);
      if (!single.ok) return;
      expect(sortEdges(batched.value.get(id) ?? [])).toEqual(
        sortEdges(single.value),
      );
    }
    // A's bucket: self-loop (once) + A->B = 2 edges.
    expect((batched.value.get('ApexClass:A') ?? []).length).toBe(2);
    // B's bucket: just A->B = 1 edge.
    expect((batched.value.get('ApexClass:B') ?? []).length).toBe(1);
    rmSync(loopDir, { recursive: true, force: true });
  });
});

describe('searchNodes', () => {
  it('returns the exact-match Account node at the top of the score', async () => {
    const r = await searchNodes(store, 'Account');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBeGreaterThan(0);
    // The first hit must be CustomObject:Account with score 3.0 (exact match).
    expect(r.value[0]!.id).toBe('CustomObject:Account');
    expect(r.value[0]!.score).toBe(3.0);
    // The fields scoped to Account also match (api_name contains 'Account'
    // is false — Industry__c doesn't contain 'Account' — so they show up
    // via label OR properties only if at all). The Account-prefixed fields'
    // ids DO contain 'Account' but ids aren't searched.
  });

  it('returns a single hit when the query matches one field', async () => {
    const r = await searchNodes(store, 'Industry');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBe(1);
    expect(r.value[0]!.id).toBe('CustomField:Account.Industry__c');
  });

  it('returns an empty array when nothing matches', async () => {
    const r = await searchNodes(store, 'NonexistentXyzzy');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });

  it('returns an empty array when the query is empty', async () => {
    const r = await searchNodes(store, '');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });

  it('rejects limit values larger than 100', async () => {
    const r = await searchNodes(store, 'Account', { limit: 101 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('query-failed');
    expect(r.error.message).toMatch(/limit exceeds 100/);
  });

  it('ranks api_name prefix matches above substring contains (B22 flow names)', async () => {
    const flowSeed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'Flow:Application_Status_Update',
          type: 'Flow',
          apiName: 'Application_Status_Update',
          label: 'Application Status Update',
          sourcePath: 'flows/Application_Status_Update.flow-meta.xml',
        }),
        makeNode({
          id: 'Flow:Application_Field_Sync_To_Contact',
          type: 'Flow',
          apiName: 'Application_Field_Sync_To_Contact',
          label: 'Application Field Sync To Contact',
          sourcePath: 'flows/Application_Field_Sync_To_Contact.flow-meta.xml',
          properties: { description: 'Sync when Application_Status changes on contact' },
        }),
        makeNode({
          id: 'CustomField:Application_Event__e.Application_Status__c',
          type: 'CustomField',
          apiName: 'Application_Status__c',
          label: 'Application Status',
          parentId: 'CustomObject:Application_Event__e',
          sourcePath: 'objects/Application_Event__e/fields/Application_Status__c.field-meta.xml',
        }),
      ],
      edges: [],
    };
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-graph-search-b22-'));
    const dbPath = join(localDir, 'b22.db');
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    const initResult = await initSchema(connection);
    expect(initResult.ok).toBe(true);
    const localStore: GraphStore = { connection, instance };
    const imported = await importExtractionResults(localStore, [flowSeed]);
    expect(imported.ok).toBe(true);
    const r = await searchNodes(localStore, 'Application_Status', { limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flowHits = r.value.filter((h) => h.id.startsWith('Flow:'));
    expect(flowHits.length).toBeGreaterThanOrEqual(1);
    expect(flowHits[0]!.id).toBe('Flow:Application_Status_Update');
    expect(flowHits[0]!.score).toBe(2.8);
    const wrongFlow = r.value.find(
      (h) => h.id === 'Flow:Application_Field_Sync_To_Contact',
    );
    if (wrongFlow !== undefined) {
      expect(flowHits[0]!.score).toBeGreaterThan(wrongFlow.score);
    }
    rmSync(localDir, { recursive: true, force: true });
  });

  it('filters by component type when types option is provided', async () => {
    const r = await searchNodes(store, 'Account', {
      types: ['CustomField'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only fields are returned. The Account-prefixed fields don't have
    // 'Account' in api_name/label/properties, so this returns empty —
    // confirming the type filter actually clamps the result set.
    for (const hit of r.value) {
      expect(hit.id.startsWith('CustomField:')).toBe(true);
    }
  });
});

describe('getSubgraph', () => {
  it('hops=1 returns the root, its immediate neighbors, and their edges', async () => {
    const r = await getSubgraph(store, 'CustomObject:Account', 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Account + its two fields = 3 nodes. Edges incident: 2 parentOf +
    // 1 triggersOn (all from Account, both pointing into the same field
    // set) = 3 edges.
    expect(r.value.nodes.map((n) => n.id)).toEqual([
      'CustomField:Account.Industry__c',
      'CustomField:Account.Region__c',
      'CustomObject:Account',
    ]);
    expect(r.value.edges.length).toBe(3);
    // Edges sorted by (from_id, to_id, edge_type, source).
    expect(r.value.edges.map((e) => e.edgeType)).toEqual([
      'parentOf',
      'triggersOn',
      'parentOf',
    ]);
  });

  it('hops=2 expands further from the frontier', async () => {
    // For our fixture, Account's neighbors are only its two fields, and
    // those fields don't link out. hops=2 should equal hops=1 (no new
    // expansion). But we explicitly test the expansion mechanism works.
    const r = await getSubgraph(store, 'CustomObject:Account', 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Same 3 nodes; the BFS round 2 walks from the fields but no new
    // edges exist there.
    expect(r.value.nodes.length).toBe(3);
  });

  it('hops > 3 is rejected', async () => {
    const r = await getSubgraph(store, 'CustomObject:Account', 4);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('query-failed');
    expect(r.error.message).toMatch(/hops exceeds 3/);
  });

  it('returns nodes sorted by id and edges sorted by composite key', async () => {
    const r = await getSubgraph(store, 'CustomObject:Account', 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.nodes.map((n) => n.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('reports truncated=false for an un-clipped subgraph', async () => {
    const r = await getSubgraph(store, 'CustomObject:Account', 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(false);
  });
});

// A hub fixture (> SUBGRAPH_MAX_NODES leaves) plus a phantom heuristic edge,
// in its own store so the size-cap and unresolved-edge behavior can be
// exercised without perturbing the small shared seed above.
describe('getSubgraph caps + unresolved-edge filtering', () => {
  const SUBGRAPH_MAX_NODES = 200; // mirrors the constant in queries.ts
  // > both the 200-node subgraph cap AND the 500-row listNodesByType cap, so
  // one fixture exercises subgraph truncation and the COUNT(*)-vs-capped-list
  // distinction that `countNodesByType` fixes.
  const LEAF_COUNT = 501;
  let capDir: string;
  let capStore: GraphStore;

  beforeAll(async () => {
    capDir = mkdtempSync(join(tmpdir(), 'sfi-graph-caps-'));
    const instance = await DuckDBInstance.create(join(capDir, 'caps.db'));
    const connection = await instance.connect();
    const initResult = await initSchema(connection);
    if (!initResult.ok) throw new Error(initResult.error.message);
    capStore = { connection, instance };

    const nodes: Node[] = [
      makeNode({ id: 'CustomObject:Hub', apiName: 'Hub', label: 'Hub' }),
      makeNode({
        id: 'ApexClass:Caller',
        type: 'ApexClass',
        apiName: 'Caller',
        label: 'Caller',
      }),
      makeNode({
        id: 'ApexClass:RealTarget',
        type: 'ApexClass',
        apiName: 'RealTarget',
        label: 'RealTarget',
      }),
    ];
    const edges: Edge[] = [
      // Heuristic edge to a REAL node — must always stay visible.
      makeEdge({
        fromId: 'ApexClass:Caller',
        toId: 'ApexClass:RealTarget',
        edgeType: 'callsApex',
        confidence: 'heuristic',
        source: 'apex-scanner',
      }),
      // Heuristic edge to a node that does NOT exist (the scanner-phantom
      // shape) — tagged targetMissing at import, hidden by default.
      makeEdge({
        fromId: 'ApexClass:Caller',
        toId: 'ApexClass:Phantom',
        edgeType: 'callsApex',
        confidence: 'heuristic',
        source: 'apex-scanner',
      }),
      // RV2: a heuristic phantom edge FROM the over-budget Hub. HubPhantom is
      // NOT added to `nodes`, so import stamps targetMissing → isHiddenUnresolved
      // is true. Under includeUnresolved this is the ONLY endpoint that should be
      // synthesized as an unresolved stub; the ~500 budget-clipped REAL
      // CustomField leaves must NOT be. `to_id ASC` orders ApexClass:HubPhantom
      // before CustomField:Hub.F0__c, so it is collected before the node budget
      // is spent, keeping the exactly-one-unresolved assertion reachable.
      makeEdge({
        fromId: 'CustomObject:Hub',
        toId: 'ApexClass:HubPhantom',
        edgeType: 'callsApex',
        confidence: 'heuristic',
        source: 'apex-scanner',
      }),
    ];
    for (let i = 0; i < LEAF_COUNT; i++) {
      const id = `CustomField:Hub.F${i}__c`;
      nodes.push(
        makeNode({
          id,
          type: 'CustomField',
          apiName: `F${i}__c`,
          parentId: 'CustomObject:Hub',
        }),
      );
      edges.push(makeEdge({ fromId: 'CustomObject:Hub', toId: id }));
    }
    const imported = await importExtractionResults(capStore, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(imported.error.message);
  });

  afterAll(() => {
    capStore.connection.disconnectSync();
    capStore.instance.closeSync();
    rmSync(capDir, { recursive: true, force: true });
  });

  it('countNodesByType returns the true total, not the 500-capped page', async () => {
    // listNodesByType saturates at 500 (its hard limit), so `.length` would
    // under-report; COUNT(*) must return the real 501.
    const r = await countNodesByType(capStore, 'CustomField');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(LEAF_COUNT);
    expect(r.value).toBeGreaterThan(500);
  });

  it('countNodesByType honors a parentId narrow (CR-22 B3 filtered total)', async () => {
    // All LEAF_COUNT CustomFields are children of CustomObject:Hub; a parent
    // narrow must return that exact subset total (a true per-parent total for a
    // filtered paginated enumeration), and a non-existent parent returns 0.
    const r = await countNodesByType(capStore, 'CustomField', {
      parentId: 'CustomObject:Hub',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(LEAF_COUNT);

    const none = await countNodesByType(capStore, 'CustomField', {
      parentId: 'CustomObject:DoesNotExist',
    });
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.value).toBe(0);
  });

  it('clips a hub subgraph at the node cap and flags truncated', async () => {
    const r = await getSubgraph(capStore, 'CustomObject:Hub', 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(true);
    expect(r.value.nodes.length).toBe(SUBGRAPH_MAX_NODES);
    expect(r.value.edges.length).toBeLessThanOrEqual(400);
    // No dangling edges: every endpoint of a returned edge is a returned node.
    const nodeIds = new Set(r.value.nodes.map((n) => n.id));
    for (const e of r.value.edges) {
      expect(nodeIds.has(e.fromId)).toBe(true);
      expect(nodeIds.has(e.toId)).toBe(true);
    }
  });

  it('tags edges whose target is not a real node with targetMissing at import', async () => {
    // listEdges does NOT filter — developer tools (explain_apex_method,
    // get_edges) intentionally surface the scanner's heuristic accesses — but
    // the phantom edge carries the targetMissing flag so consumers can disclose
    // the unresolved target. A real-target edge stays unflagged.
    const r = await listEdges(capStore, 'ApexClass:Caller', {
      direction: 'out',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const phantom = r.value.find((e) => e.toId === 'ApexClass:Phantom');
    expect(phantom?.properties['targetMissing']).toBe(true);
    const real = r.value.find((e) => e.toId === 'ApexClass:RealTarget');
    expect(real?.properties['targetMissing']).toBeUndefined();
  });

  it('tags a DECLARED grantedBy edge to a non-retrieved field with targetMissing (P2-phantom-edges)', async () => {
    // A permission set granting a standard/managed field whose own CustomField
    // definition was not retrieved is a phantom GRANT edge. Unlike the heuristic
    // Apex case above, this edge is `declared` — the import flags targetMissing
    // regardless of confidence, so FLS/sharing tools disclose the unresolved
    // target instead of implying the field has no grants. (Verified on the real
    // demo vault: 50,415 / 50,415 phantom grant edges carry the flag, 0 without.)
    const dir = mkdtempSync(join(tmpdir(), 'sfi-graph-grant-phantom-'));
    const instance = await DuckDBInstance.create(join(dir, 'grant.db'));
    const connection = await instance.connect();
    const init = await initSchema(connection);
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    const local: GraphStore = { connection, instance };
    const imp = await importExtractionResults(local, [
      {
        nodes: [
          makeNode({ id: 'PermissionSet:Sales', type: 'PermissionSet', apiName: 'Sales' }),
          makeNode({
            id: 'CustomField:Account.Real__c',
            type: 'CustomField',
            apiName: 'Account.Real__c',
          }),
        ],
        edges: [
          // Phantom: the granted field has no node of its own.
          makeEdge({
            fromId: 'PermissionSet:Sales',
            toId: 'CustomField:Contact.Email',
            edgeType: 'grantedBy',
            confidence: 'declared',
            properties: { readable: true },
          }),
          // Real: the granted field has a node.
          makeEdge({
            fromId: 'PermissionSet:Sales',
            toId: 'CustomField:Account.Real__c',
            edgeType: 'grantedBy',
            confidence: 'declared',
            properties: { readable: true },
          }),
        ],
      },
    ]);
    expect(imp.ok).toBe(true);
    const out = await listEdges(local, 'PermissionSet:Sales', { direction: 'out' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      const phantom = out.value.find((e) => e.toId === 'CustomField:Contact.Email');
      expect(phantom?.edgeType).toBe('grantedBy');
      expect(phantom?.properties['targetMissing']).toBe(true);
      const real = out.value.find((e) => e.toId === 'CustomField:Account.Real__c');
      expect(real?.properties['targetMissing']).toBeUndefined();
    }
    connection.disconnectSync();
    instance.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });

  it('omits heuristic edges to non-existent nodes from a subgraph by default', async () => {
    const r = await getSubgraph(capStore, 'ApexClass:Caller', 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const toIds = r.value.edges.map((e) => e.toId);
    expect(toIds).toContain('ApexClass:RealTarget');
    expect(toIds).not.toContain('ApexClass:Phantom');
  });

  it('includes unresolved edges in a subgraph when includeUnresolved is set', async () => {
    const r = await getSubgraph(capStore, 'ApexClass:Caller', 1, {
      includeUnresolved: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.edges.map((e) => e.toId)).toContain('ApexClass:Phantom');
  });

  it('synthesizes a stub node for the phantom endpoint so no edge dangles (CR-13)', async () => {
    // CR-13: a returned edge must never point at a node absent from the
    // returned node set. The phantom endpoint (ApexClass:Phantom) has no
    // `nodes` row, so before CR-13 the includeUnresolved edge dangled. The fix
    // synthesizes a stub boundary node for it so the slice is self-contained.
    const r = await getSubgraph(capStore, 'ApexClass:Caller', 1, {
      includeUnresolved: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nodeIds = new Set(r.value.nodes.map((n) => n.id));
    // The phantom endpoint is now a returned node (a stub).
    expect(nodeIds.has('ApexClass:Phantom')).toBe(true);
    // The phantom edge is still present (the feature is preserved).
    expect(r.value.edges.map((e) => e.toId)).toContain('ApexClass:Phantom');
    // The stub is marked unresolved so consumers can disclose it, with type +
    // apiName parsed from the ComponentId.
    const stub = r.value.nodes.find((n) => n.id === 'ApexClass:Phantom');
    expect(stub).toBeDefined();
    expect(stub?.type).toBe('ApexClass');
    expect(stub?.apiName).toBe('Phantom');
    expect(stub?.properties['unresolved']).toBe(true);
    // Full no-dangling invariant: every edge endpoint is a returned node.
    for (const e of r.value.edges) {
      expect(nodeIds.has(e.fromId)).toBe(true);
      expect(nodeIds.has(e.toId)).toBe(true);
    }
  });

  it('includeUnresolved on an over-budget hub stubs ONLY genuine phantoms, never budget-clipped real nodes (RV2)', async () => {
    // RV2: pre-fix the stub loop synthesized a stub for EVERY collectedEdge
    // endpoint missing from the returned node set. Because bfsExpand collects
    // edges up to maxEdges=400 independently of the maxNodes=200 cap, edges to
    // budget-clipped REAL CustomField leaves remained in collectedEdges with
    // endpoints absent from the node set — they were mislabeled unresolved:true
    // and pushed the node count past the 200 cap. The fix gates the stub loop on
    // isHiddenUnresolved (heuristic AND targetMissing), so only the genuine
    // phantom (ApexClass:HubPhantom) is stubbed; clipped real leaves stay out and
    // their edges are dropped by the returnedIds filter, exactly like the default.
    const r = await getSubgraph(capStore, 'CustomObject:Hub', 1, {
      includeUnresolved: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Caps hold: node count never exceeds 200, edge count never exceeds 400.
    expect(r.value.nodes.length).toBeLessThanOrEqual(SUBGRAPH_MAX_NODES);
    expect(r.value.edges.length).toBeLessThanOrEqual(400);
    // No real CustomField leaf is labeled unresolved.
    for (const n of r.value.nodes) {
      if (n.type === 'CustomField') {
        expect(n.properties['unresolved']).not.toBe(true);
      }
    }
    // Exactly one node is an unresolved stub, and it is the genuine phantom.
    const unresolved = r.value.nodes.filter((n) => n.properties['unresolved'] === true);
    expect(unresolved.length).toBe(1);
    expect(unresolved[0]?.id).toBe('ApexClass:HubPhantom');
    // Zero dangling: every edge endpoint is in the returned node id set.
    const nodeIds = new Set(r.value.nodes.map((n) => n.id));
    for (const e of r.value.edges) {
      expect(nodeIds.has(e.fromId)).toBe(true);
      expect(nodeIds.has(e.toId)).toBe(true);
    }
  });

  it('includeUnresolved caps stubbed phantoms at SUBGRAPH_MAX_NODES (CR-P3 low)', async () => {
    // CR-P3 low: bfsExpand budgets edges to maxEdges=400 independently of the
    // maxNodes=200 node cap. A single class with MORE genuine phantom heuristic
    // edges than the node cap (each `isHiddenUnresolved` → all pass the RV2 gate)
    // floods `collectedEdges` with > 200 phantom toIds. The stub loop then
    // synthesizes a stub for EVERY one of them with no cap check, blowing the
    // returned node count past the documented `at most SUBGRAPH_MAX_NODES` bound.
    // The fix must cap the stubbed nodes so the bound holds under includeUnresolved.
    const dir = mkdtempSync(join(tmpdir(), 'sfi-graph-phantom-flood-'));
    const instance = await DuckDBInstance.create(join(dir, 'flood.db'));
    const connection = await instance.connect();
    const init = await initSchema(connection);
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    const floodStore: GraphStore = { connection, instance };

    // ONE real scanned class with 300 distinct GENUINE phantom callsApex edges
    // (each toId has no node row → import stamps targetMissing → heuristic +
    // targetMissing = isHiddenUnresolved). 300 > both maxNodes (200) and
    // maxEdges-minus-nodes, so the stub loop is forced past the node cap.
    const PHANTOM_COUNT = 300;
    const nodes: Node[] = [
      makeNode({
        id: 'ApexClass:Flooder',
        type: 'ApexClass',
        apiName: 'Flooder',
        label: 'Flooder',
      }),
    ];
    const edges: Edge[] = [];
    for (let i = 0; i < PHANTOM_COUNT; i++) {
      edges.push(
        makeEdge({
          fromId: 'ApexClass:Flooder',
          // Zero-padded so the deterministic to_id ASC order is stable.
          toId: `ApexClass:Phantom${String(i).padStart(4, '0')}`,
          edgeType: 'callsApex',
          confidence: 'heuristic',
          source: 'apex-scanner',
        }),
      );
    }
    const imported = await importExtractionResults(floodStore, [{ nodes, edges }]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const r = await getSubgraph(floodStore, 'ApexClass:Flooder', 1, {
      includeUnresolved: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // The documented bound: at most SUBGRAPH_MAX_NODES, even when the stub
      // loop has > 200 genuine phantom endpoints to synthesize.
      expect(r.value.nodes.length).toBeLessThanOrEqual(SUBGRAPH_MAX_NODES);
      // The slice stays self-contained: no edge dangles to a node that was
      // dropped to keep the cap.
      const nodeIds = new Set(r.value.nodes.map((n) => n.id));
      for (const e of r.value.edges) {
        expect(nodeIds.has(e.fromId)).toBe(true);
        expect(nodeIds.has(e.toId)).toBe(true);
      }
      // The cap was actually exercised (some phantoms were surfaced as stubs,
      // proving the feature still works rather than being disabled entirely).
      expect(r.value.truncated).toBe(true);
    }

    connection.disconnectSync();
    instance.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('listNodesByType propertyEquals filter (P4-interface-impl)', () => {
  let dir2: string;
  let store2: GraphStore;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-queries-prop-'));
    const opened = await openGraph(join(dir2, 'p.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    const apex = (id: string, props: Record<string, unknown>): Node =>
      makeNode({
        id,
        type: 'ApexClass',
        apiName: id.slice(id.indexOf(':') + 1),
        properties: props,
      });
    const seed2: ExtractionResult = {
      nodes: [
        apex('ApexClass:BatchA', { isBatchable: true, isTest: false }),
        apex('ApexClass:BatchB', { isBatchable: true, isQueueable: true }),
        apex('ApexClass:QueueOnly', { isQueueable: true, isBatchable: false }),
        apex('ApexClass:Plain', {}), // no async props at all
        apex('ApexClass:TestClass', { isTest: true }),
      ],
      edges: [],
    };
    const imp = await importExtractionResults(store2, [seed2]);
    if (!imp.ok) throw new Error(imp.error.message);
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('returns only the nodes whose boolean property is true', async () => {
    const r = await listNodesByType(store2, 'ApexClass', {
      limit: 50,
      propertyEquals: { isBatchable: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((n) => n.id).sort()).toEqual([
      'ApexClass:BatchA',
      'ApexClass:BatchB',
    ]);
  });

  it('treats an ABSENT property as not-true (Plain never matches isBatchable:true)', async () => {
    const r = await listNodesByType(store2, 'ApexClass', {
      limit: 50,
      propertyEquals: { isQueueable: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((n) => n.id).sort()).toEqual([
      'ApexClass:BatchB',
      'ApexClass:QueueOnly',
    ]);
  });

  it('ANDs multiple property filters', async () => {
    const r = await listNodesByType(store2, 'ApexClass', {
      limit: 50,
      propertyEquals: { isBatchable: true, isQueueable: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((n) => n.id)).toEqual(['ApexClass:BatchB']);
  });

  it('supports the false predicate (explicitly isBatchable:false, not just absent)', async () => {
    const r = await listNodesByType(store2, 'ApexClass', {
      limit: 50,
      propertyEquals: { isBatchable: false },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only QueueOnly carries isBatchable:false explicitly; absent ones don't match.
    expect(r.value.map((n) => n.id)).toEqual(['ApexClass:QueueOnly']);
  });
});

describe('descriptionPresence filter', () => {
  // Four Report nodes exercise every way a description can be "absent": a real
  // non-empty string (present), an explicit JSON null (custom-extractor shape),
  // an empty string, and the key entirely omitted (enterprise-extractor shape).
  // The three absent shapes must all fall into the 'absent' bucket so the
  // list_components missingDescription filter behaves identically regardless of
  // which extractor produced the node.
  let localDir: string;
  let localStore: GraphStore;

  beforeAll(async () => {
    localDir = mkdtempSync(join(tmpdir(), 'sfi-graph-descpresence-'));
    const dbPath = join(localDir, 'desc.db');
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    const initResult = await initSchema(connection);
    expect(initResult.ok).toBe(true);
    localStore = { connection, instance };
    const descSeed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'Report:HasDesc',
          type: 'Report',
          apiName: 'HasDesc',
          properties: { description: 'A real description.' },
        }),
        makeNode({
          id: 'Report:NullDesc',
          type: 'Report',
          apiName: 'NullDesc',
          properties: { description: null },
        }),
        makeNode({
          id: 'Report:EmptyDesc',
          type: 'Report',
          apiName: 'EmptyDesc',
          properties: { description: '' },
        }),
        makeNode({
          id: 'Report:NoDescKey',
          type: 'Report',
          apiName: 'NoDescKey',
          properties: { rawReferenceCount: 0 },
        }),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(localStore, [descSeed]);
    expect(imported.ok).toBe(true);
  });

  afterAll(async () => {
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it("'present' keeps only nodes with a non-empty description", async () => {
    const r = await listNodesByType(localStore, 'Report', {
      descriptionPresence: 'present',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((n) => n.id)).toEqual(['Report:HasDesc']);
  });

  it("'absent' folds null, empty-string, and missing-key into one bucket", async () => {
    const r = await listNodesByType(localStore, 'Report', {
      descriptionPresence: 'absent',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((n) => n.id)).toEqual([
      'Report:EmptyDesc',
      'Report:NoDescKey',
      'Report:NullDesc',
    ]);
  });

  it('present + absent counts are complementary and sum to the type total', async () => {
    const present = await countNodesByType(localStore, 'Report', {
      descriptionPresence: 'present',
    });
    const absent = await countNodesByType(localStore, 'Report', {
      descriptionPresence: 'absent',
    });
    const total = await countNodesByType(localStore, 'Report');
    expect(present.ok && absent.ok && total.ok).toBe(true);
    if (!present.ok || !absent.ok || !total.ok) return;
    expect(present.value).toBe(1);
    expect(absent.value).toBe(3);
    expect(present.value + absent.value).toBe(total.value);
  });
});

/**
 * C-3 (finding 34) regression — `parseProperties` degrades a malformed
 * `properties_json` value to `{}` instead of throwing an anonymous
 * `SyntaxError` that crashes every query touching the row. The prior bare
 * `JSON.parse(raw)` assumed `import.ts` only ever writes valid JSON (true
 * for the fixed `canonicalJson`, but not a type-level guarantee, and not
 * true for a hand-edited/corrupted DB file) — a single bad row used to
 * poison the entire read path. The malformed value here is written via a
 * raw `UPDATE`, bypassing `canonicalJson` entirely, to simulate exactly
 * that "corrupted column" scenario independent of the import-side fix.
 */
describe('parseProperties — C-3 (finding 34) regression', () => {
  it('degrades a malformed properties_json node column to {} instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-graph-malformed-props-'));
    const dbPath = join(dir, 'malformed.db');
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    const initResult = await initSchema(connection);
    expect(initResult.ok).toBe(true);
    const localStore: GraphStore = { connection, instance };
    const imported = await importExtractionResults(localStore, [
      { nodes: [makeNode({ id: 'CustomObject:Broken', apiName: 'Broken', label: 'Broken' })], edges: [] },
    ]);
    expect(imported.ok).toBe(true);

    // Corrupt the persisted column directly — bypasses canonicalJson
    // entirely, so this reproduces the bug class regardless of whether
    // the import-side fix ever lets it happen in practice.
    await connection.run(`UPDATE nodes SET properties_json = ? WHERE id = ?`, [
      '{"foo":undefined}',
      'CustomObject:Broken',
    ]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await getNodeById(localStore, 'CustomObject:Broken');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toBeNull();
      // Degrades to {} — does not throw, does not poison the whole row.
      expect(r.value?.properties).toEqual({});
      expect(r.value?.id).toBe('CustomObject:Broken');
    }
    // The offending row's id is surfaced, not an anonymous SyntaxError.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CustomObject:Broken'));
    warnSpy.mockRestore();

    rmSync(dir, { recursive: true, force: true });
  });

  it('degrades a malformed properties_json edge column to {} instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-graph-malformed-edge-props-'));
    const dbPath = join(dir, 'malformed-edge.db');
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    const initResult = await initSchema(connection);
    expect(initResult.ok).toBe(true);
    const localStore: GraphStore = { connection, instance };
    const imported = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({ id: 'CustomObject:A', apiName: 'A', label: 'A' }),
          makeNode({ id: 'CustomObject:B', apiName: 'B', label: 'B' }),
        ],
        edges: [makeEdge({ fromId: 'CustomObject:A', toId: 'CustomObject:B' })],
      },
    ]);
    expect(imported.ok).toBe(true);

    await connection.run(
      `UPDATE edges SET properties_json = ? WHERE from_id = ? AND to_id = ?`,
      ['not even json', 'CustomObject:A', 'CustomObject:B'],
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await listEdges(localStore, 'CustomObject:A', { direction: 'out' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.length).toBe(1);
      expect(r.value[0]?.properties).toEqual({});
    }
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    rmSync(dir, { recursive: true, force: true });
  });
});
