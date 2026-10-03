/**
 * Handler for `sfi.omni_prefill_trace` (spec F2) — "for every answer this
 * screen saves, does the saved value come BACK when the screen reopens?"
 *
 * Runs the save trace for the active OmniScript, then follows every value the
 * screen's prefill calls return — forward from each DataMapper Extract item or
 * generic-fetch Apex output, through Transforms / Set Values, to the Response
 * Action, re-rooted at the calling action's response node — and checks that a
 * saved field returns at exactly the key of the element that displays it.
 */

import type { McpError, McpResponse, PageInfo, TrustSummary } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { buildPrefillTrace, type PrefillRow, type PrefillStatus } from '../omni/prefill.js';
import { buildScriptModelWithResponses } from '../omni/responses.js';
import { buildSaveTrace } from '../omni/save-report.js';
import { compareFindings, type OmniFinding } from '../omni/types.js';
import type { Context } from '../server.js';

import {
  buildWorldOrError,
  configEcho,
  OMNI_MODEL_BOUNDARIES,
  type OmniAppliedScope,
  omniTrust,
  resolveOmniTarget,
} from './omni-common.js';
import { argsFingerprint, decodeCursor, paginate } from './page-cursor.js';

const TOOL = 'sfi.omni_prefill_trace';

export const omniPrefillTraceInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  omniscript: z.string().min(1).optional(),
  step: z.string().min(1).optional(),
  statuses: z.array(z.enum(['PREFILLED', 'NEVER_PREFILLED', 'UNKNOWN'])).min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
});

export type OmniPrefillTraceInput = z.infer<typeof omniPrefillTraceInputSchema>;

/** Response payload. */
export interface OmniPrefillTraceOutput {
  readonly appliedScope: OmniAppliedScope & { readonly step: string | null };
  readonly config: { readonly status: string; readonly path: string };
  readonly refreshedAt: string;
  readonly statusCounts: Readonly<Record<PrefillStatus, number>>;
  readonly findings: readonly OmniFinding[];
  readonly rows: readonly PrefillRow[];
  /** Calls whose response the model cannot fully see into. */
  readonly unmodeledResponses: readonly string[];
  readonly returnedValues: number;
  readonly pageInfo: PageInfo;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const PREFILL_BOUNDARIES: readonly string[] = Object.freeze([
  'Only answers the save trace shows SAVED (to a field other than Id) are checked, and only input elements — Formulas recompute rather than being prefilled.',
  'A value returned by the org\'s generic-fetch Apex is recognized from how later steps read its output (`<step>:records:<Object>`); every vaulted field of that object is assumed fetchable, so PREFILLED through such a fetch is `inferred` (the Apex field set is not analysed). Declare it in org-kb/config/omnistudio.json `genericFetchAdapters` to make it `parsed`.',
  'NEVER_PREFILLED is a defect when the field comes back into the same card / container under a different key, or when that container is prefilled with other fields but not this one.',
]);

/** The `sfi.omni_prefill_trace` handler. */
export const omniPrefillTraceHandler = async (
  ctx: Context,
  input: OmniPrefillTraceInput,
): Promise<Result<McpResponse<OmniPrefillTraceOutput>, McpError>> => {
  const worldR = await buildWorldOrError(ctx);
  if (!worldR.ok) return worldR;
  const world = worldR.value;
  const t = resolveOmniTarget(world, 'OmniScript', { componentId: input.componentId, alias: input.omniscript }, 'omniscript');
  if (!t.ok) return t;
  const loaded = await world.loadProcess(t.value.node);
  if (!loaded.ok) return { ok: false, error: { kind: 'component-not-found', message: `${t.value.node.id}: ${loaded.reason}`, path: t.value.node.sourcePath } };
  const model = await buildScriptModelWithResponses(world, loaded.value);
  if (input.step !== undefined && !model.elements.some((e) => e.el.path.length === 1 && e.el.name === input.step)) {
    return { ok: false, error: { kind: 'invalid-query', message: `step '${input.step}' is not a top-level element of ${t.value.node.id}`, path: 'step' } };
  }
  const save = await buildSaveTrace(world, model, input.step === undefined ? {} : { step: input.step });
  const prefill = await buildPrefillTrace(world, model, save.rows);
  const statusCounts: Record<PrefillStatus, number> = { PREFILLED: 0, NEVER_PREFILLED: 0, UNKNOWN: 0 };
  for (const r of prefill.rows) statusCounts[r.status] += 1;
  const wanted = input.statuses === undefined ? null : new Set<string>(input.statuses);
  const rows = prefill.rows.filter((r) => wanted === null || wanted.has(r.status));
  const fingerprint = argsFingerprint({ componentId: t.value.scope.componentId, step: input.step ?? null, statuses: input.statuses ?? null });
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint });
    if (!decoded.ok) return decoded;
    offset = decoded.value.o;
  }
  const page = paginate(rows, {
    offset,
    limit: input.limit ?? 100,
    byteBudget: 24_000,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    keyOf: (r) => r.element,
  });
  return ok({
    data: {
      appliedScope: { ...t.value.scope, step: input.step ?? null },
      config: configEcho(world.configSource),
      refreshedAt: ctx.manifest.refreshedAt,
      statusCounts,
      findings: [...prefill.findings].sort(compareFindings),
      rows: page.items,
      unmodeledResponses: prefill.unmodeled,
      returnedValues: prefill.returnedCount,
      pageInfo: page.pageInfo,
      boundaries: [...OMNI_MODEL_BOUNDARIES, ...PREFILL_BOUNDARIES],
      trust: omniTrust(ctx, world, 'heuristic'),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
