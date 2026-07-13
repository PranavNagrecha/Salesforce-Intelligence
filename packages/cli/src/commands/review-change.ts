/**
 * The `sfi review-change` CLI subcommand (R6-16).
 *
 * A daily deploy gate: assemble a CHANGE SET from a `package.xml` manifest or a
 * `git diff`, resolve it against the CURRENT vault, and print an ordered risk
 * report. Exits 1 when ANY component is `blocking` — that is what makes it a CI
 * gate; exits 0 otherwise.
 *
 * The command is a thin shim around the `sfi.review_change` MCP handler:
 *
 *   1. Assemble `components: [{ type, apiName, changeKind }]` from either
 *      `--manifest <package.xml>` (changeKind is UNKNOWN from a manifest alone,
 *      so every member is `modified` with a disclosure) or `--diff <base>` (run
 *      `git diff --name-status <base>` in `--project <dir>` and map each path →
 *      `{ type, apiName, changeKind }` by REUSING the refresh pipeline's
 *      `componentTypeFromSourcePath` dispatcher — not a copy).
 *   2. Build an MCP `Context` against the vault (`--vault <path>`, default
 *      `./org-kb`) and dispatch `sfi.review_change`.
 *   3. Render markdown (default) or `--json`.
 *
 * HONESTY: the analysis is against the LAST VAULT REFRESH of the TARGET org,
 * which may have drifted from what is actually deployed. That boundary is
 * printed on every run and carried in the handler's `disclosure`.
 *
 * CROSS-VAULT (`--against <alias|path>`, R7-C2): pass a registered vault alias
 * or a path to an org-kb to review the changeset against THAT vault's graph
 * instead of `--vault` — the release-manager "will this break PROD?" question.
 * The flag is handed to `sfi.review_change`'s `againstVault`; the exit-1 gate
 * then blocks on breakage in the named vault, and the report discloses the
 * target vault, ids absent from it, and a product-version caveat.
 *
 * PR-NATIVE OUTPUT (`--format sarif|markdown-comment`, Finding #37): two
 * additional renderers, `renderReviewChangeSarif` and
 * `renderReviewChangeMarkdownComment`, are PURE TRANSFORMS over the SAME
 * `ReviewChangeCliPayload` `runReviewChange` already produces — no new
 * analysis, no extra vault reads. `--format sarif` emits SARIF 2.1.0 JSON
 * (uploadable to GitHub code scanning); `--format markdown-comment` emits a
 * compact PR-comment-friendly summary (postable via `gh pr comment`). The
 * default human report and `--json` are unchanged. Exit codes (0 clean / 1
 * blocking / 2 usage-or-environment error) are identical across every format
 * — the CI gate does not depend on which one a caller chose.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

import { err, ok, type Result } from '@sf-intelligence/core';
import {
  buildContext,
  dispatchTool,
  shutdown,
  type Context,
} from '@sf-intelligence/mcp';
import { Command } from 'commander';
import { XMLParser } from 'fast-xml-parser';

import { readCliPackageVersion } from '../package-version.js';
import { BUNDLE_PARENT_DIRS, componentTypeFromSourcePath } from '../refresh-pipeline.js';

/** JSON indentation, 2 spaces, matches the rest of the CLI. */
const JSON_INDENT = 2;

const nodeExecFile = promisify(execFile);

/** The three change kinds the handler understands. */
export type ChangeKind = 'added' | 'modified' | 'deleted';

/** One assembled change-set entry the handler reviews. */
export interface ChangeComponent {
  readonly type: string;
  readonly apiName: string;
  readonly changeKind: ChangeKind;
}

/** Error variants surfaced from the `sfi review-change` handler. */
export interface ReviewChangeCommandError {
  readonly kind:
    | 'no-input'
    | 'empty-change-set'
    | 'manifest-read-failed'
    | 'diff-failed'
    | 'vault-not-opened'
    | 'dispatch-failed';
  readonly message: string;
}

// ---------------------------------------------------------------------------
// package.xml parsing
// ---------------------------------------------------------------------------

/** Coerce a fast-xml-parser value that may be a scalar, array, or absent to an array. */
const toArray = <T>(value: T | readonly T[] | undefined): readonly T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value as T];

/**
 * Parse a `package.xml` string into a change set. Every `<members>` under a
 * `<types><name>` becomes one `{ type: <name>, apiName: <member>, changeKind:
 * 'modified' }` entry — a manifest names WHICH components a deploy touches but
 * NOT how, so `modified` is the only honest default (surfaced as a disclosure
 * by the caller). Wildcard (`*`) members cannot be enumerated offline and are
 * collected into `wildcardTypes` so the caller can disclose the gap rather than
 * silently drop them.
 *
 * @example
 *   parseManifestComponents('<Package><types><members>Acme</members>' +
 *     '<name>ApexClass</name></types></Package>')
 *   // => { components: [{ type: 'ApexClass', apiName: 'Acme', changeKind: 'modified' }], wildcardTypes: [] }
 */
export const parseManifestComponents = (
  xml: string,
): { components: readonly ChangeComponent[]; wildcardTypes: readonly string[] } => {
  const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
  const parsed = parser.parse(xml) as {
    Package?: { types?: unknown };
  };
  const typesBlocks = toArray(parsed.Package?.types) as ReadonlyArray<{
    name?: unknown;
    members?: unknown;
  }>;
  const components: ChangeComponent[] = [];
  const wildcardTypes: string[] = [];
  for (const block of typesBlocks) {
    const name = typeof block.name === 'string' ? block.name.trim() : '';
    if (name === '') continue;
    const members = toArray(block.members as string | string[] | undefined);
    for (const rawMember of members) {
      const member = String(rawMember).trim();
      if (member === '') continue;
      if (member === '*') {
        if (!wildcardTypes.includes(name)) wildcardTypes.push(name);
        continue;
      }
      components.push({ type: name, apiName: member, changeKind: 'modified' });
    }
  }
  return { components, wildcardTypes };
};

// ---------------------------------------------------------------------------
// git diff path mapping
// ---------------------------------------------------------------------------

/** Map a `git diff --name-status` status letter to a change kind. */
const statusToChangeKind = (status: string): ChangeKind => {
  const head = status.charAt(0).toUpperCase();
  if (head === 'A') return 'added';
  if (head === 'D') return 'deleted';
  if (head === 'C') return 'added'; // a copy creates a new component
  // M (modified), R (rename → treat the new path as a modify), T (type change),
  // and anything unexpected all fold to the safe `modified` default.
  return 'modified';
};

/**
 * Derive the `{ type, apiName }` a source-tree path resolves to, REUSING the
 * refresh pipeline's `componentTypeFromSourcePath` dispatcher for the TYPE and
 * deriving the vault-canonical api name to match the id format the extractors
 * emit (`{Type}:{Object}.{Name}` for object-nested types, `{Type}:{Name}`
 * otherwise, bundle dir basename for LWC/Aura). Returns null when the path is
 * not a recognised metadata source file (docs, `sfdx-project.json`, a bundle's
 * unhandled child, …) so the caller can skip it.
 *
 * Bundles: `git diff` reports FILES inside an `lwc/`/`aura/` bundle, but the
 * dispatcher's bundle branch keys on the bundle DIRECTORY. So when a path lives
 * under `lwc/{bundle}/…` or `aura/{bundle}/…`, we truncate to the bundle dir and
 * dispatch THAT (with `isDirectory: true`) — collapsing every changed file in a
 * bundle to the one bundle component.
 */
export const deriveComponentFromPath = (
  relPath: string,
): { type: string; apiName: string } | null => {
  const segments = relPath.split('/').filter((s) => s !== '');
  if (segments.length === 0) return null;

  // Bundle short-circuit. `git diff` reports FILES inside an lwc/aura bundle,
  // but the graph models the bundle as ONE component keyed by the bundle-dir
  // basename — so every changed file collapses to that component. Truncate
  // the path to the bundle directory itself and hand THAT to the shared
  // `componentTypeFromSourcePath` dispatcher with `isDirectory: true` (fixed
  // under R6-29 to resolve bundle dirs correctly) rather than duplicating the
  // dispatch matrix's type mapping here.
  for (const bundleDir of BUNDLE_PARENT_DIRS) {
    const idx = segments.indexOf(bundleDir);
    if (idx !== -1 && idx + 1 < segments.length) {
      const bundleName = segments[idx + 1];
      if (bundleName === undefined || bundleName === '') continue;
      const bundlePath = segments.slice(0, idx + 2).join('/');
      const type = componentTypeFromSourcePath('', bundlePath, true);
      if (type !== null) return { type, apiName: bundleName };
    }
  }

  const type = componentTypeFromSourcePath('', relPath, false);
  if (type === null) return null;

  const fileName = segments[segments.length - 1] ?? '';
  // The api-name portion is the basename up to its FIRST dot — correct for
  // every single-name metadata file (`OrderService.cls`, `My_Flow.flow-meta.xml`,
  // `Industry__c.field-meta.xml`, `Account.object-meta.xml`).
  const localName = fileName.split('.')[0] ?? fileName;

  const objIdx = segments.indexOf('objects');
  if (objIdx !== -1 && objIdx + 1 < segments.length) {
    const objectName = segments[objIdx + 1] ?? '';
    if (type === 'CustomObject') return { type, apiName: objectName };
    // Object-nested types (CustomField, ValidationRule, RecordType, …) scope
    // their id to the parent object: `{Object}.{Name}`.
    return { type, apiName: `${objectName}.${localName}` };
  }

  return { type, apiName: localName };
};

/**
 * Parse `git diff --name-status <base>` output into a de-duplicated change set.
 * Each line is `STATUS\tPATH` (or `R###\tOLD\tNEW` / `C###\tOLD\tNEW` — the LAST
 * tab-separated field is the current path). Paths the dispatcher does not
 * recognise are dropped. A path that maps to a component already seen keeps the
 * FIRST change kind (a bundle's many files collapse to one entry).
 */
export const parseDiffComponents = (diffOutput: string): readonly ChangeComponent[] => {
  const seen = new Map<string, ChangeComponent>();
  for (const rawLine of diffOutput.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const fields = line.split('\t').filter((f) => f !== '');
    if (fields.length < 2) continue;
    const status = fields[0] ?? '';
    const path = fields[fields.length - 1] ?? '';
    const derived = deriveComponentFromPath(path);
    if (derived === null) continue;
    const id = `${derived.type}:${derived.apiName}`;
    if (seen.has(id)) continue;
    seen.set(id, {
      type: derived.type,
      apiName: derived.apiName,
      changeKind: statusToChangeKind(status),
    });
  }
  return [...seen.values()];
};

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

/** Options accepted by `runReviewChange`. */
export interface RunReviewChangeOptions {
  /** Absolute vault root (org-kb dir) to resolve the change set against. */
  readonly vaultRoot: string;
  /** The assembled change set. Must be non-empty. */
  readonly components: readonly ChangeComponent[];
  /** Optional cap on the detailed reviewed rows. */
  readonly limit?: number;
  /**
   * Optional registered vault alias OR path to an org-kb: review the changeset
   * against THAT vault's dependency graph (e.g. PROD) instead of `vaultRoot`.
   * Passed through verbatim to `sfi.review_change`'s `againstVault`.
   */
  readonly againstVault?: string;
}

/** The `sfi.review_change` payload shape the CLI renders (subset). */
export interface ReviewChangeCliPayload {
  readonly reviewed: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly apiName: string;
    readonly changeKind: ChangeKind;
    readonly verdict: string;
    readonly reason: string;
    readonly inVault: boolean;
    readonly dependentCount: number;
    readonly dependents: readonly string[];
    readonly selectedTests: readonly string[];
    readonly testCoverage: string;
  }>;
  readonly overallVerdict: string;
  readonly summary: {
    readonly total: number;
    readonly blocking: number;
    readonly risky: number;
    readonly review: number;
    readonly safe: number;
    readonly testsToRun: number;
    readonly uncoveredApex: number;
    readonly notInVault: number;
    readonly truncated: boolean;
  };
  readonly selectedTests: readonly string[];
  readonly recommendation: string;
  readonly coverageCaveat?: { readonly message: string };
  readonly disclosure: string;
  readonly boundaries: readonly string[];
  /** Present only in `--against` mode — the vault the review was computed against. */
  readonly againstVault?: {
    readonly alias: string;
    readonly path: string;
    readonly resolvedFrom: string;
    readonly lastRefreshedAt: string | null;
    readonly sourceTreeHash: string | null;
  };
  /** Present only in `--against` mode — modified/deleted ids absent from the target. */
  readonly absentInAgainstVault?: readonly string[];
  /** Present only when the current and against vaults' product versions differ. */
  readonly extractorVersionCaveat?: string;
}

/**
 * Parse the JSON envelope `dispatchTool` returns (identical helper shape to the
 * other CLI shims — each tool response lives in `content[0].text`).
 */
const parseEnvelope = (
  content: ReadonlyArray<{ type: string; text?: string }>,
): { data: Record<string, unknown> } | { error: unknown } => {
  const first = content[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`unexpected content[0] shape: ${JSON.stringify(content)}`);
  }
  return JSON.parse(first.text) as { data: Record<string, unknown> } | { error: unknown };
};

/**
 * Build an MCP `Context` against the vault and dispatch `sfi.review_change`.
 * Does NOT render — that is `renderReviewChange`'s job, so the driver stays
 * testable without a terminal.
 */
export const runReviewChange = async (
  opts: RunReviewChangeOptions,
): Promise<Result<ReviewChangeCliPayload, ReviewChangeCommandError>> => {
  if (opts.components.length === 0) {
    return err({
      kind: 'empty-change-set',
      message:
        'No reviewable components were found. A manifest of only wildcard members, or a diff touching no recognised metadata source, yields an empty change set.',
    });
  }
  let ctx: Context | null = null;
  try {
    const ctxResult = await buildContext(opts.vaultRoot);
    if (!ctxResult.ok) {
      return err({
        kind: 'vault-not-opened',
        message:
          `failed to open vault at '${opts.vaultRoot}': ${ctxResult.error.message}. ` +
          'Run `sfi init` + `sfi refresh`, or point `--vault <path>` at an existing org-kb.',
      });
    }
    ctx = ctxResult.value;
    const dispatched = await dispatchTool(ctx, 'sfi.review_change', {
      components: opts.components,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.againstVault !== undefined ? { againstVault: opts.againstVault } : {}),
    });
    const envelope = parseEnvelope(dispatched.content);
    if ('error' in envelope) {
      return err({
        kind: 'dispatch-failed',
        message: `sfi.review_change dispatch error: ${JSON.stringify(envelope.error)}`,
      });
    }
    return ok(envelope.data as unknown as ReviewChangeCliPayload);
  } finally {
    if (ctx !== null) await shutdown(ctx);
  }
};

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const VERDICT_MARK: Readonly<Record<string, string>> = {
  blocking: 'BLOCK',
  risky: 'RISKY',
  review: 'REVIEW',
  unknown: 'REVIEW',
  safe: 'ok',
};

/**
 * Render a `ReviewChangeCliPayload` as a terminal-friendly markdown report.
 * The header carries the overall verdict + recommendation; a table lists each
 * component (most-dangerous first); the disclosures print verbatim last.
 */
export const renderReviewChange = (
  payload: ReviewChangeCliPayload,
  extraDisclosures: readonly string[] = [],
): string => {
  const lines: string[] = [];
  lines.push(
    `# Change review — overall: ${payload.overallVerdict.toUpperCase()}`,
    '',
  );
  if (payload.againstVault !== undefined) {
    const av = payload.againstVault;
    lines.push(
      `AGAINST VAULT: '${av.alias}' (${av.resolvedFrom}, last refresh ${av.lastRefreshedAt ?? 'unknown'}) — impact is vs THAT vault's graph, NOT the current one.`,
      '',
    );
  }
  lines.push(
    payload.recommendation,
    '',
    'Summary',
    '-------',
    `Total:     ${payload.summary.total}`,
    `Blocking:  ${payload.summary.blocking}`,
    `Risky:     ${payload.summary.risky}`,
    `Review:    ${payload.summary.review}`,
    `Safe:      ${payload.summary.safe}`,
    `Tests to run: ${payload.summary.testsToRun}` +
      (payload.summary.uncoveredApex > 0
        ? ` (${payload.summary.uncoveredApex} changed Apex class(es) reached by NO test)`
        : ''),
    '',
    'Components (most dangerous first)',
    '---------------------------------',
  );
  if (payload.reviewed.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of payload.reviewed) {
      const mark = VERDICT_MARK[c.verdict] ?? c.verdict;
      lines.push(`[${mark}] ${c.id}  (${c.changeKind})`);
      lines.push(`    ${c.reason}`);
      if (c.dependentCount > 0) {
        const sample = c.dependents.slice(0, 5).join(', ');
        lines.push(
          `    dependents: ${c.dependentCount}${sample !== '' ? ` (e.g. ${sample})` : ''}`,
        );
      }
      if (c.selectedTests.length > 0) {
        lines.push(`    tests: ${c.selectedTests.slice(0, 5).join(', ')}`);
      }
    }
    if (payload.summary.truncated) {
      lines.push(
        `... (${payload.summary.total - payload.reviewed.length} more not shown — raise --limit or use --json)`,
      );
    }
  }
  if (
    payload.absentInAgainstVault !== undefined &&
    payload.absentInAgainstVault.length > 0
  ) {
    lines.push(
      '',
      'Absent from the against-vault (added relative to it; own contents NOT analysed)',
      '------------------------------------------------------------------------------',
    );
    for (const id of payload.absentInAgainstVault) lines.push(`- ${id}`);
  }
  lines.push('', 'Boundaries', '----------');
  for (const d of extraDisclosures) lines.push(`- ${d}`);
  if (payload.extractorVersionCaveat !== undefined) {
    lines.push(`- ${payload.extractorVersionCaveat}`);
  }
  if (payload.coverageCaveat !== undefined) {
    lines.push(`- ${payload.coverageCaveat.message}`);
  }
  for (const b of payload.boundaries) lines.push(`- ${b}`);
  lines.push('');
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// SARIF 2.1.0 output (`--format sarif`, Finding #37)
// ---------------------------------------------------------------------------

/** SARIF 2.1.0 schema URL emitted verbatim as every report's `$schema`. */
const SARIF_SCHEMA_URL =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json';

/** `tool.driver.name` every emitted SARIF report carries. */
const SARIF_TOOL_NAME = 'sfi-review-change';

/** The three SARIF-eligible risk categories a `reviewed[]` verdict folds into. */
type SarifRuleKey = 'blocking' | 'risky' | 'review';

/**
 * Maps every `Verdict` (`blocking` | `risky` | `review` | `safe` | `unknown`,
 * from `@sf-intelligence/mcp`'s `coverage-trust.ts`) to the SARIF rule it
 * becomes. `unknown` folds into `review` — the same fold the CLI's own
 * `VERDICT_MARK` table applies (both render as `REVIEW` in the human report).
 * `safe` is intentionally ABSENT: a code-scanning result list is a list of
 * FINDINGS, and a `safe` component is the absence of one — emitting it as a
 * `note` would flood a clean PR with hundreds of non-findings and bury the
 * real ones. The full `safe` count is still visible in `runs[].properties`.
 */
const SARIF_RULE_FOR_VERDICT: Readonly<Record<string, SarifRuleKey>> = {
  blocking: 'blocking',
  risky: 'risky',
  review: 'review',
  unknown: 'review',
};

/** SARIF `level` per rule — spans all three non-`none` severities the spec defines. */
const SARIF_LEVEL_FOR_RULE: Readonly<Record<SarifRuleKey, 'error' | 'warning' | 'note'>> = {
  blocking: 'error',
  risky: 'warning',
  review: 'note',
};

/** `id` / `name` / description text for each SARIF rule, in stable declaration order. */
const SARIF_RULES: ReadonlyArray<{
  readonly id: SarifRuleKey;
  readonly name: string;
  readonly shortDescription: string;
  readonly fullDescription: string;
}> = [
  {
    id: 'blocking',
    name: 'BlockingChange',
    shortDescription: 'Deploy-blocking change',
    fullDescription:
      'A deleted component (or an added component whose id collides with an existing one) has at least one surviving dependent — deploying this change would break it. Even a heuristic-only dependent blocks: a gate fails closed rather than risk a false "safe".',
  },
  {
    id: 'risky',
    name: 'RiskyChange',
    shortDescription: 'Modified component with firm dependents',
    fullDescription:
      'A modified component has at least one dependent reached via a declared/parsed (non-heuristic) edge — a real caller or automation may break. Verify the listed dependents and run the selected tests before deploying.',
  },
  {
    id: 'review',
    name: 'ReviewChange',
    shortDescription: 'Needs manual review',
    fullDescription:
      'The verdict could not be resolved to safe or risky automatically: the vault does not contain this component under its declared change kind, its only dependents are heuristic, or its family is not fully covered by the vault — confirm manually.',
  },
];

/**
 * Build a SARIF `artifactLocation.uri` from a component id (`{type}:{apiName}`,
 * e.g. `ApexClass:OrderService` or `CustomField:Account.Industry__c`). PURE —
 * no filesystem lookup: `ReviewChangeCliPayload` does not carry a real source
 * path (a `--diff`-derived review resolves each changed path down to a
 * `{type, apiName}` component before `runReviewChange` ever sees it, and the
 * original path is discarded — see `parseDiffComponents`), so the location
 * is the component's own type/apiName address, not a repo-relative file path.
 */
const sarifArtifactUri = (id: string): string => id.replace(':', '/');

/**
 * Render a `ReviewChangeCliPayload` as SARIF 2.1.0 JSON — a PURE TRANSFORM
 * over the existing analysis result (no new analysis, no additional vault
 * reads). Uploadable to GitHub code scanning
 * (`github/codeql-action/upload-sarif`) or any SARIF 2.1.0 viewer.
 *
 * `blocking` → `error`, `risky` → `warning`, `review`/`unknown` → `note`;
 * `safe` components are not emitted as results (see `SARIF_RULE_FOR_VERDICT`
 * doc) though the full `safe` count survives in `runs[].properties.summary`.
 *
 * @example
 *   const sarif = JSON.parse(renderReviewChangeSarif(payload, '0.2.0'));
 *   sarif.runs[0].results[0].level // 'error' for a blocking component
 */
export const renderReviewChangeSarif = (
  payload: ReviewChangeCliPayload,
  toolVersion: string,
): string => {
  const ruleIndexOf: Readonly<Record<SarifRuleKey, number>> = {
    blocking: 0,
    risky: 1,
    review: 2,
  };
  const rules = SARIF_RULES.map((r) => ({
    id: r.id,
    name: r.name,
    shortDescription: { text: r.shortDescription },
    fullDescription: { text: r.fullDescription },
    defaultConfiguration: { level: SARIF_LEVEL_FOR_RULE[r.id] },
  }));

  const results = payload.reviewed
    .filter((c) => c.verdict !== 'safe')
    .map((c) => {
      const ruleId = SARIF_RULE_FOR_VERDICT[c.verdict] ?? 'review';
      return {
        ruleId,
        ruleIndex: ruleIndexOf[ruleId],
        level: SARIF_LEVEL_FOR_RULE[ruleId],
        message: { text: c.reason },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: sarifArtifactUri(c.id) },
            },
          },
        ],
        partialFingerprints: { sfiComponentId: c.id },
        properties: {
          changeKind: c.changeKind,
          verdict: c.verdict,
          dependentCount: c.dependentCount,
          testCoverage: c.testCoverage,
        },
      };
    });

  const sarif = {
    $schema: SARIF_SCHEMA_URL,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            informationUri: 'https://sfi.auditforce.cloud',
            version: toolVersion,
            rules,
          },
        },
        results,
        properties: {
          overallVerdict: payload.overallVerdict,
          summary: payload.summary,
          disclosure: payload.disclosure,
        },
      },
    ],
  };
  return `${JSON.stringify(sarif, null, JSON_INDENT)}\n`;
};

// ---------------------------------------------------------------------------
// PR-comment markdown output (`--format markdown-comment`, Finding #37)
// ---------------------------------------------------------------------------

/** Escape a table cell so an embedded `|` cannot break the markdown table. */
const escapeMarkdownCell = (text: string): string => text.replace(/\|/g, '\\|');

/**
 * Render a `ReviewChangeCliPayload` as a compact PR-comment-friendly markdown
 * summary — a PURE TRANSFORM over the same payload `renderReviewChange`
 * renders, just laid out for a GitHub PR comment body: a one-line verdict
 * header, the recommendation, a tally, a per-component table (most dangerous
 * first, same order as the human report), and the boundaries collapsed behind
 * a `<details>` so the disclosures don't dominate the comment.
 *
 * @example
 *   const body = renderReviewChangeMarkdownComment(payload, disclosures);
 *   // gh pr comment <n> --body-file <(printf '%s' "$body")
 */
export const renderReviewChangeMarkdownComment = (
  payload: ReviewChangeCliPayload,
  extraDisclosures: readonly string[] = [],
): string => {
  const lines: string[] = [];
  lines.push(`### sfi review-change — ${payload.overallVerdict.toUpperCase()}`, '');
  if (payload.againstVault !== undefined) {
    const av = payload.againstVault;
    lines.push(
      `_Against vault \`${av.alias}\` (${av.resolvedFrom}, last refresh ${av.lastRefreshedAt ?? 'unknown'}) — impact is vs THAT vault's graph, not the current one._`,
      '',
    );
  }
  lines.push(payload.recommendation, '');
  lines.push(
    `**${payload.summary.blocking} blocking**, ${payload.summary.risky} risky, ` +
      `${payload.summary.review} review, ${payload.summary.safe} safe (${payload.summary.total} total)` +
      (payload.summary.testsToRun > 0 ? ` — ${payload.summary.testsToRun} test(s) to run` : ''),
    '',
  );
  if (payload.reviewed.length > 0) {
    lines.push('| | Component | Change | Reason |', '|---|---|---|---|');
    for (const c of payload.reviewed) {
      const mark = VERDICT_MARK[c.verdict] ?? c.verdict;
      lines.push(
        `| ${mark} | \`${c.id}\` | ${c.changeKind} | ${escapeMarkdownCell(c.reason)} |`,
      );
    }
    if (payload.summary.truncated) {
      lines.push(
        '',
        `_... ${payload.summary.total - payload.reviewed.length} more not shown — raise --limit or use --json._`,
      );
    }
  }
  if (
    payload.absentInAgainstVault !== undefined &&
    payload.absentInAgainstVault.length > 0
  ) {
    lines.push(
      '',
      '**Absent from the against-vault** (added relative to it; own contents not analysed): ' +
        payload.absentInAgainstVault.map((id) => `\`${id}\``).join(', '),
    );
  }
  const boundaries = [
    ...extraDisclosures,
    ...(payload.extractorVersionCaveat !== undefined ? [payload.extractorVersionCaveat] : []),
    ...(payload.coverageCaveat !== undefined ? [payload.coverageCaveat.message] : []),
    ...payload.boundaries,
  ];
  lines.push(
    '',
    '<details><summary>Boundaries</summary>',
    '',
    ...boundaries.map((b) => `- ${b}`),
    '',
    '</details>',
    '',
  );
  return lines.join('\n');
};

/**
 * Minimal `ReviewChangeCliPayload` used ONLY for the empty-change-set early
 * exit: when `--manifest`/`--diff` yields NO reviewable components,
 * `runReviewChange` is never called (it rejects an empty change set), so
 * `--format sarif` / `--format markdown-comment` need a payload shape to
 * render rather than silently falling back to the plain-text notice — a
 * `sarif` upload step expecting JSON, or a PR-comment step expecting
 * markdown, would otherwise break on a genuinely empty diff.
 */
const emptyChangeSetPayload = (disclosures: readonly string[]): ReviewChangeCliPayload => ({
  reviewed: [],
  overallVerdict: 'safe',
  summary: {
    total: 0,
    blocking: 0,
    risky: 0,
    review: 0,
    safe: 0,
    testsToRun: 0,
    uncoveredApex: 0,
    notInVault: 0,
    truncated: false,
  },
  selectedTests: [],
  recommendation: 'No reviewable components were found in the change set — nothing to gate.',
  disclosure:
    'No reviewable components were found (empty or wildcard-only change set); no analysis was performed.',
  boundaries: disclosures,
});

// ---------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------

/** The `--format` values `sfi review-change` accepts beyond the default human report. */
const REVIEW_CHANGE_FORMATS = ['sarif', 'markdown-comment'] as const;
type ReviewChangeFormat = (typeof REVIEW_CHANGE_FORMATS)[number];

/** Flag shape for `sfi review-change`. */
interface ReviewChangeCliFlags {
  readonly manifest?: string;
  readonly diff?: string;
  readonly project?: string;
  readonly vault?: string;
  readonly against?: string;
  readonly limit?: string;
  readonly json?: boolean;
  readonly format?: string;
}

/** Read a `package.xml` and assemble its change set. */
const componentsFromManifest = async (
  manifestPath: string,
): Promise<
  Result<{ components: readonly ChangeComponent[]; disclosures: readonly string[] }, ReviewChangeCommandError>
> => {
  let xml: string;
  try {
    xml = await readFile(manifestPath, 'utf8');
  } catch (cause) {
    return err({
      kind: 'manifest-read-failed',
      message: `could not read manifest '${manifestPath}': ${(cause as Error).message}`,
    });
  }
  const { components, wildcardTypes } = parseManifestComponents(xml);
  const disclosures: string[] = [
    `Change kinds are UNKNOWN from a manifest alone — all ${components.length} member(s) from '${basename(manifestPath)}' are reviewed as 'modified'. Deletions in a destructiveChanges.xml are NOT distinguished here; use --diff for add/modify/delete fidelity.`,
  ];
  if (wildcardTypes.length > 0) {
    disclosures.push(
      `Wildcard (*) members cannot be enumerated offline — ${wildcardTypes.length} type(s) skipped: ${wildcardTypes.join(', ')}.`,
    );
  }
  return ok({ components, disclosures });
};

/** Run `git diff --name-status <base>` in the project dir and assemble the set. */
const componentsFromDiff = async (
  base: string,
  projectDir: string,
): Promise<
  Result<{ components: readonly ChangeComponent[]; disclosures: readonly string[] }, ReviewChangeCommandError>
> => {
  let stdout: string;
  try {
    const run = await nodeExecFile('git', ['diff', '--name-status', base], {
      cwd: projectDir,
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = run.stdout;
  } catch (cause) {
    return err({
      kind: 'diff-failed',
      message:
        `\`git diff --name-status ${base}\` failed in '${projectDir}': ${(cause as Error).message}. ` +
        'Pass a valid base ref and a --project dir that is an sfdx git working tree.',
    });
  }
  const components = parseDiffComponents(stdout);
  const disclosures: string[] = [
    `Change set derived from \`git diff --name-status ${base}\` in '${projectDir}'; paths mapped via the refresh dispatcher. Renames are reviewed as 'modified' of the new path.`,
  ];
  return ok({ components, disclosures });
};

/**
 * Register the `sfi review-change` subcommand on `program`. Exits 1 when any
 * component is `blocking` (the CI gate); exits 0 on a clean review; exits 2 on
 * a usage / environment error (no input source, unreadable manifest, failed
 * diff, unopened vault, dispatch error).
 *
 * @example
 *   registerReviewChangeCommand(new Command());
 */
export const registerReviewChangeCommand = (program: Command): void => {
  program
    .command('review-change')
    .description(
      'Pre-deploy change review over a package.xml or git diff (CI gate: exits 1 if any change is blocking). ' +
        'Analysis is against the LAST VAULT REFRESH of the target vault, which may drift from prod — always disclosed in the output. ' +
        'Pass --against <alias|path> to review the changeset against a DIFFERENT vault (e.g. PROD): every dependent, verdict and test is then computed against THAT vault\'s last refresh, and the exit-1 gate blocks on breakage in THAT vault. ' +
        'Pass --format sarif or --format markdown-comment for PR-native output (SARIF 2.1.0 for code scanning, or a compact PR-comment summary) instead of the human report — same exit codes either way.',
    )
    .option('--manifest <package.xml>', 'Review the components named in a package.xml (all reviewed as modified)')
    .option('--diff <base>', 'Review the components changed since <base> via `git diff --name-status`')
    .option('--project <dir>', 'sfdx project working tree for --diff (default: current directory)')
    .option('--vault <path>', 'org-kb vault to resolve against (default: ./org-kb)')
    .option(
      '--against <alias|path>',
      "Review against a DIFFERENT vault's graph (a registered alias or a path to an org-kb) — impact/verdict is vs THAT vault's last refresh (e.g. PROD), not --vault. Discloses the target, absent-in-target ids, and a product-version caveat.",
    )
    .option('--limit <n>', 'Cap the number of detailed component rows (summary tallies stay full)')
    .option('--json', 'Print the raw ReviewChangeOutput as JSON instead of the markdown report', false)
    .option(
      '--format <sarif|markdown-comment>',
      'Emit PR-native output instead of the human report: sarif (SARIF 2.1.0, upload to GitHub code scanning) or markdown-comment (compact summary for a PR comment). Mutually exclusive with --json.',
    )
    .action(async (flags: ReviewChangeCliFlags): Promise<void> => {
      if (flags.manifest === undefined && flags.diff === undefined) {
        process.stderr.write(
          'sfi review-change: pass --manifest <package.xml> OR --diff <base> (with --project <dir>).\n',
        );
        process.exit(2);
      }
      if (flags.manifest !== undefined && flags.diff !== undefined) {
        process.stderr.write('sfi review-change: pass only ONE of --manifest / --diff.\n');
        process.exit(2);
      }
      if (
        flags.format !== undefined &&
        !REVIEW_CHANGE_FORMATS.includes(flags.format as ReviewChangeFormat)
      ) {
        process.stderr.write(
          `sfi review-change: --format must be one of ${REVIEW_CHANGE_FORMATS.join(', ')} (got '${flags.format}').\n`,
        );
        process.exit(2);
      }
      if (flags.format !== undefined && flags.json === true) {
        process.stderr.write('sfi review-change: pass only ONE of --json / --format.\n');
        process.exit(2);
      }

      const assembled =
        flags.manifest !== undefined
          ? await componentsFromManifest(resolve(process.cwd(), flags.manifest))
          : await componentsFromDiff(
              flags.diff ?? '',
              resolve(process.cwd(), flags.project ?? '.'),
            );
      if (!assembled.ok) {
        process.stderr.write(`sfi review-change: ${assembled.error.message}\n`);
        process.exit(2);
      }

      if (assembled.value.components.length === 0) {
        if (flags.format === 'sarif') {
          process.stdout.write(
            renderReviewChangeSarif(
              emptyChangeSetPayload(assembled.value.disclosures),
              readCliPackageVersion(),
            ),
          );
        } else if (flags.format === 'markdown-comment') {
          process.stdout.write(
            renderReviewChangeMarkdownComment(emptyChangeSetPayload(assembled.value.disclosures)),
          );
        } else {
          process.stdout.write(
            'sfi review-change: no reviewable components found (empty or wildcard-only change set). Nothing to gate.\n',
          );
          for (const d of assembled.value.disclosures) process.stdout.write(`  - ${d}\n`);
        }
        process.exit(0);
      }

      const limit = flags.limit !== undefined ? Number.parseInt(flags.limit, 10) : undefined;
      const result = await runReviewChange({
        vaultRoot: resolve(process.cwd(), flags.vault ?? 'org-kb'),
        components: assembled.value.components,
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        ...(flags.against !== undefined ? { againstVault: flags.against } : {}),
      });
      if (!result.ok) {
        process.stderr.write(`sfi review-change: ${result.error.message}\n`);
        process.exit(2);
      }

      if (flags.format === 'sarif') {
        process.stdout.write(renderReviewChangeSarif(result.value, readCliPackageVersion()));
      } else if (flags.format === 'markdown-comment') {
        process.stdout.write(
          renderReviewChangeMarkdownComment(result.value, assembled.value.disclosures),
        );
      } else if (flags.json === true) {
        process.stdout.write(`${JSON.stringify(result.value, null, JSON_INDENT)}\n`);
      } else {
        process.stdout.write(renderReviewChange(result.value, assembled.value.disclosures));
      }
      // The CI gate: a blocking change fails the command — SAME exit-code rule
      // regardless of --format.
      process.exit(result.value.summary.blocking > 0 ? 1 : 0);
    });
};
