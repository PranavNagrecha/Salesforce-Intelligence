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
// Route-gap telemetry: the local question-gap log the router appends to when a
// question hits a gap. `sfi doctor` reads it to report routeGap counts
// (P12-ROUTER-confusion-report) — exported here so the CLI shares the canonical
// path/shape instead of duplicating it.
export { gapLogPath } from './intent-router.js';
export type { GapLogEntry } from './intent-router.js';
export {
  buildContext,
  createServer,
  shutdown,
  startServer,
} from './server.js';
export {
  generateToken,
  startHttpServer,
  tokenEquals,
} from './serve-http.js';
export type { RunningHttpServer, ServeHttpOptions } from './serve-http.js';
export type { Context, ServerError } from './server.js';
export { V01_TOOLS, dispatchTool, registerTools } from './tools/index.js';
export type { ToolDefinition } from './tools/index.js';
export { semanticCandidates } from './semantic-funnel.js';
export type { ToolCandidate } from './semantic-funnel.js';
