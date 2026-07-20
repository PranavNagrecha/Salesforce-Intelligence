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
import { recordCreationPathsHandler } from '../../src/tools/record-creation-paths.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, Flow: 1, ApexTrigger: 1 },
  edges: { writesTo: 1, triggersOn: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Widget__c',
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

const WIDGET = 'CustomObject:Widget__c';
const CREATOR_FLOW = 'Flow:Create_Widget';
const WIDGET_TRIGGER = 'ApexTrigger:WidgetTrigger';
// Hub-shaped second object: multiple creators + triggers to exercise the
// P15 handler cap + truncation disclosure.
const GADGET = 'CustomObject:Gadget__c';
const GADGET_FLOW_A = 'Flow:Create_Gadget_A';
const GADGET_FLOW_B = 'Flow:Create_Gadget_B';
const GADGET_TRIGGER_A = 'ApexTrigger:GadgetTriggerA';
const GADGET_TRIGGER_B = 'ApexTrigger:GadgetTriggerB';
// Sprocket__c: mixes ACTIVE and INACTIVE creators + triggers so the active-status
// filter (RECORD-CREATION-PATHS-CITES-OBSOLETE-TRIGGERS) can be exercised.
const SPROCKET = 'CustomObject:Sprocket__c';
const SPROCKET_CREATOR_ACTIVE = 'Flow:Create_Sprocket_Active';
const SPROCKET_CREATOR_OBSOLETE = 'Flow:Create_Sprocket_Obsolete';
const SPROCKET_FLOW_TRIGGER_ACTIVE = 'Flow:Sprocket_Save_Flow_Active';
const SPROCKET_FLOW_TRIGGER_OBSOLETE = 'Flow:Sprocket_Email_Flow_Obsolete';
const SPROCKET_APEX_TRIGGER_INACTIVE = 'ApexTrigger:SprocketTriggerInactive';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: WIDGET, type: 'CustomObject', apiName: 'Widget__c' }),
    makeNode({ id: CREATOR_FLOW, type: 'Flow', apiName: 'Create_Widget' }),
    makeNode({ id: WIDGET_TRIGGER, type: 'ApexTrigger', apiName: 'WidgetTrigger' }),
    makeNode({ id: GADGET, type: 'CustomObject', apiName: 'Gadget__c' }),
    makeNode({ id: GADGET_FLOW_A, type: 'Flow', apiName: 'Create_Gadget_A' }),
    makeNode({ id: GADGET_FLOW_B, type: 'Flow', apiName: 'Create_Gadget_B' }),
    makeNode({ id: GADGET_TRIGGER_A, type: 'ApexTrigger', apiName: 'GadgetTriggerA' }),
    makeNode({ id: GADGET_TRIGGER_B, type: 'ApexTrigger', apiName: 'GadgetTriggerB' }),
    makeNode({ id: SPROCKET, type: 'CustomObject', apiName: 'Sprocket__c' }),
    makeNode({
      id: SPROCKET_CREATOR_ACTIVE,
      type: 'Flow',
      apiName: 'Create_Sprocket_Active',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: SPROCKET_CREATOR_OBSOLETE,
      type: 'Flow',
      apiName: 'Create_Sprocket_Obsolete',
      properties: { status: 'Obsolete' },
    }),
    makeNode({
      id: SPROCKET_FLOW_TRIGGER_ACTIVE,
      type: 'Flow',
      apiName: 'Sprocket_Save_Flow_Active',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: SPROCKET_FLOW_TRIGGER_OBSOLETE,
      type: 'Flow',
      apiName: 'Sprocket_Email_Flow_Obsolete',
      properties: { status: 'Obsolete' },
    }),
    makeNode({
      id: SPROCKET_APEX_TRIGGER_INACTIVE,
      type: 'ApexTrigger',
      apiName: 'SprocketTriggerInactive',
      properties: { status: 'Inactive' },
    }),
  ],
  edges: [
    // A Flow that inserts Widget__c records (the only modeled creator class).
    makeEdge({
      fromId: CREATOR_FLOW,
      toId: WIDGET,
      edgeType: 'writesTo',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    // A trigger that fires on save.
    makeEdge({ fromId: WIDGET_TRIGGER, toId: WIDGET, edgeType: 'triggersOn' }),
    // Gadget__c: two creators + two triggers.
    makeEdge({
      fromId: GADGET_FLOW_A,
      toId: GADGET,
      edgeType: 'writesTo',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    makeEdge({
      fromId: GADGET_FLOW_B,
      toId: GADGET,
      edgeType: 'writesTo',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    makeEdge({ fromId: GADGET_TRIGGER_A, toId: GADGET, edgeType: 'triggersOn' }),
    makeEdge({ fromId: GADGET_TRIGGER_B, toId: GADGET, edgeType: 'triggersOn' }),
    // Sprocket__c: one active + one obsolete creator; one active flow trigger,
    // one obsolete flow trigger, one inactive apex trigger.
    makeEdge({
      fromId: SPROCKET_CREATOR_ACTIVE,
      toId: SPROCKET,
      edgeType: 'writesTo',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    makeEdge({
      fromId: SPROCKET_CREATOR_OBSOLETE,
      toId: SPROCKET,
      edgeType: 'writesTo',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    makeEdge({ fromId: SPROCKET_FLOW_TRIGGER_ACTIVE, toId: SPROCKET, edgeType: 'triggersOn' }),
    makeEdge({ fromId: SPROCKET_FLOW_TRIGGER_OBSOLETE, toId: SPROCKET, edgeType: 'triggersOn' }),
    makeEdge({ fromId: SPROCKET_APEX_TRIGGER_INACTIVE, toId: SPROCKET, edgeType: 'triggersOn' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-rcp-'));
  const opened = await openGraph(join(tempDir, 'rcp.db'));
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

describe('recordCreationPathsHandler', () => {
  it('lists the Flow creator and the trigger', async () => {
    const r = await recordCreationPathsHandler(ctx, { objectApiName: 'Widget__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.creatorCount).toBe(1);
    expect(r.value.data.creators[0]?.sourceId).toBe(CREATOR_FLOW);
    expect(r.value.data.triggerCount).toBe(1);
  });

  it('qualifies the count as Flow creators and discloses that Apex inserts are unmodeled', async () => {
    // The creator detection only sees Flow recordCreates. Apex `insert x;`
    // (static) and Database.insert (dynamic) are NOT modeled — so an object
    // created only by Apex (e.g. real acme Marketo_Log__c, inserted by
    // MRK_LoggerHelper) reports 0 creators. The framing must say "Flow"
    // (not bare "automation") and the disclosure must flag the Apex gap so
    // "0 creators" isn't read as "nothing creates this".
    const r = await recordCreationPathsHandler(ctx, { objectApiName: 'Widget__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rendered).toMatch(/Flow automation/);
    expect(r.value.data.rendered).toMatch(/Apex/);
    expect(r.value.data.rendered).toMatch(/insert/i);
  });

  // P15 oversize-enumeration guard (0.2.0 gate): the handler cap must DISCLOSE
  // truncation — full counts stay honest, cut lists carry explicit flags, and
  // the rendered text tells the caller how to see the tail.
  it('FAIL-BEFORE/PASS-AFTER: limit caps both lists with explicit truncation disclosure', async () => {
    const r = await recordCreationPathsHandler(ctx, {
      objectApiName: 'Gadget__c',
      limit: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Full counts survive the cap.
    expect(r.value.data.creatorCount).toBe(2);
    expect(r.value.data.triggerCount).toBe(2);
    // Lists are capped and the cut is flagged, never silent.
    expect(r.value.data.creators).toHaveLength(1);
    expect(r.value.data.creatorsTruncated).toBe(true);
    expect(r.value.data.triggers).toHaveLength(1);
    expect(r.value.data.triggersTruncated).toBe(true);
    expect(r.value.data.rendered).toMatch(/truncated to 1 of 2/i);
    expect(r.value.data.rendered).toMatch(/raise `limit`/i);
  });

  it('does not claim truncation when the lists fit within limit', async () => {
    const r = await recordCreationPathsHandler(ctx, { objectApiName: 'Widget__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.creatorsTruncated).toBe(false);
    expect(r.value.data.triggersTruncated).toBe(false);
    expect(r.value.data.rendered).not.toMatch(/truncated/i);
  });

  // RECORD-CREATION-PATHS-CITES-OBSOLETE-TRIGGERS (P1 honesty). A creation path
  // is a RUNTIME path, so a Draft/Obsolete Flow or an Inactive ApexTrigger must
  // NOT be listed among the live creators/triggers — it is segregated into
  // `inactiveCreators`/`inactiveTriggers` with its reason. FAIL-BEFORE: the old
  // handler mapped every `triggersOn` / recordCreate `writesTo` edge into the
  // main lists with no active-status filter.
  it('FAIL-BEFORE/PASS-AFTER: excludes obsolete/inactive creators and triggers, segregating them', async () => {
    const r = await recordCreationPathsHandler(ctx, { objectApiName: 'Sprocket__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    // Only the ACTIVE creator/trigger survive in the live lists.
    expect(d.creators.map((c) => c.sourceId)).toEqual([SPROCKET_CREATOR_ACTIVE]);
    expect(d.creatorCount).toBe(1);
    expect(d.triggers.map((t) => t.sourceId)).toEqual([SPROCKET_FLOW_TRIGGER_ACTIVE]);
    expect(d.triggerCount).toBe(1);

    // The inactive firers are segregated (not dropped), with their reason.
    expect(d.inactiveCreators?.map((i) => i.componentId)).toEqual([
      SPROCKET_CREATOR_OBSOLETE,
    ]);
    expect(d.inactiveCreators?.[0]?.inactiveReason).toMatch(/Obsolete/);
    expect(d.inactiveTriggers?.map((i) => i.componentId)).toEqual([
      SPROCKET_APEX_TRIGGER_INACTIVE,
      SPROCKET_FLOW_TRIGGER_OBSOLETE,
    ]);

    // The obsolete/inactive firers never appear in the live lists.
    const liveIds = [...d.creators, ...d.triggers].map((s) => s.sourceId);
    expect(liveIds).not.toContain(SPROCKET_CREATOR_OBSOLETE);
    expect(liveIds).not.toContain(SPROCKET_FLOW_TRIGGER_OBSOLETE);
    expect(liveIds).not.toContain(SPROCKET_APEX_TRIGGER_INACTIVE);

    // Rendered text discloses the exclusion.
    expect(d.rendered).toMatch(/Excluded as inactive/i);
    expect(d.rendered).toMatch(/Sprocket_Email_Flow_Obsolete/);
  });

  it('omits inactive disclosure keys when every creator/trigger is active', async () => {
    const r = await recordCreationPathsHandler(ctx, { objectApiName: 'Widget__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.inactiveCreators).toBeUndefined();
    expect(r.value.data.inactiveTriggers).toBeUndefined();
    expect(r.value.data.rendered).not.toMatch(/Excluded as inactive/i);
  });
});
