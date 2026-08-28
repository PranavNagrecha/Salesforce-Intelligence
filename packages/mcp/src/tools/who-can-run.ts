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
 *
 * The sharper honesty axis is EXTRACTION VINTAGE. Every answer here is derived
 * from `flowAccess` edges that only exist if the refresh that built the vault
 * ran `buildFlowEdges`. On an older vault NO flow has one, so an unguarded
 * handler answers `granters: [], summary.granters: 0, confidence: 'declared'`
 * for every flow in the org — a false verified zero on a security surface, and
 * the evidence an admin uses to call a flow orphaned and retire it. The family
 * is therefore decided by the `flowGrantCount` SENTINEL on the granting
 * containers (`familyWasExtracted`), never by the inbound edge set being empty.
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

import { familyWasExtracted, notExtractedFamilyDisclosure } from './absence-disclosure.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

const FLOW_PREFIX = 'Flow:';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * The property BOTH container extractors always write when the `flowAccesses`
 * family was extracted at all — `flowGrantCount: flowEdges.length`, emitted
 * from the same block as `buildFlowEdges` in
 * `packages/extractors/src/profile.ts` and
 * `packages/extractors/src/permission-set.ts`, on EVERY container INCLUDING one
 * that grants zero flows. So the key's ABSENCE means the `flowAccess` grant
 * edges were never extracted, and an empty inbound edge set is "not modeled",
 * NEVER a verified "nobody can run this flow".
 *
 * Deliberately the SAME sentinel the forward direction (`user_ability`) reads,
 * so the two ends of one edge family agree by construction rather than by luck.
 */
const FLOW_GRANTS_SENTINEL = 'flowGrantCount';

/** The container types that can carry a `<flowAccesses>` run grant. */
const GRANTER_TYPES = ['Profile', 'PermissionSet'] as const;

/**
 * The computed-from-what sentence this tool has always carried. Split out so
 * the never-extracted disclosure can LEAD the note (it is an understatement of
 * access) without the two being interleaved by hand at the return site.
 */
const COMPUTED_NOTE =
  'These Profiles/PermissionSets grant RUN access to the flow (flowAccess). A user gains it only when ASSIGNED the container (runtime, not modeled), and run also requires the flow to be active. "Who can open an app" is app_access; report/dashboard FOLDER access needs the live plane (folder shares are not in the offline metadata).';

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
  readonly summary: {
    /**
     * Containers granting run access to this flow, or `null` when NOT ONE
     * container in the vault carries the extracted {@link FLOW_GRANTS_SENTINEL}
     * and no run grant was found — the `flowAccess` family was never extracted,
     * so NOTHING was checked. `0` is reserved for a CHECKED zero: containers
     * that were examined and grant nobody run access.
     *
     * A false `0` on a security surface is a missed grant (or a flow wrongly
     * declared orphaned and retired), which is why the two cases cannot share a
     * value. Same contract `user_ability.summary.runnableFlows` carries for the
     * FORWARD direction of these same edges.
     */
    readonly granters: number | null;
  };
  /**
   * How many Profile/PermissionSet containers in this vault carry NO extracted
   * {@link FLOW_GRANTS_SENTINEL} — i.e. were never examined for `<flowAccesses>`
   * at all. `0` on a fully-extracted vault. Any positive value means `granters`
   * is a FLOOR, not an enumeration, and the reason is spelled out in
   * `boundaryNote`.
   */
  readonly flowAccessNotChecked: number;
  /**
   * True when the container scan behind {@link flowAccessNotChecked} stopped at
   * the full-scan residual cap, so MORE unchecked containers may exist behind
   * it — the disclosure itself may be an understatement.
   */
  readonly scanTruncated: boolean;
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

  // ------------------------------------------------------------------
  // R1 TYPED ABSENCE — did this refresh extract `<flowAccesses>` AT ALL?
  //
  // The empty inbound edge set above reads IDENTICALLY for "checked, nobody
  // grants it" and "this vault's refresh predates `buildFlowEdges`, so no flow
  // has a run-grant edge". The flow node itself cannot answer that: the
  // sentinel lives on the GRANTING containers, so the question is asked of the
  // whole container corpus, per-container, never as a whole-corpus OR (one
  // extracted container must not vouch for the ones that were never read).
  // Scanned with the shared multi-window walk, so a corpus past the 500-row
  // `listNodesByType` ceiling is not alphabetically capped.
  // ------------------------------------------------------------------
  const containerScan = await scanAllNodesOfTypes(ctx.graph, [...GRANTER_TYPES]);
  if (!containerScan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${containerScan.error.message}` });
  }
  const containersNotChecked: string[] = [];
  let containersChecked = 0;
  for (const container of containerScan.value.nodes) {
    if (familyWasExtracted(container.properties, FLOW_GRANTS_SENTINEL)) containersChecked += 1;
    else containersNotChecked.push(container.id);
  }
  containersNotChecked.sort();
  const scanTruncated = containerScan.value.scanIncomplete;

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

  // The case-1 sentence comes from the ONE shared builder (R6) — the same
  // template `user_ability` / `app_access` render, so the two directions of this
  // edge family cannot drift into two wordings of one blind spot.
  const notCheckedNote =
    containersNotChecked.length > 0
      ? notExtractedFamilyDisclosure({
          subject: 'Flow run grants',
          verb: 'checked',
          pluralSubject: true,
          sentinelProperty: FLOW_GRANTS_SENTINEL,
          containers: containersNotChecked,
          surface: '`granters` / `summary.granters`',
          zeroReading: '"nobody can run this flow"',
        })
      : null;
  // Leading, because it is an UNDERSTATEMENT of access: a reader who stops after
  // one sentence must still learn the enumeration may be short.
  const baseNote = notCheckedNote === null ? COMPUTED_NOTE : `${notCheckedNote} ${COMPUTED_NOTE}`;
  const boundaryNote = scanTruncated
    ? `${baseNote} ${fullScanTruncationNote(containerScan.value.incompleteTypes)}`
    : baseNote;

  // NOTHING was checked and nothing was found → `null`, never a verified `0`.
  // A grant that WAS found makes the count a real floor, so it stays a number
  // even on a mixed-vintage vault (the shortfall is disclosed, not nulled).
  const grantersSummary =
    total === 0 && containersChecked === 0 && containersNotChecked.length > 0 ? null : total;

  return ok({
    data: {
      componentId,
      granters: page,
      summary: { granters: grantersSummary },
      limit,
      offset,
      hasMore,
      truncated: hasMore || offset > 0,
      flowAccessNotChecked: containersNotChecked.length,
      scanTruncated,
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      confidence: 'declared',
      boundaryNote,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
