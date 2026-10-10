import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { execHelper } from '@sf-intelligence/core';
import { closeGraph, listNodesByType, openGraph } from '@sf-intelligence/graph';
import { loadManifest, vaultPaths } from '@sf-intelligence/vault';
import { Command } from 'commander';

import { isAuthenticated, listAuthenticatedOrgs, type OrgListResult } from '../sf-org-list.js';
import { resolveVaultOption, VAULT_OPTION_HELP } from '../vault-option.js';

export interface QuickstartStep {
  readonly n: number;
  readonly status: 'done' | 'next' | 'todo';
  readonly title: string;
  readonly cmd: string | null;
  /** Honest per-step expectation (time / what's happening). */
  readonly expect: string;
}

export interface QuickstartReport {
  readonly steps: readonly QuickstartStep[];
  /** Real starter questions seeded from the user's OWN components (empty until refreshed). */
  readonly starterQuestions: readonly string[];
  /** True once the vault answers questions (the MCP wiring itself is not checked). */
  readonly ready: boolean;
  /** The vault this report is about (flag > SFI_VAULT > ./org-kb). */
  readonly vaultRoot: string;
  /** Set when an explicit --vault / SFI_VAULT names no vault. */
  readonly vaultError?: string;
}

export interface QuickstartProbes {
  /** True when `sf --version` runs (the Salesforce CLI is installed). */
  readonly sfInstalled: () => Promise<boolean>;
  /** The local sf login list (no org contacted). */
  readonly listOrgs: () => Promise<OrgListResult>;
}

export interface RunQuickstartOptions {
  readonly cwd: string;
  /** `--vault` — same meaning as every other command (flag > SFI_VAULT > ./org-kb). */
  readonly vault?: string;
  /** `SFI_VAULT`; passed in so tests do not depend on the process env. */
  readonly envVault?: string;
  /** Injection seam for tests; defaults to the real local `sf` probes. */
  readonly probes?: QuickstartProbes;
}

/**
 * `sf --version` gets its own, longer budget than the org-list read: a cold sf
 * start (plugin load, Windows antivirus) can take well over 5s, and a slow sf
 * is still an installed sf.
 */
const SF_VERSION_TIMEOUT_MS = 30_000;

/**
 * True unless `sf` is missing. Only a missing binary (ENOENT) or a non-timeout
 * failure reads as "not installed"; a timeout-kill means sf exists but is slow.
 */
export const probeSfInstalled = async (
  exec: (binary: string, args: readonly string[], opts: { timeout: number }) => Promise<unknown> = execHelper,
): Promise<boolean> => {
  try {
    await exec('sf', ['--version'], { timeout: SF_VERSION_TIMEOUT_MS });
    return true;
  } catch (cause) {
    const e = cause as { code?: unknown; killed?: unknown };
    return e.code !== 'ENOENT' && e.killed === true;
  }
};

const defaultProbes: QuickstartProbes = {
  sfInstalled: () => probeSfInstalled(),
  listOrgs: () => listAuthenticatedOrgs(),
};

/**
 * Rank for starter questions: the customer's own custom objects (`__c`) first,
 * then standard objects, then other custom kinds (platform events `__e`,
 * custom metadata `__mdt`, big/external objects), then managed-package names.
 */
export const ownershipRank = (apiName: string): number => {
  const parts = (apiName.split('.').pop() ?? apiName).split('__');
  if (parts.length === 1) return 1;
  if (parts.length === 2) return parts[1] === 'c' ? 0 : 2;
  return 3;
};
export const byOwnership = (a: string, b: string): number =>
  ownershipRank(a) - ownershipRank(b) || (a < b ? -1 : a > b ? 1 : 0);

/** A handful of strong first questions, seeded from real components (fields qualified as Object.Field). */
const seedQuestions = (objects: readonly string[], fields: readonly string[]): string[] => {
  const q: string[] = [];
  const obj = objects[0];
  const obj2 = objects[1] ?? objects[0];
  const field = fields[0];
  if (obj) q.push(`What fields are on ${obj}?`);
  if (field) q.push(`What breaks if I change ${field}?`);
  if (field) q.push(`Where is ${field} used?`);
  if (obj2) q.push(`What's the sharing model for ${obj2}?`);
  if (obj) q.push(`What runs when a new ${obj} record is saved?`);
  // Always-valid org-wide fallbacks so the list is never empty on a thin vault.
  q.push('What custom objects do we have?', 'Run a security audit of this org.');
  return q.slice(0, 5);
};

/**
 * Build the guided first-run path: where the user is now (sf CLI → authed org →
 * init → refresh → connect + ask), what's DONE, what's NEXT, with honest
 * per-step expectations, plus real starter questions once a vault exists.
 * Read-only.
 *
 * FR-07: a step is marked done only when it was CHECKED — `sf --version` for
 * the CLI, the local login list for auth — and the last step (wiring an MCP
 * client) is never marked done, because nothing here can see the client.
 */
export const runQuickstart = async (opts: RunQuickstartOptions): Promise<QuickstartReport> => {
  const probes = opts.probes ?? defaultProbes;
  const resolved = resolveVaultOption(opts.vault, { cwd: opts.cwd, env: opts.envVault });
  const vaultRoot = resolved.ok ? resolved.value.vaultRoot : resolve(opts.cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);

  let boundOrg: string | null = null;
  let initialized = false;
  try {
    const cfg = JSON.parse(await readFile(paths.config, 'utf8')) as { targetOrg?: unknown };
    initialized = true;
    boundOrg = typeof cfg.targetOrg === 'string' ? cfg.targetOrg : null;
  } catch {
    initialized = false;
  }

  const [sfOk, orgList] = await Promise.all([probes.sfInstalled(), probes.listOrgs()]);
  const authOk =
    orgList.ok && (boundOrg !== null ? isAuthenticated(orgList.orgs, boundOrg) : orgList.orgs.length > 0);

  const manifest = initialized ? await loadManifest(vaultRoot) : null;
  const refreshed = manifest?.ok === true;

  // Seed starter questions from the user's real components once the graph exists.
  let objects: string[] = [];
  let fields: string[] = [];
  let ready = false;
  if (refreshed) {
    const opened = await openGraph(paths.graphDb).catch(() => null);
    if (opened && opened.ok) {
      try {
        // Sort the WHOLE type before picking (FR-07: a limit-50 slice sorted
        // afterwards only reordered an arbitrary 50). Paged: the graph caps a
        // single read at 500 rows.
        const store = opened.value;
        const all = async (type: 'CustomObject' | 'CustomField'): Promise<{ id: string; apiName: string }[]> => {
          const out: { id: string; apiName: string }[] = [];
          for (let offset = 0; offset < 20_000; offset += 500) {
            const page = await listNodesByType(store, type, { limit: 500, offset });
            if (!page.ok) break;
            out.push(...page.value);
            if (page.value.length < 500) break;
          }
          return out;
        };
        objects = (await all('CustomObject')).map((n) => n.apiName).sort(byOwnership);
        fields = (await all('CustomField')).map((n) => n.id.replace(/^CustomField:/, '')).sort(byOwnership);
        ready = objects.length > 0 || fields.length > 0;
      } finally {
        await closeGraph(opened.value);
      }
    }
  }

  const org = boundOrg ?? '<alias>';
  const mcpCmd = `claude mcp add --transport stdio --scope project sf-intelligence -- npx -y sf-intelligence mcp --vault "${vaultRoot}"`;
  // `done` per step, in order; the FIRST not-done step is `next`, the rest `todo`.
  // Step 5 is never `done`: no probe here can see whether a client is wired.
  const done = [sfOk, authOk, initialized, refreshed, false];
  const nextIdx = done.findIndex((d) => !d);
  const statusFor = (i: number): QuickstartStep['status'] => (done[i] ? 'done' : i === nextIdx ? 'next' : 'todo');

  const meta: ReadonlyArray<Omit<QuickstartStep, 'n' | 'status'>> = [
    { title: 'Install the Salesforce CLI (sf)', cmd: 'npm install -g @salesforce/cli', expect: sfOk ? 'Found `sf` on PATH.' : '`sf --version` did not run — install it (Node 20+), or fix PATH.' },
    {
      title: 'Authenticate the org you want to read',
      cmd: `sf org login web --alias ${org}`,
      expect: !orgList.ok
        ? 'Could not read your sf logins (`sf org list`).'
        : boundOrg !== null
          ? authOk
            ? `\`${boundOrg}\` (this vault's org) is logged in.`
            : `\`${boundOrg}\` (this vault's org) is not among your sf logins.`
          : authOk
            ? `${orgList.orgs.length} org login(s) found.`
            : 'No sf logins found. Opens a browser; read-only — sf-intelligence never writes to the org.',
    },
    { title: 'Initialize the local vault', cmd: `sfi init --target-org ${org}`, expect: 'Seconds. Creates `org-kb/` locally; nothing leaves your machine.' },
    { title: 'Retrieve + build the vault', cmd: 'sfi refresh', expect: 'Minutes for a large org (sf retrieve + extract). `sfi refresh --types ...` scopes it; see the refresh preflight estimate.' },
    {
      title: 'Connect your MCP client, then ask',
      cmd: mcpCmd,
      expect: 'Claude Code shown; other clients (Claude Desktop, Cursor, VS Code, Codex): docs/guides/mcp-hosts.md. Not checked here — restart the client after adding it.',
    },
  ];
  const steps: QuickstartStep[] = meta.map((m, i) => ({ n: i + 1, status: statusFor(i), ...m }));

  return {
    steps,
    starterQuestions: ready ? seedQuestions(objects, fields) : [],
    ready,
    vaultRoot,
    ...(resolved.ok ? {} : { vaultError: resolved.error }),
  };
};

/** Render a `QuickstartReport` to a multi-line string for the CLI. */
export const formatQuickstart = (report: QuickstartReport): string => {
  const icon = (s: QuickstartStep['status']): string => (s === 'done' ? '✓' : s === 'next' ? '▸' : ' ');
  const lines = ['sf-intelligence — quickstart', `Vault: ${report.vaultRoot}`, ''];
  if (report.vaultError !== undefined) lines.push(`WARNING — ${report.vaultError}`, '');
  for (const step of report.steps) {
    lines.push(`  ${icon(step.status)} ${step.n}. ${step.title}${step.status === 'next' ? '   ← you are here' : ''}`);
    if (step.cmd) lines.push(`        $ ${step.cmd}`);
    lines.push(`        ${step.expect}`);
  }
  lines.push('');
  if (report.ready) {
    lines.push('Your vault is built. Once your MCP client is connected (step 5), strong first questions from YOUR org:');
    for (const q of report.starterQuestions) lines.push(`  • ${q}`);
  } else {
    lines.push('Follow the ▸ step above to reach your first answer.');
  }
  lines.push('');
  return lines.join('\n');
};

/** Register the `sfi quickstart` subcommand. */
export const registerQuickstartCommand = (program: Command): void => {
  program
    .command('quickstart')
    .description('Guided first-run path (install → auth → init → refresh → connect) with real starter questions')
    .option('--vault <path>', VAULT_OPTION_HELP)
    .action(async (flags: { readonly vault?: string }): Promise<void> => {
      const envVault = process.env['SFI_VAULT'];
      const report = await runQuickstart({
        cwd: process.cwd(),
        ...(flags.vault !== undefined ? { vault: flags.vault } : {}),
        ...(envVault !== undefined ? { envVault } : {}),
      });
      process.stdout.write(formatQuickstart(report));
    });
};
