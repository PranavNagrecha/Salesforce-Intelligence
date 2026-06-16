/**
 * Handler for the `sfi.org_overview` MCP tool.
 *
 * The v2.0g headline tool — the buyer-facing answer to admin/architect
 * priority #9 on the top-10 questions list: "I'm new — give me a tour
 * of this org". One call returns a structured snapshot of the org's
 * shape: component counts, the most-referenced data model, the most-
 * called code, integration breadth, automation breadth, frontend
 * breadth, and legacy-debt indicators.
 *
 * The tool is a pure composition over existing graph queries — no new
 * extractors, no new ComponentTypes, no new EdgeTypes. It fans out
 * across:
 *   - `listNodesByType` (once per scanned ComponentType, capped to 500
 *     per type to bound the response time) for the in-memory lists the
 *     ranking / automation / largest-class stages reuse.
 *   - `countNodesByType` (once per scanned ComponentType) for the exact
 *     per-type `componentCounts` — the lists above are capped, the counts
 *     are not, so a >500-of-a-type org reports its true total.
 *   - `listEdges` with `direction: 'in'` (once per top-N candidate to
 *     compute the inbound-reference count).
 *   - `listEdges` with `direction: 'out'` (once per Profile to compute
 *     the grantedBy outbound count as the v1.x proxy for user breadth).
 *   - `recognizeNamingConventions` (zero-scope call so the response
 *     carries the existing v0.1 naming-pattern observations summary).
 *
 * The cascade is deliberately bounded: every per-type scan caps at the
 * graph layer's 500 limit, so a 10k-CustomField org still resolves in
 * a single round-trip per type. The inbound-reference fan-out is the
 * dominant cost; the response top-N caps at 10 per category so a
 * caller's UI stays compact.
 *
 * **Honesty axis** (per the v2.0g spec): every "top X" ranking in the
 * response is a heuristic proxy. "Top objects by inbound reference
 * count" doesn't mean "the most important objects" — it means "the
 * objects with the most edges pointing at them in the v1.x graph",
 * which may miss runtime references (dynamic SOQL, integration
 * payloads) or over-count incidental references (a Layout that
 * mentions a field once weighs the same as a Flow that updates it on
 * every save). "Top profiles by grant count" is the v1.x stand-in for
 * "broadest profiles" because the v1.x extractors don't surface user
 * assignment data. The headline counts (componentCounts,
 * integrationSummary, automationSummary, frontendSummary,
 * legacyDebtIndicators) are honest tallies of metadata declarations;
 * the rankings are heuristics that should be cited as "suggested
 * starting points for exploration".
 *
 * Implementation notes:
 *   - The tool takes no input arguments; the schema is `z.object({})`.
 *     A future extension may add a `topN` knob, but v2.0g keeps the
 *     response shape stable for a fresh-onboarding caller who hasn't
 *     yet learned what knobs to twist.
 *   - The `migrationCandidate` rating on `legacyDebtIndicators` is a
 *     simple bucketed heuristic: < 5 legacy items is `'low'`, 5..30
 *     is `'medium'`, > 30 is `'high'`. The thresholds are documented
 *     constants so a future tuning pass can argue from data.
 *   - `largestApexClasses` reads from `properties.sourceBytes` and
 *     `properties.lineCount` (when the v0.3 Apex extractor populated
 *     them). Classes missing both fields are scored as 0 and naturally
 *     fall to the bottom of the sort; this matches the v0.1 honesty
 *     boundary for unparsed sources rather than fabricating sizes.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  PatternObservation,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  countNodesByType,
  listEdges,
  listNodesByType,
} from '@sf-intelligence/graph';
import { recognizeNamingConventions } from '@sf-intelligence/patterns';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { renderOrgOverviewMarkdown } from '../answer-render.js';
import {
  loadRefreshHistory,
  summarizeRecentActivity,
  type RecentActivity,
} from '../history-store.js';
import type { Context } from '../server.js';

import { readFactBlock, type FactsBlock } from './facts-block.js';

/**
 * The ComponentTypes the tour enumerates when summarising the org's
 * shape. Mirrors the contracts `ComponentType` union; declared as a
 * constant so the per-type loop is deterministic and the unit tests
 * can assert against a stable set. Future ComponentType additions
 * land in this list with no other handler changes.
 */
const OVERVIEW_COMPONENT_TYPES = [
  'CustomObject',
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'Profile',
  'PermissionSet',
  'PermissionSetAssignment',
  'NamedCredential',
  'ConnectedApp',
  'Group',
  'Queue',
  'Role',
  'SharingRule',
  'RecordType',
  'BusinessProcess',
  'CustomTab',
  'CustomApplication',
  'QuickAction',
  'PathAssistant',
  'GlobalValueSet',
  'CustomLabel',
  'StaticResource',
  'WorkflowRule',
  'ApprovalProcess',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'DuplicateRule',
  'MatchingRule',
  'EmailTemplate',
  'Letterhead',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'AuthProvider',
  'RemoteSiteSetting',
  'CspTrustedSite',
  'ExternalDataSource',
  'ExternalService',
  'NetworkAccess',
  'CustomMetadataRecord',
  'CustomSettingRecord',
] as const satisfies readonly ComponentType[];

/**
 * Per-type page-size cap for the in-memory node LISTS reused by the ranking,
 * automation, and largest-class stages. The graph layer's `listNodesByType`
 * caps at 500, so this is the upper bound per call. NOTE: the headline
 * `componentCounts` do NOT use these lists — they come from `countNodesByType`
 * (an exact `COUNT(*)`), so a >500-of-a-type org reports its true total. What
 * stays bounded by this cap is the `activeRatio` numerator/denominator sample
 * and the top-N / largest-class scans, which read at most the first 500 by id.
 */
const LIST_PAGE_SIZE = 500;

/** Top-N cap for the ranking categories (`topObjects`, `topApexClasses`, `topProfiles`). */
const TOP_RANKINGS_LIMIT = 10;

/** Top-N cap for `largestApexClasses`. Tighter than the rankings cap because the field is narrower (size, not relationships). */
const LARGEST_APEX_CLASSES_LIMIT = 5;

/** Per-instance scan cap used for the inbound-reference fan-out. */
const RANKING_SCAN_CAP = 200;

/**
 * Migration-candidate bucket thresholds for `legacyDebtIndicators`.
 * "Legacy debt" is the sum of WorkflowRule, ApprovalProcess, and
 * VisualforcePage node counts: each of these surfaces is supported but
 * Salesforce treats them as legacy paths in favour of Flow / approval
 * orchestration / Lightning Web Components respectively. The bucket
 * thresholds are simple and documented so a future tuning pass can
 * argue from data.
 */
const MIGRATION_LOW_THRESHOLD = 5;
const MIGRATION_MEDIUM_THRESHOLD = 30;

/**
 * The six ComponentTypes the `integrationSummary` tallies. Mirrors
 * `INTEGRATION_TYPES` in `integration-map.ts` minus
 * `CspTrustedSite` and `NetworkAccess` (those are surface-allowlist
 * sundries that don't reflect "the org talks to N external systems");
 * `ConnectedApp` is included because each one declares an inbound
 * integration surface.
 */
const INTEGRATION_TYPES_FOR_SUMMARY: readonly ComponentType[] = [
  'NamedCredential',
  'AuthProvider',
  'RemoteSiteSetting',
  'ExternalDataSource',
  'ExternalService',
  'ConnectedApp',
];

/**
 * The four ComponentTypes the `automationSummary` tallies. Each is an
 * "automation" in the v1.x sense — they fire on insert/update/delete
 * and produce side effects. Process Builder placeholders are NOT
 * separately tracked because the v1.x metadata model surfaces Process
 * Builder records as Flow nodes with `properties.processType` ===
 * 'Workflow' (see PLAN-v1.3.md §3); the Flow count already includes
 * them and the legacy-debt indicator below double-counts them via
 * WorkflowRule.
 */
const AUTOMATION_TYPES_FOR_SUMMARY: readonly ComponentType[] = [
  'WorkflowRule',
  'ApprovalProcess',
  'Flow',
  'ApexTrigger',
];

/**
 * Zod schema for the `sfi.org_overview` tool input. The tool takes no
 * arguments; the empty object schema mirrors `sfi.get_manifest` and
 * `sfi.health_check`. Declared as a named export so the dispatcher
 * passes `dispatchTool`'s Zod-parsed `{}` straight into the handler.
 *
 * Note on frontend types: the four ComponentTypes the `frontendSummary`
 * tallies (`LightningComponentBundle`, `AuraDefinitionBundle`,
 * `VisualforcePage`, `VisualforceComponent`) are enumerated inline in
 * the handler's stage 5 logic rather than a named constant — the v1.4
 * frontend tier divides into modern (LWC, Aura) and legacy (VF page,
 * VF component) families, and the ratio between the two IS the legacy-
 * debt signal the summary surfaces.
 */
export const orgOverviewInputSchema = z.object({});

/** Parsed input shape, inferred from `orgOverviewInputSchema`. */
export type OrgOverviewInput = z.infer<typeof orgOverviewInputSchema>;

/**
 * One ranked CustomObject in the `topObjects` array. The ranking
 * proxy is the number of incoming edges (excluding the `parentOf`
 * containment edge from the CustomObject's own children) — i.e., the
 * count of things in the graph that reference the object, not the
 * count of components contained by it.
 */
export interface TopObjectEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly inboundReferences: number;
}

/**
 * One ranked ApexClass in the `topApexClasses` array. The ranking
 * proxy is the number of incoming `callsApex` edges — i.e., the count
 * of other code that calls into this class.
 */
export interface TopApexClassEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly inboundCalls: number;
}

/**
 * One ranked Profile in the `topProfiles` array. The ranking proxy is
 * the count of outgoing `grantedBy` edges — i.e., the count of
 * components this profile grants access to. The v1.x extractors do
 * NOT surface user-assignment data, so "broadest by users" is
 * deferred to a future enrichment; the metadata-grant count is the
 * honest stand-in.
 */
export interface TopProfileEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly grantCount: number;
}

/**
 * Integration-surface tally. `total` is the unweighted sum of the
 * six categorical counts — useful as a single headline number for
 * "how integrated is this org?".
 */
export interface IntegrationSummary {
  readonly namedCredentials: number;
  readonly authProviders: number;
  readonly remoteSiteSettings: number;
  readonly externalDataSources: number;
  readonly externalServices: number;
  readonly connectedApps: number;
  readonly total: number;
}

/**
 * Automation-surface tally. `activeRatio` is the fraction of
 * automation that's flagged active (where the v1.x extractors
 * surfaced an `isActive` property); orgs whose `Flow.status` is
 * `'Active'`, whose `WorkflowRule.active` is `true`, and whose
 * `ApexTrigger` has no isActive=false marker contribute to the
 * active numerator. Bounded `[0, 1]`; reports `0` when the
 * automation count itself is zero (no division by zero).
 */
export interface AutomationSummary {
  readonly workflowRules: number;
  readonly approvalProcesses: number;
  readonly flows: number;
  readonly apexTriggers: number;
  readonly activeRatio: number;
}

/**
 * Frontend-surface tally. `legacyVfDebtRatio` is the fraction of
 * the org's frontend that's still on Visualforce — `(vfPages +
 * vfComponents) / (lwcBundles + auraBundles + vfPages +
 * vfComponents)`. Bounded `[0, 1]`; reports `0` when the frontend
 * count itself is zero.
 */
export interface FrontendSummary {
  readonly lwcBundles: number;
  readonly auraBundles: number;
  readonly vfPages: number;
  readonly vfComponents: number;
  readonly legacyVfDebtRatio: number;
}

/**
 * Legacy-debt indicator bucket. `migrationCandidate` is a bucketed
 * heuristic on `(workflowRules + approvalProcesses + vfPages)`: the
 * three buckets are `'low' | 'medium' | 'high'` per the thresholds
 * `MIGRATION_LOW_THRESHOLD` (`< 5`) and `MIGRATION_MEDIUM_THRESHOLD`
 * (`<= 30`).
 */
export interface LegacyDebtIndicators {
  readonly workflowRules: number;
  readonly approvalProcesses: number;
  readonly vfPages: number;
  readonly migrationCandidate: 'low' | 'medium' | 'high';
}

/**
 * One entry in the `largestApexClasses` ranking. Reports both
 * `sourceBytes` and `lineCount` — both are best-effort honest
 * tallies populated by the v0.3 Apex extractor; classes missing the
 * properties surface as `0` here rather than `null` so the JSON
 * shape stays stable.
 */
export interface LargestApexClassEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly sourceBytes: number;
  readonly lineCount: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface OrgOverviewOutput {
  /** Per-ComponentType node counts. Keys are ComponentType names. */
  readonly componentCounts: Readonly<Record<string, number>>;
  /**
   * P13-FACTS-consumers: captured approximate record counts for the top
   * objects (`data_snapshot` observations from `refresh --with-data-shape`),
   * when any exist. Context only — stamped, sampled-or-approximate, never a
   * live read; absent entirely on a vault with no captured facts.
   */
  readonly dataShape?: {
    readonly provenance: 'data_snapshot';
    readonly recordCounts: ReadonlyArray<{ readonly id: string } & FactsBlock>;
  };
  /** Top 10 CustomObjects by inbound non-parentOf edge count. */
  readonly topObjects: readonly TopObjectEntry[];
  /** Top 10 ApexClasses by inbound callsApex edge count. */
  readonly topApexClasses: readonly TopApexClassEntry[];
  /** Top 10 Profiles by outgoing grantedBy edge count. */
  readonly topProfiles: readonly TopProfileEntry[];
  /** Integration surface tally + total. */
  readonly integrationSummary: IntegrationSummary;
  /** Automation surface tally + active ratio. */
  readonly automationSummary: AutomationSummary;
  /** Frontend surface tally + VF debt ratio. */
  readonly frontendSummary: FrontendSummary;
  /** Legacy debt indicators + migration-candidate bucket. */
  readonly legacyDebtIndicators: LegacyDebtIndicators;
  /** Top 5 ApexClasses by source bytes / line count. */
  readonly largestApexClasses: readonly LargestApexClassEntry[];
  /** Naming-convention observations from the patterns recognizer. */
  readonly namingConventionObservations: readonly PatternObservation[];
  /**
   * "What changed recently" from the continuous-learning store — last-refresh
   * deltas + overall trend. `available: false` when the vault has no history
   * yet. Makes the overview reason over change, not just the latest snapshot.
   */
  readonly recentActivity: RecentActivity;
  /**
   * Per-summary-family retrieval flags. `false` means the family was NOT in this
   * org's retrieve manifest (no coverage AND no nodes), so the matching 0/low
   * tally above means "not checked", not "none in the org" — the v4.0 honesty
   * axis that keeps the tour from asserting absence it never verified.
   */
  readonly coverage: {
    readonly integrationRetrieved: boolean;
    readonly workflowRulesRetrieved: boolean;
    readonly frontendRetrieved: boolean;
  };
  /**
   * Verbatim honesty disclosures for any summary family that was not retrieved.
   * Empty when every summarized family was covered by the retrieve.
   */
  readonly boundaries: readonly string[];
  /**
   * Pass-through-ready Markdown rendering of this overview (totals table, top
   * objects, automation summary, recent activity). The structured fields above
   * remain the source of truth.
   */
  readonly rendered: string;
}

/**
 * Resolve a numeric property from a Node's `properties` blob,
 * defaulting to 0 when the property is absent or non-numeric. Used
 * for the `largestApexClasses` size resolution where `sourceBytes`
 * and `lineCount` are best-effort fields the extractor may or may
 * not populate.
 */
const numericProperty = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): number => {
  const value = properties[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
};

/**
 * Determine whether a Node represents "active" automation. Each of
 * the four automation types stores its active flag under a different
 * property key (Flow uses `status === 'Active'`, WorkflowRule uses
 * `active: true`, ApprovalProcess uses `active: true`, ApexTrigger
 * lacks an `isActive` axis in the v0.1 extractor and is conservatively
 * counted as active). The function returns false only when the
 * property is explicitly present and false-equivalent.
 */
const isActiveAutomation = (node: Node): boolean => {
  const props = node.properties;
  if (node.type === 'Flow') {
    const status = props['status'];
    if (typeof status === 'string') return status === 'Active';
    // No status field — be honest and count as active. Inactive Flows
    // explicitly set status; missing status means the v0.1 extractor
    // could not determine it, in which case "still likely active" is
    // the safer prior for a tour intended to flag debt.
    return true;
  }
  if (node.type === 'WorkflowRule' || node.type === 'ApprovalProcess') {
    const active = props['active'];
    if (typeof active === 'boolean') return active;
    return true;
  }
  // ApexTrigger has no extracted isActive in v0.1; count as active.
  return true;
};

/**
 * Run `listNodesByType` for a single type and return the result, or
 * propagate the underlying graph error as a typed `McpError`.
 */
const fetchNodes = async (
  ctx: Context,
  type: ComponentType,
): Promise<Result<readonly Node[], McpError>> => {
  const result = await listNodesByType(ctx.graph, type, {
    limit: LIST_PAGE_SIZE,
  });
  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }
  return ok(result.value);
};

/**
 * Count incoming non-parentOf edges for a single node. The parentOf
 * containment edge is filtered out because it doesn't represent a
 * "dependency" in the buyer's mental model — a CustomField's
 * containing CustomObject pointing at it does not mean "the object
 * depends on the field"; it means "the field is part of the object".
 */
const countInboundReferences = async (
  ctx: Context,
  id: ComponentId,
): Promise<Result<number, McpError>> => {
  const result = await listEdges(ctx.graph, id, { direction: 'in' });
  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }
  let count = 0;
  for (const edge of result.value) {
    if (edge.edgeType === 'parentOf') continue;
    count += 1;
  }
  return ok(count);
};

/**
 * Count incoming callsApex edges for a single ApexClass id. The
 * callsApex edge family is emitted by every code-tier extractor
 * (Apex scanner, LWC scanner, Flow walker), so the count surfaces the
 * "hot path" classes regardless of which caller surface invokes
 * them.
 */
const countInboundCalls = async (
  ctx: Context,
  id: ComponentId,
): Promise<Result<number, McpError>> => {
  const result = await listEdges(ctx.graph, id, {
    direction: 'in',
    edgeType: 'callsApex',
  });
  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }
  return ok(result.value.length);
};

/**
 * Count outgoing grantedBy edges for a Profile id. The grantedBy edge
 * family connects a Profile (or PermissionSet) to the components it
 * grants access to; the outgoing count is the v1.x proxy for "broad
 * profiles" since user-assignment data isn't extracted.
 */
const countOutgoingGrants = async (
  ctx: Context,
  id: ComponentId,
): Promise<Result<number, McpError>> => {
  const result = await listEdges(ctx.graph, id, {
    direction: 'out',
    edgeType: 'grantedBy',
  });
  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }
  return ok(result.value.length);
};

/** Bucket the legacy-debt sum into the three migration-candidate tiers. */
const bucketMigrationCandidate = (
  legacyTotal: number,
): 'low' | 'medium' | 'high' => {
  if (legacyTotal < MIGRATION_LOW_THRESHOLD) return 'low';
  if (legacyTotal <= MIGRATION_MEDIUM_THRESHOLD) return 'medium';
  return 'high';
};

/**
 * Deterministic comparator for the top-objects / top-apex-classes /
 * top-profiles rankings: count DESC, then id ASC for ties. Keeps the
 * v2.0g output stable across runs so fixture-based tests can pin to
 * a specific ordering.
 */
const compareRankedDesc = <T extends { readonly id: ComponentId }>(
  countOf: (entry: T) => number,
) => (a: T, b: T): number => {
  const ca = countOf(a);
  const cb = countOf(b);
  if (ca !== cb) return cb - ca;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Trim a ranked list to the standard top-N cap. */
const topN = <T>(items: readonly T[], limit: number): readonly T[] =>
  items.length <= limit ? items : items.slice(0, limit);

/**
 * The `sfi.org_overview` MCP tool. Returns a structured org tour
 * snapshot — component counts, top objects / apex / profiles,
 * integration / automation / frontend / legacy-debt summaries,
 * largest apex classes, and naming-convention observations.
 *
 * @example
 *   const r = await orgOverviewHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.componentCounts);
 */
export const orgOverviewHandler = async (
  ctx: Context,
  _input: OrgOverviewInput,
): Promise<Result<McpResponse<OrgOverviewOutput>, McpError>> => {
  // Stage 1: per-type node enumeration. The scan is the dominant
  // cost; every downstream computation re-uses these in-memory lists
  // to avoid re-fetching from the graph.
  const nodesByType = new Map<ComponentType, readonly Node[]>();
  const componentCounts: Record<string, number> = {};
  for (const type of OVERVIEW_COMPONENT_TYPES) {
    const result = await fetchNodes(ctx, type);
    if (!result.ok) return err(result.error);
    nodesByType.set(type, result.value);
    // Exact tally via COUNT(*), NOT the capped list length. The in-memory list
    // (bounded by LIST_PAGE_SIZE) still feeds the bounded ranking / automation
    // / largest-class stages below, but the headline count must not saturate at
    // the page size — a 1,034-CustomField org was reporting 500.
    const countResult = await countNodesByType(ctx.graph, type);
    if (!countResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${countResult.error.message}`,
      });
    }
    componentCounts[type] = countResult.value;
  }

  // Stage 2: top objects by inbound-reference count. Scan up to
  // RANKING_SCAN_CAP CustomObjects; orgs with more than that surface
  // a top-10 derived from the first chunk by id ASC (the graph's own
  // ordering), which is honest but bounded.
  const customObjects = (nodesByType.get('CustomObject') ?? []).slice(
    0,
    RANKING_SCAN_CAP,
  );
  const topObjectsRaw: TopObjectEntry[] = [];
  for (const node of customObjects) {
    const countResult = await countInboundReferences(ctx, node.id);
    if (!countResult.ok) return err(countResult.error);
    topObjectsRaw.push({
      id: node.id,
      apiName: node.apiName,
      inboundReferences: countResult.value,
    });
  }
  const topObjects = topN(
    [...topObjectsRaw].sort(
      compareRankedDesc<TopObjectEntry>((e) => e.inboundReferences),
    ),
    TOP_RANKINGS_LIMIT,
  );

  // Stage 3: top apex classes by inbound callsApex count.
  const apexClasses = (nodesByType.get('ApexClass') ?? []).slice(
    0,
    RANKING_SCAN_CAP,
  );
  const topApexRaw: TopApexClassEntry[] = [];
  for (const node of apexClasses) {
    const countResult = await countInboundCalls(ctx, node.id);
    if (!countResult.ok) return err(countResult.error);
    topApexRaw.push({
      id: node.id,
      apiName: node.apiName,
      inboundCalls: countResult.value,
    });
  }
  const topApexClasses = topN(
    [...topApexRaw].sort(
      compareRankedDesc<TopApexClassEntry>((e) => e.inboundCalls),
    ),
    TOP_RANKINGS_LIMIT,
  );

  // Stage 4: top profiles by outgoing grantedBy count.
  const profiles = (nodesByType.get('Profile') ?? []).slice(0, RANKING_SCAN_CAP);
  const topProfilesRaw: TopProfileEntry[] = [];
  for (const node of profiles) {
    const countResult = await countOutgoingGrants(ctx, node.id);
    if (!countResult.ok) return err(countResult.error);
    topProfilesRaw.push({
      id: node.id,
      apiName: node.apiName,
      grantCount: countResult.value,
    });
  }
  const topProfiles = topN(
    [...topProfilesRaw].sort(
      compareRankedDesc<TopProfileEntry>((e) => e.grantCount),
    ),
    TOP_RANKINGS_LIMIT,
  );

  // Stage 5: integration / automation / frontend summaries.
  const integrationCount = (type: ComponentType): number =>
    componentCounts[type] ?? 0;
  const integrationSummary: IntegrationSummary = {
    namedCredentials: integrationCount('NamedCredential'),
    authProviders: integrationCount('AuthProvider'),
    remoteSiteSettings: integrationCount('RemoteSiteSetting'),
    externalDataSources: integrationCount('ExternalDataSource'),
    externalServices: integrationCount('ExternalService'),
    connectedApps: integrationCount('ConnectedApp'),
    total: INTEGRATION_TYPES_FOR_SUMMARY.reduce(
      (sum, type) => sum + integrationCount(type),
      0,
    ),
  };

  const automationCount = (type: ComponentType): number =>
    componentCounts[type] ?? 0;
  let activeAutomationCount = 0;
  let totalAutomationCount = 0;
  for (const type of AUTOMATION_TYPES_FOR_SUMMARY) {
    const nodes = nodesByType.get(type) ?? [];
    for (const node of nodes) {
      totalAutomationCount += 1;
      if (isActiveAutomation(node)) activeAutomationCount += 1;
    }
  }
  const automationSummary: AutomationSummary = {
    workflowRules: automationCount('WorkflowRule'),
    approvalProcesses: automationCount('ApprovalProcess'),
    flows: automationCount('Flow'),
    apexTriggers: automationCount('ApexTrigger'),
    activeRatio:
      totalAutomationCount === 0
        ? 0
        : activeAutomationCount / totalAutomationCount,
  };

  const frontendCount = (type: ComponentType): number =>
    componentCounts[type] ?? 0;
  const lwcBundles = frontendCount('LightningComponentBundle');
  const auraBundles = frontendCount('AuraDefinitionBundle');
  const vfPages = frontendCount('VisualforcePage');
  const vfComponents = frontendCount('VisualforceComponent');
  const frontendTotal = lwcBundles + auraBundles + vfPages + vfComponents;
  const frontendSummary: FrontendSummary = {
    lwcBundles,
    auraBundles,
    vfPages,
    vfComponents,
    legacyVfDebtRatio:
      frontendTotal === 0 ? 0 : (vfPages + vfComponents) / frontendTotal,
  };

  // Stage 6: legacy-debt indicators.
  const workflowRulesCount = componentCounts['WorkflowRule'] ?? 0;
  const approvalProcessesCount = componentCounts['ApprovalProcess'] ?? 0;
  const vfPagesCount = componentCounts['VisualforcePage'] ?? 0;
  const legacyTotal = workflowRulesCount + approvalProcessesCount + vfPagesCount;
  const legacyDebtIndicators: LegacyDebtIndicators = {
    workflowRules: workflowRulesCount,
    approvalProcesses: approvalProcessesCount,
    vfPages: vfPagesCount,
    migrationCandidate: bucketMigrationCandidate(legacyTotal),
  };

  // Stage 7: largest apex classes. Read from the pre-fetched
  // ApexClass list; sort by `sourceBytes` DESC, then `lineCount` DESC,
  // then id ASC for ties. The size proxy uses `sourceBytes` as the
  // primary axis because it's the more durable signal — a heavily
  // commented class has high byte count even if line count is small.
  const apexAll = nodesByType.get('ApexClass') ?? [];
  const largestApexClassesRaw: LargestApexClassEntry[] = apexAll.map(
    (node) => ({
      id: node.id,
      apiName: node.apiName,
      sourceBytes: numericProperty(node.properties, 'sourceBytes'),
      lineCount: numericProperty(node.properties, 'lineCount'),
    }),
  );
  const largestApexClasses = topN(
    [...largestApexClassesRaw].sort((a, b) => {
      if (a.sourceBytes !== b.sourceBytes) return b.sourceBytes - a.sourceBytes;
      if (a.lineCount !== b.lineCount) return b.lineCount - a.lineCount;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }),
    LARGEST_APEX_CLASSES_LIMIT,
  );

  // Stage 8: naming-convention observations. Composed via the
  // patterns recognizer in default-scope mode; a `graph-error` from
  // the recognizer propagates as `internal`, and an `invalid-scope`
  // (impossible since we pass nothing) would propagate as
  // `invalid-query`. The empty observations list is honest when the
  // recognizer finds no scoped pattern.
  const observationsResult = await recognizeNamingConventions(ctx.graph, {});
  if (!observationsResult.ok) {
    if (observationsResult.error.kind === 'invalid-scope') {
      return err({
        kind: 'invalid-query',
        message: observationsResult.error.message,
      });
    }
    return err({
      kind: 'internal',
      message: `naming-convention recognizer failed: ${observationsResult.error.message}`,
    });
  }

  // Fold the continuous-learning store into the org's front-page answer: what
  // changed in the last refresh + the overall trend. A read failure here must
  // not sink the whole overview — degrade to "history unavailable".
  let recentActivity;
  try {
    recentActivity = summarizeRecentActivity(
      await loadRefreshHistory(ctx.vaultRoot),
    );
  } catch {
    recentActivity = summarizeRecentActivity({
      chronological: [],
      refreshCount: 0,
      firstRefreshedAt: null,
      lastRefreshedAt: null,
      netComponentChange: null,
    });
  }

  // Coverage honesty (PLAN-v4.0 axis): a 0 in a summary family is only "none"
  // if that family was actually retrieved. Families absent from this org's
  // retrieve manifest report 0 too. A family counts as retrieved when it has
  // ANY nodes (proof it was pulled) OR the manifest's coverage marks it
  // complete; otherwise the tour must NOT assert "0 integration surfaces" /
  // "0 workflow rules" when it never looked.
  const familyRetrieved = (types: readonly string[]): boolean =>
    types.some((t) => (componentCounts[t] ?? 0) > 0) ||
    summarizeCoverage(ctx.manifest, types).status === 'complete';

  const integrationRetrieved = familyRetrieved(INTEGRATION_TYPES_FOR_SUMMARY);
  const workflowRulesRetrieved = familyRetrieved([
    'WorkflowRule',
    'ApprovalProcess',
  ]);
  const frontendRetrieved = familyRetrieved([
    'LightningComponentBundle',
    'AuraDefinitionBundle',
    'VisualforcePage',
    'VisualforceComponent',
  ]);

  const boundaries: string[] = [];
  if (!integrationRetrieved) {
    boundaries.push(
      `Integration surfaces (NamedCredential, AuthProvider, RemoteSiteSetting, ` +
        `ExternalDataSource, ExternalService, ConnectedApp) were not in this org's ` +
        `retrieve manifest — the integration tally of ${integrationSummary.total} means ` +
        `"not checked", not "none". Widen the retrieve and re-run /sfi-refresh to close it.`,
    );
  }
  if (!workflowRulesRetrieved) {
    boundaries.push(
      `Legacy automation (WorkflowRule, ApprovalProcess) was not retrieved — those ` +
        `tallies read zero only because the families were not pulled, so they mean ` +
        `"not checked", not "none".`,
    );
  }
  if (!frontendRetrieved) {
    boundaries.push(
      `Frontend bundles (LightningComponentBundle, AuraDefinitionBundle, ` +
        `VisualforcePage, VisualforceComponent) were not retrieved — the frontend ` +
        `and legacy-debt tallies mean "not checked", not "none".`,
    );
  }

  const data = {
    componentCounts,
    topObjects,
    topApexClasses,
    topProfiles,
    integrationSummary,
    automationSummary,
    frontendSummary,
    legacyDebtIndicators,
    largestApexClasses,
    namingConventionObservations: observationsResult.value,
    recentActivity,
    coverage: {
      integrationRetrieved,
      workflowRulesRetrieved,
      frontendRetrieved,
    },
    boundaries,
  };

  // P13-FACTS-consumers: attach captured record counts for the top objects.
  const factRows: Array<{ readonly id: string } & FactsBlock> = [];
  for (const top of data.topObjects) {
    const block = await readFactBlock(ctx, top.id as ComponentId, 'recordCount');
    if (block !== undefined) factRows.push({ id: top.id, ...block });
  }

  return ok({
    data: {
      ...data,
      rendered: renderOrgOverviewMarkdown(data),
      ...(factRows.length > 0
        ? { dataShape: { provenance: 'data_snapshot' as const, recordCounts: factRows } }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
