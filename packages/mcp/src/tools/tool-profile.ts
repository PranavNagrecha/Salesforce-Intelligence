/**
 * Tool-profile primitives: which tools a host sees in `tools/list` and may
 * call directly under the default `core` profile.
 *
 * Own module so both `tools/index.ts` (roster advertising + direct-call gate)
 * and `tools/route-question.ts` (gateway envelopes under core) can import them
 * without a module cycle. `tools/index.ts` re-exports for the public API.
 *
 * The core roster is DERIVED, never hand-listed: the spine (what a host needs
 * to find its way to anything else) plus every tool that answers a question
 * the npm package page advertises. A test pins each advertised question to the
 * published page, so advertising a question with no tool behind it, or a tool
 * for a question the page does not make, fails the build rather than the user.
 *
 * 0.5.0 (V5-1): the 16-schema core roster. The previous 25 included routing,
 * synthesis, catalog and orientation helpers that a host model does not need
 * in front of it, while the three tools an external reviewer verified on a
 * real org (where-used, dead code, flow graph) were not directly callable at
 * all. Everything not listed here stays reachable through `sfi.run_analysis`
 * with byte-identical output.
 */

import type { McpError } from '@sf-intelligence/contracts';

/**
 * The SPINE: resolution, lookup, the universal read, freshness, the catalog
 * gateway, and live-consent (the tool that turns the live plane on must not
 * sit behind the gateway). Chosen by ROLE, not by popularity.
 */
const SPINE_TOOLS = [
  'sfi.resolve',
  'sfi.search_components',
  'sfi.get_component',
  'sfi.health_check',
  'sfi.list_analyses',
  'sfi.describe_analysis',
  'sfi.run_analysis',
  'sfi.live_consent',
] as const;

/**
 * The questions this product ADVERTISES on the npm package page, each paired
 * with the one tool that answers it. Adding a question here advertises its
 * tool; there is no second list to keep in step. Every question must appear
 * verbatim in `packages/cli/README.md` (a test checks).
 */
export const ADVERTISED_QUESTION_TOOLS: ReadonlyMap<string, readonly string[]> =
  new Map([
    ['what fields does Account have?', ['sfi.get_component']],
    ['where is this field used?', ['sfi.find_component_usages']],
    ['what breaks if I delete this field?', ['sfi.safe_to_delete_field']],
    ['what happens when I save a Project?', ['sfi.what_happens_on_save']],
    ['which Apex is dead?', ['sfi.find_dead_code']],
    ["why can't this profile see Opportunities?", ['sfi.why_cant_user_see_record']],
    ['who can edit Salary__c?', ['sfi.effective_permissions']],
    ['how does this flow work?', ['sfi.flow_graph']],
    ['give me a tour of this org', ['sfi.org_overview']],
  ]);

/**
 * The CORE roster: the spine plus every tool that answers an advertised
 * question. Selected by `SFI_TOOL_PROFILE=core` (also the default).
 */
export const CORE_PROFILE_TOOLS: ReadonlySet<string> = new Set([
  ...SPINE_TOOLS,
  ...[...ADVERTISED_QUESTION_TOOLS.values()].flat(),
]);

/**
 * Tool profile from `SFI_TOOL_PROFILE`.
 *
 * Default is `core`. Opt into the full roster with `SFI_TOOL_PROFILE=full`
 * (the ONLY value that selects it). Any other value (`minimal`, `lean`, a
 * typo) falls back to `core` with a one-time stderr warning: a user who tries
 * to SHRINK the roster must never silently get the largest one.
 */
export const toolProfile = (): 'core' | 'full' => {
  const raw = process.env['SFI_TOOL_PROFILE']?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'core';
  if (raw === 'core') return 'core';
  if (raw === 'full') return 'full';
  warnUnknownProfileOnce(raw);
  return 'core';
};

const warnedProfiles = new Set<string>();
const warnUnknownProfileOnce = (raw: string): void => {
  if (warnedProfiles.has(raw)) return;
  warnedProfiles.add(raw);
  process.stderr.write(
    `[sfi] SFI_TOOL_PROFILE='${raw}' is not a known profile (valid: core, full); using 'core'.\n`,
  );
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
