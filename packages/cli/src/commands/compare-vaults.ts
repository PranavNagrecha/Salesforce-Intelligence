/**
 * The `sfi compare-vaults` CLI subcommand (v3.1 R7).
 *
 * Produces a terminal-friendly structural diff between two registered
 * vaults. Mirrors the `sfi.compare_vaults` MCP tool's shape (PLAN-v3.1
 * §6 R7) — the CLI is a thin shim around the MCP handler:
 *
 *   1. Resolve the registry root (same fallback chain as
 *      `sfi register-vault` and `sfi list-vaults`).
 *   2. Resolve `vaultA` to an absolute path via the registry.
 *   3. Open vault A's manifest + graph as the MCP `Context`.
 *   4. Force the cross-vault tool's registry-root resolver to use the
 *      same root via `SF_INTELLIGENCE_REGISTRY_PATH`.
 *   5. Dispatch `sfi.compare_vaults` and render the resulting
 *      `CompareVaultsOutput` as a per-bucket table.
 *
 * The `boundaries[]` array carrying the volatile-property filter and
 * api-name-match correspondence disclosures is surfaced verbatim at the
 * top of the output so the operator sees the v3.1 honesty axes on the
 * same screen as the diff.
 */

import { err, ok, type Result } from '@sf-intelligence/core';
import {
  buildContext,
  dispatchTool,
  shutdown,
  type Context,
} from '@sf-intelligence/mcp';
import {
  resolveVault,
  type RegistryError,
} from '@sf-intelligence/vault';
import { Command } from 'commander';

import { resolveRegistryRoot } from './register-vault.js';

/** JSON indentation, 2 spaces, matches the rest of the CLI. */
const JSON_INDENT = 2;

/**
 * Error variants surfaced from the `sfi compare-vaults` CLI handler.
 * Wraps the registry-resolution failures plus the context-build
 * failures plus the MCP dispatch failures under a single union so the
 * handler's exit-code mapping stays uniform.
 */
export interface CompareVaultsCommandError {
  readonly kind:
    | 'alias-not-found'
    | 'registry-error'
    | 'vault-not-opened'
    | 'dispatch-failed';
  readonly message: string;
}

/** Options accepted by `runCompareVaults`. */
export interface RunCompareVaultsOptions {
  /** Co-resident registry root. Pre-resolved. */
  readonly rootDir: string;
  /** Vault A alias (the "before" side). */
  readonly vaultA: string;
  /** Vault B alias (the "after" side). */
  readonly vaultB: string;
  /** Optional CustomObject filter, e.g. 'Account'. */
  readonly object?: string;
  /** Optional ComponentType filter, e.g. 'Profile'. */
  readonly type?: string;
  /** When true, the volatile-property filter is disabled. */
  readonly includeVolatileProperties?: boolean;
}

/**
 * The structural-diff payload the MCP `sfi.compare_vaults` handler
 * returns. Mirrored here so the CLI does not need to import the MCP
 * tool module directly (which would couple the CLI's compile graph to
 * every cross-vault tool's internals). The shape matches
 * `CompareVaultsOutput` in `packages/mcp/src/tools/compare-vaults.ts`.
 */
export interface CompareVaultsCliPayload {
  readonly vaultA: { readonly alias: string };
  readonly vaultB: { readonly alias: string };
  readonly added: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly apiName: string;
  }>;
  readonly removed: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly apiName: string;
  }>;
  readonly shapeModified: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly apiName: string;
    readonly drift?: ReadonlyArray<{
      readonly propertyPath: string;
      readonly valueA: unknown;
      readonly valueB: unknown;
    }>;
  }>;
  readonly summary: {
    readonly addedCount: number;
    readonly removedCount: number;
    readonly shapeModifiedCount: number;
    readonly unchangedCount: number;
  };
  readonly boundaries: readonly string[];
}

/**
 * Parse the JSON envelope `dispatchTool` returns. Mirrors the helper
 * in the integration tests — each tool response lives in
 * `content[0].text` as a JSON-encoded `McpResponse | { error }`.
 */
const parseEnvelope = (
  content: ReadonlyArray<{ type: string; text?: string }>,
): { data: Record<string, unknown> } | { error: unknown } => {
  const first = content[0];
  if (
    first === undefined ||
    first.type !== 'text' ||
    typeof first.text !== 'string'
  ) {
    throw new Error(`unexpected content[0] shape: ${JSON.stringify(content)}`);
  }
  return JSON.parse(first.text) as
    | { data: Record<string, unknown> }
    | { error: unknown };
};

/**
 * Drive the `sfi.compare_vaults` MCP handler for the CLI. Resolves
 * vault A via the registry, builds an MCP `Context` against its
 * manifest + graph, forces the handler's registry-root resolver to use
 * the CLI's chosen root, and returns the parsed CompareVaultsOutput.
 *
 * The function does NOT print or render — that's `renderCompareVaults`'s
 * job. Splitting the two keeps `runCompareVaults` testable without
 * spawning a real terminal.
 *
 * @example
 *   const r = await runCompareVaults({
 *     rootDir: '/home/me/sf-intelligence-vaults',
 *     vaultA: 'acme-prod',
 *     vaultB: 'acme-sandbox',
 *   });
 *   if (r.ok) console.log(r.value.summary);
 */
export const runCompareVaults = async (
  opts: RunCompareVaultsOptions,
): Promise<Result<CompareVaultsCliPayload, CompareVaultsCommandError>> => {
  const pathAResult = await resolveVault(opts.rootDir, opts.vaultA);
  if (!pathAResult.ok) return err(mapRegistryError(pathAResult.error));

  // Force the cross-vault tool's registry resolver to use the same
  // root as the CLI. The handler falls back to the parent-of-vaultRoot
  // otherwise, which is the right default for MCP-server invocation
  // but not for `sfi compare-vaults --root <custom>`.
  const priorRegistryPath = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = opts.rootDir;

  let ctx: Context | null = null;
  try {
    const ctxResult = await buildContext(pathAResult.value);
    if (!ctxResult.ok) {
      return err({
        kind: 'vault-not-opened',
        message: `failed to open vault '${opts.vaultA}': ${ctxResult.error.message}`,
      });
    }
    ctx = ctxResult.value;

    const dispatched = await dispatchTool(ctx, 'sfi.compare_vaults', {
      vaultA: opts.vaultA,
      vaultB: opts.vaultB,
      ...(opts.object !== undefined ? { objectFilter: opts.object } : {}),
      ...(opts.type !== undefined ? { typeFilter: opts.type } : {}),
      ...(opts.includeVolatileProperties === true
        ? { includeVolatileProperties: true }
        : {}),
    });
    const envelope = parseEnvelope(dispatched.content);
    if ('error' in envelope) {
      return err({
        kind: 'dispatch-failed',
        message: `sfi.compare_vaults dispatch error: ${JSON.stringify(envelope.error)}`,
      });
    }
    return ok(envelope.data as unknown as CompareVaultsCliPayload);
  } finally {
    if (ctx !== null) await shutdown(ctx);
    if (priorRegistryPath === undefined) {
      delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    } else {
      process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = priorRegistryPath;
    }
  }
};

/**
 * Map a `RegistryError` to this command's error union. Used by
 * `runCompareVaults` after a `resolveVault` failure. The
 * `alias-not-found` and `registry-missing` cases are both surfaced as
 * `alias-not-found` because either way the user needs to call
 * `sfi register-vault` next.
 */
const mapRegistryError = (
  error: RegistryError,
): CompareVaultsCommandError => {
  if (
    error.kind === 'alias-not-found' ||
    error.kind === 'registry-missing'
  ) {
    return { kind: 'alias-not-found', message: error.message };
  }
  return { kind: 'registry-error', message: error.message };
};

/** Truncate a JSON-ish value to a short single-line string for table rendering. */
const renderValueShort = (value: unknown): string => {
  const s = JSON.stringify(value);
  const max = 40;
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
};

/**
 * Render a `CompareVaultsCliPayload` as a terminal-friendly multi-block
 * text output. Layout:
 *
 *   1. Summary line (added / removed / shape-modified / unchanged counts).
 *   2. Each `boundaries[]` entry verbatim (the v3.1 honesty disclosures).
 *   3. `Added` table (id, type, apiName).
 *   4. `Removed` table.
 *   5. `Shape modified` table with per-property drift indentation.
 *
 * Empty buckets collapse to a single-line "(none)" to keep the output
 * compact.
 */
export const renderCompareVaults = (
  payload: CompareVaultsCliPayload,
): string => {
  const lines: string[] = [];
  lines.push(
    `Compare '${payload.vaultA.alias}' vs '${payload.vaultB.alias}'`,
    '',
    'Summary',
    '-------',
    `Added:          ${payload.summary.addedCount}`,
    `Removed:        ${payload.summary.removedCount}`,
    `Shape modified: ${payload.summary.shapeModifiedCount}`,
    `Unchanged:      ${payload.summary.unchangedCount}`,
    '',
    'Boundaries',
    '----------',
  );
  if (payload.boundaries.length === 0) {
    lines.push('(none)');
  } else {
    for (const b of payload.boundaries) lines.push(`- ${b}`);
  }
  lines.push('', 'Added', '-----');
  if (payload.added.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of payload.added) {
      lines.push(`+ ${c.id}`);
    }
  }
  lines.push('', 'Removed', '-------');
  if (payload.removed.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of payload.removed) {
      lines.push(`- ${c.id}`);
    }
  }
  lines.push('', 'Shape modified', '--------------');
  if (payload.shapeModified.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of payload.shapeModified) {
      lines.push(`~ ${c.id}`);
      const drift = c.drift ?? [];
      for (const d of drift) {
        lines.push(
          `    ${d.propertyPath}: ${renderValueShort(d.valueA)} -> ${renderValueShort(d.valueB)}`,
        );
      }
    }
  }
  lines.push('');
  return lines.join('\n');
};

/** Commander flag shape for `sfi compare-vaults`. */
interface CompareVaultsCliFlags {
  readonly object?: string;
  readonly type?: string;
  readonly includeVolatileProperties?: boolean;
  readonly json?: boolean;
  readonly root?: string;
}

/**
 * Register the `sfi compare-vaults <vaultA> <vaultB>` subcommand on
 * `program`. Exits 0 on a successful diff (even when the diff is
 * empty); exits 1 on registry errors, dispatch failures, or vault open
 * failures. The handler also exits 0 on a vault-not-found refusal
 * payload (the structured envelope is the correct answer; the operator
 * sees the disclosure in `boundaries[]` and the empty diff in the
 * tables).
 *
 * @example
 *   registerCompareVaultsCommand(new Command());
 */
export const registerCompareVaultsCommand = (program: Command): void => {
  program
    .command('compare-vaults <vaultA> <vaultB>')
    .description(
      'Structural diff between two registered vaults (added / removed / shape-modified components)',
    )
    .option(
      '--object <apiName>',
      'Restrict the diff to one CustomObject and its parented graph',
    )
    .option(
      '--type <componentType>',
      'Restrict the diff to one ComponentType (e.g., Profile, CustomField)',
    )
    .option(
      '--include-volatile-properties',
      'Disable the v2.0c volatile-property noise filter (surface lastModifiedDate / lastModifiedBy drift)',
    )
    .option(
      '--json',
      'Print the raw CompareVaultsOutput as pretty-printed JSON instead of the table',
      false,
    )
    .option(
      '--root <path>',
      'Co-resident registry root (default: $SF_INTELLIGENCE_REGISTRY_PATH or ~/sf-intelligence-vaults)',
    )
    .action(
      async (
        vaultA: string,
        vaultB: string,
        flags: CompareVaultsCliFlags,
      ): Promise<void> => {
        const rootDir = resolveRegistryRoot({
          ...(flags.root !== undefined ? { root: flags.root } : {}),
        });
        const opts: RunCompareVaultsOptions = {
          rootDir,
          vaultA,
          vaultB,
          ...(flags.object !== undefined ? { object: flags.object } : {}),
          ...(flags.type !== undefined ? { type: flags.type } : {}),
          ...(flags.includeVolatileProperties === true
            ? { includeVolatileProperties: true }
            : {}),
        };
        const result = await runCompareVaults(opts);
        if (!result.ok) {
          process.stderr.write(
            `sfi compare-vaults: ${result.error.message}\n`,
          );
          process.exit(1);
        }
        if (flags.json === true) {
          process.stdout.write(
            `${JSON.stringify(result.value, null, JSON_INDENT)}\n`,
          );
          return;
        }
        process.stdout.write(renderCompareVaults(result.value));
      },
    );
};
