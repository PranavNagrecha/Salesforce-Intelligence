/// <reference types="vitest/globals" />

/**
 * RESOLVE-INDEX-DISCARDED-GENERATION — the persisted resolve index must be
 * bound to the graph it was built from, not merely to that graph's node COUNT.
 *
 * The scenario is not hypothetical, and it is not a corrupted-file scenario:
 * `sfi refresh` rebuilds into a SIDE file (`graph.duckdb.rebuild`) and renames
 * it over the live database. `persistResolveIndexBestEffort` writes the resolve
 * index by DIRNAME, so the side build's index lands on
 * `{graphDir}/resolve-index.json` — the same path the live database's index
 * uses. When the swap then fails (Windows will not replace a database another
 * process holds open) or the run is abandoned, the scratch database is deleted
 * and the LIVE database is left sitting beside the index of the build that LOST.
 *
 * The old guard compared node COUNT alone. Two generations of the same org
 * routinely have the same node count — one class renamed, one field added and
 * one deleted — so the discarded index was ACCEPTED, and `sfi.resolve` then
 * returned `disposition: 'exact'` at high confidence for a component the live
 * vault does not contain. That is the exact failure mode this product exists to
 * make impossible: absence became indistinguishable from ignorance, on the
 * first tool of the core spine, which every other answer routes through.
 *
 * A count is a checksum with one byte of entropy. These tests pin the identity
 * check that replaced it, and they assert the thing the USER sees — "a name
 * resolved that does not exist" — not the implementation detail of whether an
 * index object was reused.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import {
  buildResolveIndex,
  persistResolveIndexArtifact,
  resolveIndexPathForGraph,
  tryLoadResolveIndexArtifact,
  writeResolveIndexArtifact,
} from '../src/resolve-index.js';
import { resolveComponents } from '../src/resolve.js';
import { initSchema } from '../src/schema.js';
import { closeGraph, type GraphStore } from '../src/store.js';

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

const makeEdge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>): Edge => ({
  edgeType: 'references',
  confidence: 'declared',
  source: 'test',
  properties: {},
  ...o,
});

/**
 * The four components BOTH generations share. Kept as one array so the two
 * generations differ by exactly the node each one appends — the equal node
 * count below is DERIVED from that construction, never a coincidence the test
 * happens to inherit from a hand-typed literal.
 */
const COMMON_NODES: readonly Node[] = [
  makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
  makeNode({ id: 'CustomObject:Contact', apiName: 'Contact', label: 'Contact' }),
  makeNode({ id: 'CustomObject:Opportunity', apiName: 'Opportunity', label: 'Opportunity' }),
  makeNode({ id: 'CustomObject:Case', apiName: 'Case', label: 'Case' }),
];

/** The DISCARDED side build: contains a class the live vault will not have. */
const GENERATION_A: ExtractionResult = {
  nodes: [
    ...COMMON_NODES,
    makeNode({
      id: 'ApexClass:GhostOnlyInA',
      type: 'ApexClass',
      apiName: 'GhostOnlyInA',
      label: 'Ghost Only In A',
    }),
  ],
  edges: [],
};

/** The LIVE vault: same node COUNT, and no `GhostOnlyInA` anywhere in it. */
const GENERATION_B: ExtractionResult = {
  nodes: [
    ...COMMON_NODES,
    makeNode({
      id: 'ApexClass:LivePresentInB',
      type: 'ApexClass',
      apiName: 'LivePresentInB',
      label: 'Live Present In B',
    }),
  ],
  edges: [],
};

interface TempGraph {
  readonly store: GraphStore;
  readonly dbPath: string;
}

const openTempGraph = async (
  dbPath: string,
  seed: ExtractionResult,
): Promise<TempGraph> => {
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const init = await initSchema(connection);
  if (!init.ok) throw new Error(init.error.message);
  const store: GraphStore = { connection, instance };
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  return { store, dbPath };
};

let tempDir: string;
/** The live vault database — the one that survives a failed swap. */
let liveDbPath: string;
/** The side build `sfi refresh` renames over the live database. */
let rebuildDbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-index-generation-'));
  liveDbPath = join(tempDir, 'graph.duckdb');
  rebuildDbPath = `${liveDbPath}.rebuild`;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * Reproduce the abandoned refresh exactly: build generation A into the SIDE
 * file, let it write its resolve index (dirname-based, so it lands beside the
 * live database), then fail the swap — the scratch database is removed and the
 * live database is never touched. Returns the live (generation B) store.
 */
const stageDiscardedSideBuild = async (): Promise<GraphStore> => {
  const side = await openTempGraph(rebuildDbPath, GENERATION_A);
  try {
    const indexA = await buildResolveIndex(side.store);
    // `persistResolveIndexBestEffort` resolves the artifact path from the
    // DIRNAME of the database it was handed, so the side build's index
    // overwrites the live database's index. This line is that collision.
    await writeResolveIndexArtifact(side.dbPath, indexA);
    expect(resolveIndexPathForGraph(side.dbPath)).toBe(
      resolveIndexPathForGraph(liveDbPath),
    );
  } finally {
    await closeGraph(side.store);
  }
  // `installSideBuildGraph` deletes the scratch when the rename fails. All
  // that survives of generation A is its resolve index.
  rmSync(rebuildDbPath, { force: true });
  rmSync(`${rebuildDbPath}.wal`, { force: true });

  const live = await openTempGraph(liveDbPath, GENERATION_B);
  return live.store;
};

describe('resolve index — a DISCARDED generation must never be adopted', () => {
  it('the premise: the discarded index and the live vault have the SAME node count', async () => {
    // If this ever stops holding, the tests below stop testing anything — the
    // whole defect is that an equal count was treated as proof of identity.
    expect(GENERATION_A.nodes.length).toBe(GENERATION_B.nodes.length);
    expect(GENERATION_A.nodes.some((n) => n.apiName === 'GhostOnlyInA')).toBe(true);
    expect(GENERATION_B.nodes.some((n) => n.apiName === 'GhostOnlyInA')).toBe(false);

    const store = await stageDiscardedSideBuild();
    try {
      const onDisk = JSON.parse(
        readFileSync(resolveIndexPathForGraph(liveDbPath), 'utf8'),
      ) as { readonly nodeCount: number };
      expect(onDisk.nodeCount).toBe(GENERATION_B.nodes.length);
    } finally {
      await closeGraph(store);
    }
  });

  it('does NOT resolve a name the live vault does not contain', async () => {
    const store = await stageDiscardedSideBuild();
    try {
      const r = await resolveComponents(store, 'GhostOnlyInA', {
        graphDbPath: liveDbPath,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // THE assertion. Before the fix this came back
      // `disposition: 'exact'`, score 0.9, candidate `ApexClass:GhostOnlyInA`
      // — a confident answer about a class the open database has never held.
      expect(r.value.candidates.map((c) => c.id)).not.toContain(
        'ApexClass:GhostOnlyInA',
      );
      expect(r.value.disposition).toBe('none');
    } finally {
      await closeGraph(store);
    }
  });

  it('still resolves what the live vault DOES contain (the index is rejected, not the query)', async () => {
    const store = await stageDiscardedSideBuild();
    try {
      const r = await resolveComponents(store, 'LivePresentInB', {
        graphDbPath: liveDbPath,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.candidates.map((c) => c.id)).toContain('ApexClass:LivePresentInB');
    } finally {
      await closeGraph(store);
    }
  });

  it('tryLoad rejects the discarded artifact outright', async () => {
    const store = await stageDiscardedSideBuild();
    try {
      expect(await tryLoadResolveIndexArtifact(liveDbPath, store)).toBeNull();
    } finally {
      await closeGraph(store);
    }
  });
});

describe('resolve index — the identity guard is not a blanket refusal', () => {
  it('accepts the artifact written from the SAME graph, on a cold store handle', async () => {
    // The guard is worthless if it also rejects the legitimate cache: that
    // would silently turn every cold resolve back into a full index rebuild.
    const live = await openTempGraph(liveDbPath, GENERATION_B);
    try {
      await persistResolveIndexArtifact(liveDbPath, live.store);
    } finally {
      await closeGraph(live.store);
    }

    const cold = await DuckDBInstance.create(liveDbPath);
    const connection = await cold.connect();
    const coldStore: GraphStore = { connection, instance: cold };
    try {
      const loaded = await tryLoadResolveIndexArtifact(liveDbPath, coldStore);
      expect(loaded).not.toBeNull();
      expect(loaded?.nodes.some((n) => n.id === 'ApexClass:LivePresentInB')).toBe(true);
    } finally {
      await closeGraph(coldStore);
    }
  });
});

describe('resolve index — identity covers everything the index caches', () => {
  /**
   * Each case mutates the live graph in a way that leaves the node COUNT
   * untouched, so the old pre-filter alone would wave it through. The index
   * caches labels, parentage and inbound-edge counts, so a stale copy of any
   * of them is a wrong answer waiting to be served.
   */
  const stagePersistedIndexThenMutate = async (
    mutate: (store: GraphStore) => Promise<void>,
  ): Promise<GraphStore> => {
    const live = await openTempGraph(liveDbPath, GENERATION_B);
    await persistResolveIndexArtifact(liveDbPath, live.store);
    await mutate(live.store);
    return live.store;
  };

  it('rejects when a node was REPLACED one-for-one (same count, different ids)', async () => {
    const store = await stagePersistedIndexThenMutate(async (s) => {
      await s.connection.run(`DELETE FROM nodes WHERE id = 'ApexClass:LivePresentInB'`);
      const imported = await importExtractionResults(s, [
        {
          nodes: [
            makeNode({
              id: 'ApexClass:RenamedAfterPersist',
              type: 'ApexClass',
              apiName: 'RenamedAfterPersist',
            }),
          ],
          edges: [],
        },
      ]);
      if (!imported.ok) throw new Error(imported.error.message);
    });
    try {
      const [row] = (
        await store.connection.runAndReadAll(`SELECT count(*)::INT AS c FROM nodes`, [])
      ).getRowObjectsJS() as ReadonlyArray<Record<string, unknown>>;
      // The pre-filter is blind here by construction — that is the point.
      expect(Number(row?.['c'])).toBe(GENERATION_B.nodes.length);
      expect(await tryLoadResolveIndexArtifact(liveDbPath, store)).toBeNull();
    } finally {
      await closeGraph(store);
    }
  });

  it('rejects when only a LABEL changed (the index scores against cached labels)', async () => {
    const store = await stagePersistedIndexThenMutate(async (s) => {
      await s.connection.run(
        `UPDATE nodes SET label = 'Completely Different Label' WHERE id = 'CustomObject:Account'`,
      );
    });
    try {
      expect(await tryLoadResolveIndexArtifact(liveDbPath, store)).toBeNull();
    } finally {
      await closeGraph(store);
    }
  });

  it('rejects when only PARENTAGE changed (parentId narrows every resolve)', async () => {
    const store = await stagePersistedIndexThenMutate(async (s) => {
      await s.connection.run(
        `UPDATE nodes SET parent_id = 'CustomObject:Account' WHERE id = 'ApexClass:LivePresentInB'`,
      );
    });
    try {
      expect(await tryLoadResolveIndexArtifact(liveDbPath, store)).toBeNull();
    } finally {
      await closeGraph(store);
    }
  });

  it('rejects when only EDGES changed (inbound count is the popularity prior)', async () => {
    const store = await stagePersistedIndexThenMutate(async (s) => {
      const imported = await importExtractionResults(s, [
        {
          nodes: [],
          edges: [
            makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomObject:Account' }),
          ],
        },
      ]);
      if (!imported.ok) throw new Error(imported.error.message);
    });
    try {
      expect(await tryLoadResolveIndexArtifact(liveDbPath, store)).toBeNull();
    } finally {
      await closeGraph(store);
    }
  });
});

describe('resolve index — fails CLOSED on an artifact with no identity', () => {
  const rewriteArtifact = (
    edit: (payload: Record<string, unknown>) => void,
  ): void => {
    const path = resolveIndexPathForGraph(liveDbPath);
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    edit(payload);
    writeFileSync(path, `${JSON.stringify(payload)}\n`, 'utf8');
  };

  const withPersistedLiveIndex = async (
    edit: (payload: Record<string, unknown>) => void,
  ): Promise<GraphStore> => {
    const live = await openTempGraph(liveDbPath, GENERATION_B);
    await persistResolveIndexArtifact(liveDbPath, live.store);
    rewriteArtifact(edit);
    return live.store;
  };

  it('rejects an index written before the identity field existed', async () => {
    // An older `sfi` wrote a payload with no identity at all. It might well
    // describe this exact graph — but "might" is the whole problem, so the
    // only safe reading is REJECT and rebuild.
    const store = await withPersistedLiveIndex((p) => {
      delete p['fingerprint'];
    });
    try {
      expect(await tryLoadResolveIndexArtifact(liveDbPath, store)).toBeNull();
      // And the rejection must not cost correctness: the live vault still
      // answers, from a freshly built in-memory index.
      const r = await resolveComponents(store, 'LivePresentInB', {
        graphDbPath: liveDbPath,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.candidates.map((c) => c.id)).toContain('ApexClass:LivePresentInB');
      }
    } finally {
      await closeGraph(store);
    }
  });

  it('rejects a null / non-string / empty identity rather than coercing it', async () => {
    for (const bogus of [null, 0, '', {}, []]) {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      tempDir = mkdtempSync(join(tmpdir(), 'sfi-index-generation-'));
      liveDbPath = join(tempDir, 'graph.duckdb');
      const store = await withPersistedLiveIndex((p) => {
        p['fingerprint'] = bogus;
      });
      try {
        expect(await tryLoadResolveIndexArtifact(liveDbPath, store)).toBeNull();
      } finally {
        await closeGraph(store);
      }
    }
  });
});
