/**
 * Tool-profile primitives (P13-GW-profiles / P13-GW-router-envelope / AUDIT-F6).
 *
 * Own module so both `tools/index.ts` (roster advertising + direct-call gate)
 * and `tools/route-question.ts` (gateway envelopes under core) can import them
 * without a module cycle. `tools/index.ts` re-exports for the public API.
 */

import type { McpError } from '@sf-intelligence/contracts';

/**
 * The SPINE — orientation, resolution, routing, the universal graph reads, the
 * catalog gateway, and live-consent (the tool that turns the live plane on must
 * not sit behind the gateway).
 *
 * This half is chosen by ROLE: every entry is something a host needs in order
 * to find its way to anything else. It is not the whole core roster — see
 * {@link ADVERTISED_QUESTION_TOOLS} for the half that is DERIVED.
 */
const SPINE_TOOLS = [
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
  // Consent must be directly invokable under core — otherwise the feature that
  // enables live tools is unreachable without already knowing the gateway.
  'sfi.live_consent',
] as const;

/**
 * The questions this product ADVERTISES, paired with the tools that answer them.
 *
 * ## Why this exists
 *
 * The default profile advertised 19 of 217 tools, and the ones it hid included
 * the tools that answer the questions the npm package page invites the reader
 * to ask. Measured before this change:
 *
 *   "what breaks if I delete this field?"    safe_to_delete_field   HIDDEN
 *   "who can edit Salary__c?"                who_can_access_object  HIDDEN
 *                                            field_access_audit     HIDDEN
 *   "why can't this profile see …?"          why_cant_user_see_record HIDDEN
 *   "what happens when I save a Project?"    what_happens_on_save   HIDDEN
 *   "give me a tour of this org"             org_overview           HIDDEN
 *
 * A schema-driven host reads `tools/list` and will not invent
 * `sfi.run_analysis`. So the product answered its own advertised questions only
 * for a caller who already knew the gateway existed — which a first-time user
 * is exactly not.
 *
 * ## Why it is a MAP and not a longer list
 *
 * A hand-picked "better 30" is the same failure mode as the hand-picked 19: it
 * drifts the moment the docs change, and nothing tells you. Pairing each tool
 * with the QUESTION that earns its place makes the roster derived — and lets a
 * test assert the pairing against the published page, so advertising a new
 * question with no tool behind it fails the build rather than the user.
 *
 * ## The token-tax argument, measured
 *
 * Hiding these was a real response to a real cost, but the cost was assumed
 * rather than measured. The full roster is 665 KB across 217 tools; the spine
 * is 67 KB; the median tool is 2.7 KB. These six add 36.5 KB, taking the
 * default from 67 KB to 104 KB — 16% of the full roster, for the six tools the
 * product's own front page promises. A tax worth paying is one that buys the
 * thing being taxed.
 */
export const ADVERTISED_QUESTION_TOOLS: ReadonlyMap<string, readonly string[]> =
  new Map([
    ['what fields does Account have?', ['sfi.list_components', 'sfi.get_component']],
    ['what breaks if I delete this field?', ['sfi.get_impact', 'sfi.safe_to_delete_field']],
    [
      "why can't this profile see Opportunities?",
      ['sfi.why_cant_user_see_record', 'sfi.effective_permissions'],
    ],
    ['who can edit Salary__c?', ['sfi.who_can_access_object', 'sfi.field_access_audit']],
    [
      'what happens when I save a Project?',
      ['sfi.what_happens_on_save', 'sfi.order_of_execution'],
    ],
    ['give me a tour of this org', ['sfi.org_card', 'sfi.org_overview']],
  ]);

/**
 * The CORE roster: the spine, plus every tool that answers a question this
 * product advertises. DERIVED — adding a question to
 * {@link ADVERTISED_QUESTION_TOOLS} advertises its tools, and there is no
 * second list to keep in step.
 *
 * Selected by `SFI_TOOL_PROFILE=core` (also the default).
 */
export const CORE_PROFILE_TOOLS: ReadonlySet<string> = new Set([
  ...SPINE_TOOLS,
  ...[...ADVERTISED_QUESTION_TOOLS.values()].flat(),
]);

/**
 * Tool profile from `SFI_TOOL_PROFILE`.
 *
 * AUDIT-F6: default is `core` — the spine plus the tools that answer the
 * questions this product advertises (see CORE_PROFILE_TOOLS). Deliberately not
 * a hardcoded count: the roster is derived, and a number written here would be
 * a second source of truth that drifts the first time a question is added.
 * Opt into the full roster with `SFI_TOOL_PROFILE=full`. Unknown values fall
 * back to `full` so a typo never produces an empty roster.
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
