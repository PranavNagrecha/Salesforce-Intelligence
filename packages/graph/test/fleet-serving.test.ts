/// <reference types="vitest/globals" />

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtractionResult } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import { getNodeById } from '../src/queries.js';
import { closeGraph, openGraph, openGraphReadOnly } from '../src/store.js';

// P7-readonly-fleet-serving: lock in the concurrent read-only serving capability
// the MCP server relies on (server.ts#openServerGraph opens READ-ONLY so several
// `sfi mcp` instances — an IDE's server + a CI harness + a fleet dashboard — can
// serve ONE vault at once), and prove that a `refresh` while the vault is served
// still surfaces the actionable `locked` error. DuckDB's single-writer lock only
// fires across processes, so the genuine scenarios are exercised with a real
// child process (the `vault-holder.mjs` fixture) rather than in-process, where
// DuckDB shares the instance and no conflict arises.

const HOLDER_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'vault-holder.mjs',
);

let tempDir: string;
let dbPath: string;

const SEED: ExtractionResult = {
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

/**
 * Spawn the holder fixture in `mode`, resolving once it has acquired the lock
 * (prints `READY`). Rejects if it exits early or never signals within 20s.
 */
const spawnHolder = (mode: 'RO' | 'RW'): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER_FIXTURE], {
      env: { ...process.env, DBP: dbPath, MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`holder (${mode}) did not signal READY within 20s`));
    }, 20_000);
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('READY')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`holder (${mode}) exited early (code ${code}): ${stderr}`));
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

/** SIGKILL the holder and wait for it to actually exit (release its lock). */
const stopHolder = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-fleet-'));
  dbPath = join(tempDir, 'graph.duckdb');
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(opened.error.message);
  const imp = await importExtractionResults(opened.value, [SEED]);
  if (!imp.ok) throw new Error(imp.error.message);
  await closeGraph(opened.value);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('P7-readonly-fleet-serving: concurrent read-only serving', () => {
  it('a SEPARATE process can serve the same vault read-only while this one does (IDE server + CI harness on one vault)', async () => {
    const holder = await spawnHolder('RO');
    try {
      const ro = await openGraphReadOnly(dbPath);
      expect(ro.ok).toBe(true);
      if (!ro.ok) return;
      const node = await getNodeById(ro.value, 'CustomObject:Account');
      expect(node.ok && node.value?.apiName).toBe('Account');
      await closeGraph(ro.value);
    } finally {
      await stopHolder(holder);
    }
  });
});

describe('P7-readonly-fleet-serving: a refresh while served surfaces the lock', () => {
  it('a read-write open (a `refresh`) while another process serves the vault read-only returns an actionable `locked` error, not a raw DuckDB error', async () => {
    const holder = await spawnHolder('RO');
    try {
      const rw = await openGraph(dbPath);
      expect(rw.ok).toBe(false);
      if (rw.ok) {
        await closeGraph(rw.value);
        return;
      }
      expect(rw.error.kind).toBe('locked');
      // The actionable message names the culprit and the remedy (P5-duckdb-lock).
      expect(rw.error.message).toContain('locked by another process');
      expect(rw.error.message).toContain('sfi mcp');
      expect(rw.error.message).toContain('retry');
    } finally {
      await stopHolder(holder);
    }
  });
});
