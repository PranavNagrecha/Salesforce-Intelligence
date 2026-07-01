/**
 * Update notifier — the single npm-version-check seam.
 *
 * ## What it does
 *
 * On MCP-server / CLI startup the plugin can check npm for a newer published
 * `sf-intelligence` and, when one exists, surface a one-line "update available"
 * nudge. The check is:
 *
 *   - **Opt-out** via `SFI_NO_UPDATE_CHECK=1`, and **auto-off in CI** (any of the
 *     usual CI env markers) so a build machine never reaches out to the network.
 *   - **Fail-silent**: a network error, timeout, or malformed response returns a
 *     "no update" result with the error attached — it NEVER throws and NEVER
 *     fails the server or command.
 *   - **Offline-first**: a fresh (< 24h) cache hit answers with zero network I/O.
 *     A missing / stale / corrupt cache triggers one bounded (~3s) registry GET,
 *     whose result is then cached in `~/.sf-intelligence/update-check.json`
 *     (the same state dir the live-plane consent store uses).
 *
 * ## What it never does
 *
 *   - No telemetry, user identifiers, or org data leave the machine — the only
 *     request is a plain GET of the public registry document.
 *   - No vault or org metadata is read or written.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The outcome of a version check: the latest version discovered, whether it is
 * newer than the running build, whether the answer came from the local cache,
 * and any error that occurred (fail-silent — an error still yields a result).
 */
export interface UpdateCheckResult {
  /** Whether a newer version than the running build is available. */
  readonly shouldUpdate: boolean;
  /** The latest version on npm, or `null` when the check failed or was disabled. */
  readonly latestVersion: string | null;
  /** Whether this result came from the local cache (vs. a fresh network check). */
  readonly cached: boolean;
  /** Any error during the check (network, parse, …); `null` on success/disabled. */
  readonly error: Error | null;
}

/** Persisted cache entry: the last check's latest version + when it was taken. */
interface UpdateCheckCache {
  /** ISO 8601 timestamp when the check was performed. */
  readonly checkedAt: string;
  /** The latest version discovered on npm. */
  readonly latestVersion: string;
  /** Whether that version was newer than the build that wrote the cache. */
  readonly shouldUpdate: boolean;
}

/** The npm registry document URL for the published package. */
const REGISTRY_URL = 'https://registry.npmjs.org/sf-intelligence';

/** Cache freshness window — a check at most once per 24h. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Default network budget for the registry GET (fail-silent past this). */
const DEFAULT_FETCH_TIMEOUT_MS = 3000;

/**
 * Directory for the plugin's persistent local state (update-check cache,
 * live-plane consent, …): `~/.sf-intelligence`. Created best-effort; a failure
 * here is swallowed and surfaces later as a graceful cache read/write miss.
 */
export const getStateDir = (): string => {
  const dir = join(homedir(), '.sf-intelligence');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Permission denied etc. — the later read/write degrades gracefully.
  }
  return dir;
};

/**
 * Absolute path to the update-check cache file. `SFI_UPDATE_CACHE_PATH`
 * overrides it (tests point it at a temp file for determinism); otherwise it is
 * `~/.sf-intelligence/update-check.json`, mirroring the live-consent store's
 * `SFI_CONSENT_PATH` convention.
 */
const getUpdateCachePath = (): string => {
  const override = process.env['SFI_UPDATE_CACHE_PATH'];
  if (override !== undefined && override !== '') return override;
  return join(getStateDir(), 'update-check.json');
};

/**
 * Fetches the latest published version, or `null` when it cannot be determined.
 * The default implementation hits the npm registry; tests inject a stub so the
 * check is fully hermetic (never reaches the network). Mirrors the codebase's
 * injectable-dependency seams (`ListOrgs`, `ExecCommand`).
 */
export type LatestVersionFetcher = () => Promise<string | null>;

/**
 * Fetch the latest published version from the npm registry, or `null` on any
 * failure (network error, timeout, non-JSON body, missing `dist-tags.latest`).
 * The single `setTimeout` guarantees the promise settles within `timeoutMs`
 * even if the socket hangs, and destroys the request so nothing leaks.
 */
const fetchLatestVersion = (
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<string | null> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    const req = httpsGet(REGISTRY_URL, (res) => {
      // Any non-200 (404, registry error) is a silent "no answer".
      if (res.statusCode !== 200) {
        res.resume();
        clearTimeout(timer);
        finish(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(body) as {
            readonly 'dist-tags'?: { readonly latest?: unknown };
          };
          const latest = parsed['dist-tags']?.latest;
          finish(typeof latest === 'string' ? latest : null);
        } catch {
          finish(null);
        }
      });
      res.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
    });
    req.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });

/**
 * Compare two semver strings on `MAJOR.MINOR.PATCH`. Returns `true` iff
 * `latest` is strictly newer than `current`. Pre-release / build metadata is
 * ignored (`0.1.0-beta` reads as `0.1.0`). Malformed input on either side
 * returns `false` — an unparseable version never nags the user to update.
 */
export const compareVersions = (current: string, latest: string): boolean => {
  const parse = (
    v: string,
  ): { readonly major: number; readonly minor: number; readonly patch: number } | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    if (m === null) return null;
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
    };
  };

  const c = parse(current);
  const l = parse(latest);
  if (c === null || l === null) return false;

  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  return l.patch > c.patch;
};

/**
 * Read the cached result if present and fresher than {@link CACHE_TTL_MS}.
 * Returns `null` when the cache is missing, unreadable, corrupt, shape-invalid,
 * or stale — every one of which triggers a fresh check upstream.
 */
const readUpdateCache = async (): Promise<UpdateCheckCache | null> => {
  const path = getUpdateCachePath();
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<UpdateCheckCache>;
    if (
      typeof parsed.checkedAt !== 'string' ||
      typeof parsed.latestVersion !== 'string' ||
      typeof parsed.shouldUpdate !== 'boolean'
    ) {
      return null;
    }
    const checkedMs = Date.parse(parsed.checkedAt);
    if (Number.isNaN(checkedMs)) return null;
    if (Date.now() - checkedMs > CACHE_TTL_MS) return null; // stale
    return {
      checkedAt: parsed.checkedAt,
      latestVersion: parsed.latestVersion,
      shouldUpdate: parsed.shouldUpdate,
    };
  } catch {
    return null;
  }
};

/** Persist a check result. Write failures (permission etc.) are swallowed. */
const writeUpdateCache = async (entry: UpdateCheckCache): Promise<void> => {
  try {
    await writeFile(getUpdateCachePath(), JSON.stringify(entry), 'utf8');
  } catch {
    // A cache-write failure only costs a redundant check next time.
  }
};

/**
 * The CI env markers that auto-disable the check. A build machine must never
 * make an outbound npm request or print an update nudge into CI logs.
 */
const CI_ENV_MARKERS: readonly string[] = [
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
];

/**
 * Whether the update check should be skipped: explicit opt-out
 * (`SFI_NO_UPDATE_CHECK=1`) or any CI marker being set to a non-empty value.
 */
const shouldDisableCheck = (): boolean => {
  if (process.env['SFI_NO_UPDATE_CHECK'] === '1') return true;
  return CI_ENV_MARKERS.some((v) => {
    const val = process.env[v];
    return val !== undefined && val !== '';
  });
};

/**
 * Run the update check for the given running version. Fail-silent and
 * offline-first: a disabled check, a cache hit, or any network failure all
 * return a well-formed {@link UpdateCheckResult} rather than throwing.
 *
 * Order: opt-out / CI short-circuit → fresh cache → one bounded registry GET
 * (whose result is cached).
 *
 * @param currentVersion The running build's version (e.g. from `package.json`).
 * @param fetcher Override the registry fetch (tests inject a stub for hermetic
 *   runs); defaults to the real npm-registry GET.
 * @example
 *   const r = await checkForUpdate('0.1.18');
 *   if (r.shouldUpdate) console.error(formatUpdateNotice(r));
 */
export const checkForUpdate = async (
  currentVersion: string,
  fetcher: LatestVersionFetcher = () => fetchLatestVersion(),
): Promise<UpdateCheckResult> => {
  if (shouldDisableCheck()) {
    return { shouldUpdate: false, latestVersion: null, cached: false, error: null };
  }

  const cached = await readUpdateCache();
  if (cached !== null) {
    return {
      shouldUpdate: cached.shouldUpdate,
      latestVersion: cached.latestVersion,
      cached: true,
      error: null,
    };
  }

  let latest: string | null = null;
  let error: Error | null = null;
  try {
    latest = await fetcher();
  } catch (e) {
    // fetchLatestVersion never rejects, but keep the belt-and-braces guard so
    // the contract "checkForUpdate never throws" holds even if that changes.
    error = e instanceof Error ? e : new Error(String(e));
  }

  if (latest === null) {
    return { shouldUpdate: false, latestVersion: null, cached: false, error };
  }

  const shouldUpdate = compareVersions(currentVersion, latest);
  await writeUpdateCache({
    checkedAt: new Date().toISOString(),
    latestVersion: latest,
    shouldUpdate,
  });

  return { shouldUpdate, latestVersion: latest, cached: false, error: null };
};

/**
 * Format the one-line update nudge for a result, or `null` when no update is
 * available (so a caller can `const n = ...; if (n) print(n)`).
 */
export const formatUpdateNotice = (result: UpdateCheckResult): string | null => {
  if (!result.shouldUpdate || result.latestVersion === null) return null;
  return (
    `Update available: sf-intelligence@${result.latestVersion} — run ` +
    `\`npm i -g sf-intelligence@latest\`, then \`/sfi-refresh\` to rebuild your ` +
    `vault with the new version's extractors.`
  );
};
