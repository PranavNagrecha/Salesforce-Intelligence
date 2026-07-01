/**
 * Catalog gateway (P13-GW-meta-tools) — three meta-tools that make the
 * 160+-tool roster navigable for an LLM client without advertising every
 * input schema up front (163 schemas ≈ tens of thousands of tokens in
 * clients that do not defer tool definitions):
 *
 *   - `sfi.list_analyses`     — name + one-liner + coarse category, paginated;
 *   - `sfi.describe_analysis` — ONE tool's full description + input schema,
 *                               fetched on demand;
 *   - `sfi.run_analysis`      — THIN dispatcher into the existing handler
 *                               table. No analysis logic moves; only its
 *                               schema stops being advertised.
 *
 * BYTE-IDENTITY CONTRACT: `run_analysis` returns the target tool's response
 * envelope VERBATIM — identical payloads, budgets, and trust blocks to a
 * direct call (its dispatch case in index.ts returns `dispatchTool`'s result
 * without re-wrapping; the qa parity sweep asserts equality for every roster
 * tool). Known client quirk handled defensively: `args` is accepted as an
 * object OR a JSON-encoded string.
 *
 * The roster/dispatch references are imported LAZILY at call time to avoid a
 * module cycle with tools/index.ts (which imports the two plain handlers
 * here).
 */

import type { McpError, McpResponse, PageInfo } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** Coarse, name-derived category — a navigation aid, not a taxonomy. */
export const analysisCategory = (name: string): string => {
  const bare = name.replace(/^sfi\./, '');
  if (bare.startsWith('live_')) return 'live';
  if (bare.startsWith('what_if_')) return 'what-if';
  if (bare.startsWith('generate_')) return 'documentation';
  if (bare.startsWith('find_') || bare.startsWith('search_')) return 'search';
  if (bare.startsWith('compare_') || bare.startsWith('fleet_') || bare === 'promotion_readiness')
    return 'cross-org';
  if (bare.startsWith('cpq_') || bare.startsWith('omni') || bare.startsWith('decision_table') || bare.startsWith('integration_procedure') || bare.startsWith('datatransform'))
    return 'industries';
  return 'core';
};

/** First sentence of a tool description — the list view's one-liner. */
export const oneLiner = (description: string): string => {
  const idx = description.indexOf('. ');
  const head = idx === -1 ? description : description.slice(0, idx + 1);
  return head.length > 220 ? `${head.slice(0, 217)}…` : head;
};

export const listAnalysesInputSchema = z.object({
  category: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: opaque token from a prior truncated page's
  // nextCursor; supplies the resume offset. Omit for today's behavior.
  cursor: z.string().min(1).optional(),
});

export type ListAnalysesInput = z.infer<typeof listAnalysesInputSchema>;

export interface AnalysisListEntry {
  readonly name: string;
  readonly oneLiner: string;
  readonly category: string;
}

export interface ListAnalysesOutput {
  readonly analyses: readonly AnalysisListEntry[];
  readonly total: number;
  readonly offset: number;
  readonly categories: readonly string[];
  readonly next: string;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more entries remain past `limit`). Echo it back as `cursor` to resume.
   * Absent on a complete page so an in-budget response is byte-identical to the
   * pre-CR-22 shape.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

/** Lazy roster access (cycle-safe): tools/index.ts owns `V01_TOOLS`. */
const loadRoster = async (): Promise<
  ReadonlyArray<{ readonly name: string; readonly description: string; readonly inputSchema: unknown }>
> => {
  const mod = await import('./index.js');
  return mod.V01_TOOLS;
};

/** The `sfi.list_analyses` MCP tool — paginated roster catalog. */
export const listAnalysesHandler = async (
  ctx: Context,
  input: ListAnalysesInput,
): Promise<Result<McpResponse<ListAnalysesOutput>, McpError>> => {
  const roster = await loadRoster();
  const all = roster.map((t) => ({
    name: t.name,
    oneLiner: oneLiner(t.description),
    category: analysisCategory(t.name),
  }));
  const categories = [...new Set(all.map((a) => a.category))].sort((a, b) => a.localeCompare(b));
  const filtered =
    input.category === undefined ? all : all.filter((a) => a.category === input.category);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset);
  // a stale/forged cursor (changed `category`, different tool, or refreshed
  // vault) is rejected with invalid-query. The roster is a STABLE declared
  // array (`V01_TOOLS`) with unique tool names, so the slice order is already a
  // total order keyed by array position (unique `name` tiebreak) and offset
  // resume neither dups nor skips.
  const fingerprint = argsFingerprint({
    ...(input.category !== undefined ? { category: input.category } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.list_analyses',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;

  // No per-handler byte budget (small roster entries) — set an effectively-
  // unbounded byteBudget so `paginate()` truncates only on `limit`, keeping the
  // output byte-identical to the prior open-coded slice. `keyOf` stamps the
  // entry name onto the cursor for future shift-tolerant resume.
  const paged = paginateLegacy(filtered, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    keyOf: (a) => a.name,
    binding: {
      tool: 'sfi.list_analyses',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const emitCursor = paged.nextCursor !== null;

  return ok({
    data: {
      analyses: paged.items,
      total: filtered.length,
      offset,
      categories,
      next: 'Call sfi.describe_analysis { name } for one tool’s full input schema, then sfi.run_analysis { name, args } to execute it — identical output to calling the tool directly.',
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

export const describeAnalysisInputSchema = z.object({
  name: z.string().min(1),
});

export type DescribeAnalysisInput = z.infer<typeof describeAnalysisInputSchema>;

export interface DescribeAnalysisOutput {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** The `sfi.describe_analysis` MCP tool — one schema, on demand. */
export const describeAnalysisHandler = async (
  ctx: Context,
  input: DescribeAnalysisInput,
): Promise<Result<McpResponse<DescribeAnalysisOutput>, McpError>> => {
  const roster = await loadRoster();
  const name = input.name.startsWith('sfi.') ? input.name : `sfi.${input.name}`;
  const tool = roster.find((t) => t.name === name);
  if (tool === undefined) {
    return err({
      kind: 'invalid-query',
      message: `Unknown analysis '${input.name}'. Call sfi.list_analyses for the catalog (names are exact, e.g. 'sfi.org_card').`,
    });
  }
  return ok({
    data: {
      name: tool.name,
      category: analysisCategory(tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

export const runAnalysisInputSchema = z.object({
  name: z.string().min(1),
  /** Object, or a JSON-encoded string of one (known client quirk). */
  args: z.union([z.record(z.unknown()), z.string()]).optional(),
});

export type RunAnalysisInput = z.infer<typeof runAnalysisInputSchema>;

/** The three gateway names — `run_analysis` must not re-enter itself. */
export const GATEWAY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'sfi.run_analysis',
]);

/**
 * Resolve + validate a `run_analysis` request into the concrete tool name and
 * args, WITHOUT executing it. The index.ts dispatch case executes the result
 * via `dispatchTool` and returns that envelope verbatim (byte-identity).
 */
export const resolveRunAnalysis = (
  input: RunAnalysisInput,
): Result<{ readonly name: string; readonly args: Readonly<Record<string, unknown>> }, McpError> => {
  const name = input.name.startsWith('sfi.') ? input.name : `sfi.${input.name}`;
  if (GATEWAY_TOOL_NAMES.has(name)) {
    return err({
      kind: 'invalid-query',
      message: 'run_analysis cannot dispatch itself — name a concrete analysis (see sfi.list_analyses).',
    });
  }
  let args: Readonly<Record<string, unknown>> = {};
  if (typeof input.args === 'string') {
    // Known client quirk: arguments arrive as a JSON-encoded STRING.
    try {
      const parsed: unknown = input.args.trim() === '' ? {} : JSON.parse(input.args);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      args = parsed as Readonly<Record<string, unknown>>;
    } catch {
      return err({
        kind: 'invalid-query',
        message: `run_analysis args string is not a JSON object: ${input.args.slice(0, 120)}`,
      });
    }
  } else if (input.args !== undefined) {
    args = input.args;
  }
  return ok({ name, args });
};
