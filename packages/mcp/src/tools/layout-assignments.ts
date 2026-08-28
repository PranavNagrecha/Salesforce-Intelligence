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
 * Input: `{ componentId, limit?, offset? }` where `componentId` is EITHER a
 * `Layout:{Object}.{LayoutName}` id (LAYOUT mode — assignments for that one
 * layout) OR a `CustomObject:{Object}` id (OBJECT mode — assignments across
 * EVERY layout of the object, the same id `sfi.lightning_pages` accepts). A
 * `CustomObject:` id is NO LONGER mangled into `Layout:CustomObject:X`
 * (LAYOUT-ASSIGNMENTS-MANGLES-CUSTOMOBJECT-ID).
 * Output: the profiles + record types that assign the layout(s). `declared`
 * confidence — layout assignments are declared Profile metadata. A widely
 * shared standard-object layout is assigned by every profile × record type
 * (hundreds of rows past the MCP response limit), so the inline list PAGES
 * (`limit`/`offset`/`hasMore`/`truncated`) while `summary` stays complete. In
 * OBJECT mode each row carries its own `layoutId` and `summary.layouts` counts
 * the distinct layouts.
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

import { familyWasExtracted, notExtractedFamilyDisclosure } from './absence-disclosure.js';
import { mergeInputAliases, resolveObjectAlias, toLayoutId } from './input-aliases.js';
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
 * Canonical id prefix for the object-mode lookup. Accepting `CustomObject:X`
 * (the SAME id `sfi.lightning_pages` / `sfi.list_view_sharing` accept for
 * object mode) lists assignments across every layout of the object, rather
 * than mangling the id into a bogus `Layout:CustomObject:X`
 * (LAYOUT-ASSIGNMENTS-MANGLES-CUSTOMOBJECT-ID).
 */
const OBJECT_PREFIX = 'CustomObject:';

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

const layoutAssignmentsInputBaseSchema = z
  .object({
    // LAYOUT mode: a `Layout:` id (or a bare name coerced to one) / `layoutId`
    // alias. OBJECT mode: a `CustomObject:` id, or any of the object aliases
    // below (L2 Alias OS). At least one identifier is required.
    componentId: z.string().min(1).optional(),
    object: z.string().min(1).optional(),
    objectApiName: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
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
        'name the layout or object — pass a `componentId` (`Layout:` for one layout, `CustomObject:` for the object) or an object alias (`objectApiName` / `object` / `objectId`)',
      path: ['componentId'],
    },
  );

/** Zod schema for the `sfi.layout_assignments` tool input. */
export const layoutAssignmentsInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    { canonical: 'componentId', aliases: ['layoutId'] },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.componentId === 'string' ? o.componentId : '';
    // A bare name → `Layout:` id, but a `CustomObject:` id is left intact for
    // object mode — mangling it to `Layout:CustomObject:X` was the bug
    // (LAYOUT-ASSIGNMENTS-MANGLES-CUSTOMOBJECT-ID). Object aliases are resolved
    // in the handler (L2), not coerced here, so a bare `object` never becomes a
    // `Layout:` id.
    if (id.length > 0 && !id.startsWith(LAYOUT_PREFIX) && !id.startsWith(OBJECT_PREFIX)) {
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
  /**
   * Which layout this assignment targets. Present in OBJECT mode (rows span
   * every layout of the object); omitted in LAYOUT mode, where every row
   * targets the single top-level `layoutId`.
   */
  readonly layoutId?: ComponentId;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface LayoutAssignmentsOutput {
  /**
   * `layout` when the caller passed a `Layout:` id (assignments for ONE
   * layout); `object` when they passed a `CustomObject:` id (assignments for
   * every layout of the object — LAYOUT-ASSIGNMENTS-MANGLES-CUSTOMOBJECT-ID).
   */
  readonly mode: 'layout' | 'object';
  /**
   * Echoes the id ACTUALLY resolved so a host never assumes an alias it passed
   * (`objectApiName` / `object` / `objectId`) was silently stripped — the
   * `componentId: Required` bug this closes. `componentId` is the `Layout:` id
   * (layout mode) or `CustomObject:` id (object mode); `object` is the object
   * the layout(s) belong to.
   */
  readonly appliedScope: {
    readonly componentId: string;
    readonly object: string;
  };
  /** The specific layout in LAYOUT mode; `null` in OBJECT mode. */
  readonly layoutId: ComponentId | null;
  readonly object: string;
  /** OBJECT mode only: the distinct layouts of the object that carry assignments (sorted). */
  readonly layouts?: readonly ComponentId[];
  readonly assignments: readonly LayoutAssignmentRef[];
  readonly summary: {
    /** Distinct profiles that assign this layout (COMPLETE, not paginated). */
    readonly profiles: number;
    /** Total (profile × record type) assignments (COMPLETE, not paginated). */
    readonly assignments: number;
    /** OBJECT mode only: distinct layouts of the object that carry assignments. */
    readonly layouts?: number;
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
 * types that assign a page Layout (LAYOUT mode) or every layout of an object
 * (OBJECT mode, via a `CustomObject:` id).
 *
 * @example
 *   // LAYOUT mode — assignments for one layout.
 *   await layoutAssignmentsHandler(ctx, {
 *     componentId: 'Layout:Account.Account Layout',
 *   });
 *   // OBJECT mode — assignments across every layout of the object.
 *   await layoutAssignmentsHandler(ctx, { componentId: 'CustomObject:Account' });
 */
export const layoutAssignmentsHandler = async (
  ctx: Context,
  input: LayoutAssignmentsInput,
): Promise<Result<McpResponse<LayoutAssignmentsOutput>, McpError>> => {
  // L2 Alias OS: resolve an OBJECT scope from object / objectApiName / objectId
  // or a CustomObject: componentId (a reverse-mode Layout: componentId is NOT
  // an object alias). Disagreeing object aliases -> invalid-query.
  const objScope = resolveObjectAlias(input, {
    bareComponentIdIsObject: false,
    required: false,
  });
  if (!objScope.ok) return err(objScope.error);
  const rawComponentId = input.componentId;
  let componentId: string;
  if (objScope.value !== null) {
    // OBJECT mode. A Layout: componentId alongside an object is ambiguous.
    if (rawComponentId !== undefined && rawComponentId.startsWith(LAYOUT_PREFIX)) {
      return err({
        kind: 'invalid-query',
        message:
          'pass either a Layout: componentId (layout mode) or an object (object mode), not both',
        path: 'componentId',
      });
    }
    componentId = objScope.value.componentId;
  } else if (rawComponentId !== undefined) {
    componentId = rawComponentId;
  } else {
    return err({
      kind: 'invalid-query',
      message:
        'name the layout or object — pass a `componentId` (Layout: or CustomObject:) or an object alias (objectApiName / object / objectId)',
      path: 'componentId',
    });
  }
  const isObjectMode = componentId.startsWith(OBJECT_PREFIX);
  const isLayoutMode = componentId.startsWith(LAYOUT_PREFIX);
  if (!isObjectMode && !isLayoutMode) {
    return err({
      kind: 'invalid-query',
      message:
        `componentId must be a Layout: id (e.g. 'Layout:Account.Account Layout') ` +
        `or a CustomObject: id for object mode (e.g. 'CustomObject:Account'); got '${componentId}'`,
      path: 'componentId',
    });
  }
  const targetId = componentId as ComponentId;

  // Resolve the target node so a typo is a clear `component-not-found` rather
  // than a confident "no profile assigns this layout / object".
  const targetNode = await getNodeById(ctx.graph, targetId);
  if (!targetNode.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${targetNode.error.message}` });
  }
  if (targetNode.value === null) {
    return err({
      kind: 'component-not-found',
      message: isObjectMode
        ? `no CustomObject matches \`${targetId}\` in this vault`
        : `no Layout matches \`${targetId}\` in this vault`,
      path: targetId,
    });
  }

  // LAYOUT mode narrows to the one layout; OBJECT mode keeps every layout the
  // object owns. `layoutId` is the single layout (layout mode) or null.
  const layoutId: ComponentId | null = isLayoutMode ? targetId : null;
  const object = isObjectMode
    ? targetId.slice(OBJECT_PREFIX.length)
    : (() => {
        // The object api name is the segment between `Layout:` and the first dot.
        const afterPrefix = targetId.slice(LAYOUT_PREFIX.length);
        const dot = afterPrefix.indexOf('.');
        return dot > 0 ? afterPrefix.slice(0, dot) : afterPrefix;
      })();

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
  const distinctLayouts = new Set<string>();
  // R1: per-CONTAINER absence, not an ANY across every profile. Keyed off
  // property PRESENCE (`familyWasExtracted`, hasOwnProperty) rather than
  // `readLayoutAssignments`'s array-shape check, so a profile that was
  // CHECKED and stored a non-array "none" value (e.g. `null`) is never
  // misread as never-extracted. On a mixed-era vault (an incremental refresh
  // that only re-extracted a subset of profiles) an ANY silently suppressed
  // the disclosure the moment ONE profile carried the property, so the
  // non-carrying profiles' assignments were counted as zero with no caveat.
  const notExtractedProfileIds: string[] = [];

  for (const profile of scan.value.nodes) {
    if (!familyWasExtracted(profile.properties, 'layoutAssignments')) {
      notExtractedProfileIds.push(profile.id);
      continue;
    }
    const entries = readLayoutAssignments(profile);
    if (entries === null) continue; // property present but not the recognised shape
    for (const entry of entries) {
      if (!layoutTargetsObject(entry.layout, object)) continue;
      const canonical = canonicaliseLayoutId(entry.layout, object);
      // LAYOUT mode: only the one layout. OBJECT mode: every layout of the object.
      if (isLayoutMode && canonical !== layoutId) continue;
      const recordType = entry.recordType ?? null;
      assignments.push({
        profileId: profile.id as ComponentId,
        profileLabel: profile.label ?? profile.apiName,
        recordType,
        recordTypeId: recordType !== null ? (`RecordType:${recordType}` as ComponentId) : null,
        // Tag the targeted layout only in object mode (redundant in layout mode,
        // where it equals the top-level `layoutId` — kept byte-identical there).
        ...(isObjectMode ? { layoutId: canonical } : {}),
      });
      distinctProfiles.add(profile.id);
      distinctLayouts.add(canonical);
    }
  }

  // CR-22: total-order tiebreak. In OBJECT mode the layout is the leading key
  // (rows span multiple layouts); then profileId, recordType, and the raw
  // record-type id make the order a STRICT TOTAL order so an offset/cursor
  // resume cannot dup or skip at a tie. In LAYOUT mode every row shares the one
  // layout, so the leading key is inert and the order is byte-identical.
  assignments.sort((a, b) => {
    const la = a.layoutId ?? '';
    const lb = b.layoutId ?? '';
    if (la !== lb) return la < lb ? -1 : 1;
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
  // The fingerprint covers the narrowing arg `componentId` (the layout OR object
  // id) so a token minted for one target can't be replayed against another. In
  // layout mode `targetId === layoutId`, so this stays byte-identical.
  const fingerprint = argsFingerprint({ componentId: targetId });
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
    // OBJECT mode prepends the layout (rows span layouts); LAYOUT mode keeps the
    // exact pre-existing key (`layoutId` is undefined there) so it stays byte-identical.
    keyOf: (a) =>
      isObjectMode
        ? `${a.layoutId ?? ''}|${a.profileId}|${a.recordType ?? ''}|${a.recordTypeId ?? ''}`
        : `${a.profileId}|${a.recordType ?? ''}|${a.recordTypeId ?? ''}`,
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
  // OBJECT mode lists assignments across EVERY layout of the object; disclose it.
  const objectModeNote = isObjectMode
    ? `Object mode: assignments across all ${distinctLayouts.size} layout(s) of \`${object}\` (each row carries its \`layoutId\`). `
    : '';
  const boundaryNote =
    notExtractedProfileIds.length === 0
      ? `${objectModeNote}${SCOPE_NOTE}${pageNote}${scanNote}`
      : `${objectModeNote}${notExtractedFamilyDisclosure({
          subject: 'Layout assignments',
          verb: 'checked',
          pluralSubject: true,
          sentinelProperty: 'layoutAssignments',
          containers: [...notExtractedProfileIds].sort(),
          surface: '`assignments` / `summary.assignments`',
          zeroReading: '"no assignments"',
        })} ${SCOPE_NOTE}${pageNote}${scanNote}`;

  return ok({
    data: {
      mode: isObjectMode ? 'object' : 'layout',
      // Echo the scope ACTUALLY resolved so a host never assumes an alias it
      // passed (`objectApiName` / `object` / `objectId`) was honored. In layout
      // mode `componentId` is the `Layout:` id; `object` is the object the
      // layout belongs to.
      appliedScope: { componentId: targetId, object },
      layoutId,
      object,
      ...(isObjectMode ? { layouts: [...distinctLayouts].sort() as ComponentId[] } : {}),
      assignments: page,
      summary: {
        profiles: distinctProfiles.size,
        assignments: totalAssignments,
        ...(isObjectMode ? { layouts: distinctLayouts.size } : {}),
      },
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
