/**
 * @sf-intelligence/tooling-api
 *
 * The v1.7 Salesforce Tooling API client + auth delegation + freshness
 * enricher. Loaded by `sfi refresh --with-tooling-api` and the v1.7
 * MCP tools that need live freshness data
 * (`sfi.changed_since`, etc.). Opt-in throughout — default
 * `sfi refresh` produces an un-enriched, offline-only vault.
 *
 * Authentication is delegated to the `sf` CLI; see `./auth.ts` for the
 * delegation pattern. The HTTP client (`./client.ts`) implements
 * pagination, bearer-token Authorization, and the four error
 * translations (auth-expired / rate-limit / query-failed /
 * internal-error). The enricher (`./enrich.ts`) folds query results
 * back into the vault's `Node` shape so the refresh pipeline can
 * persist the freshness fields onto pre-existing graph rows without a
 * round-trip to disk.
 */

export {
  DEFAULT_API_VERSION,
  getAuthFromSfCli,
} from './auth.js';
export type {
  AuthError,
  ExecCommand,
  ToolingApiAuth,
} from './auth.js';

export {
  createToolingApiClient,
} from './client.js';
export type {
  CreateClientOptions,
  Dependency,
  FetchFn,
  FetchResponse,
  ToolingApiClient,
  ToolingApiError,
} from './client.js';

export {
  enrichLastModified,
} from './enrich.js';
export type {
  EnrichmentError,
  EnrichmentOptions,
  EnrichmentResult,
  NodeEnrichment,
} from './enrich.js';

export {
  enrichDependencies,
} from './enrich-dependencies.js';
export type {
  DependencyEnrichmentError,
  DependencyEnrichmentOptions,
  DependencyEnrichmentResult,
  EdgeConfirmation,
} from './enrich-dependencies.js';

export * from './user-entity-access.js';
