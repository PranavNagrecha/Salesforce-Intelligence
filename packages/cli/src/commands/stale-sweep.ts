/**
 * `sfi stale-sweep` (P13-WATCH-sweep) — ONE drift tick against the live org,
 * persisted as `meta/staleness.json` so consumers (the P13 watch daemon and
 * the trust `orgDrift` badges) can answer "has the org moved since the vault
 * was built?" without re-querying.
 *
 * Two strategies, fastest first:
 *   1. SourceMember fast-path — on source-tracked orgs (sandboxes), ONE
 *      Tooling query groups every change since the vault's `refreshedAt` by
 *      member type (`method: 'source-member'`; covers ALL types).
 *   2. Per-type fallback — the canonical `checkVaultStaleness` sweep over the
 *      widened {@link STALE_CHECK_TYPES} roster (now including Profile /
 *      PermissionSet / PermissionSetGroup / SharingRules / FlexiPage /
 *      RecordType — the permission-drift hole). Types the org's Tooling API
 *      rejects land in `erroredTypes` honestly.
 *
 * READ-ONLY against the org (Tooling SELECTs via the sf CLI). A drifted org
 * is a normal answer, not an error — the command exits 0 either way and the
 * JSON it writes is the contract.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  checkVaultStaleness,
  runSfJson,
  STALE_CHECK_TYPES,
} from '@sf-intelligence/mcp';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { loadManifest, vaultPaths } from '@sf-intelligence/vault';
import type { Command } from 'commander';

/** The persisted `meta/staleness.json` shape (the watch family's contract). */
export interface StalenessSnapshot {
  readonly generatedAt: string;
  /** The vault refresh this sweep measured drift AGAINST. */
  readonly vaultRefreshedAt: string;
  readonly method: 'source-member' | 'per-type';
  readonly vaultStale: boolean;
  readonly driftCount: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly checkedTypes: readonly string[];
  readonly erroredTypes: readonly string[];
}

const SOURCE_MEMBER_TYPE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Run one sweep tick. Returns the snapshot it wrote (or an error string).
 * `exec` is injectable for mocked-tick tests; `now` for deterministic stamps.
 */
export const runStaleSweep = async (options: {
  readonly cwd: string;
  readonly targetOrg?: string;
  readonly exec?: ExecCommand;
  readonly now?: string;
}): Promise<{ readonly ok: true; readonly snapshot: StalenessSnapshot } | { readonly ok: false; readonly message: string }> => {
  const paths = vaultPaths(join(options.cwd, 'org-kb'));
  const manifestResult = await loadManifest(join(options.cwd, 'org-kb'));
  if (!manifestResult.ok) {
    return { ok: false, message: `vault manifest unavailable: ${manifestResult.error.message} — run sfi init / refresh first` };
  }
  const manifest = manifestResult.value;
  const org = options.targetOrg ?? manifest.sourceOrg;
  const refreshedAt = manifest.refreshedAt;
  const sinceLiteral = refreshedAt.replace(/\.\d+Z$/, 'Z');
  const generatedAt = options.now ?? new Date().toISOString();

  let snapshot: StalenessSnapshot | null = null;

  // 1. SourceMember fast-path (source-tracked orgs only).
  const sm = await runSfJson(
    org,
    [
      'data',
      'query',
      '--query',
      `SELECT MemberType, COUNT(Id) cnt FROM SourceMember WHERE LastModifiedDate > ${sinceLiteral} GROUP BY MemberType`,
      '--use-tooling-api',
    ],
    ...(options.exec !== undefined ? [options.exec] : []),
  );
  if (sm.ok) {
    const records =
      (sm.value as { result?: { records?: readonly Record<string, unknown>[] } }).result
        ?.records ?? [];
    const byType: Record<string, number> = {};
    let driftCount = 0;
    for (const row of records) {
      const type = row['MemberType'];
      const cnt = Number(row['cnt'] ?? row['expr0'] ?? 0);
      if (typeof type !== 'string' || !SOURCE_MEMBER_TYPE_RE.test(type) || !Number.isFinite(cnt)) continue;
      byType[type] = cnt;
      driftCount += cnt;
    }
    snapshot = {
      generatedAt,
      vaultRefreshedAt: refreshedAt,
      method: 'source-member',
      vaultStale: driftCount > 0,
      driftCount,
      byType,
      checkedTypes: ['*all (SourceMember tracking)'],
      erroredTypes: [],
    };
  }

  // 2. Per-type fallback (production orgs without source tracking).
  if (snapshot === null) {
    const result = await checkVaultStaleness(
      org,
      refreshedAt,
      ...(options.exec !== undefined ? [options.exec] : []),
    );
    if (!result.ok) {
      return { ok: false, message: result.error.message };
    }
    snapshot = {
      generatedAt,
      vaultRefreshedAt: refreshedAt,
      method: 'per-type',
      vaultStale: result.value.vaultStale,
      driftCount: result.value.driftCount,
      byType: result.value.byType,
      checkedTypes: result.value.checkedTypes,
      erroredTypes: result.value.erroredTypes,
    };
  }

  await writeFile(
    join(paths.meta, 'staleness.json'),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );
  return { ok: true, snapshot };
};

export const registerStaleSweepCommand = (program: Command): void => {
  program
    .command('stale-sweep')
    .description(
      `One org-drift tick: counts components modified in the org since the vault's refresh (SourceMember fast-path on tracked orgs; per-type Tooling sweep over ${STALE_CHECK_TYPES.length} types otherwise, incl. Profile/PermissionSet — the permission-drift surface) and writes meta/staleness.json for the watch/trust surfaces. Read-only; a drifted org is an answer, not an error.`,
    )
    .option('--target-org <alias>', 'Salesforce org alias (overrides the vault config)')
    .action(async (flags: { readonly targetOrg?: string }) => {
      const result = await runStaleSweep({
        cwd: process.cwd(),
        ...(flags.targetOrg !== undefined ? { targetOrg: flags.targetOrg } : {}),
      });
      if (!result.ok) {
        process.stderr.write(`stale-sweep failed: ${result.message}\n`);
        process.exit(1);
      }
      const s = result.snapshot;
      process.stdout.write(
        `${s.vaultStale ? 'DRIFTED' : 'clean'} — ${s.driftCount} component(s) modified in the org since ${s.vaultRefreshedAt} (${s.method}${s.erroredTypes.length > 0 ? `; unqueryable: ${s.erroredTypes.join(', ')}` : ''}). Wrote meta/staleness.json.\n`,
      );
    });
};
