/**
 * The ONE loader for the maintainer-only org blocklist
 * (`scripts/forbidden-names.local.json`, gitignored).
 *
 * Used by `scripts/scan-org-leaks.mjs` and `scripts/release-guard.mjs`.
 * `packages/cli/src/commands/vault-anonymize.ts` ships inside the npm bundle
 * and cannot import a repo script, so it carries a TypeScript port; the
 * drift test `packages/cli/test/forbidden-names-loader-parity.test.ts` runs
 * both against the same inputs and fails if they ever disagree.
 *
 * Fail-closed contract:
 *  - a file that EXISTS but is unparsable, the wrong shape, or holds an
 *    invalid regex ALWAYS throws — a typo must never turn the scanner off;
 *  - a MISSING (or empty) blocklist is reported as `status: 'missing'` /
 *    `'empty'`, and {@link assertBlocklistPresent} decides whether that is
 *    allowed (it is not in strict mode unless explicitly opted out).
 *
 * Config shape: { "scannerPatterns": [regex...], "patterns": [regex...],
 * "historyTerms": [literal...] }. The org-leak scanner and the release guard
 * both check scannerPatterns ∪ patterns (returned as `scannerPatterns`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_FORBIDDEN_NAMES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'forbidden-names.local.json',
);

export class ForbiddenNamesConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForbiddenNamesConfigError';
  }
}

const stringList = (cfg, key, path) => {
  const v = cfg[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ForbiddenNamesConfigError(`${path}: "${key}" must be an array of strings`);
  }
  return v;
};

const compileAll = (list, key, path) =>
  list.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch (cause) {
      throw new ForbiddenNamesConfigError(
        `${path}: "${key}" holds an invalid regex (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
  });

/**
 * Parse the blocklist file's TEXT. Pure (no fs) so the CLI port can be
 * drift-tested against it. Throws {@link ForbiddenNamesConfigError} on any
 * defect.
 *
 * @param {string} text
 * @param {string} [path]
 * @returns {{ guardPatterns: string[], scannerPatterns: string[], historyTerms: string[] }}
 */
export function parseForbiddenNames(text, path = 'forbidden-names.local.json') {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (cause) {
    throw new ForbiddenNamesConfigError(
      `${path}: not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ForbiddenNamesConfigError(`${path}: must be a JSON object`);
  }
  const guardPatterns = stringList(cfg, 'patterns', path);
  const scannerOnly = stringList(cfg, 'scannerPatterns', path);
  const historyTerms = stringList(cfg, 'historyTerms', path);
  compileAll(guardPatterns, 'patterns', path);
  compileAll(scannerOnly, 'scannerPatterns', path);
  return { guardPatterns, scannerPatterns: [...scannerOnly, ...guardPatterns], historyTerms };
}

/**
 * Load the blocklist from disk.
 *
 * @param {string} [path]
 * @returns {{ status: 'loaded'|'missing'|'empty', path: string, guardPatterns: string[], scannerPatterns: string[], historyTerms: string[] }}
 */
export function loadForbiddenNames(path = DEFAULT_FORBIDDEN_NAMES_PATH) {
  if (!existsSync(path)) {
    return { status: 'missing', path, guardPatterns: [], scannerPatterns: [], historyTerms: [] };
  }
  const parsed = parseForbiddenNames(readFileSync(path, 'utf8'), path);
  const empty = parsed.scannerPatterns.length === 0 && parsed.historyTerms.length === 0;
  return { status: empty ? 'empty' : 'loaded', path, ...parsed };
}

/** One-line, always-printed summary — a scan that loaded nothing must say so. */
export function describeBlocklist(cfg) {
  if (cfg.status === 'loaded') {
    return `loaded ${cfg.scannerPatterns.length} scanner pattern(s) / ${cfg.historyTerms.length} history term(s) from the org blocklist`;
  }
  return `VACUOUS: no org blocklist (${cfg.status}: ${cfg.path}) — only generic checks run; private org names are NOT being checked`;
}

/**
 * Throw when a strict run has no blocklist, unless explicitly allowed
 * (`--allow-no-blocklist` / SFI_ALLOW_NO_BLOCKLIST=1 — for contributors and
 * fork-PR CI runs, which have no access to the secret).
 */
export function assertBlocklistPresent(cfg, { strict, allowNoBlocklist }) {
  if (cfg.status === 'loaded' || !strict || allowNoBlocklist) return;
  throw new ForbiddenNamesConfigError(
    `${describeBlocklist(cfg)}. Refusing to report a vacuous pass in strict mode. ` +
      'Copy scripts/forbidden-names.local.example.json to scripts/forbidden-names.local.json, ' +
      'or pass --allow-no-blocklist (or SFI_ALLOW_NO_BLOCKLIST=1) to accept a generic-only scan.',
  );
}

/** True when the environment explicitly opts out of requiring the blocklist. */
export function allowNoBlocklistFromEnv(argv = process.argv, env = process.env) {
  return argv.includes('--allow-no-blocklist') || env.SFI_ALLOW_NO_BLOCKLIST === '1';
}
