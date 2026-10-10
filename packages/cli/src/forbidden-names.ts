/**
 * TypeScript port of `scripts/lib/forbidden-names.mjs` — the maintainer-only
 * org blocklist (`scripts/forbidden-names.local.json`). This file ships in the
 * npm bundle, which cannot import a repo script, so the parser is ported
 * rather than shared; `test/forbidden-names-loader-parity.test.ts` runs both
 * against the same inputs and fails if they ever disagree.
 *
 * Fail-closed: a file that exists but is unparsable, the wrong shape, or holds
 * an invalid regex is an ERROR — never a silent "0 patterns".
 */
import { existsSync, readFileSync } from 'node:fs';

export interface ForbiddenNames {
  /** `patterns` — the release guard's key. */
  readonly guardPatterns: readonly string[];
  /** `scannerPatterns` ∪ `patterns` — what the org-leak scanner checks. */
  readonly scannerPatterns: readonly string[];
  readonly historyTerms: readonly string[];
}

export type ForbiddenNamesLoad =
  | ({ readonly status: 'loaded' | 'empty'; readonly path: string } & ForbiddenNames)
  | { readonly status: 'missing'; readonly path: string }
  | { readonly status: 'broken'; readonly path: string; readonly error: string };

const stringList = (cfg: Record<string, unknown>, key: string, path: string): string[] => {
  const v = cfg[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`${path}: "${key}" must be an array of strings`);
  }
  return v as string[];
};

const compileAll = (list: readonly string[], key: string, path: string): void => {
  for (const p of list) {
    try {
      new RegExp(p, 'i');
    } catch (cause) {
      throw new Error(
        `${path}: "${key}" holds an invalid regex (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
  }
};

/** Parse the blocklist TEXT; throws on any defect (same contract as the .mjs). */
export const parseForbiddenNames = (text: string, path = 'forbidden-names.local.json'): ForbiddenNames => {
  let cfg: unknown;
  try {
    cfg = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${path}: not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`${path}: must be a JSON object`);
  }
  const rec = cfg as Record<string, unknown>;
  const guardPatterns = stringList(rec, 'patterns', path);
  const scannerOnly = stringList(rec, 'scannerPatterns', path);
  const historyTerms = stringList(rec, 'historyTerms', path);
  compileAll(guardPatterns, 'patterns', path);
  compileAll(scannerOnly, 'scannerPatterns', path);
  return { guardPatterns, scannerPatterns: [...scannerOnly, ...guardPatterns], historyTerms };
};

/** Load from disk; never throws — a broken file is returned as `status: 'broken'`. */
export const loadForbiddenNames = (path: string): ForbiddenNamesLoad => {
  if (!existsSync(path)) return { status: 'missing', path };
  try {
    const parsed = parseForbiddenNames(readFileSync(path, 'utf8'), path);
    const empty = parsed.scannerPatterns.length === 0 && parsed.historyTerms.length === 0;
    return { status: empty ? 'empty' : 'loaded', path, ...parsed };
  } catch (cause) {
    return { status: 'broken', path, error: cause instanceof Error ? cause.message : String(cause) };
  }
};
