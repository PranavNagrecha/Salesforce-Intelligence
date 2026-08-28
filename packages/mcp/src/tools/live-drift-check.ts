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
 *
 * Because this is the ONE tool that certifies whether the offline answers are
 * stale, two shapes of confident-empty answer are refused outright rather than
 * reported:
 *
 *   - the named object is resolved through `resolveExistingObjectScope`, so an
 *     object the vault never extracted (or a wrong-cased name) is an
 *     `invalid-query` refusal / a case correction — never an `inSync: true`
 *     bill of health for an object the vault does not contain;
 *   - the vault-side field read WINDOWS the graph's page ceiling forward, so an
 *     object with more custom fields than one page holds does not have its tail
 *     reported as "added live since the refresh", and a walk that still stopped
 *     short says so in `vaultScanIncomplete`.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveExistingObjectScope } from './input-aliases.js';
import { liveDescribeHandler } from './live-plane.js';
import {
  clampedNodeScanLimit,
  FULL_SCAN_MAX_NODES,
  fullScanTruncationNote,
} from './scan-cap.js';

export const liveDriftCheckInputSchema = z.object({
  objectApiName: z.string().min(1),
  orgAlias: z.string().min(1).optional(),
  /** Opt-in to the live plane (mirrors the other live_* tools). */
  liveEnabled: z.boolean().optional(),
});

export type LiveDriftCheckInput = z.infer<typeof liveDriftCheckInputSchema>;

export interface LiveDriftCheckOutput {
  /**
   * The object as the VAULT spells it, not as the caller typed it. A caller
   * who asked about `account` gets `Account` back, so the echoed scope always
   * names a component id that actually exists.
   */
  readonly objectApiName: string;
  /**
   * The caller's spelling when it differed from the vault's, else `null`. A
   * silent case correction would leave the caller believing the tool read the
   * name they typed.
   */
  readonly resolvedFrom: string | null;
  readonly vaultFieldCount: number;
  readonly liveFieldCount: number;
  readonly onlyInVault: readonly string[];
  readonly onlyInLiveCustom: readonly string[];
  readonly inSync: boolean;
  /**
   * True when the vault-side field walk stopped at the residual full-scan
   * ceiling with more CustomField nodes still behind it. While true,
   * `vaultFieldCount` UNDER-reports and `onlyInLiveCustom` OVER-reports (an
   * unread vault field looks live-only), so `inSync` is forced false.
   */
  readonly vaultScanIncomplete: boolean;
  readonly interpretation: string;
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'Compares the offline snapshot to a LIVE read-only describe; requires the live plane (SFI_LIVE_PLANE_ENABLED or liveEnabled:true). Does not mutate the org.',
  'The vault models extracted custom fields (and standard object definitions, not standard fields), so onlyInLiveCustom is limited to custom (__-suffixed) fields to avoid standard-field noise. onlyInVault is the trustworthy staleness signal.',
  'The object must EXIST in the offline vault: an object the vault never extracted (or a typo) is REFUSED with invalid-query, never reported as inSync. A wrong-cased name is resolved to the vault\'s casing and echoed as objectApiName with the caller\'s spelling in resolvedFrom.',
  `The vault-side field read walks EVERY CustomField parented by the object by windowing the graph's page ceiling forward (a single page is capped at 500 rows), bounded at ${FULL_SCAN_MAX_NODES} fields per object; vaultScanIncomplete discloses a walk that stopped short, and while it is set vaultFieldCount under-reports and onlyInLiveCustom over-reports.`,
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

/** Every CustomField node parented by `objectId`, plus the residual-cap flag. */
interface VaultFieldScan {
  readonly nodes: readonly Node[];
  readonly incomplete: boolean;
}

/**
 * LIVE-DRIFT-CHECK-READ-ONE-CAPPED-PAGE — walk EVERY `CustomField` parented by
 * the object by advancing the SQL `OFFSET` window-by-window, the shape
 * {@link scanAllNodesOfTypes} documents (that helper takes TYPES, not a
 * `parentId`, so the walk is done here over the same primitives and the same
 * `scan-cap` constants — no local `500` literal).
 *
 * The single capped page it replaces read the alphabetically-first
 * `clampedNodeScanLimit()` fields only. Every field behind that page was absent
 * from `vaultNames`, so each one landed in `onlyInLiveCustom` and the tool told
 * the user to `sfi refresh` for fields the vault already held, while
 * `vaultFieldCount` under-reported. Salesforce permits well over 500 custom
 * fields per object on higher editions.
 *
 * `incomplete` is true ONLY when the walk stopped at {@link FULL_SCAN_MAX_NODES}
 * with STRICTLY MORE nodes behind it, settled by one bounded probe (CR-P3), so
 * a count landing exactly on the ceiling is not over-disclosed.
 */
const scanObjectFields = async (
  ctx: Context,
  objectId: ComponentId,
): Promise<Result<VaultFieldScan, McpError>> => {
  const windowSize = clampedNodeScanLimit();
  const nodes: Node[] = [];
  let offset = 0;
  for (;;) {
    const page = await listNodesByType(ctx.graph, 'CustomField', {
      parentId: objectId,
      limit: windowSize,
      offset,
    });
    if (!page.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${page.error.message}` });
    }
    nodes.push(...page.value);
    // A short page proves end-of-object — no more windows behind it.
    if (page.value.length < windowSize) return ok({ nodes, incomplete: false });
    offset += windowSize;
    if (nodes.length >= FULL_SCAN_MAX_NODES) {
      const probe = await listNodesByType(ctx.graph, 'CustomField', {
        parentId: objectId,
        limit: windowSize,
        offset,
      });
      if (!probe.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${probe.error.message}` });
      }
      return ok({ nodes, incomplete: probe.value.length > 0 });
    }
  }
};

export const liveDriftCheckHandler = async (
  ctx: Context,
  input: LiveDriftCheckInput,
): Promise<Result<McpResponse<LiveDriftCheckOutput>, McpError>> => {
  // Live describe (gates on the live plane itself + surfaces its own errors).
  // Run FIRST so the live-plane consent gate keeps precedence over every other
  // refusal this tool can raise.
  const live = await liveDescribeHandler(ctx, {
    objectApiName: input.objectApiName,
    ...(input.orgAlias !== undefined ? { orgAlias: input.orgAlias } : {}),
    ...(input.liveEnabled !== undefined ? { liveEnabled: input.liveEnabled } : {}),
  });
  if (!live.ok) return live;
  const liveNames = new Set(liveFieldNames(live.value.data.describe));

  // LIVE-DRIFT-CHECK-TRUSTS-A-TEMPLATED-OBJECT-ID: the object id used to be
  // string-templated (`CustomObject:${input.objectApiName}`) with no existence
  // check and no case canonicalization. For an object the vault never
  // extracted — or one named `account` where the vault holds `Account` — the
  // parentId matched NOTHING, `vaultNames` was empty, `onlyInVault` was empty
  // and `inSync` came back TRUE with "No drift detected: the vault's fields for
  // this object match the live org." That is a clean staleness bill of health
  // for an object the vault does not contain, from the ONE tool whose whole job
  // is to say whether the offline answers are stale — so it certified every
  // other tool's answer about that object. `resolveExistingObjectScope` both
  // VERIFIES the `CustomObject:` node exists and canonicalizes its casing, and
  // refuses (`invalid-query`) when it does not.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input);
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;
  if (scope === null) {
    return err({
      kind: 'invalid-query',
      message: 'name the object to drift-check — pass `objectApiName` (e.g. "Account")',
      path: 'objectApiName',
    });
  }
  const objectId = scope.componentId as ComponentId;
  const resolvedFrom =
    scope.object === input.objectApiName ? null : input.objectApiName;

  // Vault fields: EVERY CustomField node parented to the object (windowed).
  const scan = await scanObjectFields(ctx, objectId);
  if (!scan.ok) return err(scan.error);
  const vaultNames = new Set(scan.value.nodes.map((n) => n.apiName));

  const { onlyInVault, onlyInLiveCustom } = diffFields(vaultNames, liveNames);

  // A truncated vault read cannot support "no drift": the fields it never read
  // are indistinguishable from fields the live org added.
  const vaultScanIncomplete = scan.value.incomplete;
  const inSync = onlyInVault.length === 0 && !vaultScanIncomplete;
  const drift =
    onlyInVault.length > 0
      ? `STALE: ${onlyInVault.length} field(s) are in the vault but not in the live org (deleted/renamed/permission-hidden since the last refresh) — run \`sfi refresh\`. ${onlyInLiveCustom.length} custom field(s) were added live since the refresh.`
      : onlyInLiveCustom.length > 0
        ? `Vault is consistent for existing fields, but ${onlyInLiveCustom.length} custom field(s) were added live since the last refresh — run \`sfi refresh\` to capture them.`
        : 'No drift detected: the vault\'s fields for this object match the live org.';
  const interpretation = [
    resolvedFrom === null
      ? null
      : `Resolved '${resolvedFrom}' to the vault's '${scope.object}'.`,
    drift,
    vaultScanIncomplete
      ? `${fullScanTruncationNote(['CustomField'])} The vault-side field list is INCOMPLETE, so vaultFieldCount under-reports and the onlyInLiveCustom entries above may already be in the vault.`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  return ok({
    data: {
      objectApiName: scope.object,
      resolvedFrom,
      vaultFieldCount: vaultNames.size,
      liveFieldCount: liveNames.size,
      onlyInVault,
      onlyInLiveCustom,
      inSync,
      vaultScanIncomplete,
      interpretation,
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
