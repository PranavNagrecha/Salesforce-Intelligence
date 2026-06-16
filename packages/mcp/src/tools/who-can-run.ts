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
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

const FLOW_PREFIX = 'Flow:';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export const whoCanRunInputSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export type WhoCanRunInput = z.infer<typeof whoCanRunInputSchema>;

/** One Profile/PermissionSet that grants run access to the flow. */
export interface FlowRunGranter {
  readonly granterId: string;
  readonly granterType: string;
  readonly granterLabel: string;
}

export interface WhoCanRunOutput {
  readonly componentId: string;
  readonly granters: readonly FlowRunGranter[];
  readonly summary: { readonly granters: number };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
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

  const granters: FlowRunGranter[] = [];
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
    });
  }
  granters.sort((a, b) => (a.granterId < b.granterId ? -1 : a.granterId > b.granterId ? 1 : 0));

  const total = granters.length;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const page = granters.slice(offset, offset + limit);
  const hasMore = offset + page.length < total;

  return ok({
    data: {
      componentId,
      granters: page,
      summary: { granters: total },
      limit,
      offset,
      hasMore,
      truncated: hasMore || offset > 0,
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
