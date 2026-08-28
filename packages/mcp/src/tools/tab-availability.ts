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

import { familyWasExtracted, notExtractedFamilyDisclosure } from './absence-disclosure.js';
import { resolveContainerAlias, resolveObjectAlias } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const GRANTER_PREFIXES = ['Profile:', 'PermissionSet:'] as const;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** Visibility enum values that mean "the user can reach the tab". */
const AVAILABLE_VISIBILITIES = new Set(['DefaultOn', 'DefaultOff', 'Visible', 'Available']);

const tabAvailabilityInputBaseSchema = z.object({
  // OPTIONAL at the schema level — the natural container selectors below are
  // reconciled by `resolveContainerAlias` in the HANDLER, which refuses a call
  // naming no container with a NAMED `invalid-query` rather than a bare Zod
  // "componentId: Required".
  componentId: z.string().min(1).optional(),
  // DECLARED so `z.object` does not strip them before the handler sees them.
  // Coercion is per key BY THE KEY'S OWN NAME.
  profileId: z.string().min(1).optional(),
  profileApiName: z.string().min(1).optional(),
  profileName: z.string().min(1).optional(),
  permissionSetId: z.string().min(1).optional(),
  permissionSetApiName: z.string().min(1).optional(),
  permissionSetName: z.string().min(1).optional(),
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

/**
 * The container selectors are reconciled in the HANDLER by
 * `resolveContainerAlias`, not in a `z.preprocess` step.
 *
 * The preprocess this replaces carried the same defect `user_ability` did: it
 * took the VALUE from one key and the PREFIX from the mere PRESENCE of another,
 * so `{ profileApiName: 'X', permissionSetApiName: 'Y' }` answered about
 * `PermissionSet:X`, a third component neither selector named. Preprocess
 * cannot emit a named `invalid-query`, so the refusal belongs in the handler.
 */
export const tabAvailabilityInputSchema = tabAvailabilityInputBaseSchema;

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
  readonly appliedScope: {
    /**
     * The container the answer is ACTUALLY about, always present — a caller who
     * passed a bare `profileApiName` deserves to see which canonical id it
     * became.
     */
    readonly container: string;
    /** Historical alias for `container`; emitted on the object-scoped path. */
    readonly componentId?: string;
    readonly object?: string;
  };
  readonly tabs: readonly TabVisibilityRow[];
  /**
   * `null` in every field when `tabVisibilities` was never extracted for this
   * container ({@link familyWasExtracted} false) — a TYPED absence, distinct
   * from `0` (checked, this container/scope declares no tabs). Collapsing
   * the two to `0` is exactly the bug this shape exists to prevent: a
   * consumer reading the structured summary (rather than prose in
   * `boundaryNote`) could not otherwise tell "never checked" from "checked,
   * holds none". Mirrors `user_ability`'s `summary.customPermissions: null`.
   */
  readonly summary: {
    readonly total: number | null;
    readonly available: number | null;
    readonly hidden: number | null;
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
  // The ONE shared container normalizer — same refusal grammar as
  // `user_ability` and `profile_security`. No container named → NAMED
  // `invalid-query`; selectors naming DIFFERENT containers → refused naming
  // both, never a silent pick; a wrong `Type:` prefix passes through unchanged
  // so the check below produces its precise message.
  const containerResult = resolveContainerAlias(input);
  if (!containerResult.ok) return err(containerResult.error);
  const container = containerResult.value as { componentId: string };
  if (!GRANTER_PREFIXES.some((p) => container.componentId.startsWith(p))) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a Profile: or PermissionSet: id; got '${container.componentId}'`,
      path: 'componentId',
    });
  }
  const componentId = container.componentId as ComponentId;

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
  // TYPED ABSENCE: whether the family was extracted is decided by the
  // SENTINEL PROPERTY (`familyWasExtracted`, a `hasOwnProperty` check), never
  // by `Array.isArray` on its value. The extractor always writes
  // `tabVisibilities` as an array (`[]` when the source declares none), so
  // `Array.isArray` and `hasOwnProperty` agree on every real vault — but a
  // property that IS present and non-array (a malformed/foreign write) must
  // still read as CHECKED, not as "never extracted"; collapsing that case
  // into not-extracted is what sent a checked container to "re-run
  // /sfi-refresh" for metadata that was, in fact, modeled.
  const extracted = familyWasExtracted(node.properties, 'tabVisibilities');
  const rawList = Array.isArray(raw) ? (raw as RawTabVis[]) : [];
  const rows: TabVisibilityRow[] = [];
  if (extracted) {
    for (const item of rawList) {
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
    componentId,
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
      : notExtractedFamilyDisclosure({
          subject: 'Tab visibility',
          verb: 'checked',
          sentinelProperty: 'tabVisibilities',
          containers: [componentId],
          surface: '`tabs` / `summary`',
          zeroReading: '"no tabs"',
        })) +
    (scopedObject !== null
      ? ` Scoped to object \`${scopedObject.object}\`: matched by tab-naming convention (the object api name, or \`standard-<Object>\`); an empty result means no such tab is declared on this container, not that the object has no tab.`
      : '');

  return ok({
    data: {
      componentId,
      granterType: node.type === 'PermissionSet' ? 'PermissionSet' : 'Profile',
      granterLabel: node.label ?? node.apiName,
      appliedScope: {
        container: componentId,
        ...(scopedObject !== null ? { componentId, object: scopedObject.object } : {}),
      },
      tabs: page,
      summary: extracted
        ? { total, available, hidden: total - available }
        : { total: null, available: null, hidden: null },
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
