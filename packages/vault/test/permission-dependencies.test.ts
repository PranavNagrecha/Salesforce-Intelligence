import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { vaultPaths } from '../src/layout.js';
import {
  loadPermissionDependencies,
  permissionDependenciesPath,
  savePermissionDependencies,
  type PermissionDependencyFile,
} from '../src/permission-dependencies.js';

const file = (
  overrides: Partial<PermissionDependencyFile> = {},
): PermissionDependencyFile => ({
  version: 1,
  capturedAt: '2026-08-20T00:00:00.000Z',
  source: 'tooling-api:PermissionDependency',
  edgeCount: 2,
  rawRowsReceived: 10,
  truncated: false,
  edges: [
    {
      permission: 'EmailMass',
      permissionType: 'User',
      requiredPermission: 'EmailSingle',
      requiredPermissionType: 'User',
    },
    {
      permission: 'ExportReport',
      permissionType: 'User',
      requiredPermission: 'RunReports',
      requiredPermissionType: 'User',
    },
  ],
  ...overrides,
});

describe('permission-dependency vault artifact', () => {
  it('lives at meta/permission-dependencies.json and is on the VaultLayout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-permdep-'));
    try {
      expect(permissionDependenciesPath(root)).toBe(
        join(root, 'meta', 'permission-dependencies.json'),
      );
      expect(vaultPaths(root).permissionDependencies).toBe(permissionDependenciesPath(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The load-bearing distinction: a vault refreshed before this feature has NO
  // artifact. Returning an empty edge list there would read as "this org has no
  // permission dependencies" and silently understate every effective-access
  // answer — exactly the bug the artifact exists to fix.
  it('returns null (NOT an empty graph) when the artifact is ABSENT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-permdep-'));
    try {
      const loaded = await loadPermissionDependencies(root);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('distinguishes a genuine EMPTY capture from an absent one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-permdep-'));
    try {
      const saved = await savePermissionDependencies(
        root,
        file({ edges: [], edgeCount: 0, rawRowsReceived: 0 }),
      );
      expect(saved.ok).toBe(true);
      const loaded = await loadPermissionDependencies(root);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value).not.toBeNull();
      expect(loaded.value?.edges).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('round-trips the edge list and the truncation disclosure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-permdep-'));
    try {
      const written = file({
        truncated: true,
        truncationReason: 'un-paged query returned 10000 rows, at or above the ceiling',
        edgeCount: 2,
        rawRowsReceived: 10_000,
      });
      const saved = await savePermissionDependencies(root, written);
      expect(saved.ok).toBe(true);
      const loaded = await loadPermissionDependencies(root);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || loaded.value === null) return;
      expect(loaded.value.edges).toEqual(written.edges);
      expect(loaded.value.truncated).toBe(true);
      expect(loaded.value.truncationReason).toContain('10000 rows');
      expect(loaded.value.capturedAt).toBe('2026-08-20T00:00:00.000Z');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('overwrites a prior capture in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-permdep-'));
    try {
      await savePermissionDependencies(root, file());
      await savePermissionDependencies(
        root,
        file({ capturedAt: '2026-08-21T00:00:00.000Z', edges: [], edgeCount: 0 }),
      );
      const loaded = await loadPermissionDependencies(root);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || loaded.value === null) return;
      expect(loaded.value.capturedAt).toBe('2026-08-21T00:00:00.000Z');
      expect(loaded.value.edges).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Raw wire count and distinct edge count are separate FIELDS on purpose:
  // this object's cursor re-serves, so raw runs ~5x the edges it carries and
  // a single "rows" number would be read as an edge count and be 5x wrong.
  it('keeps the DISTINCT edge count and the raw wire count as separate fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-permdep-'));
    try {
      await savePermissionDependencies(root, file({ edgeCount: 2, rawRowsReceived: 10 }));
      const loaded = await loadPermissionDependencies(root);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || loaded.value === null) return;
      expect(loaded.value.edgeCount).toBe(loaded.value.edges.length);
      expect(loaded.value.rawRowsReceived).toBe(10);
      expect(loaded.value.rawRowsReceived).not.toBe(loaded.value.edgeCount);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A corrupt artifact must not read as a clean "no dependencies" answer.
  it('errors on a malformed artifact instead of degrading to an empty graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-permdep-'));
    try {
      await savePermissionDependencies(root, file());
      await writeFile(permissionDependenciesPath(root), '{ not json', 'utf8');
      const loaded = await loadPermissionDependencies(root);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.error.kind).toBe('parse-error');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('errors on a well-formed JSON file of the WRONG shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-permdep-'));
    try {
      await savePermissionDependencies(root, file());
      await writeFile(
        permissionDependenciesPath(root),
        JSON.stringify({ version: 2, edges: 'nope' }),
        'utf8',
      );
      const loaded = await loadPermissionDependencies(root);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.error.message).toContain('invalid permission-dependencies shape');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
