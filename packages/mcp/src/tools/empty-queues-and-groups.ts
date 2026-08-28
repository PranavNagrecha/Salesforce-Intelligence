/**
 * Handler for the `sfi.empty_queues_and_groups` MCP tool.
 *
 * The v2.4 "which queues / groups have no members?" surface. Walks
 * existing Queue + Group nodes' member properties (extracted in v0.1
 * + v1.x) — no enrichment-tier data required.
 *
 * **Routing-trap detection** — a Queue with zero members but multiple
 * incoming AssignmentRule references is the most operationally urgent
 * case for admins. v2.0b's `unused_components` would flag the queue
 * as "used" because incoming references exist; v2.4 separates "has
 * no members" from "has no references" so the routing-trap surfaces
 * as a high-priority cleanup candidate (or, more usefully, a routing
 * redirect target before deletion).
 *
 * **Member resolution honesty** — when a Queue references a Group
 * whose own members chain to a Role the vault did not extract, the
 * tool returns `memberSource: 'unknown'` rather than asserting zero
 * members. The `unknownMemberCountQueues` / `unknownMemberCountGroups`
 * counters separate "unknown" from "confirmed empty" — the v2.4
 * constitutional rule.
 *
 * **Live-drift honesty (EMPTY-QUEUES-AND-GROUPS-FALSE-EMPTY-LIVE-DRIFT)** —
 * emptiness here is DECLARED (metadata XML direct-user membership) only, and
 * Setup-UI-managed membership routinely drifts from it, so a `memberCount: 0`
 * public group can still hold live users. Every listed row therefore carries a
 * `cleanupVerdict` of `review-not-delete` (or `unknown-membership`) — never a
 * bare "safe to delete". Confirm the live roster with `sfi.live_group_members`
 * (which reports vault-vs-live `drift`) before any delete / retire. Actually
 * annotating a `liveMemberCount` inline requires registering this tool on the
 * opt-in live plane (roster follow-up); today it stays vault-only and defers
 * the confirmation to `live_group_members`.
 *
 * **An unmeasured zero is never a measured zero (R1 typed absence)** — the two
 * shapes that produced a CONFIDENT ZERO with a fabricated `memberSource:
 * 'user-direct'` provenance label (a positive claim that a direct user
 * reference was read) over membership this vault never read:
 *   - Queue: `<queueMembers>` is a container of one wrapper per member CHANNEL
 *     (`<users>`, `<roles>`, …). A refresh that predates
 *     {@link QUEUE_MEMBER_CHANNELS_SENTINEL} read `<users>` only, so a queue
 *     staffed entirely by a role extracted as `memberCount: 0` — and this tool
 *     then named the one queue in the org that is NOT empty. Whether the family
 *     was read is decided by whether the node CARRIES `memberChannels`, never
 *     by the count; without it the row is `'unknown'` with
 *     `memberCountUnknownReason: 'queue-member-channels-not-extracted'` and a
 *     boundary from the shared `absence-disclosure` module.
 *   - Group: the retrieved `Group` metadata carries NO membership element, and
 *     public-group membership is `GroupMember` DATA that a Metadata API
 *     retrieve never emits. A declared zero is therefore unmeasurable by
 *     construction — for every public group, in every org, permanently — so it
 *     is `'unknown'` with `'group-membership-not-in-metadata'`, and the
 *     boundary says outright that a re-refresh cannot help and points at
 *     `sfi.live_group_members`. This is the handling the sibling
 *     `sfi.unassigned_permission_sets` already gives the identical unknowable.
 * `confirmedEmptyQueues` / `confirmedEmptyGroups` carry the emptiness headline
 * — `totalQueues` / `totalGroups` count ROWS, unknown rows included, so they
 * are not an "empty" count. That is what makes the "unknown counts are NOT
 * counted toward emptiness" boundary true of a NUMBER, not only of prose.
 *
 * **Name filter (EMPTY-QUEUES-AND-GROUPS-IGNORES-NAMECONTAINS)** — the optional
 * `nameContains` input narrows BOTH the queue and group lists to entries whose
 * apiName OR label contains the substring (case-insensitive). When present the
 * response echoes `appliedScope` so a host never mistakes the bare inventory
 * for a scoped answer; a no-filter call omits it and stays byte-identical. A
 * filter that matches nothing returns an honest empty result ("no empty
 * queues/groups named X"), NOT the full inventory. `nameContains` also enters
 * the pagination fingerprint so a scoped cursor cannot replay against the bare
 * list.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  familyWasExtracted,
  notExtractedFamilyDisclosure,
} from './absence-disclosure.js';
import {
  buildEnumerationCoverageCaveatFor,
  type CoverageCaveat,
} from './coverage-trust.js';
import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
  type SectionDisclosure,
} from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

/** Per-response byte budget for the designated list's page. */
const EMPTY_QUEUES_BYTE_BUDGET = 38_000;

/** Inclusive upper bound on `limit`. */
const EMPTY_QUEUES_MAX_LIMIT = 500;
/** Default `limit`. */
const EMPTY_QUEUES_DEFAULT_LIMIT = 100;

/**
 * Age threshold for `isLikelyStale`: 180 days. A queue/group with zero
 * members AND incoming references AND a `lastModifiedAt` older than
 * this threshold is "old + empty + referenced" — a high-priority
 * cleanup target.
 */
const STALE_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * The Queue-node property the CURRENT extractor always writes once it has
 * walked EVERY `<queueMembers>` channel (`<users>`, `<roles>`, …), even when
 * the queue declares none (`[]`).
 *
 * R1 typed absence: whether the member family was read is decided by whether
 * the node CARRIES this property, never by whether `memberCount` is 0. A node
 * built by a refresh that predates it read the `<users>` channel ONLY, so its
 * `memberCount: 0` means "we only looked in one place" — a queue staffed
 * entirely by a role extracted as zero and this tool, whose job is to name the
 * EMPTY queues, named the one queue that is not. Verified against
 * `packages/extractors/src/queue.ts`, which assigns `memberChannels`
 * unconditionally, so its absence is never "clean", always "never scanned".
 */
const QUEUE_MEMBER_CHANNELS_SENTINEL = 'memberChannels';

/**
 * The Queue-node flag set when a `<queueMembers>` block carried content the
 * extractor could not read. Its `memberCount` is "we could not tell".
 */
const QUEUE_MEMBERS_UNPARSED_PROPERTY = 'queueMembersUnparsed';

/** Verbatim boundary disclosures. */
const BOUNDARIES: readonly string[] = Object.freeze([
  'queue and group member resolution depends on direct user references in metadata XML; runtime membership changes (via Setup UI) since the last vault refresh are not reflected.',
  'member counts of "unknown" indicate the vault did not extract enough data to resolve membership — these are NOT counted toward emptiness.',
  'EMPTY-QUEUES-AND-GROUPS-FALSE-EMPTY-LIVE-DRIFT: a `memberCount: 0` row is DECLARED-empty from metadata only — Setup-UI-managed membership routinely drifts, so an "empty" public group can still hold live users. Every listed row therefore carries `cleanupVerdict: "review-not-delete"` (or `"unknown-membership"`): confirm the live roster with `sfi.live_group_members` (it reports vault-vs-live `drift`) BEFORE deleting or retiring anything. This is a cleanup SHORTLIST to review, never a delete list.',
]);

/** Zod schema for the input. */
export const emptyQueuesAndGroupsInputSchema = z.object({
  type: z.enum(['Queue', 'Group', 'both']).optional(),
  // EMPTY-QUEUES-AND-GROUPS-IGNORES-NAMECONTAINS: honor a caller name filter
  // instead of silently returning the full inventory. Keeps only queues/groups
  // whose apiName OR label contains the substring (case-insensitive). Echoed
  // back as `appliedScope`; a bare no-filter call omits it (byte-identical).
  nameContains: z.string().min(1).optional(),
  includeManagedPackage: z.boolean().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(EMPTY_QUEUES_MAX_LIMIT)
    .optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`; carries the resume offset + which list
  // (queues | groups) it advances. Omit = today's behavior.
  cursor: z.string().min(1).optional(),
});

export type EmptyQueuesAndGroupsInput = z.infer<
  typeof emptyQueuesAndGroupsInputSchema
>;

export type MemberSource = 'user-direct' | 'group-resolved' | 'role-resolved' | 'unknown';

/**
 * WHY a row's member count is `unknown` — a TYPED field so a machine consumer
 * cannot skip the gap the way it can skip a prose boundary. Present ONLY on a
 * row whose `memberSource` is `'unknown'`; a measured row omits it entirely.
 *
 *  - `queue-member-channels-not-extracted`: the Queue node carries no
 *    `memberChannels` sentinel, so this vault's refresh read the `<users>`
 *    channel ONLY. A role-staffed queue extracts as 0 under that refresh.
 *    Re-run `/sfi-refresh` — the current extractor walks every channel.
 *  - `queue-member-block-unreadable`: `<queueMembers>` was declared but its
 *    content could not be parsed (`queueMembersUnparsed`). Not a zero.
 *  - `group-membership-not-in-metadata`: the retrieved `Group` metadata
 *    declares NO members. Public-group membership is `GroupMember` DATA, which
 *    a Metadata API retrieve never emits, so this is NOT-MEASURED for every
 *    public group in every org — a re-refresh cannot change it. Read the live
 *    roster with `sfi.live_group_members`.
 *  - `no-member-data-extracted`: the node carries no member data of any kind.
 */
export type MemberCountUnknownReason =
  | 'queue-member-channels-not-extracted'
  | 'queue-member-block-unreadable'
  | 'group-membership-not-in-metadata'
  | 'no-member-data-extracted';

/**
 * Prose for the group gap. Deliberately NOT built by
 * `notExtractedFamilyDisclosure`: that template ends "this vault's refresh
 * predates … extraction … Re-run `/sfi-refresh`", and for public-group
 * membership a re-refresh is the WRONG remedy — no Metadata API retrieve can
 * ever carry it. Pointing an admin at a refresh that cannot help is the same
 * class of false certainty this fix exists to remove.
 */
const groupMembershipNotInMetadataDisclosure = (count: number): string =>
  'EMPTY-QUEUES-AND-GROUPS-GROUP-MEMBERSHIP-IS-NOT-METADATA: ' +
  `${count} public group(s) declare NO members in the retrieved Group ` +
  'metadata, and public-group membership is `GroupMember` DATA that a Metadata ' +
  'API retrieve never emits — so their `memberCount: 0` is NOT MEASURED, never ' +
  'a verified "nobody is in it". A re-refresh will not populate it. They are ' +
  'reported with `memberSource: "unknown"` / `cleanupVerdict: ' +
  '"unknown-membership"` and are EXCLUDED from `confirmedEmptyGroups`. Read the ' +
  'live roster with `sfi.live_group_members` before treating any of them as a ' +
  'cleanup candidate.';

/**
 * The delete-safety verdict for an offline "empty" row (EMPTY-QUEUES-AND-GROUPS-
 * FALSE-EMPTY-LIVE-DRIFT). Vault emptiness is computed from DECLARED membership
 * only (direct-user XML); Setup-UI-managed membership routinely drifts from that
 * (a vault `memberCount: 0` group can hold live users), so a zero declared count
 * is NEVER a confirmed-safe delete offline. Surfacing this per row keeps the
 * "empty" inventory from being read as a delete list.
 *   - `review-not-delete`: zero DECLARED members — confirm the live roster with
 *     `sfi.live_group_members` (which reports vault-vs-live `drift`) before any
 *     delete / retire; live membership may be non-zero.
 *   - `unknown-membership`: the vault could not resolve membership at all
 *     (already excluded from emptiness counts) — not a delete candidate either.
 */
export type CleanupVerdict = 'review-not-delete' | 'unknown-membership';

/** One Queue entry. */
export interface EmptyQueueEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly label: string;
  readonly objectTypes: readonly string[];
  readonly memberCount: number;
  readonly memberSource: MemberSource;
  readonly incomingAssignmentRuleCount: number;
  readonly isLikelyStale: boolean;
  /**
   * EMPTY-QUEUES-AND-GROUPS-FALSE-EMPTY-LIVE-DRIFT: never a bare "delete me".
   * Offline declared emptiness can drift from the live roster, so this is
   * `review-not-delete` (or `unknown-membership`) — confirm live before cleanup.
   */
  readonly cleanupVerdict: CleanupVerdict;
  /**
   * WHY this row's count is unknown. Present ONLY when
   * `memberSource === 'unknown'`; a measured row omits it entirely so a
   * confirmed-empty golden does not move.
   */
  readonly memberCountUnknownReason?: MemberCountUnknownReason;
}

/** One Group entry. */
export interface EmptyGroupEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly label: string;
  readonly groupType: string;
  readonly memberCount: number;
  readonly memberSource: MemberSource;
  readonly incomingReferenceCount: number;
  readonly isLikelyStale: boolean;
  /**
   * EMPTY-QUEUES-AND-GROUPS-FALSE-EMPTY-LIVE-DRIFT: see {@link EmptyQueueEntry}.
   * A vault `memberCount: 0` public group can still hold live members
   * (Setup-UI drift), so this is never a bare "safe to delete".
   */
  readonly cleanupVerdict: CleanupVerdict;
  /** See {@link EmptyQueueEntry.memberCountUnknownReason}. */
  readonly memberCountUnknownReason?: MemberCountUnknownReason;
}

/** Output payload. */
export interface EmptyQueuesAndGroupsOutput {
  readonly queues: readonly EmptyQueueEntry[];
  readonly groups: readonly EmptyGroupEntry[];
  readonly totalQueues: number;
  readonly totalGroups: number;
  readonly unknownMemberCountQueues: number;
  readonly unknownMemberCountGroups: number;
  /**
   * Queues whose emptiness was actually MEASURED — the rows a cleanup
   * shortlist may act on. `totalQueues` is the ROW COUNT and includes the
   * `unknown-membership` rows, so it is not an "empty queues" headline;
   * `confirmedEmptyQueues + unknownMemberCountQueues === totalQueues`. This is
   * what makes the boundary "unknown counts are NOT counted toward emptiness"
   * true of a number rather than only of prose.
   */
  readonly confirmedEmptyQueues: number;
  /** See {@link confirmedEmptyQueues}. Groups whose emptiness was MEASURED. */
  readonly confirmedEmptyGroups: number;
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  /**
   * EMPTY-QUEUES-AND-GROUPS-IGNORES-NAMECONTAINS: the scope ACTUALLY applied.
   * Present ONLY when the caller passed a `nameContains` filter — a bare call
   * omits it so its response stays byte-identical to the pre-filter shape. A
   * host that sees no `appliedScope` MUST treat the lists as the full
   * inventory, not a scoped answer.
   */
  readonly appliedScope?: {
    readonly nameContains: string;
    readonly mode: 'nameContains';
  };
  /**
   * coverage-aware-zero (CR): present when the manifest reports an included
   * family (Queue / Group) was NOT retrieved. An empty list / zero total under
   * this caveat is "not retrieved, re-refresh", NOT a proven "no empty queues or
   * groups". `missingCoverage` names exactly the unretrieved families (scoped to
   * the `type` filter). Absent on a legacy (no-coverage) vault and on a
   * confirmed-clean retrieve, so existing goldens do not move.
   */
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * R6 (BRIEF-084 scan-tail-unreachable): TRUE only when the multi-window
   * `scanAllNodesOfTypes` walk hit its residual `FULL_SCAN_MAX_NODES` ceiling
   * for Queue and/or Group with strictly more nodes behind it — a
   * pathological type far above any real org. The walk itself pages the SQL
   * `OFFSET` forward until each type is exhausted, so a normal >500-Queue org
   * is fully scanned and this is honestly false (strictly stronger than the
   * old single 500-row page, which silently dropped the tail). Present ONLY
   * when actually true so a normal org's golden does not move.
   */
  readonly scanTruncated?: boolean;
  /** Queue nodes actually scanned (only when the Queue walk was incomplete). */
  readonly totalQueueNodes?: number;
  /** Group nodes actually scanned (only when the Group walk was incomplete). */
  readonly totalGroupNodes?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when the designated list
   * overflowed `limit`/the byte budget. Echo it back as `cursor` to resume;
   * absent on a whole-fits page so the response is byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata for the designated list; truncation only. */
  readonly pageInfo?: PageInfo;
  /** Which list the cursor advances (`'queues'` | `'groups'`); truncation only. */
  readonly designatedList?: string;
  /** The non-designated list, disclosed with its full count; truncation only. */
  readonly otherSections?: readonly SectionDisclosure[];
}

/**
 * Detect a managed-package namespace prefix on a Queue/Group apiName.
 * Queue and Group api names typically lack `__c`/`__mdt` suffixes, so
 * any leading `{ns}__` marks a managed namespace. Returns the prefix
 * or null.
 */
const namespacePrefixOf = (apiName: string): string | null => {
  const idx = apiName.indexOf('__');
  if (idx === -1) return null;
  if (idx === 0) return null;
  return apiName.slice(0, idx);
};

/**
 * EMPTY-QUEUES-AND-GROUPS-IGNORES-NAMECONTAINS: does this Queue/Group match the
 * caller name filter? Matches when the (lowercased) needle is a substring of
 * either the apiName (developer name) or the label (display name). A null
 * needle means "no filter" and matches everything.
 */
const nameMatches = (node: Node, needle: string | null): boolean => {
  if (needle === null) return true;
  if (node.apiName.toLowerCase().includes(needle)) return true;
  const label = node.label;
  return typeof label === 'string' && label.toLowerCase().includes(needle);
};

const propertyString = (node: Node, key: string): string => {
  const v = node.properties[key];
  return typeof v === 'string' ? v : '';
};

/** Canonical id prefix of an sObject a queue can own. */
const CUSTOM_OBJECT_ID_PREFIX = 'CustomObject:';

/**
 * The sObjects a Queue can own, read from the `sharedWith` edges the Queue
 * extractor emits per distinct `<queueSobject><sobjectType>`.
 *
 * This USED to read a `properties.objectTypes` array. No extractor has ever
 * written that key, so every row published `objectTypes: []` — on the very
 * rows this tool nominates for cleanup, telling a reader that a queue which
 * owns Cases owns nothing at all. Same disease as the member counts: an
 * unpopulated read rendered as a fact. The edges are the extractor's real
 * output and are already deduped and ordered by it.
 */
const resolveObjectTypes = async (
  ctx: Context,
  queueId: ComponentId,
): Promise<Result<readonly string[], string>> => {
  const r = await listEdges(ctx.graph, queueId, {
    direction: 'out',
    edgeType: 'sharedWith',
  });
  if (!r.ok) return err(r.error.message);
  const out: string[] = [];
  for (const edge of r.value) {
    if (!edge.toId.startsWith(CUSTOM_OBJECT_ID_PREFIX)) continue;
    const name = edge.toId.slice(CUSTOM_OBJECT_ID_PREFIX.length);
    if (!out.includes(name)) out.push(name);
  }
  return ok(out);
};

/** What a resolver decided about one container's membership. */
interface ResolvedMembers {
  readonly count: number;
  readonly source: MemberSource;
  /** Present only when `source` is `'unknown'`. */
  readonly unknownReason?: MemberCountUnknownReason;
}

/**
 * Read the `memberSource` the extractor stamped, defaulting to `'user-direct'`
 * when it did not tag one. Only called once the family is known to have been
 * scanned — a bare default on an UNSCANNED node is precisely the fabricated
 * provenance ("a direct user reference was read") this module now refuses.
 */
const taggedMemberSource = (node: Node): MemberSource => {
  const sourceProp = node.properties['memberSource'];
  return sourceProp === 'group-resolved' ||
    sourceProp === 'role-resolved' ||
    sourceProp === 'unknown' ||
    sourceProp === 'user-direct'
    ? sourceProp
    : 'user-direct';
};

/**
 * Resolve a Queue's member count.
 *
 * R1 typed absence: a `memberCount: 0` is a MEASUREMENT only when the node
 * carries {@link QUEUE_MEMBER_CHANNELS_SENTINEL} — the marker the extractor
 * writes once it has walked every `<queueMembers>` channel. Without it the
 * refresh read `<users>` only, so a zero is "we looked in one place", and the
 * honest answer is `'unknown'`: a role-staffed queue is otherwise published as
 * an empty cleanup candidate whose live case routing a delete would stop.
 *
 * A POSITIVE legacy count is still a positive fact — those users really are
 * members, so the queue is not empty either way and never reaches the list.
 */
const resolveQueueMemberCount = (node: Node): ResolvedMembers => {
  const explicit = node.properties['memberCount'];
  if (typeof explicit !== 'number') {
    return { count: 0, source: 'unknown', unknownReason: 'no-member-data-extracted' };
  }
  const count = explicit;
  if (!familyWasExtracted(node.properties, QUEUE_MEMBER_CHANNELS_SENTINEL)) {
    if (count > 0) return { count, source: taggedMemberSource(node) };
    return {
      count: 0,
      source: 'unknown',
      unknownReason: 'queue-member-channels-not-extracted',
    };
  }
  if (node.properties[QUEUE_MEMBERS_UNPARSED_PROPERTY] === true) {
    return { count, source: 'unknown', unknownReason: 'queue-member-block-unreadable' };
  }
  return { count, source: taggedMemberSource(node) };
};

/**
 * Resolve a public Group's member count.
 *
 * A DECLARED count above zero is a positive fact and is trusted. A declared
 * ZERO is not a measurement at all: the `Group` metadata a retrieve returns
 * carries no user-membership element, and public-group membership lives in
 * `GroupMember` records — data, not metadata. (That gap is why
 * `sfi.live_group_members` exists and queries `GroupMember` over the API.) So
 * a zero here is `'unknown'`, held out of the emptiness counters exactly as
 * `sfi.unassigned_permission_sets` holds its own unknowable assignments out of
 * `unassignedCount`.
 */
const resolveGroupMemberCount = (node: Node): ResolvedMembers => {
  const explicit = node.properties['memberCount'];
  if (typeof explicit !== 'number') {
    return { count: 0, source: 'unknown', unknownReason: 'no-member-data-extracted' };
  }
  const count = explicit;
  if (count > 0) return { count, source: taggedMemberSource(node) };
  return {
    count: 0,
    source: 'unknown',
    unknownReason: 'group-membership-not-in-metadata',
  };
};

/**
 * Compute whether a queue/group is "stale" per the v2.4 definition:
 * zero members, has incoming references, and lastModifiedAt > 180d
 * ago. Returns false when lastModifiedAt is null because we cannot
 * judge age.
 */
const isLikelyStale = (
  memberCount: number,
  incomingRefs: number,
  lastModifiedAt: string | null,
): boolean => {
  if (memberCount > 0) return false;
  if (incomingRefs === 0) return false;
  if (lastModifiedAt === null) return false;
  const ts = Date.parse(lastModifiedAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts > STALE_AGE_MS;
};

const compareQueueById = (a: EmptyQueueEntry, b: EmptyQueueEntry): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const compareGroupById = (a: EmptyGroupEntry, b: EmptyGroupEntry): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Count incoming AssignmentRule references to a queue. The
 * AssignmentRule extractor emits `references` edges into the queue
 * when a rule routes work there.
 */
const countAssignmentRuleReferences = async (
  ctx: Context,
  queueId: ComponentId,
): Promise<Result<number, string>> => {
  const r = await listEdges(ctx.graph, queueId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!r.ok) return err(r.error.message);
  let count = 0;
  for (const edge of r.value) {
    if (edge.fromId.startsWith('AssignmentRule:')) count += 1;
  }
  return ok(count);
};

/**
 * Count incoming references to a Group (PermissionSet, Profile,
 * AssignmentRule, SharingRule).
 */
const countGroupReferences = async (
  ctx: Context,
  groupId: ComponentId,
): Promise<Result<number, string>> => {
  const r = await listEdges(ctx.graph, groupId, {
    direction: 'in',
  });
  if (!r.ok) return err(r.error.message);
  let count = 0;
  for (const edge of r.value) {
    if (edge.edgeType === 'parentOf') continue;
    count += 1;
  }
  return ok(count);
};

/**
 * The `sfi.empty_queues_and_groups` MCP tool. See module JSDoc for
 * the routing-trap detection and member-source honesty rules.
 */
export const emptyQueuesAndGroupsHandler = async (
  ctx: Context,
  input: EmptyQueuesAndGroupsInput,
): Promise<Result<McpResponse<EmptyQueuesAndGroupsOutput>, McpError>> => {
  const limit = input.limit ?? EMPTY_QUEUES_DEFAULT_LIMIT;
  const includeManaged = input.includeManagedPackage ?? false;
  const typeFilter = input.type ?? 'both';
  // EMPTY-QUEUES-AND-GROUPS-IGNORES-NAMECONTAINS: case-insensitive substring
  // needle over apiName / label. null = no filter.
  const nameNeedle =
    input.nameContains !== undefined ? input.nameContains.toLowerCase() : null;

  const queues: EmptyQueueEntry[] = [];
  let unknownMemberCountQueues = 0;
  // R1: ids whose Queue node carries no `memberChannels` sentinel, so the
  // members family was never walked for them. Drives the shared
  // `notExtractedFamilyDisclosure` boundary below.
  const queuesMissingChannelScan: string[] = [];
  // R6 (BRIEF-084 scan-tail-unreachable): a single un-offset `listNodesByType`
  // page caps the SCAN axis at 500 id-ASC nodes, so a Queue/Group sorted past
  // row 500 was never fetched at all — no cursor could ever reach it, even
  // though `scanTruncated` honestly reported the true total. `scanAllNodesOfTypes`
  // pages the SQL OFFSET forward until each type is exhausted, closing the gap;
  // its `scanIncomplete` flag replaces the old hand-rolled `countNodesByType`
  // comparison with one derived value (see scan-all-nodes.ts module doc).
  let scanQueuesIncomplete = false;
  let totalQueueNodesScanned = 0;

  if (typeFilter === 'Queue' || typeFilter === 'both') {
    const qRes = await scanAllNodesOfTypes(ctx.graph, ['Queue']);
    if (!qRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${qRes.error.message}`,
      });
    }
    scanQueuesIncomplete = qRes.value.scanIncomplete;
    totalQueueNodesScanned = qRes.value.nodes.length;
    for (const queue of qRes.value.nodes) {
      const ns = namespacePrefixOf(queue.apiName);
      if (!includeManaged && ns !== null) continue;
      if (!nameMatches(queue, nameNeedle)) continue;
      const { count, source, unknownReason } = resolveQueueMemberCount(queue);
      const arCountRes = await countAssignmentRuleReferences(ctx, queue.id);
      if (!arCountRes.ok) {
        return err({ kind: 'internal', message: arCountRes.error });
      }
      const objectTypesRes = await resolveObjectTypes(ctx, queue.id);
      if (!objectTypesRes.ok) {
        return err({ kind: 'internal', message: objectTypesRes.error });
      }
      const objectTypes = objectTypesRes.value;

      if (source === 'unknown') {
        unknownMemberCountQueues += 1;
        if (unknownReason === 'queue-member-channels-not-extracted') {
          queuesMissingChannelScan.push(queue.id);
        }
        // Surface in the queues list with the unknown marker so the
        // skill can render it separately, but the count is tracked
        // independently and NEVER counted toward emptiness.
        queues.push({
          id: queue.id,
          apiName: queue.apiName,
          label: queue.label ?? '',
          objectTypes,
          memberCount: 0,
          memberSource: 'unknown',
          incomingAssignmentRuleCount: arCountRes.value,
          isLikelyStale: false,
          cleanupVerdict: 'unknown-membership',
          ...(unknownReason !== undefined
            ? { memberCountUnknownReason: unknownReason }
            : {}),
        });
        continue;
      }
      if (count === 0) {
        queues.push({
          id: queue.id,
          apiName: queue.apiName,
          label: queue.label ?? '',
          objectTypes,
          memberCount: 0,
          memberSource: source,
          incomingAssignmentRuleCount: arCountRes.value,
          isLikelyStale: isLikelyStale(0, arCountRes.value, queue.lastModifiedDate),
          // Declared emptiness only — confirm live before deleting (drift).
          cleanupVerdict: 'review-not-delete',
        });
      }
    }
  }

  const groups: EmptyGroupEntry[] = [];
  let unknownMemberCountGroups = 0;
  // Groups whose declared membership is zero — unmeasurable from metadata by
  // construction (GroupMember is data), not merely unextracted.
  let groupsWithNoDeclaredMembership = 0;
  let scanGroupsIncomplete = false;
  let totalGroupNodesScanned = 0;

  if (typeFilter === 'Group' || typeFilter === 'both') {
    const gRes = await scanAllNodesOfTypes(ctx.graph, ['Group']);
    if (!gRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${gRes.error.message}`,
      });
    }
    scanGroupsIncomplete = gRes.value.scanIncomplete;
    totalGroupNodesScanned = gRes.value.nodes.length;
    for (const group of gRes.value.nodes) {
      const ns = namespacePrefixOf(group.apiName);
      if (!includeManaged && ns !== null) continue;
      if (!nameMatches(group, nameNeedle)) continue;
      const { count, source, unknownReason } = resolveGroupMemberCount(group);
      const refCountRes = await countGroupReferences(ctx, group.id);
      if (!refCountRes.ok) {
        return err({ kind: 'internal', message: refCountRes.error });
      }

      if (source === 'unknown') {
        unknownMemberCountGroups += 1;
        if (unknownReason === 'group-membership-not-in-metadata') {
          groupsWithNoDeclaredMembership += 1;
        }
        groups.push({
          id: group.id,
          apiName: group.apiName,
          label: group.label ?? '',
          groupType: propertyString(group, 'type'),
          memberCount: 0,
          memberSource: 'unknown',
          incomingReferenceCount: refCountRes.value,
          isLikelyStale: false,
          cleanupVerdict: 'unknown-membership',
          ...(unknownReason !== undefined
            ? { memberCountUnknownReason: unknownReason }
            : {}),
        });
        continue;
      }
      if (count === 0) {
        groups.push({
          id: group.id,
          apiName: group.apiName,
          label: group.label ?? '',
          groupType: propertyString(group, 'type'),
          memberCount: 0,
          memberSource: source,
          incomingReferenceCount: refCountRes.value,
          isLikelyStale: isLikelyStale(0, refCountRes.value, group.lastModifiedDate),
          // Declared emptiness only — a memberCount:0 group can hold live users
          // (Setup-UI drift); confirm with live_group_members before deleting.
          cleanupVerdict: 'review-not-delete',
        });
      }
    }
  }

  const sortedQueues = [...queues].sort(compareQueueById);
  const sortedGroups = [...groups].sort(compareGroupById);
  const truncatedQ = sortedQueues.length > limit;
  const truncatedG = sortedGroups.length > limit;
  // KEEP the pre-CR-22 `truncated` semantics byte-for-byte; the cursor block is
  // layered on top and emitted only when the designated list is actually paged.
  const truncated = truncatedQ || truncatedG;

  // R6 (BRIEF-084): scanTruncated now reflects the `scanAllNodesOfTypes`
  // residual-cap disclosure captured while walking each type above — not a
  // hand-rolled `countNodesByType` comparison against a single 500-row page.
  // A normal org (even 800+ queues) is fully walked, so this stays honestly
  // false and every node is reachable through the OUTPUT cursor below.
  const scanTruncated = scanQueuesIncomplete || scanGroupsIncomplete;
  const incompleteScanTypes = [
    ...(scanQueuesIncomplete ? ['Queue'] : []),
    ...(scanGroupsIncomplete ? ['Group'] : []),
  ];
  const boundaries: string[] = [...BOUNDARIES];
  if (scanTruncated) {
    boundaries.push(fullScanTruncationNote(incompleteScanTypes));
  }
  // R1 typed absence, in prose a host will read aloud: this vault's Queue nodes
  // predate the every-channel member walk, so their zeros are "we only read
  // `<users>`", not "nobody is in it". Built by the SHARED module so this
  // wording cannot drift from the other family disclosures.
  if (queuesMissingChannelScan.length > 0) {
    boundaries.push(
      notExtractedFamilyDisclosure({
        subject: 'Queue member channels (`<roles>` and every non-`<users>` channel)',
        verb: 'read',
        pluralSubject: true,
        sentinelProperty: QUEUE_MEMBER_CHANNELS_SENTINEL,
        containers: [...queuesMissingChannelScan].sort(),
        surface: '`memberCount` / `memberSource`',
        zeroReading: '"the queue is empty"',
      }),
    );
  }
  if (groupsWithNoDeclaredMembership > 0) {
    boundaries.push(
      groupMembershipNotInMetadataDisclosure(groupsWithNoDeclaredMembership),
    );
  }

  // CR-22 section cursor: page ONE designated list (queues by default; groups
  // when type:'Group') and disclose the other honestly. On resume the handler
  // feeds token.listId back as designatedListId (paginateSection does NOT
  // cross-check — B0 note).
  const TOOL = 'sfi.empty_queues_and_groups';
  const fingerprint = argsFingerprint({
    type: typeFilter,
    includeManagedPackage: includeManaged,
    // Bind the name filter into the cursor so a scoped cursor cannot replay
    // against the bare list. `argsFingerprint` drops undefined, so a bare call's
    // fingerprint is unchanged (byte-identical cursor behavior preserved).
    nameContains: input.nameContains,
  });
  let designatedListId = typeFilter === 'Group' ? 'groups' : 'queues';
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
    if (decoded.value.listId !== undefined) designatedListId = decoded.value.listId;
  }

  const sections: readonly PageableSection<EmptyQueueEntry | EmptyGroupEntry>[] = [
    { listId: 'queues', items: sortedQueues },
    { listId: 'groups', items: sortedGroups },
  ];
  const pagedResult = paginateSection(sections, designatedListId, {
    offset,
    limit,
    byteBudget: EMPTY_QUEUES_BYTE_BUDGET,
    keyOf: (e) => e.id,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
  });
  if (!pagedResult.ok) return err(pagedResult.error);
  const paged = pagedResult.value;
  const emitCursor = paged.pageInfo.nextCursor !== null;

  // coverage-aware-zero: caveat over the families this call actually scanned,
  // scoped to the `type` filter, so an empty result reads "not retrieved"
  // rather than a proven "no empty queues/groups".
  const coverageTypes = [
    ...(typeFilter === 'Queue' || typeFilter === 'both' ? ['Queue'] : []),
    ...(typeFilter === 'Group' || typeFilter === 'both' ? ['Group'] : []),
  ];
  const coverageCaveat = buildEnumerationCoverageCaveatFor(
    ctx,
    coverageTypes,
    'The empty queue/group inventory',
  );

  const queuesPage =
    designatedListId === 'queues'
      ? (paged.items as readonly EmptyQueueEntry[])
      : sortedQueues.slice(0, limit);
  const groupsPage =
    designatedListId === 'groups'
      ? (paged.items as readonly EmptyGroupEntry[])
      : sortedGroups.slice(0, limit);

  return ok({
    data: {
      queues: queuesPage,
      groups: groupsPage,
      totalQueues: sortedQueues.length,
      totalGroups: sortedGroups.length,
      unknownMemberCountQueues,
      unknownMemberCountGroups,
      // The emptiness headline. `total*` counts ROWS (unknowns included), so a
      // host that repeats it would repeat "41 empty groups" over 41 unmeasured
      // ones; these two are the numbers a cleanup shortlist may act on.
      confirmedEmptyQueues: sortedQueues.length - unknownMemberCountQueues,
      confirmedEmptyGroups: sortedGroups.length - unknownMemberCountGroups,
      boundaries,
      truncated,
      // Present ONLY when a name filter was passed, so a bare call stays
      // byte-identical to the pre-filter golden.
      ...(input.nameContains !== undefined
        ? {
            appliedScope: {
              nameContains: input.nameContains,
              mode: 'nameContains' as const,
            },
          }
        : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(scanTruncated
        ? {
            scanTruncated: true,
            ...(scanQueuesIncomplete ? { totalQueueNodes: totalQueueNodesScanned } : {}),
            ...(scanGroupsIncomplete ? { totalGroupNodes: totalGroupNodesScanned } : {}),
          }
        : {}),
      ...(emitCursor
        ? {
            nextCursor: paged.pageInfo.nextCursor as string,
            pageInfo: paged.pageInfo,
            designatedList: paged.listId,
            otherSections: paged.otherSections,
          }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
