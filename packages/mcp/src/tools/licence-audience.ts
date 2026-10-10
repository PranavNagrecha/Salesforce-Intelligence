/**
 * The ONE classifier from a Salesforce user licence name to the audience it
 * puts its holder in (internal org user vs Experience Cloud / portal / guest).
 *
 * Moved verbatim out of `why-cant-user-see-record.ts` so every access tool —
 * `who_can_access_object`'s granter rows and `permission_risk_report`'s
 * severity — reads the SAME licence lists instead of growing a second copy.
 */

import type { Node } from '@sf-intelligence/contracts';

/**
 * Which sharing baseline governs the subject user.
 *
 *   - `internal` — a standard/platform/integration licence. The object's
 *     `sharingModel` (the internal org-wide default) governs.
 *   - `external` — an Experience Cloud / portal / guest / external-identity
 *     licence. The object's `externalSharingModel` governs; the internal OWD
 *     does NOT apply to this user at all.
 *   - `unknown` — no profile supplied, the profile is not in this vault, it
 *     carries no `userLicense`, or the licence name is not one this build
 *     recognises. NEVER silently treated as `internal`.
 */
export type SubjectAudience = 'internal' | 'external' | 'unknown';

/**
 * User licences that make their holder an EXTERNAL (Experience Cloud / portal /
 * guest) user. For these the governing record-access baseline is the object's
 * `externalSharingModel`, not `sharingModel` — Salesforce evaluates the two
 * columns against disjoint audiences.
 *
 * Matched case-insensitively on the whitespace-collapsed licence name. A licence
 * NOT in this set and not in {@link INTERNAL_USER_LICENCES} is `unknown`, not
 * `internal`: guessing "internal" is exactly the conflation this stage exists to
 * stop.
 */
export const EXTERNAL_USER_LICENCES: ReadonlySet<string> = new Set(
  [
    'customer community',
    'customer community login',
    'customer community plus',
    'customer community plus login',
    'partner community',
    'partner community login',
    'channel account',
    'customer portal manager',
    'customer portal manager standard',
    'customer portal manager custom',
    'high volume customer portal',
    'overage high volume customer portal',
    'authenticated website',
    'overage authenticated website',
    'gold partner',
    'silver partner',
    'bronze partner',
    'guest user license',
    'external identity',
    'external identity login',
    'external apps',
    'external apps login',
    'chatter external',
    'external einstein agent',
  ],
);

/**
 * User licences whose holders are INTERNAL org users — the audience the object's
 * `sharingModel` governs. Chatter Free / Chatter Only / Identity are internal
 * licences despite their limited CRM reach; only the Experience Cloud / portal
 * families in {@link EXTERNAL_USER_LICENCES} sit on the external column.
 */
export const INTERNAL_USER_LICENCES: ReadonlySet<string> = new Set(
  [
    'salesforce',
    'salesforce platform',
    'salesforce platform one',
    'salesforce integration',
    'force.com - app subscription',
    'force.com - one app',
    'identity',
    'chatter free',
    'chatter only',
    'work.com only',
    'knowledge only user',
    'content only',
    'company communities',
    'premier support',
    'einstein agent',
    'analytics cloud integration user',
    'analytics cloud security user',
    'sales insights integration user',
    'salesforceiq integration user',
    'crm integration user',
  ],
);

/**
 * Classify a raw `Profile.userLicense` value into the audience whose OWD column
 * governs it. Exact membership decides first; the two prefix rules below are a
 * documented HEURISTIC for the member-based licence variants Salesforce keeps
 * adding to the same families (`Customer Community …`, `Partner Community …`,
 * `External …`) and only ever resolve to `external`. Anything else is `unknown`.
 */
export const classifyUserLicence = (raw: string): SubjectAudience => {
  const name = raw.trim().replace(/\s+/gu, ' ').toLowerCase();
  if (name.length === 0) return 'unknown';
  if (EXTERNAL_USER_LICENCES.has(name)) return 'external';
  if (INTERNAL_USER_LICENCES.has(name)) return 'internal';
  if (
    name.startsWith('customer community') ||
    name.startsWith('partner community') ||
    name.startsWith('external ')
  ) {
    return 'external';
  }
  return 'unknown';
};

/** Who a Profile / PermissionSet can be held by, as far as its licence says. */
export type GrantorAudience = 'internal' | 'external' | 'guest' | 'unknown';

export interface GrantorAudienceInfo {
  readonly audience: GrantorAudience;
  /** The raw licence (`Profile.userLicense` / `PermissionSet.license`), or null. */
  readonly licence: string | null;
}

/**
 * The audience a Profile or PermissionSet grant reaches. A Profile's
 * `userLicense` is mandatory; a PermissionSet's `license` is optional and a
 * permission set WITHOUT one can be assigned to any user — that is `unknown`
 * (never assumed internal). The guest licence is split out of `external`
 * because an unauthenticated guest is a stronger exposure than a logged-in
 * community member.
 */
export const grantorAudience = (node: Node): GrantorAudienceInfo => {
  const key = node.type === 'Profile' ? 'userLicense' : 'license';
  const raw = node.properties[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { audience: 'unknown', licence: null };
  }
  const normalized = raw.trim().replace(/\s+/gu, ' ').toLowerCase();
  if (normalized === 'guest user license' || normalized === 'guest') {
    return { audience: 'guest', licence: raw };
  }
  return { audience: classifyUserLicence(raw), licence: raw };
};
