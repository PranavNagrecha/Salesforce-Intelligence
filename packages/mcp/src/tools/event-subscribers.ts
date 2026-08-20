/**
 * Handler for the `sfi.event_subscribers` MCP tool.
 *
 * The v1.5 architect-tier companion to `sfi.integration_map`: given a
 * Platform Event id (`CustomObject:{ApiName}__e`), return every
 * subscriber (ApexTrigger, ApexClass, Flow) that listens for the
 * event. The v1.5 R3 extractors emit the `listensTo` edge from each
 * subscriber into the event node; this tool walks the incoming
 * `listensTo` edges for the supplied event id and resolves each
 * `fromId` to a typed subscriber record.
 *
 * The architect's question this tool answers: "if I publish this
 * Platform Event, what code runs?". One call gives the full subscriber
 * list with each subscriber's source-of-truth (the extractor that
 * emitted the edge) and edge-level metadata (the trigger handler
 * class, the Flow's `<triggerType>PlatformEvent</triggerType>` mode,
 * the Apex class's `Triggerable<{Event}__e>` interface match).
 *
 * CR-CAP-18: single-event mode also returns `channels` — the
 * publish-side routing for the event. The tool walks the event's
 * INBOUND `references` edges tagged
 * `referenceKind === 'platformEventChannelMember'` to each
 * PlatformEventChannelMember, then the member's INBOUND `parentOf` to
 * its PlatformEventChannel, surfacing `{ channelId, channelType,
 * memberId, filterExpression }`. The `filterExpression` is the
 * DECLARED per-member XML text, NOT runtime filter evaluation.
 *
 * Implementation notes:
 *   - One `listEdges(eventId, { direction: 'in', edgeType: 'listensTo' })`
 *     call retrieves every candidate edge; `getNodeById` then resolves
 *     each `fromId` to a `Node`. The graph cannot distinguish "event
 *     does not exist" from "event has no subscribers", and both
 *     resolve to an empty subscriber list (the v1.5 honest case).
 *   - Subscribers are restricted to the three node types the v1.5 R3
 *     extractors emit `listensTo` from: ApexTrigger, ApexClass, Flow.
 *     Other node types (e.g., a hypothetical future Process Builder
 *     subscriber) are filtered out — the v1.5 contract pins the
 *     subscriber surface to these three.
 *   - The output's `source` is the EDGE's `source` field (the
 *     extractor name: `'apex-trigger-extractor'`,
 *     `'apex-class-extractor'`, or `'flow-extractor'`). The
 *     subscriber's `id`, `type`, `apiName` come from the resolved
 *     subscriber node. The `properties` blob is also the edge's, not
 *     the node's — callers want the per-subscription metadata (the
 *     trigger event mode, the Flow's `<triggerType>` value) rather
 *     than the subscriber's full extracted properties.
 *   - Sort: by `id` ASC for deterministic output. `limit` is applied
 *     after sorting so the truncation is stable across runs.
 *   - Honesty axis: an `eventId` whose canonical id form is not a
 *     `__e`-suffixed CustomObject is rejected at the handler boundary
 *     with `error.kind: 'invalid-query'`. This is sharper than
 *     letting an obvious typo (`CustomField:Account.Industry__c`)
 *     silently return an empty subscriber list — the v1.5 contract
 *     pins the input axis explicitly to Platform Events.
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
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
  listNodesByType,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Inclusive upper bound on `limit`. Mirrors the
 * `FIND_APEX_USAGES_MAX_LIMIT` and `INTEGRATION_MAP_MAX_LIMIT`
 * ceilings so every enumeration-style MCP tool shares the same
 * blast-radius cap.
 */
const EVENT_SUBSCRIBERS_MAX_LIMIT = 500;

/**
 * Default `limit` when the caller omits it. Set to 50 because most
 * Platform Events in production have a handful of subscribers, not
 * hundreds — the architect almost always wants the full list rather
 * than a paginated slice.
 */
const EVENT_SUBSCRIBERS_DEFAULT_LIMIT = 50;

/**
 * The Platform Event id prefix. v1.5 R3 extractors emit `listensTo`
 * edges into `CustomObject:{ApiName}__e` targets; the canonical id
 * form starts with this prefix and ends with the `__e` suffix on the
 * ApiName side.
 */
const EVENT_ID_PREFIX = 'CustomObject:';

/**
 * The Platform Event API name suffix. Salesforce Platform Events are
 * Standard Objects ending in `__e`; the v1.5 contract pins event ids
 * to this suffix.
 */
const EVENT_API_NAME_SUFFIX = '__e';

/**
 * The set of node types that count as valid Platform Event
 * subscribers. The v1.5 R3 extractors emit `listensTo` only from
 * these three node types; other subscriber surfaces are out of scope
 * for v1.5 and would be discarded by this filter.
 */
const SUBSCRIBER_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'ApexTrigger',
  'ApexClass',
  'Flow',
]);

/**
 * GROUP C: the set of node types that count as valid Platform Event
 * *publishers* — code that emits the event via an outbound `writesTo` edge into
 * the event node. Flows (`<recordCreates>` on a `__e`) and Apex
 * (`EventBus.publish(...)`) and Apex triggers can all publish. Other node types
 * on a `writesTo` edge (e.g. a stray CustomField) are filtered out.
 */
const PUBLISHER_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'Flow',
  'ApexClass',
  'ApexTrigger',
]);

/**
 * Zod schema for the `sfi.event_subscribers` tool input.
 *
 *   - `eventId`: required, non-empty string. The canonical Platform
 *     Event id (`CustomObject:{ApiName}__e`). Invalid ids surface as
 *     `invalid-query` from the handler, not a Zod-level rejection —
 *     Zod cannot express the suffix constraint here.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 50 inside
 *     the handler when omitted.
 */
export const eventSubscribersInputSchema = z.object({
  // Optional (R0791 fix): OMIT to get the catalog of ALL Platform Events with
  // their subscriber counts — answers "what platform events does this org
  // publish?". Supply it for the subscriber list of one specific event.
  eventId: z.string().min(1).optional(),
  // Natural host alias after resolve: the bare Platform Event API name
  // (`Application_Event__e`), resolved to `CustomObject:{apiName}` internally.
  // Previously an unknown key Zod stripped, so an apiName-shaped call silently
  // fell through to CATALOG mode (empty top-level publishers/channels) instead
  // of the single-event detail. When both are supplied, `eventId` wins.
  eventApiName: z.string().min(1).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(EVENT_SUBSCRIBERS_MAX_LIMIT)
    .optional(),
});

/** Parsed input shape, inferred from `eventSubscribersInputSchema`. */
export type EventSubscribersInput = z.infer<typeof eventSubscribersInputSchema>;

/**
 * One subscriber in the output list. Combines the source node's
 * identity (`id`, `type`, `apiName`) with the edge's metadata
 * (`source`, `properties`). The edge metadata is what differentiates
 * a trigger subscriber from a Flow subscriber when both are reading
 * the same event — the `source` field carries the extractor name and
 * the `properties` blob carries any subscription-time data the
 * extractor decided to surface (the Apex class's interface name, the
 * Flow's record-trigger config, etc.).
 */
export interface EventSubscriber {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly source: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/**
 * GROUP C: one publisher in the output list — code that EMITS the event,
 * mirroring {@link EventSubscriber} but resolved from the event's INBOUND
 * `writesTo` edges instead of `listensTo`. Surfaces a published-but-unsubscribed
 * event (writesTo publishers, zero listensTo subscribers) so it no longer looks
 * orphaned. `source` is the emitting extractor; `properties` is the edge blob,
 * carrying the declared `operation` (create/publish) and `mechanism`
 * (flow-create-record / EventBus.publish) where the extractor surfaced them.
 *
 * HONESTY: detection is the modeled `writesTo` edge only, and coverage is
 * ASYMMETRIC. A Flow `<recordCreates>` on the event mints a `writesTo` edge and
 * DOES appear here. Apex `EventBus.publish(...)` does NOT: no scanner in
 * `packages/parsers/src` or `packages/extractors/src` detects it (the Apex
 * scanner covers `EventBus.subscribe` → `listensTo` and nothing on the publish
 * side), so an Apex publisher never reaches this list. This renderer would
 * surface such an edge if a future scanner minted one — the test fixture seeds
 * one directly, which is why the suite is green on a path the extractor cannot
 * produce. Dynamically-built publishes and managed-package publishers are also
 * NOT modeled.
 */
export interface EventPublisher {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly source: string;
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * Human-readable description of the publishing component, read from the
   * node's `description` property (e.g. the Flow's declared description field
   * or the Apex class doc comment captured at extraction time). `null` when the
   * publisher has no declared description.
   *
   * Surfaced here so the architect can read "what does this publisher do?" from
   * a single tool call rather than needing a follow-up `sfi.get_component` call.
   */
  readonly description: string | null;
}

/**
 * CR-CAP-18: one publish-side channel binding for an event. Surfaced by walking
 * the event's INBOUND `references` edges tagged
 * `referenceKind === 'platformEventChannelMember'` (the member→event edge) to
 * the member, then the member's INBOUND `parentOf` to its PlatformEventChannel.
 * Answers "if I publish this event, what channel routes it (with what declared
 * filter)?" in the same call as the subscriber list.
 *
 * HONESTY: `filterExpression` is the DECLARED XML text from the
 * `*.platformEventChannelMember-meta.xml`; it is NOT runtime filter
 * EVALUATION (which records actually flow needs record-level data the vault
 * lacks).
 */
export interface EventChannelBinding {
  readonly channelId: ComponentId | null;
  readonly channelType: string | null;
  readonly memberId: ComponentId;
  readonly filterExpression: string | null;
}

/** One Platform Event in catalog mode (eventId omitted). */
export interface EventCatalogEntry {
  readonly eventId: ComponentId;
  readonly eventApiName: string;
  readonly subscriberCount: number;
  /**
   * GROUP C: count of modeled `writesTo` publishers (Flow/ApexClass/ApexTrigger)
   * that emit this event. A nonzero `publisherCount` with a zero
   * `subscriberCount` flags a published-but-unsubscribed event.
   */
  readonly publisherCount: number;
}

/**
 * Payload wrapped inside the `McpResponse` envelope on success.
 *
 * Single-event mode (eventId supplied): `subscribers` + `eventApiName` are set,
 * `events` is absent. Catalog mode (eventId omitted): `events` lists every
 * Platform Event with its subscriber count, `subscribers` is `[]`, and
 * `eventApiName` is `null`.
 */
export interface EventSubscribersOutput {
  readonly subscribers: readonly EventSubscriber[];
  readonly eventApiName: string | null;
  readonly events?: readonly EventCatalogEntry[];
  /**
   * GROUP C: the code that PUBLISHES this event (Flow/Apex emitting a `writesTo`
   * edge into the event). Present only in single-event mode (eventId supplied).
   * Empty when nothing modeled publishes the event — empty≠absent. Apex
   * `EventBus.publish(...)` has NO detector, so an event published only from
   * Apex reads as empty here; dynamic and managed-package publishers are also
   * unmodeled. Surfacing this stops a published-but-unsubscribed event from
   * looking orphaned.
   */
  readonly publishers?: readonly EventPublisher[];
  /**
   * CR-CAP-18: the publish-side channel(s) that route this event, each with the
   * declared per-member filter. Present only in single-event mode (eventId
   * supplied). Empty when no PlatformEventChannelMember binds the event.
   */
  readonly channels?: readonly EventChannelBinding[];
  /** §C3 honesty: heuristic-detection + empty≠absent disclosure (never a silent empty). */
  readonly boundaries: readonly string[];
}

const EVENT_SUB_HEURISTIC_DISCLOSURE =
  'Subscribers are detected from modeled `listensTo` edges (Apex `Triggerable<X__e>` / Flow PlatformEvent triggers). Apex EventBus.subscribe is now recognized heuristically (static/resolvable channel args only); dynamically-built subscriptions (a computed/variable channel arg) and managed-package listeners remain invisible.';
// CR-CAP-18: publish-side channel routing + declared per-member filters ARE now
// extracted from `*.platformEventChannel(Member)-meta.xml` (declared XML text,
// NOT runtime filter evaluation). Surfaced in `channels`.
const EVENT_SUB_CHANNEL_DISCLOSURE =
  'Publish-side channel routing and per-member filter expressions ARE extracted from `*.platformEventChannel(Member)-meta.xml` (declared XML text — NOT runtime filter EVALUATION; which records actually flow needs record-level data the vault lacks).';
const EVENT_SUB_EMPTY_DISCLOSURE =
  'No subscribers found for this event — NOT proof nothing subscribes. Apex `EventBus.subscribe(...)` is now recognized heuristically (static/resolvable channel args only); dynamically-built subscriptions and managed-package listeners remain invisible. Verify in Setup before assuming the event is unused.';
// GROUP C: publish-side CODE (the publishers list).
const EVENT_SUB_PUBLISHER_DISCLOSURE =
  'Publishers are detected from modeled `writesTo` edges. Coverage is ASYMMETRIC: a Flow `<recordCreates>` on the event IS modeled and appears here; Apex `EventBus.publish(...)` is NOT — no scanner in this codebase detects it, so an Apex publisher never appears (the renderer would surface such an edge if a future scanner minted one). Dynamically-built publishes and managed-package publishers are also NOT modeled. An empty publishers list means "no modeled Flow publisher", never "nothing publishes this event".';
/**
 * CR-10: Publisher-vs-subscriber disambiguation disclosure. A Flow that
 * writes TO a platform event (recordCreates → `writesTo` edge) is a PUBLISHER,
 * not a subscriber. Only components with a `listensTo` edge SUBSCRIBE to the
 * event and receive it when published. A published-but-unsubscribed event means
 * the `subscribers` array is empty even though `publishers` is non-empty — the
 * event fires into a void (or an external consumer such as AWS EventBridge via
 * a PlatformEventChannel binding in `channels`). The two roles are mutually
 * exclusive in the graph model: `writesTo` = emits/publishes, `listensTo` = receives/subscribes.
 */
const EVENT_SUB_ROLE_DISAMBIGUATION_DISCLOSURE =
  'CRITICAL ROLE DISTINCTION: `publishers` (writesTo edges) = code that EMITS this event; `subscribers` (listensTo edges) = code that RECEIVES it. A Flow with a <recordCreates> element on this event is a PUBLISHER, not a subscriber — it appears in `publishers`, never in `subscribers`. A non-empty `publishers` list with an empty `subscribers` list means the event fires but nothing internal consumes it (check `channels` for external consumers such as AWS EventBridge).';

/**
 * Validate that `eventId` is a syntactically valid Platform Event id.
 * Returns the API name on success (the part between
 * `CustomObject:` and the trailing `__e`, e.g.
 * `Account_Change__e`). The trailing `__e` is preserved per the spec
 * — callers commonly want the event name with the suffix intact for
 * rendering ("Account_Change__e"), not stripped.
 */
const validateEventId = (eventId: ComponentId): string | null => {
  if (!eventId.startsWith(EVENT_ID_PREFIX)) return null;
  const apiName = eventId.slice(EVENT_ID_PREFIX.length);
  if (apiName.length === 0) return null;
  if (!apiName.endsWith(EVENT_API_NAME_SUFFIX)) return null;
  return apiName;
};

/**
 * Resolve the caller-supplied event scope into a canonical event id.
 * Precedence: an explicit `eventId` wins; otherwise a bare `eventApiName`
 * (the host alias) is lifted to `CustomObject:{apiName}`. A value already
 * carrying the `CustomObject:` prefix is passed through so a host that
 * mistakenly sends the full id under `eventApiName` still resolves (defends
 * against `CustomObject:CustomObject:…`). Returns `undefined` when neither is
 * supplied — the catalog-mode signal. Syntactic validity (the `__e` suffix) is
 * still enforced downstream by {@link validateEventId}, so a non-event apiName
 * surfaces as `invalid-query`, not a silent empty.
 */
const resolveRequestedEventId = (
  input: EventSubscribersInput,
): ComponentId | undefined => {
  if (input.eventId !== undefined) return input.eventId;
  if (input.eventApiName === undefined) return undefined;
  return input.eventApiName.startsWith(EVENT_ID_PREFIX)
    ? input.eventApiName
    : `${EVENT_ID_PREFIX}${input.eventApiName}`;
};

/**
 * Build an `EventSubscriber` from a resolved node + its incoming `listensTo`
 * edge. Returns `null` when the node is missing (sparse-graph case) or its type
 * is outside the subscriber set; the caller drops those rather than erroring,
 * matching the v0.3 / v1.1 sharp-focus tool conventions.
 */
const buildSubscriber = (
  node: Node | undefined,
  edge: Edge,
): EventSubscriber | null => {
  if (node === undefined) return null;
  if (!SUBSCRIBER_NODE_TYPES.has(node.type)) return null;
  return {
    id: node.id,
    type: node.type,
    apiName: node.apiName,
    source: edge.source,
    properties: edge.properties,
  };
};

/**
 * Deterministic comparator: id ASC. Two subscribers with the same id
 * collapse to a single entry inside the de-dup map upstream, so the
 * comparator does not need a secondary tiebreaker.
 */
const compareSubscribers = (a: EventSubscriber, b: EventSubscriber): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * P3b: merge a second `listensTo` edge for an ALREADY-seen subscriber node into
 * the existing record, preserving every subscription path. A class can listen
 * via both `Triggerable<X__e>` and `EventBus.subscribe('X__e')`; the two edges
 * survive the edge PK because their `source` differs, so the consumer must fold
 * them into ONE subscriber. The kept `source`/`properties` come from the first
 * edge (id-stable); a `mechanisms` array unions the per-edge `mechanism` tags
 * (and falls back to the edge `source` when a mechanism is absent) so the
 * caller can still see that the node subscribes via multiple paths.
 */
const mergeSubscriber = (
  kept: EventSubscriber,
  next: EventSubscriber,
): EventSubscriber => {
  const mechanismOf = (s: EventSubscriber): string => {
    const m = s.properties['mechanism'];
    return typeof m === 'string' && m.length > 0 ? m : s.source;
  };
  const existing = kept.properties['mechanisms'];
  const base = Array.isArray(existing)
    ? (existing as string[])
    : [mechanismOf(kept)];
  const merged = [...new Set([...base, mechanismOf(next)])].sort();
  return {
    ...kept,
    properties: { ...kept.properties, mechanisms: merged },
  };
};

/** Deterministic comparator for publishers: id ASC (mirrors subscribers). */
const comparePublishers = (a: EventPublisher, b: EventPublisher): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * GROUP C: resolve every modeled publisher of `eventId` by walking its INBOUND
 * `writesTo` edges and keeping only {@link PUBLISHER_NODE_TYPES}. Sorted id-ASC
 * for deterministic output. ONE `listNodesByIds` resolves every source node,
 * replacing the former per-edge `getNodeById` N+1 (the `source`/`properties`
 * come from the edge, the identity from the node; a missing/off-type node is
 * dropped exactly as the old per-edge null/type filter did).
 */
const resolvePublishers = async (
  ctx: Context,
  eventId: ComponentId,
): Promise<Result<EventPublisher[], string>> => {
  const edgesResult = await listEdges(ctx.graph, eventId, {
    direction: 'in',
    edgeType: 'writesTo',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);

  const nodesResult = await listNodesByIds(
    ctx.graph,
    edgesResult.value.map((e) => e.fromId),
  );
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const byId = new Map(nodesResult.value.map((n) => [n.id, n]));

  const publishers: EventPublisher[] = [];
  for (const edge of edgesResult.value) {
    const node = byId.get(edge.fromId);
    if (node === undefined) continue;
    if (!PUBLISHER_NODE_TYPES.has(node.type)) continue;
    const rawDesc = node.properties['description'];
    const description =
      typeof rawDesc === 'string' && rawDesc.length > 0 ? rawDesc : null;
    publishers.push({
      id: node.id,
      type: node.type,
      apiName: node.apiName,
      source: edge.source,
      properties: edge.properties,
      description,
    });
  }
  publishers.sort(comparePublishers);
  return ok(publishers);
};

/**
 * CR-CAP-18: resolve the publish-side channel bindings for an event. Walks the
 * event's INBOUND `references` edges tagged
 * `referenceKind === 'platformEventChannelMember'` (member→event), resolves
 * each member's INBOUND `parentOf` to its PlatformEventChannel, and reads the
 * channel's declared `channelType`. The declared per-member `filterExpression`
 * is read from the member→event edge's properties (no extra hop). Sorted by
 * memberId for deterministic output.
 */
const resolveChannelBindings = async (
  ctx: Context,
  eventId: ComponentId,
): Promise<Result<EventChannelBinding[], string>> => {
  const memberEdges = await listEdges(ctx.graph, eventId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!memberEdges.ok) return err(memberEdges.error.message);

  // Keep only channel-member references, preserving edge order + multiplicity.
  const memberEntries = memberEdges.value
    .filter((edge) => edge.properties['referenceKind'] === 'platformEventChannelMember')
    .map((edge) => {
      const filterRaw = edge.properties['filterExpression'];
      return {
        memberId: edge.fromId,
        filterExpression: typeof filterRaw === 'string' ? filterRaw : null,
      };
    });

  // ONE batched fetch of every member's INBOUND parentOf edges, then ONE batched
  // fetch of those parents' nodes — replacing the per-member `listEdges` +
  // per-parent `getNodeById` nested N+1. Each member's parentOf bucket is sorted
  // by the FULL (to_id, edge_type, from_id, source) order (to_id + edge_type
  // fixed), matching the old per-member `listEdges` order, so the FIRST
  // PlatformEventChannel match is the same edge.
  const parentBatch = await listEdgesForNodes(
    ctx.graph,
    memberEntries.map((m) => m.memberId),
    { direction: 'in', edgeTypes: ['parentOf'] },
  );
  if (!parentBatch.ok) return err(parentBatch.error.message);
  const parentIds: ComponentId[] = [];
  for (const entry of memberEntries) {
    for (const pe of parentBatch.value.get(entry.memberId) ?? []) {
      parentIds.push(pe.fromId);
    }
  }
  const parentNodesResult = await listNodesByIds(ctx.graph, parentIds);
  if (!parentNodesResult.ok) return err(parentNodesResult.error.message);
  const parentById = new Map(parentNodesResult.value.map((n) => [n.id, n]));

  const bindings: EventChannelBinding[] = [];
  for (const { memberId, filterExpression } of memberEntries) {
    let channelId: ComponentId | null = null;
    let channelType: string | null = null;
    for (const pe of parentBatch.value.get(memberId) ?? []) {
      const node = parentById.get(pe.fromId);
      if (node !== undefined && node.type === 'PlatformEventChannel') {
        channelId = node.id;
        const ct = node.properties['channelType'];
        channelType = typeof ct === 'string' ? ct : null;
        break;
      }
    }
    bindings.push({ channelId, channelType, memberId, filterExpression });
  }
  bindings.sort((a, b) =>
    a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
  );
  return ok(bindings);
};

/**
 * The `sfi.event_subscribers` MCP tool. Returns every subscriber
 * (ApexTrigger, ApexClass, Flow) that emits a `listensTo` edge into
 * the supplied Platform Event id. The output's `eventApiName` field
 * is the event's API name with the `__e` suffix preserved.
 *
 * @example
 *   const r = await eventSubscribersHandler(ctx, {
 *     eventId: 'CustomObject:Account_Change__e',
 *   });
 *   if (r.ok) console.log(r.value.data.subscribers.length);
 */
export const eventSubscribersHandler = async (
  ctx: Context,
  input: EventSubscribersInput,
): Promise<Result<McpResponse<EventSubscribersOutput>, McpError>> => {
  const limit = input.limit ?? EVENT_SUBSCRIBERS_DEFAULT_LIMIT;

  // Resolve the requested event scope up front so the apiName alias
  // (`eventApiName: 'Application_Event__e'`) enters DETAIL mode instead of
  // silently falling through to the catalog.
  const requestedEventId = resolveRequestedEventId(input);

  // Catalog mode (R0791): no event scope → enumerate every Platform Event
  // (CustomObject ending in `__e`) with its subscriber count, so
  // "what platform events does this org publish?" is answerable in one call.
  if (requestedEventId === undefined) {
    const nodesResult = await listNodesByType(ctx.graph, 'CustomObject', {
      limit: EVENT_SUBSCRIBERS_MAX_LIMIT,
    });
    if (!nodesResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodesResult.error.message}` });
    }
    // Batched catalog: replace the former per-event `listEdges` + per-subscriber
    // / per-publisher `getNodeById` org-wide nested N+1 (O(events x fan-out)
    // serial DuckDB queries) with THREE round-trips total — one
    // `listEdgesForNodes` for every event's inbound `listensTo`, one for every
    // event's inbound `writesTo`, and one `listNodesByIds` over the union of
    // endpoint ids. Each per-event bucket is sorted by the FULL (to_id,
    // edge_type, from_id, source) order (to_id + edge_type fixed per bucket), so
    // the DISTINCT-subscriber Set and the per-edge publisher count are byte-
    // identical to the old per-event walk.
    const eventNodes = nodesResult.value.filter((node) =>
      node.apiName.endsWith(EVENT_API_NAME_SUFFIX),
    );
    const eventIds = eventNodes.map((node) => node.id);
    const listensToBatch = await listEdgesForNodes(ctx.graph, eventIds, {
      direction: 'in',
      edgeTypes: ['listensTo'],
    });
    if (!listensToBatch.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${listensToBatch.error.message}` });
    }
    const writesToBatch = await listEdgesForNodes(ctx.graph, eventIds, {
      direction: 'in',
      edgeTypes: ['writesTo'],
    });
    if (!writesToBatch.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${writesToBatch.error.message}` });
    }
    const endpointIds = new Set<ComponentId>();
    for (const evId of eventIds) {
      for (const edge of listensToBatch.value.get(evId) ?? []) endpointIds.add(edge.fromId);
      for (const edge of writesToBatch.value.get(evId) ?? []) endpointIds.add(edge.fromId);
    }
    const endpointNodesResult = await listNodesByIds(ctx.graph, [...endpointIds]);
    if (!endpointNodesResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${endpointNodesResult.error.message}` });
    }
    const endpointById = new Map(endpointNodesResult.value.map((n) => [n.id, n]));

    const events: EventCatalogEntry[] = [];
    for (const node of eventNodes) {
      // Count DISTINCT subscriber node ids (ApexTrigger/ApexClass/Flow) so the
      // catalog count matches single-event mode. P3b de-dup: a node listening
      // via BOTH Triggerable AND EventBus.subscribe emits two `listensTo` edges
      // (different sources survive the edge PK); counting per-edge would
      // double-count it. Keep a per-event id set.
      const subscriberIds = new Set<ComponentId>();
      for (const edge of listensToBatch.value.get(node.id) ?? []) {
        const sub = endpointById.get(edge.fromId);
        if (sub !== undefined && SUBSCRIBER_NODE_TYPES.has(sub.type)) {
          subscriberIds.add(sub.id);
        }
      }
      // GROUP C: count modeled `writesTo` publishers (Flow/Apex emitting the
      // event) so the catalog flags published-but-unsubscribed events. Matches
      // resolvePublishers: a per-EDGE count over publisher-typed sources (a
      // publisher with two writesTo edges counts twice, as before).
      let publisherCount = 0;
      for (const edge of writesToBatch.value.get(node.id) ?? []) {
        const pub = endpointById.get(edge.fromId);
        if (pub !== undefined && PUBLISHER_NODE_TYPES.has(pub.type)) publisherCount += 1;
      }
      events.push({
        eventId: node.id,
        eventApiName: node.apiName,
        subscriberCount: subscriberIds.size,
        publisherCount,
      });
    }
    events.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
    return ok({
      data: { subscribers: [], eventApiName: null, events: events.slice(0, limit), boundaries: [EVENT_SUB_HEURISTIC_DISCLOSURE] },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const apiName = validateEventId(requestedEventId);
  if (apiName === null) {
    return err({
      kind: 'invalid-query',
      message: `event scope must resolve to a Platform Event canonical id (CustomObject:{ApiName}__e); got '${requestedEventId}' (from ${input.eventId !== undefined ? 'eventId' : 'eventApiName'})`,
      path: input.eventId !== undefined ? 'eventId' : 'eventApiName',
    });
  }

  const edgesResult = await listEdges(ctx.graph, requestedEventId, {
    direction: 'in',
    edgeType: 'listensTo',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  // P3b de-dup: a single node can emit MORE THAN ONE inbound `listensTo` edge
  // for the same event — e.g. a class that BOTH `implements Triggerable<X__e>`
  // (apex-class-extractor) AND calls `EventBus.subscribe('X__e')` (apex-scanner).
  // The edge PK is (fromId, toId, edgeType, SOURCE), so the differing sources
  // keep BOTH edges alive; without de-dup the same subscriber would appear
  // twice. Collapse by node id, keeping the first-resolved entry and MERGING
  // each subsequent edge's source + properties so no subscription signal is
  // lost (the surviving record discloses every path via `mechanisms`).
  // ONE batched fetch of every listensTo source, replacing the per-edge
  // `getNodeById` N+1. Iterate the edges in listEdges order (unchanged) so the
  // P3b merge keeps the SAME first-resolved entry and folds subsequent edges'
  // sources identically.
  const subNodesResult = await listNodesByIds(
    ctx.graph,
    edgesResult.value.map((e) => e.fromId),
  );
  if (!subNodesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${subNodesResult.error.message}`,
    });
  }
  const subNodeById = new Map(subNodesResult.value.map((n) => [n.id, n]));

  const byId = new Map<ComponentId, EventSubscriber>();
  for (const edge of edgesResult.value) {
    const resolved = buildSubscriber(subNodeById.get(edge.fromId), edge);
    if (resolved === null) continue;
    const existing = byId.get(resolved.id);
    if (existing === undefined) {
      byId.set(resolved.id, resolved);
    } else {
      byId.set(resolved.id, mergeSubscriber(existing, resolved));
    }
  }
  const sorted = [...byId.values()].sort(compareSubscribers).slice(0, limit);

  // CR-CAP-18: resolve the publish-side channel routing for this event.
  const channelsResult = await resolveChannelBindings(ctx, requestedEventId);
  if (!channelsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${channelsResult.error}`,
    });
  }
  const channels = channelsResult.value;

  // GROUP C: resolve the publish-side CODE (Flow/Apex emitting `writesTo`).
  const publishersResult = await resolvePublishers(ctx, requestedEventId);
  if (!publishersResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${publishersResult.error}`,
    });
  }
  const publishers = publishersResult.value;

  const boundaries =
    sorted.length === 0
      ? [
          EVENT_SUB_HEURISTIC_DISCLOSURE,
          EVENT_SUB_CHANNEL_DISCLOSURE,
          EVENT_SUB_PUBLISHER_DISCLOSURE,
          EVENT_SUB_ROLE_DISAMBIGUATION_DISCLOSURE,
          EVENT_SUB_EMPTY_DISCLOSURE,
        ]
      : [
          EVENT_SUB_HEURISTIC_DISCLOSURE,
          EVENT_SUB_CHANNEL_DISCLOSURE,
          EVENT_SUB_PUBLISHER_DISCLOSURE,
          EVENT_SUB_ROLE_DISAMBIGUATION_DISCLOSURE,
        ];

  return ok({
    data: { subscribers: sorted, eventApiName: apiName, channels, publishers, boundaries },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
