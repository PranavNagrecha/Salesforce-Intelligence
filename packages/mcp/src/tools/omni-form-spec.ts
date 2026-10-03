/**
 * Handler for `sfi.omni_form_spec` (spec F5) — the machine-readable form a
 * browser test runner fills: for the active OmniScript, every step and its
 * inputs (data key, kind, mask, pattern, length limits, required, resolved
 * label, options as stored name + label, repeat flag, show rule) with a sample
 * value that satisfies them; plus the pattern checks the metadata can make on
 * its own (PATTERN_INVALID_IN_BROWSER, PATTERN_WEAKER_THAN_MASK) and, across
 * every active script, INCONSISTENT_FIELD_RULES for the same kind of field.
 */

import type { McpError, McpResponse, PageInfo, TrustSummary } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { buildFormSpec, checkConsistency, checkPatterns, type FormSpecStep } from '../omni/form-spec.js';
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

const TOOL = 'sfi.omni_form_spec';

export const omniFormSpecInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  omniscript: z.string().min(1).optional(),
  step: z.string().min(1).optional(),
  /** Also compare field rules across every active script (INCONSISTENT_FIELD_RULES). */
  crossScript: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

export type OmniFormSpecInput = z.infer<typeof omniFormSpecInputSchema>;

/** Response payload. */
export interface OmniFormSpecOutput {
  readonly appliedScope: OmniAppliedScope & { readonly step: string | null };
  readonly config: { readonly status: string; readonly path: string };
  readonly omniscript: string;
  readonly version: number | null;
  /** Steps (paged). */
  readonly steps: readonly FormSpecStep[];
  readonly patternsDeclared: number;
  readonly findings: readonly OmniFinding[];
  readonly pageInfo: PageInfo;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const FORM_BOUNDARIES: readonly string[] = Object.freeze([
  'Only patterns DECLARED in metadata are known. A pattern a browser reports that no element declares (e.g. a component\'s built-in email pattern) must be reported as "source not identified", never attributed to an element.',
  '`sampleValue` satisfies the declared mask, pattern, length limits and option names; app-specific rules the metadata does not state (e.g. a rejected number range) need an override in org-kb/config/omnistudio.json `sampleValues`.',
  'An option\'s `stored` value (its `name`) is what the data JSON holds and what show rules compare; `label` (its `value`) is the label shown — often a Custom Label name.',
  'INCONSISTENT_FIELD_RULES groups fields by element NAME (zip / phone / email / ssn) — `inferred`.',
]);

/** The `sfi.omni_form_spec` handler. */
export const omniFormSpecHandler = async (
  ctx: Context,
  input: OmniFormSpecInput,
): Promise<Result<McpResponse<OmniFormSpecOutput>, McpError>> => {
  const worldR = await buildWorldOrError(ctx);
  if (!worldR.ok) return worldR;
  const world = worldR.value;
  const t = resolveOmniTarget(world, 'OmniScript', { componentId: input.componentId, alias: input.omniscript }, 'omniscript');
  if (!t.ok) return t;
  const loaded = await world.loadProcess(t.value.node);
  if (!loaded.ok) return { ok: false, error: { kind: 'component-not-found', message: `${t.value.node.id}: ${loaded.reason}`, path: t.value.node.sourcePath } };
  const model = buildScriptModel(loaded.value, { customLwcOutputs: world.config.customLwcOutputs, launchParameters: world.config.launchParameters });
  const allSteps = await buildFormSpec(world, model);
  if (input.step !== undefined && !allSteps.some((s) => s.name === input.step)) {
    return { ok: false, error: { kind: 'invalid-query', message: `step '${input.step}' is not a Step of ${t.value.node.id}`, path: 'step' } };
  }
  const steps = input.step === undefined ? allSteps : allSteps.filter((s) => s.name === input.step);
  const patterns = checkPatterns(model, steps);
  const findings: OmniFinding[] = [...patterns.findings];
  if (input.crossScript === true) {
    const specs = [];
    for (const n of world.scripts.filter((x) => x.properties['isActive'] === true)) {
      const l = await world.loadProcess(n);
      if (!l.ok) continue;
      const m = buildScriptModel(l.value, { customLwcOutputs: world.config.customLwcOutputs });
      specs.push({ script: m, steps: await buildFormSpec(world, m) });
    }
    findings.push(...checkConsistency(specs).filter((f) => f.componentId === t.value.node.id));
  }
  const fingerprint = argsFingerprint({ componentId: t.value.scope.componentId, step: input.step ?? null, crossScript: input.crossScript ?? false });
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint });
    if (!decoded.ok) return decoded;
    offset = decoded.value.o;
  }
  const page = paginate(steps, {
    offset,
    limit: input.limit ?? 50,
    byteBudget: 28_000,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    keyOf: (s) => s.name,
  });
  return ok({
    data: {
      appliedScope: { ...t.value.scope, step: input.step ?? null },
      config: configEcho(world.configSource),
      omniscript: t.value.scope.uniqueName,
      version: t.value.scope.versionNumber,
      steps: page.items,
      patternsDeclared: patterns.declared,
      findings: findings.sort(compareFindings),
      pageInfo: page.pageInfo,
      boundaries: [...OMNI_MODEL_BOUNDARIES, ...FORM_BOUNDARIES],
      trust: omniTrust(ctx, world, 'parsed'),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
