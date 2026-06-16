/**
 * Shared graph-open helper for the cross-vault READ tools (`compare_vaults`,
 * `compare_object_across_vaults`, `compare_profile_across_vaults`, and
 * `promotion_readiness` via the first).
 *
 * P7-cross-org-diff: these tools only READ, so they open the OTHER vault
 * READ-ONLY — a shared DuckDB lock that coexists with a serving `sfi mcp`
 * server (P5/P7). The previous read-WRITE open (`openGraph`) took the exclusive
 * writer lock and so FAILED to compare a vault that was being served (or under
 * a concurrent refresh). Mirrors `server.ts#openServerGraph`: open read-only,
 * probe it, and fall back to a read-write open only when the read-only handle
 * can't answer (a missing file or a stale schema that needs migrating) — which
 * also surfaces the actionable `locked` error if a refresh holds the writer.
 *
 * When `path` is the server's OWN vault, it reuses `ctx.graph` (already the
 * server's read-only handle) instead of opening a second one.
 */

import type { McpError } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  closeGraph,
  listNodesByType,
  openGraph,
  openGraphReadOnly,
  type GraphStore,
} from '@sf-intelligence/graph';
import { vaultPaths } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

/** A graph handle plus the matching disposer (a no-op when it is `ctx.graph`). */
export interface OpenedVault {
  readonly store: GraphStore;
  readonly dispose: () => Promise<void>;
}

export const openVaultReadOnly = async (
  ctx: Context,
  path: string,
): Promise<Result<OpenedVault, McpError>> => {
  if (path === ctx.vaultRoot) {
    return ok({ store: ctx.graph, dispose: async () => undefined });
  }
  const { graphDb } = vaultPaths(path);

  const ro = await openGraphReadOnly(graphDb);
  if (ro.ok) {
    const probe = await listNodesByType(ro.value, 'CustomObject', { limit: 1 });
    if (probe.ok) {
      const store = ro.value;
      return ok({ store, dispose: async () => closeGraph(store) });
    }
    // Opened read-only but unqueryable — a stale schema needing migration.
    // Drop the read-only handle and let the read-write path migrate it.
    await closeGraph(ro.value);
  }

  // No file yet, a stale schema, or a lock conflict — the read-write path
  // creates/migrates, or surfaces the actionable `locked` error.
  const rw = await openGraph(graphDb);
  if (!rw.ok) {
    return err({
      kind: 'internal',
      message: `failed to open graph for vault at ${path}: ${rw.error.message}`,
    });
  }
  const store = rw.value;
  return ok({ store, dispose: async () => closeGraph(store) });
};
