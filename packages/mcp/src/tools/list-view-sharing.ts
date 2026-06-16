/**
 * Handler for the `sfi.list_view_sharing` MCP tool (P11 list-view sharing).
 *
 * "Who is this list view shared with" — a list view's `<sharedTo>` visibility
 * scope (the groups / roles it appears for in the list-view picker), now
 * captured at extraction as `visibleTo` edges + `properties.sharedTo`. Two
 * query modes, both returning the same `listViews[]` row shape:
 *   - `CustomObject:X` → every list view on the object + its sharing scope.
 *   - `ListView:X.Y`   → that one list view's sharing scope.
 *
 * `declared` confidence — `<sharedTo>` is explicit list-view metadata.
 *
 * Honesty axis (`boundaryNote`, always present):
 *   - This is the saved VIEW's visibility, NOT record access — a user still
 *     needs read access to the object (and the records pass the view's filter).
 *   - `filterScope` (Everything / Mine / Queue / …) is the record filter, a
 *     SEPARATE axis from who-can-see-the-view; it is surfaced, not conflated.
 *   - "Visible only to me" personal list views are not in deployed metadata, so
 *     a list view with no `<sharedTo>` is visible to all users who can see the
 *     object — never read absence as "private".
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

const OBJECT_PREFIX = 'CustomObject:';
const LISTVIEW_PREFIX = 'ListView:';
const DEFAULT_LIMIT = 100;
// An object with many list views (a real org's Contact had 146) overflows the
// ~45 KB MCP response limit around 146 rows (~47 KB). Cap the page so the tool
// never OFFERS an oversize page; the per-page rows stay ~40 KB at the max and
// `hasMore`/`offset` walk the rest. (Measured on a real-org vault.)
const MAX_LIMIT = 120;
/** Bound the per-object scan (listNodesByType caps at 500 per page). */
const SCAN_PAGE = 500;
const SCAN_MAX = 4000;

export const listViewSharingInputSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

export type ListViewSharingInput = z.infer<typeof listViewSharingInputSchema>;

/** One `<sharedTo>` visibility target (a group / role / synthetic group). */
export interface SharedToEntry {
  readonly type: string;
  readonly name: string | null;
  readonly targetId: string;
  readonly inheritance?: string;
  readonly synthetic?: boolean;
}

type Visibility = 'sharedWithGroupsRoles' | 'allUsersWithObjectAccess';

/** One list view + its sharing scope. `componentId` is the canonical row id. */
export interface ListViewSharingRow {
  readonly componentId: string;
  readonly apiName: string;
  readonly filterScope: string | null;
  readonly visibility: Visibility;
  readonly sharedToCount: number;
  readonly sharedTo: readonly SharedToEntry[];
}

export interface ListViewSharingOutput {
  readonly componentId: string;
  readonly scope: 'object' | 'listView';
  readonly listViews: readonly ListViewSharingRow[];
  readonly summary: {
    readonly listViews: number;
    readonly sharedWithGroupsRoles: number;
    readonly allUsersWithObjectAccess: number;
    readonly distinctTargets: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly confidence: 'declared';
  readonly boundaryNote: string;
}

const BOUNDARY_NOTE =
  'Shows the saved list view’s <sharedTo> visibility scope (the groups/roles it is shared with), at `declared` confidence. This is visibility of the VIEW, not record access — a user still needs read access to the object and the records must pass the view’s filter. `filterScope` (Everything/Mine/Queue/…) is the record filter, a separate axis from who-can-see-the-view. A list view with no <sharedTo> is visible to all users who can see the object; "visible only to me" personal views are not in deployed metadata, so absence is never "private". roleAndSubordinates targets also reach subordinate roles via the role hierarchy.';

/** Read a node's `properties.sharedTo` into typed entries (defensive). */
const readSharedTo = (node: Node): SharedToEntry[] => {
  const raw = node.properties['sharedTo'];
  if (!Array.isArray(raw)) return [];
  const out: SharedToEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const targetId = typeof rec['targetId'] === 'string' ? rec['targetId'] : null;
    if (targetId === null) continue;
    out.push({
      type: typeof rec['type'] === 'string' ? rec['type'] : 'unknown',
      name: typeof rec['name'] === 'string' ? rec['name'] : null,
      targetId,
      ...(typeof rec['inheritance'] === 'string' ? { inheritance: rec['inheritance'] } : {}),
      ...(rec['synthetic'] === true ? { synthetic: true } : {}),
    });
  }
  return out;
};

const toRow = (node: Node): ListViewSharingRow => {
  const sharedTo = readSharedTo(node);
  const filterScopeRaw = node.properties['filterScope'];
  return {
    componentId: node.id,
    apiName: node.apiName,
    filterScope: typeof filterScopeRaw === 'string' ? filterScopeRaw : null,
    visibility: sharedTo.length > 0 ? 'sharedWithGroupsRoles' : 'allUsersWithObjectAccess',
    sharedToCount: sharedTo.length,
    sharedTo,
  };
};

const buildSummary = (rows: readonly ListViewSharingRow[]): ListViewSharingOutput['summary'] => {
  const distinct = new Set<string>();
  let shared = 0;
  for (const r of rows) {
    if (r.visibility === 'sharedWithGroupsRoles') shared += 1;
    for (const t of r.sharedTo) distinct.add(t.targetId);
  }
  return {
    listViews: rows.length,
    sharedWithGroupsRoles: shared,
    allUsersWithObjectAccess: rows.length - shared,
    distinctTargets: distinct.size,
  };
};

export const listViewSharingHandler = async (
  ctx: Context,
  input: ListViewSharingInput,
): Promise<Result<McpResponse<ListViewSharingOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const isObject = input.componentId.startsWith(OBJECT_PREFIX);
  const isListView = input.componentId.startsWith(LISTVIEW_PREFIX);

  if (!isObject && !isListView) {
    return err({
      kind: 'invalid-query',
      message:
        `list_view_sharing answers "who is this list view shared with" — componentId must be a CustomObject: id ` +
        `(all of the object’s list views) or a ListView: id (one list view); got '${input.componentId}'.`,
      path: 'componentId',
    });
  }
  const componentId = input.componentId as ComponentId;

  // Collect the relevant ListView nodes (all, for an accurate object-wide
  // summary), then paginate the OUTPUT rows.
  let allRows: ListViewSharingRow[];
  let scope: 'object' | 'listView';

  if (isObject) {
    scope = 'object';
    const collected: ListViewSharingRow[] = [];
    for (let scanned = 0; scanned < SCAN_MAX; scanned += SCAN_PAGE) {
      const page = await listNodesByType(ctx.graph, 'ListView' as ComponentType, {
        parentId: componentId,
        limit: SCAN_PAGE,
        offset: scanned,
      });
      if (!page.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${page.error.message}` });
      }
      for (const node of page.value) collected.push(toRow(node));
      if (page.value.length < SCAN_PAGE) break;
    }
    allRows = collected.sort((a, b) =>
      a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
    );
  } else {
    scope = 'listView';
    const node = await getNodeById(ctx.graph, componentId);
    if (!node.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
    }
    if (node.value === null) {
      return err({
        kind: 'component-not-found',
        message: `no ListView matches \`${componentId}\` in this vault`,
        path: componentId,
      });
    }
    allRows = [toRow(node.value)];
  }

  const summary = buildSummary(allRows);
  const page = allRows.slice(offset, offset + limit);
  const hasMore = offset + page.length < allRows.length;

  return ok({
    data: {
      componentId,
      scope,
      listViews: page,
      summary,
      limit,
      offset,
      hasMore,
      truncated: hasMore || offset > 0,
      confidence: 'declared',
      boundaryNote: BOUNDARY_NOTE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
