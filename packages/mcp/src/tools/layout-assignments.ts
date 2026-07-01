/**
 * Handler for the `sfi.layout_assignments` MCP tool
 * (P11-ACCESS-layout-reverse).
 *
 * The REVERSE of `sfi.layout_for_user`: given a page Layout, list every
 * (Profile × RecordType) assignment that targets it. `layout_for_user`
 * answers "what layout does this user see for object X / record type Y";
 * this answers "what is THIS layout assigned to" — the question an admin
 * asks before editing or deleting a layout.
 *
 * The data is the same `properties.layoutAssignments` surface the forward
 * tool reads, so the two agree by construction (it imports the forward
 * tool's `readLayoutAssignments` / `canonicaliseLayoutId` /
 * `layoutTargetsObject` rather than re-deriving the format).
 *
 * Input: `{ componentId: 'Layout:{Object}.{LayoutName}', limit?, offset? }`.
 * Output: the profiles + record types that assign this layout. `declared`
 * confidence — layout assignments are declared Profile metadata. A widely
 * shared standard-object layout is assigned by every profile × record type
 * (hundreds of rows past the MCP response limit), so the inline list PAGES
 * (`limit`/`offset`/`hasMore`/`truncated`) while `summary` stays complete.
 *
 * Honesty axis:
 *   - **Classic page layouts only.** Lightning record pages (FlexiPage)
 *     are assigned through a different mechanism and are not covered here.
 *   - **Profile assignments only.** Layout assignment is a Profile-level
 *     element; permission sets do not assign layouts. The org-wide default
 *     layout (not tied to a profile) is also out of scope.
 *   - If NO profile in the vault carries a `layoutAssignments` property
 *     (the refresh predates that extraction), a `boundaryNote` discloses
 *     it rather than returning a confident empty list.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { mergeInputAliases, toLayoutId } from './input-aliases.js';
import {
  canonicaliseLayoutId,
  layoutTargetsObject,
  readLayoutAssignments,
} from './layout-for-user.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

/** Canonical id prefix for the layout a caller reverse-looks-up. */
const LAYOUT_PREFIX = 'Layout:';

/**
 * Per-page assignment cap. A widely-shared standard-object layout (e.g.
 * Account) is assigned by every profile × every record type — hundreds of
 * rows that serialise past the ~45 KB MCP response limit, so the inline list
 * pages. `summary` is ALWAYS the complete count. Default sized to stay well
 * under the limit (each row ~180 bytes); MAX left modest for the same reason.
 */
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 250;

const LAYOUT_ASSIGNMENTS_TOOL = 'sfi.layout_assignments';

const layoutAssignmentsInputBaseSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor from a prior truncated page's nextCursor.
  cursor: z.string().min(1).optional(),
});

/** Zod schema for the `sfi.layout_assignments` tool input. */
export const layoutAssignmentsInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    { canonical: 'componentId', aliases: ['layoutId'] },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.componentId === 'string' ? o.componentId : '';
    if (id.length > 0 && !id.startsWith(LAYOUT_PREFIX)) {
      o.componentId = toLayoutId(id);
    }
  }
  return merged;
}, layoutAssignmentsInputBaseSchema);

/** Parsed input shape. */
export type LayoutAssignmentsInput = z.infer<typeof layoutAssignmentsInputSchema>;

/** One (Profile × RecordType) assignment that targets the layout. */
export interface LayoutAssignmentRef {
  readonly profileId: ComponentId;
  readonly profileLabel: string;
  /**
   * The record-type axis of the assignment, as the bare `{Object}.{RT}`
   * form the profile metadata stores, or `null` for the object's default
   * ("master") assignment that carries no record type.
   */
  readonly recordType: string | null;
  /** Canonical record-type id, or `null` for the default assignment. */
  readonly recordTypeId: ComponentId | null;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface LayoutAssignmentsOutput {
  readonly layoutId: ComponentId;
  readonly object: string;
  readonly assignments: readonly LayoutAssignmentRef[];
  readonly summary: {
    /** Distinct profiles that assign this layout (COMPLETE, not paginated). */
    readonly profiles: number;
    /** Total (profile × record type) assignments (COMPLETE, not paginated). */
    readonly assignments: number;
  };
  /** The applied page size. */
  readonly limit: number;
  /** The applied offset into the full, sorted assignment list. */
  readonly offset: number;
  /** True when more assignment rows exist beyond this page. */
  readonly hasMore: boolean;
  /** True when the inlined `assignments` is a partial page of the full list. */
  readonly truncated: boolean;
  /**
   * True only for a PATHOLOGICAL residual cap (a Profile scan past
   * FULL_SCAN_MAX_NODES). The normal full multi-window scan reaches every
   * Profile (including 501+) and completes, so this is false for any real org.
   */
  readonly scanTruncated: boolean;
  readonly confidence: 'declared';
  /** Disclosure when the layout-assignment surface was not extracted, or scope caveats. */
  readonly boundaryNote: string;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more assignment rows remain). Echo it back as `cursor` to resume. Absent
   * on a complete page so an in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

const SCOPE_NOTE =
  'Classic page-layout assignments via Profiles only. Lightning record pages (FlexiPage) and the org-wide default layout are assigned differently and are not covered here.';

/**
 * The `sfi.layout_assignments` MCP tool. Enumerates the profiles + record
 * types that assign a given page Layout.
 *
 * @example
 *   await layoutAssignmentsHandler(ctx, {
 *     componentId: 'Layout:Account.Account Layout',
 *   });
 */
export const layoutAssignmentsHandler = async (
  ctx: Context,
  input: LayoutAssignmentsInput,
): Promise<Result<McpResponse<LayoutAssignmentsOutput>, McpError>> => {
  if (!input.componentId.startsWith(LAYOUT_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a Layout: id (e.g. 'Layout:Account.Account Layout'); got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const layoutId = input.componentId as ComponentId;

  // Resolve the layout node so a typo is a clear `component-not-found`
  // rather than a confident "no profile assigns this layout".
  const layoutNode = await getNodeById(ctx.graph, layoutId);
  if (!layoutNode.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${layoutNode.error.message}` });
  }
  if (layoutNode.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no Layout matches \`${layoutId}\` in this vault`,
      path: layoutId,
    });
  }

  // The object api name is the segment between `Layout:` and the first dot.
  const afterPrefix = layoutId.slice(LAYOUT_PREFIX.length);
  const dot = afterPrefix.indexOf('.');
  const object = dot > 0 ? afterPrefix.slice(0, dot) : afterPrefix;

  // CR-22 B3: scan EVERY Profile by paging the SQL OFFSET forward (window-by-
  // window at the clamped cap) so assignments owned by Profile 501+ are
  // reachable — the single capped page used to drop the scan TAIL silently. The
  // derived assignment list is then COMPLETE and paged on the output axis below.
  const scan = await scanAllNodesOfTypes(ctx.graph, ['Profile']);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }
  const scanTruncated = scan.value.scanIncomplete;

  const assignments: LayoutAssignmentRef[] = [];
  const distinctProfiles = new Set<string>();
  let anyProfileHadAssignments = false;

  for (const profile of scan.value.nodes) {
    const entries = readLayoutAssignments(profile);
    if (entries === null) continue; // property absent on this profile
    anyProfileHadAssignments = true;
    for (const entry of entries) {
      if (!layoutTargetsObject(entry.layout, object)) continue;
      if (canonicaliseLayoutId(entry.layout, object) !== layoutId) continue;
      const recordType = entry.recordType ?? null;
      assignments.push({
        profileId: profile.id as ComponentId,
        profileLabel: profile.label ?? profile.apiName,
        recordType,
        recordTypeId: recordType !== null ? (`RecordType:${recordType}` as ComponentId) : null,
      });
      distinctProfiles.add(profile.id);
    }
  }

  // CR-22: total-order tiebreak. profileId then recordType then the raw record-
  // type id makes the order a STRICT TOTAL order — two rows sharing profileId
  // AND recordType previously compared equal (returned 0), so an offset resume
  // could dup/skip at that tie. `recordTypeId` is the last distinguishing key;
  // if even it ties, the rows are genuine duplicates (same profile, same RT,
  // same layout) and ordering between them is immaterial.
  assignments.sort((a, b) => {
    if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
    const ra = a.recordType ?? '';
    const rb = b.recordType ?? '';
    if (ra !== rb) return ra < rb ? -1 : 1;
    const ka = a.recordTypeId ?? '';
    const kb = b.recordTypeId ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Complete counts BEFORE pagination — a widely-shared layout (Account is
  // assigned by every profile × record type) overflows the MCP response limit,
  // so the inline list pages while the summary stays whole.
  const totalAssignments = assignments.length;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers the narrowing arg `componentId` so a token minted for
  // one layout can't be replayed against another.
  const fingerprint = argsFingerprint({ componentId: layoutId });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: LAYOUT_ASSIGNMENTS_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(assignments, {
    offset,
    limit,
    keyOf: (a) => `${a.profileId}|${a.recordType ?? ''}|${a.recordTypeId ?? ''}`,
    binding: {
      tool: LAYOUT_ASSIGNMENTS_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const page = paged.items;
  const hasMore = paged.hasMore;
  const truncated = hasMore || offset > 0;
  const emitCursor = paged.nextCursor !== null;

  const pageNote = truncated
    ? ` Showing assignments ${offset}–${offset + page.length} of ${totalAssignments}; summary holds the COMPLETE counts. Page with offset/limit or the returned cursor.`
    : '';
  const scanNote = scanTruncated
    ? ` ${scanTruncationNote(['Profile'], clampedNodeScanLimit())}`
    : '';
  const boundaryNote = anyProfileHadAssignments
    ? `${SCOPE_NOTE}${pageNote}${scanNote}`
    : `No profile in this vault carries an extracted \`layoutAssignments\` property, so layout assignments could not be evaluated — the result is "not modeled", not a verified "no assignments". Re-run \`/sfi-refresh\` to populate it. ${SCOPE_NOTE}${scanNote}`;

  return ok({
    data: {
      layoutId,
      object,
      assignments: page,
      summary: { profiles: distinctProfiles.size, assignments: totalAssignments },
      limit,
      offset,
      hasMore,
      truncated,
      scanTruncated,
      confidence: 'declared',
      boundaryNote,
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
