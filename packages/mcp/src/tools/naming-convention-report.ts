/**
 * Handler for the `sfi.get_naming_convention_report` MCP tool.
 *
 * Surfaces the patterns layer's `recognizeNamingConventions` recognizer
 * through the MCP envelope. Input is validated by the exported Zod schema;
 * `PatternError`s are translated into the MCP envelope's typed errors so
 * the JSON-RPC dispatch layer can serialize them cleanly:
 *
 *   - `graph-error`   -> `internal`      (an underlying query blew up).
 *   - `invalid-scope` -> `invalid-query` (the scope string was malformed).
 */

import type { McpError, McpResponse, PatternObservation } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { recognizeNamingConventions } from '@sf-intelligence/patterns';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Zod schema for the `sfi.get_naming_convention_report` tool input.
 * `scope` is an optional non-empty string. The recognizer parses the value
 * itself (`'all'` or `'CustomField:{ObjectApiName}.*'`); we only reject the
 * obviously malformed empty string at the input boundary so downstream
 * `invalid-scope` errors carry a meaningful payload.
 */
export const namingConventionReportInputSchema = z.object({
  scope: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `namingConventionReportInputSchema`. */
export type NamingConventionReportInput = z.infer<
  typeof namingConventionReportInputSchema
>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface NamingConventionReportOutput {
  readonly observations: readonly PatternObservation[];
}

/**
 * The `sfi.get_naming_convention_report` MCP tool. Returns the
 * naming-convention pattern observations for the requested scope (or for
 * every parent object when no scope is supplied). Input is already
 * Zod-validated by `dispatchTool`; this handler only deals in the happy
 * and pattern-error paths.
 *
 * @example
 *   const result = await namingConventionReportHandler(ctx, {
 *     scope: 'CustomField:Account.*',
 *   });
 *   if (result.ok) console.log(result.value.data.observations);
 */
export const namingConventionReportHandler = async (
  ctx: Context,
  input: NamingConventionReportInput,
): Promise<Result<McpResponse<NamingConventionReportOutput>, McpError>> => {
  // `recognizeNamingConventions` accepts an `{ scope? }` options object and
  // returns `Result<readonly PatternObservation[], PatternError>`. We
  // forward the optional `scope` directly under `exactOptionalPropertyTypes`
  // to avoid pinning `scope: undefined` into the options.
  const result = await recognizeNamingConventions(
    ctx.graph,
    input.scope !== undefined ? { scope: input.scope } : {},
  );

  if (!result.ok) {
    if (result.error.kind === 'invalid-scope') {
      return err({
        kind: 'invalid-query',
        message: result.error.message,
      });
    }
    // `graph-error` — the underlying graph query failed. Surface as
    // `internal`, matching the search-* tools' translation of graph
    // failures.
    return err({
      kind: 'internal',
      message: `naming-convention recognizer failed: ${result.error.message}`,
    });
  }

  return ok({
    data: { observations: result.value },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
