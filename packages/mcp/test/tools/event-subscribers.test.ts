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
  eventSubscribersHandler,
  eventSubscribersInputSchema,
} from '../../src/tools/event-subscribers.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    ApexTrigger: 2,
    ApexClass: 1,
    Flow: 1,
  },
  edges: { listensTo: 4 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName. */
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

/** Default edge-shape helper. Caller overrides fromId/toId/edgeType/source. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: A Platform Event with three subscribers — an ApexTrigger, an
// ApexClass (via Triggerable<Event__e> interface), and a Flow with
// triggerType=PlatformEvent. All three subscribers emit listensTo edges
// into the event node, tagged with the respective extractor source.
// =============================================================================

const ACCOUNT_CHANGE_EVENT = 'CustomObject:Account_Change__e';
const TRIGGER_HANDLER = 'ApexTrigger:Account_Change_Handler';
const APEX_HANDLER = 'ApexClass:Account_Change_AsyncHandler';
const FLOW_HANDLER = 'Flow:Account_Change_Flow';
// CR-CAP-18: a publish-side channel routing the event, with a declared filter.
const ACCOUNT_CHANNEL = 'PlatformEventChannel:Account_Change_Channel__chn';
const ACCOUNT_MEMBER = 'PlatformEventChannelMember:Account_Change_Member__chn';
// GROUP C: publish-side code that emits the event (writesTo edge into the event).
const PUBLISHER_FLOW = 'Flow:Account_Change_Publisher_Flow';
const PUBLISHER_APEX = 'ApexClass:Account_Change_Publisher';

const mixedSubscribersSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ACCOUNT_CHANGE_EVENT,
      type: 'CustomObject',
      apiName: 'Account_Change__e',
    }),
    makeNode({
      id: TRIGGER_HANDLER,
      type: 'ApexTrigger',
      apiName: 'Account_Change_Handler',
    }),
    makeNode({
      id: APEX_HANDLER,
      type: 'ApexClass',
      apiName: 'Account_Change_AsyncHandler',
    }),
    makeNode({
      id: FLOW_HANDLER,
      type: 'Flow',
      apiName: 'Account_Change_Flow',
    }),
    // CR-CAP-18 publish-side: channel + member binding the event.
    makeNode({
      id: ACCOUNT_CHANNEL,
      type: 'PlatformEventChannel',
      apiName: 'Account_Change_Channel__chn',
      properties: { channelType: 'event', label: 'Account Change Channel' },
    }),
    makeNode({
      id: ACCOUNT_MEMBER,
      type: 'PlatformEventChannelMember',
      apiName: 'Account_Change_Member__chn',
      parentId: ACCOUNT_CHANNEL,
      properties: {
        eventChannel: 'Account_Change_Channel__chn',
        selectedEntity: 'Account_Change__e',
        filterExpression: "Status__c = 'New'",
      },
    }),
    // GROUP C publish-side code: a Flow and an Apex class that emit the event.
    makeNode({
      id: PUBLISHER_FLOW,
      type: 'Flow',
      apiName: 'Account_Change_Publisher_Flow',
    }),
    makeNode({
      id: PUBLISHER_APEX,
      type: 'ApexClass',
      apiName: 'Account_Change_Publisher',
    }),
  ],
  edges: [
    makeEdge({
      fromId: TRIGGER_HANDLER,
      toId: ACCOUNT_CHANGE_EVENT,
      edgeType: 'listensTo',
      source: 'apex-trigger-extractor',
      properties: { events: ['after insert'] },
    }),
    makeEdge({
      fromId: APEX_HANDLER,
      toId: ACCOUNT_CHANGE_EVENT,
      edgeType: 'listensTo',
      source: 'apex-class-extractor',
      properties: { interface: 'Triggerable<Account_Change__e>' },
    }),
    makeEdge({
      fromId: FLOW_HANDLER,
      toId: ACCOUNT_CHANGE_EVENT,
      edgeType: 'listensTo',
      source: 'flow-extractor',
      properties: { triggerType: 'PlatformEvent' },
    }),
    // CR-CAP-18 publish-side topology: parentOf(channel→member) +
    // references(member→event) carrying the declared filterExpression.
    makeEdge({
      fromId: ACCOUNT_CHANNEL,
      toId: ACCOUNT_MEMBER,
      edgeType: 'parentOf',
      source: 'platform-event-channel-extractor',
    }),
    makeEdge({
      fromId: ACCOUNT_MEMBER,
      toId: ACCOUNT_CHANGE_EVENT,
      edgeType: 'references',
      source: 'platform-event-channel-extractor',
      properties: {
        referenceKind: 'platformEventChannelMember',
        filterExpression: "Status__c = 'New'",
      },
    }),
    // GROUP C publish-side code: Flow + Apex emit the event via writesTo edges.
    makeEdge({
      fromId: PUBLISHER_FLOW,
      toId: ACCOUNT_CHANGE_EVENT,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      properties: { operation: 'create', mechanism: 'flow-create-record' },
    }),
    makeEdge({
      fromId: PUBLISHER_APEX,
      toId: ACCOUNT_CHANGE_EVENT,
      edgeType: 'writesTo',
      source: 'apex-class-extractor',
      properties: { operation: 'publish', mechanism: 'EventBus.publish' },
    }),
  ],
};

// =============================================================================
// Seed 2: A second event with a single trigger subscriber. Used for sanity
// checks (single-subscriber path) and as a comparison against the mixed seed.
// =============================================================================

const ORDER_EVENT = 'CustomObject:Order_Placed__e';
const ORDER_TRIGGER = 'ApexTrigger:Order_Placed_Handler';

const singleSubscriberSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ORDER_EVENT,
      type: 'CustomObject',
      apiName: 'Order_Placed__e',
    }),
    makeNode({
      id: ORDER_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'Order_Placed_Handler',
    }),
  ],
  edges: [
    makeEdge({
      fromId: ORDER_TRIGGER,
      toId: ORDER_EVENT,
      edgeType: 'listensTo',
      source: 'apex-trigger-extractor',
    }),
  ],
};

// =============================================================================
// Seed 3: a many-subscribers event for the limit-truncation test. Five
// ApexTrigger subscribers with sortable ids.
// =============================================================================

const CROWDED_EVENT = 'CustomObject:Crowded_Event__e';
const CROWDED_TRIGGERS = [
  'ApexTrigger:S01_Handler',
  'ApexTrigger:S02_Handler',
  'ApexTrigger:S03_Handler',
  'ApexTrigger:S04_Handler',
  'ApexTrigger:S05_Handler',
];

const crowdedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CROWDED_EVENT,
      type: 'CustomObject',
      apiName: 'Crowded_Event__e',
    }),
    ...CROWDED_TRIGGERS.map((id) =>
      makeNode({
        id,
        type: 'ApexTrigger',
        apiName: id.replace('ApexTrigger:', ''),
      }),
    ),
  ],
  edges: CROWDED_TRIGGERS.map((id) =>
    makeEdge({
      fromId: id,
      toId: CROWDED_EVENT,
      edgeType: 'listensTo',
      source: 'apex-trigger-extractor',
    }),
  ),
};

// =============================================================================
// Seed 4: a Platform Event whose only `listensTo` edge originates from a
// non-subscriber node type (a CustomField). Used to verify the subscriber
// type filter — the CustomField edge must NOT surface as a subscriber.
// =============================================================================

const FILTERED_EVENT = 'CustomObject:Filtered_Event__e';
const NON_SUBSCRIBER = 'CustomField:Account.Whatever__c';

const filteredTypeSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FILTERED_EVENT,
      type: 'CustomObject',
      apiName: 'Filtered_Event__e',
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
      toId: FILTERED_EVENT,
      edgeType: 'listensTo',
      source: 'corrupt-extractor',
    }),
  ],
};

// =============================================================================
// Seed 5 (GROUP C): a Platform Event that is PUBLISHED but has zero
// subscribers — a Flow writesTo the event, nothing listensTo it. Before the
// publishers pass, this event looks orphaned (empty subscribers, no publishers
// surfaced). After: publishers is populated even though subscribers is empty.
// =============================================================================

const ORPHAN_PUB_EVENT = 'CustomObject:Orphan_Published__e';
const ORPHAN_PUB_FLOW = 'Flow:Orphan_Publisher_Flow';
const ORPHAN_PUB_FIELD = 'CustomField:Account.NotAPublisher__c';

const orphanPublishedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ORPHAN_PUB_EVENT,
      type: 'CustomObject',
      apiName: 'Orphan_Published__e',
    }),
    makeNode({
      id: ORPHAN_PUB_FLOW,
      type: 'Flow',
      apiName: 'Orphan_Publisher_Flow',
    }),
    makeNode({
      id: ORPHAN_PUB_FIELD,
      type: 'CustomField',
      apiName: 'Account.NotAPublisher__c',
    }),
  ],
  edges: [
    makeEdge({
      fromId: ORPHAN_PUB_FLOW,
      toId: ORPHAN_PUB_EVENT,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      properties: { operation: 'create', mechanism: 'flow-create-record' },
    }),
    // A non-publisher node-type writesTo edge must be filtered out of publishers.
    makeEdge({
      fromId: ORPHAN_PUB_FIELD,
      toId: ORPHAN_PUB_EVENT,
      edgeType: 'writesTo',
      source: 'corrupt-extractor',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-event-subscribers-'));
  const dbPath = join(tempDir, 'event-subscribers.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    mixedSubscribersSeed,
    singleSubscriberSeed,
    crowdedSeed,
    filteredTypeSeed,
    orphanPublishedSeed,
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

describe('eventSubscribersHandler', () => {
  it('returns all three subscribers for an event with ApexTrigger + ApexClass + Flow listeners', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: ACCOUNT_CHANGE_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.eventApiName).toBe('Account_Change__e');
    expect(d.subscribers.length).toBe(3);
    // Sorted by id ASC.
    const ids = d.subscribers.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain(TRIGGER_HANDLER);
    expect(ids).toContain(APEX_HANDLER);
    expect(ids).toContain(FLOW_HANDLER);
    // Sanity check: source is the extractor, properties from the edge.
    const apexHandler = d.subscribers.find((s) => s.id === APEX_HANDLER);
    expect(apexHandler?.source).toBe('apex-class-extractor');
    expect(apexHandler?.properties['interface']).toBe(
      'Triggerable<Account_Change__e>',
    );
    // vaultState carries the manifest state.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('CR-CAP-18: surfaces publish-side channels with the declared per-member filter (fail-before: no channels field)', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: ACCOUNT_CHANGE_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.channels).toBeDefined();
    expect(d.channels?.length).toBe(1);
    const ch = d.channels?.[0];
    expect(ch?.channelId).toBe(ACCOUNT_CHANNEL);
    expect(ch?.channelType).toBe('event');
    expect(ch?.memberId).toBe(ACCOUNT_MEMBER);
    expect(ch?.filterExpression).toBe("Status__c = 'New'");
    // Honesty: the reworded disclosure states publish-side channel/filter IS
    // extracted (declared), and NO longer claims per-channel filters are
    // unmodeled.
    const boundaryText = d.boundaries.join(' ');
    expect(boundaryText).toContain('Publish-side channel routing');
    expect(boundaryText).toContain('declared');
    expect(boundaryText).not.toMatch(/per-channel filter expressions.*not.*modeled/i);
  });

  it('CR-CAP-18: an event with no channel member returns an empty channels array (empty≠absent)', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: ORDER_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.channels).toEqual([]);
  });

  it('returns a single subscriber for an event with one ApexTrigger listener', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: ORDER_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.eventApiName).toBe('Order_Placed__e');
    expect(d.subscribers.length).toBe(1);
    expect(d.subscribers[0]?.id).toBe(ORDER_TRIGGER);
    expect(d.subscribers[0]?.type).toBe('ApexTrigger');
    expect(d.subscribers[0]?.source).toBe('apex-trigger-extractor');
  });

  it('returns an empty subscribers list (not error) when the event has no listensTo edges', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: 'CustomObject:NoSuchEvent__e',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.subscribers).toEqual([]);
    expect(d.eventApiName).toBe('NoSuchEvent__e');
  });

  it('returns invalid-query when the eventId is not a CustomObject:X__e form', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: 'CustomField:Account.Industry__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('Platform Event');
    expect(result.error.path).toBe('eventId');
  });

  it('returns invalid-query for an id missing the __e suffix', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns invalid-query for the bare CustomObject: prefix', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: 'CustomObject:',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('truncates with stable id-ASC ordering when limit is below the subscriber count', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: CROWDED_EVENT,
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.subscribers.length).toBe(2);
    expect(d.subscribers.map((s) => s.id)).toEqual([
      'ApexTrigger:S01_Handler',
      'ApexTrigger:S02_Handler',
    ]);
  });

  it('filters out non-subscriber node types (e.g. CustomField)', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: FILTERED_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // The CustomField "subscriber" must be filtered out — the v1.5
    // subscriber set is restricted to ApexTrigger / ApexClass / Flow.
    expect(d.subscribers).toEqual([]);
    expect(d.eventApiName).toBe('Filtered_Event__e');
  });

  it('preserves the __e suffix in eventApiName', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: ACCOUNT_CHANGE_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.eventApiName?.endsWith('__e')).toBe(true);
  });

  it('GROUP C: surfaces writesTo publishers (Flow + Apex) in single-event mode (fail-before: no publishers field)', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: ACCOUNT_CHANGE_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.publishers).toBeDefined();
    expect(d.publishers?.length).toBe(2);
    const pubIds = (d.publishers ?? []).map((p) => p.id);
    expect(pubIds).toContain(PUBLISHER_FLOW);
    expect(pubIds).toContain(PUBLISHER_APEX);
    // Sorted by id ASC.
    expect(pubIds).toEqual([...pubIds].sort());
    // Apex publisher carries the edge's operation/mechanism metadata.
    const apexPub = (d.publishers ?? []).find((p) => p.id === PUBLISHER_APEX);
    expect(apexPub?.type).toBe('ApexClass');
    expect(apexPub?.source).toBe('apex-class-extractor');
    expect(apexPub?.properties['operation']).toBe('publish');
    expect(apexPub?.properties['mechanism']).toBe('EventBus.publish');
  });

  it('GROUP C: a published-but-unsubscribed event returns publishers populated with empty subscribers (no longer looks orphaned)', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: ORPHAN_PUB_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.subscribers).toEqual([]);
    expect(d.publishers).toBeDefined();
    // Only the Flow publisher; the CustomField writesTo edge is filtered out.
    expect(d.publishers?.length).toBe(1);
    expect(d.publishers?.[0]?.id).toBe(ORPHAN_PUB_FLOW);
    expect(d.publishers?.[0]?.type).toBe('Flow');
    expect(d.publishers?.[0]?.properties['operation']).toBe('create');
  });

  it('GROUP C: an event with no writesTo publishers returns an empty publishers array (empty≠absent)', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: ORDER_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.publishers).toEqual([]);
  });

  it('catalog mode: omitting eventId lists every Platform Event with subscriber counts (R0791)', async () => {
    const result = await eventSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.eventApiName).toBeNull();
    expect(d.subscribers).toEqual([]);
    expect(Array.isArray(d.events)).toBe(true);
    const events = d.events ?? [];
    for (const e of events) {
      expect(e.eventApiName.endsWith('__e')).toBe(true);
      expect(typeof e.subscriberCount).toBe('number');
    }
    const byName = new Map(events.map((e) => [e.eventApiName, e.subscriberCount]));
    // Account_Change__e has real subscribers; Filtered_Event__e's lone
    // CustomField edge is filtered out (count 0) — same as single-event mode.
    expect((byName.get('Account_Change__e') ?? 0)).toBeGreaterThan(0);
    expect(byName.get('Filtered_Event__e')).toBe(0);
  });

  it('GROUP C catalog mode: each event carries a publisherCount (fail-before: undefined)', async () => {
    const result = await eventSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = result.value.data.events ?? [];
    const byNamePub = new Map(
      events.map((e) => [e.eventApiName, e.publisherCount]),
    );
    // Account_Change__e is published by a Flow + an Apex class (count 2).
    expect(byNamePub.get('Account_Change__e')).toBe(2);
    // Orphan_Published__e is published by one Flow (the CustomField edge is
    // filtered out) yet has zero subscribers.
    expect(byNamePub.get('Orphan_Published__e')).toBe(1);
    // Order_Placed__e has no publishers.
    expect(byNamePub.get('Order_Placed__e')).toBe(0);
  });
});

describe('eventSubscribersInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = eventSubscribersInputSchema.safeParse({
      eventId: 'CustomObject:Whatever__e',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts limit at the upper bound (500)', () => {
    expect(
      eventSubscribersInputSchema.safeParse({
        eventId: 'CustomObject:Whatever__e',
        limit: 500,
      }).success,
    ).toBe(true);
  });

  it('rejects limit > 500', () => {
    expect(
      eventSubscribersInputSchema.safeParse({
        eventId: 'CustomObject:Whatever__e',
        limit: 501,
      }).success,
    ).toBe(false);
  });

  it('rejects limit < 1', () => {
    expect(
      eventSubscribersInputSchema.safeParse({
        eventId: 'CustomObject:Whatever__e',
        limit: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    expect(
      eventSubscribersInputSchema.safeParse({
        eventId: 'CustomObject:Whatever__e',
        limit: 5.5,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty eventId', () => {
    expect(eventSubscribersInputSchema.safeParse({ eventId: '' }).success).toBe(
      false,
    );
  });

  it('accepts a missing eventId (catalog mode — R0791)', () => {
    expect(eventSubscribersInputSchema.safeParse({}).success).toBe(true);
  });
});
