/**
 * Central network policy for sf-intelligence (AUDIT-F2).
 *
 * Every outbound path — npm update-check, Salesforce CLI spawn, REST/Tooling
 * fetch — must consult this module. Defaults are fail-closed: the MCP server
 * process runs with `networkMode=off` unless an operator elevates it.
 *
 * Modes:
 *   - `off`            — no outbound network (default for `sfi mcp`)
 *   - `updates-only`   — npm registry update-check only
 *   - `salesforce-read`— Salesforce retrieve / live read (refresh elevates here)
 *
 * `SFI_UPDATE_CHECK=1` is an opt-in that allows the `update-check` purpose even
 * when the mode is `off` (administered deployments). `SFI_NO_UPDATE_CHECK=1`
 * and CI markers still force-disable update checks.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Result } from '@sf-intelligence/contracts';

import { err, ok } from './result.js';

/** Process / scoped network posture. */
export type NetworkMode = 'off' | 'updates-only' | 'salesforce-read';

/** Why an outbound call is being attempted. */
export type NetworkPurpose =
  | 'update-check'
  | 'model-download'
  | 'metadata-retrieve'
  | 'live-query';

/** Context stamped on every policy decision (for audit / disclosure). */
export interface NetworkRequestContext {
  readonly purpose: NetworkPurpose;
  readonly toolName?: string;
  readonly orgId?: string;
  readonly consentId?: string;
}

/** Structured denial returned by {@link assertNetworkAllowed}. */
export interface NetworkDenied {
  readonly kind: 'network-denied';
  readonly mode: NetworkMode;
  readonly purpose: NetworkPurpose;
  readonly message: string;
}

const MODE_OVERRIDE = new AsyncLocalStorage<NetworkMode>();

const VALID_MODES: ReadonlySet<string> = new Set([
  'off',
  'updates-only',
  'salesforce-read',
]);

/**
 * Resolve the active network mode: scoped override (refresh) wins, else
 * `SFI_NETWORK_MODE`, else `off`.
 */
export const getNetworkMode = (): NetworkMode => {
  const override = MODE_OVERRIDE.getStore();
  if (override !== undefined) return override;
  const raw = process.env['SFI_NETWORK_MODE'];
  if (typeof raw === 'string' && VALID_MODES.has(raw)) {
    return raw as NetworkMode;
  }
  return 'off';
};

/**
 * Run `fn` with a temporary network-mode elevation (e.g. refresh →
 * `salesforce-read`). Nested calls nest; the outer mode restores on exit.
 */
export const withNetworkMode = async <T>(
  mode: NetworkMode,
  fn: () => Promise<T>,
): Promise<T> => MODE_OVERRIDE.run(mode, fn);

/** Synchronous variant for non-async call sites. */
export const withNetworkModeSync = <T>(mode: NetworkMode, fn: () => T): T =>
  MODE_OVERRIDE.run(mode, fn);

/**
 * Opt-in update-check gate (independent of mode elevation for retrieve/live).
 * True when the operator explicitly asked for update checks.
 */
export const isUpdateCheckOptedIn = (): boolean =>
  process.env['SFI_UPDATE_CHECK'] === '1' || getNetworkMode() === 'updates-only';

const CI_ENV_MARKERS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'DRONE',
  'JENKINS_URL',
  'TF_BUILD',
] as const;

/** Strong disable for update checks (opt-out + CI). */
export const isUpdateCheckForcedOff = (): boolean => {
  if (process.env['SFI_NO_UPDATE_CHECK'] === '1') return true;
  return CI_ENV_MARKERS.some((v) => {
    const val = process.env[v];
    return val !== undefined && val !== '';
  });
};

const purposeAllowed = (mode: NetworkMode, purpose: NetworkPurpose): boolean => {
  switch (purpose) {
    case 'update-check':
      // Opt-in flag elevates this purpose even under `off`.
      if (process.env['SFI_UPDATE_CHECK'] === '1' && !isUpdateCheckForcedOff()) {
        return true;
      }
      return mode === 'updates-only';
    case 'model-download':
      // Runtime never downloads models; build scripts are out of band.
      return false;
    case 'metadata-retrieve':
    case 'live-query':
      return mode === 'salesforce-read';
    default:
      return false;
  }
};

/**
 * Decide whether an outbound network operation may proceed.
 * Fail-closed: unknown purposes and `off` deny everything except opted-in
 * update-check.
 */
export const assertNetworkAllowed = (
  ctx: NetworkRequestContext,
): Result<void, NetworkDenied> => {
  if (ctx.purpose === 'update-check' && isUpdateCheckForcedOff()) {
    return err({
      kind: 'network-denied',
      mode: getNetworkMode(),
      purpose: ctx.purpose,
      message:
        'Update check disabled (SFI_NO_UPDATE_CHECK=1 or CI environment).',
    });
  }
  const mode = getNetworkMode();
  if (purposeAllowed(mode, ctx.purpose)) return ok(undefined);
  const hint =
    ctx.purpose === 'update-check'
      ? 'Set SFI_UPDATE_CHECK=1 or SFI_NETWORK_MODE=updates-only to opt in.'
      : ctx.purpose === 'model-download'
        ? 'Model download is not permitted at runtime; use the offline install path.'
        : 'Set SFI_NETWORK_MODE=salesforce-read (refresh elevates automatically).';
  return err({
    kind: 'network-denied',
    mode,
    purpose: ctx.purpose,
    message: `Network purpose '${ctx.purpose}' denied under networkMode='${mode}'. ${hint}`,
  });
};

/**
 * Human-readable disclosure of the active network posture for capabilities /
 * health surfaces.
 */
export const describeNetworkPolicy = (): {
  readonly mode: NetworkMode;
  readonly updateCheckOptedIn: boolean;
  readonly updateCheckForcedOff: boolean;
} => ({
  mode: getNetworkMode(),
  updateCheckOptedIn: isUpdateCheckOptedIn() && !isUpdateCheckForcedOff(),
  updateCheckForcedOff: isUpdateCheckForcedOff(),
});
