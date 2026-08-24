/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import {
  chooseSourcePath,
  resolveDuplicateSourcePaths,
  SOURCE_CONFLICT_PROPERTY,
} from '../src/duplicate-source.js';
import { importExtractionResults } from '../src/import.js';
import { getNodeById, listEdges } from '../src/queries.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

let tempDir: string;
const stores: GraphStore[] = [];

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-dup-source-'));
});

afterAll(() => {
  for (const store of stores) {
    store.connection.disconnectSync();
    store.instance.closeSync();
  }
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const makeStore = async (label: string): Promise<GraphStore> => {
  const instance = await DuckDBInstance.create(join(tempDir, `${label}.db`));
  const connection = await instance.connect();
  const init = await initSchema(connection);
  if (!init.ok) throw new Error(`initSchema failed: ${init.error.message}`);
  const store: GraphStore = { connection, instance };
  stores.push(store);
  return store;
};

/**
 * The shape of the real defect, in invented metadata: one profile retrieved
 * twice into two layouts, where the OLDER copy declares a step-up-auth bypass
 * and a grant that the NEWER copy no longer declares.
 *
 * `DX_PATH` is the Salesforce DX layout the current retrieve writes;
 * `FLAT_PATH` is the legacy flat layout an older refresh left behind. Note that
 * `main` sorts BEFORE `profiles`, so an alphabetical source walk visits the DX
 * copy FIRST and the flat copy LAST — which is exactly why last-writer-wins let
 * the stale copy win before this fix.
 */
const PROFILE_ID = 'Profile:Depot_Supervisor';
const DX_PATH = 'source/main/default/profiles/Depot_Supervisor.profile-meta.xml';
const FLAT_PATH = 'source/profiles/Depot_Supervisor.profile-meta.xml';
const BYPASS_PERMISSION = 'SkipStepUpAuthOnUi';

const profileNode = (
  sourcePath: string,
  userPermissions: readonly string[],
): Node => ({
  id: PROFILE_ID,
  type: 'Profile',
  apiName: 'Depot_Supervisor',
  label: 'Depot_Supervisor',
  parentId: null,
  sourcePath,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { userPermissions, objectGrantCount: userPermissions.length },
});

const grantEdge = (toId: string): Edge => ({
  fromId: PROFILE_ID,
  toId,
  edgeType: 'grantedBy',
  confidence: 'declared',
  source: 'extractor:profile',
  properties: {},
});

const targetNode = (id: string, apiName: string): Node => ({
  id,
  type: 'CustomObject',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: `source/main/default/objects/${apiName}/${apiName}.object-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

/** The stale (flat) copy still grants the bypass and an extra object. */
const staleCopy = (): ExtractionResult => ({
  nodes: [profileNode(FLAT_PATH, [BYPASS_PERMISSION, 'ViewDepotRoutes'])],
  edges: [grantEdge('CustomObject:Depot__c'), grantEdge('CustomObject:Manifest__c')],
});

/** The current (DX) copy no longer declares either. */
const currentCopy = (): ExtractionResult => ({
  nodes: [profileNode(DX_PATH, ['ViewDepotRoutes'])],
  edges: [grantEdge('CustomObject:Depot__c')],
});

describe('chooseSourcePath', () => {
  it('prefers the Salesforce DX copy over a legacy flat copy', () => {
    expect(chooseSourcePath([FLAT_PATH, DX_PATH])).toEqual({
      chosen: DX_PATH,
      precedence: 'dx-canonical',
    });
  });

  it('reports `undetermined` when the DX convention cannot order the copies', () => {
    const a = 'source/profiles/Depot_Supervisor.profile-meta.xml';
    const b = 'source/legacy/profiles/Depot_Supervisor.profile-meta.xml';
    const picked = chooseSourcePath([a, b]);
    expect(picked.precedence).toBe('undetermined');
    // Lexicographic, and only for reproducibility — never presented as "newer".
    expect(picked.chosen).toBe(b);
  });

  it('reports `undetermined` when BOTH copies are DX-canonical (two package dirs)', () => {
    const picked = chooseSourcePath([
      'force-app/main/default/profiles/Depot_Supervisor.profile-meta.xml',
      'utils/main/default/profiles/Depot_Supervisor.profile-meta.xml',
    ]);
    expect(picked.precedence).toBe('undetermined');
  });
});

describe('resolveDuplicateSourcePaths', () => {
  it('leaves a vault with no duplicate source paths untouched', () => {
    const results = [currentCopy()];
    const resolved = resolveDuplicateSourcePaths(results);
    expect(resolved.summary).toBeNull();
    expect(resolved.results).toBe(results);
  });

  it('does NOT treat the same id at the SAME path as a duplicate (enrichment overlay)', () => {
    // The describe-snapshot overlay re-emits an enriched node carrying the
    // ORIGINAL sourcePath. Last-writer-wins is correct there.
    const enriched: ExtractionResult = {
      nodes: [profileNode(DX_PATH, ['ViewDepotRoutes', 'ViewDepotRosters'])],
      edges: [],
    };
    const resolved = resolveDuplicateSourcePaths([currentCopy(), enriched]);
    expect(resolved.summary).toBeNull();
  });

  it('detects the duplicate, names both paths, and keeps only the DX copy', () => {
    const resolved = resolveDuplicateSourcePaths([currentCopy(), staleCopy()]);
    expect(resolved.summary).not.toBeNull();
    expect(resolved.summary?.components).toBe(1);
    expect(resolved.summary?.conflicting).toBe(1);
    expect(resolved.summary?.byType).toEqual({ Profile: 1 });
    expect(resolved.summary?.paths).toEqual(['source/', 'source/main/default/']);

    const nodes = resolved.results.flatMap((r) => r.nodes);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.sourcePath).toBe(DX_PATH);
    expect(nodes[0]?.properties['userPermissions']).toEqual(['ViewDepotRoutes']);
  });

  it('flags the surviving component so a tool answering about it can disclose', () => {
    const resolved = resolveDuplicateSourcePaths([currentCopy(), staleCopy()]);
    const node = resolved.results.flatMap((r) => r.nodes)[0]!;
    const conflict = node.properties[SOURCE_CONFLICT_PROPERTY] as Record<string, unknown>;
    expect(conflict).toBeDefined();
    expect(conflict['conflicting']).toBe(true);
    expect(conflict['paths']).toEqual([DX_PATH, FLAT_PATH]);
    expect(conflict['chosenPath']).toBe(DX_PATH);
    expect(conflict['precedence']).toBe('dx-canonical');
    expect(String(conflict['disclosure'])).toContain('NOT merged');
  });

  it('drops the stale copy EDGES rather than unioning them', () => {
    const resolved = resolveDuplicateSourcePaths([currentCopy(), staleCopy()]);
    const edges = resolved.results.flatMap((r) => r.edges);
    expect(edges.map((e) => e.toId).sort()).toEqual(['CustomObject:Depot__c']);
  });

  it('records identical duplicates in the roll-up but does not flag the node', () => {
    const resolved = resolveDuplicateSourcePaths([
      currentCopy(),
      { nodes: [profileNode(FLAT_PATH, ['ViewDepotRoutes'])], edges: [grantEdge('CustomObject:Depot__c')] },
    ]);
    expect(resolved.summary?.components).toBe(1);
    expect(resolved.summary?.conflicting).toBe(0);
    const node = resolved.results.flatMap((r) => r.nodes)[0]!;
    expect(node.properties[SOURCE_CONFLICT_PROPERTY]).toBeUndefined();
  });

  it('is idempotent — re-resolving an already-resolved set finds nothing', () => {
    const once = resolveDuplicateSourcePaths([currentCopy(), staleCopy()]);
    const twice = resolveDuplicateSourcePaths(once.results);
    expect(twice.summary).toBeNull();
    expect(twice.results).toBe(once.results);
  });
});

describe('importExtractionResults with a duplicated source tree', () => {
  /**
   * The whole bug in one assertion: the stale copy declares a step-up-auth
   * bypass, the current copy does not, and the graph must NOT report it as
   * granted. Before the fix, the alphabetical walk order (`main/` before
   * `profiles/`) made the stale copy the LAST writer and `INSERT OR REPLACE`
   * handed it the node.
   */
  it('does not report a permission the CURRENT retrieval no longer declares', async () => {
    const store = await makeStore('revoked-permission');
    // Walk order: DX first (`main` < `profiles`), stale flat copy last.
    const imported = await importExtractionResults(store, [
      targetNodeResult(),
      currentCopy(),
      staleCopy(),
    ]);
    expect(imported.ok).toBe(true);

    const node = await getNodeById(store, PROFILE_ID);
    expect(node.ok).toBe(true);
    if (!node.ok || node.value === null) throw new Error('profile node missing');
    expect(node.value.properties['userPermissions']).toEqual(['ViewDepotRoutes']);
    expect(node.value.sourcePath).toBe(DX_PATH);
    expect(node.value.properties[SOURCE_CONFLICT_PROPERTY]).toBeDefined();
  });

  it('does not union the two copies’ grant edges', async () => {
    const store = await makeStore('no-edge-union');
    const imported = await importExtractionResults(store, [
      targetNodeResult(),
      currentCopy(),
      staleCopy(),
    ]);
    expect(imported.ok).toBe(true);

    const edges = await listEdges(store, PROFILE_ID, { direction: 'out' });
    expect(edges.ok).toBe(true);
    if (!edges.ok) throw new Error('listEdges failed');
    expect(edges.value.map((e) => e.toId).sort()).toEqual(['CustomObject:Depot__c']);
  });

  it('reports the duplicate roll-up on ImportCounts for the manifest', async () => {
    const store = await makeStore('rollup');
    const imported = await importExtractionResults(store, [currentCopy(), staleCopy()]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error('import failed');
    expect(imported.value.duplicateSourcePaths?.components).toBe(1);
    expect(imported.value.duplicateSourcePaths?.conflicting).toBe(1);
    expect(imported.value.duplicateSourcePaths?.paths).toEqual([
      'source/',
      'source/main/default/',
    ]);
    expect(String(imported.value.duplicateSourcePaths?.disclosure)).toContain(
      'NOT merged',
    );
  });

  it('omits the roll-up entirely on a clean vault', async () => {
    const store = await makeStore('clean');
    const imported = await importExtractionResults(store, [currentCopy()]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error('import failed');
    expect(imported.value.duplicateSourcePaths).toBeUndefined();
  });
});

/** Grant targets, so the edges under test are not flagged `targetMissing`. */
function targetNodeResult(): ExtractionResult {
  return {
    nodes: [targetNode('CustomObject:Depot__c', 'Depot__c'), targetNode('CustomObject:Manifest__c', 'Manifest__c')],
    edges: [],
  };
}
