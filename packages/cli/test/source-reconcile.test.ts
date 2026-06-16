/// <reference types="vitest/globals" />

import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeGraph, openGraph } from '@sf-intelligence/graph';
import { vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';
import {
  reconcileSourceDeletions,
  syncAuthoritativeRetrieveIntoSource,
} from '../src/source-reconcile.js';

const writeClass = async (root: string, name: string): Promise<void> => {
  const dir = join(root, 'main', 'default', 'classes');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.cls`), `public class ${name} {}`, 'utf8');
  await writeFile(
    join(dir, `${name}.cls-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
    'utf8',
  );
};

const seedVaultConfig = async (cwd: string): Promise<string> => {
  const vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  await mkdir(join(paths.source, 'main', 'default', 'classes'), { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'test',
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-06-04T00:00:00.000Z',
    }),
    'utf8',
  );
  return vaultRoot;
};

const nodeIds = async (vaultRoot: string): Promise<Set<string>> => {
  const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const rows = (
      await opened.value.connection.runAndReadAll('SELECT id FROM nodes')
    ).getRowObjectsJS() as readonly Record<string, unknown>[];
    return new Set(rows.map((r) => String(r.id)));
  } finally {
    await closeGraph(opened.value);
  }
};

describe('reconcileSourceDeletions', () => {
  it('drops source files absent from the authoritative retrieve set', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-reconcile-'));
    try {
      const sourceDir = join(cwd, 'source');
      const authoritativeDir = join(cwd, 'authoritative');
      await writeClass(sourceDir, 'Keep');
      await writeClass(sourceDir, 'Gone');
      await writeClass(authoritativeDir, 'Keep');

      const result = await reconcileSourceDeletions(
        sourceDir,
        authoritativeDir,
        new Set(['ApexClass']),
      );
      expect(result.deletedCount).toBe(2);
      await expect(access(join(sourceDir, 'main/default/classes/Gone.cls'))).rejects.toThrow();
      await expect(
        access(join(sourceDir, 'main/default/classes/Gone.cls-meta.xml')),
      ).rejects.toThrow();
      await syncAuthoritativeRetrieveIntoSource(sourceDir, authoritativeDir);
      await expect(
        writeFile(join(sourceDir, 'main/default/classes/Keep.cls'), 'public class Keep {}', 'utf8'),
      ).resolves.toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not touch types outside the reconcile scope', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-reconcile-scope-'));
    try {
      const sourceDir = join(cwd, 'source');
      const authoritativeDir = join(cwd, 'authoritative');
      await writeClass(sourceDir, 'StaleClass');
      await mkdir(join(sourceDir, 'main', 'default', 'flows'), { recursive: true });
      await writeFile(
        join(sourceDir, 'main', 'default', 'flows', 'Old_Flow.flow-meta.xml'),
        '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><status>Active</status></Flow>',
        'utf8',
      );
      await mkdir(join(authoritativeDir, 'main', 'default', 'classes'), { recursive: true });

      const result = await reconcileSourceDeletions(
        sourceDir,
        authoritativeDir,
        new Set(['ApexClass']),
      );
      expect(result.deletedCount).toBe(2);
      await expect(
        writeFile(join(sourceDir, 'main/default/flows/Old_Flow.flow-meta.xml'), '', 'utf8'),
      ).resolves.toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('source reconcile + refresh', () => {
  it('drops graph nodes after authoritative source reconciliation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-reconcile-graph-'));
    try {
      const vault = await seedVaultConfig(cwd);
      const paths = vaultPaths(vault);
      await writeClass(paths.source, 'Keep');
      await writeClass(paths.source, 'Gone');
      expect((await runRefresh({ cwd, noPull: true })).status).toBe('success');
      expect((await nodeIds(vault)).has('ApexClass:Gone')).toBe(true);

      const authoritativeDir = join(cwd, 'authoritative');
      await writeClass(authoritativeDir, 'Keep');
      await reconcileSourceDeletions(paths.source, authoritativeDir, new Set(['ApexClass']));
      await syncAuthoritativeRetrieveIntoSource(paths.source, authoritativeDir);

      expect((await runRefresh({ cwd, noPull: true })).status).toBe('success');
      const after = await nodeIds(vault);
      expect(after.has('ApexClass:Gone')).toBe(false);
      expect(after.has('ApexClass:Keep')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
