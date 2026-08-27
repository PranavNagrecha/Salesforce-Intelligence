/**
 * Handler for the `sfi.cdc_subscribers` MCP tool.
 *
 * The v2.8 async-deep-tier companion to `sfi.event_subscribers`. Where
 * `event_subscribers` enumerates Platform Event subscribers (objects
 * ending in `__e`), this tool enumerates Change Data Capture (CDC)
 * subscribers — Apex triggers, Apex classes, and Flows that listen to
 * `*ChangeEvent` or `*__ChangeEvent` synthetic events.
 *
 * The tool LEVERAGES EXISTING EDGE FAMILIES rather than introducing a
 * new `subscribesToChange` edge type — CDC events are recognized by
 * NAME PATTERN on the target apiName:
 *
 *   - Standard objects: `{ObjectName}ChangeEvent` (no separator).
 *   - Custom objects: `{ObjectNameWithout__c}__ChangeEvent`.
 *
 * The architect's question this tool answers: "if the data on this
 * object changes via the platform's CDC stream, what code runs?"
 *
 * TWO edge families answer it, not one. A Flow / Apex class subscribes
 * via `listensTo`; an APEX CDC TRIGGER does not. `apex-trigger.ts`
 * emits `triggersOn` unconditionally from the trigger header and gates
 * the extra `listensTo` edge on the `__e` Platform Event suffix, so
 * `trigger X on AccountChangeEvent` produces `triggersOn` into
 * `CustomObject:AccountChangeEvent` and NO `listensTo` edge at all.
 * Reading only `listensTo` made every Apex CDC trigger invisible; the
 * scan now reads both, tagging the `triggersOn` rows with
 * `subscriptionEdge` so the mechanisms stay tellable apart.
 *
 * Implementation notes:
 *   - When `sObjectFilter` is supplied, we resolve the synthetic
 *     ChangeEvent id from the filter (e.g., `Account` →
 *     `AccountChangeEvent`; `Order__c` → `Order__ChangeEvent`) and
 *     scan that single event's incoming subscription edges.
 *   - When omitted, the scan set comes from Change Event EDGE TARGETS,
 *     not from retrieved nodes. A `{X}ChangeEvent` is synthesised by
 *     the platform and the Metadata API never emits it, so a
 *     ChangeEvent is never a node on ANY org: the previous node-only
 *     walk returned an EMPTY scan set every time, and the tool still
 *     reported `totalSubscribers: 0` — a "did not check" presented as
 *     "checked and found nothing". `summary.scannedChangeEvents` now
 *     reports the denominator, and an empty scan set says so.
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
 *     invisible. (CR-CAP-18: the DECLARED per-member filter
 *     expressions in `*.platformEventChannelMember-meta.xml` ARE now
 *     extracted — surfaced on the publish-side `references` edge — but
 *     that is the declared XML text, NOT runtime filter evaluation of
 *     which records flow.)
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
  isChangeEventApiName,
  listEdges,
  listNodesByType,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveExistingObjectScope } from './input-aliases.js';

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

// Recognizing a CDC event name (`AccountChangeEvent` / `Order__ChangeEvent`,
// never a `__e` Platform Event or a regular sObject) is `isChangeEventApiName`
// from `@sf-intelligence/graph` — the SAME predicate the phantom classifier and
// the refresh's auto-expansion gate read, so this tool cannot disagree with the
// surface that decides a ChangeEvent is unretrievable.

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
 *   - `objectApiName`: optional, non-empty string. A natural host alias
 *     for `sObjectFilter` (the name most hosts reach for after resolve).
 *     Previously an unknown key stripped by Zod, so `{ objectApiName:
 *     'Contact' }` silently degraded to the org-wide scan. Now accepted
 *     as a synonym; when BOTH are supplied, `sObjectFilter` wins.
 */
export const cdcSubscribersInputSchema = z.object({
  sObjectFilter: z.string().min(1).optional(),
  objectApiName: z.string().min(1).optional(),
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
  /**
   * Present ONLY (as `'triggersOn'`) when the row came from the subscriber's
   * DECLARED `triggersOn` edge rather than a `listensTo` edge — the Apex CDC
   * trigger case. `trigger X on AccountChangeEvent (after insert)` mints
   * `triggersOn` and NEVER `listensTo` (the trigger extractor gates `listensTo`
   * on the `__e` Platform Event suffix), so a tool reading only `listensTo`
   * cannot see any Apex CDC trigger. Absent on a `listensTo` row, which keeps
   * that row byte-identical to the pre-fix shape.
   */
  readonly subscriptionEdge?: 'triggersOn';
}

/**
 * One CDC channel-membership binding — a `PlatformEventChannelMember`
 * whose `selectedEntity` is a Change Event. Surfaces the fact that CDC
 * is ENABLED for the object (the channel selects its ChangeEvent) even
 * when no Apex/Flow emits a modeled `listensTo` subscription. Before
 * this, an object with CDC enabled but no code subscriber returned
 * `totalSubscribers: 0` with no membership section, so "0" read as
 * "CDC not used" — the false-empty this closes.
 *
 * `filterExpression` is the DECLARED per-member XML text (CR-CAP-18),
 * NOT runtime filter evaluation of which records flow.
 */
export interface CdcChannelMember {
  readonly memberId: ComponentId;
  readonly channelId: ComponentId | null;
  readonly channelType: string | null;
  readonly changeEventName: string;
  readonly selectedEntity: string;
  readonly filterExpression: string | null;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CdcSubscribersOutput {
  /**
   * Present ONLY on an object-scoped call (CDC-SUBSCRIBERS-UNRESOLVED-OBJECT-
   * SCOPE) — echoes the base sObject the scan was narrowed to, so a scoped
   * answer can never be read as org-wide. Absent on the bare call, keeping
   * that response byte-identical to the pre-fix shape.
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
  readonly subscribers: readonly CdcSubscriber[];
  /**
   * CDC channel enablement: the `PlatformEventChannelMember` rows that
   * select a Change Event for the scoped object(s). Present (possibly
   * empty) always; a non-empty list with empty `subscribers` means CDC
   * is ENABLED with no modeled code subscriber (surfaced in
   * `disclosure`), not "CDC unused".
   */
  readonly channelMembers: readonly CdcChannelMember[];
  readonly summary: {
    readonly totalSubscribers: number;
    readonly totalChannelMembers: number;
    /**
     * Count of DISTINCT Change Events that are enabled — via a modeled
     * subscriber OR a channel-member selection. Counting membership (not only
     * subscribed events) is what stops an enabled-but-unsubscribed CDC stream
     * from reading as `0`.
     */
    readonly uniqueChangeEvents: number;
    /**
     * How many Change Events this call actually SCANNED for subscribers — the
     * denominator that makes `totalSubscribers: 0` interpretable. `0` here means
     * NOTHING WAS CHECKED (no Change Event is referenced anywhere in this
     * vault), which is a different answer from "every stream was checked and
     * none has a subscriber". Before this existed the two were indistinguishable
     * in the response.
     */
    readonly scannedChangeEvents: number;
  };
  readonly disclosure: string;
}

/**
 * Verbatim honesty disclosure surfaced ALWAYS in the response. The
 * heuristic v2.8 CDC detection sees the `listensTo` edge produced by
 * the v1.5 R3 extractors and matches on the target apiName's CDC
 * pattern; the `EventBus.subscribe(...)` programmatic registration is
 * invisible. CR-CAP-18: the DECLARED per-member filter expressions in
 * `*.platformEventChannelMember-meta.xml` ARE now extracted (publish-side
 * `references` edge), but that is the declared XML text, NOT runtime
 * filter EVALUATION of which records flow through the channel.
 */
const CDC_SUBSCRIBERS_DISCLOSURE =
  'CDC subscribers are recognized by name pattern on the edge TARGET (objects ending in `ChangeEvent` or `__ChangeEvent`) across two edge families: a Flow / Apex-class `listensTo` edge, and an Apex CDC trigger\'s declared `triggersOn` edge — `trigger X on AccountChangeEvent` mints `triggersOn` and never `listensTo`, so a row carrying `subscriptionEdge: "triggersOn"` is that trigger. STRUCTURAL: a `{X}ChangeEvent` is synthesised by the platform and is NEVER a retrievable CustomObject on any org, so the scan set is built from Change Event edge TARGETS, not from retrieved nodes — `summary.scannedChangeEvents` reports how many were actually checked, and `0` there means nothing was checked rather than nothing was found. The `EventBus.subscribe(...)` registration is NOT modeled, so subscribers may exist that this tool cannot see. `channelMembers` surfaces CDC ENABLEMENT: a `PlatformEventChannelMember` that selects a Change Event means CDC is on for that object even when no code subscribes — an empty `subscribers` list with a non-empty `channelMembers` list is "enabled, no modeled subscribers", NOT "CDC unused". CR-CAP-18: per-member filter expressions in `*.platformEventChannelMember-meta.xml` ARE extracted (declared XML text — NOT runtime filter evaluation of which records flow).';

/**
 * Appended when the scan set was EMPTY — no Change Event is referenced by any
 * edge in this vault, so `totalSubscribers: 0` is "nothing to check", not "every
 * stream checked, none subscribed". Emitted only on that path.
 */
const CDC_NOTHING_SCANNED_NOTE =
  ' NOTE: `scannedChangeEvents` is 0 — this vault holds NO reference to any Change Event (no CDC trigger, no channel member, no subscriber edge), so nothing was scanned. Read this as "this vault records no CDC usage", NOT as "CDC streams were checked and found unsubscribed". If the org does use CDC, the referencing metadata was not retrieved.';

/**
 * Appended in SCOPED mode when the requested object\'s Change Event is not
 * referenced by anything in the vault — the same "nothing to check" shape as
 * {@link CDC_NOTHING_SCANNED_NOTE} but named to the one stream asked about.
 */
const cdcScopedNothingReferencedNote = (changeEventName: string): string =>
  ` NOTE: nothing in this vault references \`${changeEventName}\` — no subscriber edge, no channel member. A \`{X}ChangeEvent\` is never a retrievable component, so its ABSENCE from the graph is expected and proves nothing about the org: this is "no CDC usage recorded for this object", NOT "CDC checked and unused".`;

/**
 * Extra disclosure line appended when CDC is ENABLED (channel members
 * present) yet no modeled `listensTo` subscriber exists — the exact
 * false-empty this fix closes. Makes the "0 subscribers ≠ 0 usage"
 * distinction explicit for a host that would otherwise read totalSubscribers=0
 * as "Contact CDC not used".
 */
const CDC_ENABLED_NO_SUBSCRIBERS_NOTE =
  ' NOTE: CDC is ENABLED for the scoped object (a channel member selects its Change Event) but no modeled subscriber was found — this is "enabled, no modeled subscriber", not proof the CDC stream is unused.';

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
    // Tag ONLY the triggersOn rows, so a `listensTo` row is byte-identical to
    // the pre-fix shape and the two subscription mechanisms stay tellable apart.
    ...(edge.edgeType === 'triggersOn'
      ? { subscriptionEdge: 'triggersOn' as const }
      : {}),
  });
};

/**
 * The edge families that record a CDC subscription, in scan order.
 *
 * `listensTo` is what the Flow / Apex-class extractors emit. `triggersOn` is
 * what an Apex CDC TRIGGER emits: `apex-trigger.ts` writes `triggersOn`
 * unconditionally from the trigger header and gates the extra `listensTo` edge
 * on the `__e` Platform Event suffix, so a CDC trigger has a `triggersOn` edge
 * into `CustomObject:{X}ChangeEvent` and NO `listensTo` edge at all. Reading
 * only `listensTo` therefore made every Apex CDC trigger invisible to this tool.
 * This reads the edge that already exists rather than minting a new type.
 */
const CDC_SUBSCRIPTION_EDGE_TYPES = ['listensTo', 'triggersOn'] as const;

/**
 * Collect every Change Event id present in the graph. Used when the
 * caller omits `sObjectFilter` — we scan every CustomObject node and
 * keep the ones whose apiName matches the CDC name pattern.
 */
const collectChangeEventIds = async (
  ctx: Context,
): Promise<Result<readonly ComponentId[], string>> => {
  const ids = new Set<ComponentId>();

  // A retrieved ChangeEvent NODE. Structurally impossible on a real org (see
  // below) but read anyway, so the scan set is defined by what the graph holds
  // rather than by an assumption about what the platform emits.
  const result = await listNodesByType(ctx.graph, 'CustomObject', {
    limit: 500,
  });
  if (!result.ok) return err(result.error.message);
  for (const node of result.value) {
    if (isChangeEventApiName(node.apiName)) ids.add(node.id);
  }

  // THE LOAD-BEARING SOURCE. A `{X}ChangeEvent` is synthesised by the platform
  // and the Metadata API emits no component for it, so a ChangeEvent is NEVER a
  // retrieved node on ANY org — the node scan above returns nothing, always.
  // Scanning only nodes therefore meant org-wide mode checked ZERO events and
  // still reported `totalSubscribers: 0`: "did not check" rendered as "checked
  // and found nothing". The events that exist are the DANGLING edge targets an
  // Apex CDC trigger (`triggersOn`) or a channel member (`references`) points
  // at. `%CustomObject:%` is an over-broad SQL prefilter over dangling targets
  // only; the exact CDC name shape is decided in JS.
  const dangling = await danglingTargetIdsMatching(ctx.graph, CHANGE_EVENT_ID_PREFIX);
  if (!dangling.ok) return err(dangling.error.message);
  for (const id of dangling.value) {
    if (!id.startsWith(CHANGE_EVENT_ID_PREFIX)) continue;
    if (isChangeEventApiName(id.slice(CHANGE_EVENT_ID_PREFIX.length))) ids.add(id);
  }

  return ok([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
};

/**
 * Resolve the set of Change Event ids to scan given the caller's
 * object filter. When a filter is supplied we compute the synthetic
 * id from it; when omitted we scan every CustomObject in the graph
 * whose apiName matches the CDC pattern.
 */
const resolveChangeEventIds = async (
  ctx: Context,
  objectFilter: string | undefined,
): Promise<Result<readonly ComponentId[], string>> => {
  if (objectFilter !== undefined) {
    const cdcEventName = sObjectApiNameToCdcEventName(objectFilter);
    return ok([`${CHANGE_EVENT_ID_PREFIX}${cdcEventName}`]);
  }
  return collectChangeEventIds(ctx);
};

/**
 * Defensive ceiling on the `PlatformEventChannelMember` scan. A real
 * org declares a handful of channel members, not hundreds — this cap
 * only guards a pathological metadata set.
 */
const CHANNEL_MEMBER_SCAN_LIMIT = 500;

/**
 * Collect the CDC channel-membership rows in scope. Scans every
 * `PlatformEventChannelMember` node and keeps those whose
 * `selectedEntity` is a Change Event (name-pattern — the same rule the
 * subscriber scan uses, so an `event`-channel member selecting a
 * Platform Event like `Application_Event__e` is correctly excluded).
 * When `objectFilter` is set, keeps only the member selecting that
 * object's Change Event. The channel node (resolved via the member's
 * `parentId`) supplies `channelType`; the per-member declared
 * `filterExpression` is read from the member node's properties.
 *
 * This is member-centric on purpose: a `data` channel's Change Event
 * target is often a stub/missing node in an offline vault, so keying
 * off the member node (which is always present) surfaces enablement
 * even when the ChangeEvent node itself was never retrieved.
 */
const collectChannelMembers = async (
  ctx: Context,
  objectFilter: string | undefined,
): Promise<Result<readonly CdcChannelMember[], string>> => {
  const wantedEventName =
    objectFilter !== undefined
      ? sObjectApiNameToCdcEventName(objectFilter)
      : null;

  const membersResult = await listNodesByType(
    ctx.graph,
    'PlatformEventChannelMember',
    { limit: CHANNEL_MEMBER_SCAN_LIMIT },
  );
  if (!membersResult.ok) return err(membersResult.error.message);

  const members: CdcChannelMember[] = [];
  const channelCache = new Map<ComponentId, string | null>();
  for (const node of membersResult.value) {
    const rawSelected = node.properties['selectedEntity'];
    if (typeof rawSelected !== 'string' || rawSelected.length === 0) continue;
    // CDC discriminator: the selected entity must be a Change Event.
    if (!isChangeEventApiName(rawSelected)) continue;
    if (wantedEventName !== null && rawSelected !== wantedEventName) continue;

    const channelId = node.parentId;
    let channelType: string | null = null;
    if (channelId !== null) {
      if (channelCache.has(channelId)) {
        channelType = channelCache.get(channelId) ?? null;
      } else {
        const channelResult = await getNodeById(ctx.graph, channelId);
        if (!channelResult.ok) return err(channelResult.error.message);
        const ct = channelResult.value?.properties['channelType'];
        channelType = typeof ct === 'string' ? ct : null;
        channelCache.set(channelId, channelType);
      }
    }

    const rawFilter = node.properties['filterExpression'];
    members.push({
      memberId: node.id,
      channelId,
      channelType,
      changeEventName: rawSelected,
      selectedEntity: rawSelected,
      filterExpression: typeof rawFilter === 'string' ? rawFilter : null,
    });
  }

  members.sort((a, b) =>
    a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
  );
  return ok(members);
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
  // Accept `objectApiName` as a synonym for `sObjectFilter` (host alias);
  // `sObjectFilter` wins when both are supplied.
  const rawObjectFilter = input.sObjectFilter ?? input.objectApiName;

  // CDC-SUBSCRIBERS-UNRESOLVED-OBJECT-SCOPE: the synthetic ChangeEvent id used
  // to be derived straight from the raw filter string with no check that the
  // underlying sObject exists — a made-up (or merely wrong-case) object name
  // silently produced `{totalSubscribers: 0}` with a "nothing referenced"
  // disclosure that READ like a checked answer but was never grounded in a
  // real object. Resolve + verify the BASE object (not the ChangeEvent form)
  // via the shared object-scope resolver before deriving anything: an
  // unresolvable object REFUSES, and a real object typed in the wrong case is
  // corrected to the vault's exact casing before the ChangeEvent name is
  // computed from it.
  let objectFilter: string | undefined = rawObjectFilter;
  if (rawObjectFilter !== undefined) {
    const scopeResult = await resolveExistingObjectScope(ctx.graph, {
      objectApiName: rawObjectFilter,
    });
    if (!scopeResult.ok) return err(scopeResult.error);
    // Non-null: `rawObjectFilter` is always a non-empty string here.
    objectFilter = scopeResult.value?.object ?? rawObjectFilter;
  }

  const eventIdsResult = await resolveChangeEventIds(ctx, objectFilter);
  if (!eventIdsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${eventIdsResult.error}`,
    });
  }
  const eventIds = eventIdsResult.value;

  const subscribers: CdcSubscriber[] = [];
  const uniqueEvents = new Set<string>();
  // The denominator behind `totalSubscribers`. Counted per event actually walked
  // so a `0` result can say whether anything was checked at all.
  let scannedChangeEvents = 0;
  for (const eventId of eventIds) {
    // Recover the event's apiName from the canonical id form
    // `CustomObject:{ApiName}` — splitting on the first ':' is the
    // contract-stable way to do this.
    const colon = eventId.indexOf(':');
    if (colon === -1) continue;
    const apiName = eventId.slice(colon + 1);
    if (!isChangeEventApiName(apiName)) continue;

    scannedChangeEvents += 1;
    let producedAtLeastOne = false;
    // Both subscription edge families — `listensTo` (Flow / Apex class) and
    // `triggersOn` (the Apex CDC trigger, which never emits `listensTo`).
    for (const edgeType of CDC_SUBSCRIPTION_EDGE_TYPES) {
      const edgesResult = await listEdges(ctx.graph, eventId, {
        direction: 'in',
        edgeType,
      });
      if (!edgesResult.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${edgesResult.error.message}`,
        });
      }
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
    }
    if (producedAtLeastOne) uniqueEvents.add(apiName);
  }

  const sorted = subscribers.sort(compareSubscribers);

  // CDC ENABLEMENT plane: channel members that select a Change Event for
  // the scoped object(s). Counted toward uniqueChangeEvents so an
  // enabled-but-unsubscribed stream no longer reads as `0`.
  const channelMembersResult = await collectChannelMembers(ctx, objectFilter);
  if (!channelMembersResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${channelMembersResult.error}`,
    });
  }
  const channelMembers = channelMembersResult.value;
  for (const member of channelMembers) uniqueEvents.add(member.changeEventName);

  // When CDC is enabled (members present) but no code subscribes, make the
  // "0 subscribers ≠ 0 usage" distinction explicit in the disclosure.
  let disclosure = CDC_SUBSCRIBERS_DISCLOSURE;
  if (channelMembers.length > 0 && sorted.length === 0) {
    disclosure += CDC_ENABLED_NO_SUBSCRIBERS_NOTE;
  }
  // Separate the two ways a `0` can arise. Org-wide with an EMPTY scan set means
  // nothing was checked; a scoped call with no subscriber and no membership
  // means that one stream is referenced by nothing. Both were previously
  // indistinguishable from "checked every stream, found no subscriber".
  if (objectFilter === undefined) {
    if (scannedChangeEvents === 0) disclosure += CDC_NOTHING_SCANNED_NOTE;
  } else if (sorted.length === 0 && channelMembers.length === 0) {
    disclosure += cdcScopedNothingReferencedNote(
      sObjectApiNameToCdcEventName(objectFilter),
    );
  }

  return ok({
    data: {
      // appliedScope FIRST + only when scoped, so a bare call omits the whole
      // block (byte-identical to the pre-fix shape) and a scoped one can
      // never be read as org-wide.
      ...(objectFilter !== undefined
        ? { appliedScope: { object: objectFilter, mode: 'component' as const } }
        : {}),
      subscribers: sorted,
      channelMembers,
      summary: {
        totalSubscribers: sorted.length,
        totalChannelMembers: channelMembers.length,
        uniqueChangeEvents: uniqueEvents.size,
        scannedChangeEvents,
      },
      disclosure,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
