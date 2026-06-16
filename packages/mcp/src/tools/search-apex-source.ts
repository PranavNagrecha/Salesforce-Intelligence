/**
 * Handler for the `sfi.search_apex_source` MCP tool.
 *
 * Unlike the other v0.1 tools, this one does NOT consult the graph. It
 * recursively walks `{vaultRoot}/source/` for `.cls` and `.trigger`
 * files (flat or DX-nested under `main/default/`) and grep-searches
 * each file line by line.
 */

import { readFile } from 'node:fs/promises';

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { collectVaultSourceFiles } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

const SEARCH_APEX_SOURCE_MAX_LIMIT = 200;
const SEARCH_APEX_SOURCE_DEFAULT_LIMIT = 50;

const APEX_SUFFIXES = ['.cls', '.trigger'] as const;

export const searchApexSourceInputSchema = z.object({
  query: z.string().min(1),
  regex: z.boolean().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_APEX_SOURCE_MAX_LIMIT)
    .optional(),
});

export type SearchApexSourceInput = z.infer<typeof searchApexSourceInputSchema>;

export interface SearchApexSourceMatch {
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

export interface SearchApexSourceOutput {
  readonly matches: readonly SearchApexSourceMatch[];
  readonly truncated: boolean;
  /** Present when zero matches — grep-only; graph tools may still find references. */
  readonly boundaryNote?: string;
}

/**
 * Reusable literal/regex grep over `{vaultRoot}/source/` files. The Apex
 * handler below is the original consumer; `find_component_usages` reuses it
 * for the FRONTEND bundle tier (LWC / Aura / Visualforce — `$Label`,
 * `@salesforce/label`, `$Resource` / `@salesforce/resourceUrl` references the
 * Apex-only walk could never see; P14-USAGE-grep-frontend). `pathFilter`
 * bounds the walk (e.g. to bundle directories so an unzipped static
 * resource's `.js` payload cannot flood the results).
 */
export const grepVaultSource = async (
  ctx: Context,
  options: {
    readonly query: string;
    readonly regex?: boolean | undefined;
    readonly limit: number;
    readonly suffixes: readonly string[];
    readonly pathFilter?: (vaultRelativePath: string) => boolean;
  },
): Promise<Result<{ matches: SearchApexSourceMatch[]; truncated: boolean }, McpError>> => {
  const matcher = buildMatcher({ query: options.query, regex: options.regex });
  if (!matcher.ok) return matcher;

  const all = await collectVaultSourceFiles(ctx.vaultRoot, {
    suffixes: options.suffixes,
  });
  const files = options.pathFilter
    ? all.filter((f) => options.pathFilter!(f.vaultRelativePath))
    : all;

  const matches: SearchApexSourceMatch[] = [];
  let truncated = false;

  for (const file of files) {
    if (matches.length >= options.limit) {
      truncated = true;
      break;
    }
    const fileMatches = await searchFile(
      file.absolutePath,
      file.vaultRelativePath,
      matcher.value,
      options.limit - matches.length,
    );
    matches.push(...fileMatches.matches);
    if (fileMatches.truncated) {
      truncated = true;
      break;
    }
  }

  return ok({ matches, truncated });
};

const SEARCH_EMPTY_BOUNDARY =
  'Searched retrieved Apex .cls and .trigger files under the vault source/ tree (literal line grep — not the metadata graph). No matches. Dynamic SOQL, Schema.describeSObjects, get(fieldName), and managed-package code often omit string literals — use sfi.find_field_anywhere or sfi.find_code_usages for graph-backed references.';

/** Expand field-like tokens to common Salesforce source spellings. */
const apexSearchNeedles = (query: string): readonly string[] => {
  const out = new Set<string>([query]);
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  out.add(trimmed.toLowerCase());
  if (!trimmed.endsWith('__c')) {
    out.add(`${trimmed}__c`);
    out.add(`${trimmed.toLowerCase()}__c`);
  }
  if (trimmed.includes('_')) {
    const camel = trimmed
      .toLowerCase()
      .split('_')
      .filter((p) => p.length > 0)
      .map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
      .join('');
    if (camel.length > 0) out.add(camel);
  }
  return [...out];
};

export const searchApexSourceHandler = async (
  ctx: Context,
  input: SearchApexSourceInput,
): Promise<Result<McpResponse<SearchApexSourceOutput>, McpError>> => {
  const limit = input.limit ?? SEARCH_APEX_SOURCE_DEFAULT_LIMIT;

  const needles = apexSearchNeedles(input.query);
  const matches: SearchApexSourceMatch[] = [];
  let truncated = false;
  for (const needle of needles) {
    if (matches.length >= limit) break;
    const grep = await grepVaultSource(ctx, {
      query: needle,
      regex: input.regex,
      limit: limit - matches.length,
      suffixes: APEX_SUFFIXES,
    });
    if (!grep.ok) return grep;
    for (const hit of grep.value.matches) {
      if (matches.some((m) => m.path === hit.path && m.line === hit.line)) continue;
      matches.push(hit);
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
    truncated = truncated || grep.value.truncated;
  }

  return ok({
    data: {
      matches,
      truncated,
      ...(matches.length === 0 ? { boundaryNote: SEARCH_EMPTY_BOUNDARY } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

type LineMatcher = (line: string) => boolean;

const buildMatcher = (
  input: SearchApexSourceInput,
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
  readonly matches: readonly SearchApexSourceMatch[];
  readonly truncated: boolean;
}> => {
  let raw: string;
  try {
    raw = await readFile(fileAbsPath, 'utf-8');
  } catch {
    return { matches: [], truncated: false };
  }

  const lines = raw.split('\n');
  const hits: SearchApexSourceMatch[] = [];
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
