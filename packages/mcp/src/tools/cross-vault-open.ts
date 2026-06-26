/**
 * Shared graph-open helper for the cross-vault READ tools (`compare_vaults`,
 * `compare_object_across_vaults`, `compare_profile_across_vaults`, and
 * `promotion_readiness` via the first).
 *
 * P7-cross-org-diff: these tools only READ, so they open the OTHER vault
 * READ-ONLY — a shared DuckDB lock that coexists with a serving `sfi mcp`
 * server (P5/P7). The previous read-WRITE open (`openGraph`) took the exclusive
 * writer lock and so FAILED to compare a vault that was being served (or under
 * a concurrent refresh).
 *
 * The read-only open ladder (probe, CR-19 schema-version self-heal, and the
 * CR-19-amended best-effort lock-tolerant fallback that DEFERS an additive
 * migration when the read-write re-open hits a held lock) is shared with
 * `server.ts#openServerGraph` via the single {@link openGraphServeReadOnly}
 * helper in the graph package — so these two near-identical open paths cannot
 * drift apart. See that helper for the full rationale and additive-only safety
 * argument.
 *
 * When `path` is the server's OWN vault, it reuses `ctx.graph` (already the
 * server's read-only handle) instead of opening a second one.
 */

import type { McpError } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  closeGraph,
  openGraphServeReadOnly,
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

  const opened = await openGraphServeReadOnly(graphDb);
  if (!opened.ok) {
    return err({
      kind: 'internal',
      message: `failed to open graph for vault at ${path}: ${opened.error.message}`,
    });
  }
  const store = opened.value;
  return ok({ store, dispose: async () => closeGraph(store) });
};
