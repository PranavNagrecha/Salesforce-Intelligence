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
  /** Distinct sandbox components that depend on this one; `null` when the sandbox graph couldn't be read. */
  readonly inboundDependencyCount: number | null;
  /** Up to {@link DEP_SAMPLE_CAP} example dependents (sorted). */
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
    readonly withDependents: number;
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
  let depNote: string | null = null;
  if (!unregistered && c.removed.length > 0) {
    const sandboxPath = await resolveVault(findRegistryRoot(ctx.vaultRoot), sandbox);
    if (sandboxPath.ok) {
      const opened = await openGraphReadOnly(vaultPaths(sandboxPath.value).graphDb);
      if (opened.ok) {
        try {
          for (const comp of c.removed) {
            const edges = await listEdges(opened.value, comp.id, { direction: 'in' });
            if (!edges.ok) continue;
            const from = [...new Set(edges.value.map((e) => e.fromId))].sort((a, b) =>
              a < b ? -1 : a > b ? 1 : 0,
            );
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
  const enriched = depByTarget.size > 0 || depNote === null;

  const promotionItems: PromotionItem[] = c.removed
    .map((comp: ComponentDiff): PromotionItem => {
      const info = depByTarget.get(comp.id);
      return {
        id: comp.id,
        type: comp.type,
        apiName: comp.apiName,
        inboundDependencyCount: info?.count ?? (enriched ? 0 : null),
        dependedOnBy: info?.from ?? [],
      };
    })
    .sort(
      (a, b) =>
        (b.inboundDependencyCount ?? -1) - (a.inboundDependencyCount ?? -1) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const byType: Record<string, number> = {};
  for (const item of promotionItems) byType[item.type] = (byType[item.type] ?? 0) + 1;
  const withDependents = promotionItems.filter(
    (i) => (i.inboundDependencyCount ?? 0) > 0,
  ).length;

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
    recommendation = `${c.summary.removedCount} component(s) exist in '${input.sandbox}' but not '${input.prod}' — a promotion must deploy them. ${withDependents} are depended on by other sandbox components.${lead}`;
  }

  const note =
    depNote ??
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
        truncated: c.truncated,
      },
      recommendation,
      trust: {
        provenance: 'offline_snapshot',
        confidence: 'declared',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: { status: c.truncated ? 'partial' : 'complete' },
        limitations: [PROMOTION_DISCLOSURE, ...c.boundaries],
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
