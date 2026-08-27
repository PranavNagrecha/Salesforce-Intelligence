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
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { countNodesByType, getNodeById, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveExistingObjectScope } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanTruncationNote } from './scan-cap.js';

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
/**
 * Hard ceiling on the per-object child-scan walk. CR-22 B3: a child count past
 * this is a pathological object (no real org has >20k list views on one
 * object); it is disclosed via `scanTruncated` rather than dropped SILENTLY as
 * before (the tool used to stop at 4000 with NO disclosure at all).
 */
const SCAN_MAX = 20_000;
const LIST_VIEW_SHARING_TOOL = 'sfi.list_view_sharing';

export const listViewSharingInputSchema = z
  .object({
    // OBJECT mode: a `CustomObject:` id, or any object alias below (L2 Alias
    // OS). LISTVIEW mode: a `ListView:` componentId. At least one is required.
    componentId: z.string().min(1).optional(),
    object: z.string().min(1).optional(),
    objectApiName: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
  /** Count list views shared directly to this role api name (summary only). */
  sharedWithRoleApiName: z.string().min(1).optional(),
  /**
   * FILTER the returned list views to only those shared to this target — a
   * canonical `sharedTo` target id (`Group:X` / `Role:X` / …) OR a group/role
   * NAME (case-insensitive). Unlike `sharedWithRoleApiName` (a summary-only
   * count that leaves every row in place), this narrows `listViews[]` AND the
   * `summary`. A target that matches nothing yields ZERO rows — never a silent
   * full-object dump — and the applied filter is echoed in `appliedScope`.
   * `sharedTo` and `groupId` are accepted aliases (the natural arg names a host
   * reaches for) — supply ONE; conflicting values are an invalid-query, never a
   * silent strip.
   */
  sharedToId: z.string().min(1).optional(),
  sharedTo: z.string().min(1).optional(),
  groupId: z.string().min(1).optional(),
  /**
   * FILTER the returned list views to those whose api name contains this
   * substring (case-insensitive). Composable with `sharedToId` (AND).
   */
  nameContains: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor from a prior truncated page's nextCursor.
  cursor: z.string().min(1).optional(),
  })
  .refine(
    (i) =>
      i.componentId !== undefined ||
      i.object !== undefined ||
      i.objectApiName !== undefined ||
      i.objectId !== undefined,
    {
      message:
        'name the object or list view — pass a `componentId` (`CustomObject:` for an object, `ListView:` for one view) or an object alias (`objectApiName` / `object` / `objectId`)',
      path: ['componentId'],
    },
  );

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
    /**
     * Count of list views that have at least one `sharedTo` entry with
     * `type === 'role'` (direct role share, NOT roleAndSubordinates).
     * Computed over ALL list views for the object — not just the current
     * page — so agents can answer "how many are shared directly to role X?"
     * without paginating through every `listViews[]` row.
     */
    readonly directRoleShareCount: number;
    /** When `sharedWithRoleApiName` is supplied — views with a direct role share to that role. */
    readonly sharedToRoleCount?: number;
    readonly sharedToRoleApiName?: string;
  };
  /**
   * Echoes the row filter ACTUALLY applied so a host never assumes a
   * `sharedToId`/`nameContains` it passed took effect (a silently-stripped
   * filter arg — returning the whole object — was the bug this closes).
   * `filtered` is true when any filter narrowed the rows; `totalBeforeFilter`
   * is the object's full list-view count; `matched` is how many passed the
   * filter (== `summary.listViews` when filtered).
   */
  readonly appliedScope: {
    /**
     * LIST-VIEW-SHARING-ANSWERS-A-NONEXISTENT-OBJECT: in OBJECT mode, the
     * canonical `CustomObject:` id the scan was actually run against — always
     * the VAULT's exact casing, never the caller's string, so the response
     * never asserts an id that does not exist. `null` in `ListView:` reverse
     * mode, where the single view's own `componentId` is the scope.
     */
    readonly object: string | null;
    readonly sharedToId: string | null;
    readonly nameContains: string | null;
    readonly filtered: boolean;
    readonly totalBeforeFilter: number;
    readonly matched: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /**
   * CR-22 B3: true ONLY when an object has more list views than the per-object
   * scan walk (`SCAN_MAX`) could read — a pathological object. Was a SILENT
   * drop before. False for any real org.
   */
  readonly scanTruncated?: boolean;
  readonly confidence: 'declared';
  readonly boundaryNote: string;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated.
   * Echo it back as `cursor` to resume. Absent on a complete page so an
   * in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

const BOUNDARY_NOTE =
  'Shows the saved list view’s <sharedTo> visibility scope (the groups/roles it is shared with), at `declared` confidence. This is visibility of the VIEW, not record access — a user still needs read access to the object and the records must pass the view’s filter. `filterScope` (Everything/Mine/Queue/…) is the record filter, a separate axis from who-can-see-the-view. A list view with no <sharedTo> is visible to all users who can see the object; "visible only to me" personal views are not in deployed metadata, so absence is never "private". roleAndSubordinates targets also reach subordinate roles via the role hierarchy. IMPORTANT: `summary` counts (including `directRoleShareCount`) are computed over ALL list views for the object — not just the current page. Per-entry type breakdowns (role vs roleAndSubordinates) within `sharedTo[]` are present only in the paginated `listViews[]` rows; exhaust all pages via `nextCursor` before counting by type manually.';

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

/**
 * Does a list-view row match the optional `sharedToId` / `nameContains` filter?
 * `sharedToId` matches a `sharedTo` entry by canonical target id (`Group:X` /
 * `Role:X`, exact) OR by its display name (case-insensitive) — a host asking
 * "shared to the Advising group" can pass either the id or the label. Filters
 * compose with AND. Called only when at least one filter is present.
 */
const rowMatchesFilter = (
  row: ListViewSharingRow,
  sharedToId: string | undefined,
  nameContains: string | undefined,
): boolean => {
  if (sharedToId !== undefined) {
    const needle = sharedToId.toLowerCase();
    const hit = row.sharedTo.some(
      (t) => t.targetId === sharedToId || (t.name !== null && t.name.toLowerCase() === needle),
    );
    if (!hit) return false;
  }
  if (nameContains !== undefined) {
    if (!row.apiName.toLowerCase().includes(nameContains.toLowerCase())) return false;
  }
  return true;
};

const buildSummary = (
  rows: readonly ListViewSharingRow[],
  sharedWithRoleApiName?: string,
): ListViewSharingOutput['summary'] => {
  const distinct = new Set<string>();
  let shared = 0;
  let directRoleShareCount = 0;
  let sharedToRoleCount = 0;
  const roleTargetId =
    sharedWithRoleApiName !== undefined
      ? `Role:${sharedWithRoleApiName}`
      : null;
  for (const r of rows) {
    if (r.visibility === 'sharedWithGroupsRoles') shared += 1;
    let hasDirectRole = false;
    let matchesRole = false;
    for (const t of r.sharedTo) {
      distinct.add(t.targetId);
      if (t.type === 'role') hasDirectRole = true;
      if (
        roleTargetId !== null &&
        t.targetId === roleTargetId &&
        t.type === 'role'
      ) {
        matchesRole = true;
      }
    }
    if (hasDirectRole) directRoleShareCount += 1;
    if (matchesRole) sharedToRoleCount += 1;
  }
  return {
    listViews: rows.length,
    sharedWithGroupsRoles: shared,
    allUsersWithObjectAccess: rows.length - shared,
    distinctTargets: distinct.size,
    directRoleShareCount,
    ...(sharedWithRoleApiName !== undefined
      ? { sharedToRoleCount, sharedToRoleApiName: sharedWithRoleApiName }
      : {}),
  };
};

export const listViewSharingHandler = async (
  ctx: Context,
  input: ListViewSharingInput,
): Promise<Result<McpResponse<ListViewSharingOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const rawComponentIdInput = input.componentId;

  // L2 Alias OS: resolve an OBJECT scope from object / objectApiName / objectId
  // or a CustomObject: componentId (a reverse-mode ListView: componentId is NOT
  // an object alias). Disagreeing object aliases -> invalid-query.
  //
  // LIST-VIEW-SHARING-ANSWERS-A-NONEXISTENT-OBJECT: the scope is now VERIFIED
  // against the vault before the scan, via the same `resolveExistingObjectScope`
  // `unused_fields_deep` / `flow_fault_audit` / `flow_bulkification_audit` use.
  //
  // What this replaced: the sync `resolveObjectAlias` coerced the caller's
  // string to a `CustomObject:` id and the object branch below handed it
  // straight to `listNodesByType(..., {parentId})`. An id no vault node owns has
  // no children, so the query returned zero rows. What a user saw: asking "who
  // can see Zzz_Nonexistent__c's list views?" came back `listViews: []`,
  // `summary.sharedWithGroupsRoles: 0`, `distinctTargets: 0` and a boundaryNote
  // about view-vs-record access — no boundary, no disclosure, nothing naming
  // the miss. On an ACCESS question that confident empty reads as "nobody can
  // see it", about an object the tool never found. The unverified parentId also
  // silently zeroed a REAL object typed in the wrong case (`CustomObject:account`
  // matches no row), so an exactly-correct question got an exactly-wrong answer.
  //
  // A BARE (`:`-free) componentId is still NOT an object alias here — this tool
  // is polymorphic and its `componentId` carries the `ListView:` reverse mode,
  // so a bare value keeps falling through to the explicit
  // "CustomObject: or ListView:" refusal below rather than being invented into
  // an object. Stripping it from the resolver's view preserves the old
  // `bareComponentIdIsObject: false` semantics exactly.
  const bareComponentId =
    rawComponentIdInput !== undefined && !rawComponentIdInput.includes(':');
  const objScope = await resolveExistingObjectScope(
    ctx.graph,
    bareComponentId ? { ...input, componentId: undefined } : input,
  );
  if (!objScope.ok) return err(objScope.error);
  const rawComponentId = rawComponentIdInput;
  let resolvedId: string;
  if (objScope.value !== null) {
    // OBJECT mode. A ListView: componentId alongside an object is ambiguous.
    if (rawComponentId !== undefined && rawComponentId.startsWith(LISTVIEW_PREFIX)) {
      return err({
        kind: 'invalid-query',
        message:
          'pass either a ListView: componentId (one view) or an object (all of the object’s views), not both',
        path: 'componentId',
      });
    }
    resolvedId = objScope.value.componentId;
  } else if (rawComponentId !== undefined) {
    resolvedId = rawComponentId;
  } else {
    return err({
      kind: 'invalid-query',
      message:
        'name the object or list view — pass a `componentId` (CustomObject: or ListView:) or an object alias (objectApiName / object / objectId)',
      path: 'componentId',
    });
  }
  const isObject = resolvedId.startsWith(OBJECT_PREFIX);
  const isListView = resolvedId.startsWith(LISTVIEW_PREFIX);

  if (!isObject && !isListView) {
    return err({
      kind: 'invalid-query',
      message:
        `list_view_sharing answers "who is this list view shared with" — componentId must be a CustomObject: id ` +
        `(all of the object’s list views) or a ListView: id (one list view); got '${resolvedId}'.`,
      path: 'componentId',
    });
  }
  const componentId = resolvedId as ComponentId;

  // Collect the relevant ListView nodes (all, for an accurate object-wide
  // summary), then paginate the OUTPUT rows.
  let allRows: ListViewSharingRow[];
  let scope: 'object' | 'listView';
  let scanTruncated = false;

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
    // CR-22 B3: the walk above stops at SCAN_MAX. Use a TRUE per-object count to
    // disclose (rather than SILENTLY drop) when an object has more list views
    // than the walk read — pre-B3 this was an undisclosed truncation.
    if (collected.length >= SCAN_MAX) {
      const trueCount = await countNodesByType(ctx.graph, 'ListView', {
        parentId: componentId,
      });
      if (trueCount.ok && trueCount.value > collected.length) scanTruncated = true;
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

  // Resolve the shared-to target from its canonical name + the two aliases a
  // host naturally reaches for (`sharedTo` / `groupId`). Exactly one distinct
  // value may be supplied — conflicting aliases are an invalid-query, not a
  // silent strip (the whole class of bug this closes).
  const sharedToInputs = [input.sharedToId, input.sharedTo, input.groupId].filter(
    (v): v is string => v !== undefined,
  );
  if (new Set(sharedToInputs).size > 1) {
    return err({
      kind: 'invalid-query',
      message:
        'sharedToId / sharedTo / groupId were given conflicting values; pass one shared-to target.',
      path: 'sharedToId',
    });
  }
  const sharedToFilter = sharedToInputs[0];

  // Apply the optional row filter (sharedTo target / nameContains). When
  // present, it narrows BOTH the returned rows AND the summary — the whole point
  // of "which views are shared to X". When absent, `scopedRows === allRows`, so
  // an unfiltered call is behaviourally unchanged (the summary stays
  // whole-object and the response is byte-identical to pre-filter). A filter
  // that matches nothing yields zero rows — never a silent full-object dump.
  const filtered = sharedToFilter !== undefined || input.nameContains !== undefined;
  const scopedRows = filtered
    ? allRows.filter((row) => rowMatchesFilter(row, sharedToFilter, input.nameContains))
    : allRows;

  const summary = buildSummary(scopedRows, input.sharedWithRoleApiName);
  const appliedScope: ListViewSharingOutput['appliedScope'] = {
    object: isObject ? componentId : null,
    sharedToId: sharedToFilter ?? null,
    nameContains: input.nameContains ?? null,
    filtered,
    totalBeforeFilter: allRows.length,
    matched: scopedRows.length,
  };

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers `componentId` + the filter args so a token minted for
  // one object/view/filter can't be replayed against another (a differently
  // filtered set would otherwise skip or duplicate rows on resume). The output
  // sort key (componentId) is the unique node id and matches the SQL id-ASC
  // order, so the order is a strict total order — a resume neither dups nor skips.
  const fingerprint = argsFingerprint({
    componentId,
    ...(sharedToFilter !== undefined ? { sharedToId: sharedToFilter } : {}),
    ...(input.nameContains !== undefined ? { nameContains: input.nameContains } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: LIST_VIEW_SHARING_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(scopedRows, {
    offset,
    limit,
    keyOf: (row) => row.componentId,
    binding: {
      tool: LIST_VIEW_SHARING_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const page = paged.items;
  const hasMore = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  // When a filter is applied, `listViews[]` and `summary` reflect ONLY the
  // matching set — override the "summary covers all list views" clause of the
  // base note so the honesty axis stays accurate.
  const filterNote = filtered
    ? ` FILTER APPLIED (see \`appliedScope\`): \`listViews[]\` and \`summary\` reflect ONLY the ${scopedRows.length} of ${allRows.length} list view(s) matching${sharedToFilter !== undefined ? ` sharedTo '${sharedToFilter}'` : ''}${input.nameContains !== undefined ? ` nameContains '${input.nameContains}'` : ''} — NOT the whole object. ${scopedRows.length === 0 ? 'Zero matches (the requested target shares none of this object’s list views) — this is an honest empty result, not a full-object dump.' : ''}`
    : '';
  const boundaryNote = scanTruncated
    ? `${BOUNDARY_NOTE}${filterNote} ${scanTruncationNote(['ListView'], SCAN_MAX)}`
    : `${BOUNDARY_NOTE}${filterNote}`;

  return ok({
    data: {
      componentId,
      scope,
      listViews: page,
      summary,
      appliedScope,
      limit,
      offset,
      hasMore,
      truncated: hasMore || offset > 0,
      ...(scanTruncated ? { scanTruncated: true } : {}),
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
