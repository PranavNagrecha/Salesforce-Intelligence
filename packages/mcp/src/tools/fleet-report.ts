/**
 * Handler for the `sfi.generate_fleet_report` MCP tool (R7-C6).
 *
 * The "state of my orgs" digest: a single `GeneratedDocument` composed
 * across EVERY vault in the multi-vault registry, so a fleet operator
 * gets one artifact instead of running `sfi.org_pulse` / `sfi.fleet_find`
 * / `sfi.fleet_drift_ranking` once per org by hand.
 *
 * Deliberately a COMPOSITION, not a new analysis:
 *   - Per-vault manifest facts (component counts, product version, source
 *     org, last-refresh timestamp) come straight from each registered
 *     vault's `meta/manifest.json`, via `@sf-intelligence/vault`'s
 *     `listRegisteredVaults` + `loadManifest` — the SAME registry read
 *     `sfi.fleet_find` / `sfi.fleet_drift_ranking` use.
 *   - The per-vault "org-pulse digest" (freshness coverage % + top
 *     contributor) reuses `@sf-intelligence/graph`'s `freshnessSummary` /
 *     `contributorsSummary` — the exact functions `sfi.org_pulse` calls —
 *     against each OTHER vault's graph store opened read-only via the
 *     SAME `openVaultReadOnly` helper `sfi.compare_vaults` uses. No drift
 *     or pulse logic is reimplemented here.
 *
 * **Live drift is SKIPPED, not degraded-and-hidden.** `sfi.fleet_drift_ranking`
 * answers "which vault has drifted from its LIVE org" via per-org
 * Tooling-API consent. This report never asks for that consent (it takes
 * `{ limit? }`, no org/consent args) — it substitutes an OFFLINE proxy
 * ("most behind" = oldest `refreshedAt`, or "never refreshed" ranked
 * worst) and discloses the substitution verbatim, naming
 * `sfi.fleet_drift_ranking` as the way to get the real live comparison.
 *
 * **Fails closed, never drops a vault silently.** Zero registered vaults
 * returns a document that says so (never a fabricated "fleet is healthy").
 * A vault whose manifest cannot be read is listed with an `unreadable`
 * status, not omitted from the Per-Org Inventory table. A vault whose
 * GRAPH cannot be opened (for the pulse digest only) is disclosed the
 * same way, independent of its manifest status.
 *
 * **Bounded fan-out.** The manifest-level Per-Org Inventory covers EVERY
 * registered vault (cheap — JSON file reads only). The graph-opening
 * pulse digest is capped at `limit` (default {@link FLEET_REPORT_DEFAULT_LIMIT},
 * max {@link FLEET_REPORT_MAX_LIMIT}) registered vaults, alias order, so a
 * large fleet cannot force this single call to open dozens of DuckDB
 * stores; the cap is disclosed when it truncates anything.
 */

import type {
  ConfidenceLevel,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { contributorsSummary, freshnessSummary } from '@sf-intelligence/graph';
import {
  findRegistryRoot,
  listRegisteredVaults,
  loadManifest,
  type VaultRef,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { openVaultReadOnly } from './cross-vault-open.js';
import {
  fitDocumentToBudget,
  generatedDocByteBudget,
  INHERITED_CONFIDENCE_DISCLOSURE,
  Q125_FRESHNESS_DISCLOSURE,
  renderFooter,
  STRUCTURAL_DISCLOSURE,
  type GeneratedDocument,
} from './generate-data-dictionary.js';
import { ORG_PULSE_DISCLOSURE } from './org-pulse.js';

/** Default number of registered vaults that get the graph-opening pulse digest. */
export const FLEET_REPORT_DEFAULT_LIMIT = 10;

/** Hard ceiling on the pulse-digest fan-out, regardless of caller `limit`. */
export const FLEET_REPORT_MAX_LIMIT = 25;

/** Oldest/newest + contributor sample size WITHIN one vault's pulse digest — small, since this is a fleet-wide summary, not a deep single-org dive (use `sfi.org_pulse` directly on a vault for that). */
const PER_VAULT_PULSE_SAMPLE = 3;

/** Top-N component types surfaced per vault in the Per-Org Inventory table. */
const TOP_TYPES_PER_VAULT = 3;

/** Zod schema for `sfi.generate_fleet_report`. No required args. */
export const generateFleetReportInputSchema = z.object({
  /** Caps how many registered vaults get the graph-opening pulse digest (1..{@link FLEET_REPORT_MAX_LIMIT}, default {@link FLEET_REPORT_DEFAULT_LIMIT}). Every registered vault still appears in the manifest-level Per-Org Inventory regardless of this cap. */
  limit: z.number().int().min(1).max(FLEET_REPORT_MAX_LIMIT).optional(),
});

export type GenerateFleetReportInput = z.infer<
  typeof generateFleetReportInputSchema
>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GenerateFleetReportOutput {
  readonly document: GeneratedDocument;
}

const FLEET_REPORT_NO_VAULTS_MESSAGE =
  'No vaults are registered — run `sfi register-vault <alias> <path>` to register your first org, then re-run `sfi.generate_fleet_report({})`.';

const FLEET_REPORT_MANIFEST_DISCLOSURE =
  "Per-org component counts, product version, and last-refresh timestamp are read from each vault's OWN meta/manifest.json — a cheap file read, no graph open. A vault whose manifest could not be read is listed with status `unreadable` and its counts show as unknown, never silently dropped or treated as zero.";

const FLEET_REPORT_LIVE_DRIFT_SKIPPED_DISCLOSURE =
  'Live drift is SKIPPED in this report — it takes no org/consent arguments, so no Tooling-API calls are made. "Most behind" below is an OFFLINE proxy (oldest `refreshedAt`, with a never-refreshed/unreadable vault ranked worst of all) — it is NOT the live "components changed since refresh" count `sfi.fleet_drift_ranking` computes. For that live comparison, call `sfi.fleet_drift_ranking` with a per-org `sfi.live_consent` grant (or SFI_LIVE_PLANE_ENABLED=1).';

const fleetReportPulseScopeDisclosure = (
  consideredCount: number,
  totalCount: number,
  limit: number,
): string =>
  `The Freshness & Contributors digest (coverage % + top contributor) was computed for ${consideredCount.toString()} of ${totalCount.toString()} registered vaults — capped by \`limit\` (default ${FLEET_REPORT_DEFAULT_LIMIT.toString()}, max ${FLEET_REPORT_MAX_LIMIT.toString()}, requested ${limit.toString()}) so this single call cannot be forced to open every vault's graph store. The Per-Org Inventory table above still lists every registered vault regardless of this cap; raise \`limit\`, or call \`sfi.org_pulse\` directly against an excluded vault's own MCP session.`;

/** One registered vault's manifest-derived facts (or an honest `unreadable` row). */
interface FleetVaultRow {
  readonly alias: string;
  readonly path: string;
  readonly manifestStatus: 'ok' | 'unreadable';
  readonly sourceOrg: string | null;
  readonly version: string | null;
  readonly refreshedAt: string | null;
  readonly totalComponents: number | null;
  readonly topComponentTypes: readonly { readonly type: string; readonly count: number }[];
}

/** Read every registered vault's manifest. Bounded by the (typically small) registry size — no cap needed, this is file-read cheap, unlike the graph-opening pulse digest below. */
const buildVaultRows = async (
  vaults: readonly VaultRef[],
): Promise<readonly FleetVaultRow[]> => {
  const rows: FleetVaultRow[] = [];
  for (const v of vaults) {
    // eslint-disable-next-line no-await-in-loop -- sequential manifest reads, bounded by registry size (small; a JSON file read each, not a graph open)
    const manifestResult = await loadManifest(v.path);
    if (!manifestResult.ok) {
      rows.push({
        alias: v.alias,
        path: v.path,
        manifestStatus: 'unreadable',
        sourceOrg: null,
        version: null,
        refreshedAt: null,
        totalComponents: null,
        topComponentTypes: [],
      });
      continue;
    }
    const m = manifestResult.value;
    const typeEntries = Object.entries(m.components) as readonly [string, number][];
    const totalComponents = typeEntries.reduce((sum, [, count]) => sum + count, 0);
    const topComponentTypes = [...typeEntries]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, TOP_TYPES_PER_VAULT)
      .map(([type, count]) => ({ type, count }));
    rows.push({
      alias: v.alias,
      path: v.path,
      manifestStatus: 'ok',
      sourceOrg: m.sourceOrg,
      version: m.version,
      refreshedAt: m.refreshedAt,
      totalComponents,
      topComponentTypes,
    });
  }
  return rows;
};

/** Which vault is most behind, by the OFFLINE age proxy. A never-refreshed/unreadable vault (`refreshedAt: null`) ranks worse than any real timestamp — no freshness signal is the worst case, not a neutral one. Deterministic on ties (alias ASC — `vaults` arrives alias-sorted from `listRegisteredVaults`). */
const rankMostBehind = (
  rows: readonly FleetVaultRow[],
): { readonly alias: string; readonly refreshedAt: string | null; readonly reason: 'never-refreshed' | 'oldest-refresh' } | null => {
  if (rows.length === 0) return null;
  const unknown = rows.filter((r) => r.refreshedAt === null);
  if (unknown.length > 0) {
    const first = unknown[0]!;
    return { alias: first.alias, refreshedAt: null, reason: 'never-refreshed' };
  }
  const sorted = [...rows].sort((a, b) => {
    const cmp = (a.refreshedAt as string).localeCompare(b.refreshedAt as string);
    return cmp !== 0 ? cmp : a.alias.localeCompare(b.alias);
  });
  const oldest = sorted[0]!;
  return { alias: oldest.alias, refreshedAt: oldest.refreshedAt, reason: 'oldest-refresh' };
};

/** Registered vaults grouped by sf-intelligence product `version` — the SAME extractor-version divergence signal `sfi.compare_vaults`'s `extractorVersionCaveat` surfaces pairwise, generalized to the whole fleet. Vaults with an unreadable manifest (unknown version) are excluded, not folded into any group. */
interface VersionGroup {
  readonly version: string;
  readonly aliases: readonly string[];
}
const buildVersionGroups = (rows: readonly FleetVaultRow[]): readonly VersionGroup[] => {
  const byVersion = new Map<string, string[]>();
  for (const r of rows) {
    if (r.version === null) continue;
    const list = byVersion.get(r.version) ?? [];
    list.push(r.alias);
    byVersion.set(r.version, list);
  }
  return [...byVersion.entries()]
    .map(([version, aliases]) => ({ version, aliases: aliases.sort() }))
    .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
};

/** Widest component-count spread across the fleet (min vault vs max vault), for the Notable Divergences section. `null` when fewer than 2 vaults carry a known count. */
interface CountSpread {
  readonly minAlias: string;
  readonly minCount: number;
  readonly maxAlias: string;
  readonly maxCount: number;
}
const buildCountSpread = (rows: readonly FleetVaultRow[]): CountSpread | null => {
  const known = rows.filter(
    (r): r is FleetVaultRow & { totalComponents: number } => r.totalComponents !== null,
  );
  if (known.length < 2) return null;
  const min = known.reduce((a, b) => (b.totalComponents < a.totalComponents ? b : a));
  const max = known.reduce((a, b) => (b.totalComponents > a.totalComponents ? b : a));
  return {
    minAlias: min.alias,
    minCount: min.totalComponents,
    maxAlias: max.alias,
    maxCount: max.totalComponents,
  };
};

/** One vault's org-pulse-style digest row (or an honest `unreadable` status when its graph could not be opened / queried). */
interface PulseRow {
  readonly alias: string;
  readonly status: 'ok' | 'unreadable';
  readonly coveragePct?: number;
  readonly topContributor?: { readonly author: string; readonly componentCount: number };
}

/**
 * Compose the org-pulse digest for the first `limit` registered vaults
 * (alias order), reusing `freshnessSummary` / `contributorsSummary`
 * directly against each vault's OWN opened graph store — the same
 * primitives `sfi.org_pulse` calls on `ctx.graph`, generalized across
 * vaults via `openVaultReadOnly` (the same cross-vault open helper
 * `sfi.compare_vaults` uses, so the server's OWN vault is reused instead
 * of double-opened).
 */
const buildPulseRows = async (
  ctx: Context,
  vaults: readonly VaultRef[],
  limit: number,
): Promise<{ readonly rows: readonly PulseRow[]; readonly consideredCount: number }> => {
  const considered = vaults.slice(0, limit);
  const rows: PulseRow[] = [];
  for (const v of considered) {
    // eslint-disable-next-line no-await-in-loop -- sequential graph opens, bounded by `limit` (max FLEET_REPORT_MAX_LIMIT)
    const opened = await openVaultReadOnly(ctx, v.path);
    if (!opened.ok) {
      rows.push({ alias: v.alias, status: 'unreadable' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- see above
      const fresh = await freshnessSummary(opened.value.store, PER_VAULT_PULSE_SAMPLE);
      // eslint-disable-next-line no-await-in-loop -- see above
      const contrib = await contributorsSummary(opened.value.store, PER_VAULT_PULSE_SAMPLE);
      if (!fresh.ok || !contrib.ok) {
        rows.push({ alias: v.alias, status: 'unreadable' });
        continue;
      }
      const top = contrib.value.contributors[0];
      rows.push({
        alias: v.alias,
        status: 'ok',
        coveragePct: fresh.value.coveragePct,
        ...(top !== undefined
          ? { topContributor: { author: top.author, componentCount: top.componentCount } }
          : {}),
      });
    } finally {
      // eslint-disable-next-line no-await-in-loop -- see above
      await opened.value.dispose();
    }
  }
  return { rows, consideredCount: considered.length };
};

/**
 * The `sfi.generate_fleet_report` MCP tool. See the module JSDoc for the
 * composition + honesty design.
 */
export const generateFleetReportHandler = async (
  ctx: Context,
  input: GenerateFleetReportInput,
): Promise<Result<McpResponse<GenerateFleetReportOutput>, McpError>> => {
  const root = findRegistryRoot(ctx.vaultRoot);
  const registryResult = await listRegisteredVaults(root);
  if (!registryResult.ok) {
    return err({
      kind: 'internal',
      message: `fleet registry could not be read: ${registryResult.error.message}`,
    });
  }
  const vaults = registryResult.value;
  const refreshedAt = ctx.manifest.refreshedAt;
  const sourceTreeHash = ctx.manifest.sourceTreeHash;
  const generatedAt = new Date().toISOString();
  const title = 'Fleet Report';

  // Fail closed: zero registered vaults never fabricates a fleet view.
  if (vaults.length === 0) {
    const body = [
      `# ${title}`,
      '',
      '## Executive Summary',
      '',
      FLEET_REPORT_NO_VAULTS_MESSAGE,
      '',
      renderFooter(
        refreshedAt,
        'Register at least one vault (`sfi register-vault <alias> <path>`), then re-run `sfi.generate_fleet_report({})`.',
      ),
    ].join('\n');
    const document = fitDocumentToBudget(
      {
        frontmatter: { title, generatedAt, sourceTreeHash, componentIds: [] },
        body,
        sectionConfidence: { 'Executive Summary': 'declared' },
        boundaries: [
          Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
          FLEET_REPORT_NO_VAULTS_MESSAGE,
        ],
      },
      generatedDocByteBudget(),
    );
    return ok({ data: { document }, vaultState: { sourceTreeHash, refreshedAt } });
  }

  const limit = input.limit ?? FLEET_REPORT_DEFAULT_LIMIT;
  const rows = await buildVaultRows(vaults);
  const { rows: pulseRows, consideredCount } = await buildPulseRows(ctx, vaults, limit);

  const readableRows = rows.filter((r) => r.manifestStatus === 'ok');
  const unreadableAliases = rows
    .filter((r) => r.manifestStatus === 'unreadable')
    .map((r) => r.alias);
  const totalComponentsAcrossFleet = readableRows.reduce(
    (sum, r) => sum + (r.totalComponents ?? 0),
    0,
  );
  const mostBehind = rankMostBehind(rows);
  const versionGroups = buildVersionGroups(rows);
  const countSpread = buildCountSpread(readableRows);
  const pulseUnreadableAliases = pulseRows
    .filter((r) => r.status === 'unreadable')
    .map((r) => r.alias);

  // --- Executive Summary ----------------------------------------------------
  const execLines = [
    '## Executive Summary',
    '',
    `Registered vaults: ${vaults.length.toString()} (${readableRows.length.toString()} with a readable manifest)  `,
    `Total components across the fleet: ${totalComponentsAcrossFleet.toString()}  `,
    mostBehind === null
      ? 'Most behind: n/a'
      : mostBehind.reason === 'never-refreshed'
        ? `Most behind: \`${mostBehind.alias}\` — never refreshed (or its manifest is unreadable)  `
        : `Most behind: \`${mostBehind.alias}\` — last refreshed ${mostBehind.refreshedAt}  `,
    versionGroups.length > 1
      ? `Extractor-version spread: ${versionGroups.length.toString()} distinct sf-intelligence versions across the fleet (see Notable Divergences)  `
      : 'Extractor-version spread: none — every readable vault reports the same product version  ',
  ];
  const execBlock = execLines.join('\n');

  // --- Per-Org Inventory ------------------------------------------------------
  const inventoryRows = rows.map((r) => [
    r.alias,
    r.manifestStatus,
    r.sourceOrg ?? 'unknown',
    r.version ?? 'unknown',
    r.refreshedAt ?? 'never / unreadable',
    r.totalComponents === null ? 'unknown' : r.totalComponents.toString(),
    r.topComponentTypes.length === 0
      ? '—'
      : r.topComponentTypes.map((t) => `${t.type}(${t.count.toString()})`).join(', '),
  ]);
  const inventoryBlock = [
    '## Per-Org Inventory',
    '',
    mdTable(
      ['Alias', 'Status', 'Source Org', 'Version', 'Last Refreshed', 'Total Components', 'Top Types'],
      inventoryRows,
    ),
  ].join('\n');

  // --- Freshness & Contributors (org-pulse digest) -----------------------------
  const pulseTableRows = pulseRows.map((p) => [
    p.alias,
    p.status,
    p.coveragePct === undefined ? '—' : `${p.coveragePct.toString()}%`,
    p.topContributor === undefined
      ? '—'
      : `${p.topContributor.author} (${p.topContributor.componentCount.toString()})`,
  ]);
  const pulseBlockLines = [
    '## Freshness & Contributors',
    '',
    pulseTableRows.length === 0
      ? '_(no vaults considered for the pulse digest)_'
      : mdTable(['Alias', 'Status', 'Freshness Coverage', 'Top Contributor'], pulseTableRows),
  ];
  if (vaults.length > consideredCount) {
    pulseBlockLines.push('', `_(${fleetReportPulseScopeDisclosure(consideredCount, vaults.length, limit)})_`);
  }
  const pulseBlock = pulseBlockLines.join('\n');

  // --- Notable Divergences -----------------------------------------------------
  const divergenceLines: string[] = ['## Notable Divergences', ''];
  let anyDivergence = false;
  if (versionGroups.length > 1) {
    anyDivergence = true;
    divergenceLines.push(
      '**Extractor version split** — differently-versioned vaults can show metadata drift that reflects the EXTRACTOR, not the org:',
      '',
      mdTable(
        ['Version', 'Vaults'],
        versionGroups.map((g) => [g.version, g.aliases.join(', ')]),
      ),
      '',
    );
  }
  if (countSpread !== null) {
    anyDivergence = true;
    divergenceLines.push(
      `**Component-count spread** — \`${countSpread.minAlias}\` (${countSpread.minCount.toString()}) vs \`${countSpread.maxAlias}\` (${countSpread.maxCount.toString()}); a wide spread often means the smaller vault had a scoped/partial refresh rather than a genuinely smaller org — cross-check with \`sfi.get_manifest\` on that vault.`,
    );
  }
  if (!anyDivergence) {
    divergenceLines.push('_(no extractor-version split or notable component-count spread detected)_');
  }
  const divergenceBlock = divergenceLines.join('\n');

  // --- Live Drift (Skipped) -----------------------------------------------------
  const liveDriftBlock = ['## Live Drift (Skipped)', '', FLEET_REPORT_LIVE_DRIFT_SKIPPED_DISCLOSURE].join(
    '\n',
  );

  const body = [
    `# ${title}`,
    '',
    execBlock,
    '',
    inventoryBlock,
    '',
    pulseBlock,
    '',
    divergenceBlock,
    '',
    liveDriftBlock,
    '',
    renderFooter(
      refreshedAt,
      'Re-run `sfi.generate_fleet_report({})` after registering/refreshing vaults, or after `sfi refresh` on this vault.',
    ),
  ].join('\n');

  const sectionConfidence: Record<string, ConfidenceLevel> = {
    'Executive Summary': 'declared',
    'Per-Org Inventory': 'declared',
    'Freshness & Contributors': 'declared',
    'Notable Divergences': 'heuristic',
    'Live Drift (Skipped)': 'declared',
  };

  const boundaries: string[] = [
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    INHERITED_CONFIDENCE_DISCLOSURE,
    STRUCTURAL_DISCLOSURE,
    'The Q125 freshness timestamp above is for THIS MCP session\'s own vault only — each registered vault\'s own refresh timestamp is in the Per-Org Inventory table.',
    FLEET_REPORT_MANIFEST_DISCLOSURE,
    ORG_PULSE_DISCLOSURE,
    FLEET_REPORT_LIVE_DRIFT_SKIPPED_DISCLOSURE,
  ];
  if (vaults.length > consideredCount) {
    boundaries.push(fleetReportPulseScopeDisclosure(consideredCount, vaults.length, limit));
  }
  if (unreadableAliases.length > 0) {
    boundaries.push(
      `Manifest UNREADABLE for: ${unreadableAliases.join(', ')} — listed in Per-Org Inventory with status \`unreadable\`, not dropped; counts show as unknown, never zero.`,
    );
  }
  if (pulseUnreadableAliases.length > 0) {
    boundaries.push(
      `Graph store UNREADABLE (pulse digest only) for: ${pulseUnreadableAliases.join(', ')} — its Freshness & Contributors row shows status \`unreadable\`; that vault's manifest-level facts above are unaffected.`,
    );
  }

  const document = fitDocumentToBudget(
    {
      frontmatter: { title, generatedAt, sourceTreeHash, componentIds: [] },
      body,
      sectionConfidence,
      boundaries,
    },
    generatedDocByteBudget(),
  );

  return ok({ data: { document }, vaultState: { sourceTreeHash, refreshedAt } });
};
