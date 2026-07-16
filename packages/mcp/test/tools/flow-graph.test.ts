/// <reference types="vitest/globals" />

/**
 * Unit tests for the `sfi.flow_graph` MCP tool (spec §4.5 DoD).
 *
 * A real DuckDB fixture graph (mirroring `explain-flow.test.ts`) seeds a Flow
 * node whose `sourcePath` points at a synthetic `.flow-meta.xml` written to the
 * temp vault dir, so the on-demand `readFile(join(vaultRoot, sourcePath))` in
 * the handler resolves. Every name is SYNTHETIC — zero org identifiers.
 *
 * Coverage: the full lossless graph (every connector kind, a loop's two
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

describe('flowGraphHandler — full lossless projection', () => {
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
    expect(g.start.connector?.to).toBe('My_Decision');
    // Verbatim honesty disclosure, no completeness claim.
    expect(g.disclosure).toMatch(/^Faithful lossless structural projection/);
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

  it('projects decisions (N rules + default), the record op, the loop, formulas, and variables losslessly', async () => {
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
