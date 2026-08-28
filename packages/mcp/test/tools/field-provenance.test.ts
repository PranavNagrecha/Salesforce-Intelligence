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
  fieldProvenanceHandler,
  fieldProvenanceInputSchema,
} from '../../src/tools/field-provenance.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3, CustomField: 4, ApexClass: 2, Flow: 1 },
  edges: { parentOf: 4, writesTo: 3, references: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Foo__c',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
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
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seeds:
//   Q151 — Opportunity.Customer_Health_Score__c (declared formula)
//   Q152 — Contact.External_Customer_Id__c (integration-synced via Stripe)
//   Q153 — Account.Close_Date__c (Flow writer, manual-and-coded)
//   Q147 — Account.Internal_Notes__c (no writers, manual)
//   Pre-v2.9 — Account.Old_Field__c (no sourceOfTruth populated)
// =============================================================================

const OPP_OBJ = 'CustomObject:Opportunity';
const CONTACT_OBJ = 'CustomObject:Contact';
const ACCOUNT_OBJ = 'CustomObject:Account';

const FORMULA_FIELD = 'CustomField:Opportunity.Customer_Health_Score__c';
const INTEG_FIELD = 'CustomField:Contact.External_Customer_Id__c';
const FLOW_WRITTEN_FIELD = 'CustomField:Account.Close_Date__c';
const MANUAL_FIELD = 'CustomField:Account.Internal_Notes__c';
const PRE_V29_FIELD = 'CustomField:Account.Old_Field__c';

// Census 006 / R1 — writers whose ComponentType is NOT one of the three
// canonical arrays. `writesTo` is emitted by ten extractors, not three.
const WORKFLOW_ONLY_FIELD = 'CustomField:Account.Legacy_Status__c';
const UI_ONLY_FIELD = 'CustomField:Contact.Ui_Touched__c';
const MIXED_FIELD = 'CustomField:Account.Mixed_Field__c';

const LEGACY_WORKFLOW = 'WorkflowRule:Account.Set_Legacy_Status';
const ESCALATION_APPROVAL = 'ApprovalProcess:Contact.Escalate';
const EDITOR_LWC = 'LightningComponentBundle:contactEditor';
const EDITOR_VF_PAGE = 'VisualforcePage:ContactEdit';
const ACCOUNT_TRIGGER = 'ApexTrigger:AccountTrigger';

// A `writesTo` edge whose SOURCE node is not in this vault (managed package /
// outside the retrieve scope). The edge survives import and listEdges returns
// it; only the node lookup comes back null.
const PHANTOM_WRITTEN_FIELD = 'CustomField:Account.Ghost_Written__c';
const PHANTOM_WRITER = 'ApexClass:ManagedPkgWriter';

const STRIPE_INTEGRATION = 'ApexClass:StripeIntegrationService';
const STRIPE_CRED = 'NamedCredential:Stripe';
const PLAIN_APEX = 'ApexClass:RegularUpdater';
const CLOSE_FLOW = 'Flow:Close_Opportunity_Flow';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: OPP_OBJ, type: 'CustomObject', apiName: 'Opportunity' }),
    makeNode({ id: CONTACT_OBJ, type: 'CustomObject', apiName: 'Contact' }),
    makeNode({ id: ACCOUNT_OBJ, type: 'CustomObject', apiName: 'Account' }),
    // Q151: formula field. sourceOfTruth declared:derived.
    makeNode({
      id: FORMULA_FIELD,
      type: 'CustomField',
      apiName: 'Customer_Health_Score__c',
      label: 'Customer Health Score',
      parentId: OPP_OBJ,
      properties: {
        label: 'Customer Health Score',
        type: 'Formula',
        formula: 'Renewal_Probability__c * Engagement_Score__c',
        sourceOfTruth: { value: 'derived', confidence: 'declared' },
        semanticCategory: { value: 'unknown', confidence: 'heuristic' },
      },
    }),
    // Q152: integration-synced field. Single Apex writer that references
    // a NamedCredential.
    makeNode({
      id: INTEG_FIELD,
      type: 'CustomField',
      apiName: 'External_Customer_Id__c',
      label: 'External Customer Id',
      parentId: CONTACT_OBJ,
      properties: {
        label: 'External Customer Id',
        type: 'Text',
        sourceOfTruth: {
          value: 'integration-synced',
          confidence: 'heuristic',
        },
        semanticCategory: { value: 'identifier', confidence: 'heuristic' },
      },
    }),
    // Q153: flow-written field. manual-and-coded classification.
    makeNode({
      id: FLOW_WRITTEN_FIELD,
      type: 'CustomField',
      apiName: 'Close_Date__c',
      label: 'Close Date',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Close Date',
        type: 'Date',
        sourceOfTruth: {
          value: 'manual-and-coded',
          confidence: 'heuristic',
        },
        semanticCategory: { value: 'date', confidence: 'heuristic' },
      },
    }),
    // Q147: no writers, no formula → manual.
    makeNode({
      id: MANUAL_FIELD,
      type: 'CustomField',
      apiName: 'Internal_Notes__c',
      label: 'Internal Notes',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Internal Notes',
        type: 'TextArea',
        sourceOfTruth: { value: 'manual', confidence: 'heuristic' },
        semanticCategory: { value: 'descriptor', confidence: 'heuristic' },
      },
    }),
    // Pre-v2.9: no classification populated.
    makeNode({
      id: PRE_V29_FIELD,
      type: 'CustomField',
      apiName: 'Old_Field__c',
      label: 'Old Field',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Old Field',
        type: 'Text',
      },
    }),
    // Census 006: written ONLY by a WorkflowRule field update. The
    // classifier says 'manual'; the three-array trace says nothing writes
    // it. A workflow writes it on every save.
    makeNode({
      id: WORKFLOW_ONLY_FIELD,
      type: 'CustomField',
      apiName: 'Legacy_Status__c',
      label: 'Legacy Status',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Legacy Status',
        type: 'Picklist',
        sourceOfTruth: { value: 'manual', confidence: 'heuristic' },
      },
    }),
    // Census 006: written ONLY by UI + approval writers (three distinct
    // non-canonical ComponentTypes).
    makeNode({
      id: UI_ONLY_FIELD,
      type: 'CustomField',
      apiName: 'Ui_Touched__c',
      label: 'Ui Touched',
      parentId: CONTACT_OBJ,
      properties: {
        label: 'Ui Touched',
        type: 'Text',
        sourceOfTruth: { value: 'manual', confidence: 'heuristic' },
      },
    }),
    // Census 006: a canonical writer AND a non-canonical one, so the
    // sentinel cannot be a mere fallback for the all-empty case.
    makeNode({
      id: MIXED_FIELD,
      type: 'CustomField',
      apiName: 'Mixed_Field__c',
      label: 'Mixed Field',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Mixed Field',
        type: 'Text',
        sourceOfTruth: { value: 'manual-and-coded', confidence: 'heuristic' },
      },
    }),
    makeNode({
      id: LEGACY_WORKFLOW,
      type: 'WorkflowRule',
      apiName: 'Account.Set_Legacy_Status',
    }),
    makeNode({
      id: ESCALATION_APPROVAL,
      type: 'ApprovalProcess',
      apiName: 'Contact.Escalate',
    }),
    makeNode({
      id: EDITOR_LWC,
      type: 'LightningComponentBundle',
      apiName: 'contactEditor',
    }),
    makeNode({
      id: EDITOR_VF_PAGE,
      type: 'VisualforcePage',
      apiName: 'ContactEdit',
    }),
    makeNode({
      id: ACCOUNT_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
    }),
    // Written only by a writer this vault does not hold a node for.
    makeNode({
      id: PHANTOM_WRITTEN_FIELD,
      type: 'CustomField',
      apiName: 'Ghost_Written__c',
      label: 'Ghost Written',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Ghost Written',
        type: 'Text',
        sourceOfTruth: { value: 'manual', confidence: 'heuristic' },
      },
    }),
    // Apex writers.
    makeNode({
      id: STRIPE_INTEGRATION,
      type: 'ApexClass',
      apiName: 'StripeIntegrationService',
    }),
    makeNode({
      id: STRIPE_CRED,
      type: 'NamedCredential',
      apiName: 'Stripe',
    }),
    makeNode({
      id: PLAIN_APEX,
      type: 'ApexClass',
      apiName: 'RegularUpdater',
    }),
    // Flow writer.
    makeNode({
      id: CLOSE_FLOW,
      type: 'Flow',
      apiName: 'Close_Opportunity_Flow',
    }),
  ],
  edges: [
    // Stripe writes to the integration field, AND references the
    // NamedCredential (v2.0a integration tagging).
    makeEdge({
      fromId: STRIPE_INTEGRATION,
      toId: INTEG_FIELD,
      edgeType: 'writesTo',
      confidence: 'heuristic',
    }),
    makeEdge({
      fromId: STRIPE_INTEGRATION,
      toId: STRIPE_CRED,
      edgeType: 'references',
      confidence: 'declared',
    }),
    // RegularUpdater writes to the integration field too — but it has
    // NO references edge. This proves isIntegrationTagged is per-writer.
    makeEdge({
      fromId: PLAIN_APEX,
      toId: INTEG_FIELD,
      edgeType: 'writesTo',
      confidence: 'heuristic',
    }),
    // Flow writes to the Close_Date field.
    makeEdge({
      fromId: CLOSE_FLOW,
      toId: FLOW_WRITTEN_FIELD,
      edgeType: 'writesTo',
      confidence: 'declared',
    }),
    // Census 006 — declared-confidence writesTo edges from the seven
    // extractors the three-array partition drops on the floor.
    makeEdge({
      fromId: LEGACY_WORKFLOW,
      toId: WORKFLOW_ONLY_FIELD,
      edgeType: 'writesTo',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: EDITOR_LWC,
      toId: UI_ONLY_FIELD,
      edgeType: 'writesTo',
      confidence: 'heuristic',
    }),
    makeEdge({
      fromId: EDITOR_VF_PAGE,
      toId: UI_ONLY_FIELD,
      edgeType: 'writesTo',
      confidence: 'heuristic',
    }),
    makeEdge({
      fromId: ESCALATION_APPROVAL,
      toId: UI_ONLY_FIELD,
      edgeType: 'writesTo',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: ACCOUNT_TRIGGER,
      toId: MIXED_FIELD,
      edgeType: 'writesTo',
      confidence: 'parsed',
    }),
    makeEdge({
      fromId: LEGACY_WORKFLOW,
      toId: MIXED_FIELD,
      edgeType: 'writesTo',
      confidence: 'declared',
    }),
    // NOTE: `PHANTOM_WRITER` is deliberately NOT a seeded node.
    makeEdge({
      fromId: PHANTOM_WRITER,
      toId: PHANTOM_WRITTEN_FIELD,
      edgeType: 'writesTo',
      confidence: 'declared',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-provenance-'));
  const dbPath = join(tempDir, 'provenance.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
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

describe('fieldProvenanceInputSchema', () => {
  it('accepts a valid fieldId', () => {
    const r = fieldProvenanceInputSchema.safeParse({ fieldId: MANUAL_FIELD });
    expect(r.success).toBe(true);
  });

  it('rejects an empty fieldId', () => {
    const r = fieldProvenanceInputSchema.safeParse({ fieldId: '' });
    expect(r.success).toBe(false);
  });
});

describe('fieldProvenanceHandler', () => {
  it('returns invalid-query for non-CustomField prefix', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: 'ApexClass:Foo',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for unknown ids', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: 'CustomField:Account.Nope__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('Q151: declared formula — surfaces declaredAsFormula trace, noWritersDetected: false', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: FORMULA_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.classification).toEqual({
      value: 'derived',
      confidence: 'declared',
    });
    expect(data.trace.declaredAsFormula).toEqual({
      formula: 'Renewal_Probability__c * Engagement_Score__c',
    });
    expect(data.trace.declaredAsAutoNumber).toBeNull();
    expect(data.trace.apexWriters).toEqual([]);
    expect(data.trace.flowWriters).toEqual([]);
    expect(data.trace.triggerWriters).toEqual([]);
    // Formula IS the source — not noWritersDetected.
    expect(data.trace.noWritersDetected).toBe(false);
    // Declared confidence → heuristic boundary not surfaced.
    expect(
      data.boundaries.some((b) => b.includes('writes-fabric inference')),
    ).toBe(false);
  });

  it('Q152: integration-synced — surfaces apexWriters with isIntegrationTagged per-writer', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: INTEG_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.classification).toEqual({
      value: 'integration-synced',
      confidence: 'heuristic',
    });
    // Two apex writers; Stripe is tagged, RegularUpdater is not.
    expect(data.trace.apexWriters.length).toBe(2);
    const stripe = data.trace.apexWriters.find(
      (w) => w.componentId === STRIPE_INTEGRATION,
    );
    expect(stripe).toBeDefined();
    expect(stripe!.isIntegrationTagged).toBe(true);
    const plain = data.trace.apexWriters.find(
      (w) => w.componentId === PLAIN_APEX,
    );
    expect(plain).toBeDefined();
    expect(plain!.isIntegrationTagged).toBe(false);
    // Heuristic confidence → boundary surfaces.
    expect(
      data.boundaries.some((b) => b.includes('writes-fabric inference')),
    ).toBe(true);
  });

  it('Q153: Flow writer — surfaces flowWriters and manual-and-coded classification', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: FLOW_WRITTEN_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.classification).toEqual({
      value: 'manual-and-coded',
      confidence: 'heuristic',
    });
    expect(data.trace.flowWriters).toEqual([
      { componentId: CLOSE_FLOW, apiName: 'Close_Opportunity_Flow' },
    ]);
    expect(data.trace.apexWriters).toEqual([]);
    expect(data.trace.triggerWriters).toEqual([]);
    expect(data.trace.noWritersDetected).toBe(false);
  });

  it('Q147: manual — empty trace, noWritersDetected: true', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: MANUAL_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.classification).toEqual({
      value: 'manual',
      confidence: 'heuristic',
    });
    expect(data.trace.declaredAsFormula).toBeNull();
    expect(data.trace.declaredAsAutoNumber).toBeNull();
    expect(data.trace.apexWriters).toEqual([]);
    expect(data.trace.flowWriters).toEqual([]);
    expect(data.trace.triggerWriters).toEqual([]);
    expect(data.trace.noWritersDetected).toBe(true);
  });

  it('surfaces classification-missing boundary on pre-v2.9 fields', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: PRE_V29_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.classification).toEqual({
      value: 'unknown',
      confidence: 'heuristic',
    });
    expect(
      result.value.data.boundaries.some((b) =>
        b.includes('classifier has not run'),
      ),
    ).toBe(true);
  });

  it('always surfaces the writes-invisible boundary', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: MANUAL_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.data.boundaries.some((b) =>
        b.includes('Dynamic SOQL'),
      ),
    ).toBe(true);
  });

  // ===========================================================================
  // Census 006 / R1 — `writesTo` is emitted by TEN extractors. The three-array
  // partition dropped the other seven ON THE FLOOR, and `noWritersDetected`
  // was decided by three array lengths over an edge list that held more.
  // ===========================================================================

  it('R1: a field written ONLY by a WorkflowRule field update is not noWritersDetected', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: WORKFLOW_ONLY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trace = result.value.data.trace;
    // The three canonical arrays are legitimately empty here.
    expect(trace.apexWriters).toEqual([]);
    expect(trace.flowWriters).toEqual([]);
    expect(trace.triggerWriters).toEqual([]);
    // ...but a declared `writesTo` edge exists, so "nothing writes this
    // field" is a false answer about a field a workflow writes on every save.
    expect(trace.noWritersDetected).toBe(false);
    expect(trace.otherWriterCount).toBe(1);
    expect(trace.otherWriters.map((w) => w.componentId)).toEqual([
      LEGACY_WORKFLOW,
    ]);
    expect(trace.otherWriterTypes).toEqual(['WorkflowRule']);
  });

  it('R1: the un-partitioned writer types are named in boundaries, not left silent', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: WORKFLOW_ONLY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.boundaries;
    // BOUNDARY_WRITES_INVISIBLE covers dynamic SOQL / reflection / managed
    // packages — none of which is a declared WorkflowRule field update.
    const named = boundaries.filter((b) => b.includes('WorkflowRule'));
    expect(named.length).toBe(1);
    expect(named[0]).toContain(LEGACY_WORKFLOW);
    expect(named[0]).toContain('otherWriters');
  });

  it('R1: LWC / Visualforce / ApprovalProcess writers all survive the partition', async () => {
    const result = await fieldProvenanceHandler(ctx, { fieldId: UI_ONLY_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trace = result.value.data.trace;
    expect(trace.noWritersDetected).toBe(false);
    expect(trace.otherWriterCount).toBe(3);
    expect(trace.otherWriterTypes).toEqual([
      'ApprovalProcess',
      'LightningComponentBundle',
      'VisualforcePage',
    ]);
    expect(trace.otherWriters.map((w) => w.componentId)).toEqual([
      ESCALATION_APPROVAL,
      EDITOR_LWC,
      EDITOR_VF_PAGE,
    ]);
    // Per-writer confidence is carried, not flattened.
    const approval = trace.otherWriters.find(
      (w) => w.componentId === ESCALATION_APPROVAL,
    );
    expect(approval?.confidence).toBe('declared');
    const lwc = trace.otherWriters.find((w) => w.componentId === EDITOR_LWC);
    expect(lwc?.confidence).toBe('heuristic');
  });

  it('R1: the sentinel is not a fallback — it counts alongside a canonical writer', async () => {
    const result = await fieldProvenanceHandler(ctx, { fieldId: MIXED_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trace = result.value.data.trace;
    expect(trace.triggerWriters).toEqual([
      { componentId: ACCOUNT_TRIGGER, apiName: 'AccountTrigger' },
    ]);
    expect(trace.otherWriterCount).toBe(1);
    expect(trace.otherWriterTypes).toEqual(['WorkflowRule']);
    expect(trace.noWritersDetected).toBe(false);
  });

  it('R1 control: a genuinely unwritten field still reports zero and no extra boundary', async () => {
    // The other half of the ratchet — the fix must not flip every field to
    // "something writes it". Q147 has no writesTo edge at all.
    const result = await fieldProvenanceHandler(ctx, { fieldId: MANUAL_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.trace.otherWriterCount).toBe(0);
    expect(data.trace.otherWriters).toEqual([]);
    expect(data.trace.otherWriterTypes).toEqual([]);
    expect(data.trace.noWritersDetected).toBe(true);
    expect(data.boundaries.some((b) => b.includes('otherWriters'))).toBe(false);
  });

  it('R1 (not in the brief): a writer whose node is absent is counted, not dropped', async () => {
    // The edge survives import and `listEdges` returns it — only the node
    // lookup returns null. Dropping it silently made `noWritersDetected`
    // report "nothing writes this field" over an edge that says otherwise.
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: PHANTOM_WRITTEN_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.trace.apexWriters).toEqual([]);
    expect(data.trace.flowWriters).toEqual([]);
    expect(data.trace.triggerWriters).toEqual([]);
    expect(data.trace.otherWriters).toEqual([]);
    expect(data.trace.unresolvedWriterCount).toBe(1);
    expect(data.trace.noWritersDetected).toBe(false);
    const named = data.boundaries.filter((b) =>
      b.includes('unresolvedWriterCount'),
    );
    expect(named.length).toBe(1);
    expect(named[0]).toContain(PHANTOM_WRITER);
  });

  it('R1 control: a field with no writesTo edge reports unresolvedWriterCount 0', async () => {
    const result = await fieldProvenanceHandler(ctx, { fieldId: MANUAL_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.trace.unresolvedWriterCount).toBe(0);
    expect(
      result.value.data.boundaries.some((b) =>
        b.includes('unresolvedWriterCount'),
      ),
    ).toBe(false);
  });

  it('vaultState carries the manifest hash', async () => {
    const result = await fieldProvenanceHandler(ctx, {
      fieldId: MANUAL_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });
});
