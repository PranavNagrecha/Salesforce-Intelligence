/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeGraph, openGraph, readFacts, writeFacts } from '@sf-intelligence/graph';
import { loadManifest, vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';

/**
 * End-to-end coverage for `runRefresh({ incrementalGraph: true })`
 * (P7-incremental-graph-update): a refresh that re-imports ONLY the changed
 * nodes/edges through the transactional change-set apply must produce a graph
 * byte-identical to a full cold rebuild of the same source — across an added,
 * a modified, AND a removed component.
 */
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

const writeClass = async (
  vaultRoot: string,
  name: string,
  body: string,
): Promise<void> => {
  const dir = join(vaultPaths(vaultRoot).source, 'main', 'default', 'classes');
  await writeFile(join(dir, `${name}.cls`), body, 'utf8');
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

const removeClass = async (vaultRoot: string, name: string): Promise<void> => {
  const dir = join(vaultPaths(vaultRoot).source, 'main', 'default', 'classes');
  await rm(join(dir, `${name}.cls`), { force: true });
  await rm(join(dir, `${name}.cls-meta.xml`), { force: true });
};

/** Serialize the whole graph in deterministic PK order — the equivalence oracle. */
const dumpGraph = async (vaultRoot: string): Promise<string> => {
  const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const q = async (sql: string): Promise<readonly Record<string, unknown>[]> =>
      (await opened.value.connection.runAndReadAll(sql)).getRowObjectsJS() as readonly Record<
        string,
        unknown
      >[];
    const nodes = await q(
      `SELECT id, type, api_name, label, parent_id, source_path,
              last_modified_date, last_modified_by, api_version, properties_json
       FROM nodes ORDER BY id`,
    );
    const edges = await q(
      `SELECT from_id, to_id, edge_type, confidence, source, properties_json
       FROM edges ORDER BY from_id, to_id, edge_type, source`,
    );
    return JSON.stringify({ nodes, edges });
  } finally {
    await closeGraph(opened.value);
  }
};

// S2 = S1 with Baz removed, Foo modified, Qux added.
const fooV1 = `public class Foo { public static void a() { System.debug('a'); } }`;
const fooV2 = `public class Foo { public static void aRenamedAndLonger() { System.debug('changed body'); } }`;
const baz = `public class Baz { public static void b() {} }`;
const qux = `public class Qux { public static void q() {} }`;

const seedS1 = async (vaultRoot: string): Promise<void> => {
  await writeClass(vaultRoot, 'Foo', fooV1);
  await writeClass(vaultRoot, 'Baz', baz);
};
const mutateToS2 = async (vaultRoot: string): Promise<void> => {
  await writeClass(vaultRoot, 'Foo', fooV2); // modify
  await removeClass(vaultRoot, 'Baz'); // remove
  await writeClass(vaultRoot, 'Qux', qux); // add
};
const seedS2 = async (vaultRoot: string): Promise<void> => {
  await writeClass(vaultRoot, 'Foo', fooV2);
  await writeClass(vaultRoot, 'Qux', qux);
};

describe('runRefresh --incremental-graph (P7-incremental-graph-update)', () => {
  it('produces a graph byte-identical to a full rebuild across add/modify/remove', async () => {
    const incrCwd = await mkdtemp(join(tmpdir(), 'sfi-incgraph-'));
    const coldCwd = await mkdtemp(join(tmpdir(), 'sfi-incgraph-cold-'));
    try {
      // Incremental path: full refresh of S1, then an incremental-graph refresh of S2.
      const incrVault = await seedVaultConfig(incrCwd);
      await seedS1(incrVault);
      const first = await runRefresh({ cwd: incrCwd, noPull: true });
      expect(first.status).toBe('success');

      await mutateToS2(incrVault);
      const messages: string[] = [];
      const second = await runRefresh({
        cwd: incrCwd,
        noPull: true,
        incrementalGraph: true,
        onProgress: (m) => messages.push(m),
      });
      expect(second.status).toBe('success');
      // The transactional apply ran (not the full-rebuild fallback).
      expect(messages.some((m) => m.includes('Incremental graph:') && m.includes('cold-identical'))).toBe(true);

      // Cold reference: a fresh vault built straight to S2 in full.
      const coldVault = await seedVaultConfig(coldCwd);
      await seedS2(coldVault);
      const cold = await runRefresh({ cwd: coldCwd, noPull: true });
      expect(cold.status).toBe('success');

      const incrDump = await dumpGraph(incrVault);
      expect(incrDump).toBe(await dumpGraph(coldVault));
      // The removed component is actually gone (delete path exercised).
      expect(incrDump).not.toContain('ApexClass:Baz');
      expect(incrDump).toContain('ApexClass:Qux');
    } finally {
      await rm(incrCwd, { recursive: true, force: true });
      await rm(coldCwd, { recursive: true, force: true });
    }
  });
});

describe('runRefresh side-build integrity', () => {
  it('preserves facts and publishes artifacts from the installed replacement graph', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-side-build-'));
    try {
      const vault = await seedVaultConfig(cwd);
      await writeClass(vault, 'Before', 'public class Before {}');
      expect((await runRefresh({ cwd, noPull: true })).status).toBe('success');

      const live = await openGraph(vaultPaths(vault).graphDb);
      if (!live.ok) throw new Error(live.error.message);
      try {
        const written = await writeFacts(live.value, [{
          subjectId: 'CustomObject:Account',
          metric: 'recordCount',
          value: 42,
          capturedAt: '2026-06-10T00:00:00.000Z',
          method: 'rest-recordcount',
          source: 'refresh-with-data-shape',
        }]);
        expect(written.ok).toBe(true);
      } finally {
        await closeGraph(live.value);
      }

      await writeClass(vault, 'After', 'public class After {}');
      const rebuilt = await runRefresh({ cwd, noPull: true, forceSideBuild: true });
      expect(rebuilt.status).toBe('success');

      const installed = await openGraph(vaultPaths(vault).graphDb);
      if (!installed.ok) throw new Error(installed.error.message);
      try {
        const facts = await readFacts(installed.value, { subjectId: 'CustomObject:Account' });
        expect(facts.ok && facts.value[0]?.value).toBe(42);
      } finally {
        await closeGraph(installed.value);
      }

      const manifest = await loadManifest(vault);
      if (!manifest.ok) throw new Error(manifest.error.message);
      expect(manifest.value.components.ApexClass).toBe(2);
      const ids = await nodeIds(vault);
      expect(ids.has('ApexClass:Before')).toBe(true);
      expect(ids.has('ApexClass:After')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

/** Set of every node id currently in the graph. */
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

const writeObject = async (vaultRoot: string, name: string): Promise<void> => {
  const dir = join(vaultPaths(vaultRoot).source, 'main', 'default', 'objects', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.object-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <deploymentStatus>Deployed</deploymentStatus>
  <label>${name}</label>
  <nameField>
    <label>Name</label>
    <type>Text</type>
  </nameField>
  <pluralLabel>${name}s</pluralLabel>
  <sharingModel>ReadWrite</sharingModel>
</CustomObject>
`,
    'utf8',
  );
};

/**
 * The DEFAULT import (no `--incremental-graph`) is upsert-only, so a component
 * removed from `source/` used to ORPHAN in the graph. A full, clean, no-pull
 * refresh now `fullRebuild`s so it reflects the authoritative source — while a
 * scoped or pulled refresh stays upsert-only so a partial extract / flaky
 * retrieve never wipes live data. (P10-A7 follow-up.)
 */
describe('runRefresh default import — deletion reconciliation', () => {
  it('a FULL no-pull refresh DROPS a component removed from source (no orphan)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-del-'));
    try {
      const vault = await seedVaultConfig(cwd);
      await writeClass(vault, 'Keep', 'public class Keep {}');
      await writeClass(vault, 'Gone', 'public class Gone {}');
      expect((await runRefresh({ cwd, noPull: true })).status).toBe('success');
      expect((await nodeIds(vault)).has('ApexClass:Gone')).toBe(true);

      await removeClass(vault, 'Gone');
      expect((await runRefresh({ cwd, noPull: true })).status).toBe('success');
      const after = await nodeIds(vault);
      expect(after.has('ApexClass:Gone')).toBe(false); // dropped, not orphaned
      expect(after.has('ApexClass:Keep')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('a SCOPED no-pull refresh does NOT wipe other types (upsert-preserve)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-scope-'));
    try {
      const vault = await seedVaultConfig(cwd);
      await writeClass(vault, 'Survivor', 'public class Survivor {}');
      await writeObject(vault, 'Thing__c');
      expect((await runRefresh({ cwd, noPull: true })).status).toBe('success');
      expect((await nodeIds(vault)).has('ApexClass:Survivor')).toBe(true);

      // A scoped refresh that re-extracts only CustomObject must NOT truncate;
      // the ApexClass it never touched this run has to survive (a full rebuild
      // here would wipe it — exactly the partial-extract data loss we guard).
      expect(
        (await runRefresh({ cwd, noPull: true, types: 'CustomObject' })).status,
      ).toBe('success');
      expect((await nodeIds(vault)).has('ApexClass:Survivor')).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

const removeObject = async (vaultRoot: string, name: string): Promise<void> => {
  const dir = join(vaultPaths(vaultRoot).source, 'main', 'default', 'objects', name);
  await rm(dir, { recursive: true, force: true });
};

/**
 * Finding #23 (P3guard) regression coverage: `--incremental-graph`'s
 * `computeChangeSet(store, results)` call used to diff `results` (a SCOPED
 * `--types` walk only extracts the requested type(s)) against the WHOLE
 * graph, so every non-requested node read as "current but not desired" and
 * was mass-deleted — or, past `INCREMENTAL_DELTA_CAP`, fell back to
 * `fullRebuild`, which truncates the entire graph and reimports only the
 * scoped `results`. Both are silent, severe data loss on a routine
 * `sfi refresh --types <X> --incremental-graph` run.
 */
describe('runRefresh --incremental-graph scoped by --types (finding #23 / P3guard)', () => {
  it('does NOT delete or truncate non-requested-type nodes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-incgraph-scope-'));
    try {
      const vault = await seedVaultConfig(cwd);
      await writeClass(vault, 'Survivor', 'public class Survivor {}');
      await writeObject(vault, 'Thing__c');
      expect((await runRefresh({ cwd, noPull: true })).status).toBe('success');
      expect((await nodeIds(vault)).has('ApexClass:Survivor')).toBe(true);
      expect((await nodeIds(vault)).has('CustomObject:Thing__c')).toBe(true);

      await writeObject(vault, 'NewThing__c');

      // A scoped + incremental-graph refresh that only re-extracts
      // CustomObject must NOT touch ApexClass: the unguarded diff would see
      // ApexClass:Survivor as "current but not desired" and delete it (or,
      // past the cap, truncate the whole graph via fullRebuild).
      const messages: string[] = [];
      const result = await runRefresh({
        cwd,
        noPull: true,
        types: 'CustomObject',
        incrementalGraph: true,
        onProgress: (m) => messages.push(m),
      });
      expect(result.status).toBe('success');
      // Never the whole-graph rebuild/truncate fallback this guards against.
      expect(messages.some((m) => m.includes('rebuilding full'))).toBe(false);

      const after = await nodeIds(vault);
      expect(after.has('CustomObject:NewThing__c')).toBe(true); // the new one landed
      expect(after.has('ApexClass:Survivor')).toBe(true); // NOT wiped
      expect(after.has('CustomObject:Thing__c')).toBe(true); // still present
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('still prunes a stale node WITHIN the requested type (not a no-op guard)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-incgraph-scope-prune-'));
    try {
      const vault = await seedVaultConfig(cwd);
      await writeClass(vault, 'Survivor', 'public class Survivor {}');
      await writeObject(vault, 'Keep__c');
      await writeObject(vault, 'Gone__c');
      expect((await runRefresh({ cwd, noPull: true })).status).toBe('success');
      expect((await nodeIds(vault)).has('CustomObject:Gone__c')).toBe(true);

      await removeObject(vault, 'Gone__c');
      const messages: string[] = [];
      const result = await runRefresh({
        cwd,
        noPull: true,
        types: 'CustomObject',
        incrementalGraph: true,
        onProgress: (m) => messages.push(m),
      });
      expect(result.status).toBe('success');
      // The scoped prune branch actually ran (this run has a real delete, so
      // unlike an add-only run it does not short-circuit on a zero delta).
      expect(messages.some((m) => m.includes('Incremental graph (scoped):'))).toBe(true);
      expect(messages.some((m) => m.includes('rebuilding full'))).toBe(false);

      const after = await nodeIds(vault);
      expect(after.has('CustomObject:Gone__c')).toBe(false); // pruned (same type)
      expect(after.has('CustomObject:Keep__c')).toBe(true); // sibling survives
      expect(after.has('ApexClass:Survivor')).toBe(true); // other type untouched
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
