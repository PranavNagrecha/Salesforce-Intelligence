import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  ComponentType,
  CoverageEntry,
  PhantomClassification,
  VaultManifest,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import { vaultPaths } from './layout.js';

/**
 * The error variants `loadManifest` and `saveManifest` can return.
 *
 *   - `manifest-missing`: the manifest file does not exist. Callers can
 *     treat this as a not-yet-refreshed vault.
 *   - `parse-error`: the manifest exists but its contents are not valid JSON.
 *   - `write-failed`: the manifest could not be written (I/O failure,
 *     permission denied, temp-file rename failure, etc.).
 */
export interface ManifestError {
  readonly kind: 'manifest-missing' | 'parse-error' | 'write-failed';
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
}

/**
 * Manifest extended with the v1.x observability field
 * `skippedDirectories` (see `refresh-pipeline.ts`'s skip-counter).
 *
 * The base `VaultManifest` shape in `@sf-intelligence/contracts` is
 * frozen, so this widening lives in the vault package. The field is
 * optional so existing vaults built before the skip-counter landed read
 * back as `skippedDirectories === undefined`; callers that consume it
 * should fall back to an empty object.
 *
 * The map's keys are the unknown directory basenames the refresh walker
 * encountered (e.g. `omniProcesses`, `omniDataTransforms`); values are
 * the per-directory counts of skipped files. An empty map means every
 * file the walker touched matched a supported dispatch.
 */
export interface ExtendedVaultManifest extends VaultManifest {
  readonly skippedDirectories?: Readonly<Record<string, number>>;
  /**
   * Present only while a staged refresh (`sfi refresh --staged`,
   * P13-STAGED-tiers) is mid-build: which tier last completed, how many
   * tiers the plan has, and which metadata types are still queued. The
   * final tier runs as a full monolithic refresh whose manifest omits the
   * marker, so absence means "not staged / staged build complete".
   * Consumers: `sfi.health_check` reports `degraded (building tier i/n)`
   * and `sfi.coverage_report` surfaces the queued types as `pending`.
   */
  readonly staged?: StagedBuildMarker;
  /**
   * P13-AST-edges: present when the last refresh ran `--apex-ast` — how many
   * Apex files the ANTLR pass parsed and how many fell back to scanner-only.
   */
  readonly apexAst?: {
    readonly filesParsed: number;
    readonly parseErrors: number;
  };
  /**
   * P13-REPORTS-default: present when the default usage-ranked
   * report/dashboard pull ran — org totals vs what the pull delivered. A
   * capped pull also marks the Report/Dashboard coverage rows `pending`.
   * P14-USAGE-reports-retrieve-fidelity: `requested` is the manifest member
   * count and `retrieved` the files that actually LANDED on disk —
   * `requested > retrieved` means the Metadata API silently dropped members.
   * Manifests written before 0.1.10 lack `requested` (their `retrieved` was
   * the requested count, drops invisible).
   */
  readonly reportsCap?: {
    readonly reports: { readonly total: number; readonly requested?: number; readonly retrieved: number };
    readonly dashboards: { readonly total: number; readonly requested?: number; readonly retrieved: number };
  };
  /**
   * P15-PHANTOM-manifest-summary: refresh-time roll-up of dangling edge
   * targets by phantom taxonomy bucket (ADR-004 — counts only, no stub nodes).
   */
  readonly phantomSummary?: {
    readonly computedAt: string;
    readonly distinctPhantoms: number;
    readonly buckets: Readonly<Partial<Record<PhantomClassification, number>>>;
  };
}

/** Mid-build progress marker for a staged refresh (P13-STAGED-tiers). */
export interface StagedBuildMarker {
  /** Highest tier that has fully completed (0 = skeleton only). */
  readonly tier: number;
  /** Total tiers in this staged plan (3, or 4 with `--with-reports`). */
  readonly totalTiers: number;
  /** Metadata types not yet retrieved by any completed tier. */
  readonly pendingTypes: readonly string[];
}

/**
 * Metadata families that materially affect enterprise safety answers but are
 * not modeled by the current extractor graph yet. They are included in coverage
 * reports even when the last retrieve did not include a skipped directory for
 * them, so absence-based answers can say "not checked" instead of implying
 * "none".
 */
/**
 * Metadata families with no extractor yet. v4.0 enterprise extractors
 * model Reports, dashboards, UI, and visibility rules — the list stays
 * empty so coverage summaries do not mark them `neverModeled` by default.
 */
export const ENTERPRISE_NOT_MODELED_TYPES = [] as const;

/**
 * When refresh skips a retrieve subdirectory, surface a `neverModeled` coverage
 * row under the family's canonical `ComponentType` so absence-based answers say
 * "not checked" instead of implying "none exist". Keys are the raw retrieve
 * subdirectory names emitted into `manifest.skippedDirectories`; values are the
 * `ComponentType` they map to. The value is NEVER the raw dir name — that would
 * leak a non-ComponentType string (e.g. `compactLayouts`) into the coverage
 * surface that `coverage_report` and `org_risk_report` present to the user.
 */
const SKIPPED_DIR_COVERAGE: Readonly<Partial<Record<string, ComponentType>>> = {
  compactLayouts: 'CompactLayout',
  fieldSets: 'FieldSet',
  indexes: 'Index',
  listViews: 'ListView',
  webLinks: 'WebLink',
};

/** Normalized coverage summary consumed by MCP tools and CLI diagnostics. */
export interface CoverageSummary {
  readonly coverageKnown: boolean;
  readonly status: 'complete' | 'partial' | 'unknown';
  readonly coveredTypes: readonly string[];
  readonly partialTypes: readonly string[];
  readonly notModeledTypes: readonly string[];
  readonly missingCoverage: readonly string[];
}

/**
 * Read the `skippedDirectories` field from an `ExtendedVaultManifest`
 * with a safe default. Existing pre-v1.x manifests don't carry the
 * field, so the reader must treat `undefined` as the empty map rather
 * than crash. Used by `sfi status --skipped` and the MCP `health_check`
 * and `get_manifest` tools.
 */
export const readSkippedDirectories = (
  manifest: VaultManifest | ExtendedVaultManifest | undefined,
): Readonly<Record<string, number>> => {
  if (manifest === undefined) return {};
  const ext = manifest as ExtendedVaultManifest;
  if (ext.skippedDirectories === undefined) return {};
  return ext.skippedDirectories;
};

/** Read the optional v4.0 coverage array with a back-compatible default. */
export const readCoverageEntries = (
  manifest: VaultManifest | ExtendedVaultManifest | undefined,
): readonly CoverageEntry[] => {
  if (manifest === undefined) return [];
  return manifest.coverage ?? [];
};

/**
 * Merge explicit manifest coverage with the static enterprise gap list. Explicit
 * rows win so future extractors can remove a type from "never modeled" simply
 * by writing a coverage entry for it.
 */
export const buildCoverageEntries = (
  manifest: VaultManifest | ExtendedVaultManifest | undefined,
): readonly CoverageEntry[] => {
  const byType = new Map<string, CoverageEntry>();
  for (const entry of readCoverageEntries(manifest)) {
    byType.set(entry.type, entry);
  }
  for (const type of ENTERPRISE_NOT_MODELED_TYPES) {
    if (!byType.has(type)) {
      byType.set(type, {
        type,
        requested: false,
        retrieved: 0,
        errored: false,
        neverModeled: true,
      });
    }
  }
  const skippedDirs = readSkippedDirectories(manifest);
  for (const [dir, componentType] of Object.entries(SKIPPED_DIR_COVERAGE)) {
    if (componentType === undefined) continue;
    const retrieved = skippedDirs[dir];
    if (retrieved === undefined || retrieved <= 0) continue;
    if (!byType.has(componentType)) {
      byType.set(componentType, {
        type: componentType,
        requested: true,
        retrieved,
        errored: false,
        neverModeled: true,
      });
    }
  }
  return [...byType.values()].sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 : 0,
  );
};

/**
 * Synthesize an in-memory `coverage` array for pre-v4 manifests that only
 * have `components` / `skippedDirectories`. Lets MCP synthesis report
 * `coverageKnown: true` without rewriting disk; run `sfi refresh --no-pull`
 * to persist coverage on the manifest.
 */
export const backfillCoverageInMemory = (
  manifest: ExtendedVaultManifest,
): ExtendedVaultManifest => {
  if (readCoverageEntries(manifest).length > 0) {
    return manifest;
  }

  const synthesized: CoverageEntry[] = [];
  for (const [type, count] of Object.entries(manifest.components)) {
    synthesized.push({
      type: type as ComponentType,
      requested: true,
      retrieved: count,
      errored: false,
      neverModeled: false,
    });
  }
  // Skipped retrieve subdirectories are surfaced by `buildCoverageEntries` below
  // via `SKIPPED_DIR_COVERAGE`, which maps each raw dir name to its canonical
  // `ComponentType` (e.g. `listViews` → `ListView`). Synthesizing them here from
  // the raw dir name would leak non-ComponentType strings (`compactLayouts`,
  // `fieldSets`, …) into the coverage surface and duplicate the mapped row.

  const withRows: ExtendedVaultManifest = {
    ...manifest,
    coverage: synthesized,
  };
  const coverage = buildCoverageEntries(withRows);
  if (coverage.length === 0) {
    return manifest;
  }
  return {
    ...withRows,
    coverage,
    coverageComputedAt: new Date().toISOString(),
  };
};

/** Produce the enterprise coverage summary for all or selected metadata types. */
export const summarizeCoverage = (
  manifest: VaultManifest | ExtendedVaultManifest | undefined,
  relevantTypes?: readonly string[],
): CoverageSummary => {
  const entries = buildCoverageEntries(manifest);
  const wanted = relevantTypes === undefined ? null : new Set(relevantTypes);
  const filtered = wanted === null
    ? entries
    : entries.filter((entry) => wanted.has(entry.type));

  if (filtered.length === 0) {
    return {
      coverageKnown: readCoverageEntries(manifest).length > 0,
      status: 'unknown',
      coveredTypes: [],
      partialTypes: [],
      notModeledTypes: [],
      missingCoverage: relevantTypes ?? [],
    };
  }

  // CR-P3-3 TRI-STATE for a requested, non-errored, non-pending, modeled row:
  //  (a) retrieved > 0                 -> COVERED (rows actually landed).
  //  (b) retrieved === 0 AND
  //      retrieveConfirmed === true    -> COVERED (the describe confirmed the
  //                                       org supports this type AND the clean
  //                                       retrieve returned zero members == the
  //                                       org genuinely has none == complete,
  //                                       no caveat). `retrieveConfirmed` is set
  //                                       ONLY from a confirmed-supported,
  //                                       cleanly-retrieved pull (refresh.ts),
  //                                       never from `requested` alone, so a
  //                                       silently-dropped / describe-blind
  //                                       empty pull does NOT reach here.
  //  (c) retrieved === 0 AND
  //      retrieveConfirmed unset/false -> PARTIAL (the not-retrieved /
  //                                       silently-dropped / pre-signal-manifest
  //                                       / --no-pull case). The coverage data
  //                                       model otherwise cannot distinguish
  //                                       "confirmed zero" from "dropped" — both
  //                                       persist the identical
  //                                       {requested:true,retrieved:0,
  //                                        errored:false,neverModeled:false}
  //                                       row — so the honest reading stays
  //                                       "not confirmed": routed into
  //                                       partial/missingCoverage so absence
  //                                       caveats keep firing.
  // A `pending` row (P13-STAGED-tiers / reports-cap) is excluded from BOTH
  // covered branches by the `pending !== true` guard, so a capped/dropped pull
  // can never read as confirmed-empty even if it carries retrieveConfirmed.
  const coveredTypes = filtered
    .filter(
      (entry) =>
        entry.requested &&
        (entry.retrieved > 0 || entry.retrieveConfirmed === true) &&
        !entry.errored &&
        !entry.neverModeled &&
        entry.pending !== true,
    )
    .map((entry) => entry.type);
  // Requested, non-errored, non-pending, modeled types that retrieved ZERO
  // rows WITHOUT a confirmed-clean retrieve (case (c) above). Mirrors
  // `coverage-report.ts` `partitionCoverage`, which applies the identical
  // retrieveConfirmed gate — keeping summarizeCoverage in lockstep is what
  // stops coverage_report from self-contradicting (summary said "complete"
  // while its own `partial[]` listed these zero-retrieved types). Disjoint from
  // the covered branch (the `retrieveConfirmed === true` carve-out) and from
  // the errored/pending branch below (the `!errored && pending !== true`
  // guards), so the union into `partialTypes` never double-counts. Distinct
  // from `neverModeled` (no extractor) and `notRequested` (scoped-out), so the
  // three honesty states stay separate and the a4 I3 notModeled-set cross-check
  // is unaffected.
  const emptyTypes = filtered
    .filter(
      (entry) =>
        entry.requested &&
        entry.retrieved === 0 &&
        entry.retrieveConfirmed !== true &&
        !entry.errored &&
        !entry.neverModeled &&
        entry.pending !== true,
    )
    .map((entry) => entry.type);
  // `partial` and `notModeled` are mutually exclusive buckets: a type that was
  // never modeled belongs ONLY in notModeledTypes. Including it here too made
  // health_check report the same type as both partial AND not-modeled (and
  // triple-counted it into missingCoverage). A "partial" type is one that was
  // requested and errored during retrieve — is still queued by a staged
  // build — or was requested but retrieved nothing (`emptyTypes`) — but is a
  // modeled type in every case.
  const partialTypes = [
    ...filtered
      .filter((entry) => (entry.errored || entry.pending === true) && !entry.neverModeled)
      .map((entry) => entry.type),
    ...emptyTypes,
  ];
  const notModeledTypes = filtered
    .filter((entry) => entry.neverModeled)
    .map((entry) => entry.type);
  // Types present in the manifest but NOT requested by this refresh — i.e. a
  // scoped `--types` run that pulled only part of the metadata surface. They
  // are genuinely absent from the vault, so they must keep the status out of
  // `complete` (the scoped-refresh-reports-complete bug). Distinct from
  // `partial` (requested but errored) and `notModeled` (no extractor).
  const notRequestedTypes = filtered
    .filter((entry) => !entry.requested && !entry.neverModeled)
    .map((entry) => entry.type);
  if (wanted !== null) {
    const knownTypes = new Set(filtered.map((entry) => entry.type));
    for (const type of wanted) {
      if (!knownTypes.has(type)) {
        partialTypes.push(type);
      }
    }
  }
  const missingCoverage = [
    ...new Set([...partialTypes, ...notModeledTypes, ...notRequestedTypes]),
  ].sort();
  const coverageKnown = readCoverageEntries(manifest).length > 0;
  const status = missingCoverage.length > 0
    ? 'partial'
    : coverageKnown
      ? 'complete'
      : 'unknown';

  return {
    coverageKnown,
    status,
    coveredTypes,
    partialTypes,
    notModeledTypes,
    missingCoverage,
  };
};

/** Suffix used for the temporary file in `saveManifest`'s atomic write. */
const TEMP_SUFFIX = '.tmp';
/** JSON indentation, 2 spaces, picked for diffability of committed vaults. */
const JSON_INDENT = 2;

/**
 * Load and parse the manifest at `org-kb/meta/manifest.json`.
 *
 * Returns `err({kind:'manifest-missing'})` when the file does not exist,
 * which callers should interpret as "the vault has not been refreshed
 * yet" rather than a hard failure.
 *
 * @example
 *   const r = await loadManifest('/path/to/org-kb');
 *   if (r.ok) console.log(r.value.refreshedAt);
 *   else if (r.error.kind === 'manifest-missing') createInitialVault();
 */
export const loadManifest = async (
  vaultRoot: string,
): Promise<Result<ExtendedVaultManifest, ManifestError>> => {
  const { manifest: manifestPath } = vaultPaths(vaultRoot);
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (cause) {
    if (isEnoent(cause)) {
      return err({
        kind: 'manifest-missing',
        message: `manifest does not exist: ${manifestPath}`,
        path: manifestPath,
      });
    }
    return err({
      kind: 'parse-error',
      message: `failed to read manifest: ${manifestPath}`,
      path: manifestPath,
      cause,
    });
  }

  try {
    const parsed = JSON.parse(raw) as ExtendedVaultManifest;
    return ok(parsed);
  } catch (cause) {
    return err({
      kind: 'parse-error',
      message: `manifest is not valid JSON: ${manifestPath}`,
      path: manifestPath,
      cause,
    });
  }
};

/**
 * Persist `manifest` to `org-kb/meta/manifest.json`.
 *
 * Behaviour:
 *   - Object keys are sorted alphabetically at every level, so committed
 *     manifests produce minimal diffs.
 *   - The write is atomic: data is staged in a sibling temp file and then
 *     `rename`d into place. A mid-flight failure cannot leave a partial
 *     manifest at the canonical path.
 *   - If the staged temp file exists after a failure, it is cleaned up
 *     best-effort so subsequent runs are not blocked.
 *
 * @example
 *   const r = await saveManifest('/path/to/org-kb', {
 *     version: '0.1.0',
 *     refreshedAt: '2026-05-27T14:33:08Z',
 *     sourceOrg: 'me@example.com',
 *     components: { CustomObject: 47 },
 *     edges: { parentOf: 312 },
 *     sourceTreeHash: 'sha256:abc...'
 *   });
 *   if (!r.ok) console.error(r.error.message);
 */
export const saveManifest = async (
  vaultRoot: string,
  manifest: VaultManifest | ExtendedVaultManifest,
): Promise<Result<void, ManifestError>> => {
  const { manifest: manifestPath } = vaultPaths(vaultRoot);
  const tempPath = `${manifestPath}${TEMP_SUFFIX}`;
  const json = `${JSON.stringify(sortKeys(manifest), null, JSON_INDENT)}\n`;

  try {
    await mkdir(dirname(manifestPath), { recursive: true });
  } catch (cause) {
    return err({
      kind: 'write-failed',
      message: `failed to create manifest directory: ${dirname(manifestPath)}`,
      path: manifestPath,
      cause,
    });
  }

  try {
    await writeFile(tempPath, json, 'utf8');
  } catch (cause) {
    await cleanupTemp(tempPath);
    return err({
      kind: 'write-failed',
      message: `failed to write temp manifest: ${tempPath}`,
      path: manifestPath,
      cause,
    });
  }

  try {
    await rename(tempPath, manifestPath);
  } catch (cause) {
    await cleanupTemp(tempPath);
    return err({
      kind: 'write-failed',
      message: `failed to rename temp manifest into place: ${manifestPath}`,
      path: manifestPath,
      cause,
    });
  }

  return ok(undefined);
};

/**
 * Return a structural deep copy of `value` with object keys sorted
 * alphabetically at every level. Arrays preserve their order.
 *
 * Used by `saveManifest` to canonicalize key order before JSON encoding.
 */
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      sorted[k] = sortKeys(v);
    }
    return sorted;
  }
  return value;
};

/** Treat unknown errors that smell like ENOENT as missing-file signals. */
const isEnoent = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  (cause as { code?: unknown }).code === 'ENOENT';

/** Best-effort cleanup of a temp file; ignores its absence. */
const cleanupTemp = async (tempPath: string): Promise<void> => {
  try {
    await unlink(tempPath);
  } catch {
    // Temp file may not exist (write failed before it was created); nothing to clean.
  }
};
