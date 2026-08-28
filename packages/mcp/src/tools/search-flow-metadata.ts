/**
 * Handler for the `sfi.search_flow_metadata` MCP tool.
 *
 * Like `sfi.search_apex_source`, this tool does NOT consult the graph.
 * It recursively walks `{vaultRoot}/source/` for `*.flow-meta.xml`
 * files (flat or DX-nested) and grep-searches each file line by line.
 *
 * CR-06 additions:
 *   - **Status-summary mode** (`summarize: true`, no `query` required):
 *     walks every flow file and tallies `<status>` values, returning a
 *     `statusSummary` record (Active / Obsolete / Draft / InvalidDraft /
 *     other) plus the total flow count. Directly answers "how many flows
 *     are Active vs Obsolete vs Draft?" without requiring the caller to
 *     page through 275+ XML files and grep manually.
 *   - **`triggerObject` filter**: when set, further narrows line matches
 *     (or status summary) to flow files that contain a
 *     `<object>` element whose value matches the supplied API name (e.g.
 *     `ns__Widget__c`). Used to enumerate active RTFs on a
 *     given SObject.
 */

import { readFile } from 'node:fs/promises';

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { collectVaultSourceFiles } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveExistingObjectScope } from './input-aliases.js';

const SEARCH_FLOW_METADATA_MAX_LIMIT = 200;
const SEARCH_FLOW_METADATA_DEFAULT_LIMIT = 50;
const FLOW_FILE_SUFFIX = '.flow-meta.xml';

/** Extract the text content of the FIRST occurrence of a single-line XML element. */
const extractFirstTag = (xml: string, tagName: string): string | null => {
  const re = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, '');
  const m = re.exec(xml);
  return m ? (m[1] ?? null) : null;
};

/** Every regex metacharacter, so a caller-supplied api name is matched LITERALLY. */
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when the flow XML contains `<object>VALUE</object>` for the given API name.
 *
 * SEARCH-FLOW-METADATA-TRUSTS-AN-UNVERIFIED-TRIGGEROBJECT: the value handed in
 * here is the CANONICAL api name the vault holds (see
 * {@link resolveExistingObjectScope} in the handler), never the caller's raw
 * string. Two things still hold locally:
 *   - EVERY metacharacter is escaped, not just `.`. The old escape let
 *     `Account|Contact` compile to an alternation that matched flows on BOTH
 *     objects and answered as though one had been named.
 *   - the match is CASE-INSENSITIVE. Salesforce api names are case-insensitive,
 *     so `<object>account</object>` in a hand-edited file names the same object
 *     as the canonical `Account`; a case-sensitive test dropped it.
 */
const flowMatchesTriggerObject = (xml: string, triggerObject: string): boolean => {
  const re = new RegExp(`<object>\\s*${escapeRegExp(triggerObject)}\\s*</object>`, 'i');
  return re.test(xml);
};

/**
 * Cap on the unreadable paths echoed back. The COUNT is always exact; this only
 * bounds the list so a wholly unreadable vault cannot blow the response budget.
 */
const MAX_UNREADABLE_PATHS_LISTED = 25;

/**
 * SEARCH-FLOW-METADATA-SWALLOWS-UNREADABLE-FILES: verbatim disclosure, shaped
 * after `buildUnscannedNodesNote` in `quality-scan-coverage.ts`. Product copy;
 * do not reword.
 */
const buildCoverageNote = (
  unreadable: number,
  found: number,
  paths: readonly string[],
): string => {
  const listed = paths.join(', ');
  const more = unreadable > paths.length ? `, +${unreadable - paths.length} more` : '';
  return (
    `NOT SCANNED IN THIS VAULT: ${unreadable} of ${found} flow files could not be READ ` +
    `(${listed}${more}). They are excluded from \`statusSummary\` and from \`matches\`, so ` +
    'this tally is NOT the org\'s complete flow count and zero findings for those files is ' +
    '"not checked", NOT "clean". Re-run `/sfi-refresh`, or check file permissions on the vault.'
  );
};

export const searchFlowMetadataInputSchema = z.object({
  /**
   * Text to search for (case-insensitive literal or regex). Required unless
   * `summarize: true` is set — in summary mode the query is optional and, if
   * omitted, only the status tally is returned.
   */
  query: z.string().min(1).optional(),
  regex: z.boolean().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_FLOW_METADATA_MAX_LIMIT)
    .optional(),
  /**
   * CR-06: when true, return a `statusSummary` tally of all flow statuses
   * (Active / Obsolete / Draft / InvalidDraft / other). May be combined with
   * `triggerObject` to count flows by status on a specific SObject.
   * `query` is optional in this mode; when both are present the line matches
   * are still returned alongside the summary.
   */
  summarize: z.boolean().optional(),
  /**
   * CR-06: when set, restrict results (and summary) to flow files that
   * declare `<object>THIS_API_NAME</object>` in their XML — i.e. record-
   * triggered flows on the given SObject. Example: `ns__Widget__c`.
   */
  triggerObject: z.string().min(1).optional(),
}).refine(
  (v) => v.query !== undefined || v.summarize === true,
  { message: 'provide `query`, `summarize: true`, or both' },
);

export type SearchFlowMetadataInput = z.infer<
  typeof searchFlowMetadataInputSchema
>;

export interface SearchFlowMetadataMatch {
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * CR-06: status tally returned when `summarize: true`.
 * Keys are the raw `<status>` values found in the flow XML plus `total`.
 */
export interface FlowStatusSummary {
  readonly Active: number;
  readonly Obsolete: number;
  readonly Draft: number;
  readonly InvalidDraft: number;
  /** Count of flows whose `<status>` does not match the four known values. */
  readonly other: number;
  /**
   * Total flow files successfully READ and tallied (sum of all status buckets).
   * This is NOT necessarily the org's flow count — files that could not be
   * opened are excluded and reported in `filesUnreadable`.
   */
  readonly total: number;
}

export interface SearchFlowMetadataOutput {
  /**
   * SEARCH-FLOW-METADATA-TRUSTS-AN-UNVERIFIED-TRIGGEROBJECT: present ONLY when
   * `triggerObject` was supplied — echoes the object the scan was narrowed to,
   * in the vault's EXACT casing, so a host never reads a scoped tally as
   * org-wide and a caller who typed `account` can see it resolved to `Account`.
   * Absent on a bare call, keeping that response byte-identical to pre-fix.
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
  readonly matches: readonly SearchFlowMetadataMatch[];
  readonly truncated: boolean;
  /**
   * False when NO `query` was supplied (summary-only mode): no line search ran,
   * so the empty `matches` above is NOT-SEARCHED, not searched-and-clean.
   */
  readonly searched: boolean;
  /**
   * Flow files DISCOVERED under `source/` — every one, BEFORE any
   * `triggerObject` narrowing, because a file that could not be opened cannot
   * be classified as in or out of scope. It is the denominator that makes
   * `filesUnreadable` readable.
   */
  readonly filesFound: number;
  /**
   * SEARCH-FLOW-METADATA-SWALLOWS-UNREADABLE-FILES: how many of `filesFound`
   * could not be opened. These contribute to NOTHING — not `statusSummary`, not
   * `matches` — so a non-zero value means the answer is PARTIAL.
   */
  readonly filesUnreadable: number;
  /**
   * The vault-relative paths of the unreadable files, capped at 25. The count
   * above is exact even when this list is truncated.
   */
  readonly unreadablePaths: readonly string[];
  /** Verbatim disclosure, present ONLY when `filesUnreadable > 0`. */
  readonly coverageNote?: string;
  /**
   * CR-06: present when `summarize: true`. Tally of flow `<status>` values
   * across all files that were successfully READ (optionally filtered to
   * `triggerObject`). Read `total` against `filesFound` / `filesUnreadable`.
   */
  readonly statusSummary?: FlowStatusSummary;
}

export const searchFlowMetadataHandler = async (
  ctx: Context,
  input: SearchFlowMetadataInput,
): Promise<Result<McpResponse<SearchFlowMetadataOutput>, McpError>> => {
  const limit = input.limit ?? SEARCH_FLOW_METADATA_DEFAULT_LIMIT;

  // SEARCH-FLOW-METADATA-TRUSTS-AN-UNVERIFIED-TRIGGEROBJECT: `triggerObject`
  // used to be string-templated straight into the match regex, so a wrong-case
  // name (`account` against `<object>Account</object>`), a typo, and an object
  // this refresh never retrieved ALL produced the same confident
  // `{Active: 0, …, total: 0}` — indistinguishable from a checked "this object
  // has no flows at all". It now goes through the shared
  // `resolveExistingObjectScope`, which verifies the object EXISTS in the vault,
  // rewrites it to the vault's exact casing, and REFUSES anything it cannot
  // resolve rather than answering about the empty set.
  let scopedObject: string | null = null;
  let appliedScope: { readonly object: string; readonly mode: 'component' } | null = null;
  if (input.triggerObject !== undefined) {
    const scopeResult = await resolveExistingObjectScope(ctx.graph, {
      objectApiName: input.triggerObject,
    });
    if (!scopeResult.ok) return err(scopeResult.error);
    const scope = scopeResult.value;
    // `triggerObject` is `min(1)`, so the resolver cannot report "no object
    // named"; the null branch exists only so the type is honoured.
    if (scope !== null) {
      scopedObject = scope.object;
      appliedScope = { object: scope.componentId, mode: 'component' };
    }
  }

  const files = await collectVaultSourceFiles(ctx.vaultRoot, {
    suffixes: [FLOW_FILE_SUFFIX],
  });

  const matches: SearchFlowMetadataMatch[] = [];
  let truncated = false;

  // CR-06: status summary accumulator.
  let statusSummary: FlowStatusSummary | undefined;
  const statusCounts = { Active: 0, Obsolete: 0, Draft: 0, InvalidDraft: 0, other: 0, total: 0 };

  // Build the line matcher only when a query is provided.
  let matcher: ((line: string) => boolean) | null = null;
  if (input.query !== undefined) {
    const built = buildMatcher(input as { query: string; regex?: boolean });
    if (!built.ok) return built;
    matcher = built.value;
  }

  // SEARCH-FLOW-METADATA-SWALLOWS-UNREADABLE-FILES: a file that fails to read
  // used to `continue` into silence — it reached neither `statusSummary.total`
  // nor `matches` nor any error, so a partial tally shipped as the org's
  // complete flow status. Count them and NAME them instead.
  let filesUnreadable = 0;
  const unreadablePaths: string[] = [];

  for (const file of files) {
    // Read the full file once — needed for both the object filter and the summary.
    let raw: string;
    try {
      raw = await readFile(file.absolutePath, 'utf-8');
    } catch {
      filesUnreadable += 1;
      if (unreadablePaths.length < MAX_UNREADABLE_PATHS_LISTED) {
        unreadablePaths.push(file.vaultRelativePath);
      }
      continue;
    }

    // CR-06: apply triggerObject filter at the file level (skip files that
    // don't declare the object) — avoids matching flows on other objects. The
    // name matched is the vault-canonical one the resolver returned above.
    if (scopedObject !== null) {
      if (!flowMatchesTriggerObject(raw, scopedObject)) continue;
    }

    // CR-06: accumulate status summary.
    if (input.summarize === true) {
      const status = extractFirstTag(raw, 'status');
      statusCounts.total += 1;
      if (status === 'Active') statusCounts.Active += 1;
      else if (status === 'Obsolete') statusCounts.Obsolete += 1;
      else if (status === 'Draft') statusCounts.Draft += 1;
      else if (status === 'InvalidDraft') statusCounts.InvalidDraft += 1;
      else statusCounts.other += 1;
    }

    // Line-match search (only when a query is provided and not yet truncated).
    if (matcher !== null && !truncated) {
      if (matches.length >= limit) {
        truncated = true;
      } else {
        const fileMatches = searchFileLines(
          raw,
          file.vaultRelativePath,
          matcher,
          limit - matches.length,
        );
        matches.push(...fileMatches.matches);
        if (fileMatches.truncated) truncated = true;
      }
    }
  }

  if (input.summarize === true) {
    statusSummary = { ...statusCounts };
  }

  return ok({
    data: {
      // appliedScope FIRST and only when scoped, so a bare call's serialized
      // response is byte-identical to the pre-fix shape apart from the new
      // always-present coverage fields.
      ...(appliedScope !== null ? { appliedScope } : {}),
      matches,
      truncated,
      searched: matcher !== null,
      filesFound: files.length,
      filesUnreadable,
      unreadablePaths,
      ...(filesUnreadable > 0
        ? { coverageNote: buildCoverageNote(filesUnreadable, files.length, unreadablePaths) }
        : {}),
      ...(statusSummary !== undefined ? { statusSummary } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

type LineMatcher = (line: string) => boolean;

const buildMatcher = (
  input: { query: string; regex?: boolean },
): Result<LineMatcher, McpError> => {
  if (input.regex === true) {
    let compiled: RegExp;
    try {
      compiled = new RegExp(input.query, 'i');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err({
        kind: 'invalid-query',
        message: `invalid regex: ${message}`,
      });
    }
    return ok((line) => compiled.test(line));
  }
  const needle = input.query.toLowerCase();
  return ok((line) => line.toLowerCase().includes(needle));
};

/**
 * Search pre-read file content line-by-line. Separated from file I/O so the
 * outer loop can share the single `readFile` call with the status-summary pass.
 */
const searchFileLines = (
  raw: string,
  vaultRelativePath: string,
  matches: LineMatcher,
  remaining: number,
): {
  readonly matches: readonly SearchFlowMetadataMatch[];
  readonly truncated: boolean;
} => {
  const lines = raw.split('\n');
  const hits: SearchFlowMetadataMatch[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i] ?? '';
    if (!matches(lineText)) continue;
    if (hits.length >= remaining) {
      return { matches: hits, truncated: true };
    }
    hits.push({
      path: vaultRelativePath,
      line: i + 1,
      snippet: lineText.trim(),
    });
  }
  return { matches: hits, truncated: false };
};

