/**
 * One-time, per-org consent for the read-only live plane (AUDIT-F3).
 *
 * The live plane never mutates the org — but it *queries the authenticated org
 * at call time*, so, unlike the offline vault, it must never run without
 * explicit user intent. Consent is granted once per org and persisted to a
 * vault-independent, user-level store, so it survives across sessions.
 *
 * Trust posture (AUDIT-F3):
 *   - A stored grant is the primary allow path (plus operator env override).
 *   - Per-call `liveEnabled: true` is **not** a consent substitute.
 *   - Grants bind OrgId + principal username, carry scopes + expiry, and are
 *     disclosed on live results via {@link describeLiveGrant}.
 *   - A missing, corrupt, expired, or under-scoped grant fail-closes.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';

/** Consent dir must not be world-traversable (holds OrgId + principal). */
const CONSENT_DIR_MODE = 0o700;
/** Consent file must not be world-readable. */
const CONSENT_FILE_MODE = 0o600;

/** Bumped on breaking on-disk shape changes (v1 → v2 for AUDIT-F3). */
const STORE_VERSION = 2;

/**
 * Live-plane scopes. Default grant is `aggregate` only; sample/user tools
 * require an explicit step-up via `sfi.live_consent { grant: true, scopes: [...] }`.
 */
export type LiveScope = 'aggregate' | 'sample' | 'users' | 'audit';

export const LIVE_SCOPES: readonly LiveScope[] = Object.freeze([
  'aggregate',
  'sample',
  'users',
  'audit',
]);

/** Default grant TTL when the caller does not pass `expiresInHours`. */
export const DEFAULT_GRANT_TTL_HOURS = 24 * 7; // 7 days

/** One org's consent record (store v2). */
export interface ConsentRecord {
  /** ISO-8601 timestamp the consent was granted (or last stepped up). */
  readonly grantedAt: string;
  /** Who granted it (default `user`); free-form provenance label. */
  readonly grantedBy: string;
  /** Opaque id stamped on live results for audit/disclosure. */
  readonly grantId: string;
  /** Salesforce Org Id (`00D…`) bound at grant time; null only for env bypass. */
  readonly orgId: string | null;
  /** Authenticated Salesforce username bound at grant time. */
  readonly principalUsername: string | null;
  /** Authorized scopes (subset of {@link LIVE_SCOPES}). */
  readonly scopes: readonly LiveScope[];
  /** ISO-8601 expiry; past → treat as no consent. */
  readonly expiresAt: string;
}

/** The whole persisted store: a map of normalized org key -> record. */
export interface ConsentStore {
  readonly version: number;
  readonly orgs: Readonly<Record<string, ConsentRecord>>;
}

/** Failure shape for the mutating operations. */
export interface ConsentError {
  readonly kind: 'write-failed' | 'invalid-grant';
  readonly message: string;
}

/** Structured grant disclosure for live tool trust surfaces. */
export interface LiveGrantDisclosure {
  readonly grantId: string;
  readonly orgId: string | null;
  readonly principalUsername: string | null;
  readonly scopes: readonly LiveScope[];
  readonly expiresAt: string;
  readonly source: 'consent' | 'env';
}

const EMPTY_STORE: ConsentStore = Object.freeze({
  version: STORE_VERSION,
  orgs: Object.freeze({}),
});

/**
 * Absolute path of the consent store.
 *
 * `SFI_CONSENT_PATH` overrides it (tests point it at a temp file for
 * determinism); otherwise it is `~/.sf-intelligence/live-consent.json`.
 */
export const consentStorePath = (): string => {
  const override = process.env['SFI_CONSENT_PATH'];
  if (typeof override === 'string' && override.length > 0) return override;
  return join(homedir(), '.sf-intelligence', 'live-consent.json');
};

const normalizeOrg = (org: string): string => org.trim().toLowerCase();

/**
 * Normalize Salesforce Ids for 15-vs-18 comparison (case-sensitive prefix).
 * Returns null when the value is missing or not a plausible Id.
 */
export const normalizeSalesforceId = (id: string | null | undefined): string | null => {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed.length < 15) return null;
  return trimmed.slice(0, 15);
};

/** True when two OrgIds refer to the same org (15- or 18-char forms). */
export const orgIdsMatch = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => {
  const na = normalizeSalesforceId(a);
  const nb = normalizeSalesforceId(b);
  return na !== null && nb !== null && na === nb;
};

const isLiveScope = (value: unknown): value is LiveScope =>
  value === 'aggregate' ||
  value === 'sample' ||
  value === 'users' ||
  value === 'audit';

const hardenConsentPath = async (path: string): Promise<void> => {
  try {
    await chmod(dirname(path), CONSENT_DIR_MODE);
  } catch {
    // Best-effort (Windows / unusual FS).
  }
  try {
    await chmod(path, CONSENT_FILE_MODE);
  } catch {
    // Best-effort.
  }
};

const normalizeScopes = (scopes: readonly LiveScope[] | undefined): LiveScope[] => {
  const raw = scopes === undefined || scopes.length === 0 ? (['aggregate'] as LiveScope[]) : [...scopes];
  const uniq = [...new Set(raw.filter(isLiveScope))];
  return uniq.length > 0 ? uniq : ['aggregate'];
};

const parseRecord = (raw: unknown): ConsentRecord | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // v1 shape: only grantedAt/grantedBy — treat as expired (force re-grant).
  if (typeof r['grantId'] !== 'string' || typeof r['expiresAt'] !== 'string') {
    return null;
  }
  if (typeof r['grantedAt'] !== 'string' || typeof r['grantedBy'] !== 'string') {
    return null;
  }
  const scopesRaw = r['scopes'];
  const scopes = Array.isArray(scopesRaw)
    ? scopesRaw.filter(isLiveScope)
    : (['aggregate'] as LiveScope[]);
  return {
    grantedAt: r['grantedAt'],
    grantedBy: r['grantedBy'],
    grantId: r['grantId'],
    orgId: typeof r['orgId'] === 'string' ? r['orgId'] : null,
    principalUsername:
      typeof r['principalUsername'] === 'string' ? r['principalUsername'] : null,
    scopes: scopes.length > 0 ? scopes : ['aggregate'],
    expiresAt: r['expiresAt'],
  };
};

const isExpired = (record: ConsentRecord, now: Date = new Date()): boolean => {
  const exp = Date.parse(record.expiresAt);
  if (!Number.isFinite(exp)) return true;
  return exp <= now.getTime();
};

/**
 * Read and parse the store. Returns an empty store on any failure (missing
 * file, unreadable, malformed JSON, wrong shape) — fail-closed by design.
 * v1 records without grantId/expiry are dropped (force re-grant).
 */
export const loadConsentStore = async (
  path: string = consentStorePath(),
): Promise<ConsentStore> => {
  try {
    const raw = await readFile(path, 'utf8');
    await hardenConsentPath(path);
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('orgs' in parsed) ||
      typeof (parsed as { orgs: unknown }).orgs !== 'object' ||
      (parsed as { orgs: unknown }).orgs === null
    ) {
      return EMPTY_STORE;
    }
    const obj = parsed as { version?: unknown; orgs: Record<string, unknown> };
    const orgs: Record<string, ConsentRecord> = {};
    for (const [key, value] of Object.entries(obj.orgs)) {
      const record = parseRecord(value);
      if (record !== null) orgs[key] = record;
    }
    return {
      version: STORE_VERSION,
      orgs,
    };
  } catch {
    return EMPTY_STORE;
  }
};

/** Load the active (non-expired) grant for `org`, or null. */
export const getLiveGrant = async (
  org: string,
  path: string = consentStorePath(),
  now: Date = new Date(),
): Promise<ConsentRecord | null> => {
  if (org.trim().length === 0) return null;
  const store = await loadConsentStore(path);
  const record = store.orgs[normalizeOrg(org)];
  if (record === undefined) return null;
  if (isExpired(record, now)) return null;
  return record;
};

/** True iff `org` has a non-expired standing live-plane grant. */
export const hasLiveConsent = async (
  org: string,
  path: string = consentStorePath(),
): Promise<boolean> => (await getLiveGrant(org, path)) !== null;

/** True iff the grant covers every required scope. */
export const grantHasScopes = (
  grant: ConsentRecord,
  required: readonly LiveScope[],
): boolean => required.every((s) => grant.scopes.includes(s));

/** Sorted list of orgs that currently hold a non-expired grant. */
export const listConsentedOrgs = async (
  path: string = consentStorePath(),
  now: Date = new Date(),
): Promise<readonly string[]> => {
  const store = await loadConsentStore(path);
  return Object.entries(store.orgs)
    .filter(([, record]) => !isExpired(record, now))
    .map(([key]) => key)
    .sort();
};

/** Atomically write the store (temp file + rename), creating the dir. */
const writeStore = async (
  store: ConsentStore,
  path: string,
): Promise<Result<ConsentStore, ConsentError>> => {
  try {
    await mkdir(dirname(path), { recursive: true, mode: CONSENT_DIR_MODE });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: CONSENT_FILE_MODE,
    });
    await rename(tmp, path);
    await hardenConsentPath(path);
    return ok(store);
  } catch (cause) {
    return err({
      kind: 'write-failed',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

export interface GrantLiveConsentOptions {
  readonly grantedBy?: string;
  readonly path?: string;
  /** Salesforce Org Id bound at grant (`00D…`). Required outside tests. */
  readonly orgId?: string | null;
  /** Authenticated username bound at grant. */
  readonly principalUsername?: string | null;
  /** Scopes to authorize (default `['aggregate']`). Step-up merges with existing. */
  readonly scopes?: readonly LiveScope[];
  /** Hours until expiry (default {@link DEFAULT_GRANT_TTL_HOURS}). */
  readonly expiresInHours?: number;
  /** Absolute expiry override (ISO). Wins over expiresInHours when set. */
  readonly expiresAt?: string;
  /** Fixed grant id (tests). */
  readonly grantId?: string;
  /** Clock override (tests). */
  readonly now?: Date;
  /**
   * When true (default), step-up merges scopes with any existing non-expired
   * grant for the same OrgId binding. Cross-OrgId merge is always refused;
   * overwriting with mergeScopes:false mints a new grantId.
   */
  readonly mergeScopes?: boolean;
}

/**
 * Grant standing live-plane consent for `org`. Persists immediately.
 * Step-up: re-grant with additional scopes merges into the existing record.
 */
export const grantLiveConsent = async (
  org: string,
  opts: GrantLiveConsentOptions = {},
): Promise<Result<ConsentStore, ConsentError>> => {
  const key = normalizeOrg(org);
  if (key.length === 0) {
    return err({
      kind: 'invalid-grant',
      message: 'Cannot grant consent for an empty org alias.',
    });
  }
  const path = opts.path ?? consentStorePath();
  const now = opts.now ?? new Date();
  const store = await loadConsentStore(path);
  const existing = store.orgs[key];
  const merge = opts.mergeScopes !== false;
  const incoming = normalizeScopes(opts.scopes);
  // Never inherit scopes from a prior grant bound to a different OrgId.
  const sameOrgBinding =
    existing === undefined ||
    existing.orgId === null ||
    opts.orgId === undefined ||
    opts.orgId === null ||
    orgIdsMatch(existing.orgId, opts.orgId);
  if (
    merge &&
    existing !== undefined &&
    !isExpired(existing, now) &&
    !sameOrgBinding
  ) {
    return err({
      kind: 'invalid-grant',
      message:
        `Refusing to merge live consent for '${org}': stored OrgId ` +
        `${existing.orgId ?? '(none)'} does not match the authenticated OrgId ` +
        `${opts.orgId ?? '(none)'}. Revoke the prior grant and re-grant.`,
    });
  }
  const scopes =
    merge && existing !== undefined && !isExpired(existing, now) && sameOrgBinding
      ? normalizeScopes([...existing.scopes, ...incoming])
      : incoming;

  const expiresAt =
    opts.expiresAt ??
    new Date(
      now.getTime() +
        (opts.expiresInHours ?? DEFAULT_GRANT_TTL_HOURS) * 60 * 60 * 1000,
    ).toISOString();

  const reuseGrantId =
    sameOrgBinding && existing !== undefined && !isExpired(existing, now);
  const next: ConsentStore = {
    version: STORE_VERSION,
    orgs: {
      ...store.orgs,
      [key]: {
        grantedAt: now.toISOString(),
        grantedBy: opts.grantedBy ?? 'user',
        grantId: opts.grantId ?? (reuseGrantId ? existing.grantId : randomUUID()),
        orgId: opts.orgId !== undefined ? opts.orgId : (existing?.orgId ?? null),
        principalUsername:
          opts.principalUsername !== undefined
            ? opts.principalUsername
            : (existing?.principalUsername ?? null),
        scopes,
        expiresAt,
      },
    },
  };
  return writeStore(next, path);
};

/** Revoke consent for `org`. Idempotent (no-op if absent). */
export const revokeLiveConsent = async (
  org: string,
  opts: { readonly path?: string } = {},
): Promise<Result<ConsentStore, ConsentError>> => {
  const key = normalizeOrg(org);
  const path = opts.path ?? consentStorePath();
  const store = await loadConsentStore(path);
  if (!Object.prototype.hasOwnProperty.call(store.orgs, key)) {
    return ok(store);
  }
  const nextOrgs = { ...store.orgs };
  delete nextOrgs[key];
  return writeStore({ version: STORE_VERSION, orgs: nextOrgs }, path);
};

/** Build the disclosure block stamped onto live results. */
export const describeLiveGrant = (
  grant: ConsentRecord | null,
  source: 'consent' | 'env',
): LiveGrantDisclosure | null => {
  if (source === 'env') {
    // Env bypass does not verify a stored OrgId — never cite one as if it did.
    return {
      grantId: 'env:SFI_LIVE_PLANE_ENABLED',
      orgId: null,
      principalUsername: null,
      scopes: grant?.scopes ?? [...LIVE_SCOPES],
      expiresAt: grant?.expiresAt ?? 'session',
      source: 'env',
    };
  }
  if (grant === null) return null;
  return {
    grantId: grant.grantId,
    orgId: grant.orgId,
    principalUsername: grant.principalUsername,
    scopes: grant.scopes,
    expiresAt: grant.expiresAt,
    source: 'consent',
  };
};

/**
 * Explicit scope allowlist for live / hybrid tools (AUDIT Wave 3).
 * Unmapped tools are DENIED — never defaulted to aggregate (fail-open).
 */
export const LIVE_TOOL_REQUIRED_SCOPES: Readonly<
  Record<string, readonly LiveScope[]>
> = Object.freeze({
  // sample — arbitrary / record-level row reads
  'sfi.live_sample': Object.freeze(['sample'] as const),
  'sfi.live_field_history': Object.freeze(['sample'] as const),

  // users — person-identifying rosters / named individuals
  'sfi.live_inactive_users': Object.freeze(['users'] as const),
  'sfi.live_permset_holders': Object.freeze(['users'] as const),
  'sfi.live_user_permsets': Object.freeze(['users'] as const),
  'sfi.live_zombie_accounts': Object.freeze(['users'] as const),
  'sfi.live_group_members': Object.freeze(['users'] as const),
  'sfi.live_record_access': Object.freeze(['users'] as const),
  // PLATFORM-ACCESS-ORACLE: `UserEntityAccess` is keyed on a named
  // individual's UserId and returns that person's effective access — the
  // same identity class as live_record_access / live_user_permsets, so it
  // takes `users`, NOT `aggregate`. It reads no record rows, so `sample` is
  // not required on top. No new scope is introduced.
  'sfi.live_access_oracle': Object.freeze(['users'] as const),
  'sfi.live_record_shares': Object.freeze(['users'] as const),
  'sfi.live_owner_breakdown': Object.freeze(['users'] as const),
  'sfi.live_setup_audit_trail': Object.freeze(['audit'] as const),
  'sfi.live_license_usage': Object.freeze(['users'] as const),

  // aggregate — counts / limits / non-PII aggregates
  'sfi.live_describe': Object.freeze(['aggregate'] as const),
  'sfi.live_stale_check': Object.freeze(['aggregate'] as const),
  'sfi.live_count': Object.freeze(['aggregate'] as const),
  'sfi.live_field_population': Object.freeze(['aggregate'] as const),
  'sfi.live_group_count': Object.freeze(['aggregate'] as const),
  'sfi.live_stale_records': Object.freeze(['aggregate'] as const),
  'sfi.live_recent_activity': Object.freeze(['aggregate'] as const),
  'sfi.live_aggregate': Object.freeze(['aggregate'] as const),
  'sfi.live_duplicate_check': Object.freeze(['aggregate'] as const),
  'sfi.live_scheduled_jobs': Object.freeze(['aggregate'] as const),
  'sfi.live_storage_by_object': Object.freeze(['aggregate'] as const),
  'sfi.live_org_limits': Object.freeze(['aggregate'] as const),
  'sfi.live_data_skew': Object.freeze(['aggregate'] as const),
  'sfi.live_security_exposure': Object.freeze(['aggregate'] as const),
  'sfi.live_consent': Object.freeze(['aggregate'] as const),
  'sfi.live_report_usage': Object.freeze(['aggregate'] as const),
  'sfi.live_folder_access': Object.freeze(['aggregate'] as const),
  'sfi.live_email_template_usage': Object.freeze(['aggregate'] as const),
  'sfi.live_org_health': Object.freeze(['aggregate'] as const),
  'sfi.live_automation_fired': Object.freeze(['aggregate'] as const),
  'sfi.live_picklist_usage': Object.freeze(['aggregate'] as const),
  'sfi.live_budget': Object.freeze(['aggregate'] as const),
  'sfi.live_drift_check': Object.freeze(['aggregate'] as const),

  // hybrid / live-primary non-live_* tools that call probeLiveAccess
  'sfi.blast_radius_live': Object.freeze(['aggregate'] as const),
  'sfi.fleet_drift_ranking': Object.freeze(['aggregate'] as const),
  'sfi.coverage_report': Object.freeze(['aggregate'] as const),
  'sfi.unused_fields_deep': Object.freeze(['aggregate'] as const),
  'sfi.field_cleanup_candidates': Object.freeze(['aggregate'] as const),
  'sfi.what_if_make_field_required': Object.freeze(['aggregate'] as const),
  'sfi.safe_to_delete_field': Object.freeze(['aggregate'] as const),
  'sfi.field_change_advisor': Object.freeze(['aggregate'] as const),
});

/**
 * Map a live / hybrid tool name to the scopes it requires.
 * Returns `null` when the tool has no explicit mapping (fail-closed).
 */
export const requiredScopesForTool = (
  toolName: string,
): readonly LiveScope[] | null => {
  const mapped = LIVE_TOOL_REQUIRED_SCOPES[toolName];
  return mapped === undefined ? null : mapped;
};
