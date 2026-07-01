/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type {
  ComponentType,
  Edge,
  ExtractionResult,
  Node,
} from '@sf-intelligence/contracts';

import {
  computeChangeSet,
  pruneStaleNodes,
} from '../src/apply-change-set.js';
import { IMPORT_BATCH_SIZE, importExtractionResults } from '../src/import.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

// Part 2 of CR-20: the scoped/pruned WITH-PULL incremental path. A scoped
// `sfi refresh --types Flow` reconciles ONLY type Flow but the graph holds
// other types (ApexClass, ...). The OLD path routed this through applyChangeSet
// whose whole-graph self-check (global count == reconciled-only desiredNodeCount)
// is WRONG for a partial reconcile, so it rolled back and orphaned stale nodes
// (and on the CLI branch, hard-failed the refresh). The fix (approach b) prunes
// the computed type-scoped delete lists via chunked DELETE transactions, never
// touching surviving types.

let tempDir: string;
const stores: GraphStore[] = [];

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-prune-'));
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
  const dbPath = join(tempDir, `prune-${storeCounter++}.db`);
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const initResult = await initSchema(connection);
  if (!initResult.ok) throw new Error(`initSchema failed: ${initResult.error.message}`);
  const store: GraphStore = { connection, instance };
  stores.push(store);
  return store;
};

const node = (id: string, overrides?: Partial<Node>): Node => {
  const sep = id.indexOf(':');
  const type = id.slice(0, sep) as ComponentType;
  const apiName = id.slice(sep + 1);
  return {
    id,
    type,
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: `src/${apiName}`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
    ...overrides,
  };
};

const edge = (fromId: string, toId: string, overrides?: Partial<Edge>): Edge => ({
  fromId,
  toId,
  edgeType: 'references',
  confidence: 'declared',
  source: 'extractor:test',
  properties: {},
  ...overrides,
});

const importInto = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
): Promise<void> => {
  const r = await importExtractionResults(store, results);
  if (!r.ok) throw new Error(`import failed: ${r.error.message}`);
};

const nodeIds = async (store: GraphStore): Promise<Set<string>> => {
  const reader = await store.connection.runAndReadAll('SELECT id FROM nodes ORDER BY id');
  const rows = reader.getRowObjectsJS() as ReadonlyArray<Record<string, unknown>>;
  return new Set(rows.map((r) => r['id'] as string));
};

const edgePks = async (store: GraphStore): Promise<Set<string>> => {
  const reader = await store.connection.runAndReadAll(
    'SELECT from_id, to_id, edge_type, source FROM edges',
  );
  const rows = reader.getRowObjectsJS() as ReadonlyArray<Record<string, unknown>>;
  return new Set(
    rows.map(
      (r) =>
        `${r['from_id'] as string}|${r['to_id'] as string}|${r['edge_type'] as string}|${r['source'] as string}`,
    ),
  );
};

// Drive the full scoped/pruned reconcile the way refresh.ts does it (approach b):
// importExtractionResults(results) then prune the stale reconciled-type rows.
const scopedReconcile = async (
  store: GraphStore,
  results: readonly ExtractionResult[],
  pruneNodeTypes: ReadonlySet<ComponentType>,
): Promise<void> => {
  await importInto(store, results);
  const cs = await computeChangeSet(store, results, { pruneNodeTypes });
  if (!cs.ok) throw new Error(`computeChangeSet failed: ${cs.error.message}`);
  const pruned = await pruneStaleNodes(store, cs.value);
  if (!pruned.ok) throw new Error(`pruneStaleNodes failed: ${pruned.error.message}`);
};

describe('scoped prune — multi-type graph (CR-20 data-safety headline)', () => {
  it('prunes stale X, keeps fresh X, and type Y SURVIVES', async () => {
    const store = await makeStore();
    // Graph: type Y (ApexClass:Y1, Y2) + type X (Flow:Xold).
    await importInto(store, [
      {
        nodes: [
          node('ApexClass:Y1'),
          node('ApexClass:Y2'),
          node('Flow:Xold'),
        ],
        edges: [],
      },
    ]);

    // Scoped re-extract of Flow only: Xold gone, Xnew present.
    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:Xnew')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    expect(ids.has('Flow:Xold')).toBe(false); // stale X pruned
    expect(ids.has('Flow:Xnew')).toBe(true); // fresh X present
    expect(ids.has('ApexClass:Y1')).toBe(true); // type Y survives
    expect(ids.has('ApexClass:Y2')).toBe(true); // type Y survives
  });

  it('orphan-edge completeness: X-incident edges gone, Y<->Y edges remain', async () => {
    const store = await makeStore();
    await importInto(store, [
      {
        nodes: [
          node('ApexClass:Y1'),
          node('ApexClass:Y2'),
          node('Flow:Xold'),
        ],
        edges: [
          edge('ApexClass:Y1', 'Flow:Xold'), // inbound to X from Y
          edge('Flow:Xold', 'ApexClass:Y2'), // outbound from X to Y
          edge('ApexClass:Y1', 'ApexClass:Y2'), // Y<->Y, must survive
        ],
      },
    ]);

    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:Xnew')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    const pks = await edgePks(store);
    expect(ids.has('Flow:Xold')).toBe(false);
    expect(ids.has('ApexClass:Y1')).toBe(true);
    expect(ids.has('ApexClass:Y2')).toBe(true);
    // every edge incident to X is gone
    expect(pks.has('ApexClass:Y1|Flow:Xold|references|extractor:test')).toBe(false);
    expect(pks.has('Flow:Xold|ApexClass:Y2|references|extractor:test')).toBe(false);
    // Y<->Y edge survives
    expect(pks.has('ApexClass:Y1|ApexClass:Y2|references|extractor:test')).toBe(true);
  });

  it('over-cap scoped prune STILL prunes (never no-ops, never fullRebuild)', async () => {
    const store = await makeStore();
    // Seed > INCREMENTAL_DELTA_CAP worth of stale Flow nodes + a survivor Y.
    const staleFlows: Node[] = [];
    for (let i = 0; i < IMPORT_BATCH_SIZE * 5 + 7; i += 1) {
      staleFlows.push(node(`Flow:Stale${i}`));
    }
    await importInto(store, [
      { nodes: [node('ApexClass:Y1'), ...staleFlows], edges: [] },
    ]);

    // Reconcile Flow to a single fresh node → all stale Flows must drop.
    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:Fresh')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    expect(ids.has('ApexClass:Y1')).toBe(true);
    expect(ids.has('Flow:Fresh')).toBe(true);
    for (let i = 0; i < staleFlows.length; i += 1) {
      expect(ids.has(`Flow:Stale${i}`)).toBe(false);
    }
  });

  it('empty prune delta is a no-op', async () => {
    const store = await makeStore();
    await importInto(store, [
      { nodes: [node('ApexClass:Y1'), node('Flow:X1')], edges: [] },
    ]);
    const before = await nodeIds(store);
    // Reconcile Flow to the SAME content → nothing to prune.
    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:X1')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );
    const after = await nodeIds(store);
    expect([...after].sort()).toEqual([...before].sort());
  });
});

// CR-P3-1: silent inbound-cross-extractor-edge data loss on a scoped refresh.
//
// The OLD `deleteEdgeKeys` guard was `touchesPrunedType` ALONE. On a scoped
// `sfi refresh --types Flow`, an inbound cross-extractor edge whose emitter did
// NOT re-run (e.g. QuickAction:N -> Flow:Y, source quick-action-extractor) is
// absent from `desiredEdges` (its extractor produced no results), touches Flow,
// and was DELETED even though BOTH endpoints survive — silent permanent loss of
// an inbound dependency edge. CR-20 `pruneStaleNodes` removed the self-check
// that used to roll this back, so the loss now commits.
//
// The HYBRID criterion: with `pruneNodeTypes` set, delete an absent-from-desired
// edge IFF (i) it is incident to a DELETED node, OR (ii) its source re-ran AND
// it touches a pruned type. `reRanSources` is derived ONLY from `desiredEdges`,
// so an edge from a non-reconciled emitter is preserved when both endpoints
// survive.
//
// These cases use a DISTINCT `source` per emitter (NOT the default test source)
// so they can distinguish the fix from the bug: the headline bug turns on the
// emitting extractor NOT being in `reRanSources`, which only shows up when the
// surviving-but-stale edge's source differs from the re-run extractor's source.
describe('scoped prune — inbound cross-extractor edge preservation (CR-P3-1)', () => {
  it('CASE A (req #1): inbound QuickAction->Flow edge into a SURVIVING Flow is PRESERVED', async () => {
    const store = await makeStore();
    // Graph: QuickAction:NewLead -> Flow:Welcome, emitted by quick-action-extractor.
    await importInto(store, [
      {
        nodes: [node('QuickAction:NewLead'), node('Flow:Welcome')],
        edges: [
          edge('QuickAction:NewLead', 'Flow:Welcome', {
            source: 'quick-action-extractor',
          }),
        ],
      },
    ]);

    // Scoped `--types Flow`: the flow extractor re-emits Flow:Welcome ONLY (no
    // edges). quick-action-extractor did NOT re-run, so its inbound edge is
    // absent from desiredEdges, touches the pruned type Flow, yet BOTH endpoints
    // survive → it MUST be preserved.
    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:Welcome')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    const pks = await edgePks(store);
    expect(ids.has('Flow:Welcome')).toBe(true);
    expect(ids.has('QuickAction:NewLead')).toBe(true);
    // The headline assertion: the inbound edge from a non-reconciled emitter
    // into a surviving Flow node MUST survive (current code wrongly deletes it).
    expect(pks.has('QuickAction:NewLead|Flow:Welcome|references|quick-action-extractor')).toBe(
      true,
    );
  });

  it('CASE B (req #2): genuinely-stale same-survivor edge the re-run extractor stopped emitting is DELETED', async () => {
    const store = await makeStore();
    // Flow:OrderSync -> CustomObject:Order (the soon-to-be-stale edge) plus a
    // second flow-extractor edge to CustomObject:Product, both emitted by
    // flow-extractor. Both endpoints of the stale edge survive.
    await importInto(store, [
      {
        nodes: [
          node('Flow:OrderSync'),
          node('CustomObject:Order'),
          node('CustomObject:Product'),
        ],
        edges: [
          edge('Flow:OrderSync', 'CustomObject:Order', {
            edgeType: 'writesTo',
            source: 'flow-extractor',
          }),
          edge('Flow:OrderSync', 'CustomObject:Product', {
            edgeType: 'writesTo',
            source: 'flow-extractor',
          }),
        ],
      },
    ]);

    // flow-extractor RE-RUNS (it re-emits Flow:OrderSync and at least one
    // flow-extractor edge → flow-extractor ∈ reRanSources) but STOPS emitting
    // the Order edge; both endpoints survive. The stale Order edge's source DID
    // re-run and it touches the pruned type Flow → genuinely stale, MUST delete.
    // The still-emitted Product edge proves the extractor really re-ran.
    await scopedReconcile(
      store,
      [
        {
          nodes: [node('Flow:OrderSync')],
          edges: [
            edge('Flow:OrderSync', 'CustomObject:Product', {
              edgeType: 'writesTo',
              source: 'flow-extractor',
            }),
          ],
        },
      ],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    const pks = await edgePks(store);
    expect(ids.has('Flow:OrderSync')).toBe(true);
    expect(ids.has('CustomObject:Order')).toBe(true);
    expect(ids.has('CustomObject:Product')).toBe(true);
    // The stale edge is deleted (source re-ran + touches pruned type Flow).
    expect(pks.has('Flow:OrderSync|CustomObject:Order|writesTo|flow-extractor')).toBe(false);
    // The still-emitted edge survives.
    expect(pks.has('Flow:OrderSync|CustomObject:Product|writesTo|flow-extractor')).toBe(true);
  });

  it('CASE C (req #3): BOTH edges incident to a DELETED Flow node are removed (orphan clause)', async () => {
    const store = await makeStore();
    // Flow:Deprecated has an outbound flow-extractor edge AND an inbound
    // quick-action-extractor edge.
    await importInto(store, [
      {
        nodes: [
          node('Flow:Deprecated'),
          node('CustomObject:Account'),
          node('QuickAction:Old'),
        ],
        edges: [
          edge('Flow:Deprecated', 'CustomObject:Account', {
            source: 'flow-extractor',
          }),
          edge('QuickAction:Old', 'Flow:Deprecated', {
            source: 'quick-action-extractor',
          }),
        ],
      },
    ]);

    // Reconcile Flow to a DIFFERENT node → Flow:Deprecated enters deleteNodeIds.
    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:Replacement')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    const pks = await edgePks(store);
    expect(ids.has('Flow:Deprecated')).toBe(false);
    expect(ids.has('Flow:Replacement')).toBe(true);
    expect(ids.has('CustomObject:Account')).toBe(true);
    expect(ids.has('QuickAction:Old')).toBe(true);
    // outbound edge from the deleted node — gone
    expect(pks.has('Flow:Deprecated|CustomObject:Account|references|flow-extractor')).toBe(false);
    // inbound edge from a NON-re-run emitter into the deleted node — also gone,
    // because the orphan clause (i) fires regardless of source re-run.
    expect(pks.has('QuickAction:Old|Flow:Deprecated|references|quick-action-extractor')).toBe(
      false,
    );
  });

  it('CASE D: an unrelated apex->object edge (no pruned-type endpoint) is NOT TOUCHED', async () => {
    const store = await makeStore();
    await importInto(store, [
      {
        nodes: [node('ApexClass:Handler'), node('CustomObject:Account')],
        edges: [
          edge('ApexClass:Handler', 'CustomObject:Account', {
            source: 'apex-scanner',
          }),
        ],
      },
    ]);

    // Reconcile re-emits only Flow:X; pruneNodeTypes={Flow}. The apex->object
    // edge touches no pruned type → it must survive untouched.
    await scopedReconcile(
      store,
      [{ nodes: [node('Flow:X')], edges: [] }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    const pks = await edgePks(store);
    expect(ids.has('ApexClass:Handler')).toBe(true);
    expect(ids.has('CustomObject:Account')).toBe(true);
    expect(pks.has('ApexClass:Handler|CustomObject:Account|references|apex-scanner')).toBe(true);
  });

  it('CASE E (vf-scanner shared source): VfComponent-origin edge SURVIVES — type-gate blocks it', async () => {
    const store = await makeStore();
    // vf-scanner emits edges for BOTH VisualforcePage and VisualforceComponent.
    // Seed a VfComponent-origin vf-scanner edge (the one that must survive) plus
    // a VfPage-origin vf-scanner edge (so re-running VfPage proves vf-scanner is
    // in reRanSources).
    await importInto(store, [
      {
        nodes: [
          node('VisualforcePage:P'),
          node('VisualforceComponent:C'),
          node('CustomObject:Account'),
        ],
        edges: [
          edge('VisualforceComponent:C', 'CustomObject:Account', {
            source: 'vf-scanner',
          }),
          edge('VisualforcePage:P', 'CustomObject:Account', {
            source: 'vf-scanner',
          }),
        ],
      },
    ]);

    // Scoped `--types VisualforcePage`: vf-scanner re-runs and re-emits the
    // VfPage with >= 1 vf-scanner edge → vf-scanner ∈ reRanSources. The
    // VfComponent-origin edge is absent from desired and its source DID re-run,
    // BUT it touches no pruned type (VisualforceComponent ∉ {VisualforcePage}),
    // so the type-gate conjunct preserves it.
    await scopedReconcile(
      store,
      [
        {
          nodes: [node('VisualforcePage:P')],
          edges: [
            edge('VisualforcePage:P', 'CustomObject:Account', {
              source: 'vf-scanner',
            }),
          ],
        },
      ],
      new Set<ComponentType>(['VisualforcePage']),
    );

    const ids = await nodeIds(store);
    const pks = await edgePks(store);
    expect(ids.has('VisualforcePage:P')).toBe(true);
    expect(ids.has('VisualforceComponent:C')).toBe(true);
    expect(ids.has('CustomObject:Account')).toBe(true);
    // The VfComponent-origin vf-scanner edge survives (type-gate: its endpoints
    // are VisualforceComponent + CustomObject, neither is the pruned type).
    expect(pks.has('VisualforceComponent:C|CustomObject:Account|references|vf-scanner')).toBe(
      true,
    );
    // The re-emitted VfPage edge is present.
    expect(pks.has('VisualforcePage:P|CustomObject:Account|references|vf-scanner')).toBe(true);
  });

  it('OVER-CAP composite: > IMPORT_BATCH_SIZE stale CASE-B edges dropped + one CASE-A inbound preserved', async () => {
    const store = await makeStore();
    // Survivors: one CustomObject the stale flow edges point at, plus the
    // CASE-A QuickAction + its Flow.
    const seedNodes: Node[] = [
      node('CustomObject:Order'),
      node('CustomObject:Product'),
      node('QuickAction:NewLead'),
      node('Flow:Welcome'),
    ];
    const seedEdges: Edge[] = [
      // CASE-A inbound edge from a non-reconciled emitter (must be preserved).
      edge('QuickAction:NewLead', 'Flow:Welcome', { source: 'quick-action-extractor' }),
    ];
    // > IMPORT_BATCH_SIZE stale outbound flow-extractor edges, both endpoints
    // surviving (Flow:StaleN survives as a re-emitted node; Order survives).
    const staleFlowCount = IMPORT_BATCH_SIZE * 2 + 13;
    // The flow extractor RE-RUNS — it re-emits every Flow node plus at least one
    // flow-extractor edge (so flow-extractor ∈ reRanSources), but STOPS emitting
    // every stale writesTo→Order edge → all of those are genuinely stale CASE-B.
    const reEmittedFlows: Node[] = [node('Flow:Welcome')];
    const reEmittedFlowEdges: Edge[] = [
      // One surviving flow-extractor edge proves the extractor really re-ran.
      edge('Flow:Welcome', 'CustomObject:Product', {
        edgeType: 'writesTo',
        source: 'flow-extractor',
      }),
    ];
    for (let i = 0; i < staleFlowCount; i += 1) {
      seedNodes.push(node(`Flow:Stale${i}`));
      seedEdges.push(
        edge(`Flow:Stale${i}`, 'CustomObject:Order', {
          edgeType: 'writesTo',
          source: 'flow-extractor',
        }),
      );
      reEmittedFlows.push(node(`Flow:Stale${i}`));
    }
    await importInto(store, [{ nodes: seedNodes, edges: seedEdges }]);

    // Scoped Flow reconcile: re-emit all Flow nodes + the one survivor edge, so
    // every stale flow-extractor writesTo→Order edge is dropped (CASE B), while
    // the inbound quick-action-extractor edge (CASE A) is untouched and survives.
    await scopedReconcile(
      store,
      [{ nodes: reEmittedFlows, edges: reEmittedFlowEdges }],
      new Set<ComponentType>(['Flow']),
    );

    const ids = await nodeIds(store);
    const pks = await edgePks(store);
    expect(ids.has('CustomObject:Order')).toBe(true);
    expect(ids.has('CustomObject:Product')).toBe(true);
    expect(ids.has('QuickAction:NewLead')).toBe(true);
    expect(ids.has('Flow:Welcome')).toBe(true);
    // The survivor flow-extractor edge proves the extractor re-ran.
    expect(pks.has('Flow:Welcome|CustomObject:Product|writesTo|flow-extractor')).toBe(true);
    // The preserved CASE-A inbound edge survives across chunked prune batches.
    expect(pks.has('QuickAction:NewLead|Flow:Welcome|references|quick-action-extractor')).toBe(
      true,
    );
    // Every stale CASE-B outbound flow edge is dropped.
    for (let i = 0; i < staleFlowCount; i += 1) {
      expect(ids.has(`Flow:Stale${i}`)).toBe(true);
      expect(pks.has(`Flow:Stale${i}|CustomObject:Order|writesTo|flow-extractor`)).toBe(false);
    }
  });
});
