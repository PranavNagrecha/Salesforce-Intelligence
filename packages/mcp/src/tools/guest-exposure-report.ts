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

import { offlineTrust } from './coverage-trust.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { collectPiiInventoryFields, type PiiField } from './pii-inventory.js';
import { clampedNodeScanLimit, scanHitCap } from './scan-cap.js';

const CUSTOM_SITE_PREFIX = 'CustomSite:';
const NETWORK_PREFIX = 'Network:';
const PROFILE_PREFIX = 'Profile:';
const OBJECT_PREFIX = 'CustomObject:';
const FIELD_PREFIX = 'CustomField:';
const APEX_PREFIX = 'ApexClass:';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Per-response byte budget for the paged `findings` list; below the ~45 KB guard. */
const FINDINGS_BYTE_BUDGET = 36_000;
/** Page size when draining a node type. */
const SCAN_PAGE_SIZE = 500;

/** Zod schema for the `sfi.guest_exposure_report` tool input. */
export const guestExposureReportInputSchema = z.object({
  /**
   * Optional `Network:X` or `CustomSite:X` id to scope the report to ONE
   * community; omit to audit every modeled Experience Cloud / Site surface.
   */
  communityId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
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
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /** True when a Profile/SharingRule scan hit the per-type node cap. */
  readonly scanTruncated: boolean;
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
  if (
    input.communityId !== undefined &&
    !input.communityId.startsWith(CUSTOM_SITE_PREFIX) &&
    !input.communityId.startsWith(NETWORK_PREFIX)
  ) {
    return err({
      kind: 'invalid-query',
      message: `communityId must start with '${CUSTOM_SITE_PREFIX}' or '${NETWORK_PREFIX}'; got '${input.communityId}'`,
      path: 'communityId',
    });
  }

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

  // FAIL CLOSED: no community family modeled at all → never claim "no exposure".
  if (allSites.length === 0 && allNetworks.length === 0) {
    const coverage = summarizeCoverage(ctx.manifest, ['Network', 'CustomSite']);
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
        limit: input.limit ?? DEFAULT_LIMIT,
        offset: 0,
        hasMore: false,
        truncated: false,
        scanTruncated: false,
        confidence: 'heuristic',
        disclosures: [
          'No Experience Cloud surface in the vault — no Network or CustomSite node is modeled. The org may have no communities/sites, OR the vault predates the Experience Cloud extraction (R6-17). Re-run `/sfi-refresh` to pull Network / CustomSite / ExperienceBundle before treating this as "no guest exposure".',
        ],
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

  // Scope: a CustomSite id keeps that site; a Network id keeps the site it
  // references (so `Network:X` and `CustomSite:X` both resolve to one surface).
  let scopedSites = allSites;
  if (input.communityId !== undefined) {
    if (input.communityId.startsWith(CUSTOM_SITE_PREFIX)) {
      scopedSites = allSites.filter((s) => s.id === input.communityId);
    } else {
      const net = allNetworks.find((n) => n.id === input.communityId);
      const siteName = net !== undefined ? stringProp(net.properties, 'site') : null;
      scopedSites =
        siteName !== null
          ? allSites.filter((s) => s.apiName === siteName)
          : [];
    }
    if (scopedSites.length === 0) {
      return err({
        kind: 'component-not-found',
        message: `no modeled CustomSite matches \`${input.communityId}\` in this vault (a Network id resolves through its <site>; the site may not be retrieved)`,
        path: input.communityId,
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

  // Guest sharing rules (CR-CAP-16), grouped by their Experience-Cloud site
  // name — the SAME nodes who_can_access_object surfaces.
  const scanLimit = clampedNodeScanLimit();
  let scanTruncated = false;
  const rulesResult = await listNodesByType(ctx.graph, 'SharingRule', { limit: scanLimit });
  if (!rulesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${rulesResult.error.message}` });
  }
  if (scanHitCap(rulesResult.value.length, scanLimit)) scanTruncated = true;
  const guestRulesBySite = new Map<string, Node[]>();
  for (const rule of rulesResult.value) {
    if (stringProp(rule.properties, 'ruleType') !== 'guest') continue;
    const siteName = stringProp(rule.properties, 'siteName');
    if (siteName === null) continue;
    const bucket = guestRulesBySite.get(siteName) ?? [];
    bucket.push(rule);
    guestRulesBySite.set(siteName, bucket);
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

    if (network === null && input.communityId === undefined) {
      // A site with no correlated Network is either a Force.com site or a
      // community whose Network wasn't retrieved — noted, not dropped.
    }
    const criticalCount = communityFindings.filter((f) => f.severity === 'critical').length;
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
      findingCount: communityFindings.length,
      criticalCount,
    });
    findings.push(...communityFindings);
  }

  // Networks referencing a CustomSite that is not modeled (only for a full run).
  if (input.communityId === undefined) {
    const modeledSiteApiNames = new Set(allSites.map((s) => s.apiName));
    for (const net of allNetworks) {
      const siteName = stringProp(net.properties, 'site');
      if (siteName !== null && !modeledSiteApiNames.has(siteName)) orphanNetworks.push(net.id);
    }
  }

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
  const fingerprint = argsFingerprint(
    input.communityId !== undefined ? { communityId: input.communityId } : {},
  );
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
    byteBudget: FINDINGS_BYTE_BUDGET,
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
      limit,
      offset,
      hasMore: paged.hasMore,
      truncated,
      scanTruncated,
      confidence: 'heuristic',
      disclosures,
      boundaryNote: `Ranked guest-exposure audit across ${communities.length} modeled community surface(s); ${bySeverity.critical} critical (public write on a PII object), ${bySeverity.high} high. Findings page with offset/limit; \`communities\` and \`summary\` hold complete counts. Confidence is heuristic — the guest-profile linkage is a naming convention.`,
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
