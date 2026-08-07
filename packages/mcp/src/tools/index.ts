/**
 * Tool registry — public API barrel.
 *
 * Thin re-export layer. Implementation details live in:
 *   - `roster.ts`       — ToolDefinition types, inline JSON schemas, V01_TOOLS
 *   - `tool-dispatch.ts`— handler imports, dispatchTool, runTool, jsonResult
 *
 * This file owns only two concerns that need both layers simultaneously:
 *   - `advertisedTools` — filters V01_TOOLS by profile
 *   - `registerTools`   — wires MCP server handlers
 *
 * Split from the original monolithic index.ts (R7-F2) to kill the merge
 * hotspot: roster PRs, dispatch PRs, and handler PRs no longer conflict.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { instrumentDispatch } from '../observability.js';
import type { Context } from '../server.js';
import { maybeReopenOnEpochChange } from '../server.js';

import { V01_TOOLS } from './roster.js';
import { dispatchTool, jsonResult } from './tool-dispatch.js';
import {
  CORE_PROFILE_TOOLS as CORE_TOOLS_SET,
  directInvokeDeniedError,
  isDirectlyInvokable,
  toolProfile as resolveToolProfile,
} from './tool-profile.js';

// ── Re-exports: roster ────────────────────────────────────────────────────────
export {
  MCP_LIVE_TOOL_ANNOTATIONS,
  MCP_TOOL_OUTPUT_SCHEMA,
  MCP_VAULT_TOOL_ANNOTATIONS,
  V01_TOOLS,
  mcpProtocolAnnotationsFor,
} from './roster.js';
export type { ToolDefinition } from './roster.js';

// ── Re-exports: dispatch + serialization ──────────────────────────────────────
export {
  MAX_RESPONSE_BYTES,
  RESPONSE_BUDGET_DEFAULT_BYTES,
  dispatchTool,
  jsonResult,
  responseBudgetBytes,
  runTool,
} from './tool-dispatch.js';

// ── Re-exports: tool profile primitives ───────────────────────────────────────
// P13-GW profile primitives live in tool-profile.ts (cycle-free for
// route-question's gateway envelopes); re-exported here as the public API.
export {
  CORE_PROFILE_TOOLS,
  directInvokeDeniedError,
  isDirectlyInvokable,
  toolProfile,
} from './tool-profile.js';

/**
 * The roster a server with the given profile ADVERTISES on tools/list.
 *
 * Hidden tools (`hidden: true` — back-compat aliases whose capability folded
 * into a survivor) are filtered out of BOTH profiles: they stay reachable via
 * `sfi.run_analysis` / internal `dispatchTool`, but never occupy a `tools/list`
 * schema slot. Under `core`, non-advertised tools are also not directly
 * invokable via `tools/call` (AUDIT-F6).
 */
export const advertisedTools = (
  profile: 'core' | 'full' = resolveToolProfile(),
): typeof V01_TOOLS =>
  profile === 'core'
    ? V01_TOOLS.filter((t) => !t.hidden && CORE_TOOLS_SET.has(t.name))
    : V01_TOOLS.filter((t) => !t.hidden);

export const registerTools = (server: Server, ctx: Context): void => {
  // P13-WATCH-epoch: the served context follows the vault's refresh epoch —
  // a refresh while this server is open swaps in a fresh graph connection on
  // the NEXT call (no restart). Held mutably here; tools never see the swap.
  let currentCtx = ctx;
  // AUDIT-F6: profile is FIXED at boot. Under `core`, only the 18 core schemas
  // are advertised AND directly invokable. Non-core tools stay reachable via
  // sfi.run_analysis (gateway) — advertise ≠ direct-invoke. CLI/internal
  // dispatchTool callers remain un-narrowed.
  const profile = resolveToolProfile();
  const roster = advertisedTools(profile);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: roster.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as {
        readonly type: 'object';
        readonly properties?: Readonly<Record<string, unknown>>;
        readonly required?: readonly string[];
      },
      // MCP-01: protocol ToolAnnotations (readOnlyHint / openWorldHint).
      annotations: tool.annotations,
      // MCP-01 (b): shared envelope schema for structuredContent.
      outputSchema: tool.outputSchema as {
        readonly type: 'object';
        readonly properties?: Readonly<Record<string, unknown>>;
        readonly required?: readonly string[];
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Readonly<
      Record<string, unknown>
    >;
    currentCtx = await maybeReopenOnEpochChange(currentCtx);
    // The only real `tools/call` seam — instrument HERE (not in dispatchTool,
    // which recurses for run_analysis and is shared with CLI-internal calls,
    // nor in runTool, which misses the unknown-tool early-return). Returns the
    // CallToolResult unchanged; emits one metric only when SFI_METRICS_LOG set.
    const name = request.params.name;
    return instrumentDispatch(name, async () => {
      if (!isDirectlyInvokable(name, profile)) {
        return jsonResult({ error: directInvokeDeniedError(name) });
      }
      return dispatchTool(currentCtx, name, args);
    });
  });
};
