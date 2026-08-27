/// <reference types="vitest/globals" />

/**
 * LANE-E — `sfi.event_topology`, the event-plane front door.
 *
 * These units pin the contracts that make the tool HONEST rather than merely
 * populated, because every one of them was a real defect in the two tools it
 * replaces:
 *
 *   1. A `*ChangeEvent` reachable only through a PERMISSION GRANT is NOT CDC
 *      enablement. Those entities exist on every org; counting them would
 *      report CDC enabled on an org that never turned it on.
 *   2. An event the org NAMES but the vault never retrieved must not be
 *      silently absent — it lands in `referencedNotRetrieved`, and a
 *      namespaced (managed-package) one is `closableByRefresh: false`,
 *      because no refresh ever returns managed metadata.
 *   3. An empty `cdcEntities` list must say WHY it is empty, quoting the
 *      manifest coverage row, so "checked and found nothing" is
 *      distinguishable from "did not check".
 *   4. `eventType` / `publishBehavior` read `null` on a vault built before the
 *      extractor stamped them — reported as NOT EXTRACTED, never as "the org
 *      did not declare one".
 *   5. A CDC Apex trigger reaches its Change Event by the `triggersOn` edge
 *      the trigger extractor ALREADY emits; no new edge type is minted.
 */

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
  eventTopologyHandler,
  eventTopologyInputSchema,
} from '../../src/tools/event-topology.js';

/**
 * Manifest whose coverage row says `PlatformEventChannelMember` WAS retrieved
 * — the input that lets an empty CDC list be reported as a CHECKED zero.
 */
const RETRIEVED_MANIFEST = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 5,
    PlatformEventChannel: 1,
    PlatformEventChannelMember: 2,
  },
  edges: {},
  sourceTreeHash: 'sha256:event-topology-fixture',
  coverage: [
    {
      type: 'PlatformEventChannelMember',
      requested: true,
      retrieved: 2,
      errored: false,
      neverModeled: false,
      retrieveConfirmed: true,
    },
  ],
} as unknown as VaultManifest;

/** Same vault, but the family was never requested — the UNRESOLVED path. */
const NOT_REQUESTED_MANIFEST = {
  ...RETRIEVED_MANIFEST,
  coverage: [
    {
      type: 'PlatformEventChannelMember',
      requested: false,
      retrieved: 0,
      errored: false,
      neverModeled: false,
    },
  ],
} as unknown as VaultManifest;

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

// ---------------------------------------------------------------------------
// Seed A — a Platform Event carrying the extractor-stamped facts, published by
// a Flow, subscribed by an Apex class, and routed through an `event` channel.
// ---------------------------------------------------------------------------
const EVENT_ID = 'CustomObject:Order_Placed__e';
const EVENT_PUBLISHER = 'Flow:Publish_Order_Placed';
const EVENT_SUBSCRIBER = 'ApexClass:OrderPlacedHandler';
const EVENT_CHANNEL = 'PlatformEventChannel:OrderStream__chn';
const EVENT_MEMBER = 'PlatformEventChannelMember:OrderStreamOrderPlaced';

const platformEventSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: EVENT_ID,
      apiName: 'Order_Placed__e',
      label: 'Order Placed',
      properties: {
        isPlatformEvent: true,
        eventType: 'HighVolume',
        publishBehavior: 'PublishAfterCommit',
      },
    }),
    makeNode({ id: EVENT_PUBLISHER, type: 'Flow', apiName: 'Publish_Order_Placed' }),
    makeNode({ id: EVENT_SUBSCRIBER, type: 'ApexClass', apiName: 'OrderPlacedHandler' }),
    makeNode({
      id: EVENT_CHANNEL,
      type: 'PlatformEventChannel',
      apiName: 'OrderStream__chn',
      label: 'Order Stream',
      properties: { channelType: 'event', eventType: 'custom', label: 'Order Stream' },
    }),
    makeNode({
      id: EVENT_MEMBER,
      type: 'PlatformEventChannelMember',
      apiName: 'OrderStreamOrderPlaced',
      parentId: EVENT_CHANNEL,
      properties: {
        eventChannel: 'OrderStream__chn',
        selectedEntity: 'Order_Placed__e',
      },
    }),
  ],
  edges: [
    makeEdge({ fromId: EVENT_PUBLISHER, toId: EVENT_ID, edgeType: 'writesTo' }),
    makeEdge({ fromId: EVENT_SUBSCRIBER, toId: EVENT_ID, edgeType: 'listensTo' }),
    makeEdge({
      fromId: EVENT_MEMBER,
      toId: EVENT_ID,
      edgeType: 'references',
      properties: { referenceKind: 'platformEventChannelMember' },
    }),
  ],
};

// ---------------------------------------------------------------------------
// Seed B — a Platform Event with NO extractor facts (an older vault), so it is
// recognized by the `__e` suffix and its two facts must read `null`.
// ---------------------------------------------------------------------------
const LEGACY_EVENT_ID = 'CustomObject:Legacy_Signal__e';

const legacyEventSeed: ExtractionResult = {
  nodes: [makeNode({ id: LEGACY_EVENT_ID, apiName: 'Legacy_Signal__e' })],
  edges: [],
};

// ---------------------------------------------------------------------------
// Seed C — a REAL CDC selection: a `data` channel member selecting
// ContactChangeEvent, with an Apex trigger reaching it by the `triggersOn`
// edge the trigger extractor already emits. The ChangeEvent CustomObject node
// is deliberately ABSENT, as it is in a real offline vault.
// ---------------------------------------------------------------------------
const CDC_CHANNEL = 'PlatformEventChannel:ChangeEvents__chn';
const CDC_MEMBER = 'PlatformEventChannelMember:ChangeEvents_ContactChangeEvent';
const CDC_EVENT_ID = 'CustomObject:ContactChangeEvent';
const CDC_TRIGGER = 'ApexTrigger:ContactChangeHandler';

const cdcSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CDC_CHANNEL,
      type: 'PlatformEventChannel',
      apiName: 'ChangeEvents__chn',
      properties: { channelType: 'data', label: 'Change Events' },
    }),
    makeNode({
      id: CDC_MEMBER,
      type: 'PlatformEventChannelMember',
      apiName: 'ChangeEvents_ContactChangeEvent',
      parentId: CDC_CHANNEL,
      properties: {
        eventChannel: 'ChangeEvents',
        selectedEntity: 'ContactChangeEvent',
        filterExpression: "City = 'SF'",
      },
    }),
    makeNode({
      id: CDC_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'ContactChangeHandler',
    }),
  ],
  edges: [
    makeEdge({
      fromId: CDC_TRIGGER,
      toId: CDC_EVENT_ID,
      edgeType: 'triggersOn',
      source: 'apex-trigger-extractor',
    }),
  ],
};

// ---------------------------------------------------------------------------
// Seed D — the two absence shapes.
//   * a managed-package Platform Event named ONLY by a permission grant;
//   * a `*ChangeEvent` named ONLY by a permission grant, which must NEVER be
//     read as CDC enablement.
// ---------------------------------------------------------------------------
const GRANTOR = 'PermissionSet:Integration_User';
const MANAGED_EVENT_ID = 'CustomObject:ns_pkg__Vendor_Signal__e';
const GRANTED_CHANGE_EVENT_ID = 'CustomObject:ApiPrtcPolicyChangeEvent';

const phantomSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: GRANTOR, type: 'PermissionSet', apiName: 'Integration_User' }),
  ],
  edges: [
    makeEdge({
      fromId: GRANTOR,
      toId: MANAGED_EVENT_ID,
      edgeType: 'grantedBy',
      source: 'permission-set-extractor',
    }),
    makeEdge({
      fromId: GRANTOR,
      toId: GRANTED_CHANGE_EVENT_ID,
      edgeType: 'grantedBy',
      source: 'permission-set-extractor',
    }),
  ],
};

// ---------------------------------------------------------------------------
// Seed E (EVENT-TOPOLOGY-UNRESOLVED-OBJECT-SCOPE): bare base-object nodes for
// every sObject the `objectApiName` scope tests below narrow by. A real vault
// retrieves an object's own CustomObject metadata separately from its
// (never-retrievable) Change Event — the fixtures above never needed that node
// for the subscriber/CDC-enablement mechanics, but the object-scope existence
// check the fix adds now resolves against it.
// ---------------------------------------------------------------------------
const baseObjectSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Contact', apiName: 'Contact' }),
    makeNode({ id: 'CustomObject:Account', apiName: 'Account' }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-event-topology-'));
  const opened = await openGraph(join(tempDir, 'events.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    platformEventSeed,
    legacyEventSeed,
    cdcSeed,
    phantomSeed,
    baseObjectSeed,
  ]);
  if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: RETRIEVED_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const run = async (input: Record<string, unknown> = {}) => {
  const parsed = eventTopologyInputSchema.parse(input);
  const result = await eventTopologyHandler(ctx, parsed);
  if (!result.ok) throw new Error(`handler failed: ${result.error.message}`);
  return result.value.data;
};

describe('event_topology — platform-event inventory and facts', () => {
  it('returns both platform events and reports HOW each was recognized', async () => {
    const data = await run();
    const byId = new Map(data.platformEvents.map((e) => [e.eventId, e]));
    expect([...byId.keys()].sort()).toEqual([LEGACY_EVENT_ID, EVENT_ID].sort());
    expect(byId.get(EVENT_ID)?.recognizedBy).toBe('declared-property');
    expect(byId.get(LEGACY_EVENT_ID)?.recognizedBy).toBe('api-name-suffix');
  });

  it('surfaces the DECLARED eventType / publishBehavior when the extractor stamped them', async () => {
    const data = await run();
    const event = data.platformEvents.find((e) => e.eventId === EVENT_ID);
    expect(event?.eventType).toBe('HighVolume');
    expect(event?.publishBehavior).toBe('PublishAfterCommit');
  });

  it('separates publishers (writesTo) from subscribers (listensTo)', async () => {
    const data = await run();
    const event = data.platformEvents.find((e) => e.eventId === EVENT_ID);
    expect(event?.publishers.map((p) => p.id)).toEqual([EVENT_PUBLISHER]);
    expect(event?.publishers[0]?.via).toBe('writesTo');
    expect(event?.subscribers.map((s) => s.id)).toEqual([EVENT_SUBSCRIBER]);
    expect(event?.subscribers[0]?.via).toBe('listensTo');
  });

  it('binds the event to the channel that routes it', async () => {
    const data = await run();
    const event = data.platformEvents.find((e) => e.eventId === EVENT_ID);
    expect(event?.channels).toEqual([
      {
        channelId: EVENT_CHANNEL,
        channelApiName: 'OrderStream__chn',
        channelType: 'event',
        memberId: EVENT_MEMBER,
        filterExpression: null,
      },
    ]);
  });
});

describe('event_topology — CDC enablement', () => {
  it('reads enablement from the channel-member selection, not from a name guess', async () => {
    const data = await run();
    expect(data.cdcEntities).toHaveLength(1);
    const entry = data.cdcEntities[0];
    expect(entry?.entity).toBe('Contact');
    expect(entry?.changeEventName).toBe('ContactChangeEvent');
    expect(entry?.enabledBy).toBe('channel-member');
    expect(entry?.filterExpression).toBe("City = 'SF'");
  });

  it('reaches the CDC Apex trigger through the EXISTING triggersOn edge', async () => {
    const data = await run();
    expect(data.cdcEntities[0]?.codeSubscribers).toEqual([
      { id: CDC_TRIGGER, type: 'ApexTrigger', via: 'triggersOn' },
    ]);
  });

  it('NEVER counts a permission-granted ChangeEvent as CDC enablement', async () => {
    const data = await run();
    expect(
      data.cdcEntities.map((e) => e.changeEventId),
    ).not.toContain(GRANTED_CHANGE_EVENT_ID);
    const listed = data.referencedNotRetrieved.find(
      (p) => p.id === GRANTED_CHANGE_EVENT_ID,
    );
    expect(listed?.kind).toBe('change-event');
    expect(data.boundaries.join(' ')).toContain('NOT evidence that CDC is enabled');
  });

  it('narrows to one entity with objectApiName, accepting the bare object name', async () => {
    const scoped = await run({ objectApiName: 'Contact' });
    expect(scoped.cdcEntities.map((e) => e.entity)).toEqual(['Contact']);
    const miss = await run({ objectApiName: 'Account' });
    expect(miss.cdcEntities).toEqual([]);
    expect(miss.appliedScope.object).toBe('Account');
  });
});

describe('event_topology — absence is typed, never flattened', () => {
  it('lists a referenced-but-never-retrieved event and marks a managed one unclosable', async () => {
    const data = await run();
    const managed = data.referencedNotRetrieved.find(
      (p) => p.id === MANAGED_EVENT_ID,
    );
    expect(managed?.kind).toBe('platform-event');
    expect(managed?.namespacePrefix).toBe('ns_pkg');
    expect(managed?.closableByRefresh).toBe(false);
    expect(managed?.referrers).toEqual([GRANTOR]);
    expect(data.boundaries.join(' ')).toContain('no refresh ever closes it');
  });

  it('discloses that eventType is NOT EXTRACTED rather than not declared', async () => {
    const data = await run();
    expect(data.coverage.platformEventFactsExtracted).toBe(true);
    // The legacy event is the one with null facts; the disclosure fires only
    // when NO event in the vault carries the marker, so it must be absent here.
    expect(data.boundaries.join(' ')).not.toContain('did not read them');

    const legacyOnly = mkdtempSync(join(tmpdir(), 'sfi-mcp-event-legacy-'));
    const opened = await openGraph(join(legacyOnly, 'legacy.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const imported = await importExtractionResults(opened.value, [legacyEventSeed]);
    if (!imported.ok) throw new Error(imported.error.message);
    const legacyCtx: Context = {
      vaultRoot: legacyOnly,
      manifest: RETRIEVED_MANIFEST,
      graph: opened.value,
    };
    const result = await eventTopologyHandler(legacyCtx, {});
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.data.coverage.platformEventFactsExtracted).toBe(false);
    expect(result.value.data.boundaries.join(' ')).toContain('did not read them');
    await closeGraph(opened.value);
    rmSync(legacyOnly, { recursive: true, force: true });
  });

  it('reports an empty CDC list as a CHECKED zero, quoting the manifest coverage row', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-event-nocdc-'));
    const opened = await openGraph(join(emptyDir, 'nocdc.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const imported = await importExtractionResults(opened.value, [platformEventSeed]);
    if (!imported.ok) throw new Error(imported.error.message);

    const checked = await eventTopologyHandler(
      { vaultRoot: emptyDir, manifest: RETRIEVED_MANIFEST, graph: opened.value },
      {},
    );
    if (!checked.ok) throw new Error(checked.error.message);
    expect(checked.value.data.cdcEntities).toEqual([]);
    expect(checked.value.data.coverage.channelMemberFamily).toBe('verified-none');
    const checkedText = checked.value.data.boundaries.join(' ');
    expect(checkedText).toContain('WAS retrieved into this vault');
    expect(checkedText).toContain('CHECKED zero');

    const unchecked = await eventTopologyHandler(
      {
        vaultRoot: emptyDir,
        manifest: NOT_REQUESTED_MANIFEST,
        graph: opened.value,
      },
      {},
    );
    if (!unchecked.ok) throw new Error(unchecked.error.message);
    expect(unchecked.value.data.coverage.channelMemberFamily).toBe('unresolved');
    const uncheckedText = unchecked.value.data.boundaries.join(' ');
    expect(uncheckedText).toContain('CANNOT be decided from this vault');
    expect(uncheckedText).toContain('NOT CHECKED');

    await closeGraph(opened.value);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe('event_topology — scope and coverage reporting', () => {
  it('reports coverage as data, counting modeled and referenced-not-retrieved separately', async () => {
    const data = await run();
    expect(data.coverage.platformEventsModeled).toBe(2);
    expect(data.coverage.platformEventsReferencedNotRetrieved).toBe(1);
    expect(data.coverage.changeEventsReferencedNotRetrieved).toBe(2);
    expect(data.coverage.platformEventChannelsModeled).toBe(2);
    expect(data.coverage.platformEventChannelMembersModeled).toBe(2);
    expect(data.coverage.cdcChannelMembersModeled).toBe(1);
    expect(data.coverage.standardChangeEventsChannelSeen).toBe(true);
    expect(data.coverage.objectScanTruncated).toBe(false);
  });

  it('keeps coverage and boundaries under every filter, and summary stays org-wide', async () => {
    const cdcOnly = await run({ filter: 'cdc' });
    expect(cdcOnly.platformEvents).toEqual([]);
    expect(cdcOnly.channels).toEqual([]);
    expect(cdcOnly.cdcEntities).toHaveLength(1);
    // The counts describe the ORG, not the filtered slice, so a narrowed call
    // can never be misread as an empty org.
    expect(cdcOnly.summary.platformEventCount).toBe(2);
    expect(cdcOnly.coverage.platformEventsModeled).toBe(2);
    expect(cdcOnly.boundaries.length).toBeGreaterThan(0);
  });

  it('echoes the applied scope so a host can confirm what was answered', async () => {
    const data = await run({ filter: 'channels' });
    expect(data.appliedScope).toEqual({ filter: 'channels', object: null });
    expect(data.channels.map((c) => c.channelId).sort()).toEqual(
      [CDC_CHANNEL, EVENT_CHANNEL].sort(),
    );
  });
});

// =============================================================================
// EVENT-TOPOLOGY-UNRESOLVED-OBJECT-SCOPE. Pre-fix, `objectApiName` / `object`
// was normalized into a Change Event name with NO check that the underlying
// sObject exists — a made-up (or merely wrong-case) object name silently
// produced an empty `cdcEntities` list dressed as a "CHECKED zero for THIS
// OBJECT ONLY", indistinguishable from a real object with no CDC usage. Fixed
// by resolving the base entity through the shared `resolveExistingObjectScope`
// before deriving the Change Event name.
// =============================================================================

describe('event_topology — object scope honesty', () => {
  it('FAIL-BEFORE/PASS-AFTER: refuses an objectApiName absent from the vault, never a silent zero', async () => {
    const parsed = eventTopologyInputSchema.parse({
      objectApiName: 'Zzz_Nonexistent_Object_9x7__c',
    });
    const result = await eventTopologyHandler(ctx, parsed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toMatch(/no object named 'Zzz_Nonexistent_Object_9x7__c'/i);
  });

  it('refuses the same way when the fabricated name is given in ChangeEvent form', async () => {
    const parsed = eventTopologyInputSchema.parse({
      objectApiName: 'Zzz_Nonexistent_Object_9x7__cChangeEvent',
    });
    const result = await eventTopologyHandler(ctx, parsed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('a real object typed in the wrong case still answers, corrected to the vault casing', async () => {
    const data = await run({ objectApiName: 'contact' });
    expect(data.cdcEntities.map((e) => e.entity)).toEqual(['Contact']);
    expect(data.appliedScope.object).toBe('Contact');
  });

  it('BARE CALL: the org-wide (no-scope) path is unaffected by the scope fix', async () => {
    const data = await run();
    expect(data.appliedScope).toEqual({ filter: 'all', object: null });
    expect(data.platformEvents.length).toBeGreaterThan(0);
  });
});
