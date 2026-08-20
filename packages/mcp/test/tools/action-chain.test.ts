/// <reference types="vitest/globals" />

/**
 * `sfi.action_chain` — record ACTIONS composed as chains.
 *
 * Hermetic: a hand-built fixture graph, no org, no live plane. The fixture is
 * deliberately shaped so each honesty axis has a POSITIVE and a NEGATIVE case:
 * a process that allows recall and one that forbids it, a step action that
 * resolves and one that cannot, a family the manifest covers and one it does not.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  TrustSummary,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  buildActionChainEvidenceEnvelope,
  capStepComponents,
  CHAIN_STEP_COMPONENT_CAP,
  type ChainStep,
  enforceNestedSaveBudget,
  NESTED_SAVE_DEPTH_DISCLOSURE,
} from '../../src/tools/action-chain-model.js';
import { actionChainHandler } from '../../src/tools/action-chain.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  // ValidationRule + DuplicateRule are COUNTED, so a zero for them is a
  // verified none. AutoResponseRule is counted at ZERO — the "emittable type
  // this org legitimately has none of" case. MatchingRule is deliberately
  // ABSENT from the map so an uncounted family stays unresolved.
  components: {
    CustomObject: 6,
    ValidationRule: 2,
    DuplicateRule: 1,
    ApprovalProcess: 2,
    AutoResponseRule: 0,
  },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

/** A manifest with NO coverage for the validation/duplicate families. */
const BARE_MANIFEST: VaultManifest = {
  ...MANIFEST,
  components: { CustomObject: 6 },
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

const LEAD = 'CustomObject:Lead';
const ACCOUNT = 'CustomObject:Account';
const CONTACT = 'CustomObject:Contact';
const OPPORTUNITY = 'CustomObject:Opportunity';

const LEAD_VR = 'ValidationRule:Lead.Requires_Company';
const LEAD_DUP = 'DuplicateRule:Lead.Lead_Dup';
const LEAD_MATCH = 'MatchingRule:Lead.Standard_Lead_Match';
const LEAD_ASSIGN = 'AssignmentRule:Lead.Routing';
const CONVERT_FLOW = 'Flow:Convert_Qualified_Lead';

const ACCOUNT_TRIGGER = 'ApexTrigger:AccountTrigger';
const CONTACT_FLOW = 'Flow:Contact_After_Insert';
const OPP_WORKFLOW = 'WorkflowRule:Opportunity.On_Create';
const LEAD_TRIGGER = 'ApexTrigger:LeadTrigger';

const APPROVAL_MAIN = 'ApprovalProcess:Opportunity.Discount_Approval';
const APPROVAL_NO_RECALL = 'ApprovalProcess:Opportunity.Legacy_Approval';
const APPROVAL_ALERT = 'WorkflowAlert:Opportunity.Notify_Submitter';
const APPROVAL_FIELD = 'CustomField:Opportunity.Approval_Status__c';
const MANAGER_ROLE = 'Role:Sales_Manager';
const FINANCE_QUEUE = 'Queue:Finance_Review';

/**
 * A two-step approval process. Step 1 has ONE approver and an approve action
 * whose FieldUpdate cannot be resolved (the step-level extraction hole); step 2
 * has TWO approvers (the unresolved whenMultipleApprovers gate) and no reject
 * actions (a declared verified-none).
 */
const APPROVAL_STEPS = [
  {
    stepIndex: 0,
    name: 'Manager_Review',
    label: 'Manager Review',
    approvers: [{ name: 'Sales_Manager', type: 'role' }],
    entryCriteriaFormula: 'Amount > 10000',
    entryCriteriaItemCount: 0,
    ifCriteriaNotMet: 'ApproveRecord',
    rejectBehaviorType: 'RejectRequest',
    approvalActions: [{ name: 'Set_Approved', type: 'FieldUpdate' }],
    rejectionActions: [{ name: 'Notify_Submitter', type: 'Alert' }],
  },
  {
    stepIndex: 1,
    name: 'Finance_Review',
    label: 'Finance Review',
    approvers: [
      { name: 'Finance_Review', type: 'queue' },
      { name: 'Sales_Manager', type: 'role' },
    ],
    entryCriteriaFormula: null,
    entryCriteriaItemCount: 0,
    ifCriteriaNotMet: 'GoToNextStep',
    rejectBehaviorType: 'BackToPrevious',
    approvalActions: [],
    rejectionActions: [],
  },
];

const seed: ExtractionResult = {
  nodes: [
    node({ id: LEAD, type: 'CustomObject', apiName: 'Lead' }),
    node({ id: ACCOUNT, type: 'CustomObject', apiName: 'Account' }),
    node({ id: CONTACT, type: 'CustomObject', apiName: 'Contact' }),
    node({ id: OPPORTUNITY, type: 'CustomObject', apiName: 'Opportunity' }),

    node({
      id: LEAD_VR,
      type: 'ValidationRule',
      apiName: 'Lead.Requires_Company',
      parentId: LEAD,
      properties: { active: true, errorMessage: 'Company required', errorDisplayField: null },
    }),
    node({
      id: LEAD_DUP,
      type: 'DuplicateRule',
      apiName: 'Lead.Lead_Dup',
      parentId: LEAD,
      properties: {
        isActive: true,
        operationsOnInsert: ['Alert', 'Report'],
        operationsOnUpdate: ['Alert'],
      },
    }),
    node({ id: LEAD_MATCH, type: 'MatchingRule', apiName: 'Lead.Standard_Lead_Match', parentId: LEAD }),
    node({
      id: LEAD_ASSIGN,
      type: 'AssignmentRule',
      apiName: 'Lead.Routing',
      parentId: LEAD,
      properties: { active: true },
    }),
    node({
      id: CONVERT_FLOW,
      type: 'Flow',
      apiName: 'Convert_Qualified_Lead',
      properties: {
        status: 'Active',
        actionCalls: [
          { actionType: 'convertLead', actionName: 'convertLead' },
          { actionType: 'emailAlert', actionName: 'Notify' },
        ],
      },
    }),

    // Automation so each nested save chain is non-empty.
    node({
      id: ACCOUNT_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      properties: { status: 'Active', events: ['before insert', 'after insert'] },
    }),
    node({
      id: CONTACT_FLOW,
      type: 'Flow',
      apiName: 'Contact_After_Insert',
      properties: { status: 'Active', hasImmediateConnector: true },
    }),
    node({
      id: OPP_WORKFLOW,
      type: 'WorkflowRule',
      apiName: 'Opportunity.On_Create',
      parentId: OPPORTUNITY,
      properties: { active: true, triggerType: 'onCreateOnly' },
    }),
    node({
      id: LEAD_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'LeadTrigger',
      properties: { status: 'Active', events: ['before update', 'after update'] },
    }),

    node({ id: MANAGER_ROLE, type: 'Role', apiName: 'Sales_Manager' }),
    node({ id: FINANCE_QUEUE, type: 'Queue', apiName: 'Finance_Review' }),
    node({
      id: APPROVAL_ALERT,
      type: 'WorkflowAlert',
      apiName: 'Opportunity.Notify_Submitter',
      parentId: OPPORTUNITY,
    }),
    node({
      id: APPROVAL_FIELD,
      type: 'CustomField',
      apiName: 'Opportunity.Approval_Status__c',
      parentId: OPPORTUNITY,
    }),

    node({
      id: APPROVAL_MAIN,
      type: 'ApprovalProcess',
      apiName: 'Opportunity.Discount_Approval',
      parentId: OPPORTUNITY,
      properties: {
        active: true,
        allowRecall: true,
        finalApprovalRecordLock: true,
        finalRejectionRecordLock: false,
        recordEditability: 'AdminOrCurrentApprover',
        entryCriteriaFormula: 'Discount__c > 0.2',
        entryCriteriaItemCount: 0,
        stepCount: 2,
        steps: APPROVAL_STEPS,
        initialSubmissionActions: [{ name: 'Set_Pending', type: 'FieldUpdate' }],
        finalApprovalActions: [{ name: 'Notify_Submitter', type: 'Alert' }],
        finalRejectionActions: [],
        recallActions: [{ name: 'Notify_Submitter', type: 'Alert' }],
        allowedSubmitters: [
          { type: 'role', name: 'Sales_Manager' },
          { type: 'owner', name: null },
        ],
      },
    }),
    node({
      id: APPROVAL_NO_RECALL,
      type: 'ApprovalProcess',
      apiName: 'Opportunity.Legacy_Approval',
      parentId: OPPORTUNITY,
      properties: {
        active: false,
        allowRecall: false,
        finalApprovalRecordLock: false,
        finalRejectionRecordLock: false,
        recordEditability: 'AdminOnly',
        entryCriteriaFormula: null,
        entryCriteriaItemCount: 0,
        stepCount: 0,
        steps: [],
        initialSubmissionActions: [],
        finalApprovalActions: [],
        finalRejectionActions: [],
        recallActions: [],
        allowedSubmitters: [],
      },
    }),
  ],
  edges: [
    edge({ fromId: LEAD, toId: LEAD_VR, edgeType: 'parentOf' }),
    edge({ fromId: LEAD, toId: LEAD_DUP, edgeType: 'parentOf' }),
    edge({ fromId: LEAD, toId: LEAD_MATCH, edgeType: 'parentOf' }),
    edge({ fromId: LEAD, toId: LEAD_ASSIGN, edgeType: 'parentOf' }),
    edge({ fromId: LEAD_DUP, toId: LEAD_MATCH, edgeType: 'references' }),

    edge({ fromId: ACCOUNT_TRIGGER, toId: ACCOUNT, edgeType: 'triggersOn' }),
    edge({
      fromId: CONTACT_FLOW,
      toId: CONTACT,
      edgeType: 'triggersOn',
      properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'Create' },
    }),
    edge({ fromId: OPPORTUNITY, toId: OPP_WORKFLOW, edgeType: 'parentOf' }),
    edge({
      fromId: OPP_WORKFLOW,
      toId: OPPORTUNITY,
      edgeType: 'triggersOn',
      properties: { triggerType: 'onCreateOnly' },
    }),
    edge({ fromId: LEAD_TRIGGER, toId: LEAD, edgeType: 'triggersOn' }),

    edge({ fromId: OPPORTUNITY, toId: APPROVAL_MAIN, edgeType: 'parentOf' }),
    edge({ fromId: OPPORTUNITY, toId: APPROVAL_NO_RECALL, edgeType: 'parentOf' }),
    // Approver edges carry the step index + approver type, exactly as the
    // ApprovalProcess extractor stamps them.
    edge({
      fromId: APPROVAL_MAIN,
      toId: MANAGER_ROLE,
      edgeType: 'references',
      properties: { stepIndex: 0, approverType: 'role' },
    }),
    edge({
      fromId: APPROVAL_MAIN,
      toId: FINANCE_QUEUE,
      edgeType: 'references',
      properties: { stepIndex: 1, approverType: 'queue' },
    }),
    // Process-level hook edges + the field-level writesTo the extractor adds
    // for a PROCESS-level FieldUpdate hook (never for a step-level one).
    edge({
      fromId: APPROVAL_MAIN,
      toId: APPROVAL_ALERT,
      edgeType: 'references',
      properties: { hookType: 'finalApproval', actionType: 'Alert' },
    }),
    edge({
      fromId: APPROVAL_MAIN,
      toId: APPROVAL_FIELD,
      edgeType: 'writesTo',
      confidence: 'parsed',
      properties: { hookType: 'initialSubmission', operation: 'Literal' },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;
let bareCtx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-action-chain-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
  bareCtx = { vaultRoot: tempDir, manifest: BARE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('action_chain — lead convert', () => {
  it('composes the documented sequence in order, one chain for Lead', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.chains).toHaveLength(1);
    expect(d.chains[0]?.subject.apiName).toBe('Lead');
    const phases = d.chains[0]!.steps.map((s) => s.phase);
    // Documented order: request → lead validation → duplicates → mapping →
    // Account → Contact → Opportunity → Lead update → ownership → activities.
    expect(phases.indexOf('convert-field-mapping')).toBeLessThan(
      phases.indexOf('account-save'),
    );
    expect(phases.indexOf('account-save')).toBeLessThan(phases.indexOf('contact-save'));
    expect(phases.indexOf('contact-save')).toBeLessThan(
      phases.indexOf('opportunity-save'),
    );
    expect(phases.indexOf('opportunity-save')).toBeLessThan(phases.indexOf('lead-update'));
    expect(phases.indexOf('lead-update')).toBeLessThan(
      phases.indexOf('activity-carryover'),
    );
    // stepIndex is a dense, unique, 0-based total order.
    expect(d.chains[0]!.steps.map((s) => s.stepIndex)).toEqual(
      d.chains[0]!.steps.map((_, i) => i),
    );
  });

  it('composes a FULL nested save order for each record the convert writes', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = r.value.data.chains[0]!.steps;
    const nested = steps.filter((s) => s.nestedSave !== undefined);
    // Account insert, Contact insert, Opportunity insert, Lead update.
    expect(nested.map((s) => `${s.nestedSave!.objectApiName}:${s.nestedSave!.event}`)).toEqual([
      'Account:insert',
      'Contact:insert',
      'Opportunity:insert',
      'Lead:update',
    ]);
    // Each nested chain is the save-order engine's own output — the Account
    // insert must carry its before-trigger, the Lead update its update trigger.
    const account = nested[0]!.nestedSave!;
    expect(account.soe.some((s) => s.componentId === ACCOUNT_TRIGGER)).toBe(true);
    expect(account.summary.phaseCounts['pre-save-triggers']).toBe(1);
    const lead = nested[3]!.nestedSave!;
    expect(lead.soe.some((s) => s.componentId === LEAD_TRIGGER)).toBe(true);
    // The engine's verbatim disclosure is carried ONCE at response level
    // (deduped) rather than four times inside the nested chains — four copies
    // of a ~3.5 KB string alone overran the response budget on a real org.
    expect(
      r.value.data.disclosures.some(
        (d) => d.includes('verbatim from') && d.includes('NOT EVALUATED'),
      ),
    ).toBe(true);
    expect(r.value.data.summary.nestedSaves).toBe(4);
  });

  it('grounds the convert invocation in a Flow that calls the convertLead action', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const request = r.value.data.chains[0]!.steps.find(
      (s) => s.phase === 'convert-request' && s.resolution === 'resolved',
    );
    expect(request?.components.map((c) => c.componentId)).toEqual([CONVERT_FLOW]);
  });

  it('refuses a lead-convert scoped to a different object rather than answering for Lead', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'lead-convert',
      objectApiName: 'Account',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Lead-scoped by definition');
  });
});

describe('action_chain — unresolved steps are VISIBLE, never omitted', () => {
  it('emits the convert field mapping as unresolved with the reason attached', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mapping = r.value.data.chains[0]!.steps.find(
      (s) => s.phase === 'convert-field-mapping',
    );
    expect(mapping).toBeDefined();
    expect(mapping?.resolution).toBe('unresolved');
    expect(mapping?.unresolvedReason).toContain('LeadConvertSettings');
    expect(mapping?.unresolvedReason).toContain(
      'it is a hole in the answer, NOT a finding that no fields are mapped',
    );
  });

  it('surfaces the Lead-Settings convert toggle as an unresolved GATE on a resolved roster', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const validation = r.value.data.chains[0]!.steps.find(
      (s) => s.phase === 'lead-validation',
    );
    // The roster resolved (the vault has the rule) …
    expect(validation?.resolution).toBe('resolved');
    expect(validation?.components.map((c) => c.componentId)).toEqual([LEAD_VR]);
    // … but its FIRING at convert time is explicitly unresolved.
    expect(validation?.gate?.status).toBe('unresolved');
    expect(validation?.gate?.reason).toContain('Do not read this step as "these will run"');
    expect(r.value.data.summary.unresolvedGates).toBeGreaterThan(0);
  });

  it('marks a step-level approval FieldUpdate unresolved (no edge, unmodeled type)', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      objectApiName: 'Opportunity',
      approvalProcess: APPROVAL_MAIN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const approveActions = r.value.data.chains[0]!.steps.find(
      (s) => s.phase === 'step-approval-actions',
    );
    expect(approveActions?.resolution).toBe('unresolved');
    expect(approveActions?.unresolvedReason).toContain('WorkflowFieldUpdate');
    // The action is still LISTED — the name survives even though it resolves
    // to no node.
    expect(approveActions?.components[0]?.apiName).toBe('Set_Approved');
    expect(approveActions?.components[0]?.targetMissing).toBe(true);
  });
});

describe('action_chain — verified-none vs not-modeled are never conflated', () => {
  it('calls a declared allowRecall:false a VERIFIED NONE with its basis', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      approvalProcess: APPROVAL_NO_RECALL,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const recall = r.value.data.chains[0]!.steps.find((s) => s.phase === 'recall');
    expect(recall?.resolution).toBe('verified-none');
    expect(recall?.absenceBasis).toContain('allowRecall: false');
    expect(recall?.absenceBasis).toContain('DECLARED org fact');
    // A verified none is NOT an unresolved hole and NOT a blind spot.
    expect(recall?.unresolvedReason).toBeUndefined();
    expect(recall?.notModeledReason).toBeUndefined();
  });

  it('calls the Apex convert-invocation path a BLIND SPOT, not an absence', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const apex = r.value.data.chains[0]!.steps.find(
      (s) => s.title === 'Apex convert invocations',
    );
    expect(apex?.resolution).toBe('not-modeled');
    expect(apex?.notModeledReason).toContain(
      'blind spot in this tool, NOT a claim that no Apex converts leads',
    );
    expect(apex?.absenceBasis).toBeUndefined();
  });

  it('downgrades a family the manifest does not cover from verified-none to unresolved', async () => {
    // Same graph, but a manifest with no ValidationRule/DuplicateRule coverage:
    // a zero is then unprovable. Use an object with no rules at all so the
    // absence branch is the one exercised.
    const covered = await actionChainHandler(ctx, { action: 'lead-convert' });
    const uncovered = await actionChainHandler(bareCtx, { action: 'lead-convert' });
    expect(covered.ok && uncovered.ok).toBe(true);
    if (!covered.ok || !uncovered.ok) return;
    // The fixture Lead HAS a duplicate rule, so both resolve — the manifest
    // axis is proven on the AutoResponseRule-style zero below instead.
    const dup = covered.value.data.chains[0]!.steps.find(
      (s) => s.phase === 'convert-duplicate-check',
    );
    expect(dup?.resolution).toBe('resolved');
    // Approval on an object with NO approval process: covered manifest says
    // verified none, bare manifest says unresolved.
    const coveredNone = await actionChainHandler(ctx, {
      action: 'approval-submit',
      objectApiName: 'Account',
    });
    const bareNone = await actionChainHandler(bareCtx, {
      action: 'approval-submit',
      objectApiName: 'Account',
    });
    expect(coveredNone.ok && bareNone.ok).toBe(true);
    if (!coveredNone.ok || !bareNone.ok) return;
    expect(coveredNone.value.data.disclosures.join(' ')).toContain('VERIFIED NONE');
    expect(bareNone.value.data.disclosures.join(' ')).toContain('UNRESOLVED, not a finding');
  });
});

describe('action_chain — approval over a multi-step process', () => {
  it('emits every documented phase in order for a two-step process', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      approvalProcess: APPROVAL_MAIN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = r.value.data.chains[0]!.steps;
    const phases = steps.map((s) => s.phase);
    expect(phases[0]).toBe('submit-request');
    expect(phases[1]).toBe('entry-criteria');
    expect(phases[2]).toBe('initial-submission-actions');
    expect(phases[3]).toBe('record-lock');
    expect(phases).toContain('final-approval-actions');
    expect(phases).toContain('final-rejection-actions');
    expect(phases).toContain('recall');
    expect(phases[phases.length - 1]).toBe('field-update-reentry');
    // Two steps → two approver-assignment rows, in step order.
    const approvers = steps.filter((s) => s.phase === 'approver-assignment');
    expect(approvers).toHaveLength(2);
    expect(approvers[0]?.components.map((c) => c.componentId)).toEqual([MANAGER_ROLE]);
    expect(approvers[1]?.components.map((c) => c.componentId)).toEqual([FINANCE_QUEUE]);
  });

  it('surfaces whenMultipleApprovers as an unresolved gate on a multi-approver step', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      approvalProcess: APPROVAL_MAIN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const approvers = r.value.data.chains[0]!.steps.filter(
      (s) => s.phase === 'approver-assignment',
    );
    expect(approvers[0]?.gate).toBeUndefined();
    expect(approvers[1]?.gate?.reason).toContain('Do not assume unanimous');
  });

  it('models the approval field update re-entering the object save order', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      approvalProcess: APPROVAL_MAIN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reentry = r.value.data.chains[0]!.steps.find(
      (s) => s.phase === 'field-update-reentry',
    );
    expect(reentry?.resolution).toBe('resolved');
    expect(reentry?.components.map((c) => c.componentId)).toEqual([APPROVAL_FIELD]);
    expect(reentry?.nestedSave?.objectApiName).toBe('Opportunity');
    expect(reentry?.nestedSave?.event).toBe('update');
    expect(reentry?.note).toContain('NOT a claim that any of it runs');
  });

  it('narrows to one terminal branch on request and says the rest was omitted BY REQUEST', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      approvalProcess: APPROVAL_MAIN,
      outcome: 'reject',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const phases = r.value.data.chains[0]!.steps.map((s) => s.phase);
    expect(phases).toContain('final-rejection-actions');
    expect(phases).not.toContain('final-approval-actions');
    expect(r.value.data.disclosures.join(' ')).toContain('OMITTED BY YOUR REQUEST');
  });

  it('composes every process on the object when none is named', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      objectApiName: 'Opportunity',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.chains.map((c) => c.subject.componentId).sort()).toEqual(
      [APPROVAL_MAIN, APPROVAL_NO_RECALL].sort(),
    );
    // Inactive processes are still composed — but flagged, not hidden.
    const legacy = r.value.data.chains.find((c) => c.subject.componentId === APPROVAL_NO_RECALL);
    expect(legacy?.subject.active).toBe(false);
  });

  it('refuses an approval chain with no object named', async () => {
    const r = await actionChainHandler(ctx, { action: 'approval-submit' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('refuses an unknown approval process instead of answering empty', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      objectApiName: 'Opportunity',
      approvalProcess: 'No_Such_Process',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });
});

describe('action_chain — recursion cap is disclosed and observable', () => {
  it('discloses the depth cap and where depth 2 stops, on every response', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosures).toContain(NESTED_SAVE_DEPTH_DISCLOSURE);
    expect(NESTED_SAVE_DEPTH_DISCLOSURE).toContain('Depth 2');
    expect(NESTED_SAVE_DEPTH_DISCLOSURE).toContain('FLOOR on what the action touches');
    expect(r.value.data.appliedScope.nestedSaveDepth).toBe(1);
  });

  it('names but does not expand nested saves at depth 0, and says so', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'lead-convert',
      nestedSaveDepth: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nested = r.value.data.chains[0]!.steps.filter((s) => s.nestedSave !== undefined);
    expect(nested).toHaveLength(4);
    for (const s of nested) {
      expect(s.nestedSave?.suppressedByDepthCap).toBe(true);
      expect(s.nestedSave?.soe).toEqual([]);
    }
    // Suppressed chains are NOT counted as composed saves.
    expect(r.value.data.summary.nestedSaves).toBe(0);
    expect(r.value.data.disclosures.join(' ')).toContain('`nestedSaveDepth: 0`');
  });

  it('suppresses the identical per-process re-entry chain when several processes are in scope', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      objectApiName: 'Opportunity',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosures.join(' ')).toContain('NAMED but NOT expanded');
    for (const chain of r.value.data.chains) {
      const reentry = chain.steps.find((s) => s.phase === 'field-update-reentry');
      expect(reentry?.nestedSave?.suppressedByDepthCap).toBe(true);
    }
  });
});

describe('action_chain — evidence envelope', () => {
  it('reports absence as not-checked whenever the chain has a hole', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const env = r.value.data.evidenceEnvelope;
    expect(env.envelopeVersion).toBe(2);
    expect(env.absence?.status).toBe('not-checked');
    expect(env.absence?.note).toContain('NO absence claim over the whole action is defensible');
    expect(env.coverage.status).toBe('partial');
    expect(env.coverage.missingCoverage?.length ?? 0).toBeGreaterThan(0);
    expect(env.trust.provenance).toBe('offline_snapshot');
  });

  it('tallies every resolution kind so no step is silently uncounted', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const counts = r.value.data.summary.resolutionCounts;
    const total = Object.values(counts).reduce((n, v) => n + v, 0);
    expect(total).toBe(r.value.data.summary.totalSteps);
    expect(counts.unresolved).toBeGreaterThan(0);
    expect(counts['not-modeled']).toBeGreaterThan(0);
  });
});

describe('enforceNestedSaveBudget — response-size truncation is honest', () => {
  const bigStep = (
    objectApiName: string,
    event: 'insert' | 'update',
    stepCount: number,
  ): ChainStep => ({
    phase: 'nested',
    stepIndex: 0,
    title: `${objectApiName} ${event}`,
    resolution: 'resolved',
    note: '',
    components: [],
    nestedSave: {
      objectApiName,
      event,
      depth: 1,
      objectModeled: true,
      // Each fake step carries enough padding that a handful blow the budget.
      soe: Array.from({ length: stepCount }, (_, i) => ({
        phase: 'after-triggers' as const,
        stepIndex: i,
        componentId: `ApexTrigger:${objectApiName}_${i}` as `${string}:${string}`,
        componentType: 'ApexTrigger' as const,
        apiName: `${objectApiName}_${i}`.padEnd(400, 'x'),
        actions: [],
      })),
      summary: {
        totalSteps: stepCount,
        activeComponents: stepCount,
        phaseCounts: {} as never,
      },
    },
  });

  it('leaves a chain that fits completely untouched', () => {
    const steps = [bigStep('Account', 'insert', 2)];
    const out = enforceNestedSaveBudget(steps);
    expect(out.trimmed).toEqual([]);
    expect(out.steps).toBe(steps);
  });

  it('sheds the LARGEST chains first and keeps their counts + a recovery call', () => {
    const steps = [
      bigStep('Account', 'insert', 60),
      bigStep('Contact', 'insert', 5),
      bigStep('Opportunity', 'insert', 5),
    ];
    const out = enforceNestedSaveBudget(steps);
    expect(out.trimmed).toEqual(['Account insert']);
    const account = out.steps[0]!.nestedSave!;
    // The sequence went; the COUNTS did not — a trimmed chain can never
    // contradict its own summary.
    expect(account.soe).toEqual([]);
    expect(account.summary.totalSteps).toBe(60);
    expect(account.summary.activeComponents).toBe(60);
    expect(account.stepsOmittedForBudget).toBe(60);
    expect(account.recovery).toContain("objectApiName: 'Account'");
    expect(account.recovery).toContain("event: 'insert'");
    // The chains that fit are byte-identical.
    expect(out.steps[1]).toBe(steps[1]);
    expect(out.steps[2]).toBe(steps[2]);
  });

  it('is deterministic — the same input always sheds the same chains', () => {
    const build = (): ChainStep[] => [
      bigStep('Account', 'insert', 40),
      bigStep('Contact', 'insert', 40),
    ];
    const a = enforceNestedSaveBudget(build());
    const b = enforceNestedSaveBudget(build());
    expect(a.trimmed).toEqual(b.trimmed);
    expect(a.trimmed.length).toBeGreaterThan(0);
  });
});

describe('capStepComponents — a dense org cannot blow the response budget', () => {
  const step = (n: number): ChainStep => ({
    phase: 'lead-validation',
    stepIndex: 0,
    title: 'Lead validation rules',
    resolution: 'resolved',
    note: '',
    components: Array.from({ length: n }, (_, i) => ({
      componentId: `ValidationRule:Lead.R${String(i).padStart(3, '0')}` as `${string}:${string}`,
      componentType: 'ValidationRule' as const,
      apiName: `Lead.R${i}`,
      role: 'lead-validation-rule',
    })),
  });

  it('leaves a roster at or below the cap byte-identical', () => {
    const s = step(CHAIN_STEP_COMPONENT_CAP);
    const out = capStepComponents([s], () => 'recover');
    expect(out.cappedSteps).toEqual([]);
    expect(out.steps[0]).toBe(s);
  });

  it('caps a large roster, keeps the FIRST slice, and names the recovery call', () => {
    // The real sandbox resolved 100 active validation rules onto this one step.
    const out = capStepComponents([step(100)], () => "sfi.order_of_execution { objectApiName: 'Lead' }");
    expect(out.cappedSteps).toEqual(['Lead validation rules']);
    const capped = out.steps[0]!;
    expect(capped.components).toHaveLength(CHAIN_STEP_COMPONENT_CAP);
    expect(capped.componentsOmitted).toBe(100 - CHAIN_STEP_COMPONENT_CAP);
    expect(capped.componentsRecovery).toContain('sfi.order_of_execution');
    // Deterministic slice — composers emit in canonical id order.
    expect(capped.components[0]?.componentId).toBe('ValidationRule:Lead.R000');
    // The step's honesty payload is untouched by a roster cap.
    expect(capped.resolution).toBe('resolved');
    expect(capped.phase).toBe('lead-validation');
  });
});

describe('evidence envelope does not duplicate the disclosures', () => {
  it('carries a POINTER at data.disclosures, not a second copy of them', async () => {
    const r = await actionChainHandler(ctx, { action: 'lead-convert' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    const joined = d.disclosures.join(' ');
    expect(d.evidenceEnvelope.disclosure).not.toBe(joined);
    expect(d.evidenceEnvelope.disclosure).toContain('`disclosures` on this response');
    // The pointer must be a small fraction of what it points at.
    expect((d.evidenceEnvelope.disclosure ?? '').length).toBeLessThan(joined.length / 4);
  });
});

describe('action_chain — an unmodeled action is refused BY NAME, never answered', () => {
  it('refuses owner-change and says it is a tool gap, not an absence', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'owner-change',
    } as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('GAP IN THIS TOOL');
    expect(r.error.message).toContain('not a claim that those actions run no automation');
    // It names what IS modeled so the caller can re-ask.
    expect(r.error.message).toContain('lead-convert');
    expect(r.error.message).toContain('approval-submit');
  });

  it('accepts the phrasings a host or router actually produces', async () => {
    for (const alias of ['convert-lead', 'Lead_Convert', 'CONVERT']) {
      const r = await actionChainHandler(ctx, { action: alias } as never);
      expect(r.ok, `alias ${alias} should resolve to lead-convert`).toBe(true);
      if (!r.ok) continue;
      expect(r.value.data.action).toBe('lead-convert');
    }
    for (const alias of ['approval', 'submit-for-approval']) {
      const r = await actionChainHandler(ctx, {
        action: alias,
        objectApiName: 'Opportunity',
      } as never);
      expect(r.ok, `alias ${alias} should resolve to approval-submit`).toBe(true);
      if (!r.ok) continue;
      expect(r.value.data.action).toBe('approval-submit');
    }
  });
});

describe('action_chain — an UNEXTRACTED hook list is a hole, an EMPTY one is a zero', () => {
  it('calls an extracted-but-empty hook list a verified none', async () => {
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      approvalProcess: APPROVAL_MAIN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // APPROVAL_MAIN declares `finalRejectionActions: []` — present and empty.
    const finalReject = r.value.data.chains[0]!.steps.find(
      (s) => s.phase === 'final-rejection-actions',
    );
    expect(finalReject?.resolution).toBe('verified-none');
    expect(finalReject?.absenceBasis).toContain('DECLARED absence read directly off the component');
  });

  it('calls a hook list the extractor never wrote UNRESOLVED, not a verified none', async () => {
    // A process node from a vault predating the structured hook-list
    // extraction: `steps` is there, the four hook-list properties are not.
    // Parented to Contact, NOT Opportunity: this import mutates the shared
    // fixture store, and an extra Opportunity process would silently change the
    // "composes every process on the object" assertion above.
    const legacyId = 'ApprovalProcess:Contact.Pre_Extraction';
    const legacy: ExtractionResult = {
      nodes: [
        node({
          id: legacyId,
          type: 'ApprovalProcess',
          apiName: 'Contact.Pre_Extraction',
          parentId: CONTACT,
          properties: {
            active: true,
            allowRecall: true,
            recordEditability: 'AdminOnly',
            stepCount: 1,
            steps: [APPROVAL_STEPS[0]],
          },
        }),
      ],
      edges: [edge({ fromId: CONTACT, toId: legacyId, edgeType: 'parentOf' })],
    };
    const imported = await importExtractionResults(store, [legacy]);
    expect(imported.ok).toBe(true);

    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      approvalProcess: legacyId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const initial = r.value.data.chains[0]!.steps.find(
      (s) => s.phase === 'initial-submission-actions',
    );
    expect(initial?.resolution).toBe('unresolved');
    expect(initial?.unresolvedReason).toContain('COVERAGE HOLE');
    expect(initial?.absenceBasis).toBeUndefined();
  });
});

describe('evidence envelope — a TRIMMED answer can never read as a complete one', () => {
  /** A chain with ZERO composition holes: one resolved step, one verified none. */
  const cleanSteps: readonly ChainStep[] = [
    {
      phase: 'entry-criteria',
      stepIndex: 0,
      title: 'Process entry criteria evaluated',
      resolution: 'resolved',
      note: '',
      components: [
        {
          componentId: 'ApprovalProcess:Opportunity.X',
          componentType: 'ApprovalProcess',
          apiName: 'Opportunity.X',
          role: 'process',
        },
      ],
    },
    {
      phase: 'recall',
      stepIndex: 1,
      title: 'Request recalled',
      resolution: 'verified-none',
      note: '',
      components: [],
      absenceBasis: 'allowRecall: false — DECLARED org fact',
    },
  ];

  const trust: TrustSummary = {
    provenance: 'offline_snapshot',
    confidence: 'declared',
    freshness: { snapshotRefreshedAt: MANIFEST.refreshedAt },
    completeness: { status: 'complete' },
    limitations: [],
  };

  const build = (
    omittedSubjects: readonly `${string}:${string}`[],
    cappedSteps: readonly string[],
  ) =>
    buildActionChainEvidenceEnvelope({
      action: 'approval-submit',
      steps: cleanSteps,
      trust,
      disclosures: ['d'],
      omittedSubjects,
      cappedSteps,
    });

  it('BASELINE: with nothing dropped, a hole-free chain is complete + proven-none', () => {
    const env = build([], []);
    expect(env.coverage.status).toBe('complete');
    expect(env.coverage.missingCoverage).toBeUndefined();
    expect(env.absence?.status).toBe('proven-none');
  });

  it('FAIL-BEFORE/PASS-AFTER: a DROPPED subject forces partial + not-checked', () => {
    // Every surviving step is clean, so the per-step scan sees nothing wrong —
    // this is exactly the path that used to report "complete / proven-none" on
    // an answer that had silently dropped whole approval processes.
    const env = build(['ApprovalProcess:Opportunity.Dropped'], []);
    expect(env.coverage.status).toBe('partial');
    expect(env.absence?.status).toBe('not-checked');
    // Structural, not merely prose: a consumer can READ the omission.
    expect(env.coverage.missingCoverage).toContain(
      'budget-omitted-subject: ApprovalProcess:Opportunity.Dropped',
    );
    expect(env.absence?.note).toContain('may be exactly the one that fires');
  });

  it('FAIL-BEFORE/PASS-AFTER: a CAPPED roster forces partial + not-checked', () => {
    const env = build([], ['Lead validation rules and Lead triggers during convert']);
    expect(env.coverage.status).toBe('partial');
    expect(env.absence?.status).toBe('not-checked');
    expect(env.coverage.missingCoverage).toContain(
      'budget-capped-roster: Lead validation rules and Lead triggers during convert',
    );
  });

  it('keeps composition holes and budget omissions as SEPARATE missingCoverage rows', () => {
    const withHole: readonly ChainStep[] = [
      ...cleanSteps,
      {
        phase: 'convert-field-mapping',
        stepIndex: 2,
        title: 'Convert field mapping',
        resolution: 'unresolved',
        note: '',
        components: [],
        unresolvedReason: 'LeadConvertSettings not extracted',
      },
    ];
    const env = buildActionChainEvidenceEnvelope({
      action: 'lead-convert',
      steps: withHole,
      trust,
      disclosures: ['d'],
      omittedSubjects: ['ApprovalProcess:Opportunity.Dropped'],
      cappedSteps: ['Lead validation rules'],
    });
    expect(env.coverage.missingCoverage).toEqual([
      'convert-field-mapping: Convert field mapping',
      'budget-omitted-subject: ApprovalProcess:Opportunity.Dropped',
      'budget-capped-roster: Lead validation rules',
    ]);
    expect(env.coverage.message).toContain('RESPONSE BUDGET also removed content that WAS resolved');
  });

  it('handler path: a per-call cap omission reaches the envelope AND trust', async () => {
    // Opportunity owns two processes; `limit: 1` composes one and omits the
    // other — the omission must be visible in the envelope, not just in prose.
    const r = await actionChainHandler(ctx, {
      action: 'approval-submit',
      objectApiName: 'Opportunity',
      limit: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.chains).toHaveLength(1);
    expect(d.omittedSubjects?.length).toBe(1);
    const omittedId = d.omittedSubjects?.[0];
    expect(d.evidenceEnvelope.coverage.status).toBe('partial');
    expect(d.evidenceEnvelope.absence?.status).toBe('not-checked');
    expect(d.evidenceEnvelope.coverage.missingCoverage).toContain(
      `budget-omitted-subject: ${omittedId}`,
    );
    // The trust block obeys the same two-axis law.
    expect(d.evidenceEnvelope.trust.completeness.status).toBe('partial');
    expect(d.evidenceEnvelope.trust.limitations).toContain(
      `budget-omitted-subject: ${omittedId}`,
    );
  });
});
