import { resolve } from 'node:path';

import { buildContext, dispatchTool, shutdown, type Context } from '@sf-intelligence/mcp';
import { Command } from 'commander';

/** Default vault root, relative to CWD. Mirrors init/status/doctor/quickstart. */
const DEFAULT_VAULT_ROOT = 'org-kb';

export interface SelftestProbe {
  /** The question TYPE this proves the vault answers. */
  readonly questionType: string;
  readonly tool: string;
  readonly ok: boolean;
  /** Why it was skipped (no suitable component in the vault), or null. */
  readonly skipped: string | null;
}

export interface SelftestReport {
  readonly probes: readonly SelftestProbe[];
  readonly passed: number;
  readonly ran: number;
  /** True when the vault could be opened at all. */
  readonly vaultOpen: boolean;
  readonly note: string;
}

/** Parse the `dispatchTool` JSON envelope (mirrors compare-vaults). */
const envelope = (
  content: ReadonlyArray<{ type: string; text?: string }>,
): { data?: Record<string, unknown>; error?: unknown } => {
  const first = content[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') return { error: 'bad-shape' };
  try {
    return JSON.parse(first.text) as { data?: Record<string, unknown>; error?: unknown };
  } catch {
    return { error: 'unparseable' };
  }
};

/** Call a tool and return its parsed data, or null on any error. */
const call = async (ctx: Context, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
  try {
    const dispatched = await dispatchTool(ctx, tool, args);
    const env = envelope(dispatched.content);
    return env.error !== undefined || env.data === undefined ? null : env.data;
  } catch {
    return null;
  }
};

/** First component id of a type, or null. */
const firstId = async (ctx: Context, type: string): Promise<string | null> => {
  const data = await call(ctx, 'sfi.list_components', { type, limit: 1 });
  const list = (data?.['components'] ?? data?.['items'] ?? data?.['results'] ?? []) as Array<{ id?: string; componentId?: string }>;
  return list[0]?.id ?? list[0]?.componentId ?? null;
};

/**
 * Run a handful of REAL queries against the freshly built vault and report which
 * question types it actually answers — a confidence signal beyond "refresh
 * complete". Includes a §C3 usage probe (`find_component_usages`) so it proves
 * usage answers work, not just schema listing. Read-only.
 */
export const runSelftest = async (opts: { cwd: string }): Promise<SelftestReport> => {
  const vaultRoot = resolve(opts.cwd, DEFAULT_VAULT_ROOT);
  const ctxResult = await buildContext(vaultRoot);
  if (!ctxResult.ok) {
    return {
      probes: [],
      passed: 0,
      ran: 0,
      vaultOpen: false,
      note: `Could not open a vault at ${vaultRoot}. Run \`sfi init\` then \`sfi refresh\` first.`,
    };
  }
  const ctx = ctxResult.value;
  const probes: SelftestProbe[] = [];
  try {
    const objectId = await firstId(ctx, 'CustomObject');
    const fieldId = await firstId(ctx, 'CustomField');
    const apexId = await firstId(ctx, 'ApexClass');

    const add = async (questionType: string, tool: string, args: Record<string, unknown> | null) => {
      if (args === null) {
        probes.push({ questionType, tool, ok: false, skipped: 'no suitable component in this vault' });
        return;
      }
      const data = await call(ctx, tool, args);
      probes.push({ questionType, tool, ok: data !== null, skipped: null });
    };

    await add('What\'s in this org? (schema)', 'sfi.list_components', { type: 'CustomObject', limit: 5 });
    await add('Is the vault complete? (coverage)', 'sfi.coverage_report', {});
    await add('Org at a glance (overview)', 'sfi.org_overview', {});
    await add('Everything about a field (deep-dive)', 'sfi.field_360', fieldId ? { fieldId } : null);
    await add('What breaks if I change X? (impact)', 'sfi.get_impact', objectId ? { componentId: objectId, hops: 1 } : null);
    // §C3: prove usage answers work, not just listing.
    await add('Where is X used? (usage)', 'sfi.find_component_usages', (apexId ?? fieldId) ? { componentId: apexId ?? fieldId } : null);
  } finally {
    await shutdown(ctx);
  }

  const ran = probes.filter((p) => p.skipped === null).length;
  const passed = probes.filter((p) => p.ok).length;
  return {
    probes,
    passed,
    ran,
    vaultOpen: true,
    note: `Your vault answers ${passed} of ${probes.length} question types.`,
  };
};

/** Render a `SelftestReport` for the CLI. */
export const formatSelftest = (report: SelftestReport): string => {
  const lines = ['sf-intelligence — selftest', ''];
  if (!report.vaultOpen) {
    lines.push(`  ✗ ${report.note}`, '');
    return lines.join('\n');
  }
  for (const p of report.probes) {
    const mark = p.ok ? '✓' : p.skipped ? '–' : '✗';
    lines.push(`  ${mark} ${p.questionType}${p.skipped ? `  (skipped: ${p.skipped})` : ''}`);
  }
  lines.push('', `  ${report.note}`, '');
  return lines.join('\n');
};

/**
 * Exit code for a selftest run. A vault that cannot OPEN is as much a failure
 * as a vault that answers nothing — exiting 0 there made `sfi selftest` a
 * false success in CI on a missing/corrupt vault.
 */
export const selftestExitCode = (report: SelftestReport): 0 | 1 =>
  !report.vaultOpen || report.passed === 0 ? 1 : 0;

/** Register the `sfi selftest` subcommand. */
export const registerSelftestCommand = (program: Command): void => {
  program
    .command('selftest')
    .description('Run real queries against the built vault and report which question types it answers')
    .action(async (): Promise<void> => {
      const report = await runSelftest({ cwd: process.cwd() });
      process.stdout.write(formatSelftest(report));
      if (selftestExitCode(report) !== 0) process.exit(1);
    });
};
