/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import {
  applyChangeSet,
  changeSetSize,
  computeChangeSet,
  type ChangeSet,
} from '../src/apply-change-set.js';
import { importExtractionResults } from '../src/import.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

// One fresh DuckDB file per store keeps tests independent (mirrors
// import.test.ts). The whole suite tears down in afterAll.
let tempDir: string;
const stores: GraphStore[] = [];

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-apply-'));
});

afterAll(() => {
  for (const store of stores) {
    store.connection.disconnectSync();
    store.instance.closeSync();
  }
  rmSync(tempDir, { recursive: true, force: true });
});

let storeCounter = 0;
const makeStore = async (): Promise<GraphStore> => {
  const dbPath = join(tempDir, `apply-${storeCounter++}.db`);
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const initResult = await initSchema(connection);
  if (!initResult.ok) throw new Error(`initSchema failed: ${initResult.error.message}`);
  const store: GraphStore = { connection, instance };
  stores.push(store);
  return store;
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

/**
 * Serialize the WHOLE graph (every column of every row) in deterministic PK
 * order. Two graphs with the same digest are byte-identical at the row level —
 * this is the headline equivalence oracle.
 */
const dump = async (store: GraphStore): Promise<string> => {
  const q = async (sql: string): Promise<readonly Record<string, unknown>[]> => {
    const reader = await store.connection.runAndReadAll(sql);
    return reader.getRowObjectsJS() as readonly Record<string, unknown>[];
  };
  const nodes = await q(
    `SELECT id, type, api_name, label, parent_id, source_path,
            last_modified_date, last_modified_by, api_version, properties_json
     FROM nodes ORDER BY id`,
  );
  const edges = await q(
    `SELECT from_id, to_id, edge_type, confidence, source, properties_json
     FROM edges ORDER BY from_id, to_id, edge_type, source`,
  );
  return JSON.stringify({ nodes, edges });
};

const importInto = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
): Promise<void> => {
  const r = await importExtractionResults(store, results);
  if (!r.ok) throw new Error(`import failed: ${r.error.message}`);
};

// ---------------------------------------------------------------------------
// S1 → S2 fixtures, engineered to exercise every diff dimension at once.
// ---------------------------------------------------------------------------
const ACCT = 'CustomObject:Acct';
const F1 = 'CustomField:Acct.F1__c';
const F2 = 'CustomField:Acct.F2__c'; // removed in S2
const F3 = 'CustomField:Acct.F3__c'; // added in S2
const GHOST = 'CustomObject:Ghost'; // added in S2 (clears a targetMissing)
const SVC = 'ApexClass:Svc';

const s1 = (): ExtractionResult[] => [
  {
    nodes: [
      makeNode({ id: ACCT, apiName: 'Acct', type: 'CustomObject' }),
      makeNode({ id: F1, apiName: 'Acct.F1__c', type: 'CustomField', parentId: ACCT }),
      makeNode({ id: F2, apiName: 'Acct.F2__c', type: 'CustomField', parentId: ACCT }),
      makeNode({ id: SVC, apiName: 'Svc', type: 'ApexClass', properties: { v: 1 } }),
    ],
    edges: [
      makeEdge({ fromId: ACCT, toId: F1 }), // payload changes in S2
      makeEdge({ fromId: ACCT, toId: F2 }), // deleted in S2 (F2 gone)
      // Svc references Ghost (absent in S1 → targetMissing true; cleared in S2)
      makeEdge({ fromId: SVC, toId: GHOST, edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner' }),
      // Svc references F2 (present in S1 → no flag; flips to true in S2 once F2 is deleted)
      makeEdge({ fromId: SVC, toId: F2, edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner' }),
    ],
  },
];

const s2 = (): ExtractionResult[] => [
  {
    nodes: [
      makeNode({ id: ACCT, apiName: 'Acct', type: 'CustomObject' }),
      makeNode({ id: F1, apiName: 'Acct.F1__c', type: 'CustomField', parentId: ACCT }),
      makeNode({ id: F3, apiName: 'Acct.F3__c', type: 'CustomField', parentId: ACCT }), // added
      makeNode({ id: GHOST, apiName: 'Ghost', type: 'CustomObject' }), // added
      makeNode({ id: SVC, apiName: 'Svc', type: 'ApexClass', properties: { v: 2 } }), // shape change
      // F2 removed entirely
    ],
    edges: [
      makeEdge({ fromId: ACCT, toId: F1, properties: { tag: 'changed' } }), // payload change
      makeEdge({ fromId: ACCT, toId: F3 }), // added
      makeEdge({ fromId: SVC, toId: GHOST, edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner' }), // target now present → clears
      makeEdge({ fromId: SVC, toId: F2, edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner' }), // target now gone → flips
      // ACCT→F2 parentOf removed
    ],
  },
];

describe('applyChangeSet — byte-identical to cold rebuild (invariant #1)', () => {
  it('reconciles S1→S2 to a graph byte-identical to a cold S2 rebuild', async () => {
    const cold = await makeStore();
    await importInto(cold, s2());
    const coldDump = await dump(cold);

    const incremental = await makeStore();
    await importInto(incremental, s1());
    const csResult = await computeChangeSet(incremental, s2());
    expect(csResult.ok).toBe(true);
    if (!csResult.ok) return;
    const applied = await applyChangeSet(incremental, csResult.value);
    expect(applied.ok).toBe(true);

    expect(await dump(incremental)).toBe(coldDump);
  });

  it('partitions the diff correctly across every dimension', async () => {
    const store = await makeStore();
    await importInto(store, s1());
    const csResult = await computeChangeSet(store, s2());
    expect(csResult.ok).toBe(true);
    if (!csResult.ok) return;
    const cs = csResult.value;

    const upsertNodeIds = new Set(cs.upsertNodes.map((n) => n.id));
    // added + shape-changed nodes are upserted; unchanged ACCT/F1 are not.
    expect(upsertNodeIds.has(F3)).toBe(true);
    expect(upsertNodeIds.has(GHOST)).toBe(true);
    expect(upsertNodeIds.has(SVC)).toBe(true);
    expect(upsertNodeIds.has(ACCT)).toBe(false);
    expect(upsertNodeIds.has(F1)).toBe(false);
    // F2 disappeared → delete.
    expect(cs.deleteNodeIds).toEqual([F2]);

    // edges: the payload change, the new edge, and BOTH targetMissing flips.
    const upsertEdge = (from: string, to: string): Edge | undefined =>
      cs.upsertEdges.find((e) => e.fromId === from && e.toId === to);
    expect(upsertEdge(ACCT, F1)).toBeDefined(); // payload changed
    expect(upsertEdge(ACCT, F3)).toBeDefined(); // added
    expect(upsertEdge(SVC, GHOST)).toBeDefined(); // targetMissing true→false
    expect(upsertEdge(SVC, F2)).toBeDefined(); // targetMissing false→true
    // the removed parentOf edge is deleted.
    expect(
      cs.deleteEdgeKeys.some((k) => k.fromId === ACCT && k.toId === F2),
    ).toBe(true);
  });

  it('an identical re-diff is a no-op (empty change set, graph unchanged)', async () => {
    const store = await makeStore();
    await importInto(store, s2());
    const before = await dump(store);
    const csResult = await computeChangeSet(store, s2());
    expect(csResult.ok).toBe(true);
    if (!csResult.ok) return;
    expect(changeSetSize(csResult.value)).toBe(0);
    const applied = await applyChangeSet(store, csResult.value);
    expect(applied.ok).toBe(true);
    expect(await dump(store)).toBe(before);
  });

  it('applies onto an empty graph identically to a cold import', async () => {
    const cold = await makeStore();
    await importInto(cold, s2());

    const fromEmpty = await makeStore();
    const csResult = await computeChangeSet(fromEmpty, s2());
    expect(csResult.ok).toBe(true);
    if (!csResult.ok) return;
    expect(csResult.value.deleteNodeIds).toEqual([]);
    const applied = await applyChangeSet(fromEmpty, csResult.value);
    expect(applied.ok).toBe(true);
    expect(await dump(fromEmpty)).toBe(await dump(cold));
  });

  it('matches cold dedup order: nodes last-writer-wins, edges first-writer-wins', async () => {
    // Two results with a duplicate node id (different label) and a duplicate
    // edge PK (different confidence). Cold import keeps the LAST node and the
    // FIRST edge; the incremental desired-set must reproduce both.
    const dupResults: ExtractionResult[] = [
      {
        nodes: [makeNode({ id: ACCT, label: 'first' })],
        edges: [makeEdge({ fromId: ACCT, toId: F1, confidence: 'declared' })],
      },
      {
        nodes: [makeNode({ id: ACCT, label: 'second' })],
        edges: [makeEdge({ fromId: ACCT, toId: F1, confidence: 'heuristic' })],
      },
      { nodes: [makeNode({ id: F1, parentId: ACCT })], edges: [] },
    ];
    const cold = await makeStore();
    await importInto(cold, dupResults);

    const incremental = await makeStore();
    const csResult = await computeChangeSet(incremental, dupResults);
    expect(csResult.ok).toBe(true);
    if (!csResult.ok) return;
    const applied = await applyChangeSet(incremental, csResult.value);
    expect(applied.ok).toBe(true);
    expect(await dump(incremental)).toBe(await dump(cold));
  });

  it('canonicalizes callsApex targets before edge dedupe (GRF-01 / A7 parity)', async () => {
    const apexResults: ExtractionResult[] = [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:pkb_Controller',
            type: 'ApexClass',
            apiName: 'pkb_Controller',
            sourcePath: 'classes/pkb_Controller.cls',
          }),
          makeNode({
            id: 'ApexClass:Caller',
            type: 'ApexClass',
            apiName: 'Caller',
            sourcePath: 'classes/Caller.cls',
          }),
        ],
        edges: [],
      },
      {
        nodes: [],
        edges: [
          {
            fromId: 'ApexClass:Caller',
            toId: 'ApexClass:pkb_controller',
            edgeType: 'callsApex',
            confidence: 'heuristic',
            source: 'apex-scanner',
            properties: {},
          },
        ],
      },
    ];
    const cold = await makeStore();
    await importInto(cold, apexResults);

    const incremental = await makeStore();
    const csResult = await computeChangeSet(incremental, apexResults);
    expect(csResult.ok).toBe(true);
    if (!csResult.ok) return;
    const applied = await applyChangeSet(incremental, csResult.value);
    expect(applied.ok).toBe(true);
    expect(await dump(incremental)).toBe(await dump(cold));
  });
});

describe('applyChangeSet — consistency under failure (invariant #2)', () => {
  it('rolls back fully when a write throws mid-transaction (no partial state)', async () => {
    const store = await makeStore();
    await importInto(store, s1());
    const before = await dump(store);

    // A node with a NULL api_name violates the NOT NULL column constraint, so
    // the INSERT throws partway through the upsert loop — after the deletes and
    // some writes have already run inside the open transaction.
    const badNode = makeNode({
      id: 'CustomObject:Bad',
      apiName: null as unknown as string,
    });
    const badCs: ChangeSet = {
      upsertNodes: [makeNode({ id: GHOST, apiName: 'Ghost' }), badNode],
      deleteNodeIds: [F2],
      upsertEdges: [],
      deleteEdgeKeys: [],
      finalNodeIds: new Set([ACCT, F1, GHOST, SVC, 'CustomObject:Bad']),
      desiredNodeCount: 5,
      desiredEdgeCount: 4,
    };
    const applied = await applyChangeSet(store, badCs);
    expect(applied.ok).toBe(false);
    // The graph is byte-for-byte what it was before the failed apply.
    expect(await dump(store)).toBe(before);
  });

  it('rolls back and reports when the post-apply count self-check fails', async () => {
    const store = await makeStore();
    await importInto(store, s1());
    const before = await dump(store);

    const csResult = await computeChangeSet(store, s2());
    expect(csResult.ok).toBe(true);
    if (!csResult.ok) return;
    // Corrupt the expected counts so the safeguard trips after the writes.
    const tampered: ChangeSet = {
      ...csResult.value,
      desiredNodeCount: csResult.value.desiredNodeCount + 7,
    };
    const applied = await applyChangeSet(store, tampered);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error.message).toContain('count mismatch');
    expect(await dump(store)).toBe(before);
  });
});

describe('incremental reconcile mints relationship-resolver edges (regression)', () => {
  /**
   * Relationship-resolver edges exist ONLY because an import-time pass mints
   * them — no extractor emits them. When `computeChangeSet` did not run that
   * pass, every one of them read as absent-from-desired, and on the whole-graph
   * path (`pruneNodeTypes` undefined) the preserve-guard is skipped and absent
   * edges are DELETED. A routine incremental refresh therefore dropped real
   * dependency evidence and returned those fields to "no referrers" — which
   * `safe_to_delete_field` reads as deletable.
   *
   * A two-object model: Enrolment__c holds a lookup to Programme__c, and a
   * formula on Enrolment__c reads Programme__c.Status__c through the traversal.
   */
  const model = (): readonly ExtractionResult[] => {
    const lookup = makeNode({
      id: 'CustomField:Enrolment__c.Programme__c',
      type: 'CustomField',
      apiName: 'Programme__c',
      parentId: 'CustomObject:Enrolment__c',
      properties: { referenceTo: 'Programme__c', relationshipName: 'Enrolments' },
    });
    const target = makeNode({
      id: 'CustomField:Programme__c.Status__c',
      type: 'CustomField',
      apiName: 'Status__c',
      parentId: 'CustomObject:Programme__c',
      properties: {},
    });
    const formula = makeNode({
      id: 'CustomField:Enrolment__c.Programme_Status__c',
      type: 'CustomField',
      apiName: 'Programme_Status__c',
      parentId: 'CustomObject:Enrolment__c',
      properties: {
        isFormula: true,
        formulaRelationshipRefs: ['Programme__r.Status__c'],
      },
    });
    return [{ nodes: [lookup, target, formula], edges: [] }];
  };

  const resolverEdges = async (store: GraphStore): Promise<number> => {
    const reader = await store.connection.runAndReadAll(
      "SELECT COUNT(*) AS n FROM edges WHERE source = 'relationship-resolver'",
    );
    const rows = reader.getRowObjectsJS() as readonly Record<string, unknown>[];
    return Number(rows[0]?.['n'] ?? 0);
  };

  it('a cold import mints the traversal edge', async () => {
    const store = await makeStore();
    const r = await importExtractionResults(store, model());
    expect(r.ok).toBe(true);
    expect(await resolverEdges(store)).toBe(1);
  });

  it('FAIL-BEFORE/PASS-AFTER: a whole-graph incremental reconcile PRESERVES it instead of deleting it', async () => {
    const store = await makeStore();
    const cold = await importExtractionResults(store, model());
    expect(cold.ok).toBe(true);
    expect(await resolverEdges(store)).toBe(1);

    // Same source tree, reconciled incrementally with no pruneNodeTypes — the
    // whole-graph path, where every absent-from-desired edge is deleted.
    const cs = await computeChangeSet(store, model());
    expect(cs.ok).toBe(true);
    if (!cs.ok) return;

    // Before the fix this asserted the failure: the edge was in deleteEdgeKeys.
    expect(
      cs.value.deleteEdgeKeys.filter((k) => k.source === 'relationship-resolver'),
    ).toEqual([]);

    const applied = await applyChangeSet(store, cs.value);
    expect(applied.ok).toBe(true);
    expect(await resolverEdges(store)).toBe(1);
  });
});
