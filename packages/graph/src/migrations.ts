import type { DuckDBConnection } from '@duckdb/node-api';
import { err, ok, type Result } from '@sf-intelligence/core';

import { initSchema } from './schema.js';
import type { GraphError } from './store.js';

/**
 * The schema version this build expects a vault to be at. Bump this by ONE
 * each time you append a {@link Migration} to {@link MIGRATIONS}: a vault
 * stored below this value gets the intervening migrations applied in order on
 * the next read-write open; a vault at this value is a no-op.
 *
 * v1 is the baseline — the v0.1 nodes/edges/facts schema (plus the CR-19
 * `schema_version` ledger itself), with no transform beyond stamping the
 * version on a previously-unversioned vault.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * One ordered, forward-only migration step. `run` performs the DDL/DML to move
 * the vault from `version - 1` to `version`; it executes inside the
 * BEGIN/COMMIT that {@link runMigrations} opens, so it must NOT manage its own
 * transaction. A throw aborts the whole batch and rolls back.
 *
 * INVARIANT — migrations MUST be ADDITIVE: a step may CREATE a new table/column
 * or add an index, but must NOT DROP, rename, or retype a column or table that
 * any read-only tool queries (nodes/edges/facts and their columns). This is a
 * hard contract, not a style preference, because the read-only OPEN paths
 * (the MCP server and the cross-vault read tools, via
 * `serve-readonly.ts#openGraphServeReadOnly`) may DEFER a migration and keep
 * serving the PRE-migration schema when the vault is held under a lock by
 * another process. An additive migration is safe to defer — un-migrated readers
 * still see every column they need and return identical answers — but a
 * BREAKING migration served un-migrated would feed readers a schema the new
 * code does not expect (or vice-versa).
 *
 * A breaking migration therefore requires a DIFFERENT strategy than the
 * deferral, e.g. a per-`Migration` `breaking: true` flag that disables the
 * read-only defer fallback and forces an exclusive open before serving. That
 * flag is intentionally NOT implemented today (no breaking migration exists);
 * its ABSENCE is the known limitation — adding a breaking step without it would
 * be unsafe. Add the flag (and gate the fallback on it) before ever appending a
 * destructive step.
 */
export interface Migration {
  /** The version this step UPGRADES TO (1-based, contiguous, ascending). */
  readonly version: number;
  readonly run: (db: DuckDBConnection) => Promise<unknown>;
}

/**
 * The ordered migration ladder. Append new steps to the END with the next
 * integer `version` and bump {@link CURRENT_SCHEMA_VERSION} to match. Each step
 * runs exactly once per vault, in version order, only when the stored version
 * is below it.
 *
 * v1 is intentionally a no-op transform: the base schema is created
 * idempotently by `initSchema` (it owns the `CREATE ... IF NOT EXISTS`
 * statements), so the only effect of "migrating to v1" on a pre-versioning
 * vault is stamping `schema_version = 1`. This is a real, exercised migration —
 * it proves the version-detect / apply / stamp / rollback machinery end to end
 * — without altering any existing row, so it is lossless by construction.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    run: async () => {
      // No structural change beyond `initSchema` (run before this) and the
      // version stamp (run after). Real step, zero data transform.
    },
  },
];

/**
 * Read the integer schema version stored in the vault, or `0` when the
 * `schema_version` table is absent (a pre-versioning vault built before CR-19)
 * or empty. Errors other than "table missing" surface as `schema-error`.
 *
 * @example
 *   const r = await readSchemaVersion(connection);
 *   if (r.ok && r.value < CURRENT_SCHEMA_VERSION) { ...needs migration... }
 */
export const readSchemaVersion = async (
  db: DuckDBConnection,
): Promise<Result<number, GraphError>> => {
  try {
    const reader = await db.runAndReadAll(
      'SELECT version FROM schema_version WHERE id = 1',
    );
    const rows = reader.getRowObjectsJS() as ReadonlyArray<{
      version?: unknown;
    }>;
    // No row at all (empty ledger) is a pre-versioning vault, same as a missing
    // table — read as v0 and let the migration ladder upgrade it.
    if (rows.length === 0) return ok(0);
    const raw = rows[0]?.version;
    // A PRESENT row whose `version` is not a valid non-negative integer is an
    // anomaly (a corrupt or foreign-built ledger), NOT a v0 vault. DuckDB's
    // INTEGER column yields a number/bigint; anything else (a non-numeric
    // string, null, a float, a negative) must surface a typed error rather than
    // silently coercing to 0/NaN — `Number('garbage')` was reading as v0 and
    // would have re-migrated a corrupt vault. Only the empty-ledger and
    // missing-table cases above legitimately mean v0.
    const parsed = typeof raw === 'bigint' ? Number(raw) : raw;
    if (
      typeof parsed !== 'number' ||
      !Number.isInteger(parsed) ||
      parsed < 0
    ) {
      return err({
        kind: 'schema-error',
        message: `readSchemaVersion: malformed schema_version row (version = ${JSON.stringify(raw)})`,
      });
    }
    return ok(parsed);
  } catch (e) {
    // A missing table reads as a pre-versioning vault (version 0), not an
    // error: that is exactly the case the migration ladder exists to upgrade.
    const message = (e as Error).message.toLowerCase();
    if (message.includes('schema_version') || message.includes('does not exist')) {
      return ok(0);
    }
    return err({
      kind: 'schema-error',
      message: `readSchemaVersion failed: ${(e as Error).message}`,
    });
  }
};

/**
 * Detect whether the vault at this open connection is below
 * {@link CURRENT_SCHEMA_VERSION} and therefore needs a read-write migration.
 * Used by read-only open paths (the MCP server, cross-vault compares) to decide
 * whether to drop the read-only handle and re-open read-write so migrations can
 * run. A read error is treated as "needs migration" (fail safe: prefer the
 * read-write path, which surfaces a typed error, over serving a stale schema).
 *
 * @example
 *   if (await needsMigration(ro.connection)) { ...re-open read-write... }
 */
export const needsMigration = async (
  db: DuckDBConnection,
): Promise<boolean> => {
  const r = await readSchemaVersion(db);
  return !r.ok || r.value < CURRENT_SCHEMA_VERSION;
};

/** Upsert the single `schema_version` row to `version`. */
const stampVersion = async (
  db: DuckDBConnection,
  version: number,
): Promise<void> => {
  // INSERT OR REPLACE keeps the one row (id = 1) idempotent under re-stamp.
  await db.run(
    'INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)',
    [version],
  );
};

/**
 * Bring an open read-write DuckDB connection up to {@link CURRENT_SCHEMA_VERSION}.
 *
 * Steps:
 *   1. `initSchema` creates the base tables (incl. `schema_version`)
 *      idempotently — a fresh vault gets the full schema, an existing one is
 *      untouched.
 *   2. Read the stored version (0 for a pre-CR-19 vault).
 *   3. Apply every migration whose `version` is greater than the stored
 *      version, in ascending order, inside one BEGIN/COMMIT. Any failure
 *      ROLLs BACK the whole batch and returns a typed `schema-error` — the
 *      vault is left exactly as it was (never half-migrated).
 *   4. Stamp the new version (still inside the transaction) and COMMIT.
 *
 * A vault already at CURRENT does no work beyond `initSchema` and one version
 * read — no transaction is opened. Re-running is therefore a safe no-op
 * (idempotent).
 *
 * `migrations` is injectable for testing (a poison step to prove rollback);
 * production callers use the default ladder.
 *
 * @example
 *   const result = await runMigrations(connection);
 *   if (!result.ok) { console.error(result.error.message); return; }
 */
export const runMigrations = async (
  db: DuckDBConnection,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<Result<void, GraphError>> => {
  // 1. Base schema (idempotent). Owns the schema_version table creation.
  const schemaResult = await initSchema(db);
  if (!schemaResult.ok) return schemaResult;

  // 2. Current stored version.
  const versionResult = await readSchemaVersion(db);
  if (!versionResult.ok) return versionResult;
  const stored = versionResult.value;

  // 3. Steps strictly newer than the stored version, in ascending order.
  const target = migrations.reduce(
    (max, m) => Math.max(max, m.version),
    CURRENT_SCHEMA_VERSION,
  );
  const pending = migrations
    .filter((m) => m.version > stored)
    .slice()
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0 && stored >= target) {
    // Already current — no transaction, no work.
    return ok(undefined);
  }

  try {
    await db.run('BEGIN TRANSACTION;');
  } catch (e) {
    return err({
      kind: 'schema-error',
      message: `runMigrations: failed to begin transaction: ${(e as Error).message}`,
    });
  }

  try {
    for (const step of pending) {
      await step.run(db);
    }
    await stampVersion(db, target);
    await db.run('COMMIT;');
    return ok(undefined);
  } catch (e) {
    try {
      await db.run('ROLLBACK;');
    } catch {
      // Swallow; the original migration error is what the caller needs.
    }
    return err({
      kind: 'schema-error',
      message: `runMigrations: migration failed and rolled back (vault left at version ${stored}): ${(e as Error).message}`,
    });
  }
};
