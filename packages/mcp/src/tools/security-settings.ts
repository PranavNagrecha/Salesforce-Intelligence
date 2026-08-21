/**
 * Handler for the `sfi.security_settings` MCP tool.
 *
 * "What are my org's security settings — and what can this product NOT see?"
 * ONE call over the two org-level singletons that
 * `settings/Security.settings-meta.xml` produces:
 *
 *   - `SecuritySettings:default` — password policy, trusted-IP network access,
 *     single sign-on settings, and the top-level org security toggles.
 *   - `SessionSettings:default` — the nested `<sessionSettings>` block: session
 *     timeout, clickjack protection, CSRF, session locking, referrer policy.
 *
 * Values are surfaced VERBATIM as the strings the Metadata API emitted.
 * Salesforce settings values are discrete ENUMS (`FourHours`, `NinetyDays`,
 * `ThreeAttempts`, `UpperLowerCaseNumericSpecialCharacters`), not numbers —
 * coercing them loses information, and `parseInt('FourHours')` is exactly how
 * the pre-0.3.1 build turned a declared four-hour timeout into `null`. The one
 * number this tool reports, `sessionTimeoutMinutes`, is OUR derivation from the
 * enum and says so in `sessionTimeoutMinutesDerivedFrom` (Salesforce never
 * emits a minute count).
 *
 * The other half of the answer is `notCovered[]`: the enumerated, machine-
 * readable list of security questions this response does NOT answer, each with
 * a `status` and `closableByRefresh`. It is DATA, not prose, and most of it is
 * computed rather than hardcoded — a property that is `null` because this org's
 * file does not declare it, a nested block the extractor walked past, and the
 * sibling `*.settings-meta.xml` files sitting in the vault that no extractor
 * parses. "Checked and found nothing" and "did not check" are different
 * answers, and this array is where the second one lives.
 */

import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** The two org-level singleton ids this tool joins. */
const SECURITY_SETTINGS_ID = 'SecuritySettings:default' as ComponentId;
const SESSION_SETTINGS_ID = 'SessionSettings:default' as ComponentId;

/** Default / maximum page size for the trusted-IP window list. */
const IP_RANGE_DEFAULT_LIMIT = 100;
const IP_RANGE_MAX_LIMIT = 500;

/**
 * Settings FILES in the generic `settings/` container that this build has an
 * extractor for. Every other `*.settings-meta.xml` sitting next to them is
 * retrieved but never parsed — reported in `notCovered` rather than ignored.
 * These are Salesforce feature names, never org identifiers.
 */
const MODELED_SETTINGS_FILES: ReadonlySet<string> = new Set([
  'Security.settings-meta.xml',
  'FieldService.settings-meta.xml',
]);

/**
 * Name filter for "which of the unparsed settings files are SECURITY-relevant".
 * Used only to pick which unmodeled siblings are worth naming individually; the
 * full unparsed count is reported regardless, so the filter can never hide a
 * gap — it only decides what gets a row of its own.
 */
const SECURITY_RELEVANT_SETTINGS_RE =
  /(secur|ident|oauth|privacy|session|password|sso|saml|mobile|encrypt|trust)/i;

/** How many unmodeled sibling settings files to name individually. */
const MAX_NAMED_UNMODELED_SETTINGS = 12;

/**
 * Why a security question is NOT answered by this response.
 *
 *   - `not-declared-in-this-org-file` — the element is simply absent from this
 *     org's retrieved `Security.settings-meta.xml`. NOT "disabled": Salesforce
 *     omits what is not set, so absence is silence.
 *   - `not-modeled-by-this-build` — the data IS in the vault (a nested block, or
 *     a sibling settings file) and no extractor reads it. A refresh cannot fix
 *     this; product code has to.
 *   - `not-metadata` — the answer is record data or runtime state and lives on
 *     the live plane or nowhere. No refresh of any depth can ever close it.
 *   - `not-in-vault` — the source file itself is missing from this vault. A
 *     refresh CAN close this one.
 */
export type SecurityGapStatus =
  | 'not-declared-in-this-org-file'
  | 'not-modeled-by-this-build'
  | 'not-metadata'
  | 'not-in-vault';

/** One enumerated gap in `notCovered[]`. */
export interface SecurityGap {
  /** Stable machine key (an element name where one exists). */
  readonly setting: string;
  /** Human-readable name of the security question this row is about. */
  readonly label: string;
  readonly status: SecurityGapStatus;
  /** Whether re-running `/sfi-refresh` could turn this row into an answer. */
  readonly closableByRefresh: boolean;
  /** Why this is not answered — stated as a fact about the data, not a guess. */
  readonly reason: string;
  /** Where the answer actually lives, when there is somewhere to point. */
  readonly whereInstead: string | null;
}

/** One trusted-IP window from `<networkAccess><ipRanges>`. */
export interface TrustedIpRangeRow {
  readonly start: string | null;
  readonly end: string | null;
  readonly description: string | null;
}

/** Org password policy, verbatim enum strings. `null` when not declared. */
export interface PasswordPolicyView {
  readonly complexity: string | null;
  readonly expiration: string | null;
  readonly lockoutInterval: string | null;
  readonly maxLoginAttempts: string | null;
  readonly minimumPasswordLength: string | null;
  readonly historyRestriction: string | null;
  readonly minimumPasswordLifetime: string | null;
  readonly obscureSecretAnswer: string | null;
  readonly questionRestriction: string | null;
  /** Every key the org declared in the block, verbatim — including any this build does not name above. */
  readonly allDeclared: Readonly<Record<string, string>>;
}

/** Org session-security posture, verbatim enum strings plus the one derived number. */
export interface SessionSecurityView {
  /** RAW `<sessionTimeout>` enum, e.g. `FourHours`. Never coerced. */
  readonly sessionTimeout: string | null;
  /** OUR mapping of that enum to minutes. Salesforce emits no minute count. */
  readonly sessionTimeoutMinutes: number | null;
  /** The enum `sessionTimeoutMinutes` was derived from, or `null` if not derived. */
  readonly sessionTimeoutMinutesDerivedFrom: string | null;
  readonly forceLogoutOnSessionTimeout: string | null;
  readonly disableTimeoutWarning: string | null;
  readonly lockSessionsToIp: string | null;
  readonly lockSessionsToDomain: string | null;
  readonly enforceIpRangesEveryRequest: string | null;
  readonly requireHttpOnly: string | null;
  readonly enableCSRFOnGet: string | null;
  readonly enableCSRFOnPost: string | null;
  readonly enableContentSniffingProtection: string | null;
  readonly referrerPolicy: string | null;
  readonly referrerPolicyDirective: string | null;
  readonly forceRelogin: string | null;
  readonly enableMFADirectUILoginOptIn: string | null;
  /** The four clickjack switches — NESTED in `<sessionSettings>`, not top-level. */
  readonly clickjackProtection: Readonly<Record<string, string>>;
  /** Every key of the block, verbatim. */
  readonly allDeclared: Readonly<Record<string, string>>;
  readonly declaredKeyCount: number;
}

export interface SecuritySettingsOutput {
  /** Vault-relative path both singletons were extracted from, or `null` when absent. */
  readonly sourceFile: string | null;
  readonly passwordPolicy: PasswordPolicyView | null;
  readonly sessionSecurity: SessionSecurityView | null;
  readonly networkAccess: {
    readonly trustedIpRangeCount: number;
    readonly trustedIpRanges: readonly TrustedIpRangeRow[];
    readonly limit: number;
    readonly offset: number;
    readonly hasMore: boolean;
    /** From the session block — whether trusted IP ranges are enforced on every request. */
    readonly enforceIpRangesEveryRequest: string | null;
  };
  /** `<singleSignOnSettings>` verbatim, or `null` when the block is not declared. */
  readonly singleSignOn: Readonly<Record<string, string>> | null;
  /** Every TOP-LEVEL scalar toggle verbatim (HTTPS, admin-login-as, redirect blocking, …). */
  readonly orgToggles: Readonly<Record<string, string>>;
  /** The enumerated list of what this response does NOT answer. Half the answer. */
  readonly notCovered: readonly SecurityGap[];
  readonly confidence: 'declared';
  /** Present ONLY when the source file is missing from this vault (refresh-closable). */
  readonly coverageCaveat?: string;
  readonly boundaryNote: string;
}

/**
 * Zod schema for `sfi.security_settings`. No required input — these are org
 * singletons. `limit` / `offset` page the trusted-IP window list only; every
 * other section is returned whole.
 */
export const securitySettingsInputSchema = z.object({
  limit: z.number().int().min(1).max(IP_RANGE_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export type SecuritySettingsInput = z.infer<typeof securitySettingsInputSchema>;

/** Read one property as a verbatim string, or `null` when absent / non-scalar. */
const str = (props: Readonly<Record<string, unknown>>, key: string): string | null => {
  const v = props[key];
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return null;
  return String(v);
};

/** Read one property as a `key -> string` map, or `null` when absent. */
const stringMap = (
  props: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> | null => {
  const v = props[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw === undefined || raw === null || typeof raw === 'object') continue;
    out[k] = String(raw);
  }
  return out;
};

/** Read one property as an array of strings (empty when absent). */
const stringArray = (
  props: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] => {
  const v = props[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
};

/** Pick the named keys out of a verbatim map into a smaller verbatim map. */
const pick = (
  map: Readonly<Record<string, string>>,
  keys: readonly string[],
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = map[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
};

/** The four clickjack switches, which live INSIDE `<sessionSettings>`. */
const CLICKJACK_KEYS: readonly string[] = [
  'enableClickjackSetup',
  'enableClickjackNonsetupSFDC',
  'enableClickjackNonsetupUser',
  'enableClickjackNonsetupUserHeaderless',
];

/** Build the password-policy view from the SecuritySettings node. */
const readPasswordPolicy = (props: Readonly<Record<string, unknown>>): PasswordPolicyView | null => {
  const all = stringMap(props, 'passwordPolicies');
  if (all === null) return null;
  return {
    complexity: all['complexity'] ?? null,
    expiration: all['expiration'] ?? null,
    lockoutInterval: all['lockoutInterval'] ?? null,
    maxLoginAttempts: all['maxLoginAttempts'] ?? null,
    minimumPasswordLength: all['minimumPasswordLength'] ?? null,
    historyRestriction: all['historyRestriction'] ?? null,
    minimumPasswordLifetime: all['minimumPasswordLifetime'] ?? null,
    obscureSecretAnswer: all['obscureSecretAnswer'] ?? null,
    questionRestriction: all['questionRestriction'] ?? null,
    allDeclared: all,
  };
};

/** Build the session-security view from the SessionSettings node. */
const readSessionSecurity = (props: Readonly<Record<string, unknown>>): SessionSecurityView => {
  const all = stringMap(props, 'sessionSettings') ?? {};
  const minutes = props['sessionTimeoutMinutes'];
  return {
    sessionTimeout: str(props, 'sessionTimeout'),
    sessionTimeoutMinutes: typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : null,
    sessionTimeoutMinutesDerivedFrom: str(props, 'sessionTimeoutMinutesDerivedFrom'),
    forceLogoutOnSessionTimeout: all['forceLogoutOnSessionTimeout'] ?? null,
    disableTimeoutWarning: all['disableTimeoutWarning'] ?? null,
    lockSessionsToIp: all['lockSessionsToIp'] ?? null,
    lockSessionsToDomain: all['lockSessionsToDomain'] ?? null,
    enforceIpRangesEveryRequest: all['enforceIpRangesEveryRequest'] ?? null,
    requireHttpOnly: all['requireHttpOnly'] ?? null,
    enableCSRFOnGet: all['enableCSRFOnGet'] ?? null,
    enableCSRFOnPost: all['enableCSRFOnPost'] ?? null,
    enableContentSniffingProtection: all['enableContentSniffingProtection'] ?? null,
    referrerPolicy: all['referrerPolicy'] ?? null,
    referrerPolicyDirective: all['referrerPolicyDirective'] ?? null,
    forceRelogin: all['forceRelogin'] ?? null,
    enableMFADirectUILoginOptIn: all['enableMFADirectUILoginOptIn'] ?? null,
    clickjackProtection: pick(all, CLICKJACK_KEYS),
    allDeclared: all,
    declaredKeyCount: stringArray(props, 'declaredKeys').length,
  };
};

/** Read the trusted-IP windows off the SecuritySettings node. */
const readTrustedIpRanges = (
  props: Readonly<Record<string, unknown>>,
): readonly TrustedIpRangeRow[] => {
  const raw = props['networkAccessIpRanges'];
  if (!Array.isArray(raw)) return [];
  const rows: TrustedIpRangeRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    rows.push({
      start: typeof row['start'] === 'string' ? row['start'] : null,
      end: typeof row['end'] === 'string' ? row['end'] : null,
      description: typeof row['description'] === 'string' ? row['description'] : null,
    });
  }
  return rows;
};

/**
 * List the `*.settings-meta.xml` files sitting next to the one this build parses
 * that NO extractor reads. Derived from the security node's own `sourcePath`
 * rather than a hardcoded layout, so it degrades honestly: a vault whose
 * directory cannot be read reports `null` (unknown), never an empty list read as
 * "there are none".
 */
const listUnmodeledSettingsFiles = async (
  ctx: Context,
  securityNode: Node | null,
): Promise<readonly string[] | null> => {
  if (securityNode === null) return null;
  const sourcePath = securityNode.sourcePath;
  const abs = isAbsolute(sourcePath) ? sourcePath : join(ctx.vaultRoot, sourcePath);
  try {
    const names = await readdir(dirname(abs));
    return names
      .filter((n) => n.endsWith('.settings-meta.xml') && !MODELED_SETTINGS_FILES.has(n))
      .sort();
  } catch {
    return null;
  }
};

/**
 * Gaps that no refresh and no extractor can ever close, because the answer is
 * record data or runtime state rather than metadata. The vault holds METADATA,
 * never RECORD DATA — these rows say so explicitly instead of letting a reader
 * infer a clean bill of health from a settings dump.
 */
const NEVER_IN_METADATA_GAPS: readonly SecurityGap[] = Object.freeze([
  Object.freeze({
    setting: 'loginHistory',
    label: 'Login history / failed login attempts / currently locked-out users',
    status: 'not-metadata' as const,
    closableByRefresh: false,
    reason:
      'Who logged in, from where, and who is currently locked out is RECORD DATA (LoginHistory), not metadata. It is not in this vault at any refresh depth.',
    whereInstead: 'Setup > Login History, or a live-plane query against LoginHistory.',
  }),
  Object.freeze({
    setting: 'effectiveMfaPerUser',
    label: 'Whether a given user is actually required to use MFA',
    status: 'not-metadata' as const,
    closableByRefresh: false,
    reason:
      'MFA enforcement per user depends on permission ASSIGNMENT plus runtime state. This file declares org-wide switches only; assignment is not modeled and runtime is not metadata.',
    whereInstead:
      '`sfi.user_ability` / `sfi.profile_security` for the declared grants on a Profile or PermissionSet; the org itself for who holds them.',
  }),
  Object.freeze({
    setting: 'passwordExpiryState',
    label: 'When each user\'s password actually expires / how many are past due',
    status: 'not-metadata' as const,
    closableByRefresh: false,
    reason:
      'The expiration POLICY is declared here; each user\'s password age and expiry date is record data on the User record.',
    whereInstead: 'Setup > Users, or a live-plane query.',
  }),
]);

export const securitySettingsHandler = async (
  ctx: Context,
  input: SecuritySettingsInput,
): Promise<Result<McpResponse<SecuritySettingsOutput>, McpError>> => {
  const securityResult = await getNodeById(ctx.graph, SECURITY_SETTINGS_ID);
  if (!securityResult.ok) {
    return {
      ok: false,
      error: { kind: 'internal', message: `graph query failed: ${securityResult.error.message}` },
    };
  }
  const sessionResult = await getNodeById(ctx.graph, SESSION_SETTINGS_ID);
  if (!sessionResult.ok) {
    return {
      ok: false,
      error: { kind: 'internal', message: `graph query failed: ${sessionResult.error.message}` },
    };
  }

  const securityNode = securityResult.value;
  const sessionNode = sessionResult.value;
  const securityProps = securityNode?.properties ?? {};
  const sessionProps = sessionNode?.properties ?? {};

  const passwordPolicy = securityNode === null ? null : readPasswordPolicy(securityProps);
  const sessionSecurity = sessionNode === null ? null : readSessionSecurity(sessionProps);
  const allIpRanges = readTrustedIpRanges(securityProps);
  const limit = input.limit ?? IP_RANGE_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const pageIpRanges = allIpRanges.slice(offset, offset + limit);
  const singleSignOn = securityNode === null ? null : stringMap(securityProps, 'singleSignOnSettings');
  const orgToggles = stringMap(securityProps, 'orgToggles') ?? {};

  // ── notCovered: computed first, hardcoded last ────────────────────────────
  const notCovered: SecurityGap[] = [];

  if (securityNode === null && sessionNode === null) {
    notCovered.push({
      setting: 'Security.settings',
      label: 'The org security settings file itself',
      status: 'not-in-vault',
      closableByRefresh: true,
      reason:
        'Neither `SecuritySettings:default` nor `SessionSettings:default` is in this vault — `settings/Security.settings-meta.xml` was not retrieved or not extracted.',
      whereInstead: 'Re-run `/sfi-refresh` to pull the `Settings` metadata container.',
    });
  }

  // Properties that are null because THIS ORG'S FILE does not declare them.
  // Absence is silence, never "disabled" — and these two are exactly the
  // properties the org-wide MFA concept rules bind, so their null is load-bearing.
  if (sessionNode !== null) {
    const declaredCount = stringArray(sessionProps, 'declaredKeys').length;
    if (sessionProps['mfaRequired'] === null || sessionProps['mfaRequired'] === undefined) {
      notCovered.push({
        setting: 'mfaRequired',
        label: 'Org-wide "require MFA for UI logins" switch',
        status: 'not-declared-in-this-org-file',
        closableByRefresh: false,
        reason: `No \`MFARequired\` element is present among the ${declaredCount} session keys this org's \`Security.settings-meta.xml\` declares. That is "not declared here", NOT "MFA is off".`,
        whereInstead:
          '`sfi.user_ability` / `sfi.profile_security` for the MFA-related user permissions a Profile or PermissionSet grants.',
      });
    }
    if (
      sessionProps['requiresStrongAuth'] === null ||
      sessionProps['requiresStrongAuth'] === undefined
    ) {
      notCovered.push({
        setting: 'requiresStrongAuth',
        label: 'Org-wide "require high-assurance session for UI logins" switch',
        status: 'not-declared-in-this-org-file',
        closableByRefresh: false,
        reason: `No \`enableRequiredStrongAuthForUILogins\` element is present among the ${declaredCount} session keys this org declares. Absence is silence, not a disabled policy.`,
        whereInstead: null,
      });
    }
  }

  if (securityNode !== null && passwordPolicy === null) {
    notCovered.push({
      setting: 'passwordPolicies',
      label: 'Org password policy',
      status: 'not-declared-in-this-org-file',
      closableByRefresh: false,
      reason:
        'This org\'s `Security.settings-meta.xml` carries no `<passwordPolicies>` block, so the org is running platform defaults that are not written down in metadata.',
      whereInstead: 'Setup > Password Policies.',
    });
  }
  if (securityNode !== null && allIpRanges.length === 0) {
    notCovered.push({
      setting: 'networkAccess',
      label: 'Trusted IP ranges (org-wide network access)',
      status: 'not-declared-in-this-org-file',
      closableByRefresh: false,
      reason:
        'This org\'s file declares no `<networkAccess><ipRanges>` windows. Profile-level login IP ranges are a SEPARATE control and are not covered by this row.',
      whereInstead: '`sfi.profile_security` for per-profile login IP ranges.',
    });
  }
  if (securityNode !== null && singleSignOn === null) {
    notCovered.push({
      setting: 'singleSignOnSettings',
      label: 'Single sign-on settings',
      status: 'not-declared-in-this-org-file',
      closableByRefresh: false,
      reason: 'This org\'s file carries no `<singleSignOnSettings>` block.',
      whereInstead: '`sfi.list_components` with `type: "SamlSsoConfig"` for the SAML configurations themselves.',
    });
  }

  // Nested blocks the extractor walked past — in the vault, unread.
  for (const block of stringArray(securityProps, 'unmodeledBlocks')) {
    notCovered.push({
      setting: block,
      label: `\`<${block}>\` block of Security.settings`,
      status: 'not-modeled-by-this-build',
      closableByRefresh: false,
      reason: `The \`<${block}>\` block IS in the retrieved file and this build has no reader for it. A refresh cannot close this — product code has to.`,
      whereInstead: null,
    });
  }

  // Sibling settings files that no extractor parses.
  const unmodeledSettings = await listUnmodeledSettingsFiles(ctx, securityNode);
  if (unmodeledSettings === null) {
    if (securityNode !== null) {
      notCovered.push({
        setting: 'otherSettingsFiles',
        label: 'Other `*.settings-meta.xml` files in this vault',
        status: 'not-modeled-by-this-build',
        closableByRefresh: false,
        reason:
          'The vault\'s `settings/` directory could not be listed, so how many sibling settings files go unparsed is UNKNOWN — not zero.',
        whereInstead: null,
      });
    }
  } else if (unmodeledSettings.length > 0) {
    const securityRelevant = unmodeledSettings.filter((n) =>
      SECURITY_RELEVANT_SETTINGS_RE.test(n),
    );
    for (const name of securityRelevant.slice(0, MAX_NAMED_UNMODELED_SETTINGS)) {
      notCovered.push({
        setting: name,
        label: `\`settings/${name}\``,
        status: 'not-modeled-by-this-build',
        closableByRefresh: false,
        reason: `\`${name}\` is in this vault and no extractor reads it, so nothing it declares is in any answer.`,
        whereInstead: null,
      });
    }
    notCovered.push({
      setting: 'otherSettingsFiles',
      label: 'Other `*.settings-meta.xml` files in this vault',
      status: 'not-modeled-by-this-build',
      closableByRefresh: false,
      reason: `${unmodeledSettings.length} settings file(s) sit next to \`Security.settings-meta.xml\` in this vault with no extractor to read them (${securityRelevant.length} of them security-named${securityRelevant.length > MAX_NAMED_UNMODELED_SETTINGS ? `, ${MAX_NAMED_UNMODELED_SETTINGS} listed above` : ''}). This build models only ${MODELED_SETTINGS_FILES.size} of the container's files.`,
      whereInstead: null,
    });
  }

  notCovered.push(...NEVER_IN_METADATA_GAPS);

  const sourceFile = securityNode?.sourcePath ?? sessionNode?.sourcePath ?? null;
  const boundaryNote =
    'Every value here is DECLARED org-wide metadata, surfaced verbatim as the Metadata API string (Salesforce settings values are discrete enums, not numbers). `sessionTimeoutMinutes` is the ONE exception: it is this product\'s mapping of the `sessionTimeout` enum to minutes, recorded in `sessionTimeoutMinutesDerivedFrom` — Salesforce emits no minute count. These are ORG-WIDE defaults; a profile can override session timeout and password policy in Setup, and nothing in this file records whether one does, so a per-profile override cannot be ruled out from here. `notCovered[]` enumerates what this response does NOT answer — read it before treating this as a complete security posture.';

  const coverageCaveat =
    securityNode === null && sessionNode === null
      ? '`settings/Security.settings-meta.xml` is not in this vault, so NO org security setting could be read — this is "not retrieved", not "not configured". Re-run `/sfi-refresh`.'
      : securityNode === null || sessionNode === null
        ? 'Only one of the two org security singletons is in this vault; the other section is missing rather than empty. Re-run `/sfi-refresh`.'
        : null;

  return ok({
    data: {
      sourceFile,
      passwordPolicy,
      sessionSecurity,
      networkAccess: {
        trustedIpRangeCount: allIpRanges.length,
        trustedIpRanges: pageIpRanges,
        limit,
        offset,
        hasMore: offset + pageIpRanges.length < allIpRanges.length,
        enforceIpRangesEveryRequest: sessionSecurity?.enforceIpRangesEveryRequest ?? null,
      },
      singleSignOn,
      orgToggles,
      notCovered,
      confidence: 'declared',
      ...(coverageCaveat === null ? {} : { coverageCaveat }),
      boundaryNote,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
