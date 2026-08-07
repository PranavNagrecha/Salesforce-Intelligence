/**
 * AUDIT-F5 — deletion tombstones for components reconciled out of the vault
 * source tree. Confirmed-gone (reconcile deleted the file) is recorded; a
 * refused reconcile must NOT write tombstones (stale kept ≠ deleted).
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type TombstoneReason = 'reconciled-absent';

export interface TombstoneRecord {
  readonly componentPath: string;
  readonly deletedAt: string;
  readonly reason: TombstoneReason;
  readonly sourceOrg?: string;
  readonly refreshRefreshedAt?: string;
}

export const tombstonesPath = (vaultRoot: string): string =>
  join(vaultRoot, 'meta', 'tombstones.jsonl');

/** Append tombstones for paths deleted by a successful reconcile. */
export const appendTombstones = async (
  vaultRoot: string,
  deletedPaths: readonly string[],
  meta: {
    readonly deletedAt: string;
    readonly sourceOrg?: string;
    readonly refreshRefreshedAt?: string;
  },
): Promise<number> => {
  if (deletedPaths.length === 0) return 0;
  const path = tombstonesPath(vaultRoot);
  await mkdir(dirname(path), { recursive: true });
  const lines = deletedPaths.map((componentPath) =>
    JSON.stringify({
      componentPath,
      deletedAt: meta.deletedAt,
      reason: 'reconciled-absent' as const,
      ...(meta.sourceOrg !== undefined ? { sourceOrg: meta.sourceOrg } : {}),
      ...(meta.refreshRefreshedAt !== undefined
        ? { refreshRefreshedAt: meta.refreshRefreshedAt }
        : {}),
    }),
  );
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
  return deletedPaths.length;
};

/** Best-effort read of tombstone records (empty on missing/corrupt). */
export const readTombstones = async (
  vaultRoot: string,
  limit = 200,
): Promise<readonly TombstoneRecord[]> => {
  try {
    const text = await readFile(tombstonesPath(vaultRoot), 'utf8');
    const out: TombstoneRecord[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as TombstoneRecord;
        if (
          typeof row.componentPath === 'string' &&
          typeof row.deletedAt === 'string' &&
          row.reason === 'reconciled-absent'
        ) {
          out.push(row);
          if (out.length >= limit) break;
        }
      } catch {
        // skip corrupt lines
      }
    }
    return out;
  } catch {
    return [];
  }
};
