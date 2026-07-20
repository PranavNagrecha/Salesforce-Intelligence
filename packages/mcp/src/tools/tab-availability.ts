/**
 * Handler for the `sfi.tab_availability` MCP tool (P11-UI-tab-availability).
 *
 * "What tabs can this profile / permission set see?" — reads the
 * `tabVisibilities` the extractor now emits (P11-UI-app-tab-visibility-extract)
 * and reports each tab's visibility enum (`DefaultOn` / `DefaultOff` /
 * `Hidden` on a profile; `Available` / `Visible` / `None` on a permission set),
 * with an `available` flag normalising "the user can reach this tab".
 *
 * Input: `{ componentId: 'Profile:X' | 'PermissionSet:X', limit?, offset? }` —
 * or the natural `profileApiName` / `permissionSetApiName` selector (a bare name
 * is coerced to the container prefix). Pass an optional `objectApiName` /
 * `object` / `objectId` to narrow to that object's tab (matched by
 * tab-naming convention), echoed in `appliedScope`.
 * `declared` confidence — tab visibility is declared profile metadata.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  mergeInputAliases,
  resolveObjectAlias,
  toProfileOrPermSetId,
} from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const GRANTER_PREFIXES = ['Profile:', 'PermissionSet:'] as const;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** Visibility enum values that mean "the user can reach the tab". */
const AVAILABLE_VISIBILITIES = new Set(['DefaultOn', 'DefaultOff', 'Visible', 'Available']);

const tabAvailabilityInputBaseSchema = z.object({
  componentId: z.string().min(1),
  // TAB-AVAILABILITY-REJECTS-PROFILEAPINAME: optional OBJECT scope — "is {object}'s
  // tab available to {profile}?". The handler narrows the tab list to the object's
  // tab (by Salesforce tab-naming convention) and echoes `appliedScope`.
  object: z.string().min(1).optional(),
  objectApiName: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0 / explicit `offset`).
  cursor: z.string().min(1).optional(),
});

export const tabAvailabilityInputSchema = z.preprocess((raw) => {
  // TAB-AVAILABILITY-REJECTS-PROFILEAPINAME: accept the natural `profileApiName`
  // / `permissionSetApiName` selectors alongside the prior `profileId` /
  // `permissionSetId` aliases — the container is the visibility SUBJECT, resolved
  // to its `Profile:` / `PermissionSet:` prefix (canonical `componentId` wins).
  const merged = mergeInputAliases(raw, [
    {
      canonical: 'componentId',
      aliases: ['profileId', 'profileApiName', 'permissionSetId', 'permissionSetApiName'],
    },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.componentId === 'string' ? o.componentId : '';
    // TAB-AVAILABILITY-PREFIXES-NON-PROFILE-AS-PROFILE: only coerce a BARE
    // granter name (no `Type:` prefix — Salesforce API names never contain a
    // colon) up to a canonical Profile/PermissionSet id. An id that already
    // carries a component-type prefix (`CustomTab:standard-Case`,
    // `CustomObject:…`, and even the already-canonical `Profile:`/
    // `PermissionSet:` forms) contains a `:`, so it is LEFT UNTOUCHED — a
    // non-granter id then falls through to the handler's Profile/PermissionSet
    // prefix check and is rejected with `invalid-query`, instead of being
    // silently rewritten to `Profile:CustomTab:standard-Case` and 404-ing as a
    // phantom Profile. Mirrors `app_access`'s prefix validation.
    if (id.length > 0 && !id.includes(':')) {
      const rawObj = raw as Record<string, unknown>;
      const fromPs =
        typeof rawObj.permissionSetId === 'string' ||
        typeof rawObj.permissionSetApiName === 'string';
      o.componentId = fromPs ? `PermissionSet:${id}` : toProfileOrPermSetId(id);
    }
  }
  return merged;
}, tabAvailabilityInputBaseSchema);

export type TabAvailabilityInput = z.infer<typeof tabAvailabilityInputSchema>;

/** One tab's visibility for the granter. */
export interface TabVisibilityRow {
  readonly tab: string;
  /** The verbatim Salesforce visibility enum. */
  readonly visibility: string;
  /** True when the visibility enum makes the tab reachable. */
  readonly available: boolean;
}

export interface TabAvailabilityOutput {
  readonly componentId: string;
  readonly granterType: 'Profile' | 'PermissionSet';
  readonly granterLabel: string;
  /**
   * Echoes the OBJECT scope ACTUALLY applied. Present ONLY when the caller
   * passed an `object` / `objectApiName` / `objectId` selector — a bare
   * profile/permission-set call omits it so the response stays byte-identical.
   * When present, `tabs` and `summary` are narrowed to the object's tab (matched
   * by Salesforce tab-naming convention); an object with no matching tab is an
   * honest empty, never the full-profile tab dump.
   */
  readonly appliedScope?: {
    readonly componentId: string;
    readonly object: string;
  };
  readonly tabs: readonly TabVisibilityRow[];
  readonly summary: {
    readonly total: number;
    readonly available: number;
    readonly hidden: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token, present ONLY when this page was truncated
   * (more tabs remain past `limit`). Echo it back as `cursor` to resume. Absent
   * on a whole-fits page so an in-budget response stays byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  readonly confidence: 'declared';
  readonly boundaryNote: string;
}

interface RawTabVis {
  readonly tab?: unknown;
  readonly visibility?: unknown;
}

export const tabAvailabilityHandler = async (
  ctx: Context,
  input: TabAvailabilityInput,
): Promise<Result<McpResponse<TabAvailabilityOutput>, McpError>> => {
  if (!GRANTER_PREFIXES.some((p) => input.componentId.startsWith(p))) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a Profile: or PermissionSet: id; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const componentId = input.componentId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, componentId);
  if (!nodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
  }
  const node: Node | null = nodeResult.value;
  if (node === null) {
    return err({
      kind: 'component-not-found',
      message: `no Profile/PermissionSet matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }

  const raw = node.properties['tabVisibilities'];
  const extracted = Array.isArray(raw);
  const rows: TabVisibilityRow[] = [];
  if (extracted) {
    for (const item of raw as RawTabVis[]) {
      if (typeof item.tab !== 'string') continue;
      const visibility = typeof item.visibility === 'string' ? item.visibility : 'unknown';
      rows.push({ tab: item.tab, visibility, available: AVAILABLE_VISIBILITIES.has(visibility) });
    }
  }
  // TOTAL-ORDER sort: `tab` ASC then `visibility` ASC. `tab` alone is NOT a
  // unique key — the extractors emit `tabVisibilities` verbatim (no dedup), and
  // a PermissionSet whose source carries the same tab under both `tabSettings`
  // and `tabVisibilities` (or a duplicated `<tabVisibilities>`) yields two rows
  // with the same `tab` but a different `visibility`. Appending `visibility`
  // (the only other discriminating field — `available` is derived from it)
  // makes `(tab, visibility)` the row's full stable identity, so a CR-22
  // resume cannot dup or skip on a page boundary.
  rows.sort((a, b) =>
    a.tab < b.tab
      ? -1
      : a.tab > b.tab
        ? 1
        : a.visibility < b.visibility
          ? -1
          : a.visibility > b.visibility
            ? 1
            : 0,
  );

  // TAB-AVAILABILITY-REJECTS-PROFILEAPINAME: optional OBJECT scope. Salesforce
  // names an object's tab after the object api name (custom objects) or
  // `standard-<Object>` (standard objects), so narrow the tab list to those two
  // forms (case-insensitive). `bareComponentIdIsObject:false` keeps the profile
  // `componentId` from ever being read as the object. No matching tab → honest
  // empty, never the full-profile tab dump.
  const objScope = resolveObjectAlias(input, {
    required: false,
    bareComponentIdIsObject: false,
  });
  if (!objScope.ok) return err(objScope.error);
  const scopedObject = objScope.value;
  const scopedRows =
    scopedObject === null
      ? rows
      : rows.filter((r) => {
          const t = r.tab.toLowerCase();
          const o = scopedObject.object.toLowerCase();
          return t === o || t === `standard-${o}`;
        });

  const available = scopedRows.filter((r) => r.available).length;
  const total = scopedRows.length;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22: resolve the resume offset — an echoed cursor wins over an explicit
  // `offset`; a stale/forged cursor (changed componentId, different tool, or
  // refreshed vault) is rejected with `invalid-query`. The object scope is part
  // of the fingerprint so a scoped cursor cannot resume the unscoped list.
  const fingerprint = argsFingerprint({
    componentId: input.componentId,
    ...(scopedObject !== null ? { object: scopedObject.object } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.tab_availability',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // No per-handler byte budget (offset/limit only) — set an effectively
  // unbounded byteBudget so `paginate()` truncates ONLY on `limit`
  // (byte-identical to the prior open-coded slice). The global jsonResult guard
  // remains the byte backstop.
  const paged = paginateLegacy(scopedRows, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    binding: {
      tool: 'sfi.tab_availability',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
    keyOf: (r) => `${r.tab} ${r.visibility}`,
  });
  const page = paged.items;
  const hasMore = paged.hasMore;
  // Preserve the EXACT pre-CR-22 `truncated` expression (true on any non-first
  // page even when that page fully fits), independent of the new nextCursor.
  const truncated = hasMore || offset > 0;
  const emitCursor = paged.nextCursor !== null;

  const boundaryNote =
    (extracted
      ? 'Tab visibility is declared profile/permission-set metadata. A tab being "available" does not by itself grant object access — the user also needs the object permission (`object_access_audit`). The user must be ASSIGNED this profile/permission set (runtime, not modeled).'
      : 'This Profile/PermissionSet carries no extracted `tabVisibilities` property — re-run `/sfi-refresh`; the empty list is "not modeled", not a verified "no tabs".') +
    (scopedObject !== null
      ? ` Scoped to object \`${scopedObject.object}\`: matched by tab-naming convention (the object api name, or \`standard-<Object>\`); an empty result means no such tab is declared on this container, not that the object has no tab.`
      : '');

  return ok({
    data: {
      componentId,
      granterType: node.type === 'PermissionSet' ? 'PermissionSet' : 'Profile',
      granterLabel: node.label ?? node.apiName,
      ...(scopedObject !== null
        ? { appliedScope: { componentId, object: scopedObject.object } }
        : {}),
      tabs: page,
      summary: { total, available, hidden: total - available },
      limit,
      offset,
      hasMore,
      truncated,
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
