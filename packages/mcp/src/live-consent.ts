/**
 * One-time, per-org consent for the read-only live plane.
 *
 * The live plane never mutates the org — but it *queries the authenticated org
 * at call time*, so, unlike the offline vault, it must never run without
 * explicit user intent. Consent is granted once per org and persisted to a
 * vault-independent, user-level store, so it survives across sessions and is
 * available even before a vault exists (the install -> ask path).
 *
 * Trust posture: this store is the *only* thing that flips the live plane from
 * fail-closed to allowed (besides an explicit per-call `liveEnabled: true` or
 * the `SFI_LIVE_PLANE_ENABLED` env). It never auto-grants. A missing or corrupt
 * store reads as "no consent" — the gate stays closed. No function here throws.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';

/** Bumped only on a breaking change to the on-disk shape. */
const STORE_VERSION = 1;

/** One org's consent record. */
export interface ConsentRecord {
  /** ISO-8601 timestamp the consent was granted. */
  readonly grantedAt: string;
  /** Who granted it (default `user`); free-form provenance label. */
  readonly grantedBy: string;
}

/** The whole persisted store: a map of normalized org key -> record. */
export interface ConsentStore {
  readonly version: number;
  readonly orgs: Readonly<Record<string, ConsentRecord>>;
}

/** Failure shape for the mutating operations. */
export interface ConsentError {
  readonly kind: 'write-failed';
  readonly message: string;
}

const EMPTY_STORE: ConsentStore = Object.freeze({
  version: STORE_VERSION,
  orgs: Object.freeze({}),
});

/**
 * Absolute path of the consent store.
 *
 * `SFI_CONSENT_PATH` overrides it (tests point it at a temp file for
 * determinism); otherwise it is `~/.sf-intelligence/live-consent.json`. The
 * location is deliberately vault-independent so consent works in the no-vault
 * install -> ask path and is shared across every vault for the same org.
 */
export const consentStorePath = (): string => {
  const override = process.env['SFI_CONSENT_PATH'];
  if (typeof override === 'string' && override.length > 0) return override;
  return join(homedir(), '.sf-intelligence', 'live-consent.json');
};

/**
 * Normalize an org alias/username to a stable key. Salesforce usernames are
 * case-insensitive, and `resolveOrg` yields whatever the caller passed or the
 * vault's `sourceOrg`; lower-casing + trimming avoids spurious misses.
 */
const normalizeOrg = (org: string): string => org.trim().toLowerCase();

/**
 * Read and parse the store. Returns an empty store on any failure (missing
 * file, unreadable, malformed JSON, wrong shape) — fail-closed by design.
 */
export const loadConsentStore = async (
  path: string = consentStorePath(),
): Promise<ConsentStore> => {
  try {
    const raw = await readFile(path, 'utf8');
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
    const obj = parsed as { version?: unknown; orgs: Record<string, ConsentRecord> };
    return {
      version: typeof obj.version === 'number' ? obj.version : STORE_VERSION,
      orgs: obj.orgs,
    };
  } catch {
    return EMPTY_STORE;
  }
};

/** True iff `org` has standing live-plane consent. Empty org -> false. */
export const hasLiveConsent = async (
  org: string,
  path: string = consentStorePath(),
): Promise<boolean> => {
  if (org.trim().length === 0) return false;
  const store = await loadConsentStore(path);
  return Object.prototype.hasOwnProperty.call(store.orgs, normalizeOrg(org));
};

/** Sorted list of orgs that currently hold consent (normalized keys). */
export const listConsentedOrgs = async (
  path: string = consentStorePath(),
): Promise<readonly string[]> => {
  const store = await loadConsentStore(path);
  return Object.keys(store.orgs).sort();
};

/** Atomically write the store (temp file + rename), creating the dir. */
const writeStore = async (
  store: ConsentStore,
  path: string,
): Promise<Result<ConsentStore, ConsentError>> => {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return ok(store);
  } catch (cause) {
    return err({
      kind: 'write-failed',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

/**
 * Grant standing live-plane consent for `org`. Idempotent (re-granting just
 * refreshes the timestamp). Persists immediately.
 */
export const grantLiveConsent = async (
  org: string,
  opts: { readonly grantedBy?: string; readonly path?: string } = {},
): Promise<Result<ConsentStore, ConsentError>> => {
  const key = normalizeOrg(org);
  if (key.length === 0) {
    return err({ kind: 'write-failed', message: 'Cannot grant consent for an empty org alias.' });
  }
  const path = opts.path ?? consentStorePath();
  const store = await loadConsentStore(path);
  const next: ConsentStore = {
    version: STORE_VERSION,
    orgs: {
      ...store.orgs,
      [key]: { grantedAt: new Date().toISOString(), grantedBy: opts.grantedBy ?? 'user' },
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
