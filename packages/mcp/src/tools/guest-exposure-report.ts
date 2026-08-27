/**
 * Handler for the `sfi.guest_exposure_report` MCP tool (R6-17).
 *
 * "What can UNAUTHENTICATED guest users see in my Experience Cloud / Site
 * communities?" — the buyer-facing answer to one of the most notorious
 * real-world Salesforce security failure classes (over-permissioned site
 * guest profiles leaking PII to the open internet).
 *
 * This tool COMPOSES the existing engine rather than duplicating it:
 *   - the community family the R6-17 extractors model (`Network` / `CustomSite`
 *     / `ExperienceBundle`) supplies the surfaces + the HEURISTIC guest-profile
 *     linkage (`CustomSite` → `Profile:{Site Label} Profile`, a Salesforce
 *     naming convention, NOT a declared pointer);
 *   - the SAME `grantedBy` object/field/apex grant model that
 *     `effective_permissions` / `who_can_access_object` read;
 *   - the SAME PII classifier `pii_inventory` uses (`collectPiiInventoryFields`);
 *   - the SAME guest sharing rules `who_can_access_object` surfaces
 *     (`SharingRule` nodes with `ruleType: 'guest'`, extracted by CR-CAP-16).
 *
 * Per community with an identifiable guest profile it composes the guest
 * profile's exposure and RANKS findings (public write on objects that carry
 * guest-readable PII first). Every finding carries a REAL vault node id and a
 * per-claim confidence: the underlying CRUD/FLS/apex GRANT is `declared`, but
 * the guest-profile identity itself is `heuristic` (the naming convention), so
 * the report's headline `confidence` is `heuristic` and each finding carries
 * `guestLinkageConfidence: 'heuristic'`.
 *
 * FAIL CLOSED: when NO `Network` and NO `CustomSite` node is modeled, the tool
 * does NOT claim "no exposure" — it discloses that the vault holds no
 * Experience Cloud surface (the org may have none, or the vault predates the
 * R6-17 extraction) and points at `/sfi-refresh`.
 *
 * Honesty boundaries (disclosed, never silently assumed):
 *   - Object CRUD + FLS are the DECLARED static grant; actual record
 *     visibility to a guest still depends on OWD + guest sharing rules (record
 *     level) — the guest sharing rules attached to each community are surfaced
 *     as their own findings, but whether a given record matches is not modeled.
 *   - Visualforce-page guest access (`<pageAccesses>`) is NOT in the offline
 *     metadata model; only Apex-class access is enumerated.
 *   - The guest-profile linkage is heuristic; an unresolved guest profile is
 *     disclosed per community, never treated as "no exposure".
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { guestProfileNameForSite } from '@sf-intelligence/extractors';
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { offlineTrust } from './coverage-trust.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { collectPiiInventoryFields, type PiiField } from './pii-inventory.js';
import { clampedNodeScanLimit, scanHitCap } from './scan-cap.js';

const CUSTOM_SITE_PREFIX = 'CustomSite:';
const NETWORK_PREFIX = 'Network:';
const PROFILE_PREFIX = 'Profile:';
const OBJECT_PREFIX = 'CustomObject:';
const FIELD_PREFIX = 'CustomField:';
const APEX_PREFIX = 'ApexClass:';
const SHARING_RULE_PREFIX = 'SharingRule:';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Per-response byte budget for the paged `findings` list; below the ~45 KB guard. */
const FINDINGS_BYTE_BUDGET = 36_000;
/** Page size when draining a node type. */
const SCAN_PAGE_SIZE = 500;
/**
 * Per-response row cap for the `orphanGuestRules` bucket, and its own byte
 * budget. The bucket shipped with NO contract at all: on a vault holding 600
 * guest sharing rules and no community surface it put 500 rows and a 28,463-
 * character disclosure naming every one of their ids into a payload with a
 * 40 KB budget. The global envelope guard then tail-trimmed the array to 62
 * rows while the disclosure still said 500 were "listed in `orphanGuestRules`"
 * — a response contradicting itself about a record-level grant to
 * unauthenticated visitors, with the dropped tail unreachable from any call
 * (`limit`/`offset` page `findings`, not this bucket).
 */
const ORPHAN_RULE_PAGE_LIMIT = 50;
const ORPHAN_RULE_BYTE_BUDGET = 6_000;
/** How many rule ids the orphan disclosure may name inline (never all of them). */
const ORPHAN_RULE_IDS_NAMED = 10;
/**
 * Floor for the `findings` byte budget once the orphan page has taken its
 * share. The two lists ride in ONE envelope, so the orphan bytes are charged
 * against the findings slice rather than pushing the pair over the global cap
 * and inviting the guard to trim whichever list it finds largest.
 */
const FINDINGS_BYTE_BUDGET_FLOOR = 12_000;
/**
 * The orphan block costs more than its rows. Charging only the rows left the
 * DISCLOSURE (up to ~2 KB once it names 10 ids inline and appends the remedy
 * sentence — the `communityId`-scoped wording is the longest) and the
 * `orphanGuestRulesPage` marker uncounted, so a saturated orphan page plus a
 * full findings page cleared FINDINGS_BYTE_BUDGET and then blew the GLOBAL
 * ~40 KB guard. The guard trims the largest array, which halved `findings`
 * while `pageInfo.returnedCount` and `nextCursor` still described the untrimmed
 * page — leaving the dropped `critical` rows unreachable from any call.
 *
 * That is the same self-contradiction the orphan paging was added to close,
 * displaced from `orphanGuestRules` onto `findings`. It survived because the
 * paging was measured on the FAIL-CLOSED vault, which has zero findings and so
 * cannot exhibit the collision — the honesty equivalent of testing the happy
 * path. `guest-exposure-envelope.test.ts` now pins the collision shape itself.
 */
const ORPHAN_BLOCK_OVERHEAD_BYTES = 3_000;

/** Zod schema for the `sfi.guest_exposure_report` tool input. */
export const guestExposureReportInputSchema = z.object({
  /**
   * Optional `Network:X` or `CustomSite:X` id to scope the report to ONE
   * community; omit to audit every modeled Experience Cloud / Site surface.
   */
  communityId: z.string().min(1).optional(),
  /**
   * Optional COMMUNITY-scope aliases — the natural keys a host / router sends
   * for "guest exposure on {community}?". `networkApiName` / `networkName` are
   * the bare Network api name (coerced to `Network:{name}`); `siteApiName` is
   * the bare CustomSite api name (coerced to `CustomSite:{name}`). All resolve
   * to the same community scope as `communityId`; several that disagree are
   * `invalid-query`. Previously these were silently stripped and every call ran
   * org-wide over all communities.
   */
  networkApiName: z.string().min(1).optional(),
  networkName: z.string().min(1).optional(),
  siteApiName: z.string().min(1).optional(),
  /**
   * Optional canonical-id alias dispatched BY PREFIX: `Network:` / `CustomSite:`
   * scopes to that community (like `communityId`); `CustomObject:` scopes to
   * that object (like `objectId`). Any other prefix is `invalid-query`. This is
   * the router's shape — it used to be stripped and fall through to an org-wide
   * audit.
   */
  componentId: z.string().min(1).optional(),
  /**
   * Optional OBJECT scope — the dominant question shape is object-specific
   * ("guest exposure for Contact"). Filters `findings` (and the per-community
   * `findingCount`) to that object's guest CRUD, its fields' FLS, and its
   * guest sharing rules; object-independent Apex-class findings drop out.
   * `objectApiName` is the bare api name (`Contact`); `objectId` is the
   * canonical `CustomObject:Contact` id; `componentId: CustomObject:Contact`
   * also resolves here. All resolve to the same scope — pass one. The applied
   * scope is always echoed back as `appliedScope`.
   *
   * The named object must EXIST in the vault. An object that does not is a
   * named `invalid-query`, never a clean empty report — on this tool an empty
   * report is the security claim "the unauthenticated internet cannot read
   * this object", and it must never be made about an object that was never
   * found. Resolution is case-insensitive, and `appliedScope.object` carries
   * the vault's casing rather than the caller's.
   */
  objectApiName: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
  /**
   * Offset into the `orphanGuestRules` bucket — its OWN paging axis, because
   * `limit`/`offset`/`cursor` page `findings` and cannot reach this list.
   * Without it, every unattributable guest rule past the per-response cap was
   * unrecoverable from any call. Echoed back in `orphanGuestRulesPage`, whose
   * `nextOffset` is the value to pass next.
   */
  orphanOffset: z.number().int().min(0).optional(),
});

export type GuestExposureReportInput = z.infer<typeof guestExposureReportInputSchema>;

/** Severity of one exposure finding — public write on a PII object is worst. */
export type ExposureSeverity = 'critical' | 'high' | 'medium' | 'low';

const SEVERITY_RANK: Readonly<Record<ExposureSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** What KIND of exposure a finding describes. */
export type ExposureKind =
  | 'object-crud'
  | 'pii-field-fls'
  | 'apex-enabled'
  | 'guest-sharing-rule';

/**
 * One ranked exposure finding. `nodeId` is ALWAYS a real vault node id so the
 * caller can drill in. `grantConfidence` is the confidence of the underlying
 * grant edge (`declared` for CRUD/FLS/apex, `declared` for a guest sharing
 * rule); `guestLinkageConfidence` is always `heuristic` (the guest-profile
 * identity is a naming convention), so the EFFECTIVE trust of the finding is
 * the weaker of the two — heuristic.
 */
export interface ExposureFinding {
  readonly communityId: string;
  readonly guestProfileId: string;
  readonly kind: ExposureKind;
  readonly severity: ExposureSeverity;
  /** The real vault node this finding is about (object / field / apex / rule). */
  readonly nodeId: string;
  readonly label: string;
  /** Human-readable one-liner describing the exposure. */
  readonly detail: string;
  readonly grantConfidence: 'declared';
  readonly guestLinkageConfidence: 'heuristic';
  /** object-crud: which operations the guest profile is granted. */
  readonly access?: {
    readonly read: boolean;
    readonly create: boolean;
    readonly edit: boolean;
    readonly delete: boolean;
    readonly viewAllRecords: boolean;
    readonly modifyAllRecords: boolean;
  };
  /** object-crud: count of guest-readable PII fields on this object (drives severity). */
  readonly guestReadablePiiFieldCount?: number;
  /** pii-field-fls: the field's PII classification + category (heuristic). */
  readonly piiClassification?: string;
  readonly piiCategory?: string;
  readonly fieldReadable?: boolean;
  readonly fieldEditable?: boolean;
}

/** Per-community metadata + roll-up counts (COMPLETE list; findings paginate separately). */
export interface CommunitySummary {
  /** The anchor node id (`CustomSite:X`). */
  readonly communityId: string;
  readonly label: string;
  readonly siteType: string | null;
  readonly active: boolean | null;
  /** Correlated `Network:X` id (matched by the Network's `<site>`), or null. */
  readonly networkId: string | null;
  readonly status: string | null;
  /** CRITICAL exposure switch — unauthenticated visitors can self-register a login. */
  readonly selfRegistration: boolean | null;
  readonly enableGuestFileAccess: boolean | null;
  /** Correlated `ExperienceBundle:X` id (via the Network's `<picassoSite>`), or null. */
  readonly experienceBundleId: string | null;
  /** The heuristic guest-profile id (`Profile:{Site Label} Profile`). */
  readonly guestProfileId: string;
  readonly guestProfileConfidence: 'heuristic';
  /** Whether that guest profile node exists in the vault (fail-closed when false). */
  readonly guestProfileResolved: boolean;
  /** Count of this community's findings (across all severities). */
  readonly findingCount: number;
  readonly criticalCount: number;
}

/**
 * A guest sharing rule this run could NOT attach to any community — the mirror
 * of the `orphanNetworks` disclosure. The rule's `siteName` matched none of the
 * three keys a community is matched on (any modeled CustomSite api name, any
 * modeled site label, any modeled Network api name), or the rule declares no
 * `siteName` at all. It is a REAL declared record-level grant to
 * unauthenticated visitors; this bucket exists so it is reported as
 * UNATTRIBUTED rather than dropped.
 *
 * The Network key is EVERY modeled Network, not only those correlated through a
 * modeled CustomSite: a Network whose `<site>` names an unmodeled CustomSite is
 * still a Network this vault holds, and denying it in one disclosure while
 * naming it in the next made a single response contradict itself.
 */
export interface OrphanGuestRule {
  /** The `SharingRule:{Object}.{Rule}` node id — a real vault id. */
  readonly ruleId: string;
  /** The rule's declared `siteName`, or null when it declares none. */
  readonly siteName: string | null;
  /** The object the rule is filed under, or null when the id has no object part. */
  readonly objectApiName: string | null;
  /** The rule's declared `accessLevel`, or null when absent. */
  readonly accessLevel: string | null;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GuestExposureReportOutput {
  readonly communities: readonly CommunitySummary[];
  /** Ranked exposure findings across all in-scope communities (paginated). */
  readonly findings: readonly ExposureFinding[];
  readonly summary: {
    readonly communities: number;
    readonly guestProfilesResolved: number;
    readonly totalFindings: number;
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
  };
  /**
   * Echoes the scope ACTUALLY applied so a host never assumes a filter it
   * passed took effect (an unsupported/silently-stripped arg was the bug this
   * closes). `community` is the resolved `communityId` or null; `object` is the
   * resolved object api name (from `objectApiName`/`objectId`) or null; `mode`
   * names the axes in force.
   */
  readonly appliedScope: {
    readonly community: string | null;
    readonly object: string | null;
    readonly mode: 'all' | 'community' | 'object' | 'community+object';
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /** True when a Profile/SharingRule scan hit the per-type node cap. */
  readonly scanTruncated: boolean;
  /**
   * Guest sharing rules that attach to NO modeled community — see
   * {@link OrphanGuestRule}. Present ONLY when at least one rule was
   * unattributable, so a vault whose every guest rule matched is byte-identical
   * to before this bucket existed.
   *
   * PAGED on its own axis (`orphanOffset` in, {@link orphanGuestRulesPage} out)
   * and capped per response, so the rows delivered can never disagree with the
   * count the disclosure states. Read the count from `orphanGuestRulesPage`,
   * never from `orphanGuestRules.length`.
   *
   * Emitted under EVERY scope, including a `communityId` scope (where the rows
   * stay out of `findings`) and the fail-closed no-Experience-Cloud-surface
   * response (where every guest rule is unattributable by construction).
   * Membership is judged against all modeled communities, so a row here is
   * genuinely unattributable — never merely outside the caller's scope.
   */
  readonly orphanGuestRules?: readonly OrphanGuestRule[];
  /**
   * Paging state for {@link orphanGuestRules} — present exactly when that
   * bucket is. `totalCount` is every unattributable rule in scope;
   * `returnedCount` is how many rows this response actually carries;
   * `nextOffset` is the `orphanOffset` to pass for the rest (null when
   * exhausted). This exists so a truncated bucket announces itself instead of
   * being silently shortened by the envelope guard.
   */
  readonly orphanGuestRulesPage?: {
    readonly totalCount: number;
    readonly returnedCount: number;
    readonly offset: number;
    readonly limit: number;
    readonly hasMore: boolean;
    readonly nextOffset: number | null;
  };
  /** Headline confidence is HEURISTIC — the guest-profile linkage is a convention. */
  readonly confidence: 'heuristic';
  readonly disclosures: readonly string[];
  readonly boundaryNote: string;
  readonly trust: TrustSummary;
  readonly nextCursor?: string;
  readonly pageInfo?: PageInfo;
}

const OBJECT_FLAGS = [
  'allowRead',
  'allowCreate',
  'allowEdit',
  'allowDelete',
  'viewAllRecords',
  'modifyAllRecords',
] as const;

const flag = (p: Readonly<Record<string, unknown>>, k: string): boolean => p[k] === true;
const stringProp = (p: Readonly<Record<string, unknown>>, k: string): string | null =>
  typeof p[k] === 'string' && (p[k] as string).length > 0 ? (p[k] as string) : null;
const boolProp = (p: Readonly<Record<string, unknown>>, k: string): boolean | null =>
  typeof p[k] === 'boolean' ? (p[k] as boolean) : null;

/** Object api-name for a `CustomField:{Object}.{Field}` id (the field's parent). */
const objectOfFieldId = (fieldId: string): string | null => {
  if (!fieldId.startsWith(FIELD_PREFIX)) return null;
  const rest = fieldId.slice(FIELD_PREFIX.length);
  const dot = rest.indexOf('.');
  return dot === -1 ? null : rest.slice(0, dot);
};

/**
 * The object api-name a finding pertains to — the axis the optional
 * `objectApiName`/`objectId` scope filters on. Object-CRUD findings carry the
 * object in their `CustomObject:` node id; PII-FLS findings in their field's
 * `CustomField:{Object}.{Field}` parent; guest sharing-rule findings in their
 * `SharingRule:{Object}.{Rule}` id (rules are filed under their object).
 * Object-INDEPENDENT findings (apex-enabled — a guest-invocable class is not
 * tied to one object) return null and therefore drop out of an object scope.
 */
const findingObjectApiName = (f: ExposureFinding): string | null => {
  if (f.nodeId.startsWith(OBJECT_PREFIX)) return f.nodeId.slice(OBJECT_PREFIX.length);
  if (f.nodeId.startsWith(FIELD_PREFIX)) return objectOfFieldId(f.nodeId);
  if (f.kind === 'guest-sharing-rule') return objectOfSharingRuleId(f.nodeId);
  return null;
};

/**
 * Object api-name for a `SharingRule:{Object}.{Rule}` id — rules are filed under
 * their object. Shared by {@link findingObjectApiName} and the orphan-rule
 * bucket so an orphaned rule is scoped on exactly the axis a matched one is.
 */
function objectOfSharingRuleId(ruleId: string): string | null {
  if (!ruleId.startsWith(SHARING_RULE_PREFIX)) return null;
  const rest = ruleId.slice(SHARING_RULE_PREFIX.length);
  const dot = rest.indexOf('.');
  return dot === -1 ? null : rest.slice(0, dot);
}

/** One page of the `orphanGuestRules` bucket plus the counts that describe it. */
interface OrphanRulePage {
  readonly rows: readonly OrphanGuestRule[];
  /** Unattributable rules in scope, BEFORE this page's cap. */
  readonly totalCount: number;
  /** Offset actually applied (clamped into the bucket). */
  readonly offset: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

/**
 * Slice the unattributable-rule bucket to one honest page: at most
 * {@link ORPHAN_RULE_PAGE_LIMIT} rows and {@link ORPHAN_RULE_BYTE_BUDGET}
 * bytes, with the total kept alongside so no consumer has to infer it from
 * `rows.length`. Input order is the id sort `orphanRowsFor` applies, so paging
 * is stable across calls.
 */
const pageOrphanRules = (
  all: readonly OrphanGuestRule[],
  offsetInput: number,
): OrphanRulePage => {
  const offset = Math.min(offsetInput, all.length);
  const rows: OrphanGuestRule[] = [];
  let bytes = 0;
  for (let i = offset; i < all.length && rows.length < ORPHAN_RULE_PAGE_LIMIT; i += 1) {
    const row = all[i]!;
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    // Always keep at least one row, so a single oversized row still makes
    // forward progress instead of stalling the page at zero.
    if (rows.length > 0 && bytes + rowBytes > ORPHAN_RULE_BYTE_BUDGET) break;
    bytes += rowBytes;
    rows.push(row);
  }
  const end = offset + rows.length;
  return {
    rows,
    totalCount: all.length,
    offset,
    hasMore: end < all.length,
    nextOffset: end < all.length ? end : null,
  };
};

/** The `orphanGuestRulesPage` marker for a page (emitted whenever rows exist). */
const orphanPageMarker = (
  page: OrphanRulePage,
): NonNullable<GuestExposureReportOutput['orphanGuestRulesPage']> => ({
  totalCount: page.totalCount,
  returnedCount: page.rows.length,
  offset: page.offset,
  limit: ORPHAN_RULE_PAGE_LIMIT,
  hasMore: page.hasMore,
  nextOffset: page.nextOffset,
});

/**
 * Sentence-initial count for the orphan bucket. When the SharingRule scan hit
 * the per-type node cap the bucket total is a FLOOR, not the org's number, so
 * the bare count would overstate what was established (a 600-rule vault reports
 * 500 — the scan cap — and "500 guest sharing rules ARE modeled" is then false).
 */
const orphanCountPhrase = (total: number, scanTruncated: boolean): string =>
  scanTruncated ? `At least ${total}` : `${total}`;

/**
 * The sentence that reconciles the bucket's COUNT with the rows actually
 * delivered, and names at most {@link ORPHAN_RULE_IDS_NAMED} ids inline. The
 * previous wording asserted every rule was "listed in `orphanGuestRules`" and
 * spelled out 500 ids, both of which the envelope guard then falsified.
 */
const orphanListingSentence = (page: OrphanRulePage): string => {
  if (page.rows.length === 0) {
    return `\`orphanGuestRules\` is EMPTY in this response — the requested \`orphanOffset\` is at or past the end of the ${page.totalCount}-row bucket; re-call with \`orphanOffset: 0\` to read it from the start.`;
  }
  const named = page.rows.slice(0, ORPHAN_RULE_IDS_NAMED).map((r) => r.ruleId);
  const unnamed = page.rows.length - named.length;
  const ids = `ids on this page: ${named.join(', ')}${
    unnamed > 0 ? `, … (+${unnamed} more, each present as a row)` : ''
  }`;
  if (page.rows.length === page.totalCount) {
    return `\`orphanGuestRules\` carries all ${page.totalCount} of them (${ids}).`;
  }
  const last = page.offset + page.rows.length - 1;
  return `\`orphanGuestRules\` carries ${page.rows.length} of the ${page.totalCount} — rows ${page.offset}–${last} of the id-sorted bucket (${ids}); the other ${page.totalCount - page.rows.length} are counted here but NOT in this response${
    page.nextOffset !== null
      ? `, so re-call with \`orphanOffset: ${page.nextOffset}\` for the next page (\`orphanGuestRulesPage\` carries the paging state)`
      : ''
  }.`;
};

/** Drain every node of a type (paginating past the graph's 500-row cap). */
const drainType = async (
  ctx: Context,
  type: Node['type'],
): Promise<Result<readonly Node[], string>> => {
  const all: Node[] = [];
  let offset = 0;
  for (;;) {
    const page = await listNodesByType(ctx.graph, type, { limit: SCAN_PAGE_SIZE, offset });
    if (!page.ok) return err(page.error.message);
    all.push(...page.value);
    if (page.value.length < SCAN_PAGE_SIZE) break;
    offset += SCAN_PAGE_SIZE;
  }
  return ok(all);
};

/** The guest profile id a CustomSite implies via the naming convention. */
const guestProfileIdForSite = (site: Node): string => {
  const declared = stringProp(site.properties, 'guestProfileName');
  const label = stringProp(site.properties, 'masterLabel') ?? site.apiName;
  return `${PROFILE_PREFIX}${declared ?? guestProfileNameForSite(label)}`;
};

/**
 * The `sfi.guest_exposure_report` MCP tool. Audits every modeled Experience
 * Cloud / Site community's guest-user profile for object CRUD, PII FLS, Apex,
 * and guest sharing-rule exposure — ranked, with real node ids and honest
 * per-claim confidence.
 */
export const guestExposureReportHandler = async (
  ctx: Context,
  input: GuestExposureReportInput,
): Promise<Result<McpResponse<GuestExposureReportOutput>, McpError>> => {
  // `componentId` is dispatched BY PREFIX: Network:/CustomSite: → community
  // scope; CustomObject: → object scope; any other prefix is invalid-query (an
  // unsupported arg is never silently stripped and fallen back to org-wide).
  if (
    input.componentId !== undefined &&
    !input.componentId.startsWith(NETWORK_PREFIX) &&
    !input.componentId.startsWith(CUSTOM_SITE_PREFIX) &&
    !input.componentId.startsWith(OBJECT_PREFIX)
  ) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a '${NETWORK_PREFIX}' / '${CUSTOM_SITE_PREFIX}' (community) or '${OBJECT_PREFIX}' (object) id; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const componentIsCommunity =
    input.componentId !== undefined &&
    (input.componentId.startsWith(NETWORK_PREFIX) ||
      input.componentId.startsWith(CUSTOM_SITE_PREFIX));
  const componentIsObject =
    input.componentId !== undefined && input.componentId.startsWith(OBJECT_PREFIX);

  // Resolve the optional COMMUNITY scope from every alias (communityId, the
  // Network:/CustomSite: componentId, and the bare networkApiName / networkName
  // / siteApiName keys). Several that disagree → invalid-query.
  const communityIds = new Set<string>();
  if (input.communityId !== undefined) communityIds.add(input.communityId);
  if (componentIsCommunity) communityIds.add(input.componentId as string);
  if (input.networkApiName !== undefined) {
    communityIds.add(coercePrefix(input.networkApiName, [NETWORK_PREFIX]));
  }
  if (input.networkName !== undefined) {
    communityIds.add(coercePrefix(input.networkName, [NETWORK_PREFIX]));
  }
  if (input.siteApiName !== undefined) {
    communityIds.add(coercePrefix(input.siteApiName, [CUSTOM_SITE_PREFIX]));
  }
  if (communityIds.size > 1) {
    return err({
      kind: 'invalid-query',
      message: `community selectors name different communities (${[...communityIds].join(', ')}); pass one`,
      path: 'communityId',
    });
  }
  const communityId: string | undefined =
    communityIds.size === 1 ? [...communityIds][0] : undefined;
  if (
    communityId !== undefined &&
    !communityId.startsWith(CUSTOM_SITE_PREFIX) &&
    !communityId.startsWith(NETWORK_PREFIX)
  ) {
    return err({
      kind: 'invalid-query',
      message: `communityId must start with '${CUSTOM_SITE_PREFIX}' or '${NETWORK_PREFIX}'; got '${communityId}'`,
      path: 'communityId',
    });
  }

  // `objectId` keeps its OWN prefix contract (a bare api name belongs in
  // `objectApiName`), checked here so the refusal still carries
  // `path: 'objectId'` rather than the shared resolver's `objectApiName`.
  if (input.objectId !== undefined && !input.objectId.startsWith(OBJECT_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `objectId must start with '${OBJECT_PREFIX}' (e.g. '${OBJECT_PREFIX}Contact'); got '${input.objectId}'. Use objectApiName for a bare api name.`,
      path: 'objectId',
    });
  }

  // Resolve the optional OBJECT scope from every alias — `objectId`,
  // `objectApiName`, and a `CustomObject:` `componentId` — and VERIFY the
  // object EXISTS, through the one shared `resolveExistingObjectScope` the
  // `flow_bulkification_audit` / `flow_fault_audit` / `unused_fields_deep`
  // siblings were migrated onto in 0.3.2. `ok(null)` = no object named, so the
  // org-wide audit below runs exactly as before; disagreeing aliases are still
  // `invalid-query`; an object the vault does not hold is now refused.
  //
  // GUEST-EXPOSURE-ANSWERS-FOR-AN-OBJECT-IT-NEVER-FOUND — what a user saw
  // before: the scope was a hand-rolled alias set applied as a plain string
  // filter over the findings, with nothing asking whether the object existed.
  // Name an object this vault has never modeled and every filter matched
  // nothing, so the tool returned the full confident report shape with
  // `findings: []`, `summary.critical: 0` and a "Scoped to object 'X'"
  // disclosure. On THIS tool that empty answer is a SECURITY claim — "no, the
  // unauthenticated internet cannot read this object" — about an object that
  // was never found, and it is the kind an architect acts on once and never
  // re-checks. An UNCHECKED zero wearing a CHECKED zero's clothes, exactly as
  // the 0.3.2 changelog put it for `sfi.unused_fields_deep`. The COMMUNITY
  // half of this same handler already refused an unresolvable id
  // (`component-not-found`, below); only the object half was silent.
  //
  // A real object in the wrong case is a different thing and still answers:
  // the resolver rewrites the scope to the vault's exact casing
  // (case-insensitive RESOLUTION, never case-insensitive IDENTITY — two
  // objects differing only by case are refused, not silently picked), so
  // `appliedScope.object` never asserts a spelling the vault does not hold.
  const objectScopeInput: Record<string, unknown> = {
    ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
    ...(input.objectApiName !== undefined ? { objectApiName: input.objectApiName } : {}),
    // Only a `CustomObject:` componentId is an object alias here; a
    // `Network:` / `CustomSite:` one is the COMMUNITY axis resolved above and
    // must not reach an object resolver set to refuse foreign prefixes.
    ...(componentIsObject ? { componentId: input.componentId } : {}),
  };
  const objectScopeResult = await resolveExistingObjectScope(ctx.graph, objectScopeInput, {
    unhandledPrefix: 'refuse',
  });
  if (!objectScopeResult.ok) return err(objectScopeResult.error);
  const objectScope: string | null = objectScopeResult.value?.object ?? null;

  const scopeMode: GuestExposureReportOutput['appliedScope']['mode'] =
    communityId !== undefined && objectScope !== null
      ? 'community+object'
      : communityId !== undefined
        ? 'community'
        : objectScope !== null
          ? 'object'
          : 'all';
  const appliedScope: GuestExposureReportOutput['appliedScope'] = {
    community: communityId ?? null,
    object: objectScope,
    mode: scopeMode,
  };

  const sitesResult = await drainType(ctx, 'CustomSite');
  if (!sitesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${sitesResult.error}` });
  }
  const networksResult = await drainType(ctx, 'Network');
  if (!networksResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${networksResult.error}` });
  }
  const allSites = sitesResult.value;
  const allNetworks = networksResult.value;

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  // Guest sharing rules (CR-CAP-16), grouped by their Experience-Cloud site
  // name — the SAME nodes who_can_access_object surfaces.
  //
  // SCANNED ABOVE THE FAIL-CLOSED RETURN BELOW, deliberately. It used to sit
  // after it, so a vault holding guest rules but NO CustomSite/Network node —
  // exactly the "vault predates the Experience Cloud extraction" case that
  // return's own disclosure names — dropped every guest rule: no finding, no
  // `orphanGuestRules` bucket, no per-rule naming, `totalFindings: 0`. That is
  // the silent drop this bucket exists to end, on the highest-stakes surface
  // this tool has, and the early return was reintroducing it.
  const scanLimit = clampedNodeScanLimit();
  let scanTruncated = false;
  const rulesResult = await listNodesByType(ctx.graph, 'SharingRule', { limit: scanLimit });
  if (!rulesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${rulesResult.error.message}` });
  }
  if (scanHitCap(rulesResult.value.length, scanLimit)) scanTruncated = true;
  const guestRulesBySite = new Map<string, Node[]>();
  // Every guest rule seen, attributable or not. A rule whose declared `siteName`
  // hits none of the three keys a community is matched on (site apiName, site
  // label, Network apiName) — or that declares no `siteName` at all — used to be
  // DROPPED in silence: no finding, no bucket, no disclosure, while the mirror
  // case (a Network naming an unmodeled CustomSite) did get a disclosure. A
  // guest sharing rule is a record-level grant to unauthenticated visitors;
  // dropping one without saying so is the "checked and found nothing" vs "did
  // not check" conflation.
  const allGuestRules: Node[] = [];
  for (const rule of rulesResult.value) {
    if (stringProp(rule.properties, 'ruleType') !== 'guest') continue;
    allGuestRules.push(rule);
    const siteName = stringProp(rule.properties, 'siteName');
    if (siteName === null) continue;
    const bucket = guestRulesBySite.get(siteName) ?? [];
    bucket.push(rule);
    guestRulesBySite.set(siteName, bucket);
  }
  /** Project guest rules into `orphanGuestRules` rows, honouring the object scope. */
  const orphanRowsFor = (rules: readonly Node[]): OrphanGuestRule[] =>
    rules
      .map((rule) => ({
        ruleId: rule.id,
        siteName: stringProp(rule.properties, 'siteName'),
        objectApiName: objectOfSharingRuleId(rule.id),
        accessLevel: stringProp(rule.properties, 'accessLevel'),
      }))
      .filter((row) => objectScope === null || row.objectApiName === objectScope)
      .sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));

  // FAIL CLOSED: no community family modeled at all → never claim "no exposure".
  if (allSites.length === 0 && allNetworks.length === 0) {
    const coverage = summarizeCoverage(ctx.manifest, ['Network', 'CustomSite']);
    // With no modeled community at all, EVERY guest rule is unattributable by
    // construction — there is nothing to attribute one to. They are reported
    // here rather than dropped.
    const orphanRulePage = pageOrphanRules(
      orphanRowsFor(allGuestRules),
      input.orphanOffset ?? 0,
    );
    const failClosedDisclosures = [
      'No Experience Cloud surface in the vault — no Network or CustomSite node is modeled. The org may have no communities/sites, OR the vault predates the Experience Cloud extraction (R6-17). Re-run `/sfi-refresh` to pull Network / CustomSite / ExperienceBundle before treating this as "no guest exposure".',
    ];
    if (orphanRulePage.totalCount > 0) {
      failClosedDisclosures.push(
        `${orphanCountPhrase(orphanRulePage.totalCount, scanTruncated)} guest sharing rule(s) ARE modeled in this vault and NONE of them could be attributed to a community — there is no modeled CustomSite or Network to attribute them to. They are declared record-level grants to unauthenticated visitors, each row carrying its object and \`accessLevel\`. ${orphanListingSentence(orphanRulePage)} None of them are counted in \`summary.totalFindings\`, which stays 0 because no community surface was audited. Never read \`findings: []\` here as "no guest exposure".`,
      );
    }
    if (scanTruncated) {
      failClosedDisclosures.push(
        'A SharingRule scan hit the per-type node cap (SFI_NODE_SCAN_LIMIT) — some guest sharing rules may be missing from `orphanGuestRules`.',
      );
    }
    return ok({
      data: {
        communities: [],
        findings: [],
        summary: {
          communities: 0,
          guestProfilesResolved: 0,
          totalFindings: 0,
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
        },
        appliedScope,
        limit: input.limit ?? DEFAULT_LIMIT,
        offset: 0,
        hasMore: false,
        truncated: false,
        scanTruncated,
        ...(orphanRulePage.totalCount > 0
          ? {
              orphanGuestRules: orphanRulePage.rows,
              orphanGuestRulesPage: orphanPageMarker(orphanRulePage),
            }
          : {}),
        confidence: 'heuristic',
        disclosures: failClosedDisclosures,
        boundaryNote:
          'Fail-closed: absence of a modeled Experience Cloud surface is reported as "not checked", never as "no exposure".',
        trust: offlineTrust(ctx, {
          status: coverage.status === 'complete' ? 'unknown' : coverage.status,
          missingCoverage: ['Network', 'CustomSite', 'ExperienceBundle'],
        }),
      },
      vaultState,
    });
  }

  // Correlate Networks to sites by the Network's declared `<site>` api-name.
  const networkBySiteApiName = new Map<string, Node>();
  for (const net of allNetworks) {
    const siteName = stringProp(net.properties, 'site');
    if (siteName !== null) networkBySiteApiName.set(siteName, net);
  }

  // Every name a guest rule's `siteName` can attribute onto, across ALL modeled
  // communities — NOT just the scoped ones. Whether a rule is attributable is a
  // property of the VAULT, not of this call's scope. Deriving it from the scoped
  // subset made another community's rule look "orphaned" under a `communityId`
  // scope, which is why the bucket used to be suppressed there outright;
  // computing it globally lets the bucket stay correct under every scope.
  const attributableSiteNames = new Set<string>();
  for (const site of allSites) {
    attributableSiteNames.add(site.apiName);
    attributableSiteNames.add(stringProp(site.properties, 'masterLabel') ?? site.apiName);
  }
  // EVERY modeled Network api name, not only the ones correlated through a
  // MODELED CustomSite. Deriving the Network keys from `allSites` meant a
  // Network whose `<site>` names an unmodeled CustomSite contributed NO key —
  // so a guest rule declaring that Network landed in `orphanGuestRules` under a
  // disclosure reading "matches no ... Network api name in this vault", while
  // the very next disclosure in the SAME payload named that Network as one that
  // "reference[s] a CustomSite not modeled in this vault". One response, two
  // contradictory claims about the same node. A Network the vault holds is
  // present whether or not its site is, so its api name is attributable.
  for (const net of allNetworks) attributableSiteNames.add(net.apiName);

  // Scope: a CustomSite id keeps that site; a Network id keeps the site it
  // references (so `Network:X` and `CustomSite:X` both resolve to one surface).
  let scopedSites = allSites;
  if (communityId !== undefined) {
    if (communityId.startsWith(CUSTOM_SITE_PREFIX)) {
      scopedSites = allSites.filter((s) => s.id === communityId);
    } else {
      const net = allNetworks.find((n) => n.id === communityId);
      const siteName = net !== undefined ? stringProp(net.properties, 'site') : null;
      scopedSites =
        siteName !== null
          ? allSites.filter((s) => s.apiName === siteName)
          : [];
    }
    if (scopedSites.length === 0) {
      return err({
        kind: 'component-not-found',
        message: `no modeled CustomSite matches \`${communityId}\` in this vault (a Network id resolves through its <site>; the site may not be retrieved)`,
        path: communityId,
      });
    }
  }

  // PII field ids (pii + sensitive), reusing the SAME classifier pii_inventory
  // uses — composed, not duplicated. Map id -> classified field for detail.
  const piiById = new Map<string, PiiField>();
  for (const cls of ['pii', 'sensitive'] as const) {
    const collected = await collectPiiInventoryFields(ctx, { classification: cls });
    if (!collected.ok) return collected;
    for (const f of collected.value.fields) piiById.set(f.id, f);
  }

  const communities: CommunitySummary[] = [];
  const findings: ExposureFinding[] = [];
  const orphanNetworks: string[] = [];
  let guestProfilesResolved = 0;

  for (const site of scopedSites) {
    const network = networkBySiteApiName.get(site.apiName) ?? null;
    const guestProfileId = guestProfileIdForSite(site);
    const siteLabel = stringProp(site.properties, 'masterLabel') ?? site.apiName;

    const profileResult = await getNodeById(ctx.graph, guestProfileId as ComponentId);
    if (!profileResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${profileResult.error.message}` });
    }
    const guestProfileResolved = profileResult.value !== null;
    if (guestProfileResolved) guestProfilesResolved += 1;

    const experienceBundleId =
      network !== null && stringProp(network.properties, 'picassoSite') !== null
        ? `ExperienceBundle:${stringProp(network.properties, 'picassoSite')!}`
        : null;

    const communityFindings: ExposureFinding[] = [];

    if (guestProfileResolved) {
      const edgesResult = await listEdges(ctx.graph, guestProfileId as ComponentId, {
        direction: 'out',
        edgeType: 'grantedBy',
      });
      if (!edgesResult.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${edgesResult.error.message}` });
      }

      // Partition the guest profile's declared grants.
      const objectGrants = new Map<string, Record<(typeof OBJECT_FLAGS)[number], boolean>>();
      const fieldGrants = new Map<string, { readable: boolean; editable: boolean }>();
      const apexGrants: string[] = [];
      for (const edge of edgesResult.value) {
        if (edge.toId.startsWith(OBJECT_PREFIX)) {
          const obj = edge.toId.slice(OBJECT_PREFIX.length);
          const cur =
            objectGrants.get(obj) ??
            ({
              allowRead: false,
              allowCreate: false,
              allowEdit: false,
              allowDelete: false,
              viewAllRecords: false,
              modifyAllRecords: false,
            } as Record<(typeof OBJECT_FLAGS)[number], boolean>);
          for (const f of OBJECT_FLAGS) if (flag(edge.properties, f)) cur[f] = true;
          objectGrants.set(obj, cur);
        } else if (edge.toId.startsWith(FIELD_PREFIX)) {
          const readable = edge.properties['readable'] === true;
          const editable = edge.properties['editable'] === true;
          if (readable || editable) {
            const prev = fieldGrants.get(edge.toId);
            fieldGrants.set(edge.toId, {
              readable: readable || (prev?.readable ?? false),
              editable: editable || (prev?.editable ?? false),
            });
          }
        } else if (edge.toId.startsWith(APEX_PREFIX)) {
          apexGrants.push(edge.toId.slice(APEX_PREFIX.length));
        }
      }

      // Which objects does the guest have READ reach on (object read / view-all
      // / modify-all)? FLS is only real exposure when the object is readable.
      const objectReadable = new Set<string>();
      for (const [obj, flags] of objectGrants) {
        if (flags.allowRead || flags.viewAllRecords || flags.modifyAllRecords) {
          objectReadable.add(obj);
        }
      }

      // PII fields the guest can actually SEE: FLS read/edit AND object read.
      const guestPiiByObject = new Map<string, number>();
      for (const [fieldId, fls] of fieldGrants) {
        if (!piiById.has(fieldId)) continue;
        const obj = objectOfFieldId(fieldId);
        if (obj === null || !objectReadable.has(obj)) continue; // FLS w/o object read = not visible
        guestPiiByObject.set(obj, (guestPiiByObject.get(obj) ?? 0) + 1);
        const pii = piiById.get(fieldId)!;
        const editable = fls.editable;
        communityFindings.push({
          communityId: site.id,
          guestProfileId,
          kind: 'pii-field-fls',
          severity: editable ? 'high' : 'medium',
          nodeId: fieldId,
          label: pii.apiName,
          detail: `guest profile has ${editable ? 'READ+EDIT' : 'READ'} FLS on ${pii.classification}/${pii.category} field ${fieldId} and object read on ${obj} — the value is exposed to guest users`,
          grantConfidence: 'declared',
          guestLinkageConfidence: 'heuristic',
          piiClassification: pii.classification,
          piiCategory: pii.category,
          fieldReadable: fls.readable,
          fieldEditable: fls.editable,
        });
      }

      // Object CRUD findings, ranked by write + guest-readable-PII.
      for (const [obj, flags] of objectGrants) {
        const isWrite =
          flags.allowCreate || flags.allowEdit || flags.allowDelete || flags.modifyAllRecords;
        const isRead = flags.allowRead || flags.viewAllRecords || flags.modifyAllRecords;
        const piiCount = guestPiiByObject.get(obj) ?? 0;
        const severity: ExposureSeverity =
          piiCount > 0 && isWrite
            ? 'critical'
            : piiCount > 0 && isRead
              ? 'high'
              : isWrite
                ? 'high'
                : 'low';
        const ops: string[] = [];
        if (flags.allowRead) ops.push('read');
        if (flags.allowCreate) ops.push('create');
        if (flags.allowEdit) ops.push('edit');
        if (flags.allowDelete) ops.push('delete');
        if (flags.viewAllRecords) ops.push('viewAll');
        if (flags.modifyAllRecords) ops.push('modifyAll');
        communityFindings.push({
          communityId: site.id,
          guestProfileId,
          kind: 'object-crud',
          severity,
          nodeId: `${OBJECT_PREFIX}${obj}`,
          label: obj,
          detail: `guest profile grants [${ops.join(', ')}] on ${obj}${piiCount > 0 ? ` — object carries ${piiCount} guest-readable PII field(s)` : ''}. Object CRUD is the DECLARED grant; record visibility also depends on OWD + guest sharing rules.`,
          grantConfidence: 'declared',
          guestLinkageConfidence: 'heuristic',
          access: {
            read: flags.allowRead,
            create: flags.allowCreate,
            edit: flags.allowEdit,
            delete: flags.allowDelete,
            viewAllRecords: flags.viewAllRecords,
            modifyAllRecords: flags.modifyAllRecords,
          },
          guestReadablePiiFieldCount: piiCount,
        });
      }

      // Apex classes the guest profile can invoke.
      for (const apex of apexGrants) {
        communityFindings.push({
          communityId: site.id,
          guestProfileId,
          kind: 'apex-enabled',
          severity: 'low',
          nodeId: `${APEX_PREFIX}${apex}`,
          label: apex,
          detail: `guest profile has class access to Apex ${apex} — a guest-invocable class; review it enforces CRUD/FLS (guest context runs without a user)`,
          grantConfidence: 'declared',
          guestLinkageConfidence: 'heuristic',
        });
      }
    }

    // Guest sharing rules attached to this community (matched by site name).
    const siteNamesToMatch = new Set<string>([site.apiName, siteLabel]);
    if (network !== null) siteNamesToMatch.add(network.apiName);
    for (const name of siteNamesToMatch) {
      for (const rule of guestRulesBySite.get(name) ?? []) {
        communityFindings.push({
          communityId: site.id,
          guestProfileId,
          kind: 'guest-sharing-rule',
          severity: 'low',
          nodeId: rule.id,
          label: rule.apiName,
          detail: `guest sharing rule ${rule.id} (accessLevel ${stringProp(rule.properties, 'accessLevel') ?? 'Read'}) shares records with the '${name}' site guest user — record-level applicability requires org data`,
          grantConfidence: 'declared',
          guestLinkageConfidence: 'heuristic',
        });
      }
    }

    if (network === null && communityId === undefined) {
      // A site with no correlated Network is either a Force.com site or a
      // community whose Network wasn't retrieved — noted, not dropped.
    }
    // Apply the optional OBJECT scope: keep only findings on that object (its
    // CRUD, its fields' FLS, its guest sharing rules). Object-independent
    // findings (apex-enabled) drop out. Filtering HERE keeps per-community
    // `findingCount`/`criticalCount` and the global `findings` list consistent.
    const scopedFindings =
      objectScope === null
        ? communityFindings
        : communityFindings.filter((f) => findingObjectApiName(f) === objectScope);
    const criticalCount = scopedFindings.filter((f) => f.severity === 'critical').length;
    communities.push({
      communityId: site.id,
      label: siteLabel,
      siteType: stringProp(site.properties, 'siteType'),
      active: boolProp(site.properties, 'active'),
      networkId: network?.id ?? null,
      status: network !== null ? stringProp(network.properties, 'status') : null,
      selfRegistration: network !== null ? boolProp(network.properties, 'selfRegistration') : null,
      enableGuestFileAccess:
        network !== null ? boolProp(network.properties, 'enableGuestFileAccess') : null,
      experienceBundleId,
      guestProfileId,
      guestProfileConfidence: 'heuristic',
      guestProfileResolved,
      findingCount: scopedFindings.length,
      criticalCount,
    });
    findings.push(...scopedFindings);
  }

  // Networks referencing a CustomSite that is not modeled (only for a full run).
  if (communityId === undefined) {
    const modeledSiteApiNames = new Set(allSites.map((s) => s.apiName));
    for (const net of allNetworks) {
      const siteName = stringProp(net.properties, 'site');
      if (siteName !== null && !modeledSiteApiNames.has(siteName)) orphanNetworks.push(net.id);
    }
  }

  // Guest sharing rules that attach to NO modeled community — the mirror of
  // `orphanNetworks`, and the bucket whose absence made this tool drop real
  // guest grants in silence. Membership is decided against EVERY modeled
  // community (`attributableSiteNames`), so a rule is listed only when it is
  // genuinely unattributable, never merely out of the caller's scope.
  //
  // It is computed under a `communityId` scope TOO. Suppressing it there
  // restored full silence for the rule most likely to belong to the scoped
  // community: an unattributable rule belongs to NO community, so it may well
  // belong to this one — a site-label mismatch is exactly how a rule becomes
  // unattributable. The rules stay OUT of `findings` and out of every
  // community's `findingCount` under that scope (they are not attributed to
  // it), and the disclosure below says so. Under an OBJECT scope the same
  // filter the findings get is applied, so the bucket never widens past the
  // scope the caller asked for.
  const orphanRulePage = pageOrphanRules(
    orphanRowsFor(
      allGuestRules.filter((rule) => {
        const siteName = stringProp(rule.properties, 'siteName');
        return siteName === null || !attributableSiteNames.has(siteName);
      }),
    ),
    input.orphanOffset ?? 0,
  );
  // The orphan rows and the findings page share ONE envelope, so charge the
  // orphan bytes against the findings slice. Otherwise a full findings page
  // plus a full orphan page overruns the global budget and the guard trims
  // whichever array it finds largest — which is how the bucket came to be
  // silently shortened while its own disclosure still claimed every row.
  const findingsByteBudget = Math.max(
    FINDINGS_BYTE_BUDGET_FLOOR,
    FINDINGS_BYTE_BUDGET -
      (orphanRulePage.rows.length > 0
        ? Buffer.byteLength(JSON.stringify(orphanRulePage.rows), 'utf8') +
          ORPHAN_BLOCK_OVERHEAD_BYTES
        : 0),
  );

  // Rank: severity (critical→low), then kind, then nodeId — a stable total order.
  findings.sort((a, b) => {
    if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (a.communityId !== b.communityId) return a.communityId < b.communityId ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  const limit = input.limit ?? DEFAULT_LIMIT;
  // Bind the pagination cursor to BOTH scope axes — a cursor minted for a bare
  // (or differently-scoped) call must not resume against an object-scoped call,
  // whose findings set differs (else a resume could skip or duplicate rows).
  const fingerprint = argsFingerprint({
    ...(communityId !== undefined ? { communityId } : {}),
    ...(objectScope !== null ? { objectApiName: objectScope } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.guest_exposure_report',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }
  const paged = paginateLegacy(findings, {
    offset,
    limit,
    byteBudget: findingsByteBudget,
    keyOf: (f) => `${f.severity}|${f.communityId}|${f.kind}|${f.nodeId}`,
    binding: {
      tool: 'sfi.guest_exposure_report',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const truncated = paged.hasMore || offset > 0;

  const disclosures: string[] = [
    'The guest-profile identity is HEURISTIC: it is inferred from Salesforce\'s "{Site Label} Profile" naming convention, not a declared metadata pointer. Every finding\'s underlying CRUD/FLS/apex grant is `declared`, but that the profile IS the site guest user is heuristic — so the report confidence is `heuristic`. Confirm the guest profile in Setup.',
    'Object CRUD + FLS are the DECLARED static grant. Actual record visibility to a guest also depends on OWD + guest/criteria sharing rules (record level) — guest sharing rules are surfaced as their own findings, but whether a specific record matches is not modeled here.',
    'Visualforce-page guest access (`<pageAccesses>`) is NOT in the offline metadata model — only Apex-class access is enumerated. A guest-exposed VF page will not appear as a finding.',
  ];
  if (objectScope !== null) {
    disclosures.push(
      `Scoped to object '${objectScope}': only guest exposure ON ${objectScope} (its object CRUD, its fields' FLS, and its guest sharing rules) is reported — other objects' guest grants and object-independent guest Apex access are filtered OUT. \`summary\`, \`findings\`, and each community's \`findingCount\`/\`criticalCount\` reflect this object scope (see \`appliedScope\`).`,
    );
  }
  const unresolved = communities.filter((c) => !c.guestProfileResolved).map((c) => c.communityId);
  if (unresolved.length > 0) {
    disclosures.push(
      `${unresolved.length} community/communities have NO resolvable guest profile in this vault (${unresolved.join(', ')}) — the conventionally-named site guest profile was not retrieved. Their guest exposure is NOT checked (never "no exposure"); include Profile in the next \`/sfi-refresh\`.`,
    );
  }
  if (orphanNetworks.length > 0) {
    disclosures.push(
      `${orphanNetworks.length} Network(s) reference a CustomSite not modeled in this vault (${orphanNetworks.join(', ')}) — their site container / guest profile was not retrieved, so their guest exposure is NOT audited here.`,
    );
  }
  if (orphanRulePage.totalCount > 0) {
    const unattributable = `${orphanCountPhrase(orphanRulePage.totalCount, scanTruncated)} guest sharing rule(s) could NOT be attributed to ANY modeled community — each declares a site name that matches no CustomSite api name, site label, or Network api name in this vault (or declares none at all). They ARE declared record-level grants to unauthenticated visitors and are NOT counted in any community's \`findingCount\``;
    // REMEDY. When this same payload already names Networks whose CustomSite is
    // not modeled, that IS the diagnosed cause of an unmatched site name —
    // sending the operator to Setup to "confirm each rule's site" would point
    // them away from a gap the vault has already identified for them.
    const remedy =
      orphanNetworks.length > 0
        ? ` This payload already names a likelier cause than an org-side discrepancy: ${orphanNetworks.length} modeled Network(s) reference a CustomSite this vault does not model (the Network disclosure above), so a rule naming one of those missing sites lands here. Retrieve the missing CustomSite — include CustomSite / Network / ExperienceBundle in the next \`/sfi-refresh\` — and re-run before treating any of these as a Setup problem.`
        : ` Include the missing CustomSite/Network in the next \`/sfi-refresh\` and re-run; only if a rule's site name is still unmatched after a complete retrieve is it worth confirming that site in Setup.`;
    disclosures.push(
      communityId === undefined
        ? `${unattributable}, so this report's per-community guest exposure is INCOMPLETE for them — never read their absence from \`findings\` as "no exposure". ${orphanListingSentence(orphanRulePage)}${remedy}`
        : `${unattributable}, this one included. Because they belong to NO community, one of them may well belong to '${communityId}' — a site-label mismatch is exactly how a rule becomes unattributable — so this SCOPED answer is INCOMPLETE for them: never read their absence from \`findings\` as "no guest exposure on this community". ${orphanListingSentence(orphanRulePage)}${remedy}`,
    );
  }
  if (scanTruncated) {
    disclosures.push(
      'A SharingRule scan hit the per-type node cap (SFI_NODE_SCAN_LIMIT) — some guest sharing-rule findings may be missing.',
    );
  }

  const coverage = summarizeCoverage(ctx.manifest, [
    'Network',
    'CustomSite',
    'Profile',
    'CustomField',
    'SharingRule',
  ]);

  return ok({
    data: {
      communities,
      findings: paged.items,
      summary: {
        communities: communities.length,
        guestProfilesResolved,
        totalFindings: findings.length,
        critical: bySeverity.critical,
        high: bySeverity.high,
        medium: bySeverity.medium,
        low: bySeverity.low,
      },
      appliedScope,
      limit,
      offset,
      hasMore: paged.hasMore,
      truncated,
      scanTruncated,
      ...(orphanRulePage.totalCount > 0
        ? {
            orphanGuestRules: orphanRulePage.rows,
            orphanGuestRulesPage: orphanPageMarker(orphanRulePage),
          }
        : {}),
      confidence: 'heuristic',
      disclosures,
      boundaryNote: `Ranked guest-exposure audit across ${communities.length} modeled community surface(s)${objectScope !== null ? `, scoped to object '${objectScope}'` : ''}; ${bySeverity.critical} critical (public write on a PII object), ${bySeverity.high} high. Findings page with offset/limit; \`communities\` and \`summary\` hold complete counts. \`appliedScope\` echoes the scope actually applied. Confidence is heuristic — the guest-profile linkage is a naming convention.`,
      trust: offlineTrust(ctx, {
        status: coverage.status,
        ...(coverage.missingCoverage.length > 0 ? { missingCoverage: coverage.missingCoverage } : {}),
      }),
      ...(paged.nextCursor !== null
        ? { nextCursor: paged.nextCursor, pageInfo: paged.pageInfo }
        : {}),
    },
    vaultState,
  });
};
