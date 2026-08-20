/**
 * Vault persistence for the platform's `PermissionDependency` graph —
 * "user permission X requires permission Y", captured at refresh time from
 * the Tooling API.
 *
 * This is ORG-VARIABLE data, which is why it lives in the vault rather
 * than in a curated model file: the edge set depends on the org's edition
 * and which features are enabled, so two orgs legitimately disagree about
 * it and a hard-coded table would be wrong for somebody. The vault is the
 * org-grounded plane; this belongs here, beside `baseline.json` and
 * `annotations.jsonl`, as a non-graph JSON artifact under `meta/`.
 *
 * **Absent is not empty.** {@link loadPermissionDependencies} returns
 * `ok(null)` when the file does not exist and `ok(file)` — possibly with
 * zero edges — when it does. Every vault refreshed before this feature
 * shipped has NO file, and a consumer that treats that as "this org has no
 * permission dependencies" would silently understate effective access,
 * which is exactly the bug this artifact exists to fix. The two states are
 * kept distinguishable at the type level so a caller must handle them
 * separately.
 *
 * The persisted `truncated` flag is equally load-bearing: the un-paged read
 * of this object is capped by the server, so a captured graph can
 * legitimately be incomplete. Any closure computed from a truncated capture
 * is a LOWER BOUND and must be disclosed as partial.
 *
 * `edgeCount` and `rawRowsReceived` are kept as SEPARATE fields on purpose.
 * The Tooling API re-serves its cursor on this object — a real capture
 * measured ~5 raw records per distinct edge — so a single "rows" number
 * would be read as an edge count by somebody and be about 5x wrong.
 * `edgeCount` is the headline; `rawRowsReceived` is a wire diagnostic.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';

import { vaultPaths } from './layout.js';

/**
 * One persisted dependency edge: `permission` requires
 * `requiredPermission`. Names are VERBATIM from the platform, including
 * the object-level angle-bracket encoding (`Account<create>`); the vault
 * stores what the org said and leaves interpretation to the reader.
 */
export interface PermissionDependencyRecord {
  readonly permission: string;
  readonly permissionType: string;
  readonly requiredPermission: string;
  readonly requiredPermissionType: string;
}

/** Persisted artifact at `{vaultRoot}/meta/permission-dependencies.json`. */
export interface PermissionDependencyFile {
  readonly version: 1;
  /** ISO 8601 capture time — the artifact can outlive the refresh that wrote it. */
  readonly capturedAt: string;
  /** Provenance string, fixed for this producer. */
  readonly source: 'tooling-api:PermissionDependency';
  /**
   * DISTINCT dependency edges captured — equals `edges.length`. The honest
   * headline count, and the only number here that means "how much of the
   * graph we have".
   */
  readonly edgeCount: number;
  /**
   * RAW records the wire returned, INCLUDING the server's duplicate
   * re-serves (measured at roughly 5x the edge count on a real org). A WIRE
   * DIAGNOSTIC only — never an edge count, never shown as one.
   */
  readonly rawRowsReceived: number;
  /**
   * TRUE when the capture is NOT the whole graph (server row ceiling, page
   * budget, or a mid-walk stop). A consumer MUST mark any closure computed
   * from this as partial.
   */
  readonly truncated: boolean;
  /** Present only when `truncated` — why, verbatim, for disclosure. */
  readonly truncationReason?: string;
  /** Sorted by `permission` then `requiredPermission` (stable across refreshes). */
  readonly edges: readonly PermissionDependencyRecord[];
}

/** I/O failure shape, mirroring `BaselineError`. */
export interface PermissionDependencyIoError {
  readonly kind: 'parse-error' | 'write-failed';
  readonly message: string;
  readonly path?: string;
}

/** Where the artifact lives inside a vault. */
export const permissionDependenciesPath = (vaultRoot: string): string =>
  vaultPaths(vaultRoot).permissionDependencies;

/** Structural validation — a shape we cannot trust is a parse error, not a default. */
const isValidFile = (parsed: Partial<PermissionDependencyFile>): boolean =>
  parsed?.version === 1 &&
  typeof parsed.capturedAt === 'string' &&
  typeof parsed.truncated === 'boolean' &&
  typeof parsed.edgeCount === 'number' &&
  Array.isArray(parsed.edges);

/**
 * Read the persisted dependency graph.
 *
 * Returns `ok(null)` when the artifact is ABSENT — a vault refreshed
 * before this feature, or one refreshed without `--with-tooling-api`. That
 * is NOT the same as `ok({ edges: [] })`, which means "we asked the org and
 * it genuinely reported no dependencies". Callers must disclose the
 * absent case rather than silently expanding nothing.
 *
 * A malformed or unreadable-but-present file is an `err`, never a silent
 * fallback to "no dependencies" — a corrupt artifact must not read as a
 * clean answer.
 *
 * @example
 *   const loaded = await loadPermissionDependencies(vaultRoot);
 *   if (loaded.ok && loaded.value === null) {
 *     // disclose: dependency expansion unavailable, grants are DECLARED only
 *   }
 */
export const loadPermissionDependencies = async (
  vaultRoot: string,
): Promise<Result<PermissionDependencyFile | null, PermissionDependencyIoError>> => {
  const path = permissionDependenciesPath(vaultRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return ok(null);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'parse-error', message, path });
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PermissionDependencyFile>;
    if (!isValidFile(parsed)) {
      return err({
        kind: 'parse-error',
        message: 'invalid permission-dependencies shape',
        path,
      });
    }
    return ok(parsed as PermissionDependencyFile);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'parse-error', message, path });
  }
};

/**
 * Persist the dependency graph atomically (tmp file + rename), the same
 * write discipline `saveBaseline` uses so a crashed refresh cannot leave a
 * half-written artifact that would then fail to parse.
 */
export const savePermissionDependencies = async (
  vaultRoot: string,
  file: PermissionDependencyFile,
): Promise<Result<void, PermissionDependencyIoError>> => {
  const path = permissionDependenciesPath(vaultRoot);
  const dir = dirname(path);
  const tmp = `${path}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    const body = `${JSON.stringify(file, null, 2)}\n`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
    return ok(undefined);
  } catch (cause) {
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'write-failed', message, path });
  }
};
