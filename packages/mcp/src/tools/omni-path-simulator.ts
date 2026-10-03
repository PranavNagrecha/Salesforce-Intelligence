/**
 * Handler for `sfi.omni_path_simulator` (spec F5) — given a set of answers (a
 * data JSON, or flat `name → value` pairs), which steps and inputs of the
 * active OmniScript are shown? Show rules are evaluated three-valued: a rule
 * over an answer not supplied is `unknown` (and named), never guessed.
 *
 * For path coverage, each step also carries `reachWith` — answers that satisfy
 * its own show rule when that rule is a simple conjunction — and steps whose
 * rule contradicts itself are listed as `unreachableSteps` (UNREACHABLE_STEP).
 *
 * Phase 2: each section the app adds outside the script (declared in
 * org-kb/config/omnistudio.json `sectionEntries`, or passed as `sections`) is
 * checked for DEAD_END_SECTION — answers that add the section while its entry
 * step hides itself (`omni/dead-end.ts`).
 */

import type { McpError, McpResponse, TrustSummary } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { checkDeadEndSection, type DeadEndCheck, type SectionEntrySpec } from '../omni/dead-end.js';
import { type PathSimulation, simulatePath } from '../omni/form-spec.js';
import { buildScriptModelWithResponses } from '../omni/responses.js';
import type { OmniFinding } from '../omni/types.js';
import type { Context } from '../server.js';

import {
  buildWorldOrError,
  OMNI_MODEL_BOUNDARIES,
  type OmniAppliedScope,
  omniTrust,
  resolveOmniTarget,
} from './omni-common.js';

export const omniPathSimulatorInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  omniscript: z.string().min(1).optional(),
  answers: z.record(z.unknown()).optional(),
  /** Sections to check for DEAD_END_SECTION, beside any declared in config. */
  sections: z
    .array(
      z.object({
        step: z.string().min(1),
        enteredWhen: z.string().min(1),
        section: z.string().min(1).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export type OmniPathSimulatorInput = z.infer<typeof omniPathSimulatorInputSchema>;

/** Response payload. */
export interface OmniPathSimulatorOutput extends PathSimulation {
  readonly appliedScope: OmniAppliedScope;
  /** One result per section checked for DEAD_END_SECTION. */
  readonly deadEndChecks: readonly DeadEndCheck[];
  readonly findings: readonly OmniFinding[];
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

/** The `sfi.omni_path_simulator` handler. */
export const omniPathSimulatorHandler = async (
  ctx: Context,
  input: OmniPathSimulatorInput,
): Promise<Result<McpResponse<OmniPathSimulatorOutput>, McpError>> => {
  const worldR = await buildWorldOrError(ctx);
  if (!worldR.ok) return worldR;
  const world = worldR.value;
  const t = resolveOmniTarget(world, 'OmniScript', { componentId: input.componentId, alias: input.omniscript }, 'omniscript');
  if (!t.ok) return t;
  const loaded = await world.loadProcess(t.value.node);
  if (!loaded.ok) return { ok: false, error: { kind: 'component-not-found', message: `${t.value.node.id}: ${loaded.reason}`, path: t.value.node.sourcePath } };
  const model = await buildScriptModelWithResponses(world, loaded.value);
  const sim = simulatePath(model, input.answers ?? {});
  const header = loaded.value.doc.header;
  const scriptKeys = new Set(
    [`${header.type}/${header.subType}`, `${header.type}_${header.subType}`, model.uniqueName].map((k) => k.toLowerCase()),
  );
  const sections: SectionEntrySpec[] = [
    ...world.config.sectionEntries
      .filter((s) => scriptKeys.has(s.omniscript.trim().toLowerCase()))
      .map((s) => ({ step: s.step, enteredWhen: s.enteredWhen, section: s.section, source: 'config' as const })),
    ...(input.sections ?? []).map((s) => ({ step: s.step, enteredWhen: s.enteredWhen, section: s.section, source: 'input' as const })),
  ];
  const deadEndChecks = sections.map((s) => checkDeadEndSection(model, s));
  const findings: OmniFinding[] = sim.unreachableSteps.map((name) => {
    const step = model.elements.find((e) => e.parent === null && e.el.name === name);
    return {
      code: 'UNREACHABLE_STEP',
      verdict: 'defect' as const,
      componentId: model.componentId,
      sourcePath: model.sourcePath,
      elementPath: name,
      line: step?.el.line ?? null,
      message: `step ${name}'s show rule contradicts itself (one field required to equal two values, or to equal and not equal one value): no answers can show it`,
      confidence: 'parsed' as const,
      evidence: { show: step?.el.config?.['show'] ?? null },
      citations: [{ componentId: model.componentId, sourcePath: model.sourcePath, elementPath: name, ...(step?.el.line == null ? {} : { line: step.el.line }) }],
    };
  });
  for (const check of deadEndChecks) {
    if (check.verdict === 'clear') continue;
    const step = model.elements.find((e) => e.parent === null && e.el.name.trim() === check.step.trim());
    const label = check.section ?? check.step;
    findings.push({
      code: 'DEAD_END_SECTION',
      verdict: check.verdict === 'defect' ? 'defect' : 'unknown',
      componentId: model.componentId,
      sourcePath: model.sourcePath,
      elementPath: check.step,
      line: step?.el.line ?? null,
      message:
        check.verdict === 'defect'
          ? `section ${label} is entered when ${check.enteredWhen}, but its entry step ${check.step} is hidden for some of that population — those users cannot start it (witness answers attached)`
          : `cannot decide whether section ${label} can be entered while its entry step ${check.step} is hidden: ${check.unknownReason ?? 'not evaluable'}`,
      confidence: check.assumptions.length > 0 ? ('inferred' as const) : ('parsed' as const),
      ...(check.verdict === 'unknown' ? { unknownReason: check.unknownReason ?? 'not evaluable' } : {}),
      evidence: {
        enteredWhen: check.enteredWhen,
        enteredWhenSource: check.source,
        show: step?.el.config?.['show'] ?? null,
        witness: check.witness,
        assumptions: check.assumptions,
      },
      citations: [{ componentId: model.componentId, sourcePath: model.sourcePath, elementPath: check.step, ...(step?.el.line == null ? {} : { line: step.el.line }) }],
    });
  }
  return ok({
    data: {
      appliedScope: t.value.scope,
      ...sim,
      deadEndChecks,
      findings,
      boundaries: [
        ...OMNI_MODEL_BOUNDARIES,
        'Visibility from the answers given. A rule inside a repeating container is evaluated against the FIRST row of the answers supplied for it.',
        'DEAD_END_SECTION: when a section is added usually lives outside the script (a server formula, or custom metadata read by Apex), so it is declared in org-kb/config/omnistudio.json `sectionEntries` or passed as `sections`; without one, no section is checked. The entry step\'s rule is expanded through the Set Values that run before it; each input ranges over the literals both conditions compare it with (plus a different value and blank), which is exhaustive for equality, inequality, thresholds and CONTAINS. A Set Values key computed by a function the evaluator does not compute (AGE, arithmetic) is searched as a free input and named in `assumptions` (the finding is then `inferred`).',
      ],
      trust: omniTrust(ctx, world, 'parsed'),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
