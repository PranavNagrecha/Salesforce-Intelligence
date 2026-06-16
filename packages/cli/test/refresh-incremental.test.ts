/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeGraph,
  listNodesByType,
  openGraph,
} from '@sf-intelligence/graph';
import { vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';

/**
 * End-to-end coverage for `runRefresh({ incremental: true })`
 * (P5-incremental-refresh): the `meta/extract-cache.json` sidecar is written
 * on the first incremental run, reused on the second when nothing changed, and
 * a changed file's stale entry is dropped — all while the graph is rebuilt in
 * full so the result is byte-identical to a cold refresh.
 */
const seedVault = async (
  cwd: string,
): Promise<{ readonly vaultRoot: string; readonly classPath: string }> => {
  const vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  await mkdir(paths.source, { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'test',
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-06-02T00:00:00.000Z',
    }),
    'utf8',
  );
  const classesDir = join(paths.source, 'main', 'default', 'classes');
  await mkdir(classesDir, { recursive: true });
  const classPath = join(classesDir, 'FooBar.cls');
  await writeFile(
    classPath,
    `public class FooBar { public static void greet() { System.debug('hi'); } }`,
    'utf8',
  );
  await writeFile(
    join(classesDir, 'FooBar.cls-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
    'utf8',
  );
  return { vaultRoot, classPath };
};

const nodeCount = async (vaultRoot: string): Promise<number> => {
  const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const apex = await listNodesByType(opened.value, 'ApexClass', { limit: 50 });
    if (!apex.ok) throw new Error(apex.error.message);
    return apex.value.length;
  } finally {
    await closeGraph(opened.value);
  }
};

describe('runRefresh --incremental (P5-incremental-refresh)', () => {
  it('writes the cache sidecar on the first run and reuses it on an unchanged second run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-incr-'));
    try {
      const { vaultRoot } = await seedVault(cwd);
      const paths = vaultPaths(vaultRoot);

      // First incremental run: cold cache, nothing to reuse, sidecar written.
      const firstMessages: string[] = [];
      const first = await runRefresh({
        cwd,
        noPull: true,
        incremental: true,
        onProgress: (m) => firstMessages.push(m),
      });
      expect(first.status).toBe('success');
      expect(firstMessages.some((m) => m.includes('reused 0'))).toBe(true);

      // The sidecar exists with the version-keyed envelope + one entry.
      const cacheRaw = await readFile(
        join(paths.meta, 'extract-cache.json'),
        'utf8',
      );
      const cache = JSON.parse(cacheRaw) as {
        cacheVersion: number;
        packageVersion: string;
        entries: unknown[];
      };
      expect(cache.cacheVersion).toBe(1);
      expect(cache.packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(cache.entries.length).toBeGreaterThanOrEqual(1);

      const coldNodes = await nodeCount(vaultRoot);

      // Second incremental run, nothing changed: the file is reused, and the
      // graph still has the same nodes (full rebuild from reused results).
      const secondMessages: string[] = [];
      const second = await runRefresh({
        cwd,
        noPull: true,
        incremental: true,
        onProgress: (m) => secondMessages.push(m),
      });
      expect(second.status).toBe('success');
      expect(secondMessages.some((m) => /reused [1-9]/.test(m))).toBe(true);
      expect(await nodeCount(vaultRoot)).toBe(coldNodes);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('re-extracts a file whose content changed (cache miss on size), staying correct', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-incr-chg-'));
    try {
      const { vaultRoot, classPath } = await seedVault(cwd);

      await runRefresh({ cwd, noPull: true, incremental: true });

      // Rewrite the class with a DIFFERENT length so mtime+size both shift —
      // the cached entry must be discarded and the file re-extracted.
      await writeFile(
        classPath,
        `public class FooBar { public static void greetEveryoneLoudly() { System.debug('hello world'); } }`,
        'utf8',
      );

      const messages: string[] = [];
      const result = await runRefresh({
        cwd,
        noPull: true,
        incremental: true,
        onProgress: (m) => messages.push(m),
      });
      expect(result.status).toBe('success');
      // The single changed file did not reuse a cached extraction.
      expect(messages.some((m) => m.includes('reused 0'))).toBe(true);
      // Graph is still well-formed after the re-extract.
      expect(await nodeCount(vaultRoot)).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores a cache written under a different packageVersion (full re-extract)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-incr-ver-'));
    try {
      const { vaultRoot } = await seedVault(cwd);
      const paths = vaultPaths(vaultRoot);

      // Plant a poisoned cache from a "future" build: if it were honored, the
      // run would reuse its (bogus) entries. The version guard must reject it.
      await writeFile(
        join(paths.meta, 'extract-cache.json'),
        JSON.stringify({
          cacheVersion: 1,
          packageVersion: '99.0.0',
          entries: [
            { key: 'main/default/classes/FooBar.cls', mtimeMs: 1, size: 1, result: { nodes: [], edges: [] } },
          ],
        }),
        'utf8',
      );

      const messages: string[] = [];
      const result = await runRefresh({
        cwd,
        noPull: true,
        incremental: true,
        onProgress: (m) => messages.push(m),
      });
      expect(result.status).toBe('success');
      // Stale-version cache rejected → nothing reused → real file extracted.
      expect(messages.some((m) => m.includes('reused 0'))).toBe(true);
      expect(await nodeCount(vaultRoot)).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
