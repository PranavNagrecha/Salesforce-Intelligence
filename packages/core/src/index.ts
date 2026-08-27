/**
 * @sf-intelligence/core
 *
 * The smallest shared runtime layer: the project's error-handling convention.
 *
 * `Result<T, E>` (re-exported from `@sf-intelligence/contracts`, where the type
 * itself is frozen) plus the `ok()` / `err()` constructors here are how every
 * package returns a recoverable failure WITHOUT throwing. The rule across the
 * codebase: return `err(...)` for any error a caller is expected to handle
 * (a missing file, a malformed metadata shape, a closed live gate); reserve
 * `throw` for true invariant violations the caller cannot recover from.
 *
 * This package depends only on `contracts` and has no I/O, so it sits at the
 * bottom of the dependency graph and is safe to import anywhere.
 */
export type { Result } from '@sf-intelligence/contracts';

export { ok, err } from './result.js';

export { isCustomFieldApiName } from './api-names.js';

export {
  execHelper,
  escapeWindowsArg,
  isWindows,
  type ExecCommand,
  type ExecHelperOptions,
} from './exec-helper.js';

// Portable path primitives. Every "split a path" / "render a path relative to"
// in the product routes through here — six hand-rolled spellings across five
// packages had drifted, and the Windows-only failures were silent (a metadata
// type extracting to zero rows, a deploy gate passing because it parsed
// nothing, a username leaking into every response). Guarded by
// `scripts/check-portability.mjs`.
export {
  collapseHome,
  hasAdjacentSegments,
  hasAnySegment,
  isPathWithin,
  PATH_SEPARATORS,
  splitPathSegments,
  toPosixPath,
  toRelativePosix,
} from './path-portable.js';

export {
  buildVersionCheckCounterPayload,
  checkForUpdate,
  compareVersions,
  formatUpdateNotice,
  getStateDir,
  isVersionCheckCounterEnabled,
  maybePingVersionCheckCounter,
  versionCheckCounterBucket,
  type CheckForUpdateOptions,
  type LatestVersionFetcher,
  type UpdateCheckResult,
  type VersionCheckCounterPayload,
  type VersionCheckCounterPoster,
} from './update-notifier.js';

export {
  assertNetworkAllowed,
  describeNetworkPolicy,
  getNetworkMode,
  isUpdateCheckForcedOff,
  isUpdateCheckOptedIn,
  withNetworkMode,
  withNetworkModeSync,
  type NetworkDenied,
  type NetworkMode,
  type NetworkPurpose,
  type NetworkRequestContext,
} from './network-policy.js';
