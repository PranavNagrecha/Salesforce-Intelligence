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

// =============================================================================
// Seed 5 (CDC-SUBSCRIBERS-OMITS-CHANNEL-MEMBERSHIP guard): a CDC `data` channel
// whose member selects ContactChangeEvent with ZERO listensTo subscribers. The
// ChangeEvent CustomObject node is deliberately ABSENT (a stub/missing target,
// as in an offline vault) — membership must still surface. Contact is a generic
// standard object, not an org identifier.
// =============================================================================

const CDC_DATA_CHANNEL = 'PlatformEventChannel:ChangeEvents__chn';
const CONTACT_CDC_MEMBER = 'PlatformEventChannelMember:ChangeEvents_ContactChangeEvent';
const CONTACT_CDC_EVENT = 'CustomObject:ContactChangeEvent';
const CONTACT_CDC_FILTER = "City = 'SF'";

const contactCdcMembershipSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CDC_DATA_CHANNEL,
      type: 'PlatformEventChannel',
      apiName: 'ChangeEvents__chn',
      properties: { channelType: 'data', label: 'Change Events' },
    }),
    makeNode({
      id: CONTACT_CDC_MEMBER,
      type: 'PlatformEventChannelMember',
      apiName: 'ChangeEvents_ContactChangeEvent',
      parentId: CDC_DATA_CHANNEL,
      properties: {
        eventChannel: 'ChangeEvents__chn',
        selectedEntity: 'ContactChangeEvent',
        filterExpression: CONTACT_CDC_FILTER,
      },
    }),
    // NB: no CustomObject:ContactChangeEvent node — target is a stub/missing.
  ],
  edges: [
    makeEdge({
      fromId: CDC_DATA_CHANNEL,
      toId: CONTACT_CDC_MEMBER,
      edgeType: 'parentOf',
      source: 'platform-event-channel-extractor',
    }),
    makeEdge({
      fromId: CONTACT_CDC_MEMBER,
      toId: CONTACT_CDC_EVENT,
      edgeType: 'references',
      source: 'platform-event-channel-extractor',
      properties: {
        referenceKind: 'platformEventChannelMember',
        filterExpression: CONTACT_CDC_FILTER,
      },
    }),
  ],
};

// =============================================================================
// Seed 5b (CDC-SUBSCRIBERS-UNRESOLVED-OBJECT-SCOPE): bare base-object nodes for
// every sObject the tests below scope by. A real vault retrieves the object's
// own CustomObject metadata separately from its (never-retrievable) Change
// Event — these fixtures previously omitted that node entirely because the
// subscriber-detection tests didn't need it, but the object-scope existence
// check now does. `NonExistentObject` / `Zzz_...` are deliberately NOT added
// here — they must stay absent from every vault in this file.
// =============================================================================

const baseObjectSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
    makeNode({ id: 'CustomObject:Lead', type: 'CustomObject', apiName: 'Lead' }),
    makeNode({ id: 'CustomObject:Order__c', type: 'CustomObject', apiName: 'Order__c' }),
  ],
  edges: [],
};

// =============================================================================
// Seed 6: an EVENT channel (channelType 'event') whose member selects a Platform
// Event (Order_Placed__e), NOT a ChangeEvent. It must NOT surface as a CDC
// channel member — the CDC discriminator is the ChangeEvent name pattern.
// =============================================================================

const EVENT_CHANNEL = 'PlatformEventChannel:AppStream__chn';
const EVENT_CHANNEL_MEMBER = 'PlatformEventChannelMember:AppStream_OrderPlaced';

const eventChannelSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: EVENT_CHANNEL,
      type: 'PlatformEventChannel',
      apiName: 'AppStream__chn',
      properties: { channelType: 'event', label: 'App Stream' },
    }),
    makeNode({
      id: EVENT_CHANNEL_MEMBER,
      type: 'PlatformEventChannelMember',
      apiName: 'AppStream_OrderPlaced',
      parentId: EVENT_CHANNEL,
      properties: {
        eventChannel: 'AppStream__chn',
        selectedEntity: 'Order_Placed__e',
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: EVENT_CHANNEL,
      toId: EVENT_CHANNEL_MEMBER,
      edgeType: 'parentOf',
      source: 'platform-event-channel-extractor',
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
    contactCdcMembershipSeed,
    eventChannelSeed,
    baseObjectSeed,
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

  // CDC-SUBSCRIBERS-UNRESOLVED-OBJECT-SCOPE: this used to "answer" a scope
  // naming an object absent from the vault with a checked-looking empty
  // result — the exact honesty defect the fix below closes. See the dedicated
  // "object scope honesty" describe block for the FAIL-BEFORE/PASS-AFTER pin.
  it('refuses a sObjectFilter absent from the vault (never a silent empty answer)', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'NonExistentObject',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
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

  // ===========================================================================
  // CDC-SUBSCRIBERS-OMITS-CHANNEL-MEMBERSHIP guards. Pre-fix these FAIL: the
  // tool composed only `listensTo`, so a CDC-enabled object with no code
  // subscriber returned totalSubscribers:0 with NO channelMembers section, and
  // `objectApiName` was silently stripped.
  // ===========================================================================

  it('surfaces CDC channel membership for an enabled-but-unsubscribed object (Contact)', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'Contact',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // Zero code subscribers, but CDC IS enabled via the channel member.
    expect(d.subscribers).toEqual([]);
    expect(d.summary.totalSubscribers).toBe(0);
    expect(d.channelMembers).toHaveLength(1);
    const m = d.channelMembers[0];
    expect(m?.memberId).toBe(CONTACT_CDC_MEMBER);
    expect(m?.channelId).toBe(CDC_DATA_CHANNEL);
    expect(m?.channelType).toBe('data');
    expect(m?.selectedEntity).toBe('ContactChangeEvent');
    expect(m?.changeEventName).toBe('ContactChangeEvent');
    expect(m?.filterExpression).toBe(CONTACT_CDC_FILTER);
    // uniqueChangeEvents must count the enabled event, not only subscribed ones.
    expect(d.summary.totalChannelMembers).toBe(1);
    expect(d.summary.uniqueChangeEvents).toBe(1);
    // Disclosure makes "enabled, no modeled subscriber" explicit.
    expect(d.disclosure).toContain('enabled, no modeled subscriber');
  });

  it('accepts objectApiName as a synonym for sObjectFilter (no silent strip)', async () => {
    const viaAlias = await cdcSubscribersHandler(ctx, {
      objectApiName: 'Contact',
    });
    const viaFilter = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'Contact',
    });
    expect(viaAlias.ok && viaFilter.ok).toBe(true);
    if (!viaAlias.ok || !viaFilter.ok) return;
    // The alias must NOT degrade to the org-wide scan.
    expect(viaAlias.value.data.channelMembers).toHaveLength(1);
    expect(viaAlias.value.data.channelMembers[0]?.memberId).toBe(
      CONTACT_CDC_MEMBER,
    );
    expect(viaAlias.value.data.summary.uniqueChangeEvents).toBe(
      viaFilter.value.data.summary.uniqueChangeEvents,
    );
  });

  it('excludes event-channel members (Platform Events) from CDC membership', async () => {
    const result = await cdcSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.channelMembers.map((m) => m.memberId);
    // The Contact CDC member surfaces org-wide...
    expect(ids).toContain(CONTACT_CDC_MEMBER);
    // ...but the Order_Placed__e event-channel member must NOT (not a ChangeEvent).
    expect(ids).not.toContain(EVENT_CHANNEL_MEMBER);
  });

  it('scopes channel membership to the requested object', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Account CDC has code subscribers but no channel member in the fixture.
    expect(result.value.data.channelMembers).toEqual([]);
    expect(result.value.data.summary.totalChannelMembers).toBe(0);
    // The Contact member must not leak into an Account-scoped call.
    expect(result.value.data.subscribers.length).toBe(3);
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

// =============================================================================
// CDC-SUBSCRIBERS-SCANS-NOTHING-AND-REPORTS-ZERO
//
// The fixtures above seed a ChangeEvent NODE. A real org never has one: the
// platform synthesises `{X}ChangeEvent` and the Metadata API emits no component
// for it, so it exists ONLY as a dangling edge target. Two consequences the
// fixtures hid:
//
//   1. Org-wide mode built its scan set from `listNodesByType('CustomObject')`,
//      which on a real vault yields ZERO ChangeEvents — so it checked nothing
//      and still reported `totalSubscribers: 0`.
//   2. An APEX CDC TRIGGER emits `triggersOn`, never `listensTo` (the trigger
//      extractor gates `listensTo` on the `__e` suffix), so reading only
//      `listensTo` made every Apex CDC trigger invisible.
//
// These fixtures use the REAL shape — dangling ChangeEvent targets, no node.
// =============================================================================

const REAL_SHAPE_EVENT = 'CustomObject:ContactChangeEvent';
const REAL_SHAPE_TRIGGER = 'ApexTrigger:ContactChangeCdcHandler';

/**
 * Exactly what `apex-trigger.ts` produces for
 * `trigger ContactChangeCdcHandler on ContactChangeEvent (after insert)`:
 * a `triggersOn` edge into a target that is NOT and can never be a node.
 */
const realShapeCdcSeed: ExtractionResult = {
  nodes: [
    // The base object node — the object-scope existence check resolves
    // against THIS, not against the (never-retrievable) ChangeEvent.
    makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
    makeNode({
      id: REAL_SHAPE_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'ContactChangeCdcHandler',
    }),
  ],
  edges: [
    makeEdge({
      fromId: REAL_SHAPE_TRIGGER,
      toId: REAL_SHAPE_EVENT,
      edgeType: 'triggersOn',
      source: 'apex-trigger-extractor',
    }),
  ],
};

const withCdcStore = async <T>(
  seedData: ExtractionResult,
  run: (ctx: Context) => Promise<T>,
): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), 'sfi-cdc-real-'));
  const opened = await openGraph(join(dir, 'cdc.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  const store = opened.value;
  const imported = await importExtractionResults(store, [seedData]);
  if (!imported.ok) throw new Error(imported.error.message);
  const out = await run({ vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store } as Context);
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
  return out;
};

describe('cdcSubscribersHandler — real-org shape (ChangeEvent is never a node)', () => {
  it('FAIL-BEFORE/PASS-AFTER: org-wide mode finds an Apex CDC trigger that has only a triggersOn edge', async () => {
    const result = await withCdcStore(realShapeCdcSeed, (c) => cdcSubscribersHandler(c, {}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.subscribers.map((s) => s.subscriberId)).toEqual([REAL_SHAPE_TRIGGER]);
    // The row must SAY which mechanism found it — a `listensTo` row is untagged.
    expect(data.subscribers[0]?.subscriptionEdge).toBe('triggersOn');
    expect(data.subscribers[0]?.changeEventName).toBe('ContactChangeEvent');
    // The stream WAS walked, so `0` and `1` are now distinguishable answers.
    expect(data.summary.scannedChangeEvents).toBeGreaterThan(0);
    expect(data.summary.uniqueChangeEvents).toBe(1);
  });

  it('scoped mode finds the same trigger through the object filter', async () => {
    const result = await withCdcStore(realShapeCdcSeed, (c) =>
      cdcSubscribersHandler(c, { sObjectFilter: 'Contact' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.subscribers.map((s) => s.subscriberId)).toEqual([REAL_SHAPE_TRIGGER]);
  });

  it('a `listensTo` subscriber row stays untagged, so the two mechanisms are tellable apart', async () => {
    const result = await withCdcStore(accountCdcSeed, (c) => cdcSubscribersHandler(c, {}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const sub of result.value.data.subscribers) {
      expect('subscriptionEdge' in sub).toBe(false);
    }
  });

  it('an empty scan set says NOTHING WAS CHECKED rather than reporting a bare zero', async () => {
    const emptySeed: ExtractionResult = {
      nodes: [makeNode({ id: 'CustomObject:Account', apiName: 'Account' })],
      edges: [],
    };
    const result = await withCdcStore(emptySeed, (c) => cdcSubscribersHandler(c, {}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // The distinction the old response could not express: 0 found AND 0 checked.
    expect(data.summary.totalSubscribers).toBe(0);
    expect(data.summary.scannedChangeEvents).toBe(0);
    expect(data.disclosure).toMatch(/nothing was scanned/i);
    expect(data.disclosure).toMatch(/`scannedChangeEvents` is 0/);
  });

  it('the nothing-scanned note is ABSENT once a stream was actually walked', async () => {
    const result = await withCdcStore(realShapeCdcSeed, (c) => cdcSubscribersHandler(c, {}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.summary.scannedChangeEvents).toBeGreaterThan(0);
    expect(result.value.data.disclosure).not.toMatch(/nothing was scanned/i);
  });

  it('a scoped miss says the stream is referenced by nothing, not that CDC was checked and unused', async () => {
    // Lead is a REAL, modeled object here (unlike a fabricated scope) — it
    // simply has zero CDC footprint. That is what this test pins: an existing
    // object with no CDC usage still gets the "nothing referenced" honest
    // disclosure, distinct from the hard refusal a nonexistent object gets.
    const emptySeed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Account', apiName: 'Account' }),
        makeNode({ id: 'CustomObject:Lead', apiName: 'Lead' }),
      ],
      edges: [],
    };
    const result = await withCdcStore(emptySeed, (c) =>
      cdcSubscribersHandler(c, { sObjectFilter: 'Lead' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('LeadChangeEvent');
    expect(result.value.data.disclosure).toMatch(/NOT "CDC checked and unused"/);
  });
});

// =============================================================================
// CDC-SUBSCRIBERS-UNRESOLVED-OBJECT-SCOPE. Pre-fix, `sObjectFilter` /
// `objectApiName` was glued straight into a synthetic ChangeEvent id with no
// check that the underlying sObject exists — a made-up (or merely wrong-case)
// object name silently produced `{totalSubscribers: 0}` with a "nothing
// referenced" disclosure that READ like a checked answer but was never
// grounded in a real object. Fixed by resolving the base entity through the
// shared `resolveExistingObjectScope` before deriving the ChangeEvent name.
// =============================================================================

describe('cdcSubscribersHandler — object scope honesty', () => {
  it('FAIL-BEFORE/PASS-AFTER: refuses a sObjectFilter absent from the vault, never a silent zero', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      sObjectFilter: 'Zzz_Nonexistent_Object_9x7__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toMatch(/no object named 'Zzz_Nonexistent_Object_9x7__c'/i);
  });

  it('refuses the same way via the objectApiName alias', async () => {
    const result = await cdcSubscribersHandler(ctx, {
      objectApiName: 'Zzz_Nonexistent_Object_9x7__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('a real object typed in the wrong case still answers, corrected to the vault casing', async () => {
    const lower = await cdcSubscribersHandler(ctx, { sObjectFilter: 'account' });
    const exact = await cdcSubscribersHandler(ctx, { sObjectFilter: 'Account' });
    expect(lower.ok && exact.ok).toBe(true);
    if (!lower.ok || !exact.ok) return;
    expect(lower.value.data.subscribers.map((s) => s.subscriberId)).toEqual(
      exact.value.data.subscribers.map((s) => s.subscriberId),
    );
    expect(lower.value.data.appliedScope).toEqual({ object: 'Account', mode: 'component' });
  });

  it('a scoped call echoes appliedScope so the answer cannot be read as org-wide', async () => {
    const result = await cdcSubscribersHandler(ctx, { sObjectFilter: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.appliedScope).toEqual({ object: 'Account', mode: 'component' });
  });

  it('BARE CALL: the org-wide (no-scope) path carries no appliedScope', async () => {
    const result = await cdcSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('appliedScope' in result.value.data).toBe(false);
  });

  it('BARE CALL: the org-wide payload shape is unchanged by the scope fix', async () => {
    const result = await cdcSubscribersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.summary.uniqueChangeEvents).toBeGreaterThanOrEqual(2);
    expect(d.subscribers.length).toBeGreaterThanOrEqual(4);
  });
});
