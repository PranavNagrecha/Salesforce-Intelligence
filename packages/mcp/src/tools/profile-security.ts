/**
 * Handler for the `sfi.profile_security` MCP tool.
 *
 * "What are this profile's login and session security policies?" — the login
 * IP ranges, the login-hours weekday windows, and a link to the org-wide
 * MFA / session settings. A focused security-audit surface, separate from
 * `sfi.user_ability` (which answers "what can this container RUN or DO").
 *
 * Profile-only: a `PermissionSet:` id is refused with `invalid-query` because
 * permission sets carry no login security (IP ranges / login hours live on the
 * Profile).
 *
 * Two data planes, both `declared` metadata:
 *   - Profile-scoped: `loginIpRanges` (already extracted into
 *     `properties.loginIpRanges`, previously unsurfaced) + `loginHoursByDay`
 *     (the per-weekday `<loginHours>` windows, extracted into
 *     `properties.loginHours`). ALSO REFRESH-GATED: a Profile node that carries
 *     no `loginIpRanges` property was built before that extractor, so the whole
 *     login axis is `null` + `loginRestrictionsExtracted: false` (disclosed in
 *     `boundaryNote`) — never `[] / 0 / false`, which would read as a verified
 *     "this profile is unrestricted" for a profile locked to a corporate
 *     network.
 *   - Org-wide: `sessionSecuritySettings` from the single `SessionSettings:default`
 *     node (required-MFA, strong-auth, session-timeout). REFRESH-GATED — a vault
 *     built before the SessionSettings type shipped carries no such node, so this
 *     is `null` until a re-refresh pulls it (disclosed in `boundaryNote`).
 *
 * Input: `{ profileId: 'Profile:X' | 'X' }` (a bare apiName is coerced to
 * `Profile:X`). `declared` confidence — all of this is declared metadata.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { familyWasExtracted, notExtractedFamilyDisclosure } from './absence-disclosure.js';
import { coercePrefix } from './coerce-id.js';
import { firstNonEmpty } from './input-aliases.js';
import {
  readLoginHours,
  readLoginIpRanges,
  type LoginHourWindow,
  type LoginIpRange,
} from './user-ability.js';

/** The single org-wide session-security node id (one per org). */
const SESSION_SETTINGS_ID = 'SessionSettings:default' as ComponentId;

const PROFILE_PREFIX = 'Profile:';

/**
 * The property the profile extractor ALWAYS writes when it ran at all.
 *
 * `collectLoginRestrictions` (`packages/extractors/src/profile.ts`) emits
 * `{ loginIpRanges, loginHoursDefined, loginHours }` as one object on every
 * Profile — `{ loginIpRanges: [] }` when the profile declares no restriction —
 * precisely "so a consumer can tell 'extracted, none' from 'never extracted'".
 * A node that carries no such key was built by a refresh predating that
 * extractor, so its login axis is NOT MODELED, never a verified "unrestricted".
 * Read with {@link familyWasExtracted} (a `hasOwnProperty` check): the
 * checked-and-clean case writes `[]` / `false`, which are real answers and are
 * both falsy, so truthiness cannot tell the two apart.
 */
const LOGIN_RESTRICTIONS_SENTINEL = 'loginIpRanges';

/**
 * Zod schema for the `sfi.profile_security` tool input.
 *
 *   - `profileId`: the canonical `Profile:{ApiName}` id or a bare apiName
 *     (coerced). A `PermissionSet:` / non-Profile id is refused at the handler.
 *   - `componentId` / `profileApiName`: interchangeable aliases a host naturally
 *     forwards from `sfi.resolve` (PROFILE-SECURITY-REJECTS-COMPONENTID).
 *     Resolved to the single profile through {@link resolveProfileRef}; the
 *     canonical `profileId` wins, disagreeing selectors → `invalid-query`, at
 *     least one is required.
 */
export const profileSecurityInputSchema = z.object({
  profileId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  profileApiName: z.string().min(1).optional(),
});

export type ProfileSecurityInput = z.infer<typeof profileSecurityInputSchema>;

/**
 * Reconcile the interchangeable Profile selectors a host reaches for —
 * `profileId` (canonical), `componentId` (`Profile:{name}`), and
 * `profileApiName` (PROFILE-SECURITY-REJECTS-COMPONENTID). Each is coerced to a
 * `Profile:` id for the distinctness check; the canonical `profileId` wins when
 * several agree. Disagreeing selectors → `invalid-query` (never a silent pick);
 * none → `invalid-query`. The RAW winning value is returned so the handler's
 * existing coercion + Profile-only refusal stay byte-identical for a bare
 * `{ profileId }` call.
 */
const resolveProfileRef = (input: ProfileSecurityInput): Result<string, McpError> => {
  const candidates = [input.profileId, input.componentId, input.profileApiName]
    .map((v) => firstNonEmpty(v))
    .filter((v): v is string => v !== undefined);
  if (candidates.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'name the profile — pass `profileId` (e.g. "StandardUser"), `componentId` (`Profile:StandardUser`), or `profileApiName`',
      path: 'profileId',
    });
  }
  const distinct = [...new Set(candidates.map((v) => coercePrefix(v, [PROFILE_PREFIX])))];
  if (distinct.length > 1) {
    return err({
      kind: 'invalid-query',
      message: `profile selectors name different targets (${distinct.join(', ')}); pass exactly one of profileId / componentId / profileApiName`,
      path: 'profileId',
    });
  }
  return ok(candidates[0] as string);
};

/**
 * Org-wide session-security policy, read from the single `SessionSettings:default`
 * node. `null` when that node is absent (a vault refreshed before the
 * SessionSettings type shipped — refresh-gated, disclosed in `boundaryNote`).
 */
export interface SessionSecuritySettings {
  readonly mfaRequired: boolean | null;
  readonly requiresStrongAuth: boolean | null;
  readonly sessionTimeoutMinutes: number | null;
}

export interface ProfileSecurityOutput {
  readonly profileId: ComponentId;
  readonly profileLabel: string;
  /**
   * Whether THIS vault's refresh extracted the login-restriction family at all
   * (the {@link LOGIN_RESTRICTIONS_SENTINEL} property is present on the node).
   * `false` mutes every field below it to `null` — nothing was checked.
   */
  readonly loginRestrictionsExtracted: boolean;
  /**
   * The profile's declared login-IP-range windows (`[]` = checked, none), or
   * `null` when the family was never extracted (see
   * {@link loginRestrictionsExtracted}).
   */
  readonly loginIpRanges: readonly LoginIpRange[] | null;
  /** Count of the above; `null` — never `0` — when nothing was checked. */
  readonly loginIpRangeCount: number | null;
  /**
   * Login-hours per-weekday windows (`[]` when the profile declares no
   * `<loginHours>` restriction). `loginHoursRestricted` reports whether ANY
   * login-hours window is defined (from the extracted `loginHoursDefined` flag).
   * Both are `null` — never `[]` / `false` — when the family was never
   * extracted.
   */
  readonly loginHoursByDay: readonly LoginHourWindow[] | null;
  readonly loginHoursRestricted: boolean | null;
  /**
   * Org-wide MFA / session policy (single `SessionSettings:default` node), or
   * `null` when that node is not in the vault (refresh-gated).
   */
  readonly sessionSecuritySettings: SessionSecuritySettings | null;
  readonly confidence: 'declared';
  readonly boundaryNote: string;
}

/** Read one boolean-ish property, tolerating `'true'`/`'false'` string forms. */
const readBool = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
};

/** Read one numeric property, tolerating a numeric-string form. */
const readNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

export const profileSecurityHandler = async (
  ctx: Context,
  input: ProfileSecurityInput,
): Promise<Result<McpResponse<ProfileSecurityOutput>, McpError>> => {
  const profileRefResult = resolveProfileRef(input);
  if (!profileRefResult.ok) return profileRefResult;
  const profileRef = profileRefResult.value;
  const profileId = coercePrefix(profileRef, [PROFILE_PREFIX]);
  if (!profileId.startsWith(PROFILE_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message:
        `profileId must be a Profile: id; got '${profileRef}'. ` +
        'Permission sets carry no login security — login IP ranges / hours are a Profile-only surface.',
      path: 'profileId',
    });
  }

  const nodeResult = await getNodeById(ctx.graph, profileId as ComponentId);
  if (!nodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no Profile matches \`${profileId}\` in this vault`,
      path: profileId,
    });
  }
  const node = nodeResult.value;

  // TYPED ABSENCE: decide by the SENTINEL PROPERTY, never by the array's shape.
  // `readLoginIpRanges` returns `[]` for a missing key and for a declared-empty
  // one alike, which is exactly how a profile locked to a corporate network
  // reads as "not IP-restricted" on a vault predating the extractor.
  const loginRestrictionsExtracted = familyWasExtracted(
    node.properties,
    LOGIN_RESTRICTIONS_SENTINEL,
  );
  const loginIpRanges = loginRestrictionsExtracted
    ? readLoginIpRanges(node.properties)
    : null;
  const loginHoursByDay = loginRestrictionsExtracted
    ? readLoginHours(node.properties)
    : null;
  const loginHoursRestricted = loginRestrictionsExtracted
    ? node.properties['loginHoursDefined'] === true
    : null;

  // Org-wide session settings: read the single SessionSettings:default node.
  // Absent → null (a vault refreshed before the type shipped; refresh-gated).
  const sessionResult = await getNodeById(ctx.graph, SESSION_SETTINGS_ID);
  if (!sessionResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${sessionResult.error.message}` });
  }
  let sessionSecuritySettings: SessionSecuritySettings | null = null;
  if (sessionResult.value !== null) {
    const p = sessionResult.value.properties;
    sessionSecuritySettings = {
      mfaRequired: readBool(p['mfaRequired']),
      requiresStrongAuth: readBool(p['requiresStrongAuth']),
      sessionTimeoutMinutes: readNumber(p['sessionTimeoutMinutes']),
    };
  }

  // The not-extracted sentence LEADS the note: it mutes the whole login axis,
  // so it must not sit behind the sentences describing what those fields mean.
  const notExtractedSentence = loginRestrictionsExtracted
    ? ''
    : notExtractedFamilyDisclosure({
        subject: 'Login restrictions',
        verb: 'checked',
        pluralSubject: true,
        sentinelProperty: LOGIN_RESTRICTIONS_SENTINEL,
        containers: [profileId],
        surface: '`loginIpRanges` / `loginIpRangeCount` / `loginHoursByDay` / `loginHoursRestricted`',
        zeroReading: '"this profile is not IP- or hours-restricted"',
      }) + ' ';

  const boundaryNote =
    notExtractedSentence
    + 'Login IP ranges are declared Profile metadata (the user must be ASSIGNED this profile at runtime to be restricted by them, and IP ranges combine with org-wide network access). Login-hours weekday windows (`loginHoursByDay`) are the declared `<loginHours>` start/end minutes-since-midnight (GMT) per restricted weekday; a weekday absent from the list is unrestricted. '
    + (sessionSecuritySettings === null
      ? 'Org-wide MFA / session settings are NOT in this vault (`sessionSecuritySettings: null`) — the SessionSettings type is refresh-gated; re-run `/sfi-refresh` to pull it.'
      : 'Org-wide MFA / session settings come from the single SessionSettings:default node (declared, org-level).');

  return ok({
    data: {
      profileId: profileId as ComponentId,
      profileLabel: node.label ?? node.apiName,
      loginRestrictionsExtracted,
      loginIpRanges,
      loginIpRangeCount: loginIpRanges === null ? null : loginIpRanges.length,
      loginHoursByDay,
      loginHoursRestricted,
      sessionSecuritySettings,
      confidence: 'declared',
      boundaryNote,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
