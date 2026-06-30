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
 *     `hed__Course_Offering__c`). Used to enumerate active RTFs on a
 *     given SObject.
 */

import { readFile } from 'node:fs/promises';

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { collectVaultSourceFiles } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

const SEARCH_FLOW_METADATA_MAX_LIMIT = 200;
const SEARCH_FLOW_METADATA_DEFAULT_LIMIT = 50;
const FLOW_FILE_SUFFIX = '.flow-meta.xml';

/** Extract the text content of the FIRST occurrence of a single-line XML element. */
const extractFirstTag = (xml: string, tagName: string): string | null => {
  const re = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, '');
  const m = re.exec(xml);
  return m ? (m[1] ?? null) : null;
};

/** True when the flow XML contains `<object>VALUE</object>` for the given API name. */
const flowMatchesTriggerObject = (xml: string, triggerObject: string): boolean => {
  const re = new RegExp(`<object>\\s*${triggerObject.replace(/\./g, '\\.')}\\s*</object>`);
  return re.test(xml);
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
   * triggered flows on the given SObject. Example: `hed__Course_Offering__c`.
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
  /** Total flow files scanned (sum of all status buckets). */
  readonly total: number;
}

export interface SearchFlowMetadataOutput {
  readonly matches: readonly SearchFlowMetadataMatch[];
  readonly truncated: boolean;
  /**
   * CR-06: present when `summarize: true`. Tally of flow `<status>` values
   * across all files (optionally filtered to `triggerObject`).
   */
  readonly statusSummary?: FlowStatusSummary;
}

export const searchFlowMetadataHandler = async (
  ctx: Context,
  input: SearchFlowMetadataInput,
): Promise<Result<McpResponse<SearchFlowMetadataOutput>, McpError>> => {
  const limit = input.limit ?? SEARCH_FLOW_METADATA_DEFAULT_LIMIT;

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

  for (const file of files) {
    // Read the full file once — needed for both the object filter and the summary.
    let raw: string;
    try {
      raw = await readFile(file.absolutePath, 'utf-8');
    } catch {
      continue;
    }

    // CR-06: apply triggerObject filter at the file level (skip files that
    // don't declare the object) — avoids matching flows on other objects.
    if (input.triggerObject !== undefined) {
      if (!flowMatchesTriggerObject(raw, input.triggerObject)) continue;
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
      matches,
      truncated,
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

