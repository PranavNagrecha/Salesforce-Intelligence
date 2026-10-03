/**
 * Handler for `sfi.omni_save_trace` (spec F2) — "for every answer on this
 * screen, does it reach the database?"
 *
 * For each answer-holding element of the ACTIVE OmniScript version, follow its
 * data key through every server call the script makes: the action's payload
 * map, the Integration Procedure's steps, its DataMappers (a Transform keeps a
 * key only if an item reads it EXACTLY) and generic-upsert Apex adapters, to a
 * field write. Each row says SAVED / SAVED_CONDITIONALLY / NEVER_SAVED /
 * UNKNOWN / NOT_INPUT with the exact place a key was dropped, near-miss item
 * keys and the field they feed, the conditions met on the way and the steps
 * whose failure is silent. Findings (`NEVER_SAVED` defects, `ORPHAN_WRITE`)
 * carry stable codes and citations.
 */

import type { McpError, McpResponse, PageInfo, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import {
  buildSaveTrace,
  type OrphanWrite,
  type SaveStatus,
  type SaveTraceRow,
} from '../omni/save-report.js';
import { buildScriptModel } from '../omni/script-model.js';
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

const TOOL = 'sfi.omni_save_trace';

const SAVE_STATUSES = ['SAVED', 'SAVED_CONDITIONALLY', 'NEVER_SAVED', 'UNKNOWN', 'NOT_INPUT'] as const;

export const omniSaveTraceInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  omniscript: z.string().min(1).optional(),
  step: z.string().min(1).optional(),
  statuses: z.array(z.enum(SAVE_STATUSES)).min(1).optional(),
  includeNonInputs: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
});

export type OmniSaveTraceInput = z.infer<typeof omniSaveTraceInputSchema>;

/** Response payload. */
export interface OmniSaveTraceOutput {
  readonly appliedScope: OmniAppliedScope & { readonly step: string | null };
  readonly config: { readonly status: string; readonly path: string };
  readonly refreshedAt: string;
  /** Over every traced row (before the `statuses` filter). */
  readonly statusCounts: Readonly<Record<SaveStatus, number>>;
  readonly findings: readonly OmniFinding[];
  readonly rows: readonly SaveTraceRow[];
  readonly orphanWrites: readonly OrphanWrite[];
  /** Write paths no screen key feeds and no near-miss explains (often prefill-fed). Count + first 50. */
  readonly unfedWrites: { readonly count: number; readonly sample: readonly OrphanWrite[] };
  readonly pageInfo: PageInfo;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const SAVE_TRACE_BOUNDARIES: readonly string[] = Object.freeze([
  'SAVED means a branch writes a field that exists for this answer, with every condition on the way evaluated TRUE from metadata (payload constants, the element\'s own visibility, "the container carrying the answer is not blank"). SAVED_CONDITIONALLY lists the conditions that could not be decided.',
  'NEVER_SAVED is reported as a DEFECT only when an INPUT element was routed to a save path that dropped it (a whitelist mapper that saves its siblings, or an Integration Procedure no step of which reads the key). Helper Formulas and answers that are only ever used (searches, filters) are NEVER_SAVED without being defects.',
  'An answer read by a Formula that is itself saved is SAVED in derived form (`derivedVia`).',
  'An answer that reaches unanalysed Apex only as part of a whole-data-JSON send is UNKNOWN; configure the org\'s generic-upsert Apex in org-kb/config/omnistudio.json to resolve those writes.',
]);

/** The `sfi.omni_save_trace` handler. */
export const omniSaveTraceHandler = async (
  ctx: Context,
  input: OmniSaveTraceInput,
): Promise<Result<McpResponse<OmniSaveTraceOutput>, McpError>> => {
  const worldR = await buildWorldOrError(ctx);
  if (!worldR.ok) return worldR;
  const world = worldR.value;
  const target = resolveOmniTarget(world, 'OmniScript', { componentId: input.componentId, alias: input.omniscript }, 'omniscript');
  if (!target.ok) return target;
  const loaded = await world.loadProcess(target.value.node);
  if (!loaded.ok) {
    return err({ kind: 'component-not-found', message: `${target.value.node.id}: ${loaded.reason}`, path: target.value.node.sourcePath });
  }
  const model = buildScriptModel(loaded.value, {
    customLwcOutputs: world.config.customLwcOutputs,
    launchParameters: world.config.launchParameters,
  });
  if (input.step !== undefined && !model.elements.some((e) => e.el.path.length === 1 && e.el.name === input.step)) {
    return err({
      kind: 'invalid-query',
      message: `step '${input.step}' is not a top-level element of ${target.value.node.id}`,
      path: 'step',
    });
  }
  const result = await buildSaveTrace(world, model, {
    ...(input.step === undefined ? {} : { step: input.step }),
    ...(input.includeNonInputs === undefined ? {} : { includeNonInputs: input.includeNonInputs }),
  });

  const wanted = input.statuses === undefined ? null : new Set<string>(input.statuses);
  const rows = result.rows.filter((r) => wanted === null || wanted.has(r.status));
  const fingerprint = argsFingerprint({
    componentId: target.value.scope.componentId,
    step: input.step ?? null,
    statuses: input.statuses ?? null,
    includeNonInputs: input.includeNonInputs ?? false,
  });
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
  const confidence: TrustSummary['confidence'] = result.findings.some((f) => f.confidence === 'inferred') ? 'heuristic' : 'parsed';
  return ok({
    data: {
      appliedScope: { ...target.value.scope, step: input.step ?? null },
      config: configEcho(world.configSource),
      refreshedAt: ctx.manifest.refreshedAt,
      statusCounts: result.statusCounts,
      findings: [...result.findings].sort(compareFindings),
      rows: page.items,
      orphanWrites: result.orphanWrites,
      unfedWrites: { count: result.unfedWrites.length, sample: result.unfedWrites.slice(0, 50) },
      pageInfo: page.pageInfo,
      boundaries: [...OMNI_MODEL_BOUNDARIES, ...SAVE_TRACE_BOUNDARIES],
      trust: omniTrust(ctx, world, confidence),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
