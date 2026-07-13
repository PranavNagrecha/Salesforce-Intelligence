/**
 * Snapshot persistence helpers for the v2.0c diff infrastructure.
 *
 * A snapshot is a structured capture of a single point-in-time vault
 * graph state. Each snapshot lives at `{vaultRoot}/snapshots/{label}/`
 * and contains four flat JSON files:
 *
 *   - `meta.json` — capture-time identity (label, createdAt,
 *     sourceTreeHash, componentCount, edgeCount).
 *   - `manifest.json` — verbatim copy of the vault's
 *     `meta/manifest.json` at capture time.
 *   - `nodes.json` — flat array of `SnapshotNode` rows (id, type,
 *     apiName, label, propertiesHash).
 *   - `edges.json` — flat array of `SnapshotEdge` rows (fromId, toId,
 *     edgeType, source, propertiesHash).
 *
 * The Markdown vault contents are NOT copied — diff use cases are
 * answered from the structured graph plus the manifest, and copying
 * the Markdown corpus would inflate snapshot size 10-100x for no
 * additional signal. The per-row `propertiesHash` field is what makes
 * the diff tool's "modified" check a single string comparison.
 *
 * This module owns the on-disk shape of a snapshot (load/save) but
 * NOT the graph extraction step (the CLI does that — it owns the
 * graph package dependency). Keeping graph access out of the vault
 * package keeps the dependency arrow `cli -> vault, graph` rather
 * than `vault -> graph` (which would create a cycle the day a graph
 * package needs vault helpers for path resolution).
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  ComponentId,
  ComponentType,
  EdgeType,
  VaultManifest,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import { snapshotPath, vaultPaths } from './layout.js';

/** JSON indentation, 2 spaces, mirrors the rest of the vault for diffability. */
const JSON_INDENT = 2;

/**
 * One snapshot node row. The `propertiesHash` is the sha256 of the
 * canonicalised JSON of the node's `properties` (sorted-key, recursive)
 * plus the structural metadata fields (type, apiName, label). Storing
 * the hash instead of the full property blob keeps `nodes.json` compact
 * and makes the diff tool's "modified" check a single string comparison.
 */
export interface SnapshotNode {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly label: string | null;
  readonly propertiesHash: string;
}

/**
 * One snapshot edge row. The `propertiesHash` covers the edge's
 * `properties` blob plus the structural fields (confidence). Same
 * rationale as the node hash — small file, single string compare for
 * "modified" detection.
 */
export interface SnapshotEdge {
  readonly fromId: ComponentId;
  readonly toId: ComponentId;
  readonly edgeType: EdgeType;
  readonly source: string;
  readonly propertiesHash: string;
}

/**
 * Capture-time identity persisted in `meta.json`. The label + createdAt
 * is what `snapshot list` displays; the counts make a delete decision
 * possible without re-reading the larger files.
 */
export interface SnapshotMeta {
  readonly label: string;
  readonly createdAt: string;
  readonly sourceTreeHash: string;
  readonly componentCount: number;
  readonly edgeCount: number;
  /**
   * Optional capture-time scalar bag (R8-SECURITY-TREND). Written at
   * `sfi snapshot create` / refresh auto-capture. Keys are metric names;
   * values are numbers (`securityScore` 0–100, `securityGrade` GPA 0–4).
   * Absent on pre-upgrade snapshots — trend discloses that honestly.
   */
  readonly metrics?: Readonly<Record<string, number>>;
}

/**
 * The in-memory shape of a snapshot. The CLI writes one of these to
 * disk per `create` invocation; the diff tool reads one of these per
 * `from`/`to` label (and constructs a transient one for `'current'`).
 */
export interface Snapshot {
  readonly meta: SnapshotMeta;
  readonly manifest: VaultManifest;
  readonly nodes: readonly SnapshotNode[];
  readonly edges: readonly SnapshotEdge[];
}

/**
 * Error variants surfaced by the snapshot persistence layer.
 *
 *   - `snapshot-exists`: caller asked to write a snapshot whose label
 *     already exists on disk.
 *   - `snapshot-missing`: caller asked to read or delete a snapshot
 *     whose label is not on disk.
 *   - `write-failed` / `read-failed`: I/O errors; `path` is the file
 *     that triggered the failure.
 */
export interface SnapshotIoError {
  readonly kind:
    | 'snapshot-exists'
    | 'snapshot-missing'
    | 'write-failed'
    | 'read-failed';
  readonly message: string;
  readonly path?: string;
}

/** Return `true` if `path` exists. */
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Persist a `Snapshot` to `{vaultRoot}/snapshots/{snapshot.meta.label}/`.
 * Refuses to overwrite an existing directory — caller deletes first or
 * picks a different label.
 *
 * @example
 *   const r = await saveSnapshot('/abs/org-kb', snapshot);
 *   if (!r.ok) console.error(r.error.message);
 */
export const saveSnapshot = async (
  vaultRoot: string,
  snapshot: Snapshot,
): Promise<Result<void, SnapshotIoError>> => {
  const dir = snapshotPath(vaultRoot, snapshot.meta.label);
  if (await pathExists(dir)) {
    return err({
      kind: 'snapshot-exists',
      message: `snapshot '${snapshot.meta.label}' already exists at ${dir}. Delete it first or pick a different label.`,
      path: dir,
    });
  }
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'write-failed', message: `mkdir snapshot dir: ${message}`, path: dir });
  }
  const writes: ReadonlyArray<readonly [string, unknown]> = [
    ['meta.json', snapshot.meta],
    ['manifest.json', snapshot.manifest],
    ['nodes.json', snapshot.nodes],
    ['edges.json', snapshot.edges],
  ];
  for (const [name, body] of writes) {
    const filePath = resolve(dir, name);
    try {
      await writeFile(filePath, `${JSON.stringify(body, null, JSON_INDENT)}\n`, 'utf8');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return err({ kind: 'write-failed', message: `write ${name}: ${message}`, path: filePath });
    }
  }
  return ok(undefined);
};

/**
 * Read a persisted `Snapshot` off disk.
 *
 * Each of the four JSON files is independently parsed so a
 * partially-written snapshot directory (e.g. `nodes.json` present but
 * `edges.json` missing) surfaces as a typed read failure rather than a
 * generic parse error.
 *
 * @example
 *   const r = await loadSnapshot('/abs/org-kb', 'weekly-2026-05-27');
 *   if (r.ok) console.log(r.value.meta.componentCount);
 */
export const loadSnapshot = async (
  vaultRoot: string,
  label: string,
): Promise<Result<Snapshot, SnapshotIoError>> => {
  const dir = snapshotPath(vaultRoot, label);
  if (!(await pathExists(dir))) {
    return err({
      kind: 'snapshot-missing',
      message: `snapshot '${label}' not found at ${dir}`,
      path: dir,
    });
  }
  const readJson = async (name: string): Promise<Result<unknown, SnapshotIoError>> => {
    const filePath = resolve(dir, name);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return err({ kind: 'read-failed', message: `read ${name}: ${message}`, path: filePath });
    }
    try {
      return ok(JSON.parse(raw));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return err({ kind: 'read-failed', message: `parse ${name}: ${message}`, path: filePath });
    }
  };
  const metaResult = await readJson('meta.json');
  if (!metaResult.ok) return metaResult;
  const manifestResult = await readJson('manifest.json');
  if (!manifestResult.ok) return manifestResult;
  const nodesResult = await readJson('nodes.json');
  if (!nodesResult.ok) return nodesResult;
  const edgesResult = await readJson('edges.json');
  if (!edgesResult.ok) return edgesResult;
  return ok({
    meta: metaResult.value as SnapshotMeta,
    manifest: manifestResult.value as VaultManifest,
    nodes: nodesResult.value as readonly SnapshotNode[],
    edges: edgesResult.value as readonly SnapshotEdge[],
  });
};

/**
 * Enumerate every snapshot directory under
 * `{vaultRoot}/snapshots/`, reading each `meta.json` and surfacing
 * the persisted identity. Skips entries that are not directories or
 * whose `meta.json` cannot be parsed — those are operator-visible
 * inconsistencies but not worth failing the whole list call over.
 *
 * Result is sorted by `label` ASC for stable diff-friendly output.
 * Returns an empty array if the snapshots directory does not exist.
 *
 * @example
 *   const r = await listSnapshots('/abs/org-kb');
 *   if (r.ok) for (const s of r.value) console.log(s.label, s.createdAt);
 */
export const listSnapshots = async (
  vaultRoot: string,
): Promise<Result<readonly SnapshotMeta[], SnapshotIoError>> => {
  const paths = vaultPaths(vaultRoot);
  if (!(await pathExists(paths.snapshots))) {
    return ok([]);
  }
  let entries;
  try {
    entries = await readdir(paths.snapshots, { withFileTypes: true });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'read-failed', message: `readdir snapshots: ${message}`, path: paths.snapshots });
  }
  const out: SnapshotMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = resolve(paths.snapshots, entry.name, 'meta.json');
    let raw: string;
    try {
      raw = await readFile(metaPath, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as SnapshotMeta;
      if (typeof parsed.label === 'string' && typeof parsed.createdAt === 'string') {
        out.push(parsed);
      }
    } catch {
      continue;
    }
  }
  out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return ok(out);
};

/**
 * Remove the snapshot directory at
 * `{vaultRoot}/snapshots/{label}/`. Returns `snapshot-missing` for an
 * unknown label so the caller can exit nonzero without confusing
 * "deleted successfully" with "label was never there".
 *
 * @example
 *   const r = await deleteSnapshot('/abs/org-kb', 'weekly-2026-05-27');
 */
export const deleteSnapshot = async (
  vaultRoot: string,
  label: string,
): Promise<Result<void, SnapshotIoError>> => {
  const dir = snapshotPath(vaultRoot, label);
  if (!(await pathExists(dir))) {
    return err({
      kind: 'snapshot-missing',
      message: `snapshot '${label}' not found at ${dir}`,
      path: dir,
    });
  }
  try {
    await rm(dir, { recursive: true, force: true });
    return ok(undefined);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'write-failed', message: `rm snapshot: ${message}`, path: dir });
  }
};
