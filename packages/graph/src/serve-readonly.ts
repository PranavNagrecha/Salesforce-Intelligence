import { ok, type Result } from '@sf-intelligence/core';

import {
  CURRENT_SCHEMA_VERSION,
  needsMigration,
  readSchemaVersion,
} from './migrations.js';
import { listNodesByType } from './queries.js';
import {
  closeGraph,
  openGraph,
  openGraphReadOnly,
  type GraphError,
  type GraphStore,
} from './store.js';

/**
 * Open a vault for READ-ONLY serving with a best-effort, lock-tolerant
 * self-heal (CR-19 amended).
 *
 * This is the SINGLE source of truth for the read-only open ladder consumed by
 * BOTH the MCP server (`server.ts#openServerGraph`) and the cross-vault read
 * tools (`cross-vault-open.ts#openVaultReadOnly`). Those two were near-identical
 * hand-maintained copies of subtle lock-fallback logic — exactly the kind of
 * sibling divergence this codebase has been bitten by — so the semantics live
 * here once and both callers delegate.
 *
 * The ladder, in order:
 *
 *   1. Try a READ-ONLY open. A read-only handle takes a SHARED lock, so several
 *      readers (an IDE's `sfi mcp` server + a CI harness + a fleet dashboard)
 *      serve one vault at once.
 *   2. If read-only opens, run a cheap content probe AND a schema-version check:
 *        - probe ok && schema CURRENT  -> serve the read-only handle as-is.
 *        - probe ok && schema STALE    -> the vault needs an (additive)
 *          migration. Attempt a READ-WRITE re-open to migrate WITHOUT first
 *          dropping the read-only handle (a failed RW open leaves a separately
 *          held RO handle fully usable). On RW success, close RO and serve the
 *          migrated RW store. On RW failure that is a LOCK CONFLICT
 *          (`kind === 'locked'`), DEFER the migration: keep serving the still-
 *          open read-only handle un-migrated (the pre-CR-19 behavior) and emit a
 *          one-line stderr notice. On any OTHER RW failure (open-failed /
 *          schema-error — a genuinely broken upgrade, a poison step, a corrupt
 *          file), close RO and surface the RW error: a non-lock failure must NOT
 *          be masked by silently serving stale.
 *        - probe FAILS (content broken) -> the read-only handle cannot answer.
 *          Drop it and go read-write, which migrates a stale-but-readable file
 *          or hard-errors a corrupt one (a corrupt vault's RW open returns
 *          `open-failed`, NOT `locked`, so it correctly errors rather than
 *          falling back). The lock-only deferral applies SOLELY to the
 *          probe-passed + needs-migration branch.
 *   3. If the read-only open itself fails (no file yet, or a writer already
 *      holds the exclusive lock), fall through to the read-write path, which
 *      creates/migrates the file or surfaces the actionable `locked` error.
 *
 * SAFETY — why deferring the migration under lock is correct: a deferred
 * migration only ever serves the PRE-migration schema to read-only readers.
 * That is safe BECAUSE the migration ladder is additive-only (see the invariant
 * documented on {@link Migration} / {@link CURRENT_SCHEMA_VERSION}): an additive
 * migration adds a table/column no read-only tool requires, so an un-migrated
 * vault returns identical answers for the current ladder. The migration still
 * runs later, at the next exclusive open (a refresh, or any unlocked read where
 * the writer lock is free). A FUTURE breaking migration would invalidate this
 * deferral; the invariant on the Migration contract calls out the
 * `breaking: true` flag as the clean future-proofing (a known limitation today,
 * since no breaking migration exists).
 *
 * The REAL contender that makes the lock-only fallback necessary is NOT a
 * `sfi refresh` writer: an exclusive writer blocks even read-only opens, so such
 * a vault was never read-only-serveable and step 3 already surfaces its `locked`
 * error. The fallback exists for the case where THIS process (or a sibling
 * harness) holds the vault read-only while the self-heal's own read-write
 * re-open collides with that shared read-only hold — which is exactly what broke
 * the commit-gate router/coverage harnesses against the repo's stale org-kb.
 */
export const openGraphServeReadOnly = async (
  graphDb: string,
): Promise<Result<GraphStore, GraphError>> => {
  const ro = await openGraphReadOnly(graphDb);
  if (ro.ok) {
    const probe = await listNodesByType(ro.value, 'CustomObject', { limit: 1 });
    if (probe.ok) {
      // Probe passed: the only reason to leave read-only is schema drift, and an
      // additive migration is deferrable under lock contention.
      if (!(await needsMigration(ro.value.connection))) {
        return ok(ro.value);
      }
      // Stale-but-readable: attempt the RW migrate, but DO NOT drop the RO
      // handle first — a failed RW open leaves it fully usable to fall back to.
      const rw = await openGraph(graphDb);
      if (rw.ok) {
        await closeGraph(ro.value);
        return ok(rw.value);
      }
      if (rw.error.kind === 'locked') {
        // Lock-specific deferral: serve the still-open RO handle un-migrated.
        // The migration runs later at the next exclusive open.
        const stored = await readSchemaVersion(ro.value.connection);
        const fromVersion = stored.ok ? stored.value : 'unknown';
        process.stderr.write(
          `sf-intelligence: migration to schema v${CURRENT_SCHEMA_VERSION} deferred — ` +
            `vault at ${graphDb} is locked by another process; serving read-only on ` +
            `schema v${fromVersion} (migration will apply on the next exclusive open).\n`,
        );
        return ok(ro.value);
      }
      // Any NON-lock RW failure (open-failed / schema-error: corrupt file,
      // poison migration step, disk-full) is a real fault, not transient
      // contention. Do NOT mask it by serving stale — drop RO and surface it.
      await closeGraph(ro.value);
      return rw;
    }
    // Probe FAILED — the read-only handle is genuinely unqueryable (broken /
    // corrupt). Drop it and let the read-write path migrate-or-error. This is
    // the ONLY branch that proceeds to RW on a non-lock condition, and it
    // intentionally does NOT participate in the lock-only deferral above: a
    // corrupt vault's RW open returns `open-failed`, so it hard-errors.
    await closeGraph(ro.value);
    return openGraph(graphDb);
  }
  // No file yet, or a writer holds the exclusive lock — let the read-write path
  // create/migrate, or surface the actionable `locked` error.
  return openGraph(graphDb);
};
