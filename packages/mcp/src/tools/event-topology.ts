/**
 * Handler for the `sfi.event_topology` MCP tool.
 *
 * ONE front door for the event plane: the org's Platform Events, its Change
 * Data Capture selections, and the PlatformEventChannels that carry both —
 * inventory AND where-used in a single call.
 *
 * WHY IT EXISTS (the defect it closes). The capability was split across two
 * roster entries and a deterministic intent that routed the owner's verbatim
 * question — "what platform events are in this org and where are they used?"
 * — to `sfi.event_subscribers` ALONE. That tool answers the Platform-Event
 * half confidently and silently drops the CDC half, and neither tool said
 * anything about the events the org's own permission metadata NAMES but the
 * refresh never retrieved. The defect was over-confidence, not absence:
 *
 *   - `event_subscribers` catalog mode returned the retrieved `__e` objects
 *     with no statement about the ones referenced-but-not-retrieved.
 *   - `cdc_subscribers` returned `{ totalSubscribers: 0, channelMembers: [] }`
 *     with a disclosure that only covered the empty-subscribers /
 *     non-empty-members case — silent on the all-zero case that actually
 *     fires, so a reader inferred "no CDC configured" from a tool that had
 *     not said whether it could tell.
 *
 * `event_topology` answers both halves and reports RETRIEVAL COVERAGE AS
 * DATA (`coverage`), never as prose the caller has to parse.
 *
 * HOW A NODE IS RECOGNIZED AS A PLATFORM EVENT. Two discriminators, reported
 * per event in `recognizedBy`:
 *
 *   1. `declared-property` — the CustomObject node carries
 *      `properties.isPlatformEvent === true`, stamped by the extractor from
 *      the PlatformEvent variant of the object file. Vaults refreshed by an
 *      sf-intelligence that reads `<eventType>` / `<publishBehavior>` carry
 *      it, and those two facts come back with the event.
 *   2. `api-name-suffix` — the fallback for a vault built BEFORE that
 *      extractor: the apiName ends in `__e`. Correct, but it cannot supply
 *      `eventType` / `publishBehavior`, which stay `null` and are disclosed
 *      as "not extracted by the sf-intelligence that built this vault",
 *      NEVER as "not declared on the event".
 *
 * HOW CDC ENABLEMENT IS DECIDED. A `PlatformEventChannelMember` whose
 * `selectedEntity` is a Change Event (`{Object}ChangeEvent` /
 * `{Object}__ChangeEvent`) IS the org's declaration that CDC is on for that
 * entity — that is the metadata Salesforce writes when an admin selects an
 * entity in Setup → Change Data Capture. Code that reacts to the stream is
 * read from the edges that ALREADY EXIST — a CDC Apex trigger's declared
 * `triggersOn` into `CustomObject:{X}ChangeEvent` (the trigger extractor
 * emits `triggersOn` unconditionally; the `__e` gate applies only to the
 * extra `listensTo` edge) plus any `listensTo` a scanner minted. No new
 * edge type is introduced and nothing is name-matched into existence.
 *
 * ABSENCE IS TYPED, NEVER FLATTENED. Three distinct kinds of "nothing here",
 * each with its own disclosure:
 *
 *   - VERIFIED NONE — `PlatformEventChannelMember` was requested, retrieved
 *     without error, and no retrieved member selects a Change Event. The
 *     manifest coverage row is quoted verbatim via {@link familyAbsence}, so
 *     "no object has CDC enabled" is a checked claim, not an unchecked one.
 *   - REFERENCED BUT NEVER RETRIEVED — an id that only ever appears as an
 *     edge TARGET with no node behind it (`referencedNotRetrieved`). The
 *     org names the event; this vault does not hold it. A namespaced id
 *     (`ns__Event__e`) is managed-package metadata a retrieve does not
 *     return, so `closableByRefresh: false` — the `unproducedEdgeType`
 *     shape, a gap NO refresh closes. A namespace-free id is
 *     `closableByRefresh: true` — a real `coverageCaveat`.
 *   - NOT EXTRACTED — `eventType` / `publishBehavior` are `null` because the
 *     vault predates the extractor, flagged by
 *     `coverage.platformEventFactsExtracted: false`.
 *
 * NOT CDC ENABLEMENT (a trap this tool refuses to fall into): a Profile or
 * PermissionSet granting read on `AccountChangeEvent` is a PERMISSION on a
 * platform entity that exists on every org whether or not CDC is selected.
 * Those grants surface only under `referencedNotRetrieved` with
 * `kind: 'change-event'`, and are NEVER counted as an enabled entity.
 *
 * The vault holds METADATA. How many change events actually flowed, and
 * whether a declared channel filter matched any record, are record-level
 * facts no offline answer can carry.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  danglingTargetIdsMatching,
  getNodeById,
  listEdgesForNodes,
  listNodesByIds,
  listNodesByType,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { familyAbsence } from './action-chain-model.js';

/** Canonical id prefix for every event entity — Platform Events and Change Events alike. */
const OBJECT_ID_PREFIX = 'CustomObject:';

/** Platform Event apiName suffix (`Application_Event__e`). */
const PLATFORM_EVENT_SUFFIX = '__e';

/** Change Event apiName suffix, standard form (`AccountChangeEvent`). */
const CHANGE_EVENT_SUFFIX = 'ChangeEvent';

/** Custom-object Change Event infix (`Order__ChangeEvent`). */
const CUSTOM_CHANGE_EVENT_SUFFIX = '__ChangeEvent';

/** `__c` suffix, stripped when deriving a custom object's Change Event name. */
const CUSTOM_OBJECT_SUFFIX = '__c';

/**
 * The platform's built-in CDC channel. Standard CDC selections are members of
 * this channel (`ChangeEvents_AccountChangeEvent`), and it has no metadata
 * file of its own — its presence is inferred from a member declaring it.
 */
const STANDARD_CHANGE_EVENTS_CHANNEL = 'ChangeEvents';

/** Page size for the CustomObject sweep (the graph layer's own maximum). */
const OBJECT_PAGE_SIZE = 500;

/**
 * Ceiling on the CustomObject sweep. 20 pages = 10,000 objects, far above any
 * real org; hitting it sets `coverage.objectScanTruncated` rather than
 * silently returning a partial inventory.
 */
const MAX_OBJECT_PAGES = 20;

/** Defensive ceiling on the channel / member sweeps. */
const CHANNEL_SCAN_LIMIT = 500;

/** Referrer ids listed per referenced-but-not-retrieved event before capping. */
const PHANTOM_REFERRER_SAMPLE = 5;

/** Default / maximum number of events returned per section. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Node types that count as event-plane CODE — the producers the extractors
 * emit `listensTo` / `writesTo` / `triggersOn` from.
 */
const CODE_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'ApexTrigger',
  'ApexClass',
  'Flow',
]);

/**
 * True when an apiName is a Change Event by the platform's naming rule:
 * `{Object}ChangeEvent` for standard objects, `{Object}__ChangeEvent` for
 * custom. Excludes the bare literal so a hypothetical object named exactly
 * `ChangeEvent` is not mistaken for one.
 */
const isChangeEventApiName = (apiName: string): boolean =>
  apiName.endsWith(CHANGE_EVENT_SUFFIX) &&
  apiName.length > CHANGE_EVENT_SUFFIX.length;

/** True when an apiName is a Platform Event by suffix (`Application_Event__e`). */
const isPlatformEventApiName = (apiName: string): boolean =>
  apiName.endsWith(PLATFORM_EVENT_SUFFIX) &&
  apiName.length > PLATFORM_EVENT_SUFFIX.length;

/**
 * Recover the sObject a Change Event belongs to: `AccountChangeEvent` →
 * `Account`; `Order__ChangeEvent` → `Order__c`. Returns the input unchanged
 * when it is not a Change Event name.
 */
const changeEventToEntity = (changeEventName: string): string => {
  if (changeEventName.endsWith(CUSTOM_CHANGE_EVENT_SUFFIX)) {
    return (
      changeEventName.slice(0, -CUSTOM_CHANGE_EVENT_SUFFIX.length) +
      CUSTOM_OBJECT_SUFFIX
    );
  }
  if (isChangeEventApiName(changeEventName)) {
    return changeEventName.slice(0, -CHANGE_EVENT_SUFFIX.length);
  }
  return changeEventName;
};

/**
 * The inverse: `Account` → `AccountChangeEvent`; `Order__c` →
 * `Order__ChangeEvent`. Used to resolve the `objectApiName` narrow.
 */
const entityToChangeEvent = (apiName: string): string =>
  apiName.endsWith(CUSTOM_OBJECT_SUFFIX)
    ? apiName.slice(0, -CUSTOM_OBJECT_SUFFIX.length) + CUSTOM_CHANGE_EVENT_SUFFIX
    : apiName + CHANGE_EVENT_SUFFIX;

/**
 * The managed-package namespace prefix of an apiName (`mkto_si__Log__e` →
 * `mkto_si`), or `null` for an org-local name. A namespaced component is not
 * returned by a metadata retrieve, which is what makes its absence permanent
 * rather than a refresh away.
 */
const namespacePrefixOf = (apiName: string): string | null => {
  const idx = apiName.indexOf('__');
  if (idx <= 0) return null;
  const rest = apiName.slice(idx + 2);
  // A bare `Foo__e` / `Foo__c` has no namespace — the only `__` is the suffix.
  if (rest.length === 0) return null;
  if (!rest.includes('__') && rest.length <= 3) return null;
  return apiName.slice(0, idx);
};

/**
 * Zod schema for the `sfi.event_topology` tool input.
 *
 *   - `filter`: which half to return. `all` (default) returns Platform
 *     Events, CDC, and channels; the narrower values return one section each
 *     but ALWAYS keep `coverage` and `boundaries`, so a narrowed call is
 *     never a less honest one.
 *   - `objectApiName` / `object`: narrow the CDC half to one entity — the
 *     "is change data capture enabled for Contact?" shape. Accepts a bare
 *     apiName (`Contact`, `Order__c`), the Change Event name
 *     (`ContactChangeEvent`), or a `CustomObject:` id.
 *   - `limit`: cap per section (default 100, max 500).
 */
export const eventTopologyInputSchema = z.object({
  filter: z
    .enum(['all', 'platform-events', 'cdc', 'channels'])
    .optional(),
  objectApiName: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

/** Parsed input shape, inferred from {@link eventTopologyInputSchema}. */
export type EventTopologyInput = z.infer<typeof eventTopologyInputSchema>;

/** One component that participates in an event, with the edge that says so. */
export interface EventParticipant {
  readonly id: ComponentId;
  readonly type: ComponentType;
  /**
   * The MODELED edge this participation was read from — never an inference:
   * `listensTo` (subscribes), `writesTo` (publishes), `triggersOn` (a CDC
   * Apex trigger declared on the Change Event).
   */
  readonly via: 'listensTo' | 'writesTo' | 'triggersOn';
}

/** A channel binding for an event — the publish-side routing. */
export interface EventChannelBinding {
  readonly channelId: ComponentId | null;
  readonly channelApiName: string | null;
  readonly channelType: string | null;
  readonly memberId: ComponentId;
  /** DECLARED per-member XML filter text. NOT runtime filter evaluation. */
  readonly filterExpression: string | null;
}

/** One retrieved Platform Event, with its facts and its where-used. */
export interface PlatformEventEntry {
  readonly eventId: ComponentId;
  readonly apiName: string;
  readonly label: string | null;
  /**
   * `HighVolume` / `StandardVolume` as DECLARED on the object file, or `null`
   * when this vault's extractor did not read it (see
   * `coverage.platformEventFactsExtracted`) or the org did not declare it.
   * `recognizedBy` disambiguates those two `null`s.
   */
  readonly eventType: string | null;
  /** `PublishAfterCommit` / `PublishImmediately`, same `null` semantics. */
  readonly publishBehavior: string | null;
  /** Which discriminator identified this node as a Platform Event. */
  readonly recognizedBy: 'declared-property' | 'api-name-suffix';
  readonly subscribers: readonly EventParticipant[];
  readonly publishers: readonly EventParticipant[];
  readonly channels: readonly EventChannelBinding[];
}

/** One entity whose Change Event a retrieved channel member selects. */
export interface CdcEntityEntry {
  /** The sObject CDC is enabled for (`Account`, `Order__c`). */
  readonly entity: string;
  readonly changeEventName: string;
  readonly changeEventId: ComponentId;
  /**
   * `channel-member` — the DECLARED `PlatformEventChannelMember` selection.
   * This is the only signal that means "CDC is enabled"; code reacting to a
   * stream is reported separately in `codeSubscribers`.
   */
  readonly enabledBy: 'channel-member';
  readonly memberId: ComponentId;
  readonly channelId: ComponentId | null;
  readonly channelApiName: string | null;
  readonly channelType: string | null;
  readonly filterExpression: string | null;
  /** Apex/Flow reached by a modeled `triggersOn` / `listensTo` into the Change Event. */
  readonly codeSubscribers: readonly EventParticipant[];
}

/** One PlatformEventChannel with the members it carries. */
export interface EventChannelEntry {
  readonly channelId: ComponentId;
  readonly apiName: string;
  readonly label: string | null;
  /** `event` (Platform Events) / `data` (Change Data Capture), as declared. */
  readonly channelType: string | null;
  readonly memberCount: number;
  readonly members: readonly {
    readonly memberId: ComponentId;
    readonly selectedEntity: string;
    readonly selectedKind: 'platform-event' | 'change-event' | 'other';
    readonly filterExpression: string | null;
  }[];
}

/** An event id the org REFERENCES but this vault never retrieved. */
export interface ReferencedNotRetrievedEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly kind: 'platform-event' | 'change-event';
  /** Managed-package namespace, or `null` for an org-local name. */
  readonly namespacePrefix: string | null;
  /**
   * `false` for a namespaced id: a metadata retrieve does not return managed
   * components, so no refresh closes this gap. `true` for an org-local id —
   * a real coverage gap a refresh can close.
   */
  readonly closableByRefresh: boolean;
  readonly referrerCount: number;
  /** Up to {@link PHANTOM_REFERRER_SAMPLE} referrer ids; `referrerCount` is the full number. */
  readonly referrers: readonly ComponentId[];
}

/** Retrieval coverage, reported as DATA rather than prose. */
export interface EventTopologyCoverage {
  readonly platformEventsModeled: number;
  readonly platformEventsReferencedNotRetrieved: number;
  readonly changeEventNodesModeled: number;
  readonly changeEventsReferencedNotRetrieved: number;
  readonly platformEventChannelsModeled: number;
  readonly platformEventChannelMembersModeled: number;
  readonly cdcChannelMembersModeled: number;
  readonly platformEventChannelMembersModeledForEvents: number;
  /** True when a member declares the platform's built-in `ChangeEvents` channel. */
  readonly standardChangeEventsChannelSeen: boolean;
  /**
   * True when at least one retrieved Platform Event node carries the
   * extractor-stamped `isPlatformEvent` marker — i.e. this vault can supply
   * `eventType` / `publishBehavior` at all.
   */
  readonly platformEventFactsExtracted: boolean;
  readonly objectNodesScanned: number;
  readonly objectScanTruncated: boolean;
  /**
   * The manifest's own verdict on whether a zero here is a checked none.
   * `verified-none` means `PlatformEventChannelMember` was requested and
   * retrieved without error.
   */
  readonly channelMemberFamily: 'verified-none' | 'unresolved';
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface EventTopologyOutput {
  readonly appliedScope: {
    readonly filter: 'all' | 'platform-events' | 'cdc' | 'channels';
    readonly object: string | null;
  };
  /**
   * ORG-WIDE counts, computed BEFORE `filter` and `limit` are applied — so a
   * narrowed or paged call still reports the true size of each section and a
   * caller can never mistake a filtered-out list for an empty org.
   */
  readonly summary: {
    readonly platformEventCount: number;
    readonly cdcEnabledEntityCount: number;
    readonly channelCount: number;
    readonly truncated: boolean;
  };
  /**
   * Deliberately serialized BEFORE the inventory lists: a reader — or a host
   * LLM reading a byte-budgeted slice — must reach the counts that say what
   * was and was not retrieved before reaching the lists computed under them.
   */
  readonly coverage: EventTopologyCoverage;
  readonly cdcEntities: readonly CdcEntityEntry[];
  readonly platformEvents: readonly PlatformEventEntry[];
  readonly channels: readonly EventChannelEntry[];
  readonly referencedNotRetrieved: readonly ReferencedNotRetrievedEntry[];
  readonly boundaries: readonly string[];
}

/** Always emitted: what "where used" is read from, and what it cannot see. */
const RECOGNITION_DISCLOSURE =
  'Where-used is read from MODELED edges only: `listensTo` (subscribes), `writesTo` (publishes) and a CDC trigger\'s declared `triggersOn` into the Change Event. Apex `EventBus.publish(...)` has no detector in this codebase and `EventBus.subscribe(...)` is recognized only when the channel argument is a static, resolvable string, so a dynamically-built or managed-package publisher/subscriber is invisible here — an empty list means "no modeled participant", never "nothing uses this event".';

/** Always emitted: the metadata/record-data line. */
const RECORD_PLANE_DISCLOSURE =
  'This is the METADATA plane. Channel `filterExpression` is the DECLARED XML text, never a runtime evaluation of which records flowed; event volume, delivery and subscriber lag are record-level facts no offline answer carries.';

/** Emitted only when the platform-event facts were not extracted by this vault's builder. */
const FACTS_NOT_EXTRACTED_DISCLOSURE =
  '`eventType` (High Volume vs Standard) and `publishBehavior` are NULL for every event here because the sf-intelligence that BUILT this vault did not read them — not because the org left them undeclared. Every event was recognized by the `__e` api-name suffix instead of the extractor-stamped marker. Run `sfi refresh` to populate them.';

/** Emitted only when a permission grant names a Change Event this vault never retrieved. */
// States only what the code establishes. The previous wording asserted the
// referrer was a PERMISSION GRANT — a provenance nothing here checks: the line
// fires whenever `phantomChangeEvents` is non-empty, with no inspection of the
// referring edge type. The load-bearing half (it is NOT evidence of CDC, and it
// is excluded from `cdcEntities`) is true regardless of how the reference
// arrived, and the referrers are listed per entry so the reader can see for
// themselves rather than take the tool's word for the cause.
const CHANGE_EVENT_GRANT_DISCLOSURE =
  'A Change Event listed under `referencedNotRetrieved` is REFERENCED by this vault\'s metadata without having been retrieved — its `referrers` name what points at it. Change Events exist on every org whether or not CDC is selected for the object, so a reference to one is NOT evidence that CDC is enabled, and these are deliberately excluded from `cdcEntities`. This tool does not establish HOW the reference arrived; read `referrers` for that.';

/**
 * Build the CDC absence line. Reported ONLY when zero channel members select a
 * Change Event, and it QUOTES the manifest coverage row so the reader can tell
 * "retrieved and none found" from "never retrieved" without trusting the tool.
 */
/**
 * Emitted when a call NARROWED to one object finds no CDC for it.
 *
 * The org-wide wording below asserts "No object in this vault has Change Data
 * Capture enabled", which is a claim about the WHOLE vault. `cdcEntries` is
 * scope-filtered before the emptiness check, so on any org that does have CDC
 * enabled a scoped call for an object that does not was emitting that org-wide
 * claim — a checked-zero assertion about 143 objects derived from looking at
 * one.
 */
const cdcEmptyForScopeDisclosure = (
  entity: string,
  basis: string,
  verified: boolean,
): string =>
  verified
    ? `No Change Data Capture selection was found FOR \`${entity}\` — CDC enablement is DECLARED as a \`PlatformEventChannelMember\` whose \`selectedEntity\` is that object's Change Event, and no retrieved member selects it. ${basis} This is a CHECKED zero for THIS OBJECT ONLY and says nothing about whether other objects have CDC enabled; call without a scope for the org-wide answer.`
    : `Change Data Capture enablement for \`${entity}\` CANNOT be decided from this vault. ${basis} The empty \`cdcEntities\` list here means NOT CHECKED, not "no CDC" — and it is scoped to this object, not the org.`;

const cdcEmptyDisclosure = (basis: string, verified: boolean): string =>
  verified
    ? `No object in this vault has Change Data Capture enabled: CDC enablement is DECLARED as a \`PlatformEventChannelMember\` whose \`selectedEntity\` is a Change Event, and none of the retrieved members selects one. ${basis} This is a CHECKED zero, not an unchecked one. Selections made only in Setup still write this metadata, so re-run \`sfi refresh\` if CDC was turned on after this vault was built.`
    : `Change Data Capture enablement CANNOT be decided from this vault. ${basis} The empty \`cdcEntities\` list here means NOT CHECKED, not "no CDC".`;

/** Emitted when at least one Platform Event is referenced but was never retrieved. */
const referencedNotRetrievedDisclosure = (
  total: number,
  namespaced: number,
): string =>
  `${total} Platform Event${total === 1 ? ' is' : 's are'} NAMED by this org's own metadata but ${total === 1 ? 'was' : 'were'} never retrieved into this vault, so ${total === 1 ? 'it is' : 'they are'} listed in \`referencedNotRetrieved\` and NOT in \`platformEvents\` — their subscribers and publishers are unknown, not zero. ${namespaced} of ${total} carr${namespaced === 1 ? 'ies' : 'y'} a managed-package namespace, which a metadata retrieve does not return: that portion is \`closableByRefresh: false\` — no refresh ever closes it.`;

/** Deterministic id comparator used by every section sort. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sweep every CustomObject node, paging to the graph layer's maximum, and
 * split them into Platform Events and Change Events. Returns the scan size and
 * whether the ceiling was hit so the caller can report it rather than imply a
 * complete inventory.
 */
const sweepObjectNodes = async (
  ctx: Context,
): Promise<
  Result<
    {
      readonly platformEvents: readonly Node[];
      readonly changeEvents: readonly Node[];
      readonly scanned: number;
      readonly truncated: boolean;
    },
    string
  >
> => {
  const platformEvents: Node[] = [];
  const changeEvents: Node[] = [];
  let scanned = 0;
  let truncated = false;
  for (let page = 0; page < MAX_OBJECT_PAGES; page += 1) {
    const result = await listNodesByType(ctx.graph, 'CustomObject', {
      limit: OBJECT_PAGE_SIZE,
      offset: page * OBJECT_PAGE_SIZE,
    });
    if (!result.ok) return err(result.error.message);
    const batch = result.value;
    scanned += batch.length;
    for (const node of batch) {
      if (
        node.properties['isPlatformEvent'] === true ||
        isPlatformEventApiName(node.apiName)
      ) {
        platformEvents.push(node);
      } else if (isChangeEventApiName(node.apiName)) {
        changeEvents.push(node);
      }
    }
    if (batch.length < OBJECT_PAGE_SIZE) return ok({ platformEvents, changeEvents, scanned, truncated });
  }
  truncated = true;
  return ok({ platformEvents, changeEvents, scanned, truncated });
};

/**
 * Resolve the inbound `listensTo` / `writesTo` / `triggersOn` edges for a set
 * of event ids into typed participants, in THREE batched round-trips rather
 * than a per-event N+1 walk.
 */
const resolveParticipants = async (
  ctx: Context,
  eventIds: readonly ComponentId[],
): Promise<Result<ReadonlyMap<ComponentId, readonly EventParticipant[]>, string>> => {
  const out = new Map<ComponentId, EventParticipant[]>();
  for (const id of eventIds) out.set(id, []);
  if (eventIds.length === 0) return ok(out);

  const edgesResult = await listEdgesForNodes(ctx.graph, eventIds, {
    direction: 'in',
    edgeTypes: ['listensTo', 'writesTo', 'triggersOn'],
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);

  const endpointIds = new Set<ComponentId>();
  for (const id of eventIds) {
    for (const edge of edgesResult.value.get(id) ?? []) endpointIds.add(edge.fromId);
  }
  const nodesResult = await listNodesByIds(ctx.graph, [...endpointIds]);
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const nodeById = new Map(nodesResult.value.map((n) => [n.id, n]));

  for (const id of eventIds) {
    const seen = new Set<string>();
    const bucket = out.get(id) as EventParticipant[];
    for (const edge of edgesResult.value.get(id) ?? []) {
      const node = nodeById.get(edge.fromId);
      if (node === undefined) continue;
      if (!CODE_NODE_TYPES.has(node.type)) continue;
      // De-dup: one class can emit the same edge type from two extractors
      // (the edge PK includes `source`), which would otherwise double-list it.
      const key = `${node.id}|${edge.edgeType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bucket.push({
        id: node.id,
        type: node.type,
        via: edge.edgeType as EventParticipant['via'],
      });
    }
    bucket.sort((a, b) => byId(a.id, b.id) || byId(a.via, b.via));
  }
  return ok(out);
};

/** A retrieved channel member, joined to its channel. */
interface MemberRow {
  readonly memberId: ComponentId;
  readonly selectedEntity: string;
  readonly filterExpression: string | null;
  readonly channelId: ComponentId | null;
  readonly channelApiName: string | null;
  readonly channelType: string | null;
  readonly declaredChannel: string | null;
}

/**
 * Read every `PlatformEventChannelMember` and join each to its channel. The
 * join is member-centric on purpose: a member is always present when a
 * selection exists, while the platform's built-in `ChangeEvents` channel has
 * no metadata file, so keying off the channel would drop standard CDC
 * entirely.
 */
const collectMembers = async (
  ctx: Context,
): Promise<Result<readonly MemberRow[], string>> => {
  const membersResult = await listNodesByType(
    ctx.graph,
    'PlatformEventChannelMember',
    { limit: CHANNEL_SCAN_LIMIT },
  );
  if (!membersResult.ok) return err(membersResult.error.message);

  const rows: MemberRow[] = [];
  const channelCache = new Map<ComponentId, Node | null>();
  for (const node of membersResult.value) {
    const selected = node.properties['selectedEntity'];
    if (typeof selected !== 'string' || selected.length === 0) continue;
    const channelId = node.parentId;
    let channel: Node | null = null;
    if (channelId !== null) {
      if (channelCache.has(channelId)) {
        channel = channelCache.get(channelId) ?? null;
      } else {
        const channelResult = await getNodeById(ctx.graph, channelId);
        if (!channelResult.ok) return err(channelResult.error.message);
        channel = channelResult.value;
        channelCache.set(channelId, channel);
      }
    }
    const declared = node.properties['eventChannel'];
    const rawFilter = node.properties['filterExpression'];
    const rawType = channel?.properties['channelType'];
    rows.push({
      memberId: node.id,
      selectedEntity: selected,
      filterExpression: typeof rawFilter === 'string' ? rawFilter : null,
      channelId,
      channelApiName: channel?.apiName ?? null,
      channelType: typeof rawType === 'string' ? rawType : null,
      declaredChannel: typeof declared === 'string' ? declared : null,
    });
  }
  rows.sort((a, b) => byId(a.memberId, b.memberId));
  return ok(rows);
};

/**
 * Collect the ids an edge TARGETS but no node backs — the org names them, the
 * vault does not hold them. Filtered to event-shaped ids and annotated with
 * their referrers so the answer can cite WHO names each one.
 */
const collectReferencedNotRetrieved = async (
  ctx: Context,
): Promise<Result<readonly ReferencedNotRetrievedEntry[], string>> => {
  const ids = new Set<ComponentId>();
  for (const needle of [PLATFORM_EVENT_SUFFIX, CHANGE_EVENT_SUFFIX]) {
    const result = await danglingTargetIdsMatching(ctx.graph, needle);
    if (!result.ok) return err(result.error.message);
    for (const id of result.value) {
      if (!id.startsWith(OBJECT_ID_PREFIX)) continue;
      const apiName = id.slice(OBJECT_ID_PREFIX.length);
      if (isPlatformEventApiName(apiName) || isChangeEventApiName(apiName)) {
        ids.add(id);
      }
    }
  }
  const ordered = [...ids].sort(byId);
  if (ordered.length === 0) return ok([]);

  const edgesResult = await listEdgesForNodes(ctx.graph, ordered, {
    direction: 'in',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);

  const entries: ReferencedNotRetrievedEntry[] = [];
  for (const id of ordered) {
    const apiName = id.slice(OBJECT_ID_PREFIX.length);
    const referrers = [
      ...new Set((edgesResult.value.get(id) ?? []).map((e: Edge) => e.fromId)),
    ].sort(byId);
    const namespacePrefix = namespacePrefixOf(apiName);
    const kind = isPlatformEventApiName(apiName) ? 'platform-event' : 'change-event';
    entries.push({
      id,
      apiName,
      kind,
      namespacePrefix,
      // `closableByRefresh` is per KIND, not per namespace. The namespace rule
      // is a PLATFORM-EVENT rule: a managed-package event is not returned by a
      // metadata retrieve, so a namespaced one is unclosable and a bare one is
      // closable. Applying it to Change Events was wrong in BOTH directions,
      // and the common direction was the dangerous one: a standard
      // `AccountChangeEvent` has no `__`, so it scored `namespacePrefix: null`
      // and the tool asserted a refresh WOULD close the gap. It never can —
      // a Change Event is a platform-derived entity, never a retrievable
      // CustomObject on any org. (Same fact the ChangeEvent phantom-loop fix
      // rests on: the refresh re-requested these forever without converging.)
      closableByRefresh: kind === 'platform-event' && namespacePrefix === null,
      referrerCount: referrers.length,
      referrers: referrers.slice(0, PHANTOM_REFERRER_SAMPLE),
    });
  }
  return ok(entries);
};

/**
 * Normalize the caller's object narrow into the Change Event apiName it
 * scopes to. Accepts a bare object apiName, the Change Event name itself, or
 * a `CustomObject:` id.
 */
const resolveObjectScope = (
  input: EventTopologyInput,
): { readonly raw: string; readonly changeEventName: string } | null => {
  const raw = input.objectApiName ?? input.object;
  if (raw === undefined) return null;
  const bare = raw.startsWith(OBJECT_ID_PREFIX)
    ? raw.slice(OBJECT_ID_PREFIX.length)
    : raw;
  return {
    raw,
    changeEventName: isChangeEventApiName(bare)
      ? bare
      : entityToChangeEvent(bare),
  };
};

/**
 * The `sfi.event_topology` MCP tool. Returns the org's Platform Events with
 * their declared facts and where-used, the entities whose Change Data Capture
 * stream a channel member selects, the channels carrying both, the events the
 * org names but this vault never retrieved, and the retrieval coverage those
 * four sections were computed under.
 *
 * @example
 *   const r = await eventTopologyHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.coverage.platformEventsReferencedNotRetrieved);
 */
export const eventTopologyHandler = async (
  ctx: Context,
  input: EventTopologyInput,
): Promise<Result<McpResponse<EventTopologyOutput>, McpError>> => {
  const filter = input.filter ?? 'all';
  const limit = input.limit ?? DEFAULT_LIMIT;
  const scope = resolveObjectScope(input);

  const sweep = await sweepObjectNodes(ctx);
  if (!sweep.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${sweep.error}` });
  }
  const { platformEvents: eventNodes, changeEvents: changeEventNodes } = sweep.value;

  const members = await collectMembers(ctx);
  if (!members.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${members.error}` });
  }
  const memberRows = members.value;

  const phantoms = await collectReferencedNotRetrieved(ctx);
  if (!phantoms.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${phantoms.error}` });
  }

  // The CDC half keys off the MEMBER rows (the enablement declaration), then
  // reaches for code via the Change Event id — whether or not that Change
  // Event was ever retrieved as a node.
  const cdcMembers = memberRows.filter((m) => isChangeEventApiName(m.selectedEntity));
  const eventMembers = memberRows.filter((m) =>
    isPlatformEventApiName(m.selectedEntity),
  );

  // One participant walk over every event-plane target: retrieved Platform
  // Events, retrieved Change Events, and the Change Events a member selects
  // but no node backs.
  const participantTargets = [
    ...new Set<ComponentId>([
      ...eventNodes.map((n) => n.id),
      ...changeEventNodes.map((n) => n.id),
      ...cdcMembers.map((m) => `${OBJECT_ID_PREFIX}${m.selectedEntity}` as ComponentId),
    ]),
  ].sort(byId);
  const participants = await resolveParticipants(ctx, participantTargets);
  if (!participants.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${participants.error}`,
    });
  }
  const participantsById = participants.value;

  // Channel bindings for Platform Events, keyed by the selected event apiName.
  const channelsByEvent = new Map<string, EventChannelBinding[]>();
  for (const m of eventMembers) {
    const list = channelsByEvent.get(m.selectedEntity) ?? [];
    list.push({
      channelId: m.channelId,
      channelApiName: m.channelApiName,
      channelType: m.channelType,
      memberId: m.memberId,
      filterExpression: m.filterExpression,
    });
    channelsByEvent.set(m.selectedEntity, list);
  }

  const factsExtracted = eventNodes.some(
    (n) => n.properties['isPlatformEvent'] === true,
  );

  const platformEventEntries: PlatformEventEntry[] = eventNodes
    .map((node) => {
      const declared = node.properties['isPlatformEvent'] === true;
      const rawEventType = node.properties['eventType'];
      const rawPublish = node.properties['publishBehavior'];
      const all = participantsById.get(node.id) ?? [];
      return {
        eventId: node.id,
        apiName: node.apiName,
        label: node.label,
        eventType: typeof rawEventType === 'string' ? rawEventType : null,
        publishBehavior: typeof rawPublish === 'string' ? rawPublish : null,
        recognizedBy: (declared
          ? 'declared-property'
          : 'api-name-suffix') as PlatformEventEntry['recognizedBy'],
        subscribers: all.filter((p) => p.via === 'listensTo'),
        publishers: all.filter((p) => p.via === 'writesTo'),
        channels: channelsByEvent.get(node.apiName) ?? [],
      };
    })
    .sort((a, b) => byId(a.eventId, b.eventId));

  const cdcEntries: CdcEntityEntry[] = cdcMembers
    .filter((m) => scope === null || m.selectedEntity === scope.changeEventName)
    .map((m) => {
      const changeEventId = `${OBJECT_ID_PREFIX}${m.selectedEntity}` as ComponentId;
      return {
        entity: changeEventToEntity(m.selectedEntity),
        changeEventName: m.selectedEntity,
        changeEventId,
        enabledBy: 'channel-member' as const,
        memberId: m.memberId,
        channelId: m.channelId,
        channelApiName: m.channelApiName ?? m.declaredChannel,
        channelType: m.channelType,
        filterExpression: m.filterExpression,
        codeSubscribers: participantsById.get(changeEventId) ?? [],
      };
    })
    .sort((a, b) => byId(a.changeEventName, b.changeEventName));

  const channelsResult = await listNodesByType(ctx.graph, 'PlatformEventChannel', {
    limit: CHANNEL_SCAN_LIMIT,
  });
  if (!channelsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${channelsResult.error.message}`,
    });
  }
  const channelEntries: EventChannelEntry[] = channelsResult.value
    .map((channel) => {
      const own = memberRows.filter((m) => m.channelId === channel.id);
      const rawType = channel.properties['channelType'];
      return {
        channelId: channel.id,
        apiName: channel.apiName,
        label: channel.label,
        channelType: typeof rawType === 'string' ? rawType : null,
        memberCount: own.length,
        members: own.map((m) => ({
          memberId: m.memberId,
          selectedEntity: m.selectedEntity,
          selectedKind: (isPlatformEventApiName(m.selectedEntity)
            ? 'platform-event'
            : isChangeEventApiName(m.selectedEntity)
              ? 'change-event'
              : 'other') as 'platform-event' | 'change-event' | 'other',
          filterExpression: m.filterExpression,
        })),
      };
    })
    .sort((a, b) => byId(a.channelId, b.channelId));

  const memberFamily = familyAbsence(ctx, 'PlatformEventChannelMember');
  const phantomEvents = phantoms.value.filter((p) => p.kind === 'platform-event');
  const phantomChangeEvents = phantoms.value.filter((p) => p.kind === 'change-event');

  const coverage: EventTopologyCoverage = {
    platformEventsModeled: eventNodes.length,
    platformEventsReferencedNotRetrieved: phantomEvents.length,
    changeEventNodesModeled: changeEventNodes.length,
    changeEventsReferencedNotRetrieved: phantomChangeEvents.length,
    platformEventChannelsModeled: channelsResult.value.length,
    platformEventChannelMembersModeled: memberRows.length,
    cdcChannelMembersModeled: cdcMembers.length,
    platformEventChannelMembersModeledForEvents: eventMembers.length,
    standardChangeEventsChannelSeen: memberRows.some(
      (m) => m.declaredChannel === STANDARD_CHANGE_EVENTS_CHANNEL,
    ),
    platformEventFactsExtracted: factsExtracted,
    objectNodesScanned: sweep.value.scanned,
    objectScanTruncated: sweep.value.truncated,
    channelMemberFamily: memberFamily.resolution,
  };

  // Disclosures are ADDITIVE and PATH-SPECIFIC: the two always-on lines, plus
  // one line per absence kind that actually fired on this call.
  const boundaries: string[] = [RECOGNITION_DISCLOSURE, RECORD_PLANE_DISCLOSURE];
  if (filter === 'all' || filter === 'cdc') {
    if (cdcEntries.length === 0) {
      // The org-wide claim is only true when NOTHING was narrowed away.
      boundaries.push(
        scope === null
          ? cdcEmptyDisclosure(
              memberFamily.basis,
              memberFamily.resolution === 'verified-none',
            )
          : cdcEmptyForScopeDisclosure(
              changeEventToEntity(scope.changeEventName),
              memberFamily.basis,
              memberFamily.resolution === 'verified-none',
            ),
      );
    }
    if (phantomChangeEvents.length > 0) {
      boundaries.push(CHANGE_EVENT_GRANT_DISCLOSURE);
    }
  }
  if (filter === 'all' || filter === 'platform-events') {
    if (phantomEvents.length > 0) {
      boundaries.push(
        referencedNotRetrievedDisclosure(
          phantomEvents.length,
          phantomEvents.filter((p) => !p.closableByRefresh).length,
        ),
      );
    }
    if (eventNodes.length > 0 && !factsExtracted) {
      boundaries.push(FACTS_NOT_EXTRACTED_DISCLOSURE);
    }
  }

  const showEvents = filter === 'all' || filter === 'platform-events';
  const showCdc = filter === 'all' || filter === 'cdc';
  const showChannels = filter === 'all' || filter === 'channels';
  const truncated =
    (showEvents && platformEventEntries.length > limit) ||
    (showCdc && cdcEntries.length > limit) ||
    (showChannels && channelEntries.length > limit) ||
    (showEvents && phantoms.value.length > limit);

  return ok({
    data: {
      appliedScope: { filter, object: scope?.raw ?? null },
      summary: {
        platformEventCount: platformEventEntries.length,
        cdcEnabledEntityCount: cdcEntries.length,
        channelCount: channelEntries.length,
        truncated,
      },
      coverage,
      cdcEntities: showCdc ? cdcEntries.slice(0, limit) : [],
      platformEvents: showEvents ? platformEventEntries.slice(0, limit) : [],
      channels: showChannels ? channelEntries.slice(0, limit) : [],
      referencedNotRetrieved: showEvents ? phantoms.value.slice(0, limit) : [],
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
