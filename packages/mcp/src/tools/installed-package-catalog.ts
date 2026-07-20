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
 * The list is COMPLETE (a real org has tens of packages, not thousands),
 * sorted by namespace.
 *
 * **Namespace filter (INSTALLED-PACKAGE-CATALOG-IGNORES-NAMESPACEPREFIX)** —
 * the optional `namespacePrefix` input narrows the catalog to the package whose
 * namespace equals it (EXACT, case-insensitive — a namespace prefix is a single
 * token like `hed`, not a substring). When present the response echoes
 * `appliedScope` so a host never mistakes the bare 28-package list for a scoped
 * answer; a no-filter call omits it and stays byte-identical. A prefix that
 * matches nothing returns an honest empty catalog with a scoped `boundaryNote`
 * ("no installed package with namespace prefix X"), NOT the full list and NOT
 * the "not modeled" note reserved for a genuinely package-less vault.
 */
import type { ComponentId, McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { buildEnumerationCoverageCaveat, type CoverageCaveat } from './coverage-trust.js';

/** Defensive ceiling — `listNodesByType` caps at 500; an org with more installed packages than that is unheard of. */
const CATALOG_SCAN_LIMIT = 500;

export const installedPackageCatalogInputSchema = z.object({
  // INSTALLED-PACKAGE-CATALOG-IGNORES-NAMESPACEPREFIX: honor an exact
  // (case-insensitive) namespace match instead of silently returning the full
  // catalog. Echoed back as `appliedScope`; a bare call omits it.
  namespacePrefix: z.string().min(1).optional(),
});
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
   * INSTALLED-PACKAGE-CATALOG-IGNORES-NAMESPACEPREFIX: the scope ACTUALLY
   * applied. Present ONLY when the caller passed a `namespacePrefix` filter — a
   * bare call omits it so its response stays byte-identical to the pre-filter
   * shape. A host that sees no `appliedScope` MUST treat the list as the full
   * catalog, not a scoped answer.
   */
  readonly appliedScope?: {
    readonly namespacePrefix: string;
    readonly mode: 'namespacePrefix';
  };
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

/**
 * Boundary note for a `namespacePrefix`-scoped call that matched no package,
 * while the vault DOES hold packages. This is an honest empty scope ("none with
 * that prefix"), NOT the "not modeled" case a genuinely package-less vault gets
 * ({@link NOT_EXTRACTED_NOTE}) — conflating the two would be its own honesty
 * bug.
 */
const SCOPED_EMPTY_NOTE =
  'No installed package matches the requested `namespacePrefix` (exact, case-insensitive match). The vault DOES hold installed packages — this is an empty SCOPE, not a package-less org. Omit `namespacePrefix` to see the full catalog; the prefix is the token its components carry (e.g. `hed` for `hed__Course__c`).';

export const installedPackageCatalogHandler = async (
  ctx: Context,
  input: InstalledPackageCatalogInput,
): Promise<Result<McpResponse<InstalledPackageCatalogOutput>, McpError>> => {
  const res = await listNodesByType(ctx.graph, 'InstalledPackage', { limit: CATALOG_SCAN_LIMIT });
  if (!res.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${res.error.message}` });
  }

  const allPackages: InstalledPackageEntry[] = res.value
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

  // INSTALLED-PACKAGE-CATALOG-IGNORES-NAMESPACEPREFIX: a namespace prefix is an
  // exact token (the prefix its components carry), so match it exactly,
  // case-insensitively — never as a substring.
  const prefixNeedle =
    input.namespacePrefix !== undefined ? input.namespacePrefix.toLowerCase() : null;
  const packages =
    prefixNeedle === null
      ? allPackages
      : allPackages.filter((p) => p.namespace.toLowerCase() === prefixNeedle);

  // boundaryNote honesty tri-state:
  //   - vault genuinely has no packages          -> NOT_EXTRACTED_NOTE
  //   - scoped filter matched nothing (but vault HAS packages) -> SCOPED_EMPTY_NOTE
  //   - packages present                          -> EXTRACTED_NOTE
  // A bare (unscoped) call can only hit the first or third branch, so its
  // note is unchanged from before the filter existed (byte-identical golden).
  const boundaryNote =
    allPackages.length === 0
      ? NOT_EXTRACTED_NOTE
      : packages.length === 0
        ? SCOPED_EMPTY_NOTE
        : EXTRACTED_NOTE;

  const coverageCaveat = buildEnumerationCoverageCaveat(ctx, 'InstalledPackage');

  return ok({
    data: {
      packages,
      summary: { count: packages.length },
      confidence: 'declared',
      boundaryNote,
      // Present ONLY when a namespace filter was passed, so a bare call stays
      // byte-identical to the pre-filter golden.
      ...(input.namespacePrefix !== undefined
        ? {
            appliedScope: {
              namespacePrefix: input.namespacePrefix,
              mode: 'namespacePrefix' as const,
            },
          }
        : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
