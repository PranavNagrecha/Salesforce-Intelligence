/**
 * High-fanout graph enumeration guard (P15-GRAPH-oversize-roster-audit).
 *
 * MCP tools that walk hub nodes (standard-object layouts, Account grantedBy
 * edges, Contact list views, Admin profiles) can exceed the ~45 KB transport
 * ceiling unless they paginate, byte-trim, or hard-cap at the handler. Pagination
 * is per-tool discipline — analysis tools correctly use full `listEdges` while
 * MCP handlers must slice.
 *
 * This module is the audited INVENTORY of those handlers plus static validation
 * shared by the unit test and the harness gate (`check-oversize-enumeration.mjs`).
 * Every inventoried tool must also carry a real-org high-fanout probe in
 * `sf-intelligence-qa/scripts/tool-smoke.mjs` (`HIGH_FANOUT` map).
 */

import type { ToolLike } from './response-consistency.js';

/** How an inventoried tool stays under the MCP byte ceiling. */
export type HighFanoutBoundKind =
  | 'paginated'
  | 'graph-payload-budget'
  | 'handler-capped'
  | 'global-response-budget';

export interface HighFanoutInventoryEntry {
  readonly bound: HighFanoutBoundKind;
  /** Short note for auditors — why this bound applies. */
  readonly note?: string;
}

/**
 * Audited roster of MCP handlers that enumerate graph-derived row/edge lists
 * and can fan out on hub nodes. Keys MUST stay in sync with `HIGH_FANOUT` in
 * `tool-smoke.mjs`. Add a row here when shipping a new graph enumerator.
 */
export const HIGH_FANOUT_INVENTORY: Readonly<
  Record<string, HighFanoutInventoryEntry>
> = Object.freeze({
  // --- Paginated reverse lookups / graph lists (limit/offset/hasMore) ---
  'sfi.list_components': { bound: 'paginated' },
  'sfi.get_edges': { bound: 'paginated', note: 'default limit 200 + byte trim' },
  'sfi.search_components': { bound: 'paginated' },
  'sfi.search_apex_source': { bound: 'paginated' },
  'sfi.search_flow_metadata': { bound: 'paginated' },
  'sfi.find_apex_usages': { bound: 'paginated' },
  'sfi.find_code_usages': { bound: 'paginated' },
  'sfi.find_field_anywhere': { bound: 'paginated' },
  'sfi.find_formula_references': { bound: 'paginated' },
  'sfi.find_semantic_field': { bound: 'paginated' },
  'sfi.find_hardcoded_values': { bound: 'paginated' },
  'sfi.find_hardcoded_values_anywhere': { bound: 'paginated' },
  'sfi.find_clone_patterns': { bound: 'paginated' },
  'sfi.find_dead_code': { bound: 'paginated' },
  'sfi.find_dependency_cycles': { bound: 'paginated' },
  'sfi.effective_permissions': { bound: 'paginated', note: 'Admin unions thousands of grants' },
  'sfi.who_can_run': { bound: 'paginated' },
  'sfi.who_can_access_object': { bound: 'paginated', note: 'Account ~70 granters' },
  'sfi.layout_assignments': { bound: 'paginated', note: 'Account layout ~295 rows' },
  'sfi.list_view_sharing': { bound: 'paginated', note: 'Contact ~146 list views' },
  'sfi.app_access': { bound: 'paginated' },
  'sfi.tab_availability': { bound: 'paginated', note: 'Admin ~59 tabs' },
  'sfi.lightning_pages': { bound: 'paginated' },
  'sfi.lifecycle_process': { bound: 'paginated' },
  'sfi.integration_map': { bound: 'paginated' },
  'sfi.event_subscribers': { bound: 'paginated' },
  'sfi.pii_inventory': { bound: 'paginated' },
  'sfi.changed_since': { bound: 'paginated' },
  'sfi.diff_snapshots': { bound: 'paginated' },
  'sfi.domain_clusters': { bound: 'paginated' },
  'sfi.org_history': { bound: 'paginated' },
  'sfi.unused_components': { bound: 'paginated' },
  'sfi.unused_fields_deep': { bound: 'paginated' },
  'sfi.test_coverage_gaps': { bound: 'paginated' },
  'sfi.governor_limit_risks': { bound: 'paginated' },
  'sfi.process_builder_migration_candidates': { bound: 'paginated' },
  'sfi.empty_queues_and_groups': { bound: 'paginated' },
  'sfi.unassigned_permission_sets': { bound: 'paginated' },
  'sfi.crud_fls_audit': { bound: 'paginated' },
  'sfi.what_if_merge_profiles': { bound: 'paginated', note: 'Admin merge page-500 repro' },
  'sfi.what_if_split_profile': { bound: 'paginated' },
  'sfi.user_ability': { bound: 'paginated' },
  'sfi.apex_test_coverage': { bound: 'paginated' },
  'sfi.fleet_find': { bound: 'paginated' },
  'sfi.cpq_dependency_map': { bound: 'paginated' },
  // --- BFS traversals: hop/node/edge caps + graph-payload byte budget ---
  'sfi.get_subgraph': { bound: 'graph-payload-budget', note: 'hops + 200 nodes / 400 edges + byte trim' },
  'sfi.get_impact': { bound: 'graph-payload-budget', note: 'incoming-only BFS + same caps' },
  // --- Handler-internal hard caps (no caller limit knob) ---
  'sfi.scheduled_job_catalog': { bound: 'handler-capped', note: '500-class ceiling' },
  'sfi.outbound_message_catalog': { bound: 'handler-capped', note: '500-entry ceiling' },
  'sfi.endpoint_catalog': { bound: 'handler-capped', note: '500/category ceiling' },
  // --- Global jsonResult budget + high-fanout smoke required ---
  'sfi.get_component': { bound: 'global-response-budget', note: 'Profile:Admin slim path' },
  'sfi.object_access_audit': { bound: 'global-response-budget' },
  'sfi.field_access_audit': { bound: 'global-response-budget' },
  'sfi.recordtype_availability': { bound: 'global-response-budget' },
  'sfi.order_of_execution': { bound: 'global-response-budget' },
  'sfi.what_happens_on_save': { bound: 'global-response-budget' },
  'sfi.explain_field': { bound: 'global-response-budget' },
  'sfi.find_component_usages': { bound: 'global-response-budget' },
  'sfi.generate_data_dictionary': { bound: 'global-response-budget' },
  'sfi.generate_sharing_summary': { bound: 'global-response-budget' },
});

/**
 * Tools with a `limit` input that are NOT high-fanout graph enumerators —
 * live-plane tools, meta catalogs, org reports. A NEW limit tool outside both
 * sets is treated as a missing inventory entry.
 */
export const LIMIT_TOOL_EXCLUSIONS: ReadonlySet<string> = new Set([
  'sfi.resolve',
  'sfi.list_analyses',
  'sfi.component_history',
  'sfi.disambiguate_concepts',
  'sfi.field_cleanup_candidates',
  'sfi.package_impact',
  'sfi.org_pulse',
  'sfi.org_risk_report',
  'sfi.automation_risk_report',
  'sfi.permission_risk_report',
  'sfi.release_readiness_report',
  'sfi.code_quality_audit',
  'sfi.live_duplicate_check',
  'sfi.live_email_template_usage',
  'sfi.live_folder_access',
  'sfi.live_group_count',
  'sfi.live_inactive_users',
  'sfi.live_license_usage',
  'sfi.live_owner_breakdown',
  'sfi.live_picklist_usage',
  'sfi.live_recent_activity',
  'sfi.live_report_usage',
  'sfi.live_sample',
  'sfi.live_stale_records',
  'sfi.live_storage_by_object',
]);

export interface OversizeEnumerationViolation {
  readonly tool: string;
  readonly message: string;
}

export interface OversizeEnumerationReport {
  readonly inventorySize: number;
  readonly violations: readonly OversizeEnumerationViolation[];
}

const hasLimitProperty = (tool: ToolLike): boolean =>
  tool.inputSchema?.properties?.limit !== undefined;

const isLiveTool = (name: string): boolean => name.startsWith('sfi.live_');

/**
 * Validate the audited inventory against declared schemas and probe coverage.
 *
 * @param tools - the product roster (`V01_TOOLS`)
 * @param highFanoutProbes - tool names with a real-org high-fanout entry in tool-smoke
 */
export const analyzeOversizeEnumeration = (
  tools: readonly ToolLike[],
  highFanoutProbes: ReadonlySet<string>,
): OversizeEnumerationReport => {
  const roster = new Map(tools.map((t) => [t.name, t]));
  const violations: OversizeEnumerationViolation[] = [];

  for (const [name, entry] of Object.entries(HIGH_FANOUT_INVENTORY)) {
    const tool = roster.get(name);
    if (!tool) {
      violations.push({
        tool: name,
        message: `${name} is in HIGH_FANOUT_INVENTORY but missing from V01_TOOLS.`,
      });
      continue;
    }
    if (entry.bound === 'paginated' && !hasLimitProperty(tool)) {
      violations.push({
        tool: name,
        message:
          `${name} is inventoried as paginated but its inputSchema lacks a \`limit\` property.`,
      });
    }
    if (
      (entry.bound === 'graph-payload-budget' || entry.bound === 'handler-capped') &&
      hasLimitProperty(tool)
    ) {
      // Having limit is fine; bound tag is what we audit.
    }
    if (!highFanoutProbes.has(name)) {
      violations.push({
        tool: name,
        message:
          `${name} is in HIGH_FANOUT_INVENTORY but has no real-org high-fanout probe in tool-smoke HIGH_FANOUT.`,
      });
    }
  }

  for (const tool of tools) {
    if (!hasLimitProperty(tool) || isLiveTool(tool.name)) continue;
    if (LIMIT_TOOL_EXCLUSIONS.has(tool.name)) continue;
    if (tool.name in HIGH_FANOUT_INVENTORY) continue;
    violations.push({
      tool: tool.name,
      message:
        `${tool.name} declares \`limit\` but is not in HIGH_FANOUT_INVENTORY (and not in LIMIT_TOOL_EXCLUSIONS). ` +
        `Add it to oversize-enumeration.ts + tool-smoke HIGH_FANOUT when it enumerates graph-derived rows.`,
    });
  }

  return { inventorySize: Object.keys(HIGH_FANOUT_INVENTORY).length, violations };
};
