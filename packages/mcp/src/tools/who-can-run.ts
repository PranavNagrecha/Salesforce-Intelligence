/**
 * Handler for the `sfi.who_can_run` MCP tool (P11-REVERSE-who-can-run).
 *
 * The REVERSE of `sfi.user_ability` (which is "what can this user run"): given
 * a `Flow:X`, which profiles / permission sets grant run access to it — from
 * the `flowAccess` `grantedBy` edges the extractor now emits. Completes the
 * reverse-access surface alongside `who_can_access_object` (records) and
 * `app_access` (which already lists the profiles that can OPEN an app).
 *
 * Input: `{ componentId: 'Flow:X', limit?, offset? }`.
 * `declared` confidence — flow access is declared profile/permset metadata.
 *
 * Honesty axis: "who can OPEN an app" is `app_access` (applicationVisibilities,
 * not a grantedBy edge); "who can access a report/dashboard FOLDER" needs the
 * live plane (folder shares aren't in the offline metadata) — disclosed, not
 * fabricated. A user must also be ASSIGNED the profile/permission set (runtime).
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const FLOW_PREFIX = 'Flow:';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export const whoCanRunInputSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0 / explicit `offset`).
  cursor: z.string().min(1).optional(),
});

export type WhoCanRunInput = z.infer<typeof whoCanRunInputSchema>;

/** One Profile/PermissionSet that grants run access to the flow. */
export interface FlowRunGranter {
  readonly granterId: string;
  readonly granterType: string;
  readonly granterLabel: string;
}

/**
 * Internal sort/page carrier: a {@link FlowRunGranter} plus the edge `source`
 * used as the TOTAL-ORDER tiebreak. `__source` is NEVER emitted (it is stripped
 * before the page goes onto `data.granters`) so the visible output stays
 * byte-identical to pre-CR-22.
 */
interface FlowRunGranterInternal extends FlowRunGranter {
  readonly __source: string;
}

export interface WhoCanRunOutput {
  readonly componentId: string;
  readonly granters: readonly FlowRunGranter[];
  readonly summary: { readonly granters: number };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token, present ONLY when this page was truncated
   * (more granters remain past `limit`). Echo it back as `cursor` to resume.
   * Absent on a whole-fits page so an in-budget response stays byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  readonly confidence: 'declared';
  readonly boundaryNote: string;
}

export const whoCanRunHandler = async (
  ctx: Context,
  input: WhoCanRunInput,
): Promise<Result<McpResponse<WhoCanRunOutput>, McpError>> => {
  if (!input.componentId.startsWith(FLOW_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message:
        `who_can_run answers "who can RUN this flow" — componentId must be a Flow: id; got '${input.componentId}'. ` +
        `For "who can OPEN an app" use app_access; "who can access a report/dashboard folder" needs the live plane.`,
      path: 'componentId',
    });
  }
  const componentId = input.componentId as ComponentId;

  // Phantom-aware: a flow referenced only by run-grant edges (not retrieved as a
  // node) is still answerable from those edges; an id with no node AND no inbound
  // run grant is genuinely unknown.
  const flowNode = await getNodeById(ctx.graph, componentId);
  if (!flowNode.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${flowNode.error.message}` });
  }

  const edgesResult = await listEdges(ctx.graph, componentId, { direction: 'in', edgeType: 'grantedBy' });
  if (!edgesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${edgesResult.error.message}` });
  }
  const runEdges = edgesResult.value.filter((e) => e.properties['flowAccess'] === true);

  if (flowNode.value === null && runEdges.length === 0) {
    return err({
      kind: 'component-not-found',
      message: `no Flow matches \`${componentId}\` in this vault (and nothing grants run access to it)`,
      path: componentId,
    });
  }

  const granters: FlowRunGranterInternal[] = [];
  for (const edge of runEdges) {
    const grantor = await getNodeById(ctx.graph, edge.fromId);
    if (!grantor.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${grantor.error.message}` });
    }
    const g = grantor.value;
    granters.push({
      granterId: edge.fromId,
      granterType: g?.type ?? (edge.fromId.includes(':') ? edge.fromId.slice(0, edge.fromId.indexOf(':')) : 'unknown'),
      granterLabel: g?.label ?? g?.apiName ?? edge.fromId,
      __source: edge.source,
    });
  }
  // TOTAL-ORDER sort: `granterId` ASC then edge `source` ASC. `granterId`
  // (= edge.fromId) alone is NOT unique — two grantedBy edges with the same
  // fromId but a different `source` (profile-extractor vs permission-set-
  // extractor, or a duplicate `<flowAccesses>` declaration) produce two rows
  // with an equal granterId, so the comparator would return 0. The edges PK is
  // (from_id, to_id, edge_type, source); to_id (the flow) and edge_type
  // (grantedBy) are fixed here, so within a fixed granterId only `source`
  // distinguishes two edges — appending it makes the order unique/total so a
  // CR-22 resume cannot dup or skip on a page boundary.
  granters.sort((a, b) =>
    a.granterId < b.granterId
      ? -1
      : a.granterId > b.granterId
        ? 1
        : a.__source < b.__source
          ? -1
          : a.__source > b.__source
            ? 1
            : 0,
  );

  const total = granters.length;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22: resolve the resume offset — an echoed cursor wins over an explicit
  // `offset`; a stale/forged cursor (changed componentId, different tool, or
  // refreshed vault) is rejected with `invalid-query`.
  const fingerprint = argsFingerprint({ componentId: input.componentId });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.who_can_run',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // No per-handler byte budget (offset/limit only) — set an effectively
  // unbounded byteBudget so `paginate()` truncates ONLY on `limit`
  // (byte-identical to the prior open-coded slice). The global jsonResult guard
  // remains the byte backstop. The cursor `k` carries the (granterId, source)
  // composite tiebreak.
  const paged = paginateLegacy(granters, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    binding: {
      tool: 'sfi.who_can_run',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
    keyOf: (g) => `${g.granterId} ${g.__source}`,
  });
  // Strip the internal `__source` tiebreak so the visible page stays exactly
  // the pre-CR-22 FlowRunGranter shape.
  const page: FlowRunGranter[] = paged.items.map((g) => ({
    granterId: g.granterId,
    granterType: g.granterType,
    granterLabel: g.granterLabel,
  }));
  const hasMore = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  return ok({
    data: {
      componentId,
      granters: page,
      summary: { granters: total },
      limit,
      offset,
      hasMore,
      truncated: hasMore || offset > 0,
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      confidence: 'declared',
      boundaryNote:
        'These Profiles/PermissionSets grant RUN access to the flow (flowAccess). A user gains it only when ASSIGNED the container (runtime, not modeled), and run also requires the flow to be active. "Who can open an app" is app_access; report/dashboard FOLDER access needs the live plane (folder shares are not in the offline metadata).',
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
