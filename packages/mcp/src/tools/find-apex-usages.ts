/**
 * `sfi.find_apex_usages` — HIDDEN back-compat alias (STEP-2 roster retirement).
 *
 * The Apex-only view folded into `sfi.find_code_usages`. The two tools were
 * data-identical when `find_code_usages` is narrowed to the Apex node types and
 * the Apex edge triad: both do one `listEdges(targetId, { direction: 'in' })`
 * then filter by (edgeTypes ∩ nodeTypes) with the same total-order comparator.
 * So this module is now a THIN alias that delegates to `findCodeUsagesHandler`
 * with `nodeTypes: ['ApexClass', 'ApexTrigger']` and the Apex edge triad
 * (`readsFrom`/`writesTo`/`callsApex`).
 *
 * Preservation (zero capability lost):
 *   - `find_code_usages` now emits the ALWAYS-ON pagination envelope
 *     (`totalCount`/`offset`/`limit`/`hasMore`/`nextOffset` + the `INCOMPLETE`
 *     truncation note), so the shape this alias returns is identical to the
 *     pre-retirement `find_apex_usages` output — a consumer relying on an
 *     always-present `totalCount` still works.
 *   - The Apex-only input schema is retained here (its `edgeTypes` enum rejects
 *     the frontend-only `references` type, exactly as before).
 *
 * The tool stays `hidden: true` in `V01_TOOLS` (dispatchable by name /
 * `run_analysis`, and the migrated gold row still resolves) but is NOT
 * advertised on `tools/list`. Callers wanting the frontend tier (LWC/Aura/VF)
 * use `sfi.find_code_usages` directly.
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import type { Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  type FindCodeUsagesOutput,
  findCodeUsagesHandler,
} from './find-code-usages.js';

/**
 * Inclusive upper bound on `limit`. Mirrors `find_code_usages`'s
 * `CODE_USAGES_MAX_LIMIT` (500) so the alias validates identically to the
 * survivor it delegates to.
 */
const APEX_USAGES_MAX_LIMIT = 500;

/**
 * The three edge types the Apex scanner emits — the alias's default `edgeTypes`
 * set and the survivor-narrowing passed to `find_code_usages`. The
 * frontend-only `references` type is intentionally NOT accepted (the Apex-only
 * persona), so this schema still rejects it.
 */
const APEX_EDGE_TYPES = ['readsFrom', 'writesTo', 'callsApex'] as const;

/**
 * Zod schema for the (hidden) `sfi.find_apex_usages` alias. Identical to the
 * pre-retirement Apex-only schema: `targetId` required; `limit` in [1, 500];
 * `offset`/`cursor` for paging; `edgeTypes` restricted to the Apex triad
 * (empty array = filter to nothing, per the long-standing boundary choice).
 */
export const findApexUsagesInputSchema = z.object({
  targetId: z.string().min(1),
  limit: z.number().int().min(1).max(APEX_USAGES_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
  cursor: z.string().min(1).optional(),
  edgeTypes: z.array(z.enum(APEX_EDGE_TYPES)).optional(),
});

/** Parsed input shape, inferred from `findApexUsagesInputSchema`. */
export type FindApexUsagesInput = z.infer<typeof findApexUsagesInputSchema>;

/**
 * The hidden `sfi.find_apex_usages` alias. Delegates to
 * `findCodeUsagesHandler` narrowed to the Apex node types + edge triad — the
 * data-identical Apex-only view — and returns its (always-on paginated) output
 * verbatim. Passing `edgeTypes` explicitly (defaulting to the triad) keeps the
 * survivor's cursor fingerprint stable across an offset/cursor resume.
 *
 * @example
 *   const r = await findApexUsagesHandler(ctx, {
 *     targetId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) console.log(r.value.data.usages.length);
 */
export const findApexUsagesHandler = async (
  ctx: Context,
  input: FindApexUsagesInput,
): Promise<Result<McpResponse<FindCodeUsagesOutput>, McpError>> =>
  findCodeUsagesHandler(ctx, {
    targetId: input.targetId,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    edgeTypes: input.edgeTypes ?? [...APEX_EDGE_TYPES],
    nodeTypes: ['ApexClass', 'ApexTrigger'],
  });
