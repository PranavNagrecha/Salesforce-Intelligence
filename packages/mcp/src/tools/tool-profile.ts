/**
 * Tool-profile primitives (P13-GW-profiles / P13-GW-router-envelope), in
 * their own module so both `tools/index.ts` (roster advertising) and
 * `tools/route-question.ts` (gateway envelopes under core) can import them
 * without a module cycle. `tools/index.ts` re-exports both for the public
 * API surface.
 */

/**
 * The ~18-schema CORE roster — orientation, resolution, routing, the
 * universal graph reads, and the catalog gateway through which everything
 * else stays reachable. Selected by `SFI_TOOL_PROFILE=core`.
 */
export const CORE_PROFILE_TOOLS: ReadonlySet<string> = new Set([
  'sfi.resolve',
  'sfi.search_components',
  'sfi.get_component',
  'sfi.list_components',
  'sfi.get_edges',
  'sfi.get_impact',
  'sfi.effective_permissions',
  'sfi.order_of_execution',
  'sfi.org_history',
  'sfi.health_check',
  'sfi.org_card',
  'sfi.route_question',
  'sfi.synthesize_answer',
  'sfi.capabilities',
  'sfi.guidance',
  'sfi.list_analyses',
  'sfi.describe_analysis',
  'sfi.run_analysis',
]);

/**
 * Tool profile, read from `SFI_TOOL_PROFILE` (`core` | anything-else=`full`).
 * Resolved ONCE at registration (server boot): MCP clients fetch tools/list
 * a single time and `list_changed` support is uneven, so the advertised
 * roster is NEVER changed dynamically. Default `full` — zero behavior change.
 */
export const toolProfile = (): 'core' | 'full' =>
  process.env['SFI_TOOL_PROFILE'] === 'core' ? 'core' : 'full';
