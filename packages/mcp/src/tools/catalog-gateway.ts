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
 *
 * CATEGORY-FILTER-FAILED-OPEN (R4). `list_analyses` filtered on `category`
 * without ever verifying the value named a category. A typo, a
 * plausible-but-wrong word, or a REAL category in the WRONG CASE all returned
 * `{ analyses: [], total: 0 }` — no error, no marker — which reads as "this
 * server has no analyses of that kind". `describe_analysis` in this same file
 * already refused an unknown NAME with `invalid-query`, so the name filter
 * failed closed while the category filter failed open. The category now routes
 * through `resolveExistingCategory` against the vocabulary the roster itself
 * derives: unknown is refused by name (with the real vocabulary in the
 * message), wrong case is folded, and a filtered page echoes the canonical
 * `appliedCategory` so it can never be read as the whole roster.
 */

import type { McpError, McpResponse, PageInfo } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { toolProfile } from './tool-profile.js';

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
  /**
   * R4 verified scope echo: the category filter that was ACTUALLY applied,
   * canonicalized to this roster's own vocabulary (a wrong-case request is
   * folded, e.g. `What-If` -> `what-if`). Present ONLY on a filtered call, so a
   * narrowed page can never be read as the whole roster; absent on an
   * unfiltered call, keeping that response byte-identical to its prior shape.
   */
  readonly appliedCategory?: string;
}

/**
 * R4 (verified scope): resolve a caller-supplied `category` against the
 * vocabulary this roster ACTUALLY derives, BEFORE it is used as a filter.
 *
 * CATEGORY-FILTER-FAILED-OPEN — the defect this replaces: the category was
 * string-compared straight against `analysisCategory()` output, so a value that
 * names no category (a typo, a plausible-but-wrong word, or a REAL category in
 * the WRONG CASE) produced `{ analyses: [], total: 0 }` with no error and no
 * marker. A host reads that as "this server has no analyses of that kind" —
 * a confident zero over a filter that never matched anything. The sibling
 * `describe_analysis` in this same file already refuses an unknown NAME with
 * `invalid-query`; the two now fail closed the same way.
 *
 * Wrong CASE is resolved rather than refused: the vocabulary is a closed,
 * lowercase, name-derived set, so a case fold is unambiguous. The canonical
 * value is echoed back as `appliedCategory` and is what binds the cursor.
 */
export const resolveExistingCategory = (
  requested: string,
  vocabulary: readonly string[],
): Result<string, McpError> => {
  const exact = vocabulary.find((c) => c === requested);
  if (exact !== undefined) return ok(exact);
  const folded = requested.trim().toLowerCase();
  const insensitive = vocabulary.find((c) => c.toLowerCase() === folded);
  if (insensitive !== undefined) return ok(insensitive);
  return err({
    kind: 'invalid-query',
    message: `Unknown category '${requested}'. This roster derives exactly: ${vocabulary.join(', ')}. Omit \`category\` to list every analysis.`,
    path: 'category',
  });
};

/** Lazy roster access (cycle-safe): tools/index.ts owns `V01_TOOLS`. */
const loadRoster = async (): Promise<
  ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
    readonly hidden?: boolean;
  }>
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
  // AUDIT-F9: hide retired aliases from the catalog (same advertise contract as
  // tools/list). They remain invokable via `sfi.run_analysis` / describe.
  const all = roster
    .filter((t) => !t.hidden)
    .map((t) => ({
      name: t.name,
      oneLiner: oneLiner(t.description),
      category: analysisCategory(t.name),
    }));
  const categories = [...new Set(all.map((a) => a.category))].sort((a, b) => a.localeCompare(b));
  // R4: VERIFY the requested category exists in the derived vocabulary before
  // filtering on it. An unknown category is refused by name; a wrong-case one
  // is folded to its canonical form and echoed.
  let appliedCategory: string | undefined;
  if (input.category !== undefined) {
    const resolved = resolveExistingCategory(input.category, categories);
    if (!resolved.ok) return err(resolved.error);
    appliedCategory = resolved.value;
  }
  const filtered =
    appliedCategory === undefined ? all : all.filter((a) => a.category === appliedCategory);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset);
  // a stale/forged cursor (changed `category`, different tool, or refreshed
  // vault) is rejected with invalid-query. The roster is a STABLE declared
  // array (`V01_TOOLS`) with unique tool names, so the slice order is already a
  // total order keyed by array position (unique `name` tiebreak) and offset
  // resume neither dups nor skips.
  // Bind the cursor to the CANONICAL category so a case-variant resume
  // (`core` page 1, `CORE` page 2) is the same filter, not a forged one.
  const fingerprint = argsFingerprint({
    ...(appliedCategory !== undefined ? { category: appliedCategory } : {}),
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
      ...(appliedCategory !== undefined ? { appliedCategory } : {}),
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
  /**
   * AUDIT-F6 progressive discovery:
   *   - `summary` — name, category, one-liner, required arg keys (default under core)
   *   - `schema`  — summary + full inputSchema
   *   - `full`    — today's payload (description + inputSchema)
   * When omitted: `summary` under core profile, `full` under full profile.
   */
  detail: z.enum(['summary', 'schema', 'full']).optional(),
});

export type DescribeAnalysisInput = z.infer<typeof describeAnalysisInputSchema>;

export interface DescribeAnalysisOutput {
  readonly name: string;
  readonly category: string;
  readonly detail: 'summary' | 'schema' | 'full';
  readonly summary: string;
  readonly required?: readonly string[];
  readonly description?: string;
  readonly inputSchema?: unknown;
}

const requiredKeys = (schema: unknown): readonly string[] => {
  if (
    typeof schema === 'object' &&
    schema !== null &&
    Array.isArray((schema as { required?: unknown }).required)
  ) {
    return (schema as { required: readonly string[] }).required;
  }
  return [];
};

/** The `sfi.describe_analysis` MCP tool — progressive schema discovery. */
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
  const detail =
    input.detail ?? (toolProfile() === 'core' ? 'summary' : 'full');
  const summary = oneLiner(tool.description);
  const required = requiredKeys(tool.inputSchema);
  const base = {
    name: tool.name,
    category: analysisCategory(tool.name),
    detail,
    summary,
    ...(required.length > 0 ? { required } : {}),
  };
  const data: DescribeAnalysisOutput =
    detail === 'summary'
      ? base
      : detail === 'schema'
        ? { ...base, inputSchema: tool.inputSchema }
        : {
            ...base,
            description: tool.description,
            inputSchema: tool.inputSchema,
          };
  return ok({
    data,
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
  knownToolNames?: ReadonlySet<string>,
): Result<{ readonly name: string; readonly args: Readonly<Record<string, unknown>> }, McpError> => {
  const name = input.name.startsWith('sfi.') ? input.name : `sfi.${input.name}`;
  if (GATEWAY_TOOL_NAMES.has(name)) {
    return err({
      kind: 'invalid-query',
      message: 'run_analysis cannot dispatch itself — name a concrete analysis (see sfi.list_analyses).',
    });
  }
  // AUDIT-F6: authorize the gateway target against the registered roster.
  // Profile does not shrink gateway reachability — non-core tools are WHY
  // run_analysis exists under core — but unknown names fail closed here.
  if (knownToolNames !== undefined && !knownToolNames.has(name)) {
    return err({
      kind: 'invalid-query',
      message: `Unknown analysis '${input.name}'. Call sfi.list_analyses for the catalog.`,
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
