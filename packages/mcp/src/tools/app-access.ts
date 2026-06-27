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
 * Input: `{ componentId: 'CustomApplication:X', limit?, offset? }`.
 * `declared` confidence — app metadata + applicationVisibilities are declared.
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
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

const APP_PREFIX = 'CustomApplication:';
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 250;
const APP_ACCESS_TOOL = 'sfi.app_access';

export const appAccessInputSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor from a prior truncated page's nextCursor.
  cursor: z.string().min(1).optional(),
});

export type AppAccessInput = z.infer<typeof appAccessInputSchema>;

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

export const appAccessHandler = async (
  ctx: Context,
  input: AppAccessInput,
): Promise<Result<McpResponse<AppAccessOutput | AppAccessGranterOutput>, McpError>> => {
  // INVERSE direction (P14-APP-default-reverse): a Profile/PermissionSet id
  // answers from the granter's OWN applicationVisibilities — one node read.
  if (input.componentId.startsWith('Profile:') || input.componentId.startsWith('PermissionSet:')) {
    return appAccessForGranter(ctx, input.componentId as ComponentId);
  }
  if (input.componentId.startsWith('PermissionSetGroup:')) {
    return err({
      kind: 'invalid-query',
      message:
        'PermissionSetGroup app visibility is the UNION of its member permission sets and is not directly extracted — list the members (get_component on the group) and ask app_access for each PermissionSet instead.',
      path: 'componentId',
    });
  }
  if (!input.componentId.startsWith(APP_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a CustomApplication:, Profile:, or PermissionSet: id; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const componentId = input.componentId as ComponentId;
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
