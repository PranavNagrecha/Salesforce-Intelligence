/**
 * Handler for the `sfi.app_access` MCP tool (P11-UI-app-tool).
 *
 * "What is in this app, who can open it, and who defaults to it?" —
 * `CustomApplication` was extracted as a node but no tool was app-centric.
 * Given a CustomApplication this returns its navType + tabs (from the
 * `belongsToApp` edges, in document order) and the profiles / permission sets
 * that can OPEN it and that DEFAULT to it (from the `applicationVisibilities`
 * the profile/permset extractor now emits — P11-UI-app-tab-visibility-extract).
 *
 * Input: a `componentId` (`CustomApplication:` / `Profile:` / `PermissionSet:`)
 * OR a natural app-name selector — `apiName` / `app` / `application` (bare app
 * name) or a fuzzy `nameContains` — resolved to the app in the handler
 * (APP-ACCESS-REJECTS-NATURAL-ARGS); the canonical `CustomApplication:` path is
 * byte-identical, the alias/search path echoes `appliedScope`. Plus `limit?` /
 * `offset?`. `declared` confidence — app metadata + applicationVisibilities are
 * declared.
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

import { firstNonEmpty, toCustomApplicationId } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

const APP_PREFIX = 'CustomApplication:';
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 250;
const APP_ACCESS_TOOL = 'sfi.app_access';

export const appAccessInputSchema = z.object({
  /**
   * Canonical selector: a `CustomApplication:` / `Profile:` / `PermissionSet:`
   * id (or a bare app api name). Optional at the schema layer so the natural
   * app-name aliases below satisfy the router/host shape ("who can use the
   * Sales app?") instead of hard-failing `componentId: Required`
   * (APP-ACCESS-REJECTS-NATURAL-ARGS); the handler still REQUIRES a resolvable
   * selector and refuses with a named `invalid-query` when none is given.
   */
  componentId: z.string().min(1).optional(),
  /** Natural app-name aliases → a `CustomApplication:` id (see {@link resolveAppSelector}). */
  apiName: z.string().min(1).optional(),
  appApiName: z.string().min(1).optional(),
  app: z.string().min(1).optional(),
  application: z.string().min(1).optional(),
  /** Fuzzy app label / api-name substring, resolved by the handler's label search. */
  nameContains: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor from a prior truncated page's nextCursor.
  cursor: z.string().min(1).optional(),
});

export type AppAccessInput = z.infer<typeof appAccessInputSchema>;

/**
 * How a natural selector resolved to the app `componentId` (APP-ACCESS-REJECTS-
 * NATURAL-ARGS) — echoed as `appliedScope` on the alias/search path only, so a
 * canonical `CustomApplication:`/`Profile:`/`PermissionSet:` `componentId` call
 * stays byte-identical.
 */
export interface AppAccessAppliedScope {
  readonly componentId: string;
  /** Which input the app was resolved from. */
  readonly resolvedFrom: 'apiName' | 'nameContains';
  /** The matched app label (or api name), for the host to confirm. */
  readonly matched: string;
}

/** One profile/permission set that grants access to the app. */
export interface AppGranter {
  readonly granterId: string;
  readonly granterType: 'Profile' | 'PermissionSet';
  readonly granterLabel: string;
  /** True when this app is the granter's DEFAULT app. */
  readonly default: boolean;
}

export interface AppAccessOutput {
  readonly componentId: string;
  readonly label: string;
  readonly navType: string;
  /** The app's tabs (`CustomTab:` ids), in document order. */
  readonly tabs: readonly string[];
  /** Profiles/permission sets that can open the app (paginated). */
  readonly canOpen: readonly AppGranter[];
  /** The granters for which this is the default app (complete). */
  readonly defaultedBy: readonly string[];
  readonly summary: {
    readonly tabs: number;
    readonly canOpen: number;
    readonly defaultedBy: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /**
   * True only for a PATHOLOGICAL residual cap (a grantor scan past
   * FULL_SCAN_MAX_NODES). The normal full multi-window scan reaches every
   * Profile / PermissionSet (including 501+) and completes, so this is false
   * for any real org.
   */
  readonly scanTruncated: boolean;
  readonly confidence: 'declared';
  readonly boundaryNote: string;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more granters remain). Echo it back as `cursor` to resume. Absent on a
   * complete page so an in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  /**
   * How a NATURAL selector (`apiName` / `app` / `nameContains`) resolved to this
   * app (APP-ACCESS-REJECTS-NATURAL-ARGS). Present ONLY on the alias/search
   * path; absent for a canonical `CustomApplication:` `componentId` call so that
   * path is byte-identical.
   */
  readonly appliedScope?: AppAccessAppliedScope;
}

/**
 * INVERSE direction (P14-APP-default-reverse): given a Profile/PermissionSet
 * id, its own `applicationVisibilities` answer "which apps can this granter
 * open, and which is its default?" — a single node read, no roster scan.
 */
export interface AppAccessGranterOutput {
  readonly componentId: string;
  readonly granterType: 'Profile' | 'PermissionSet';
  readonly granterLabel: string;
  /** CustomApplication ids this granter can OPEN (visible: true), sorted. */
  readonly openableApps: readonly string[];
  /** The granter's DEFAULT app, or null when none is marked default. */
  readonly defaultApp: string | null;
  readonly summary: { readonly openableApps: number };
  readonly confidence: 'declared';
  readonly boundaryNote: string;
}

interface RawAppVis {
  readonly application?: unknown;
  readonly visible?: unknown;
  readonly default?: unknown;
}

/** Normalize an app name/label for case-/separator-insensitive matching. */
const normApp = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The resolved app selector: the id to dispatch on, plus how it was reached. */
interface ResolvedAppSelector {
  readonly componentId: string;
  /** Set ONLY on the alias/search path; drives the optional output `appliedScope`. */
  readonly appliedScope?: AppAccessAppliedScope;
}

/**
 * Resolve the app the caller named from the canonical `componentId` OR the
 * natural aliases (APP-ACCESS-REJECTS-NATURAL-ARGS). Precedence via
 * `firstNonEmpty`:
 *   1. An explicit `componentId` (`CustomApplication:`/`Profile:`/`PermissionSet:`)
 *      wins untouched → canonical path, no `appliedScope` (byte-identical).
 *   2. A bare `componentId` or `apiName`/`appApiName`/`app`/`application` name →
 *      an exact `CustomApplication:<name>` node when one exists, else a
 *      label/api-name search.
 *   3. `nameContains` → a label/api-name substring search.
 * A search yields exactly one → resolved; several → `invalid-query` pick list
 * (never a silent pick); none → `component-not-found`. No selector at all →
 * a named `invalid-query` (not a bare "componentId Required").
 */
const resolveAppSelector = async (
  ctx: Context,
  input: AppAccessInput,
): Promise<Result<ResolvedAppSelector, McpError>> => {
  const cid = firstNonEmpty(input.componentId);
  if (cid !== undefined) {
    // Canonical granter/app ids and other-prefix ids pass through untouched —
    // the handler's own branch validates/rejects them (byte-identical).
    if (
      cid.startsWith('CustomApplication:') ||
      cid.startsWith('Profile:') ||
      cid.startsWith('PermissionSet:') ||
      cid.includes(':')
    ) {
      return ok({ componentId: cid });
    }
    // A bare `componentId` (no prefix) is an app name — resolve like `apiName`.
    return resolveAppByName(ctx, cid, 'apiName');
  }
  const named = firstNonEmpty(input.apiName, input.appApiName, input.app, input.application);
  if (named !== undefined) return resolveAppByName(ctx, named, 'apiName');
  const contains = firstNonEmpty(input.nameContains);
  if (contains !== undefined) return resolveAppByName(ctx, contains, 'nameContains');
  return err({
    kind: 'invalid-query',
    message:
      'name the app — pass `componentId` (a `CustomApplication:`/`Profile:`/`PermissionSet:` id), an app `apiName` (e.g. "Sales"), or `nameContains`',
    path: 'componentId',
  });
};

/**
 * Resolve an app by name: an exact `CustomApplication:<name>` node when one
 * exists (apiName path only), else a normalized exact-then-substring search over
 * CustomApplication api names/labels. One match → resolved with `appliedScope`;
 * multiple → `invalid-query` naming the candidates (host disambiguates); none →
 * `component-not-found`.
 */
const resolveAppByName = async (
  ctx: Context,
  name: string,
  resolvedFrom: 'apiName' | 'nameContains',
): Promise<Result<ResolvedAppSelector, McpError>> => {
  // Exact-id fast path (apiName only): a `CustomApplication:<name>` that exists
  // is byte-identical to the explicit-id call save for `appliedScope`.
  if (resolvedFrom === 'apiName') {
    const exactId = toCustomApplicationId(name);
    const exact = await getNodeById(ctx.graph, exactId as ComponentId);
    if (!exact.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${exact.error.message}` });
    }
    if (exact.value !== null) {
      return ok({
        componentId: exactId,
        appliedScope: { componentId: exactId, resolvedFrom, matched: exact.value.label ?? name },
      });
    }
  }
  const scan = await scanAllNodesOfTypes(ctx.graph, ['CustomApplication']);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }
  const target = normApp(name);
  const withMatch = scan.value.nodes.map((n) => ({ n, label: n.label ?? n.apiName }));
  const exactHits = withMatch.filter(
    ({ n, label }) => normApp(n.apiName) === target || normApp(label) === target,
  );
  const hits = exactHits.length > 0
    ? exactHits
    : withMatch.filter(
        ({ n, label }) => normApp(n.apiName).includes(target) || normApp(label).includes(target),
      );
  if (hits.length === 0) {
    return err({
      kind: 'component-not-found',
      message: `no CustomApplication matches '${name}' in this vault (searched app api names and labels)`,
      path: 'componentId',
    });
  }
  if (hits.length > 1) {
    const shown = hits
      .slice(0, 8)
      .map(({ n, label }) => `${n.id} (${label})`)
      .join(', ');
    return err({
      kind: 'invalid-query',
      message:
        `'${name}' matches ${hits.length} apps — pass one \`componentId\`: ${shown}` +
        (hits.length > 8 ? ', …' : ''),
      path: 'componentId',
    });
  }
  const only = hits[0]!;
  return ok({
    componentId: only.n.id,
    appliedScope: { componentId: only.n.id, resolvedFrom, matched: only.label },
  });
};

export const appAccessHandler = async (
  ctx: Context,
  input: AppAccessInput,
): Promise<Result<McpResponse<AppAccessOutput | AppAccessGranterOutput>, McpError>> => {
  const selector = await resolveAppSelector(ctx, input);
  if (!selector.ok) return err(selector.error);
  const componentIdInput = selector.value.componentId;
  const appliedScope = selector.value.appliedScope;

  // INVERSE direction (P14-APP-default-reverse): a Profile/PermissionSet id
  // answers from the granter's OWN applicationVisibilities — one node read.
  if (componentIdInput.startsWith('Profile:') || componentIdInput.startsWith('PermissionSet:')) {
    return appAccessForGranter(ctx, componentIdInput as ComponentId);
  }
  if (componentIdInput.startsWith('PermissionSetGroup:')) {
    return err({
      kind: 'invalid-query',
      message:
        'PermissionSetGroup app visibility is the UNION of its member permission sets and is not directly extracted — list the members (get_component on the group) and ask app_access for each PermissionSet instead.',
      path: 'componentId',
    });
  }
  if (!componentIdInput.startsWith(APP_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a CustomApplication:, Profile:, or PermissionSet: id; got '${componentIdInput}'`,
      path: 'componentId',
    });
  }
  const componentId = componentIdInput as ComponentId;
  const appApiName = componentId.slice(APP_PREFIX.length);

  const appResult = await getNodeById(ctx.graph, componentId);
  if (!appResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${appResult.error.message}` });
  }
  if (appResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no CustomApplication matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }
  const app = appResult.value;
  const navType = typeof app.properties['navType'] === 'string' ? (app.properties['navType'] as string) : 'unknown';

  // Tabs: incoming `belongsToApp` edges (CustomTab → app), ordered by ordinal.
  const tabEdges = await listEdges(ctx.graph, componentId, { direction: 'in', edgeType: 'belongsToApp' });
  if (!tabEdges.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${tabEdges.error.message}` });
  }
  const tabs = [...tabEdges.value]
    .sort((a, b) => {
      const oa = typeof a.properties['ordinal'] === 'number' ? (a.properties['ordinal'] as number) : 0;
      const ob = typeof b.properties['ordinal'] === 'number' ? (b.properties['ordinal'] as number) : 0;
      return oa - ob;
    })
    .map((e) => e.fromId);

  // Who can open / defaults: CR-22 B3 full multi-window scan over Profiles +
  // PermissionSets so a grantor on node 501+ is reachable (the single capped
  // page used to drop the scan TAIL). The derived `canOpen` list is COMPLETE
  // and paged on the output axis below; the scan completes inside this call.
  const canOpen: AppGranter[] = [];
  const defaultedBy: string[] = [];
  let anyGranterHadAppVis = false;
  const scan = await scanAllNodesOfTypes(ctx.graph, ['Profile', 'PermissionSet']);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }
  for (const node of scan.value.nodes) {
    const raw = node.properties['applicationVisibilities'];
    if (!Array.isArray(raw)) continue;
    anyGranterHadAppVis = true;
    const granterType = node.id.startsWith('Profile:') ? 'Profile' : 'PermissionSet';
    for (const item of raw as RawAppVis[]) {
      if (item.application !== appApiName) continue;
      if (item.visible !== true) continue;
      const isDefault = item.default === true;
      canOpen.push({
        granterId: node.id,
        granterType,
        granterLabel: node.label ?? node.apiName,
        default: isDefault,
      });
      if (isDefault) defaultedBy.push(node.id);
    }
  }
  // CR-22: total-order tiebreak. granterId is the node id (unique per node), but
  // a node could in theory list the app twice; granterType is the final
  // distinguishing key so the order is a strict total order (dup/skip-proof).
  canOpen.sort((a, b) => {
    if (a.granterId !== b.granterId) return a.granterId < b.granterId ? -1 : 1;
    return a.granterType < b.granterType ? -1 : a.granterType > b.granterType ? 1 : 0;
  });
  defaultedBy.sort();

  const total = canOpen.length;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers the narrowing arg `componentId` (the app) so a token
  // minted for one app can't be replayed against another.
  const fingerprint = argsFingerprint({ componentId });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: APP_ACCESS_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(canOpen, {
    offset,
    limit,
    keyOf: (g) => `${g.granterId}|${g.granterType}`,
    binding: {
      tool: APP_ACCESS_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const page = paged.items;
  const hasMore = paged.hasMore;
  const truncated = hasMore || offset > 0;
  const emitCursor = paged.nextCursor !== null;

  const scanTruncated = scan.value.scanIncomplete;
  const baseNote = anyGranterHadAppVis
    ? 'Who-can-open is computed from profile/permission-set applicationVisibilities (`visible: true`); tab membership is the app definition. App access also depends on the user being ASSIGNED the profile/permission set (runtime, not modeled).'
    : 'No profile/permission set in this vault carries an extracted `applicationVisibilities` property — re-run `/sfi-refresh`; the who-can-open list is "not modeled", not a verified empty.';
  const boundaryNote = scanTruncated
    ? `${baseNote} ${scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit())}`
    : baseNote;

  return ok({
    data: {
      componentId,
      label: app.label ?? appApiName,
      navType,
      tabs,
      canOpen: page,
      defaultedBy,
      summary: { tabs: tabs.length, canOpen: total, defaultedBy: defaultedBy.length },
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
      // Present ONLY on the natural alias/search path — a canonical
      // `CustomApplication:` `componentId` call stays byte-identical.
      ...(appliedScope !== undefined ? { appliedScope } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * The inverse lookup (P14-APP-default-reverse): read the granter node's own
 * `applicationVisibilities` and project `{openableApps, defaultApp}`. Honest
 * when the property is missing: "not modeled", never a verified empty.
 */
const appAccessForGranter = async (
  ctx: Context,
  componentId: ComponentId,
): Promise<Result<McpResponse<AppAccessGranterOutput>, McpError>> => {
  const granterType = componentId.startsWith('Profile:') ? 'Profile' : 'PermissionSet';
  const nodeRes = await getNodeById(ctx.graph, componentId);
  if (!nodeRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeRes.error.message}` });
  }
  if (nodeRes.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no ${granterType} matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }
  const node = nodeRes.value;
  const raw = node.properties['applicationVisibilities'];
  const hasVis = Array.isArray(raw);
  const openable: string[] = [];
  let defaultApp: string | null = null;
  if (hasVis) {
    for (const item of raw as RawAppVis[]) {
      if (typeof item.application !== 'string' || item.visible !== true) continue;
      const appId = `CustomApplication:${item.application}`;
      openable.push(appId);
      if (item.default === true) defaultApp = appId;
    }
  }
  openable.sort();
  return ok({
    data: {
      componentId,
      granterType,
      granterLabel: node.label ?? node.apiName,
      openableApps: openable,
      defaultApp,
      summary: { openableApps: openable.length },
      confidence: 'declared',
      boundaryNote: hasVis
        ? 'Computed from this granter\'s declared applicationVisibilities (visible: true; default flags the default app). Actual access also requires the user to be ASSIGNED this profile/permission set (runtime, not modeled).'
        : 'This granter carries NO extracted applicationVisibilities property — the answer is "not modeled", never a verified empty. Re-run /sfi-refresh; pre-0.1.8 vaults may predate the extraction.',
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
