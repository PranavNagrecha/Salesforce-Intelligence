/**
 * Handler for the `sfi.cdc_subscribers` MCP tool.
 *
 * The v2.8 async-deep-tier companion to `sfi.event_subscribers`. Where
 * `event_subscribers` enumerates Platform Event subscribers (objects
 * ending in `__e`), this tool enumerates Change Data Capture (CDC)
 * subscribers — Apex triggers, Apex classes, and Flows that listen to
 * `*ChangeEvent` or `*__ChangeEvent` synthetic events.
 *
 * Per the task definition the tool LEVERAGES THE EXISTING `listensTo`
 * EDGE FAMILY (produced by v1.5 R3) rather than introducing a new
 * `subscribesToChange` edge type — CDC events are recognized by NAME
 * PATTERN on the target apiName:
 *
 *   - Standard objects: `{ObjectName}ChangeEvent` (no separator).
 *   - Custom objects: `{ObjectNameWithout__c}__ChangeEvent`.
 *
 * The architect's question this tool answers: "if the data on this
 * object changes via the platform's CDC stream, what code runs?"
 *
 * Implementation notes:
 *   - When `sObjectFilter` is supplied, we resolve the synthetic
 *     ChangeEvent id from the filter (e.g., `Account` →
 *     `AccountChangeEvent`; `Order__c` → `Order__ChangeEvent`) and
 *     scan incoming `listensTo` edges for that single event.
 *   - When omitted, we walk every CustomObject node whose apiName
 *     matches the CDC name-pattern rule and aggregate their incoming
 *     `listensTo` edges.
 *   - Subscribers are restricted to the same three node types as
 *     `event_subscribers`: ApexTrigger, ApexClass, Flow. Other node
 *     types (e.g., a hypothetical custom subscriber) are filtered out
 *     so the v2.8 contract pins the subscriber surface to the three
 *     v1.5 R3 producers.
 *   - The output's `source` is the EDGE's `source` field (the
 *     extractor name); the subscriber's identity comes from the
 *     resolved node. Sort is `(subscriberId ASC, changeEventName ASC)`
 *     so multi-event subscribers render deterministically.
 *   - Honesty axis (verbatim in `disclosure`): CDC subscription
 *     detection here recognizes by NAME PATTERN only. The
 *     `EventBus.subscribe(...)` programmatic registration path is
 *     invisible to v2.8; runtime channel-filter expressions in
 *     `*.platformEventChannelMember-meta.xml` are also out of scope.
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
 * The set of node types that count as valid CDC subscribers — the same
 * three v1.5 R3 producers `event_subscribers` accepts. Other node
 * types are filtered out so the v2.8 contract is stable.
 */
const SUBSCRIBER_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'ApexTrigger',
  'ApexClass',
  'Flow',
]);

/**
 * The CDC event id prefix. v2.8 recognizes CDC by name pattern on the
 * `listensTo` edge's `toId`; the target node is a `CustomObject:` —
 * the same prefix used for `__e` Platform Events.
 */
const CHANGE_EVENT_ID_PREFIX = 'CustomObject:';

/**
 * The CDC event apiName suffix for CUSTOM objects. Custom objects
 * `MyObj__c` become `MyObj__ChangeEvent` — the `__c` is dropped and
 * `__ChangeEvent` (with a single leading double-underscore) is
 * appended.
 */
const CUSTOM_CHANGE_EVENT_SUFFIX = '__ChangeEvent';

/**
 * The CDC event apiName suffix for STANDARD objects. Standard objects
 * `Account` become `AccountChangeEvent` — no separator, just the
 * `ChangeEvent` literal. The discriminator from the custom case is
 * the presence of the double-underscore in `__ChangeEvent`.
 */
const STANDARD_CHANGE_EVENT_SUFFIX = 'ChangeEvent';

/**
 * The `__c` suffix on a custom object's apiName. Stripped when
 * computing the CDC event name for a custom object.
 */
const CUSTOM_OBJECT_SUFFIX = '__c';

/**
 * Recognize whether an apiName (the part after `CustomObject:`)
 * matches the CDC event name pattern. Returns `true` for any name
 * ending in `ChangeEvent` (standard form) or `__ChangeEvent` (custom
 * form). Returns `false` for `__e`-suffixed Platform Events and for
 * regular sObjects.
 */
const isChangeEventApiName = (apiName: string): boolean =>
  apiName.endsWith(STANDARD_CHANGE_EVENT_SUFFIX) &&
  apiName.length > STANDARD_CHANGE_EVENT_SUFFIX.length;

/**
 * Compute the CDC event apiName for a given sObject apiName. Standard
 * objects (`Account`) become `AccountChangeEvent`; custom objects
 * (`Order__c`) become `Order__ChangeEvent` (the `__c` is dropped and
 * `__ChangeEvent` is appended). Empty / null inputs are passed through
 * by the caller's guard.
 */
const sObjectApiNameToCdcEventName = (apiName: string): string => {
  if (apiName.endsWith(CUSTOM_OBJECT_SUFFIX)) {
    return apiName.slice(0, -CUSTOM_OBJECT_SUFFIX.length) + CUSTOM_CHANGE_EVENT_SUFFIX;
  }
  return apiName + STANDARD_CHANGE_EVENT_SUFFIX;
};

/**
 * Zod schema for the `sfi.cdc_subscribers` tool input.
 *
 *   - `sObjectFilter`: optional, non-empty string. The sObject apiName
 *     to narrow the scan to (e.g., `'Account'` or `'Order__c'`). When
 *     omitted the tool scans every CustomObject whose apiName matches
 *     the CDC name-pattern rule.
 */
export const cdcSubscribersInputSchema = z.object({
  sObjectFilter: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `cdcSubscribersInputSchema`. */
export type CdcSubscribersInput = z.infer<typeof cdcSubscribersInputSchema>;

/**
 * One subscriber in the output list. Combines the source node's
 * identity (`subscriberId`, `subscriberType`) with the CDC event name
 * the edge targets (the `changeEventName` carries the verbatim CDC
 * event apiName so the renderer can render "subscribed to
 * AccountChangeEvent") and the producer extractor's `source` field.
 */
export interface CdcSubscriber {
  readonly subscriberId: ComponentId;
  readonly subscriberType: 'ApexClass' | 'ApexTrigger' | 'Flow';
  readonly changeEventName: string;
  readonly source: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CdcSubscribersOutput {
  readonly subscribers: readonly CdcSubscriber[];
  readonly summary: {
    readonly totalSubscribers: number;
    readonly uniqueChangeEvents: number;
  };
  readonly disclosure: string;
}

/**
 * Verbatim honesty disclosure surfaced ALWAYS in the response. The
 * heuristic v2.8 CDC detection sees the `listensTo` edge produced by
 * the v1.5 R3 extractors and matches on the target apiName's CDC
 * pattern; runtime `EventBus.subscribe(...)` registration and
 * per-channel filter expressions in
 * `*.platformEventChannelMember-meta.xml` are invisible to v2.8.
 */
const CDC_SUBSCRIBERS_DISCLOSURE =
  'v2.8 recognizes CDC subscribers by name pattern on the `listensTo` edge target (objects ending in `ChangeEvent` or `__ChangeEvent`). Runtime `EventBus.subscribe(...)` registration and per-channel filter expressions in `*.platformEventChannelMember-meta.xml` are NOT extracted; subscribers may exist that this tool cannot see.';

/**
 * Deterministic subscriber comparator: subscriberId ASC, then
 * changeEventName ASC. The tiebreaker handles the rare case where one
 * Apex class subscribes to multiple change events.
 */
const compareSubscribers = (a: CdcSubscriber, b: CdcSubscriber): number => {
  if (a.subscriberId !== b.subscriberId) {
    return a.subscriberId < b.subscriberId ? -1 : 1;
  }
  if (a.changeEventName !== b.changeEventName) {
    return a.changeEventName < b.changeEventName ? -1 : 1;
  }
  return 0;
};

/**
 * Resolve one incoming `listensTo` edge into a `CdcSubscriber`. The
 * caller has already validated the edge's `toId` matches the CDC
 * name pattern; this resolver fetches the producer node, narrows by
 * subscriber type, and packs the per-subscriber record. Returns
 * `null` for sparse-graph misses or non-subscriber producer types.
 */
const resolveSubscriber = async (
  ctx: Context,
  edge: Edge,
  changeEventName: string,
): Promise<Result<CdcSubscriber | null, string>> => {
  const nodeResult = await getNodeById(ctx.graph, edge.fromId);
  if (!nodeResult.ok) {
    return err(nodeResult.error.message);
  }
  const node: Node | null = nodeResult.value;
  if (node === null) return ok(null);
  if (!SUBSCRIBER_NODE_TYPES.has(node.type)) return ok(null);
  return ok({
    subscriberId: node.id,
    subscriberType: node.type as 'ApexClass' | 'ApexTrigger' | 'Flow',
    changeEventName,
    source: edge.source,
  });
};

/**
 * Collect every Change Event id present in the graph. Used when the
 * caller omits `sObjectFilter` — we scan every CustomObject node and
 * keep the ones whose apiName matches the CDC name pattern.
 */
const collectChangeEventIds = async (
  ctx: Context,
): Promise<Result<readonly ComponentId[], string>> => {
  // CustomObject is the only node type that holds CDC event names; the
  // synthetic ChangeEvent type from the AsyncTopologySemantics spec
  // becomes a CustomObject in the v2.8 graph because the v1.5 R3
  // `listensTo` producers emit `CustomObject:` targets (not a new
  // synthetic prefix). Walk every CustomObject and filter by the
  // CDC name-pattern rule.
  const result = await listNodesByType(ctx.graph, 'CustomObject', {
    limit: 500,
  });
  if (!result.ok) return err(result.error.message);
  const ids: ComponentId[] = [];
  for (const node of result.value) {
    if (isChangeEventApiName(node.apiName)) ids.push(node.id);
  }
  return ok(ids);
};

/**
 * Resolve the set of Change Event ids to scan given the caller's
 * input. When `sObjectFilter` is supplied we compute the synthetic
 * id from the filter; when omitted we scan every CustomObject in the
 * graph whose apiName matches the CDC pattern.
 */
const resolveChangeEventIds = async (
  ctx: Context,
  input: CdcSubscribersInput,
): Promise<Result<readonly ComponentId[], string>> => {
  if (input.sObjectFilter !== undefined) {
    const cdcEventName = sObjectApiNameToCdcEventName(input.sObjectFilter);
    return ok([`${CHANGE_EVENT_ID_PREFIX}${cdcEventName}`]);
  }
  return collectChangeEventIds(ctx);
};

/**
 * The `sfi.cdc_subscribers` MCP tool. Returns every Apex trigger,
 * Apex class, and Flow that emits an incoming `listensTo` edge into
 * a Change Event target. `sObjectFilter` optionally narrows the scan
 * to a single sObject's CDC stream (e.g., `Account` →
 * `AccountChangeEvent`; `Order__c` → `Order__ChangeEvent`); when
 * omitted, every CDC-recognizable event in the graph is scanned.
 *
 * @example
 *   const r = await cdcSubscribersHandler(ctx, { sObjectFilter: 'Account' });
 *   if (r.ok) console.log(r.value.data.summary.totalSubscribers);
 */
export const cdcSubscribersHandler = async (
  ctx: Context,
  input: CdcSubscribersInput,
): Promise<Result<McpResponse<CdcSubscribersOutput>, McpError>> => {
  const eventIdsResult = await resolveChangeEventIds(ctx, input);
  if (!eventIdsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${eventIdsResult.error}`,
    });
  }
  const eventIds = eventIdsResult.value;

  const subscribers: CdcSubscriber[] = [];
  const uniqueEvents = new Set<string>();
  for (const eventId of eventIds) {
    // Recover the event's apiName from the canonical id form
    // `CustomObject:{ApiName}` — splitting on the first ':' is the
    // contract-stable way to do this.
    const colon = eventId.indexOf(':');
    if (colon === -1) continue;
    const apiName = eventId.slice(colon + 1);
    if (!isChangeEventApiName(apiName)) continue;

    const edgesResult = await listEdges(ctx.graph, eventId, {
      direction: 'in',
      edgeType: 'listensTo',
    });
    if (!edgesResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${edgesResult.error.message}`,
      });
    }
    let producedAtLeastOne = false;
    for (const edge of edgesResult.value) {
      const resolved = await resolveSubscriber(ctx, edge, apiName);
      if (!resolved.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${resolved.error}`,
        });
      }
      if (resolved.value !== null) {
        subscribers.push(resolved.value);
        producedAtLeastOne = true;
      }
    }
    if (producedAtLeastOne) uniqueEvents.add(apiName);
  }

  const sorted = subscribers.sort(compareSubscribers);

  return ok({
    data: {
      subscribers: sorted,
      summary: {
        totalSubscribers: sorted.length,
        uniqueChangeEvents: uniqueEvents.size,
      },
      disclosure: CDC_SUBSCRIBERS_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
