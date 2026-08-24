/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import { getNodeById } from '../src/queries.js';
import {
  closeGraph,
  isLockConflict,
  isNativeBindingFailure,
  lockConflictMessage,
  nativeBindingMessage,
  openGraph,
  openGraphReadOnly,
  probeDuckDBNative,
} from '../src/store.js';

let tempDir: string;
let dbPath: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-store-'));
  dbPath = join(tempDir, 'ro.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(opened.error.message);
  const seed: ExtractionResult = {
    nodes: [
      {
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
        label: 'Account',
        parentId: null,
        sourcePath: 'x',
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {},
      },
    ],
    edges: [],
  };
  const imp = await importExtractionResults(opened.value, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  await closeGraph(opened.value);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('openGraphReadOnly', () => {
  it('opens an existing vault and serves reads', async () => {
    const r = await openGraphReadOnly(dbPath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const node = await getNodeById(r.value, 'CustomObject:Account');
    expect(node.ok && node.value?.apiName).toBe('Account');
    await closeGraph(r.value);
  });

  it('returns open-failed when the file does not exist (read-only cannot create)', async () => {
    const r = await openGraphReadOnly(join(tempDir, 'does-not-exist.db'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('open-failed');
  });

  it('rejects writes — the vault cannot be mutated through this handle', async () => {
    const r = await openGraphReadOnly(dbPath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await expect(
      r.value.connection.run(
        "INSERT INTO nodes VALUES ('CustomObject:X','CustomObject','X',null,null,'x',null,null,null,'{}')",
      ),
    ).rejects.toThrow();
    await closeGraph(r.value);
  });
});

describe('DuckDB lock-conflict detection (P5-duckdb-lock / B15)', () => {
  // Representative of the real DuckDB single-writer error. The lock only
  // fires across processes (within one process DuckDB shares the instance),
  // so the detector + message are unit-tested directly here; the real
  // cross-process path (a refresh denied while a server serves the vault) is
  // exercised with a child-process holder in fleet-serving.test.ts
  // (P7-readonly-fleet-serving).
  const REAL_LOCK_ERR =
    'IO Error: Could not set lock on file "/x/graph.duckdb": Conflicting lock is held in /usr/local/bin/node (PID 4242). See also https://duckdb.org/docs/connect/concurrency';

  it('isLockConflict matches the DuckDB lock error and ignores unrelated errors', () => {
    expect(isLockConflict(REAL_LOCK_ERR)).toBe(true);
    expect(isLockConflict('Could not set lock on file "g.db"')).toBe(true);
    expect(isLockConflict('CONFLICTING LOCK is held')).toBe(true); // case-insensitive
    expect(isLockConflict('No such file or directory')).toBe(false);
    expect(isLockConflict('Catalog Error: Table does not exist')).toBe(false);
  });

  it('lockConflictMessage names the culprit and the remedy, and carries the cause', () => {
    // Asserted on BOTH platform branches, not just the host's. The remedy text
    // diverges by platform (POSIX recovers automatically, Windows cannot), and
    // this contract must hold either way — otherwise the Windows CI runner goes
    // red on a message the macOS runner is perfectly happy with.
    const ORIG = process.platform;
    try {
      for (const platform of ['darwin', 'win32'] as const) {
        Object.defineProperty(process, 'platform', { value: platform });
        const msg = lockConflictMessage('/x/graph.duckdb', REAL_LOCK_ERR);
        expect(msg).toContain('/x/graph.duckdb');
        expect(msg).toContain('locked by another process');
        expect(msg).toContain('sfi mcp'); // names the likely culprit
        expect(msg).toContain('retry'); // gives the remedy
        expect(msg).toContain(REAL_LOCK_ERR); // appends the underlying error
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: ORIG });
    }
  });

  it('a non-lock open failure stays `open-failed`, never mislabeled `locked`', async () => {
    // tempDir is a directory, not a DuckDB file — open fails for a reason
    // that is NOT a lock conflict, so the branch must keep `open-failed`.
    const r = await openGraph(tempDir);
    expect(r.ok).toBe(false);
    if (r.ok) {
      await closeGraph(r.value);
      return;
    }
    expect(r.error.kind).toBe('open-failed');
    expect(r.error.kind).not.toBe('locked');
  });
});

describe('DuckDB native-binding detection (INFRA-11)', () => {
  const REAL_DLOPEN_ERR =
    "Error: dlopen(/path/node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node, 0x0001): tried: '/path/duckdb.node' (no such file)";

  it('isNativeBindingFailure matches dlopen / missing-binding shapes and ignores unrelated errors', () => {
    expect(isNativeBindingFailure(REAL_DLOPEN_ERR)).toBe(true);
    expect(isNativeBindingFailure('ERR_DLOPEN_FAILED: file too short')).toBe(true);
    expect(isNativeBindingFailure('Library not loaded: @rpath/libduckdb.dylib')).toBe(true);
    expect(isNativeBindingFailure('Cannot find module @duckdb/node-api')).toBe(true);
    expect(isNativeBindingFailure('was compiled against a different Node.js version')).toBe(
      true,
    );
    expect(isNativeBindingFailure('No such file or directory')).toBe(false);
    expect(
      isNativeBindingFailure(
        'IO Error: Could not set lock on file "/x/graph.duckdb": Conflicting lock is held',
      ),
    ).toBe(false);
  });

  it('nativeBindingMessage names platform/arch and the reinstall remedy', () => {
    const msg = nativeBindingMessage(REAL_DLOPEN_ERR);
    expect(msg).toContain('@duckdb/node-api');
    expect(msg).toContain(`${process.platform}-${process.arch}`);
    expect(msg).toContain('rebuild');
    expect(msg).toContain(REAL_DLOPEN_ERR);
  });

  it('probeDuckDBNative succeeds when native bindings are installed', async () => {
    const r = await probeDuckDBNative();
    expect(r.ok).toBe(true);
  });
});

/**
 * The lock-conflict remedy is platform-DERIVED, not asserted.
 *
 * `sfi refresh` recovers from this automatically only on POSIX, where a rename
 * may replace a file another process holds open. On Windows that rename fails
 * with EPERM/EBUSY for as long as a connected MCP server holds a handle, so
 * telling a Windows user "no restart needed" sends them hunting for a bug that
 * is not there. This is the drift test for that claim.
 */
describe('lockConflictMessage — the auto-recovery claim is platform-gated', () => {
  const ORIG = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIG });
  });

  it('does NOT promise automatic recovery on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const msg = lockConflictMessage('C:\\vault\\graph.duckdb', 'conflicting lock');
    expect(msg).not.toContain('no restart needed');
    expect(msg).not.toContain('AUTOMATICALLY');
    // and tells them what actually works there
    expect(msg).toContain('close your MCP client');
  });

  it('keeps the automatic-recovery guidance on POSIX, where it is true', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const msg = lockConflictMessage('/vault/graph.duckdb', 'conflicting lock');
    expect(msg).toContain('no restart needed');
  });

  it('names the database and the underlying cause on both platforms', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      Object.defineProperty(process, 'platform', { value: platform });
      const msg = lockConflictMessage('/vault/graph.duckdb', 'conflicting lock: pid 42');
      expect(msg).toContain('/vault/graph.duckdb');
      expect(msg).toContain('conflicting lock: pid 42');
    }
  });
});
