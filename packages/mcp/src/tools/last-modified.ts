/**
 * Handler for the `sfi.last_modified` MCP tool.
 *
 * v1.7 R3's per-component freshness lookup — the sibling of v1.7 R2's
 * `sfi.changed_since` range scan. Given a canonical `ComponentId`, the
 * tool reads the node's freshness fields (`lastModifiedDate`,
 * `lastModifiedBy`, `apiVersion`) and emits a structured envelope with
 * an explicit `enriched: boolean` flag so consumers can distinguish a
 * genuinely-null freshness value from a vault that hasn't yet been
 * enriched via the opt-in Tooling API tier.
 *
 * **Honesty axis** — when both `properties.lastModifiedDate` and
 * `properties.lastModifiedBy` are absent (the offline DX-source
 * pipeline's default state) AND there is no legacy top-level
 * `lastModifiedDate` / `lastModifiedBy` value either, the tool returns
 * `{ enriched: false, lastModifiedDate: null, lastModifiedBy: null,
 * apiVersion: null }` with the verbatim disclosure string the
 * `freshness-tracking` skill surfaces to users:
 *
 *   "v1.7 Tooling API enrichment has not run for this vault. Run
 *    `sfi refresh --with-tooling-api --target-org <alias>` to populate
 *    lastModifiedDate / lastModifiedBy / apiVersion for the enriched
 *    types."
 *
 * **The partial-enrichment axis** — a component can carry SOME freshness
 * axes and not others. On a vault where the Tooling API enricher has
 * never run, every component that ships an `<apiVersion>` element in its
 * own metadata file resolves to `apiVersion: <n>` with
 * `lastModifiedDate: null` and `lastModifiedBy: null`. `enriched` is
 * `true` there — that flag answers "do we know ANYTHING?", and it is
 * pinned by contract — but the flag alone let the response certify
 * "Freshness fields populated" over two nulls that were never checked.
 * So the payload also carries `enrichmentState` (`complete` | `partial`
 * | `none`) and `missingAxes` — the axes that are null because NOTHING
 * POPULATED THEM. A machine consumer branches on `enrichmentState`; the
 * `disclosure` prose is DERIVED from `missingAxes`, so the sentence a
 * host reads aloud and the typed field cannot drift apart.
 *
 * Per PLAN-v1.7.md §4 condition (1), the disclosure is fixed-form —
 * callers are NOT to paraphrase or estimate dates from prior-art
 * training data.
 *
 * Backward-compat reads: the v1.0-v1.6 baseline writes the legacy
 * top-level `lastModifiedDate: string | null` field on the node and the
 * legacy string-only `lastModifiedBy: string | null`. v1.7's enricher
 * writes the new structured overlay under `properties.lastModifiedDate`
 * and `properties.lastModifiedBy: { id, name }`. The handler reads BOTH
 * sources — properties take precedence, with the legacy fields used
 * only as fallback. A node that carries only the legacy fields (e.g.,
 * a CustomField pre-enrichment vault that already had freshness from
 * the DX-source extractor's `<lastModifiedDate>` element) still
 * resolves to `enriched: true` because the data IS present.
 *
 * The properties-overlay-then-legacy-fallback precedence is sourced from
 * the shared `freshness-fields.ts` leaf module (not duplicated locally)
 * so this tool and `sfi.changed_since` cannot silently diverge on how a
 * node's freshness is read.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  extractApiVersion,
  extractLastModifiedBy,
  extractLastModifiedDate,
} from './freshness-fields.js';

/**
 * Verbatim disclosure surfaced when neither the v1.7 enriched overlay
 * nor the legacy top-level fields carry a freshness value. Kept as a
 * module-level constant so the `freshness-tracking` skill, the test
 * suite, and any future consumer all reference the SAME string.
 */
export const LAST_MODIFIED_UNENRICHED_DISCLOSURE =
  'v1.7 Tooling API enrichment has not run for this vault. Run ' +
  '`sfi refresh --with-tooling-api --target-org <alias>` to populate ' +
  'lastModifiedDate / lastModifiedBy / apiVersion for the enriched types.';

/**
 * Verbatim disclosure surfaced when the freshness fields ARE present —
 * a one-line statement of provenance so callers can render the value
 * with the right confidence framing.
 */
export const LAST_MODIFIED_ENRICHED_DISCLOSURE =
  'Freshness fields populated. lastModifiedDate / lastModifiedBy ' +
  'reflect the Tooling API at enrichment time (or the DX-source ' +
  'extractor when the type carries a `<lastModifiedDate>` element).';

/**
 * The three freshness axes this tool reports on, in the order they are
 * named in prose. Single source for `missingAxes` and for the derived
 * partial disclosure — a fourth axis added here is reported by both
 * without a second edit.
 */
export const LAST_MODIFIED_AXES = [
  'lastModifiedDate',
  'lastModifiedBy',
  'apiVersion',
] as const;

/** One of the freshness axes named in {@link LAST_MODIFIED_AXES}. */
export type LastModifiedAxis = (typeof LAST_MODIFIED_AXES)[number];

/**
 * How much of the freshness picture this vault actually holds for the
 * component — the typed discriminator a machine consumer branches on.
 *
 *   - `complete`: every axis carries a value.
 *   - `partial`:  at least one axis carries a value AND at least one is
 *                 null because nothing populated it. `missingAxes` names
 *                 which. A null on a `partial` answer is UNCHECKED, not
 *                 checked-and-empty.
 *   - `none`:     no axis carries a value.
 *
 * `missingAxes` is empty ONLY on `complete`; on `partial` and `none` it
 * is non-empty. The pair therefore cannot be read as a clean zero —
 * `missingAxes: []` never has to stand in for "we did not look".
 */
export type LastModifiedEnrichmentState = 'complete' | 'partial' | 'none';

/**
 * Prose for a PARTIAL answer, DERIVED from the same `missingAxes` array
 * the payload carries so the sentence a host reads aloud and the typed
 * field can never disagree.
 *
 * This exists because the enriched disclosure was being emitted over
 * nulls. On an un-enriched vault a component with an `<apiVersion>` in
 * its metadata file returned `enriched: true` plus "Freshness fields
 * populated. lastModifiedDate / lastModifiedBy reflect the Tooling API
 * at enrichment time" — while both of those were null and the Tooling
 * API had never been asked. That is a certified unchecked zero.
 */
export const lastModifiedPartialDisclosure = (
  missingAxes: readonly LastModifiedAxis[],
): string => {
  const named = missingAxes.join(', ');
  const verb = missingAxes.length === 1 ? 'is' : 'are';
  return (
    `PARTIAL — only some freshness axes are known for this component. ` +
    `${named} ${verb} null because NOTHING POPULATED ${
      missingAxes.length === 1 ? 'IT' : 'THEM'
    }, not because the component has no value. Do not read a null axis ` +
    `as "never modified" or "author unknown" — it is UNCHECKED. Run ` +
    '`sfi refresh --with-tooling-api --target-org <alias>` to populate ' +
    'the missing axes for the enriched types (ApexClass, ApexTrigger, ' +
    'Flow, Layout, CustomField, ValidationRule).'
  );
};

/**
 * Zod schema for the `sfi.last_modified` tool input.
 *
 *   - `componentId`: required non-empty string. The canonical
 *     `{Type}:{ApiName}` form is enforced downstream by the graph
 *     lookup (an unknown id yields `component-not-found`, not a
 *     Zod-level rejection).
 */
export const lastModifiedInputSchema = z.object({
  componentId: z.string().min(1),
});

/** Parsed input shape, inferred from `lastModifiedInputSchema`. */
export type LastModifiedInput = z.infer<typeof lastModifiedInputSchema>;

/**
 * Payload wrapped inside the `McpResponse` envelope on success.
 *
 *   - `componentId`: echoed back from the input.
 *   - `enriched`: `true` when at least one of `lastModifiedDate`,
 *     `lastModifiedBy`, or `apiVersion` carries a non-null value. The
 *     load-bearing honesty axis — a consumer that checks this flag is
 *     guaranteed to never present a fabricated freshness value as real.
 *   - `lastModifiedDate`: ISO 8601 timestamp or `null`.
 *   - `lastModifiedBy`: `{ id, name }` or `null`.
 *   - `apiVersion`: numeric API version or `null`.
 *   - `enrichmentState`: `complete` | `partial` | `none` — the typed
 *     discriminator. `enriched: true` is TRUE for both `complete` and
 *     `partial`, so it cannot answer "is this null checked?". This can.
 *   - `missingAxes`: the axes that are null because nothing populated
 *     them. Empty ONLY when `enrichmentState` is `complete`.
 *   - `disclosure`: fixed-form string telling the consumer how to read
 *     the result. When `enriched: false`, the disclosure names the
 *     specific CLI command that would populate the missing fields; on a
 *     `partial` answer it NAMES the unchecked axes and says the nulls
 *     are unchecked rather than certifying the fields are populated.
 */
export interface LastModifiedOutput {
  readonly componentId: ComponentId;
  readonly enriched: boolean;
  readonly enrichmentState: LastModifiedEnrichmentState;
  readonly missingAxes: readonly LastModifiedAxis[];
  readonly lastModifiedDate: string | null;
  readonly lastModifiedBy: { id: string; name: string } | null;
  readonly apiVersion: number | null;
  readonly disclosure: string;
}

/**
 * The `sfi.last_modified` handler. Looks up the node, extracts the
 * freshness fields from either the v1.7 enricher overlay (preferred)
 * or the legacy top-level fields (fallback), and emits a structured
 * envelope with the `enriched: boolean` honesty flag. See the module
 * JSDoc for the partial-data axis and the verbatim disclosure shape.
 *
 * @example
 *   const r = await lastModifiedHandler(ctx, {
 *     componentId: 'ApexClass:AccountController',
 *   });
 *   if (r.ok && r.value.data.enriched) {
 *     console.log(r.value.data.lastModifiedDate);
 *   }
 */
export const lastModifiedHandler = async (
  ctx: Context,
  input: LastModifiedInput,
): Promise<Result<McpResponse<LastModifiedOutput>, McpError>> => {
  const nodeResult = await getNodeById(ctx.graph, input.componentId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no node with id ${input.componentId}`,
      path: input.componentId,
    });
  }
  const node = nodeResult.value;

  const lastModifiedDate = extractLastModifiedDate(
    node.lastModifiedDate,
    node.properties,
  );
  const lastModifiedBy = extractLastModifiedBy(
    node.lastModifiedBy,
    node.properties,
  );
  const apiVersion = extractApiVersion(node.apiVersion, node.properties);

  // The `enriched` flag is true when ANY freshness axis carries a
  // non-null value — a node may have lastModifiedDate from the legacy
  // DX-source extractor but no lastModifiedBy until the Tooling API
  // enricher runs, and that partial-presence still counts as enriched
  // for the user-facing "do we know anything?" question. The
  // disclosure string adapts accordingly.
  const enriched =
    lastModifiedDate !== null || lastModifiedBy !== null || apiVersion !== null;

  // Which axes are null BECAUSE NOTHING POPULATED THEM. Derived from the
  // same three values the payload reports, so the typed field cannot
  // describe a different answer than the one returned.
  const resolvedByAxis: Readonly<Record<LastModifiedAxis, unknown>> = {
    lastModifiedDate,
    lastModifiedBy,
    apiVersion,
  };
  const missingAxes: readonly LastModifiedAxis[] = LAST_MODIFIED_AXES.filter(
    (axis) => resolvedByAxis[axis] === null,
  );
  const enrichmentState: LastModifiedEnrichmentState = !enriched
    ? 'none'
    : missingAxes.length > 0
      ? 'partial'
      : 'complete';

  return ok({
    data: {
      componentId: node.id,
      enriched,
      enrichmentState,
      missingAxes,
      lastModifiedDate,
      lastModifiedBy,
      apiVersion,
      disclosure:
        enrichmentState === 'complete'
          ? LAST_MODIFIED_ENRICHED_DISCLOSURE
          : enrichmentState === 'partial'
            ? lastModifiedPartialDisclosure(missingAxes)
            : LAST_MODIFIED_UNENRICHED_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
