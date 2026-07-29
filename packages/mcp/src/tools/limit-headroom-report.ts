/**
 * Handler for the `sfi.limit_headroom_report` MCP tool.
 *
 * The OFFLINE, vault-only replacement for the retiring Salesforce Optimizer's
 * "limit" report. It counts the org's METADATA against per-object and per-org
 * CONFIGURATION ceilings (custom fields per object, validation rules, record
 * types, relationship fields; org-wide custom objects / tabs / apps and active
 * flows) and ranks the rows WORST-FIRST by remaining headroom%, so an admin acts
 * before a deploy hits a ceiling.
 *
 * It is deliberately NOT:
 *   - `sfi.tech_debt_score` — a weighted debt INDEX with no per-limit headroom.
 *   - `sfi.coverage_report` — RETRIEVAL coverage (what was pulled/modeled), not
 *     a metadata-vs-configuration-limit table.
 *
 * ARCHITECTURE — a PURE core ({@link buildHeadroomRows} / {@link rankWorstFirst})
 * takes `{ scope, metric, subject, consumed }` inputs + the curated
 * {@link SALESFORCE_LIMITS} cap table + an optional edition and returns ranked
 * headroom rows. It is unit-testable with NO vault. The handler is the thin MCP
 * wrapper: it scans the graph for the counts, applies the cap table, ranks, pages
 * the per-object rows, and builds the honesty spine.
 *
 * HONESTY SPINE (this is the load-bearing part):
 *   - **Edition is unknown offline.** Edition-dependent limits are computed
 *     against an ASSUMED edition (default `enterprise`) unless the caller passes
 *     `edition`; every such row is labeled `limitBasis: 'assumed-edition'` and the
 *     assumption is disclosed VERBATIM in `boundaries[]`. The cap table holds
 *     GENERAL Salesforce documented limits, NEVER this org's provisioned limits.
 *   - **Field consumption is an APPROXIMATION.** Geolocation fields consume 3
 *     field slots each (counted as 3); roll-up summary has a separate per-object
 *     cap not modeled here; managed-package (namespaced) fields are reported
 *     separately and excluded from the consumed count because installed managed
 *     fields generally do not count toward the per-object limit (but some do).
 *     Prefer under-claiming: geolocation is counted at its 3x multiplier.
 *   - **Coverage is a floor.** Only metadata FAMILIES the refresh retrieved are
 *     counted; an un-retrieved family reads as 0 consumed — a FLOOR, not a truth.
 *     Rows whose backing family is not fully covered carry `consumedIsFloor`.
 *   - **Runtime limits are out of scope.** Data / file storage, API request
 *     counts, and daily async executions are not knowable offline and are
 *     deferred to the consent-gated live plane (`sfi.live_org_limits`).
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

// ---------------------------------------------------------------------------
// The curated GENERAL Salesforce configuration-limit cap table.
//
// This is org-INDEPENDENT general Salesforce knowledge (treated like the Concept
// Model): published, documented configuration ceilings — NEVER a read of this
// org's provisioned limits. Numbers vary by edition and by per-org provisioning
// / add-ons, so every edition-dependent cap carries per-edition values and is
// surfaced with `limitBasis: 'assumed-edition'`; general (edition-independent)
// caps carry a single `generalLimit`. `null` means "no practical single ceiling"
// (effectively unlimited for that edition).
// ---------------------------------------------------------------------------

/** Editions whose caps differ. `performance` folds into `unlimited` here. */
export type Edition = 'enterprise' | 'unlimited' | 'developer' | 'professional';

/** Whether a row's LIMIT is a general Salesforce number or an assumed-edition one. */
export type LimitBasis = 'general' | 'assumed-edition';

/** The edition assumed when the caller does not supply one. Disclosed verbatim. */
export const DEFAULT_ASSUMED_EDITION: Edition = 'enterprise';

/** All editions the cap table knows, in a stable order (for range disclosure). */
export const KNOWN_EDITIONS: readonly Edition[] = [
  'enterprise',
  'unlimited',
  'developer',
  'professional',
];

/** One curated configuration limit. */
export interface LimitCap {
  /** Stable machine key, e.g. `customFields`. */
  readonly metric: string;
  /** `'object'` — per-CustomObject; `'org'` — per-org. */
  readonly scope: 'object' | 'org';
  /** Human label surfaced in the legend. */
  readonly label: string;
  /** Whether the limit is edition-dependent (`assumed-edition`) or `general`. */
  readonly basis: LimitBasis;
  /** Single general ceiling (`null` = effectively unlimited). Present iff basis `general`. */
  readonly generalLimit?: number | null;
  /** Per-edition ceilings (`null` = unlimited for that edition). Present iff basis `assumed-edition`. */
  readonly editionLimits?: Readonly<Partial<Record<Edition, number | null>>>;
  /** GENERAL Salesforce source note — never this org's provisioned limit. */
  readonly sourceNote: string;
  /** When the CONSUMED side is an approximation, what it assumes/excludes. */
  readonly consumptionCaveat?: string;
}

/**
 * The cap table. All figures are GENERAL, publicly documented Salesforce
 * configuration limits as of the 2026 platform; they are subject to change and
 * to per-org provisioning. They are NOT a reflection of this org's entitlements.
 */
export const SALESFORCE_LIMITS: readonly LimitCap[] = Object.freeze([
  // --- Per-object caps ---
  {
    metric: 'customFields',
    scope: 'object',
    label: 'Custom fields per object',
    basis: 'assumed-edition',
    editionLimits: {
      enterprise: 800,
      unlimited: 900,
      developer: 800,
      professional: 100,
    },
    sourceNote:
      'General Salesforce documented limit — custom fields per object: Enterprise 800, Unlimited/Performance 900, Developer 800, Professional 100. Edition-dependent; not this org’s provisioned limit.',
    consumptionCaveat:
      'Approximate consumption: geolocation fields are counted as 3 field slots each; roll-up summary fields have a separate per-object cap not modeled here; managed-package (namespaced) fields are excluded (they generally do not count toward the limit, though some do). Standard fields are not counted toward the custom-field limit.',
  },
  {
    metric: 'validationRules',
    scope: 'object',
    label: 'Active validation rules per object',
    basis: 'general',
    generalLimit: 100,
    sourceNote:
      'General Salesforce documented limit — up to 100 active validation rules per object. Not edition-dependent. This count includes all retrieved validation rules (active + inactive), so it is an upper bound on the active-rule figure.',
    consumptionCaveat:
      'The limit is on ACTIVE validation rules; the offline count does not separate active from inactive, so consumed is an upper bound (over-counts, under-claims headroom — the safe direction).',
  },
  {
    metric: 'recordTypes',
    scope: 'object',
    label: 'Record types per object',
    basis: 'general',
    generalLimit: 200,
    sourceNote:
      'General Salesforce guidance — roughly 200 record types per object (with per-business-process nuance). This is an approximate general ceiling, not a hard edition-published number.',
  },
  {
    metric: 'relationshipFields',
    scope: 'object',
    label: 'Relationship fields per object (lookup + master-detail)',
    basis: 'general',
    generalLimit: 40,
    sourceNote:
      'General Salesforce documented limit — up to 40 relationship fields per object; master-detail is further capped at 2 per object. Not edition-dependent.',
    consumptionCaveat:
      'Counts custom (non-managed) lookup + master-detail fields retrieved into the vault. STANDARD relationship fields and managed-package relationship fields are not counted, so consumed is a floor.',
  },
  // --- Per-org caps ---
  {
    metric: 'customObjects',
    scope: 'org',
    label: 'Custom objects per org',
    basis: 'assumed-edition',
    editionLimits: {
      enterprise: 200,
      unlimited: 2000,
      developer: 400,
      professional: 50,
    },
    sourceNote:
      'General Salesforce documented limit — custom objects per org: Enterprise 200, Unlimited/Performance 2000, Developer 400, Professional 50. Provisioned add-ons can raise this. Edition-dependent; not this org’s provisioned limit.',
    consumptionCaveat:
      'Counts custom objects (api name ending in `__c`), excluding managed-package (namespaced) objects, which do not count toward the org limit. Custom Metadata Types (`__mdt`), Platform Events (`__e`), Big Objects (`__b`), and External Objects (`__x`) have their own separate limits and are NOT counted here.',
  },
  {
    metric: 'customTabs',
    scope: 'org',
    label: 'Custom tabs per org',
    basis: 'assumed-edition',
    editionLimits: {
      enterprise: 25,
      unlimited: null,
      developer: null,
      professional: 10,
    },
    sourceNote:
      'General Salesforce documented limit — custom tabs per org: Professional 10, Enterprise 25, Unlimited/Performance and Developer effectively unlimited. Edition-dependent; not this org’s provisioned limit.',
    consumptionCaveat:
      'Counts custom tabs excluding managed-package (namespaced) tabs.',
  },
  {
    metric: 'customApps',
    scope: 'org',
    label: 'Custom apps per org',
    basis: 'assumed-edition',
    editionLimits: {
      enterprise: 25,
      unlimited: null,
      developer: null,
      professional: 10,
    },
    sourceNote:
      'General Salesforce documented limit — custom apps per org: Professional 10, Enterprise 25, Unlimited/Performance and Developer effectively unlimited. Edition-dependent and approximate; not this org’s provisioned limit.',
    consumptionCaveat:
      'Counts custom applications excluding managed-package (namespaced) apps.',
  },
  {
    metric: 'activeFlows',
    scope: 'org',
    label: 'Active flows and processes per org',
    basis: 'general',
    generalLimit: 2000,
    sourceNote:
      'General Salesforce documented limit — up to 2,000 active flows and processes per org (4,000 total). Not edition-dependent.',
    consumptionCaveat:
      'Counts modeled Flow definitions whose status is Active. Process Builder processes and individual flow VERSIONS also consume against this org limit but are not separately counted here, so consumed is a floor.',
  },
]);

/** Index the cap table by `scope:metric` for O(1) lookup. */
const CAP_INDEX: ReadonlyMap<string, LimitCap> = new Map(
  SALESFORCE_LIMITS.map((cap) => [`${cap.scope}:${cap.metric}`, cap]),
);

/** Resolve the cap for a `(scope, metric)` pair, or `undefined` if unmodeled. */
export const capFor = (
  scope: 'object' | 'org',
  metric: string,
): LimitCap | undefined => CAP_INDEX.get(`${scope}:${metric}`);

// ---------------------------------------------------------------------------
// The PURE core — unit-testable without a vault.
// ---------------------------------------------------------------------------

/** A caller-supplied consumption count to score against the cap table. */
export interface HeadroomInput {
  readonly scope: 'object' | 'org';
  readonly metric: string;
  /** The object api name, or `'org'` for an org-wide metric. */
  readonly subject: string;
  readonly consumed: number;
  /** True when `consumed` is an approximation (e.g. field multiplier applied). */
  readonly consumedIsApproximate?: boolean;
  /** True when the backing family was not fully retrieved (consumed is a floor). */
  readonly consumedIsFloor?: boolean;
  /** Optional numeric breakdown (namespacedExcluded, geolocationCount, …). */
  readonly detail?: Readonly<Record<string, number>>;
}

/** One scored headroom row. Lean by design — labels/notes live in the legend. */
export interface HeadroomRow {
  readonly scope: 'object' | 'org';
  readonly metric: string;
  readonly subject: string;
  readonly consumed: number;
  /** The resolved ceiling; `null` when effectively unlimited. */
  readonly limit: number | null;
  /** `(limit - consumed) / limit * 100`, one decimal; `null` when unlimited. Can be negative. */
  readonly headroomPct: number | null;
  /** `limit - consumed`; `null` when unlimited. Can be negative. */
  readonly remaining: number | null;
  /** True when `consumed > limit` (over the assumed/general ceiling). */
  readonly overLimit: boolean;
  readonly limitBasis: LimitBasis;
  /** The edition whose number was applied, or `null` for a general limit. */
  readonly editionApplied: Edition | null;
  /** True when the edition was ASSUMED (caller passed none) for an edition-dependent row. */
  readonly editionAssumed: boolean;
  readonly consumedIsApproximate: boolean;
  readonly consumedIsFloor: boolean;
  readonly detail?: Readonly<Record<string, number>>;
}

/** The resolved limit for a cap under a (possibly assumed) edition. */
export interface ResolvedLimit {
  readonly limit: number | null;
  readonly basis: LimitBasis;
  readonly editionApplied: Edition | null;
  readonly editionAssumed: boolean;
}

/**
 * Resolve a cap's ceiling under an edition. A `general` cap ignores edition. An
 * `assumed-edition` cap uses the caller's edition, or {@link DEFAULT_ASSUMED_EDITION}
 * when none was given (flagged `editionAssumed: true`).
 */
export const resolveLimit = (
  cap: LimitCap,
  edition: Edition | undefined,
): ResolvedLimit => {
  if (cap.basis === 'general') {
    return {
      limit: cap.generalLimit ?? null,
      basis: 'general',
      editionApplied: null,
      editionAssumed: false,
    };
  }
  const editionApplied = edition ?? DEFAULT_ASSUMED_EDITION;
  const limit = cap.editionLimits?.[editionApplied] ?? null;
  return {
    limit,
    basis: 'assumed-edition',
    editionApplied,
    editionAssumed: edition === undefined,
  };
};

/** Round to one decimal place. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Score a single input against its cap. Returns `undefined` for an unmodeled metric. */
export const scoreHeadroomRow = (
  input: HeadroomInput,
  edition: Edition | undefined,
): HeadroomRow | undefined => {
  const cap = capFor(input.scope, input.metric);
  if (cap === undefined) return undefined;
  const resolved = resolveLimit(cap, edition);
  const limit = resolved.limit;
  const headroomPct =
    limit === null || limit === 0 ? null : round1(((limit - input.consumed) / limit) * 100);
  const remaining = limit === null ? null : limit - input.consumed;
  return {
    scope: input.scope,
    metric: input.metric,
    subject: input.subject,
    consumed: input.consumed,
    limit,
    headroomPct,
    remaining,
    overLimit: limit !== null && input.consumed > limit,
    limitBasis: resolved.basis,
    editionApplied: resolved.editionApplied,
    editionAssumed: resolved.editionAssumed,
    consumedIsApproximate: input.consumedIsApproximate === true,
    consumedIsFloor: input.consumedIsFloor === true,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
};

/** Score every input; unmodeled metrics are dropped. */
export const buildHeadroomRows = (
  inputs: readonly HeadroomInput[],
  edition: Edition | undefined,
): readonly HeadroomRow[] =>
  inputs
    .map((input) => scoreHeadroomRow(input, edition))
    .filter((row): row is HeadroomRow => row !== undefined);

/**
 * Rank rows WORST-FIRST: lowest numeric `headroomPct` first; rows with an
 * unlimited (`null`) headroom sort last. Tiebreak by higher `consumed`, then
 * `subject`, then `metric` — a total order, so the sort is deterministic.
 */
export const rankWorstFirst = (
  rows: readonly HeadroomRow[],
): readonly HeadroomRow[] =>
  [...rows].sort((a, b) => {
    const ah = a.headroomPct;
    const bh = b.headroomPct;
    if (ah === null && bh === null) {
      // both unlimited — order by consumed desc so the busier one shows first
      if (a.consumed !== b.consumed) return b.consumed - a.consumed;
    } else if (ah === null) {
      return 1;
    } else if (bh === null) {
      return -1;
    } else if (ah !== bh) {
      return ah - bh;
    } else if (a.consumed !== b.consumed) {
      return b.consumed - a.consumed;
    }
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
  });

/** The minimum numeric headroom% across a set of rows (`null` when all unlimited). */
export const worstHeadroomOf = (
  rows: readonly HeadroomRow[],
): number | null => {
  let worst: number | null = null;
  for (const row of rows) {
    if (row.headroomPct === null) continue;
    if (worst === null || row.headroomPct < worst) worst = row.headroomPct;
  }
  return worst;
};

/** Result of packing a ranked list into a byte budget ({@link packToByteBudget}). */
export interface BytePackResult<T> {
  /** The items included on this page (already sliced to fit `limit` AND the budget). */
  readonly page: readonly T[];
  /**
   * The resume cursor. ALWAYS equals `offset + page.length` — the cursor can
   * never overstate the advance, so a caller that follows it can never skip a
   * ranked item.
   */
  readonly nextOffset: number;
  /** True when items remain past `nextOffset`. */
  readonly truncated: boolean;
  /** True when the page stopped for the BYTE budget before reaching `limit`/end. */
  readonly byteTrimmed: boolean;
}

/**
 * Greedily pack `items[offset..]` (at most `limit` items) into `budgetBytes`,
 * measuring each item with `sizeOf`. This is the tool's cursor-integrity
 * primitive: it self-fits the page HERE so the central `jsonResult` response
 * guard never has to tail-truncate the array and leave a hand-set `nextOffset`
 * stale (the exact defect this closes — the guard truncates `data.objects` but
 * does NOT repair a handler's own `nextOffset`).
 *
 * Invariants:
 *   - `nextOffset === offset + page.length` — the advertised advance is EXACTLY
 *     the served count, so a walk following the cursor drops no row.
 *   - Forward progress: when `offset` is in range at least ONE item is emitted,
 *     even if that single item alone exceeds `budgetBytes` — so a page is never
 *     empty with a non-zero `nextOffset`. (A degenerate over-budget single item
 *     is still tiny next to the response budget, so the central guard does not
 *     truncate it either.)
 *   - An `offset` at/after the end yields an empty page, `nextOffset === offset`,
 *     `truncated === false`.
 */
export const packToByteBudget = <T>(
  items: readonly T[],
  offset: number,
  limit: number,
  budgetBytes: number,
  sizeOf: (item: T) => number,
): BytePackResult<T> => {
  const page: T[] = [];
  let used = 0;
  for (let i = offset; i < items.length && page.length < limit; i += 1) {
    const item = items[i] as T;
    const cost = sizeOf(item);
    // Always keep the first item (forward progress); stop before the budget
    // would be exceeded for any subsequent one.
    if (page.length > 0 && used + cost > budgetBytes) break;
    page.push(item);
    used += cost;
  }
  const nextOffset = offset + page.length;
  const remaining = Math.max(0, items.length - offset);
  return {
    page,
    nextOffset,
    truncated: nextOffset < items.length,
    // Trimmed iff we served fewer than could have been by count alone — the
    // only remaining reason is the byte budget.
    byteTrimmed: page.length < Math.min(limit, remaining),
  };
};

// ---------------------------------------------------------------------------
// Node classification helpers (pure — exported for tests).
// ---------------------------------------------------------------------------

/**
 * True when a component api name carries a managed-package namespace prefix
 * (`ns__Name__c`). Detection: strip a trailing custom suffix (`__c`/`__mdt`/…),
 * and if the remainder still contains `__`, the leading token is a namespace.
 */
export const isNamespaced = (apiName: string): boolean => {
  const stripped = apiName.replace(/__[a-z]+$/i, '');
  return stripped.includes('__');
};

/** True when a field api name is a custom field (`__c` suffix). */
const isCustomFieldApi = (apiName: string): boolean => /__c$/i.test(apiName);

/** True when an object api name is a standard custom object (`__c`, not `__mdt`/`__e`/`__b`/`__x`). */
const isStandardCustomObjectApi = (apiName: string): boolean => /__c$/i.test(apiName);

/** Field slot cost — geolocation consumes 3 field slots each; everything else 1. */
const fieldSlotCost = (dataType: unknown): number =>
  dataType === 'Location' ? 3 : 1;

/** True when a CustomField's dataType is a relationship (lookup or master-detail). */
const isRelationshipDataType = (dataType: unknown): boolean =>
  dataType === 'Lookup' || dataType === 'MasterDetail';

// ---------------------------------------------------------------------------
// Verbatim boundary disclosures.
// ---------------------------------------------------------------------------

const EDITION_DISCLOSURE_PREFIX =
  'Edition cannot be read offline. Edition-dependent limits (custom fields per object; custom objects / tabs / apps per org) are computed against';

const buildEditionDisclosure = (
  edition: Edition | undefined,
): string => {
  const applied = edition ?? DEFAULT_ASSUMED_EDITION;
  const clause =
    edition === undefined
      ? `an ASSUMED "${applied}" edition (pass \`edition\` to override)`
      : `the caller-supplied "${applied}" edition`;
  return (
    `${EDITION_DISCLOSURE_PREFIX} ${clause}; every such row is labeled ` +
    `\`limitBasis: 'assumed-edition'\`. These are GENERAL Salesforce documented ` +
    `configuration limits, NOT this org's provisioned limits — an org may have ` +
    `add-on-provisioned higher ceilings, so a low or negative headroom on an ` +
    `assumed-edition row is a prompt to verify, not a proven breach.`
  );
};

const FIELD_MULTIPLIER_DISCLOSURE =
  'Custom-field consumption is an APPROXIMATION. Geolocation fields consume 3 field slots each (counted as 3 here); roll-up summary fields have a separate per-object cap not modeled here. Treat field headroom as indicative, not exact.';

const MANAGED_PACKAGE_DISCLOSURE =
  'Managed-package (namespaced, `ns__…`) fields, objects, tabs, and apps are EXCLUDED from the consumed counts because installed managed components generally do not count toward these limits — but some managed fields DO count, so an excluded count is a best-effort approximation. The per-object field row reports the excluded namespaced count in its `detail`.';

const RUNTIME_DEFERRED_DISCLOSURE =
  'This report covers CONFIGURATION limits (metadata counts vs per-object / per-org ceilings) only. RUNTIME limits — data / file storage, API request counts, daily async executions, and other usage-based limits — are not knowable offline and are deferred to the consent-gated live plane (`sfi.live_org_limits`).';

const NOT_TECH_DEBT_DISCLOSURE =
  'This is a configuration-ceiling headroom table, distinct from `sfi.tech_debt_score` (a weighted debt index with no per-limit headroom) and `sfi.coverage_report` (retrieval coverage, not config limits).';

const buildCoverageFloorDisclosure = (
  incompleteFamilies: readonly string[],
): string =>
  'Only metadata FAMILIES the last refresh retrieved are counted. A family the ' +
  'refresh did not retrieve (or retrieved partially) reads as 0 or under-counted ' +
  'consumed — a FLOOR on real consumption, not the truth; such rows carry ' +
  '`consumedIsFloor: true`. Standard-object fields and standard relationship ' +
  'fields absent from the retrieve are likewise not counted. ' +
  (incompleteFamilies.length > 0
    ? `Coverage-incomplete families relevant to this report: ${[...incompleteFamilies].sort().join(', ')}.`
    : 'All families this report counts are fully covered per the manifest.');

// ---------------------------------------------------------------------------
// Handler types.
// ---------------------------------------------------------------------------

/** A per-metric legend entry (label + notes) — deduped out of the lean rows. */
export interface MetricLegendEntry {
  readonly label: string;
  readonly scope: 'object' | 'org';
  readonly basis: LimitBasis;
  readonly sourceNote: string;
  readonly consumptionCaveat?: string;
}

/** One object's headroom rows + its worst metric. */
export interface ObjectHeadroom {
  readonly objectApiName: string;
  readonly componentId: ComponentId;
  /** The tightest numeric headroom% across this object's rows (`null` when all unlimited). */
  readonly worstHeadroomPct: number | null;
  readonly rows: readonly HeadroomRow[];
}

export interface LimitHeadroomReportOutput {
  /** Edition provenance: what was provided vs assumed. */
  readonly edition: {
    readonly provided: Edition | null;
    readonly applied: Edition;
    readonly assumed: boolean;
  };
  /** Legend: label + source note + consumption caveat per metric (deduped). */
  readonly metricLegend: Readonly<Record<string, MetricLegendEntry>>;
  /** Org-wide rows — always fully included (small), ranked worst-first. */
  readonly orgLimits: readonly HeadroomRow[];
  /** The tightest rows across the WHOLE report (org + all objects), ≤5 — page-independent. */
  readonly topRisks: readonly HeadroomRow[];
  /** Per-object rows, ranked worst-first, PAGED by `limit`/`offset`. */
  readonly objects: readonly ObjectHeadroom[];
  /** Object count BEFORE the page slice. */
  readonly totalObjectCount: number;
  /** Objects actually scanned this run. */
  readonly scannedObjectCount: number;
  /** Coverage honesty for the counted families. */
  readonly coverage: {
    readonly incompleteFamilies: readonly string[];
    readonly note: string;
  };
  /** Verbatim honesty disclosures. */
  readonly boundaries: readonly string[];
  /** True when the object-level slice was trimmed to `limit`. */
  readonly truncated: boolean;
  readonly trust: TrustSummary;
  /** Requested page size echoed. Present only on a PAGED response (`truncated`, `offset > 0`, or byte-trimmed). */
  readonly limit?: number;
  /** Zero-based offset of the first returned object. Present only when paged. */
  readonly offset?: number;
  /**
   * Offset to pass on the next call. ALWAYS equals `offset + objects.length` —
   * the cursor never overstates the advance, so a consumer that follows it can
   * never skip a ranked object. Present only when `truncated`.
   */
  readonly nextOffset?: number;
  /**
   * True when the page was trimmed below the requested `limit` to fit the
   * response byte budget (a large `limit` self-fits to fewer objects). The
   * cursor stays honest — resume from `nextOffset`. Present only when trimmed.
   */
  readonly byteTrimmed?: boolean;
  /** Human note explaining a byte-trimmed page. Present only when `byteTrimmed`. */
  readonly pageNote?: string;
}

/** Inclusive upper bound on the requested object-page `limit`. */
const LHR_MAX_LIMIT = 100;
/**
 * Default requested object-page size when the caller omits `limit`. The real
 * bound on the page is the BYTE budget, not this number: the handler self-fits
 * the object slice ({@link packToByteBudget}) so the response always lands under
 * {@link LHR_RESPONSE_TARGET_BYTES}. A caller can therefore pass `limit` up to
 * {@link LHR_MAX_LIMIT} and still get a whole, cursor-honest page — the page is
 * simply trimmed to as many objects as fit and `nextOffset` reflects exactly
 * what was served.
 */
const LHR_DEFAULT_LIMIT = 15;
/**
 * Self-fit target for the WHOLE serialized `{ data, vaultState }` body. Sits
 * below the central jsonResult response budget (default 40 KB,
 * `RESPONSE_BUDGET_DEFAULT_BYTES`) with headroom for the central vaultState
 * stamping (`targetOrg` / `vaultPath` / `builderVersion`), `estimatedPayloadBytes`,
 * and an optional org-drift badge. Sizing the object page HERE means the central
 * guard never has to tail-truncate `data.objects` — so this tool's own
 * `nextOffset` can never be left stale (the cursor-integrity bug this closes).
 */
const LHR_RESPONSE_TARGET_BYTES = 36_000;
/** Note surfaced when the object page was byte-trimmed below the requested `limit`. */
const LHR_PAGE_NOTE =
  'This object page was trimmed below the requested `limit` to fit the response byte budget. No ranked object was dropped: `nextOffset` equals `offset + objects.length`, so resume from it to walk the rest.';
/** Cap on the `topRisks` list. */
const TOP_RISKS_CAP = 5;

/** The metadata families this report counts (for coverage checks + node scan). */
const COUNTED_TYPES: readonly ComponentType[] = [
  'CustomObject',
  'CustomField',
  'ValidationRule',
  'RecordType',
  'CustomTab',
  'CustomApplication',
  'Flow',
];

export const limitHeadroomReportInputSchema = z.object({
  /**
   * Optional org edition. When omitted, edition-dependent limits use an assumed
   * edition (default `enterprise`) and disclose the assumption in `boundaries[]`.
   */
  edition: z
    .enum(['enterprise', 'unlimited', 'developer', 'professional'])
    .optional(),
  /**
   * Requested object-page size (1..100, default 15). Upper bound on the RANKED
   * per-object slice; the page also self-fits the response byte budget, so a
   * large `limit` returns as many objects as fit with an honest `nextOffset`.
   */
  limit: z.number().int().min(1).max(LHR_MAX_LIMIT).optional(),
  /** Zero-based offset for paging the ranked object list forward. */
  offset: z.number().int().min(0).optional(),
});

export type LimitHeadroomReportInput = z.infer<
  typeof limitHeadroomReportInputSchema
>;

/**
 * True when the manifest reports `complete` coverage for a family (or coverage
 * is unknown — a pre-coverage/legacy vault is not false-flagged, matching the
 * enumeration honesty surface). A `partial`/absent family means the count is a
 * floor.
 */
const coverageComplete = (ctx: Context, type: ComponentType): boolean => {
  const summary = summarizeCoverage(ctx.manifest, [type]);
  if (!summary.coverageKnown) return true; // legacy vault — do not false-flag
  return summary.status === 'complete';
};

/** Group nodes by `parentId` (undefined parent is dropped). */
const groupByParent = (
  nodes: readonly Node[],
): Map<ComponentId, Node[]> => {
  const map = new Map<ComponentId, Node[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = map.get(node.parentId);
    if (list === undefined) map.set(node.parentId, [node]);
    else list.push(node);
  }
  return map;
};

/**
 * The `sfi.limit_headroom_report` MCP tool. See the module JSDoc for the cap
 * table, the pure core, and the honesty spine.
 *
 * @example
 *   const r = await limitHeadroomReportHandler(ctx, { edition: 'enterprise' });
 *   if (r.ok) console.log(r.value.data.topRisks[0]);
 */
export const limitHeadroomReportHandler = async (
  ctx: Context,
  input: LimitHeadroomReportInput,
): Promise<Result<McpResponse<LimitHeadroomReportOutput>, McpError>> => {
  const edition = input.edition;
  const limit = input.limit ?? LHR_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  const scan = await scanAllNodesOfTypes(ctx.graph, COUNTED_TYPES);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }

  // Partition the scanned nodes by type.
  const byType = new Map<ComponentType, Node[]>();
  for (const type of COUNTED_TYPES) byType.set(type, []);
  for (const node of scan.value.nodes) {
    const bucket = byType.get(node.type);
    if (bucket !== undefined) bucket.push(node);
  }
  const objectsNodes = byType.get('CustomObject') ?? [];
  const fieldsByParent = groupByParent(byType.get('CustomField') ?? []);
  const vrByParent = groupByParent(byType.get('ValidationRule') ?? []);
  const rtByParent = groupByParent(byType.get('RecordType') ?? []);

  // --- Per-object inputs ---
  const objectHeadrooms: ObjectHeadroom[] = [];
  for (const obj of objectsNodes) {
    const fields = fieldsByParent.get(obj.id) ?? [];
    let localFieldSlots = 0; // custom, non-namespaced, geolocation counted as 3
    let namespacedExcluded = 0;
    let geolocationCount = 0;
    let relationshipCount = 0;
    for (const f of fields) {
      if (!isCustomFieldApi(f.apiName)) continue; // only custom fields count
      if (isNamespaced(f.apiName)) {
        namespacedExcluded += 1;
        continue;
      }
      const dataType = f.properties['dataType'];
      if (dataType === 'Location') geolocationCount += 1;
      localFieldSlots += fieldSlotCost(dataType);
      if (isRelationshipDataType(dataType)) relationshipCount += 1;
    }
    const vrCount = (vrByParent.get(obj.id) ?? []).length;
    const rtCount = (rtByParent.get(obj.id) ?? []).length;

    const inputs: HeadroomInput[] = [
      {
        scope: 'object',
        metric: 'customFields',
        subject: obj.apiName,
        consumed: localFieldSlots,
        consumedIsApproximate: true,
        consumedIsFloor: !coverageComplete(ctx, 'CustomField'),
        detail: {
          localCustomFields: localFieldSlots - geolocationCount * 2,
          geolocationFields: geolocationCount,
          namespacedExcluded,
        },
      },
      {
        scope: 'object',
        metric: 'validationRules',
        subject: obj.apiName,
        consumed: vrCount,
        consumedIsApproximate: true,
        consumedIsFloor: !coverageComplete(ctx, 'ValidationRule'),
      },
      {
        scope: 'object',
        metric: 'recordTypes',
        subject: obj.apiName,
        consumed: rtCount,
        consumedIsFloor: !coverageComplete(ctx, 'RecordType'),
      },
      {
        scope: 'object',
        metric: 'relationshipFields',
        subject: obj.apiName,
        consumed: relationshipCount,
        consumedIsFloor: !coverageComplete(ctx, 'CustomField'),
      },
    ];
    const rows = rankWorstFirst(buildHeadroomRows(inputs, edition));
    objectHeadrooms.push({
      objectApiName: obj.apiName,
      componentId: obj.id,
      worstHeadroomPct: worstHeadroomOf(rows),
      rows,
    });
  }

  // Rank objects worst-first by their tightest metric (nulls last).
  objectHeadrooms.sort((a, b) => {
    const aw = a.worstHeadroomPct;
    const bw = b.worstHeadroomPct;
    if (aw === null && bw === null) {
      return a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0;
    }
    if (aw === null) return 1;
    if (bw === null) return -1;
    if (aw !== bw) return aw - bw;
    return a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0;
  });

  // --- Org-wide inputs ---
  const localCustomObjects = objectsNodes.filter(
    (o) => isStandardCustomObjectApi(o.apiName) && !isNamespaced(o.apiName),
  ).length;
  const localCustomTabs = (byType.get('CustomTab') ?? []).filter(
    (n) => !isNamespaced(n.apiName),
  ).length;
  const localCustomApps = (byType.get('CustomApplication') ?? []).filter(
    (n) => !isNamespaced(n.apiName),
  ).length;
  const activeFlows = (byType.get('Flow') ?? []).filter(
    (n) => n.properties['status'] === 'Active',
  ).length;

  const orgInputs: HeadroomInput[] = [
    {
      scope: 'org',
      metric: 'customObjects',
      subject: 'org',
      consumed: localCustomObjects,
      consumedIsFloor: !coverageComplete(ctx, 'CustomObject'),
    },
    {
      scope: 'org',
      metric: 'customTabs',
      subject: 'org',
      consumed: localCustomTabs,
      consumedIsFloor: !coverageComplete(ctx, 'CustomTab'),
    },
    {
      scope: 'org',
      metric: 'customApps',
      subject: 'org',
      consumed: localCustomApps,
      consumedIsFloor: !coverageComplete(ctx, 'CustomApplication'),
    },
    {
      scope: 'org',
      metric: 'activeFlows',
      subject: 'org',
      consumed: activeFlows,
      consumedIsApproximate: true,
      consumedIsFloor: !coverageComplete(ctx, 'Flow'),
    },
  ];
  const orgLimits = rankWorstFirst(buildHeadroomRows(orgInputs, edition));

  // topRisks: the tightest numeric-headroom rows across the WHOLE report so a
  // paged response still surfaces the org-wide worst offenders.
  const allRows: HeadroomRow[] = [
    ...orgLimits,
    ...objectHeadrooms.flatMap((o) => o.rows),
  ];
  const topRisks = rankWorstFirst(allRows)
    .filter((r) => r.headroomPct !== null)
    .slice(0, TOP_RISKS_CAP);

  // Coverage honesty across the counted families.
  const incompleteFamilies = COUNTED_TYPES.filter(
    (t) => !coverageComplete(ctx, t),
  );

  // Build the metric legend (only for metrics that actually produced rows).
  const usedMetrics = new Set<string>();
  for (const r of orgLimits) usedMetrics.add(`${r.scope}:${r.metric}`);
  for (const o of objectHeadrooms) for (const r of o.rows) usedMetrics.add(`${r.scope}:${r.metric}`);
  const metricLegend: Record<string, MetricLegendEntry> = {};
  for (const cap of SALESFORCE_LIMITS) {
    if (!usedMetrics.has(`${cap.scope}:${cap.metric}`)) continue;
    metricLegend[cap.metric] = {
      label: cap.label,
      scope: cap.scope,
      basis: cap.basis,
      sourceNote: cap.sourceNote,
      ...(cap.consumptionCaveat !== undefined
        ? { consumptionCaveat: cap.consumptionCaveat }
        : {}),
    };
  }

  // Boundaries — always disclosed.
  const boundaries: string[] = [
    buildEditionDisclosure(edition),
    FIELD_MULTIPLIER_DISCLOSURE,
    MANAGED_PACKAGE_DISCLOSURE,
    RUNTIME_DEFERRED_DISCLOSURE,
    buildCoverageFloorDisclosure(incompleteFamilies),
    NOT_TECH_DEBT_DISCLOSURE,
  ];
  if (scan.value.scanIncomplete) {
    boundaries.push(
      scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit()),
    );
  }

  const completeness: TrustSummary['completeness'] =
    incompleteFamilies.length === 0
      ? { status: 'complete' }
      : { status: 'partial', missingCoverage: [...incompleteFamilies].sort() };

  // --- Self-fitting object page (cursor-honest) ---------------------------
  // The per-object rows dominate the payload. Rather than lean on the central
  // jsonResult budget (which tail-truncates `data.objects` yet leaves a hand-set
  // `nextOffset` stale — the cursor-integrity bug), size the page HERE: measure
  // the fixed envelope, give the remaining budget to the object slice, and
  // derive `nextOffset`/`truncated` from the objects we ACTUALLY include.
  const editionBlock = {
    provided: edition ?? null,
    applied: edition ?? DEFAULT_ASSUMED_EDITION,
    assumed: edition === undefined,
  };
  const coverageBlock = {
    incompleteFamilies,
    note: buildCoverageFloorDisclosure(incompleteFamilies),
  };
  const trust = offlineTrust(ctx, completeness);
  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };
  // Fixed envelope (everything except the `objects` page). Measured WITH the
  // pagination + note fields present so the object budget accounts for them.
  const fixedBody = {
    data: {
      edition: editionBlock,
      metricLegend,
      orgLimits,
      topRisks,
      objects: [] as ObjectHeadroom[],
      totalObjectCount: objectHeadrooms.length,
      scannedObjectCount: objectsNodes.length,
      coverage: coverageBlock,
      boundaries,
      truncated: true,
      trust,
      limit,
      offset,
      nextOffset: offset,
      byteTrimmed: true,
      pageNote: LHR_PAGE_NOTE,
    },
    vaultState,
  };
  const fixedBytes = Buffer.byteLength(JSON.stringify(fixedBody), 'utf8');
  const objectsBudget = Math.max(0, LHR_RESPONSE_TARGET_BYTES - fixedBytes);
  const packed = packToByteBudget(
    objectHeadrooms,
    offset,
    limit,
    objectsBudget,
    // +1 for the array comma separator between elements.
    (o) => Buffer.byteLength(JSON.stringify(o), 'utf8') + 1,
  );
  const isPaged = packed.truncated || offset > 0 || packed.byteTrimmed;

  return ok({
    data: {
      edition: editionBlock,
      metricLegend,
      orgLimits,
      topRisks,
      objects: packed.page,
      totalObjectCount: objectHeadrooms.length,
      scannedObjectCount: objectsNodes.length,
      coverage: coverageBlock,
      boundaries,
      truncated: packed.truncated,
      trust,
      ...(isPaged ? { limit, offset } : {}),
      ...(packed.truncated ? { nextOffset: packed.nextOffset } : {}),
      ...(packed.byteTrimmed ? { byteTrimmed: true, pageNote: LHR_PAGE_NOTE } : {}),
    },
    vaultState,
  });
};
