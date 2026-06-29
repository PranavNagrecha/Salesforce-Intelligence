/**
 * Handler for the `sfi.installed_package_catalog` MCP tool.
 *
 * Answers "what packages are installed in this org?" from the `InstalledPackage`
 * nodes the refresh extracts (`installedPackages/<namespace>.installedPackage-meta.xml`).
 * Each row is a managed/unlocked package: its `namespace` prefix (the same prefix
 * its components carry — `hed__Course__c` -> `hed`) and the installed
 * `versionNumber`. This grounds the managed-extension taxonomy with REAL
 * version + namespace data instead of inferring the namespace from component
 * api-name prefixes alone. `declared` confidence (it is declared metadata).
 *
 * No input. The list is COMPLETE (a real org has tens of packages, not
 * thousands), sorted by namespace.
 */
import type { ComponentId, McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { buildEnumerationCoverageCaveat, type CoverageCaveat } from './coverage-trust.js';

/** Defensive ceiling — `listNodesByType` caps at 500; an org with more installed packages than that is unheard of. */
const CATALOG_SCAN_LIMIT = 500;

export const installedPackageCatalogInputSchema = z.object({});
export type InstalledPackageCatalogInput = z.infer<typeof installedPackageCatalogInputSchema>;

/** One installed managed/unlocked package. */
export interface InstalledPackageEntry {
  readonly componentId: ComponentId;
  /** The package's namespace prefix (also the metadata fullName). */
  readonly namespace: string;
  /** The installed version (e.g. `8.293`), or `null` when not declared. */
  readonly versionNumber: string | null;
}

export interface InstalledPackageCatalogOutput {
  readonly packages: readonly InstalledPackageEntry[];
  readonly summary: { readonly count: number };
  readonly confidence: 'declared';
  readonly boundaryNote: string;
  /**
   * coverage-aware-zero (CR): present when the manifest reports `InstalledPackage`
   * was NOT retrieved (requested but not confirmed-clean). An empty `packages`
   * under this caveat is "not retrieved, re-refresh" — NOT a proven "no managed
   * packages". Absent on a legacy (no-coverage) vault and on a confirmed-clean
   * retrieve, so existing goldens do not move.
   */
  readonly coverageCaveat?: CoverageCaveat;
}

const NOT_EXTRACTED_NOTE =
  'No `InstalledPackage` metadata in this vault — either the org has no managed/unlocked packages, or the refresh predates InstalledPackage extraction. Re-run `/sfi-refresh`; an empty list here is "not modeled", not a verified "none". Component namespace prefixes (e.g. `hed__`) still indicate package ownership even without this catalog.';

const EXTRACTED_NOTE =
  'Declared from `installedPackages/*.installedPackage-meta.xml`. `namespace` is the package prefix its components carry; `versionNumber` is the installed version. This is the package inventory, not its contents — use `package_impact` for what a namespace touches.';

export const installedPackageCatalogHandler = async (
  ctx: Context,
  _input: InstalledPackageCatalogInput,
): Promise<Result<McpResponse<InstalledPackageCatalogOutput>, McpError>> => {
  const res = await listNodesByType(ctx.graph, 'InstalledPackage', { limit: CATALOG_SCAN_LIMIT });
  if (!res.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${res.error.message}` });
  }

  const packages: InstalledPackageEntry[] = res.value
    .map((node) => {
      const ns = node.properties['namespace'];
      const ver = node.properties['versionNumber'];
      return {
        componentId: node.id,
        namespace: typeof ns === 'string' && ns.length > 0 ? ns : node.apiName,
        versionNumber: typeof ver === 'string' && ver.length > 0 ? ver : null,
      };
    })
    .sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0));

  const coverageCaveat = buildEnumerationCoverageCaveat(ctx, 'InstalledPackage');

  return ok({
    data: {
      packages,
      summary: { count: packages.length },
      confidence: 'declared',
      boundaryNote: packages.length === 0 ? NOT_EXTRACTED_NOTE : EXTRACTED_NOTE,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
