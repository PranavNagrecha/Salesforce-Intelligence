/// <reference types="vitest/globals" />

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

import type { Context } from '../../src/server.js';
import {
  explainFlowHandler,
  explainFlowInputSchema,
} from '../../src/tools/explain-flow.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Flow: 2 },
  edges: { triggersOn: 1, callsApex: 1, readsFrom: 1, writesTo: 1 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/properties. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Flow',
  apiName: 'TestFlow',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Default edge-shape helper. */
const makeEdge = (overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'flow',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: Full-body Flow with every category populated — trigger info with a
// firesWhen condition, action call, two record lookups against the same
// object (collapsed to one row with filterCount=2), three record writes
// (create + update + delete), and two decision conditions in the mirror.
// =============================================================================

const ACCOUNT_ID = 'CustomObject:Account';
const CONTACT_ID = 'CustomObject:Contact';
const APEX_CLASS_ID = 'ApexClass:NotifyAccountTeam';
const FULL_FLOW_ID = 'Flow:Account_FullBody';
const FULL_CONDITION_TRIGGER_ID =
  'ConditionalContext:Flow:Account_FullBody.condition-0';
const FULL_DECISION_CONDITION_ID_1 =
  'ConditionalContext:Flow:Account_FullBody.condition-1';
const FULL_DECISION_CONDITION_ID_2 =
  'ConditionalContext:Flow:Account_FullBody.condition-2';

const fullBodyFlowSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ACCOUNT_ID,
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      properties: {},
    }),
    makeNode({
      id: CONTACT_ID,
      type: 'CustomObject',
      apiName: 'Contact',
      label: 'Contact',
      properties: {},
    }),
    makeNode({
      id: APEX_CLASS_ID,
      type: 'ApexClass',
      apiName: 'NotifyAccountTeam',
      label: 'NotifyAccountTeam',
      properties: {},
    }),
    makeNode({
      id: FULL_FLOW_ID,
      type: 'Flow',
      apiName: 'Account_FullBody',
      label: 'Account Full Body',
      properties: {
        label: 'Account Full Body',
        description: 'Demonstrates every section of the explain_flow output.',
        processType: 'AutoLaunchedFlow',
        status: 'Active',
        interviewLabel: null,
        runInMode: 'SystemModeWithoutSharing',
        triggerObject: ACCOUNT_ID,
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'CreateAndUpdate',
        flowExtractionWarnings: [],
        faultableElementCount: 3,
        elementsWithoutFault: 2,
        hasUnhandledFaults: true,
        conditions: [
          {
            kind: 'flow-recordtrigger',
            conditionContextId: FULL_CONDITION_TRIGGER_ID,
            expression: 'Industry__c = "Technology"',
            fieldRefs: ['CustomField:Account.Industry__c'],
          },
          {
            kind: 'flow-decision',
            conditionContextId: FULL_DECISION_CONDITION_ID_1,
            expression: 'AnnualRevenue > 1000000',
            fieldRefs: ['CustomField:Account.AnnualRevenue'],
          },
          {
            kind: 'flow-decision',
            conditionContextId: FULL_DECISION_CONDITION_ID_2,
            expression: 'EmployeeCount > 50',
            fieldRefs: ['CustomField:Account.EmployeeCount'],
          },
        ],
      },
    }),
    makeNode({
      id: FULL_CONDITION_TRIGGER_ID,
      type: 'ConditionalContext',
      apiName: 'Flow:Account_FullBody.condition-0',
      label: 'Industry__c = "Technology"',
      parentId: FULL_FLOW_ID,
      properties: {
        kind: 'flow-recordtrigger',
        expression: 'Industry__c = "Technology"',
        fieldRefs: ['CustomField:Account.Industry__c'],
        synthesized: false,
      },
    }),
    makeNode({
      id: FULL_DECISION_CONDITION_ID_1,
      type: 'ConditionalContext',
      apiName: 'Flow:Account_FullBody.condition-1',
      label: 'AnnualRevenue > 1000000',
      parentId: FULL_FLOW_ID,
      properties: {
        kind: 'flow-decision',
        expression: 'AnnualRevenue > 1000000',
        fieldRefs: ['CustomField:Account.AnnualRevenue'],
        synthesized: false,
      },
    }),
    makeNode({
      id: FULL_DECISION_CONDITION_ID_2,
      type: 'ConditionalContext',
      apiName: 'Flow:Account_FullBody.condition-2',
      label: 'EmployeeCount > 50',
      parentId: FULL_FLOW_ID,
      properties: {
        kind: 'flow-decision',
        expression: 'EmployeeCount > 50',
        fieldRefs: ['CustomField:Account.EmployeeCount'],
        synthesized: false,
      },
    }),
  ],
  edges: [
    // triggersOn → Account
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: ACCOUNT_ID,
      edgeType: 'triggersOn',
      properties: {
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'CreateAndUpdate',
      },
    }),
    // firesWhen → trigger condition
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: FULL_CONDITION_TRIGGER_ID,
      edgeType: 'firesWhen',
      source: 'condition-extractor',
      properties: { kind: 'flow-recordtrigger', conditionIndex: 0 },
    }),
    // firesWhen → decision condition 1
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: FULL_DECISION_CONDITION_ID_1,
      edgeType: 'firesWhen',
      source: 'condition-extractor',
      properties: { kind: 'flow-decision', conditionIndex: 1 },
    }),
    // firesWhen → decision condition 2
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: FULL_DECISION_CONDITION_ID_2,
      edgeType: 'firesWhen',
      source: 'condition-extractor',
      properties: { kind: 'flow-decision', conditionIndex: 2 },
    }),
    // callsApex → NotifyAccountTeam
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: APEX_CLASS_ID,
      edgeType: 'callsApex',
      properties: { actionType: 'apex' },
    }),
    // readsFrom → Account (one edge — the graph dedupes by
    // (from_id, to_id, edge_type, source). The Flow extractor emits
    // one readsFrom edge per recordLookups block even if multiple
    // lookups target the same object; the explain_flow tool then
    // counts the edge as one filterCount=1 entry.)
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: ACCOUNT_ID,
      edgeType: 'readsFrom',
      properties: { operation: 'recordLookup' },
    }),
    // readsFrom → Contact (different object)
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: CONTACT_ID,
      edgeType: 'readsFrom',
      properties: { operation: 'recordLookup' },
    }),
    // writesTo → Account (update, source=flow-create)
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: ACCOUNT_ID,
      edgeType: 'writesTo',
      properties: { operation: 'recordUpdate' },
    }),
    // writesTo → Contact (create, source=flow distinguishes from delete)
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: CONTACT_ID,
      edgeType: 'writesTo',
      source: 'flow-create',
      properties: { operation: 'recordCreate' },
    }),
    // writesTo → Contact (delete, distinct source from create so the
    // graph keeps both rows)
    makeEdge({
      fromId: FULL_FLOW_ID,
      toId: CONTACT_ID,
      edgeType: 'writesTo',
      source: 'flow-delete',
      properties: { operation: 'recordDelete' },
    }),
  ],
};

// =============================================================================
// Seed 2: A minimal Flow — no body sections, no decisions, no trigger
// conditions. Verifies the empty-array fallbacks.
// =============================================================================

const MINIMAL_FLOW_ID = 'Flow:Minimal';

const minimalFlowSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: MINIMAL_FLOW_ID,
      type: 'Flow',
      apiName: 'Minimal',
      label: 'Minimal',
      properties: {
        label: 'Minimal',
        description: null,
        processType: 'Flow',
        status: 'Draft',
        interviewLabel: null,
        runInMode: null,
        triggerObject: null,
        triggerType: null,
        recordTriggerType: null,
        flowExtractionWarnings: [],
        conditions: [],
      },
    }),
  ],
  edges: [],
};

// An ApexTrigger sharing a name with no Flow — "explain flow AccountTrigger"
// should point here rather than dead-ending (B26).
const triggerSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'ApexTrigger:AccountTrigger',
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      label: 'AccountTrigger',
      properties: {},
    }),
  ],
  edges: [],
};

// One shared graph store + Context across the suite.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-explain-flow-'));
  const dbPath = join(tempDir, 'explain-flow.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    fullBodyFlowSeed,
    minimalFlowSeed,
    triggerSeed,
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('explainFlowHandler', () => {
  it('points at the ApexTrigger when asked to explain a same-named non-Flow (B26)', async () => {
    const result = await explainFlowHandler(ctx, { flowId: 'AccountTrigger' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    // Names the real component + its type instead of a bare "no Flow".
    expect(result.error.message).toContain('ApexTrigger:AccountTrigger');
    expect(result.error.message).toMatch(/not a Flow/);
  });

  it('still gives a plain not-found when no same-named component exists', async () => {
    const result = await explainFlowHandler(ctx, { flowId: 'TotallyMadeUpName' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toContain('no Flow with id Flow:TotallyMadeUpName');
  });

  it('returns identity + trigger info for a full-body Flow', async () => {
    const result = await explainFlowHandler(ctx, { flowId: FULL_FLOW_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.flowId).toBe(FULL_FLOW_ID);
    expect(data.apiName).toBe('Account_FullBody');
    expect(data.label).toBe('Account Full Body');
    expect(data.status).toBe('Active');
    expect(data.processType).toBe('AutoLaunchedFlow');
    // Trigger info: triggerType from properties, triggerObject from
    // outgoing triggersOn edge, conditions from outgoing firesWhen
    // edges.
    expect(data.triggerInfo.triggerType).toBe('RecordAfterSave');
    expect(data.triggerInfo.triggerObject).toBe(ACCOUNT_ID);
    // Three firesWhen edges → three trigger conditions surface.
    expect(data.triggerInfo.conditions.length).toBe(3);
    // The disclosure is the verbatim explainer-tier signal.
    expect(data.disclosure).toBe('Structured narrative; Claude composes prose');
    // P4-flow-conditions: conditions carry a runtime-evaluation heuristic flag.
    expect(data.conditionsRuntimeNote).toMatch(/statically-declared/);
    expect(data.conditionsRuntimeNote).toMatch(/NOT a runtime trace/);
    // vaultState carries the manifest hash and timestamp.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('surfaces the declared run mode, unhandled-fault flag, and a correct run-mode note', async () => {
    const result = await explainFlowHandler(ctx, { flowId: FULL_FLOW_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ec = result.value.data.executionContext;
    // Declared runInMode surfaced verbatim (not inferred / not inherited).
    expect(ec.runInMode).toBe('SystemModeWithoutSharing');
    // Fault coverage surfaced from the extractor's properties.
    expect(ec.hasUnhandledFaults).toBe(true);
    expect(ec.unhandledFaultElementCount).toBe(2);
    // The note states the load-bearing platform rules the host must NOT
    // fabricate: a subflow runs in its OWN declared mode (does not inherit
    // the caller), $User resolves to the running user, and an unhandled
    // fault rolls back the whole transaction.
    expect(ec.runModeNote).toMatch(/does NOT inherit/);
    expect(ec.runModeNote).toMatch(/OWN declared runInMode/);
    expect(ec.runModeNote).toMatch(/running user/);
    expect(ec.runModeNote).toMatch(/rolls back the ENTIRE/);
  });

  it('returns runInMode=null and no unhandled faults for a minimal flow', async () => {
    const result = await explainFlowHandler(ctx, { flowId: MINIMAL_FLOW_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ec = result.value.data.executionContext;
    expect(ec.runInMode).toBeNull();
    expect(ec.hasUnhandledFaults).toBe(false);
    expect(ec.unhandledFaultElementCount).toBe(0);
    // Note is always present so the host never substitutes a wrong inference.
    expect(ec.runModeNote.length).toBeGreaterThan(0);
  });

  it('surfaces the fields each trigger/firing condition evaluates', async () => {
    const result = await explainFlowHandler(ctx, { flowId: FULL_FLOW_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conditions = result.value.data.triggerInfo.conditions;
    // Three firesWhen edges → three conditions. Each must surface the
    // `fieldRefs` from its ConditionalContext node — previously dropped,
    // which left a real record-trigger/firing row as just the bare connector
    // ("and") with no indication of WHAT gates the flow. The sibling tools
    // order_of_execution + what_happens_on_save already read this same node
    // property, and the v2.0f decision axis surfaces it; the trigger axis
    // must agree (it read the same nodes but projected only `expression`).
    expect(conditions.length).toBe(3);
    expect(conditions[0]?.fieldReferences).toEqual([
      'CustomField:Account.Industry__c',
    ]);
    expect(conditions[1]?.fieldReferences).toEqual([
      'CustomField:Account.AnnualRevenue',
    ]);
    expect(conditions[2]?.fieldReferences).toEqual([
      'CustomField:Account.EmployeeCount',
    ]);
  });

  it('surfaces action calls with target type', async () => {
    const result = await explainFlowHandler(ctx, { flowId: FULL_FLOW_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const actions = result.value.data.actionCalls;
    expect(actions.length).toBe(1);
    expect(actions[0]?.targetId).toBe(APEX_CLASS_ID);
    expect(actions[0]?.targetType).toBe('ApexClass');
  });

  it('collapses record lookups by target object with filter counts', async () => {
    const result = await explainFlowHandler(ctx, { flowId: FULL_FLOW_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lookups = result.value.data.recordLookups;
    // Two readsFrom edges (Account + Contact) → two rows, each with
    // filterCount=1.
    expect(lookups.length).toBe(2);
    const accountLookup = lookups.find((l) => l.object === 'Account');
    expect(accountLookup?.filterCount).toBe(1);
    const contactLookup = lookups.find((l) => l.object === 'Contact');
    expect(contactLookup?.filterCount).toBe(1);
  });

  it('classifies record writes by operation (create / update / delete)', async () => {
    const result = await explainFlowHandler(ctx, { flowId: FULL_FLOW_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const writes = result.value.data.recordWrites;
    // Three writes: Account update + Contact create + Contact delete.
    // The two Contact writes have distinct `source` values so the
    // graph's `(from_id, to_id, edge_type, source)` PK keeps both.
    expect(writes.length).toBe(3);
    const accountWrites = writes.filter((w) => w.object === 'Account');
    const contactWrites = writes.filter((w) => w.object === 'Contact');
    expect(accountWrites.length).toBe(1);
    expect(accountWrites[0]?.operation).toBe('update');
    expect(contactWrites.length).toBe(2);
    const operations = contactWrites.map((w) => w.operation).sort();
    expect(operations).toEqual(['create', 'delete']);
  });

  it('surfaces decisions from the properties.conditions mirror', async () => {
    const result = await explainFlowHandler(ctx, { flowId: FULL_FLOW_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decisions = result.value.data.decisions;
    // The mirror has 3 entries; all 3 surface as decisions (the
    // trigger-context entry is also a row, since the v2.0a mirror
    // does not distinguish trigger vs decision at the schema level).
    expect(decisions.length).toBe(3);
    // The first entry corresponds to the trigger context.
    expect(decisions[0]?.decisionName).toBe(
      'Flow:Account_FullBody.condition-0',
    );
    expect(decisions[0]?.conditions[0]).toBe('Industry__c = "Technology"');
    // The second entry is the AnnualRevenue decision.
    expect(decisions[1]?.conditions[0]).toBe('AnnualRevenue > 1000000');
    // Each decision surfaces the fields it evaluates (mirror `fieldRefs`) —
    // previously dropped, which left real flows (where the expression is just
    // the bare connector "and") with no indication of WHAT they branch on.
    expect(decisions[0]?.fieldReferences).toEqual([
      'CustomField:Account.Industry__c',
    ]);
    expect(decisions[1]?.fieldReferences).toEqual([
      'CustomField:Account.AnnualRevenue',
    ]);
    expect(decisions[2]?.fieldReferences).toEqual([
      'CustomField:Account.EmployeeCount',
    ]);
  });

  it('returns empty arrays for a minimal Flow with no body', async () => {
    const result = await explainFlowHandler(ctx, { flowId: MINIMAL_FLOW_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // No triggersOn edge → null triggerObject.
    expect(data.triggerInfo.triggerObject).toBeNull();
    // No firesWhen edges → empty conditions array.
    expect(data.triggerInfo.conditions).toEqual([]);
    // No outgoing edges in any category.
    expect(data.actionCalls).toEqual([]);
    expect(data.recordLookups).toEqual([]);
    expect(data.recordWrites).toEqual([]);
    // No conditions mirror → empty decisions array.
    expect(data.decisions).toEqual([]);
  });

  it('returns component-not-found for an unknown flow id', async () => {
    const result = await explainFlowHandler(ctx, {
      flowId: 'Flow:DoesNotExist',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('Flow:DoesNotExist');
  });

  it('returns invalid-query when flowId does not start with Flow:', async () => {
    const result = await explainFlowHandler(ctx, {
      flowId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('Flow:');
    expect(result.error.path).toBe('flowId');
  });

  it('returns component-not-found when the id resolves to a non-Flow node', async () => {
    // The graph carries CustomObject:Account; the prefix `Flow:Account`
    // is well-formed under Zod but the lookup returns null (no such
    // Flow). The handler surfaces `component-not-found`.
    const result = await explainFlowHandler(ctx, { flowId: 'Flow:Account' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });
});

describe('explainFlowInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = explainFlowInputSchema.safeParse({
      flowId: 'Flow:MyFlow',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty flowId string', () => {
    const parsed = explainFlowInputSchema.safeParse({ flowId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing flowId', () => {
    const parsed = explainFlowInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});
