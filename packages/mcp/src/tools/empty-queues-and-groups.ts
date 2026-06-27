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
 * Member-count extraction:
 *   - Queue: reads `properties.memberCount` (the v0.1 extractor
 *     convention) OR walks `properties.queueMembers` array length.
 *     When neither is populated, returns 'unknown'.
 *   - Group: same shape, reading `properties.memberCount` or
 *     `properties.groupMembers`.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { countNodesByType, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
  type SectionDisclosure,
} from './page-cursor.js';

/** Per-response byte budget for the designated list's page. */
const EMPTY_QUEUES_BYTE_BUDGET = 38_000;

/** Inclusive upper bound on `limit`. */
const EMPTY_QUEUES_MAX_LIMIT = 500;
/** Default `limit`. */
const EMPTY_QUEUES_DEFAULT_LIMIT = 100;
/** Internal page-size cap. */
const LIST_PAGE_SIZE = 500;

/**
 * Age threshold for `isLikelyStale`: 180 days. A queue/group with zero
 * members AND incoming references AND a `lastModifiedAt` older than
 * this threshold is "old + empty + referenced" — a high-priority
 * cleanup target.
 */
const STALE_AGE_MS = 180 * 24 * 60 * 60 * 1000;

/** Verbatim boundary disclosures. */
const BOUNDARIES: readonly string[] = Object.freeze([
  'queue and group member resolution depends on direct user references in metadata XML; runtime membership changes (via Setup UI) since the last vault refresh are not reflected.',
  'member counts of "unknown" indicate the vault did not extract enough data to resolve membership — these are NOT counted toward emptiness.',
]);

/** Zod schema for the input. */
export const emptyQueuesAndGroupsInputSchema = z.object({
  type: z.enum(['Queue', 'Group', 'both']).optional(),
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
}

/** Output payload. */
export interface EmptyQueuesAndGroupsOutput {
  readonly queues: readonly EmptyQueueEntry[];
  readonly groups: readonly EmptyGroupEntry[];
  readonly totalQueues: number;
  readonly totalGroups: number;
  readonly unknownMemberCountQueues: number;
  readonly unknownMemberCountGroups: number;
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  /**
   * CR-RV12: TRUE when the >500 node SCAN cap (LIST_PAGE_SIZE) dropped Queue
   * and/or Group nodes BEFORE emptiness was computed — so the lists (and totals)
   * cover only the first 500 of that type. Present ONLY when actually true so a
   * ≤500-node org's golden does not move.
   */
  readonly scanTruncated?: boolean;
  /** CR-RV12: true org-wide Queue count (only when the Queue scan was capped). */
  readonly totalQueueNodes?: number;
  /** CR-RV12: true org-wide Group count (only when the Group scan was capped). */
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

const propertyString = (node: Node, key: string): string => {
  const v = node.properties[key];
  return typeof v === 'string' ? v : '';
};

const propertyStringArray = (node: Node, key: string): readonly string[] => {
  const v = node.properties[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
};

/**
 * Resolve the member count for a Queue or Group from its properties.
 * Returns `{ count, source }` where `source` is `'unknown'` if the
 * extractors did not populate any member data.
 *
 * Resolution order:
 *   1. Numeric `properties.memberCount` (v1.1+ extractor convention).
 *   2. Array length of `properties.queueMembers` /
 *      `properties.groupMembers` (v0.1 fallback).
 *   3. Returns `{ count: 0, source: 'unknown' }`.
 */
const resolveMemberCount = (
  node: Node,
  membersKey: 'queueMembers' | 'groupMembers',
): { count: number; source: MemberSource } => {
  const explicit = node.properties['memberCount'];
  if (typeof explicit === 'number') {
    // Determine the member source from a sibling field. Default to
    // user-direct when the extractor didn't tag it explicitly.
    const sourceProp = node.properties['memberSource'];
    const source: MemberSource =
      sourceProp === 'group-resolved' ||
      sourceProp === 'role-resolved' ||
      sourceProp === 'unknown' ||
      sourceProp === 'user-direct'
        ? sourceProp
        : 'user-direct';
    return { count: explicit, source };
  }
  const members = node.properties[membersKey];
  if (Array.isArray(members)) {
    return { count: members.length, source: 'user-direct' };
  }
  // Defensive: when no member data exists, the answer is "unknown."
  return { count: 0, source: 'unknown' };
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

  const queues: EmptyQueueEntry[] = [];
  let unknownMemberCountQueues = 0;

  if (typeFilter === 'Queue' || typeFilter === 'both') {
    const qRes = await listNodesByType(ctx.graph, 'Queue', {
      limit: LIST_PAGE_SIZE,
    });
    if (!qRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${qRes.error.message}`,
      });
    }
    for (const queue of qRes.value) {
      const ns = namespacePrefixOf(queue.apiName);
      if (!includeManaged && ns !== null) continue;
      const { count, source } = resolveMemberCount(queue, 'queueMembers');
      const arCountRes = await countAssignmentRuleReferences(ctx, queue.id);
      if (!arCountRes.ok) {
        return err({ kind: 'internal', message: arCountRes.error });
      }
      const objectTypes = propertyStringArray(queue, 'objectTypes');

      if (source === 'unknown') {
        unknownMemberCountQueues += 1;
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
        });
      }
    }
  }

  const groups: EmptyGroupEntry[] = [];
  let unknownMemberCountGroups = 0;

  if (typeFilter === 'Group' || typeFilter === 'both') {
    const gRes = await listNodesByType(ctx.graph, 'Group', {
      limit: LIST_PAGE_SIZE,
    });
    if (!gRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${gRes.error.message}`,
      });
    }
    for (const group of gRes.value) {
      const ns = namespacePrefixOf(group.apiName);
      if (!includeManaged && ns !== null) continue;
      const { count, source } = resolveMemberCount(group, 'groupMembers');
      const refCountRes = await countGroupReferences(ctx, group.id);
      if (!refCountRes.ok) {
        return err({ kind: 'internal', message: refCountRes.error });
      }

      if (source === 'unknown') {
        unknownMemberCountGroups += 1;
        groups.push({
          id: group.id,
          apiName: group.apiName,
          label: group.label ?? '',
          groupType: propertyString(group, 'type'),
          memberCount: 0,
          memberSource: 'unknown',
          incomingReferenceCount: refCountRes.value,
          isLikelyStale: false,
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

  // CR-RV12 honest SCAN-cap disclosure: the per-type scan above is capped at
  // LIST_PAGE_SIZE, so on a >500-node org both the lists AND totalQueues/
  // totalGroups silently under-count. Compare a TRUE count against the cap; when
  // a scan saturated, surface scanTruncated + the true node counts. Emitted only
  // when actually capped so a ≤500-node org's golden does not move.
  let scanQueuesCapped = false;
  let scanGroupsCapped = false;
  let totalQueueNodes = 0;
  let totalGroupNodes = 0;
  if (typeFilter === 'Queue' || typeFilter === 'both') {
    const c = await countNodesByType(ctx.graph, 'Queue');
    if (!c.ok) return err({ kind: 'internal', message: `graph query failed: ${c.error.message}` });
    totalQueueNodes = c.value;
    scanQueuesCapped = c.value > LIST_PAGE_SIZE;
  }
  if (typeFilter === 'Group' || typeFilter === 'both') {
    const c = await countNodesByType(ctx.graph, 'Group');
    if (!c.ok) return err({ kind: 'internal', message: `graph query failed: ${c.error.message}` });
    totalGroupNodes = c.value;
    scanGroupsCapped = c.value > LIST_PAGE_SIZE;
  }
  const scanTruncated = scanQueuesCapped || scanGroupsCapped;

  // CR-22 section cursor: page ONE designated list (queues by default; groups
  // when type:'Group') and disclose the other honestly. On resume the handler
  // feeds token.listId back as designatedListId (paginateSection does NOT
  // cross-check — B0 note).
  const TOOL = 'sfi.empty_queues_and_groups';
  const fingerprint = argsFingerprint({
    type: typeFilter,
    includeManagedPackage: includeManaged,
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
      boundaries: BOUNDARIES,
      truncated,
      ...(scanTruncated
        ? {
            scanTruncated: true,
            ...(scanQueuesCapped ? { totalQueueNodes } : {}),
            ...(scanGroupsCapped ? { totalGroupNodes } : {}),
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
