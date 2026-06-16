/**
 * The v1.7 Tooling API HTTP client.
 *
 * Per `docs/vendor/salesforce-metadata/ToolingApi.md`, this client owns
 * three concerns:
 *
 *   1. Bearer-token Authorization against
 *      `{instanceUrl}/services/data/v{apiVersion}/tooling/...`.
 *   2. Pagination — the Tooling API's `QueryResult` envelope carries
 *      `done: false` and a `nextRecordsUrl` when results exceed the
 *      per-page cap; the client loops until `done: true`.
 *   3. Error translation — 401 (token expired) → `auth-expired`; 429
 *      (rate limit) → `rate-limit` with the Sforce-Limit-Info header
 *      parsed; malformed SOQL or 5xx → `query-failed` /
 *      `internal-error`.
 *
 * The fetch implementation is injected via `FetchFn` so tests stub the
 * HTTP transport. Production code uses Node's built-in `fetch` (Node
 * 20+ ships it natively per the workspace's `engines.node` constraint).
 *
 * Two endpoints are exposed:
 *   - `query<T>(soql)` — generic Tooling API SOQL, the enrichment
 *     pass's primary read path.
 *   - `getDependencies(componentId)` — the
 *     `MetadataComponentDependency` lookup keyed by
 *     `RefMetadataComponentId`. Returns the same row shape as the
 *     general query but typed as `Dependency` for the consumer.
 */

import { err, ok, type Result } from '@sf-intelligence/core';

import type { ToolingApiAuth } from './auth.js';

/**
 * Error variants the client can return. Distinguished so the caller can
 * decide whether to surface a fatal error, retry, or back off.
 *
 *   - `auth-expired`: a 401 came back; the caller should re-run
 *     `getAuthFromSfCli` and retry. The client itself does NOT loop
 *     on 401 because it has no auth-fetcher reference; the retry
 *     belongs at the enrichment-loop layer.
 *   - `rate-limit`: a 429 came back. `retryAfterMs` carries the
 *     suggested sleep time (parsed from `Sforce-Limit-Info` or the
 *     `Retry-After` header when present); the caller sleeps and
 *     retries.
 *   - `query-failed`: the SOQL itself was malformed (e.g.,
 *     `INVALID_FIELD`); the caller marks the affected type as
 *     "unable to enrich" and moves on.
 *   - `network-error`: the fetch itself rejected (DNS, TCP, abort).
 *   - `malformed-response`: 2xx came back but the body did not match
 *     the `QueryResult` shape.
 *   - `internal-error`: 5xx came back; the caller may retry with
 *     backoff (the client does NOT retry internally — that policy
 *     belongs at the enrichment-loop layer).
 */
export interface ToolingApiError {
  readonly kind:
    | 'auth-expired'
    | 'rate-limit'
    | 'query-failed'
    | 'network-error'
    | 'malformed-response'
    | 'internal-error';
  readonly message: string;
  /** Populated only for `rate-limit` errors. */
  readonly retryAfterMs?: number;
  /** HTTP status code when applicable. */
  readonly status?: number;
}

/**
 * A `MetadataComponentDependency` row, as returned by the dependency
 * endpoint. Shape mirrors the Tooling API's record layout per
 * `docs/vendor/salesforce-metadata/MetadataComponentDependency.md`.
 *
 *   - `Id`: the dependency row's own Tooling API id.
 *   - `MetadataComponentId` / `MetadataComponentType` / `MetadataComponentName`:
 *     the SOURCE side — the component that depends on the target.
 *   - `RefMetadataComponentId` / `RefMetadataComponentType` /
 *     `RefMetadataComponentName`: the TARGET side — the component
 *     depended upon. (Tooling API direction: Source → Target.)
 */
export interface Dependency {
  readonly Id: string;
  readonly MetadataComponentId: string;
  readonly MetadataComponentType: string;
  readonly MetadataComponentName: string;
  readonly RefMetadataComponentId: string;
  readonly RefMetadataComponentType: string;
  readonly RefMetadataComponentName: string;
}

/** Public client surface. */
export interface ToolingApiClient {
  query<T>(soql: string): Promise<Result<readonly T[], ToolingApiError>>;
  getDependencies(
    componentId: string,
  ): Promise<Result<readonly Dependency[], ToolingApiError>>;
}

/**
 * The fetch shape the client depends on. Matches the Node 20 / browser
 * global `fetch` signature so production code passes it through
 * directly and tests substitute a stub.
 */
export type FetchFn = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  },
) => Promise<FetchResponse>;

/** Minimal Response shape the client touches. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * Factory options for `createToolingApiClient`. The `fetch` parameter
 * defaults to the global `fetch` when omitted; tests pass a stub.
 */
export interface CreateClientOptions {
  readonly auth: ToolingApiAuth;
  readonly fetch?: FetchFn;
}

/**
 * The `QueryResult` envelope every `/tooling/query` response carries.
 * `nextRecordsUrl` is present when `done: false`; the client loops on
 * it until `done: true`.
 */
interface QueryResult<T> {
  readonly size?: number;
  readonly totalSize?: number;
  readonly done: boolean;
  readonly nextRecordsUrl?: string;
  readonly records: readonly T[];
}

/**
 * Construct a `ToolingApiClient` from an `auth` bundle. The returned
 * object closes over the bundle and the fetch implementation.
 *
 * @example
 *   const client = createToolingApiClient({ auth });
 *   const rows = await client.query<{ Id: string }>('SELECT Id FROM ApexClass');
 */
export const createToolingApiClient = (
  options: CreateClientOptions | ToolingApiAuth,
): ToolingApiClient => {
  const opts: CreateClientOptions =
    'auth' in options
      ? options
      : { auth: options as ToolingApiAuth };
  const auth = opts.auth;
  const fetchImpl: FetchFn = opts.fetch ?? (globalFetch());
  const versionPath = `/services/data/v${auth.apiVersion}/tooling`;
  const headers: Readonly<Record<string, string>> = Object.freeze({
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
  });

  const fetchAt = async (
    relativeUrl: string,
  ): Promise<Result<FetchResponse, ToolingApiError>> => {
    const fullUrl = relativeUrl.startsWith('http')
      ? relativeUrl
      : `${auth.instanceUrl}${relativeUrl}`;
    try {
      const response = await fetchImpl(fullUrl, { method: 'GET', headers });
      return ok(response);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return err({ kind: 'network-error', message: msg });
    }
  };

  const readBody = async (
    response: FetchResponse,
  ): Promise<Result<string, ToolingApiError>> => {
    try {
      return ok(await response.text());
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return err({ kind: 'malformed-response', message: `body read failed: ${msg}` });
    }
  };

  const classifyError = async (
    response: FetchResponse,
  ): Promise<ToolingApiError> => {
    const status = response.status;
    if (status === 401) {
      return {
        kind: 'auth-expired',
        message: 'Tooling API returned 401 — access token expired or invalid.',
        status,
      };
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(response);
      return {
        kind: 'rate-limit',
        message: 'Tooling API returned 429 — rate limit exceeded.',
        status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    let bodyHint = '';
    try {
      const body = await response.text();
      bodyHint = body.length > 0 ? ` body=${body.slice(0, 240)}` : '';
    } catch {
      // best-effort body extraction; failure to read does not change the
      // classification axis.
    }
    if (status >= 400 && status < 500) {
      return {
        kind: 'query-failed',
        message: `Tooling API returned ${status}.${bodyHint}`,
        status,
      };
    }
    return {
      kind: 'internal-error',
      message: `Tooling API returned ${status}.${bodyHint}`,
      status,
    };
  };

  const paginateQuery = async <T>(
    initialPath: string,
  ): Promise<Result<readonly T[], ToolingApiError>> => {
    const collected: T[] = [];
    let path: string | undefined = initialPath;
    // Bounded so a misbehaving server cannot trap the client in an
    // infinite loop. 200 pages × 2000/page = 400k records, an order of
    // magnitude beyond v1.7's expected scale.
    const PAGE_CAP = 200;
    for (let i = 0; i < PAGE_CAP; i++) {
      if (path === undefined) break;
      const responseResult = await fetchAt(path);
      if (!responseResult.ok) return err(responseResult.error);
      const response = responseResult.value;
      if (!response.ok) {
        return err(await classifyError(response));
      }
      const bodyResult = await readBody(response);
      if (!bodyResult.ok) return err(bodyResult.error);
      let parsed: QueryResult<T>;
      try {
        parsed = JSON.parse(bodyResult.value) as QueryResult<T>;
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        return err({
          kind: 'malformed-response',
          message: `JSON parse failed: ${msg}`,
        });
      }
      if (!Array.isArray(parsed.records)) {
        return err({
          kind: 'malformed-response',
          message: 'Tooling API response missing `records` array.',
        });
      }
      for (const record of parsed.records) collected.push(record);
      if (parsed.done === true) {
        path = undefined;
      } else if (
        typeof parsed.nextRecordsUrl === 'string' &&
        parsed.nextRecordsUrl.length > 0
      ) {
        path = parsed.nextRecordsUrl;
      } else {
        return err({
          kind: 'malformed-response',
          message:
            "Tooling API response is paginated (done: false) but carries no nextRecordsUrl.",
        });
      }
    }
    return ok(collected);
  };

  return {
    query: async <T>(soql: string) => {
      if (soql.length === 0) {
        return err({
          kind: 'query-failed',
          message: 'SOQL query is empty.',
        });
      }
      const initialPath = `${versionPath}/query?q=${encodeURIComponent(soql)}`;
      return paginateQuery<T>(initialPath);
    },
    getDependencies: async (componentId: string) => {
      if (componentId.length === 0) {
        return err({
          kind: 'query-failed',
          message: 'componentId is empty.',
        });
      }
      // The Tooling API's MetadataComponentDependency endpoint is just
      // a regular Tooling SOQL query against the dependency sObject;
      // `RefMetadataComponentId` is the WHERE-key. See
      // `docs/vendor/salesforce-metadata/MetadataComponentDependency.md`.
      // Escape backslash before the quote (order matters — prevents `\'` break-out).
      const escaped = componentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const soql =
        `SELECT Id, MetadataComponentId, MetadataComponentType, MetadataComponentName, ` +
        `RefMetadataComponentId, RefMetadataComponentType, RefMetadataComponentName ` +
        `FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${escaped}'`;
      const initialPath = `${versionPath}/query?q=${encodeURIComponent(soql)}`;
      return paginateQuery<Dependency>(initialPath);
    },
  };
};

/**
 * Lazy global-fetch lookup. Wrapped in a function so the import-time
 * environment check does not throw in older Node versions, and so the
 * default can be overridden by tests that exercise `createToolingApiClient`
 * without injecting a stub. Throws a clear message if `fetch` is
 * missing — Node 20+ ships it natively.
 */
const globalFetch = (): FetchFn => {
  const g = (globalThis as { fetch?: FetchFn }).fetch;
  if (g === undefined) {
    throw new Error(
      'Global fetch is not available. Node 20+ ships fetch natively; verify the runtime version or pass `fetch` explicitly to createToolingApiClient.',
    );
  }
  return g;
};

/**
 * Parse the rate-limit retry hint from the response. The Tooling API
 * documents the `Sforce-Limit-Info` header as `api-usage=N/M`; we treat
 * the standard HTTP `Retry-After` header (seconds) as authoritative when
 * present, and fall back to a conservative 60s window when only the
 * Sforce-Limit-Info header is set and the bucket is at or near floor.
 */
const parseRetryAfterMs = (response: FetchResponse): number | undefined => {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  }
  const limitInfo = response.headers.get('Sforce-Limit-Info');
  if (limitInfo !== null) {
    // Header format: `api-usage=3500/3500`. When the numerator equals
    // the denominator (or is at the floor margin), the bucket has been
    // exhausted; a one-minute back-off is the conservative default.
    const match = /api-usage=(\d+)\/(\d+)/.exec(limitInfo);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      const used = Number(match[1]);
      const cap = Number(match[2]);
      if (Number.isFinite(used) && Number.isFinite(cap) && cap > 0 && used >= cap * 0.95) {
        return 60_000;
      }
    }
  }
  return undefined;
};
