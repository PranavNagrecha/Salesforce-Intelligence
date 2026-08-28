/**
 * Handler for the `sfi.health_check` MCP tool.
 *
 * Diagnostic — never fails the JSON-RPC dispatch. Instead it inspects
 * the live server state and reports a structured triage payload:
 *   1. Does the vault root exist on disk?
 *   2. Is the graph store still queryable? (probe via a 1-row
 *      `listNodesByType` against `CustomObject`.)
 *   3. Does the on-disk source tree still hash to the value recorded
 *      in the manifest? (Skipped when `source/` is absent — typical
 *      for a fresh clone where the source tree is gitignored.)
 *
 * Result aggregation:
 *   - `unhealthy` if the graph probe failed: clients cannot rely on
 *     any subsequent tool call.
 *   - `degraded` if the graph is fine but at least one issue surfaced
 *     (stale hash, missing source/, vault dir missing).
 *   - `healthy` if nothing is wrong.
 *
 * Beyond the pass/fail verdict, the payload carries a `freshness` block: the
 * vault's age in days, a `stale` flag (age >= a one-week threshold), what the
 * most recent refresh changed (from the history store), and a human `nudge`.
 * The nudge is the offline "yellow flag" so a host never narrates a stale
 * snapshot as current — it is advisory and never changes `status`.
 */

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { compareVersions, ok, type Result, type UpdateCheckResult } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import {
  computeSourceTreeHash,
  readSkippedDirectories,
  summarizeCoverage,
  type CoverageSummary,
  type ExtendedVaultManifest,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import {
  loadRefreshHistory,
  summarizeRecentActivity,
} from '../history-store.js';
import type { Context } from '../server.js';

import {
  buildAssignmentDataCoverage,
  type AssignmentDataCoverage,
} from './coverage-report.js';

/**
 * Age (in whole days) at or above which `health_check` flags the vault as
 * `stale` and emits a freshness nudge. Picked at 7 so a vault refreshed
 * within the last week stays quiet (no false alarm on an actively-maintained
 * vault), while a vault left untouched for a week or more surfaces a yellow
 * flag. The flag is advisory: it never changes `status` (an old vault is not
 * a broken vault), it only populates `freshness.nudge`.
 */
const STALE_AGE_DAYS = 7;

/** Milliseconds in one day, for the freshness age calculation. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * File-count threshold above which a non-empty `skippedDirectories`
 * map flips `health_check` from `healthy` to `degraded`. Picked at
 * 100 so trivial unknowns (a stray `.DS_Store`, a one-off custom
 * directory the admin added by mistake) don't trip the indicator,
 * while real coverage gaps (OmniStudio's hundreds of `omniProcesses`
 * files; thousands of FSL Industries files) reliably do.
 */
const SKIPPED_FILES_DEGRADED_THRESHOLD = 100;

/**
 * Age (in whole days) at or above which an EXISTING assignment-data facts
 * capture (`sfi refresh --with-data-shape`) earns a re-capture advisory in the
 * informational `assignmentData` block. Advisory only — assignment data is
 * live-first BY DESIGN (ENGINE-ARC §6), so neither a missing nor a stale
 * capture ever degrades `status`.
 */
const STALE_FACTS_ADVISORY_DAYS = 30;

/**
 * Zod schema for the `sfi.health_check` tool input. The tool takes no
 * arguments; the schema exists only so `dispatchTool`'s `runTool` helper
 * rejects extraneous fields with the standard `invalid-query` envelope.
 */
export const healthCheckInputSchema = z.object({});

/** Parsed input shape, inferred from `healthCheckInputSchema`. */
export type HealthCheckInput = z.infer<typeof healthCheckInputSchema>;

/**
 * The triage payload returned on success.
 *
 *   - `status`: aggregate verdict, derived from `checks`.
 *   - `issues`: human-readable list of every detected problem. Empty
 *     when `status === 'healthy'`. Order matches the check sequence
 *     so clients can render a stable list.
 *   - `checks`: per-check booleans for programmatic consumers.
 *     `sourceHashMatches` is nullable because it's skipped when
 *     `source/` is missing (common in fresh clones). `renderComplete` is
 *     likewise nullable: `null` when the render-desync probe itself could
 *     not run (query threw or failed) — verified-clean and never-checked
 *     are distinct states, never collapsed into `true`. `uncoveredTypesOk`
 *     becomes `false` when the manifest's skip-counter records more
 *     than `SKIPPED_FILES_DEGRADED_THRESHOLD` files in unknown
 *     directories (architectural-bug-fix observability).
 *   - `reason`: structured cause when `status === 'degraded'`. Empty
 *     string in the healthy / unhealthy paths. Currently a single
 *     enumerant — `"uncovered-types-detected"` — surfaces the
 *     skip-counter degradation; pre-existing degradations
 *     (stale-hash / missing source / missing vault dir) leave
 *     `reason` empty, matching their `issues` strings.
 */
export interface HealthCheckOutput {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly issues: readonly string[];
  readonly checks: Readonly<{
    readonly vaultExists: boolean;
    readonly graphReadable: boolean;
    readonly sourceHashMatches: boolean | null;
    readonly uncoveredTypesOk: boolean;
    /**
     * Whether the rendered vault is consistent with the graph. `false`
     * when the graph holds MORE nodes of some type than the manifest
     * recorded at render time — a partially-rendered vault (e.g. built by
     * older code) where components resolve but have no `.md` file, so
     * `get_component` fails with "vault file missing". A fresh
     * `/sfi-refresh` re-renders everything. `null` when the desync probe
     * itself could not run for one or more recorded types (query threw or
     * failed) — render-completeness is UNVERIFIED, not confirmed clean; a
     * desync cannot be ruled out.
     */
    readonly renderComplete: boolean | null;
  }>;
  readonly coverage: CoverageSummary;
  readonly reason?: 'uncovered-types-detected';
  /**
   * Vault freshness — the yellow flag for stale answers. Always present.
   *
   * `health_check` is OFFLINE: it cannot know what changed in the live org
   * since the last refresh. What it CAN report honestly is (a) how old the
   * vault is, and (b) what the most recent refresh changed (from the
   * continuous-learning history store). It reports those and, when the vault
   * is old or the local source drifted, emits a `nudge` so a host never
   * narrates a stale snapshot as if it were current. To detect actual
   * org-side drift, the nudge points at `sfi.live_drift_check`.
   */
  readonly freshness: HealthFreshness;
  /**
   * Whether local vault git history is enabled (`org-kb/.git`). Advisory —
   * never changes `status`. `enableHint` carries the one-line enable command
   * AND its plain-English value prop ("answer 'when did this change?' from
   * local git history") when disabled, so a host can nudge the user toward the
   * feature; it is `null` once enabled (nothing to prompt).
   */
  readonly vaultHistory: {
    readonly enabled: boolean;
    readonly enableHint: string | null;
  };
  /**
   * P15-PHANTOM-manifest-summary (VAULT-PHANTOM-MANIFEST-SUMMARY) — echo of the
   * refresh-time roll-up of dangling-edge targets by phantom taxonomy bucket
   * (`automation-critical`, `grant-only`, …), written into the manifest by
   * `sfi refresh` (ADR-004 — COUNTS ONLY, never materialized as stub nodes).
   * INFORMATIONAL: never changes `status`. `null` when the last refresh did not
   * compute it — a vault built before the roll-up shipped, or a staged/mid-build
   * manifest. REFRESH-REQUIRED: it populates on the next `sfi refresh`. Gives
   * architects the org-wide phantom picture without an on-demand taxonomy sweep.
   */
  readonly phantomSummary: ExtendedVaultManifest['phantomSummary'] | null;
  /**
   * ENGINE-ARC §6 — runtime assignment data (User / PermissionSetAssignment /
   * GroupMember). INFORMATIONAL ONLY: assignment data is excluded from the
   * vault by design (live-first), so its absence is not a retrieval failure
   * and MUST NOT degrade `status`. `advisory` carries a stale-facts (>30d)
   * re-capture nudge when a counts snapshot exists but has aged — advisory,
   * never an `issues[]` entry (issues flip `status` to degraded).
   */
  readonly assignmentData: AssignmentDataCoverage & {
    readonly advisory: string | null;
  };
}

/** The freshness sub-report of {@link HealthCheckOutput}. */
export interface HealthFreshness {
  /** ISO timestamp the vault was last refreshed (from the manifest). */
  readonly refreshedAt: string;
  /**
   * Whole days between `refreshedAt` and now (floored). `null` when
   * `refreshedAt` is missing or unparseable — never a fabricated 0.
   */
  readonly ageDays: number | null;
  /**
   * `true` when `ageDays >= STALE_AGE_DAYS`. A yellow flag, not a failure:
   * `status` is left unchanged. `false` when fresh or age is unknown.
   */
  readonly stale: boolean;
  /**
   * What the MOST RECENT refresh changed, from the history store
   * (`meta/history.jsonl`). `available: false` for a vault with no recorded
   * history (refreshed once, or before the store shipped). This is "changed
   * AT the last refresh", NOT "changed in the org SINCE" — the offline vault
   * cannot know the latter without `live_drift_check`.
   */
  readonly lastRefresh: {
    readonly available: boolean;
    /** Count of component-type deltas (sum of |added−removed| per type). */
    readonly componentsChanged: number;
  };
  /**
   * Human-readable yellow flag, or `null` when the vault is fresh and the
   * source has not drifted. Never asserts anything about the live org.
   */
  readonly nudge: string | null;
}

/**
 * Build the freshness sub-report. Pure given `manifest`, the history summary,
 * the source-hash check result, and `now`. Extracted so the age threshold and
 * nudge wording have a single home and are unit-testable with a fixed clock.
 */
const buildFreshness = (
  ctx: Context,
  now: number,
  sourceHashMatches: boolean | null,
  recent: ReturnType<typeof summarizeRecentActivity>,
  update: UpdateCheckResult | null,
): HealthFreshness => {
  const refreshedAt = ctx.manifest.refreshedAt;
  const refreshedMs = Date.parse(refreshedAt);
  const ageDays = Number.isNaN(refreshedMs)
    ? null
    : Math.max(0, Math.floor((now - refreshedMs) / MS_PER_DAY));
  const stale = ageDays !== null && ageDays >= STALE_AGE_DAYS;

  const componentsChanged = Object.values(recent.lastRefreshComponentDeltas).reduce(
    (sum, n) => sum + Math.abs(n),
    0,
  );

  // Build the nudge from whichever staleness signals fired. Each clause is
  // honest about its scope: age and source-drift are offline facts; org-side
  // drift is explicitly deferred to live_drift_check.
  const clauses: string[] = [];
  if (stale && ageDays !== null) {
    clauses.push(
      `Vault last refreshed ${refreshedAt} (${ageDays} day${ageDays === 1 ? '' : 's'} ago); answers reflect that snapshot. The org may have changed since — run \`/sfi-refresh\`, or \`sfi.live_stale_check\` for the REAL count of components modified in the org since this refresh (and \`sfi.live_drift_check\` to compare one object's fields against the live org).`,
    );
  }
  if (sourceHashMatches === false) {
    clauses.push(
      'Local source has drifted from the vault (source-tree hash mismatch); run `sfi refresh --no-pull` to rebuild from the current source.',
    );
  }
  // A newer npm build is an advisory yellow flag too — never a failure. Only
  // added when the injected check CONFIRMED an update; a disabled / failed /
  // absent check contributes nothing (a host must not narrate an unconfirmed
  // upgrade). Distinct from the vault-freshness clauses: it is about the
  // installed plugin, not the org snapshot.
  if (update?.shouldUpdate === true && update.latestVersion !== null) {
    clauses.push(
      `A newer sf-intelligence is published on npm (${update.latestVersion}); run \`npm i -g sf-intelligence@latest\` to update the plugin.`,
    );
  }
  // Offline vault-version nudge: the vault records the plugin version that BUILT
  // it (`manifest.version`). When the running plugin is newer, the vault predates
  // the current extractors, so a re-refresh may pick up metadata types or fixes
  // the older build never emitted. Purely local — reads the running version from
  // `SFI_PLUGIN_VERSION` (set by `sfi mcp` at startup) and never touches the
  // network; an absent env var or unparseable version simply skips the clause.
  const runningVersion = process.env['SFI_PLUGIN_VERSION'];
  const builtByVersion = ctx.manifest.version;
  if (
    runningVersion !== undefined &&
    runningVersion !== '' &&
    typeof builtByVersion === 'string' &&
    builtByVersion !== '' &&
    compareVersions(builtByVersion, runningVersion)
  ) {
    clauses.push(
      `This vault was built by sf-intelligence ${builtByVersion}, but you are running ${runningVersion}; run \`/sfi-refresh\` to rebuild it with the newer version's extractors (metadata types or fixes added since ${builtByVersion} may be missing).`,
    );
  }
  const nudge = clauses.length > 0 ? clauses.join(' ') : null;

  return {
    refreshedAt,
    ageDays,
    stale,
    lastRefresh: { available: recent.available, componentsChanged },
    nudge,
  };
};

/**
 * Probe the graph store with the cheapest read available: list at most
 * one `CustomObject` row. Returns whether the probe succeeded plus any
 * issue string to surface to the user. Catches synchronous throws so a
 * disposed store (closed connection, etc.) still produces a structured
 * report rather than crashing the dispatch loop.
 */
const probeGraph = async (
  ctx: Context,
): Promise<{ readable: boolean; issue: string | null }> => {
  try {
    const result = await listNodesByType(ctx.graph, 'CustomObject', { limit: 1 });
    if (!result.ok) {
      return { readable: false, issue: `graph query failed: ${result.error.message}` };
    }
    return { readable: true, issue: null };
  } catch (e) {
    return {
      readable: false,
      issue: `graph query exception: ${(e as Error).message}`,
    };
  }
};

/**
 * Compare the on-disk source tree against the manifest's recorded hash.
 * Returns the per-check tri-state plus any issue string:
 *   - `match === true`:    hashes agree.
 *   - `match === false`:   hashes disagree; vault is stale.
 *   - `match === null`:    source/ is absent or unreadable; skipped.
 */
const probeSourceHash = async (
  ctx: Context,
): Promise<{ match: boolean | null; issue: string | null }> => {
  const sourcePath = join(ctx.vaultRoot, 'source');
  try {
    await stat(sourcePath);
  } catch {
    return {
      match: null,
      issue: 'source/ directory missing — cannot verify freshness',
    };
  }

  const hashResult = await computeSourceTreeHash(sourcePath);
  if (!hashResult.ok) {
    return {
      match: null,
      issue: `hash computation failed: ${hashResult.error.message}`,
    };
  }
  if (hashResult.value !== ctx.manifest.sourceTreeHash) {
    return {
      match: false,
      issue: 'source-tree hash mismatch (vault is stale; run sfi refresh)',
    };
  }
  return { match: true, issue: null };
};

/**
 * Detect a graph/vault render desync. The graph is the source of truth; the
 * `.md` files under `components/` are a cache written at render time, and the
 * manifest records how many of each type were rendered. If the graph holds
 * MORE nodes of some type than the manifest records, the vault is partially
 * rendered: the resolver (which reads the graph) will offer candidates whose
 * file was never written, and `get_component` then fails with "vault file
 * missing". This happens when a vault was built by older/interrupted code; a
 * fresh `/sfi-refresh` re-renders everything.
 *
 * The probe is cheap — one indexed `LIMIT 1 OFFSET <recorded-count>` query
 * per recorded type, short-circuiting on the first desync. It only flags
 * positive counts (a type recorded as 0 is skipped: an empty placeholder
 * manifest must not read as a desync).
 *
 * Tri-state, mirroring `probeSourceHash`:
 *   - `complete === true`:  every recorded type was actually queried and
 *     none showed a desync.
 *   - `complete === false`: a desync was found (definite — wins over any
 *     later unverified type, since a known problem outranks an unknown one).
 *   - `complete === null`:  at least one type's query threw or returned
 *     `!ok` before a desync was found, so render-completeness for that type
 *     was never actually checked. A query that never ran is not evidence of
 *     "no desync" — collapsing it into `true` would be the exact
 *     NEVER-SCANNED-vs-SCANNED-AND-CLEAN conflation this file's own
 *     `probeSourceHash` pattern exists to avoid.
 */
const probeRenderComplete = async (
  ctx: Context,
): Promise<{ complete: boolean | null; issue: string | null }> => {
  const recorded = ctx.manifest.components ?? {};
  let unverifiedType: string | null = null;
  for (const [type, count] of Object.entries(recorded)) {
    if (typeof count !== 'number' || count <= 0) continue;
    let probe;
    try {
      probe = await listNodesByType(ctx.graph, type as ComponentType, {
        limit: 1,
        offset: count,
      });
    } catch {
      // The query itself threw (malformed type string, closed/unreadable
      // store, etc). This type's render-completeness is UNKNOWN, not
      // clean — remember it and keep walking the rest, since a later type
      // finding a definite desync still wins.
      unverifiedType ??= type;
      continue;
    }
    if (!probe.ok) {
      unverifiedType ??= type;
      continue;
    }
    if (probe.value.length > 0) {
      return {
        complete: false,
        issue: `vault appears partially rendered: the graph holds more \`${type}\` nodes than the manifest records (${count}). Some components will resolve but have no vault file. Run \`/sfi-refresh\` to re-render the vault.`,
      };
    }
  }
  if (unverifiedType !== null) {
    return {
      complete: null,
      issue: `render-completeness could not be verified for \`${unverifiedType}\` (graph query failed) — a partially-rendered vault cannot be ruled out; re-run once the graph is readable`,
    };
  }
  return { complete: true, issue: null };
};

/**
 * The `sfi.health_check` MCP tool. Runs three diagnostic probes and
 * returns an aggregated `HealthCheckOutput`. Never returns `err`; the
 * `Result<..., McpError>` signature exists only so the handler shares the
 * `runTool` dispatch shape with the other tools, and `McpError` is
 * unreachable on this path.
 *
 * @example
 *   const r = await healthCheckHandler(ctx, {});
 *   if (r.ok && r.value.data.status !== 'healthy') {
 *     console.warn(r.value.data.issues.join('\n'));
 *   }
 */
export const healthCheckHandler = async (
  ctx: Context,
  _input: HealthCheckInput,
  now: number = Date.now(),
  update: UpdateCheckResult | null = null,
): Promise<Result<McpResponse<HealthCheckOutput>, McpError>> => {
  const issues: string[] = [];

  const vaultExists = existsSync(ctx.vaultRoot);
  if (!vaultExists) issues.push('vault directory missing');

  const graphProbe = await probeGraph(ctx);
  if (graphProbe.issue !== null) issues.push(graphProbe.issue);

  const hashProbe = await probeSourceHash(ctx);
  if (hashProbe.issue !== null) issues.push(hashProbe.issue);

  const renderProbe = await probeRenderComplete(ctx);
  if (renderProbe.issue !== null) issues.push(renderProbe.issue);

  // Architectural-bug-fix observability: read the skip-counter the
  // refresh walker wrote into the manifest. A non-empty map above the
  // threshold flips the verdict to `degraded` so MCP clients can warn
  // the user that the vault is missing coverage for whichever
  // ComponentTypes the dispatcher didn't recognise. Vaults built
  // before the counter shipped read back as an empty map, so older
  // manifests never trip this branch.
  const skipped = readSkippedDirectories(ctx.manifest);
  const skippedFileCount = Object.values(skipped).reduce((sum, n) => sum + n, 0);
  const uncoveredTypesOk = skippedFileCount <= SKIPPED_FILES_DEGRADED_THRESHOLD;
  let uncoveredReason: HealthCheckOutput['reason'];
  if (!uncoveredTypesOk) {
    const dirCount = Object.keys(skipped).length;
    issues.push(
      `vault skipped ${skippedFileCount} files in ${dirCount} unknown ${dirCount === 1 ? 'directory' : 'directories'} during refresh — run \`sfi status --skipped\` for the full list`,
    );
    uncoveredReason = 'uncovered-types-detected';
  }

  const coverage = summarizeCoverage(ctx.manifest);
  if (!coverage.coverageKnown) {
    issues.push(
      'manifest missing coverage metadata — run `/sfi-refresh` or `sfi refresh --no-pull` to recompute from existing source',
    );
  } else if (coverage.partialTypes.length > 0) {
    issues.push(
      `vault coverage is partial for requested metadata: ${coverage.partialTypes.join(', ')}`,
    );
  }
  // NOT PARSED, MEMBER NEVER ARRIVED — its own issue, not folded into the
  // partial line. A partial type asks for a re-retrieve; this one cannot be
  // closed that way (the shared container already came back, without this
  // type's member file), so naming the wrong remedy would send the operator in
  // a circle. Emitted only when the vault has the condition, so an unaffected
  // vault's `issues` list is unchanged.
  const notParsedTypes = coverage.retrievedNotParsedTypes ?? [];
  if (notParsedTypes.length > 0) {
    issues.push(
      `vault reports zero rows for ${notParsedTypes.join(', ')} but the shared retrieve container holding them came back WITHOUT their member file — nothing was read for them, and whether the org simply does not have the feature enabled or the file failed to come back CANNOT be told from this vault; treat those planes as NOT CHECKED, never as "the org has none" (a re-retrieve does not change it: the container already returned without the member — see sfi.coverage_report for the per-type detail)`,
    );
  }

  // PROFILE-COBATCH detect+disclose (trust-critical): the last refresh
  // produced profiles WITHOUT their permission grant sections (a split
  // retrieve likely separated Profile from its co-listed types). The vault
  // must NOT report healthy — permission answers sourced from profiles are
  // untrustworthy until a clean refresh writes a manifest without the field.
  const profileGrantIntegrity = ctx.manifest.profileGrantIntegrity;
  if (profileGrantIntegrity !== undefined && profileGrantIntegrity.degraded) {
    issues.push(profileGrantIntegrity.reason);
  }

  // DUPLICATE-SOURCE detect+disclose (trust-critical): the vault's `source/`
  // tree holds two copies of the same retrieval target, so some components were
  // assembled from two different retrievals. The vault must NOT report healthy
  // while that is true — a permission revoked in one copy and still present in
  // the other is exactly the answer this product must never give confidently.
  const duplicateSourcePaths = ctx.manifest.duplicateSourcePaths;
  if (duplicateSourcePaths !== undefined && duplicateSourcePaths.components > 0) {
    issues.push(duplicateSourcePaths.disclosure);
  }

  // P13-STAGED-tiers: a staged refresh is mid-build. Degraded with explicit
  // tier progress, so consumers qualify every answer until the final tier
  // clears the marker.
  const staged = ctx.manifest.staged;
  if (staged !== undefined) {
    issues.push(
      `staged build in progress (building tier ${staged.tier}/${staged.totalTiers}) — ${staged.pendingTypes.length} metadata type(s) still queued; absence claims about queued types are unreliable until the build completes`,
    );
  }

  const status: HealthCheckOutput['status'] = !graphProbe.readable
    ? 'unhealthy'
    : issues.length > 0
      ? 'degraded'
      : 'healthy';

  const checks: HealthCheckOutput['checks'] = {
    vaultExists,
    graphReadable: graphProbe.readable,
    sourceHashMatches: hashProbe.match,
    uncoveredTypesOk,
    renderComplete: renderProbe.complete,
  };

  // Freshness nudge: read the continuous-learning history store best-effort
  // (a missing/corrupt log must never fail the diagnostic), then derive the
  // age-based yellow flag. Additive — it never alters `status` or `checks`.
  let recent;
  try {
    recent = summarizeRecentActivity(await loadRefreshHistory(ctx.vaultRoot));
  } catch {
    recent = summarizeRecentActivity({
      chronological: [],
      refreshCount: 0,
      firstRefreshedAt: null,
      lastRefreshedAt: null,
      netComponentChange: null,
    });
  }
  const freshness = buildFreshness(ctx, now, hashProbe.match, recent, update);

  const vaultHistoryEnabled = existsSync(join(ctx.vaultRoot, '.git'));

  // ENGINE-ARC §6 — informational assignment-data block. Computed AFTER
  // `status` is derived so it can never influence the verdict: missing
  // assignment data is by-design (live-first), not a retrieval failure.
  const assignmentBase = await buildAssignmentDataCoverage(ctx);
  let assignmentAdvisory: string | null = null;
  if (assignmentBase.factsCounts.present && assignmentBase.factsCounts.capturedAt !== null) {
    const capturedMs = Date.parse(assignmentBase.factsCounts.capturedAt);
    const factsAgeDays = Number.isNaN(capturedMs)
      ? null
      : Math.max(0, Math.floor((now - capturedMs) / MS_PER_DAY));
    if (factsAgeDays !== null && factsAgeDays >= STALE_FACTS_ADVISORY_DAYS) {
      assignmentAdvisory =
        `Assignment-data counts snapshot is ${factsAgeDays} days old (captured ${assignmentBase.factsCounts.capturedAt}); ` +
        'holder counts quoted from it may be stale — re-run `sfi refresh --with-data-shape`, ' +
        'or use the live tools for current rosters.';
    }
  }
  const assignmentData = { ...assignmentBase, advisory: assignmentAdvisory };

  return ok({
    data: {
      status,
      issues,
      checks,
      coverage,
      freshness,
      assignmentData,
      vaultHistory: {
        enabled: vaultHistoryEnabled,
        enableHint: vaultHistoryEnabled
          ? null
          : "Run `sfi vault git enable` once to answer 'when did this change?' from local git history (`sfi.component_history` / `sfi.component_as_of`).",
      },
      // VAULT-PHANTOM-MANIFEST-SUMMARY: echo the refresh-computed phantom
      // taxonomy roll-up if the manifest carries one. Purely informational
      // (never influences `status`); `null` on a manifest that predates the
      // roll-up or a mid-build one — REFRESH-REQUIRED to populate.
      phantomSummary: ctx.manifest.phantomSummary ?? null,
      ...(uncoveredReason !== undefined ? { reason: uncoveredReason } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
