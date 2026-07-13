/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import { extractFlow } from '@sf-intelligence/extractors';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { FIELD_360_Q165_DISCLOSURE } from '../../src/tools/field-360.js';
import {
  FIELD_LINEAGE_DATA_NOT_AVAILABLE,
  fieldLineageHandler,
  fieldLineageInputSchema,
} from '../../src/tools/field-lineage.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '3.0.0',
  refreshedAt: '2026-05-28T12:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:field-lineage-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'Default',
  label: null,
  parentId: null,
  sourcePath: 'fixture.xml',
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
  source: 'fixture',
  properties: {},
  ...overrides,
});

// Upstream chain per PLAN-v3.0 §7 Q162:
//
//   Account.Customer_Segment__c  (target)
//     <- LeadConverter.cls writes it
//        <- LeadConverter reads Lead.Lead_Score__c
//           <- LeadScoreCalculator.cls writes Lead.Lead_Score__c
//              <- LeadScoreCalculator reads Lead.LastModifiedDate
//                 (Lead.LastModifiedDate is v2.9 source-of-truth — terminal)
//
// We model this by writesTo chains: a writer A whose writer chain
// includes a CustomField B at depth 2 must produce a `writesTo` edge
// from A to itself's target B for the walk to find. The simplest
// shape that exercises depth-3 + source-of-truth termination is two
// CustomField hops backed by writesTo edges.
const TARGET = 'CustomField:Account.Customer_Segment__c';
const upstreamSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TARGET,
      type: 'CustomField',
      apiName: 'Customer_Segment__c',
      parentId: 'CustomObject:Account',
    }),
    makeNode({
      id: 'CustomField:Lead.Lead_Score__c',
      type: 'CustomField',
      apiName: 'Lead_Score__c',
    }),
    makeNode({
      id: 'CustomField:Lead.LastModifiedDate',
      type: 'CustomField',
      apiName: 'LastModifiedDate',
      // The v2.9 source-of-truth marker terminates the upstream walk.
      properties: { isSourceOfTruth: true },
    }),
    makeNode({
      id: 'ApexClass:LeadConverter',
      type: 'ApexClass',
      apiName: 'LeadConverter',
    }),
    // A formula field and its source, to exercise formula-source upstream
    // provenance (an OUTGOING `references` edge, not an incoming writesTo).
    makeNode({
      id: 'CustomField:Account.Earnings__c',
      type: 'CustomField',
      apiName: 'Earnings__c',
      parentId: 'CustomObject:Account',
    }),
    makeNode({
      id: 'CustomField:Account.Base_Amount__c',
      type: 'CustomField',
      apiName: 'Base_Amount__c',
      parentId: 'CustomObject:Account',
    }),
  ],
  edges: [
    // Apex writes the target — depth 1.
    makeEdge({
      fromId: 'ApexClass:LeadConverter',
      toId: TARGET,
      edgeType: 'writesTo',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
    // Lead.Lead_Score__c also writes the target (depth 1 - parallel).
    makeEdge({
      fromId: 'CustomField:Lead.Lead_Score__c',
      toId: TARGET,
      edgeType: 'writesTo',
      confidence: 'parsed',
      source: 'formula-tokenizer',
    }),
    // Lead.LastModifiedDate writes Lead.Lead_Score__c (depth 2;
    // source-of-truth field — terminal).
    makeEdge({
      fromId: 'CustomField:Lead.LastModifiedDate',
      toId: 'CustomField:Lead.Lead_Score__c',
      edgeType: 'writesTo',
      confidence: 'declared',
      source: 'formula-tokenizer',
    }),
    // Earnings__c is a FORMULA computed from Base_Amount__c — an OUTGOING
    // `references` edge. Earnings__c upstream must surface Base_Amount__c as
    // a formula-source; Base_Amount__c downstream surfaces Earnings__c as a
    // formula-recompute (the cross-direction mirror that was inconsistent).
    makeEdge({
      fromId: 'CustomField:Account.Earnings__c',
      toId: 'CustomField:Account.Base_Amount__c',
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
    }),
  ],
};

// Downstream chain per PLAN-v3.0 §7 Q163:
//
//   Lead.Lead_Score__c  (target)
//     -> ApexClass:LeadConverter.shouldConvert() — if-clause (firesWhen)
//     -> Flow:Lead_Routing_Flow — decision-branch (firesWhen)
//     -> WorkflowRule:Lead.NotifyOwner — workflow-fire (references)
//     -> OutboundMessage:Lead.MarketoSync — integration-outbound
//
// Each consumer carries an incoming edge into the target.
const downstreamTarget = 'CustomField:Lead.Lead_Score__c';
const downstreamSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: downstreamTarget,
      type: 'CustomField',
      apiName: 'Lead_Score__c',
    }),
    makeNode({
      id: 'ConditionalContext:Flow:Lead_Routing_Flow.condition-0',
      type: 'ConditionalContext',
      apiName: 'Lead_Routing_Flow.condition-0',
    }),
    makeNode({
      id: 'Flow:Lead_Routing_Flow',
      type: 'Flow',
      apiName: 'Lead_Routing_Flow',
    }),
    makeNode({
      id: 'WorkflowRule:Lead.NotifyOwner',
      type: 'WorkflowRule',
      apiName: 'Lead.NotifyOwner',
    }),
    makeNode({
      id: 'OutboundMessage:Lead.MarketoSync',
      type: 'OutboundMessage',
      apiName: 'Lead.MarketoSync',
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'ConditionalContext:Flow:Lead_Routing_Flow.condition-0',
      toId: downstreamTarget,
      edgeType: 'firesWhen',
      confidence: 'parsed',
      source: 'flow-extractor',
      properties: { expression: 'Lead_Score__c > 50' },
    }),
    makeEdge({
      fromId: 'WorkflowRule:Lead.NotifyOwner',
      toId: downstreamTarget,
      edgeType: 'references',
      confidence: 'declared',
      source: 'workflow-rule-extractor',
    }),
    makeEdge({
      fromId: 'OutboundMessage:Lead.MarketoSync',
      toId: downstreamTarget,
      edgeType: 'references',
      confidence: 'declared',
      source: 'workflow-rule-extractor',
    }),
  ],
};

let upstreamDir: string;
let upstreamStore: GraphStore;
let upstreamCtx: Context;

let downstreamDir: string;
let downstreamStore: GraphStore;
let downstreamCtx: Context;

beforeAll(async () => {
  upstreamDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-lineage-up-'));
  let opened = await openGraph(join(upstreamDir, 'up.db'));
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error('openGraph upstream failed');
  upstreamStore = opened.value;
  const imp = await importExtractionResults(upstreamStore, [upstreamSeed]);
  expect(imp.ok).toBe(true);
  if (!imp.ok) throw new Error('import upstream failed');
  upstreamCtx = {
    vaultRoot: upstreamDir,
    manifest: FIXTURE_MANIFEST,
    graph: upstreamStore,
  };

  downstreamDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-lineage-down-'));
  opened = await openGraph(join(downstreamDir, 'down.db'));
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error('openGraph downstream failed');
  downstreamStore = opened.value;
  const imp2 = await importExtractionResults(downstreamStore, [downstreamSeed]);
  expect(imp2.ok).toBe(true);
  if (!imp2.ok) throw new Error('import downstream failed');
  downstreamCtx = {
    vaultRoot: downstreamDir,
    manifest: FIXTURE_MANIFEST,
    graph: downstreamStore,
  };
});

afterAll(async () => {
  await closeGraph(upstreamStore);
  await closeGraph(downstreamStore);
  rmSync(upstreamDir, { recursive: true, force: true });
  rmSync(downstreamDir, { recursive: true, force: true });
});

describe('fieldLineageHandler upstream (Q162)', () => {
  it('walks upstream writers and terminates at source-of-truth fields', async () => {
    const result = await fieldLineageHandler(upstreamCtx, {
      fieldId: TARGET,
      direction: 'upstream',
      maxDepth: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.upstream).toBeDefined();
    if (out.upstream === undefined) return;
    // Depth-1 writers: ApexClass:LeadConverter and CustomField:Lead.Lead_Score__c.
    const depth1 = out.upstream.sources.filter((s) => s.depth === 1);
    expect(depth1.length).toBe(2);
    const ids = depth1.map((s) => s.sourceId);
    expect(ids).toContain('ApexClass:LeadConverter');
    expect(ids).toContain('CustomField:Lead.Lead_Score__c');
    // Depth-2: Lead.LastModifiedDate (source-of-truth).
    const depth2 = out.upstream.sources.filter((s) => s.depth === 2);
    const sotEntry = depth2.find(
      (s) => s.sourceId === 'CustomField:Lead.LastModifiedDate',
    );
    expect(sotEntry).toBeDefined();
    if (!sotEntry) return;
    expect(sotEntry.sourceKind).toBe('source-of-truth-field');
    expect(sotEntry.isSourceOfTruth).toBe(true);
    expect(out.upstream.sourceOfTruthCount).toBe(1);
  });

  it('surfaces formula-source upstream and stays consistent with downstream', async () => {
    // Earnings__c is a formula computed from Base_Amount__c. Upstream of the
    // formula must surface Base_Amount__c as a formula-source — previously []
    // because the walk only followed incoming writesTo, never the formula's
    // OUTGOING references edge.
    const up = await fieldLineageHandler(upstreamCtx, {
      fieldId: 'CustomField:Account.Earnings__c',
      direction: 'upstream',
    });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    const base = (up.value.data.upstream?.sources ?? []).find(
      (s) => s.sourceId === 'CustomField:Account.Base_Amount__c',
    );
    expect(base).toBeDefined();
    expect(base?.sourceKind).toBe('formula-source');

    // Cross-direction mirror: Base_Amount__c downstream lists Earnings__c as a
    // formula-recompute. The two directions must agree about the relationship.
    const down = await fieldLineageHandler(upstreamCtx, {
      fieldId: 'CustomField:Account.Base_Amount__c',
      direction: 'downstream',
    });
    expect(down.ok).toBe(true);
    if (!down.ok) return;
    const earnings = (down.value.data.downstream?.effects ?? []).find(
      (e) => e.effectId === 'CustomField:Account.Earnings__c',
    );
    expect(earnings).toBeDefined();
    expect(earnings?.effectKind).toBe('formula-recompute');
  });

  it('records reachableVia paths for depth>1 sources', async () => {
    const result = await fieldLineageHandler(upstreamCtx, {
      fieldId: TARGET,
      direction: 'upstream',
      maxDepth: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    if (out.upstream === undefined) return;
    const depth2 = out.upstream.sources.find((s) => s.depth === 2);
    expect(depth2).toBeDefined();
    if (!depth2) return;
    // The reachableVia chain records the intermediate hops between the
    // root and the depth-2 source.
    expect(depth2.reachableVia.length).toBeGreaterThanOrEqual(1);
  });

  it('truncates at maxDepth and reports truncatedAtDepth', async () => {
    const result = await fieldLineageHandler(upstreamCtx, {
      fieldId: TARGET,
      direction: 'upstream',
      maxDepth: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    if (out.upstream === undefined) return;
    // depth-1 sources should still surface; depth-2 should NOT.
    expect(out.upstream.sources.every((s) => s.depth === 1)).toBe(true);
    expect(out.upstream.truncatedAtDepth).toBe(1);
  });
});

describe('fieldLineageHandler downstream (Q163)', () => {
  it('walks downstream effects across kinds with firesWhen literals', async () => {
    const result = await fieldLineageHandler(downstreamCtx, {
      fieldId: downstreamTarget,
      direction: 'downstream',
      maxDepth: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.downstream).toBeDefined();
    if (out.downstream === undefined) return;
    const kinds = out.downstream.effects.map((e) => e.effectKind);
    // The fixture surfaces flow-decision-branch (firesWhen),
    // workflow-fire (references from WorkflowRule), and
    // integration-outbound (OutboundMessage). The walk MUST surface
    // each kind verbatim.
    expect(kinds).toContain('flow-decision-branch');
    expect(kinds).toContain('workflow-fire');
    expect(kinds).toContain('integration-outbound');
    // The firesWhen string is preserved for the flow-decision-branch
    // effect — the renderer surfaces the literal condition for review.
    const decision = out.downstream.effects.find(
      (e) => e.effectKind === 'flow-decision-branch',
    );
    expect(decision).toBeDefined();
    if (!decision) return;
    expect(decision.firesWhen).toBe('Lead_Score__c > 50');
  });

  it('honors includeFiresWhen: false to suppress conditional walks', async () => {
    const result = await fieldLineageHandler(downstreamCtx, {
      fieldId: downstreamTarget,
      direction: 'downstream',
      maxDepth: 2,
      includeFiresWhen: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    if (out.downstream === undefined) return;
    // When firesWhen is disabled, flow-decision-branch effects derived
    // from the firesWhen edge type vanish; workflow-fire (references
    // from WorkflowRule) remains.
    const kinds = out.downstream.effects.map((e) => e.effectKind);
    expect(kinds).not.toContain('flow-decision-branch');
    expect(kinds).toContain('workflow-fire');
  });
});

describe('fieldLineageHandler honesty axis', () => {
  it('surfaces the verbatim Q165 disclosure on every response', async () => {
    const result = await fieldLineageHandler(upstreamCtx, {
      fieldId: TARGET,
      direction: 'upstream',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.boundaries).toContain(
      FIELD_360_Q165_DISCLOSURE,
    );
    // CR-CAP-03: the default upstream fixture has no Report/Dashboard coverage
    // (status 'unknown' -> not-retrieved) and TARGET has no folded usage, so the
    // dynamic dataNotAvailable equals the full not-retrieved baseline.
    expect(result.value.data.dataNotAvailable).toEqual(
      FIELD_LINEAGE_DATA_NOT_AVAILABLE,
    );
    expect(result.value.data.dataNotAvailable).toEqual([
      'list-view-filters',
      'reports',
      'dashboards',
    ]);
  });

  it('returns invalid-query for non-CustomField ids', async () => {
    const result = await fieldLineageHandler(upstreamCtx, {
      fieldId: 'Flow:NotAField',
      direction: 'upstream',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for unknown CustomField ids', async () => {
    const result = await fieldLineageHandler(upstreamCtx, {
      fieldId: 'CustomField:Account.NoSuchField__c',
      direction: 'upstream',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });
});

describe('fieldLineageHandler — CR-CAP-03 coverage-aware analytics (field_360 parity)', () => {
  // A manifest proving Report/Dashboard WERE retrieved (coverage 'complete').
  const COVERAGE_COMPLETE_MANIFEST: VaultManifest = {
    ...FIXTURE_MANIFEST,
    components: { Report: 5, Dashboard: 2 },
    coverage: [
      { type: 'Report', requested: true, retrieved: 5, errored: false, neverModeled: false },
      { type: 'Dashboard', requested: true, retrieved: 2, errored: false, neverModeled: false },
    ],
  };

  let capDir: string;
  let capStore: GraphStore;
  const FOLDED_FIELD = 'CustomField:Account.Report_Used__c';

  beforeAll(async () => {
    capDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fl-cap-'));
    const opened = await openGraph(join(capDir, 'cap.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    capStore = opened.value;
    const imp = await importExtractionResults(capStore, [
      {
        nodes: [
          makeNode({
            id: FOLDED_FIELD,
            type: 'CustomField',
            apiName: 'Report_Used__c',
            parentId: 'CustomObject:Account',
            // Folded reports-pull usage (the fold DROPS the report node + edge).
            properties: { usedInReport: true },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
  });

  afterAll(async () => {
    await closeGraph(capStore);
    rmSync(capDir, { recursive: true, force: true });
  });

  it('retrieved-empty manifest drops reports/dashboards + states confirmed not-used', async () => {
    // FAIL-BEFORE: field_lineage hard-coded the static
    // ['list-view-filters','reports','dashboards']. With Report/Dashboard
    // retrieved (coverage 'complete') and TARGET having no folded usage, those
    // families are AVAILABLE (confirmed-absent) and must drop out.
    const completeCtx: Context = {
      ...upstreamCtx,
      manifest: COVERAGE_COMPLETE_MANIFEST,
    };
    const result = await fieldLineageHandler(completeCtx, {
      fieldId: TARGET,
      direction: 'upstream',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.dataNotAvailable).not.toContain('reports');
    expect(out.dataNotAvailable).not.toContain('dashboards');
    expect(out.dataNotAvailable).toContain('list-view-filters');
    expect(
      out.boundaries.some(
        (b) =>
          b.includes('WERE retrieved') && b.includes('none reference this field'),
      ),
    ).toBe(true);
  });

  it('not-retrieved manifest keeps reports/dashboards + the caveat (sibling guard)', async () => {
    // PASS-AFTER guard: default fixture manifest -> coverage 'unknown'. The
    // families stay listed and the REPORT_DASHBOARD_USAGE_CAVEAT is present.
    const result = await fieldLineageHandler(upstreamCtx, {
      fieldId: TARGET,
      direction: 'upstream',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(out.dataNotAvailable).toContain('reports');
    expect(out.dataNotAvailable).toContain('dashboards');
    // The not-retrieved caveat (distinctive 'outside that cap' text) is present.
    expect(out.boundaries.some((b) => b.includes('outside that cap'))).toBe(true);
  });

  it('surfaces a positive report-usage boundary for a folded-used field (parity)', async () => {
    // FAIL-BEFORE: field_lineage read the report/dashboard fold NOWHERE, so a
    // folded-used field got the generic not-retrieved caveat. After the fix it
    // surfaces the positive in-use boundary AND drops reports from
    // dataNotAvailable (the data IS available — provably used).
    const capCtx: Context = {
      vaultRoot: capDir,
      manifest: FIXTURE_MANIFEST,
      graph: capStore,
    };
    const result = await fieldLineageHandler(capCtx, {
      fieldId: FOLDED_FIELD,
      direction: 'both',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.data;
    expect(
      out.boundaries.some(
        (b) => b.includes('IS referenced') && b.includes('report column/filter'),
      ),
    ).toBe(true);
    expect(out.dataNotAvailable).not.toContain('reports');
    // Dashboard usage not folded + not retrieved -> stays listed.
    expect(out.dataNotAvailable).toContain('dashboards');
  });
});

describe('fieldLineageInputSchema', () => {
  it('rejects an unknown direction', () => {
    const parsed = fieldLineageInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      direction: 'sideways',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects maxDepth above the hard cap', () => {
    const parsed = fieldLineageInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      direction: 'upstream',
      maxDepth: 6,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a minimal well-formed input', () => {
    const parsed = fieldLineageInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      direction: 'both',
    });
    expect(parsed.success).toBe(true);
  });

  it('defaults direction to both when omitted (TSB-12)', () => {
    const parsed = fieldLineageInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.direction).toBe('both');
  });
});

describe('fieldLineageHandler: cross-object formula chain depth (P4-formula-chains)', () => {
  let dir2: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-fl-formula-'));
    const opened = await openGraph(join(dir2, 'fl.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    const fld = (id: string, parent: string): Node =>
      makeNode({ id, type: 'CustomField', apiName: id.split('.').pop() ?? id, parentId: parent });
    const ref = (from: string, to: string): Edge =>
      makeEdge({ fromId: from, toId: to, edgeType: 'references', confidence: 'parsed', source: 'formula-tokenizer' });
    // Chain: Opportunity.Total__c (formula) -> Account.Earnings__c (formula, OTHER
    // object) -> Account.Base_Amount__c. Upstream from Total__c is a 2-hop,
    // cross-object formula-reference cascade.
    const seed2: ExtractionResult = {
      nodes: [
        fld('CustomField:Opportunity.Total__c', 'CustomObject:Opportunity'),
        fld('CustomField:Account.Earnings__c', 'CustomObject:Account'),
        fld('CustomField:Account.Base_Amount__c', 'CustomObject:Account'),
      ],
      edges: [
        ref('CustomField:Opportunity.Total__c', 'CustomField:Account.Earnings__c'),
        ref('CustomField:Account.Earnings__c', 'CustomField:Account.Base_Amount__c'),
      ],
    };
    const imp = await importExtractionResults(store2, [seed2]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx2 = { vaultRoot: dir2, manifest: FIXTURE_MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('reports formulaChain depth >= 2 and crossesObject for a chained cross-object formula', async () => {
    const r = await fieldLineageHandler(ctx2, {
      fieldId: 'CustomField:Opportunity.Total__c',
      direction: 'upstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fc = r.value.data.upstream?.formulaChain;
    expect(fc?.maxDepth).toBeGreaterThanOrEqual(2);
    expect(fc?.crossesObject).toBe(true);
  });

  it('a single-hop same-object formula reports depth 1 and crossesObject false', async () => {
    const r = await fieldLineageHandler(ctx2, {
      fieldId: 'CustomField:Account.Earnings__c',
      direction: 'upstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fc = r.value.data.upstream?.formulaChain;
    expect(fc?.maxDepth).toBe(1);
    expect(fc?.crossesObject).toBe(false);
  });
});

describe('fieldLineageHandler — flow field-level dataflow (R6-11)', () => {
  // End-to-end across TWO flows, driven by the REAL extractor (not
  // hand-built edges): FlowA writes F1 from F2; FlowB writes F2 from F3.
  // Upstream lineage of F1 must reach F3 through both flows, with the
  // flows' INPUT fields surfaced as walkable hops.
  const F1 = 'CustomField:Ledger__c.Amount_Mirror__c';
  const F2 = 'CustomField:Invoice__c.Amount_Copy__c';
  const F3 = 'CustomField:Order__c.Amount__c';

  const FLOW_A_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Mirror Invoice Amount</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <recordUpdates>
    <name>Update_Ledger</name>
    <label>Update Ledger</label>
    <object>Ledger__c</object>
    <inputAssignments>
      <field>Amount_Mirror__c</field>
      <value><elementReference>$Record.Amount_Copy__c</elementReference></value>
    </inputAssignments>
  </recordUpdates>
  <start>
    <object>Invoice__c</object>
    <recordTriggerType>CreateAndUpdate</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
</Flow>`;

  const FLOW_B_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Copy Order Amount</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <recordUpdates>
    <name>Update_Invoice</name>
    <label>Update Invoice</label>
    <object>Invoice__c</object>
    <inputAssignments>
      <field>Amount_Copy__c</field>
      <value><elementReference>$Record.Amount__c</elementReference></value>
    </inputAssignments>
  </recordUpdates>
  <start>
    <object>Order__c</object>
    <recordTriggerType>CreateAndUpdate</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
</Flow>`;

  let dir3: string;
  let store3: GraphStore;
  let ctx3: Context;

  beforeAll(async () => {
    dir3 = mkdtempSync(join(tmpdir(), 'sfi-mcp-fl-flowdata-'));
    const flowDir = join(dir3, 'flows');
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'Mirror_Invoice_Amount.flow-meta.xml'), FLOW_A_XML);
    writeFileSync(join(flowDir, 'Copy_Order_Amount.flow-meta.xml'), FLOW_B_XML);
    const resA = await extractFlow(join(flowDir, 'Mirror_Invoice_Amount.flow-meta.xml'));
    const resB = await extractFlow(join(flowDir, 'Copy_Order_Amount.flow-meta.xml'));
    if (!resA.ok || !resB.ok) throw new Error('extractFlow fixture failed');

    const fieldSeed: ExtractionResult = {
      nodes: [
        makeNode({ id: F1, type: 'CustomField', apiName: 'Amount_Mirror__c', parentId: 'CustomObject:Ledger__c' }),
        makeNode({ id: F2, type: 'CustomField', apiName: 'Amount_Copy__c', parentId: 'CustomObject:Invoice__c' }),
        makeNode({ id: F3, type: 'CustomField', apiName: 'Amount__c', parentId: 'CustomObject:Order__c' }),
        // An extra flow writer whose inputs could NOT be traced — proves the
        // walk DISCLOSES rather than guesses.
        makeNode({ id: 'Flow:Opaque_Enricher', type: 'Flow', apiName: 'Opaque_Enricher' }),
        makeNode({ id: 'CustomField:Order__c.Enriched__c', type: 'CustomField', apiName: 'Enriched__c', parentId: 'CustomObject:Order__c' }),
        // A flow writer whose edge predates the dataflow tracer entirely
        // (pre-R2-1 vault shape: bare `operation`, no assignedValue at all —
        // verified live against a production-scale gate vault). Its inputs
        // are UNKNOWN, which must be disclosed as untraced, not read as
        // "zero inputs".
        makeNode({ id: 'Flow:Legacy_Vault_Writer', type: 'Flow', apiName: 'Legacy_Vault_Writer' }),
        makeNode({ id: 'CustomField:Order__c.Legacy__c', type: 'CustomField', apiName: 'Legacy__c', parentId: 'CustomObject:Order__c' }),
      ],
      edges: [
        makeEdge({
          fromId: 'Flow:Opaque_Enricher',
          toId: 'CustomField:Order__c.Enriched__c',
          edgeType: 'writesTo',
          confidence: 'parsed',
          source: 'flow-extractor',
          properties: {
            operation: 'recordUpdate',
            assignedValue: 'Score_It.result',
            assignedValueKind: 'reference',
            sourceFields: [],
            sourceFieldConfidence: [],
            unresolvedSourceCount: 2,
          },
        }),
        makeEdge({
          fromId: 'Flow:Legacy_Vault_Writer',
          toId: 'CustomField:Order__c.Legacy__c',
          edgeType: 'writesTo',
          confidence: 'parsed',
          source: 'flow-extractor',
          properties: { operation: 'recordUpdate' },
        }),
      ],
    };
    const opened = await openGraph(join(dir3, 'fl.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store3 = opened.value;
    const imp = await importExtractionResults(store3, [resA.value, resB.value, fieldSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx3 = { vaultRoot: dir3, manifest: FIXTURE_MANIFEST, graph: store3 };
  });

  afterAll(async () => {
    await closeGraph(store3);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('upstream lineage of F1 reaches F3 across TWO flows with per-hop confidence', async () => {
    const r = await fieldLineageHandler(ctx3, {
      fieldId: F1,
      direction: 'upstream',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sources = r.value.data.upstream?.sources ?? [];
    const byId = (id: string) => sources.find((s) => s.sourceId === id);

    const flowA = byId('Flow:Mirror_Invoice_Amount');
    expect(flowA?.sourceKind).toBe('flow-assignment');
    expect(flowA?.depth).toBe(1);

    // FlowA's traced INPUT field is the next upstream hop — previously the
    // walk dead-ended at the flow node (no incoming writesTo on a Flow).
    const f2 = byId(F2);
    expect(f2?.sourceKind).toBe('flow-input-field');
    expect(f2?.depth).toBe(2);
    expect(f2?.confidence).toBe('declared');

    const flowB = byId('Flow:Copy_Order_Amount');
    expect(flowB?.sourceKind).toBe('flow-assignment');
    expect(flowB?.depth).toBe(3);

    const f3 = byId(F3);
    expect(f3?.sourceKind).toBe('flow-input-field');
    expect(f3?.depth).toBe(4);
    expect(f3?.confidence).toBe('declared');

    const fd = r.value.data.upstream?.flowDataflow;
    expect(fd?.inputFieldsTraced).toBe(2);
    expect(fd?.unresolvedInputCount).toBe(0);
  });

  it('downstream lineage of F3 crosses both flows via flow-field-write effects', async () => {
    const r = await fieldLineageHandler(ctx3, {
      fieldId: F3,
      direction: 'downstream',
      maxDepth: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const effects = r.value.data.downstream?.effects ?? [];

    const flowB = effects.find((e) => e.effectId === 'Flow:Copy_Order_Amount');
    expect(flowB?.effectKind).toBe('flow-field-write');
    expect(flowB?.depth).toBe(1);
    expect(flowB?.targetFields).toEqual(['Invoice__c.Amount_Copy__c']);

    // The walk continues INTO the written field: F2's own dataflow consumer
    // (FlowA) surfaces at depth 2.
    const flowA = effects.find((e) => e.effectId === 'Flow:Mirror_Invoice_Amount');
    expect(flowA?.effectKind).toBe('flow-field-write');
    expect(flowA?.depth).toBe(2);
    expect(flowA?.targetFields).toEqual(['Ledger__c.Amount_Mirror__c']);
  });

  it('discloses unresolved flow inputs as a count, never guesses', async () => {
    const r = await fieldLineageHandler(ctx3, {
      fieldId: 'CustomField:Order__c.Enriched__c',
      direction: 'upstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sources = r.value.data.upstream?.sources ?? [];
    // The flow writer itself is surfaced...
    expect(sources.some((s) => s.sourceId === 'Flow:Opaque_Enricher')).toBe(true);
    // ...but NO fabricated input fields.
    expect(sources.some((s) => s.sourceKind === 'flow-input-field')).toBe(false);
    const fd = r.value.data.upstream?.flowDataflow;
    expect(fd?.inputFieldsTraced).toBe(0);
    expect(fd?.unresolvedInputCount).toBe(2);
    expect(
      r.value.data.boundaries.some((b) => b.includes('could not be statically traced')),
    ).toBe(true);
  });

  it('discloses a pre-tracer vault edge as untraced instead of "zero inputs"', async () => {
    // The edge carries ONLY `operation` (pre-R2-1 vault shape — no
    // assignedValue, no trace). Its inputs are unknown: the walk must count
    // it as untraced and nudge a re-refresh, never read the absence of
    // trace data as "the flow has no inputs".
    const r = await fieldLineageHandler(ctx3, {
      fieldId: 'CustomField:Order__c.Legacy__c',
      direction: 'upstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sources = r.value.data.upstream?.sources ?? [];
    expect(sources.some((s) => s.sourceId === 'Flow:Legacy_Vault_Writer')).toBe(true);
    expect(sources.some((s) => s.sourceKind === 'flow-input-field')).toBe(false);
    const fd = r.value.data.upstream?.flowDataflow;
    expect(fd?.untracedFlowWriteEdges).toBe(1);
    expect(
      r.value.data.boundaries.some((b) => b.includes('predate the dataflow tracer')),
    ).toBe(true);
  });
});

describe('fieldLineageHandler — R7-W2 before-save $Record field write', () => {
  // A RecordBeforeSave flow assigns $Record.Combined_Name__c = {!$Record.Given_Part__c}
  // via an <assignments> element (no DML). Driven by the REAL extractor: the
  // before-save field write must be a first-class writer in field_lineage, and
  // its traced input field must be a walkable upstream hop.
  const WROTE = 'CustomField:Widget__c.Combined_Name__c';
  const SRC = 'CustomField:Widget__c.Given_Part__c';

  const FLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Copy Widget Name</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <start>
    <object>Widget__c</object>
    <recordTriggerType>CreateAndUpdate</recordTriggerType>
    <triggerType>RecordBeforeSave</triggerType>
  </start>
  <assignments>
    <name>Copy_Name</name>
    <label>Copy Name</label>
    <assignmentItems>
      <assignToReference>$Record.Combined_Name__c</assignToReference>
      <operator>Assign</operator>
      <value><elementReference>$Record.Given_Part__c</elementReference></value>
    </assignmentItems>
  </assignments>
</Flow>`;

  let dir4: string;
  let store4: GraphStore;
  let ctx4: Context;

  beforeAll(async () => {
    dir4 = mkdtempSync(join(tmpdir(), 'sfi-mcp-fl-w2-'));
    const flowDir = join(dir4, 'flows');
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'Copy_Widget_Name.flow-meta.xml'), FLOW_XML);
    const res = await extractFlow(join(flowDir, 'Copy_Widget_Name.flow-meta.xml'));
    if (!res.ok) throw new Error('extractFlow fixture failed');

    const fieldSeed: ExtractionResult = {
      nodes: [
        makeNode({ id: WROTE, type: 'CustomField', apiName: 'Combined_Name__c', parentId: 'CustomObject:Widget__c' }),
        makeNode({ id: SRC, type: 'CustomField', apiName: 'Given_Part__c', parentId: 'CustomObject:Widget__c' }),
      ],
      edges: [],
    };
    const opened = await openGraph(join(dir4, 'fl.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store4 = opened.value;
    const imp = await importExtractionResults(store4, [res.value, fieldSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx4 = { vaultRoot: dir4, manifest: FIXTURE_MANIFEST, graph: store4 };
  });

  afterAll(async () => {
    await closeGraph(store4);
    rmSync(dir4, { recursive: true, force: true });
  });

  it('surfaces the before-save flow as an upstream writer and traces its $Record input field', async () => {
    const r = await fieldLineageHandler(ctx4, {
      fieldId: WROTE,
      direction: 'upstream',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sources = r.value.data.upstream?.sources ?? [];
    const flow = sources.find((s) => s.sourceId === 'Flow:Copy_Widget_Name');
    expect(flow?.sourceKind).toBe('flow-assignment');
    expect(flow?.depth).toBe(1);
    // The traced $Record.Given_Part__c input is a walkable hop (declared).
    const src = sources.find((s) => s.sourceId === SRC);
    expect(src?.sourceKind).toBe('flow-input-field');
    expect(src?.depth).toBe(2);
    expect(src?.confidence).toBe('declared');
    const fd = r.value.data.upstream?.flowDataflow;
    expect(fd?.inputFieldsTraced).toBe(1);
    expect(fd?.unresolvedInputCount).toBe(0);
    expect(fd?.untracedFlowWriteEdges).toBe(0);
  });

  it('surfaces the write as a downstream flow-field-write effect on the source field', async () => {
    const r = await fieldLineageHandler(ctx4, {
      fieldId: SRC,
      direction: 'downstream',
      maxDepth: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const effects = r.value.data.downstream?.effects ?? [];
    const flow = effects.find((e) => e.effectId === 'Flow:Copy_Widget_Name');
    expect(flow?.effectKind).toBe('flow-field-write');
    expect(flow?.targetFields).toEqual(['Widget__c.Combined_Name__c']);
  });
});
