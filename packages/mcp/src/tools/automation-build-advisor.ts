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
import {
  getNodeById,
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
  listNodesByType,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Zod schema for the `sfi.automation_build_advisor` tool input.
 *
 * Two modes (presence of `objectApiName` vs `scope` selects):
 *   - PER-OBJECT (default): pass `objectApiName` for the single-object briefing.
 *   - ORG-WIDE GAP (`scope: 'flow-only-objects'`): no object needed; returns the
 *     org-wide set difference of objects with an active record-triggered Flow but
 *     ZERO active Apex triggers, annotated with master-detail-child / junction
 *     role. Exactly one of the two must be supplied.
 */
export const automationBuildAdvisorInputSchema = z
  .object({
    objectApiName: z.string().min(1).optional(),
    scope: z.literal('flow-only-objects').optional(),
  })
  .refine((v) => (v.objectApiName != null) !== (v.scope != null), {
    message:
      "supply exactly one of `objectApiName` (per-object briefing) or `scope: 'flow-only-objects'` (org-wide flow-only gap)",
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
  readonly mode: 'per-object';
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

/**
 * The relationship role of a flow-only object, derived from outbound
 * master-detail `lookupTo` edges on the fields parented under it:
 *   - `master-detail-child`: exactly one master-detail parent.
 *   - `junction`: TWO+ master-detail parents (a junction object).
 *   - `lookup-only`: no master-detail parent (standalone or lookup-only child).
 */
export type ObjectRelationshipRole =
  | 'master-detail-child'
  | 'junction'
  | 'lookup-only';

/** One object that has active Flow automation but ZERO active Apex triggers. */
export interface FlowOnlyObject {
  readonly id: ComponentId;
  readonly apiName: string;
  /** Active record-triggered Flows targeting this object. */
  readonly activeFlowCount: number;
  readonly relationshipRole: ObjectRelationshipRole;
  /** Master-detail PARENT object ids (the objects this one cascades under). */
  readonly masterDetailParents: readonly ComponentId[];
}

export interface FlowOnlyObjectsOutput {
  readonly mode: 'flow-only-objects';
  readonly summary: {
    /** Org-custom objects (`__c`, no managed namespace) that are flow-only. */
    readonly orgCustomCount: number;
    readonly masterDetailChildCount: number;
    readonly junctionCount: number;
  };
  /** Sorted by id; org-custom objects only (standard + managed excluded). */
  readonly flowOnlyObjects: readonly FlowOnlyObject[];
  readonly recommendations: readonly string[];
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'Lists automation that TARGETS this object from the vault — every entry is a real node, not a fabricated save sequence. Conditions are not evaluated.',
  'Runtime Flow Trigger Order, dynamic/reflective invocation, and managed-package automation are out of scope; treat the ordering risk as "verify", not "proven".',
]);

const FLOW_ONLY_BOUNDARIES: readonly string[] = Object.freeze([
  'Org-wide set difference: objects with >=1 ACTIVE record-triggered Flow MINUS objects with >=1 ACTIVE Apex trigger. Standard objects (no `__c` suffix) and managed-package objects (namespaced API names) are EXCLUDED — only org-custom objects are listed.',
  'A record-triggered Flow is one whose incoming `triggersOn` edge carries a `recordTriggerType`; "active" reads the Flow node `status` (Active, or unset). Apex-trigger activity reads the ApexTrigger node `status`.',
  'Relationship role is derived from master-detail `lookupTo` edges on the object’s own fields (relationshipType === "MasterDetail"): one parent = master-detail child, two+ = junction. These flow-only objects run cascade-delete-time Flow logic with NO Apex trigger guard. Conditions are not evaluated and Flow Trigger Order is out of scope; treat as "verify".',
  'The Flow and ApexTrigger scans read up to 500 nodes each (the graph list cap); on an org with more than 500 of either, the gap set is computed over a deterministic prefix — re-verify on very large orgs.',
]);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const isActiveFlow = (status: string | null): boolean => status === null || status === 'Active';

/** An Apex trigger is "active" unless its status is explicitly Inactive/Deleted. */
const isActiveTrigger = (status: string | null): boolean =>
  status === null || status === 'Active';

/**
 * Namespace heuristic (mirrors `package_impact`'s `namespaceOf`): a Salesforce
 * API name carries a managed-package namespace iff its leaf splits into >= 3
 * `__`-delimited segments (`NS__Object__c`). `Object__c` (2 segments) and
 * standard names (`Account`) carry none. We exclude any managed/namespaced
 * object from the org-wide gap view — the admin can't add a trigger guard to
 * a managed object.
 */
const isManagedApiName = (apiName: string): boolean =>
  apiName.split('__').length >= 3;

/**
 * Org-custom object = ends in the `__c` custom suffix AND is not namespaced.
 * Standard objects (`Account`, `Case`) and managed objects (`NS__X__c`) are
 * excluded from the flow-only gap view.
 */
const isOrgCustomObject = (apiName: string): boolean =>
  apiName.endsWith('__c') && !isManagedApiName(apiName);

/**
 * The `sfi.automation_build_advisor` MCP tool. Dispatches on input shape:
 * `objectApiName` → per-object briefing; `scope: 'flow-only-objects'` → the
 * org-wide flow-only gap view. See module JSDoc for composition and honesty.
 *
 * @example
 *   const r = await automationBuildAdvisorHandler(ctx, { objectApiName: 'Account' });
 *   if (r.ok && r.value.data.mode === 'per-object') console.log(r.value.data.risks);
 *   const g = await automationBuildAdvisorHandler(ctx, { scope: 'flow-only-objects' });
 *   if (g.ok && g.value.data.mode === 'flow-only-objects') console.log(g.value.data.summary);
 */
export const automationBuildAdvisorHandler = async (
  ctx: Context,
  input: AutomationBuildAdvisorInput,
): Promise<
  Result<
    McpResponse<AutomationBuildAdvisorOutput | FlowOnlyObjectsOutput>,
    McpError
  >
> => {
  if (input.scope === 'flow-only-objects') {
    return flowOnlyObjectsHandler(ctx);
  }
  return perObjectHandler(ctx, input.objectApiName as string);
};

/**
 * Per-object briefing (the original tool behavior). See module JSDoc.
 */
const perObjectHandler = async (
  ctx: Context,
  objectApiName: string,
): Promise<Result<McpResponse<AutomationBuildAdvisorOutput>, McpError>> => {
  const input = { objectApiName };
  const objectId: ComponentId = `CustomObject:${input.objectApiName}`;

  const objNode = await getNodeById(ctx.graph, objectId);
  if (!objNode.ok) return err({ kind: 'internal', message: `graph query failed: ${objNode.error.message}` });

  // Incoming triggersOn edges → record-triggered Flows / ApexTriggers / WorkflowRules.
  const inResult = await listEdges(ctx.graph, objectId, { direction: 'in', edgeType: 'triggersOn' });
  if (!inResult.ok) return err({ kind: 'internal', message: `graph query failed: ${inResult.error.message}` });

  // ONE batched node fetch for every triggersOn source, replacing the per-edge
  // `getNodeById` N+1. The per-edge Map lookup preserves the old null-skip and
  // reads each edge's own `recordTriggerType`; the byId sort below makes push
  // order irrelevant.
  const inNodesResult = await listNodesByIds(ctx.graph, inResult.value.map((e) => e.fromId));
  if (!inNodesResult.ok) return err({ kind: 'internal', message: `graph query failed: ${inNodesResult.error.message}` });
  const inNodeById = new Map(inNodesResult.value.map((node) => [node.id, node]));

  const recordTriggeredFlows: FlowRef[] = [];
  const apexTriggers: TriggerRef[] = [];
  const workflowRules: ComponentId[] = [];
  for (const edge of inResult.value) {
    const n = inNodeById.get(edge.fromId);
    if (n === undefined) continue;
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

  // A present node means modeled, but a STANDARD object (e.g. Case) legitimately
  // omits <type> in its definition file, so no CustomObject node is materialized
  // even though the object IS modeled. Treat node-present OR incoming automation
  // OR parented rules as modeled (matching evaluateSoeAdmission); only a genuine
  // phantom — no node and no edges — stays objectModeled:false. Mis-flagging a
  // standard object as not-modeled would wrongly disclaim grounded conflict /
  // co-fire analysis on it.
  const objectModeled =
    objNode.value !== null || inResult.value.length > 0 || outResult.value.length > 0;
  // ONE batched node fetch for every parentOf child, replacing the per-edge
  // `getNodeById` N+1 (a missing id maps to `undefined`, matching the old
  // `node.value?.type` optional-chaining skip).
  const outNodesResult = await listNodesByIds(ctx.graph, outResult.value.map((e) => e.toId));
  if (!outNodesResult.ok) return err({ kind: 'internal', message: `graph query failed: ${outNodesResult.error.message}` });
  const outNodeById = new Map(outNodesResult.value.map((node) => [node.id, node]));

  const validationRules: RuleRef[] = [];
  for (const edge of outResult.value) {
    const node = outNodeById.get(edge.toId);
    if (node?.type === 'ValidationRule') {
      const active = node.properties['active'];
      validationRules.push({ id: node.id, active: typeof active === 'boolean' ? active : null });
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
      mode: 'per-object',
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

/**
 * Org-wide flow-only-objects gap analytic. Computes the set difference:
 *
 *   { objects with >=1 ACTIVE record-triggered Flow }
 *     MINUS { objects with >=1 ACTIVE Apex trigger }
 *
 * restricted to ORG-CUSTOM objects (standard + managed excluded), then
 * annotates each with its master-detail relationship role (child / junction /
 * lookup-only) using outbound `lookupTo` edges on the object's fields. These
 * are exactly the objects exposed to cascade-delete-time Flow execution with no
 * Apex trigger guard — the gap no single per-object tool surfaces.
 */
const flowOnlyObjectsHandler = async (
  ctx: Context,
): Promise<Result<McpResponse<FlowOnlyObjectsOutput>, McpError>> => {
  const fail = (m: string): Result<never, McpError> =>
    err({ kind: 'internal', message: `graph query failed: ${m}` });

  // 1) Every record-triggered Flow and Apex trigger, in one type scan each.
  const flowsRes = await listNodesByType(ctx.graph, 'Flow', { limit: 500 });
  if (!flowsRes.ok) return fail(flowsRes.error.message);
  const triggersRes = await listNodesByType(ctx.graph, 'ApexTrigger', { limit: 500 });
  if (!triggersRes.ok) return fail(triggersRes.error.message);

  // Active automation nodes only — drop deactivated ones up front so the set
  // difference reflects what actually fires.
  const activeFlows = flowsRes.value.filter((n) => isActiveFlow(str(n.properties['status'])));
  const activeTriggers = triggersRes.value.filter((n) =>
    isActiveTrigger(str(n.properties['status'])),
  );

  // 2) The objects each kind of automation targets, via outbound `triggersOn`.
  //    For Flows we additionally require the edge to be RECORD-triggered
  //    (`recordTriggerType` present) — a screen/autolaunched Flow is not.
  const flowEdges = await listEdgesForNodes(
    ctx.graph,
    activeFlows.map((n) => n.id),
    { direction: 'out', edgeTypes: ['triggersOn'] },
  );
  if (!flowEdges.ok) return fail(flowEdges.error.message);
  const triggerEdges = await listEdgesForNodes(
    ctx.graph,
    activeTriggers.map((n) => n.id),
    { direction: 'out', edgeTypes: ['triggersOn'] },
  );
  if (!triggerEdges.ok) return fail(triggerEdges.error.message);

  // objectId → count of active record-triggered Flows targeting it.
  const flowCountByObject = new Map<ComponentId, number>();
  for (const flow of activeFlows) {
    for (const e of flowEdges.value.get(flow.id) ?? []) {
      if (str(e.properties['recordTriggerType']) === null) continue;
      flowCountByObject.set(e.toId, (flowCountByObject.get(e.toId) ?? 0) + 1);
    }
  }
  // objectIds with >=1 active Apex trigger.
  const objectsWithTrigger = new Set<ComponentId>();
  for (const trig of activeTriggers) {
    for (const e of triggerEdges.value.get(trig.id) ?? []) {
      objectsWithTrigger.add(e.toId);
    }
  }

  // 3) Set difference, restricted to org-custom objects.
  const candidateIds: ComponentId[] = [];
  for (const objectId of flowCountByObject.keys()) {
    if (objectsWithTrigger.has(objectId)) continue;
    const apiName = objectId.startsWith('CustomObject:')
      ? objectId.slice('CustomObject:'.length)
      : objectId;
    if (!isOrgCustomObject(apiName)) continue;
    candidateIds.push(objectId);
  }
  candidateIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // 4) Annotate each with its master-detail role. A CustomField parented under
  //    the object that has an outbound `lookupTo` edge with
  //    relationshipType === 'MasterDetail' makes the object an MD child of the
  //    edge's target; two+ distinct MD parents make it a junction.
  //    Gather the object's child fields (parentOf), then their lookupTo edges.
  const parentEdges = await listEdgesForNodes(ctx.graph, candidateIds, {
    direction: 'out',
    edgeTypes: ['parentOf'],
  });
  if (!parentEdges.ok) return fail(parentEdges.error.message);

  const fieldIdsByObject = new Map<ComponentId, ComponentId[]>();
  const allFieldIds: ComponentId[] = [];
  for (const objectId of candidateIds) {
    const fieldIds = (parentEdges.value.get(objectId) ?? [])
      .filter((e) => e.toId.startsWith('CustomField:'))
      .map((e) => e.toId);
    fieldIdsByObject.set(objectId, fieldIds);
    allFieldIds.push(...fieldIds);
  }
  const lookupEdges = await listEdgesForNodes(ctx.graph, allFieldIds, {
    direction: 'out',
    edgeTypes: ['lookupTo'],
  });
  if (!lookupEdges.ok) return fail(lookupEdges.error.message);

  const flowOnlyObjects: FlowOnlyObject[] = [];
  let masterDetailChildCount = 0;
  let junctionCount = 0;
  for (const objectId of candidateIds) {
    const mdParents = new Set<ComponentId>();
    for (const fieldId of fieldIdsByObject.get(objectId) ?? []) {
      for (const e of lookupEdges.value.get(fieldId) ?? []) {
        if (str(e.properties['relationshipType']) === 'MasterDetail') {
          mdParents.add(e.toId);
        }
      }
    }
    const masterDetailParents = [...mdParents].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let relationshipRole: ObjectRelationshipRole;
    if (masterDetailParents.length >= 2) {
      relationshipRole = 'junction';
      junctionCount += 1;
    } else if (masterDetailParents.length === 1) {
      relationshipRole = 'master-detail-child';
      masterDetailChildCount += 1;
    } else {
      relationshipRole = 'lookup-only';
    }
    flowOnlyObjects.push({
      id: objectId,
      apiName: objectId.startsWith('CustomObject:')
        ? objectId.slice('CustomObject:'.length)
        : objectId,
      activeFlowCount: flowCountByObject.get(objectId) ?? 0,
      relationshipRole,
      masterDetailParents,
    });
  }

  const recommendations: string[] = [];
  if (flowOnlyObjects.length === 0) {
    recommendations.push(
      'No org-custom objects run an active record-triggered Flow without an Apex trigger — no flow-only automation gap detected in the vault.',
    );
  } else {
    recommendations.push(
      `${flowOnlyObjects.length} org-custom object(s) run active record-triggered Flow logic with NO Apex trigger guard. Review each before relying on a trigger to enforce invariants.`,
    );
    if (masterDetailChildCount > 0) {
      recommendations.push(
        `${masterDetailChildCount} are master-detail children — cascade-delete on the parent runs their Flow logic with no trigger to intercept; confirm the Flow handles the delete path.`,
      );
    }
    if (junctionCount > 0) {
      recommendations.push(
        `${junctionCount} are junction objects (two master-detail parents) — flow-only automation on a junction fires on either parent's cascade; verify both paths.`,
      );
    }
  }

  return ok({
    data: {
      mode: 'flow-only-objects',
      summary: {
        orgCustomCount: flowOnlyObjects.length,
        masterDetailChildCount,
        junctionCount,
      },
      flowOnlyObjects,
      recommendations,
      boundaries: FLOW_ONLY_BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
