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
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import {
  isRegulatedPiiClassification,
  type QualityIssue,
} from '@sf-intelligence/patterns';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { familyWasExtracted } from './absence-disclosure.js';
import { coercePrefix } from './coerce-id.js';
import { offlineTrust } from './coverage-trust.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { collectPiiInventoryFields, type PiiField } from './pii-inventory.js';
import { QUALITY_ISSUES_PROPERTY } from './quality-scan-coverage.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

const CUSTOM_SITE_PREFIX = 'CustomSite:';
const NETWORK_PREFIX = 'Network:';
const PROFILE_PREFIX = 'Profile:';
const OBJECT_PREFIX = 'CustomObject:';
const FIELD_PREFIX = 'CustomField:';
const APEX_PREFIX = 'ApexClass:';
const SHARING_RULE_PREFIX = 'SharingRule:';
const VISUALFORCE_PAGE_PREFIX = 'VisualforcePage:';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Apex sharing keywords that ENFORCE record sharing on a guest-invoked entry
 * point. Anything else — `without sharing`, or no keyword at all — means a
 * guest-reachable method can read rows the guest user has no share on, which is
 * the canonical Salesforce guest data-leak shape. Named rather than inlined so
 * the escalation below stays one readable expression.
 */
const SHARING_ENFORCED_MODELS: ReadonlySet<string> = new Set([
  'with sharing',
  'inherited sharing',
]);

/** Quality-issue severities, worst first — the ladder {@link worstIssueSeverity} walks. */
const ISSUE_SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
type IssueSeverity = (typeof ISSUE_SEVERITY_ORDER)[number];

/**
 * The recognizer rules that describe a GUEST-CONTEXT data-exposure hazard
 * specifically, as opposed to general code hygiene. Named on the finding so a
 * reader sees WHICH hazard fired rather than only a severity count.
 */
const GUEST_SECURITY_RULES: ReadonlySet<string> = new Set([
  'missing-fls-check',
  'missing-crud-check',
  'soql-injection',
  'without-sharing-no-comment',
  'dynamic-apex',
]);

/**
 * The `<pageAccesses>` blind spot, in the one place both channels read from.
 *
 * GUEST-EXPOSURE-CERTIFIES-A-ZERO-IT-NEVER-CHECKED. Measured on a real org: an
 * ACTIVE public Visualforce site whose guest profile granted NO object CRUD and
 * NO Apex returned `findings: []`, `summary.totalFindings: 0`,
 * `trust.completeness.status: 'complete'` — while a prose disclosure in the very
 * same envelope said a guest-exposed Visualforce page "will not appear as a
 * finding". The site's only guest surface was ten `<pageAccesses>` entries with
 * `<enabled>true</enabled>`, and a Visualforce page RUNS its controller Apex.
 * A consumer reading the structured trust block got the opposite of the truth.
 *
 * The old wording was also misleading about the CAUSE: it said the access is
 * "NOT in the offline metadata model", which sends a reader away from a file the
 * vault actually ships. The `<pageAccesses>` blocks ARE in the retrieved
 * `.profile-meta.xml`, and the pages themselves ARE modeled as
 * `VisualforcePage` nodes — it is the profile extractor that emits no
 * `Profile -> VisualforcePage` grant edge (it emits object, field, class, flow
 * and custom-permission grants and stops there). That is a gap a future
 * extraction closes, and until then a reader can open the profile file by hand.
 */
const VISUALFORCE_GAP_LIMITATION =
  'Visualforce-page guest access is NOT enumerated by this report. The guest profile\'s `<pageAccesses>` entries ARE present in the retrieved `.profile-meta.xml` this vault ships (see each community\'s `guestProfileSourcePath`), and the pages themselves ARE modeled as `VisualforcePage` nodes, but the profile extractor emits no `Profile -> VisualforcePage` grant edge — so no guest-exposed page can ever become a finding here. A Visualforce page RUNS its controller Apex, so this is a real guest-reachable code surface. An empty `findings` list is therefore NEVER proof that a site exposes nothing: read the `<pageAccesses>` blocks in the profile XML yourself before treating a zero as a clearance. See `uncheckedGuestSurfaces`.';

/**
 * The classifier caveat, emitted on EVERY response (in `disclosures` and in
 * `trust.limitations`) rather than only when something was found.
 *
 * Which fields count as regulated here is decided by the shared heuristic
 * recognizer, so both directions of its error are load-bearing on a guest-
 * exposure answer: a field storing regulated data whose API name / label /
 * description carries no signal classifies `public` and never becomes a
 * finding at all. That blind spot does not become untrue when the scoped
 * answer happens to be short, so the sentence does not ride on a condition.
 */
const PII_RECOGNIZER_LIMITATION =
  'Which exposed fields are REGULATED is decided by the shared pii_inventory heuristic recognizer over the field\'s declared API name, label, data type and description — it covers the pii, sensitive and protected (protected-class) tiers, but a field that stores regulated data while carrying no name/description signal classifies public and is NOT reported here. Absence of a field from `findings` is therefore never proof the guest cannot see regulated data on it.';
/** Per-response byte budget for the paged `findings` list; below the ~45 KB guard. */
const FINDINGS_BYTE_BUDGET = 36_000;
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
  /**
   * apex-enabled: the facts THIS VAULT ALREADY HOLDS about the granted class,
   * and which of them could not be read. See {@link GuestApexAnalysis}.
   */
  readonly apex?: GuestApexAnalysis;
}

/**
 * What the vault knows about one guest-invocable Apex class — the join this
 * report used to skip.
 *
 * GUEST-EXPOSURE-RANKS-EVERY-GUEST-CLASS-FLAT. Measured on a real org: a live
 * self-registration community produced 19 `apex-enabled` findings, EVERY one
 * severity `low`, EVERY one carrying the identical sentence "review it enforces
 * CRUD/FLS (guest context runs without a user)". That sentence is an open
 * QUESTION, and the vault had already answered it — on the very node each
 * finding cites. Two of the 19 were `without sharing` `@AuraEnabled`
 * controllers whose own `qualityIssues[]` carried `missing-fls-check` at
 * severity HIGH with line numbers; a third declared no sharing keyword at all
 * and carried twelve `high` plus one `critical`. All three ranked identically
 * to the stock login and change-password boilerplate beside them, on a report
 * whose entire value is ranking. A host reading 19 uniform `low` rows with
 * identical text says "standard Communities boilerplate" and drops the axis.
 *
 * The fix is a JOIN, not a new subsystem: every field below is already on the
 * `ApexClass` node. The honesty half is that both ways of not knowing are
 * TYPED rather than collapsed into the rating:
 *   - `nodeResolved: false` — the granted class is not in this vault at all, so
 *     nothing about it was read and the finding stays UNRATED at `low`;
 *   - `qualityScanned: false` — the class IS modeled but carries no
 *     `qualityIssues` PROPERTY, so the code-quality recognizers never ran over
 *     its source. Decided with the shared `familyWasExtracted` predicate on the
 *     property's PRESENCE, never on an empty array: NOT SCANNED is not CLEAN.
 */
export interface GuestApexAnalysis {
  /** Whether the granted `ApexClass` node exists in this vault at all. */
  readonly nodeResolved: boolean;
  /**
   * Whether the code-quality recognizers ever RAN over this class's source —
   * decided by whether the node carries the `qualityIssues` property, never by
   * whether that array is empty.
   */
  readonly qualityScanned: boolean;
  /** The declared sharing keyword, `null` when the class declares none. */
  readonly sharingModel: string | null;
  /**
   * Whether a guest-invoked entry point on this class runs OUTSIDE record
   * sharing (`without sharing`, or no keyword at all). `null` when the vault
   * never recorded a sharing model for this class, so it was not ranked on.
   */
  readonly sharingBypass: boolean | null;
  /**
   * Whether the class exposes a remotely-invocable entry point
   * (`@AuraEnabled` / `@RestResource` / `@InvocableMethod`). `null` when none
   * of those markers was extracted onto this node.
   */
  readonly remotelyInvocable: boolean | null;
  /** `true` for an `@isTest` class — not invocable at runtime, so capped at `low`. */
  readonly isTest: boolean | null;
  readonly status: string | null;
  /**
   * Per-severity counts from the class's own `qualityIssues[]`. ABSENT exactly
   * when `qualityScanned` is false — the absence is guarded by a typed boolean,
   * never left for a consumer to infer from a zero.
   */
  readonly qualityIssueCounts?: Readonly<Record<IssueSeverity, number>>;
  /** Guest-relevant recognizer rules that fired, deduped and sorted. */
  readonly securityRules?: readonly string[];
}

/**
 * A guest-reachable surface this report did NOT enumerate, with the evidence
 * that says whether it exists — the TYPED half of the honesty channel, so a
 * machine consumer reading `findings: []` cannot skip the gap the way it could
 * skip a sentence in `disclosures`.
 *
 * `kind` splits the two cases the way the rest of the product splits them:
 *   - `extractor-blind` — the family IS in the vault but no grant edge is
 *     emitted for it, so this report can never see a grant. `modeledNodeCount`
 *     is the evidence that the family is there to be read by hand.
 *   - `not-enumerated` — grant edges to that family DO exist on the scoped
 *     guest profiles, and this build does not rank them.
 */
export interface UncheckedGuestSurface {
  /** The component family, e.g. `VisualforcePage`. */
  readonly surface: string;
  readonly kind: 'extractor-blind' | 'not-enumerated';
  /** Nodes of that family this vault holds (`0` = the family was not retrieved). */
  readonly modeledNodeCount: number;
  /** `grantedBy` edges to that family seen on the scoped guest profiles. */
  readonly guestGrantEdgeCount: number;
  readonly detail: string;
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
  /**
   * The retrieved `.profile-meta.xml` this vault ships for that guest profile,
   * or `null` when the profile did not resolve. Named because the
   * `<pageAccesses>` grants this report cannot enumerate live in that file —
   * a disclosure that says "go and look" has to say WHERE.
   */
  readonly guestProfileSourcePath: string | null;
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
   * Guest-reachable surfaces this report did NOT enumerate — see
   * {@link UncheckedGuestSurface}. ALWAYS present and never empty: the
   * Visualforce-page grant plane is unmodeled on every vault, so every response
   * this tool produces has at least one. Read it before reading `findings: []`
   * as "nothing is exposed"; `trust.completeness.status` is downgraded off
   * `complete` for the same reason.
   */
  readonly uncheckedGuestSurfaces: readonly UncheckedGuestSurface[];
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

/**
 * The class's own quality findings, narrowed for TYPE only. Whether the scan
 * RAN is decided separately by `familyWasExtracted` on the property's presence
 * — this function is never the absence decision, so an empty return here always
 * means "scanned and clean".
 */
const qualityIssuesOf = (
  props: Readonly<Record<string, unknown>>,
): readonly QualityIssue[] => {
  const raw = props[QUALITY_ISSUES_PROPERTY];
  return Array.isArray(raw) ? (raw as readonly QualityIssue[]) : [];
};

/** The worst severity present in a quality-issue list, or `null` when empty. */
const worstIssueSeverity = (
  issues: readonly QualityIssue[],
): IssueSeverity | null => {
  for (const level of ISSUE_SEVERITY_ORDER) {
    if (issues.some((i) => i.severity === level)) return level;
  }
  return null;
};

/**
 * OR of the remote-invocation markers, `null` when the vault recorded NONE of
 * them on this node — an old vault's silence must not read as "no remote entry
 * point", which is exactly the collapse this release is fixing.
 */
const remoteInvocabilityOf = (
  props: Readonly<Record<string, unknown>>,
): boolean | null => {
  const markers = ['hasAuraEnabledMethod', 'isRestResource', 'hasInvocableMethod'].map(
    (k) => boolProp(props, k),
  );
  if (markers.every((m) => m === null)) return null;
  return markers.some((m) => m === true);
};

/** Per-severity census of a class's quality issues (zeros included). */
const countIssueSeverities = (
  issues: readonly QualityIssue[],
): Record<IssueSeverity, number> => {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const issue of issues) {
    if (issue.severity in counts) counts[issue.severity as IssueSeverity] += 1;
  }
  return counts;
};

/** Human phrase for a count census, e.g. `1 critical, 3 high`. */
const describeIssueCounts = (counts: Record<IssueSeverity, number>): string => {
  const parts = ISSUE_SEVERITY_ORDER.filter((k) => counts[k] > 0).map(
    (k) => `${counts[k]} ${k}`,
  );
  return parts.length === 0 ? 'no quality issues' : parts.join(', ');
};

/**
 * Rank ONE guest-invocable Apex class on the facts the vault already holds, and
 * say plainly which of those facts could not be read. See
 * {@link GuestApexAnalysis} for the defect this closes.
 *
 * The ladder, in one expression: an `@isTest` class is capped at `low` because
 * it cannot be invoked at runtime; otherwise the class's own worst recognizer
 * severity leads, a sharing bypass on a remotely-invocable class is `high` on
 * its own (the canonical guest leak shape), and a bare sharing bypass or a
 * `medium` recognizer hit is `medium`. A class that was never read is UNRATED
 * at `low` with the reason in the detail — never rated safe.
 */
const analyseGuestApex = (
  apexId: string,
  apexName: string,
  cls: Node | null,
): { readonly analysis: GuestApexAnalysis; readonly severity: ExposureSeverity; readonly detail: string } => {
  const lead = `guest profile has class access to Apex ${apexName} (${apexId})`;
  if (cls === null) {
    return {
      analysis: {
        nodeResolved: false,
        qualityScanned: false,
        sharingModel: null,
        sharingBypass: null,
        remotelyInvocable: null,
        isTest: null,
        status: null,
      },
      severity: 'low',
      detail: `${lead} — that ApexClass is NOT IN THIS VAULT, so its sharing model and code-quality scan were never read. This finding is UNRATED (held at \`low\`): it means "not checked", NOT "reviewed and safe". Include ApexClass in the next \`/sfi-refresh\` and re-run.`,
    };
  }
  const props = cls.properties;
  const qualityScanned = familyWasExtracted(props, QUALITY_ISSUES_PROPERTY);
  const issues = qualityIssuesOf(props);
  const counts = countIssueSeverities(issues);
  const worst = qualityScanned ? worstIssueSeverity(issues) : null;
  const sharingKnown = familyWasExtracted(props, 'sharingModel');
  const sharingModel = stringProp(props, 'sharingModel');
  const sharingBypass = sharingKnown
    ? sharingModel === null || !SHARING_ENFORCED_MODELS.has(sharingModel)
    : null;
  const remotelyInvocable = remoteInvocabilityOf(props);
  const isTest = boolProp(props, 'isTest');
  const securityRules = [
    ...new Set(issues.filter((i) => GUEST_SECURITY_RULES.has(i.rule)).map((i) => i.rule)),
  ].sort();
  const severity: ExposureSeverity =
    isTest === true
      ? 'low'
      : worst === 'critical'
        ? 'critical'
        : worst === 'high'
          ? 'high'
          : sharingBypass === true && remotelyInvocable === true
            ? 'high'
            : sharingBypass === true || worst === 'medium'
              ? 'medium'
              : 'low';
  const sharingPhrase =
    sharingBypass === null
      ? 'its sharing model was never extracted onto this node, so sharing was NOT ranked on'
      : sharingModel === null
        ? 'it declares NO sharing keyword, so a guest entry point runs outside record sharing'
        : `it is declared \`${sharingModel}\``;
  const invocablePhrase =
    remotelyInvocable === null
      ? 'no remote-entry-point markers were extracted onto this node'
      : remotelyInvocable
        ? 'it exposes a remotely-invocable entry point (@AuraEnabled / @RestResource / @InvocableMethod)'
        : 'no remotely-invocable entry point is declared on it';
  const scanPhrase = qualityScanned
    ? `the vault's own code-quality scan of this class carries ${describeIssueCounts(counts)}${
        securityRules.length > 0 ? ` (${securityRules.join(', ')})` : ''
      }`
    : 'this class carries NO `qualityIssues` property, so the code-quality recognizers NEVER RAN over its source — NOT SCANNED, which is not the same as clean';
  const testPhrase =
    isTest === true
      ? ' It declares @isTest, so it is not invocable at runtime by a guest — capped at `low` regardless of what the scan found.'
      : '';
  return {
    analysis: {
      nodeResolved: true,
      qualityScanned,
      sharingModel,
      sharingBypass,
      remotelyInvocable,
      isTest,
      status: stringProp(props, 'status'),
      ...(qualityScanned ? { qualityIssueCounts: counts, securityRules } : {}),
    },
    severity,
    detail: `${lead} — ${sharingPhrase}, ${invocablePhrase}; ${scanPhrase}.${testPhrase}`,
  };
};

/**
 * The `uncheckedGuestSurfaces` rows for one response. The Visualforce row is
 * UNCONDITIONAL — the grant plane is unmodeled on every vault — so this list is
 * never empty and `trust.completeness` can never be `complete`.
 *
 * `guestGrantEdgeCount` is measured, not assumed: if a future extraction starts
 * emitting `Profile -> VisualforcePage` grants, the row flips to
 * `not-enumerated` and says the grants exist while this build does not rank
 * them, rather than continuing to claim the plane is invisible.
 */
const buildUncheckedGuestSurfaces = (opts: {
  readonly modeledPageCount: number;
  readonly pageCountIsFloor: boolean;
  readonly guestPageGrantEdges: number;
}): readonly UncheckedGuestSurface[] => {
  const countPhrase = `${opts.pageCountIsFloor ? 'At least ' : ''}${opts.modeledPageCount}`;
  const evidence =
    opts.modeledPageCount === 0
      ? 'This vault holds NO `VisualforcePage` node either, so the pages themselves were not retrieved.'
      : `${countPhrase} \`VisualforcePage\` node(s) ARE modeled in this vault, so the pages exist — only the grant edge is missing.`;
  return [
    {
      surface: 'VisualforcePage',
      kind: opts.guestPageGrantEdges > 0 ? 'not-enumerated' : 'extractor-blind',
      modeledNodeCount: opts.modeledPageCount,
      guestGrantEdgeCount: opts.guestPageGrantEdges,
      detail:
        opts.guestPageGrantEdges > 0
          ? `${opts.guestPageGrantEdges} \`Profile -> VisualforcePage\` grant edge(s) were seen on the scoped guest profile(s) and this build does NOT rank them as findings. ${evidence} Read them directly, or from the \`<pageAccesses>\` blocks in the profile XML at \`guestProfileSourcePath\`.`
          : `The profile extractor emits no \`Profile -> VisualforcePage\` grant edge (it emits object, field, Apex-class, flow and custom-permission grants and stops there), so a guest-exposed Visualforce page can NEVER become a finding here. ${evidence} The \`<pageAccesses>\` blocks ARE present in the retrieved profile XML at \`guestProfileSourcePath\` — open it to see which pages a guest can load. A Visualforce page RUNS its controller Apex, so this is a real guest-reachable code surface.`,
    },
  ];
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

  // ONE full multi-window scan for all three corpora, through the shared
  // `scanAllNodesOfTypes`. This file used to hold its OWN walker (`drainType`,
  // a hand-rolled OFFSET loop on a hardcoded 500 page size) AND, thirty lines
  // below it, a single-page `listNodesByType` for SharingRule — so the two
  // community types were drained while the HIGHEST-STAKES type was not. A
  // second copy of a corpus walk is exactly the drift that produced that
  // split; there is now one call and no local walker to diverge from it.
  const scanResult = await scanAllNodesOfTypes(ctx.graph, [
    'CustomSite',
    'Network',
    'SharingRule',
  ]);
  if (!scanResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scanResult.error.message}` });
  }
  const allSites = scanResult.value.nodes.filter((n) => n.type === 'CustomSite');
  const allNetworks = scanResult.value.nodes.filter((n) => n.type === 'Network');

  // The Visualforce-page corpus, scanned SEPARATELY from the three corpora
  // above so a cap on it can never be mistaken for a cap on the SharingRule
  // walk — the two feed different disclosures and collapsing them would make
  // "some guest sharing-rule findings may be missing" fire for a reason that
  // has nothing to do with sharing rules. Counted, not enumerated: the count is
  // the evidence that the pages EXIST while the grant edge does not, which is
  // what turns `uncheckedGuestSurfaces` from an assertion into a measurement.
  const pageScan = await scanAllNodesOfTypes(ctx.graph, ['VisualforcePage']);
  if (!pageScan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${pageScan.error.message}` });
  }
  const modeledPageCount = pageScan.value.nodes.length;
  const pageCountIsFloor = pageScan.value.scanIncomplete;
  /** `Profile -> VisualforcePage` grant edges seen on the scoped guest profiles. */
  let guestPageGrantEdges = 0;

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
  //
  // SCANNED ACROSS EVERY WINDOW, not one page. This was a single
  // `listNodesByType` call — `ORDER BY id ASC LIMIT <=500 OFFSET 0` over the
  // whole SharingRule type — while CustomSite and Network thirty lines above
  // were drained window-by-window. An org with more sharing rules than the
  // per-type cap (routine) had every guest rule past id-rank 500 dropped: no
  // finding, no `orphanGuestRules` row, absent from `summary.totalFindings` —
  // and unreachable from ANY call, because `limit`/`offset`/`cursor` page
  // `findings` and `orphanOffset` pages the orphan OUTPUT rows. Nothing
  // advanced the SCAN, so the `scanTruncated` flag named an answer no caller
  // could complete, on the highest-stakes surface this tool has: record-level
  // grants to unauthenticated internet visitors. `scanAllNodesOfTypes` walks
  // the SQL OFFSET forward to exhaust the type, and reports incompleteness
  // only at the far residual cap with a BOUNDED PROBE — so a type whose count
  // lands exactly on a window boundary is no longer over-disclosed as
  // truncated the way `scanHitCap(len, cap)` reported it.
  const incompleteTypes = scanResult.value.incompleteTypes;
  const scanTruncated = scanResult.value.scanIncomplete;
  /**
   * Whether the SHARING-RULE corpus specifically fell short. The orphan
   * bucket's count is a FLOOR only when ITS type was capped; hedging that
   * total on a CustomSite cap would understate a number that was in fact
   * fully established.
   */
  const ruleScanTruncated = incompleteTypes.includes('SharingRule');
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
  for (const rule of scanResult.value.nodes) {
    if (rule.type !== 'SharingRule') continue;
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
    const failClosedSurfaces = buildUncheckedGuestSurfaces({
      modeledPageCount,
      pageCountIsFloor,
      guestPageGrantEdges: 0,
    });
    const failClosedDisclosures = [
      'No Experience Cloud surface in the vault — no Network or CustomSite node is modeled. The org may have no communities/sites, OR the vault predates the Experience Cloud extraction (R6-17). Re-run `/sfi-refresh` to pull Network / CustomSite / ExperienceBundle before treating this as "no guest exposure".',
      VISUALFORCE_GAP_LIMITATION,
    ];
    if (orphanRulePage.totalCount > 0) {
      failClosedDisclosures.push(
        `${orphanCountPhrase(orphanRulePage.totalCount, ruleScanTruncated)} guest sharing rule(s) ARE modeled in this vault and NONE of them could be attributed to a community — there is no modeled CustomSite or Network to attribute them to. They are declared record-level grants to unauthenticated visitors, each row carrying its object and \`accessLevel\`. ${orphanListingSentence(orphanRulePage)} None of them are counted in \`summary.totalFindings\`, which stays 0 because no community surface was audited. Never read \`findings: []\` here as "no guest exposure".`,
      );
    }
    if (scanTruncated) {
      failClosedDisclosures.push(
        `${fullScanTruncationNote(incompleteTypes)} Some guest sharing rules may therefore be missing from \`orphanGuestRules\`.`,
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
        uncheckedGuestSurfaces: failClosedSurfaces,
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
        trust: offlineTrust(
          ctx,
          {
            status: coverage.status === 'complete' ? 'unknown' : coverage.status,
            missingCoverage: ['Network', 'CustomSite', 'ExperienceBundle'],
          },
          undefined,
          [VISUALFORCE_GAP_LIMITATION],
        ),
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

  // Regulated field ids, reusing the SAME classifier `pii_inventory` uses —
  // composed, not duplicated. Map id -> classified field for detail.
  //
  // GUEST-EXPOSURE-DROPS-THE-PROTECTED-BUCKET: this used to loop over a
  // hand-written `['pii', 'sensitive']` tuple. The shared recognizer mints a
  // THIRD regulated tier — `protected` (protected-class attributes: race,
  // ethnicity, religion, disability, citizenship / national origin, veteran /
  // military status, gender identity) — and that tuple silently dropped it,
  // while the envelope still certified `trust.completeness: complete` with an
  // EMPTY `trust.limitations`. On a real community the report then listed 31
  // exposed `pii`/`sensitive` fields and NONE of the eight protected-class
  // fields the same guest profile held READ+EDIT FLS on, which reads to a host
  // as "nothing in a special category is reachable".
  //
  // The fix is adoption, not a fourth copy: `isRegulatedPiiClassification` is
  // the shared predicate in `@sf-intelligence/patterns` whose own doc says
  // callers must use it "rather than an ad-hoc `=== 'pii' || === 'sensitive'`
  // check, so `protected` is never missed". One unfiltered classification pass
  // now feeds it — which also collapses the previous per-classification full
  // org scans into a single one.
  const piiById = new Map<string, PiiField>();
  const collected = await collectPiiInventoryFields(ctx, {});
  if (!collected.ok) return collected;
  for (const f of collected.value.fields) {
    if (isRegulatedPiiClassification(f.classification)) piiById.set(f.id, f);
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
    const guestProfileNode = profileResult.value;
    const guestProfileResolved = guestProfileNode !== null;
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
        } else if (edge.toId.startsWith(VISUALFORCE_PAGE_PREFIX)) {
          // Counted, never dropped: the plane this build does not rank is
          // MEASURED here so `uncheckedGuestSurfaces` reports what it saw
          // rather than asserting a permanent blindness it never re-checked.
          guestPageGrantEdges += 1;
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

      // Apex classes the guest profile can invoke, RANKED on the facts the
      // vault already holds about each one (sharing model, remote entry point,
      // the class's own `qualityIssues[]`) instead of a flat `low` and an open
      // question. See `GuestApexAnalysis` for the real-org defect this closes.
      for (const apex of apexGrants) {
        const apexId = `${APEX_PREFIX}${apex}`;
        const apexNodeResult = await getNodeById(ctx.graph, apexId as ComponentId);
        if (!apexNodeResult.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${apexNodeResult.error.message}`,
          });
        }
        const ranked = analyseGuestApex(apexId, apex, apexNodeResult.value);
        communityFindings.push({
          communityId: site.id,
          guestProfileId,
          kind: 'apex-enabled',
          severity: ranked.severity,
          nodeId: apexId,
          label: apex,
          detail: ranked.detail,
          grantConfidence: 'declared',
          guestLinkageConfidence: 'heuristic',
          apex: ranked.analysis,
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
      guestProfileSourcePath: guestProfileNode?.sourcePath ?? null,
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
    VISUALFORCE_GAP_LIMITATION,
    PII_RECOGNIZER_LIMITATION,
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
    const unattributable = `${orphanCountPhrase(orphanRulePage.totalCount, ruleScanTruncated)} guest sharing rule(s) could NOT be attributed to ANY modeled community — each declares a site name that matches no CustomSite api name, site label, or Network api name in this vault (or declares none at all). They ARE declared record-level grants to unauthenticated visitors and are NOT counted in any community's \`findingCount\``;
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
      `${fullScanTruncationNote(incompleteTypes)} Some guest sharing-rule findings may therefore be missing.`,
    );
  }

  const coverage = summarizeCoverage(ctx.manifest, [
    'Network',
    'CustomSite',
    'Profile',
    'CustomField',
    'SharingRule',
  ]);

  const uncheckedGuestSurfaces = buildUncheckedGuestSurfaces({
    modeledPageCount,
    pageCountIsFloor,
    guestPageGrantEdges,
  });
  /**
   * NEVER `complete`. This report enumerates four guest planes and the
   * Visualforce-page grant plane is not one of them, on any vault — so the
   * strongest honest completeness is `partial`, whatever the retrieve coverage
   * says. A real org's ACTIVE public site returned `findings: []` beside
   * `completeness: 'complete'` while its ONLY guest surface was ten enabled
   * `<pageAccesses>` entries; the machine-readable channel certified the
   * opposite of the prose channel in the same envelope.
   */
  const completenessStatus: 'partial' | 'unknown' =
    coverage.status === 'unknown' ? 'unknown' : 'partial';
  const uncheckedSurfaceNames = uncheckedGuestSurfaces.map((u) => u.surface).join(', ');

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
      uncheckedGuestSurfaces,
      ...(orphanRulePage.totalCount > 0
        ? {
            orphanGuestRules: orphanRulePage.rows,
            orphanGuestRulesPage: orphanPageMarker(orphanRulePage),
          }
        : {}),
      confidence: 'heuristic',
      disclosures,
      boundaryNote: `Ranked guest-exposure audit across ${communities.length} modeled community surface(s)${objectScope !== null ? `, scoped to object '${objectScope}'` : ''}; ${bySeverity.critical} critical, ${bySeverity.high} high. NOT A COMPLETE PICTURE OF GUEST REACH: this report enumerates object CRUD, PII field FLS, Apex-class access and guest sharing rules, and does NOT enumerate ${uncheckedSurfaceNames} guest access — a Visualforce page runs its controller Apex, and its \`<pageAccesses>\` grants live in the profile XML at each community's \`guestProfileSourcePath\`, unreachable from this graph. So \`findings: []\` here is never a clearance; see \`uncheckedGuestSurfaces\` and \`trust.limitations\`. Findings page with offset/limit; \`communities\` and \`summary\` hold complete counts. \`appliedScope\` echoes the scope actually applied. Confidence is heuristic — the guest-profile linkage is a naming convention.`,
      // The recognizer caveat rides on EVERY response, findings or none — it
      // describes what the classifier cannot see, which does not become untrue
      // when a scope happens to surface nothing. An empty `limitations` next to
      // `completeness: complete` is the certification this tool has no right to.
      trust: offlineTrust(
        ctx,
        {
          status: completenessStatus,
          ...(coverage.missingCoverage.length > 0
            ? { missingCoverage: coverage.missingCoverage }
            : {}),
        },
        undefined,
        [VISUALFORCE_GAP_LIMITATION, PII_RECOGNIZER_LIMITATION],
      ),
      ...(paged.nextCursor !== null
        ? { nextCursor: paged.nextCursor, pageInfo: paged.pageInfo }
        : {}),
    },
    vaultState,
  });
};
