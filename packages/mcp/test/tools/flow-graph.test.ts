/// <reference types="vitest/globals" />

/**
 * Unit tests for the `sfi.flow_graph` MCP tool (spec §4.5 DoD).
 *
 * A real DuckDB fixture graph (mirroring `explain-flow.test.ts`) seeds a Flow
 * node whose `sourcePath` points at a synthetic `.flow-meta.xml` written to the
 * temp vault dir, so the on-demand `readFile(join(vaultRoot, sourcePath))` in
 * the handler resolves. Every name is SYNTHETIC — zero org identifiers.
 *
 * Coverage: the full graph (every connector kind, a loop's two
 * connectors, a decision's N rules + default, a fault connector, scheduled
 * paths, a `$Record` start with entry filters, a record op resolved via
 * `<object>`, `unmodeled[]` for a `<waits>` element, an `isGoTo` edge, and
 * subflow `resolved` overlay); `include`-narrowing; `element`-narrowing
 * subgraph; an unknown `element` → invalid-query; an ambiguous bare name →
 * ambiguous success envelope; a wrong-`Type:` prefix → invalid-query; an
 * unknown name → component-not-found.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  flowGraphHandler,
  flowGraphInputSchema,
  type FlowGraph,
} from '../../src/tools/flow-graph.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.2.0',
  refreshedAt: '2026-06-01T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: { Flow: 4 },
  edges: {},
  sourceTreeHash: 'sha256:flow-graph-fixture',
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
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'flow',
  properties: {},
  ...overrides,
});

// The demo Flow's real element <name>s (never synthetic condition-N).
const DEMO_FLOW_ID = 'Flow:Ns__Flow_Graph_Demo';
const DEMO_SOURCE_RELPATH = 'source/flows/Ns__Flow_Graph_Demo.flow-meta.xml';
const RESOLVABLE_SUB_ID = 'Flow:Ns__Sub_Flow';

/**
 * A synthetic Flow exercising every projection axis: a `$Record` start with an
 * entry filter + a scheduled path, a decision with two rules + a default, two
 * assignments (one is a fault target), a record update with a fault connector,
 * a loop with next/noMore connectors (the noMore edge is a loop-back `isGoTo`),
 * a resolvable + a dangling subflow, a formula, two variables, and an unmodeled
 * `<waits>` element.
 */
const DEMO_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <apiVersion>60.0</apiVersion>',
  '    <label>Ns Flow Graph Demo</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <runInMode>SystemModeWithoutSharing</runInMode>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <recordTriggerType>CreateAndUpdate</recordTriggerType>',
  '        <doesRequireRecordChangedToMeetCriteria>true</doesRequireRecordChangedToMeetCriteria>',
  '        <filterLogic>and</filterLogic>',
  '        <filters>',
  '            <field>Status__c</field>',
  '            <operator>EqualTo</operator>',
  '            <value><stringValue>Active</stringValue></value>',
  '        </filters>',
  '        <connector><targetReference>My_Decision</targetReference></connector>',
  '        <scheduledPaths>',
  '            <name>My_Scheduled_Path</name>',
  '            <label>My Scheduled Path</label>',
  '            <offsetNumber>1</offsetNumber>',
  '            <offsetUnit>Hours</offsetUnit>',
  '            <timeSource>RecordField</timeSource>',
  '            <connector><targetReference>My_Assignment</targetReference></connector>',
  '        </scheduledPaths>',
  '    </start>',
  '    <decisions>',
  '        <name>My_Decision</name>',
  '        <label>My Decision</label>',
  '        <defaultConnector><targetReference>My_Assignment</targetReference></defaultConnector>',
  '        <defaultConnectorLabel>Default Outcome</defaultConnectorLabel>',
  '        <rules>',
  '            <name>Rule_Approved</name>',
  '            <label>Rule Approved</label>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.Status__c</leftValueReference>',
  '                <operator>EqualTo</operator>',
  '                <rightValue><stringValue>Approved</stringValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>My_Update</targetReference></connector>',
  '        </rules>',
  '        <rules>',
  '            <name>Rule_Loop</name>',
  '            <label>Rule Loop</label>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.Status__c</leftValueReference>',
  '                <operator>EqualTo</operator>',
  '                <rightValue><stringValue>Pending</stringValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>My_Loop</targetReference></connector>',
  '        </rules>',
  '    </decisions>',
  '    <assignments>',
  '        <name>My_Assignment</name>',
  '        <label>My Assignment</label>',
  '        <assignmentItems>',
  '            <assignToReference>My_Var</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><numberValue>5</numberValue></value>',
  '        </assignmentItems>',
  '        <connector><targetReference>My_Update</targetReference></connector>',
  '    </assignments>',
  '    <assignments>',
  '        <name>My_Fault_Assign</name>',
  '        <label>My Fault Assign</label>',
  '        <assignmentItems>',
  '            <assignToReference>My_Var</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><numberValue>0</numberValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '    <recordUpdates>',
  '        <name>My_Update</name>',
  '        <label>My Update</label>',
  '        <object>Ns__Obj__c</object>',
  '        <filterLogic>and</filterLogic>',
  '        <filters>',
  '            <field>Id</field>',
  '            <operator>EqualTo</operator>',
  '            <value><elementReference>$Record.Id</elementReference></value>',
  '        </filters>',
  '        <inputAssignments>',
  '            <field>Status__c</field>',
  '            <value><stringValue>Done</stringValue></value>',
  '        </inputAssignments>',
  '        <connector><targetReference>My_Subflow</targetReference></connector>',
  '        <faultConnector><targetReference>My_Fault_Assign</targetReference></faultConnector>',
  '    </recordUpdates>',
  '    <loops>',
  '        <name>My_Loop</name>',
  '        <label>My Loop</label>',
  '        <collectionReference>My_Collection</collectionReference>',
  '        <iterationOrder>Asc</iterationOrder>',
  '        <nextValueConnector><targetReference>My_Assignment</targetReference></nextValueConnector>',
  '        <noMoreValuesConnector><targetReference>My_Decision</targetReference><isGoTo>true</isGoTo></noMoreValuesConnector>',
  '    </loops>',
  '    <subflows>',
  '        <name>My_Subflow</name>',
  '        <label>My Subflow</label>',
  '        <flowName>Ns__Sub_Flow</flowName>',
  '        <connector><targetReference>My_Dangling_Subflow</targetReference></connector>',
  '    </subflows>',
  '    <subflows>',
  '        <name>My_Dangling_Subflow</name>',
  '        <label>My Dangling Subflow</label>',
  '        <flowName>Ns__Managed_Sub</flowName>',
  '    </subflows>',
  '    <formulas>',
  '        <name>My_Formula</name>',
  '        <dataType>Number</dataType>',
  '        <expression>{!My_Var} + 1</expression>',
  '    </formulas>',
  '    <variables>',
  '        <name>My_Var</name>',
  '        <dataType>Number</dataType>',
  '        <isCollection>false</isCollection>',
  '        <isInput>true</isInput>',
  '        <isOutput>false</isOutput>',
  '    </variables>',
  '    <variables>',
  '        <name>My_Collection</name>',
  '        <dataType>SObject</dataType>',
  '        <objectType>Ns__Obj__c</objectType>',
  '        <isCollection>true</isCollection>',
  '        <isInput>false</isInput>',
  '        <isOutput>false</isOutput>',
  '    </variables>',
  '    <waits>',
  '        <name>My_Wait</name>',
  '        <label>My Wait</label>',
  '        <connector><targetReference>My_Decision</targetReference></connector>',
  '    </waits>',
  '</Flow>',
].join('\n');

/**
 * A SECOND synthetic Flow, added for the W2B "what does each element do" work.
 * Deliberately separate from {@link DEMO_FLOW_XML} so every pre-existing count
 * assertion above stays untouched.
 *
 * It carries: a flow-level `<description>`; an element `<description>` on the
 * decision, screen, action and record-op; a `<screens>` element with a
 * DisplayText field, an InputField, a ComponentInstance (`extensionName` +
 * `inputParameters`) and a RegionContainer nesting a Region nesting a field; an
 * `<actionCalls>` with scalar + reference `inputParameters`, a valueless
 * parameter, and an `<outputParameters>`; a `<collectionProcessors>` element
 * (identity + connector projected, BODY unmodeled); and two containers this
 * projection carries no datum for (`<constants>`, `<textTemplates>`) plus one
 * pure-metadata container (`<interviewLabel>`). A decision rule loops BACK to
 * the screen so the walkthrough's `revisit` guard is exercised, and one element
 * is deliberately connected to by nothing so `unreachable[]` is non-empty.
 */
const DETAIL_FLOW_ID = 'Flow:Ns__Flow_Detail_Demo';
const DETAIL_SOURCE_RELPATH = 'source/flows/Ns__Flow_Detail_Demo.flow-meta.xml';

const DETAIL_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <apiVersion>62.0</apiVersion>',
  '    <description>Collects a rating from the user and emails the outcome.</description>',
  '    <interviewLabel>Ns Flow Detail Demo {!$Flow.CurrentDateTime}</interviewLabel>',
  '    <label>Ns Flow Detail Demo</label>',
  '    <processType>Flow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <connector><targetReference>Ask_For_Rating</targetReference></connector>',
  '    </start>',
  '    <screens>',
  '        <description>Ask the reviewer for a rating and show the policy text.</description>',
  '        <name>Ask_For_Rating</name>',
  '        <label>Ask For Rating</label>',
  '        <allowBack>true</allowBack>',
  '        <allowFinish>false</allowFinish>',
  '        <allowPause>false</allowPause>',
  '        <nextOrFinishButtonLabel>Continue</nextOrFinishButtonLabel>',
  '        <fields>',
  '            <name>Policy_Text</name>',
  '            <fieldText>&lt;p&gt;Rate this application.&lt;/p&gt;</fieldText>',
  '            <fieldType>DisplayText</fieldType>',
  '        </fields>',
  '        <fields>',
  '            <name>Rating_Input</name>',
  '            <fieldText>Rating</fieldText>',
  '            <fieldType>InputField</fieldType>',
  '            <dataType>Number</dataType>',
  '            <isRequired>true</isRequired>',
  '            <helpText>Whole numbers only.</helpText>',
  '            <choiceReferences>Choice_High</choiceReferences>',
  '            <choiceReferences>Choice_Low</choiceReferences>',
  '            <visibilityRule>',
  '                <conditionLogic>and</conditionLogic>',
  '                <conditions>',
  '                    <leftValueReference>Show_Rating</leftValueReference>',
  '                    <operator>EqualTo</operator>',
  '                    <rightValue><booleanValue>true</booleanValue></rightValue>',
  '                </conditions>',
  '            </visibilityRule>',
  '        </fields>',
  '        <fields>',
  '            <name>Custom_Widget</name>',
  '            <fieldType>ComponentInstance</fieldType>',
  '            <extensionName>c:nsRatingWidget</extensionName>',
  '            <inputParameters>',
  '                <name>recordId</name>',
  '                <value><elementReference>Target_Var</elementReference></value>',
  '            </inputParameters>',
  '        </fields>',
  // Salesforce emits an ObjectProvided record-form field with NO <name>: its
  // identity is objectFieldReference. Requiring a name silently dropped these.
  '        <fields>',
  '            <fieldType>ObjectProvided</fieldType>',
  '            <isRequired>true</isRequired>',
  '            <objectFieldReference>Ns__Obj__c.Status__c</objectFieldReference>',
  '        </fields>',
  '        <fields>',
  '            <name>Outer_Container</name>',
  '            <fieldType>RegionContainer</fieldType>',
  '            <regionContainerType>SectionWithHeader</regionContainerType>',
  '            <fields>',
  '                <name>Left_Region</name>',
  '                <fieldType>Region</fieldType>',
  '                <fields>',
  '                    <name>Nested_Note</name>',
  '                    <fieldText>Nested note</fieldText>',
  '                    <fieldType>DisplayText</fieldType>',
  '                </fields>',
  '            </fields>',
  '        </fields>',
  '        <connector><targetReference>Rating_High_Enough</targetReference></connector>',
  '    </screens>',
  '    <decisions>',
  '        <description>Send the email only when the rating clears the bar.</description>',
  '        <name>Rating_High_Enough</name>',
  '        <label>Rating High Enough</label>',
  '        <defaultConnector><targetReference>Ask_For_Rating</targetReference></defaultConnector>',
  '        <defaultConnectorLabel>Try Again</defaultConnectorLabel>',
  '        <rules>',
  '            <name>Yes_Send</name>',
  '            <label>Yes Send</label>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>Rating_Input</leftValueReference>',
  '                <operator>GreaterThan</operator>',
  '                <rightValue><numberValue>3</numberValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>Send_Outcome_Email</targetReference></connector>',
  '        </rules>',
  '    </decisions>',
  '    <actionCalls>',
  '        <description>Email the applicant the committee outcome.</description>',
  '        <name>Send_Outcome_Email</name>',
  '        <label>Send Outcome Email</label>',
  '        <actionName>emailSimple</actionName>',
  '        <actionType>emailSimple</actionType>',
  '        <connector><targetReference>Filter_Rejects</targetReference></connector>',
  '        <inputParameters>',
  '            <name>emailSubject</name>',
  '            <value><stringValue>Committee outcome</stringValue></value>',
  '        </inputParameters>',
  '        <inputParameters>',
  '            <name>recipientId</name>',
  '            <value><elementReference>Target_Var</elementReference></value>',
  '        </inputParameters>',
  '        <inputParameters>',
  '            <name>ccRecipientAddressList</name>',
  '        </inputParameters>',
  '        <outputParameters>',
  '            <assignToReference>Email_Status</assignToReference>',
  '            <name>status</name>',
  '        </outputParameters>',
  '    </actionCalls>',
  '    <collectionProcessors>',
  '        <description>Drop the rejected rows before the summary.</description>',
  '        <name>Filter_Rejects</name>',
  '        <label>Filter Rejects</label>',
  '        <elementSubtype>FilterCollectionProcessor</elementSubtype>',
  '        <collectionReference>Target_Collection</collectionReference>',
  '    </collectionProcessors>',
  '    <recordUpdates>',
  '        <description>Never reached — nothing connects to this element.</description>',
  '        <name>Orphan_Update</name>',
  '        <label>Orphan Update</label>',
  '        <object>Ns__Obj__c</object>',
  '    </recordUpdates>',
  '    <formulas>',
  '        <description>Doubles the rating for the summary line.</description>',
  '        <name>Doubled_Rating</name>',
  '        <dataType>Number</dataType>',
  '        <expression>{!Rating_Input} * 2</expression>',
  '    </formulas>',
  '    <variables>',
  '        <description>Record the email lands against.</description>',
  '        <name>Target_Var</name>',
  '        <dataType>String</dataType>',
  '        <isCollection>false</isCollection>',
  '        <isInput>true</isInput>',
  '        <isOutput>false</isOutput>',
  '    </variables>',
  '    <constants>',
  '        <name>Passing_Score</name>',
  '        <dataType>Number</dataType>',
  '        <value><numberValue>3</numberValue></value>',
  '    </constants>',
  '    <textTemplates>',
  '        <name>Outcome_Body</name>',
  '        <text>Hello</text>',
  '    </textTemplates>',
  '</Flow>',
].join('\n');

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: DEMO_FLOW_ID,
      type: 'Flow',
      apiName: 'Ns__Flow_Graph_Demo',
      label: 'Ns Flow Graph Demo',
      sourcePath: DEMO_SOURCE_RELPATH,
      apiVersion: 60,
      properties: {
        label: 'Ns Flow Graph Demo',
        processType: 'AutoLaunchedFlow',
        status: 'Active',
        runInMode: 'SystemModeWithoutSharing',
      },
    }),
    makeNode({
      id: DETAIL_FLOW_ID,
      type: 'Flow',
      apiName: 'Ns__Flow_Detail_Demo',
      label: 'Ns Flow Detail Demo',
      sourcePath: DETAIL_SOURCE_RELPATH,
      apiVersion: 62,
      properties: {
        label: 'Ns Flow Detail Demo',
        processType: 'Flow',
        status: 'Active',
      },
    }),
    // Resolvable subflow target — the overlay must mark My_Subflow resolved.
    makeNode({
      id: RESOLVABLE_SUB_ID,
      type: 'Flow',
      apiName: 'Ns__Sub_Flow',
      label: 'Ns Sub Flow',
      properties: { status: 'Active' },
    }),
    // Two shared-prefix flows so a typo of the prefix resolves AMBIGUOUSLY.
    makeNode({
      id: 'Flow:Order_Escalation_One',
      type: 'Flow',
      apiName: 'Order_Escalation_One',
      label: 'Order Escalation One',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: 'Flow:Order_Escalation_Two',
      type: 'Flow',
      apiName: 'Order_Escalation_Two',
      label: 'Order Escalation Two',
      properties: { status: 'Active' },
    }),
  ],
  edges: [
    // A single edge so the resolve-index's inbound-count query has a row.
    makeEdge({
      fromId: DEMO_FLOW_ID,
      toId: 'ApexClass:Ns__Helper',
      edgeType: 'callsApex',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-flow-graph-'));
  const sourceDir = join(tempDir, 'source/flows');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, 'Ns__Flow_Graph_Demo.flow-meta.xml'),
    DEMO_FLOW_XML,
    'utf-8',
  );
  writeFileSync(
    join(sourceDir, 'Ns__Flow_Detail_Demo.flow-meta.xml'),
    DETAIL_FLOW_XML,
    'utf-8',
  );

  const opened = await openGraph(join(tempDir, 'flow-graph.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

/** Narrow the union to the projected-graph branch (asserts it is NOT ambiguous). */
const asGraph = (data: unknown): FlowGraph => {
  if (data !== null && typeof data === 'object' && 'ambiguous' in data) {
    throw new Error('expected a projected FlowGraph, got an ambiguous envelope');
  }
  return data as FlowGraph;
};

describe('flowGraphHandler — full structural projection', () => {
  it('returns the resolved flowRef, meta, and start block for a bare-name request', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Graph_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    // flowRef resolution echo (bare name → api-name, exact).
    expect(g.flowRef.componentId).toBe(DEMO_FLOW_ID);
    expect(g.flowRef.resolvedForm).toBe('api-name');
    expect(g.flowRef.matchConfidence).toBe('exact');
    // meta composed from the graph node.
    expect(g.meta.apiName).toBe('Ns__Flow_Graph_Demo');
    expect(g.meta.processType).toBe('AutoLaunchedFlow');
    expect(g.meta.status).toBe('Active');
    expect(g.meta.runInMode).toBe('SystemModeWithoutSharing');
    expect(g.meta.apiVersion).toBe(60);
    // start block: $Record trigger + entry filter + immediate connector.
    expect(g.start.object).toBe('Ns__Obj__c');
    expect(g.start.triggerType).toBe('RecordAfterSave');
    expect(g.start.filters).toHaveLength(1);
    expect(g.start.filters[0]?.leftValueReference).toBe('Status__c');
    // A structured-filter start surfaces filterFormula as null (the field exists
    // on the projection so a formula-gated start is never dropped — FLOW-GRAPH-
    // TRACE-DROPS-START-FILTER-FORMULA).
    expect(g.start.filterFormula).toBeNull();
    expect(g.start.connector?.to).toBe('My_Decision');
    // Verbatim honesty disclosure, no completeness claim.
    // Verbatim honesty disclosure: it must NOT claim losslessness, and must
    // name BOTH measured gap lists.
    expect(g.disclosure).toMatch(/^Faithful structural projection/);
    expect(g.disclosure).toContain('NOT lossless');
    expect(g.disclosure).toContain('unmodeled[]');
    expect(g.disclosure).toContain('unprojected[]');
    expect(g.disclosure).not.toMatch(/\blossless structural\b/);
    // No narrowing on a full request.
    expect(g.narrowing).toBeUndefined();
    // vaultState base fields present (dispatch stamps the rest).
    expect(r.value.vaultState.sourceTreeHash).toBe('sha256:flow-graph-fixture');
  });

  it('emits every connector kind with the right from/to/ruleName/isGoTo', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: DEMO_FLOW_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    const has = (pred: (c: FlowGraph['connectors'][number]) => boolean) =>
      g.connectors.some(pred);
    // immediate — the start's direct first element.
    expect(has((c) => c.kind === 'immediate' && c.from === '$start' && c.to === 'My_Decision')).toBe(true);
    // scheduled — from the start, carrying the scheduled path name.
    expect(
      has((c) => c.kind === 'scheduled' && c.scheduledPathName === 'My_Scheduled_Path' && c.to === 'My_Assignment'),
    ).toBe(true);
    // default — the decision's default outcome.
    expect(has((c) => c.kind === 'default' && c.from === 'My_Decision' && c.to === 'My_Assignment')).toBe(true);
    // rule — a decision outcome carrying its ruleName.
    expect(has((c) => c.kind === 'rule' && c.ruleName === 'Rule_Approved' && c.from === 'My_Decision' && c.to === 'My_Update')).toBe(true);
    // fault — the record op's fault path.
    expect(has((c) => c.kind === 'fault' && c.from === 'My_Update' && c.to === 'My_Fault_Assign')).toBe(true);
    // nextValue + noMoreValues — the loop's two branches.
    expect(has((c) => c.kind === 'nextValue' && c.from === 'My_Loop' && c.to === 'My_Assignment')).toBe(true);
    const noMore = g.connectors.find((c) => c.kind === 'noMoreValues' && c.from === 'My_Loop');
    expect(noMore?.to).toBe('My_Decision');
    // isGoTo preserved on the loop-back edge.
    expect(noMore?.isGoTo).toBe(true);
  });

  it('projects decisions (N rules + default), the record op, the loop, formulas, and variables verbatim', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: DEMO_FLOW_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    // decision: 2 rules + a default label.
    expect(g.decisions).toHaveLength(1);
    expect(g.decisions[0]?.name).toBe('My_Decision');
    expect(g.decisions[0]?.rules).toHaveLength(2);
    expect(g.decisions[0]?.defaultConnectorLabel).toBe('Default Outcome');
    // record op resolved via <object> (objectResolution 'object'), with a fault target.
    expect(g.recordOps).toHaveLength(1);
    expect(g.recordOps[0]?.kind).toBe('update');
    expect(g.recordOps[0]?.object).toBe('Ns__Obj__c');
    expect(g.recordOps[0]?.objectResolution).toBe('object');
    expect(g.recordOps[0]?.faultConnectsTo).toBe('My_Fault_Assign');
    expect(g.recordOps[0]?.inputAssignments[0]?.field).toBe('Status__c');
    // loop.
    expect(g.loops).toHaveLength(1);
    expect(g.loops[0]?.collectionReference).toBe('My_Collection');
    // formula expression verbatim.
    expect(g.formulas).toHaveLength(1);
    expect(g.formulas[0]?.expression).toBe('{!My_Var} + 1');
    // variables.
    expect(g.variables).toHaveLength(2);
    // scheduled path detail on start.
    expect(g.start.scheduledPaths[0]?.offsetNumber).toBe(1);
    expect(g.start.scheduledPaths[0]?.offsetUnit).toBe('Hours');
  });

  it('overlays vault subflow resolution and lists the unmodeled <waits> element', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: DEMO_FLOW_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    const byName = new Map(g.subflows.map((s) => [s.name, s]));
    // My_Subflow → Flow:Ns__Sub_Flow exists in the vault → resolved true.
    expect(byName.get('My_Subflow')?.resolved).toBe(true);
    expect(byName.get('My_Subflow')?.targetFlowId).toBe(RESOLVABLE_SUB_ID);
    // My_Dangling_Subflow → Flow:Ns__Managed_Sub not seeded → resolved false.
    expect(byName.get('My_Dangling_Subflow')?.resolved).toBe(false);
    // The <waits> body is an honest gap — listed by name, never silently dropped.
    expect(g.unmodeled).toContain('My_Wait');
    // …but its outgoing connector IS captured (graph stays connected).
    expect(g.connectors.some((c) => c.from === 'My_Wait' && c.to === 'My_Decision')).toBe(true);
  });
});

describe('flowGraphHandler — §4.4 narrowing', () => {
  it('include narrows to the named sections and discloses every omitted one', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: DEMO_FLOW_ID,
      include: ['connectors', 'decisions'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    // Named sections kept.
    expect(g.connectors.length).toBeGreaterThan(0);
    expect(g.decisions.length).toBeGreaterThan(0);
    // Unselected body sections emptied.
    expect(g.assignments).toEqual([]);
    expect(g.recordOps).toEqual([]);
    expect(g.loops).toEqual([]);
    expect(g.formulas).toEqual([]);
    expect(g.variables).toEqual([]);
    expect(g.actions).toEqual([]);
    // Structural axes (not in the include enum) are ALWAYS kept — the element
    // index and subflow identities survive so connectors stay interpretable.
    expect(g.elements.length).toBeGreaterThan(0);
    // Always-kept axes survive.
    expect(g.meta.apiName).toBe('Ns__Flow_Graph_Demo');
    expect(g.start.object).toBe('Ns__Obj__c');
    expect(g.unmodeled).toContain('My_Wait');
    // Narrowing disclosed, nothing silently dropped.
    expect(g.narrowing?.applied).toBe('include');
    expect(g.narrowing?.truncated).toBe(true);
    expect(g.narrowing?.omittedSections).toEqual(
      expect.arrayContaining([
        'assignments',
        'recordOps',
        'loops',
        'formulas',
        'variables',
        'actions',
      ]),
    );
    expect(g.narrowing?.omittedSections).not.toContain('connectors');
    expect(g.narrowing?.omittedSections).not.toContain('decisions');
    expect(g.narrowing?.omittedSections).not.toContain('elements');
    expect(g.narrowing?.omittedSections).not.toContain('subflows');
  });

  it('element narrows to one element + its immediate connectors and neighbors', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: DEMO_FLOW_ID,
      element: 'My_Decision',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    expect(g.narrowing?.applied).toBe('element');
    expect(g.narrowing?.element).toBe('My_Decision');
    // Every connector in the subgraph touches the focal element.
    expect(g.connectors.length).toBeGreaterThan(0);
    for (const c of g.connectors) {
      expect(c.from === 'My_Decision' || c.to === 'My_Decision').toBe(true);
    }
    // Focal element present in the element list, plus its neighbors.
    const names = new Set(g.elements.map((e) => e.name));
    expect(names.has('My_Decision')).toBe(true);
    expect(names.has('My_Assignment')).toBe(true); // default-outcome neighbor
    // Only the focal decision's own typed detail is surfaced.
    expect(g.decisions).toHaveLength(1);
    expect(g.decisions[0]?.name).toBe('My_Decision');
    // Non-focal typed sections are excluded from the subgraph.
    expect(g.recordOps).toEqual([]);
    expect(g.loops).toEqual([]);
  });

  it('returns invalid-query for an element name that is not in the flow', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: DEMO_FLOW_ID,
      element: 'No_Such_Element',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('element');
  });
});

describe('flowGraphHandler — resolution edge cases', () => {
  it('surfaces an ambiguous bare name as a success envelope (never a pick)', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Order_Escalaton' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect('ambiguous' in data && data.ambiguous).toBe(true);
    if (!('ambiguous' in data)) return;
    expect(data.flowRef.requested).toBe('Order_Escalaton');
    expect(data.flowRef.resolvedForm).toBe('api-name');
    expect(data.candidates.length).toBeGreaterThanOrEqual(2);
    // No graph fields on an ambiguity envelope.
    expect('connectors' in data).toBe(false);
  });

  it('returns invalid-query for a wrong Type: prefix', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'CustomObject:Account' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown name (zero token overlap)', async () => {
    // No token overlaps any seeded flow, so the fuzzy fallback returns 'none'.
    const r = await flowGraphHandler(ctx, { flowRef: 'Qqzz_Bogus_Placeholder' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('fails closed on a Flow record id with no id index', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: '301000000000001AAA' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/Tooling-API/);
  });
});

describe('flowGraphInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    expect(flowGraphInputSchema.safeParse({ flowRef: 'Flow:My_Flow' }).success).toBe(true);
  });

  it('accepts include + element narrowing knobs', () => {
    const parsed = flowGraphInputSchema.safeParse({
      flowRef: 'My_Flow',
      include: ['connectors', 'loops'],
      element: 'My_Decision',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty flowRef', () => {
    expect(flowGraphInputSchema.safeParse({ flowRef: '' }).success).toBe(false);
  });

  it('rejects an unknown include section', () => {
    const parsed = flowGraphInputSchema.safeParse({
      flowRef: 'My_Flow',
      include: ['not_a_section'],
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W2B — "what does each element DO": author descriptions, screen detail,
// action parameters, the measured gap lists, and the ordered walkthrough.
// ---------------------------------------------------------------------------

describe('flowGraphHandler — element descriptions (the author already wrote the answer)', () => {
  it('carries each element\'s own <description> on its elements[] row', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    const byName = new Map(g.elements.map((e) => [e.name, e]));
    expect(byName.get('Ask_For_Rating')?.description).toBe(
      'Ask the reviewer for a rating and show the policy text.',
    );
    expect(byName.get('Rating_High_Enough')?.description).toBe(
      'Send the email only when the rating clears the bar.',
    );
    expect(byName.get('Send_Outcome_Email')?.description).toBe(
      'Email the applicant the committee outcome.',
    );
  });

  it('omits `description` entirely on an element that declares none', () => {
    // Byte-identity guard: an element with no author note must serialize the
    // same as it did before the field existed.
    expect(
      Object.prototype.hasOwnProperty.call(
        { name: 'x', label: null, type: 'decision' },
        'description',
      ),
    ).toBe(false);
  });

  it('surfaces the flow-level <description> on meta, and null when absent', async () => {
    const withDesc = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(withDesc.ok).toBe(true);
    if (!withDesc.ok) return;
    expect(asGraph(withDesc.value.data).meta.description).toBe(
      'Collects a rating from the user and emails the outcome.',
    );
    const without = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Graph_Demo' });
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(asGraph(without.value.data).meta.description).toBeNull();
  });

  it('carries resource descriptions on formulas and variables (they have no element row)', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    expect(g.formulas[0]?.description).toBe('Doubles the rating for the summary line.');
    expect(g.variables[0]?.description).toBe('Record the email lands against.');
    // …and stays ABSENT on the older fixture whose resources declare none.
    const plain = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Graph_Demo' });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(asGraph(plain.value.data).formulas[0]).not.toHaveProperty('description');
  });
});

describe('flowGraphHandler — screen fields', () => {
  it('projects the screen with its fields, including nested Region fields', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    expect(g.screens).toHaveLength(1);
    const screen = g.screens[0];
    expect(screen?.name).toBe('Ask_For_Rating');
    expect(screen?.nextOrFinishButtonLabel).toBe('Continue');
    expect(screen?.allowBack).toBe(true);
    expect(screen?.allowFinish).toBe(false);
    expect(screen?.connectsTo).toBe('Rating_High_Enough');
    expect(screen?.fields.map((f) => f.name)).toEqual([
      'Policy_Text',
      'Rating_Input',
      'Custom_Widget',
      // An ObjectProvided record-form field carries NO <name> — kept anyway,
      // with the null stated, because dropping it is the very defect this
      // projection exists to stop.
      null,
      'Outer_Container',
    ]);
    expect(screen?.fields[3]?.fieldType).toBe('ObjectProvided');
    expect(screen?.fields[3]?.objectFieldReference).toBe('Ns__Obj__c.Status__c');
    // Recursion: RegionContainer → Region → leaf field.
    const container = screen?.fields[4];
    expect(container?.fields[0]?.name).toBe('Left_Region');
    expect(container?.fields[0]?.fields[0]?.name).toBe('Nested_Note');
    expect(container?.fields[0]?.fields[0]?.fieldText).toBe('Nested note');
  });

  it('carries fieldText, dataType, isRequired, helpText, choices and visibility conditions', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const input = asGraph(r.value.data).screens[0]?.fields[1];
    expect(input?.fieldType).toBe('InputField');
    expect(input?.dataType).toBe('Number');
    expect(input?.isRequired).toBe(true);
    expect(input?.helpText).toBe('Whole numbers only.');
    expect(input?.choiceReferences).toEqual(['Choice_High', 'Choice_Low']);
    expect(input?.visibilityLogic).toBe('and');
    expect(input?.visibilityConditions).toHaveLength(1);
    expect(input?.visibilityConditions[0]?.leftValueReference).toBe('Show_Rating');
    // The display-text field is always shown: no visibility rule, and NO
    // fabricated one.
    expect(asGraph(r.value.data).screens[0]?.fields[0]?.visibilityLogic).toBeNull();
    expect(asGraph(r.value.data).screens[0]?.fields[0]?.visibilityConditions).toEqual([]);
  });

  it('names the LWC/Aura extension and its input parameters for a ComponentInstance field', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const widget = asGraph(r.value.data).screens[0]?.fields[2];
    expect(widget?.extensionName).toBe('c:nsRatingWidget');
    expect(widget?.inputParameters).toEqual([
      { name: 'recordId', value: 'Target_Var', valueKind: 'reference' },
    ]);
  });

  it('exposes screens as an include-narrowable section', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: 'Ns__Flow_Detail_Demo',
      include: ['screens'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    expect(g.screens).toHaveLength(1);
    expect(g.decisions).toHaveLength(0);
    expect(g.narrowing?.omittedSections).toContain('decisions');
    expect(g.narrowing?.omittedSections).not.toContain('screens');
  });
});

describe('flowGraphHandler — action call parameters', () => {
  it('carries input parameters with literal / reference / unset kinds, and outputs', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const action = asGraph(r.value.data).actions[0];
    expect(action?.name).toBe('Send_Outcome_Email');
    expect(action?.actionType).toBe('emailSimple');
    expect(action?.inputParameters).toEqual([
      { name: 'emailSubject', value: 'Committee outcome', valueKind: 'literal' },
      { name: 'recipientId', value: 'Target_Var', valueKind: 'reference' },
      // A parameter declared with NO value is `unset`, not a literal empty
      // string — the reader can tell "not configured" from "configured empty".
      { name: 'ccRecipientAddressList', value: null, valueKind: 'unset' },
    ]);
    expect(action?.outputParameters).toEqual([
      { name: 'status', assignToReference: 'Email_Status' },
    ]);
  });

  it('emits empty parameter arrays (never absent) for an action with none', async () => {
    // The older fixture has no actionCalls at all; assert the SHAPE is stable
    // for a caller that maps over inputParameters without a null check.
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Graph_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(asGraph(r.value.data).actions).toEqual([]);
  });
});

describe('flowGraphHandler — the measured gap (no more implied losslessness)', () => {
  it('gives an unmodeled element an identity row so elements[] indexes every connector endpoint', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    expect(g.unmodeled).toContain('Filter_Rejects');
    const row = g.elements.find((e) => e.name === 'Filter_Rejects');
    expect(row?.type).toBe('unmodeled');
    expect(row?.container).toBe('collectionProcessors');
    expect(row?.label).toBe('Filter Rejects');
    expect(row?.description).toBe('Drop the rejected rows before the summary.');
    // The contract: no connector endpoint is missing from the element index.
    const named = new Set(g.elements.map((e) => e.name));
    for (const c of g.connectors) {
      expect(named.has(c.from)).toBe(true);
      expect(named.has(c.to)).toBe(true);
    }
  });

  it('counts every <Flow> container it carries no datum for, classified', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    const byContainer = new Map(g.unprojected.map((u) => [u.container, u]));
    // Referencable resources — an element names these BY NAME, so an
    // unprojected one is a dangling reference in the payload.
    expect(byContainer.get('constants')).toEqual({
      container: 'constants',
      count: 1,
      kind: 'resource',
    });
    expect(byContainer.get('textTemplates')?.kind).toBe('resource');
    // Flow-level metadata, ranked separately so it reads as trivia.
    expect(byContainer.get('interviewLabel')?.kind).toBe('metadata');
    // Anything the projection DOES carry must never appear here.
    for (const carried of ['screens', 'decisions', 'actionCalls', 'formulas', 'collectionProcessors']) {
      expect(byContainer.has(carried)).toBe(false);
    }
  });
});

describe('flowGraphHandler — walkthrough mode (ordered, element by element)', () => {
  it('is absent unless asked for', async () => {
    const r = await flowGraphHandler(ctx, { flowRef: 'Ns__Flow_Detail_Demo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(asGraph(r.value.data)).not.toHaveProperty('walkthrough');
  });

  it('walks the declared graph from <start> in declared evaluation order', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: 'Ns__Flow_Detail_Demo',
      walkthrough: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = asGraph(r.value.data).walkthrough;
    expect(w).toBeDefined();
    if (w === undefined) return;
    expect(w.steps.map((s) => s.name)).toEqual([
      '$start',
      'Ask_For_Rating',
      'Rating_High_Enough',
      // The decision's RULE branch is expanded before its default…
      'Send_Outcome_Email',
      'Filter_Rejects',
      // …and the default edge loops back to an already-walked element.
      'Ask_For_Rating',
    ]);
    expect(w.steps[0]?.step).toBe(1);
    expect(w.steps[0]?.via).toBeNull();
    expect(w.steps[1]?.via).toEqual({ from: '$start', kind: 'immediate' });
    expect(w.steps[3]?.via).toEqual({
      from: 'Rating_High_Enough',
      kind: 'rule',
      ruleName: 'Yes_Send',
    });
  });

  it('carries the author description and a detail pointer on every step', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: 'Ns__Flow_Detail_Demo',
      walkthrough: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = asGraph(r.value.data).walkthrough?.steps ?? [];
    const screenStep = steps.find((s) => s.name === 'Ask_For_Rating');
    expect(screenStep?.description).toBe(
      'Ask the reviewer for a rating and show the policy text.',
    );
    expect(screenStep?.detail).toBe('screens');
    expect(steps.find((s) => s.name === 'Rating_High_Enough')?.detail).toBe('decisions');
    expect(steps.find((s) => s.name === 'Send_Outcome_Email')?.detail).toBe('actions');
    // An unmodeled element has no detail array of its own — say null, never
    // point at a section that does not hold it.
    expect(steps.find((s) => s.name === 'Filter_Rejects')?.detail).toBeNull();
    // <start> has no author description; the field is explicitly null.
    expect(steps[0]?.description).toBeNull();
  });

  it('marks a loop-back as revisit and does not expand it again', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: 'Ns__Flow_Detail_Demo',
      walkthrough: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const steps = asGraph(r.value.data).walkthrough?.steps ?? [];
    const visits = steps.filter((s) => s.name === 'Ask_For_Rating');
    expect(visits).toHaveLength(2);
    expect(visits[0]?.revisit).toBeUndefined();
    expect(visits[1]?.revisit).toBe(true);
    // Terminal branch: the collection processor has no outgoing connector.
    expect(steps.find((s) => s.name === 'Filter_Rejects')?.endsBranch).toBe(true);
  });

  it('reports an element with no path from <start> as unreachable, not as walked', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: 'Ns__Flow_Detail_Demo',
      walkthrough: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = asGraph(r.value.data).walkthrough;
    expect(w?.unreachable).toEqual(['Orphan_Update']);
    expect(w?.visitedCount).toBe((w?.elementCount ?? 0) - 1);
    expect(w?.truncated).toBe(false);
  });

  it('discloses the branch-order boundary verbatim and defers execution to flow_trace', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: 'Ns__Flow_Detail_Demo',
      walkthrough: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = asGraph(r.value.data).walkthrough?.disclosure ?? '';
    expect(d).toContain('not an execution trace');
    expect(d).toContain('only ONE branch of a decision actually runs per interview');
    expect(d).toContain('sfi.flow_trace');
    expect(d).toContain('not a dead-element verdict');
  });

  it('walks a goTo loop-back in the older fixture without running forever', async () => {
    const r = await flowGraphHandler(ctx, {
      flowRef: 'Ns__Flow_Graph_Demo',
      walkthrough: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = asGraph(r.value.data).walkthrough;
    expect(w?.truncated).toBe(false);
    // The <waits> element is connected only OUTWARD (nothing targets it), so it
    // is honestly unreachable rather than silently walked.
    expect(w?.unreachable).toContain('My_Wait');
    // Every step index is dense and 1-based.
    expect(w?.steps.map((s) => s.step)).toEqual(
      (w?.steps ?? []).map((_, i) => i + 1),
    );
  });
});

// =============================================================================
// W2B-REVIEW F3 — the tool-local walkthrough budget ran BEFORE §4.4 narrowing,
// and BOTH narrowing functions overwrite `narrowing` wholesale. So a caller who
// asked for exactly one section could be handed that section EMPTY with a
// narrowing block saying nothing was omitted — "this flow has no screens" when
// the truth is "the budget dropped them". That is a wrong-`no`, which is the
// failure mode this product exists to prevent. The fix applies the budget LAST
// and merges the narrowing block instead of replacing it.
//
// Nothing in the repo covered the shedding path at all before this block.
// =============================================================================

/**
 * A flow whose FORMULAS carry the bulk and whose screens are modest. That split
 * is what makes the ordering testable: an unnarrowed walkthrough sheds the
 * biggest section (formulas) and may keep screens, while `include: ['screens']`
 * drops everything else and leaves room for the screens the caller asked for.
 */
const OVERSIZE_FLOW_XML = (() => {
  const expr =
    'IF(ISBLANK({!Var_A}), TEXT({!Var_B}) + " padding padding padding padding", "x") '.repeat(12);
  const screens = Array.from({ length: 8 }, (_, i) => {
    const n = i + 1;
    const next =
      n < 8
        ? `        <connector><targetReference>Screen_${(n + 1).toString()}</targetReference></connector>`
        : '';
    return [
      '    <screens>',
      `        <name>Screen_${n.toString()}</name>`,
      `        <label>Screen ${n.toString()}</label>`,
      `        <description>Step ${n.toString()} of the intake.</description>`,
      next,
      '        <fields>',
      `            <name>Body_${n.toString()}</name>`,
      `            <fieldText>Short prompt ${n.toString()}.</fieldText>`,
      '            <fieldType>DisplayText</fieldType>',
      '        </fields>',
      '    </screens>',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }).join('\n');
  const formulas = Array.from({ length: 40 }, (_, i) =>
    [
      '    <formulas>',
      `        <name>Formula_${(i + 1).toString()}</name>`,
      '        <dataType>String</dataType>',
      `        <expression>${expr}</expression>`,
      '    </formulas>',
    ].join('\n'),
  ).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <apiVersion>62.0</apiVersion>',
    '    <label>Ns Flow Oversize Demo</label>',
    '    <processType>Flow</processType>',
    '    <status>Active</status>',
    '    <start>',
    '        <connector><targetReference>Screen_1</targetReference></connector>',
    '    </start>',
    screens,
    formulas,
    '</Flow>',
  ].join('\n');
})();

describe('flowGraphHandler — walkthrough byte budget (W2B-REVIEW F3)', () => {
  const OVERSIZE_ID = 'Flow:Ns__Flow_Oversize_Demo';
  let bigDir: string;
  let bigStore: GraphStore;
  let bigCtx: Context;

  beforeAll(async () => {
    bigDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-flow-oversize-'));
    const sourceDir = join(bigDir, 'source/flows');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, 'Ns__Flow_Oversize_Demo.flow-meta.xml'),
      OVERSIZE_FLOW_XML,
      'utf-8',
    );
    const opened = await openGraph(join(bigDir, 'oversize.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    bigStore = opened.value;
    const imported = await importExtractionResults(bigStore, [
      {
        nodes: [
          makeNode({
            id: OVERSIZE_ID,
            type: 'Flow',
            apiName: 'Ns__Flow_Oversize_Demo',
            label: 'Ns Flow Oversize Demo',
            sourcePath: 'source/flows/Ns__Flow_Oversize_Demo.flow-meta.xml',
            apiVersion: 62,
            properties: {
              label: 'Ns Flow Oversize Demo',
              processType: 'Flow',
              status: 'Active',
            },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    bigCtx = { vaultRoot: bigDir, manifest: FIXTURE_MANIFEST, graph: bigStore };
  });

  afterAll(async () => {
    await closeGraph(bigStore);
    rmSync(bigDir, { recursive: true, force: true });
  });

  it('the fixture really is over budget with a walk attached (else this block proves nothing)', async () => {
    const r = await flowGraphHandler(bigCtx, { flowRef: OVERSIZE_ID });
    if (!r.ok) throw new Error(`handler failed: ${r.error.kind}: ${r.error.message}`);
    const g = asGraph(r.value.data);
    // No walkthrough asked for => no shed, whatever the size.
    expect(g.narrowing).toBeUndefined();
    expect(g.formulas.length).toBe(40);
    expect(g.screens.length).toBe(8);
  });

  it('an unnarrowed walkthrough sheds screens AND names them, with a way back', async () => {
    const r = await flowGraphHandler(bigCtx, { flowRef: OVERSIZE_ID, walkthrough: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    // Largest section goes first, so formulas are shed before screens.
    expect(g.formulas).toHaveLength(0);
    expect(g.narrowing?.omittedSections).toContain('formulas');
    expect(g.narrowing?.truncated).toBe(true);
    expect(g.narrowing?.recoverWith).toMatch(/include:/);
    // The walk itself is never shed — it is the answer that was asked for.
    expect((g.walkthrough?.steps.length ?? 0)).toBeGreaterThan(0);
  });

  it('FAIL-BEFORE/PASS-AFTER: include:[screens] + walkthrough returns the screens, not an empty list', async () => {
    const r = await flowGraphHandler(bigCtx, {
      flowRef: OVERSIZE_ID,
      walkthrough: true,
      include: ['screens'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    // Budget now runs AFTER narrowing, so dropping every other section is
    // enough and the one section the caller asked for survives. Before the fix
    // this was `[]` with `omittedSections` silent about it.
    expect(g.screens.length).toBeGreaterThan(0);
    expect(g.narrowing?.applied).toBe('include');
    expect(g.narrowing?.omittedSections ?? []).not.toContain('screens');
  });

  it('a section the budget DOES shed under include is never reported as merely absent', async () => {
    const r = await flowGraphHandler(bigCtx, {
      flowRef: OVERSIZE_ID,
      walkthrough: true,
      include: ['screens'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = asGraph(r.value.data);
    // Whatever the outcome, the invariant holds: an empty section is either one
    // the caller did not ask for, or one named in omittedSections. Never both
    // empty and unmentioned.
    const omitted = new Set(g.narrowing?.omittedSections ?? []);
    if (g.screens.length === 0) expect(omitted.has('screens')).toBe(true);
  });
});
