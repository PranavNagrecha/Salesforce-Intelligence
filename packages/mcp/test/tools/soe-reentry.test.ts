/// <reference types="vitest/globals" />

/**
 * SAVE-REENTRY — the save-order answer names the steps that write back to the
 * saved object, the documented rule behind the second pass, what an update
 * re-runs (with any visible recursion guard), and one-hop cascades. Before this
 * the host had to infer "why did my flow run twice" itself. Also pins the
 * shared SOE event matchers: `order_of_execution` used to carry a stale copy
 * that dropped record-triggered flows with no `recordTriggerType`.
 * All names synthetic.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import { buildSoeReentry, REENTRY_RULES } from '../../src/tools/soe-reentry.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-reentry',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (
  fromId: string,
  toId: string,
  edgeType: Edge['edgeType'],
  properties: Record<string, unknown> = {},
  confidence: Edge['confidence'] = 'parsed',
): Edge => ({ fromId, toId, edgeType, confidence, source: 'unit-test', properties });

const TRIGGER_SRC = `trigger WidgetTrigger on Widget__c (before update, after update) {
  WidgetHandler.run(Trigger.new);
}`;
const HANDLER_SRC = `public class WidgetHandler {
  private static Boolean alreadyDone = false;
  public static void run(List<Widget__c> rows) {
    if (alreadyDone) { return; }
    alreadyDone = true;
    List<Widget__c> again = new List<Widget__c>();
    for (Widget__c w : rows) { again.add(new Widget__c(Id = w.Id)); }
    update again;
    List<Gadget__c> stale = [SELECT Id FROM Gadget__c];
    delete stale;
  }
}`;
const WORKFLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldUpdates>
        <fullName>Set_Stage</fullName>
        <field>Stage__c</field>
        <literalValue>Open</literalValue>
        <name>Set Stage</name>
        <operation>Literal</operation>
        <reevaluateOnChange>true</reevaluateOnChange>
    </fieldUpdates>
    <fieldUpdates>
        <fullName>Touch_Parent</fullName>
        <field>Touched__c</field>
        <formula>NOW()</formula>
        <name>Touch Parent</name>
        <operation>Formula</operation>
        <targetObject>Owner_Account__c</targetObject>
    </fieldUpdates>
    <rules>
        <fullName>Stage_Rule</fullName>
        <actions><name>Set_Stage</name><type>FieldUpdate</type></actions>
        <actions><name>Touch_Parent</name><type>FieldUpdate</type></actions>
        <active>true</active>
        <formula>true</formula>
        <triggerType>onAllChanges</triggerType>
    </rules>
</Workflow>`;

/** A minimal record-triggered flow file. `body` holds DML elements; `start` extra start children. */
const flowXml = (object: string, body: string, startExtra: string, recordTriggerType = 'CreateAndUpdate'): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>60.0</apiVersion>
    <processType>AutoLaunchedFlow</processType>
${body}
    <start>
        <locationX>0</locationX>
        <locationY>0</locationY>
${startExtra}
        <object>${object}</object>
        <recordTriggerType>${recordTriggerType}</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
    <status>Active</status>
</Flow>`;
const connector = (to: string): string => `<connector><targetReference>${to}</targetReference></connector>`;
const recordUpdate$Record = (name: string, field: string, next = ''): string => `    <recordUpdates>
        <name>${name}</name>
        <label>${name}</label>
        <locationX>0</locationX>
        <locationY>0</locationY>
        ${next}
        <inputAssignments><field>${field}</field><value><stringValue>x</stringValue></value></inputAssignments>
        <inputReference>$Record</inputReference>
    </recordUpdates>`;

const FLOW_SRC: Record<string, string> = {
  // $Record update + an update of another object.
  Widget_After_Stamp: flowXml(
    'Widget__c',
    `${recordUpdate$Record('Stamp_Record', 'Stamp__c', connector('Touch_Gadgets'))}
    <recordUpdates>
        <name>Touch_Gadgets</name>
        <label>Touch Gadgets</label>
        <locationX>0</locationX>
        <locationY>0</locationY>
        <filters><field>Name</field><operator>EqualTo</operator><value><stringValue>a</stringValue></value></filters>
        <inputAssignments><field>Name</field><value><stringValue>b</stringValue></value></inputAssignments>
        <object>Gadget__c</object>
    </recordUpdates>`,
    connector('Stamp_Record'),
  ),
  // Creates a sibling AND updates $Record: the graph keeps only the create edge.
  Swap_After: flowXml(
    'Swap__c',
    `    <recordCreates>
        <name>Make_Sibling</name>
        <label>Make Sibling</label>
        <locationX>0</locationX>
        <locationY>0</locationY>
        ${connector('Stamp_Self')}
        <inputAssignments><field>Note__c</field><value><stringValue>x</stringValue></value></inputAssignments>
        <object>Swap__c</object>
    </recordCreates>
${recordUpdate$Record('Stamp_Self', 'Note__c')}`,
    connector('Make_Sibling'),
  ),
  // Immediate: an <object> update filtered to the current record's Id; scheduled: a $Record update.
  Later_After: flowXml(
    'Later__c',
    `    <recordUpdates>
        <name>Self_By_Id</name>
        <label>Self By Id</label>
        <locationX>0</locationX>
        <locationY>0</locationY>
        <filters><field>Id</field><operator>EqualTo</operator><value><elementReference>$Record.Id</elementReference></value></filters>
        <inputAssignments><field>Seen__c</field><value><booleanValue>true</booleanValue></value></inputAssignments>
        <object>Later__c</object>
    </recordUpdates>
${recordUpdate$Record('Later_Stamp', 'Done__c')}`,
    `${connector('Self_By_Id')}
        <scheduledPaths>
            <name>One_Hour</name>
            <label>One Hour</label>
            ${connector('Later_Stamp')}
            <offsetNumber>1</offsetNumber>
            <offsetUnit>Hours</offsetUnit>
            <timeSource>RecordTriggerEvent</timeSource>
        </scheduledPaths>`,
  ),
  // Create-only flow that inserts records of its own object.
  Spawn_After: flowXml(
    'Spawn__c',
    `    <recordCreates>
        <name>Make_Child</name>
        <label>Make Child</label>
        <locationX>0</locationX>
        <locationY>0</locationY>
        <inputAssignments><field>Kind__c</field><value><stringValue>x</stringValue></value></inputAssignments>
        <object>Spawn__c</object>
    </recordCreates>`,
    connector('Make_Child'),
    'Create',
  ),
};

const PLAIN_WORKFLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldUpdates>
        <fullName>Set_State</fullName>
        <field>State__c</field>
        <literalValue>Open</literalValue>
        <name>Set State</name>
        <operation>Literal</operation>
        <reevaluateOnChange>true</reevaluateOnChange>
    </fieldUpdates>
    <rules>
        <fullName>State_Rule</fullName>
        <actions><name>Set_State</name><type>FieldUpdate</type></actions>
        <active>true</active>
        <formula>true</formula>
        <triggerType>onAllChanges</triggerType>
    </rules>
</Workflow>`;

const afterFlow = (id: string, object: string, recordTriggerType = 'CreateAndUpdate'): { n: Node; e: Edge } => ({
  n: node({
    id: `Flow:${id}`,
    type: 'Flow',
    apiName: id,
    sourcePath: `flows/${id}.flow-meta.xml`,
    properties: { status: 'Active', hasImmediateConnector: true },
  }),
  e: edge(`Flow:${id}`, `CustomObject:${object}`, 'triggersOn', { triggerType: 'RecordAfterSave', recordTriggerType }),
});
const swap = afterFlow('Swap_After', 'Swap__c');
const later = afterFlow('Later_After', 'Later__c');
const spawn = afterFlow('Spawn_After', 'Spawn__c', 'Create');
// A flow whose source is NOT on disk: the graph-edge fallback.
const lost = afterFlow('Lost_After', 'Lost__c');
// Many unreadable flows on one object: caps.
const BUSY = Array.from({ length: 14 }, (_, i) => afterFlow(`Busy_After_${String(i).padStart(2, '0')}`, 'Busy__c'));

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Widget__c', type: 'CustomObject', apiName: 'Widget__c' }),
    node({ id: 'CustomObject:Gadget__c', type: 'CustomObject', apiName: 'Gadget__c' }),
    node({ id: 'CustomField:Widget__c.Stage__c', type: 'CustomField', apiName: 'Stage__c' }),
    node({ id: 'CustomField:Widget__c.Stamp__c', type: 'CustomField', apiName: 'Stamp__c' }),
    node({
      id: 'Flow:Widget_After_Stamp',
      type: 'Flow',
      apiName: 'Widget_After_Stamp',
      sourcePath: 'flows/Widget_After_Stamp.flow-meta.xml',
      properties: { status: 'Active', hasImmediateConnector: true },
    }),
    node({ id: 'Flow:Widget_Before_Default', type: 'Flow', apiName: 'Widget_Before_Default', properties: { status: 'Active' } }),
    node({ id: 'Flow:Widget_After_NoType', type: 'Flow', apiName: 'Widget_After_NoType', properties: { status: 'Active', hasImmediateConnector: true } }),
    node({
      id: 'WorkflowRule:Widget__c.Stage_Rule',
      type: 'WorkflowRule',
      apiName: 'Widget__c.Stage_Rule',
      properties: { active: true, triggerType: 'onAllChanges' },
    }),
    node({
      id: 'ApexTrigger:WidgetTrigger',
      type: 'ApexTrigger',
      apiName: 'WidgetTrigger',
      sourcePath: 'triggers/WidgetTrigger.trigger',
      properties: { triggerObject: 'Widget__c', events: ['before update', 'after update'], status: 'Active' },
    }),
    node({ id: 'ApexClass:WidgetHandler', type: 'ApexClass', apiName: 'WidgetHandler', sourcePath: 'classes/WidgetHandler.cls' }),
    node({
      id: 'ApexTrigger:GadgetTrigger',
      type: 'ApexTrigger',
      apiName: 'GadgetTrigger',
      properties: { triggerObject: 'Gadget__c', events: ['after update'], status: 'Active' },
    }),
    ...['Plain__c', 'Swap__c', 'Later__c', 'Spawn__c', 'Lost__c', 'Busy__c'].map((o) =>
      node({ id: `CustomObject:${o}`, type: 'CustomObject', apiName: o }),
    ),
    node({ id: 'CustomField:Plain__c.State__c', type: 'CustomField', apiName: 'State__c' }),
    node({
      id: 'WorkflowRule:Plain__c.State_Rule',
      type: 'WorkflowRule',
      apiName: 'Plain__c.State_Rule',
      sourcePath: 'wf-elsewhere/Plain__c.workflow-meta.xml',
      properties: { active: true, triggerType: 'onAllChanges' },
    }),
    node({ id: 'Flow:Plain_Before', type: 'Flow', apiName: 'Plain_Before', properties: { status: 'Active' } }),
    node({
      id: 'ApexTrigger:PlainTrigger',
      type: 'ApexTrigger',
      apiName: 'PlainTrigger',
      properties: { triggerObject: 'Plain__c', events: ['before update'], status: 'Active' },
    }),
    swap.n,
    later.n,
    spawn.n,
    lost.n,
    ...BUSY.map((b) => b.n),
  ],
  edges: [
    edge('Flow:Widget_After_Stamp', 'CustomObject:Widget__c', 'triggersOn', { triggerType: 'RecordAfterSave', recordTriggerType: 'CreateAndUpdate' }),
    // `$Record` update: object inferred from the trigger (heuristic, no record-variable marker).
    edge('Flow:Widget_After_Stamp', 'CustomObject:Widget__c', 'writesTo', { operation: 'recordUpdate' }, 'heuristic'),
    edge('Flow:Widget_After_Stamp', 'CustomField:Widget__c.Stamp__c', 'writesTo', { operation: 'recordUpdate' }),
    edge('Flow:Widget_After_Stamp', 'CustomObject:Gadget__c', 'writesTo', { operation: 'recordUpdate' }),
    edge('Flow:Widget_Before_Default', 'CustomObject:Widget__c', 'triggersOn', { triggerType: 'RecordBeforeSave', recordTriggerType: 'CreateAndUpdate' }),
    edge('Flow:Widget_Before_Default', 'CustomField:Widget__c.Stage__c', 'writesTo', { operation: 'recordUpdate' }),
    // No recordTriggerType: the platform default (CreateAndUpdate) applies.
    edge('Flow:Widget_After_NoType', 'CustomObject:Widget__c', 'triggersOn', { triggerType: 'RecordAfterSave' }),
    edge('WorkflowRule:Widget__c.Stage_Rule', 'CustomObject:Widget__c', 'triggersOn'),
    edge('WorkflowRule:Widget__c.Stage_Rule', 'CustomField:Widget__c.Stage__c', 'writesTo', { operation: 'Literal' }),
    edge('WorkflowRule:Widget__c.Stage_Rule', 'WorkflowFieldUpdate:Widget__c.Set_Stage', 'references', { actionType: 'FieldUpdate' }, 'declared'),
    edge('WorkflowRule:Widget__c.Stage_Rule', 'WorkflowFieldUpdate:Widget__c.Touch_Parent', 'references', { actionType: 'FieldUpdate' }, 'declared'),
    edge('ApexTrigger:WidgetTrigger', 'CustomObject:Widget__c', 'triggersOn', {}, 'declared'),
    edge('ApexTrigger:WidgetTrigger', 'ApexClass:WidgetHandler', 'callsApex', { methods: ['run'], methodName: 'run' }),
    edge('ApexTrigger:GadgetTrigger', 'CustomObject:Gadget__c', 'triggersOn', {}, 'declared'),
    // Workflow-only write-back object, with a before-save flow and an update trigger.
    edge('WorkflowRule:Plain__c.State_Rule', 'CustomObject:Plain__c', 'triggersOn'),
    edge('WorkflowRule:Plain__c.State_Rule', 'CustomField:Plain__c.State__c', 'writesTo', { operation: 'Literal' }),
    edge('WorkflowRule:Plain__c.State_Rule', 'WorkflowFieldUpdate:Plain__c.Set_State', 'references', { actionType: 'FieldUpdate' }, 'declared'),
    edge('Flow:Plain_Before', 'CustomObject:Plain__c', 'triggersOn', { triggerType: 'RecordBeforeSave', recordTriggerType: 'CreateAndUpdate' }),
    edge('ApexTrigger:PlainTrigger', 'CustomObject:Plain__c', 'triggersOn', {}, 'declared'),
    // Graph edges as the extractor leaves them: one object-level edge per
    // (flow, object), the first operation in sort order wins.
    swap.e,
    edge('Flow:Swap_After', 'CustomObject:Swap__c', 'writesTo', { operation: 'recordCreate' }),
    edge('Flow:Swap_After', 'CustomField:Swap__c.Note__c', 'writesTo', { operation: 'recordCreate' }),
    later.e,
    spawn.e,
    edge('Flow:Spawn_After', 'CustomObject:Spawn__c', 'writesTo', { operation: 'recordCreate' }),
    lost.e,
    edge('Flow:Lost_After', 'CustomObject:Lost__c', 'writesTo', { operation: 'recordDelete' }),
    edge('Flow:Lost_After', 'CustomField:Lost__c.Note__c', 'writesTo', { operation: 'recordUpdate' }),
    ...BUSY.flatMap((b) => [b.e, edge(b.n.id, 'CustomObject:Busy__c', 'writesTo', { operation: 'recordUpdate' }, 'heuristic')]),
  ],
  warnings: [],
} as unknown as ExtractionResult;

let dir: string;
let graph: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-reentry-'));
  for (const sub of ['triggers', 'classes', 'source/workflows', 'flows', 'wf-elsewhere']) mkdirSync(join(dir, sub), { recursive: true });
  for (const [name, xml] of Object.entries(FLOW_SRC)) writeFileSync(join(dir, `flows/${name}.flow-meta.xml`), xml);
  writeFileSync(join(dir, 'wf-elsewhere/Plain__c.workflow-meta.xml'), PLAIN_WORKFLOW_XML);
  writeFileSync(join(dir, 'triggers/WidgetTrigger.trigger'), TRIGGER_SRC);
  writeFileSync(join(dir, 'classes/WidgetHandler.cls'), HANDLER_SRC);
  writeFileSync(join(dir, 'source/workflows/Widget__c.workflow-meta.xml'), WORKFLOW_XML);
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  graph = opened.value;
  const imported = await importExtractionResults(graph, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph } as Context;
});

afterAll(async () => {
  await closeGraph(graph);
  rmSync(dir, { recursive: true, force: true });
});

describe('what_happens_on_save reentry', () => {
  it('FAIL-BEFORE/PASS-AFTER: names each write-back, its rule, what re-runs and the visible guard', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Widget__c', event: 'update' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const re = r.value.data.reentry;
    expect(re).toBeDefined();
    if (re === undefined) return;
    const byId = new Map(re.writeBacks.map((w) => [w.componentId, w]));

    const flow = byId.get('Flow:Widget_After_Stamp');
    expect(flow).toMatchObject({ mechanism: 'flow-dml', target: 'triggering-record', fields: ['Stamp__c'], rules: ['recursive-save'], tier: 'parsed' });
    const stepOf = (id: string): number | undefined => r.value.data.soe.find((s) => s.componentId === id)?.stepIndex;
    expect(flow?.step).toBe(stepOf('Flow:Widget_After_Stamp'));

    expect(byId.get('WorkflowRule:Widget__c.Stage_Rule')).toMatchObject({
      mechanism: 'workflow-field-update',
      fields: ['Stage__c'],
      rules: ['workflow-field-update', 'reevaluate-workflow'],
    });

    const apex = byId.get('ApexTrigger:WidgetTrigger');
    expect(apex).toMatchObject({ mechanism: 'apex-dml', target: 'records-of-object', tier: 'heuristic', rules: ['apex-dml'] });
    expect(apex?.sites?.[0]).toMatch(/^ApexClass:WidgetHandler:\d+ update \(typed\)$/);

    // A before-save flow's write folds into the pending save: never a write-back.
    expect(byId.has('Flow:Widget_Before_Default')).toBe(false);

    // Flow and Apex DML re-run before-save flows; the workflow update does not.
    expect(re.rerunOnUpdate?.beforeSaveFlowsRerunBy).toEqual(['apex-dml', 'flow-dml']);
    expect(re.rerunOnUpdate?.beforeSaveFlows).toEqual(['Flow:Widget_Before_Default']);
    expect(re.rerunOnUpdate?.triggers).toEqual([
      { componentId: 'ApexTrigger:WidgetTrigger', fires: 'before and after update', guard: 'toggled-static-boolean', guardIn: 'ApexClass:WidgetHandler' },
    ]);

    // One-hop cascades: the flow's update of another object (with its active
    // automation counted) and the workflow's cross-object update (relationship only).
    expect(re.cascades).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ componentId: 'Flow:Widget_After_Stamp', object: 'Gadget__c', operation: 'recordUpdate', targetAutomation: 1, tier: 'parsed' }),
        expect.objectContaining({ componentId: 'WorkflowRule:Widget__c.Stage_Rule', object: null, via: 'Owner_Account__c', targetAutomation: null, tier: 'declared' }),
        // Apex deletes of another object are cascades too (own-object deletes are not listed).
        expect.objectContaining({ componentId: 'ApexTrigger:WidgetTrigger', object: 'Gadget__c', operation: 'delete', tier: 'heuristic' }),
      ]),
    );

    // Every rule a write-back cites is quoted, and nothing else.
    expect(Object.keys(re.rules).sort()).toEqual(['apex-dml', 'recursive-save', 'reevaluate-workflow', 'workflow-field-update']);
    expect(re.rules['workflow-field-update']).toBe(REENTRY_RULES['workflow-field-update']);
    expect(r.value.data.disclosure).toContain('`reentry` names the steps that write back');
  });

  it('a object with no write-back reports a CHECKED empty reentry, not an absent one', async () => {
    const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Gadget__c', event: 'update' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reentry?.writeBacks).toEqual([]);
    expect(r.value.data.reentry?.rerunOnUpdate).toBeUndefined();
    expect(r.value.data.reentryNotChecked).toBeUndefined();
  });
});

const reentryOf = async (objectApiName: string, event: 'insert' | 'update' = 'update') => {
  const r = await whatHappensOnSaveHandler(ctx, { objectApiName, event });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('handler failed');
  expect(r.value.data.reentryNotChecked).toBeUndefined();
  const re = r.value.data.reentry;
  if (re === undefined) throw new Error('no reentry');
  return re;
};

describe('reentry: what re-runs depends on the mechanism', () => {
  it('FAIL-BEFORE/PASS-AFTER: a workflow field update alone re-runs update triggers, NOT before-save flows (the rule it quotes)', async () => {
    const re = await reentryOf('Plain__c');
    expect(re.writeBacks).toEqual([
      expect.objectContaining({
        componentId: 'WorkflowRule:Plain__c.State_Rule',
        mechanism: 'workflow-field-update',
        // Read from the WorkflowRule node's own sourcePath, not a guessed path.
        rules: ['workflow-field-update', 'reevaluate-workflow'],
      }),
    ]);
    expect(re.rerunOnUpdate?.triggers.map((t) => t.componentId)).toEqual(['ApexTrigger:PlainTrigger']);
    expect(re.rerunOnUpdate?.beforeSaveFlowsRerunBy).toEqual([]);
    expect(re.rerunOnUpdate?.beforeSaveFlows).toBeUndefined();
    expect(re.rules['workflow-field-update']).toContain('flows');
  });

  it('FAIL-BEFORE/PASS-AFTER: insert-only write-backs carry no rerunOnUpdate (inserts fire insert automation)', async () => {
    const re = await reentryOf('Spawn__c', 'insert');
    expect(re.writeBacks).toEqual([
      expect.objectContaining({ componentId: 'Flow:Spawn_After', target: 'new-records-of-object', fields: ['Kind__c'], rules: ['dml-save'], tier: 'parsed' }),
    ]);
    expect(re.rerunOnUpdate).toBeUndefined();
  });
});

describe('reentry: flow DML read from source, not collapsed graph edges', () => {
  it('FAIL-BEFORE/PASS-AFTER: create-a-sibling + $Record update keeps the triggering-record recursion', async () => {
    const re = await reentryOf('Swap__c');
    expect(re.writeBacks).toEqual([
      expect.objectContaining({
        componentId: 'Flow:Swap_After',
        target: 'triggering-record',
        alsoTargets: ['new-records-of-object'],
        rules: ['recursive-save', 'dml-save'],
        tier: 'parsed',
      }),
    ]);
    expect(re.rerunOnUpdate?.beforeSaveFlowsRerunBy).toEqual(['flow-dml']);
    expect(re.flowSourceUnread).toBeUndefined();
  });

  it('FAIL-BEFORE/PASS-AFTER: an Id = $Record.Id update is the triggering record; scheduled-path DML is a separate later save', async () => {
    const re = await reentryOf('Later__c');
    const later = re.writeBacks.filter((w) => w.componentId === 'Flow:Later_After');
    expect(later).toEqual([
      expect.objectContaining({ target: 'triggering-record', fields: ['Seen__c'], rules: ['recursive-save'] }),
      expect.objectContaining({ target: 'triggering-record', when: 'scheduled-path', fields: ['Done__c'], rules: ['async-save'] }),
    ]);
    expect(later[0]?.when).toBeUndefined();
    expect(re.rules['async-save']).toBe(REENTRY_RULES['async-save']);
  });

  it('FAIL-BEFORE/PASS-AFTER: unreadable source falls back to edges — a delete edge no longer hides the field update, and it is disclosed', async () => {
    const re = await reentryOf('Lost__c');
    expect(re.writeBacks).toEqual([
      expect.objectContaining({ componentId: 'Flow:Lost_After', target: 'records-of-object', fields: ['Note__c'], tier: 'heuristic' }),
    ]);
    expect(re.flowSourceUnread?.flows).toEqual(['Flow:Lost_After']);
    expect(re.flowSourceUnread?.note).toContain('collapse');
  });

  it('caps write-backs and unread flows with omitted counts', async () => {
    const re = await reentryOf('Busy__c');
    expect(re.writeBacks).toHaveLength(12);
    expect(re.writeBacksOmitted).toBe(2);
    expect(re.flowSourceUnread?.flows).toHaveLength(5);
    expect(re.flowSourceUnread?.omitted).toBe(9);
  });
});

describe('reentry: a failed vault query is never an empty report', () => {
  it('buildSoeReentry returns null (shipped as reentryNotChecked) when the graph cannot be read', async () => {
    const opened = await openGraph(join(dir, 'closed.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    await closeGraph(opened.value);
    const closedCtx = { vaultRoot: dir, manifest: MANIFEST, graph: opened.value } as Context;
    const out = await buildSoeReentry(closedCtx, 'Widget__c', [
      { phase: 'post-save-flows', componentId: 'Flow:Widget_After_Stamp', componentType: 'Flow' },
    ]);
    expect(out).toBeNull();
  });
});

describe('order_of_execution reentry + shared event matchers', () => {
  it('FAIL-BEFORE/PASS-AFTER: a write-back names the events its step fires on', async () => {
    const r = await orderOfExecutionHandler(ctx, { objectApiName: 'Spawn__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reentry?.writeBacks).toEqual([expect.objectContaining({ componentId: 'Flow:Spawn_After', on: ['insert'] })]);
  });

  it('FAIL-BEFORE/PASS-AFTER: carries the same write-backs, named by component', async () => {
    const r = await orderOfExecutionHandler(ctx, { objectApiName: 'Widget__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = (r.value.data.reentry?.writeBacks ?? []).map((w) => w.componentId).sort();
    expect(ids).toEqual(['ApexTrigger:WidgetTrigger', 'Flow:Widget_After_Stamp', 'WorkflowRule:Widget__c.Stage_Rule']);
    expect(r.value.data.reentry?.writeBacks.every((w) => w.step === undefined)).toBe(true);
  });

  it('FAIL-BEFORE/PASS-AFTER: a record-triggered flow with no recordTriggerType is listed (shared matcher)', async () => {
    const r = await orderOfExecutionHandler(ctx, { objectApiName: 'Widget__c', events: ['update'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = (r.value.data.byEvent.update?.soe ?? []).map((s) => s.componentId);
    expect(ids).toContain('Flow:Widget_After_NoType');
  });
});
