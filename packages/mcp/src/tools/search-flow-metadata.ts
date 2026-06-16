/**
 * Handler for the `sfi.search_flow_metadata` MCP tool.
 *
 * Like `sfi.search_apex_source`, this tool does NOT consult the graph.
 * It recursively walks `{vaultRoot}/source/` for `*.flow-meta.xml`
 * files (flat or DX-nested) and grep-searches each file line by line.
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

export const searchFlowMetadataInputSchema = z.object({
  query: z.string().min(1),
  regex: z.boolean().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_FLOW_METADATA_MAX_LIMIT)
    .optional(),
});

export type SearchFlowMetadataInput = z.infer<
  typeof searchFlowMetadataInputSchema
>;

export interface SearchFlowMetadataMatch {
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

export interface SearchFlowMetadataOutput {
  readonly matches: readonly SearchFlowMetadataMatch[];
  readonly truncated: boolean;
}

export const searchFlowMetadataHandler = async (
  ctx: Context,
  input: SearchFlowMetadataInput,
): Promise<Result<McpResponse<SearchFlowMetadataOutput>, McpError>> => {
  const limit = input.limit ?? SEARCH_FLOW_METADATA_DEFAULT_LIMIT;

  const matcher = buildMatcher(input);
  if (!matcher.ok) return matcher;

  const files = await collectVaultSourceFiles(ctx.vaultRoot, {
    suffixes: [FLOW_FILE_SUFFIX],
  });

  const matches: SearchFlowMetadataMatch[] = [];
  let truncated = false;

  for (const file of files) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    const fileMatches = await searchFile(
      file.absolutePath,
      file.vaultRelativePath,
      matcher.value,
      limit - matches.length,
    );
    matches.push(...fileMatches.matches);
    if (fileMatches.truncated) {
      truncated = true;
      break;
    }
  }

  return ok({
    data: { matches, truncated },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

type LineMatcher = (line: string) => boolean;

const buildMatcher = (
  input: SearchFlowMetadataInput,
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

const searchFile = async (
  fileAbsPath: string,
  vaultRelativePath: string,
  matches: LineMatcher,
  remaining: number,
): Promise<{
  readonly matches: readonly SearchFlowMetadataMatch[];
  readonly truncated: boolean;
}> => {
  let raw: string;
  try {
    raw = await readFile(fileAbsPath, 'utf-8');
  } catch {
    return { matches: [], truncated: false };
  }

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
