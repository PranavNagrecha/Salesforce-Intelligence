/// <reference types="vitest/globals" />

import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ComponentType } from '@sf-intelligence/contracts';
import { closeGraph, openGraph } from '@sf-intelligence/graph';
import {
  appendTombstones,
  readTombstones,
  vaultPaths,
} from '@sf-intelligence/vault';

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
      // AUDIT-F5: confirmed deletions get tombstones (refresh wires the same call).
      expect(result.refused).toBe(false);
      await appendTombstones(cwd, result.deletedPaths, {
        deletedAt: '2026-08-07T12:00:00.000Z',
      });
      const tombs = await readTombstones(cwd);
      expect(tombs.some((t) => t.componentPath.includes('Gone.cls'))).toBe(true);
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

/** Write a file at `root/<relPath>` (POSIX-style rel path), creating parents. */
const writeAt = async (root: string, relPath: string, body: string): Promise<void> => {
  const abs = join(root, ...relPath.split('/'));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body, 'utf8');
};

/**
 * The incident's exact shape: an older vault laid out FLAT, and an authoritative
 * retrieve of the same components laid out under an SFDX package dir.
 */
const INCIDENT_FILES: readonly (readonly [string, string])[] = [
  ['objects/Account/Account.object-meta.xml', '<CustomObject/>'],
  ['objects/Account/fields/Industry__c.field-meta.xml', '<CustomField/>'],
  ['objects/Contact/Contact.object-meta.xml', '<CustomObject/>'],
  ['objects/Contact/fields/Tier__c.field-meta.xml', '<CustomField/>'],
  ['classes/Keep.cls', 'public class Keep {}'],
  ['classes/Keep.cls-meta.xml', '<ApexClass/>'],
  ['reports/Sales/Pipeline.report-meta.xml', '<Report/>'],
  ['dashboards/Exec/Overview.dashboard-meta.xml', '<Dashboard/>'],
];

const INCIDENT_TYPES = new Set([
  'CustomObject',
  'CustomField',
  'ApexClass',
  'Report',
  'Dashboard',
] as const);

describe('reconcileSourceDeletions layout normalisation', () => {
  it('deletes nothing when the vault is flat and the retrieve is package-dir wrapped', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-reconcile-layout-'));
    try {
      const sourceDir = join(cwd, 'source');
      const authoritativeDir = join(cwd, 'authoritative');
      for (const [rel, body] of INCIDENT_FILES) {
        await writeAt(sourceDir, rel, body);
        await writeAt(authoritativeDir, `force-app/main/default/${rel}`, body);
      }

      const result = await reconcileSourceDeletions(
        sourceDir,
        authoritativeDir,
        INCIDENT_TYPES as ReadonlySet<ComponentType>,
      );

      // Before the layout fix this reported deletedCount 8 of 8 — the incident.
      expect(result.deletedPaths).toEqual([]);
      expect(result.deletedCount).toBe(0);
      expect(result.refused).toBe(false);
      for (const [rel] of INCIDENT_FILES) {
        await expect(access(join(sourceDir, ...rel.split('/')))).resolves.toBeUndefined();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('is unchanged when both trees already sit under main/default', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-reconcile-samelayout-'));
    try {
      const sourceDir = join(cwd, 'source');
      const authoritativeDir = join(cwd, 'authoritative');
      for (const [rel, body] of INCIDENT_FILES) {
        await writeAt(sourceDir, `main/default/${rel}`, body);
        await writeAt(authoritativeDir, `main/default/${rel}`, body);
      }

      const result = await reconcileSourceDeletions(
        sourceDir,
        authoritativeDir,
        INCIDENT_TYPES as ReadonlySet<ComponentType>,
      );

      expect(result.deletedCount).toBe(0);
      expect(result.refused).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('still deletes a component that really is absent from the retrieve', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-reconcile-genuine-'));
    try {
      const sourceDir = join(cwd, 'source');
      const authoritativeDir = join(cwd, 'authoritative');
      for (const [rel, body] of INCIDENT_FILES) {
        await writeAt(sourceDir, rel, body);
        await writeAt(authoritativeDir, `force-app/main/default/${rel}`, body);
      }
      // Present in the vault, absent from the org: one field and one report.
      await writeAt(sourceDir, 'objects/Account/fields/Dead__c.field-meta.xml', '<CustomField/>');
      await writeAt(sourceDir, 'reports/Sales/Retired.report-meta.xml', '<Report/>');

      const result = await reconcileSourceDeletions(
        sourceDir,
        authoritativeDir,
        INCIDENT_TYPES as ReadonlySet<ComponentType>,
      );

      expect(result.deletedCount).toBe(2);
      expect(result.refused).toBe(false);
      await expect(
        access(join(sourceDir, 'objects/Account/fields/Dead__c.field-meta.xml')),
      ).rejects.toThrow();
      await expect(
        access(join(sourceDir, 'reports/Sales/Retired.report-meta.xml')),
      ).rejects.toThrow();
      await expect(
        access(join(sourceDir, 'objects/Account/fields/Industry__c.field-meta.xml')),
      ).resolves.toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('reconcileSourceDeletions safety rail', () => {
  it('refuses a wholesale mismatch and leaves every file on disk', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-reconcile-rail-'));
    try {
      const sourceDir = join(cwd, 'source');
      const authoritativeDir = join(cwd, 'authoritative');
      // Vault holds Foo_0..Foo_29; the retrieve holds a disjoint set of the same
      // type, so a layout-blind comparison would delete all 30.
      for (let i = 0; i < 30; i += 1) {
        await writeAt(sourceDir, `classes/Foo_${i}.cls`, `public class Foo_${i} {}`);
      }
      for (let i = 0; i < 30; i += 1) {
        await writeAt(authoritativeDir, `classes/Bar_${i}.cls`, `public class Bar_${i} {}`);
      }

      const result = await reconcileSourceDeletions(
        sourceDir,
        authoritativeDir,
        new Set(['ApexClass']),
      );

      expect(result.refused).toBe(true);
      expect(result.deletedCount).toBe(0);
      expect(result.deletedPaths).toEqual([]);
      expect(result.consideredCount).toBe(30);
      expect(result.refusalReason).toMatch(/layout mismatch/i);
      // AUDIT-F5: refuse must not invent tombstones (stale kept ≠ deleted).
      expect(await readTombstones(cwd)).toEqual([]);
      for (let i = 0; i < 30; i += 1) {
        await expect(access(join(sourceDir, 'classes', `Foo_${i}.cls`))).resolves.toBeUndefined();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not trip on a normal small deletion inside a large tree', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-reconcile-rail-ok-'));
    try {
      const sourceDir = join(cwd, 'source');
      const authoritativeDir = join(cwd, 'authoritative');
      for (let i = 0; i < 30; i += 1) {
        await writeAt(sourceDir, `classes/Foo_${i}.cls`, `public class Foo_${i} {}`);
        if (i >= 2) {
          await writeAt(
            authoritativeDir,
            `force-app/main/default/classes/Foo_${i}.cls`,
            `public class Foo_${i} {}`,
          );
        }
      }

      const result = await reconcileSourceDeletions(
        sourceDir,
        authoritativeDir,
        new Set(['ApexClass']),
      );

      expect(result.deletedCount).toBe(2);
      expect(result.refused).toBe(false);
      await expect(access(join(sourceDir, 'classes/Foo_0.cls'))).rejects.toThrow();
      await expect(access(join(sourceDir, 'classes/Foo_5.cls'))).resolves.toBeUndefined();
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
