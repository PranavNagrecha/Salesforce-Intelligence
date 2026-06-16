/**
 * Handler for the `sfi.package_impact` MCP tool.
 *
 * Answers the admin's terror question: "what does the `{namespace}` managed
 * package touch, and what of MINE breaks if I uninstall or upgrade it?" —
 * the managed-package boundary surface. No `InstalledPackage` metadata is
 * modelled, so the tool derives package membership from the API-name
 * NAMESPACE PREFIX (the same `SBQQ__` signal the CPQ tier recognises) and
 * reports the BOUNDARY: which of your components reference the package's
 * components (the uninstall blast radius), and which of your components were
 * grafted onto the package's objects.
 *
 * **Two modes** (no extra plumbing — presence of `namespace` selects):
 *   - INVENTORY (no `namespace`): scan every node, group by detected
 *     namespace, return the packages visible in the vault with component
 *     counts. "Which managed packages can we see, and how big is each?"
 *   - IMPACT (`namespace`, e.g. `SBQQ`): return the package's visible
 *     components, your `yourDependencies` (incoming non-`parentOf` edges
 *     from components OUTSIDE the namespace — what breaks on uninstall), and
 *     `yourExtensions` (your components parented UNDER a package component,
 *     e.g. custom fields you added to `SBQQ__Quote__c` — orphaned on
 *     uninstall). The verdict is `has-dependencies` or the deliberately
 *     hedged `no-detected-dependencies` — NEVER "safe to uninstall".
 *
 * **Namespace heuristic** (`namespaceOf`): a Salesforce API name carries a
 * namespace iff its leaf component name splits into >= 3 `__`-delimited
 * segments (`NS__Object__c` → `['NS','Object','c']` → namespace `NS`).
 * `Object__c` (2 segments — base + suffix) and standard names (`Account`,
 * `Name`) carry none. This is robust because Salesforce forbids consecutive
 * underscores inside a custom name, so any non-suffix `__` IS a namespace
 * separator. For field ids (`Object.Field`) the FIELD leaf decides ownership
 * — `SBQQ__Quote__c.MyField__c` is YOUR field (no namespace) on THEIR object.
 *
 * **Honesty boundary (verbatim in `disclosure`)**: managed Apex referenced
 * via dot-notation (`NS.ClassName`) and namespaced components without a
 * standard suffix are invisible to the prefix heuristic; a package's INTERNAL
 * components are usually never retrieved, so `packageComponentCount` reflects
 * what you can SEE, not the package's full footprint; `no-detected-
 * dependencies` means no STATIC evidence in retrieved metadata — dynamic
 * SOQL, `Type.forName('NS.X')`, and unretrieved metadata are invisible.
 * Validate every uninstall in a sandbox first.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodeIdentities, type NodeIdentity } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Default detail/sample cap; hard max. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Per-package id sample size in INVENTORY mode (keeps the response compact). */
const INVENTORY_SAMPLE = 5;

/**
 * Max package nodes scanned for incoming edges in IMPACT mode. Each node
 * costs one `listEdges` call; this bounds a pathological package (CPQ has
 * hundreds of components) while staying deterministic — `listNodeIdentities`
 * returns id-sorted rows, so a truncated scan is a stable prefix.
 */
const EDGE_SCAN_CAP = 2000;

/** Verbatim honesty disclosure surfaced on every response. */
const PACKAGE_IMPACT_DISCLOSURE =
  'package_impact detects managed/namespaced components by API-name prefix: a name is namespaced iff its leaf splits into >= 3 "__"-delimited segments (NS__Object__c). This reliably catches namespaced objects, fields, and custom metadata — the bulk of what a package adds — but MISSES managed Apex referenced via dot-notation (NS.ClassName) and namespaced components without a standard suffix. The vault holds only what `sf project retrieve` pulled: a package’s INTERNAL components are usually NOT retrieved, so packageComponentCount reflects what you can SEE, not the package’s full footprint. "no-detected-dependencies" means NO STATIC evidence in retrieved metadata that your components reference this namespace — it does NOT prove the package is safe to uninstall (dynamic SOQL, Type.forName("NS.X"), merge-field/formula references, and unretrieved metadata are invisible). Always validate an uninstall in a sandbox first.';

/**
 * Zod schema for the `sfi.package_impact` tool input.
 *   - `namespace`: optional. Absent → INVENTORY mode (list every package).
 *     Present → IMPACT mode for that namespace (case-insensitive match).
 *   - `limit`: detail/sample cap (default 50, max 500).
 */
export const packageImpactInputSchema = z.object({
  namespace: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type PackageImpactInput = z.infer<typeof packageImpactInputSchema>;

/** One package (namespace) summary in INVENTORY mode. */
export interface PackageSummary {
  readonly namespace: string;
  readonly componentCount: number;
  /**
   * Your components parented UNDER this package's objects (layouts/fields you
   * added to `NS__Object__c`). A package with `componentCount` 0 but
   * `extensionCount` > 0 IS installed — its own components were just never
   * retrieved (managed internals, or the package object is a phantom). Without
   * this signal a heavily-used package (e.g. HEDA `hed`, whose objects come
   * down as phantoms) reads as "not present" in the inventory.
   */
  readonly extensionCount: number;
  readonly sampleComponentIds: readonly ComponentId[];
}

/** One boundary dependency: your component references a package component. */
export interface PackageDependency {
  readonly fromId: ComponentId;
  readonly fromType: ComponentType | null;
  /** Namespace of the dependent (null = your own / unmanaged component). */
  readonly fromNamespace: string | null;
  readonly edgeType: string;
  readonly confidence: string;
  readonly toId: ComponentId;
}

/** Your component grafted onto a package component (parented under it). */
export interface PackageExtension {
  readonly id: ComponentId;
  readonly type: ComponentType | null;
  readonly parentId: ComponentId;
}

export interface PackageImpactInventoryOutput {
  readonly mode: 'inventory';
  readonly packages: readonly PackageSummary[];
  readonly totalNamespacedComponents: number;
  readonly totalComponentsScanned: number;
  readonly scanTruncated: boolean;
  readonly disclosure: string;
}

export interface PackageImpactImpactOutput {
  readonly mode: 'impact';
  readonly namespace: string;
  readonly packageComponentCount: number;
  readonly packageComponentSample: readonly ComponentId[];
  readonly yourDependencies: readonly PackageDependency[];
  readonly yourDependencyTotal: number;
  /** Distinct dependent component ids (a single class may hold several edges). */
  readonly dependentComponentCount: number;
  readonly yourExtensions: readonly PackageExtension[];
  readonly yourExtensionTotal: number;
  readonly verdict: 'has-dependencies' | 'no-detected-dependencies';
  readonly scanTruncated: boolean;
  readonly edgeScanTruncated: boolean;
  readonly disclosure: string;
}

export type PackageImpactOutput =
  | PackageImpactInventoryOutput
  | PackageImpactImpactOutput;

/**
 * Derive the managed-package namespace of a canonical id (or bare API name),
 * or `null` when unmanaged / standard. See the file header for the rule. The
 * leaf (the part after the last `.`, for `Object.Field` ids) decides
 * ownership; a leaf with >= 3 `__`-segments is namespaced and the first
 * segment is the namespace.
 *
 * @example
 *   namespaceOf('CustomObject:SBQQ__Quote__c')            // 'SBQQ'
 *   namespaceOf('CustomField:Account.SBQQ__Ext__c')       // 'SBQQ'
 *   namespaceOf('CustomField:SBQQ__Quote__c.MyField__c')  // null (your field)
 *   namespaceOf('CustomObject:Payment__c')                // null
 *   namespaceOf('ApexClass:OrderService')                 // null
 */
export const namespaceOf = (idOrName: string): string | null => {
  const colon = idOrName.indexOf(':');
  const local = colon >= 0 ? idOrName.slice(colon + 1) : idOrName;
  const dot = local.lastIndexOf('.');
  const leaf = dot >= 0 ? local.slice(dot + 1) : local;
  const segments = leaf.split('__');
  if (segments.length < 3) return null;
  const ns = segments[0];
  return ns !== undefined && ns.length > 0 ? ns : null;
};

const buildInventory = (
  identities: readonly NodeIdentity[],
  scanTruncated: boolean,
): PackageImpactInventoryOutput => {
  const ownByNs = new Map<string, ComponentId[]>();
  const extByNs = new Map<string, ComponentId[]>();
  let totalNamespaced = 0;
  for (const node of identities) {
    const ns = namespaceOf(node.id);
    if (ns !== null) {
      totalNamespaced += 1;
      const bucket = ownByNs.get(ns);
      if (bucket === undefined) ownByNs.set(ns, [node.id]);
      else bucket.push(node.id);
    }
    // A node parented UNDER a package object but not itself in that namespace
    // is YOUR extension of the package — it reveals the package is installed
    // even when none of its OWN components were retrieved (the package object
    // is often a phantom). `ns !== parentNs` excludes a package node nested
    // under another package node (counted as a component above, not here).
    if (node.parentId !== null) {
      const parentNs = namespaceOf(node.parentId);
      if (parentNs !== null && parentNs !== ns) {
        const bucket = extByNs.get(parentNs);
        if (bucket === undefined) extByNs.set(parentNs, [node.id]);
        else bucket.push(node.id);
      }
    }
  }
  const allNamespaces = new Set<string>([...ownByNs.keys(), ...extByNs.keys()]);
  const packages: PackageSummary[] = [...allNamespaces].map((namespace) => {
    const own = ownByNs.get(namespace) ?? [];
    const ext = extByNs.get(namespace) ?? [];
    return {
      namespace,
      componentCount: own.length,
      extensionCount: ext.length,
      // ids arrive id-sorted (listNodeIdentities orders by id ASC). Prefer the
      // package's own components for the sample; fall back to your extensions
      // when none of its own components were retrieved.
      sampleComponentIds: (own.length > 0 ? own : ext).slice(0, INVENTORY_SAMPLE),
    };
  });
  // Most-entangled first (own + extensions); ties broken by namespace ASC.
  packages.sort((a, b) => {
    const aWeight = a.componentCount + a.extensionCount;
    const bWeight = b.componentCount + b.extensionCount;
    return bWeight !== aWeight
      ? bWeight - aWeight
      : a.namespace < b.namespace
        ? -1
        : a.namespace > b.namespace
          ? 1
          : 0;
  });
  return {
    mode: 'inventory',
    packages,
    totalNamespacedComponents: totalNamespaced,
    totalComponentsScanned: identities.length,
    scanTruncated,
    disclosure: PACKAGE_IMPACT_DISCLOSURE,
  };
};

const buildImpact = async (
  ctx: Context,
  identities: readonly NodeIdentity[],
  scanTruncated: boolean,
  rawNamespace: string,
  limit: number,
): Promise<Result<PackageImpactImpactOutput, McpError>> => {
  const target = rawNamespace.trim();
  const targetLc = target.toLowerCase();
  const typeById = new Map<ComponentId, ComponentType>();
  for (const node of identities) typeById.set(node.id, node.type);

  const packageNodes = identities.filter(
    (n) => (namespaceOf(n.id) ?? '').toLowerCase() === targetLc,
  );

  // Your components grafted onto a package component (parent in-namespace,
  // child not). These orphan on uninstall.
  const extensions: PackageExtension[] = [];
  for (const node of identities) {
    if (node.parentId === null) continue;
    const ownNs = (namespaceOf(node.id) ?? '').toLowerCase();
    if (ownNs === targetLc) continue; // a package node under another package node
    const parentNs = (namespaceOf(node.parentId) ?? '').toLowerCase();
    if (parentNs === targetLc) {
      extensions.push({
        id: node.id,
        type: typeById.get(node.id) ?? null,
        parentId: node.parentId,
      });
    }
  }

  // Boundary dependencies: incoming non-parentOf edges into package nodes,
  // from components OUTSIDE the namespace. Cap the edge scan deterministically.
  const edgeScanTruncated = packageNodes.length > EDGE_SCAN_CAP;
  const scanNodes = edgeScanTruncated
    ? packageNodes.slice(0, EDGE_SCAN_CAP)
    : packageNodes;
  const seen = new Set<string>();
  const dependencies: PackageDependency[] = [];
  for (const node of scanNodes) {
    const r = await listEdges(ctx.graph, node.id, { direction: 'in' });
    if (!r.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${r.error.message}` });
    }
    for (const edge of r.value) {
      if (edge.edgeType === 'parentOf') continue; // containment, not a dependency
      const fromNs = namespaceOf(edge.fromId);
      if ((fromNs ?? '').toLowerCase() === targetLc) continue; // intra-package edge
      const key = `${edge.fromId} ${edge.edgeType} ${node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push({
        fromId: edge.fromId,
        fromType: typeById.get(edge.fromId) ?? null,
        fromNamespace: fromNs,
        edgeType: edge.edgeType,
        confidence: edge.confidence,
        toId: node.id,
      });
    }
  }

  dependencies.sort((a, b) =>
    a.fromId !== b.fromId
      ? a.fromId < b.fromId
        ? -1
        : 1
      : a.toId !== b.toId
        ? a.toId < b.toId
          ? -1
          : 1
        : a.edgeType < b.edgeType
          ? -1
          : a.edgeType > b.edgeType
            ? 1
            : 0,
  );
  extensions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const dependentComponentCount = new Set(dependencies.map((d) => d.fromId)).size;
  const verdict: 'has-dependencies' | 'no-detected-dependencies' =
    dependencies.length > 0 || extensions.length > 0
      ? 'has-dependencies'
      : 'no-detected-dependencies';

  return ok({
    mode: 'impact',
    namespace: target,
    packageComponentCount: packageNodes.length,
    packageComponentSample: packageNodes.slice(0, limit).map((n) => n.id),
    yourDependencies: dependencies.slice(0, limit),
    yourDependencyTotal: dependencies.length,
    dependentComponentCount,
    yourExtensions: extensions.slice(0, limit),
    yourExtensionTotal: extensions.length,
    verdict,
    scanTruncated,
    edgeScanTruncated,
    disclosure: PACKAGE_IMPACT_DISCLOSURE,
  });
};

/**
 * The `sfi.package_impact` MCP tool. INVENTORY mode (no `namespace`) lists
 * every managed package visible in the vault; IMPACT mode (`namespace`)
 * returns the uninstall blast radius for one package.
 *
 * @example
 *   const r = await packageImpactHandler(ctx, { namespace: 'SBQQ' });
 *   if (r.ok && r.value.data.mode === 'impact')
 *     console.log(r.value.data.verdict);
 */
export const packageImpactHandler = async (
  ctx: Context,
  input: PackageImpactInput,
): Promise<Result<McpResponse<PackageImpactOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const idRes = await listNodeIdentities(ctx.graph);
  if (!idRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${idRes.error.message}` });
  }
  const identities = idRes.value;
  // listNodeIdentities caps at its own ceiling; surface that as scanTruncated.
  const scanTruncated = identities.length >= 100_000;

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  if (input.namespace === undefined) {
    return ok({ data: buildInventory(identities, scanTruncated), vaultState });
  }

  const impact = await buildImpact(
    ctx,
    identities,
    scanTruncated,
    input.namespace,
    limit,
  );
  if (!impact.ok) return impact;
  return ok({ data: impact.value, vaultState });
};
