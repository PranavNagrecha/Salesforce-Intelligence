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
 *   - `scanAllNodesOfTypes` (once per scanned ComponentType, walked to
 *     EXHAUSTION by windowing the SQL `OFFSET` past the graph layer's
 *     500-row per-page cap) for the in-memory lists the ranking /
 *     automation / largest-class stages reuse.
 *   - `countNodesByType` (once per scanned ComponentType) for the exact
 *     per-type `componentCounts`.
 *   - `listEdgesForNodes` (ONE batched query per ranked type, chunked so
 *     the SQL `IN (...)` list stays bounded) for the inbound-reference,
 *     inbound-callsApex and outgoing-grantedBy counts.
 *   - `recognizeNamingConventions` (zero-scope call so the response
 *     carries the existing v0.1 naming-pattern observations summary).
 *
 * Every ranking is therefore computed over the WHOLE org, not over an
 * id-ASC prefix. The scans used to stop at the first 500 nodes per type
 * and the rankings at the first 200, so `topApexClasses` was "the ten
 * most-called classes among the alphabetically-first 200" and
 * `automationSummary.activeRatio` measured a 500-node sample against a
 * `COUNT(*)` denominator — a flatly wrong number with no hedge.
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
  Edge,
  EdgeType,
  McpError,
  McpResponse,
  Node,
  PatternObservation,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { countNodesByType, listEdgesForNodes } from '@sf-intelligence/graph';
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

import { familyWasExtracted } from './absence-disclosure.js';
import { readFactBlock, type FactsBlock } from './facts-block.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, fullScanTruncationNote } from './scan-cap.js';

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

/** Top-N cap for the ranking categories (`topObjects`, `topApexClasses`, `topProfiles`). */
const TOP_RANKINGS_LIMIT = 10;

/** Top-N cap for `largestApexClasses`. Tighter than the rankings cap because the field is narrower (size, not relationships). */
const LARGEST_APEX_CLASSES_LIMIT = 5;

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
 * Automation-surface tally. `activeRatio` is the fraction of active
 * automation **among the automation items whose active/inactive status was
 * actually extracted** — `Flow.status`, `ApexTrigger.status`,
 * `WorkflowRule.active` and `ApprovalProcess.active` when the node carries
 * the property. All four families DO carry their axis on a current vault, so
 * on a freshly refreshed org `activeStatusUnknownCount` is `0`. An automation
 * node that does not carry the property — a stale vault whose refresh
 * predates that extraction — is typed absence, not a measured `false`: it is
 * excluded from both the numerator and the denominator and counted in
 * `activeStatusUnknownCount` instead of being guessed as active. Bounded
 * `[0, 1]`; reports `0` when the measured count itself is zero, which means
 * NOT MEASURED rather than "0% active" — read it together with
 * `activeStatusUnknownCount`, and the `boundaries[]` entry says so.
 */
export interface AutomationSummary {
  readonly workflowRules: number;
  readonly approvalProcesses: number;
  readonly flows: number;
  readonly apexTriggers: number;
  readonly activeRatio: number;
  /**
   * Count of automation nodes (of any of the four types) whose
   * active/inactive status was NOT extracted — excluded from `activeRatio`
   * rather than folded into the active numerator. See {@link AutomationSummary}.
   */
  readonly activeStatusUnknownCount: number;
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
 * (`<= 30`) — but ONLY when both addend families were actually
 * retrieved (`coverage.workflowRulesRetrieved` AND
 * `coverage.frontendRetrieved`, since `vfPages` feeds the sum). When
 * either family was not retrieved, `migrationCandidate` reports
 * `'not-checked'` rather than bucketing a sum that may contain an
 * unverified zero — the same typed-absence law as the `boundaries[]`
 * disclosures for those two families, applied to the verdict they feed.
 */
export interface LegacyDebtIndicators {
  readonly workflowRules: number;
  readonly approvalProcesses: number;
  readonly vfPages: number;
  readonly migrationCandidate: 'low' | 'medium' | 'high' | 'not-checked';
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
 * Typed-absence result for one automation node's active/inactive status.
 * `known: false` means the node does not carry the sentinel property at
 * all — per {@link familyWasExtracted}'s law, that is NEVER-CHECKED, not a
 * measured `false`, and `active` is meaningless in that case (always
 * `false`, ignored by every caller).
 */
interface AutomationActiveStatus {
  readonly known: boolean;
  readonly active: boolean;
}

/**
 * Determine an automation Node's active/inactive status, or disclose that it
 * was never extracted. The four automation types store their active flag
 * under two property keys: `Flow` and `ApexTrigger` both carry a `status`
 * string that reads `'Active'` when live, while `WorkflowRule` and
 * `ApprovalProcess` carry a boolean `active`. Every one of the four IS
 * extracted — `packages/extractors/src/apex-trigger.ts` lists `status` in
 * `META_REQUIRED_ELEMENTS` and writes `status: meta.status` into
 * `baseProperties` unconditionally, which is why `automation-build-advisor`'s
 * `isActiveTrigger`, `soe-active` and `what-if-disable-trigger` all read it as
 * the trigger's active axis; this function deliberately matches that
 * predicate rather than inventing a fourth rule.
 *
 * Decided by {@link familyWasExtracted} — whether the node CARRIES the
 * property — never by treating a missing property as a guessed value. Only a
 * genuinely property-less node (a stale vault whose refresh predates that
 * extraction) reports `known: false`. Hardcoding any type to `known: false`
 * would make the tool ASSERT that metadata was not extracted when it is
 * present in the vault, which is a fabricated absence claim — a worse defect
 * than the guess this replaced.
 */
const automationActiveStatus = (node: Node): AutomationActiveStatus => {
  const props = node.properties;
  if (node.type === 'Flow' || node.type === 'ApexTrigger') {
    if (!familyWasExtracted(props, 'status')) return { known: false, active: false };
    const status = props['status'];
    return { known: true, active: typeof status === 'string' && status === 'Active' };
  }
  if (node.type === 'WorkflowRule' || node.type === 'ApprovalProcess') {
    if (!familyWasExtracted(props, 'active')) return { known: false, active: false };
    const active = props['active'];
    return { known: true, active: typeof active === 'boolean' && active };
  }
  // Defensive default for a type outside AUTOMATION_TYPES_FOR_SUMMARY: no
  // known active axis, so typed absence rather than a guess.
  return { known: false, active: false };
};

/**
 * Walk EVERY node of `type` and return the list, or propagate the underlying
 * graph error as a typed `McpError`. Windows the SQL `OFFSET` past the graph
 * layer's 500-row per-page cap, so the ranking / automation / largest-class
 * stages downstream see the whole org rather than an id-ASC prefix.
 * `incomplete` (the residual `FULL_SCAN_MAX_NODES` ceiling) is returned so the
 * caller can disclose it.
 */
const fetchNodes = async (
  ctx: Context,
  type: ComponentType,
): Promise<
  Result<
    { readonly nodes: readonly Node[]; readonly incomplete: boolean },
    McpError
  >
> => {
  const result = await scanAllNodesOfTypes(ctx.graph, [type]);
  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }
  return ok({
    nodes: result.value.nodes,
    incomplete: result.value.scanIncomplete,
  });
};

/**
 * Batched edge counts for a whole ranked type in ~1 query per chunk instead of
 * one `listEdges` per node. The ids are chunked at `clampedNodeScanLimit()` so
 * the SQL `IN (...)` list stays bounded no matter how many nodes the full scan
 * returned. `keep` filters the edges that count (identity by default).
 */
const countEdgesForNodes = async (
  ctx: Context,
  ids: readonly ComponentId[],
  options: {
    readonly direction: 'in' | 'out';
    readonly edgeTypes?: readonly EdgeType[];
    readonly keep?: (edge: Edge) => boolean;
  },
): Promise<Result<ReadonlyMap<ComponentId, number>, McpError>> => {
  const counts = new Map<ComponentId, number>();
  const chunkSize = clampedNodeScanLimit();
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const result = await listEdgesForNodes(ctx.graph, chunk, {
      direction: options.direction,
      ...(options.edgeTypes !== undefined
        ? { edgeTypes: options.edgeTypes }
        : {}),
    });
    if (!result.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${result.error.message}`,
      });
    }
    for (const id of chunk) {
      const edges = result.value.get(id) ?? [];
      const keep = options.keep;
      counts.set(
        id,
        keep === undefined ? edges.length : edges.filter(keep).length,
      );
    }
  }
  return ok(counts);
};

/**
 * The `keep` predicate for the inbound-reference ranking. The parentOf
 * containment edge is filtered out because it doesn't represent a
 * "dependency" in the buyer's mental model — a CustomField's
 * containing CustomObject pointing at it does not mean "the object
 * depends on the field"; it means "the field is part of the object".
 */
const isNonParentOfEdge = (edge: Edge): boolean => edge.edgeType !== 'parentOf';

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
  const incompleteScanTypes: string[] = [];
  for (const type of OVERVIEW_COMPONENT_TYPES) {
    const result = await fetchNodes(ctx, type);
    if (!result.ok) return err(result.error);
    nodesByType.set(type, result.value.nodes);
    if (result.value.incomplete) incompleteScanTypes.push(type);
    // Exact tally via COUNT(*). The in-memory list is now the WHOLE type, so
    // the two agree; the COUNT(*) stays because it is the cheaper source of
    // truth and covers a type the scan left at its residual cap.
    const countResult = await countNodesByType(ctx.graph, type);
    if (!countResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${countResult.error.message}`,
      });
    }
    componentCounts[type] = countResult.value;
  }

  // Stages 2-4: the three rankings, each over EVERY node of its type (no
  // id-ASC prefix) via ONE batched `listEdgesForNodes` per chunk instead of a
  // `listEdges` per node — exact rankings at ~3 queries rather than ~1,400.
  const customObjects = nodesByType.get('CustomObject') ?? [];
  const objectCounts = await countEdgesForNodes(
    ctx,
    customObjects.map((n) => n.id),
    { direction: 'in', keep: isNonParentOfEdge },
  );
  if (!objectCounts.ok) return err(objectCounts.error);
  const topObjects = topN(
    customObjects
      .map<TopObjectEntry>((node) => ({
        id: node.id,
        apiName: node.apiName,
        inboundReferences: objectCounts.value.get(node.id) ?? 0,
      }))
      .sort(compareRankedDesc<TopObjectEntry>((e) => e.inboundReferences)),
    TOP_RANKINGS_LIMIT,
  );

  const apexClasses = nodesByType.get('ApexClass') ?? [];
  const apexCallCounts = await countEdgesForNodes(
    ctx,
    apexClasses.map((n) => n.id),
    { direction: 'in', edgeTypes: ['callsApex'] },
  );
  if (!apexCallCounts.ok) return err(apexCallCounts.error);
  const topApexClasses = topN(
    apexClasses
      .map<TopApexClassEntry>((node) => ({
        id: node.id,
        apiName: node.apiName,
        inboundCalls: apexCallCounts.value.get(node.id) ?? 0,
      }))
      .sort(compareRankedDesc<TopApexClassEntry>((e) => e.inboundCalls)),
    TOP_RANKINGS_LIMIT,
  );

  const profiles = nodesByType.get('Profile') ?? [];
  const grantCounts = await countEdgesForNodes(
    ctx,
    profiles.map((n) => n.id),
    { direction: 'out', edgeTypes: ['grantedBy'] },
  );
  if (!grantCounts.ok) return err(grantCounts.error);
  const topProfiles = topN(
    profiles
      .map<TopProfileEntry>((node) => ({
        id: node.id,
        apiName: node.apiName,
        grantCount: grantCounts.value.get(node.id) ?? 0,
      }))
      .sort(compareRankedDesc<TopProfileEntry>((e) => e.grantCount)),
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
  let measuredAutomationCount = 0;
  let activeStatusUnknownCount = 0;
  for (const type of AUTOMATION_TYPES_FOR_SUMMARY) {
    const nodes = nodesByType.get(type) ?? [];
    for (const node of nodes) {
      const status = automationActiveStatus(node);
      if (!status.known) {
        activeStatusUnknownCount += 1;
        continue;
      }
      measuredAutomationCount += 1;
      if (status.active) activeAutomationCount += 1;
    }
  }
  const automationSummary: AutomationSummary = {
    workflowRules: automationCount('WorkflowRule'),
    approvalProcesses: automationCount('ApprovalProcess'),
    flows: automationCount('Flow'),
    apexTriggers: automationCount('ApexTrigger'),
    activeRatio:
      measuredAutomationCount === 0
        ? 0
        : activeAutomationCount / measuredAutomationCount,
    activeStatusUnknownCount,
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

  // Coverage honesty (PLAN-v4.0 axis): a 0 in a summary family is only "none"
  // if that family was actually retrieved. Families absent from this org's
  // retrieve manifest report 0 too. A family counts as retrieved when it has
  // ANY nodes (proof it was pulled) OR the manifest's coverage marks it
  // complete; otherwise the tour must NOT assert "0 integration surfaces" /
  // "0 workflow rules" when it never looked. Computed here, ahead of Stage 6,
  // because `legacyDebtIndicators.migrationCandidate` must be gated by the
  // same retrieval facts that gate the `workflowRules` / `vfPages` tallies it
  // is bucketed from — a verdict minted from an unretrieved zero is exactly
  // the typed-absence collapse this axis exists to prevent.
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

  // Stage 6: legacy-debt indicators.
  const workflowRulesCount = componentCounts['WorkflowRule'] ?? 0;
  const approvalProcessesCount = componentCounts['ApprovalProcess'] ?? 0;
  const vfPagesCount = componentCounts['VisualforcePage'] ?? 0;
  const legacyTotal = workflowRulesCount + approvalProcessesCount + vfPagesCount;
  // `legacyTotal` sums a WorkflowRule/ApprovalProcess family and a vfPages
  // family that carry INDEPENDENT retrieval facts (`workflowRulesRetrieved`,
  // `frontendRetrieved`); either one being unretrieved means the sum
  // contains an unverified zero, so the verdict must not bucket it as if
  // every addend were measured.
  const legacyDebtIndicators: LegacyDebtIndicators = {
    workflowRules: workflowRulesCount,
    approvalProcesses: approvalProcessesCount,
    vfPages: vfPagesCount,
    migrationCandidate:
      workflowRulesRetrieved && frontendRetrieved
        ? bucketMigrationCandidate(legacyTotal)
        : 'not-checked',
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
        `"not checked", not "none", and legacyDebtIndicators.migrationCandidate reports ` +
        `'not-checked' rather than bucketing an unretrieved zero.`,
    );
  }
  if (!frontendRetrieved) {
    boundaries.push(
      `Frontend bundles (LightningComponentBundle, AuraDefinitionBundle, ` +
        `VisualforcePage, VisualforceComponent) were not retrieved — the frontend ` +
        `tallies mean "not checked", not "none", and legacyDebtIndicators.migrationCandidate ` +
        `reports 'not-checked' rather than bucketing an unretrieved vfPages zero.`,
    );
  }
  if (automationSummary.activeStatusUnknownCount > 0) {
    boundaries.push(
      `Automation active/inactive status was not extracted for ` +
        `${automationSummary.activeStatusUnknownCount} of ` +
        `${automationSummary.activeStatusUnknownCount + measuredAutomationCount} automation ` +
        `item(s) (those Flow/ApexTrigger/WorkflowRule/ApprovalProcess nodes were imported ` +
        `by a refresh predating status extraction — re-run /sfi-refresh to close it) — ` +
        `activeRatio is computed only over the ${measuredAutomationCount} item(s) with a ` +
        `known status; those ${automationSummary.activeStatusUnknownCount} are NOT assumed ` +
        `active.` +
        (measuredAutomationCount === 0
          ? ` No automation item carried a status at all, so activeRatio reads 0 meaning ` +
            `NOT MEASURED, not "0% active".`
          : ''),
    );
  }
  // Residual full-scan cap (FULL_SCAN_MAX_NODES). False in the normal case now
  // that each type is walked to exhaustion; when it fires, the rankings and
  // activeRatio were computed over a prefix and must say so.
  if (incompleteScanTypes.length > 0) {
    boundaries.push(fullScanTruncationNote(incompleteScanTypes));
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
