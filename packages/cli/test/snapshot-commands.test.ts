/// <reference types="vitest/globals" />

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';
import {
  saveManifest,
  snapshotPath,
  vaultPaths,
  type SnapshotMeta,
} from '@sf-intelligence/vault';

import {
  canonicalJson,
  captureSnapshotGraph,
  runSnapshotCreate,
  runSnapshotDelete,
  runSnapshotList,
} from '../src/commands/snapshot.js';

const makeTempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-snapshot-'));

const SAMPLE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

/**
 * Stage a minimal vault: a `meta/config.json`, the manifest, a
 * pre-created graph directory + DB seeded with two CustomObject
 * nodes and one parentOf edge between them. The snapshot CLI then
 * has a real graph to capture without spawning an extractor walk.
 */
const seedVault = async (
  cwd: string,
  manifest: VaultManifest = SAMPLE_MANIFEST,
): Promise<{ readonly vaultRoot: string }> => {
  const vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  for (const dir of [paths.meta, paths.graph, paths.source, paths.components]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(
    paths.config,
    JSON.stringify({ targetOrg: 'test', vaultRoot, version: '0.1.0', createdAt: '2026-05-27T00:00:00.000Z' }),
    'utf8',
  );
  const saved = await saveManifest(vaultRoot, manifest);
  if (!saved.ok) throw new Error(saved.error.message);

  // Seed the graph with two nodes + one edge so the captured
  // snapshot has both lists non-empty.
  const opened = await openGraph(paths.graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const imported = await importExtractionResults(opened.value, [
      {
        nodes: [
          {
            id: 'CustomObject:Account',
            type: 'CustomObject',
            apiName: 'Account',
            label: 'Account',
            parentId: null,
            sourcePath: 'objects/Account/Account.object-meta.xml',
            lastModifiedDate: null,
            lastModifiedBy: null,
            apiVersion: null,
            properties: { sharingModel: 'ReadWrite' },
          },
          {
            id: 'CustomField:Account.Industry__c',
            type: 'CustomField',
            apiName: 'Industry__c',
            label: 'Industry',
            parentId: 'CustomObject:Account',
            sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
            lastModifiedDate: null,
            lastModifiedBy: null,
            apiVersion: null,
            properties: { dataType: 'Text' },
          },
        ],
        edges: [
          {
            fromId: 'CustomObject:Account',
            toId: 'CustomField:Account.Industry__c',
            edgeType: 'parentOf',
            confidence: 'declared',
            source: 'unit-test',
            properties: {},
          },
        ],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
  } finally {
    await closeGraph(opened.value);
  }

  return { vaultRoot };
};

describe('runSnapshotCreate', () => {
  it('persists the four snapshot files under {vaultRoot}/snapshots/{label}/', async () => {
    const cwd = await makeTempCwd();
    try {
      const { vaultRoot } = await seedVault(cwd);
      const created = await runSnapshotCreate({ cwd, label: 'snap-1' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const dir = snapshotPath(vaultRoot, 'snap-1');
      const entries = await readdir(dir);
      expect(entries.sort()).toEqual(['edges.json', 'manifest.json', 'meta.json', 'nodes.json']);
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as SnapshotMeta;
      expect(meta.label).toBe('snap-1');
      expect(meta.componentCount).toBe(2);
      expect(meta.edgeCount).toBe(1);
      expect(meta.sourceTreeHash).toBe('sha256:fixture');
      // R8-SECURITY-TREND. This assertion USED TO READ:
      //     expect(meta.metrics?.['securityScore']).toBe(100)   // "empty fixture → A / 100"
      // which encoded the defect rather than the contract. This fixture's
      // manifest carries NO coverage at all, so Profile / PermissionSet /
      // PermissionSetGroup / ApexClass / ApexTrigger were never confirmed
      // retrieved — and the metric grades an over-privilege headline computed
      // from exactly those five families. Scoring a perfect 100 over a vault
      // that holds none of them is a graded A for an unchecked corpus, which is
      // the one thing this product must never do. The metric is now WITHHELD
      // there, and its absence is the correct answer, not a gap.
      //
      // WHAT THIS ASSERTION IS AND IS NOT: it documents the CONSUMER-visible
      // effect. It cannot BITE on the change that produced it — packages/cli
      // resolves `@sf-intelligence/mcp` through its built `dist`, so reverting
      // the mcp source leaves this test green. Measured, not assumed: with
      // security-posture-metric.ts reverted this file still passes 13/13.
      // The biting guard lives where it can bite —
      // packages/mcp/test/tools/security-posture-metric.test.ts
      // ("withholds the metric (typed absence) when Profile retrieval ERRORED"),
      // which goes red the moment the coverage gate is removed.
      expect(meta.metrics).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('captures the security metric once the families it grades are confirmed retrieved', async () => {
    // The positive half of the pair above. Without this, "metrics is undefined"
    // would pass just as well if the capture had been deleted outright.
    const cwd = await makeTempCwd();
    try {
      const covered: VaultManifest = {
        ...SAMPLE_MANIFEST,
        coverage: ['Profile', 'PermissionSet', 'PermissionSetGroup', 'ApexClass', 'ApexTrigger'].map(
          (type) => ({
            type,
            requested: true,
            retrieved: 1,
            errored: false,
            neverModeled: false,
            retrieveConfirmed: true,
          }),
        ),
      };
      const { vaultRoot } = await seedVault(cwd, covered);
      const created = await runSnapshotCreate({ cwd, label: 'snap-covered' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const meta = JSON.parse(
        await readFile(join(snapshotPath(vaultRoot, 'snap-covered'), 'meta.json'), 'utf8'),
      ) as SnapshotMeta;
      expect(meta.metrics).toBeDefined();
      expect(typeof meta.metrics?.['securityScore']).toBe('number');
      expect(typeof meta.metrics?.['securityGrade']).toBe('number');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("defaults the label to a timestamp when --label is omitted", async () => {
    const cwd = await makeTempCwd();
    try {
      await seedVault(cwd);
      const now = new Date('2026-05-27T14:33:08.000Z');
      const created = await runSnapshotCreate({ cwd, now });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      // The default label removes colons and the milliseconds for filesystem safety.
      expect(created.value.meta.label).toBe('2026-05-27T14-33-08Z');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns snapshot-exists when re-using an existing label', async () => {
    const cwd = await makeTempCwd();
    try {
      await seedVault(cwd);
      const first = await runSnapshotCreate({ cwd, label: 'dup' });
      expect(first.ok).toBe(true);
      const second = await runSnapshotCreate({ cwd, label: 'dup' });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.kind).toBe('snapshot-exists');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns manifest-missing when the vault has no manifest', async () => {
    const cwd = await makeTempCwd();
    try {
      // Only stage the `meta/` directory and config, no manifest.
      const vaultRoot = join(cwd, 'org-kb');
      const paths = vaultPaths(vaultRoot);
      await mkdir(paths.meta, { recursive: true });
      await writeFile(
        paths.config,
        JSON.stringify({ targetOrg: 't', vaultRoot, version: '0.1.0', createdAt: '2026-05-27T00:00:00.000Z' }),
        'utf8',
      );
      const result = await runSnapshotCreate({ cwd, label: 'no-manifest' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('manifest-missing');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('runSnapshotList', () => {
  it('returns an empty list when no snapshots exist', async () => {
    const cwd = await makeTempCwd();
    try {
      await seedVault(cwd);
      const listed = await runSnapshotList({ cwd });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('enumerates persisted snapshots sorted by label ASC', async () => {
    const cwd = await makeTempCwd();
    try {
      await seedVault(cwd);
      await runSnapshotCreate({ cwd, label: 'zebra' });
      await runSnapshotCreate({ cwd, label: 'apple' });
      await runSnapshotCreate({ cwd, label: 'mango' });
      const listed = await runSnapshotList({ cwd });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const labels = listed.value.map((s) => s.label);
      expect(labels).toEqual(['apple', 'mango', 'zebra']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('runSnapshotDelete', () => {
  it('removes the snapshot directory for a known label', async () => {
    const cwd = await makeTempCwd();
    try {
      const { vaultRoot } = await seedVault(cwd);
      await runSnapshotCreate({ cwd, label: 'delete-me' });
      const dir = snapshotPath(vaultRoot, 'delete-me');
      const beforeEntries = await readdir(dir);
      expect(beforeEntries.length).toBe(4);
      const deleted = await runSnapshotDelete({ cwd, label: 'delete-me' });
      expect(deleted.ok).toBe(true);
      // The directory must not exist after delete.
      const snapshotsDir = resolve(vaultRoot, 'snapshots');
      const remaining = await readdir(snapshotsDir);
      expect(remaining.includes('delete-me')).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns snapshot-missing for an unknown label', async () => {
    const cwd = await makeTempCwd();
    try {
      await seedVault(cwd);
      const deleted = await runSnapshotDelete({ cwd, label: 'does-not-exist' });
      expect(deleted.ok).toBe(false);
      if (deleted.ok) return;
      expect(deleted.error.kind).toBe('snapshot-missing');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * C-3 (finding 28) regression — `canonicalJson(undefined)` crash-class
 * sweep, snapshot.ts variant. CAUTION: this copy's hash feeds
 * `diff_snapshots`' "modified" verdict, so the fix must NOT change any
 * hash for the common (non-undefined) path.
 */
describe('canonicalJson — C-3 (finding 28) regression', () => {
  it('returns a string sentinel for undefined instead of the raw JS `undefined` value', () => {
    const result = canonicalJson(undefined);
    expect(typeof result).toBe('string');
    expect(result).toBe('\0undefined\0');
  });

  it('an object with an explicit undefined property value does not throw', () => {
    const withUndefined = { a: 1, b: undefined as unknown };
    expect(() => canonicalJson(withUndefined)).not.toThrow();
    expect(canonicalJson(withUndefined)).toContain('\0undefined\0');
  });

  it('HASH-PARITY: the common (non-undefined) path serializes byte-identically to the pre-fix algorithm', () => {
    // Reproduces the pre-fix algorithm inline (no `undefined` branch —
    // exactly what shipped before this fix) and confirms it agrees with
    // the exported `canonicalJson` for ordinary, real-world input that
    // never contains an explicit `undefined`. The two algorithms only
    // diverge on the `undefined` branch this fix adds, so agreement here
    // is proof the fix is byte-identical on the common path.
    const preFixCanonicalJson = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(preFixCanonicalJson).join(',')}]`;
      const record = value as Readonly<Record<string, unknown>>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${preFixCanonicalJson(record[k])}`).join(',')}}`;
    };
    const representativeHashInput = {
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      properties: { sharingModel: 'ReadWrite', nested: { a: 1, b: [1, 2, 'x'] } },
    };
    expect(canonicalJson(representativeHashInput)).toBe(
      preFixCanonicalJson(representativeHashInput),
    );
  });

  it('HASH-PARITY: captureSnapshotGraph produces the same propertiesHash as the pre-fix algorithm for a real (non-undefined) node', async () => {
    const cwd = await makeTempCwd();
    try {
      const vaultRoot = join(cwd, 'org-kb');
      const paths = vaultPaths(vaultRoot);
      for (const dir of [paths.meta, paths.graph]) {
        await mkdir(dir, { recursive: true });
      }
      const opened = await openGraph(paths.graphDb);
      if (!opened.ok) throw new Error(opened.error.message);
      try {
        const imported = await importExtractionResults(opened.value, [
          {
            nodes: [
              {
                id: 'CustomObject:Account',
                type: 'CustomObject',
                apiName: 'Account',
                label: 'Account',
                parentId: null,
                sourcePath: 'objects/Account/Account.object-meta.xml',
                lastModifiedDate: null,
                lastModifiedBy: null,
                apiVersion: null,
                properties: { sharingModel: 'ReadWrite' },
              },
            ],
            edges: [],
          },
        ]);
        if (!imported.ok) throw new Error(imported.error.message);

        const captured = await captureSnapshotGraph(opened.value);
        expect(captured.ok).toBe(true);
        if (!captured.ok) return;
        const node = captured.value.nodes.find((n) => n.id === 'CustomObject:Account');
        expect(node).toBeDefined();

        // Reconstruct the exact hashInput shape captureSnapshotGraph builds
        // for a node (type/apiName/label/properties — see the JSDoc above
        // captureSnapshotGraph) and hash it with the pre-fix algorithm.
        const preFixCanonicalJson = (value: unknown): string => {
          if (value === null || typeof value !== 'object') return JSON.stringify(value);
          if (Array.isArray(value)) return `[${value.map(preFixCanonicalJson).join(',')}]`;
          const record = value as Readonly<Record<string, unknown>>;
          const keys = Object.keys(record).sort();
          return `{${keys.map((k) => `${JSON.stringify(k)}:${preFixCanonicalJson(record[k])}`).join(',')}}`;
        };
        const expectedHash = createHash('sha256')
          .update(
            preFixCanonicalJson({
              type: 'CustomObject',
              apiName: 'Account',
              label: 'Account',
              properties: { sharingModel: 'ReadWrite' },
            }),
          )
          .digest('hex');
        expect(node?.propertiesHash).toBe(expectedHash);
      } finally {
        await closeGraph(opened.value);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
