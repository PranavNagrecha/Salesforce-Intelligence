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
 *     (DEFERRED behind the SessionSettings tier — always `[]` today; the v0.1
 *     extractor stores only the `loginHoursDefined` boolean).
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

import { coercePrefix } from './coerce-id.js';
import {
  readLoginHours,
  readLoginIpRanges,
  type LoginHourWindow,
  type LoginIpRange,
} from './user-ability.js';

/** The single org-wide session-security node id (one per org). */
const SESSION_SETTINGS_ID = 'SessionSettings:default' as ComponentId;

export const profileSecurityInputSchema = z.object({
  profileId: z.string().min(1),
});

export type ProfileSecurityInput = z.infer<typeof profileSecurityInputSchema>;

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
  /** The profile's declared login-IP-range windows (may be empty). */
  readonly loginIpRanges: readonly LoginIpRange[];
  readonly loginIpRangeCount: number;
  /**
   * Login-hours per-weekday windows. DEFERRED behind the SessionSettings tier
   * — always `[]` today; `loginHoursRestricted` still reports whether ANY
   * login-hours window is defined (from the extracted `loginHoursDefined` flag).
   */
  readonly loginHoursByDay: readonly LoginHourWindow[];
  readonly loginHoursRestricted: boolean;
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
  const profileId = coercePrefix(input.profileId, ['Profile:']);
  if (!profileId.startsWith('Profile:')) {
    return err({
      kind: 'invalid-query',
      message:
        `profileId must be a Profile: id; got '${input.profileId}'. ` +
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

  const loginIpRanges = readLoginIpRanges(node.properties);
  const loginHoursByDay = readLoginHours(node.properties);
  const loginHoursRestricted = node.properties['loginHoursDefined'] === true;

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

  const boundaryNote =
    'Login IP ranges are declared Profile metadata (the user must be ASSIGNED this profile at runtime to be restricted by them, and IP ranges combine with org-wide network access). Login-hours weekday windows are DEFERRED behind the SessionSettings tier, so `loginHoursByDay` is empty even when `loginHoursRestricted` is true. '
    + (sessionSecuritySettings === null
      ? 'Org-wide MFA / session settings are NOT in this vault (`sessionSecuritySettings: null`) — the SessionSettings type is refresh-gated; re-run `/sfi-refresh` to pull it.'
      : 'Org-wide MFA / session settings come from the single SessionSettings:default node (declared, org-level).');

  return ok({
    data: {
      profileId: profileId as ComponentId,
      profileLabel: node.label ?? node.apiName,
      loginIpRanges,
      loginIpRangeCount: loginIpRanges.length,
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
