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
import { analyzeNamingConventions } from '@sf-intelligence/patterns';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveExistingObjectScope } from './input-aliases.js';

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
  /**
   * What the recognizer LOOKED at. Without it an empty `observations` list is
   * unreadable: "this object has no convention" and "this object has too few
   * custom fields to observe one" are different answers.
   */
  readonly analyzed: {
    readonly objectsWithCustomFields: number;
    readonly objectsBelowMinimumGroupSize: number;
    readonly minimumGroupSize: number;
    /**
     * Standard fields dropped before grouping WITHIN THE ANALYZED SCOPE — the
     * same population `objectsWithCustomFields` counts over. Under a
     * single-object scope this used to carry the org-wide total, so the block
     * printed `objectsWithCustomFields: 1` beside a figure in the thousands
     * with nothing saying the two were counted over different sets.
     */
    readonly standardFieldsExcluded: number;
    /**
     * The ORG-WIDE exclusion count, labelled as such IN THE RESPONSE rather
     * than only in the tool description. Equal to `standardFieldsExcluded` on
     * an unscoped call.
     */
    readonly standardFieldsExcludedOrgWide: number;
  };
  /** Present ONLY when a SCOPED call produced zero observations. Verbatim. */
  readonly note?: string;
}

/**
 * Verbatim note for a scoped call that produced nothing. Standard field names
 * are Salesforce's, not this org's, so they cannot evidence an org convention —
 * and an empty list must never be narrated as "no convention here".
 */
const emptyScopeNote = (objectApiName: string, customFieldCount: number, minimum: number): string =>
  `\`${objectApiName}\` has ${customFieldCount} custom field(s) in this vault — fewer than the ${minimum} needed to observe a convention. Standard field names are defined by Salesforce, not by this org, so they are excluded from convention analysis. An empty observation list here means NOT ENOUGH EVIDENCE, never "this object has no convention".`;

/** Extract the object api name from a `CustomField:{Object}[.*]` scope string. */
const scopedObjectApiName = (scope: string | undefined): string | null => {
  if (scope === undefined || scope === 'all') return null;
  const match = /^CustomField:([^.]+)(?:\.\*)?$/.exec(scope);
  return match === null ? null : (match[1] as string);
};

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
  // R4: a scope naming one object is STRING-SHAPE only at this point
  // (`parseScope` in the patterns package only checks the regex). The
  // recognizer then does an exact `parentApiName` match, so an unverified
  // name — a typo, an object the refresh never retrieved, or a real object
  // in the WRONG CASE — would fall through to `filtered = []` and this
  // handler would confidently narrate "0 custom fields" about it via
  // `emptyScopeNote`, rather than refusing. `resolveExistingObjectScope`
  // both verifies the object exists in the vault (refusing with
  // `invalid-query` when it does not) and corrects the caller's casing to
  // the vault's exact spelling, so the corrected name is what actually gets
  // analyzed and narrated.
  let effectiveScope = input.scope;
  const rawObjectApiName = scopedObjectApiName(input.scope);
  if (rawObjectApiName !== null) {
    const scopeResult = await resolveExistingObjectScope(ctx.graph, {
      objectApiName: rawObjectApiName,
    });
    if (!scopeResult.ok) return err(scopeResult.error);
    // `objectApiName` above is always non-empty when `rawObjectApiName` is
    // non-null, so this always resolves — the `null` branch only fires for a
    // bare (unscoped) call, which cannot happen here.
    if (scopeResult.value !== null) {
      effectiveScope = `CustomField:${scopeResult.value.object}.*`;
    }
  }

  // `recognizeNamingConventions` accepts an `{ scope? }` options object and
  // returns `Result<readonly PatternObservation[], PatternError>`. We
  // forward the optional `scope` directly under `exactOptionalPropertyTypes`
  // to avoid pinning `scope: undefined` into the options.
  const result = await analyzeNamingConventions(
    ctx.graph,
    effectiveScope !== undefined ? { scope: effectiveScope } : {},
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

  const { observations, analyzed } = result.value;
  // Re-derive from `effectiveScope`, not `input.scope`: after a wrong-case
  // correction the note (and the fact it names) must describe the vault's
  // object, not the caller's spelling.
  const objectApiName = scopedObjectApiName(effectiveScope);
  const note =
    objectApiName !== null && observations.length === 0
      ? emptyScopeNote(
          objectApiName,
          analyzed.scopedObjectCustomFieldCount ?? 0,
          analyzed.minimumGroupSize,
        )
      : undefined;

  return ok({
    data: {
      observations,
      analyzed: {
        objectsWithCustomFields: analyzed.objectsWithCustomFields,
        objectsBelowMinimumGroupSize: analyzed.objectsBelowMinimumGroupSize,
        minimumGroupSize: analyzed.minimumGroupSize,
        standardFieldsExcluded: analyzed.standardFieldsExcluded,
        standardFieldsExcludedOrgWide: analyzed.standardFieldsExcludedOrgWide,
      },
      ...(note !== undefined ? { note } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
