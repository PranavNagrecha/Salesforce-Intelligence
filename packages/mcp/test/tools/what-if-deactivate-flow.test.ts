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
    // Five impacts: triggersOn, callsApex, readsFrom, writesTo, sendsEmail.
    // firesWhen is surfaced via `firingConditions`, NOT impacts.
    expect(data.impacts.length).toBe(5);
    const ids = data.impacts.map((i) => i.componentId).sort();
    expect(ids).toEqual(
      [
        ACCOUNT_OBJ,
        APEX_CLS,
        EMAIL_TPL,
        FIELD_INDUSTRY,
        FIELD_REVENUE,
      ].sort(),
    );
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
    // triggersOn → metadata-blocker
    expect(byId.get(ACCOUNT_OBJ)?.category).toBe('metadata-blocker');
    // writesTo → metadata-blocker
    expect(byId.get(FIELD_REVENUE)?.category).toBe('metadata-blocker');
    // readsFrom → metadata-blocker
    expect(byId.get(FIELD_INDUSTRY)?.category).toBe('metadata-blocker');
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

  it('aggregates verdict to `risky` when only callsApex impacts exist', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_BARE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.impacts.length).toBe(1);
    expect(result.value.data.impacts[0]?.category).toBe('code-needs-update');
    expect(result.value.data.verdict).toBe('risky');
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

  it('rejects a missing flowId', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('accepts the empty-prefix case at the schema layer (prefix check is in the handler)', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({
      flowId: 'NotAFlow',
    });
    expect(parsed.success).toBe(true);
  });
});
