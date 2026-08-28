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
 * it answers honestly even when the object's own definition is not modeled —
 * but the object itself must be PROVABLY THERE: an api name with neither a
 * `CustomObject` node nor a single automation edge is refused
 * (`invalid-query`), never briefed as `greenfield`. Conditions are not
 * evaluated; runtime ordering set via Flow Trigger Order and dynamic/reflective
 * invocation are out of scope.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveExistingObjectScope, toCustomObjectId } from './input-aliases.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

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
  /**
   * The object scope ACTUALLY applied, in canonical `CustomObject:` form.
   * Present on every per-object briefing (this mode is object-scoped by
   * definition) and ABSENT from the org-wide `flow-only-objects` mode, whose
   * payload is unchanged. When the caller spelled the api name in a different
   * case, this carries the VAULT's spelling — never the caller's, which would
   * assert a component id no vault holds.
   */
  readonly appliedScope: {
    readonly object: string;
    readonly mode: 'component';
  };
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
  /**
   * STRUCTURAL truncation sentinel for the corpus scan behind the set
   * difference. `false` means BOTH the Flow and the ApexTrigger corpus were
   * read to exhaustion, so the set difference is complete; `true` means a type
   * hit the residual `FULL_SCAN_MAX_NODES` ceiling and the difference may
   * contain FALSE POSITIVES (a guard that was never read) as well as misses.
   * A machine reader must branch on this, never on a boundary sentence.
   */
  readonly scanTruncated: boolean;
  /** The component types whose walk stopped at the residual cap. */
  readonly incompleteTypes: readonly string[];
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
  'The Flow and ApexTrigger corpora are scanned to EXHAUSTION (the SQL OFFSET is windowed forward past the 500-row page cap), so the set difference is computed over every node of both types. `scanTruncated` reports structurally whether any type stopped short at the residual full-scan ceiling.',
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
  // AUTOMATION-BUILD-ADVISOR-ANSWERS-FOR-NONEXISTENT-OBJECT.
  //
  // The api name used to be concatenated straight into `CustomObject:{name}`.
  // `getNodeById` WAS called on it — but a null result only set the
  // `objectModeled: false` disclosure flag; the handler then answered anyway,
  // and with no automation to report the risk synthesis fell through to its
  // `greenfield` branch. A MISTYPED object name therefore came back as:
  //
  //   risks:           [{ kind: 'greenfield', … 'No automation currently
  //                       targets Zzz_Nonexistent_Object_9x7__c in the vault —
  //                       this is greenfield…' }]
  //   recommendations: ['Greenfield object: establish the automation pattern
  //                     now …']
  //
  // — a fabricated risk and a fabricated recommendation to start building on
  // an object that does not exist. A computed flag beside them is a
  // DISCLOSURE, not a guard.
  //
  // `resolveExistingObjectScope` is the shared resolver every object-scoped
  // tool routes through (flow_fault_audit, flow_bulkification_audit,
  // unused_fields_deep, …): it rewrites a wrong-case api name to the vault's
  // exact spelling, refuses two objects differing only by case, and refuses an
  // api name no `CustomObject:` node matches.
  //
  // ONE deliberate exception, which is why the resolver's error is HELD rather
  // than returned immediately: a STANDARD object (Case) omits `<type>` in its
  // definition file, so no `CustomObject` node is materialized even though the
  // object is real and automation targets it. Edge evidence — an incoming
  // `triggersOn` or an outgoing `parentOf` — proves the object exists just as
  // well as a node does, so the refusal fires only for a GENUINE phantom: no
  // node AND no edges. That is exactly the `objectModeled` predicate below,
  // promoted from a flag the payload carried to the gate it always should
  // have been.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, { objectApiName });
  const scope = scopeResult.ok ? scopeResult.value : null;
  const objectId: ComponentId = (
    scope !== null ? scope.componentId : toCustomObjectId(objectApiName)
  ) as ComponentId;
  const input = { objectApiName: scope !== null ? scope.object : objectApiName };

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
  // OR parented rules as modeled (matching evaluateSoeAdmission). Mis-flagging a
  // standard object as not-modeled would wrongly disclaim grounded conflict /
  // co-fire analysis on it.
  const objectModeled =
    scope !== null || inResult.value.length > 0 || outResult.value.length > 0;
  // ...and a genuine phantom — no node AND no edges — is now REFUSED rather
  // than briefed as greenfield. `scopeResult.error` names the object and tells
  // the caller to check the api name or refresh; it is only ever unset when
  // `scope !== null`, which `objectModeled` already covers.
  if (!objectModeled && !scopeResult.ok) return err(scopeResult.error);
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
      // Echo the scope actually applied (vault casing), so a host can never
      // read this briefing as org-wide or as being about the caller's spelling.
      // On the standard-object path this id has no NODE of its own, but it is
      // the exact id the vault's own `triggersOn` / `parentOf` edges point at —
      // which is what admitted the object in the first place.
      appliedScope: { object: objectId, mode: 'component' },
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

  // 1) Every record-triggered Flow and Apex trigger.
  //
  // FLOW-ONLY-OBJECTS-SCANNED-ONE-ALPHABETICAL-PAGE.
  //
  // These two reads used to be a single-page `listNodesByType` per type at
  // `{ limit: 500 }`, which
  // `packages/graph/src/queries.ts` serves as `ORDER BY id ASC LIMIT 500
  // OFFSET 0` — an alphabetical FIRST PAGE, not a scan, with 500 the graph's
  // HARD ceiling (`LIST_MAX_LIMIT`) so no larger limit could reach the tail.
  // This mode computes an org-wide SET DIFFERENCE over those two corpora, so
  // the cap did not merely miss rows, it INVERTED answers in both directions:
  //   - a trigger past the page never entered `objectsWithTrigger`, so a
  //     GUARDED object was reported as flow-only and told the reader its Flow
  //     logic runs with 'NO Apex trigger guard' — a fabricated hazard;
  //   - a record-triggered Flow past the page never entered
  //     `flowCountByObject`, so a REAL gap was silently dropped, and an empty
  //     result still issued the clean bill 'no flow-only automation gap
  //     detected in the vault'.
  // The old 500-cap boundary SENTENCE was printed on every response whether or
  // not the cap bit; a boundary string is a comment, not a guard.
  //
  // `scanAllNodesOfTypes` is the shared helper (adopted by test_coverage_gaps,
  // integration_map, org_overview, endpoint_catalog, generate_admin_handbook):
  // it windows the SQL OFFSET forward until each type is exhausted and reports
  // residual incompleteness STRUCTURALLY.
  const flowsRes = await scanAllNodesOfTypes(ctx.graph, ['Flow']);
  if (!flowsRes.ok) return fail(flowsRes.error.message);
  const triggersRes = await scanAllNodesOfTypes(ctx.graph, ['ApexTrigger']);
  if (!triggersRes.ok) return fail(triggersRes.error.message);
  const incompleteTypes = [
    ...flowsRes.value.incompleteTypes,
    ...triggersRes.value.incompleteTypes,
  ];

  // Active automation nodes only — drop deactivated ones up front so the set
  // difference reflects what actually fires.
  const activeFlows = flowsRes.value.nodes.filter((n) => isActiveFlow(str(n.properties['status'])));
  const activeTriggers = triggersRes.value.nodes.filter((n) =>
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
    // An empty set difference is a CLEAN BILL, and a clean bill over an
    // unfinished scan is the fabrication this mode is most exposed to. Only
    // issue it when both corpora were exhausted.
    recommendations.push(
      incompleteTypes.length > 0
        ? `No flow-only automation gap was found, but the scan did NOT finish (${[...new Set(incompleteTypes)].sort().join(' / ')} hit the full-scan ceiling) — this is NOT a clean bill; re-run narrowed before relying on it.`
        : 'No org-custom objects run an active record-triggered Flow without an Apex trigger — no flow-only automation gap detected in the vault.',
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
      scanTruncated: incompleteTypes.length > 0,
      incompleteTypes,
      recommendations,
      boundaries:
        incompleteTypes.length > 0
          ? [...FLOW_ONLY_BOUNDARIES, fullScanTruncationNote(incompleteTypes)]
          : FLOW_ONLY_BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
