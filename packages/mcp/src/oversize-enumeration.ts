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
  // --- Truly paginated: a `limit` page PLUS a resume knob (offset or CR-22
  //     cursor) so the dropped tail is reachable. The strengthened `paginated`
  //     audit requires this; a top-N truncator with no resume is classified
  //     `handler-capped` below instead. CR-22 added an opaque `cursor` to the
  //     B1 batch (get_edges, find_apex_usages, find_formula_references,
  //     pii_inventory, crud_fls_audit, test_coverage_gaps). ---
  'sfi.list_components': { bound: 'paginated' },
  'sfi.get_edges': { bound: 'paginated', note: 'default limit 200 + byte trim + CR-22 cursor' },
  'sfi.find_apex_usages': { bound: 'paginated', note: 'offset + CR-22 cursor' },
  'sfi.find_formula_references': { bound: 'paginated', note: 'offset + CR-22 cursor' },
  'sfi.effective_permissions': { bound: 'paginated', note: 'Admin unions thousands of grants' },
  'sfi.who_can_run': { bound: 'paginated' },
  'sfi.who_can_access_object': { bound: 'paginated', note: 'Account ~70 granters' },
  'sfi.layout_assignments': { bound: 'paginated', note: 'Account layout ~295 rows' },
  'sfi.list_view_sharing': { bound: 'paginated', note: 'Contact ~146 list views' },
  'sfi.app_access': { bound: 'paginated' },
  'sfi.tab_availability': { bound: 'paginated', note: 'Admin ~59 tabs' },
  'sfi.lightning_pages': { bound: 'paginated' },
  'sfi.lifecycle_process': { bound: 'paginated' },
  'sfi.pii_inventory': { bound: 'paginated', note: 'offset + byte trim + CR-22 cursor' },
  'sfi.test_coverage_gaps': { bound: 'paginated', note: 'offset + byte trim + CR-22 cursor' },
  'sfi.crud_fls_audit': { bound: 'paginated', note: 'offset + byte trim + CR-22 cursor' },
  'sfi.what_if_merge_profiles': { bound: 'paginated', note: 'Admin merge page-500 repro' },
  'sfi.what_if_split_profile': { bound: 'paginated' },
  'sfi.user_ability': { bound: 'paginated' },
  // --- Top-N truncators: a `limit` caps the result but there is NO resume
  //     (no offset/cursor to fetch the dropped tail). Tagged `handler-capped`
  //     so the strengthened `paginated` audit (which requires a resume knob)
  //     does not falsely pass them. Convert to a real cursor to promote back.
  //     CR-22: the B0 audit-strengthening surfaced these as mislabeled (they
  //     were tagged `paginated` but expose only `limit`); reclassified here so
  //     the real-schema gate passes truthfully. ---
  'sfi.search_components': { bound: 'handler-capped', note: 'top-N truncator, limit caps but no resume (CR-22)' },
  'sfi.search_apex_source': { bound: 'handler-capped', note: 'top-N truncator, limit caps but no resume (CR-22)' },
  'sfi.search_flow_metadata': { bound: 'handler-capped', note: 'top-N truncator, limit caps but no resume (CR-22)' },
  'sfi.find_code_usages': { bound: 'paginated', note: 'offset + CR-22 cursor' },
  'sfi.find_field_anywhere': { bound: 'paginated', note: 'nested-section cursor: pages one ComponentType bucket + discloses the rest, rolls forward (CR-22)' },
  'sfi.find_semantic_field': { bound: 'paginated', note: 'top-N slice + CR-22 cursor' },
  'sfi.find_hardcoded_values': { bound: 'paginated', note: 'limit + offset + CR-22 cursor; B3 full-type scan windows past 500' },
  'sfi.find_hardcoded_values_anywhere': { bound: 'paginated', note: 'offset + CR-22 cursor' },
  'sfi.find_clone_patterns': { bound: 'handler-capped', note: 'top-N truncator, limit caps but no resume (CR-22)' },
  'sfi.integration_map': { bound: 'handler-capped', note: 'top-N truncator, limit caps but no resume (CR-22)' },
  'sfi.event_subscribers': { bound: 'handler-capped', note: 'top-N truncator, limit caps but no resume (CR-22)' },
  'sfi.diff_snapshots': { bound: 'paginated', note: 'section cursor: pages the largest of added/removed/modified + discloses the others (CR-22)' },
  'sfi.domain_clusters': { bound: 'paginated', note: 'per-cluster member section cursor + cluster-count byte budget + CR-RV12 candidateTruncated (CR-22)' },
  'sfi.org_history': { bound: 'handler-capped', note: 'top-N truncator, limit caps but no resume (CR-22)' },
  'sfi.unused_components': { bound: 'paginated', note: 'offset + CR-22 cursor' },
  'sfi.unused_fields_deep': { bound: 'paginated', note: 'offset + byte trim + CR-22 cursor' },
  'sfi.governor_limit_risks': { bound: 'paginated', note: 'limit + offset + CR-22 cursor; B3 full-type scan windows past 500' },
  'sfi.code_quality_audit': { bound: 'paginated', note: 'limit + offset + CR-22 cursor; B3 full-type scan windows past 500' },
  'sfi.process_builder_migration_candidates': { bound: 'paginated', note: 'section cursor: pages the largest of 3 lists + discloses the others + CR-RV12 scanTruncated (CR-22)' },
  'sfi.empty_queues_and_groups': { bound: 'paginated', note: 'section cursor: pages queues|groups + discloses the other + CR-RV12 scanTruncated (CR-22)' },
  'sfi.unassigned_permission_sets': { bound: 'paginated', note: 'section cursor: pages the populated list + discloses the other + CR-RV12 scanTruncated (CR-22)' },
  'sfi.apex_test_coverage': { bound: 'paginated', note: 'offset + CR-22 cursor (org-wide mode)' },
  'sfi.fleet_find': { bound: 'handler-capped', note: 'top-N truncator, limit caps but no resume (CR-22)' },
  'sfi.find_dead_code': { bound: 'paginated', note: 'offset + CR-22 cursor' },
  'sfi.changed_since': { bound: 'paginated', note: 'offset + CR-22 cursor + full type scan' },
  'sfi.find_dependency_cycles': { bound: 'paginated', note: 'offset + CR-22 cursor + full Apex scan' },
  'sfi.cpq_dependency_map': { bound: 'paginated', note: 'offset + CR-22 cursor + full CPQ scan' },
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
  // CR-22 B5: value_change_audit gained a limit+cursor; it is a per-field
  // impact/what-if report (bounded value-coupling rows, capped at MAX_ROWS),
  // not a raw node-type enumeration — excluded from the high-fanout probe
  // requirement like code_quality_audit / the risk-report family.
  'sfi.value_change_audit',
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

/**
 * A `paginated` tool must let the caller fetch the DROPPED tail — a `limit`
 * alone is a top-N truncator, not real pagination. The resume knob is either
 * classic `offset` or a CR-22 continuation `cursor`. A tool with `limit` but no
 * resume knob belongs under `handler-capped`, not `paginated`.
 */
const hasResumeKnob = (tool: ToolLike): boolean =>
  tool.inputSchema?.properties?.offset !== undefined ||
  tool.inputSchema?.properties?.cursor !== undefined;

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
    // Strengthened CR-22 audit: `paginated` MUST also expose a resume knob
    // (`offset` or `cursor`), else it is a top-N truncator and should be
    // tagged `handler-capped` (so the dropped tail isn't silently unreachable).
    if (
      entry.bound === 'paginated' &&
      hasLimitProperty(tool) &&
      !hasResumeKnob(tool)
    ) {
      violations.push({
        tool: name,
        message:
          `${name} is inventoried as paginated but has no resume knob (\`offset\` or \`cursor\`) — ` +
          `a \`limit\` alone is a top-N truncator with no way to fetch the dropped tail. ` +
          `Add a cursor (CR-22) or reclassify as \`handler-capped\`.`,
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
