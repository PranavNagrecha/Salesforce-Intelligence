/**
 * Handler for the `sfi.live_drift_check` MCP tool.
 *
 * Offline↔live contradiction detection — the one check only this product can
 * do, because it holds BOTH the offline snapshot and a live read-only org
 * connection. For a given object it compares the fields the vault recorded at
 * the last refresh against the live `describe`, and flags:
 *
 *   - `onlyInVault`: fields in the snapshot that the live org no longer
 *     reports — deleted, renamed, or permission-hidden since the refresh. This
 *     is the high-signal direction: it means the vault (and any answer grounded
 *     in it) may be STALE for this object.
 *   - `onlyInLiveCustom`: custom fields the live org has that the vault does
 *     not — added since the refresh (filtered to custom `__`-suffixed fields so
 *     standard fields the vault never models don't create noise).
 *
 * Requires the opt-in live plane (read-only). Does not mutate the org.
 *
 * **Honesty axis**: the vault models the custom fields it extracted (and, since
 * the standard-object pass, standard object definitions — but not standard
 * fields). So `onlyInLiveCustom` is intentionally limited to custom fields; a
 * field appearing in `onlyInVault` is the trustworthy drift signal.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { liveDescribeHandler } from './live-plane.js';

const FIELD_PAGE_SIZE = 500;

export const liveDriftCheckInputSchema = z.object({
  objectApiName: z.string().min(1),
  orgAlias: z.string().min(1).optional(),
  /** Opt-in to the live plane (mirrors the other live_* tools). */
  liveEnabled: z.boolean().optional(),
});

export type LiveDriftCheckInput = z.infer<typeof liveDriftCheckInputSchema>;

export interface LiveDriftCheckOutput {
  readonly objectApiName: string;
  readonly vaultFieldCount: number;
  readonly liveFieldCount: number;
  readonly onlyInVault: readonly string[];
  readonly onlyInLiveCustom: readonly string[];
  readonly inSync: boolean;
  readonly interpretation: string;
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'Compares the offline snapshot to a LIVE read-only describe; requires the live plane (SFI_LIVE_PLANE_ENABLED or liveEnabled:true). Does not mutate the org.',
  'The vault models extracted custom fields (and standard object definitions, not standard fields), so onlyInLiveCustom is limited to custom (__-suffixed) fields to avoid standard-field noise. onlyInVault is the trustworthy staleness signal.',
]);

const isCustomField = (name: string): boolean => name.includes('__');

/** Result of diffing the vault's field names against the live org's. */
export interface FieldDrift {
  readonly onlyInVault: readonly string[];
  readonly onlyInLiveCustom: readonly string[];
}

/**
 * Pure field-set diff. `onlyInVault` = snapshot fields the live org no longer
 * reports (the staleness signal). `onlyInLiveCustom` = custom fields the live
 * org added since the refresh (standard fields excluded — the vault never
 * models them).
 *
 * @example diffFields(['A__c','B__c'], ['A__c','C__c']) // onlyInVault ['B__c'], onlyInLiveCustom ['C__c']
 */
export const diffFields = (
  vaultNames: Iterable<string>,
  liveNames: Iterable<string>,
): FieldDrift => {
  const vault = new Set(vaultNames);
  const live = new Set(liveNames);
  return {
    onlyInVault: [...vault].filter((n) => !live.has(n)).sort(),
    onlyInLiveCustom: [...live].filter((n) => isCustomField(n) && !vault.has(n)).sort(),
  };
};

/** Pull the field API-name set out of a live describe payload. */
const liveFieldNames = (describe: unknown): string[] => {
  const fields = (describe as { fields?: ReadonlyArray<{ name?: unknown }> } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  const out: string[] = [];
  for (const f of fields) {
    if (typeof f.name === 'string') out.push(f.name);
  }
  return out;
};

export const liveDriftCheckHandler = async (
  ctx: Context,
  input: LiveDriftCheckInput,
): Promise<Result<McpResponse<LiveDriftCheckOutput>, McpError>> => {
  // Live describe (gates on the live plane itself + surfaces its own errors).
  const live = await liveDescribeHandler(ctx, {
    objectApiName: input.objectApiName,
    ...(input.orgAlias !== undefined ? { orgAlias: input.orgAlias } : {}),
    ...(input.liveEnabled !== undefined ? { liveEnabled: input.liveEnabled } : {}),
  });
  if (!live.ok) return live;
  const liveNames = new Set(liveFieldNames(live.value.data.describe));

  // Vault fields: CustomField nodes parented to the object.
  const objectId: ComponentId = `CustomObject:${input.objectApiName}`;
  const vaultNodes = await listNodesByType(ctx.graph, 'CustomField', {
    parentId: objectId,
    limit: FIELD_PAGE_SIZE,
  });
  if (!vaultNodes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${vaultNodes.error.message}` });
  }
  const vaultNames = new Set(vaultNodes.value.map((n) => n.apiName));

  const { onlyInVault, onlyInLiveCustom } = diffFields(vaultNames, liveNames);

  const inSync = onlyInVault.length === 0;
  const interpretation = !inSync
    ? `STALE: ${onlyInVault.length} field(s) are in the vault but not in the live org (deleted/renamed/permission-hidden since the last refresh) — run \`sfi refresh\`. ${onlyInLiveCustom.length} custom field(s) were added live since the refresh.`
    : onlyInLiveCustom.length > 0
      ? `Vault is consistent for existing fields, but ${onlyInLiveCustom.length} custom field(s) were added live since the last refresh — run \`sfi refresh\` to capture them.`
      : 'No drift detected: the vault\'s fields for this object match the live org.';

  return ok({
    data: {
      objectApiName: input.objectApiName,
      vaultFieldCount: vaultNames.size,
      liveFieldCount: liveNames.size,
      onlyInVault,
      onlyInLiveCustom,
      inSync,
      interpretation,
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
