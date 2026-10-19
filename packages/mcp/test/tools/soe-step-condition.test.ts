/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

// SAVE-ENTRY-CONDITION. A flow step's `conditional` is the flow's `<start>`
// entry criteria (`kind: 'flow-recordtrigger'`), never its first `<decisions>`
// rule. Before this, both save-order tools took the firer's FIRST `firesWhen`
// context, which on a real org was an inner decision for 41 of 69
// record-triggered flows — so "what happens when I close a case" was answered
// with a branch inside a flow instead of what makes the flow run.

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:save-entry',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Flow',
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

const makeEdge = (overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

const OBJ = 'CustomObject:Demo_Obj__c';
const STATUS = 'CustomField:Demo_Obj__c.Demo_Status__c';
/** Entry criteria AND two decisions; the decisions are numbered FIRST. */
const ENTRY_FLOW = 'Flow:Demo_Entry_And_Decision';
const ENTRY_FLOW_DECISION_0 = `ConditionalContext:${ENTRY_FLOW}.condition-0`;
const ENTRY_FLOW_DECISION_1 = `ConditionalContext:${ENTRY_FLOW}.condition-1`;
const ENTRY_FLOW_ENTRY = `ConditionalContext:${ENTRY_FLOW}.condition-2`;
/** Decisions only — no `<start>` filters, so it runs on every qualifying save. */
const NO_ENTRY_FLOW = 'Flow:Demo_No_Entry';
const NO_ENTRY_FLOW_DECISION = `ConditionalContext:${NO_ENTRY_FLOW}.condition-0`;
/** No conditions at all. */
const BARE_FLOW = 'Flow:Demo_Bare';

const condition = (id: string, parentId: string, kind: string, expression: string): Node =>
  makeNode({
    id,
    type: 'ConditionalContext',
    apiName: id.replace('ConditionalContext:', ''),
    parentId,
    properties: { kind, expression, fieldRefs: [STATUS], synthesized: false },
  });

const flow = (id: string, triggerType: string, recordTriggerType: string): Node =>
  makeNode({
    id,
    apiName: id.replace('Flow:', ''),
    properties: { status: 'Active', triggerType, recordTriggerType },
  });

const triggersOn = (flowId: string, triggerType: string, recordTriggerType: string): Edge =>
  makeEdge({
    fromId: flowId,
    toId: OBJ,
    edgeType: 'triggersOn',
    properties: { triggerType, recordTriggerType },
  });

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: OBJ, type: 'CustomObject', apiName: 'Demo_Obj__c' }),
    makeNode({ id: STATUS, type: 'CustomField', apiName: 'Demo_Status__c', parentId: OBJ }),
    flow(ENTRY_FLOW, 'RecordAfterSave', 'Update'),
    condition(ENTRY_FLOW_DECISION_0, ENTRY_FLOW, 'flow-decision', '$Record.Demo_Status__c EqualTo Closed'),
    condition(ENTRY_FLOW_DECISION_1, ENTRY_FLOW, 'flow-decision', '$Record.Demo_Status__c EqualTo Escalated'),
    condition(
      ENTRY_FLOW_ENTRY,
      ENTRY_FLOW,
      'flow-recordtrigger',
      'Demo_Status__c EqualTo Closed OR Demo_Transferred__c EqualTo true',
    ),
    flow(NO_ENTRY_FLOW, 'RecordBeforeSave', 'CreateAndUpdate'),
    condition(NO_ENTRY_FLOW_DECISION, NO_ENTRY_FLOW, 'flow-decision', '$Record.Demo_Status__c EqualTo Open'),
    flow(BARE_FLOW, 'RecordAfterSave', 'Update'),
  ],
  edges: [
    triggersOn(ENTRY_FLOW, 'RecordAfterSave', 'Update'),
    makeEdge({ fromId: ENTRY_FLOW, toId: ENTRY_FLOW_DECISION_0, edgeType: 'firesWhen' }),
    makeEdge({ fromId: ENTRY_FLOW, toId: ENTRY_FLOW_DECISION_1, edgeType: 'firesWhen' }),
    makeEdge({ fromId: ENTRY_FLOW, toId: ENTRY_FLOW_ENTRY, edgeType: 'firesWhen' }),
    triggersOn(NO_ENTRY_FLOW, 'RecordBeforeSave', 'CreateAndUpdate'),
    makeEdge({ fromId: NO_ENTRY_FLOW, toId: NO_ENTRY_FLOW_DECISION, edgeType: 'firesWhen' }),
    triggersOn(BARE_FLOW, 'RecordAfterSave', 'Update'),
  ],
};

let dir = '';
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'soe-entry-'));
  const opened = await openGraph(join(dir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  const imported = await importExtractionResults(opened.value, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { graph: opened.value, vaultRoot: dir, manifest: MANIFEST } as Context;
});

afterAll(async () => {
  await closeGraph(ctx.graph);
  rmSync(dir, { recursive: true, force: true });
});

const flowSteps = async () => {
  const result = await whatHappensOnSaveHandler(ctx, {
    objectApiName: 'Demo_Obj__c',
    event: 'update',
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value.data.soe.filter((s) => s.componentType === 'Flow');
};

describe('SAVE-ENTRY-CONDITION: a flow step is gated by its entry criteria, not its first decision', () => {
  it('shows the <start> entry criterion even when the decisions are numbered first', async () => {
    const step = (await flowSteps()).find((s) => s.componentId === ENTRY_FLOW);
    expect(step?.conditional?.conditionContextId).toBe(ENTRY_FLOW_ENTRY);
    expect(step?.conditional?.expression).toBe(
      'Demo_Status__c EqualTo Closed OR Demo_Transferred__c EqualTo true',
    );
    expect(step?.conditional?.fieldRefs).toEqual([STATUS]);
    // The grounding pass still runs over the entry criterion it now receives.
    expect(step?.conditional?.refGrounding).toEqual({ checked: true, grounded: 1, ungrounded: 0 });
    expect(step?.entryCriteria).toBeUndefined();
    // The decisions are still there, separately, so the host can explain the
    // inner logic without mistaking it for the gate.
    expect(step?.branches).toEqual({
      count: 2,
      expressions: [
        '$Record.Demo_Status__c EqualTo Closed',
        '$Record.Demo_Status__c EqualTo Escalated',
      ],
    });
  });

  it('a flow with decisions but no entry criteria says it runs on every save of its kind', async () => {
    const step = (await flowSteps()).find((s) => s.componentId === NO_ENTRY_FLOW);
    expect(step?.conditional).toBeUndefined();
    expect(step?.entryCriteria).toEqual({
      none: true,
      text: 'no entry criteria: runs on every create or update',
    });
    expect(step?.branches).toEqual({
      count: 1,
      expressions: ['$Record.Demo_Status__c EqualTo Open'],
    });
  });

  it('a flow with no conditions at all says so and lists no branches', async () => {
    const step = (await flowSteps()).find((s) => s.componentId === BARE_FLOW);
    expect(step?.conditional).toBeUndefined();
    expect(step?.entryCriteria).toEqual({
      none: true,
      text: 'no entry criteria: runs on every update',
    });
    expect(step?.branches).toBeUndefined();
  });

  it('no flow step is ever gated by a flow-decision context', async () => {
    const steps = await flowSteps();
    expect(steps).toHaveLength(3);
    const decisionGated = steps.filter((s) =>
      [ENTRY_FLOW_DECISION_0, ENTRY_FLOW_DECISION_1, NO_ENTRY_FLOW_DECISION].includes(
        s.conditional?.conditionContextId ?? '',
      ),
    );
    expect(decisionGated).toHaveLength(0);
  });

  it('what_happens_on_save and order_of_execution emit identical gates for the same flows', async () => {
    const whos = await flowSteps();
    const ooe = await orderOfExecutionHandler(ctx, { objectApiName: 'Demo_Obj__c', event: 'update' });
    expect(ooe.ok).toBe(true);
    if (!ooe.ok) return;
    const ooeFlows = (ooe.value.data.byEvent.update?.soe ?? []).filter(
      (s) => s.componentType === 'Flow',
    );
    const gate = (s: {
      componentId: string;
      conditional?: unknown;
      entryCriteria?: unknown;
      branches?: unknown;
    }) => ({ id: s.componentId, c: s.conditional, e: s.entryCriteria, b: s.branches });
    expect(ooeFlows.map(gate)).toEqual(whos.map(gate));
    expect(ooeFlows.length).toBe(3);
  });
});
