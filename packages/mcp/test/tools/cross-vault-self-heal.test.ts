/// <reference types="vitest/globals" />

/**
 * CR-19 self-heal guard (amendment option (a)): the READ-ONLY cross-vault open
 * path (`openVaultReadOnly`) must detect schema-version drift and re-open the
 * vault READ-WRITE to run migrations, then continue — so an additive migration
 * (a new table that leaves nodes/edges queryable) still reaches RO readers
 * instead of being silently skipped because the old content probe passed.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  CURRENT_SCHEMA_VERSION,
  openGraph,
  readSchemaVersion,
  type GraphStore,
} from '@sf-intelligence/graph';
import { saveManifest, vaultPaths } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { openVaultReadOnly } from '../../src/tools/cross-vault-open.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-26T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1 },
  edges: {},
  sourceTreeHash: 'sha256:selfheal',
};

let rootDir: string;
let ctxStore: GraphStore;
let ctx: Context;

/**
 * Write an OLD-schema vault to disk: base v0.1 tables and a seed row, then DROP
 * the schema_version table so the file looks like a pre-CR-19 vault (stored
 * version reads as 0). mcp does not depend on @duckdb/node-api directly, so we
 * build via the graph package's openGraph (which creates the version table) and
 * then drop it, rather than driving DuckDB ourselves.
 */
const buildOldVault = async (root: string): Promise<void> => {
  await mkdir(join(root, 'graph'), { recursive: true });
  await saveManifest(root, MANIFEST);
  const { graphDb } = vaultPaths(root);
  const opened = await openGraph(graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  const { connection } = opened.value;
  await connection.run(`INSERT INTO nodes (
    id, type, api_name, label, parent_id, source_path,
    last_modified_date, last_modified_by, api_version, properties_json
  ) VALUES (
    'CustomObject:Account', 'CustomObject', 'Account', 'Account',
    NULL, 'x', NULL, NULL, NULL, '{}'
  );`);
  // Make it genuinely pre-versioning: remove the ledger openGraph created.
  await connection.run('DROP TABLE schema_version;');
  await closeGraph(opened.value);
};

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sfi-selfheal-'));
  await buildOldVault(join(rootDir, 'oldVault'));
  const opened = await openGraph(join(rootDir, 'ctx.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  ctxStore = opened.value;
  // ctx.vaultRoot must NOT be the vault under test, so openVaultReadOnly opens
  // it fresh rather than reusing ctx.graph.
  ctx = { vaultRoot: rootDir, manifest: MANIFEST, graph: ctxStore };
});

afterAll(async () => {
  await closeGraph(ctxStore);
  await rm(rootDir, { recursive: true, force: true });
});

describe('openVaultReadOnly self-heals a schema-version-stale vault (CR-19)', () => {
  it('migrates the old vault forward and returns a usable handle', async () => {
    const oldRoot = join(rootDir, 'oldVault');
    const opened = await openVaultReadOnly(ctx, oldRoot);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.value.dispose();

    // After the self-heal, the on-disk vault is stamped to CURRENT and the row
    // is intact (lossless). Re-open RW to inspect the persisted file.
    const inspect = await openGraph(vaultPaths(oldRoot).graphDb);
    expect(inspect.ok).toBe(true);
    if (!inspect.ok) return;
    const version = await readSchemaVersion(inspect.value.connection);
    expect(version.ok).toBe(true);
    if (version.ok) expect(version.value).toBe(CURRENT_SCHEMA_VERSION);
    const reader = await inspect.value.connection.runAndReadAll(
      "SELECT api_name FROM nodes WHERE id = 'CustomObject:Account'",
    );
    expect(reader.getRowObjectsJS()).toEqual([{ api_name: 'Account' }]);
    await closeGraph(inspect.value);
  });
});
