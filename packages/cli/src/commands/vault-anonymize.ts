/**
 * `sfi vault anonymize` — export a redacted copy of a vault for external
 * sharing (consultant / support / demo) (R6-20).
 *
 * Nothing before this scrubbed a vault. The only precedent is `scrubText` in
 * `./feedback.ts` (emails / URLs / Salesforce 15-18-char record ids in a
 * free-text question, used by `sfi feedback export`); this module extends
 * that same idea to a WHOLE vault tree, plus adds phone-number scrubbing and
 * org-identity replacement.
 *
 * SHIPPED — `--mode redact` (default): copies `org-kb/{components,docs,
 * source}` and an allowlisted subset of `meta/` to `--out`, with every file
 * run through two text-level transforms:
 *   1. org identity (the `targetOrg` / `sourceOrg` alias found in
 *      config.json / manifest.json / org-card.json) replaced everywhere it
 *      appears as literal text with a stable placeholder;
 *   2. {@link extendedScrubText} (emails, URLs, Salesforce record ids, phone
 *      numbers) run over the result.
 * Component / field API names are KEPT verbatim in this mode — a consultant
 * usually needs them, and scrubbing them safely (below) is a bigger project.
 * `graph/` (the DuckDB dependency graph) and `snapshots/` are NEVER copied —
 * see the module doc on `anonymizeVault` for why.
 *
 * NOT SHIPPED — `--mode pseudonymize` (custom API names ALSO replaced with a
 * stable, non-reversible placeholder mapping kept OUTSIDE `--out`). The
 * command refuses this mode with {@link PSEUDONYMIZE_NOT_IMPLEMENTED_MESSAGE}
 * rather than half-implementing it: consistently renaming a custom API name
 * across `components/`, the rendered markdown, AND the DuckDB graph needs
 * either a full re-extraction run over the pseudonymized source tree, or an
 * in-place rewrite of every textual column in the binary graph db — both are
 * real projects deserving their own item. The deterministic mapping
 * primitives ({@link buildPseudonymMapping}, {@link writeMappingTable}) are
 * built and tested here so that follow-up has something to start from.
 *
 * Safety rails: {@link validateOutDir} refuses an `--out` inside the source
 * vault (or a source vault inside `--out`); the source vault is opened
 * READ-ONLY (every write happens under `--out`); {@link residualLeakScan}
 * re-scans the OUTPUT after the copy and the CLI prints its summary before
 * exiting, so a scrub bug is surfaced rather than silently shipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';
import { vaultPaths } from '@sf-intelligence/vault';
import { Command } from 'commander';

import { scrubText } from './feedback.js';
import { loadVaultConfig } from './refresh.js';

// =============================================================================
// Text scrubbing
// =============================================================================

/**
 * North American-style phone number pattern: optional `+1`/`1` country code,
 * then a 3-3-4 digit grouping with `-`, `.`, or space separators (and
 * optional parens around the area code). Deliberately narrow (this is a
 * best-effort scrub, not a validator) — international formats vary too much
 * to catch generically without a much higher false-positive rate.
 *
 * No leading `\b`: a `(` immediately preceded by whitespace has no word
 * boundary on either side (both are non-word characters), which would skip
 * the leading paren and leave `(` outside the match (`(555) 867-5309` →
 * `([phone]` instead of `[phone]`). The trailing `\b` still prevents eating
 * extra trailing digits.
 */
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

/**
 * `scrubText` (emails, URLs, Salesforce 15/18-char record ids) plus a
 * phone-number pass. Extends the `sfi feedback export` precedent for a
 * whole-vault scrub rather than a single free-text question.
 */
export const extendedScrubText = (s: string): string => scrubText(s).replace(PHONE_RE, '[phone]');

// =============================================================================
// Org-identity replacement
// =============================================================================

/**
 * Build a deterministic real-value → placeholder map. A single identity (the
 * common case: `targetOrg` and `sourceOrg` agree) maps to `redacted-org`; two
 * or more DISTINCT values (rare — a vault refreshed under a different alias
 * than it was initialized with) map to `redacted-org-1`, `redacted-org-2`, …
 * in sorted order, so the mapping is stable across runs for the same input
 * set regardless of the order the identities were discovered in.
 */
export const buildIdentityReplacements = (
  identities: readonly string[],
): ReadonlyMap<string, string> => {
  const distinct = [...new Set(identities.filter((s) => s.length > 0))].sort();
  const map = new Map<string, string>();
  distinct.forEach((real, i) => {
    map.set(real, distinct.length === 1 ? 'redacted-org' : `redacted-org-${(i + 1).toString()}`);
  });
  return map;
};

/**
 * Replace every literal occurrence of each real identity string with its
 * placeholder. Plain substring replace (not a regex) — an org alias can
 * contain characters that are regex-special, and a literal match is exactly
 * what's needed here (no wildcards, no case-folding: an alias's casing is
 * itself part of its identity).
 */
export const applyReplacements = (text: string, map: ReadonlyMap<string, string>): string => {
  let out = text;
  for (const [real, placeholder] of map) {
    if (real.length === 0) continue;
    out = out.split(real).join(placeholder);
  }
  return out;
};

/** The `meta/*.json` files whose identity field is replaced structurally (parse → replace → re-stringify) before the blanket text scrub. */
const META_IDENTITY_KEY: Readonly<Record<string, string>> = {
  'config.json': 'targetOrg',
  'manifest.json': 'sourceOrg',
  'org-card.json': 'targetOrg',
};

/**
 * Read the org identity strings out of a vault's `config.json` (`targetOrg`),
 * `manifest.json` (`sourceOrg`), and `org-card.json` (`targetOrg`) — the
 * three places today's vault layout persists an org alias (v0.1.26; no
 * `username` / `instanceUrl` / `orgId` are written to disk today — those live
 * only transiently during a refresh's `sf` auth step). Best-effort on
 * manifest/org-card (an unrefreshed vault may lack them); `config.json`
 * missing or unparsable is the one hard error — that file is the `sfi init`
 * marker, so its absence means `vaultRoot` isn't a real vault.
 */
export const collectVaultIdentities = async (
  vaultRoot: string,
): Promise<Result<readonly string[], string>> => {
  const paths = vaultPaths(vaultRoot);
  let configRaw: string;
  try {
    configRaw = await readFile(paths.config, 'utf8');
  } catch {
    return err(`Vault config not found at ${paths.config} — is '${vaultRoot}' a refreshed org-kb vault?`);
  }
  const identities = new Set<string>();
  try {
    const parsed = JSON.parse(configRaw) as { targetOrg?: unknown };
    if (typeof parsed.targetOrg === 'string' && parsed.targetOrg.length > 0) {
      identities.add(parsed.targetOrg);
    }
  } catch {
    return err(`Vault config is not valid JSON: ${paths.config}`);
  }
  const bestEffortSources: readonly (readonly [path: string, key: string])[] = [
    [paths.manifest, 'sourceOrg'],
    [join(paths.meta, 'org-card.json'), 'targetOrg'],
  ];
  for (const [path, key] of bestEffortSources) {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed[key];
      if (typeof value === 'string' && value.length > 0) identities.add(value);
    } catch {
      // Absent or unparsable — an unrefreshed vault has no manifest/org-card
      // yet; config.json's targetOrg alone is still enough identity to scrub.
    }
  }
  return ok([...identities]);
};

// =============================================================================
// Safety rails
// =============================================================================

/**
 * Refuse an `--out` that is the source vault, nested inside it, or that
 * CONTAINS the source vault (the reverse mistake — pointing `--out` at an
 * ancestor of `org-kb/`). Either would let the redacted copy overwrite, or
 * be overwritten by, the real vault.
 */
export const validateOutDir = (vaultRoot: string, outDir: string): Result<void, string> => {
  const src = resolve(vaultRoot) + sep;
  const out = resolve(outDir) + sep;
  if (out === src || out.startsWith(src)) {
    return err(`--out (${resolve(outDir)}) must be OUTSIDE the source vault (${resolve(vaultRoot)}).`);
  }
  if (src.startsWith(out)) {
    return err(
      `--out (${resolve(outDir)}) must not CONTAIN the source vault (${resolve(vaultRoot)}) — pick a sibling or unrelated directory.`,
    );
  }
  return ok(undefined);
};

// =============================================================================
// File tree copy + transform
// =============================================================================

/**
 * Extensions treated as binary and EXCLUDED (not scrubbed, not copied) from
 * the anonymized output. Mirrors `scripts/scan-org-leaks.mjs`'s `isTextFile`
 * skip-list (that script's source of truth for "this isn't text") plus
 * `.resource` (Salesforce static-resource archives are frequently zipped).
 * A binary file COULD carry org identity (a logo, a bundled screenshot) that
 * text-level scrubbing cannot touch, so excluding it is the honest default.
 */
const isLikelyBinaryFile = (path: string): boolean =>
  /\.(png|jpe?g|gif|webp|ico|zip|gz|duckdb|wal|pdf|woff2?|ttf|eot|resource)$/i.test(path);

const walkFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

/** One skipped source file + why it was left out of the copy. */
export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

interface CopyStats {
  filesWritten: number;
  readonly filesSkipped: SkippedFile[];
}

/**
 * Copy every file under `srcDir` to `destDir` (same relative layout),
 * running each through `transform`. Binary files are skipped (recorded in
 * `stats.filesSkipped`), never copied verbatim. `relLabel` is the prefix
 * used in the skipped-file paths reported back to the caller (e.g.
 * `'source'`, `'components'`) so the summary reads like a vault-relative
 * path rather than a bare filename.
 */
const copyTextTree = async (
  srcDir: string,
  destDir: string,
  relLabel: string,
  transform: (text: string) => string,
  stats: CopyStats,
): Promise<void> => {
  const files = await walkFiles(srcDir);
  for (const file of files) {
    const rel = relative(srcDir, file);
    const reportedPath = join(relLabel, rel);
    if (isLikelyBinaryFile(file)) {
      stats.filesSkipped.push({
        path: reportedPath,
        reason: 'binary file — excluded (not scrubbed; could carry org identity verbatim, e.g. a logo in a static resource)',
      });
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (cause) {
      stats.filesSkipped.push({
        path: reportedPath,
        reason: `unreadable as text: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      continue;
    }
    const destPath = join(destDir, rel);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, transform(raw), 'utf8');
    stats.filesWritten += 1;
  }
};

/**
 * Replace the known identity field (`targetOrg` / `sourceOrg`) inside a
 * `meta/*.json` file structurally (parse → replace → re-stringify) rather
 * than relying on the blanket text scrub alone — the field VALUE might
 * itself not be caught by any generic pattern (an org alias is just a bare
 * word), so it needs the identity map applied by KEY, not by pattern.
 * `config.json`'s `vaultRoot` (an absolute local filesystem path — not org
 * identity, but still local-machine information with no place in a shared
 * copy) is rewritten to `'.'`. Non-JSON meta files (`.jsonl`, `.txt`) and any
 * `meta/*.json` file with no listed identity key pass through unchanged —
 * the blanket text scrub the caller runs afterward still covers them.
 */
const transformMetaJsonIdentityFields = (
  fileName: string,
  raw: string,
  identityMap: ReadonlyMap<string, string>,
): string => {
  const key = META_IDENTITY_KEY[fileName];
  if (key === undefined) return raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const real = parsed[key];
    if (typeof real === 'string') {
      parsed[key] = identityMap.get(real) ?? 'redacted-org';
    }
    if (fileName === 'config.json' && 'vaultRoot' in parsed) {
      parsed['vaultRoot'] = '.';
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
};

/** `meta/` files worth copying into the shared vault. Deliberately NOT the whole directory — see the module doc for the excluded (internal/transient) files. */
const META_COPY_ALLOWLIST: readonly string[] = [
  'config.json',
  'manifest.json',
  'org-card.json',
  'version.txt',
  'history.jsonl',
  'pulse.json',
  'risk-scores.jsonl',
];

// =============================================================================
// Residual-leak scan
// =============================================================================

interface LocalForbiddenNamePattern {
  readonly id: string;
  readonly re: RegExp;
}

/**
 * Best-effort load of `scripts/forbidden-names.local.json` — the SAME
 * gitignored, maintainer-only config `scripts/scan-org-leaks.mjs` reads (see
 * that script's `loadLocalConfig` — this is the source of truth for the
 * pattern-file SHAPE; real org-name patterns are never duplicated here).
 * Absent path or unparsable file → zero patterns (disclosed via
 * `localOrgNamePatternsChecked: 0` in the scan result), never a thrown error.
 */
const loadLocalForbiddenNamePatterns = (configPath: string): readonly LocalForbiddenNamePattern[] => {
  if (!existsSync(configPath)) return [];
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
      scannerPatterns?: unknown;
      patterns?: unknown;
    };
    const raw = [
      ...(Array.isArray(cfg.scannerPatterns) ? cfg.scannerPatterns : []),
      ...(Array.isArray(cfg.patterns) ? cfg.patterns : []),
    ];
    return raw
      .filter((p): p is string => typeof p === 'string')
      .map((p, i) => ({ id: `local-${i.toString()}`, re: new RegExp(p, 'i') }));
  } catch {
    return [];
  }
};

/** One residual match the scan found in the OUTPUT (a scrub gap). */
export interface ResidualFinding {
  readonly file: string;
  readonly pattern: string;
}

export interface ResidualScanResult {
  readonly filesScanned: number;
  readonly findings: readonly ResidualFinding[];
  /** Count of local (maintainer-only) org-name patterns checked; 0 when no local config was found — disclosed, not silently "0 matches because unchecked". */
  readonly localOrgNamePatternsChecked: number;
}

/**
 * Re-scan the ALREADY-TRANSFORMED output tree for anything the copy pass
 * should have caught: (1) any of the original identity strings surviving
 * verbatim, (2) the generic scrub patterns still matching (an
 * `extendedScrubText` idempotency check — a fully-scrubbed file must equal
 * its own re-scrub, so a difference means a live match slipped through),
 * and (3) — only when a maintainer's local `forbidden-names.local.json`
 * config is available — the same real-org-name patterns
 * `scripts/scan-org-leaks.mjs` checks. This is the "0 residual matches"
 * summary printed before the CLI exits.
 */
export const residualLeakScan = async (
  outDir: string,
  identities: readonly string[],
  forbiddenNamesConfigPath?: string,
): Promise<ResidualScanResult> => {
  const files = await walkFiles(outDir);
  const localPatterns =
    forbiddenNamesConfigPath !== undefined ? loadLocalForbiddenNamePatterns(forbiddenNamesConfigPath) : [];
  const findings: ResidualFinding[] = [];
  let filesScanned = 0;
  for (const file of files) {
    if (isLikelyBinaryFile(file)) continue;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    filesScanned += 1;
    const rel = relative(outDir, file);
    for (const identity of identities) {
      if (identity.length > 0 && text.includes(identity)) {
        findings.push({ file: rel, pattern: 'identity-literal' });
      }
    }
    if (extendedScrubText(text) !== text) {
      findings.push({ file: rel, pattern: 'generic-pii-pattern' });
    }
    for (const { id, re } of localPatterns) {
      if (re.test(text)) findings.push({ file: rel, pattern: id });
    }
  }
  return { filesScanned, findings, localOrgNamePatternsChecked: localPatterns.length };
};

// =============================================================================
// pseudonymize building blocks (NOT wired into anonymizeVault — see module doc)
// =============================================================================

/** Zero-padded to 4 digits, matching the illustrative `Custom_Field_0042__c` shape from the R6-20 spec. */
const pad4 = (n: number): string => String(n).padStart(4, '0');

/**
 * A stable placeholder api name for a custom component, labeled by its
 * suffix family (field / custom metadata / platform event / big object /
 * external object) so a pseudonymized name still reads as "this was a
 * CustomField", just not WHICH one.
 */
export const pseudonymFor = (apiName: string, index: number): string => {
  if (apiName.endsWith('__mdt')) return `Custom_Metadata_${pad4(index)}__mdt`;
  if (apiName.endsWith('__e')) return `Custom_Event_${pad4(index)}__e`;
  if (apiName.endsWith('__b')) return `Custom_Big_Object_${pad4(index)}__b`;
  if (apiName.endsWith('__x')) return `Custom_External_${pad4(index)}__x`;
  if (apiName.endsWith('__c')) return `Custom_Field_${pad4(index)}__c`;
  return `Custom_Component_${pad4(index)}`;
};

/**
 * Build a deterministic real-api-name → pseudonym map. Distinct names are
 * sorted BEFORE indexing, so the mapping for a given SET of names is stable
 * across runs regardless of the order they were discovered in (mirrors
 * {@link buildIdentityReplacements}'s determinism contract).
 */
export const buildPseudonymMapping = (apiNames: readonly string[]): ReadonlyMap<string, string> => {
  const distinct = [...new Set(apiNames)].sort();
  const map = new Map<string, string>();
  distinct.forEach((name, i) => map.set(name, pseudonymFor(name, i)));
  return map;
};

/** Refuse a mapping-table path that lands inside `--out` — the whole point of the separate file is that the shared copy is NOT reversible without it. */
export const assertMappingPathOutsideOut = (mappingPath: string, outDir: string): void => {
  const out = resolve(outDir) + sep;
  const resolvedMappingPath = resolve(mappingPath);
  if (resolvedMappingPath === resolve(outDir) || (resolvedMappingPath + sep).startsWith(out)) {
    throw new Error(
      `mapping table path (${resolvedMappingPath}) must be OUTSIDE --out (${resolve(outDir)}) — the shared copy must not be reversible without the mapping the owner keeps.`,
    );
  }
};

/** Write the pseudonym mapping table (owner-only) as sorted, deterministic JSON. Throws via {@link assertMappingPathOutsideOut} if `path` is inside `outDir`. */
export const writeMappingTable = async (
  mapping: ReadonlyMap<string, string>,
  path: string,
  outDir: string,
): Promise<void> => {
  assertMappingPathOutsideOut(path, outDir);
  const entries = [...mapping.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([original, pseudonym]) => ({ original, pseudonym }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'pseudonymize', entries }, null, 2)}\n`,
    'utf8',
  );
};

// =============================================================================
// anonymizeVault
// =============================================================================

export type AnonymizeMode = 'redact' | 'pseudonymize';

export interface AnonymizeOptions {
  readonly vaultRoot: string;
  readonly outDir: string;
  readonly mode: AnonymizeMode;
  /** Path to a maintainer-local `forbidden-names.local.json`, if one exists. Omit to skip that check (disclosed in the result, never silently "0 matches"). */
  readonly forbiddenNamesConfigPath?: string;
}

export interface AnonymizeSummary {
  readonly mode: AnonymizeMode;
  readonly outDir: string;
  readonly filesWritten: number;
  readonly filesSkipped: readonly SkippedFile[];
  readonly identitiesReplacedCount: number;
  readonly residualScan: ResidualScanResult;
}

export const PSEUDONYMIZE_NOT_IMPLEMENTED_MESSAGE =
  "sfi vault anonymize --mode pseudonymize is NOT YET IMPLEMENTED. Consistently renaming custom API names across components/, the rendered markdown, AND the DuckDB dependency graph needs either (a) a full re-extraction pipeline run over the pseudonymized source tree, or (b) an in-place rewrite of every textual column in the binary graph db — both are real projects, tracked as a follow-up rather than half-shipped here. Use --mode redact (the default): it scrubs org identity and free text but keeps API names, which is what most consultant/support/demo shares need — see the residual-risk note in the generated README.md. The deterministic pseudonym-mapping primitives (buildPseudonymMapping / writeMappingTable) already exist in this module for that follow-up to build on.";

const buildAnonymizedReadme = (mode: AnonymizeMode, identityCount: number): string =>
  `# Anonymized SfIntelligence vault (mode: ${mode})

Generated by \`sfi vault anonymize\`. This is a REDACTED copy meant for
external sharing (consultant / support / demo) — read this before sending it
anywhere.

## What was done

- Org identity (${identityCount.toString()} distinct value(s) found across
  config.json / manifest.json / org-card.json) replaced with a stable
  placeholder everywhere it appeared as literal text.
- Free text (component descriptions, rendered markdown, retrieved source
  files) scrubbed for emails, URLs, Salesforce 15/18-char record ids, and
  phone-number patterns.
- Binary files (images, zips, fonts, static-resource archives) were EXCLUDED,
  not scrubbed — they cannot be text-scrubbed safely. Check the CLI output /
  handoff for the skipped-file count.

## What was intentionally left out

- \`graph/\` (the DuckDB dependency graph) — a copied binary database would
  carry the ORIGINAL, un-redacted strings inside it (node/edge properties are
  stored verbatim). Rebuild it locally instead: run \`sfi refresh --no-pull\`
  INSIDE this directory (it has \`meta/config.json\` and a scrubbed
  \`source/\` tree, so refresh can re-derive \`components/\` and \`graph/\`
  from what's here without another Salesforce API call or touching the real
  org). The rebuilt graph reflects the SCRUBBED source, not the original.
- \`snapshots/\` — internal diff history, not needed for external sharing.

## Residual-risk disclosure — mode: ${mode}

${
  mode === 'redact'
    ? `\`redact\` mode (the default) KEEPS component/field API names verbatim — a
consultant usually needs them. That means:

- Custom object/field/flow/etc. API names ARE visible (e.g.
  \`My_Custom_Field__c\`) and MAY themselves be identifying if your org's
  naming convention embeds a company name or internal codename. Skim
  \`components/\` before sharing if that's a concern.
- Aggregate statistics (component counts, coverage) are visible and could, in
  combination with public information, help someone guess which org this is.

For a stronger guarantee — custom API names ALSO replaced with a stable,
non-reversible placeholder mapping — use \`--mode pseudonymize\`. That mode is
NOT YET IMPLEMENTED (tracked as a follow-up); the CLI explains why if you ask
for it.`
    : 'pseudonymize mode is not yet implemented — this README should not exist for that mode.'
}

Run \`sfi vault anonymize --help\` for the full mode comparison.
`;

/**
 * Export a redacted copy of `opts.vaultRoot` to `opts.outDir`.
 *
 * `--mode redact` (SHIPPED, default): copies `components/`, `docs/`,
 * `source/` (every text file, scrubbed; binary files excluded — see
 * {@link isLikelyBinaryFile}), and an allowlisted subset of `meta/`
 * ({@link META_COPY_ALLOWLIST}). `graph/` and `snapshots/` are never copied.
 * `source/` is included DELIBERATELY (not just `components/`): redact mode
 * keeps API names, so the raw retrieved metadata is exactly as shareable as
 * the rendered markdown once scrubbed — and keeping it lets the recipient
 * run `sfi refresh --no-pull` inside `--out` to regenerate `components/` and
 * `graph/` from the scrubbed source without a network round-trip.
 *
 * `--mode pseudonymize`: refused with {@link PSEUDONYMIZE_NOT_IMPLEMENTED_MESSAGE}.
 *
 * Read-only against `vaultRoot` — every write happens under `outDir`
 * (validated via {@link validateOutDir} before any file touches disk).
 */
export const anonymizeVault = async (
  opts: AnonymizeOptions,
): Promise<Result<AnonymizeSummary, string>> => {
  if (opts.mode === 'pseudonymize') {
    return err(PSEUDONYMIZE_NOT_IMPLEMENTED_MESSAGE);
  }

  const outCheck = validateOutDir(opts.vaultRoot, opts.outDir);
  if (!outCheck.ok) return err(outCheck.error);

  const identitiesResult = await collectVaultIdentities(opts.vaultRoot);
  if (!identitiesResult.ok) return err(identitiesResult.error);
  const identityMap = buildIdentityReplacements(identitiesResult.value);

  const transform = (text: string): string => extendedScrubText(applyReplacements(text, identityMap));

  const paths = vaultPaths(opts.vaultRoot);
  await mkdir(opts.outDir, { recursive: true });

  const stats: CopyStats = { filesWritten: 0, filesSkipped: [] };

  if (existsSync(paths.components)) {
    await copyTextTree(paths.components, join(opts.outDir, 'components'), 'components', transform, stats);
  }
  const docsDir = join(opts.vaultRoot, 'docs');
  if (existsSync(docsDir)) {
    await copyTextTree(docsDir, join(opts.outDir, 'docs'), 'docs', transform, stats);
  }
  if (existsSync(paths.source)) {
    await copyTextTree(paths.source, join(opts.outDir, 'source'), 'source', transform, stats);
  }

  const metaOutDir = join(opts.outDir, 'meta');
  await mkdir(metaOutDir, { recursive: true });
  for (const name of META_COPY_ALLOWLIST) {
    const src = join(paths.meta, name);
    if (!existsSync(src)) continue;
    let raw: string;
    try {
      raw = await readFile(src, 'utf8');
    } catch {
      stats.filesSkipped.push({ path: join('meta', name), reason: 'unreadable' });
      continue;
    }
    const withIdentityFields = transformMetaJsonIdentityFields(name, raw, identityMap);
    await writeFile(join(metaOutDir, name), transform(withIdentityFields), 'utf8');
    stats.filesWritten += 1;
  }

  await writeFile(
    join(opts.outDir, 'README.md'),
    buildAnonymizedReadme(opts.mode, identitiesResult.value.length),
    'utf8',
  );
  stats.filesWritten += 1;

  const residualScan = await residualLeakScan(opts.outDir, identitiesResult.value, opts.forbiddenNamesConfigPath);

  return ok({
    mode: opts.mode,
    outDir: opts.outDir,
    filesWritten: stats.filesWritten,
    filesSkipped: stats.filesSkipped,
    identitiesReplacedCount: identitiesResult.value.length,
    residualScan,
  });
};

// =============================================================================
// CLI registration
// =============================================================================

/**
 * Register `sfi vault anonymize` as a sibling of the existing `sfi vault git
 * *` subcommands. Called from {@link registerVaultCommand} in `vault-git.ts`
 * (the module that owns the `vault` command GROUP) so both live under one
 * `sfi vault …` namespace without two competing `program.command('vault')`
 * registrations.
 */
export const registerVaultAnonymizeSubcommand = (vault: Command): void => {
  vault
    .command('anonymize')
    .description(
      "Export a redacted copy of this vault to --out for external sharing (consultant / support / demo). " +
        "'redact' (default) scrubs org identity + free text (emails, URLs, Salesforce record ids, phone numbers) but KEEPS component/field API names — the residual risk (API names may themselves be identifying) is disclosed in the generated README.md. " +
        "'pseudonymize' would ALSO replace custom API names with a stable non-reversible mapping kept in a SEPARATE file outside --out — NOT YET IMPLEMENTED; the command explains why and exits non-zero rather than half-doing it. " +
        'graph/ (DuckDB) and snapshots/ are never copied — rebuild the graph locally with `sfi refresh --no-pull` inside --out. Read-only against the source vault; --out must be a directory outside it. Prints a residual-scan summary before exiting.',
    )
    .requiredOption('--out <dir>', 'output directory for the redacted copy (must be outside the source vault)')
    .option('--mode <mode>', "'redact' (default, keeps API names) or 'pseudonymize' (not yet implemented)", 'redact')
    .action(async (flags: { out: string; mode: string }): Promise<void> => {
      if (flags.mode !== 'redact' && flags.mode !== 'pseudonymize') {
        process.stderr.write(`--mode must be 'redact' or 'pseudonymize', got '${flags.mode}'.\n`);
        process.exitCode = 1;
        return;
      }
      if (flags.mode === 'pseudonymize') {
        process.stderr.write(`${PSEUDONYMIZE_NOT_IMPLEMENTED_MESSAGE}\n`);
        process.exitCode = 1;
        return;
      }
      const config = await loadVaultConfig(process.cwd());
      if (!config.ok) {
        process.stderr.write(`${config.error}\n`);
        process.exitCode = 1;
        return;
      }
      const outDir = resolve(process.cwd(), flags.out);
      const forbiddenNamesConfigPath = resolve(process.cwd(), 'scripts', 'forbidden-names.local.json');
      const result = await anonymizeVault({
        vaultRoot: config.value.vaultRoot,
        outDir,
        mode: 'redact',
        ...(existsSync(forbiddenNamesConfigPath) ? { forbiddenNamesConfigPath } : {}),
      });
      if (!result.ok) {
        process.stderr.write(`${result.error}\n`);
        process.exitCode = 1;
        return;
      }
      const s = result.value;
      const localCheckNote =
        s.residualScan.localOrgNamePatternsChecked > 0
          ? ` (incl. ${s.residualScan.localOrgNamePatternsChecked.toString()} local org-name pattern(s))`
          : ' (no local org-name pattern config found — identity + generic-pattern checks only)';
      process.stdout.write(
        `Wrote ${s.filesWritten.toString()} file(s) to ${s.outDir} (mode: ${s.mode}).\n` +
          (s.filesSkipped.length > 0
            ? `${s.filesSkipped.length.toString()} file(s) skipped (binary/unreadable) — see README.md and the CLI output above for reasons.\n`
            : '') +
          `Residual scan: ${s.residualScan.findings.length.toString()} match(es) across ${s.residualScan.filesScanned.toString()} file(s)${localCheckNote}.\n` +
          (s.residualScan.findings.length === 0
            ? '0 residual matches — safe to share, but re-read README.md\'s residual-risk note (API names are kept in redact mode).\n'
            : `WARNING: residual matches found — review before sharing:\n${s.residualScan.findings
                .slice(0, 20)
                .map((f) => `  [${f.pattern}] ${f.file}`)
                .join('\n')}\n`),
      );
    });
};
