/**
 * INFRA-12-DEEP — structural live-plane capability tokens.
 *
 * Standing consent (`hasLiveConsent` / ambient `~/.sf-intelligence/live-consent.json`)
 * is a blanket per-org grant. Without a registry-level capability, any handler that
 * reaches `resolveLiveAccess` can silently spend Salesforce API budget once consent
 * exists — including offline-nominal composites that only import a live helper.
 *
 * Every tool is tagged `livePlane: 'never' | 'opt-in' | 'primary'` in the registry.
 * At dispatch, the tag is minted into an opaque {@link LiveCapability} and threaded
 * on {@link Context}. `resolveLiveAccess` / `gateLive` refuse ambient consent (and
 * every other live path) unless that token is present. Composed sub-handlers inherit
 * the *top-level* tool's capability — they cannot mint their own.
 */

/** Registry tag: whether the tool may consult the live plane at all. */
export type LivePlaneTag = 'never' | 'opt-in' | 'primary';

/**
 * Opaque capability token. Only {@link mintLiveCapability} creates one, and only
 * from a registry `livePlane` tag of `opt-in` or `primary`. A `never` tool gets
 * `undefined` — which fail-closes every live gate.
 */
export type LiveCapability = {
  readonly __brand: 'LiveCapability';
  readonly tag: 'opt-in' | 'primary';
};

/**
 * Mint a capability from a registry tag. `never` → `undefined` (fail-closed).
 * Exported so unit tests that call handlers *without* going through
 * `dispatchTool` can attach the same token the dispatcher would.
 */
export function mintLiveCapability(tag: 'never'): undefined;
export function mintLiveCapability(tag: 'opt-in' | 'primary'): LiveCapability;
export function mintLiveCapability(tag: LivePlaneTag): LiveCapability | undefined;
export function mintLiveCapability(tag: LivePlaneTag): LiveCapability | undefined {
  if (tag === 'never') return undefined;
  return Object.freeze({ __brand: 'LiveCapability' as const, tag });
}

/**
 * Tools that may optionally enrich with live reads (explicit `liveEnabled`, env,
 * or standing consent) but are not live-primary. Audited INFRA-12-DEEP:
 *
 *   - coverage_report — reports consent *status* only (no live query); must be
 *     declared so the status read is intentional, not ambient leakage.
 *   - unused_fields_deep / field_cleanup_candidates — hybrid by design.
 *   - what_if_make_field_required / safe_to_delete_field — optional live
 *     population cross-check.
 *   - field_change_advisor — composes the two field tools above; inherits their
 *     live enrichment when *it* is the top-level invoke.
 *
 * Composites that only *transitively* reached the seam (health_check,
 * tech_debt_score, synthesis risk reports) stay `never` — that is the fix for
 * the ambient-consent composition bug.
 */
export const LIVE_PLANE_OPT_IN_TOOLS: ReadonlySet<string> = new Set([
  'sfi.coverage_report',
  'sfi.unused_fields_deep',
  'sfi.field_cleanup_candidates',
  'sfi.what_if_make_field_required',
  'sfi.safe_to_delete_field',
  'sfi.field_change_advisor',
]);

/**
 * Non-`live_*` tools whose *primary* job is a live org read (plane `live` in
 * the semantic funnel). Same capability class as `sfi.live_*`.
 */
export const LIVE_PLANE_PRIMARY_EXTRA_TOOLS: ReadonlySet<string> = new Set([
  'sfi.blast_radius_live',
  'sfi.fleet_drift_ranking',
]);

/** Derive the registry `livePlane` tag for a tool name. */
export const livePlaneForTool = (name: string): LivePlaneTag => {
  if (name.startsWith('sfi.live_') || LIVE_PLANE_PRIMARY_EXTRA_TOOLS.has(name)) {
    return 'primary';
  }
  if (LIVE_PLANE_OPT_IN_TOOLS.has(name)) return 'opt-in';
  return 'never';
};
