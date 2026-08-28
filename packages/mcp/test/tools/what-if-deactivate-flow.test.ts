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
  whatIfDeactivateFlowHandler,
  whatIfDeactivateFlowInputSchema,
} from '../../src/tools/what-if-deactivate-flow.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    CustomField: 1,
    Flow: 2,
    ApexClass: 1,
    EmailTemplate: 1,
    ConditionalContext: 1,
  },
  edges: {
    triggersOn: 2,
    callsApex: 1,
    writesTo: 1,
    readsFrom: 1,
    sendsEmail: 1,
    firesWhen: 1,
  },
  sourceTreeHash: 'sha256:fixture',
  coverageComputedAt: '2026-05-29T12:00:00.000Z',
  coverage: ['Flow', 'ApexClass', 'CustomObject', 'EmailTemplate'].map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
  })),
};

/** Default node-shape helper. Caller overrides id/type/apiName/etc. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
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
  confidence: 'parsed',
  source: 'flow-extractor',
  properties: {},
  ...overrides,
});

// =============================================================================
// Suite 1: rich-impact Flow. The Flow has every outgoing edge type the
// composer recognises — triggersOn to an SObject, callsApex to a class,
// writesTo + readsFrom to fields, sendsEmail to a template, plus a
// firesWhen ConditionalContext gating the trigger. Verifies that every
// edge surfaces as an impact (or as the firingConditions list for
// firesWhen) and that the aggregate verdict is `blocking`.
// =============================================================================

const FLOW_RICH_ID = 'Flow:AccountNotify';
const ACCOUNT_OBJ = 'CustomObject:Account';
const APEX_CLS = 'ApexClass:NotificationService';
const FIELD_INDUSTRY = 'CustomField:Account.Industry__c';
const FIELD_REVENUE = 'CustomField:Account.AnnualRevenue';
const EMAIL_TPL = 'EmailTemplate:WelcomeEmail';
const COND_CTX = 'ConditionalContext:Flow:AccountNotify.condition-1';

const richSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_RICH_ID,
      type: 'Flow',
      apiName: 'AccountNotify',
      properties: { status: 'Active', triggerType: 'RecordAfterSave' },
    }),
    makeNode({
      id: ACCOUNT_OBJ,
      type: 'CustomObject',
      apiName: 'Account',
    }),
    makeNode({
      id: APEX_CLS,
      type: 'ApexClass',
      apiName: 'NotificationService',
    }),
    makeNode({
      id: FIELD_INDUSTRY,
      type: 'CustomField',
      apiName: 'Industry__c',
    }),
    makeNode({
      id: FIELD_REVENUE,
      type: 'CustomField',
      apiName: 'AnnualRevenue',
    }),
    makeNode({
      id: EMAIL_TPL,
      type: 'EmailTemplate',
      apiName: 'WelcomeEmail',
    }),
    makeNode({
      id: COND_CTX,
      type: 'ConditionalContext',
      apiName: 'Flow:AccountNotify.condition-1',
      properties: {
        expression: "Industry__c == 'Tech'",
        kind: 'flow-recordtrigger',
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: ACCOUNT_OBJ,
      edgeType: 'triggersOn',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: APEX_CLS,
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: FIELD_INDUSTRY,
      edgeType: 'readsFrom',
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: FIELD_REVENUE,
      edgeType: 'writesTo',
      properties: { operation: 'recordUpdate' },
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: EMAIL_TPL,
      edgeType: 'sendsEmail',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: COND_CTX,
      edgeType: 'firesWhen',
      confidence: 'declared',
    }),
  ],
};

// =============================================================================
// Suite 2: bare Flow. No outgoing edges except triggersOn. Surfaces the
// callsApex-only `risky` verdict path when only callsApex is present.
// =============================================================================

const FLOW_BARE_ID = 'Flow:AccountBareCall';
const APEX_BARE = 'ApexClass:UtilService';

const bareSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_BARE_ID,
      type: 'Flow',
      apiName: 'AccountBareCall',
      properties: { status: 'Draft' },
    }),
    makeNode({
      id: APEX_BARE,
      type: 'ApexClass',
      apiName: 'UtilService',
    }),
  ],
  edges: [
    makeEdge({
      fromId: FLOW_BARE_ID,
      toId: APEX_BARE,
      edgeType: 'callsApex',
    }),
  ],
};

// =============================================================================
// Suite 3: empty Flow — exists but has no outgoing edges. Surfaces the
// `safe` verdict path.
// =============================================================================

const FLOW_EMPTY_ID = 'Flow:EmptyFlow';

const emptySeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_EMPTY_ID,
      type: 'Flow',
      apiName: 'EmptyFlow',
      properties: { status: 'Active' },
    }),
  ],
  edges: [],
};

// =============================================================================
// Suite 4 (bug 15): platform-event publish → subscribe. A publisher flow
// writes the event; a subscriber flow listens to it. Deactivating the
// publisher must surface the subscriber (one hop past the event object).
// =============================================================================

const FLOW_PUBLISHER_ID = 'Flow:EventPublisher';
const EVENT_OBJ = 'CustomObject:Order_Event__e';
const FLOW_SUBSCRIBER_ID = 'Flow:EventSubscriber';

const platformEventSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_PUBLISHER_ID,
      type: 'Flow',
      apiName: 'EventPublisher',
      properties: { status: 'Active' },
    }),
    makeNode({ id: EVENT_OBJ, type: 'CustomObject', apiName: 'Order_Event__e' }),
    makeNode({
      id: FLOW_SUBSCRIBER_ID,
      type: 'Flow',
      apiName: 'EventSubscriber',
      properties: { status: 'Active' },
    }),
  ],
  edges: [
    makeEdge({ fromId: FLOW_PUBLISHER_ID, toId: EVENT_OBJ, edgeType: 'writesTo' }),
    makeEdge({ fromId: FLOW_SUBSCRIBER_ID, toId: EVENT_OBJ, edgeType: 'listensTo' }),
  ],
};

// =============================================================================
// Suite 5 (R6-02): subflow broken callers. A subflow with NO outgoing edges
// would read `safe` to deactivate — the false-"safe" the R6 audit flagged. With
// incoming `references` (referenceKind: 'subflow') edges from parent flows, the
// parents are BROKEN CALLERS on deactivation. An ACTIVE parent flips the verdict
// to `blocking`; an inactive-only parent set surfaces the callers but stops at
// `risky`. A non-subflow incoming `references` (e.g. a FlexiPage embedding the
// flow) is NOT a broken caller — only referenceKind 'subflow' counts.
// =============================================================================

const SUBFLOW_ACTIVE_PARENTS_ID = 'Flow:SharedSubflow';
const PARENT_ACTIVE_1_ID = 'Flow:ParentActiveA';
const PARENT_ACTIVE_2_ID = 'Flow:ParentActiveB';
const FLEXIPAGE_EMBED_ID = 'FlexiPage:HomePage';

const subflowActiveParentsSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: SUBFLOW_ACTIVE_PARENTS_ID,
      type: 'Flow',
      apiName: 'SharedSubflow',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: PARENT_ACTIVE_1_ID,
      type: 'Flow',
      apiName: 'ParentActiveA',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: PARENT_ACTIVE_2_ID,
      type: 'Flow',
      apiName: 'ParentActiveB',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: FLEXIPAGE_EMBED_ID,
      type: 'FlexiPage',
      apiName: 'HomePage',
      properties: {},
    }),
  ],
  edges: [
    makeEdge({
      fromId: PARENT_ACTIVE_1_ID,
      toId: SUBFLOW_ACTIVE_PARENTS_ID,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'subflow', subflowElementName: 'Call_A' },
    }),
    makeEdge({
      fromId: PARENT_ACTIVE_2_ID,
      toId: SUBFLOW_ACTIVE_PARENTS_ID,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'subflow', subflowElementName: 'Call_B' },
    }),
    // A FlexiPage that embeds the flow — an incoming `references` with a
    // NON-subflow referenceKind. Must NOT be counted as a broken caller.
    makeEdge({
      fromId: FLEXIPAGE_EMBED_ID,
      toId: SUBFLOW_ACTIVE_PARENTS_ID,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'flexiPageComponent' },
    }),
  ],
};

const SUBFLOW_OBSOLETE_PARENT_ID = 'Flow:SubflowObsoleteOnly';
const PARENT_OBSOLETE_ID = 'Flow:ParentObsolete';

const subflowObsoleteParentSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: SUBFLOW_OBSOLETE_PARENT_ID,
      type: 'Flow',
      apiName: 'SubflowObsoleteOnly',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: PARENT_OBSOLETE_ID,
      type: 'Flow',
      apiName: 'ParentObsolete',
      properties: { status: 'Obsolete' },
    }),
  ],
  edges: [
    makeEdge({
      fromId: PARENT_OBSOLETE_ID,
      toId: SUBFLOW_OBSOLETE_PARENT_ID,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'subflow', subflowElementName: 'Call_Old' },
    }),
  ],
};


// =============================================================================
// Suite 6 (FIX 5): the VERDICT-CARRIES-INFORMATION fixtures. Four invented
// Flows with deliberately different edge sets AND different runtime states, so
// the verdict distribution can be asserted as a RELATION (more than one
// distinct value) rather than a pinned constant.
//
//   Ledger_Sync_Flow    Obsolete, 3 outgoing effects → already-inactive / blocking
//   Widget_Intake_Flow  Active, triggersOn ONLY      → safe (+ notProvenHarmless)
//   Sprocket_Read_Flow  Active, triggersOn + readsFrom → safe (read is INPUT)
//   Gadget_Audit_Flow   NO status property, writesTo → currentlyRunning null
// =============================================================================

const FLOW_OBSOLETE_ID = 'Flow:Ledger_Sync_Flow';
const FIELD_LEDGER_TOTAL = 'CustomField:Ledger__c.Total__c';
const APEX_LEDGER = 'ApexClass:LedgerService';
const EMAIL_LEDGER = 'EmailTemplate:LedgerDigest';
const FLOW_ENTRY_ONLY_ID = 'Flow:Widget_Intake_Flow';
const OBJ_WIDGET = 'CustomObject:Widget__c';
const FLOW_READ_ONLY_ID = 'Flow:Sprocket_Read_Flow';
const OBJ_SPROCKET = 'CustomObject:Sprocket__c';
const FIELD_SPROCKET_SERIAL = 'CustomField:Sprocket__c.Serial__c';
const FLOW_NO_STATUS_ID = 'Flow:Gadget_Audit_Flow';
const FIELD_GADGET_CODE = 'CustomField:Gadget__c.Code__c';

const verdictSpreadSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_OBSOLETE_ID,
      type: 'Flow',
      apiName: 'Ledger_Sync_Flow',
      properties: { status: 'Obsolete' },
    }),
    makeNode({
      id: FIELD_LEDGER_TOTAL,
      type: 'CustomField',
      apiName: 'Total__c',
    }),
    makeNode({ id: APEX_LEDGER, type: 'ApexClass', apiName: 'LedgerService' }),
    makeNode({
      id: EMAIL_LEDGER,
      type: 'EmailTemplate',
      apiName: 'LedgerDigest',
    }),
    makeNode({
      id: FLOW_ENTRY_ONLY_ID,
      type: 'Flow',
      apiName: 'Widget_Intake_Flow',
      properties: { status: 'Active' },
    }),
    makeNode({ id: OBJ_WIDGET, type: 'CustomObject', apiName: 'Widget__c' }),
    makeNode({
      id: FLOW_READ_ONLY_ID,
      type: 'Flow',
      apiName: 'Sprocket_Read_Flow',
      properties: { status: 'Active' },
    }),
    makeNode({ id: OBJ_SPROCKET, type: 'CustomObject', apiName: 'Sprocket__c' }),
    makeNode({
      id: FIELD_SPROCKET_SERIAL,
      type: 'CustomField',
      apiName: 'Serial__c',
    }),
    makeNode({
      // NO `status` property at all — the vault does not record it.
      id: FLOW_NO_STATUS_ID,
      type: 'Flow',
      apiName: 'Gadget_Audit_Flow',
      properties: {},
    }),
    makeNode({ id: FIELD_GADGET_CODE, type: 'CustomField', apiName: 'Code__c' }),
  ],
  edges: [
    makeEdge({
      fromId: FLOW_OBSOLETE_ID,
      toId: FIELD_LEDGER_TOTAL,
      edgeType: 'writesTo',
      properties: { operation: 'recordUpdate' },
    }),
    makeEdge({
      fromId: FLOW_OBSOLETE_ID,
      toId: APEX_LEDGER,
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: FLOW_OBSOLETE_ID,
      toId: EMAIL_LEDGER,
      edgeType: 'sendsEmail',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: FLOW_ENTRY_ONLY_ID,
      toId: OBJ_WIDGET,
      edgeType: 'triggersOn',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: FLOW_READ_ONLY_ID,
      toId: OBJ_SPROCKET,
      edgeType: 'triggersOn',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: FLOW_READ_ONLY_ID,
      toId: FIELD_SPROCKET_SERIAL,
      edgeType: 'readsFrom',
    }),
    makeEdge({
      fromId: FLOW_NO_STATUS_ID,
      toId: FIELD_GADGET_CODE,
      edgeType: 'writesTo',
      properties: { operation: 'recordUpdate' },
    }),
  ],
};

// =============================================================================
// Suite 7 (R1 honesty — unresolved edge targets): a Flow whose every impact
// edge names a component that is NOT a node in this vault (a managed-package
// Apex action, an EmailTemplate the refresh never retrieved, a packaged
// subflow). The edges are DECLARED and real; only the targets are unnameable
// here. Dropping those edges produced `impacts: []`, which `aggregateVerdict`
// turns into a literal `safe` — a destructive verdict produced by not looking.
// =============================================================================

const FLOW_EXTERNAL_ID = 'Flow:Vendor_Sync_Flow';
const MISSING_TRIGGER_OBJ = 'CustomObject:Vendor_Record__c';
const MISSING_APEX = 'ApexClass:VendorGatewayService';
const MISSING_FIELD = 'CustomField:Vendor_Record__c.Status__c';
const MISSING_EMAIL = 'EmailTemplate:VendorDigest';
const MISSING_SUBFLOW = 'Flow:Vendor_Post_Steps';

const externalTargetsSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_EXTERNAL_ID,
      type: 'Flow',
      apiName: 'Vendor_Sync_Flow',
      properties: { status: 'Active', triggerType: 'RecordAfterSave' },
    }),
    // Deliberately NO node for any of the five targets below.
  ],
  edges: [
    makeEdge({
      fromId: FLOW_EXTERNAL_ID,
      toId: MISSING_TRIGGER_OBJ,
      edgeType: 'triggersOn',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: FLOW_EXTERNAL_ID,
      toId: MISSING_APEX,
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: FLOW_EXTERNAL_ID,
      toId: MISSING_FIELD,
      edgeType: 'writesTo',
      properties: { operation: 'recordUpdate' },
    }),
    makeEdge({
      fromId: FLOW_EXTERNAL_ID,
      toId: MISSING_EMAIL,
      edgeType: 'sendsEmail',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: FLOW_EXTERNAL_ID,
      toId: MISSING_SUBFLOW,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'subflow', subflowElementName: 'Call_Pkg' },
    }),
  ],
};

// The INCOMING mirror: a subflow whose only parent caller is not a node in
// this vault, and a publisher whose only event subscriber is not a node.
const FLOW_ORPHAN_CALLED_ID = 'Flow:Orphan_Called_Subflow';
const MISSING_PARENT_ID = 'Flow:Vendor_Parent_Caller';
const FLOW_BEACON_PUB_ID = 'Flow:Beacon_Publisher';
const BEACON_EVENT_OBJ = 'CustomObject:Beacon_Event__e';
const MISSING_SUBSCRIBER_ID = 'Flow:Beacon_Listener';

const incomingMissingSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_ORPHAN_CALLED_ID,
      type: 'Flow',
      apiName: 'Orphan_Called_Subflow',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: FLOW_BEACON_PUB_ID,
      type: 'Flow',
      apiName: 'Beacon_Publisher',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: BEACON_EVENT_OBJ,
      type: 'CustomObject',
      apiName: 'Beacon_Event__e',
    }),
    // NO node for MISSING_PARENT_ID or MISSING_SUBSCRIBER_ID.
  ],
  edges: [
    makeEdge({
      fromId: MISSING_PARENT_ID,
      toId: FLOW_ORPHAN_CALLED_ID,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'subflow', subflowElementName: 'Call_Ext' },
    }),
    makeEdge({
      fromId: FLOW_BEACON_PUB_ID,
      toId: BEACON_EVENT_OBJ,
      edgeType: 'writesTo',
    }),
    makeEdge({
      fromId: MISSING_SUBSCRIBER_ID,
      toId: BEACON_EVENT_OBJ,
      edgeType: 'listensTo',
      confidence: 'declared',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-what-if-deactivate-flow-'));
  const dbPath = join(tempDir, 'wid.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    richSeed,
    bareSeed,
    emptySeed,
    platformEventSeed,
    subflowActiveParentsSeed,
    subflowObsoleteParentSeed,
    verdictSpreadSeed,
    externalTargetsSeed,
    incomingMissingSeed,
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

describe('whatIfDeactivateFlowHandler', () => {
  it('surfaces platform-event subscribers when the flow publishes the event (bug 15)', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_PUBLISHER_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sub = result.value.data.impacts.find(
      (i) => i.componentId === FLOW_SUBSCRIBER_ID,
    );
    expect(sub).toBeDefined();
    expect(sub?.category).toBe('metadata-blocker');
    expect(sub?.explanation).toContain('platform event');
  });

  it('emits one impact per recognised outgoing edge type for a rich Flow', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.flowId).toBe(FLOW_RICH_ID);
    expect(data.apiName).toBe('AccountNotify');
    expect(data.status).toBe('Active');
    // UPDATED (FIX 5a) — INVARIANT: an entry point is not a dependent.
    // `triggersOn` used to be a 5th impact; it is the Flow's own START and is
    // now RECATEGORISED (never dropped) into `entryPoints`. Four impacts
    // remain: callsApex, readsFrom (input-only), writesTo, sendsEmail.
    // firesWhen is surfaced via `firingConditions`, NOT impacts.
    expect(data.impacts.length).toBe(4);
    const ids = data.impacts.map((i) => i.componentId).sort();
    expect(ids).toEqual(
      [APEX_CLS, EMAIL_TPL, FIELD_INDUSTRY, FIELD_REVENUE].sort(),
    );
    // Nothing was dropped: the object the Flow starts on is still reported.
    expect(data.entryPoints).toEqual([
      {
        kind: 'triggersOn',
        componentId: ACCOUNT_OBJ,
        note: 'the object this Flow starts on; deactivating removes the record-trigger here',
        // ALWAYS written — a resolved entry point is `false`, never absent, so
        // "resolved" and "never resolvable" cannot render the same.
        targetMissing: false,
      },
    ]);
  });

  it('surfaces firesWhen edges as firingConditions, not as impacts', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.firingConditions.length).toBe(1);
    expect(data.firingConditions[0]?.conditionContextId).toBe(COND_CTX);
    expect(data.firingConditions[0]?.expression).toBe("Industry__c == 'Tech'");
    // None of the impacts should be the ConditionalContext.
    for (const impact of data.impacts) {
      expect(impact.componentId).not.toBe(COND_CTX);
    }
  });

  it('classifies the impact categories per the rule table', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    const byId = new Map(data.impacts.map((i) => [i.componentId, i]));
    // UPDATED (FIX 5a) — INVARIANT: entry points leave `impacts`; a READ is an
    // INPUT to this Flow, not a downstream effect of it.
    // triggersOn → NOT an impact any more (see `entryPoints`)
    expect(byId.has(ACCOUNT_OBJ)).toBe(false);
    // writesTo → metadata-blocker
    expect(byId.get(FIELD_REVENUE)?.category).toBe('metadata-blocker');
    // readsFrom → input-only (was metadata-blocker — the sharpest instance of
    // the category error: a Get Records lookup rated `blocking`)
    expect(byId.get(FIELD_INDUSTRY)?.category).toBe('input-only');
    // sendsEmail → metadata-blocker
    expect(byId.get(EMAIL_TPL)?.category).toBe('metadata-blocker');
    // callsApex → code-needs-update
    expect(byId.get(APEX_CLS)?.category).toBe('code-needs-update');
  });

  it('aggregates verdict to `blocking` when any metadata-blocker impact exists', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
  });

  it('aggregates STRUCTURAL verdict to `risky` when only callsApex impacts exist', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_BARE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.impacts.length).toBe(1);
    expect(result.value.data.impacts[0]?.category).toBe('code-needs-update');
    // UPDATED (FIX 5b) — INVARIANT: runtime state is its own axis. This
    // fixture Flow is `Draft`, so it does not run today: the HEADLINE is
    // `already-inactive` and the structural answer keeps `risky`. Before the
    // fix the headline was `risky`, which told the caller that deactivating
    // automation that is already off would skip an Apex call.
    expect(result.value.data.structuralVerdict).toBe('risky');
    expect(result.value.data.verdict).toBe('already-inactive');
    expect(result.value.data.runtimeState.currentlyRunning).toBe(false);
  });

  it('aggregates verdict to `safe` when the Flow has no outgoing edges', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_EMPTY_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.impacts.length).toBe(0);
    expect(result.value.data.firingConditions.length).toBe(0);
    expect(result.value.data.verdict).toBe('safe');
    // ADDED (FIX 5a) — `safe` alone over-claims: an empty result is a
    // statement about the edge types walked, not a proof of harmlessness.
    expect(result.value.data.notProvenHarmless).toContain(
      'not a proof that disabling is harmless',
    );
  });

  it('sorts impacts deterministically by (category, componentId)', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Sort key: category ASC, then componentId ASC. code-needs-update
    // comes before metadata-blocker alphabetically.
    const sorted = [...data.impacts].sort((a, b) => {
      if (a.category !== b.category) return a.category < b.category ? -1 : 1;
      if (a.componentId !== b.componentId) {
        return a.componentId < b.componentId ? -1 : 1;
      }
      return 0;
    });
    expect(data.impacts.map((i) => i.componentId)).toEqual(
      sorted.map((i) => i.componentId),
    );
    // code-needs-update items appear before metadata-blocker.
    const codeFirstIdx = data.impacts.findIndex(
      (i) => i.category === 'code-needs-update',
    );
    const blockerFirstIdx = data.impacts.findIndex(
      (i) => i.category === 'metadata-blocker',
    );
    expect(codeFirstIdx).toBeLessThan(blockerFirstIdx);
  });

  it('returns invalid-query for a non-Flow prefix', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: 'ApexClass:NotAFlow',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for a well-formed but unknown flowId', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: 'Flow:NoSuchFlow',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('emits the verbatim honesty-axis disclosure', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('v2.3 what-if analysis');
    expect(result.value.data.disclosure).toContain('Flow.Interview');
    expect(result.value.data.disclosure).toContain('@InvocableMethod');
  });

  it('echoes the manifest vaultState into the response envelope', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-28T10:00:00Z');
  });

  // ---------------------------------------------------------------------------
  // R6-02: subflow broken callers (the incoming side).
  // ---------------------------------------------------------------------------

  it('flips a would-be-safe subflow to `blocking` when an ACTIVE parent calls it', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: SUBFLOW_ACTIVE_PARENTS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // The subflow has NO outgoing edges — pre-R6-02 this read `safe`.
    expect(data.verdict).toBe('blocking');
    const brokenCallers = data.impacts.filter(
      (i) => i.category === 'broken-caller',
    );
    const ids = brokenCallers.map((i) => i.componentId).sort();
    expect(ids).toEqual([PARENT_ACTIVE_1_ID, PARENT_ACTIVE_2_ID].sort());
    for (const bc of brokenCallers) {
      expect(bc.componentType).toBe('Flow');
      expect(bc.confidence).toBe('declared');
      expect(bc.explanation.toLowerCase()).toContain('subflow');
    }
  });

  it('does NOT count a non-subflow incoming reference (FlexiPage) as a broken caller', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: SUBFLOW_ACTIVE_PARENTS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).not.toContain(FLEXIPAGE_EMBED_ID);
  });

  it('surfaces an obsolete-only parent as a broken caller but stops at `risky` (not blocking)', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: SUBFLOW_OBSOLETE_PARENT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    const brokenCallers = data.impacts.filter(
      (i) => i.category === 'broken-caller',
    );
    expect(brokenCallers.map((i) => i.componentId)).toEqual([
      PARENT_OBSOLETE_ID,
    ]);
    // The caller is surfaced (transparency) but its Obsolete status means the
    // subflow is not currently invoked at runtime — verdict is `risky`, not
    // `blocking`.
    expect(data.verdict).toBe('risky');
    expect(brokenCallers[0]?.explanation).toContain('Obsolete');
  });

  it('surfaces the OUTGOING subflow call as a metadata-blocker when a parent is deactivated', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: PARENT_ACTIVE_1_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    const childImpact = data.impacts.find(
      (i) => i.componentId === SUBFLOW_ACTIVE_PARENTS_ID,
    );
    expect(childImpact).toBeDefined();
    expect(childImpact?.category).toBe('metadata-blocker');
    // Deactivating the parent stops its subflow invocation → blocking.
    expect(data.verdict).toBe('blocking');
  });

  it('discloses both the new subflow modeling and the still-invisible Apex Flow.Interview path', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: SUBFLOW_ACTIVE_PARENTS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const disclosure = result.value.data.disclosure;
    expect(disclosure).toContain('subflow');
    expect(disclosure).toContain('Flow.Interview');
  });
});


// =============================================================================
// FIX 5 — the verdict must carry information.
//
// Two independent causes, both asserted here:
//   (a) de-tautologise — `triggersOn` / `listensTo` are the Flow's own ENTRY
//       POINT and must not pin the verdict; `readsFrom` is an INPUT.
//   (b) runtime state is its own axis — a Flow that is already off must not be
//       told that deactivating it breaks things. Measured before the fix: 67 of
//       71 non-Active Flows returned `blocking`.
// =============================================================================

describe('whatIfDeactivateFlowHandler — FIX 5 verdict information content', () => {
  it('an OBSOLETE Flow with three outgoing effects reads `already-inactive`, keeping `blocking` as the structural answer', async () => {
    // FAIL-BEFORE: the status was resolved and emitted but never consulted, so
    // this returned `blocking` about a Flow that does not run today.
    const r = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_OBSOLETE_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect(data.impacts.length).toBe(3);
    expect(data.verdict).toBe('already-inactive');
    expect(data.structuralVerdict).toBe('blocking');
    expect(data.runtimeState.status).toBe('Obsolete');
    expect(data.runtimeState.currentlyRunning).toBe(false);
    expect(data.runtimeState.note).toBe(
      'This Flow is Obsolete — it does not run in the org today, so deactivating it changes no runtime behaviour. structuralVerdict below describes what WOULD stop if it were Active. That is NOT a claim that nothing depends on it: 3 dependent(s) are listed in impacts, and they will be affected if it is ever reactivated.',
    );
  });

  it('a Flow whose ONLY edge is its entry point is `safe`, with the not-proven sentence', async () => {
    // FAIL-BEFORE: `triggersOn` was an unconditional metadata-blocker, so every
    // record-triggered Flow returned `blocking`.
    const r = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_ENTRY_ONLY_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect(data.impacts).toEqual([]);
    expect(data.structuralVerdict).toBe('safe');
    expect(data.verdict).toBe('safe');
    expect(data.notProvenHarmless).toBe(
      'No downstream effect is visible in this vault. That is a statement about the edge types walked (writesTo, callsApex, dispatchesAsync, sendsEmail, subflow references), not a proof that disabling is harmless — dynamic dispatch, managed-package callers, and framework wiring are invisible here.',
    );
    expect(data.entryPoints).toEqual([
      {
        kind: 'triggersOn',
        componentId: OBJ_WIDGET,
        note: 'the object this Flow starts on; deactivating removes the record-trigger here',
        // ALWAYS written — a resolved entry point is `false`, never absent, so
        // "resolved" and "never resolvable" cannot render the same.
        targetMissing: false,
      },
    ]);
  });

  it('a readsFrom impact is `input-only`, drops "stops this action", and moves no verdict', async () => {
    // FAIL-BEFORE: category was `metadata-blocker` and the verdict `blocking`
    // — a Get Records lookup rated as a hard blocker.
    const r = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_READ_ONLY_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    const read = data.impacts.find(
      (i) => i.componentId === FIELD_SPROCKET_SERIAL,
    );
    expect(read?.category).toBe('input-only');
    expect(read?.explanation).toBe(
      "Flow 'Sprocket_Read_Flow' reads CustomField 'Serial__c'. Deactivating the Flow removes that read; 'Serial__c' itself is unchanged and nothing downstream of it is affected. Listed because it is a dependency of this Flow, not a dependent on it.",
    );
    expect(read?.explanation).not.toContain('stops this action');
    // The read is reported but carries no verdict, and the entry point is out
    // of `impacts`, so a read-only Flow is structurally `safe`.
    expect(data.structuralVerdict).toBe('safe');
    expect(data.verdict).toBe('safe');
    expect(data.notProvenHarmless).toBeDefined();
  });

  it('an ABSENT status is `currentlyRunning: null` — never a fabricated false', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_NO_STATUS_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect(data.runtimeState.currentlyRunning).toBeNull();
    expect(data.runtimeState.currentlyRunning).not.toBe(false);
    expect(data.runtimeState.status).toBeNull();
    expect(data.runtimeState.note).toBe(
      "This component's activation status is not recorded in this vault, so whether it runs today is UNKNOWN — not assumed active and not assumed inactive. Treat the verdict as the structural answer only, and confirm the status in the org.",
    );
    // Unknown status must NOT be read as "off".
    expect(data.verdict).not.toBe('already-inactive');
    expect(data.verdict).toBe(data.structuralVerdict);
    expect(data.structuralVerdict).toBe('blocking');
  });

  it('an ACTIVE Flow reports both axes and they agree', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, { flowId: FLOW_RICH_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.runtimeState.currentlyRunning).toBe(true);
    expect(r.value.data.runtimeState.status).toBe('Active');
    expect(r.value.data.verdict).toBe(r.value.data.structuralVerdict);
  });

  it('VERDICT-DISTRIBUTION INVARIANT: different edge sets produce different verdicts', async () => {
    // The regression this catches is the one the fix exists for: a verdict that
    // is the same word for every input carries no information. Assert the
    // RELATION (more than one distinct verdict), never an org-wide constant.
    const ids = [
      FLOW_OBSOLETE_ID,
      FLOW_ENTRY_ONLY_ID,
      FLOW_READ_ONLY_ID,
      FLOW_NO_STATUS_ID,
      FLOW_RICH_ID,
    ];
    const verdicts: string[] = [];
    for (const id of ids) {
      const r = await whatIfDeactivateFlowHandler(ctx, { flowId: id });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      verdicts.push(r.value.data.verdict);
    }
    expect(verdicts).toHaveLength(5);
    expect(new Set(verdicts).size).toBeGreaterThan(1);
  });
});

describe('whatIfDeactivateFlowInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({
      flowId: FLOW_RICH_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty flowId', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({
      flowId: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a componentId alias in place of flowId', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({
      componentId: FLOW_RICH_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty object at the schema layer (the "name a Flow" check is in the handler)', () => {
    // flowId is now optional because componentId / flowApiName / apiName are
    // interchangeable selectors; the "at least one" requirement is enforced by
    // the handler (invalid-query), not the schema.
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('accepts the empty-prefix case at the schema layer (prefix check is in the handler)', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({
      flowId: 'NotAFlow',
    });
    expect(parsed.success).toBe(true);
  });
});

// =============================================================================
// N+1 query budget (finding C-1). The outgoing-impact walk,
// collectFiringConditions, and collectBrokenCaller all resolved edge endpoints
// with a `getNodeById` per edge (and the platform-event subscriber walk did a
// per-event listEdges + per-subscriber getNodeById); all are batched. The count
// must NOT scale with the flow's edge fan-out.
// =============================================================================
describe('whatIfDeactivateFlowHandler — bounded graph queries', () => {
  // A wide flow: `fanOut` outgoing callsApex targets, `fanOut` firesWhen
  // conditions, `fanOut` incoming subflow callers, AND `fanOut` subscribers to a
  // platform event this flow publishes (exercises the nested subs walk too).
  const seedWideFlow = async (fanOut: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-widf-budget-'));
    const opened = await openGraph(join(dir, 'widf.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const EVENT = 'CustomObject:WideEvent__e';
    const nodes: Node[] = [
      makeNode({ id: 'Flow:Wide', type: 'Flow', apiName: 'Wide', properties: { status: 'Active' } }),
      makeNode({ id: EVENT, type: 'CustomObject', apiName: 'WideEvent__e' }),
    ];
    const edges: Edge[] = [
      makeEdge({ fromId: 'Flow:Wide', toId: EVENT, edgeType: 'writesTo' }),
    ];
    for (let i = 0; i < fanOut; i += 1) {
      nodes.push(makeNode({ id: `ApexClass:Cls${i}`, type: 'ApexClass', apiName: `Cls${i}` }));
      edges.push(makeEdge({ fromId: 'Flow:Wide', toId: `ApexClass:Cls${i}`, edgeType: 'callsApex' }));
      nodes.push(makeNode({ id: `ConditionalContext:Cond${i}`, type: 'ConditionalContext', apiName: `Cond${i}` }));
      edges.push(makeEdge({ fromId: 'Flow:Wide', toId: `ConditionalContext:Cond${i}`, edgeType: 'firesWhen' }));
      nodes.push(makeNode({ id: `Flow:Parent${i}`, type: 'Flow', apiName: `Parent${i}`, properties: { status: 'Active' } }));
      edges.push(makeEdge({ fromId: `Flow:Parent${i}`, toId: 'Flow:Wide', edgeType: 'references', properties: { referenceKind: 'subflow' } }));
      nodes.push(makeNode({ id: `Flow:Sub${i}`, type: 'Flow', apiName: `Sub${i}`, properties: { status: 'Active' } }));
      edges.push(makeEdge({ fromId: `Flow:Sub${i}`, toId: EVENT, edgeType: 'listensTo' }));
    }
    const imported = await importExtractionResults(s, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const wideCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const measured = await measureGraphQueries(s, () =>
      whatIfDeactivateFlowHandler(wideCtx, { flowId: 'Wide' }),
    );
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return measured;
  };

  it('issues a query count independent of the flow edge fan-out', async () => {
    const small = await seedWideFlow(60);
    const large = await seedWideFlow(200);
    expect(small.result.ok).toBe(true);
    expect(large.result.ok).toBe(true);
    expect(large.nodeQueries).toBe(small.nodeQueries);
    expect(large.edgeQueries).toBe(small.edgeQueries);
    // A per-edge getNodeById across the walks would be >=180 node queries at
    // fanOut=200; batched, each walk is one node/edge fetch.
    expect(large.nodeQueries).toBeLessThan(60);
    expect(large.edgeQueries).toBeLessThan(60);
  });
});

// =============================================================================
// GUARD (WHAT-IF-DEACTIVATE-FLOW-REJECTS-COMPONENTID): a dev "if I deactivate
// Flow X, what breaks?" after route_question naturally passes componentId
// (works on get_impact / most tools), but the schema only accepted `flowId` and
// hard-failed `flowId: Required`. componentId / flowApiName / apiName must now
// be interchangeable with flowId (same deactivation impact, byte-equal),
// disagreeing selectors reject, and the resolved id is echoed in appliedScope.
// =============================================================================
describe('whatIfDeactivateFlowHandler — flowId / componentId / flowApiName / apiName alias (guard)', () => {
  it('componentId ≡ flowId ≡ flowApiName ≡ apiName resolve to the same impact (byte-equal data)', async () => {
    const byFlowId = await whatIfDeactivateFlowHandler(ctx, { flowId: FLOW_RICH_ID });
    const byComponentId = await whatIfDeactivateFlowHandler(ctx, { componentId: FLOW_RICH_ID });
    const byFlowApiName = await whatIfDeactivateFlowHandler(ctx, { flowApiName: 'AccountNotify' });
    const byApiName = await whatIfDeactivateFlowHandler(ctx, { apiName: 'AccountNotify' });
    expect(byFlowId.ok && byComponentId.ok && byFlowApiName.ok && byApiName.ok).toBe(true);
    if (!byFlowId.ok || !byComponentId.ok || !byFlowApiName.ok || !byApiName.ok) return;
    const canonical = JSON.stringify(byFlowId.value.data);
    expect(JSON.stringify(byComponentId.value.data)).toBe(canonical);
    expect(JSON.stringify(byFlowApiName.value.data)).toBe(canonical);
    expect(JSON.stringify(byApiName.value.data)).toBe(canonical);
    expect(byComponentId.value.data.appliedScope).toEqual({
      component: FLOW_RICH_ID,
      mode: 'component',
    });
  });

  it('componentId scope is actually honored — a different Flow returns ITS impact', async () => {
    const rich = await whatIfDeactivateFlowHandler(ctx, { componentId: FLOW_RICH_ID });
    const empty = await whatIfDeactivateFlowHandler(ctx, { componentId: FLOW_EMPTY_ID });
    expect(rich.ok && empty.ok).toBe(true);
    if (!rich.ok || !empty.ok) return;
    expect(empty.value.data.flowId).toBe(FLOW_EMPTY_ID);
    expect(empty.value.data.appliedScope.component).toBe(FLOW_EMPTY_ID);
    // Different Flows → different impact payloads: proof the alias is used.
    expect(JSON.stringify(empty.value.data.impacts)).not.toBe(
      JSON.stringify(rich.value.data.impacts),
    );
  });

  it('disagreeing flowId / componentId is invalid-query (never a silent pick)', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
      componentId: FLOW_EMPTY_ID,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('no flow selector at all is invalid-query', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

// =============================================================================
// GUARD (WHAT-IF-DEACTIVATE-FLOW-UNRESOLVED-TARGETS, R1): an impact edge whose
// target is not a node in this vault used to be dropped silently at three
// sites (the outgoing walk, the broken-caller walk, the platform-event second
// hop). A Flow whose impact edges ALL point out of the vault therefore
// produced `impacts: []`, and `aggregateVerdict([])` returns the literal word
// `safe` — a destructive verdict manufactured by not looking, with nothing in
// the response counting or naming what was dropped. The edges are DECLARED and
// real; only the TARGET is unnameable here, so each is now surfaced with
// `targetMissing: true` and bears on the verdict exactly as its resolvable
// twin would (the `sfi.user_ability` doctrine: emit the row, never drop it).
// =============================================================================
describe('whatIfDeactivateFlowHandler — unresolved edge targets (guard)', () => {
  it('does NOT return `safe` for a Flow whose every impact edge leaves the vault', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, { flowId: FLOW_EXTERNAL_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // writesTo / sendsEmail / subflow are metadata-blockers → blocking. The
    // pre-fix code dropped all four edges and answered the literal word `safe`.
    expect(d.structuralVerdict).toBe('blocking');
    expect(d.verdict).toBe('blocking');
    // The four non-entry-point edges (callsApex / writesTo / sendsEmail /
    // subflow references) are real declared effects that stop on deactivation.
    expect(d.unresolvedImpacts.map((i) => i.componentId).sort()).toEqual(
      [MISSING_APEX, MISSING_EMAIL, MISSING_FIELD, MISSING_SUBFLOW].sort(),
    );
    for (const row of d.unresolvedImpacts) expect(row.targetMissing).toBe(true);
    // "No downstream effect is visible in this vault" would be a lie here.
    expect(d.notProvenHarmless).toBeUndefined();
    // The count is stated, not merely implied by an array the caller may skip.
    expect(d.unresolvedTargetsNote).toContain('4');
    expect(d.unresolvedTargetsNote).toContain('targetMissing');
  });

  it('keeps the unresolved ENTRY POINT in the response instead of dropping it', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, { flowId: FLOW_EXTERNAL_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entryPoints).toEqual([
      {
        kind: 'triggersOn',
        componentId: MISSING_TRIGGER_OBJ,
        note: expect.any(String) as unknown as string,
        targetMissing: true,
      },
    ]);
  });

  it('a resolvable Flow is unaffected: every impact still resolves and nothing is marked missing', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, { flowId: FLOW_RICH_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unresolvedImpacts).toEqual([]);
    expect(r.value.data.unresolvedTargetsNote).toBeUndefined();
    for (const e of r.value.data.entryPoints) expect(e.targetMissing).toBe(false);
  });

  it('a subflow whose only parent caller is out of vault does not read `safe`', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_ORPHAN_CALLED_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Pre-fix: the parent edge was dropped at the `parentNode === undefined`
    // guard, leaving zero impacts and the literal word `safe`.
    expect(d.structuralVerdict).not.toBe('safe');
    expect(d.verdict).not.toBe('safe');
    expect(d.notProvenHarmless).toBeUndefined();
    expect(d.unresolvedImpacts).toEqual([
      {
        category: 'broken-caller',
        componentId: MISSING_PARENT_ID,
        edgeType: 'references',
        confidence: 'declared',
        targetMissing: true,
        explanation: expect.any(String) as unknown as string,
      },
    ]);
  });

  it('a platform-event subscriber that is not a node is surfaced, not dropped', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_BEACON_PUB_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The publisher's only downstream consumer is the out-of-vault subscriber;
    // pre-fix it was dropped and the publisher read `safe`.
    expect(d.verdict).toBe('blocking');
    expect(
      d.unresolvedImpacts.some((i) => i.componentId === MISSING_SUBSCRIBER_ID),
    ).toBe(true);
  });
});
