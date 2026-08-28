/**
 * The `sfi snapshot` CLI subcommand and its three siblings:
 *
 *   - `sfi snapshot create [--label X]` captures a structured snapshot of
 *     the current vault graph + manifest under
 *     `{vaultRoot}/snapshots/{label}/`. The default label is the current
 *     ISO 8601 timestamp.
 *   - `sfi snapshot list` enumerates every directory under
 *     `{vaultRoot}/snapshots/` in sort order so an operator can pick a
 *     label for `diff_snapshots`.
 *   - `sfi snapshot delete <label>` removes one snapshot tree.
 *
 * Snapshot layout (defined in `@sf-intelligence/vault`'s `snapshot.ts`):
 * one directory per snapshot, four flat JSON files inside (`meta.json`,
 * `manifest.json`, `nodes.json`, `edges.json`). Markdown vault contents
 * are NOT copied — the structured graph plus the manifest is sufficient
 * for the v2.0c diff use cases.
 *
 * This module owns:
 *   - The graph-capture step (raw `SELECT *` over `store.connection`)
 *     including the per-row hash that makes the diff tool's "modified"
 *     check a single string comparison.
 *   - The transient-snapshot capture used by `sfi.diff_snapshots` when
 *     `toLabel === 'current'`.
 *   - The CLI plumbing (commander wiring, exit codes, output
 *     formatting).
 *
 * The on-disk shape (load/save) lives in `@sf-intelligence/vault`'s
 * snapshot module so the diff tool can consume snapshots without
 * pulling in the CLI package's graph dependency.
 */

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ComponentId, ComponentType, EdgeType } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';
import { captureSecurityPostureMetrics } from '@sf-intelligence/mcp';
import {
  backfillCoverageInMemory,
  deleteSnapshot,
  listSnapshots,
  loadManifest,
  saveSnapshot,
  vaultPaths,
  type Snapshot,
  type SnapshotEdge,
  type SnapshotMeta,
  type SnapshotNode,
} from '@sf-intelligence/vault';
import { Command } from 'commander';

/**
 * Error variants surfaced from the snapshot CLI commands. Wraps both
 * the vault `SnapshotIoError` shapes and the graph-side errors
 * (open/query failures) under a single union so the CLI's error
 * messaging path stays uniform.
 */
export interface SnapshotCommandError {
  readonly kind:
    | 'no-vault'
    | 'manifest-missing'
    | 'graph-open-failed'
    | 'graph-query-failed'
    | 'snapshot-exists'
    | 'snapshot-missing'
    | 'write-failed'
    | 'read-failed';
  readonly message: string;
  readonly path?: string;
}

/**
 * Stringify `value` with deterministic key ordering at every depth.
 *
 * Matches the graph layer's `canonicalJson` so the snapshot's per-row
 * hashes line up with the graph's stored `properties_json` column
 * character-for-character whenever both inputs are equivalent.
 *
 * C-3 (finding 28) — `canonicalJson(undefined)` crash-class sweep. This
 * copy was missing the explicit `undefined` branch from R6-12's fix in
 * `compare-vaults.ts`: a naive `typeof value !== 'object'` fall-through
 * calls `JSON.stringify(undefined)`, which returns the JS value `undefined`
 * (NOT a string) — `hashRecord` would then hash the literal characters
 * `undefined` via `String(undefined)` coercion inside `createHash().update`,
 * an inconsistent, easy-to-collide input. HASH-PARITY CAUTION: every
 * `hashRecord` call site in this file (`captureSnapshotGraph`) builds its
 * `hashInput` from `row.type`/`row.api_name`/`row.label`/`row.confidence`
 * (DB columns, never JS `undefined`) plus `parsePropertiesJson`'s output
 * (parsed JSON, which can produce `null` but never a bare `undefined`
 * value) — so no current caller can reach the new branch, and every
 * existing snapshot's hash is byte-for-byte unchanged. The branch exists
 * only to close the same landmine class as R6-12, matching its exact
 * sentinel semantics, should a future caller ever pass an explicit
 * `undefined`.
 *
 * Exported (only) so the C-3 regression test can exercise the `undefined`
 * branch directly, and independently confirm hash-parity for the common
 * (non-undefined) path via a golden-hash assertion against
 * `captureSnapshotGraph`.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === undefined) return '\0undefined\0';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`,
  );
  return `{${parts.join(',')}}`;
};

/** sha256 over a canonical JSON serialization. Hex digest, 64 chars. */
const hashRecord = (record: Readonly<Record<string, unknown>>): string =>
  createHash('sha256').update(canonicalJson(record)).digest('hex');

interface RawNodeRow {
  readonly id: string;
  readonly type: string;
  readonly api_name: string;
  readonly label: string | null;
  readonly properties_json: string;
}

interface RawEdgeRow {
  readonly from_id: string;
  readonly to_id: string;
  readonly edge_type: string;
  readonly confidence: string;
  readonly source: string;
  readonly properties_json: string;
}

const parsePropertiesJson = (raw: string | null | undefined): Readonly<Record<string, unknown>> => {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return {};
  }
};

const compareNodes = (a: SnapshotNode, b: SnapshotNode): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const compareEdges = (a: SnapshotEdge, b: SnapshotEdge): number => {
  if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
  if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

/**
 * Read every node and every edge out of the live graph store and
 * project them into the snapshot's compact row shape. Sorts both lists
 * deterministically so the on-disk byte stream is stable.
 *
 * Implementation notes:
 *   - `SELECT *` is intentional. Nodes and edges are an order of a few
 *     thousand rows in the canonical edu-org fixture; a single
 *     `runAndReadAll` over the indexed primary-key tables stays well
 *     under DuckDB's comfortable working set on developer laptops.
 *   - The structural fields included in each row's hash input
 *     (`apiName`, `label`, `type` for nodes; `confidence` for edges)
 *     are exactly the fields the diff tool's "modified" verdict cares
 *     about. A rename of `apiName` without any property change still
 *     surfaces as `modified`; a no-op refresh (same source tree) leaves
 *     every hash byte-identical.
 */
export const captureSnapshotGraph = async (
  store: GraphStore,
): Promise<Result<{ readonly nodes: readonly SnapshotNode[]; readonly edges: readonly SnapshotEdge[] }, SnapshotCommandError>> => {
  try {
    const nodeReader = await store.connection.runAndReadAll(
      'SELECT id, type, api_name, label, properties_json FROM nodes',
    );
    const rawNodes = nodeReader.getRowObjectsJS() as unknown as readonly RawNodeRow[];
    const nodes: SnapshotNode[] = rawNodes.map((row) => {
      const props = parsePropertiesJson(row.properties_json);
      // The hash input includes the structural fields the diff tool
      // cares about (type, apiName, label) alongside the properties
      // blob. A change to any of them flips the hash and lights up
      // `modified` in the v2.0c diff.
      const hashInput: Readonly<Record<string, unknown>> = {
        type: row.type,
        apiName: row.api_name,
        label: row.label,
        properties: props,
      };
      return {
        id: row.id as ComponentId,
        type: row.type as ComponentType,
        apiName: row.api_name,
        label: row.label,
        propertiesHash: hashRecord(hashInput),
      };
    });
    nodes.sort(compareNodes);

    const edgeReader = await store.connection.runAndReadAll(
      'SELECT from_id, to_id, edge_type, confidence, source, properties_json FROM edges',
    );
    const rawEdges = edgeReader.getRowObjectsJS() as unknown as readonly RawEdgeRow[];
    const edges: SnapshotEdge[] = rawEdges.map((row) => {
      const props = parsePropertiesJson(row.properties_json);
      const hashInput: Readonly<Record<string, unknown>> = {
        confidence: row.confidence,
        properties: props,
      };
      return {
        fromId: row.from_id as ComponentId,
        toId: row.to_id as ComponentId,
        edgeType: row.edge_type as EdgeType,
        source: row.source,
        propertiesHash: hashRecord(hashInput),
      };
    });
    edges.sort(compareEdges);

    return ok({ nodes, edges });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'graph-query-failed', message: `graph query failed: ${message}` });
  }
};

/** Generate an ISO-8601 default label with colons replaced for filesystem safety. */
const defaultLabel = (now: Date = new Date()): string =>
  now.toISOString().replace(/:/g, '-').replace(/\.\d+/, '');

/** Return `true` if `path` exists. Used to detect a missing vault before
 *  opening the graph store would surface a less actionable error. */
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Options accepted by `runSnapshotCreate`. */
export interface RunSnapshotCreateOptions {
  readonly cwd: string;
  readonly label?: string;
  /** Inject `now()` for deterministic test output. Defaults to `new Date()`. */
  readonly now?: Date;
}

/**
 * Capture a snapshot of the current vault state under
 * `{vaultRoot}/snapshots/{label}/`.
 *
 * The flow:
 *   1. Resolve `{cwd}/org-kb/` and ensure it has a manifest. No
 *      manifest -> `manifest-missing`. No `org-kb/meta/` -> `no-vault`.
 *   2. Open the graph DB.
 *   3. Capture nodes + edges via `captureSnapshotGraph`.
 *   4. Persist via `saveSnapshot` (atomic-enough — the snapshot
 *      directory is created up-front so a mid-flight failure leaves a
 *      partial directory the caller can simply re-attempt).
 *
 * `label` defaults to the current ISO timestamp with colons replaced
 * by hyphens (filesystem-safe). A duplicate label returns
 * `snapshot-exists` rather than overwriting.
 *
 * @example
 *   const r = await runSnapshotCreate({ cwd: process.cwd() });
 *   if (!r.ok) console.error(r.error.message);
 */
export const runSnapshotCreate = async (
  opts: RunSnapshotCreateOptions,
): Promise<Result<Snapshot, SnapshotCommandError>> => {
  const vaultRoot = resolve(opts.cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);

  if (!(await pathExists(paths.meta))) {
    return err({
      kind: 'no-vault',
      message: `vault not initialised at ${vaultRoot}. Run \`sfi init\` first.`,
      path: vaultRoot,
    });
  }

  const manifestResult = await loadManifest(vaultRoot);
  if (!manifestResult.ok) {
    return err({
      kind: 'manifest-missing',
      message: `manifest not found at ${paths.manifest}. Run \`sfi refresh\` first.`,
      path: paths.manifest,
    });
  }
  const manifest = manifestResult.value;

  const label = opts.label ?? defaultLabel(opts.now);

  const storeResult = await openGraph(paths.graphDb);
  if (!storeResult.ok) {
    return err({
      kind: 'graph-open-failed',
      message: `openGraph: ${storeResult.error.message}`,
      path: paths.graphDb,
    });
  }
  const store = storeResult.value;

  try {
    const captured = await captureSnapshotGraph(store);
    if (!captured.ok) return captured;
    const { nodes, edges } = captured.value;

    // R8-SECURITY-TREND: persist a graded securityScore at capture time.
    // Best-effort — a posture failure must not block the snapshot. Reuses the
    // already-open graph (do NOT shutdown this context).
    let metrics: Readonly<Record<string, number>> | undefined;
    try {
      metrics = await captureSecurityPostureMetrics({
        vaultRoot,
        // COVERAGE-ASYMMETRY-CLI-VS-MCP. `server.ts` builds every serving
        // Context as `backfillCoverageInMemory(manifestResult.value)`, so a
        // coverage-aware analysis reached over MCP sees derived coverage rows
        // that the same analysis reached from the CLI did not — the CLI path
        // read a strictly weaker manifest and could grade a family as "not
        // retrieved" that the server grades as retrieved. Only the ANALYSIS
        // context is backfilled: the `manifest` persisted into the snapshot
        // below stays the manifest as it was on disk, so snapshot-to-snapshot
        // diffs keep comparing stored facts rather than derived ones.
        manifest: backfillCoverageInMemory(manifest),
        graph: store,
      });
    } catch {
      metrics = undefined;
    }

    const meta: SnapshotMeta = {
      label,
      createdAt: (opts.now ?? new Date()).toISOString(),
      sourceTreeHash: manifest.sourceTreeHash,
      componentCount: nodes.length,
      edgeCount: edges.length,
      ...(metrics !== undefined ? { metrics } : {}),
    };

    const snapshot: Snapshot = { meta, manifest, nodes, edges };
    const saved = await saveSnapshot(vaultRoot, snapshot);
    if (!saved.ok) {
      // Map the vault's typed IO error onto this command's error union.
      return err({
        kind: saved.error.kind,
        message: saved.error.message,
        ...(saved.error.path !== undefined ? { path: saved.error.path } : {}),
      });
    }
    return ok(snapshot);
  } finally {
    await closeGraph(store);
  }
};

/** Options accepted by `runSnapshotList`. */
export interface RunSnapshotListOptions {
  readonly cwd: string;
}

/**
 * Enumerate every snapshot under `{cwd}/org-kb/snapshots/`, reading
 * each `meta.json` and surfacing the persisted identity. Sorts by
 * `label` ASC for stable diff-friendly output.
 *
 * @example
 *   const r = await runSnapshotList({ cwd: process.cwd() });
 *   if (r.ok) for (const s of r.value) console.log(s.label, s.createdAt);
 */
export const runSnapshotList = async (
  opts: RunSnapshotListOptions,
): Promise<Result<readonly SnapshotMeta[], SnapshotCommandError>> => {
  const vaultRoot = resolve(opts.cwd, 'org-kb');
  const result = await listSnapshots(vaultRoot);
  if (!result.ok) {
    return err({
      kind: result.error.kind,
      message: result.error.message,
      ...(result.error.path !== undefined ? { path: result.error.path } : {}),
    });
  }
  return ok(result.value);
};

/** Options accepted by `runSnapshotDelete`. */
export interface RunSnapshotDeleteOptions {
  readonly cwd: string;
  readonly label: string;
}

/**
 * Remove the snapshot directory at `{vaultRoot}/snapshots/{label}/`.
 * Returns `snapshot-missing` for an unknown label so the caller can
 * exit nonzero without confusing "deleted successfully" with "label
 * was never there".
 *
 * @example
 *   const r = await runSnapshotDelete({ cwd: process.cwd(), label: 'weekly-2026-05-27' });
 */
export const runSnapshotDelete = async (
  opts: RunSnapshotDeleteOptions,
): Promise<Result<void, SnapshotCommandError>> => {
  const vaultRoot = resolve(opts.cwd, 'org-kb');
  const result = await deleteSnapshot(vaultRoot, opts.label);
  if (!result.ok) {
    return err({
      kind: result.error.kind,
      message: result.error.message,
      ...(result.error.path !== undefined ? { path: result.error.path } : {}),
    });
  }
  return ok(undefined);
};

/**
 * Capture a transient snapshot of the current live graph without
 * writing it to disk. Used by `sfi.diff_snapshots` when `toLabel`
 * is `'current'` — the diff is computed against the live state but
 * no persisted artefact is produced.
 *
 * @example
 *   const r = await captureTransientSnapshot('/abs/org-kb');
 *   if (r.ok) console.log(r.value.nodes.length);
 */
export const captureTransientSnapshot = async (
  vaultRoot: string,
): Promise<Result<Snapshot, SnapshotCommandError>> => {
  const paths = vaultPaths(vaultRoot);
  const manifestResult = await loadManifest(vaultRoot);
  if (!manifestResult.ok) {
    return err({
      kind: 'manifest-missing',
      message: `manifest not found at ${paths.manifest}.`,
      path: paths.manifest,
    });
  }
  const manifest = manifestResult.value;
  const storeResult = await openGraph(paths.graphDb);
  if (!storeResult.ok) {
    return err({
      kind: 'graph-open-failed',
      message: `openGraph: ${storeResult.error.message}`,
      path: paths.graphDb,
    });
  }
  const store = storeResult.value;
  try {
    const captured = await captureSnapshotGraph(store);
    if (!captured.ok) return captured;
    const { nodes, edges } = captured.value;
    const meta: SnapshotMeta = {
      label: 'current',
      createdAt: new Date().toISOString(),
      sourceTreeHash: manifest.sourceTreeHash,
      componentCount: nodes.length,
      edgeCount: edges.length,
    };
    return ok({ meta, manifest, nodes, edges });
  } finally {
    await closeGraph(store);
  }
};

/**
 * Format a list of snapshots for the CLI's text output. One row per
 * snapshot, sorted by label ASC, with a header line.
 */
const formatSnapshotList = (items: readonly SnapshotMeta[]): string => {
  if (items.length === 0) return 'No snapshots.\n';
  const lines: string[] = ['label\tcreatedAt\tcomponents\tedges'];
  for (const item of items) {
    lines.push(`${item.label}\t${item.createdAt}\t${item.componentCount}\t${item.edgeCount}`);
  }
  return `${lines.join('\n')}\n`;
};

/** Commander flag shape for `sfi snapshot create`. */
interface CreateFlags {
  readonly label?: string;
}

/**
 * Register the `sfi snapshot` parent command (and its three
 * subcommands) on `program`. Exits 0 on success, 1 on any error.
 *
 * @example
 *   registerSnapshotCommand(new Command());
 */
export const registerSnapshotCommand = (program: Command): void => {
  const snapshot = program
    .command('snapshot')
    .description('Capture, list, and delete vault snapshots');

  snapshot
    .command('create')
    .description('Capture a snapshot of the current vault state')
    .option('--label <label>', 'Snapshot label (default: current ISO timestamp)')
    .action(async (flags: CreateFlags): Promise<void> => {
      const result = await runSnapshotCreate({
        cwd: process.cwd(),
        ...(flags.label !== undefined ? { label: flags.label } : {}),
      });
      if (!result.ok) {
        process.stderr.write(`sfi snapshot create: ${result.error.message}\n`);
        process.exit(1);
      }
      const { meta } = result.value;
      process.stdout.write(
        `Snapshot '${meta.label}' captured (${meta.componentCount} components, ${meta.edgeCount} edges).\n`,
      );
    });

  snapshot
    .command('list')
    .description('List every captured snapshot')
    .action(async (): Promise<void> => {
      const result = await runSnapshotList({ cwd: process.cwd() });
      if (!result.ok) {
        process.stderr.write(`sfi snapshot list: ${result.error.message}\n`);
        process.exit(1);
      }
      process.stdout.write(formatSnapshotList(result.value));
    });

  snapshot
    .command('delete <label>')
    .description('Delete a previously captured snapshot')
    .action(async (label: string): Promise<void> => {
      const result = await runSnapshotDelete({ cwd: process.cwd(), label });
      if (!result.ok) {
        process.stderr.write(`sfi snapshot delete: ${result.error.message}\n`);
        process.exit(1);
      }
      process.stdout.write(`Snapshot '${label}' deleted.\n`);
    });
};
