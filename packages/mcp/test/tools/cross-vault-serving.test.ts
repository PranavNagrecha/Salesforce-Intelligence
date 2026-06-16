/// <reference types="vitest/globals" />

/**
 * P7-cross-org-diff regression guard: the compare_* family opens the OTHER
 * vault READ-ONLY (`openVaultReadOnly`), so a comparison succeeds even while
 * that vault is being SERVED read-only by another `sfi mcp` process. With the
 * old read-WRITE open it failed with the `locked` error. The vault is held by a
 * real child process (the graph package's `vault-holder.mjs` fixture) — the
 * single-writer lock only fires across processes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import { registerVault, saveManifest, vaultPaths } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { compareVaultsHandler } from '../../src/tools/compare-vaults.js';

// Reuse the proven holder fixture from the graph package (resolves
// @duckdb/node-api from graph's node_modules; mcp does not depend on it directly).
const HOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'graph',
  'test',
  'fixtures',
  'vault-holder.mjs',
);

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1 },
  edges: {},
  sourceTreeHash: 'sha256:serving',
};

const node = (id: string, apiName: string): Node => ({
  id,
  type: 'CustomObject',
  apiName,
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const seed = async (root: string, names: string[]): Promise<void> => {
  await mkdir(join(root, 'graph'), { recursive: true });
  await saveManifest(root, MANIFEST);
  const opened = await openGraph(vaultPaths(root).graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  const result: ExtractionResult = {
    nodes: names.map((n) => node(`CustomObject:${n}`, n)),
    edges: [],
  };
  const imp = await importExtractionResults(opened.value, [result]);
  if (!imp.ok) throw new Error(imp.error.message);
  await closeGraph(opened.value); // not held open by this process
};

const spawnHolderRO = (graphDb: string): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER], {
      env: { ...process.env, DBP: graphDb, MODE: 'RO' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('holder did not signal READY within 20s'));
    }, 20_000);
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('READY')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`holder exited early (code ${code}): ${stderr}`));
    });
  });

const stopHolder = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });

let rootDir: string;
let ctx: Context;

describe('compare_vaults against a vault being served read-only (P7-cross-org-diff)', () => {
  let ctxStore: GraphStore;
  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'sfi-xv-serving-'));
    await seed(join(rootDir, 'vaultA'), ['Account', 'Foo__c']);
    await seed(join(rootDir, 'vaultB'), ['Account']);
    await registerVault(rootDir, 'vaultA', join(rootDir, 'vaultA'));
    await registerVault(rootDir, 'vaultB', join(rootDir, 'vaultB'));
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
    // ctx.vaultRoot is the registry root (neither compared vault) so the handler
    // opens BOTH vaults fresh read-only. ctx.graph is a throwaway (never queried).
    const opened = await openGraph(join(rootDir, 'ctx.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    ctxStore = opened.value;
    ctx = { vaultRoot: rootDir, manifest: MANIFEST, graph: ctxStore };
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(ctxStore);
    await rm(rootDir, { recursive: true, force: true });
  });

  it('succeeds while a separate process serves vaultB read-only (would fail `locked` with a read-write open)', async () => {
    const holder = await spawnHolderRO(vaultPaths(join(rootDir, 'vaultB')).graphDb);
    try {
      const r = await compareVaultsHandler(ctx, { vaultA: 'vaultA', vaultB: 'vaultB' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Foo__c is in vaultA only → it is `removed` (in A, not B).
      expect(r.value.data.removed.map((c) => c.id)).toContain('CustomObject:Foo__c');
    } finally {
      await stopHolder(holder);
    }
  });
});
