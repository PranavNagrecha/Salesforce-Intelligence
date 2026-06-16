/**
 * Handler for the `sfi.automation_build_advisor` MCP tool.
 *
 * The decision-support "before I build automation here, what should I know?"
 * tool. Given an object, it briefs the admin/architect on the automation that
 * ALREADY fires on it and the org-specific risks of adding more — so they make
 * a better build decision. It does NOT build anything (this is a backend
 * knowledge layer, not an authoring tool); it arms the decision.
 *
 * Composes the object's incoming `triggersOn` edges (record-triggered Flows,
 * ApexTriggers, WorkflowRules) and parented `parentOf` ValidationRules into:
 *   - `existingAutomation`: what already runs on save.
 *   - `risks`: org-specific hazards — multiple record-triggered Flows on one
 *     object (Salesforce does not guarantee their order), mixed Apex-trigger +
 *     Flow automation (duplicate/looping logic), and heavy validation load.
 *   - `recommendations`: plain-language guidance synthesised from the above.
 *
 * **Honesty axis**: every listed component is a real vault node. The advisor
 * lists automation that TARGETS the object (not a fabricated save sequence), so
 * it answers honestly even when the object's own definition is not modeled.
 * Conditions are not evaluated; runtime ordering set via Flow Trigger Order and
 * dynamic/reflective invocation are out of scope.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Zod schema for the `sfi.automation_build_advisor` tool input. */
export const automationBuildAdvisorInputSchema = z.object({
  objectApiName: z.string().min(1),
});

export type AutomationBuildAdvisorInput = z.infer<
  typeof automationBuildAdvisorInputSchema
>;

export interface FlowRef {
  readonly id: ComponentId;
  readonly recordTriggerType: string | null;
  readonly status: string | null;
}
export interface TriggerRef {
  readonly id: ComponentId;
  readonly status: string | null;
}
export interface RuleRef {
  readonly id: ComponentId;
  readonly active: boolean | null;
}

export interface AutomationRisk {
  readonly kind: 'flow-ordering' | 'mixed-trigger-and-flow' | 'validation-load' | 'greenfield';
  readonly severity: 'info' | 'medium' | 'high';
  readonly detail: string;
}

export interface AutomationBuildAdvisorOutput {
  readonly objectApiName: string;
  readonly objectModeled: boolean;
  readonly existingAutomation: {
    readonly recordTriggeredFlows: readonly FlowRef[];
    readonly apexTriggers: readonly TriggerRef[];
    readonly validationRules: readonly RuleRef[];
    readonly workflowRules: readonly ComponentId[];
  };
  readonly risks: readonly AutomationRisk[];
  readonly recommendations: readonly string[];
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'Lists automation that TARGETS this object from the vault — every entry is a real node, not a fabricated save sequence. Conditions are not evaluated.',
  'Runtime Flow Trigger Order, dynamic/reflective invocation, and managed-package automation are out of scope; treat the ordering risk as "verify", not "proven".',
]);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const isActiveFlow = (status: string | null): boolean => status === null || status === 'Active';

/**
 * The `sfi.automation_build_advisor` MCP tool. See module JSDoc for the
 * composition and honesty axis.
 *
 * @example
 *   const r = await automationBuildAdvisorHandler(ctx, { objectApiName: 'Account' });
 *   if (r.ok) console.log(r.value.data.risks, r.value.data.recommendations);
 */
export const automationBuildAdvisorHandler = async (
  ctx: Context,
  input: AutomationBuildAdvisorInput,
): Promise<Result<McpResponse<AutomationBuildAdvisorOutput>, McpError>> => {
  const objectId: ComponentId = `CustomObject:${input.objectApiName}`;

  const objNode = await getNodeById(ctx.graph, objectId);
  if (!objNode.ok) return err({ kind: 'internal', message: `graph query failed: ${objNode.error.message}` });
  const objectModeled = objNode.value !== null;

  // Incoming triggersOn edges → record-triggered Flows / ApexTriggers / WorkflowRules.
  const inResult = await listEdges(ctx.graph, objectId, { direction: 'in', edgeType: 'triggersOn' });
  if (!inResult.ok) return err({ kind: 'internal', message: `graph query failed: ${inResult.error.message}` });

  const recordTriggeredFlows: FlowRef[] = [];
  const apexTriggers: TriggerRef[] = [];
  const workflowRules: ComponentId[] = [];
  for (const edge of inResult.value) {
    const node = await getNodeById(ctx.graph, edge.fromId);
    if (!node.ok) return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
    if (node.value === null) continue;
    const n = node.value;
    if (n.type === 'Flow') {
      recordTriggeredFlows.push({
        id: n.id,
        recordTriggerType: str(edge.properties['recordTriggerType']),
        status: str(n.properties['status']),
      });
    } else if (n.type === 'ApexTrigger') {
      apexTriggers.push({ id: n.id, status: str(n.properties['status']) });
    } else if (n.type === 'WorkflowRule') {
      workflowRules.push(n.id);
    }
  }

  // Parented ValidationRules (parentOf from the object).
  const outResult = await listEdges(ctx.graph, objectId, { direction: 'out', edgeType: 'parentOf' });
  if (!outResult.ok) return err({ kind: 'internal', message: `graph query failed: ${outResult.error.message}` });
  const validationRules: RuleRef[] = [];
  for (const edge of outResult.value) {
    const node = await getNodeById(ctx.graph, edge.toId);
    if (!node.ok) return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
    if (node.value?.type === 'ValidationRule') {
      const active = node.value.properties['active'];
      validationRules.push({ id: node.value.id, active: typeof active === 'boolean' ? active : null });
    }
  }

  // Sort for determinism.
  const byId = <T extends { id: ComponentId }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  recordTriggeredFlows.sort(byId);
  apexTriggers.sort(byId);
  validationRules.sort(byId);
  workflowRules.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // --- Risk synthesis ---
  const risks: AutomationRisk[] = [];
  const recommendations: string[] = [];

  const activeFlows = recordTriggeredFlows.filter((f) => isActiveFlow(f.status));
  if (activeFlows.length >= 2) {
    risks.push({
      kind: 'flow-ordering',
      severity: 'high',
      detail: `${activeFlows.length} active record-triggered Flows already run on ${input.objectApiName}. Salesforce does not guarantee execution order between record-triggered Flows on the same object/event.`,
    });
    recommendations.push(
      'Set explicit Flow Trigger Order on each record-triggered Flow (or consolidate into one), so your new automation runs deterministically.',
    );
  }
  if (apexTriggers.length >= 1 && recordTriggeredFlows.length >= 1) {
    risks.push({
      kind: 'mixed-trigger-and-flow',
      severity: 'medium',
      detail: `${input.objectApiName} has BOTH ApexTrigger automation (${apexTriggers.length}) and record-triggered Flows (${recordTriggeredFlows.length}). Mixed paradigms risk duplicate logic and trigger/flow recursion.`,
    });
    recommendations.push(
      'Decide which paradigm owns this object (trigger framework vs Flow) before adding more; document where the new logic belongs to avoid double-processing.',
    );
  }
  const activeVRs = validationRules.filter((v) => v.active !== false);
  if (activeVRs.length >= 5) {
    risks.push({
      kind: 'validation-load',
      severity: 'medium',
      detail: `${activeVRs.length} active validation rules already fire on save of ${input.objectApiName}. A new field-update or required-field change may collide with one.`,
    });
    recommendations.push(
      `Review the ${activeVRs.length} existing validation rules for overlap before adding constraints; consider whether a new rule should be additive or replace an old one.`,
    );
  }
  if (
    recordTriggeredFlows.length === 0 &&
    apexTriggers.length === 0 &&
    workflowRules.length === 0 &&
    activeVRs.length === 0
  ) {
    risks.push({
      kind: 'greenfield',
      severity: 'info',
      detail: `No automation currently targets ${input.objectApiName} in the vault — this is greenfield (or its automation isn't extracted).`,
    });
    recommendations.push(
      'Greenfield object: establish the automation pattern now (e.g. one record-triggered Flow, or a trigger handler framework) so future builds stay consistent.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      `Existing automation on ${input.objectApiName} looks manageable; still review the components above and run sfi.what_happens_on_save before building to see the full save sequence.`,
    );
  }

  return ok({
    data: {
      objectApiName: input.objectApiName,
      objectModeled,
      existingAutomation: { recordTriggeredFlows, apexTriggers, validationRules, workflowRules },
      risks,
      recommendations,
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
