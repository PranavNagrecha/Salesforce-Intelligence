/// <reference types="vitest/globals" />

/**
 * Honesty tests for the shared PermissionSetGroup expansion module.
 *
 * Two defects are pinned here:
 *   - R1/HIGH — `expandAllPermissionSetGroups` served ONE `listNodesByType`
 *     page capped at 500 with no SQL `OFFSET` and no truncation channel, so
 *     PSG #501+ (by id ASC) did not exist for the consolidation analysis. A
 *     missed group is a missed grant in a least-privilege review.
 *   - R6/LOW — the muting-loader's "was this family extracted?" test was a
 *     local re-implementation (`'k' in props`) of the shared
 *     `familyWasExtracted` (`hasOwnProperty`). The two disagree whenever the
 *     sentinel resolves on the PROTOTYPE chain, and the `in` form then
 *     classifies a NEVER-EXTRACTED node as subtractable.
 *
 * The PSG roster test uses a REAL DuckDB graph seeded with 520 synthetic
 * groups (placeholder `PSG_0001`-style names only — no org identifiers), which
 * is the only way to exercise the 500-row page boundary honestly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, ExtractionResult, Node } from '@sf-intelligence/contracts';
import { ok } from '@sf-intelligence/core';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  expandAllPermissionSetGroups,
  loadMutingPermissions,
  scanAllPermissionSetGroups,
} from '../../src/tools/permission-set-group.js';

/** Override hook for `getNodeById` — the only way to hand the loader a node
 *  whose `properties` inherits the sentinel from its PROTOTYPE. */
const hoisted = vi.hoisted(() => ({
  getNodeByIdOverride: null as null | ((id: string) => unknown),
}));

vi.mock('@sf-intelligence/graph', async () => {
  const actual =
    await vi.importActual<typeof import('@sf-intelligence/graph')>('@sf-intelligence/graph');
  return {
    ...actual,
    getNodeById: async (store: unknown, id: string) => {
      const override = hoisted.getNodeByIdOverride;
      if (override !== null) return override(id);
      return actual.getNodeById(store as GraphStore, id as ComponentId);
    },
  };
});

/** Total synthetic PSGs seeded — deliberately PAST the 500-row page ceiling. */
const PSG_COUNT = 520;

const psgNode = (n: number): Node => {
  const name = `PSG_${String(n).padStart(4, '0')}`;
  return {
    id: `PermissionSetGroup:${name}` as ComponentId,
    type: 'PermissionSetGroup',
    apiName: name,
    label: null,
    parentId: null,
    sourcePath: `permissionsetgroups/${name}.permissionsetgroup-meta.xml`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: { permissionSets: [`PS_${String(n).padStart(4, '0')}`] },
  };
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-psg-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const nodes: Node[] = [];
  for (let n = 1; n <= PSG_COUNT; n += 1) nodes.push(psgNode(n));
  const seed: ExtractionResult = { nodes, edges: [] };
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { graph: store } as unknown as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  hoisted.getNodeByIdOverride = null;
  delete process.env['SFI_NODE_SCAN_LIMIT'];
});

describe('expandAllPermissionSetGroups — R1 full roster', () => {
  it('FAIL-BEFORE/PASS-AFTER: enumerates PSG #501+ instead of stopping at page one', async () => {
    const r = await expandAllPermissionSetGroups(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(PSG_COUNT);
    // The tail group (id ASC) is the one a single 500-row page silently drops.
    const tail = `PermissionSetGroup:PSG_${String(PSG_COUNT).padStart(4, '0')}`;
    expect(r.value.map((p) => p.psgId)).toContain(tail);
    // …and its declared membership must survive the walk, not just its id.
    const tailPsg = r.value.find((p) => p.psgId === tail);
    expect(tailPsg?.memberPermissionSetIds).toEqual([
      `PermissionSet:PS_${String(PSG_COUNT).padStart(4, '0')}`,
    ]);
  });

  it('reports a COMPLETE roster (no residual cap) when the type is exhausted', async () => {
    const r = await scanAllPermissionSetGroups(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.groups).toHaveLength(PSG_COUNT);
    expect(r.value.scanIncomplete).toBe(false);
    expect(r.value.incompleteTypes).toEqual([]);
  });

  it('DISCLOSES the residual cap rather than silently truncating', async () => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '100';
    const r = await scanAllPermissionSetGroups(ctx, 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.groups.length).toBeLessThan(PSG_COUNT);
    expect(r.value.scanIncomplete).toBe(true);
    expect(r.value.incompleteTypes).toEqual(['PermissionSetGroup']);
  });
});

describe('loadMutingPermissions — R6 typed absence', () => {
  it('FAIL-BEFORE/PASS-AFTER: a sentinel resolved on the PROTOTYPE is NOT extraction', async () => {
    // A node whose `properties` object does NOT own `mutedObjectPermissions`
    // but inherits it. `'k' in props` says "extracted" (and would subtract a
    // grant that was never parsed from this org); `familyWasExtracted` says
    // "never extracted" and the id lands in presentWithoutData.
    const inherited = Object.create({
      mutedObjectPermissions: [{ object: 'Account', read: true }],
    }) as Record<string, unknown>;
    hoisted.getNodeByIdOverride = (id: string) =>
      ok({
        id,
        type: 'MutingPermissionSet',
        apiName: 'MPS_Placeholder',
        label: null,
        parentId: null,
        sourcePath: 'x.xml',
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: inherited,
      });
    const r = await loadMutingPermissions(ctx, [
      'MutingPermissionSet:MPS_Placeholder' as ComponentId,
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.grants).toEqual([]);
    expect(r.value.presentWithoutData).toEqual(['MutingPermissionSet:MPS_Placeholder']);
    expect(r.value.missingMutingIds).toEqual([]);
  });

  it('an OWN empty sentinel is EXTRACTED-AND-CLEAN, not absence', async () => {
    hoisted.getNodeByIdOverride = (id: string) =>
      ok({
        id,
        type: 'MutingPermissionSet',
        apiName: 'MPS_Clean',
        label: null,
        parentId: null,
        sourcePath: 'x.xml',
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: { mutedObjectPermissions: [] },
      });
    const r = await loadMutingPermissions(ctx, ['MutingPermissionSet:MPS_Clean' as ComponentId]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.presentWithoutData).toEqual([]);
    expect(r.value.grants).toHaveLength(1);
    expect(r.value.grants[0]?.objects.size).toBe(0);
  });

  it('a muting id absent from the vault is missing, never "mutes nothing"', async () => {
    hoisted.getNodeByIdOverride = () => ok(null);
    const r = await loadMutingPermissions(ctx, ['MutingPermissionSet:MPS_Gone' as ComponentId]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.grants).toEqual([]);
    expect(r.value.presentWithoutData).toEqual([]);
    expect(r.value.missingMutingIds).toEqual(['MutingPermissionSet:MPS_Gone']);
  });
});
