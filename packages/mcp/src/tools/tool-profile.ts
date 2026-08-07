/**
 * Tool-profile primitives (P13-GW-profiles / P13-GW-router-envelope / AUDIT-F6).
 *
 * Own module so both `tools/index.ts` (roster advertising + direct-call gate)
 * and `tools/route-question.ts` (gateway envelopes under core) can import them
 * without a module cycle. `tools/index.ts` re-exports for the public API.
 */

import type { McpError } from '@sf-intelligence/contracts';

/**
 * The ~18-schema CORE roster — orientation, resolution, routing, the
 * universal graph reads, and the catalog gateway through which everything
 * else stays reachable. Selected by `SFI_TOOL_PROFILE=core` (also the default).
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
 * Tool profile from `SFI_TOOL_PROFILE`.
 *
 * AUDIT-F6: default is `core` (advertise the 18-tool spine). Opt into the full
 * roster with `SFI_TOOL_PROFILE=full`. Unknown values fall back to `full` so a
 * typo never produces an empty roster.
 */
export const toolProfile = (): 'core' | 'full' => {
  const raw = process.env['SFI_TOOL_PROFILE']?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'core';
  if (raw === 'core') return 'core';
  return 'full';
};

/**
 * Whether a host may `tools/call` this name DIRECTLY under the active profile.
 * Under `core`, only {@link CORE_PROFILE_TOOLS}; under `full`, any registered
 * name (unknowns still fail in dispatch). Gateway `run_analysis` is the path
 * to non-core tools when profile is core — advertise ≠ invokable for direct
 * calls, not a capability kill-switch.
 */
export const isDirectlyInvokable = (
  toolName: string,
  profile: 'core' | 'full' = toolProfile(),
): boolean => {
  if (profile === 'full') return true;
  return CORE_PROFILE_TOOLS.has(toolName);
};

/** Fail-closed denial for a direct CallTool outside the profile allowlist. */
export const directInvokeDeniedError = (toolName: string): McpError => ({
  kind: 'invalid-query',
  message:
    `Tool '${toolName}' is not directly invokable under SFI_TOOL_PROFILE=core. ` +
    `Call sfi.run_analysis { name: '${toolName}', args } after sfi.describe_analysis, ` +
    `or set SFI_TOOL_PROFILE=full to advertise and invoke the full roster.`,
});
