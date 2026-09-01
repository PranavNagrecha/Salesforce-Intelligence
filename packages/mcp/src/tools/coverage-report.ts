/**
 * Handler for `sfi.coverage_report`.
 *
 * This is the enterprise honesty surface: it reports what the last vault build
 * knows about its own completeness, including metadata families that are not
 * modeled yet.
 */

import type {
  CoverageEntry,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  ACTIVE_HOLDERS_COMPLETE_SUBJECT,
  readFacts,
} from '@sf-intelligence/graph';
import {
  buildCoverageEntries,
  buildMixedFreshness,
  rankUncoveredFamilies,
  readTombstones,
  retrievedNotParsedTypes,
  SHARED_CONTAINER_TYPES,
  summarizeCoverage,
  type TombstoneRecord,
  type UncoveredFamily,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { probeLiveAccess } from './live-plane.js';
import {
  type ReferencedButAbsentFamily,
  referencedButAbsentFamilies,
} from './referenced-but-absent.js';
import { ASSIGNMENT_DATA_LIVE_TOOLS } from './vault-assignment-disclosure.js';

/** CR-CAP-20 — cap on the ranked uncovered-families list. */
const TOP_UNCOVERED_FAMILIES_CAP = 10;

/**
 * The disclosure sentence for types whose SHARED retrieve container came back
 * WITHOUT their own member file (see `SHARED_CONTAINER_TYPES`).
 *
 * It must state the TRUE cause, because the cause decides the remedy. The
 * earlier wording said the files were "on disk and nothing read them" and that
 * "the product does not parse that container yet" — all three clauses were
 * false on the probe vault: the refresh dispatches both filenames to shipped
 * extractors, the retrieve manifest already aliases the types onto the shared
 * container, and neither member file is anywhere in the retrieved container.
 * It sent the reader to a re-retrieve AND to a product gap that does not exist.
 *
 * What the manifest actually proves for a listed type: the container was
 * requested (`requested` + `retrieveConfirmed`), the org returned it (a
 * positive `skippedDirectories[container]` counts its OTHER members), and this
 * type still parsed zero. Since the dispatcher for its filename ships and
 * works, what follows is that its member file never arrived — and nothing
 * more. WHY it never arrived is UNDECIDABLE from the vault: the org may not
 * have the feature enabled (it then emits no such file, and "the org has none"
 * is the true reading), or the file exists in the org and did not come back.
 * A previous wording denied the first cause outright — "`retrieved: 0` is a
 * BUILD outcome, not 'the org has none'" — for BOTH types, with a proof for
 * neither; on the probe vault it is probably backwards for FieldServiceSettings,
 * which models no ServiceAppointment / ServiceTerritory / WorkOrder /
 * OperatingHours object at all. So the disclosure names the GAP and refuses to
 * name its cause, except where a type-specific proof exists (SessionSettings).
 *
 * Empty string for an empty list, so a vault without the condition serialises
 * exactly as before.
 */
export const retrievedNotParsedDisclosure = (types: readonly string[]): string => {
  if (types.length === 0) return '';
  const containers = [
    ...new Set(
      Object.entries(SHARED_CONTAINER_TYPES)
        .filter(([, members]) => members.some((t) => types.includes(t)))
        .map(([dir]) => dir),
    ),
  ].sort();
  const containerPhrase = containers.map((c) => `\`${c}\``).join(' / ');
  // SessionSettings is the case where the member can NEVER arrive: Salesforce
  // has no `Session.settings` file at all. Named only when it is in the list.
  const sessionClause = types.includes('SessionSettings')
    ? ' For SessionSettings that member never will arrive — Salesforce does not emit `Session.settings-meta.xml` at all; session settings are a nested `<sessionSettings>` element inside `Security.settings-meta.xml`, which IS in this vault. Closing that one is a PRODUCT change (read the nested element), not an operator action.'
    : '';
  return (
    ` NOT PARSED — THE CONTAINER RETURNED WITHOUT THIS MEMBER: ${types.join(', ')}.` +
    ` Each is dispatched by one exact filename out of the shared ${containerPhrase} retrieve container, and the refresh DOES parse that filename.` +
    ' The container WAS requested (these types alias onto it in the retrieve manifest) and the org DID return it — its other members are the family ranked in `topUncoveredFamilies` — but this type\'s own member file was not among them, so nothing was ever parsed for it.' +
    ' WHY it was not among them cannot be decided from this vault: the org may not have the feature enabled (it then emits no such file, and "the org has none" is the true reading), or the file exists in the org and did not come back. Offline those two are indistinguishable, so no cause is asserted here for any type without a type-specific proof.' +
    ' What is certain either way is that nothing was read for this type: `retrieved: 0` here is not evidence of an empty org, so treat their absence from any answer as NOT CHECKED.' +
    ' Re-running the same retrieve does not change it — the container already came back and the member was not in it; only the org (Setup / a feature check) separates the two causes.' +
    sessionClause
  );
};

/**
 * A `covered` row (`{requested: true, retrieved: 0, retrieveConfirmed: true}`)
 * whose type the vault's OWN graph names members of via `declared`/`parsed`
 * edges that were never retrieved — the shared
 * UNUSED-CERTIFIED-ZERO-CONTRADICTED-BY-OWN-GRAPH fact
 * (`./referenced-but-absent.js`), read here so `sfi.coverage_report` cannot
 * certify a zero as `covered` that `sfi.unused_components` and
 * `sfi.list_components` are, on the SAME vault, already refusing to certify.
 * Not a member-file-shaped gap like {@link retrievedNotParsedDisclosure} — the
 * cause here is a folder-scoped metadata family, where a bare wildcard
 * retrieve returns nothing whether or not the org holds any member, so
 * "retrieve completed, zero members" is never itself evidence of absence.
 */
export interface ReferencedButAbsentCoverageEntry extends CoverageEntry {
  /** Non-heuristic (`declared`/`parsed`) edges naming members of this family. */
  readonly referenceEdges: number;
  /** Distinct missing member ids those edges name. */
  readonly distinctTargets: number;
}

/**
 * Disclosure sentence for {@link ReferencedButAbsentCoverageEntry} rows.
 * Empty string for an empty list, so a vault without the condition serialises
 * exactly as before.
 */
export const referencedButAbsentDisclosure = (
  entries: readonly ReferencedButAbsentCoverageEntry[],
): string => {
  if (entries.length === 0) return '';
  const clauses = entries
    .map(
      (e) =>
        `\`${e.type}\` (${e.referenceEdges} declared/parsed reference edge(s) naming ${e.distinctTargets} distinct member(s))`,
    )
    .join(', ');
  return (
    ` REFERENCED BUT ABSENT — NOT A CHECKED ZERO: ${clauses}.` +
    ' Each reads "requested, confirmed clean, zero members" upstream — the ONE signal this report otherwise trusts to call a zero-member family `covered` — but the vault\'s OWN graph contradicts it: non-heuristic edges from other retrieved components name specific members of these families that were never retrieved.' +
    ' A folder-scoped metadata family is the usual cause: a bare wildcard retrieve of one returns nothing whether or not the org holds any, so "retrieve completed, zero members" can never be evidence of absence for these — they are moved OUT of `covered` and INTO `partial` here.' +
    ' Run `sfi.retrieve_blindspot_report` to see which components reference the missing members, then re-run `/sfi-refresh` (folder-qualified members) before reading any of these as "the org has none".'
  );
};

export const COVERAGE_DISCLOSURE =
  "Coverage describes what the last `sf project retrieve` requested and returned — not what exists in the org. A type listed under `notModeled` is not analyzed by this product at all; its absence from any result means 'not checked', never 'none'. Re-run `/sfi-refresh` after widening your retrieve manifest to close a gap. `topUncoveredFamilies` ranks (by skipped-file volume) directories that WERE retrieved but not modeled by an extractor — a listed family is retrieved-but-not-modeled, never 'absent'.";

export const coverageReportInputSchema = z.object({
  type: z.string().min(1).optional(),
});

export type CoverageReportInput = z.infer<typeof coverageReportInputSchema>;

export interface CoverageReportOutput {
  readonly coverageKnown: boolean;
  readonly coverageComputedAt: string | null;
  readonly covered: readonly CoverageEntry[];
  readonly partial: readonly CoverageEntry[];
  readonly notModeled: readonly CoverageEntry[];
  /**
   * P13-STAGED-tiers: types queued by an in-progress staged refresh — "not
   * retrieved YET (build in progress)", distinct from `partial` ("requested
   * but came back empty/errored") and from `capped` ("was retrieved, just
   * not completely"). Empty outside a staged build.
   */
  readonly pending: readonly CoverageEntry[];
  /**
   * FIX-2 (coverage-spine): types whose retrieval was intentionally bounded
   * (the usage-ranked report/dashboard pull, or the report/dashboard
   * node-persistence ceiling) and DID land a real, non-zero, partial result —
   * "attempted, known cap, more exists beyond it", distinct from `pending`
   * ("not yet attempted at all"). Still folded into `summary.missingCoverage`
   * (the beyond-cap tail genuinely was not checked), so absence caveats keep
   * firing exactly as before — this bucket only makes the REASON legible.
   * Empty `[]` when nothing in the vault is capped.
   */
  readonly capped: readonly CoverageEntry[];
  /**
   * Types dispatched by exact filename out of a SHARED retrieve container whose
   * OWN member file did not come back in it — the third honesty state between
   * `covered` and `partial`. Their coverage row reads
   * `{requested: true, retrieveConfirmed: true, retrieved: 0}`, which the
   * tri-state used to read as "the org genuinely has none"; it is not. The
   * container WAS requested and DID return (its other members are counted in
   * `topUncoveredFamilies`), the refresh DOES dispatch this type's filename, and
   * still nothing was parsed for it — because that member never arrived. WHY it
   * never arrived (the feature is off in the org, so no such file exists; or the
   * file exists and did not come back) is not decidable from the vault, and this
   * bucket asserts neither. "Retrieved" in this name refers to the CONTAINER,
   * never to this type's own file. Present ONLY when non-empty. Never read a
   * listed type's absence from any answer as "none" — nothing has looked.
   */
  readonly retrievedNotParsed?: readonly CoverageEntry[];
  /**
   * UNUSED-CERTIFIED-ZERO-CONTRADICTED-BY-OWN-GRAPH: types whose coverage row
   * reads `{requested: true, retrieved: 0, retrieveConfirmed: true}` — a
   * confirmed-clean zero, `covered` by every upstream signal — that the
   * vault's OWN `declared`/`parsed` edges nonetheless name members of. Moved
   * OUT of `covered` and into `partial` (never read as "the org has none");
   * each row also appears in `partial` and carries `referenceEdges` /
   * `distinctTargets` naming the contradiction. Present ONLY when non-empty.
   * Reads the SAME shared fact `sfi.unused_components` and
   * `sfi.list_components` consult (`referenced-but-absent.js`) so the three
   * tools cannot certify a zero one of them has already refused to certify.
   */
  readonly referencedButAbsent?: readonly ReferencedButAbsentCoverageEntry[];
  /**
   * R6-DRIFT: types present in the manifest but NOT requested by this
   * refresh — a scoped `--types` run that pulled only part of the metadata
   * surface (mirrors `summarizeCoverage`'s `notRequestedTypes` in
   * manifest.ts). Genuinely absent from the vault, not merely never
   * modeled, so it is folded into `summary.missingCoverage` there and
   * belongs in its own bucket here rather than silently disappearing from
   * every per-entry list. Present ONLY when non-empty.
   */
  readonly notRequested?: readonly CoverageEntry[];
  /** Present while a staged refresh is mid-build (tier progress). */
  readonly stagedBuild?: {
    readonly tier: number;
    readonly totalTiers: number;
  };
  readonly summary: ReturnType<typeof summarizeCoverage>;
  /**
   * CR-CAP-20: top families (capped at 10) that were RETRIEVED but not
   * modeled by an extractor, ranked by skipped-file volume desc. Each
   * row carries the canonical `family` label (a `ComponentType` when the
   * raw dir maps to one, else the raw dir name), `rawDir`, `skippedFiles`,
   * and `modeledType`. Empty `[]` on a clean vault — never implies the
   * family is absent from the org.
   */
  readonly topUncoveredFamilies: readonly UncoveredFamily[];
  /**
   * ENGINE-ARC §6 — runtime assignment data (User rows, PermissionSetAssignment,
   * GroupMember). NOT a retrieve gap: these are runtime data objects excluded
   * from the vault BY DESIGN (live-first; the counts-only facts capture is the
   * only offline snapshot, PII-pinned to counts). This section names the
   * consent-gated live tools that answer those questions and whether an
   * offline counts snapshot exists.
   */
  readonly assignmentData: AssignmentDataCoverage;
  /**
   * AUDIT-F5 — recent reconciled-absent tombstones (confirmed source deletions).
   * Empty when none recorded; never invents deletions from a refused reconcile.
   */
  readonly tombstones: readonly TombstoneRecord[];
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

/** The `assignmentData` section of {@link CoverageReportOutput}. */
export interface AssignmentDataCoverage {
  readonly vaultModeled: false;
  readonly reason: string;
  readonly liveTools: readonly string[];
  /** Whether the live plane may run for this org right now (consent/env). */
  readonly liveConsent: boolean;
  /** The P13-FACTS counts-only snapshot (`sfi refresh --with-data-shape`). */
  readonly factsCounts: {
    readonly present: boolean;
    readonly capturedAt: string | null;
  };
  /** One-line human rendering of the three facts above. */
  readonly rendered: string;
}

/** Verbatim `reason` for {@link AssignmentDataCoverage} — judge-consumed. */
export const ASSIGNMENT_DATA_NOT_A_GAP_REASON =
  'runtime data object — by design, not a retrieve gap';

/**
 * Build the assignmentData coverage section: facts-snapshot presence from the
 * ACTIVE_HOLDERS_COMPLETE_SUBJECT marker (counts-only capture) and live-plane
 * availability from the org's standing consent/env. Best-effort — a facts
 * table that cannot be read simply reports `present: false`.
 */
export const buildAssignmentDataCoverage = async (
  ctx: Context,
): Promise<AssignmentDataCoverage> => {
  let present = false;
  let capturedAt: string | null = null;
  try {
    const rows = await readFacts(ctx.graph, {
      subjectId: ACTIVE_HOLDERS_COMPLETE_SUBJECT,
      metric: 'activeHolders',
      limit: 1,
    });
    const marker = rows.ok ? rows.value[0] : undefined;
    if (
      marker !== undefined &&
      typeof marker.value === 'object' &&
      marker.value !== null &&
      (marker.value as { readonly complete?: unknown }).complete === true
    ) {
      present = true;
      capturedAt = marker.capturedAt;
    }
  } catch {
    // A missing/corrupt facts table must not fail the coverage report.
  }
  const liveConsent = (await probeLiveAccess(ctx)).allowed;
  return {
    vaultModeled: false,
    reason: ASSIGNMENT_DATA_NOT_A_GAP_REASON,
    liveTools: ASSIGNMENT_DATA_LIVE_TOOLS,
    liveConsent,
    factsCounts: { present, capturedAt },
    rendered:
      'Runtime assignment data: not in vault (by design). ' +
      `Live: ${liveConsent ? 'available' : 'consent-needed'} (${ASSIGNMENT_DATA_LIVE_TOOLS.join(', ')}). ` +
      `Offline counts snapshot: ${present && capturedAt !== null ? `as of ${capturedAt}` : 'none'}.`,
  };
};

// CR-P3-3: kept in deliberate lockstep with `summarizeCoverage`'s tri-state
// (manifest.ts). A confirmed-clean empty type (`retrieved === 0` AND
// `retrieveConfirmed === true`) moves from `partial` to `covered`; an
// unconfirmed empty type (no signal / dropped / --no-pull) stays in `partial`.
// Without this gate coverage_report would self-contradict summarizeCoverage
// (its own `partial[]` listing a type the summary calls complete) — the exact
// bug the lockstep comment in manifest.ts guards.
// RETRIEVED-NOT-PARSED: the same carve-out `summarizeCoverage` applies. A type
// dispatched by exact filename out of a SHARED retrieve container whose own
// member file did not come back in that container parsed nothing, so its
// confirmed-clean `retrieved: 0` is not evidence of an empty org — it must
// leave `covered`, and it does not belong in `partial` either (a re-retrieve
// does not change it: the container already came back without the member).
// REFERENCED-BUT-ABSENT: unlike the two carve-outs above, this one CANNOT be
// kept in lockstep with `summarizeCoverage` — the fact it reads
// (`referencedButAbsentFamilies`, `./referenced-but-absent.js`) requires the
// GRAPH, which `summarizeCoverage` (manifest.ts) has no access to by
// construction. So `covered`/`partial` here and `summary` (still the raw,
// unmodified `summarizeCoverage` output, read elsewhere e.g. by
// `sfi.health_check`) may legitimately disagree on these types; `trust`
// below is independently widened so THIS tool's own honesty verdict does not
// read `complete` while its own `partial[]` lists the contradiction.
const partitionCoverage = (
  entries: readonly CoverageEntry[],
  unparsed: ReadonlySet<string>,
  referencedButAbsent: ReadonlyMap<string, ReferencedButAbsentFamily>,
): Pick<CoverageReportOutput, 'covered' | 'partial' | 'notModeled' | 'pending' | 'capped'> & {
  // Always arrays HERE (the handler decides whether to emit the optional
  // output keys), unlike the three optional output fields.
  readonly retrievedNotParsed: readonly CoverageEntry[];
  readonly notRequested: readonly CoverageEntry[];
  readonly referencedButAbsentEntries: readonly ReferencedButAbsentCoverageEntry[];
} => {
  const isRetrievedNotParsed = (entry: CoverageEntry): boolean =>
    unparsed.has(entry.type) &&
    entry.requested &&
    entry.retrieved === 0 &&
    entry.retrieveConfirmed === true &&
    !entry.errored &&
    !entry.neverModeled &&
    entry.pending !== true;
  // A confirmed-clean zero the vault's OWN graph contradicts. Checked AFTER
  // isRetrievedNotParsed so a type can never be double-classified — the
  // shared-container reason wins when both apply (mirrors the FIX-2
  // "pending wins over capped" precedent below: one honesty state per type).
  const isReferencedButAbsent = (entry: CoverageEntry): boolean =>
    referencedButAbsent.has(entry.type) &&
    entry.requested &&
    entry.retrieved === 0 &&
    entry.retrieveConfirmed === true &&
    !entry.errored &&
    !entry.neverModeled &&
    entry.pending !== true &&
    !isRetrievedNotParsed(entry);
  return {
    covered: entries.filter(
      (entry) =>
        entry.requested &&
        (entry.retrieved > 0 || entry.retrieveConfirmed === true) &&
        !entry.errored &&
        !entry.neverModeled &&
        entry.pending !== true &&
        entry.capped !== true &&
        !isRetrievedNotParsed(entry) &&
        !isReferencedButAbsent(entry),
    ),
    // A referenced-but-absent type joins `partial` (never `covered`): the
    // vault's own contradicting edges are the same honest-uncertainty shape
    // as an unconfirmed empty retrieve, not a distinct build outcome like
    // `retrievedNotParsed` — see `referencedButAbsentDisclosure` for detail.
    partial: entries.filter(
      (entry) =>
        entry.requested &&
        ((entry.retrieved === 0 && entry.retrieveConfirmed !== true) ||
          entry.errored ||
          isReferencedButAbsent(entry)) &&
        !entry.neverModeled &&
        entry.pending !== true &&
        entry.capped !== true,
    ),
    notModeled: entries.filter((entry) => entry.neverModeled),
    pending: entries.filter((entry) => entry.pending === true && !entry.neverModeled),
    // FIX-2: `pending` wins when a row somehow carries both (mirrors the
    // existing pending-over-retrieveConfirmed precedent) — "not yet attempted
    // at all" is the stronger, more conservative claim.
    capped: entries.filter(
      (entry) => entry.capped === true && entry.pending !== true && !entry.neverModeled,
    ),
    retrievedNotParsed: entries.filter(isRetrievedNotParsed),
    // R6-DRIFT: mirrors summarizeCoverage's `notRequestedTypes` filter
    // (manifest.ts) exactly — `!requested && !neverModeled`. Without this
    // bucket a scoped-refresh type that summarizeCoverage correctly folds
    // into `missingCoverage` had no home in ANY of the buckets above (they
    // all require `entry.requested`), so it vanished from every per-entry
    // list coverage_report exposes even though the summary still named it.
    notRequested: entries.filter((entry) => !entry.requested && !entry.neverModeled),
    referencedButAbsentEntries: entries
      .filter(isReferencedButAbsent)
      .map((entry) => {
        const contradiction = referencedButAbsent.get(entry.type);
        return {
          ...entry,
          referenceEdges: contradiction?.referenceEdges ?? 0,
          distinctTargets: contradiction?.distinctTargets ?? 0,
        };
      }),
  };
};

export const coverageReportHandler = async (
  ctx: Context,
  input: CoverageReportInput,
): Promise<Result<McpResponse<CoverageReportOutput>, McpError>> => {
  const entries = buildCoverageEntries(ctx.manifest).filter((entry) =>
    input.type === undefined ? true : entry.type === input.type,
  );
  const summary = summarizeCoverage(
    ctx.manifest,
    input.type === undefined ? undefined : [input.type],
  );
  // UNUSED-CERTIFIED-ZERO-CONTRADICTED-BY-OWN-GRAPH, coverage_report's half.
  // Candidates are ONLY the confirmed-clean-zero rows — the ones that would
  // otherwise land in `covered` purely on `retrieveConfirmed === true` — so a
  // vault with no such row never touches the graph at all (matches `entries`
  // filtered by `input.type` when one is given).
  const confirmedEmptyTypes = entries
    .filter((entry) => entry.retrieved === 0 && entry.retrieveConfirmed === true)
    .map((entry) => entry.type);
  const absentFamilies = await referencedButAbsentFamilies(ctx, confirmedEmptyTypes);
  if (!absentFamilies.ok) return err(absentFamilies.error);
  const referencedButAbsent = absentFamilies.value;
  const { retrievedNotParsed, notRequested, referencedButAbsentEntries, ...partitions } =
    partitionCoverage(entries, retrievedNotParsedTypes(ctx.manifest), referencedButAbsent);
  const missingCoverage = summary.missingCoverage;
  // `trust.completeness` is THIS tool's own honesty verdict over its own
  // `covered`/`partial` buckets — widened here so it cannot read `complete`
  // while `partial[]` (above) already lists the contradiction. `summary`
  // itself (below) stays the raw, unmodified `summarizeCoverage` output: that
  // function has no graph access and other callers (e.g. `sfi.health_check`)
  // depend on it being byte-identical to the manifest-only fact.
  const referencedButAbsentTypes = referencedButAbsentEntries.map((entry) => entry.type);
  const completenessMissingCoverage =
    referencedButAbsentTypes.length === 0
      ? missingCoverage
      : [...new Set([...missingCoverage, ...referencedButAbsentTypes])].sort();
  const completenessStatus =
    referencedButAbsentTypes.length === 0 ? summary.status : ('partial' as const);
  const staged = ctx.manifest.staged;
  // CR-CAP-20: rank retrieved-but-not-modeled families and cap the list.
  // Inert ([]) when `skippedDirectories` is empty/absent (clean vault).
  const topUncoveredFamilies = rankUncoveredFamilies(ctx.manifest).slice(
    0,
    TOP_UNCOVERED_FAMILIES_CAP,
  );
  const assignmentData = await buildAssignmentDataCoverage(ctx);
  const involvedTypes =
    input.type === undefined ? undefined : ([input.type] as readonly string[]);
  const freshness = buildMixedFreshness(ctx.manifest, involvedTypes);
  const tombstones = await readTombstones(ctx.vaultRoot, 50);
  // A shared-container member that never arrived is invisible in the standard
  // disclosure — it is neither a `notModeled` family nor a retrieve gap — so it
  // gets its own sentence, appended ONLY when the vault has the condition.
  const retrievedNotParsedNote = retrievedNotParsedDisclosure(
    retrievedNotParsed.map((entry) => entry.type),
  );
  // Same treatment for the graph-contradicted rows — appended ONLY when the
  // vault has the condition, so an unaffected vault serialises unchanged.
  const referencedButAbsentNote = referencedButAbsentDisclosure(referencedButAbsentEntries);
  const disclosure = COVERAGE_DISCLOSURE + retrievedNotParsedNote + referencedButAbsentNote;
  const mixedNote =
    freshness.overall === 'mixed'
      ? `Mixed family freshness: oldest evidence at ${freshness.oldestEvidenceAt ?? 'unknown'} — a scoped refresh left some families older than the vault-wide refreshedAt.`
      : null;

  return ok({
    data: {
      coverageKnown: summary.coverageKnown,
      coverageComputedAt: ctx.manifest.coverageComputedAt ?? null,
      ...partitions,
      // Present ONLY when the vault actually has the condition, so a vault
      // whose containers were all dispatched serialises exactly as before.
      ...(retrievedNotParsed.length > 0 ? { retrievedNotParsed } : {}),
      ...(notRequested.length > 0 ? { notRequested } : {}),
      ...(referencedButAbsentEntries.length > 0
        ? { referencedButAbsent: referencedButAbsentEntries }
        : {}),
      ...(staged !== undefined
        ? { stagedBuild: { tier: staged.tier, totalTiers: staged.totalTiers } }
        : {}),
      summary,
      topUncoveredFamilies,
      assignmentData,
      tombstones,
      trust: {
        provenance: 'offline_snapshot',
        confidence: summary.coverageKnown ? 'declared' : 'unknown',
        freshness,
        completeness: {
          status: completenessStatus,
          ...(completenessMissingCoverage.length > 0
            ? { missingCoverage: completenessMissingCoverage }
            : {}),
        },
        limitations: [
          disclosure,
          ...(mixedNote !== null ? [mixedNote] : []),
        ],
      },
      disclosure,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
