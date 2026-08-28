/**
 * Handler for the `sfi.search_apex_source` MCP tool.
 *
 * Unlike the other v0.1 tools, this one does NOT consult the graph. It
 * recursively walks `{vaultRoot}/source/` for `.cls` and `.trigger`
 * files (flat or DX-nested under `main/default/`) and grep-searches
 * each file line by line.
 *
 * Because the corpus is the filesystem rather than the graph, a zero-match
 * answer has two completely different causes — the Apex was read and does not
 * mention the query, or there was no Apex to read. `absence` (see
 * {@link SearchApexAbsenceKind}) says which, derived from the walk itself
 * rather than from `matches.length`.
 */

import { readFile } from 'node:fs/promises';

import type {
  EvidenceAbsenceV2,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { buildCoverageEntries, collectVaultSourceFiles } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  APEX_USAGE_REQUIRED_COVERAGE,
  buildEnumerationCoverageCaveatFor,
  type CoverageCaveat,
} from './coverage-trust.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const SEARCH_APEX_SOURCE_MAX_LIMIT = 200;
const SEARCH_APEX_SOURCE_DEFAULT_LIMIT = 50;

const APEX_SUFFIXES = ['.cls', '.trigger'] as const;

/** Tool name minted onto / checked against a continuation cursor. */
const SEARCH_APEX_SOURCE_TOOL = 'sfi.search_apex_source';

/**
 * Ceiling on how many DISTINCT match lines one call will collect before it
 * stops walking the corpus.
 *
 * WHY A CAP AT ALL: `totalCount` is computed by grepping the WHOLE corpus, not
 * by counting one page, so a pathological query (a single punctuation
 * character) would otherwise materialise one object per source line. The cap
 * bounds that. WHY IT IS DISCLOSED: once it bites, `totalCount` is a LOWER
 * BOUND, and a lower bound presented as a total is precisely the certification
 * this tool is not allowed to make — so `scanCap` is emitted as a typed field
 * (`totalIsLowerBound: true`) that a machine consumer cannot skip, alongside
 * prose in `note`.
 */
export const SEARCH_APEX_SOURCE_SCAN_CAP = 5_000;

export const searchApexSourceInputSchema = z.object({
  query: z.string().min(1),
  regex: z.boolean().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_APEX_SOURCE_MAX_LIMIT)
    .optional(),
  /**
   * Zero-based page offset over the FULL ordered match list. Before this
   * existed the object was non-strict, so a caller who passed `offset` — the
   * convention every other paged tool in this product uses — had it SILENTLY
   * STRIPPED and got page one back again, byte-identical, with no error: a
   * false paging illusion that reads as "I reached the end".
   */
  offset: z.number().int().nonnegative().optional(),
  /**
   * CR-22 continuation cursor: the opaque token from a prior truncated page's
   * `nextCursor`. Supplies the resume offset and is bound to this tool, this
   * vault hash and this query's narrowing args; a stale or foreign token is
   * refused with `invalid-query` rather than silently paging the wrong list.
   */
  cursor: z.string().min(1).optional(),
});

export type SearchApexSourceInput = z.infer<typeof searchApexSourceInputSchema>;

export interface SearchApexSourceMatch {
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * Which kind of empty a zero-match search is. TYPED-ABSENCE-SEARCH-APEX.
 *
 *   - `corpus-absent` — the walk found NO `.cls` / `.trigger` file at all under
 *     `{vaultRoot}/source/`. Nothing was grepped, so "no matches" is a statement
 *     about this VAULT, not about the org's Apex.
 *   - `corpus-partially-read` — files were found but at least one could not be
 *     READ. The lines in it were never compared against the query.
 *   - `result-capped` — the walk stopped at `limit` before exhausting the
 *     corpus, so the rest of it was never compared.
 *   - `coverage-disagrees` — files WERE read, but the vault's own manifest says
 *     the Apex retrieve did not land complete (errored, never requested, or a
 *     zero it could not confirm). `filesSearched > 0` proves some Apex was
 *     grepped; it does not prove the vault holds the org's Apex, so the zero
 *     cannot be certified.
 *   - `checked-empty` — every discovered file was read line by line and none
 *     matched. This is the only kind that is a real finding of nothing, and it
 *     is still bounded by what a LITERAL grep can see (see `note`).
 */
export type SearchApexAbsenceKind =
  | 'corpus-absent'
  | 'corpus-partially-read'
  | 'result-capped'
  | 'coverage-disagrees'
  | 'checked-empty';

/**
 * The typed absence attached to a zero-match search.
 *
 * WHY: before this block a zero-match response carried `matches: []`,
 * `truncated: false` and a single fixed `boundaryNote` whose first sentence was
 * "Searched retrieved Apex .cls and .trigger files under the vault source/
 * tree ... No matches." A vault with NO source tree got that same sentence — so
 * "this org's Apex does not mention X" and "this vault holds no Apex to search"
 * were the same answer, and the caller would have concluded the former.
 * `truncated: false` cannot carry the distinction either: it describes the PAGE,
 * not whether the scan ran (see `tests/integration/envelope-honesty.ts`, which
 * deliberately REJECTS it as an absence marker).
 *
 * `status` is the shared `EvidenceAbsenceStatusV2` vocabulary:
 * `proven-none` only for `checked-empty`, `not-checked` for the two corpus
 * gaps, `unknown` for a capped page and for a corpus the manifest says is
 * incomplete (`coverage-disagrees`).
 */
export interface SearchApexAbsence extends EvidenceAbsenceV2 {
  readonly kind: SearchApexAbsenceKind;
  /** `.cls` / `.trigger` files the walk actually discovered and read. */
  readonly filesSearched: number;
  /**
   * Vault-relative paths that matched the suffix walk but could NOT be read —
   * their lines were never compared to the query. Empty on the clean path.
   */
  readonly filesUnreadable: readonly string[];
  /**
   * The shared retrieve-coverage caveat for the Apex families, when the
   * manifest says coverage is not complete. Present on ANY zero-match kind —
   * a corpus gap and a coverage gap are independent axes and a caller must see
   * both. Absent when the manifest carries no coverage rows (legacy vaults are
   * never false-flagged) or when the retrieve landed clean.
   */
  readonly coverageCaveat?: CoverageCaveat;
}

/**
 * Emitted when the corpus walk stopped at {@link SEARCH_APEX_SOURCE_SCAN_CAP}
 * before running out of matching lines. Its presence is the ONLY thing that
 * makes `totalCount` a lower bound rather than a total, so it is a typed field
 * rather than a sentence in prose a machine consumer would skip.
 */
export interface SearchApexScanCap {
  /** The ceiling that bit. */
  readonly cap: number;
  /** Always `true` — `totalCount` is a floor, not the number of matching lines. */
  readonly totalIsLowerBound: true;
  /** Host-readable prose saying the count is a floor and how to narrow it. */
  readonly note: string;
}

export interface SearchApexSourceOutput {
  readonly matches: readonly SearchApexSourceMatch[];
  /**
   * Back-compat flag: TRUE when matches remain past this page. It describes the
   * PAGE and nothing else — `truncated: false` is never an absence marker (see
   * `tests/integration/envelope-honesty.ts`) and it never says how many were
   * withheld. `totalCount` / `pageInfo` are what answer that.
   */
  readonly truncated: boolean;
  /**
   * Total DISTINCT matching lines across the whole vaulted Apex corpus, before
   * `offset` / `limit`. A LOWER BOUND — not a total — whenever `scanCap` is
   * present. Before this key existed the payload carried `matches` and
   * `truncated` alone, so a caller could neither learn that a remainder existed
   * nor how big it was, and a 200-row page read as an org-wide inventory.
   */
  readonly totalCount: number;
  /** Zero-based offset of THIS page into the full ordered match list. */
  readonly offset: number;
  /** Page size actually applied (echoed so the page is readable without guessing). */
  readonly limit: number;
  /** True when matches remain past this page. */
  readonly hasMore: boolean;
  /** Offset to pass next, or `null` when the list is exhausted. */
  readonly nextOffset: number | null;
  /**
   * Opaque CR-22 continuation token, present ONLY on a truncated page. Echo it
   * back verbatim as `cursor`. Never parse or construct it.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata; `nextCursor` is `null` when exhausted. */
  readonly pageInfo: PageInfo;
  /**
   * Present ONLY when `hasMore`: prose a host will read aloud saying this page
   * is not the inventory and how to advance. A host relaying a capped page as
   * "here are the N matches in your org" is the failure this exists to stop.
   */
  readonly note?: string;
  /** Present only when the corpus walk hit its own ceiling — see the type. */
  readonly scanCap?: SearchApexScanCap;
  /** Present when zero matches — grep-only; graph tools may still find references. */
  readonly boundaryNote?: string;
  /**
   * Present when zero matches: WHICH kind of empty this is. A bare `[]` is
   * indistinguishable from an unretrieved Apex corpus; this says which.
   *
   * Attached ONLY when `totalCount` is 0. An empty PAGE at an offset past the
   * end is an EXHAUSTED page, not a searched-and-clean corpus; certifying
   * `proven-none` there would be a fresh instance of the defect the typed
   * absence exists to remove.
   */
  readonly absence?: SearchApexAbsence;
}

/**
 * What one {@link grepVaultSource} pass actually did.
 *
 * `matches` / `truncated` are the historical fields. `filesAvailable` and
 * `unreadablePaths` were added so a caller can tell a searched-and-empty result
 * from one where there was nothing to search or something could not be read —
 * a zero over an empty corpus is not evidence of anything. Both are derived
 * from the walk itself, never from `matches.length`.
 */
export interface GrepVaultSourceResult {
  readonly matches: SearchApexSourceMatch[];
  readonly truncated: boolean;
  /** Files the suffix walk discovered (after `pathFilter`), read or not. */
  readonly filesAvailable: number;
  /** Vault-relative paths whose contents could not be read, so were NOT searched. */
  readonly unreadablePaths: readonly string[];
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
): Promise<Result<GrepVaultSourceResult, McpError>> => {
  const matcher = buildMatcher({ query: options.query, regex: options.regex });
  if (!matcher.ok) return matcher;

  const all = await collectVaultSourceFiles(ctx.vaultRoot, {
    suffixes: options.suffixes,
  });
  const files = options.pathFilter
    ? all.filter((f) => options.pathFilter!(f.vaultRelativePath))
    : all;

  const matches: SearchApexSourceMatch[] = [];
  const unreadablePaths: string[] = [];
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
    if (fileMatches.unreadable) unreadablePaths.push(file.vaultRelativePath);
    matches.push(...fileMatches.matches);
    if (fileMatches.truncated) {
      truncated = true;
      break;
    }
  }

  return ok({
    matches,
    truncated,
    filesAvailable: files.length,
    unreadablePaths,
  });
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

/**
 * What the vault's own coverage rows claim about the Apex families, rendered
 * for the `corpus-absent` reason. The point is to separate the two ways a vault
 * can hold no Apex source: the org genuinely has none (coverage agrees), or the
 * retrieve/prune lost it (coverage says N landed, the tree holds 0) — which is
 * a VAULT defect the caller must not read as an org fact.
 */
const apexCoverageClaim = (ctx: Context): string => {
  const rows = buildCoverageEntries(ctx.manifest).filter(
    (entry) => entry.type === 'ApexClass' || entry.type === 'ApexTrigger',
  );
  if (rows.length === 0) {
    return 'This vault’s manifest carries no ApexClass / ApexTrigger coverage row at all, so it cannot even say whether Apex was requested.';
  }
  const claimed = rows.reduce((sum, entry) => sum + entry.retrieved, 0);
  if (claimed > 0) {
    return `The manifest CONTRADICTS the tree: its coverage rows claim ${String(claimed)} retrieved Apex component(s) (${rows
      .map((entry) => `${entry.type} ${String(entry.retrieved)}`)
      .join(', ')}) while \`source/\` holds none — the source tree was pruned or never written, so this is a VAULT gap, not an org without Apex.`;
  }
  return `The manifest agrees the retrieve landed no Apex (${rows
    .map((entry) => `${entry.type} ${String(entry.retrieved)}`)
    .join(', ')}), so there was nothing to grep; that still is not proof the ORG has no Apex — only that this refresh retrieved none.`;
};

/**
 * Classify a ZERO-MATCH search. TYPED-ABSENCE-SEARCH-APEX.
 *
 * Called only when `matches` is empty: a populated result asserts no absence
 * and must not acquire a not-checked marker. Ordered most-severe first so a
 * corpus that was never read can never be reported as "read and clean", and
 * `checked-empty` — the only `proven-none` — is reachable ONLY after both the
 * walk and the manifest agree there is no gap.
 */
const classifyEmptySearch = (
  ctx: Context,
  filesSearched: number,
  filesUnreadable: readonly string[],
  truncated: boolean,
): SearchApexAbsence => {
  // The SECOND axis, independent of the walk. The walk can only report what is
  // on disk; whether what is on disk IS the org's Apex is a manifest question,
  // and `buildEnumerationCoverageCaveatFor` is the one place that answers it
  // (`APEX_USAGE_REQUIRED_COVERAGE` is the same ApexClass/ApexTrigger pair the
  // graph-backed usage tools require — not a fourth copy of the list). It
  // returns undefined for a legacy vault with no coverage rows and for a clean
  // retrieve, so neither is false-flagged.
  const coverageCaveat = buildEnumerationCoverageCaveatFor(
    ctx,
    APEX_USAGE_REQUIRED_COVERAGE,
    'The Apex grep',
  );
  const withCoverage = (absence: SearchApexAbsence): SearchApexAbsence =>
    coverageCaveat === undefined ? absence : { ...absence, coverageCaveat };

  if (filesSearched === 0) {
    return withCoverage({
      kind: 'corpus-absent',
      status: 'not-checked',
      filesSearched,
      filesUnreadable,
      note:
        'NOT CHECKED: the walk over `{vaultRoot}/source/` found NO `.cls` or `.trigger` file, so not one line was compared against this query. ' +
        'Zero matches here says nothing about the org’s Apex. ' +
        `${apexCoverageClaim(ctx)} Run \`/sfi-refresh\` and search again.`,
    });
  }
  if (truncated) {
    return withCoverage({
      kind: 'result-capped',
      status: 'unknown',
      filesSearched,
      filesUnreadable,
      note:
        `CAPPED: the walk stopped at the \`limit\` before exhausting the ${String(filesSearched)} Apex file(s) in this vault, ` +
        'so the remainder was never compared. Raise `limit` before reading this as an absence.',
    });
  }
  if (filesUnreadable.length > 0) {
    return withCoverage({
      kind: 'corpus-partially-read',
      status: 'not-checked',
      filesSearched,
      filesUnreadable,
      note:
        `PARTIAL: ${String(filesUnreadable.length)} of ${String(filesSearched)} discovered Apex file(s) could not be read (${filesUnreadable.join(', ')}), ` +
        'so their lines were never compared against this query. The zero covers only the files that WERE read.',
    });
  }
  // COVERAGE-DISAGREES before CHECKED-EMPTY. Everything the walk itself can see
  // looked clean, so without this branch the handler would certify
  // `proven-none` over a corpus the vault's OWN manifest says is incomplete —
  // "all 1 file(s) were read and none matched" for an org whose ApexClass
  // retrieve errored. `filesSearched > 0` is evidence that SOMETHING was
  // grepped, never evidence that everything was.
  if (coverageCaveat !== undefined) {
    return {
      kind: 'coverage-disagrees',
      status: 'unknown',
      filesSearched,
      filesUnreadable,
      coverageCaveat,
      note:
        `NOT CONFIRMED: ${String(filesSearched)} \`.cls\` / \`.trigger\` file(s) present in this vault were read and none matched, ` +
        `but the manifest says the Apex retrieve did not land complete — ${coverageCaveat.message} ` +
        'Re-run `/sfi-refresh` before reading this zero as "not referenced in Apex".',
    };
  }

  return {
    kind: 'checked-empty',
    status: 'proven-none',
    filesSearched,
    filesUnreadable,
    note:
      `CHECKED: all ${String(filesSearched)} \`.cls\` / \`.trigger\` file(s) in this vault were read line by line and none matched. ` +
      'This is a real finding of nothing FOR A LITERAL GREP — it is still blind to references the source does not spell out ' +
      '(dynamic SOQL, `Schema.describeSObjects`, `get(fieldName)`, managed-package code). Use `sfi.find_field_anywhere` / ' +
      '`sfi.find_code_usages` for graph-backed references.',
  };
};

export const searchApexSourceHandler = async (
  ctx: Context,
  input: SearchApexSourceInput,
): Promise<Result<McpResponse<SearchApexSourceOutput>, McpError>> => {
  const limit = input.limit ?? SEARCH_APEX_SOURCE_DEFAULT_LIMIT;

  const needles = apexSearchNeedles(input.query);
  // SCAN THE WHOLE CORPUS, NOT ONE PAGE. The walk used to stop at the caller's
  // `limit`, which meant the handler never knew how many matches existed — so
  // the payload could not publish a total, and a 200-row page was
  // indistinguishable from an org-wide inventory. The walk is now bounded by
  // SEARCH_APEX_SOURCE_SCAN_CAP (disclosed when it bites), not by the page size.
  const all: SearchApexSourceMatch[] = [];
  const seen = new Set<string>();
  // Every needle greps the SAME corpus, so `filesAvailable` is identical across
  // passes and the unreadable set is a union rather than a sum. Both are read
  // off the walk, never inferred from `matches.length` — the whole point is
  // that the two are independent.
  let filesSearched = 0;
  const unreadable = new Set<string>();
  let scanCapped = false;
  for (const needle of needles) {
    if (all.length >= SEARCH_APEX_SOURCE_SCAN_CAP) {
      scanCapped = true;
      break;
    }
    const grep = await grepVaultSource(ctx, {
      query: needle,
      regex: input.regex,
      limit: SEARCH_APEX_SOURCE_SCAN_CAP - all.length,
      suffixes: APEX_SUFFIXES,
    });
    if (!grep.ok) return grep;
    filesSearched = Math.max(filesSearched, grep.value.filesAvailable);
    for (const path of grep.value.unreadablePaths) unreadable.add(path);
    for (const hit of grep.value.matches) {
      const key = `${hit.path}\u0000${String(hit.line)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(hit);
    }
    // `truncated` here means the walk stopped at the SCAN CAP, not at a page
    // boundary — the page limit is no longer what bounds it.
    if (grep.value.truncated) scanCapped = true;
  }

  // TOTAL ORDER before paging. Needles are searched in sequence, so a
  // `Field__c` hit could land after a `field` hit from a later file; a resume
  // over an order that is not total can dup or skip. (path ASC, line ASC) is
  // unique after dedupe and is the order this tool already documented.
  const ordered = all.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });

  // R2: resolve the resume offset — an echoed cursor wins over an explicit
  // `offset`. A stale or foreign token (different query, different tool, vault
  // refreshed under the caller) is REFUSED with `invalid-query` rather than
  // used to slice this list at another list's offsets.
  const fingerprint = argsFingerprint({
    query: input.query,
    ...(input.regex !== undefined ? { regex: input.regex } : {}),
  });
  const binding = {
    tool: SEARCH_APEX_SOURCE_TOOL,
    vaultHash: ctx.manifest.sourceTreeHash,
    argsFingerprint: fingerprint,
  };
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, binding);
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // No per-handler byte budget: page on `limit` only and let the global
  // `jsonResult` guard (which reconciles this handler's own page pointer) do
  // the byte work, so an in-budget page keeps the shape it had before.
  const paged = paginateLegacy(ordered, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    binding,
  });
  const matches = paged.items;
  const total = paged.totalCount;
  const hasMore = paged.hasMore;

  const scanCap: SearchApexScanCap | undefined = scanCapped
    ? {
        cap: SEARCH_APEX_SOURCE_SCAN_CAP,
        totalIsLowerBound: true,
        note:
          `SCAN CAPPED: the corpus walk stopped after ${String(SEARCH_APEX_SOURCE_SCAN_CAP)} distinct matching line(s), ` +
          'so `totalCount` is a LOWER BOUND and the remainder was never collected. Narrow the query before reading this as a count.',
    }
    : undefined;

  const note = hasMore
    ? `Showing ${String(matches.length)} of ${scanCapped ? 'at least ' : ''}${String(total)} matching Apex line(s) (offset=${String(offset)}). ` +
      `MORE remain — advance with offset=${String(paged.nextOffset ?? 0)} or by echoing \`nextCursor\`. ` +
      'This page is INCOMPLETE; do not narrate it as the org\u2019s full set of matches.'
    : undefined;

  // `boundaryNote` is DERIVED from the classification rather than being a fixed
  // string, because the fixed string opened with "Searched retrieved Apex .cls
  // and .trigger files under the vault source/ tree — No matches." A vault
  // holding no Apex at all got that same sentence, which is the lie this fix
  // exists to remove: it is only true on the `checked-empty` path.
  //
  // Keyed off the TOTAL, never off this page: an empty page at an offset past
  // the end has been read and paged, not searched-and-found-nothing.
  const absence =
    total === 0
      ? classifyEmptySearch(ctx, filesSearched, [...unreadable].sort(), false)
      : null;

  return ok({
    data: {
      matches,
      truncated: hasMore,
      totalCount: total,
      offset,
      limit,
      hasMore,
      nextOffset: paged.nextOffset,
      ...(paged.nextCursor !== null ? { nextCursor: paged.nextCursor } : {}),
      pageInfo: paged.pageInfo,
      ...(note !== undefined ? { note } : {}),
      ...(scanCap !== undefined ? { scanCap } : {}),
      ...(absence !== null
        ? {
            boundaryNote:
              absence.kind === 'checked-empty'
                ? SEARCH_EMPTY_BOUNDARY
                : (absence.note ?? SEARCH_EMPTY_BOUNDARY),
            absence,
          }
        : {}),
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
  /**
   * True when the file could not be read. It is NOT a file with zero matches —
   * its lines were never compared — so the caller must not fold it into a
   * "searched and found nothing" claim.
   */
  readonly unreadable: boolean;
}> => {
  let raw: string;
  try {
    raw = await readFile(fileAbsPath, 'utf-8');
  } catch {
    return { matches: [], truncated: false, unreadable: true };
  }

  const lines = raw.split('\n');
  const hits: SearchApexSourceMatch[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i] ?? '';
    if (!matches(lineText)) continue;
    if (hits.length >= remaining) {
      return { matches: hits, truncated: true, unreadable: false };
    }
    hits.push({
      path: vaultRelativePath,
      line: i + 1,
      snippet: lineText.trim(),
    });
  }
  return { matches: hits, truncated: false, unreadable: false };
};
