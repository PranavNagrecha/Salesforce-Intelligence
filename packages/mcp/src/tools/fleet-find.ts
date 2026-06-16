/**
 * Handler for the `sfi.fleet_find` MCP tool — "which of my orgs contains X?".
 *
 * The cross-vault sibling of `sfi.resolve`. Where the single-vault tools all
 * read `ctx.graph` (the one org this server was launched for), fleet_find runs
 * the same typo-tolerant resolver across EVERY registered vault, read-only,
 * and reports per-vault dispositions — so a power user with several orgs can
 * answer "which org has a Payment object / a CalculatePayments class / this
 * field" from one call.
 *
 * **Multi-vault, so it reads a registry, not `ctx.graph`.** The registry lists
 * the user's vaults. It is located via `SF_INTELLIGENCE_REGISTRY_PATH`, else
 * by walking up from the current vault root. A single-org install has no
 * registry (or one vault); fleet_find then returns an HONEST note rather than
 * an error — it is a power-user / multi-org tool by nature.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import {
  fleetResolve,
  type FleetVaultRef,
  type FleetVaultResult,
} from '@sf-intelligence/graph';
import { findRegistryFile } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

const MAX_LIMIT = 50;

export const fleetFindInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type FleetFindInput = z.infer<typeof fleetFindInputSchema>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FleetFindOutput {
  readonly query: string;
  /** How many vaults the registry listed (0 when no registry was found). */
  readonly registeredVaultCount: number;
  /** Per-vault resolver verdicts. Empty when there is no usable registry. */
  readonly results: readonly FleetVaultResult[];
  /** Vault keys where the query resolved to `exact` or `ambiguous`. */
  readonly foundIn: readonly string[];
  /** Set when fleet search couldn't run as intended (no/!single registry). */
  readonly note: string | null;
  readonly disclosure: string;
}

const FLEET_DISCLOSURE =
  'Cross-vault results are typo-tolerant, heuristic resolver verdicts per org — same honesty as sfi.resolve. `exact` = one confident match in that vault; `ambiguous` = several plausible; `none` = nothing matched; `unavailable` = that vault could not be read. Verify the candidate id/label before acting.';

/** Minimal shape we read out of the workspace registry.json. */
interface RegistryShape {
  readonly vaults?: Readonly<Record<string, { readonly path: string }>>;
}

/**
 * Locate the multi-vault registry FILE via the shared `findRegistryFile`
 * primitive (in `@sf-intelligence/vault`) so fleet_find and the `compare_*`
 * family resolve from the same logic. It honors `SF_INTELLIGENCE_REGISTRY_PATH`
 * (an exact file path — possibly not named `registry.json` — or a directory)
 * and otherwise walks up from the vault root. Returns the file path, or null
 * when it doesn't exist — fleet_find then surfaces an honest "single-vault
 * install" note rather than erroring.
 */
const findRegistryPath = (vaultRoot: string): string | null => {
  const candidate = findRegistryFile(vaultRoot);
  return existsSync(candidate) ? candidate : null;
};

/**
 * The `sfi.fleet_find` MCP tool. Resolves `query` across every registered
 * vault read-only. See module JSDoc for the multi-vault / honest-degradation
 * design.
 *
 * @example
 *   const r = await fleetFindHandler(ctx, { query: 'payment' });
 *   if (r.ok) console.log(r.value.data.foundIn);
 */
export const fleetFindHandler = async (
  ctx: Context,
  input: FleetFindInput,
): Promise<Result<McpResponse<FleetFindOutput>, McpError>> => {
  const base = (
    note: string | null,
    results: readonly FleetVaultResult[],
    registeredVaultCount: number,
  ): Result<McpResponse<FleetFindOutput>, McpError> =>
    ok({
      data: {
        query: input.query,
        registeredVaultCount,
        results,
        foundIn: results
          .filter((r) => r.disposition === 'exact' || r.disposition === 'ambiguous')
          .map((r) => r.vault),
        note,
        disclosure: FLEET_DISCLOSURE,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });

  const registryFilePath = findRegistryPath(ctx.vaultRoot);
  if (registryFilePath === null) {
    return base(
      'No multi-vault registry found (set SF_INTELLIGENCE_REGISTRY_PATH to enable). This looks like a single-vault install — use sfi.resolve to search this org. Fleet search compares one query across several registered orgs.',
      [],
      0,
    );
  }

  let registry: RegistryShape;
  try {
    registry = JSON.parse(readFileSync(registryFilePath, 'utf8')) as RegistryShape;
  } catch (e) {
    return base(`registry at ${registryFilePath} is unreadable: ${(e as Error).message}`, [], 0);
  }

  const vaults: FleetVaultRef[] = Object.entries(registry.vaults ?? {}).map(
    ([key, v]) => ({ key, graphDbPath: join(v.path, 'graph', 'graph.duckdb') }),
  );

  if (vaults.length < 2) {
    return base(
      `Only ${vaults.length} vault(s) registered; fleet search compares a query across multiple orgs. Register more vaults, or use sfi.resolve for this one.`,
      [],
      vaults.length,
    );
  }

  const results = await fleetResolve(vaults, input.query, {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  });

  return base(null, results, vaults.length);
};
