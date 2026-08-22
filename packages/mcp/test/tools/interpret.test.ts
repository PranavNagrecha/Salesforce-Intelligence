/// <reference types="vitest/globals" />

/**
 * RM-wire — unit tests for the `sfi.interpret` MCP tool over a SYNTHETIC
 * in-memory graph (no real org, no vault). Proves:
 *   - a master-detail CustomField fires the cascade rule (edge + endpoint node);
 *   - a Summary CustomField fires the roll-up rule (node predicate);
 *   - a CustomObject with automation fires the status-code cross-ref rule
 *     (citing ONLY the automation endpoint, never the object);
 *   - a fired interpretation's confidence is the WEAKEST of the rule ceiling
 *     and its matched edges (a heuristic edge → heuristic claim, not declared);
 *   - a dangling edge endpoint (absent from the assembled slice) is NEVER cited;
 *   - the empty-result path emits the honest "no rule fired" disclosure — NOT
 *     an absence claim;
 *   - the coverage adapter maps complete / partial / unknown correctly and a
 *     truncated slice forces coverage down to at most partial — AND, e2e, a
 *     component over SLICE_EDGE_CAP truncates the slice and degrades a
 *     would-be-`complete` coverage to `partial` through the handler.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { CoverageSummary, ExtendedVaultManifest } from '@sf-intelligence/vault';

import { CHAINED_RULES } from '../../src/knowledge/chained-rules.js';
import { COMPOUND_RULES } from '../../src/knowledge/compound-rules.js';
import { CONCEPT_RULES } from '../../src/knowledge/loader.js';
import { SUPERSEDES_RULES } from '../../src/knowledge/supersedes-rules.js';
import type { Context } from '../../src/server.js';
import {
  adaptCoverage,
  interpretHandler,
} from '../../src/tools/interpret.js';
import { dispatchTool } from '../../src/tools/tool-dispatch.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-interpret',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'synthetic-test',
  properties: {},
  ...overrides,
});

// Master-detail child field → parent object (lookupTo, relationshipType MD).
const MD_FIELD = 'CustomField:Child__c.Parent__c';
const PARENT_OBJ = 'CustomObject:Parent__c';
// Roll-up summary field on the parent.
const ROLLUP_FIELD = 'CustomField:Parent__c.ChildCount__c';
// Object with automation firing on save.
const AUTO_OBJ = 'CustomObject:Order__c';
const TRIGGER = 'ApexTrigger:OrderTrigger';
const FLOW = 'Flow:OrderBeforeSave';
// A plain field nothing structural applies to (empty-result path).
const PLAIN_FIELD = 'CustomField:Account.Plain__c';
// Object whose ONLY save automation is a HEURISTIC-confidence trigger — proves
// a fired interpretation's confidence is the WEAKEST of the rule ceiling and
// its matched edges, not the declared rule ceiling (RM-wire HIGH gap).
const WEAK_OBJ = 'CustomObject:WeakOrder__c';
const WEAK_TRIGGER = 'ApexTrigger:WeakOrderTrigger';
// Master-detail child whose parent object is ABSENT from the vault — a legal
// dangling `lookupTo` (managed/standard master not retrieved). The dangling
// parent id must NOT be cited (it never resolves in the assembled slice).
const DANGLING_MD_FIELD = 'CustomField:Detail__c.GhostParent__c';
const GHOST_PARENT_OBJ = 'CustomObject:GhostParent__c'; // deliberately NOT seeded

// RM-loop JOIN fixture — a firer whose firing condition gates on a field that a
// DIFFERENT automation writes (a real coupled-field-write), plus a self-write on
// the SAME field to prove W≠F. The writer is NOT incident to the firer, so the
// handler's 2-hop slice assembly is what surfaces it.
const COUPLED_FIRER = 'WorkflowRule:Coupled__c.Gate'; // F
const COUPLED_CC = 'ConditionalContext:WorkflowRule:Coupled__c.Gate.condition-0';
const COUPLED_FIELD = 'CustomField:Coupled__c.Status__c'; // X (same object as F)
const COUPLED_WRITER = 'Flow:CoupledWriter'; // W ≠ F

// FIX 1 leak fixture — a firer whose gated field is a Summary field. Querying the
// FIRER drags that field into the slice via the 2-hop expansion; the node-shaped
// roll-up rule must NOT (mis)fire on the neighbor — only on the queried root.
const LEAK_FIRER = 'WorkflowRule:Leak__c.Gate';
const LEAK_CC = 'ConditionalContext:WorkflowRule:Leak__c.Gate.condition-0';
const LEAK_SUMMARY_FIELD = 'CustomField:Leak__c.Rollup__c'; // dataType: Summary (roll-up)
const LEAK_WRITER = 'Flow:LeakWriter';
// FIX 1 own-component fixture — a formula field fires field-provenance when queried.
const FORMULA_FIELD = 'CustomField:Account.Score__c'; // isFormula: true
// FIX 2 fixture — a record-triggered FLOW firer (object-less id). Its object is
// derived from its triggersOn edge, so it couples on a same-object gated field.
const FLOW_FIRER = 'Flow:DealGateFlow';
const FLOW_CC = 'ConditionalContext:Flow:DealGateFlow.start';
const FLOW_TRIGGER_OBJ = 'CustomObject:DealObj__c';
const FLOW_GATED_FIELD = 'CustomField:DealObj__c.Status__c'; // same object as the triggersOn target
const FLOW_WRITER = 'ApexClass:DealObjWriter';
// RM-loop PASS 2 fixture — a ValidationRule firer (pre-save-validation) gating on
// a field a BEFORE-SAVE Flow writer (before-save-flows) computes. The writer's
// before/after-save timing lives on ITS OWN triggersOn edge, which the handler's
// 2-hop assembly must now pull so the engine can PROVE the cross-phase upgrade.
const CP_FIRER = 'ValidationRule:Cp__c.Status_Gate'; // F, object Cp__c
const CP_CC = 'ConditionalContext:ValidationRule:Cp__c.Status_Gate.condition-0';
const CP_FIELD = 'CustomField:Cp__c.Status__c'; // X (same object as F)
const CP_WRITER = 'Flow:CpBeforeSaveComputer'; // W, before-save flow
const CP_WRITER_OBJ = 'CustomObject:Cp__c'; // W's triggersOn target (carries triggerType)

// AGGREGATE fixture: an object with TWO ACTIVE before-save record-triggered
// flows — the stacked-record-triggered-flows rule should fire (count 2, before).
// A THIRD before-save flow is OBSOLETE: it rides the same 1-hop slice (its
// `status` property is carried on the assembled Flow node) and must be excluded
// by the active filter END-TO-END, so the count stays 2 (FIX 3 e2e).
const STACK_OBJ = 'CustomObject:Stack__c';
const STACK_FLOW_A = 'Flow:StackBeforeA';
const STACK_FLOW_B = 'Flow:StackBeforeB';
const STACK_FLOW_OBSOLETE = 'Flow:StackBeforeObsolete';

// JUNCTION fixture (RM-reason junction): an object with EXACTLY two master-detail
// parents. The master-detail `lookupTo` edges hang off the object's CHILD FIELDS,
// so the object node has ZERO incident ones — the junction rule fires only if the
// handler's `root-children-outgoing` 2-hop pull (child fields via `parentOf`,
// their outgoing lookupTo edges, the parent objects) surfaces them. A THIRD child
// field carries a plain LOOKUP (not master-detail) that must NOT count, and a
// FOURTH master-detail field points at the SAME parent as the first (distinct-to
// dedup: still exactly two DISTINCT parents).
const JUNC_OBJ = 'CustomObject:JuncLink__c';
const JUNC_PARENT_A = 'CustomObject:JuncAlpha__c';
const JUNC_PARENT_B = 'CustomObject:JuncBeta__c';
const JUNC_PARENT_C = 'CustomObject:JuncGamma__c';
const JUNC_FIELD_A = 'CustomField:JuncLink__c.AlphaRef__c'; // MD → A
const JUNC_FIELD_B = 'CustomField:JuncLink__c.BetaRef__c'; // MD → B
const JUNC_FIELD_A2 = 'CustomField:JuncLink__c.AlphaRef2__c'; // MD → A (same parent as A)
const JUNC_FIELD_LOOKUP = 'CustomField:JuncLink__c.GammaRef__c'; // plain Lookup → C
// A single-master child (negative case): exactly ONE master-detail parent.
const SINGLE_MD_OBJ = 'CustomObject:SingleDetail__c';
const SINGLE_MD_FIELD = 'CustomField:SingleDetail__c.OnlyParent__c';

// P1-B REASONING-STATUS-CODE-CITES-INACTIVE-AUTOMATION fixtures (e2e).
// MIXED object: an Active + an Obsolete flow fire on it — the status-code rule
// must cite ONLY the active flow and disclose the obsolete one.
const SC_MIXED_OBJ = 'CustomObject:ScMix__c';
const SC_ACTIVE_FLOW = 'Flow:ScMixActive';
const SC_OBSOLETE_FLOW = 'Flow:ScMixObsolete';
// ALL-INACTIVE object: a Draft flow + an Inactive trigger — the rule must emit the
// no-active-automation disclosure, never a "could have aborted" production claim.
const SC_DEAD_OBJ = 'CustomObject:ScDead__c';
const SC_DRAFT_FLOW = 'Flow:ScDeadDraft';
const SC_INACTIVE_TRIGGER = 'ApexTrigger:ScDeadLegacy';

// P1-A REASONING-COUPLED-FIELD-WRITE-DEAD-PLANE fixtures (e2e).
// (a) An INACTIVE ValidationRule firer gating on a field a production Flow writes —
// the dead gate must NOT be cited as a live coupling.
const DP_INACTIVE_VR = 'ValidationRule:DpA__c.Gate';
const DP_INACTIVE_CC = 'ConditionalContext:ValidationRule:DpA__c.Gate.condition-0';
const DP_A_FIELD = 'CustomField:DpA__c.Status__c';
const DP_A_WRITER = 'Flow:DpAWriter'; // production writer
// (b) An ACTIVE ValidationRule firer gating on a field a TEST-class Apex writer
// writes — the test-only writer must be excluded from the production coupling.
const DP_ACTIVE_VR = 'ValidationRule:DpB__c.Gate';
const DP_ACTIVE_CC = 'ConditionalContext:ValidationRule:DpB__c.Gate.condition-0';
const DP_B_FIELD = 'CustomField:DpB__c.Status__c';
const DP_B_TEST_WRITER = 'ApexClass:DpBWriterTest'; // isTest → excluded

// ASYNC-BOUNDARY fixture (RM-reason async): a Queueable ApexClass (node marker),
// a caller ApexClass that dispatchesAsync to it (edge rule cites [caller, target]),
// and a plain non-async ApexClass (fires nothing). Proves the handler auto-derives
// the `dispatchesAsync` bound edge type from the new rule and fires it end-to-end.
const ASYNC_QUEUEABLE = 'ApexClass:OrderQueueable';
const ASYNC_CALLER = 'ApexClass:OrderEnqueuer';
const ASYNC_PLAIN = 'ApexClass:PlainOrderService';

// EXTERNAL-API-SURFACE fixture (RM-reason external-api-surface): an @AuraEnabled
// class and an @InvocableMethod class (NODE markers) fire the surface concept;
// the plain non-external ApexClass (ASYNC_PLAIN — no markers) fires none. Proves
// the node rules reach the user end-to-end via interpretHandler with no edge rule.
const EXT_AURA = 'ApexClass:AccountLwcController';
const EXT_INVOCABLE = 'ApexClass:LeadEnricherInvocable';

// APEX-SHARING-MODE fixture (RM-reason apex-sharing-mode): a `without sharing`
// class (security-relevant primary rule) and an `inherited sharing` class fire
// the concept; a `with sharing` class (the deliberately-unclaimed safe default)
// fires none. Proves the node rules reach the user end-to-end via interpretHandler
// with no edge rule, and that the default posture is not proactively claimed.
const SHARING_WITHOUT = 'ApexClass:LegacyMigrationService';
const SHARING_INHERITED = 'ApexClass:OrderSharingUtil';
const SHARING_WITH = 'ApexClass:AccountDefaultService';

// SYSTEM-CONTEXT-EXTERNAL-SURFACE fixture (compound): a class that is BOTH
// `without sharing` AND @AuraEnabled AND not a test fires the compound rule
// (the AND-array) end-to-end, AS WELL AS the two base concepts (apex-sharing
// without + external-api aura) — the compound ADDS a third claim, it does not
// replace them. A test-class variant with the same two markers fires NOTHING
// (the isTest=false clause filters scaffolding).
const SYSCTX_EXTERNAL = 'ApexClass:AdminBypassApiService';
const SYSCTX_EXTERNAL_TEST = 'ApexClass:AdminBypassApiServiceTest';

// VIEW-MODIFY-ALL fixture (RM-reason view-modify-all): a `grantedBy` object grant
// (PermissionSet/Profile --grantedBy--> CustomObject) carrying the edge booleans
// `viewAllRecords` / `modifyAllRecords`. VMA_OBJ is granted View All by a
// permission set AND a profile (object anchor cites the ENUMERATED SET);
// VMA_MODIFY_OBJ carries a Modify-All grant (viewAll+modifyAll → BOTH rules fire as
// escalation); VMA_PLAIN_OBJ carries only an ordinary read grant (fires neither).
// Proves the two edge rules reach the user end-to-end from BOTH anchor directions,
// with the handler auto-deriving the `grantedBy` bound edge type.
const VMA_OBJ = 'CustomObject:VmaDeal__c';
const VMA_PERMSET = 'PermissionSet:VmaReadAll';
const VMA_PROFILE = 'Profile:VmaOps';
const VMA_MODIFY_OBJ = 'CustomObject:VmaInvoice__c';
const VMA_ADMIN_PS = 'PermissionSet:VmaAdminAll';
const VMA_PLAIN_OBJ = 'CustomObject:VmaPlain__c';
const VMA_PLAIN_PS = 'PermissionSet:VmaPlainRead';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: MD_FIELD, apiName: 'Parent__c' }),
    makeNode({ id: PARENT_OBJ, type: 'CustomObject', apiName: 'Parent__c' }),
    makeNode({
      id: ROLLUP_FIELD,
      apiName: 'ChildCount__c',
      properties: { dataType: 'Summary' },
    }),
    makeNode({ id: AUTO_OBJ, type: 'CustomObject', apiName: 'Order__c' }),
    makeNode({ id: TRIGGER, type: 'ApexTrigger', apiName: 'OrderTrigger' }),
    makeNode({ id: FLOW, type: 'Flow', apiName: 'OrderBeforeSave' }),
    makeNode({ id: PLAIN_FIELD, apiName: 'Plain__c' }),
    makeNode({ id: WEAK_OBJ, type: 'CustomObject', apiName: 'WeakOrder__c' }),
    makeNode({ id: WEAK_TRIGGER, type: 'ApexTrigger', apiName: 'WeakOrderTrigger' }),
    // The dangling MD child field resolves; its parent object is intentionally
    // NOT seeded, so the `lookupTo` edge points at an absent node.
    makeNode({ id: DANGLING_MD_FIELD, apiName: 'GhostParent__c' }),
    // JOIN fixture: firer + its ConditionalContext (gating on COUPLED_FIELD) +
    // the gated field + a distinct writer of that field.
    makeNode({ id: COUPLED_FIRER, type: 'WorkflowRule', apiName: 'Coupled__c.Gate' }),
    makeNode({
      id: COUPLED_CC,
      type: 'ConditionalContext',
      apiName: 'Coupled__c.Gate.condition-0',
      properties: { kind: 'criteria', fieldRefs: [COUPLED_FIELD] },
    }),
    makeNode({ id: COUPLED_FIELD, apiName: 'Status__c' }),
    makeNode({ id: COUPLED_WRITER, type: 'Flow', apiName: 'CoupledWriter' }),
    // FIX 1 leak fixture: a firer gating on a Summary (roll-up) field + a writer.
    makeNode({ id: LEAK_FIRER, type: 'WorkflowRule', apiName: 'Leak__c.Gate' }),
    makeNode({
      id: LEAK_CC,
      type: 'ConditionalContext',
      apiName: 'Leak__c.Gate.condition-0',
      properties: { kind: 'criteria', fieldRefs: [LEAK_SUMMARY_FIELD] },
    }),
    makeNode({ id: LEAK_SUMMARY_FIELD, apiName: 'Rollup__c', properties: { dataType: 'Summary' } }),
    makeNode({ id: LEAK_WRITER, type: 'Flow', apiName: 'LeakWriter' }),
    // FIX 1 own-component fixture: a formula field.
    makeNode({ id: FORMULA_FIELD, apiName: 'Score__c', properties: { isFormula: true } }),
    // FIX 2 fixture: a record-triggered Flow firer + its object + gated field + writer.
    makeNode({ id: FLOW_FIRER, type: 'Flow', apiName: 'DealGateFlow' }),
    makeNode({
      id: FLOW_CC,
      type: 'ConditionalContext',
      apiName: 'DealGateFlow.start',
      properties: { kind: 'flow-recordtrigger', fieldRefs: [FLOW_GATED_FIELD] },
    }),
    makeNode({ id: FLOW_TRIGGER_OBJ, type: 'CustomObject', apiName: 'DealObj__c' }),
    makeNode({ id: FLOW_GATED_FIELD, apiName: 'Status__c' }),
    makeNode({ id: FLOW_WRITER, type: 'ApexClass', apiName: 'DealObjWriter' }),
    // PASS 2 fixture: VR firer + its CC (gating on CP_FIELD) + the gated field +
    // a before-save Flow writer + the writer's triggersOn target object.
    makeNode({ id: CP_FIRER, type: 'ValidationRule', apiName: 'Cp__c.Status_Gate' }),
    makeNode({
      id: CP_CC,
      type: 'ConditionalContext',
      apiName: 'Cp__c.Status_Gate.condition-0',
      properties: { kind: 'criteria', fieldRefs: [CP_FIELD] },
    }),
    makeNode({ id: CP_FIELD, apiName: 'Status__c' }),
    makeNode({ id: CP_WRITER, type: 'Flow', apiName: 'CpBeforeSaveComputer' }),
    makeNode({ id: CP_WRITER_OBJ, type: 'CustomObject', apiName: 'Cp__c' }),
    // AGGREGATE fixture: object + 2 ACTIVE before-save record-triggered flows +
    // 1 OBSOLETE before-save flow (must be filtered out end-to-end).
    makeNode({ id: STACK_OBJ, type: 'CustomObject', apiName: 'Stack__c' }),
    makeNode({ id: STACK_FLOW_A, type: 'Flow', apiName: 'StackBeforeA', properties: { status: 'Active' } }),
    makeNode({ id: STACK_FLOW_B, type: 'Flow', apiName: 'StackBeforeB', properties: { status: 'Active' } }),
    makeNode({ id: STACK_FLOW_OBSOLETE, type: 'Flow', apiName: 'StackBeforeObsolete', properties: { status: 'Obsolete' } }),
    // JUNCTION: the junction object (ControlledByParent), its two master parents +
    // a third (lookup-only) parent, and its four child fields.
    makeNode({ id: JUNC_OBJ, type: 'CustomObject', apiName: 'JuncLink__c', properties: { sharingModel: 'ControlledByParent' } }),
    makeNode({ id: JUNC_PARENT_A, type: 'CustomObject', apiName: 'JuncAlpha__c' }),
    makeNode({ id: JUNC_PARENT_B, type: 'CustomObject', apiName: 'JuncBeta__c' }),
    makeNode({ id: JUNC_PARENT_C, type: 'CustomObject', apiName: 'JuncGamma__c' }),
    makeNode({ id: JUNC_FIELD_A, apiName: 'AlphaRef__c', parentId: JUNC_OBJ }),
    makeNode({ id: JUNC_FIELD_B, apiName: 'BetaRef__c', parentId: JUNC_OBJ }),
    makeNode({ id: JUNC_FIELD_A2, apiName: 'AlphaRef2__c', parentId: JUNC_OBJ }),
    makeNode({ id: JUNC_FIELD_LOOKUP, apiName: 'GammaRef__c', parentId: JUNC_OBJ }),
    // Negative case: a single-master child (exactly one MD parent → not a junction).
    makeNode({ id: SINGLE_MD_OBJ, type: 'CustomObject', apiName: 'SingleDetail__c' }),
    makeNode({ id: SINGLE_MD_FIELD, apiName: 'OnlyParent__c', parentId: SINGLE_MD_OBJ }),
    // P1-B status-code inactive-firer: a MIXED object (Active + Obsolete flow) and
    // an ALL-INACTIVE object (Draft flow + Inactive trigger).
    makeNode({ id: SC_MIXED_OBJ, type: 'CustomObject', apiName: 'ScMix__c' }),
    makeNode({ id: SC_ACTIVE_FLOW, type: 'Flow', apiName: 'ScMixActive', properties: { status: 'Active' } }),
    makeNode({ id: SC_OBSOLETE_FLOW, type: 'Flow', apiName: 'ScMixObsolete', properties: { status: 'Obsolete' } }),
    makeNode({ id: SC_DEAD_OBJ, type: 'CustomObject', apiName: 'ScDead__c' }),
    makeNode({ id: SC_DRAFT_FLOW, type: 'Flow', apiName: 'ScDeadDraft', properties: { status: 'Draft' } }),
    makeNode({ id: SC_INACTIVE_TRIGGER, type: 'ApexTrigger', apiName: 'ScDeadLegacy', properties: { status: 'Inactive' } }),
    // P1-A coupled-write dead-plane: an INACTIVE VR firer over a production writer,
    // and an ACTIVE VR firer over a TEST-class writer.
    makeNode({ id: DP_INACTIVE_VR, type: 'ValidationRule', apiName: 'DpA__c.Gate', properties: { active: false } }),
    makeNode({
      id: DP_INACTIVE_CC,
      type: 'ConditionalContext',
      apiName: 'DpA__c.Gate.condition-0',
      properties: { kind: 'criteria', fieldRefs: [DP_A_FIELD] },
    }),
    makeNode({ id: DP_A_FIELD, apiName: 'Status__c', parentId: 'CustomObject:DpA__c' }),
    makeNode({ id: DP_A_WRITER, type: 'Flow', apiName: 'DpAWriter' }),
    makeNode({ id: DP_ACTIVE_VR, type: 'ValidationRule', apiName: 'DpB__c.Gate', properties: { active: true } }),
    makeNode({
      id: DP_ACTIVE_CC,
      type: 'ConditionalContext',
      apiName: 'DpB__c.Gate.condition-0',
      properties: { kind: 'criteria', fieldRefs: [DP_B_FIELD] },
    }),
    makeNode({ id: DP_B_FIELD, apiName: 'Status__c', parentId: 'CustomObject:DpB__c' }),
    makeNode({ id: DP_B_TEST_WRITER, type: 'ApexClass', apiName: 'DpBWriterTest', properties: { isTest: true } }),
    // ASYNC-BOUNDARY: a Queueable class, a plain caller that dispatches it async,
    // and a plain non-async class (fires nothing async).
    makeNode({ id: ASYNC_QUEUEABLE, type: 'ApexClass', apiName: 'OrderQueueable', properties: { isQueueable: true } }),
    makeNode({ id: ASYNC_CALLER, type: 'ApexClass', apiName: 'OrderEnqueuer' }),
    makeNode({ id: ASYNC_PLAIN, type: 'ApexClass', apiName: 'PlainOrderService' }),
    // EXTERNAL-API-SURFACE: an @AuraEnabled class and an @InvocableMethod class
    // (node markers); ASYNC_PLAIN above doubles as the non-external negative.
    makeNode({ id: EXT_AURA, type: 'ApexClass', apiName: 'AccountLwcController', properties: { hasAuraEnabledMethod: true } }),
    makeNode({ id: EXT_INVOCABLE, type: 'ApexClass', apiName: 'LeadEnricherInvocable', properties: { hasInvocableMethod: true } }),
    // APEX-SHARING-MODE: a `without sharing` class + an `inherited sharing` class
    // (node markers) fire the concept; a `with sharing` class (safe default) fires none.
    makeNode({ id: SHARING_WITHOUT, type: 'ApexClass', apiName: 'LegacyMigrationService', properties: { sharingModel: 'without sharing' } }),
    makeNode({ id: SHARING_INHERITED, type: 'ApexClass', apiName: 'OrderSharingUtil', properties: { sharingModel: 'inherited sharing' } }),
    makeNode({ id: SHARING_WITH, type: 'ApexClass', apiName: 'AccountDefaultService', properties: { sharingModel: 'with sharing' } }),
    // SYSTEM-CONTEXT-EXTERNAL-SURFACE (compound): all three predicates hold.
    makeNode({ id: SYSCTX_EXTERNAL, type: 'ApexClass', apiName: 'AdminBypassApiService', properties: { sharingModel: 'without sharing', hasAuraEnabledMethod: true, isTest: false } }),
    // …the same two markers on a TEST class must fire nothing (isTest=false clause).
    makeNode({ id: SYSCTX_EXTERNAL_TEST, type: 'ApexClass', apiName: 'AdminBypassApiServiceTest', properties: { sharingModel: 'without sharing', hasAuraEnabledMethod: true, isTest: true } }),
    // VIEW-MODIFY-ALL: two objects (one View-All-granted, one Modify-All-granted),
    // a plain object, and the granting permission sets / profile.
    makeNode({ id: VMA_OBJ, type: 'CustomObject', apiName: 'VmaDeal__c', properties: { sharingModel: 'Private' } }),
    makeNode({ id: VMA_PERMSET, type: 'PermissionSet', apiName: 'VmaReadAll' }),
    makeNode({ id: VMA_PROFILE, type: 'Profile', apiName: 'VmaOps' }),
    makeNode({ id: VMA_MODIFY_OBJ, type: 'CustomObject', apiName: 'VmaInvoice__c', properties: { sharingModel: 'Private' } }),
    makeNode({ id: VMA_ADMIN_PS, type: 'PermissionSet', apiName: 'VmaAdminAll' }),
    makeNode({ id: VMA_PLAIN_OBJ, type: 'CustomObject', apiName: 'VmaPlain__c', properties: { sharingModel: 'Private' } }),
    makeNode({ id: VMA_PLAIN_PS, type: 'PermissionSet', apiName: 'VmaPlainRead' }),
  ],
  edges: [
    makeEdge({
      fromId: MD_FIELD,
      toId: PARENT_OBJ,
      edgeType: 'lookupTo',
      properties: { relationshipType: 'MasterDetail' },
    }),
    makeEdge({ fromId: TRIGGER, toId: AUTO_OBJ, edgeType: 'triggersOn' }),
    makeEdge({ fromId: FLOW, toId: AUTO_OBJ, edgeType: 'triggersOn' }),
    // WEAK_OBJ's only save automation is a HEURISTIC-confidence trigger.
    makeEdge({
      fromId: WEAK_TRIGGER,
      toId: WEAK_OBJ,
      edgeType: 'triggersOn',
      confidence: 'heuristic',
    }),
    // Dangling master-detail: child field → an UNSEEDED parent object.
    makeEdge({
      fromId: DANGLING_MD_FIELD,
      toId: GHOST_PARENT_OBJ,
      edgeType: 'lookupTo',
      properties: { relationshipType: 'MasterDetail' },
    }),
    // JOIN edges: F fires on its condition; a DIFFERENT flow writes the gated
    // field (the coupling); F ALSO writes it (a self-write, must be excluded).
    makeEdge({ fromId: COUPLED_FIRER, toId: COUPLED_CC, edgeType: 'firesWhen', properties: { kind: 'criteria' } }),
    makeEdge({ fromId: COUPLED_WRITER, toId: COUPLED_FIELD, edgeType: 'writesTo', confidence: 'parsed' }),
    makeEdge({ fromId: COUPLED_FIRER, toId: COUPLED_FIELD, edgeType: 'writesTo', confidence: 'parsed' }),
    // FIX 1 leak: the firer gates on the Summary field; a distinct writer writes it.
    makeEdge({ fromId: LEAK_FIRER, toId: LEAK_CC, edgeType: 'firesWhen', properties: { kind: 'criteria' } }),
    makeEdge({ fromId: LEAK_WRITER, toId: LEAK_SUMMARY_FIELD, edgeType: 'writesTo', confidence: 'parsed' }),
    // FIX 2: the Flow firer triggersOn its object, gates on a same-object field a
    // distinct Apex class writes — the coupling only fires once the object is
    // derived from the triggersOn edge (a Flow id has no object segment).
    makeEdge({ fromId: FLOW_FIRER, toId: FLOW_CC, edgeType: 'firesWhen', properties: { kind: 'flow-recordtrigger' } }),
    makeEdge({ fromId: FLOW_FIRER, toId: FLOW_TRIGGER_OBJ, edgeType: 'triggersOn' }),
    makeEdge({ fromId: FLOW_WRITER, toId: FLOW_GATED_FIELD, edgeType: 'writesTo', confidence: 'parsed' }),
    // PASS 2: F fires on its condition; a before-save Flow writes the gated field.
    // The writer's before-save timing is on ITS triggersOn edge (RecordBeforeSave)
    // — NOT incident to F, so only the 2-hop writer-triggersOn pull surfaces it.
    makeEdge({ fromId: CP_FIRER, toId: CP_CC, edgeType: 'firesWhen', properties: { kind: 'criteria' } }),
    makeEdge({ fromId: CP_WRITER, toId: CP_FIELD, edgeType: 'writesTo', confidence: 'parsed' }),
    makeEdge({ fromId: CP_WRITER, toId: CP_WRITER_OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordBeforeSave' } }),
    // AGGREGATE: two ACTIVE before-save flows target STACK_OBJ (same timing +
    // same DML event — both CreateAndUpdate, so they co-fire on insert AND update
    // and merge to one "insert or update" claim), plus one OBSOLETE before-save
    // flow that the active filter must drop e2e.
    makeEdge({ fromId: STACK_FLOW_A, toId: STACK_OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordBeforeSave', recordTriggerType: 'CreateAndUpdate' } }),
    makeEdge({ fromId: STACK_FLOW_B, toId: STACK_OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordBeforeSave', recordTriggerType: 'CreateAndUpdate' } }),
    makeEdge({ fromId: STACK_FLOW_OBSOLETE, toId: STACK_OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordBeforeSave', recordTriggerType: 'CreateAndUpdate' } }),
    // JUNCTION: object --parentOf--> each child field (the 2-hop anchor), and each
    // child field's outgoing lookupTo (MD to A/B/A-again, plain Lookup to C).
    makeEdge({ fromId: JUNC_OBJ, toId: JUNC_FIELD_A, edgeType: 'parentOf' }),
    makeEdge({ fromId: JUNC_OBJ, toId: JUNC_FIELD_B, edgeType: 'parentOf' }),
    makeEdge({ fromId: JUNC_OBJ, toId: JUNC_FIELD_A2, edgeType: 'parentOf' }),
    makeEdge({ fromId: JUNC_OBJ, toId: JUNC_FIELD_LOOKUP, edgeType: 'parentOf' }),
    makeEdge({ fromId: JUNC_FIELD_A, toId: JUNC_PARENT_A, edgeType: 'lookupTo', properties: { relationshipType: 'MasterDetail' } }),
    makeEdge({ fromId: JUNC_FIELD_B, toId: JUNC_PARENT_B, edgeType: 'lookupTo', properties: { relationshipType: 'MasterDetail' } }),
    makeEdge({ fromId: JUNC_FIELD_A2, toId: JUNC_PARENT_A, edgeType: 'lookupTo', properties: { relationshipType: 'MasterDetail' } }),
    makeEdge({ fromId: JUNC_FIELD_LOOKUP, toId: JUNC_PARENT_C, edgeType: 'lookupTo', properties: { relationshipType: 'Lookup' } }),
    // Negative case: a single-master child (one MD parent → not a junction).
    makeEdge({ fromId: SINGLE_MD_OBJ, toId: SINGLE_MD_FIELD, edgeType: 'parentOf' }),
    makeEdge({ fromId: SINGLE_MD_FIELD, toId: JUNC_PARENT_A, edgeType: 'lookupTo', properties: { relationshipType: 'MasterDetail' } }),
    // P1-B: MIXED object's incoming triggersOn (an Active + an Obsolete flow); the
    // ALL-INACTIVE object's incoming triggersOn (a Draft flow + an Inactive trigger).
    makeEdge({ fromId: SC_ACTIVE_FLOW, toId: SC_MIXED_OBJ, edgeType: 'triggersOn' }),
    makeEdge({ fromId: SC_OBSOLETE_FLOW, toId: SC_MIXED_OBJ, edgeType: 'triggersOn' }),
    makeEdge({ fromId: SC_DRAFT_FLOW, toId: SC_DEAD_OBJ, edgeType: 'triggersOn' }),
    makeEdge({ fromId: SC_INACTIVE_TRIGGER, toId: SC_DEAD_OBJ, edgeType: 'triggersOn' }),
    // P1-A: the INACTIVE VR firer gates on DP_A_FIELD that a production Flow writes;
    // the ACTIVE VR firer gates on DP_B_FIELD that a TEST-class Apex writer writes.
    makeEdge({ fromId: DP_INACTIVE_VR, toId: DP_INACTIVE_CC, edgeType: 'firesWhen', properties: { kind: 'criteria' } }),
    makeEdge({ fromId: DP_A_WRITER, toId: DP_A_FIELD, edgeType: 'writesTo', confidence: 'parsed' }),
    makeEdge({ fromId: DP_ACTIVE_VR, toId: DP_ACTIVE_CC, edgeType: 'firesWhen', properties: { kind: 'criteria' } }),
    makeEdge({ fromId: DP_B_TEST_WRITER, toId: DP_B_FIELD, edgeType: 'writesTo', confidence: 'heuristic' }),
    // ASYNC-BOUNDARY: the caller dispatches the Queueable class asynchronously.
    makeEdge({ fromId: ASYNC_CALLER, toId: ASYNC_QUEUEABLE, edgeType: 'dispatchesAsync', properties: { dispatchMechanism: 'enqueueJob' } }),
    // VIEW-MODIFY-ALL: a permission set AND a profile grant View All on VMA_OBJ (the
    // enumerated set); an admin permission set grants Modify All (viewAll+modifyAll)
    // on VMA_MODIFY_OBJ (escalation); a plain read grant on VMA_PLAIN_OBJ fires nothing.
    makeEdge({ fromId: VMA_PERMSET, toId: VMA_OBJ, edgeType: 'grantedBy', properties: { allowRead: true, viewAllRecords: true, modifyAllRecords: false } }),
    makeEdge({ fromId: VMA_PROFILE, toId: VMA_OBJ, edgeType: 'grantedBy', properties: { allowRead: true, viewAllRecords: true, modifyAllRecords: false } }),
    makeEdge({ fromId: VMA_ADMIN_PS, toId: VMA_MODIFY_OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true, allowDelete: true, viewAllRecords: true, modifyAllRecords: true } }),
    makeEdge({ fromId: VMA_PLAIN_PS, toId: VMA_PLAIN_OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true, viewAllRecords: false, modifyAllRecords: false } }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-interpret-'));
  const opened = await openGraph(join(tempDir, 'i.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('interpretHandler — rule firing', () => {
  it('fires the master-detail cascade rule for a MasterDetail lookupTo field, citing both endpoints', async () => {
    const r = await interpretHandler(ctx, { componentId: MD_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, componentType, trust } = r.value.data;
    const md = interpretations.find(
      (i) => i.ruleId === 'rule:relationship/master-detail-cascade',
    );
    expect(md, 'master-detail cascade rule should fire').toBeDefined();
    expect(md!.claim).toContain('Master-detail relationship');
    expect(md!.groundedIn).toEqual([MD_FIELD, PARENT_OBJ]);
    expect(md!.provenance).toBe('offline_snapshot');
    expect(componentType).toBe('CustomField');
    expect(trust.provenance).toBe('offline_snapshot');
  });

  it('fires the JUNCTION rule for a 2-master junction object — the 2-hop slice surfaces the child MD fields + parents (root-first citation, 3 grounded ids)', async () => {
    const r = await interpretHandler(ctx, { componentId: JUNC_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, componentType } = r.value.data;
    const junction = interpretations.find((i) => i.ruleId === 'rule:relationship/junction-object');
    expect(junction, 'junction rule should fire end-to-end via the 2-hop slice').toBeDefined();
    // Citation [root, …sorted parents] — the junction {0}, the two DISTINCT
    // masters {1}/{2}. The lookup-only parent (C) and the duplicate parent (A2)
    // never inflate: exactly the two distinct MD parents are cited.
    expect(junction!.groundedIn).toEqual([JUNC_OBJ, JUNC_PARENT_A, JUNC_PARENT_B]);
    expect(junction!.groundedIn).not.toContain(JUNC_PARENT_C);
    // Pattern-not-intent wording end-to-end (the shipped, reworded claim).
    expect(junction!.claim).toContain('structural signature of a many-to-many junction');
    expect(junction!.claim).toContain('Controlled by Parent');
    expect(junction!.claim).toContain('inferred from the relationship type');
    expect(junction!.confidence).toBe('declared');
    expect(componentType).toBe('CustomObject');
  });

  it('does NOT fire the junction rule on a single-master child (exactly-two cardinality)', async () => {
    const r = await interpretHandler(ctx, { componentId: SINGLE_MD_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const junction = r.value.data.interpretations.find(
      (i) => i.ruleId === 'rule:relationship/junction-object',
    );
    expect(junction, 'a single-master child is not a junction').toBeUndefined();
  });

  // #4 — the master-detail-cascade EDGE rule must NOT fire redundantly on a
  // junction OBJECT anchor. The junction 2-hop drags the object's child fields'
  // outgoing MD lookupTo edges into the shared slice; before the edge-branch root
  // scoping, md-cascade also scanned them and emitted a 4-id claim in a singular
  // template. On an OBJECT anchor those edges are not incident to the root, so
  // md-cascade now stays silent — only the junction rule speaks.
  it('does NOT redundantly fire master-detail-cascade on a junction OBJECT anchor (edge-branch root scoping)', async () => {
    const r = await interpretHandler(ctx, { componentId: JUNC_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations } = r.value.data;
    const cascade = interpretations.find(
      (i) => i.ruleId === 'rule:relationship/master-detail-cascade',
    );
    expect(cascade, 'md-cascade must not fire on a junction object anchor').toBeUndefined();
    // The junction rule still fires — the object is genuinely a junction.
    expect(
      interpretations.find((i) => i.ruleId === 'rule:relationship/junction-object'),
      'the junction rule still fires',
    ).toBeDefined();
  });

  it('fires the async-boundary node rule for a Queueable ApexClass anchor (marker property)', async () => {
    const r = await interpretHandler(ctx, { componentId: ASYNC_QUEUEABLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, componentType } = r.value.data;
    const q = interpretations.find((i) => i.ruleId === 'rule:async-boundary/queueable');
    expect(q, 'the queueable node rule should fire').toBeDefined();
    expect(q!.concept).toBe('concept:async-boundary');
    expect(q!.groundedIn).toEqual([ASYNC_QUEUEABLE]);
    expect(q!.claim).toContain('implements Queueable');
    expect(q!.claim.toLowerCase()).toContain('separate transaction');
    expect(q!.confidence).toBe('declared');
    expect(componentType).toBe('ApexClass');
  });

  it('fires the async-boundary EDGE rule for a caller anchor — auto-derives the dispatchesAsync bound type, cites [caller, target]', async () => {
    const r = await interpretHandler(ctx, { componentId: ASYNC_CALLER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations } = r.value.data;
    const dispatch = interpretations.find((i) => i.ruleId === 'rule:async-boundary/dispatches-async');
    expect(dispatch, 'the dispatchesAsync edge rule should fire end-to-end').toBeDefined();
    // Both ApexClass endpoints resolve → cited [caller, target]; the {ids} template
    // renders every cited id and leaves no unfilled positional token.
    expect(dispatch!.groundedIn).toEqual([ASYNC_CALLER, ASYNC_QUEUEABLE]);
    expect(dispatch!.claim).toContain(ASYNC_CALLER);
    expect(dispatch!.claim).toContain(ASYNC_QUEUEABLE);
    expect(dispatch!.claim.toLowerCase()).toContain('deferred');
    expect(dispatch!.claim).not.toMatch(/\{\d+\}/);
    expect(dispatch!.confidence).toBe('declared');
  });

  it('does NOT fire any async-boundary rule for a plain non-async ApexClass', async () => {
    const r = await interpretHandler(ctx, { componentId: ASYNC_PLAIN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const asyncFires = r.value.data.interpretations.filter(
      (i) => i.concept === 'concept:async-boundary',
    );
    expect(asyncFires, 'a non-async class implies no async boundary').toEqual([]);
  });

  it('fires the external-api-surface node rule for an @AuraEnabled ApexClass anchor (marker property)', async () => {
    const r = await interpretHandler(ctx, { componentId: EXT_AURA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, componentType } = r.value.data;
    const aura = interpretations.find((i) => i.ruleId === 'rule:external-api-surface/aura-enabled');
    expect(aura, 'the aura-enabled node rule should fire end-to-end').toBeDefined();
    expect(aura!.concept).toBe('concept:external-api-surface');
    // A node match cites ONLY the anchor class (no synthetic ExternalApi: neighbor).
    expect(aura!.groundedIn).toEqual([EXT_AURA]);
    expect(aura!.claim).toContain(EXT_AURA);
    expect(aura!.claim).toContain('@AuraEnabled');
    expect(aura!.claim.toLowerCase()).toContain('not automatically enforced');
    expect(aura!.claim).not.toMatch(/\{\d+\}/);
    expect(aura!.confidence).toBe('declared');
    expect(componentType).toBe('ApexClass');
    // NODE-ONLY: no synthetic ExternalApi: id is ever cited.
    for (const i of interpretations) {
      for (const id of i.groundedIn) expect(id.startsWith('ExternalApi:')).toBe(false);
    }
  });

  it('fires the external-api-surface node rule for an @InvocableMethod ApexClass anchor', async () => {
    const r = await interpretHandler(ctx, { componentId: EXT_INVOCABLE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inv = r.value.data.interpretations.find(
      (i) => i.ruleId === 'rule:external-api-surface/invocable',
    );
    expect(inv, 'the invocable node rule should fire end-to-end').toBeDefined();
    expect(inv!.groundedIn).toEqual([EXT_INVOCABLE]);
    expect(inv!.claim).toContain('@InvocableMethod');
    expect(inv!.claim.toLowerCase()).toContain('per-class, not per-method');
    expect(inv!.confidence).toBe('declared');
  });

  it('does NOT fire any external-api-surface rule for a plain non-external ApexClass', async () => {
    const r = await interpretHandler(ctx, { componentId: ASYNC_PLAIN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const extFires = r.value.data.interpretations.filter(
      (i) => i.concept === 'concept:external-api-surface',
    );
    expect(extFires, 'a class with no API annotation implies no external surface').toEqual([]);
  });

  it('fires the apex-sharing-mode node rule for a `without sharing` ApexClass anchor (declaration property)', async () => {
    const r = await interpretHandler(ctx, { componentId: SHARING_WITHOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, componentType } = r.value.data;
    const sharing = interpretations.find((i) => i.ruleId === 'rule:apex-sharing/without-sharing');
    expect(sharing, 'the without-sharing node rule should fire end-to-end').toBeDefined();
    expect(sharing!.concept).toBe('concept:apex-sharing-mode');
    // A node match cites ONLY the anchor class (no neighbor).
    expect(sharing!.groundedIn).toEqual([SHARING_WITHOUT]);
    expect(sharing!.claim).toContain(SHARING_WITHOUT);
    expect(sharing!.claim).toContain('without sharing');
    expect(sharing!.claim.toLowerCase()).toContain('system context');
    // Boundaries survive the round-trip: FLS/CRUD-separate and declared-not-proven.
    expect(sharing!.claim.toLowerCase()).toContain('separate concern');
    expect(sharing!.claim.toLowerCase()).toContain('not a proven access outcome');
    // No unfilled positional token leaks into the rendered claim.
    expect(sharing!.claim).not.toMatch(/\{\d+\}/);
    expect(sharing!.confidence).toBe('declared');
    expect(componentType).toBe('ApexClass');
  });

  it('fires the apex-sharing-mode node rule for an `inherited sharing` ApexClass anchor', async () => {
    const r = await interpretHandler(ctx, { componentId: SHARING_INHERITED });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inh = r.value.data.interpretations.find(
      (i) => i.ruleId === 'rule:apex-sharing/inherited-sharing',
    );
    expect(inh, 'the inherited-sharing node rule should fire end-to-end').toBeDefined();
    expect(inh!.groundedIn).toEqual([SHARING_INHERITED]);
    expect(inh!.claim).toContain('inherited sharing');
    expect(inh!.claim.toLowerCase()).toContain('depends on the execution context');
    expect(inh!.confidence).toBe('declared');
  });

  it('does NOT fire any apex-sharing-mode rule for a `with sharing` (safe default) ApexClass', async () => {
    const r = await interpretHandler(ctx, { componentId: SHARING_WITH });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sharingFires = r.value.data.interpretations.filter(
      (i) => i.concept === 'concept:apex-sharing-mode',
    );
    expect(sharingFires, 'the safe default is deliberately not proactively claimed').toEqual([]);
  });

  it('fires the system-context-external-surface COMPOUND rule (AND-array) end-to-end for a without-sharing + Aura class', async () => {
    const r = await interpretHandler(ctx, { componentId: SYSCTX_EXTERNAL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations } = r.value.data;
    const compound = interpretations.find(
      (i) => i.ruleId === 'rule:system-context-external-surface/aura-enabled',
    );
    expect(compound, 'the compound AND-array rule should fire end-to-end').toBeDefined();
    expect(compound!.concept).toBe('concept:system-context-external-surface');
    // A node match cites ONLY the anchor class (no neighbor), declared, no caveat.
    expect(compound!.groundedIn).toEqual([SYSCTX_EXTERNAL]);
    expect(compound!.claim).toContain(SYSCTX_EXTERNAL);
    expect(compound!.confidence).toBe('declared');
    expect(compound!.coverageCaveat).toBeNull();
    // Honest wording survives the round-trip.
    const lower = compound!.claim.toLowerCase();
    expect(lower).toContain('without sharing');
    expect(lower).toContain('system context');
    expect(lower).toContain('security-review priority');
    expect(lower).toContain('not by itself a vulnerability');
    expect(lower).toContain('not a proven access outcome');
    // No unfilled positional token leaks into the rendered claim.
    expect(compound!.claim).not.toMatch(/\{\d+\}/);
    // EPIC-3 DEMOTION: the two base concepts still co-fire but are superseded
    // beneath the composed security-review claim (groundedIn/claim preserved).
    const baseSharing = interpretations.find((i) => i.ruleId === 'rule:apex-sharing/without-sharing');
    const baseExternal = interpretations.find((i) => i.ruleId === 'rule:external-api-surface/aura-enabled');
    expect(baseSharing, 'base without-sharing claim co-fires').toBeDefined();
    expect(baseExternal, 'base external-api claim co-fires').toBeDefined();
    expect(baseSharing!.concept).toBe('concept:apex-sharing-mode');
    expect(baseExternal!.concept).toBe('concept:external-api-surface');
    expect(baseSharing!.supersededBy).toBe('supersedes:system-context-external-surface>apex-sharing-mode');
    expect(baseExternal!.supersededBy).toBe('supersedes:system-context-external-surface>external-api-surface');
    expect(compound!.supersededBy).toBeUndefined();
  });

  it('does NOT fire the compound rule for a TEST class with the same two markers (isTest=false clause filters scaffolding)', async () => {
    const r = await interpretHandler(ctx, { componentId: SYSCTX_EXTERNAL_TEST });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const compoundFires = r.value.data.interpretations.filter(
      (i) => i.concept === 'concept:system-context-external-surface',
    );
    expect(compoundFires, 'a test class is filtered by the isTest=false clause').toEqual([]);
  });

  it('fires the view-all EDGE rule for an OBJECT anchor — cites the object + every granting permission set/profile (enumerated set), and does NOT fire modify-all', async () => {
    const r = await interpretHandler(ctx, { componentId: VMA_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, componentType } = r.value.data;
    const view = interpretations.find((i) => i.ruleId === 'rule:access/view-all-records');
    expect(view, 'the view-all edge rule should fire end-to-end on the object anchor').toBeDefined();
    expect(view!.concept).toBe('concept:view-modify-all');
    // Both grantors AND the object are cited (order is store-driven, so assert the SET).
    expect(view!.groundedIn).toHaveLength(3);
    expect(view!.groundedIn).toContain(VMA_OBJ);
    expect(view!.groundedIn).toContain(VMA_PERMSET);
    expect(view!.groundedIn).toContain(VMA_PROFILE);
    expect(view!.claim).toContain('View All Records');
    expect(view!.claim).not.toMatch(/\{\d+\}/);
    expect(view!.confidence).toBe('declared');
    expect(componentType).toBe('CustomObject');
    // A View-All-only grant does NOT fire the Modify-All rule.
    const modify = interpretations.find((i) => i.ruleId === 'rule:access/modify-all-records');
    expect(modify, 'a view-all-only object must not fire modify-all').toBeUndefined();
  });

  it('fires the view-all EDGE rule for a PERMSET anchor — cites the permission set + the object(s) it grants View All on', async () => {
    const r = await interpretHandler(ctx, { componentId: VMA_PERMSET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = r.value.data.interpretations.find((i) => i.ruleId === 'rule:access/view-all-records');
    expect(view, 'the view-all edge rule should fire on the permission-set anchor').toBeDefined();
    expect(view!.groundedIn).toHaveLength(2);
    expect(view!.groundedIn).toContain(VMA_PERMSET);
    expect(view!.groundedIn).toContain(VMA_OBJ);
    expect(view!.claim).toContain(VMA_OBJ);
    expect(view!.claim).not.toMatch(/\{\d+\}/);
  });

  it('ESCALATION — a Modify-All grant fires BOTH rules on the object anchor, reading as one escalating grant (Modify All INCLUDES View All)', async () => {
    const r = await interpretHandler(ctx, { componentId: VMA_MODIFY_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations } = r.value.data;
    const view = interpretations.find((i) => i.ruleId === 'rule:access/view-all-records');
    const modify = interpretations.find((i) => i.ruleId === 'rule:access/modify-all-records');
    expect(view, 'view-all co-fires on a modify-all grant (Modify All implies View All)').toBeDefined();
    expect(modify, 'modify-all fires on the modify-all grant').toBeDefined();
    expect(view!.groundedIn).toEqual([VMA_ADMIN_PS, VMA_MODIFY_OBJ]);
    expect(modify!.groundedIn).toEqual([VMA_ADMIN_PS, VMA_MODIFY_OBJ]);
    // The modify-all claim frames it as the stronger form of the SAME grant.
    expect(modify!.claim).toContain('STRONGER');
    expect(modify!.claim).toContain('INCLUDES View All');
    expect(modify!.claim).not.toMatch(/\{\d+\}/);
  });

  it('EPIC-5 — ranks proactiveRisks by severity × confidence (critical modify-all beats view-all)', async () => {
    const r = await interpretHandler(ctx, { componentId: VMA_MODIFY_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { proactiveRisks } = r.value.data;
    expect(proactiveRisks, 'fired interpretations should surface ranked proactive risks').toBeDefined();
    expect(proactiveRisks!.length).toBeGreaterThanOrEqual(2);
    const top = proactiveRisks![0]!;
    expect(top.severity).toBe('critical');
    expect(top.ruleId).toBe('rule:access/modify-all-records');
    expect(proactiveRisks![1]!.ruleId).toBe('rule:access/view-all-records');
    expect(top.riskScore).toBe(proactiveRisks![1]!.riskScore);
    expect(top.claimPreview.length).toBeLessThanOrEqual(160);
  });

  it('does NOT fire either view/modify-all rule for an object with only an ordinary (non View/Modify-All) grant', async () => {
    const r = await interpretHandler(ctx, { componentId: VMA_PLAIN_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vmaFires = r.value.data.interpretations.filter(
      (i) => i.concept === 'concept:view-modify-all',
    );
    expect(vmaFires, 'an ordinary object grant implies no View/Modify All override').toEqual([]);
  });

  it('fires the roll-up rule for a Summary field (node predicate, no edge needed)', async () => {
    const r = await interpretHandler(ctx, { componentId: ROLLUP_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rollup = r.value.data.interpretations.find(
      (i) => i.ruleId === 'rule:relationship/master-detail-rollup',
    );
    expect(rollup, 'roll-up summary rule should fire').toBeDefined();
    expect(rollup!.claim).toContain('roll-up summary field');
    expect(rollup!.groundedIn).toEqual([ROLLUP_FIELD]);
    expect(r.value.data.rulesFired).toBeGreaterThanOrEqual(1);
  });

  it('fires the status-code cross-ref rule for an object with automation, citing ONLY the automations', async () => {
    const r = await interpretHandler(ctx, { componentId: AUTO_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const statusCode = r.value.data.interpretations.find(
      (i) => i.ruleId === 'rule:status-code/cross-ref-automation',
    );
    expect(statusCode, 'status-code cross-ref rule should fire').toBeDefined();
    // Cites the automation endpoints, never the object they fire on.
    expect([...statusCode!.groundedIn].sort()).toEqual([FLOW, TRIGGER].sort());
    expect(statusCode!.groundedIn).not.toContain(AUTO_OBJ);
  });

  it('[P1-B e2e] status-code MIXED object — cites ONLY the ACTIVE flow, discloses the OBSOLETE one (real slice assembly)', async () => {
    const r = await interpretHandler(ctx, { componentId: SC_MIXED_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const statusCode = r.value.data.interpretations.find(
      (i) => i.ruleId === 'rule:status-code/cross-ref-automation',
    );
    expect(statusCode, 'status-code rule should fire on the mixed object').toBeDefined();
    // The obsolete flow rides the 1-hop slice (its `status` is on the assembled
    // node), yet only the ACTIVE flow is a grounded save-abort suspect.
    expect(statusCode!.groundedIn).toEqual([SC_ACTIVE_FLOW]);
    expect(statusCode!.groundedIn).not.toContain(SC_OBSOLETE_FLOW);
    expect(statusCode!.claim).toContain('could have aborted the save; verify which ran');
    expect(statusCode!.claim).toContain('Excluded as INACTIVE');
    expect(statusCode!.claim).toContain(SC_OBSOLETE_FLOW);
  });

  it('[P1-B e2e] status-code ALL-INACTIVE object — the no-active-automation disclosure, NOT a production abort claim', async () => {
    const r = await interpretHandler(ctx, { componentId: SC_DEAD_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const statusCode = r.value.data.interpretations.find(
      (i) => i.ruleId === 'rule:status-code/cross-ref-automation',
    );
    expect(statusCode, 'status-code rule should still fire (as a disclosure)').toBeDefined();
    expect([...statusCode!.groundedIn].sort()).toEqual([SC_DRAFT_FLOW, SC_INACTIVE_TRIGGER].sort());
    expect(statusCode!.claim).toContain('None of the automation');
    expect(statusCode!.claim).toContain('currently ACTIVE');
    expect(statusCode!.claim).not.toContain('; verify which ran');
  });

  it('[P1-A e2e] coupled-write does NOT fire for an INACTIVE ValidationRule firer over a production writer (dead gate)', async () => {
    const r = await interpretHandler(ctx, { componentId: DP_INACTIVE_VR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const coupled = r.value.data.interpretations.filter(
      (i) => i.ruleId === 'rule:automation/coupled-field-write',
    );
    expect(coupled, 'an inactive gate must own no live coupling').toHaveLength(0);
  });

  it('[P1-A e2e] coupled-write does NOT fire for an ACTIVE firer whose only writer is a TEST class (test plane excluded)', async () => {
    const r = await interpretHandler(ctx, { componentId: DP_ACTIVE_VR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const coupled = r.value.data.interpretations.filter(
      (i) => i.ruleId === 'rule:automation/coupled-field-write',
    );
    expect(coupled, 'a test-only writer must never be conflated into a production coupling').toHaveLength(0);
  });

  it('computes a fired interpretation confidence as the WEAKEST matched-edge level (heuristic edge → heuristic claim, NOT the declared rule ceiling)', async () => {
    // WEAK_OBJ has a single triggersOn edge at `heuristic` confidence. The
    // status-code rule's ceiling is `declared`, so a handler that returned the
    // ceiling would report `declared`; the honest engine reports
    // weakest(declared, heuristic) = 'heuristic'. This test fails if the engine
    // or handler ever asserts confidence above its weakest ground.
    const r = await interpretHandler(ctx, { componentId: WEAK_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, trust } = r.value.data;
    const statusCode = interpretations.find(
      (i) => i.ruleId === 'rule:status-code/cross-ref-automation',
    );
    expect(statusCode, 'status-code rule should fire over the heuristic edge').toBeDefined();
    // The FIRED interpretation's confidence is the weaker level, not the ceiling.
    expect(statusCode!.confidence).toBe('heuristic');
    expect(statusCode!.confidence).not.toBe('declared');
    // …and it propagates into the aggregate trust block (no other rule fires here).
    expect(trust.confidence).toBe('heuristic');
    expect(trust.confidence).not.toBe('declared');
    expect(statusCode!.groundedIn).toEqual([WEAK_TRIGGER]);
  });

  it('drops a dangling edge endpoint (absent from the slice) — it is NEVER cited in groundedIn', async () => {
    // The MD child field's parent object is not in the vault (a legal dangling
    // lookupTo). The engine cites only endpoints that resolve in the assembled
    // slice, so the ghost parent id must not appear in any interpretation.
    const r = await interpretHandler(ctx, { componentId: DANGLING_MD_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations } = r.value.data;
    const cascade = interpretations.find(
      (i) => i.ruleId === 'rule:relationship/master-detail-cascade',
    );
    expect(cascade, 'master-detail cascade rule should still fire on the child field').toBeDefined();
    // The resolvable child field IS cited; the absent parent is NOT.
    expect(cascade!.groundedIn).toContain(DANGLING_MD_FIELD);
    expect(cascade!.groundedIn).not.toContain(GHOST_PARENT_OBJ);
    // Belt-and-braces: no interpretation anywhere cites the dangling endpoint.
    for (const i of interpretations) {
      expect(i.groundedIn).not.toContain(GHOST_PARENT_OBJ);
    }
  });

  it('fires the coupled-field-write JOIN rule via 2-hop assembly, citing [F, X, W] and excluding the self-write', async () => {
    const r = await interpretHandler(ctx, { componentId: COUPLED_FIRER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const coupled = r.value.data.interpretations.filter(
      (i) => i.ruleId === 'rule:automation/coupled-field-write',
    );
    // Exactly one coupling: the DISTINCT flow writer (the self-write is dropped).
    expect(coupled, 'coupled-field-write JOIN rule should fire').toHaveLength(1);
    const only = coupled[0]!;
    expect(only.groundedIn).toEqual([COUPLED_FIRER, COUPLED_FIELD, COUPLED_WRITER]);
    // The self-writer (the firer itself) is NEVER cited as the coupled writer.
    expect(only.groundedIn[2]).not.toBe(COUPLED_FIRER);
    // Coupling-honest claim wording.
    expect(only.claim).toContain('order_of_execution');
    expect(only.claim).not.toMatch(/\bphase\b/i);
    // The writer W is not incident to F — only the 2-hop expansion surfaces it.
    expect(only.confidence).toBe('parsed');
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[FIX 1] fires field-provenance for a formula field asked about its OWN component', async () => {
    const r = await interpretHandler(ctx, { componentId: FORMULA_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const prov = r.value.data.interpretations.find(
      (i) => i.ruleId === 'rule:field-provenance/derived-read-only',
    );
    expect(prov, 'field-provenance rule should fire on the formula root').toBeDefined();
    expect(prov!.groundedIn).toEqual([FORMULA_FIELD]);
    expect(prov!.claim.toLowerCase()).toContain('read-only');
  });

  it('[FIX 1] does NOT (mis)fire a node rule on a NEIGHBOR gated field the 2-hop join dragged in', async () => {
    // LEAK_FIRER gates on LEAK_SUMMARY_FIELD (a Summary/roll-up field). Querying
    // the FIRER pulls that field into the slice, but the roll-up (and formula)
    // NODE rules are root-scoped: they must NOT claim the neighbor field — only
    // the JOIN rule (which centers on the firer) fires.
    const r = await interpretHandler(ctx, { componentId: LEAK_FIRER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations } = r.value.data;

    // The coupling still fires on the firer root.
    const coupled = interpretations.filter((i) => i.ruleId === 'rule:automation/coupled-field-write');
    expect(coupled, 'the JOIN rule should still fire on the firer root').toHaveLength(1);
    expect(coupled[0]!.groundedIn).toEqual([LEAK_FIRER, LEAK_SUMMARY_FIELD, LEAK_WRITER]);

    // But NO node-shaped rule fired about the neighbor Summary field.
    const rollup = interpretations.find((i) => i.ruleId === 'rule:relationship/master-detail-rollup');
    expect(rollup, 'roll-up node rule must NOT leak onto the neighbor field').toBeUndefined();
    const prov = interpretations.find((i) => i.ruleId === 'rule:field-provenance/derived-read-only');
    expect(prov, 'field-provenance node rule must NOT leak onto a neighbor').toBeUndefined();
    // Belt-and-braces: nothing anywhere cites the neighbor as a node-rule subject.
    for (const i of interpretations) {
      if (i.ruleId !== 'rule:automation/coupled-field-write') {
        expect(i.groundedIn).not.toContain(LEAK_SUMMARY_FIELD);
      }
    }
  });

  it('[FIX 2] a record-triggered Flow firer couples via its triggersOn-derived object (join-only selection)', async () => {
    // Select ONLY the join rule, so `triggersOn` is NOT a bound edge type from
    // the status-code rule — the handler must still pull the firer's triggersOn
    // edge + object node so the engine can same-object scope the Flow firer.
    const r = await interpretHandler(ctx, {
      componentId: FLOW_FIRER,
      ruleIds: ['rule:automation/coupled-field-write'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const coupled = r.value.data.interpretations.filter(
      (i) => i.ruleId === 'rule:automation/coupled-field-write',
    );
    expect(coupled, 'a Flow firer should couple once its object is derived from triggersOn').toHaveLength(1);
    expect(coupled[0]!.groundedIn).toEqual([FLOW_FIRER, FLOW_GATED_FIELD, FLOW_WRITER]);
  });

  it('[PASS 2] UPGRADES to a cross-phase claim e2e — the 2-hop pull of the writer triggersOn edge proves before-save-flow → validation-rule order', async () => {
    const r = await interpretHandler(ctx, { componentId: CP_FIRER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const coupled = r.value.data.interpretations.filter(
      (i) => i.ruleId === 'rule:automation/coupled-field-write',
    );
    expect(coupled, 'the coupled-field-write rule should fire').toHaveLength(1);
    const only = coupled[0]!;
    expect(only.groundedIn).toEqual([CP_FIRER, CP_FIELD, CP_WRITER]);
    // The handler pulled the writer's triggersOn edge, so the engine PROVED the
    // cross-phase order and rendered the UPGRADED claim.
    expect(only.claim).toContain('EARLIER save-order phase');
    // ORDERED contiguous phrase (FIX 2 HIGH) — a swapped writerPhase/firerPhase
    // fill would fail this, unlike two order-agnostic separate `.toContain`s.
    expect(only.claim).toContain('before-save-flows before pre-save-validation');
    // Causation CONDITIONED on the writer running (FIX 1), not an absolute claim.
    expect(only.claim).toContain('On saves where');
    expect(only.claim).not.toMatch(/is reacting to the value/i);
    expect(only.claim.toLowerCase()).not.toContain('may be reacting');
    expect(only.confidence).toBe('parsed');
  });

  it('[AGGREGATE] fires stacked-record-triggered-flows for an object with 2 active before-save flows — cites both, discloses count 2', async () => {
    // e2e: the 1-hop slice already carries the object, its incoming triggersOn
    // edges, and the firer Flow NODES (with `status`) — the aggregate rule needs
    // no extra hop. Proves the slice assembly grounds the active-filter + count.
    const r = await interpretHandler(ctx, { componentId: STACK_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stacked = r.value.data.interpretations.filter(
      (i) => i.ruleId === 'rule:automation/stacked-record-triggered-flows',
    );
    expect(stacked, 'aggregate rule should fire on the object').toHaveLength(1);
    const only = stacked[0]!;
    expect(only.concept).toBe('concept:automation-collision');
    // Both CreateAndUpdate → merged one claim "insert or update" (never doubled).
    expect(only.claim).toContain('2 active record-triggered before-save flows');
    expect(only.claim).toContain('co-fire on the insert or update operation');
    // Cites the FLOWS first; the object trails as context.
    expect(only.groundedIn).toEqual([STACK_FLOW_A, STACK_FLOW_B, STACK_OBJ]);
    expect(only.confidence).toBe('declared');
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[AGGREGATE][FIX 3 e2e] the active filter bites on the REAL assembled slice — an Obsolete flow riding the 1-hop slice is excluded (count stays 2, never cited)', async () => {
    // STACK_OBJ carries THREE before-save triggersOn edges in the graph, one from
    // an Obsolete flow. The unit tests use hand-built slices; this proves the REAL
    // handler-assembled 1-hop slice carries each firer Flow node's `status`, so the
    // active filter drops the Obsolete version end-to-end rather than crying wolf
    // with a phantom count of 3.
    const r = await interpretHandler(ctx, { componentId: STACK_OBJ });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stacked = r.value.data.interpretations.filter(
      (i) => i.ruleId === 'rule:automation/stacked-record-triggered-flows',
    );
    expect(stacked).toHaveLength(1);
    const only = stacked[0]!;
    // The Obsolete version is filtered on the real slice → count 2, not 3.
    expect(only.claim).toContain('2 active record-triggered before-save flows');
    expect(only.claim).not.toContain('3 active record-triggered');
    expect(only.groundedIn).toEqual([STACK_FLOW_A, STACK_FLOW_B, STACK_OBJ]);
    expect(only.groundedIn).not.toContain(STACK_FLOW_OBSOLETE);
    expect(only.claim).not.toContain(STACK_FLOW_OBSOLETE);
  });

  // UPDATED, not deleted. What these two really guarded is that the additive
  // filter NARROWS the rule set, and that the count moves with it. They pinned
  // that through `selectedRules + CHAINED + COMPOUND + SUPERSEDES`, which is
  // also the expression that published 200 beside the digest's 195 (and 5
  // beside 0 under a filter). The invariant survives; the second counter does
  // not — `rulesConsidered` is now THE number, and the second-pass rules are
  // counted in their own field.
  it('narrows to a single rule via the ruleIds filter (additive)', async () => {
    const r = await interpretHandler(ctx, {
      componentId: MD_FIELD,
      ruleIds: ['rule:relationship/master-detail-cascade'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rulesConsidered).toBe(1);
    expect(r.value.data.rulesConsidered).toBe(
      r.value.data.completeness.rulesConsidered,
    );
    expect(r.value.data.secondPassRules).toBe(
      CHAINED_RULES.length + COMPOUND_RULES.length + SUPERSEDES_RULES.length,
    );
    expect(r.value.data.ruleSelection).toEqual({
      ruleIds: ['rule:relationship/master-detail-cascade'],
      rulesSelected: 1,
      rulesInModel: CONCEPT_RULES.length,
    });
    expect(
      r.value.data.interpretations.every(
        (i) => i.ruleId === 'rule:relationship/master-detail-cascade',
      ),
    ).toBe(true);
  });

  it('an empty filter array matches NO rule → honest empty disclosure', async () => {
    const r = await interpretHandler(ctx, {
      componentId: MD_FIELD,
      ruleIds: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rulesConsidered).toBe(0);
    expect(r.value.data.rulesConsidered).toBe(
      r.value.data.completeness.rulesConsidered,
    );
    expect(r.value.data.secondPassRules).toBe(
      CHAINED_RULES.length + COMPOUND_RULES.length + SUPERSEDES_RULES.length,
    );
    expect(r.value.data.interpretations).toHaveLength(0);
  });
});

// =============================================================================
// TWO CONTRADICTORY RULE COUNTERS — `completeness.rulesConsidered: 195` shipped
// beside a top-level `rulesConsidered: 200` on EVERY response, and under a
// `ruleIds` filter the pair diverged to 0 vs 5 while
// `completeness.noRuleCoversComponentType` flipped true and rendered "NOTHING
// was checked for this CustomObject: of 0 concept rules…". The tool's own
// description tells a reader to consult that field FIRST, so it is the field
// most likely to be believed — and a caller-applied filter is not a coverage
// gap.
// =============================================================================

describe('interpretHandler — ONE authoritative rule counter', () => {
  it('FAIL-BEFORE/PASS-AFTER: the two counters agree on an UNFILTERED call', async () => {
    const r = await interpretHandler(ctx, { componentId: MD_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Pre-fix: 200 vs 195.
    expect(d.rulesConsidered).toBe(d.completeness.rulesConsidered);
    expect(d.rulesConsidered).toBe(CONCEPT_RULES.length);
    // The second-pass rules are not lost — they are counted where they belong.
    expect(d.secondPassRules).toBe(
      CHAINED_RULES.length + COMPOUND_RULES.length + SUPERSEDES_RULES.length,
    );
    // An unfiltered call carries no selection block.
    expect(d.ruleSelection).toBeUndefined();
  });

  it('FAIL-BEFORE/PASS-AFTER: a filter that matches NOTHING blames the filter, not the component type', async () => {
    const r = await interpretHandler(ctx, {
      componentId: MD_FIELD,
      ruleIds: ['rule:does-not-exist/anywhere'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Pre-fix: 5 vs 0.
    expect(d.rulesConsidered).toBe(0);
    expect(d.completeness.rulesConsidered).toBe(0);
    // Still SILENCE — an empty interpretations list here is not a clean bill.
    expect(d.completeness.noRuleCoversComponentType).toBe(true);
    // …but the stated REASON is the caller's own filter. The degenerate
    // "of 0 concept rules, 0 are provably inapplicable … and 0 could not be
    // evaluated" sentence is now unreachable on this path.
    expect(d.completeness.summary).not.toMatch(/of 0 concept rules/);
    expect(d.completeness.summary).toContain("THIS CALL'S OWN concepts/ruleIds filter");
    expect(d.completeness.summary).toContain(`selected 0 of the ${CONCEPT_RULES.length} concept rules`);
    expect(d.completeness.summary).toContain('caller-applied narrowing');
    // The disclosure a host relays carries the same reason, verbatim.
    expect(d.disclosure).toContain(d.completeness.summary);
    expect(d.ruleSelection).toEqual({
      ruleIds: ['rule:does-not-exist/anywhere'],
      rulesSelected: 0,
      rulesInModel: CONCEPT_RULES.length,
    });
  });

  it('an empty concepts filter takes the same honest path', async () => {
    const r = await interpretHandler(ctx, { componentId: MD_FIELD, concepts: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.rulesConsidered).toBe(0);
    expect(d.completeness.summary).toContain("THIS CALL'S OWN concepts/ruleIds filter");
    expect(d.ruleSelection).toEqual({
      concepts: [],
      rulesSelected: 0,
      rulesInModel: CONCEPT_RULES.length,
    });
  });

  it('an UNFILTERED "nothing covers this type" verdict keeps the engine\'s own wording', async () => {
    // Whatever component this lands on, the unfiltered summary must never be
    // rewritten — the filter attribution is for filtered calls ONLY.
    const r = await interpretHandler(ctx, { componentId: MD_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.completeness.summary).not.toMatch(/CALL'S OWN/);
  });
});

describe('interpretHandler — honesty', () => {
  it('emits the honest "no rule fired" disclosure (NOT an absence claim) when nothing matches', async () => {
    const r = await interpretHandler(ctx, { componentId: PLAIN_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, disclosure, rendered, trust, evidenceEnvelope } =
      r.value.data;
    expect(interpretations).toHaveLength(0);
    expect(disclosure.toLowerCase()).toContain('no concept rule fired');
    expect(disclosure.toLowerCase()).toContain('not a claim that nothing depends');
    expect(rendered.toLowerCase()).toContain('no concept rule fired');
    // No rule fired ⇒ confidence is unknown by construction, never asserted.
    expect(trust.confidence).toBe('unknown');
    expect(evidenceEnvelope.envelopeVersion).toBe(2);
    expect(evidenceEnvelope.absence?.status).toBe('unknown');
    expect(evidenceEnvelope.claims).toHaveLength(0);
    expect(evidenceEnvelope.trust).toEqual(trust);
  });

  it('returns a phantom-aware component-not-found for an unknown id', async () => {
    const r = await interpretHandler(ctx, {
      componentId: 'CustomField:Nope.Nope__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('hardwires provenance to offline_snapshot on every interpretation and the trust block', async () => {
    const r = await interpretHandler(ctx, { componentId: MD_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.trust.provenance).toBe('offline_snapshot');
    for (const i of r.value.data.interpretations) {
      expect(i.provenance).toBe('offline_snapshot');
    }
    expect(r.value.data.sliceTruncated).toBe(false);
  });
});

describe('adaptCoverage — coverage adapter', () => {
  const summary = (
    status: CoverageSummary['status'],
    missingCoverage: readonly string[] = [],
  ): CoverageSummary => ({
    coverageKnown: status !== 'unknown',
    status,
    coveredTypes: [],
    partialTypes: [],
    notModeledTypes: [],
    missingCoverage,
  });

  it('maps complete → complete with a null caveat', () => {
    expect(adaptCoverage(summary('complete'), false)).toEqual({
      status: 'complete',
      caveat: null,
    });
  });

  it('maps partial → partial with a caveat naming the missing families', () => {
    const c = adaptCoverage(summary('partial', ['Flow']), false);
    expect(c.status).toBe('partial');
    expect(c.caveat).toContain('partial');
    expect(c.caveat).toContain('Flow');
  });

  it('maps unknown → unknown with a caveat', () => {
    const c = adaptCoverage(summary('unknown', ['CustomField']), false);
    expect(c.status).toBe('unknown');
    expect(c.caveat).toContain('unknown');
    expect(c.caveat).toContain('CustomField');
  });

  it('forces a truncated slice down to at most partial (complete can never survive truncation)', () => {
    const c = adaptCoverage(summary('complete'), true);
    expect(c.status).toBe('partial');
    expect(c.caveat).toContain('truncated');
  });
});

// E2E proof that the hub-cap truncation is wired all the way through the
// handler: a component carrying MORE than SLICE_EDGE_CAP (1000) incident edges
// truncates the slice AND forces the reported coverage down from `complete` to
// `partial`, so an absence-shaped rule could never read `complete` over a
// clipped slice. The dedicated graph + a COMPLETE-coverage manifest isolate
// truncation as the ONLY thing that can knock the status below `complete`.
describe('interpretHandler — hub-cap truncation e2e', () => {
  const HUB_OBJ = 'CustomObject:TruncHub__c';
  const SMALL_OBJ = 'CustomObject:TruncSmall__c';
  const STATUS_RULE = 'rule:status-code/cross-ref-automation';
  // SLICE_EDGE_CAP is 1000 (private to interpret.ts); one past it forces truncation.
  const OVER_CAP = 1001;

  // ApexTrigger + Flow both retrieved > 0 ⇒ the status-code rule's
  // dependsOnCoverage summarizes to `complete`, so any non-complete status the
  // handler reports is caused by truncation, not by missing coverage.
  const COVERED_MANIFEST: VaultManifest = {
    ...FIXTURE_MANIFEST,
    coverage: [
      { type: 'ApexTrigger', requested: true, retrieved: 3, errored: false, neverModeled: false },
      { type: 'Flow', requested: true, retrieved: 1, errored: false, neverModeled: false },
    ],
  };

  let tDir: string;
  let tStore: GraphStore;
  let tCtx: Context;

  // 1001-edge fixture import regularly exceeds vitest's 10s default under
  // parallel package test load — pin an explicit budget so the suite is stable.
  beforeAll(async () => {
    tDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-interpret-trunc-'));
    const opened = await openGraph(join(tDir, 't.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    tStore = opened.value;

    // Build the big fixture programmatically: HUB_OBJ carries OVER_CAP incident
    // triggersOn edges (one per distinct ApexTrigger); SMALL_OBJ is the 2-edge
    // control under the SAME complete-coverage manifest.
    const nodes: Node[] = [
      makeNode({ id: HUB_OBJ, type: 'CustomObject', apiName: 'TruncHub__c' }),
      makeNode({ id: SMALL_OBJ, type: 'CustomObject', apiName: 'TruncSmall__c' }),
    ];
    const edges: Edge[] = [];
    for (let i = 0; i < OVER_CAP; i++) {
      const trig = `ApexTrigger:HubTrig${i}`;
      nodes.push(makeNode({ id: trig, type: 'ApexTrigger', apiName: `HubTrig${i}` }));
      edges.push(makeEdge({ fromId: trig, toId: HUB_OBJ, edgeType: 'triggersOn' }));
    }
    for (let i = 0; i < 2; i++) {
      const trig = `ApexTrigger:SmallTrig${i}`;
      nodes.push(makeNode({ id: trig, type: 'ApexTrigger', apiName: `SmallTrig${i}` }));
      edges.push(makeEdge({ fromId: trig, toId: SMALL_OBJ, edgeType: 'triggersOn' }));
    }
    const imp = await importExtractionResults(tStore, [{ nodes, edges }]);
    if (!imp.ok) throw new Error(imp.error.message);
    tCtx = { vaultRoot: tDir, manifest: COVERED_MANIFEST, graph: tStore };
  }, 60_000);

  afterAll(async () => {
    await closeGraph(tStore);
    rmSync(tDir, { recursive: true, force: true });
  }, 30_000);

  it('control: a NON-truncated slice under complete coverage reports complete', async () => {
    const r = await interpretHandler(tCtx, { componentId: SMALL_OBJ, ruleIds: [STATUS_RULE] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.sliceTruncated).toBe(false);
    expect(r.value.data.trust.completeness.status).toBe('complete');
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('a component over SLICE_EDGE_CAP truncates the slice AND degrades coverage to at most partial', async () => {
    const r = await interpretHandler(tCtx, { componentId: HUB_OBJ, ruleIds: [STATUS_RULE] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { sliceTruncated, trust, coverageCaveat, rulesFired } = r.value.data;
    expect(sliceTruncated).toBe(true);
    // Same complete-coverage manifest as the control, but the clipped slice
    // knocks the status DOWN — `complete` can never survive truncation.
    expect(trust.completeness.status).not.toBe('complete');
    expect(trust.completeness.status).toBe('partial');
    expect(coverageCaveat).toBeDefined();
    expect(coverageCaveat).toContain('truncated');
    // The rule still fires over the clipped slice (presence-shaped, not absence).
    expect(rulesFired).toBeGreaterThanOrEqual(1);
  });
});

// #2 e2e — a junction whose SECOND master was not retrieved into the vault. The
// distinct-parent count silently under-reports (count 1 < 2), so the junction
// rule never fires and no per-rule caveat surfaces. "complete coverage" must
// NOT sit beside that silent non-detection: the handler downgrades the aggregate
// completeness off `complete` and discloses the miss in the trust limitations +
// top-level coverageCaveat, EVEN THOUGH no interpretation fired. A dedicated
// graph + a CustomField/CustomObject-complete manifest isolate the un-retrieved
// master as the ONLY thing that can knock the status below `complete`.
describe('interpretHandler — un-retrieved junction master disclosure (#2)', () => {
  const JUNCTION_RULE = 'rule:relationship/junction-object';
  // Miss junction: one resolved MD parent, one PHANTOM (un-retrieved) MD parent.
  const MISS_OBJ = 'CustomObject:MissJunc__c';
  const MISS_PARENT_OK = 'CustomObject:MissAlpha__c'; // seeded
  const MISS_PARENT_GHOST = 'CustomObject:MissGhost__c'; // deliberately NOT seeded
  const MISS_FIELD_OK = 'CustomField:MissJunc__c.AlphaRef__c';
  const MISS_FIELD_GHOST = 'CustomField:MissJunc__c.GhostRef__c';
  // Control junction: BOTH masters resolved (a genuine, fully-grounded 2-master).
  const OK_OBJ = 'CustomObject:OkJunc__c';
  const OK_PARENT_A = 'CustomObject:OkAlpha__c';
  const OK_PARENT_B = 'CustomObject:OkBeta__c';
  const OK_FIELD_A = 'CustomField:OkJunc__c.AlphaRef__c';
  const OK_FIELD_B = 'CustomField:OkJunc__c.BetaRef__c';

  // CustomField + CustomObject both retrieved > 0 ⇒ the junction rule's
  // dependsOnCoverage summarizes to `complete`, so any non-complete status the
  // handler reports is caused by the un-retrieved master, not missing coverage.
  const COVERED_MANIFEST: VaultManifest = {
    ...FIXTURE_MANIFEST,
    coverage: [
      { type: 'CustomField', requested: true, retrieved: 6, errored: false, neverModeled: false },
      { type: 'CustomObject', requested: true, retrieved: 4, errored: false, neverModeled: false },
    ],
  };

  const mdEdge = (fromId: string, toId: string): Edge =>
    makeEdge({ fromId, toId, edgeType: 'lookupTo', properties: { relationshipType: 'MasterDetail' } });

  let mDir: string;
  let mStore: GraphStore;
  let mCtx: Context;

  beforeAll(async () => {
    mDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-interpret-miss-'));
    const opened = await openGraph(join(mDir, 'm.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    mStore = opened.value;
    const nodes: Node[] = [
      makeNode({ id: MISS_OBJ, type: 'CustomObject', apiName: 'MissJunc__c' }),
      makeNode({ id: MISS_PARENT_OK, type: 'CustomObject', apiName: 'MissAlpha__c' }),
      // MISS_PARENT_GHOST intentionally omitted (un-retrieved master).
      makeNode({ id: MISS_FIELD_OK, apiName: 'AlphaRef__c', parentId: MISS_OBJ }),
      makeNode({ id: MISS_FIELD_GHOST, apiName: 'GhostRef__c', parentId: MISS_OBJ }),
      makeNode({ id: OK_OBJ, type: 'CustomObject', apiName: 'OkJunc__c' }),
      makeNode({ id: OK_PARENT_A, type: 'CustomObject', apiName: 'OkAlpha__c' }),
      makeNode({ id: OK_PARENT_B, type: 'CustomObject', apiName: 'OkBeta__c' }),
      makeNode({ id: OK_FIELD_A, apiName: 'AlphaRef__c', parentId: OK_OBJ }),
      makeNode({ id: OK_FIELD_B, apiName: 'BetaRef__c', parentId: OK_OBJ }),
    ];
    const edges: Edge[] = [
      makeEdge({ fromId: MISS_OBJ, toId: MISS_FIELD_OK, edgeType: 'parentOf' }),
      makeEdge({ fromId: MISS_OBJ, toId: MISS_FIELD_GHOST, edgeType: 'parentOf' }),
      mdEdge(MISS_FIELD_OK, MISS_PARENT_OK),
      mdEdge(MISS_FIELD_GHOST, MISS_PARENT_GHOST), // → an un-retrieved parent (phantom)
      makeEdge({ fromId: OK_OBJ, toId: OK_FIELD_A, edgeType: 'parentOf' }),
      makeEdge({ fromId: OK_OBJ, toId: OK_FIELD_B, edgeType: 'parentOf' }),
      mdEdge(OK_FIELD_A, OK_PARENT_A),
      mdEdge(OK_FIELD_B, OK_PARENT_B),
    ];
    const imp = await importExtractionResults(mStore, [{ nodes, edges }]);
    if (!imp.ok) throw new Error(imp.error.message);
    mCtx = { vaultRoot: mDir, manifest: COVERED_MANIFEST, graph: mStore };
  });

  afterAll(async () => {
    await closeGraph(mStore);
    rmSync(mDir, { recursive: true, force: true });
  });

  it('control: a fully-grounded 2-master junction fires and reports complete, no miss note', async () => {
    const r = await interpretHandler(mCtx, { componentId: OK_OBJ, ruleIds: [JUNCTION_RULE] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, trust, coverageCaveat } = r.value.data;
    expect(interpretations.find((i) => i.ruleId === JUNCTION_RULE)).toBeDefined();
    expect(trust.completeness.status).toBe('complete');
    expect(coverageCaveat).toBeUndefined();
    expect(trust.limitations.some((l) => l.includes('not retrieved into the vault'))).toBe(false);
  });

  it('an un-retrieved master: the junction rule stays silent BUT the miss is disclosed and completeness drops off complete', async () => {
    const r = await interpretHandler(mCtx, { componentId: MISS_OBJ, ruleIds: [JUNCTION_RULE] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, trust, coverageCaveat, rulesFired } = r.value.data;
    // Silent non-detection: only one MD parent resolved (count 1 < 2), no fire.
    expect(interpretations.find((i) => i.ruleId === JUNCTION_RULE)).toBeUndefined();
    expect(rulesFired).toBe(0);
    // …but "complete coverage" MUST NOT co-occur with that silence.
    expect(trust.completeness.status).not.toBe('complete');
    expect(trust.completeness.status).toBe('partial');
    expect(coverageCaveat).toBeDefined();
    expect(coverageCaveat).toContain('not retrieved into the vault');
    expect(trust.limitations.some((l) => l.includes('junction (two-master) detection may be incomplete'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WORKFLOWRULE-RETRIEVED-ZERO (P2 grounding / coverage honesty) — the shipped
// RM-A14 workflow concepts (`concept:workflow-field-update-partial-resave` +
// its time-dependent sibling) fire on 0 in an org that uses Flows, not legacy
// workflow. The finding's fear: an un-witnessable automation concept that
// "silently produces nothing" reads as a proven "no such automation" instead of
// "not checked". This fixture pins the honest tri-state END-TO-END through the
// `interpretHandler` (the seed-concept tests only exercise the pure engine over
// hand-built slices; here the coverage disclosure comes from the manifest):
//
//   A) RETRIEVE PATH (witnessable): a WorkflowRule with immediate field updates
//      IS in the graph  → the A14 concept FIRES and cites it. This is the real
//      fix — WorkflowRule is in the retrieve set (`refresh.test.ts` proves the
//      `WorkflowRule → Workflow` xmlName alias is included, not dropped) and the
//      extractor emits `fieldUpdateCount` (`workflow-rule.test.ts`), so the
//      concept is grounded the moment an org actually has workflow rules.
//   B) CONFIRMED-EMPTY (honest silence — the confirmed-empty org state): the org
//      genuinely has zero workflow rules and the retrieve CONFIRMED it
//      (`retrieveConfirmed: true`, `retrieved: 0`) → the concept fires on none,
//      completeness stays `complete`, and NO false "not retrieved" caveat is
//      emitted. "No workflow rules" is a real, grounded answer here.
//   C) UN-CONFIRMED / UN-RETRIEVED (disclose): the byte-identical zero-retrieve
//      row WITHOUT the confirm signal (a `--no-pull` rebuild, a describe-blind
//      pull, a scoped refresh that dropped Workflow) → the concept still fires on
//      none, BUT completeness drops off `complete` and the caveat DISCLOSES that
//      the `WorkflowRule` plane is not fully modeled — "not checked", never a
//      proven "none". This is the exact WORKFLOWRULE-RETRIEVED-ZERO honesty gap.
// ---------------------------------------------------------------------------
describe('interpretHandler — WorkflowRule A14 grounding honesty (WORKFLOWRULE-RETRIEVED-ZERO)', () => {
  const A14_RULE = 'rule:workflow/field-update-partial-resave';
  const A14_CONCEPT = 'concept:workflow-field-update-partial-resave';
  const WFR_FIELD_UPDATE = 'WorkflowRule:Ns__Account.Set_Tier';
  const ANCHOR_OBJ = 'CustomObject:Ns__Account';

  let wDir: string;
  let wStore: GraphStore;

  beforeAll(async () => {
    wDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-interpret-wfr-'));
    const opened = await openGraph(join(wDir, 'w.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    wStore = opened.value;
    const nodes: Node[] = [
      makeNode({ id: ANCHOR_OBJ, type: 'CustomObject', apiName: 'Ns__Account' }),
      // A synthetic WorkflowRule carrying the extractor's declared
      // `fieldUpdateCount` (workflow-rule.ts) — one immediate field update.
      makeNode({
        id: WFR_FIELD_UPDATE,
        type: 'WorkflowRule',
        apiName: 'Ns__Account.Set_Tier',
        properties: { fieldUpdateCount: 2, timeTriggerCount: 0 },
      }),
    ];
    const imp = await importExtractionResults(wStore, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error(imp.error.message);
  });

  afterAll(async () => {
    await closeGraph(wStore);
    rmSync(wDir, { recursive: true, force: true });
  });

  // A) RETRIEVE PATH — the concept is witnessable when the org has workflow rules.
  it('A) fires the A14 concept on a WorkflowRule with immediate field updates (retrieve path is witnessable)', async () => {
    const manifest: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        { type: 'WorkflowRule', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
      ],
    };
    const ctx = { vaultRoot: wDir, manifest, graph: wStore } as unknown as Context;
    const r = await interpretHandler(ctx, { componentId: WFR_FIELD_UPDATE, ruleIds: [A14_RULE] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, rulesFired, coverageCaveat, trust } = r.value.data;
    const fired = interpretations.find((i) => i.ruleId === A14_RULE);
    expect(fired).toBeDefined();
    expect(fired!.concept).toBe(A14_CONCEPT);
    expect(fired!.groundedIn).toEqual([WFR_FIELD_UPDATE]);
    expect(rulesFired).toBe(1);
    expect(coverageCaveat).toBeUndefined();
    expect(trust.completeness.status).toBe('complete');
  });

  // B) CONFIRMED-EMPTY — honest silence, the confirmed-empty org state. No false caveat.
  it('B) confirmed-empty WorkflowRule plane: fires on none, stays complete, emits NO false "not retrieved" caveat', async () => {
    const manifest: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        // retrieved 0 AND retrieveConfirmed true == the org genuinely has none.
        { type: 'WorkflowRule', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
      ],
    };
    const ctx = { vaultRoot: wDir, manifest, graph: wStore } as unknown as Context;
    const r = await interpretHandler(ctx, { componentId: ANCHOR_OBJ, ruleIds: [A14_RULE] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, rulesFired, coverageCaveat, trust } = r.value.data;
    expect(interpretations.find((i) => i.ruleId === A14_RULE)).toBeUndefined();
    expect(rulesFired).toBe(0);
    // The plane WAS checked and confirmed empty — "no workflow rules" is honest,
    // so completeness must stay complete and no coverage caveat may fire.
    expect(coverageCaveat).toBeUndefined();
    expect(trust.completeness.status).toBe('complete');
  });

  // C) UN-CONFIRMED / UN-RETRIEVED — the disclosure the finding demands.
  it('C) un-confirmed WorkflowRule plane: fires on none BUT discloses the plane is not fully modeled (not a proven "none")', async () => {
    const manifest: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        // Byte-identical zero-retrieve row WITHOUT retrieveConfirmed — dropped /
        // describe-blind / --no-pull. Stays PARTIAL so the absence is disclosed.
        { type: 'WorkflowRule', requested: true, retrieved: 0, errored: false, neverModeled: false },
      ],
    };
    const ctx = { vaultRoot: wDir, manifest, graph: wStore } as unknown as Context;
    const r = await interpretHandler(ctx, { componentId: ANCHOR_OBJ, ruleIds: [A14_RULE] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { interpretations, rulesFired, coverageCaveat, trust } = r.value.data;
    // Same silent 0-fire as the confirmed-empty case…
    expect(interpretations.find((i) => i.ruleId === A14_RULE)).toBeUndefined();
    expect(rulesFired).toBe(0);
    // …but here the plane was NOT confirmed, so the honesty gate must disclose it.
    expect(trust.completeness.status).not.toBe('complete');
    expect(trust.completeness.status).toBe('partial');
    expect(coverageCaveat).toBeDefined();
    expect(coverageCaveat).toContain('WorkflowRule');
    expect(coverageCaveat).toContain('not fully modeled');
  });

  // D) not-in-manifest at all — the strongest un-checked signal (unknown, disclosed).
  it('D) WorkflowRule absent from manifest coverage entirely: discloses the plane is not fully modeled', async () => {
    const manifest: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        { type: 'CustomObject', requested: true, retrieved: 5, errored: false, neverModeled: false, retrieveConfirmed: true },
      ],
    };
    const ctx = { vaultRoot: wDir, manifest, graph: wStore } as unknown as Context;
    const r = await interpretHandler(ctx, { componentId: ANCHOR_OBJ, ruleIds: [A14_RULE] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { rulesFired, coverageCaveat, trust } = r.value.data;
    expect(rulesFired).toBe(0);
    expect(trust.completeness.status).not.toBe('complete');
    expect(coverageCaveat).toBeDefined();
    expect(coverageCaveat).toContain('WorkflowRule');
  });
});

// =============================================================================
// A SHARED-CONTAINER MEMBER THAT NEVER ARRIVED reaches the reasoning engine
// (spec row 7). Two concept rules declare `dependsOnCoverage:
// ['SessionSettings']`, and the vault's `settings` container is dispatched by
// exact filename: `Session.settings-meta.xml` → SessionSettings. While a
// `{retrieveConfirmed: true, retrieved: 0}` SessionSettings row read as COVERED,
// `summarizeCoverage(...).missingCoverage` was empty, so `sfi.interpret`
// reported `complete` coverage over a plane nothing had ever read. Measured on
// the probe vault before the fix: `sfi.interpret {componentId: CustomObject:…,
// concepts: ['concept:session-security-posture']}` returned
// `trust.completeness: {"status":"complete"}` with NO coverageCaveat.
//
// THE VAULT STATE UNDER TEST IS THE ONE THE PIPELINE ACTUALLY PRODUCES. The
// earlier version of this block asserted over an incoherent vault — a
// SessionSettings NODE in the graph while the manifest said `retrieved: 0` —
// which the refresh cannot emit: the node exists only if the member file was
// parsed, and parsing it makes `retrieved` ≥ 1. Here the unparsed vault has NO
// SessionSettings node (the container came back without that member), and the
// parsed control has one.
// =============================================================================
describe('interpretHandler — a shared-container plane that never parsed hedges the answer', () => {
  const SESSION_ID = 'SessionSettings:default';
  const OBJECT_ID = 'CustomObject:Widget__c';
  const MFA_RULES = [
    'rule:security/session-mfa-required',
    'rule:security/session-strong-auth-required',
  ];

  /**
   * `settings/` returned 139 members and none of them was
   * `Session.settings-meta.xml`, so the SessionSettings zero is a BUILD
   * outcome. No SessionSettings node can exist in this vault.
   */
  const UNPARSED_MANIFEST: ExtendedVaultManifest = {
    ...FIXTURE_MANIFEST,
    skippedDirectories: { settings: 139 },
    coverage: [
      { type: 'SessionSettings', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
    ],
  };

  /** The same vault with the member present and parsed — the control. */
  const PARSED_MANIFEST: VaultManifest = {
    ...FIXTURE_MANIFEST,
    coverage: [
      { type: 'SessionSettings', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
    ],
  };

  /** The unparsed vault: an object to anchor on, and NO SessionSettings node. */
  let uDir: string;
  let uStore: GraphStore;
  /** The parsed vault: the same object PLUS the parsed SessionSettings node. */
  let pDir: string;
  let pStore: GraphStore;

  const objectNode = makeNode({
    id: OBJECT_ID,
    type: 'CustomObject',
    apiName: 'Widget__c',
  });

  beforeAll(async () => {
    uDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-interpret-unparsed-'));
    const u = await openGraph(join(uDir, 'u.db'));
    if (!u.ok) throw new Error(u.error.message);
    uStore = u.value;
    const uSeed: ExtractionResult = { nodes: [objectNode], edges: [] };
    const uImported = await importExtractionResults(uStore, [uSeed]);
    if (!uImported.ok) throw new Error(uImported.error.message);

    pDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-interpret-parsed-'));
    const p = await openGraph(join(pDir, 'p.db'));
    if (!p.ok) throw new Error(p.error.message);
    pStore = p.value;
    const pSeed: ExtractionResult = {
      nodes: [
        objectNode,
        makeNode({
          id: SESSION_ID,
          type: 'SessionSettings',
          apiName: 'SessionSettings',
          properties: { mfaRequired: true, requiresStrongAuth: true },
        }),
      ],
      edges: [],
    };
    const pImported = await importExtractionResults(pStore, [pSeed]);
    if (!pImported.ok) throw new Error(pImported.error.message);
  });

  afterAll(async () => {
    await closeGraph(uStore);
    await closeGraph(pStore);
    rmSync(uDir, { recursive: true, force: true });
    rmSync(pDir, { recursive: true, force: true });
  });

  it('the unparsed state is exactly this: the SessionSettings node does NOT exist', async () => {
    const ctx = { vaultRoot: uDir, manifest: UNPARSED_MANIFEST, graph: uStore } as unknown as Context;
    const r = await interpretHandler(ctx, { componentId: SESSION_ID, ruleIds: MFA_RULES });
    // The pipeline cannot hand you a node for a member that never arrived —
    // which is why no test here may assert over "node present + retrieved 0".
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('reports partial coverage and names SessionSettings when the plane never parsed', async () => {
    const ctx = { vaultRoot: uDir, manifest: UNPARSED_MANIFEST, graph: uStore } as unknown as Context;
    const r = await interpretHandler(ctx, { componentId: OBJECT_ID, ruleIds: MFA_RULES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The load-bearing assertion: NOT `complete` over a plane nothing read.
    expect(d.trust.completeness.status).toBe('partial');
    expect(d.trust.completeness.missingCoverage).toContain('SessionSettings');
    expect(d.coverageCaveat).toBeDefined();
    expect(d.coverageCaveat).toContain('SessionSettings');
    // The two rules bind `componentTypes: ['SessionSettings']`, so against a
    // CustomObject root they are PROVABLY inapplicable — never "checked clean".
    expect(d.completeness.rulesNotApplicable).toBe(2);
    expect(d.completeness.rulesCheckedClean).toBe(0);
    expect(d.completeness.noRuleCoversComponentType).toBe(true);
    // And the summary must not invent a remedy: the files are NOT on disk, and
    // nothing here may claim they are.
    expect(d.completeness.summary).not.toContain('on disk');
    expect(d.completeness.summary).not.toContain('re-retrieve does NOT close them');
  });

  it('stays `complete` — byte-for-byte the old behaviour — once the member IS parsed', async () => {
    const ctx = { vaultRoot: pDir, manifest: PARSED_MANIFEST, graph: pStore } as unknown as Context;
    const r = await interpretHandler(ctx, { componentId: SESSION_ID, ruleIds: MFA_RULES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.trust.completeness.status).toBe('complete');
    expect(d.coverageCaveat ?? null).toBeNull();
    // Both rules fire against real data — proving the hedge above was caused by
    // coverage, not by the rules being unable to match this node.
    expect(d.rulesFired).toBe(2);
    expect(d.trust.completeness.missingCoverage).toBeUndefined();
  });
});

// INTERPRET-OVERSIZE-KNOBLESS-REMEDY: `sfi.interpret`'s only narrowing
// params are `ruleIds` / `concepts` — no `limit`/`offset`/`filter`-shaped
// field, so the shared oversize guard's schema-derived `narrowingKnobs`
// found nothing and fell back to the generic "(filter, pagination, fewer
// hops)" remedy — parameters this tool does not have. Measured on a real
// vault: `sfi.interpret({ componentId: 'CustomObject:Contact' })` at ~183 KB
// vs the ~40 KB budget returned exactly that unactionable remedy. These
// tests drive the handler THROUGH `dispatchTool` (the wiring in
// `tool-dispatch.ts`'s `sfi.interpret` case), because the generic knob
// mechanism alone never sees the tool-specific fix.
describe('sfi.interpret — oversize remedy names the real narrowing params', () => {
  interface DispatchEnvelope {
    readonly error?: { readonly kind: string; readonly message: string };
    readonly estimatedPayloadBytes?: number;
  }

  const envelopeOf = async (
    args: Readonly<Record<string, unknown>>,
  ): Promise<DispatchEnvelope> => {
    const result = await dispatchTool(ctx, 'sfi.interpret', args);
    const block = result.content[0];
    const text = block !== undefined && block.type === 'text' ? block.text : '{}';
    return JSON.parse(text) as DispatchEnvelope;
  };

  it("FAIL-BEFORE/PASS-AFTER: names ruleIds/concepts and a concrete example call, never the generic 'filter, pagination, fewer hops'", async () => {
    const previous = process.env['SFI_MAX_RESPONSE_BYTES'];
    // Low enough that ANY successful interpret payload is oversize — this
    // isolates the REMEDY TEXT from needing a fixture large enough to
    // organically exceed the real 40 KB budget.
    process.env['SFI_MAX_RESPONSE_BYTES'] = '2000';
    try {
      const parsed = await envelopeOf({ componentId: MD_FIELD });
      expect(parsed.error?.kind).toBe('oversize');
      const message = parsed.error?.message ?? '';
      // Pre-fix: "Re-query with a narrower scope (filter, pagination, fewer
      // hops)." — none of which `interpretInputSchema` has.
      expect(message).not.toContain('(filter, pagination, fewer hops)');
      expect(message).toContain('this tool supports: ruleIds, concepts');
      expect(message).toContain("sfi.interpret({ componentId, ruleIds: ['SOME_RULE_ID'] })");
    } finally {
      if (previous === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
      else process.env['SFI_MAX_RESPONSE_BYTES'] = previous;
    }
  });

  it('the named ruleIds param genuinely narrows the payload — not a fictitious knob', async () => {
    const previous = process.env['SFI_MAX_RESPONSE_BYTES'];
    // Generous budget so BOTH calls succeed — this test is about whether
    // `ruleIds` genuinely shrinks the payload, not about crossing a
    // particular byte line (that is covered by the oversize test above).
    process.env['SFI_MAX_RESPONSE_BYTES'] = '40000';
    try {
      const unfiltered = await envelopeOf({ componentId: MD_FIELD });
      expect(unfiltered.error).toBeUndefined();

      // The SAME call the remedy tells the caller to make, using a REAL rule
      // id this fixture's `MD_FIELD` is proven (above) to fire.
      const filtered = await envelopeOf({
        componentId: MD_FIELD,
        ruleIds: ['rule:relationship/master-detail-cascade'],
      });
      expect(filtered.error).toBeUndefined();
      // Pre-fix concern this test guards against: `ruleIds` being a
      // no-op / unreal knob. It is real — the filtered call is smaller.
      expect(filtered.estimatedPayloadBytes ?? 0).toBeLessThan(
        unfiltered.estimatedPayloadBytes ?? 0,
      );
    } finally {
      if (previous === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
      else process.env['SFI_MAX_RESPONSE_BYTES'] = previous;
    }
  });

  it('a DIFFERENT tool (no oversizeExtras passed) is unaffected — never interpret-specific text', async () => {
    // `runTool`'s new 5th parameter is optional; every OTHER dispatch case
    // (get_edges included) still calls it with exactly 4 arguments, so this
    // is also a regression check that the new parameter did not disturb an
    // existing call site.
    const result = await dispatchTool(ctx, 'sfi.get_edges', { nodeId: MD_FIELD });
    const block = result.content[0];
    const text = block !== undefined && block.type === 'text' ? block.text : '{}';
    expect(text).not.toContain('ruleIds');
    expect(text).not.toContain('sfi.interpret(');
    const parsed = JSON.parse(text) as { readonly error?: unknown; readonly data?: unknown };
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toBeDefined();
  });
});
