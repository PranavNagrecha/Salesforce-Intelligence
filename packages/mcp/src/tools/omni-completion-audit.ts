/**
 * Handler for `sfi.omni_completion_audit` (spec F4) — does "Complete" mean
 * "saved"? For one Integration Procedure, or every active one: completion
 * markers that run regardless of whether the preceding writes succeeded,
 * success / status / error keys the calling screens never read, and readers
 * that check only the first row of a write's result.
 */

import type { McpError, McpResponse, PageInfo, TrustSummary } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { auditCompletion } from '../omni/completion-audit.js';
import { buildIpModel } from '../omni/ip-model.js';
import { buildScriptModelWithResponses } from '../omni/responses.js';
import type { ScriptModel } from '../omni/script-model.js';
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

const TOOL = 'sfi.omni_completion_audit';

export const omniCompletionAuditInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  ip: z.string().min(1).optional(),
  codes: z.array(z.enum(['COMPLETE_WITHOUT_SUCCESS', 'SUCCESS_FLAG_NEVER_READ', 'ONLY_FIRST_RESULT_CHECKED'])).min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
});

export type OmniCompletionAuditInput = z.infer<typeof omniCompletionAuditInputSchema>;

/** Response payload. */
export interface OmniCompletionAuditOutput {
  readonly appliedScope: (OmniAppliedScope & { readonly mode: 'ip' }) | { readonly mode: 'vault'; readonly ips: number };
  readonly config: { readonly status: string; readonly path: string };
  readonly refreshedAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly findings: readonly OmniFinding[];
  readonly pageInfo: PageInfo;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const COMPLETION_BOUNDARIES: readonly string[] = Object.freeze([
  'Completion markers are the calls declared in org-kb/config/omnistudio.json `completionMarkers`; without that file, a Remote Action whose method name reads like a status update is a heuristic marker (`inferred`).',
  'A write step is a DataMapper Load, a Delete Action, or a generic-upsert Remote Action (configured, or recognized by its records + object-name inputs).',
  'Whether a returned key is a success flag is judged by its name (success / status / error / fail, or a `…Flag`) — `inferred`.',
]);

/** The `sfi.omni_completion_audit` handler. */
export const omniCompletionAuditHandler = async (
  ctx: Context,
  input: OmniCompletionAuditInput,
): Promise<Result<McpResponse<OmniCompletionAuditOutput>, McpError>> => {
  const worldR = await buildWorldOrError(ctx);
  if (!worldR.ok) return worldR;
  const world = worldR.value;
  let targets;
  let appliedScope: OmniCompletionAuditOutput['appliedScope'];
  if (input.componentId !== undefined || input.ip !== undefined) {
    const t = resolveOmniTarget(world, 'OmniIntegrationProcedure', { componentId: input.componentId, alias: input.ip }, 'ip');
    if (!t.ok) return t;
    targets = [t.value.node];
    appliedScope = { ...t.value.scope, mode: 'ip' };
  } else {
    const prefixes = world.config.appScope.namePrefixes;
    targets = world.ips
      .filter((n) => n.properties['isActive'] === true && (prefixes.length === 0 || prefixes.some((p) => n.apiName.startsWith(p))))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    appliedScope = { mode: 'vault', ips: targets.length };
  }
  // Callers: every active script (models built once).
  const callers: ScriptModel[] = [];
  for (const n of world.scripts.filter((x) => x.properties['isActive'] === true)) {
    const loaded = await world.loadProcess(n);
    if (loaded.ok) callers.push(await buildScriptModelWithResponses(world, loaded.value));
  }
  const findings: OmniFinding[] = [];
  for (const node of targets) {
    const loaded = await world.loadProcess(node);
    if (!loaded.ok) continue;
    const ip = buildIpModel(loaded.value);
    const mine = callers.filter((c) => c.actions.some((a) => a.ipKey !== null && world.resolveIpKey(a.ipKey).node?.id === node.id));
    findings.push(...(await auditCompletion(world, ip, mine)));
  }
  const counts: Record<string, number> = {};
  for (const f of findings) counts[`${f.code}/${f.verdict}`] = (counts[`${f.code}/${f.verdict}`] ?? 0) + 1;
  const codes = input.codes === undefined ? null : new Set<string>(input.codes);
  const selected = findings.filter((f) => codes === null || codes.has(f.code)).sort(compareFindings);
  const fingerprint = argsFingerprint({ scope: 'componentId' in appliedScope ? appliedScope.componentId : 'vault', codes: input.codes ?? null });
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint });
    if (!decoded.ok) return decoded;
    offset = decoded.value.o;
  }
  const page = paginate(selected, {
    offset,
    limit: input.limit ?? 100,
    byteBudget: 26_000,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    keyOf: (f) => `${f.componentId}#${f.elementPath ?? ''}#${f.code}#${f.message}`,
  });
  return ok({
    data: {
      appliedScope,
      config: configEcho(world.configSource),
      refreshedAt: ctx.manifest.refreshedAt,
      counts,
      findings: page.items,
      pageInfo: page.pageInfo,
      boundaries: [...OMNI_MODEL_BOUNDARIES, ...COMPLETION_BOUNDARIES],
      trust: omniTrust(ctx, world, 'heuristic'),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
