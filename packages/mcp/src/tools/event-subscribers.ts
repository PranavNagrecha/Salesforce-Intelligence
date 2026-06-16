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
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
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

/** One Platform Event in catalog mode (eventId omitted). */
export interface EventCatalogEntry {
  readonly eventId: ComponentId;
  readonly eventApiName: string;
  readonly subscriberCount: number;
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
  /** §C3 honesty: heuristic-detection + empty≠absent disclosure (never a silent empty). */
  readonly boundaries: readonly string[];
}

const EVENT_SUB_HEURISTIC_DISCLOSURE =
  'Subscribers are detected from modeled `listensTo` edges (Apex/Flow trigger subscriptions). Detection is partial: some subscriptions (CDC channel pattern, dynamically-built subscriptions, managed-package listeners) are not modeled.';
const EVENT_SUB_EMPTY_DISCLOSURE =
  'No subscribers found for this event — NOT proof nothing subscribes. Dynamically-built subscriptions, CDC channel subscriptions, and managed-package listeners are not modeled; verify in Setup before assuming the event is unused.';

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
 * Resolve one incoming `listensTo` edge into an `EventSubscriber`.
 * Returns `null` when the edge points at a node that is not present
 * in the graph (sparse-graph case) or whose type is outside the
 * subscriber set; the caller drops those rather than erroring,
 * matching the v0.3 / v1.1 sharp-focus tool conventions.
 */
const resolveSubscriber = async (
  ctx: Context,
  edge: Edge,
): Promise<Result<EventSubscriber | null, string>> => {
  const nodeResult = await getNodeById(ctx.graph, edge.fromId);
  if (!nodeResult.ok) {
    return err(nodeResult.error.message);
  }
  const node: Node | null = nodeResult.value;
  if (node === null) {
    return ok(null);
  }
  if (!SUBSCRIBER_NODE_TYPES.has(node.type)) {
    return ok(null);
  }
  return ok({
    id: node.id,
    type: node.type,
    apiName: node.apiName,
    source: edge.source,
    properties: edge.properties,
  });
};

/**
 * Deterministic comparator: id ASC. Two subscribers with the same id
 * collapse to a single entry inside the de-dup map upstream, so the
 * comparator does not need a secondary tiebreaker.
 */
const compareSubscribers = (a: EventSubscriber, b: EventSubscriber): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

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

  // Catalog mode (R0791): no eventId → enumerate every Platform Event
  // (CustomObject ending in `__e`) with its subscriber count, so
  // "what platform events does this org publish?" is answerable in one call.
  if (input.eventId === undefined) {
    const nodesResult = await listNodesByType(ctx.graph, 'CustomObject', {
      limit: EVENT_SUBSCRIBERS_MAX_LIMIT,
    });
    if (!nodesResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodesResult.error.message}` });
    }
    const events: EventCatalogEntry[] = [];
    for (const node of nodesResult.value) {
      if (!node.apiName.endsWith(EVENT_API_NAME_SUFFIX)) continue;
      const inEdges = await listEdges(ctx.graph, node.id, {
        direction: 'in',
        edgeType: 'listensTo',
      });
      if (!inEdges.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${inEdges.error.message}` });
      }
      // Count only real subscriber node types (ApexTrigger/ApexClass/Flow) so
      // the catalog count matches what single-event mode would return.
      let subscriberCount = 0;
      for (const edge of inEdges.value) {
        const sub = await getNodeById(ctx.graph, edge.fromId);
        if (!sub.ok) {
          return err({ kind: 'internal', message: `graph query failed: ${sub.error.message}` });
        }
        if (sub.value !== null && SUBSCRIBER_NODE_TYPES.has(sub.value.type)) {
          subscriberCount += 1;
        }
      }
      events.push({ eventId: node.id, eventApiName: node.apiName, subscriberCount });
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

  const apiName = validateEventId(input.eventId);
  if (apiName === null) {
    return err({
      kind: 'invalid-query',
      message: `eventId must be a Platform Event canonical id (CustomObject:{ApiName}__e); got '${input.eventId}'`,
      path: 'eventId',
    });
  }

  const edgesResult = await listEdges(ctx.graph, input.eventId, {
    direction: 'in',
    edgeType: 'listensTo',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  const subscribers: EventSubscriber[] = [];
  for (const edge of edgesResult.value) {
    const resolved = await resolveSubscriber(ctx, edge);
    if (!resolved.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${resolved.error}`,
      });
    }
    if (resolved.value !== null) {
      subscribers.push(resolved.value);
    }
  }

  const sorted = subscribers.sort(compareSubscribers).slice(0, limit);
  const boundaries =
    sorted.length === 0
      ? [EVENT_SUB_HEURISTIC_DISCLOSURE, EVENT_SUB_EMPTY_DISCLOSURE]
      : [EVENT_SUB_HEURISTIC_DISCLOSURE];

  return ok({
    data: { subscribers: sorted, eventApiName: apiName, boundaries },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
