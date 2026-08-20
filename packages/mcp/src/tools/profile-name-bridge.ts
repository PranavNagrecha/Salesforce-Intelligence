/**
 * PLATFORM-ACCESS-ORACLE — the profile LABEL -> API-name bridge. ONE seam.
 *
 * ## Why this module exists at all
 *
 * SOQL exposes `User.Profile.Name`, the profile's LABEL. Every offline surface
 * keys Profile nodes by the metadata API name. Anything that starts from a live
 * user and needs that user's OFFLINE profile container has to cross that gap,
 * and there is no SOQL field that crosses it.
 *
 * The current crossing is a map built at `sfi refresh` (see
 * `@sf-intelligence/vault`'s `profile-name-map.ts`): `sf org list metadata -m
 * Profile` gives `{ id, fullName }`, `SELECT Id, Name FROM Profile` gives
 * `{ Id, Name }`, joined on the 15-char Id.
 *
 * **That mechanism is under independent verification and is NOT settled.** It
 * is therefore isolated behind this single function. Callers know only
 * "give me a label, get an API name or a refusal" — they never load the
 * artifact, never see its shape, and never implement a fallback. If
 * verification refutes the join, this module changes and no tool does.
 *
 * ## What the caller is guaranteed
 *
 * Exactly two outcomes: a resolved API name **backed by evidence**, or an
 * `McpError` that names the cause and the remedy. There is no third, quieter
 * outcome — in particular there is NO name-match fallback.
 *
 * ## The key is ProfileId, never the label
 *
 * An earlier revision of this bridge resolved on `User.Profile.Name`. That was
 * wrong, and not subtly: labels are MUTABLE and RE-USABLE. Rename a profile
 * between two refreshes, or free a label and re-apply it to a different
 * profile, and a label-keyed lookup silently resolves to the WRONG profile —
 * so the oracle would diff the user against a container bundle that is not
 * theirs and report the mismatch as a permission finding. A confidently wrong
 * answer on a security question is the worst failure this product can produce,
 * and it is indistinguishable from a real one.
 *
 * `User.ProfileId` is stable, always populated, and free: `resolveUser` already
 * traverses `Profile.Name`, so the id costs no extra query and no extra join.
 *
 * The label survives ONLY as (a) a human-readable echo, and (b) a cross-check:
 * when the label recorded in the map differs from the live one, the profile was
 * renamed since the last refresh, and that is surfaced as a DISCLOSURE. It is
 * never a resolution key and never a refusal.
 *
 * ## Failure modes, all fail-CLOSED
 *
 *   - `map-absent` — the vault has no artifact (never refreshed with an org
 *     connection, or refresh's best-effort build failed). NOT the same as a map
 *     with zero entries, and never treated as one.
 *   - `no-profile-id` — the live org returned no ProfileId for the user.
 *   - `not-in-map` — the id is unknown: profile newer than the last refresh, or
 *     one of the disclosed join gaps (`onlyInMetadata` / `onlyInSoql` /
 *     `unjoinable` / `collidingIds`).
 *
 * Every one of them returns `invalid-query` naming `profileId` as the escape
 * hatch, which bypasses this bridge entirely and always works.
 */

import type { McpError } from '@sf-intelligence/contracts';
import {
  loadProfileNameMap,
  profileId15,
  resolveProfileApiNameById,
  type ProfileNameMapFile,
} from '@sf-intelligence/vault';

/**
 * Evidence for a resolution that SUCCEEDED. Its presence in a tool response is
 * the proof a bridge was actually crossed — a caller-supplied container carries
 * `null` instead, so the two are never confused.
 */
export interface ProfileResolution {
  /** The live `Profile.Name` — a LABEL. Echo only; never the resolution key. */
  readonly label: string;
  /** The 15-char ProfileId the resolution was actually keyed on. */
  readonly profileId15: string;
  /**
   * The label the map recorded when it was BUILT. When this differs from
   * `label` the profile was renamed since the last refresh — harmless here
   * (the id still resolves), and precisely the case that would have silently
   * mis-resolved under the old label-keyed design.
   */
  readonly mappedLabel: string;
  /** True when `label !== mappedLabel`. Surfaced, not suppressed. */
  readonly labelChangedSinceRefresh: boolean;
  /** The metadata API name the vault keys the Profile node by. */
  readonly apiName: string;
  /** Which mechanism answered. Named so a future swap is visible in output. */
  readonly source: 'vault-profile-name-map';
  /** When the map was built — a stale map is still a map, but say how old. */
  readonly mapBuiltAt: string;
  readonly mapEntries: number;
  /**
   * Profiles the build could not join: present in only one source, carrying no
   * Id, or colliding on one. Non-zero does NOT invalidate this resolution — it
   * means OTHER profiles are unresolvable, which is why it rides along.
   */
  readonly mapGaps: number;
}

export type ProfileBridgeOutcome =
  | { readonly ok: true; readonly apiName: string; readonly resolution: ProfileResolution }
  | { readonly ok: false; readonly error: McpError };

/** Every disclosed reason a profile did not make it into `entries`. */
const gapCount = (map: ProfileNameMapFile): number =>
  map.onlyInMetadata.length +
  map.onlyInSoql.length +
  map.unjoinable.metadata.length +
  map.unjoinable.soql.length +
  map.collidingIds.length;

const refuse = (message: string): ProfileBridgeOutcome => ({
  ok: false,
  error: { kind: 'invalid-query', message, path: 'profileId' },
});

/**
 * Cross the ProfileId -> API-name gap, or refuse with an actionable reason.
 *
 * @example
 *   const bridged = await bridgeProfileToApiName(ctx.vaultRoot, user.profileId, user.profileName);
 *   if (!bridged.ok) return err(bridged.error);   // never a fallback
 *   containers.push(`Profile:${bridged.apiName}`);
 */
export const bridgeProfileToApiName = async (
  vaultRoot: string,
  profileId: string | null | undefined,
  label: string | null,
): Promise<ProfileBridgeOutcome> => {
  const map = await loadProfileNameMap(vaultRoot);

  if (map === null) {
    return refuse(
      "Cannot resolve this user's profile to a vault Profile node: this vault has no Profile " +
        'Id<->API-name map. SOQL exposes a ProfileId and a mutable LABEL, while the vault keys ' +
        'profiles by metadata API name, and nothing crosses that gap without the map. Run ' +
        '`sfi refresh` (with an org connection) to build it, or pass `profileId` explicitly. ' +
        'Refusing to guess by name: profile labels are mutable and re-usable, so a name-match ' +
        'can silently resolve to a DIFFERENT profile and diff the user against a container ' +
        'bundle that is not theirs.',
    );
  }

  const key = profileId15(profileId);
  if (key === null) {
    return refuse(
      'The live org returned no usable ProfileId for this user, so the offline Profile container ' +
        'cannot be resolved. Pass `profileId` explicitly. Refusing to fall back to the profile ' +
        'label: labels are mutable and re-usable, and a wrong profile silently computes a ' +
        'different set of permissions.',
    );
  }

  const resolved = resolveProfileApiNameById(map, key);
  if (!resolved.ok) {
    const gaps = gapCount(map);
    return refuse(
      "This user's ProfileId is not in this vault's Profile Id<->API-name map " +
        `(built ${map.builtAt}, ${map.entries.length} profile(s) joined` +
        (gaps > 0 ? `, ${gaps} disclosed gap(s)` : '') +
        '). The profile was likely created after the last refresh, or it is one of those gaps ' +
        '(present in only one org source, carrying no Id from `listMetadata`, or colliding on ' +
        'one). Re-run `sfi refresh`, or pass `profileId` explicitly. Refusing to fall back to ' +
        'the profile label.',
    );
  }

  const liveLabel = label ?? '';
  return {
    ok: true,
    apiName: resolved.apiName,
    resolution: {
      label: liveLabel,
      profileId15: key,
      mappedLabel: resolved.mappedLabel,
      labelChangedSinceRefresh:
        liveLabel.length > 0 && liveLabel.trim() !== resolved.mappedLabel.trim(),
      apiName: resolved.apiName,
      source: 'vault-profile-name-map',
      mapBuiltAt: map.builtAt,
      mapEntries: map.entries.length,
      mapGaps: gapCount(map),
    },
  };
};
