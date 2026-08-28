/**
 * Handler for `sfi.promotion_readiness` (P7-promotion-readiness).
 *
 * A focused lens on `sfi.compare_vaults(sandbox → prod)`, not a new diff engine:
 * it takes the `removed` bucket — components present in the SANDBOX vault but
 * absent from PROD, i.e. exactly what a deploy must ADD — and enriches each with
 * how many OTHER sandbox components depend on it (distinct inbound edges in the
 * sandbox graph). That dependency count is a deploy-order priority hint: deploy
 * the most-depended-on components first, because their dependents can't function
 * without them. It is a hint, not a strict topological order (a dependent may
 * already exist in prod, or be sandbox-only itself).
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { closeGraph, listEdges, openGraphReadOnly } from '@sf-intelligence/graph';
import {
  findRegistryRoot,
  listRegisteredVaults,
  resolveVault,
  vaultPaths,
  type VaultRef,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { compareVaultsHandler, type ComponentDiff } from './compare-vaults.js';

export const PROMOTION_DISCLOSURE =
  'Promotion readiness is the sandbox-only set of compare_vaults(sandbox → prod): components present in the sandbox vault but absent from prod — what a deploy must ADD. Each is enriched with how many OTHER sandbox components depend on it (distinct inbound edges in the sandbox graph) as a deploy-ORDER priority hint (deploy the most-depended-on first), NOT a strict topological order — a dependent may already be in prod or be sandbox-only itself. Components correspond by api-name (a rename reads as remove+add). Vault-only structural diff over the last refresh of each vault; it does NOT deploy or validate against the live org. The sandbox-only list is capped at 200 (summary.sandboxOnlyCount is the true total).';

const DEP_SAMPLE_CAP = 5;

/** How many ids the unavailable-count disclosure enumerates before it summarises. */
const DEP_UNAVAILABLE_ENUM_CAP = 10;

/**
 * Sort key for a possibly-unknown dependency count.
 *
 * An UNREAD count sorts FIRST, ahead of every verified count. The list is a
 * deploy-ORDER hint whose instruction is "deploy the most-depended-on first",
 * so the failure direction matters: ranking an unread component last would tell
 * the admin to defer a component precisely BECAUSE we could not read it, which
 * is the worst possible reading of a missing measurement. `MAX_SAFE_INTEGER`
 * (not `Infinity`) so that two unknowns subtract to 0 rather than NaN and fall
 * through to the id tiebreak.
 */
const depSortKey = (count: number | null): number =>
  count === null ? Number.MAX_SAFE_INTEGER : count;

/**
 * The "we could not COUNT this, so do not read the blank as a zero" sentence —
 * the {@link ../tools/absence-disclosure.js} pattern applied to a per-component
 * query failure rather than to a never-extracted family.
 */
const dependencyCountUnavailableDisclosure = (
  unavailableIds: readonly string[],
  total: number,
): string => {
  const shown = unavailableIds.slice(0, DEP_UNAVAILABLE_ENUM_CAP);
  const rest = unavailableIds.length - shown.length;
  const ids = rest > 0 ? `${shown.join(', ')}, … and ${rest} more` : shown.join(', ');
  return (
    `The inbound-dependency count could NOT be read for ${unavailableIds.length} of ${total} ` +
    `promotion item(s) (${ids}) — the sandbox graph query failed for those ids. Their ` +
    '`inboundDependencyCount` is null and `dependedOnBy` is empty because NOTHING WAS ' +
    'MEASURED, never because a check returned none: any of them may be depended on by many ' +
    'components. They are listed FIRST — an unread component cannot be certified safe to ' +
    'deploy late. Re-run after `/sfi-refresh` rebuilds the sandbox graph.'
  );
};

const PROMOTION_MISSING_VAULTS =
  'promotion_readiness compares TWO registered vault aliases (sandbox vs prod). Pass { sandbox: "<alias>", prod: "<alias>" } — register each with `sfi register-vault <alias> <path>` and list them with `sfi list-vaults`. Single-vault setups cannot use this tool.';

export const promotionReadinessInputSchema = z
  .object({
    sandbox: z.string().min(1).optional(),
    prod: z.string().min(1).optional(),
    typeFilter: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.sandbox || !v.prod) {
      ctx.addIssue({ code: 'custom', message: PROMOTION_MISSING_VAULTS });
    }
  });

export type PromotionReadinessInput = z.infer<typeof promotionReadinessInputSchema>;

interface PromotionItem {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  /**
   * Distinct OTHER sandbox components that depend on this one.
   *
   * `null` when the count could not be read — the sandbox graph would not open,
   * its path would not resolve, or the per-component edge query failed. `null`
   * is NOT `0`: `0` means the graph answered and named no dependents.
   */
  readonly inboundDependencyCount: number | null;
  /**
   * Up to {@link DEP_SAMPLE_CAP} example dependents (sorted). Always empty when
   * {@link inboundDependencyCount} is `null` — an unread count has no sample.
   */
  readonly dependedOnBy: readonly ComponentId[];
}

export interface PromotionReadinessOutput {
  readonly sandbox: VaultRef;
  readonly prod: VaultRef;
  /** Sandbox-only components to deploy, ranked most-depended-on first. */
  readonly promotionItems: readonly PromotionItem[];
  readonly byType: Readonly<Record<string, number>>;
  readonly summary: {
    /** TRUE total of sandbox-only components (may exceed the inlined 200). */
    readonly sandboxOnlyCount: number;
    /** Items with a READ count greater than zero (an unread count is not one). */
    readonly withDependents: number;
    /**
     * Items whose `inboundDependencyCount` is `null` because the sandbox graph
     * could not be read. Non-zero means `withDependents` is a FLOOR, not a total.
     */
    readonly dependencyCountUnavailable: number;
    readonly truncated: boolean;
  };
  readonly recommendation: string;
  readonly trust: TrustSummary;
  readonly disclosure: string;
  readonly boundaries: readonly string[];
  readonly note: string | null;
}

export const promotionReadinessHandler = async (
  ctx: Context,
  input: PromotionReadinessInput,
): Promise<Result<McpResponse<PromotionReadinessOutput>, McpError>> => {
  const sandbox = input.sandbox ?? '';
  const prod = input.prod ?? '';
  if (sandbox.length === 0 || prod.length === 0) {
    const registry = findRegistryRoot(ctx.vaultRoot);
    const listed = await listRegisteredVaults(registry);
    const aliases =
      listed.ok && listed.value.length > 0
        ? listed.value.map((v) => v.alias).join(', ')
        : '(none registered)';
    return {
      ok: false,
      error: {
        kind: 'invalid-query',
        message: `${PROMOTION_MISSING_VAULTS} Registered vault aliases: ${aliases}.`,
      },
    };
  }

  const cmp = await compareVaultsHandler(ctx, {
    vaultA: sandbox,
    vaultB: prod,
    ...(input.typeFilter !== undefined ? { typeFilter: input.typeFilter } : {}),
  });
  if (!cmp.ok) return { ok: false, error: cmp.error };
  const c = cmp.value.data;

  // compare_vaults returns an unregistered alias as an OK response with an empty
  // path on the missing ref + the register-vault directive in boundaries.
  const unregistered = c.vaultA.path === '' || c.vaultB.path === '';

  // Enrich the sandbox-only set with inbound-dependency counts from the sandbox
  // graph. Degrade honestly (counts → null) if the graph can't be opened.
  const depByTarget = new Map<string, { count: number; from: ComponentId[] }>();
  /**
   * Ids whose edge query FAILED. Tracked separately from `depByTarget` because
   * a failed query and a genuinely dependent-free component are the two things
   * this tool must never render the same: skipping the failure would leave the
   * id absent from `depByTarget`, and any "absent means zero" fallback would
   * then stamp a confident `0` on a component nothing measured.
   */
  const depQueryFailed = new Set<string>();
  let depNote: string | null = null;
  if (!unregistered && c.removed.length > 0) {
    const sandboxPath = await resolveVault(findRegistryRoot(ctx.vaultRoot), sandbox);
    if (sandboxPath.ok) {
      const opened = await openGraphReadOnly(vaultPaths(sandboxPath.value).graphDb);
      if (opened.ok) {
        try {
          for (const comp of c.removed) {
            const edges = await listEdges(opened.value, comp.id, { direction: 'in' });
            if (!edges.ok) {
              depQueryFailed.add(comp.id);
              continue;
            }
            // R3: a self-referential edge (a lookup to the component's own type,
            // an Apex class calling itself) is not another component waiting on
            // this deploy, so it must not inflate the deploy-order rank.
            const from = [
              ...new Set(edges.value.map((e) => e.fromId).filter((id) => id !== comp.id)),
            ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            depByTarget.set(comp.id, { count: from.length, from: from.slice(0, DEP_SAMPLE_CAP) });
          }
        } finally {
          await closeGraph(opened.value);
        }
      } else {
        depNote = 'Sandbox graph could not be opened; promotion items are listed without dependency counts.';
      }
    } else {
      depNote = 'Sandbox vault path could not be resolved for dependency enrichment.';
    }
  }

  const promotionItems: PromotionItem[] = c.removed
    .map((comp: ComponentDiff): PromotionItem => {
      const info = depByTarget.get(comp.id);
      // A count is a number ONLY when this component's OWN query answered.
      // A run-wide "the graph opened" flag is not enough: the graph can open
      // and still fail on one id, and that id must stay null rather than
      // inherit the run's overall success.
      const measured = info !== undefined && !depQueryFailed.has(comp.id);
      return {
        id: comp.id,
        type: comp.type,
        apiName: comp.apiName,
        inboundDependencyCount: measured ? info.count : null,
        dependedOnBy: measured ? info.from : [],
      };
    })
    .sort(
      (a, b) =>
        depSortKey(b.inboundDependencyCount) - depSortKey(a.inboundDependencyCount) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const byType: Record<string, number> = {};
  for (const item of promotionItems) byType[item.type] = (byType[item.type] ?? 0) + 1;
  const withDependents = promotionItems.filter(
    (i) => (i.inboundDependencyCount ?? 0) > 0,
  ).length;
  // DERIVED from the emitted items, not from `depQueryFailed`, so the count and
  // the disclosure can never disagree with what the caller actually received —
  // this also covers the whole-graph failure paths, where no per-id query ran.
  const unavailableIds = promotionItems
    .filter((i) => i.inboundDependencyCount === null)
    .map((i) => i.id);
  const depUnavailableNote =
    unavailableIds.length > 0
      ? dependencyCountUnavailableDisclosure(unavailableIds, promotionItems.length)
      : null;

  let recommendation: string;
  if (unregistered) {
    recommendation = c.boundaries[0] ?? 'A vault alias is not registered.';
  } else if (c.summary.removedCount === 0) {
    recommendation = `Nothing to promote: '${input.prod}' already has every component '${input.sandbox}' has (for the compared types). Note this checks structure only, not field/permission shape drift — see compare_vaults shapeModified for that.`;
  } else {
    const top = promotionItems[0];
    const lead =
      top !== undefined && (top.inboundDependencyCount ?? 0) > 0
        ? ` Deploy the most-depended-on first — e.g. ${top.id} (depended on by ${top.inboundDependencyCount}).`
        : '';
    const unknown =
      unavailableIds.length > 0
        ? ` ${unavailableIds.length} dependency count(s) could not be read from the sandbox graph — those are null, NOT 0, and are listed first; ${withDependents} is therefore a floor.`
        : '';
    recommendation = `${c.summary.removedCount} component(s) exist in '${input.sandbox}' but not '${input.prod}' — a promotion must deploy them. ${withDependents} are depended on by other sandbox components.${unknown}${lead}`;
  }

  const note =
    depNote ??
    depUnavailableNote ??
    (unregistered ? (c.boundaries[0] ?? null) : null) ??
    (c.truncated
      ? 'Sandbox-only list capped at 200 components; summary.sandboxOnlyCount is the true total. Narrow with typeFilter for a complete slice.'
      : null);

  return ok({
    data: {
      sandbox: c.vaultA,
      prod: c.vaultB,
      promotionItems,
      byType,
      summary: {
        sandboxOnlyCount: c.summary.removedCount,
        withDependents,
        dependencyCountUnavailable: unavailableIds.length,
        truncated: c.truncated,
      },
      recommendation,
      trust: {
        provenance: 'offline_snapshot',
        confidence: 'declared',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: {
          status:
            c.truncated || depNote !== null || depUnavailableNote !== null
              ? 'partial'
              : 'complete',
        },
        limitations: [
          PROMOTION_DISCLOSURE,
          ...(depNote !== null ? [depNote] : []),
          ...(depUnavailableNote !== null ? [depUnavailableNote] : []),
          ...c.boundaries,
        ],
      },
      disclosure: PROMOTION_DISCLOSURE,
      boundaries: c.boundaries,
      note,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
