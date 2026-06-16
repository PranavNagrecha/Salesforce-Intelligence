/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { whoCanRunHandler } from '../../src/tools/who-can-run.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

const FLOW = 'Flow:Onboard_Contact';
const seed: ExtractionResult = {
  nodes: [
    node({ id: FLOW, type: 'Flow', apiName: 'Onboard_Contact' }),
    node({ id: 'Profile:Sales', type: 'Profile', apiName: 'Sales' }),
    node({ id: 'PermissionSet:FlowRunner', type: 'PermissionSet', apiName: 'FlowRunner' }),
    node({ id: 'Profile:NoRun', type: 'Profile', apiName: 'NoRun' }),
  ],
  edges: [
    edge({ fromId: 'Profile:Sales', toId: FLOW, edgeType: 'grantedBy', properties: { flowAccess: true } }),
    edge({ fromId: 'PermissionSet:FlowRunner', toId: FLOW, edgeType: 'grantedBy', properties: { flowAccess: true } }),
    // A non-flowAccess grant edge to a class must NOT be counted.
    edge({ fromId: 'Profile:NoRun', toId: 'ApexClass:Foo', edgeType: 'grantedBy', properties: { enabled: true } }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-who-can-run-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('whoCanRunHandler', () => {
  it('rejects a non-Flow id with a helpful message', async () => {
    const r = await whoCanRunHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('app_access');
  });

  it('lists the profiles/permsets that grant run access to the flow', async () => {
    const r = await whoCanRunHandler(ctx, { componentId: FLOW });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.summary.granters).toBe(2);
    expect(r.value.data.granters.map((g) => g.granterId).sort()).toEqual([
      'PermissionSet:FlowRunner', 'Profile:Sales',
    ]);
  });

  it('component-not-found for a flow with no node and no run grant', async () => {
    const r = await whoCanRunHandler(ctx, { componentId: 'Flow:Nope' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('component-not-found');
  });

  it('always discloses the app/folder boundary', async () => {
    const r = await whoCanRunHandler(ctx, { componentId: FLOW });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.boundaryNote).toContain('app_access');
    expect(r.value.data.boundaryNote).toContain('live plane');
  });
});
