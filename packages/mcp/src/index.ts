/**
 * @sf-intelligence/mcp
 *
 * The Model Context Protocol server that exposes `org-kb/` to Claude
 * Code. v0.1 ships the server lifecycle, tool registry, and a single
 * vault resource; tool handlers themselves remain stubs that Phase F's
 * `mcp-tool-*` tasks fill in. This barrel is the single public surface.
 *
 * Typical consumer flow:
 *   1. `await buildContext(vaultRoot)` -> `Context` or `ServerError`.
 *   2. `createServer(ctx)` -> a wired-up `Server` instance.
 *   3. `await startServer(server)` -> connect to stdio and serve.
 *   4. `await shutdown(ctx)` -> release the graph store on exit.
 */

export { registerPrompts, MCP_PROMPTS, getMcpPrompt } from './prompts.js';
export { registerResources } from './resources.js';
// P13-FACTS-capture: the CLI's refresh-time data-shape capture shares the
// canonical consent check (the capture is opt-in twice over: flag + consent).
export { hasLiveConsent } from './live-consent.js';
// P13-WATCH-sweep: the CLI stale-sweep reuses the canonical staleness check +
// sf-CLI JSON runner (with the injectable exec for tests).
export {
  checkVaultStaleness,
  runSfJson,
  STALE_CHECK_TYPES,
  type VaultStalenessResult,
} from './tools/live-plane.js';
// CR-09 follow-up: the per-session live-query budget/cache is an MCP-session
// safety. A discrete, user-invoked drift sweep (`sfi stale-sweep`) and the watch
// daemon's periodic tick must each run in a FRESH budget+cache scope so a single
// 15-type sweep (<< the 50 budget) never trips the guard and the daemon does not
// degrade across ticks (15 * N ticks would otherwise exhaust the process-level
// budget and false-positive drift). The CLI calls this at the start of each
// sweep. The MCP live_* tools keep their session budget untouched.
export { resetLiveSession } from './tools/live-session.js';
// Route-gap telemetry: the local question-gap log the router appends to when a
// question hits a gap. `sfi doctor` / `sfi gaps report` / `sfi.capabilities`
// read it (P12-ROUTER-confusion-report / R8-GAPLOG-SURFACE) — exported here so
// the CLI shares the canonical path/shape/summarizer instead of duplicating it.
export {
  gapLogPath,
  ROUTE_GAP_NUDGE_THRESHOLD,
  routeGapsNudge,
  summarizeRouteGaps,
} from './intent-router.js';
export type {
  GapLogEntry,
  RouteGapCategoryCount,
  RouteGapSummary,
  RouteGapsNudge,
  SummarizeRouteGapsOptions,
} from './intent-router.js';
export {
  bindCallerIdentity,
  buildContext,
  createServer,
  shutdown,
  startServer,
} from './server.js';
// Setup mode: the server that answers when there is NO vault yet. Exported so
// the CLI can boot it instead of exiting — an MCP host that loses its server
// shows the user "failed to connect" and nothing else, which made the
// product's own onboarding instructions unreachable. See setup-server.ts.
export { createSetupServer, setupStatusPayload } from './setup-server.js';
export type { SetupReason, SetupState } from './setup-server.js';
export {
  generateToken,
  loadTokensFile,
  matchTokenEntry,
  resolveBearerAuth,
  startHttpServer,
  tokenEquals,
} from './serve-http.js';
export type {
  AuthResolution,
  RunningHttpServer,
  ServeHttpOptions,
  TokenEntry,
} from './serve-http.js';
export type { CallerIdentity, Context, ServerError } from './server.js';
export {
  V01_TOOLS,
  dispatchTool,
  registerTools,
  MCP_LIVE_TOOL_ANNOTATIONS,
  MCP_VAULT_TOOL_ANNOTATIONS,
  MCP_TOOL_OUTPUT_SCHEMA,
  mcpProtocolAnnotationsFor,
} from './tools/index.js';
export type { ToolDefinition } from './tools/index.js';
export {
  captureSecurityPostureMetrics,
  gradeFromFindingCount,
  securityPostureMetricsFromFindingCount,
} from './tools/security-posture-metric.js';
export { semanticCandidates } from './semantic-funnel.js';
export type { ToolCandidate } from './semantic-funnel.js';
