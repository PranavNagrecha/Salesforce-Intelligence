/**
 * Handler for the `sfi.get_manifest` MCP tool.
 *
 * Returns the in-memory `VaultManifest` snapshot the server loaded at
 * startup, wrapped in the standard `McpResponse` envelope. This is the
 * cheapest tool in the v0.1 surface — no graph or filesystem access at
 * call time. Clients use it to display vault provenance (refresh time,
 * source org, per-type component counts) without re-reading
 * `meta/manifest.json` themselves.
 */

import type { McpError, McpResponse, VaultManifest } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { readSkippedDirectories } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * The response payload `sfi.get_manifest` returns.
 *
 * The base `VaultManifest` interface (frozen in
 * `@sf-intelligence/contracts`) is widened with the
 * `skippedDirectories` field surfaced by the architectural-bug-fix
 * skip-counter. The field is always present (default: empty object)
 * so MCP clients don't have to special-case the `undefined` form;
 * older vaults written before the counter landed read back as an
 * empty map via `readSkippedDirectories`.
 */
export interface ManifestOutput extends VaultManifest {
  readonly skippedDirectories: Readonly<Record<string, number>>;
}

/**
 * Zod schema for the `sfi.get_manifest` tool input. The tool takes no
 * arguments; the schema exists only so `dispatchTool`'s `runTool` helper
 * can reject extraneous fields with the same `invalid-query` envelope
 * every other tool produces.
 */
export const getManifestInputSchema = z.object({});

/** Parsed input shape, inferred from `getManifestInputSchema`. */
export type GetManifestInput = z.infer<typeof getManifestInputSchema>;

/**
 * The `sfi.get_manifest` MCP tool. Returns `ctx.manifest` verbatim. The
 * server loads the manifest once at startup and refreshes it on
 * `sfi.refresh`, so this handler is a pure pass-through — no I/O, no
 * graph access. Cannot fail, hence the `Promise<Result<..., never>>`
 * widening to `McpError` only to satisfy the shared dispatch signature.
 *
 * @example
 *   const result = await getManifestHandler(ctx, {});
 *   if (result.ok) console.log(result.value.data.refreshedAt);
 */
export const getManifestHandler = async (
  ctx: Context,
  _input: GetManifestInput,
): Promise<Result<McpResponse<ManifestOutput>, McpError>> => {
  // Surface the skip-counter as a first-class field on the response.
  // `readSkippedDirectories` normalises the pre-counter empty-map
  // fallback so the wire shape is stable across vault versions.
  const data: ManifestOutput = {
    ...ctx.manifest,
    skippedDirectories: readSkippedDirectories(ctx.manifest),
  };
  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
