/**
 * The metadata types the vault-staleness check compares against the vault's
 * `refreshedAt`, and the prose renderings of that set.
 *
 * WHY ITS OWN MODULE (and why it must stay import-free): the roster's MCP tool
 * DESCRIPTIONS have to name these types — that is the whole point of
 * STALE-CHECK-DESCRIPTION-UNDERSTATES-COVERAGE, where hand-listed descriptions
 * named 6 of the 15 and rotted. But `roster.ts` cannot reach into
 * `tools/live-plane.ts` to get them: that file is the live plane's
 * consent/session SEAM, and because the live plane goes ambient once an org
 * holds standing consent, a value-import edge from the roster would give every
 * non-live tool that imports the roster transitive reach into it
 * (`plane-import-guard.test.ts` catches exactly this, and did).
 *
 * So the constant lives here, in a leaf with ZERO imports of its own. Both the
 * seam (`live-plane.ts`, which re-exports it for its existing consumers) and
 * the description surface read the same tuple, and neither pulls the other in.
 */

/**
 * The Tooling-API-queryable types the staleness check compares against the
 * vault's `refreshedAt`. All carry a `LastModifiedDate`. A type the org's
 * Tooling API rejects (rare) is skipped into `erroredTypes` rather than
 * failing the whole check.
 *
 * Shared so the fleet drift sweep (`fleet_drift_ranking`) runs the SAME set of
 * checks per org as `live_stale_check` does for one org, without drift.
 */
export const STALE_CHECK_TYPES = [
  'ApexClass',
  'ApexTrigger',
  'ValidationRule',
  'Layout',
  'Flow',
  'CustomField',
  // P13-WATCH-sweep widening — closes the permission-drift hole (a Profile or
  // PermissionSet edited in the org silently invalidated access answers) and
  // covers the UI/record-type surfaces. A type the org's Tooling API rejects
  // lands in erroredTypes honestly, never fatal.
  'CustomObject',
  'Profile',
  'PermissionSet',
  'PermissionSetGroup',
  'SharingRules',
  'FlexiPage',
  'RecordType',
  'CustomApplication',
  'CustomTab',
] as const;

/**
 * The {@link STALE_CHECK_TYPES} set rendered for prose — the SINGLE source every
 * human-facing surface (MCP tool descriptions, JSDoc, the runtime
 * `boundaries[]`) interpolates so none of them can under-report the set again.
 *
 * STALE-CHECK-DESCRIPTION-UNDERSTATES-COVERAGE: the roster descriptions for
 * `sfi.live_stale_check` and `sfi.fleet_drift_ranking`, and
 * `fleet-drift-ranking`'s own response disclosure, all hand-listed the SIX
 * original types and were never updated when the widening added the other
 * nine. The nine omitted ones are precisely the permission / security drift
 * families (Profile, PermissionSet, PermissionSetGroup, SharingRules) plus the
 * UI / record-type surfaces — the highest-value half of the check — so a host
 * reading the description would not know a Profile edit is detected.
 * Hand-listing is what let that drift happen; interpolation is what stops it.
 */
export const STALE_CHECK_TYPE_LIST = STALE_CHECK_TYPES.join(', ');

/** How many types {@link STALE_CHECK_TYPES} covers, for prose that counts them. */
export const STALE_CHECK_TYPE_COUNT = STALE_CHECK_TYPES.length;
