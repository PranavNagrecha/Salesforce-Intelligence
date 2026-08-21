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

import { measureGraphQueries } from './_graph-query-budget.js';

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

// =============================================================================
// Seed 6 (P3b consumer de-dup): a single ApexClass that subscribes to the SAME
// event via BOTH paths — `implements Triggerable<X__e>` (apex-class-extractor)
// AND `EventBus.subscribe('X__e')` (apex-scanner). Two `listensTo` edges land
// on the event from the same node id, carrying DIFFERENT sources (so the edge
// PK does not collapse them). The consumer must de-dup by node id so the class
// appears ONCE in subscribers[] and is counted ONCE in the catalog.
// =============================================================================

const DUP_EVENT = 'CustomObject:Dual_Path__e';
const DUP_CLASS = 'ApexClass:Dual_Path_Handler';

const dualPathSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: DUP_EVENT,
      type: 'CustomObject',
      apiName: 'Dual_Path__e',
    }),
    makeNode({
      id: DUP_CLASS,
      type: 'ApexClass',
      apiName: 'Dual_Path_Handler',
    }),
  ],
  edges: [
    makeEdge({
      fromId: DUP_CLASS,
      toId: DUP_EVENT,
      edgeType: 'listensTo',
      confidence: 'declared',
      source: 'apex-class-extractor',
      properties: { mechanism: 'implementsTriggerable', eventName: 'Dual_Path__e' },
    }),
    makeEdge({
      fromId: DUP_CLASS,
      toId: DUP_EVENT,
      edgeType: 'listensTo',
      confidence: 'heuristic',
      source: 'apex-scanner',
      properties: { mechanism: 'eventBusSubscribe' },
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
    dualPathSeed,
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

  // ===========================================================================
  // EVENT-SUBSCRIBERS-SILENTLY-IGNORES-EVENTAPINAME guards. Pre-fix these FAIL:
  // an apiName-shaped call was Zod-stripped and fell through to CATALOG mode
  // (empty top-level publishers/channels, eventApiName null), so publishers only
  // appeared when the host already knew the canonical CustomObject id.
  // ===========================================================================

  it('resolves eventApiName to the same DETAIL payload as the canonical eventId', async () => {
    const viaApiName = await eventSubscribersHandler(ctx, {
      eventApiName: 'Account_Change__e',
    });
    const viaEventId = await eventSubscribersHandler(ctx, {
      eventId: ACCOUNT_CHANGE_EVENT,
    });
    expect(viaApiName.ok && viaEventId.ok).toBe(true);
    if (!viaApiName.ok || !viaEventId.ok) return;
    const a = viaApiName.value.data;
    const b = viaEventId.value.data;
    // DETAIL mode, not catalog: eventApiName echoed, events absent.
    expect(a.eventApiName).toBe('Account_Change__e');
    expect(a.events).toBeUndefined();
    // Same subscribers, publishers, and channels as the canonical id call.
    expect(a.subscribers.map((s) => s.id)).toEqual(
      b.subscribers.map((s) => s.id),
    );
    expect((a.publishers ?? []).map((p) => p.id)).toEqual(
      (b.publishers ?? []).map((p) => p.id),
    );
    expect(a.publishers?.length).toBe(2);
    expect((a.channels ?? []).map((c) => c.memberId)).toEqual(
      (b.channels ?? []).map((c) => c.memberId),
    );
  });

  it('does NOT fall through to catalog mode when only eventApiName is supplied', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventApiName: 'Account_Change__e',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Catalog mode would set eventApiName:null + a populated events[].
    expect(result.value.data.eventApiName).not.toBeNull();
    expect(result.value.data.events).toBeUndefined();
  });

  it('accepts eventApiName already carrying the CustomObject: prefix', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventApiName: ACCOUNT_CHANGE_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.eventApiName).toBe('Account_Change__e');
  });

  it('invalid-query on a non-event eventApiName (not a silent empty)', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventApiName: 'Account.Industry__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('eventApiName');
  });

  it('eventId wins when both eventId and eventApiName are supplied', async () => {
    const result = await eventSubscribersHandler(ctx, {
      eventId: ACCOUNT_CHANGE_EVENT,
      eventApiName: 'Order_Placed__e',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.eventApiName).toBe('Account_Change__e');
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

  it('Bug 9: publisher description is surfaced from node properties when present', async () => {
    // The publisher node carries a `description` in its node properties.
    // Before the fix, `EventPublisher` had no `description` field and
    // resolvePublisher did not read node.properties['description'].
    // After the fix, description is present on the publisher object and
    // matches the value stored on the node.
    const DESCRIBED_EVENT = 'CustomObject:Described__e';
    const DESCRIBED_PUBLISHER = 'Flow:AcmeCo_Publisher_Flow';
    const describedSeed: ExtractionResult = {
      nodes: [
        makeNode({ id: DESCRIBED_EVENT, type: 'CustomObject', apiName: 'Described__e' }),
        makeNode({
          id: DESCRIBED_PUBLISHER,
          type: 'Flow',
          apiName: 'AcmeCo_Publisher_Flow',
          properties: {
            description: 'Publishes an event when AcmeCo Account status changes.',
          },
        }),
      ],
      edges: [
        makeEdge({
          fromId: DESCRIBED_PUBLISHER,
          toId: DESCRIBED_EVENT,
          edgeType: 'writesTo',
          source: 'flow-extractor',
          properties: { operation: 'publish' },
        }),
      ],
    };
    // Create a fresh in-memory graph for this test to avoid polluting the shared store.
    const tmpD = mkdtempSync(join(tmpdir(), 'sfi-pub-desc-'));
    try {
      const { join: pathJoin } = await import('node:path');
      const openedD = await openGraph(pathJoin(tmpD, 'desc.db'));
      if (!openedD.ok) throw new Error(openedD.error.message);
      const storeD = openedD.value;
      const imp = await importExtractionResults(storeD, [describedSeed]);
      if (!imp.ok) throw new Error(imp.error.message);
      const ctxD: Context = { vaultRoot: tmpD, manifest: FIXTURE_MANIFEST, graph: storeD };
      const result = await eventSubscribersHandler(ctxD, { eventId: DESCRIBED_EVENT });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const publishers = result.value.data.publishers ?? [];
      expect(publishers.length).toBe(1);
      const pub = publishers[0];
      expect(pub?.id).toBe(DESCRIBED_PUBLISHER);
      // description must be surfaced from the node's properties.
      expect(pub?.description).toBe('Publishes an event when AcmeCo Account status changes.');
      await closeGraph(storeD);
    } finally {
      rmSync(tmpD, { recursive: true, force: true });
    }
  });

  it('Bug 9: publisher description is null when node has no description property', async () => {
    // Publisher nodes without a description property must return description: null,
    // not undefined or a stale property from the edge properties.
    const result = await eventSubscribersHandler(ctx, {
      eventId: ACCOUNT_CHANGE_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const publishers = result.value.data.publishers ?? [];
    // PUBLISHER_FLOW and PUBLISHER_APEX nodes have no description in their node properties.
    for (const pub of publishers) {
      expect(pub.description).toBeNull();
    }
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

  it('P3b: de-dups a class subscribing via BOTH Triggerable AND EventBus.subscribe to ONE subscriber', async () => {
    const result = await eventSubscribersHandler(ctx, { eventId: DUP_EVENT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const subs = result.value.data.subscribers;
    // Two listensTo edges (different sources, both surviving the edge PK) must
    // collapse to ONE subscriber entry for the same node id.
    expect(subs.filter((s) => s.id === DUP_CLASS)).toHaveLength(1);
    expect(subs).toHaveLength(1);
  });

  it('P3b: catalog counts a dual-path subscriber ONCE, not twice', async () => {
    const result = await eventSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = result.value.data.events ?? [];
    const dual = events.find((e) => e.eventApiName === 'Dual_Path__e');
    expect(dual?.subscriberCount).toBe(1);
  });

  it('P3b: disclosure states EventBus.subscribe IS recognized heuristically (static channel only)', async () => {
    const result = await eventSubscribersHandler(ctx, { eventId: DUP_EVENT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.value.data.boundaries.join(' ');
    // Reworded: subscribe is recognized; dynamic args + managed pkgs invisible.
    expect(text).toMatch(/EventBus\.subscribe is now recognized heuristically/i);
    expect(text).toMatch(/dynamic/i);
    // Must NOT still claim EventBus.subscribe is NOT modeled.
    expect(text).not.toMatch(/EventBus\.subscribe\([^)]*\)[^.]*are NOT modeled/i);
  });

  it('P3b: empty-event disclosure also reflects the heuristic-subscribe rewording', async () => {
    const result = await eventSubscribersHandler(ctx, { eventId: ORDER_EVENT });
    // Order_Placed__e has a subscriber, so use a truly-empty event instead:
    const empty = await eventSubscribersHandler(ctx, {
      eventId: 'CustomObject:Nonexistent_Empty__e',
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(result.ok).toBe(true);
    const text = empty.value.data.boundaries.join(' ');
    expect(text).toMatch(/EventBus\.subscribe is now recognized heuristically/i);
    expect(text).toMatch(/NOT proof nothing subscribes/i);
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

// =============================================================================
// CR-10: Publisher-vs-subscriber role-disambiguation disclosure
// The product previously confused a Flow that PUBLISHES an event (writesTo
// edge) with one that SUBSCRIBES (listensTo edge). The fix adds an explicit
// CRITICAL ROLE DISTINCTION boundary in both the non-empty and empty-subscriber
// paths so an LLM reading the response cannot conflate the two roles.
// =============================================================================
describe('eventSubscribersHandler — CR-10 role-disambiguation disclosure', () => {
  it('CR-10: single-event with subscribers includes role-disambiguation disclosure in boundaries', async () => {
    // Account_Change__e has 3 subscribers AND 2 publishers in the fixture.
    // Before the fix, boundaries did NOT contain the CRITICAL ROLE DISTINCTION
    // message. After the fix, it must be present in both populated-subscribers
    // and empty-subscribers paths.
    const result = await eventSubscribersHandler(ctx, {
      eventId: ACCOUNT_CHANGE_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaryText = result.value.data.boundaries.join(' ');
    // Key phrase from EVENT_SUB_ROLE_DISAMBIGUATION_DISCLOSURE.
    expect(boundaryText).toContain('CRITICAL ROLE DISTINCTION');
    expect(boundaryText).toContain('EMITS');
    expect(boundaryText).toContain('RECEIVES');
    // The disclosure must explicitly call out that a Flow with recordCreates
    // is a publisher, NOT a subscriber.
    expect(boundaryText).toContain('PUBLISHER');
    expect(boundaryText).toContain('publishers');
    expect(boundaryText).toContain('subscribers');
  });

  it('CR-10: single-event with NO subscribers also includes role-disambiguation disclosure', async () => {
    // Orphan_Published__e has publishers but zero subscribers — the empty-
    // subscriber boundary path must also carry the disambiguation message.
    const result = await eventSubscribersHandler(ctx, {
      eventId: ORPHAN_PUB_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.subscribers).toHaveLength(0);
    const boundaryText = result.value.data.boundaries.join(' ');
    expect(boundaryText).toContain('CRITICAL ROLE DISTINCTION');
    expect(boundaryText).toContain('EMITS');
    expect(boundaryText).toContain('RECEIVES');
  });

  it('CR-10: role-disambiguation disclosure is present even when publishers list is empty', async () => {
    // Order_Placed__e has 1 subscriber and 0 publishers — both arrays are
    // opposite-empty from the orphan case. The disclosure must still be there.
    const result = await eventSubscribersHandler(ctx, {
      eventId: ORDER_EVENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.publishers).toEqual([]);
    const boundaryText = result.value.data.boundaries.join(' ');
    expect(boundaryText).toContain('CRITICAL ROLE DISTINCTION');
  });
});

// =============================================================================
// N+1 query budget (finding C-1). Catalog mode used a per-event listEdges +
// per-subscriber / per-publisher getNodeById org-wide nested N+1; it is now
// three round-trips total (listensTo batch + writesTo batch + one node batch).
// The query count must NOT scale with the event count. Plus a golden asserting
// the DISTINCT-subscriber dedup and the per-EDGE publisher count are unchanged.
// =============================================================================
describe('eventSubscribersHandler — bounded graph queries (catalog)', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context, s: GraphStore) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-evsub-budget-'));
    const opened = await openGraph(join(dir, 'evsub.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const out = await run(localCtx, s);
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  // Ev1__e: Sub1 subscribes via TWO edges (distinct sources) -> deduped to 1;
  //         Sub2 (Flow) subscribes; a CustomField listensTo is filtered out.
  //         Pub1 publishes via TWO writesTo edges -> per-EDGE count = 2.
  // Ev2__e: nothing.
  const goldenSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'CustomObject:Ev1__e', apiName: 'Ev1__e' }),
      makeNode({ id: 'CustomObject:Ev2__e', apiName: 'Ev2__e' }),
      makeNode({ id: 'ApexClass:Sub1', type: 'ApexClass', apiName: 'Sub1' }),
      makeNode({ id: 'Flow:Sub2', type: 'Flow', apiName: 'Sub2' }),
      makeNode({ id: 'CustomField:Account.NotASub', type: 'CustomField', apiName: 'NotASub' }),
      makeNode({ id: 'ApexClass:Pub1', type: 'ApexClass', apiName: 'Pub1' }),
    ],
    edges: [
      makeEdge({ fromId: 'ApexClass:Sub1', toId: 'CustomObject:Ev1__e', edgeType: 'listensTo', source: 'triggerable' }),
      makeEdge({ fromId: 'ApexClass:Sub1', toId: 'CustomObject:Ev1__e', edgeType: 'listensTo', source: 'eventbus' }),
      makeEdge({ fromId: 'Flow:Sub2', toId: 'CustomObject:Ev1__e', edgeType: 'listensTo', source: 'flow' }),
      makeEdge({ fromId: 'CustomField:Account.NotASub', toId: 'CustomObject:Ev1__e', edgeType: 'listensTo', source: 'stray' }),
      makeEdge({ fromId: 'ApexClass:Pub1', toId: 'CustomObject:Ev1__e', edgeType: 'writesTo', source: 'publish-a' }),
      makeEdge({ fromId: 'ApexClass:Pub1', toId: 'CustomObject:Ev1__e', edgeType: 'writesTo', source: 'publish-b' }),
    ],
  };

  it('golden: catalog subscriber-dedup + per-edge publisher count unchanged', async () => {
    const result = await withStore(goldenSeed, (localCtx) =>
      eventSubscribersHandler(localCtx, {}),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.events).toEqual([
      { eventId: 'CustomObject:Ev1__e', eventApiName: 'Ev1__e', subscriberCount: 2, publisherCount: 2 },
      { eventId: 'CustomObject:Ev2__e', eventApiName: 'Ev2__e', subscriberCount: 0, publisherCount: 0 },
    ]);
  });

  const seedManyEvents = (count: number): ExtractionResult => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < count; i += 1) {
      nodes.push(makeNode({ id: `CustomObject:Ev${i}__e`, apiName: `Ev${i}__e` }));
      nodes.push(makeNode({ id: `ApexClass:Sub${i}`, type: 'ApexClass', apiName: `Sub${i}` }));
      edges.push(makeEdge({ fromId: `ApexClass:Sub${i}`, toId: `CustomObject:Ev${i}__e`, edgeType: 'listensTo' }));
    }
    return { nodes, edges };
  };

  it('query count does NOT scale with the event count', async () => {
    const measure = (count: number) =>
      withStore(seedManyEvents(count), (localCtx, s) =>
        measureGraphQueries(s, () => eventSubscribersHandler(localCtx, {})),
      );
    const few = await measure(60);
    const many = await measure(200);
    expect(few.result.ok).toBe(true);
    expect(many.result.ok).toBe(true);
    // Three round-trips total (listensTo batch + writesTo batch + node batch);
    // the CustomObject scan adds a constant. An N+1 would be ~2 * event count.
    expect(many.edgeQueries).toBe(few.edgeQueries);
    expect(many.nodeQueries).toBe(few.nodeQueries);
    expect(many.edgeQueries + many.nodeQueries).toBeLessThan(10);
  });

  // Single-event mode (J2): the subscriber resolution loop, resolvePublishers,
  // and resolveChannelBindings all batched. Query count must NOT scale with one
  // event's subscriber / publisher / channel-member fan-out.
  const seedWideEvent = (fanOut: number): ExtractionResult => {
    const EVENT = 'CustomObject:Wide__e';
    const nodes: Node[] = [makeNode({ id: EVENT, apiName: 'Wide__e' })];
    const edges: Edge[] = [];
    for (let i = 0; i < fanOut; i += 1) {
      nodes.push(makeNode({ id: `ApexClass:Sub${i}`, type: 'ApexClass', apiName: `Sub${i}` }));
      edges.push(makeEdge({ fromId: `ApexClass:Sub${i}`, toId: EVENT, edgeType: 'listensTo' }));
      nodes.push(makeNode({ id: `Flow:Pub${i}`, type: 'Flow', apiName: `Pub${i}` }));
      edges.push(makeEdge({ fromId: `Flow:Pub${i}`, toId: EVENT, edgeType: 'writesTo' }));
    }
    return { nodes, edges };
  };

  it('single-event query count does NOT scale with subscriber/publisher fan-out', async () => {
    const measure = (fanOut: number) =>
      withStore(seedWideEvent(fanOut), (localCtx, s) =>
        measureGraphQueries(s, () =>
          eventSubscribersHandler(localCtx, { eventId: 'CustomObject:Wide__e', limit: 500 }),
        ),
      );
    const narrow = await measure(60);
    const wide = await measure(200);
    expect(narrow.result.ok).toBe(true);
    expect(wide.result.ok).toBe(true);
    // Constant: listensTo/writesTo/references edge fetches + a couple of node
    // batches — independent of fan-out. An N+1 would be ~fan-out.
    expect(wide.edgeQueries).toBe(narrow.edgeQueries);
    expect(wide.nodeQueries).toBe(narrow.nodeQueries);
    expect(wide.edgeQueries + wide.nodeQueries).toBeLessThan(10);
  });
});

// =============================================================================
// EVENT-SUBSCRIBERS-CANNOT-SEE-UNRETRIEVED-EVENTS
//
// `validateEventId` is a pure `__e`-SUFFIX SYNTAX check, so single-event mode
// went straight from "the id looks like an event" to `listEdges` — and answered
// "no subscribers found for this event" for a Platform Event this org's own
// metadata NAMES but never retrieved (a managed-package event, or one outside
// the retrieve scope). That is "did not check" rendered as "checked and found
// nothing". Catalog mode had the matching defect at inventory scale: it listed
// only RETRIEVED events, with no statement that others are referenced.
// =============================================================================

describe('eventSubscribersHandler — retrieval state is separate from subscription', () => {
  const PHANTOM_EVENT = 'CustomObject:pkg__Vendor_Signal__e';
  const RETRIEVED_EVENT = 'CustomObject:Local_Signal__e';

  /**
   * Mirrors a real vault: one retrieved event node, plus a second event that
   * exists ONLY as an edge target (a permission grant naming it), exactly as a
   * managed-package event appears after a wildcard retrieve.
   */
  const phantomSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: RETRIEVED_EVENT, apiName: 'Local_Signal__e' }),
      makeNode({ id: 'ApexClass:LocalSignalHandler', type: 'ApexClass', apiName: 'LocalSignalHandler' }),
      makeNode({ id: 'PermissionSet:Integration', type: 'PermissionSet', apiName: 'Integration' }),
    ],
    edges: [
      makeEdge({
        fromId: 'ApexClass:LocalSignalHandler',
        toId: RETRIEVED_EVENT,
        edgeType: 'listensTo',
        source: 'apex-class-extractor',
      }),
      // The phantom's ONLY trace: a grant that names it. No node is ever created.
      makeEdge({
        fromId: 'PermissionSet:Integration',
        toId: PHANTOM_EVENT,
        edgeType: 'grantedBy',
        source: 'permission-set-extractor',
      }),
    ],
  };

  let dir: string;
  let s: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-evsub-phantom-'));
    const opened = await openGraph(join(dir, 'evsub.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    s = opened.value;
    const imported = await importExtractionResults(s, [phantomSeed]);
    if (!imported.ok) throw new Error(imported.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
  });
  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: a referenced-but-unretrieved event reports NOT RETRIEVED, not "no subscribers"', async () => {
    const result = await eventSubscribersHandler(localCtx, { eventId: PHANTOM_EVENT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Still `ok` and still returns the edge-derived lists — a subscriber's edge
    // can exist even when the event node does not, so refusing would lose data.
    expect(result.value.data.eventRetrieved).toBe(false);
    // The not-retrieved verdict must be read BEFORE any subscriber statement.
    expect(result.value.data.boundaries[0]).toMatch(/EVENT NOT IN THIS VAULT/);
    expect(result.value.data.boundaries[0]).toMatch(/never retrieved/i);
  });

  it('a RETRIEVED event carries no retrieval flag and no extra boundary (unchanged response)', async () => {
    const result = await eventSubscribersHandler(localCtx, { eventId: RETRIEVED_EVENT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Absent, not `true` — the key must not appear at all on the healthy path.
    expect('eventRetrieved' in result.value.data).toBe(false);
    expect(result.value.data.boundaries.some((b) => b.includes('EVENT NOT IN THIS VAULT'))).toBe(false);
    expect(result.value.data.subscribers).toHaveLength(1);
  });

  it('catalog mode counts the events it could NOT list, so a partial inventory cannot pass for the whole', async () => {
    const result = await eventSubscribersHandler(localCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // INVARIANT: retrieved + referenced-not-retrieved accounts for every `__e`
    // id the graph knows about — the listed slice is never the whole story.
    expect(data.events?.map((e) => e.eventId)).toEqual([RETRIEVED_EVENT]);
    expect(data.referencedNotRetrievedEventCount).toBe(1);
    expect(data.referencedNotRetrievedEvents).toEqual([PHANTOM_EVENT]);
    expect(data.boundaries.some((b) => b.includes('PARTIAL INVENTORY'))).toBe(true);
  });

  it('a vault whose every event IS retrieved emits no partial-inventory fields', async () => {
    const cleanSeed: ExtractionResult = {
      nodes: [makeNode({ id: RETRIEVED_EVENT, apiName: 'Local_Signal__e' })],
      edges: [],
    };
    const cleanDir = mkdtempSync(join(tmpdir(), 'sfi-evsub-clean-'));
    const opened = await openGraph(join(cleanDir, 'evsub.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const cleanStore = opened.value;
    const imported = await importExtractionResults(cleanStore, [cleanSeed]);
    if (!imported.ok) throw new Error(imported.error.message);
    const cleanCtx = { vaultRoot: cleanDir, manifest: FIXTURE_MANIFEST, graph: cleanStore } as Context;

    const result = await eventSubscribersHandler(cleanCtx, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('referencedNotRetrievedEventCount' in result.value.data).toBe(false);
      // Assert the ABSENCE of the partial-inventory line, not the LENGTH of the
      // boundaries array. A count pin here is a tripwire for every unrelated
      // catalog-mode disclosure: LANE-E's CATALOG SCOPE line is emitted on this
      // same path and is correct, and it broke this pin the moment the two lanes
      // merged even though neither lane failed alone.
      const text = result.value.data.boundaries.join(' ');
      expect(text).not.toContain('PARTIAL INVENTORY');
      expect(text).toContain('CATALOG SCOPE');
    }
    await closeGraph(cleanStore);
    rmSync(cleanDir, { recursive: true, force: true });
  });
});

describe('event_subscribers — catalog mode declares its own scope (LANE-E)', () => {
  it('catalog mode says it covers neither CDC nor referenced-but-not-retrieved events', async () => {
    const result = await eventSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.value.data.boundaries.join(' ');
    expect(text).toContain('CATALOG SCOPE');
    expect(text).toContain('Change Data Capture');
    expect(text).toContain('sfi.event_topology');
  });

  it('single-event mode does NOT carry the catalog-scope line (byte-identical path)', async () => {
    const result = await eventSubscribersHandler(ctx, { eventId: ORDER_EVENT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.boundaries.join(' ')).not.toContain('CATALOG SCOPE');
  });
});
