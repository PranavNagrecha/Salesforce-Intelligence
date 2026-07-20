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
 * **Two modes** (presence of a package selector chooses IMPACT):
 *   - INVENTORY (no `namespace` / `packageId` / `componentId`): scan every
 *     node, group by detected namespace, return the packages visible in the
 *     vault with component counts. "Which managed packages can we see, and how
 *     big is each?"
 *   - IMPACT (`namespace`, e.g. `SBQQ` — OR a `packageId` / `componentId` /
 *     `namespacePrefix` selector: a bare namespace or the
 *     `InstalledPackage:<namespace>` id `sfi.installed_package_catalog`
 *     returns): return the package's visible
 *     components, your `yourDependencies` (incoming non-`parentOf` edges
 *     from components OUTSIDE the namespace — what breaks on uninstall), and
 *     `yourExtensions` (your components parented UNDER a package component,
 *     e.g. custom fields you added to `SBQQ__Quote__c` — orphaned on
 *     uninstall). The verdict is one of `has-dependencies`,
 *     `members-present-no-static-inbound`, `incomplete-scan`, `review`, or the
 *     bare `no-detected-dependencies` — NEVER "safe to uninstall". A bare
 *     `no-detected-dependencies` is emitted ONLY when nothing hides a
 *     touchpoint: no visible members, a complete scan, and no coverage gap.
 *     Visible package members, a truncated scan, or an un-provable absence each
 *     yield a truthful non-soft verdict so the caveat and the verdict AGREE
 *     (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND) — the enum a host acts on can
 *     never read soft-safe while a package touchpoint or blind spot is present.
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
 * **Two-segment package members** (`namespaceOfWithKnownPackages`): managed
 * components WITHOUT a standard suffix — a managed Apex class, FieldSet, or
 * permission set named `NS__Leaf` (`Demopkg__GadgetController`,
 * `Demopkg__GadgetFields`) — split into only 2 `__`-segments and so the
 * >=3-segment rule alone MISSES them, reading a real installed package as
 * empty (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND). A 2-segment leaf `A__B`
 * is therefore claimed for namespace `A` ONLY when `A` is the namespace of an
 * `InstalledPackage` node present in this vault AND `B` is not a standard
 * suffix (`c`/`r`/`e`/`b`/`x`/`mdt`/…) — so `Widget__c` (your object) is never
 * misread and no namespace is invented from an arbitrary `A__B` token. Orgs
 * with no modelled `InstalledPackage` metadata fall back to the bare
 * prefix heuristic unchanged.
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
import {
  danglingTargetIdsMatching,
  listEdges,
  listNodeIdentities,
  type NodeIdentity,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildUsageSourceCoverageCaveat,
  type CoverageCaveat,
} from './coverage-trust.js';

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
  'package_impact detects managed/namespaced components by API-name prefix: a name is namespaced iff its leaf splits into >= 3 "__"-delimited segments (NS__Object__c). A 2-segment managed member with NO standard suffix (a managed Apex class / FieldSet / permission set named NS__Leaf, e.g. Demopkg__GadgetController) is ALSO claimed for that namespace, but ONLY when an InstalledPackage marker for NS is modelled in this vault — managed members of a package the refresh did not retrieve as an InstalledPackage stay invisible. This reliably catches namespaced objects, fields, and custom metadata — the bulk of what a package adds — but still MISSES managed Apex referenced via dot-notation (NS.ClassName). The vault holds only what `sf project retrieve` pulled: a package’s INTERNAL components are usually NOT retrieved, so packageComponentCount reflects what you can SEE, not the package’s full footprint. The verdict is deliberately staged so it can NEVER read soft-safe while a touchpoint or blind spot is present: "has-dependencies" (a component of yours references the namespace); "members-present-no-static-inbound" (the package HAS visible members in this vault but no STATIC inbound reference was found — you are carrying its metadata, so this is NOT "safe to uninstall"); "incomplete-scan" (the node/edge scan was truncated, so even the dependency search is not exhaustive); "review" (no visible members but the vault cannot PROVE the absence because a family that could reference the package was not fully retrieved); and only "no-detected-dependencies" when nothing hides a touchpoint — no visible members, a complete scan, and no coverage gap. Even that bare verdict means NO STATIC evidence in retrieved metadata, NOT proof the package is safe to uninstall (dynamic SOQL, Type.forName("NS.X"), merge-field/formula references, and unretrieved metadata are invisible). Always validate an uninstall in a sandbox first.';

/**
 * Zod schema for the `sfi.package_impact` tool input.
 *   - `namespace`: optional. Absent → INVENTORY mode (list every package).
 *     Present → IMPACT mode for that namespace (case-insensitive match).
 *   - `packageId` / `componentId` / `namespacePrefix`: optional package SELECTOR
 *     aliases — a bare namespace (`APXTConga4`) or an `InstalledPackage:<namespace>`
 *     id (exactly what `sfi.installed_package_catalog` returns). `namespacePrefix`
 *     is the Salesforce-shaped synonym a host reaches for (`{ namespacePrefix:
 *     'hed' }`); it used to be Zod-stripped, silently falling back to the full
 *     org-wide INVENTORY (PACKAGE-IMPACT-IGNORES-NAMESPACEPREFIX). All three are
 *     resolved to `namespace` (IMPACT mode) in the handler, so the impact-mode
 *     `namespace` + `mode: 'impact'` echo IS the applied-scope signal; an
 *     unrecognized selector (e.g. a `CustomObject:` id) is an `invalid-query`,
 *     NEVER a silent inventory fallback (mirrors PACKAGE-IMPACT-IGNORES-PACKAGE-ID).
 *   - `limit`: detail/sample cap (default 50, max 500).
 */
export const packageImpactInputSchema = z.object({
  namespace: z.string().min(1).optional(),
  packageId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  namespacePrefix: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type PackageImpactInput = z.infer<typeof packageImpactInputSchema>;

/** Canonical id prefix for an `InstalledPackage` node (`InstalledPackage:<namespace>`). */
const INSTALLED_PACKAGE_PREFIX = 'InstalledPackage:';

/**
 * Resolve a `packageId` / `componentId` selector to a package namespace, or
 * `null` when it is not a package selector this tool can honor.
 *
 *   - `InstalledPackage:APXTConga4` → `APXTConga4` (the catalog id shape).
 *   - `APXTConga4` (a bare token, no `:`) → `APXTConga4`.
 *   - `CustomObject:X` / any other typed id → `null` (caller gets `invalid-query`,
 *     never a silent full-inventory fallback).
 */
const deriveNamespaceFromSelector = (selector: string): string | null => {
  const trimmed = selector.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith(INSTALLED_PACKAGE_PREFIX)) {
    const ns = trimmed.slice(INSTALLED_PACKAGE_PREFIX.length).trim();
    return ns.length > 0 ? ns : null;
  }
  // A bare namespace token carries no ':'; any other typed component id is not a
  // package selector we can resolve to a namespace.
  return trimmed.includes(':') ? null : trimmed;
};

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

/**
 * The IMPACT-mode uninstall verdict (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND).
 * Staged so the enum a host acts on can NEVER read soft-safe while a package
 * touchpoint or blind spot is present — a caveat alone is insufficient because
 * the verdict is what a host keys its decision on:
 *
 *   - `has-dependencies`                  — a component of yours references the
 *     namespace (positive claim; carries no coverage caveat).
 *   - `members-present-no-static-inbound` — the package HAS visible members in
 *     this vault (`packageComponentCount > 0`) but NO static inbound reference
 *     was found. You are carrying its metadata: NOT a soft "safe to uninstall".
 *   - `incomplete-scan`                   — the node / edge scan was truncated,
 *     so even the dependency search is not exhaustive; absence is "not checked".
 *   - `review`                            — no visible members, but the vault
 *     cannot PROVE the absence: a producer family that could reference the
 *     package was not fully retrieved (a coverage gap ⇒ the caveat fired).
 *   - `no-detected-dependencies`          — the ONLY bare / soft verdict, and
 *     only when nothing hides a touchpoint: no visible members, a complete scan,
 *     and no coverage gap. Even then it means "no STATIC evidence", not "safe".
 */
export type PackageImpactVerdict =
  | 'has-dependencies'
  | 'members-present-no-static-inbound'
  | 'incomplete-scan'
  | 'review'
  | 'no-detected-dependencies';

/**
 * Pure verdict policy (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND). Precedence,
 * highest first, so the caveat and the verdict ALWAYS agree — the bare / soft
 * `no-detected-dependencies` is reached ONLY when every hiding signal is absent:
 *
 *   1. `hasInbound`     → `has-dependencies`               (a touchpoint exists)
 *   2. `scanIncomplete` → `incomplete-scan`                (search not exhaustive)
 *   3. `membersPresent` → `members-present-no-static-inbound` (you hold its metadata)
 *   4. `hasCaveat`      → `review`                         (absence not provable)
 *   5. otherwise        → `no-detected-dependencies`       (genuinely earned bare)
 *
 * INVARIANT (asserted in the tests): `hasCaveat` ⇒ result is NOT
 * `no-detected-dependencies`, and `no-detected-dependencies` ⇒ `!hasCaveat`. The
 * caller only computes a caveat when `!hasInbound`, so `has-dependencies` never
 * carries one either — a positive claim needs no absence hedge.
 */
export const packageVerdictFor = (args: {
  readonly hasInbound: boolean;
  readonly scanIncomplete: boolean;
  readonly membersPresent: boolean;
  readonly hasCaveat: boolean;
}): PackageImpactVerdict => {
  if (args.hasInbound) return 'has-dependencies';
  if (args.scanIncomplete) return 'incomplete-scan';
  if (args.membersPresent) return 'members-present-no-static-inbound';
  if (args.hasCaveat) return 'review';
  return 'no-detected-dependencies';
};

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
  readonly verdict: PackageImpactVerdict;
  readonly scanTruncated: boolean;
  readonly edgeScanTruncated: boolean;
  /**
   * GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE: present on any absence-based verdict
   * (`members-present-no-static-inbound` / `incomplete-scan` / `review`, and —
   * only on a coverage-unknown/legacy vault where nothing else fired — never on a
   * bare `no-detected-dependencies`) whose absence claim the vault cannot prove:
   * a family that could reference this package's components was not fully
   * retrieved / modeled, or the package HAS visible members / the scan was
   * truncated (the "members exist with empty inbound edges" trap). Absence is
   * only as strong as the coverage behind it, so the host must not read it as
   * "safe to uninstall". Computed through the SAME completeness helper as
   * `review_change` / `safe_to_delete_field` / `unused_components`. Never
   * co-occurs with `has-dependencies` (a positive claim) nor with a bare
   * `no-detected-dependencies` — the caveat and the verdict AGREE.
   */
  readonly coverageCaveat?: CoverageCaveat;
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

/**
 * Standard Salesforce leaf suffixes. A 2-segment leaf `A__B` whose `B` is one
 * of these is a suffixed API name (`Widget__c`, `Ledger__b`, `Gizmo__mdt`) —
 * i.e. YOUR component whose base name precedes a `__suffix`, NOT a
 * `Namespace__Leaf` managed member. The >=3-segment rule in {@link namespaceOf}
 * already handles namespaced suffixed names (`NS__Object__c`), so this guard
 * only scopes the 2-segment package-aware pass below.
 */
const RESERVED_LEAF_SUFFIXES: ReadonlySet<string> = new Set([
  'c', 'r', 'e', 'b', 'x', 'mdt', 'Share', 'History', 'Feed', 'Tag', 'ChangeEvent',
]);

/**
 * The namespaces of the managed/unlocked packages modelled in this vault, keyed
 * by lower-case (for case-insensitive match) with the canonical casing from the
 * `InstalledPackage` node as the value. Empty when the refresh modelled no
 * `InstalledPackage` metadata — in which case the 2-segment package-aware pass
 * is a no-op and detection is identical to the bare prefix heuristic.
 */
export const collectPackageNamespaces = (
  identities: readonly NodeIdentity[],
): ReadonlyMap<string, string> => {
  const known = new Map<string, string>();
  for (const node of identities) {
    if (node.type !== 'InstalledPackage') continue;
    // An InstalledPackage's fullName / apiName IS the namespace prefix.
    const ns = node.apiName.trim();
    if (ns.length === 0) continue;
    const lower = ns.toLowerCase();
    if (!known.has(lower)) known.set(lower, ns);
  }
  return known;
};

/**
 * Package-aware namespace resolver. First applies {@link namespaceOf} (the
 * >=3-segment rule); when that finds nothing, it runs a SECOND pass for
 * 2-segment managed member names — a `Namespace__Leaf` API name with NO
 * standard suffix (managed Apex classes, FieldSets, permission sets), which the
 * first rule alone misses and which made a real installed package read as empty
 * (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND). A 2-segment leaf `A__B` is
 * claimed for namespace `A` iff `A` is the namespace of an `InstalledPackage`
 * node in this vault AND `B` is not a {@link RESERVED_LEAF_SUFFIXES standard
 * suffix} — so `Widget__c` stays YOUR object and no namespace is invented from
 * an arbitrary `A__B` token. Returns the canonical namespace casing.
 *
 * @example
 *   const known = collectPackageNamespaces(identities); // { demopkg → 'Demopkg' }
 *   namespaceOfWithKnownPackages('ApexClass:Demopkg__GadgetController', known) // 'Demopkg'
 *   namespaceOfWithKnownPackages('FieldSet:Contact.Demopkg__GadgetFields', known) // 'Demopkg'
 *   namespaceOfWithKnownPackages('CustomObject:Widget__c', known)              // null (suffix)
 *   namespaceOfWithKnownPackages('ApexClass:Unknown__Helper', known)           // null (no marker)
 */
export const namespaceOfWithKnownPackages = (
  idOrName: string,
  known: ReadonlyMap<string, string>,
): string | null => {
  const base = namespaceOf(idOrName);
  if (base !== null) return base;
  if (known.size === 0) return null;
  const colon = idOrName.indexOf(':');
  const local = colon >= 0 ? idOrName.slice(colon + 1) : idOrName;
  const dot = local.lastIndexOf('.');
  const leaf = dot >= 0 ? local.slice(dot + 1) : local;
  const segments = leaf.split('__');
  if (segments.length !== 2) return null;
  const [head, tail] = segments;
  if (head === undefined || head.length === 0) return null;
  if (tail === undefined || tail.length === 0) return null; // trailing `__`
  if (RESERVED_LEAF_SUFFIXES.has(tail)) return null; // suffixed → your component
  return known.get(head.toLowerCase()) ?? null;
};

const buildInventory = (
  identities: readonly NodeIdentity[],
  scanTruncated: boolean,
  known: ReadonlyMap<string, string>,
): PackageImpactInventoryOutput => {
  const ownByNs = new Map<string, ComponentId[]>();
  const extByNs = new Map<string, ComponentId[]>();
  let totalNamespaced = 0;
  for (const node of identities) {
    const ns = namespaceOfWithKnownPackages(node.id, known);
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
      const parentNs = namespaceOfWithKnownPackages(node.parentId, known);
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
  known: ReadonlyMap<string, string>,
): Promise<Result<PackageImpactImpactOutput, McpError>> => {
  const target = rawNamespace.trim();
  const targetLc = target.toLowerCase();
  const typeById = new Map<ComponentId, ComponentType>();
  for (const node of identities) typeById.set(node.id, node.type);

  const packageNodes = identities.filter(
    (n) => (namespaceOfWithKnownPackages(n.id, known) ?? '').toLowerCase() === targetLc,
  );

  // Your components grafted onto a package component (parent in-namespace,
  // child not). These orphan on uninstall.
  const extensions: PackageExtension[] = [];
  for (const node of identities) {
    if (node.parentId === null) continue;
    const ownNs = (namespaceOfWithKnownPackages(node.id, known) ?? '').toLowerCase();
    if (ownNs === targetLc) continue; // a package node under another package node
    const parentNs = (namespaceOfWithKnownPackages(node.parentId, known) ?? '').toLowerCase();
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
      const fromNs = namespaceOfWithKnownPackages(edge.fromId, known);
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

  // W6.1 (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND — targetMissing touchpoints,
  // incl. the grant-only count residual): a managed package's INTERNAL components
  // are usually never retrieved, so a reference from YOUR code to
  // `Ns__ManagedThing` (an Apex `callout:` / cross-class call) — or, the residual
  // this closes, a PermissionSet/Profile GRANT of a managed Apex class
  // (`grantedBy` -> `Ns__AdminService`) — points at a node that does not exist in
  // the graph: a dangling / `targetMissing` edge. The retrieved-node scan above
  // cannot see those because the phantom target is not in `packageNodes`, so the
  // grant touchpoint was being DROPPED and `yourDependencyTotal` UNDER-COUNTED the
  // package footprint (a grant of a managed class IS a footprint touchpoint).
  //
  // Recover the COMPLETE set: `danglingTargetIdsMatching` returns every dangling
  // target id in this namespace WITHOUT a per-group sample cap — the earlier
  // `danglingTargetSummary` pass sampled only 50 distinct missing targets per
  // `(targetType, edgeType, confidence)` group, so on a busy real vault (dozens of
  // packages granting managed Apex) a namespace whose members sort late — e.g.
  // `SparkTable__*` — fell outside the smallest-50 window and its grant was
  // under-counted. The namespace rule below is authoritative; the SQL substring is
  // only a bound. `listEdges` keys on `to_id`, so it returns the referrers of a
  // phantom target even though no node exists for it.
  const danglingRes = await danglingTargetIdsMatching(ctx.graph, target);
  if (!danglingRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${danglingRes.error.message}` });
  }
  const phantomTargets = new Set<ComponentId>();
  for (const targetId of danglingRes.value) {
    if ((namespaceOfWithKnownPackages(targetId, known) ?? '').toLowerCase() === targetLc) {
      phantomTargets.add(targetId);
    }
  }
  for (const phantomId of phantomTargets) {
    const r = await listEdges(ctx.graph, phantomId, { direction: 'in' });
    if (!r.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${r.error.message}` });
    }
    for (const edge of r.value) {
      if (edge.edgeType === 'parentOf') continue; // containment, not a dependency
      const fromNs = namespaceOfWithKnownPackages(edge.fromId, known);
      if ((fromNs ?? '').toLowerCase() === targetLc) continue; // intra-package edge
      const key = `${edge.fromId} ${edge.edgeType} ${phantomId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push({
        fromId: edge.fromId,
        fromType: typeById.get(edge.fromId) ?? null,
        fromNamespace: fromNs,
        edgeType: edge.edgeType,
        confidence: edge.confidence,
        toId: phantomId,
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

  // W6.2 (GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE verdict policy — PACKAGE-IMPACT-
  // TWO-SEGMENT-NAMESPACE-BLIND residual). An absence-based verdict reads as a
  // soft "safe to uninstall"; it is only as strong as (a) the coverage of the
  // families that COULD hold a reference AND (b) the completeness of the scan.
  // When the package HAS visible members (members > 0) or the node / edge scan
  // was truncated, absence is "not checked" even on a vault that carries no
  // coverage rows, so fail HARDER (`fireOnUnknownCoverage`) — the "members exist
  // with empty inbound edges" trap the finding cites. When there are no visible
  // members and the scan was complete, a KNOWN coverage gap still caveats but a
  // fully-covered / genuinely-absent namespace stays bare. Routed through the
  // SHARED L1 helper so package_impact, review_change, safe_to_delete_field and
  // unused_components share ONE completeness contract (`InstalledPackage` is
  // unmapped → the broad DEFAULT producer union). A POSITIVE `has-dependencies`
  // claim never carries the absence caveat.
  const hasInbound = dependencies.length > 0 || extensions.length > 0;
  const membersPresent = packageNodes.length > 0;
  const scanIncomplete = scanTruncated || edgeScanTruncated;
  const coverageCaveat = hasInbound
    ? undefined
    : buildUsageSourceCoverageCaveat(
        ctx,
        'InstalledPackage',
        `No component of yours referencing the \`${target}\` package`,
        { fireOnUnknownCoverage: membersPresent || scanIncomplete },
      );

  // The verdict AGREES with the caveat: a caveat, visible members, or a
  // truncated scan each force a truthful NON-soft verdict, so the bare
  // `no-detected-dependencies` a host reads as "safe-ish to uninstall" survives
  // ONLY when nothing hides a touchpoint (no members, complete scan, no gap).
  const verdict = packageVerdictFor({
    hasInbound,
    scanIncomplete,
    membersPresent,
    hasCaveat: coverageCaveat !== undefined,
  });

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
    ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
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
  // Namespaces of the InstalledPackage markers in this vault — enables the
  // 2-segment `Namespace__Leaf` managed-member pass
  // (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND).
  const known = collectPackageNamespaces(identities);

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  // Resolve the effective IMPACT namespace. `namespace` wins; otherwise a
  // `namespacePrefix` / `packageId` / `componentId` selector (a bare namespace or
  // an `InstalledPackage:<namespace>` catalog id) is honored. `namespacePrefix`
  // is the Salesforce-shaped synonym that used to be silently dropped into full
  // INVENTORY (PACKAGE-IMPACT-IGNORES-NAMESPACEPREFIX). A selector that is present
  // but unrecognizable is an `invalid-query` — NEVER a silent fall-back to full
  // inventory (mirrors PACKAGE-IMPACT-IGNORES-PACKAGE-ID).
  let effectiveNamespace = input.namespace;
  if (effectiveNamespace === undefined) {
    const selectorKey =
      input.namespacePrefix !== undefined
        ? 'namespacePrefix'
        : input.packageId !== undefined
          ? 'packageId'
          : 'componentId';
    const selector = input.namespacePrefix ?? input.packageId ?? input.componentId;
    if (selector !== undefined) {
      const resolved = deriveNamespaceFromSelector(selector);
      if (resolved === null) {
        return err({
          kind: 'invalid-query',
          message:
            `${selectorKey} '${selector}' is not a package selector — pass a namespace ` +
            `(e.g. 'APXTConga4') or an 'InstalledPackage:<namespace>' id, or set 'namespace' directly.`,
          path: selectorKey,
        });
      }
      effectiveNamespace = resolved;
    }
  }

  if (effectiveNamespace === undefined) {
    return ok({ data: buildInventory(identities, scanTruncated, known), vaultState });
  }

  const impact = await buildImpact(
    ctx,
    identities,
    scanTruncated,
    effectiveNamespace,
    limit,
    known,
  );
  if (!impact.ok) return impact;
  return ok({ data: impact.value, vaultState });
};
