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
 * ## Opt-in adoption counter (default OFF)
 *
 * After a **fresh** registry check (never on a cache hit), if — and only if —
 * `SFI_TELEMETRY_OPTIN=1` **and** `SFI_TELEMETRY_ENDPOINT` is set, a second
 * fire-and-forget POST may ping a hit-counter endpoint. Payload is a UTC day
 * bucket only (`{ event: "version_check", bucket: "YYYY-MM-DD" }`) — no client
 * id, no org/vault data, no IP storage on the client. See
 * `docs/configuration.md` ("Opt-in version-check counter"). The Cloudflare
 * Worker + KV backend is deferred; without an endpoint the opt-in flag is a
 * no-op.
 *
 * ## What it never does by default
 *
 *   - No telemetry leaves the machine unless both opt-in env vars are set.
 *   - The default path is still a plain GET of the public registry document.
 *   - No vault or org metadata is read or written.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { get as httpsGet, request as httpsRequest } from 'node:https';
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

/** Default network budget for the opt-in adoption counter POST. */
const DEFAULT_TELEMETRY_TIMEOUT_MS = 2000;

/**
 * Body shape for the opt-in version-check counter. Documented in
 * docs/configuration.md — keep this the only payload the client ever sends.
 */
export interface VersionCheckCounterPayload {
  /** Fixed event name — a hit means "a fresh npm version-check happened". */
  readonly event: 'version_check';
  /** UTC calendar day (`YYYY-MM-DD`) for bucketed increments; not a client id. */
  readonly bucket: string;
}

/**
 * Injectable POST for the opt-in counter (tests stub this; production uses
 * a bounded HTTPS POST). Failures must never reject into the update path.
 */
export type VersionCheckCounterPoster = (
  endpoint: string,
  payload: VersionCheckCounterPayload,
) => Promise<void>;

/**
 * Whether the opt-in adoption counter is armed: explicit `SFI_TELEMETRY_OPTIN=1`
 * **and** a non-empty `SFI_TELEMETRY_ENDPOINT`. Default is off; missing endpoint
 * keeps the flag a documented no-op until Worker+KV ships.
 */
export const isVersionCheckCounterEnabled = (): boolean => {
  if (process.env['SFI_TELEMETRY_OPTIN'] !== '1') return false;
  const endpoint = process.env['SFI_TELEMETRY_ENDPOINT'];
  return endpoint !== undefined && endpoint !== '';
};

/** UTC day bucket string for the counter payload. */
export const versionCheckCounterBucket = (now: Date = new Date()): string =>
  now.toISOString().slice(0, 10);

/**
 * Build the documented counter payload. Exported so docs/tests stay in sync
 * with the only shape the client will ever send.
 */
export const buildVersionCheckCounterPayload = (
  now: Date = new Date(),
): VersionCheckCounterPayload => ({
  event: 'version_check',
  bucket: versionCheckCounterBucket(now),
});

/**
 * POST `{ event, bucket }` to an https endpoint with a hard timeout. Resolves
 * on any outcome (including network failure) — the adoption counter is
 * best-effort and must never affect the update check.
 */
const defaultCounterPoster = (
  endpoint: string,
  payload: VersionCheckCounterPayload,
  timeoutMs: number = DEFAULT_TELEMETRY_TIMEOUT_MS,
): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      finish();
      return;
    }
    // Production Worker will be https; refuse anything else in the default poster.
    if (url.protocol !== 'https:') {
      finish();
      return;
    }

    const body = JSON.stringify(payload);
    const timer = setTimeout(() => {
      req.destroy();
      finish();
    }, timeoutMs);
    timer.unref?.();

    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          accept: 'application/json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          clearTimeout(timer);
          finish();
        });
        res.on('error', () => {
          clearTimeout(timer);
          finish();
        });
      },
    );
    req.on('error', () => {
      clearTimeout(timer);
      finish();
    });
    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timer);
      finish();
    });
    req.write(body);
    req.end();
  });

/**
 * Fire-and-forget opt-in counter ping. No-op unless both env gates pass.
 * Never throws; never awaits into the caller's critical path when used via
 * `void maybePing…`.
 */
export const maybePingVersionCheckCounter = async (
  poster: VersionCheckCounterPoster = defaultCounterPoster,
): Promise<boolean> => {
  if (!isVersionCheckCounterEnabled()) return false;
  const endpoint = process.env['SFI_TELEMETRY_ENDPOINT'];
  if (endpoint === undefined || endpoint === '') return false;
  try {
    await poster(endpoint, buildVersionCheckCounterPayload());
    return true;
  } catch {
    return false;
  }
};

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
 * Optional hooks for {@link checkForUpdate}. Tests inject a hermetic fetcher
 * and/or counter poster; production uses the defaults.
 */
export interface CheckForUpdateOptions {
  /** Override the registry fetch (hermetic tests). */
  readonly fetcher?: LatestVersionFetcher;
  /** Override the opt-in counter POST (hermetic tests). */
  readonly counterPoster?: VersionCheckCounterPoster;
}

/**
 * Run the update check for the given running version. Fail-silent and
 * offline-first: a disabled check, a cache hit, or any network failure all
 * return a well-formed {@link UpdateCheckResult} rather than throwing.
 *
 * Order: opt-out / CI short-circuit → fresh cache → one bounded registry GET
 * (whose result is cached) → optional opt-in counter ping on a fresh hit.
 *
 * @param currentVersion The running build's version (e.g. from `package.json`).
 * @param fetcherOrOptions Override the registry fetch, or an options bag with
 *   fetcher + counterPoster. The 2-arg fetcher form is preserved for callers.
 * @example
 *   const r = await checkForUpdate('0.1.18');
 *   if (r.shouldUpdate) console.error(formatUpdateNotice(r));
 */
export const checkForUpdate = async (
  currentVersion: string,
  fetcherOrOptions: LatestVersionFetcher | CheckForUpdateOptions = {},
): Promise<UpdateCheckResult> => {
  const options: CheckForUpdateOptions =
    typeof fetcherOrOptions === 'function'
      ? { fetcher: fetcherOrOptions }
      : fetcherOrOptions;
  const fetcher = options.fetcher ?? (() => fetchLatestVersion());
  const counterPoster = options.counterPoster ?? defaultCounterPoster;

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

  // Fresh registry check only — never on cache hit / disable. Awaited but
  // fail-silent + bounded (~2s); when opt-in is off this is a sync no-op.
  await maybePingVersionCheckCounter(counterPoster);

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
