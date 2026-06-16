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
  cdcSubscribersHandler,
  cdcSubscribersInputSchema,
} from '../../src/tools/cdc-subscribers.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 4,
    ApexTrigger: 2,
    ApexClass: 1,
    Flow: 1,
  },
  edges: { listensTo: 5 },
  sourceTreeHash: 'sha256:cdc-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'placeholder',
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
// Seed 1: a standard-object CDC event (AccountChangeEvent) with three CDC
// subscribers (ApexTrigger, ApexClass, Flow) — mirror of the
// event-subscribers fixture for the __e Platform Event case.
// =============================================================================

const ACCOUNT_CDC_EVENT = 'CustomObject:AccountChangeEvent';
const ACCOUNT_CDC_TRIGGER = 'ApexTrigger:AccountChangeHandler';
const ACCOUNT_CDC_CLASS = 'ApexClass:AccountChangeAsyncHandler';
const ACCOUNT_CDC_FLOW = 'Flow:AccountChangeFlow';

const accountCdcSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ACCOUNT_CDC_EVENT,
      type: 'CustomObject',
      apiName: 'AccountChangeEvent',
    }),
    makeNode({
      id: ACCOUNT_CDC_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'AccountChangeHandler',
    }),
    makeNode({
      id: ACCOUNT_CDC_CLASS,
      type: 'ApexClass',
      apiName: 'AccountChangeAsyncHandler',
    }),
    makeNode({
      id: ACCOUNT_CDC_FLOW,
      type: 'Flow',
      apiName: 'AccountChangeFlow',
    }),
  ],
  edges: [
    makeEdge({
      fromId: ACCOUNT_CDC_TRIGGER,
      toId: ACCOUNT_CDC_EVENT,
      edgeType: 'listensTo',
      source: 'apex-trigger-extractor',
    }),
    makeEdge({
      fromId: ACCOUNT_CDC_CLASS,
      toId: ACCOUNT_CDC_EVENT,
      edgeType: 'listensTo',
      source: 'apex-class-extractor',
    }),
    makeEdge({
      fromId: ACCOUNT_CDC_FLOW,
      toId: ACCOUNT_CDC_EVENT,
      edgeType: 'listensTo',
      source: 'flow-extractor',
    }),
  ],
};

// =============================================================================
// Seed 2: a custom-object CDC event (Order__ChangeEvent) with one subscriber.
// =============================================================================

const ORDER_CDC_EVENT = 'CustomObject:Order__ChangeEvent';
const ORDER_CDC_TRIGGER = 'ApexTrigger:OrderChangeHandler';

const orderCdcSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ORDER_CDC_EVENT,
      type: 'CustomObject',
      apiName: 'Order__ChangeEvent',
    }),
    makeNode({
      id: ORDER_CDC_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'OrderChangeHandler',
    }),
  ],
  edges: [
    makeEdge({
      fromId: ORDER_CDC_TRIGGER,
      toId: ORDER_CDC_EVENT,
      edgeType: 'listensTo',
      source: 'apex-trigger-extractor',
    }),
  ],
};

// =============================================================================
// Seed 3: a regular Platform Event (Order_Placed__e) that should NOT be
// counted as a CDC event — the v2.8 name-pattern recognizer filters it out.
// =============================================================================

const PLATFORM_EVENT = 'CustomObject:Order_Placed__e';
const PLATFORM_EVENT_TRIGGER = 'ApexTrigger:OrderPlacedHandler';

const platformEventSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PLATFORM_EVENT,
      type: 'CustomObject',
      apiName: 'Order_Placed__e',
    }),
    makeNode({
      id: PLATFORM_EVENT_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'OrderPlacedHandler',
    }),
  ],
  edges: [
    makeEdge({
      fromId: PLATFORM_EVENT_TRIGGER,
      toId: PLATFORM_EVENT,
      edgeType: 'listensTo',
      source: 'apex-trigger-extractor',
    }),
  ],
};

// =============================================================================
// Seed 4: a CDC event whose only listensTo edge originates from a non-
// subscriber node type (a CustomField). Used to verify the subscriber-type
// filter — the CustomField edge must NOT surface as a subscriber.
// =============================================================================

const FILTERED_CDC = 'CustomObject:LeadChangeEvent';
const NON_SUBSCRIBER = 'CustomField:Account.Whatever__c';

const filteredCdcSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FILTERED_CDC,
      type: 'CustomObject',
      apiName: 'LeadChangeEvent',
    }),
    makeNode({
      id: NON_SUBSCRIBER,
      type: 'CustomField',
      apiName: 'Account.Whatever__c',
    }),
  ],
  edges: [
    makeEdge({
      fromId: NON_SUBSCRIBER,
      toId: FILTERED_CDC,
      edgeType: 'listensTo',
      source: 'corrupt-extractor',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cdc-subscribers-'));
  const opened = await openGraph(join(tempDir, 'cdc.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    accountCdcSeed,
    orderCdcSeed,
    platformEventSeed,
    filteredCdcSeed,
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

describe('cdcSubscribersHandler', () => {
  it('returns all three subscribers for a standard-object CDC event', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.subscribers).toHaveLength(3);
    const ids = d.subscribers.map((s) => s.subscriberId);
    expect(ids).toContain(ACCOUNT_CDC_TRIGGER);
    expect(ids).toContain(ACCOUNT_CDC_CLASS);
    expect(ids).toContain(ACCOUNT_CDC_FLOW);
    expect(d.subscribers.every((s) => s.changeEventName === 'AccountChangeEvent')).toBe(
      true,
    );
    expect(d.summary.totalSubscribers).toBe(3);
    expect(d.summary.uniqueChangeEvents).toBe(1);
    expect(d.disclosure).toContain('name pattern');
  });

  it('resolves the custom-object CDC name pattern (Order__c -> Order__ChangeEvent)', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'Order__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.subscribers).toHaveLength(1);
    expect(d.subscribers[0]?.subscriberId).toBe(ORDER_CDC_TRIGGER);
    expect(d.subscribers[0]?.changeEventName).toBe('Order__ChangeEvent');
  });

  it('filters out non-CDC Platform Events when scanning the org-wide set', async () => {
    const result = await cdcSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.subscribers.map((s) => s.subscriberId);
    // OrderPlacedHandler subscribes to Order_Placed__e (not CDC) and
    // must NOT surface.
    expect(ids).not.toContain(PLATFORM_EVENT_TRIGGER);
  });

  it('walks every CDC event when no sObjectFilter is supplied', async () => {
    const result = await cdcSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // Two CDC events with at least one subscriber: AccountChangeEvent
    // (3 subscribers) and Order__ChangeEvent (1 subscriber).
    expect(d.summary.uniqueChangeEvents).toBeGreaterThanOrEqual(2);
    expect(d.subscribers.length).toBeGreaterThanOrEqual(4);
  });

  it('returns an empty subscriber list (not error) when the CDC event has no subscribers', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'NonExistentObject',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.subscribers).toEqual([]);
    expect(result.value.data.summary.totalSubscribers).toBe(0);
    expect(result.value.data.summary.uniqueChangeEvents).toBe(0);
  });

  it('filters out non-subscriber node types (e.g. CustomField)', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'Lead',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.subscribers).toEqual([]);
  });

  it('sorts the subscribers array by subscriberId ASC for determinism', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.subscribers.map((s) => s.subscriberId);
    expect(ids).toEqual([...ids].sort());
  });

  it('preserves the verbatim source field from the producing extractor', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trigger = result.value.data.subscribers.find(
      (s) => s.subscriberId === ACCOUNT_CDC_TRIGGER,
    );
    expect(trigger?.source).toBe('apex-trigger-extractor');
    const flow = result.value.data.subscribers.find(
      (s) => s.subscriberId === ACCOUNT_CDC_FLOW,
    );
    expect(flow?.source).toBe('flow-extractor');
  });

  it('returns an honest disclosure mentioning the v2.8 name-pattern boundary', async () => {
    const result = await cdcSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('EventBus.subscribe');
    expect(result.value.data.disclosure).toContain('platformEventChannelMember');
  });

  it('carries vaultState from the manifest', async () => {
    const result = await cdcSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:cdc-fixture');
  });
});

describe('cdcSubscribersInputSchema', () => {
  it('accepts an empty input (sObjectFilter is optional)', () => {
    expect(cdcSubscribersInputSchema.safeParse({}).success).toBe(true);
  });

  it("accepts sObjectFilter='Account'", () => {
    expect(
      cdcSubscribersInputSchema.safeParse({ sObjectFilter: 'Account' }).success,
    ).toBe(true);
  });

  it("accepts sObjectFilter='Order__c' (custom object form)", () => {
    expect(
      cdcSubscribersInputSchema.safeParse({ sObjectFilter: 'Order__c' }).success,
    ).toBe(true);
  });

  it('rejects an empty-string sObjectFilter', () => {
    expect(
      cdcSubscribersInputSchema.safeParse({ sObjectFilter: '' }).success,
    ).toBe(false);
  });
});
