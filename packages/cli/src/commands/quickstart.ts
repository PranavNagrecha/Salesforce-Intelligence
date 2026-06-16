import { resolve } from 'node:path';

import { closeGraph, listNodesByType, openGraph } from '@sf-intelligence/graph';
import { loadManifest, vaultPaths } from '@sf-intelligence/vault';
import { Command } from 'commander';

/** Default vault root, relative to CWD. Mirrors init/status/doctor. */
const DEFAULT_VAULT_ROOT = 'org-kb';

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
  /** True once the vault answers questions — the guided path is complete. */
  readonly ready: boolean;
}

export interface RunQuickstartOptions {
  readonly cwd: string;
}

/** A handful of strong first questions, seeded from real component api names. */
const seedQuestions = (objects: readonly string[], fields: readonly string[]): string[] => {
  const q: string[] = [];
  const obj = objects[0];
  const obj2 = objects[1] ?? objects[0];
  const field = fields[0];
  if (obj) q.push(`What fields are on ${obj}?`);
  if (field) q.push(`What breaks if I change ${field}?`);
  if (field) q.push(`Where is ${field} used?`);
  if (obj2) q.push(`What's the sharing model for ${obj2}?`);
  if (obj) q.push(`What runs when a ${obj} is created?`);
  // Always-valid org-wide fallbacks so the list is never empty on a thin vault.
  q.push('What custom objects do we have?', 'Run a security audit of this org.');
  return q.slice(0, 5);
};

/**
 * Build the guided first-run path: where the user is now (sf CLI → authed org →
 * init → refresh → ask), what's DONE, what's NEXT, with honest per-step
 * expectations, plus real starter questions once a vault exists. Read-only.
 */
export const runQuickstart = async (opts: RunQuickstartOptions): Promise<QuickstartReport> => {
  const vaultRoot = resolve(opts.cwd, DEFAULT_VAULT_ROOT);
  const paths = vaultPaths(vaultRoot);

  let initialized = false;
  try {
    const { stat } = await import('node:fs/promises');
    await stat(paths.config);
    initialized = true;
  } catch {
    initialized = false;
  }

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
        const objRes = await listNodesByType(opened.value, 'CustomObject', { limit: 50 });
        const fldRes = await listNodesByType(opened.value, 'CustomField', { limit: 50 });
        // Prefer the customer's OWN components (standard 0× `__`, custom 1×) over
        // managed-package ones (`ns__X__c`, 2+× `__`) so the starter questions
        // are about their org, not an installed package.
        const ownFirst = (a: string, b: string): number => (a.split('__').length - b.split('__').length) || (a < b ? -1 : 1);
        if (objRes.ok) objects = objRes.value.map((n) => n.apiName).sort(ownFirst);
        if (fldRes.ok) fields = fldRes.value.map((n) => n.apiName).sort(ownFirst);
        ready = objects.length > 0 || fields.length > 0;
      } finally {
        await closeGraph(opened.value);
      }
    }
  }

  // `done` per step, in order; the FIRST not-done step is `next`, the rest `todo`.
  const done = [true, initialized, initialized, refreshed, ready];
  const nextIdx = done.findIndex((d) => !d);
  const statusFor = (i: number): QuickstartStep['status'] => (done[i] ? 'done' : i === nextIdx ? 'next' : 'todo');

  const meta: ReadonlyArray<Omit<QuickstartStep, 'n' | 'status'>> = [
    { title: 'Install sf-intelligence + the Salesforce CLI', cmd: 'npx -y sf-intelligence --version', expect: 'Seconds. Needs Node 20+ and the `sf` CLI on PATH.' },
    { title: 'Authenticate the org you want to read', cmd: 'sf org login web --alias myorg', expect: 'Opens a browser; read-only — sf-intelligence never writes to the org.' },
    { title: 'Initialize the local vault', cmd: 'sfi init --target-org myorg', expect: 'Seconds. Creates `org-kb/` locally; nothing leaves your machine.' },
    { title: 'Retrieve + build the vault', cmd: 'sfi refresh', expect: 'Minutes for a large org (sf retrieve + extract). `sfi refresh --types ...` scopes it; see the refresh preflight estimate.' },
    { title: 'Ask your org anything', cmd: 'connect the MCP server in your client, then just ask', expect: 'Instant, offline, grounded in the metadata you retrieved.' },
  ];
  const steps: QuickstartStep[] = meta.map((m, i) => ({ n: i + 1, status: statusFor(i), ...m }));

  return { steps, starterQuestions: ready ? seedQuestions(objects, fields) : [], ready };
};

/** Render a `QuickstartReport` to a multi-line string for the CLI. */
export const formatQuickstart = (report: QuickstartReport): string => {
  const icon = (s: QuickstartStep['status']): string => (s === 'done' ? '✓' : s === 'next' ? '▸' : ' ');
  const lines = ['sf-intelligence — quickstart', ''];
  for (const step of report.steps) {
    lines.push(`  ${icon(step.status)} ${step.n}. ${step.title}${step.status === 'next' ? '   ← you are here' : ''}`);
    if (step.cmd) lines.push(`        $ ${step.cmd}`);
    lines.push(`        ${step.expect}`);
  }
  lines.push('');
  if (report.ready) {
    lines.push('Your vault is ready. Strong first questions, from YOUR org:');
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
    .description('Guided first-run path (install → auth → init → refresh → ask) with real starter questions')
    .action(async (): Promise<void> => {
      const report = await runQuickstart({ cwd: process.cwd() });
      process.stdout.write(formatQuickstart(report));
    });
};
