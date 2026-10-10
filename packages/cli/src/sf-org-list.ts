/**
 * The ONE reader of the user's authenticated Salesforce orgs (FR-06).
 *
 * `sf org list --json` without `--skip-connection-status` checks the
 * connection to every non-scratch org — seconds of network traffic to every
 * org the user is logged into, just to read aliases. Every setup surface
 * (`sfi init`, setup-mode `sfi mcp`, the refresh auth preflight, quickstart)
 * needs only the local login list, so they all go through here: local read,
 * short timeout, never throws.
 */
import { execHelper } from '@sf-intelligence/core';

export interface AuthedOrg {
  readonly alias?: string;
  readonly username?: string;
  readonly isDefault: boolean;
}

export type OrgListResult =
  | { readonly ok: true; readonly orgs: readonly AuthedOrg[] }
  | { readonly ok: false; readonly reason: string };

/** Short by default: this is a local file read, and setup-mode startup must stay well under host startup limits. */
export const ORG_LIST_TIMEOUT_MS = (() => {
  const n = Number(process.env['SFI_SF_ORG_LIST_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5_000;
})();

const CATEGORIES = ['nonScratchOrgs', 'scratchOrgs', 'otherOrgs', 'devHubs', 'sandboxes'] as const;

/** Parse `sf org list --json` stdout into a de-duplicated org list. Exported for tests. */
export const parseOrgList = (stdout: string): readonly AuthedOrg[] => {
  const parsed = JSON.parse(stdout) as { result?: Record<string, unknown> };
  const result = parsed.result ?? {};
  const seen = new Set<string>();
  const out: AuthedOrg[] = [];
  for (const key of CATEGORIES) {
    const entries = result[key];
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Record<string, unknown>;
      const alias = typeof e['alias'] === 'string' && e['alias'].length > 0 ? e['alias'] : undefined;
      const username = typeof e['username'] === 'string' && e['username'].length > 0 ? e['username'] : undefined;
      const label = alias ?? username;
      if (label === undefined || seen.has(label)) continue;
      seen.add(label);
      out.push({
        ...(alias !== undefined ? { alias } : {}),
        ...(username !== undefined ? { username } : {}),
        isDefault: e['isDefaultUsername'] === true || e['isDefaultDevHubUsername'] === true,
      });
    }
  }
  return out;
};

export type RunSf = (args: readonly string[], timeoutMs: number) => Promise<{ readonly stdout: string }>;

const defaultRun: RunSf = (args, timeoutMs) => {
  // Never LONGER than the global sf exec budget when one is configured.
  const globalCap = Number(process.env['SFI_SF_EXEC_TIMEOUT_MS']);
  const timeout = Number.isFinite(globalCap) && globalCap > 0 ? Math.min(timeoutMs, globalCap) : timeoutMs;
  return execHelper('sf', args, { timeout, maxBuffer: 10 * 1024 * 1024 });
};

/** List authenticated orgs from the LOCAL sf login store — no org is contacted. Never throws. */
export const listAuthenticatedOrgs = async (
  opts: { readonly timeoutMs?: number; readonly run?: RunSf } = {},
): Promise<OrgListResult> => {
  const run = opts.run ?? defaultRun;
  try {
    const { stdout } = await run(['org', 'list', '--skip-connection-status', '--json'], opts.timeoutMs ?? ORG_LIST_TIMEOUT_MS);
    return { ok: true, orgs: parseOrgList(stdout) };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message.split('\n')[0] ?? cause.message : String(cause) };
  }
};

/** Display label (alias, else username) for each org. */
export const orgLabels = (orgs: readonly AuthedOrg[]): string[] =>
  orgs.map((o) => o.alias ?? o.username ?? '').filter((l) => l.length > 0);

/** True when `aliasOrUsername` names one of `orgs` (sf accepts either). */
export const isAuthenticated = (orgs: readonly AuthedOrg[], aliasOrUsername: string): boolean =>
  orgs.some((o) => o.alias === aliasOrUsername || o.username === aliasOrUsername);

/** The fixed remedy for an alias the local sf CLI does not know. */
export const loginRemedy = (alias: string): string =>
  `Check the alias with \`sf org list\`, or log in with \`sf org login web --alias ${alias}\`.`;
