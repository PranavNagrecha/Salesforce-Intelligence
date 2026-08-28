/**
 * Handler for the `sfi.changed_since` MCP tool.
 *
 * The v1.7 freshness headline answers the buyer-priority gap "when was
 * X modified?". Given a `since` date (ISO 8601), enumerate every vault
 * node whose `properties.lastModifiedDate` is at or after that
 * timestamp. Optional `types` filter narrows the scan to a subset of
 * ComponentTypes; optional `limit` truncates the response.
 *
 * **Honesty axis** — the tool surfaces the partial-data shape via the
 * `unenrichedCount` field. Every node whose `properties.lastModifiedDate`
 * is `null` (i.e. not yet enriched via `sfi refresh --with-tooling-api`)
 * is counted in `unenrichedCount` so the consumer can surface a
 * "rerun refresh with --with-tooling-api for full coverage" suggestion
 * rather than silently dropping the unenriched fraction. The tool
 * remains FULLY FUNCTIONAL against an un-enriched vault: it returns
 * `changed: []` plus the full `unenrichedCount` so the caller sees
 * the gap explicitly.
 *
 * That axis was necessary and not sufficient. `unenrichedCount` is a bare
 * number sitting beside the list it invalidates, and nothing in the payload
 * said so: `changed: []` on a vault with no dates at all was byte-identical to
 * a completed scan that found nothing. `absence` (see
 * {@link ChangedSinceAbsenceKind}) now types each empty site — `changed` and a
 * zero `unenrichedCount` — so the two readings cannot be confused.
 *
 * v1.7 covers the six ComponentTypes the R2 dispatch table enriches
 * (ApexClass, ApexTrigger, Flow, Layout, CustomField, ValidationRule);
 * other types may receive freshness enrichment in v1.7+ R3 (ProfileSet,
 * EmailTemplate, etc.). The handler does NOT enforce that constraint —
 * any node with a non-null `lastModifiedDate` participates, regardless
 * of whether it was the enricher's output or a future v1.7 pass.
 *
 * Implementation notes:
 *   - The scan iterates the requested ComponentTypes — defaulting to the
 *     compile-time-proven `COMPONENT_TYPES` (the WHOLE `ComponentType`
 *     union, not a hand-listed subset; see `CHANGED_SINCE_DEFAULT_TYPES`)
 *     — via `scanAllNodesOfTypes`, which windows the SQL `OFFSET` forward
 *     until each type is exhausted. Nodes 501+ ARE reached; the only
 *     residual ceiling is `FULL_SCAN_MAX_NODES` per type, and a type that
 *     hits it is disclosed by name in `boundaries` and classified
 *     `scan-capped` in `absence`.
 *   - The `since` comparison is a string compare (ISO 8601 lex-sorts
 *     correctly for the same offset). v1.7 normalises `since` to UTC
 *     so a caller passing a local-time date does not silently flap the
 *     boundary.
 *   - Result sort: `lastModifiedDate DESC` then `id ASC`.
 */

import type {
  ComponentId,
  ComponentType,
  EvidenceAbsenceV2,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { buildCoverageEntries } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { COMPONENT_TYPES } from './list-components.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

/** Inclusive upper bound on `limit`. */
const CHANGED_SINCE_MAX_LIMIT = 500;

/** Default `limit` when the caller omits it. */
const CHANGED_SINCE_DEFAULT_LIMIT = 100;

const CHANGED_SINCE_TOOL = 'sfi.changed_since';

/**
 * The types scanned when the caller omits `types`.
 *
 * DERIVED, not hand-listed. This constant USED to be a 46-entry literal that
 * had drifted from the contracts union while `roster.ts` advertised "default
 * scans every ComponentType" and this module's JSDoc claimed "ALL types in the
 * v1.x contract". A bare `changed_since({ since })` therefore never looked at
 * 57 modelled types -- FlexiPage, CustomPermission, Report, Dashboard,
 * ListView, PermissionSetGroup, MutingPermissionSet, RestrictionRule,
 * ScopingRule, Network, CustomSite, TransactionSecurityPolicy, and every CPQ /
 * OmniStudio / GenAi type among them -- and still answered `truncated: false`
 * with no boundary naming the gap. The blind spot was unreadable from the
 * payload: a pre-deploy "what changed since my last refresh?" got a confident,
 * complete-looking list over less than half the modelled surface.
 *
 * It is now the SAME compile-time-proven `COMPONENT_TYPES` the validator uses
 * (`list-components.ts`, where a `satisfies` + an `Exclude<>` assertion prove it
 * is the whole `ComponentType` union), so the accepted set and the default
 * scanned set cannot drift apart again -- the advertised contract IS the
 * implementation. A type absent from this vault costs one indexed empty page,
 * and a requested type that contributed no node is still classified honestly by
 * `unretrievedTypes` below rather than folded into "nothing changed".
 *
 * `changed-since.test.ts` carries the drift guard: it seeds one freshly-dated
 * node of EVERY `ComponentType` and asserts a default call returns all of them,
 * so re-narrowing this default fails a test instead of a comment.
 */
const CHANGED_SINCE_DEFAULT_TYPES: readonly ComponentType[] = COMPONENT_TYPES;

/**
 * Natural "since my last refresh" tokens a host reaches for when the router
 * ranked `changed_since` for a refresh-relative ask
 * (CHANGED-SINCE-REJECTS-LAST-REFRESH-TOKEN). Each resolves to the vault's
 * `manifest.refreshedAt` — the moment this vault was built — so the answer is
 * grounded in a real timestamp rather than hard-failing on ISO validation.
 *
 * The separator is normalised (hyphen ≡ underscore ≡ space) so `last-refresh`,
 * `last_refresh`, and `last refresh` are all accepted — the residual the
 * hyphen-only fix left open.
 */
const REFRESH_SINCE_TOKENS: ReadonlySet<string> = new Set([
  'last-refresh',
  'lastrefresh',
  'refresh',
]);

/**
 * Whether `raw` is a refresh-relative `since` token. Case-insensitive, and any
 * run of hyphen / underscore / whitespace collapses to a single `-` so the
 * hyphen, underscore, and SPACE forms (`last refresh`) all resolve.
 */
const isRefreshToken = (raw: string): boolean =>
  REFRESH_SINCE_TOKENS.has(raw.trim().toLowerCase().replace(/[\s_-]+/g, '-'));

/**
 * Zod schema for the `sfi.changed_since` tool input.
 *
 *   - `since`: required — an ISO 8601 timestamp (date-only `YYYY-MM-DD` or
 *     full `YYYY-MM-DDTHH:mm:ssZ`), OR the natural token `last-refresh` /
 *     `last refresh` / `last_refresh` / `refresh` (separator-insensitive) which
 *     the handler resolves to the vault's `refreshedAt`. The runtime normalises
 *     non-Z-suffixed inputs to UTC so the boundary is unambiguous; the resolved
 *     boundary is echoed back as `since`.
 *   - `types`: optional array; when omitted, the handler scans every
 *     ComponentType in the v1.x contract.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100.
 */
export const changedSinceInputSchema = z.object({
  since: z.string().min(1).refine(
    (s) => isRefreshToken(s) || !Number.isNaN(Date.parse(s)),
    { message: 'since must be a valid ISO 8601 date string, or the token "last-refresh"' },
  ),
  types: z.array(z.enum(COMPONENT_TYPES)).optional(),
  limit: z.number().int().min(1).max(CHANGED_SINCE_MAX_LIMIT).optional(),
  // CR-22: page cursor for walking the full changed list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `changedSinceInputSchema`. */
export type ChangedSinceInput = z.infer<typeof changedSinceInputSchema>;

/** One entry in the `changed` array. */
export interface ChangedComponent {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly lastModifiedDate: string;
  readonly lastModifiedBy: {
    readonly id: string;
    readonly name: string;
  };
}

/**
 * Which kind of empty an empty `changed` list (or a zero `unenrichedCount`) is.
 * TYPED-ABSENCE-CHANGED-SINCE.
 *
 *   - `scan-capped` — a type's full scan hit `FULL_SCAN_MAX_NODES`, so nodes
 *     past the cap were never date-compared.
 *   - `page-past-end` — the RESULT SET is not empty; this PAGE is. A caller
 *     resuming a cursor past the last row gets `changed: []` while components
 *     genuinely did change.
 *   - `no-nodes-scanned` — the requested types hold no node in this vault at
 *     all. There was nothing to compare against the boundary.
 *   - `types-not-retrieved` — at least one requested type contributed zero
 *     nodes AND its coverage row does not confirm the retrieve landed it. That
 *     type was never checked, so absence over it is not evidence.
 *   - `freshness-not-enriched` — nodes WERE scanned but NONE carries a
 *     `lastModifiedDate`. The freshness overlay (`sfi refresh
 *     --with-tooling-api`) never ran, so this tool cannot know what changed:
 *     the empty list is a statement about the VAULT, not about the org.
 *   - `freshness-partially-enriched` — some scanned nodes carry no date. Any of
 *     them may have changed since the boundary and would be invisible here.
 *   - `checked-empty` — every scanned node carried a date, the scan completed,
 *     and none is at or after the boundary. A real finding of nothing.
 */
export type ChangedSinceAbsenceKind =
  | 'scan-capped'
  | 'page-past-end'
  | 'no-nodes-scanned'
  | 'types-not-retrieved'
  | 'freshness-not-enriched'
  | 'freshness-partially-enriched'
  | 'checked-empty';

/** One empty list / zero count in this payload, and which kind of empty it is. */
export interface ChangedSinceAbsenceSite {
  /** Dotted path of the empty site inside `data` (`changed`, `unenrichedCount`). */
  readonly path: string;
  readonly kind: ChangedSinceAbsenceKind;
  /** The shared `EvidenceAbsenceStatusV2` reading for THIS site. */
  readonly status: EvidenceAbsenceV2['status'];
  readonly reason: string;
}

/**
 * The typed absence attached whenever this payload asserts one.
 *
 * WHY: `changed: []` shipped bare. On a vault whose freshness overlay never ran
 * — the demo vault is one: 110 of 110 scanned nodes carry no
 * `lastModifiedDate` — the tool CANNOT know what changed, yet it answered
 * "nothing changed since 2020" in exactly the shape it uses for a real
 * finding of nothing. `unenrichedCount` was the only honesty axis and it is a
 * bare number: a reader had to know that a non-zero value invalidates the list
 * beside it, and nothing said so. `truncated: false` cannot carry the
 * distinction either — it describes the PAGE (and
 * `tests/integration/envelope-honesty.ts` deliberately rejects it as an absence
 * marker).
 *
 * Present ONLY when at least one site is actually empty, so a populated answer
 * never acquires a spurious not-checked marker.
 */
export interface ChangedSinceAbsence extends EvidenceAbsenceV2 {
  /** Per-site classification. Never a single blanket stamp over the payload. */
  readonly sites: readonly ChangedSinceAbsenceSite[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ChangedSinceOutput {
  /** The normalised `since` boundary (ISO 8601 UTC). */
  readonly since: string;
  readonly changed: readonly ChangedComponent[];
  /**
   * Count of nodes (within the requested `types`) whose
   * `lastModifiedDate` is `null`. The non-zero value tells the caller
   * the answer is partial — run `sfi refresh --with-tooling-api` for
   * full coverage.
   */
  readonly unenrichedCount: number;
  /** True when the response slice was trimmed to `limit`. */
  readonly truncated: boolean;
  /**
   * Present when this payload asserts an absence (`changed` is empty, or
   * `unenrichedCount` is zero): WHICH kind of empty each one is. Absent from a
   * payload that asserts none.
   */
  readonly absence?: ChangedSinceAbsence;
  /**
   * Honesty disclosure, present ONLY when a pathological type's full scan hit
   * FULL_SCAN_MAX_NODES (so the enumeration may be incomplete). Absent on a
   * normal full scan, keeping that response byte-identical to pre-CR-22.
   */
  readonly boundaries?: readonly string[];
  /**
   * Page size applied to this response. Present ONLY on a PAGED response
   * (`truncated` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned change. Present only when paged (see `limit`). */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when `truncated`. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated.
   * Echo it back as `cursor` to resume. Absent on a complete page so an
   * in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

/**
 * Normalise `since` to a UTC ISO 8601 string the comparison can use.
 * Accepts either a date-only `YYYY-MM-DD` (assumed UTC midnight) or a
 * full timestamp. Returns the canonical UTC ISO string.
 */
const normalizeSince = (raw: string): string => {
  // The Zod refine already verified `Date.parse(raw)` is finite.
  return new Date(raw).toISOString();
};

/**
 * Comparator: lastModifiedDate DESC, then id ASC.
 *
 * This is already a STRICT TOTAL order (CR-22): `id` is the unique node
 * ComponentId, so no two distinct ChangedComponents compare equal — the id-ASC
 * secondary key resolves every date tie uniquely. No further tiebreak is needed
 * for a dup-free / skip-free offset resume.
 */
const compareByDateDescThenIdAsc = (a: ChangedComponent, b: ChangedComponent): number => {
  if (a.lastModifiedDate !== b.lastModifiedDate) {
    return a.lastModifiedDate < b.lastModifiedDate ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Extract the `lastModifiedBy.id` / `.name` pair from a node's properties.
 * The v1.7 enricher writes `{ id, name }` under `properties.lastModifiedBy`;
 * the v0.1 baseline writes the legacy string-only `lastModifiedBy` field
 * on the node. The tool reads BOTH so an un-enriched node with a legacy
 * string value still surfaces something useful (`{ id: legacy, name: '' }`).
 */
const extractLastModifiedBy = (
  legacy: string | null,
  properties: Readonly<Record<string, unknown>>,
): { id: string; name: string } => {
  const propsValue = properties['lastModifiedBy'];
  if (propsValue !== undefined && propsValue !== null && typeof propsValue === 'object') {
    const obj = propsValue as { id?: unknown; name?: unknown };
    const id = typeof obj.id === 'string' ? obj.id : '';
    const name = typeof obj.name === 'string' ? obj.name : '';
    if (id.length > 0 || name.length > 0) {
      return { id, name };
    }
  }
  if (typeof legacy === 'string' && legacy.length > 0) {
    return { id: legacy, name: '' };
  }
  return { id: '', name: '' };
};

/**
 * Extract the freshness `lastModifiedDate` for a node. Prefers
 * `properties.lastModifiedDate` (the v1.7 enricher's overlay) and
 * falls back to the legacy top-level `lastModifiedDate` field. Returns
 * `null` when neither source carries a value.
 */
const extractLastModifiedDate = (
  legacy: string | null,
  properties: Readonly<Record<string, unknown>>,
): string | null => {
  const propsValue = properties['lastModifiedDate'];
  if (typeof propsValue === 'string' && propsValue.length > 0) {
    return propsValue;
  }
  if (typeof legacy === 'string' && legacy.length > 0) {
    return legacy;
  }
  return null;
};

/**
 * Requested types that contributed ZERO scanned nodes AND whose coverage row
 * does not prove the retrieve landed them.
 *
 * Adopts the manifest's own `retrieveConfirmed` discriminator (see
 * `CoverageEntry` in `packages/contracts/src/index.ts`): the row
 * `{requested: true, retrieved: 0, errored: false, neverModeled: false}` is
 * byte-identical for "the org genuinely has none" and "the retrieve never
 * landed it", and only `retrieveConfirmed: true` separates them. A type in this
 * list was NOT checked, so a change to one of its components is invisible here
 * — reporting `changed: []` as a finished answer over it would be the
 * unchecked-zero this whole family is about.
 *
 * Types that DID contribute nodes are excluded: whatever coverage claims, the
 * scan demonstrably read them.
 */
const unretrievedTypes = (
  ctx: Context,
  types: readonly ComponentType[],
  scannedByType: ReadonlyMap<ComponentType, number>,
): readonly ComponentType[] => {
  const entries = buildCoverageEntries(ctx.manifest);
  return types.filter((type) => {
    if ((scannedByType.get(type) ?? 0) > 0) return false;
    const row = entries.find((entry) => entry.type === type);
    if (row === undefined) return true;
    if (row.neverModeled || row.errored) return true;
    if (row.pending === true || row.capped === true) return true;
    return row.retrieved === 0 && row.retrieveConfirmed !== true;
  });
};

/** How many type names a reason sentence spells out before summarising. */
const MAX_NAMED_TYPES = 8;

const nameTypes = (types: readonly ComponentType[]): string =>
  types.length <= MAX_NAMED_TYPES
    ? types.join(', ')
    : `${types.slice(0, MAX_NAMED_TYPES).join(', ')} … and ${String(types.length - MAX_NAMED_TYPES)} more`;

/** Inputs the two site classifiers below read. Bundled so neither can drift. */
interface ScanFacts {
  /** Nodes the scan actually read across every requested type. */
  readonly scannedNodes: number;
  /** Of those, how many carried NO `lastModifiedDate` at all. */
  readonly unenrichedCount: number;
  /** Rows matching the boundary BEFORE the output page was cut. */
  readonly matchedTotal: number;
  /** True when a type's full scan hit `FULL_SCAN_MAX_NODES`. */
  readonly scanIncomplete: boolean;
  readonly incompleteTypes: readonly string[];
  /** Requested types the coverage row cannot prove were retrieved. */
  readonly unretrieved: readonly ComponentType[];
  readonly since: string;
}

/**
 * Classify an EMPTY `changed` list. TYPED-ABSENCE-CHANGED-SINCE.
 *
 * Ordered most-severe first: a scan that was capped, a page past the end, and a
 * vault with no freshness data must each win over "checked and clean", because
 * each of them makes the clean reading unsupportable.
 */
const classifyEmptyChanged = (facts: ScanFacts): ChangedSinceAbsenceSite => {
  if (facts.scanIncomplete) {
    return {
      path: 'changed',
      kind: 'scan-capped',
      status: 'not-checked',
      reason:
        `CAPPED: the full scan hit its node ceiling for ${nameTypes(facts.incompleteTypes as readonly ComponentType[])}, ` +
        'so components past the cap were never compared against the boundary. This empty list covers only what was scanned.',
    };
  }
  if (facts.matchedTotal > 0) {
    return {
      path: 'changed',
      kind: 'page-past-end',
      status: 'unknown',
      reason:
        `THIS PAGE is empty, the RESULT SET is not: ${String(facts.matchedTotal)} component(s) changed at or after ${facts.since}, ` +
        'and this offset/cursor lands past the last of them. Read it as the end of the page walk, never as "nothing changed".',
    };
  }
  if (facts.scannedNodes === 0) {
    return {
      path: 'changed',
      kind: 'no-nodes-scanned',
      status: 'not-checked',
      reason:
        'NOT CHECKED: the requested types hold no node in this vault at all, so not one component was compared against the boundary. ' +
        'Nothing here says whether the org changed.',
    };
  }
  if (facts.unenrichedCount >= facts.scannedNodes) {
    return {
      path: 'changed',
      kind: 'freshness-not-enriched',
      status: 'not-checked',
      reason:
        `NOT CHECKED: all ${String(facts.scannedNodes)} scanned node(s) carry NO lastModifiedDate, so this vault holds no freshness data ` +
        'to compare against the boundary. The empty list is a fact about the VAULT, not about the org — run ' +
        '`sfi refresh --with-tooling-api` and ask again.',
    };
  }
  if (facts.unretrieved.length > 0) {
    return {
      path: 'changed',
      kind: 'types-not-retrieved',
      status: 'not-checked',
      reason:
        `NOT CHECKED for ${nameTypes(facts.unretrieved)}: those requested types contributed no node and their coverage row does not ` +
        'confirm the retrieve landed them (`retrieveConfirmed` unset), so a change to one of their components is invisible here.',
    };
  }
  if (facts.unenrichedCount > 0) {
    return {
      path: 'changed',
      kind: 'freshness-partially-enriched',
      status: 'not-checked',
      reason:
        `PARTIAL: ${String(facts.unenrichedCount)} of ${String(facts.scannedNodes)} scanned node(s) carry no lastModifiedDate. ` +
        'Any of them may have changed since the boundary and would be absent from this list — the zero covers only the enriched fraction.',
    };
  }
  return {
    path: 'changed',
    kind: 'checked-empty',
    status: 'proven-none',
    reason:
      `CHECKED: all ${String(facts.scannedNodes)} scanned node(s) carry a lastModifiedDate, the scan completed, and none is at or after ` +
      `${facts.since}. A real finding of nothing, bounded by the retrieve that built this vault.`,
  };
};

/**
 * Classify a ZERO `unenrichedCount`.
 *
 * "Zero nodes lacked a date" is only meaningful if nodes were scanned at all: a
 * zero over an empty scan is arithmetic, not evidence, and reads as "fully
 * enriched" when nothing was enriched.
 */
const classifyZeroUnenriched = (facts: ScanFacts): ChangedSinceAbsenceSite => {
  if (facts.scannedNodes === 0) {
    return {
      path: 'unenrichedCount',
      kind: 'no-nodes-scanned',
      status: 'not-checked',
      reason:
        'NOT CHECKED: zero nodes were scanned, so "0 unenriched" is arithmetic over an empty set — it does NOT mean this vault is ' +
        'fully freshness-enriched.',
    };
  }
  if (facts.scanIncomplete) {
    return {
      path: 'unenrichedCount',
      kind: 'scan-capped',
      status: 'not-checked',
      reason:
        `CAPPED: the full scan hit its node ceiling for ${nameTypes(facts.incompleteTypes as readonly ComponentType[])}; nodes past the cap ` +
        'were never inspected, so they are neither counted here nor proven enriched.',
    };
  }
  return {
    path: 'unenrichedCount',
    kind: 'checked-empty',
    status: 'proven-none',
    reason: `CHECKED: every one of the ${String(facts.scannedNodes)} scanned node(s) carries a lastModifiedDate.`,
  };
};

/**
 * Assemble the payload-level absence block from the per-site classifications.
 * Returns `null` when nothing in this payload is empty — a populated answer
 * must NOT acquire a not-checked marker it did not earn.
 *
 * `status` is the WEAKEST reading across the sites, so one not-checked site can
 * never be averaged away by a checked one.
 */
const buildChangedSinceAbsence = (
  changedLength: number,
  facts: ScanFacts,
): ChangedSinceAbsence | null => {
  const sites: ChangedSinceAbsenceSite[] = [];
  if (changedLength === 0) sites.push(classifyEmptyChanged(facts));
  if (facts.unenrichedCount === 0) sites.push(classifyZeroUnenriched(facts));
  if (sites.length === 0) return null;
  const status = sites.some((site) => site.status === 'not-checked')
    ? 'not-checked'
    : sites.some((site) => site.status === 'unknown')
      ? 'unknown'
      : 'proven-none';
  return {
    status,
    sites,
    note:
      status === 'proven-none'
        ? 'Every empty value in this payload was reached by a completed scan over dated components.'
        : 'At least one empty value in this payload was NOT reached by a completed scan — read `sites[]` before treating it as "nothing changed".',
  };
};

/**
 * The `sfi.changed_since` handler. Scans the requested types, decides
 * whether each node is past the `since` boundary, and returns the
 * structural answer with the partial-data axis surfaced via
 * `unenrichedCount`. See the module JSDoc for the honesty axis and the
 * partial-data rationale.
 *
 * @example
 *   const r = await changedSinceHandler(ctx, {
 *     since: '2026-05-01',
 *     types: ['ApexClass', 'Flow'],
 *   });
 *   if (r.ok) console.log(r.value.data.changed.length, r.value.data.unenrichedCount);
 */
export const changedSinceHandler = async (
  ctx: Context,
  input: ChangedSinceInput,
): Promise<Result<McpResponse<ChangedSinceOutput>, McpError>> => {
  const limit = input.limit ?? CHANGED_SINCE_DEFAULT_LIMIT;
  const types = input.types ?? CHANGED_SINCE_DEFAULT_TYPES;

  // CHANGED-SINCE-REJECTS-LAST-REFRESH-TOKEN: resolve a natural "last refresh"
  // token to the vault's refresh timestamp. The resolution is transparent —
  // `since` in the output echoes the resolved boundary, so passing the token is
  // byte-identical to passing that ISO instant. (For the component TYPES the
  // refresh itself pulled in, use `what_changed_since_refresh`.)
  const rawSince = isRefreshToken(input.since)
    ? ctx.manifest.refreshedAt
    : input.since;
  if (Number.isNaN(Date.parse(rawSince))) {
    return err({
      kind: 'invalid-query',
      message: `cannot anchor "${input.since}" — the vault manifest has no valid refreshedAt; pass an explicit ISO 8601 date`,
      path: 'since',
    });
  }
  const since = normalizeSince(rawSince);

  const matched: ChangedComponent[] = [];
  let unenrichedCount = 0;

  // CR-22 B4: scan EVERY node of each requested type by paging the SQL OFFSET
  // forward (window-by-window) so a type with >500 nodes (CustomField trivially)
  // no longer silently drops nodes 501+ from BOTH `changed` and `unenrichedCount`
  // — the admitted scan-tail bug. The scan completes inside this call, so the
  // output list is then paged on the output axis below (no `s` scan cursor).
  const scan = await scanAllNodesOfTypes(ctx.graph, types);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }
  // Per-type scanned counts feed the absence classification below: a requested
  // type that contributed ZERO nodes was not necessarily checked, and only the
  // coverage row can say which (see `unretrievedTypes`).
  const scannedByType = new Map<ComponentType, number>();
  for (const node of scan.value.nodes) {
    scannedByType.set(node.type, (scannedByType.get(node.type) ?? 0) + 1);
    const date = extractLastModifiedDate(node.lastModifiedDate, node.properties);
    if (date === null) {
      unenrichedCount += 1;
      continue;
    }
    if (date < since) continue;
    matched.push({
      id: node.id,
      type: node.type,
      apiName: node.apiName,
      lastModifiedDate: date,
      lastModifiedBy: extractLastModifiedBy(node.lastModifiedBy, node.properties),
    });
  }

  const sorted = [...matched].sort(compareByDateDescThenIdAsc);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers the NARROWING args — the normalised `since` boundary
  // and `types` — so a token minted for one query can't be replayed against
  // another. (`since` is normalised so the same instant always fingerprints
  // identically across calls.)
  const fingerprint = argsFingerprint({
    since,
    ...(input.types !== undefined ? { types: input.types } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: CHANGED_SINCE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    keyOf: (c) => c.id,
    binding: {
      tool: CHANGED_SINCE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const changed = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  const isPaged = truncated || offset > 0;

  // A pathological type past FULL_SCAN_MAX_NODES leaves the scan incomplete;
  // disclose it via the response envelope (the existing shape has no boundaries
  // array, so surface it only when actually incomplete — a normal full scan
  // leaves this absent and the response byte-identical).
  const scanNote = scan.value.scanIncomplete
    ? fullScanTruncationNote(scan.value.incompleteTypes)
    : undefined;

  // TYPED-ABSENCE-CHANGED-SINCE. `changed: []` and `unenrichedCount: 0` both
  // shipped bare. On a vault whose freshness overlay never ran, `changed: []`
  // was byte-identical to a completed scan that found nothing — so a caller
  // would have concluded "nothing changed in the org" from a tool that had no
  // dates to compare. The block below says which kind of empty each site is.
  const absence = buildChangedSinceAbsence(changed.length, {
    scannedNodes: scan.value.nodes.length,
    unenrichedCount,
    matchedTotal: sorted.length,
    scanIncomplete: scan.value.scanIncomplete,
    incompleteTypes: scan.value.incompleteTypes,
    unretrieved: unretrievedTypes(ctx, types, scannedByType),
    since,
  });

  return ok({
    data: {
      since,
      changed,
      unenrichedCount,
      truncated,
      ...(absence !== null ? { absence } : {}),
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + changed.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
      ...(scanNote !== undefined ? { boundaries: [scanNote] } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
