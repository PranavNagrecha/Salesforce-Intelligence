/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
  type NodeIdentity,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { DEFAULT_USAGE_SOURCE_FAMILIES } from '../../src/tools/coverage-trust.js';
import {
  collectPackageNamespaces,
  namespaceOf,
  namespaceOfWithKnownPackages,
  packageImpactHandler,
  packageImpactInputSchema,
  packageVerdictFor,
  type PackageImpactVerdict,
} from '../../src/tools/package-impact.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-pkg',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// SBQQ package: an object, a package field on it, and a package field on the
// standard Account. MyExt__c is YOUR field on THEIR object (an extension).
// OrderService reads a package field (a dependency). VLOC is a second package
// with no entanglement. Payment__c / LonelyHelper are unmanaged.
const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:SBQQ__Quote__c', type: 'CustomObject', apiName: 'SBQQ__Quote__c' }),
    makeNode({
      id: 'CustomField:SBQQ__Quote__c.SBQQ__Status__c',
      type: 'CustomField',
      apiName: 'SBQQ__Status__c',
      parentId: 'CustomObject:SBQQ__Quote__c',
    }),
    makeNode({
      id: 'CustomField:SBQQ__Quote__c.MyExt__c',
      type: 'CustomField',
      apiName: 'MyExt__c',
      parentId: 'CustomObject:SBQQ__Quote__c',
    }),
    makeNode({
      id: 'CustomField:Account.SBQQ__Ext__c',
      type: 'CustomField',
      apiName: 'SBQQ__Ext__c',
      parentId: 'CustomObject:Account',
    }),
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({ id: 'CustomObject:Payment__c', type: 'CustomObject', apiName: 'Payment__c' }),
    makeNode({ id: 'ApexClass:OrderService', type: 'ApexClass', apiName: 'OrderService' }),
    makeNode({ id: 'ApexClass:LonelyHelper', type: 'ApexClass', apiName: 'LonelyHelper' }),
    makeNode({ id: 'CustomObject:VLOC__Thing__c', type: 'CustomObject', apiName: 'VLOC__Thing__c' }),
  ],
  edges: [
    // Containment — must be EXCLUDED from dependency counting even when the
    // parent (Account) is outside the namespace.
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.SBQQ__Ext__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'CustomObject:SBQQ__Quote__c', toId: 'CustomField:SBQQ__Quote__c.SBQQ__Status__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'CustomObject:SBQQ__Quote__c', toId: 'CustomField:SBQQ__Quote__c.MyExt__c', edgeType: 'parentOf' }),
    // The real boundary dependency: your Apex reads a package field.
    makeEdge({
      fromId: 'ApexClass:OrderService',
      toId: 'CustomField:SBQQ__Quote__c.SBQQ__Status__c',
      edgeType: 'readsFrom',
      confidence: 'heuristic',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pkg-'));
  const opened = await openGraph(join(tempDir, 'pkg.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('namespaceOf', () => {
  it('detects a namespaced object', () => {
    expect(namespaceOf('CustomObject:SBQQ__Quote__c')).toBe('SBQQ');
  });
  it('detects a package field on a standard object', () => {
    expect(namespaceOf('CustomField:Account.SBQQ__Ext__c')).toBe('SBQQ');
  });
  it('treats YOUR field on a package object as unmanaged (leaf decides)', () => {
    expect(namespaceOf('CustomField:SBQQ__Quote__c.MyExt__c')).toBeNull();
  });
  it('does not flag a plain custom object', () => {
    expect(namespaceOf('CustomObject:Payment__c')).toBeNull();
  });
  it('does not flag a standard component', () => {
    expect(namespaceOf('ApexClass:OrderService')).toBeNull();
    expect(namespaceOf('CustomField:Account.Name')).toBeNull();
  });
  it('works on a bare api name without a Type prefix', () => {
    expect(namespaceOf('SBQQ__Quote__c')).toBe('SBQQ');
  });
});

describe('packageImpactHandler — inventory mode', () => {
  it('lists packages by component count, most-entangled first', async () => {
    const r = await packageImpactHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'inventory') return;
    const names = r.value.data.packages.map((p) => p.namespace);
    expect(names).toEqual(['SBQQ', 'VLOC']);
    const sbqq = r.value.data.packages.find((p) => p.namespace === 'SBQQ');
    expect(sbqq?.componentCount).toBe(3);
    // MyExt__c is YOUR field on SBQQ__Quote__c — counted as an extension, not a
    // package component, and not in totalNamespacedComponents.
    expect(sbqq?.extensionCount).toBe(1);
    expect(r.value.data.totalNamespacedComponents).toBe(4);
  });

  it('does not classify unmanaged custom objects as a package', async () => {
    const r = await packageImpactHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'inventory') return;
    const names = r.value.data.packages.map((p) => p.namespace);
    expect(names).not.toContain('Payment');
    expect(names).not.toContain('Account');
  });

  it('surfaces a package present ONLY via your extensions (phantom package object — managed-package-style, B27)', async () => {
    // A managed object (ns__Widget__c) is a phantom — its own definition was
    // never retrieved, so no node carries the `ns` prefix. But you added a
    // layout to it. Inventory must still report `ns` as installed
    // (componentCount 0, extensionCount > 0), not "no packages".
    const dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pkg-phantom-'));
    const opened = await openGraph(join(dir, 'phantom.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const local = opened.value;
    const imp = await importExtractionResults(local, [
      {
        nodes: [
          makeNode({
            id: 'Layout:ns__Widget__c.Widget Layout',
            type: 'Layout',
            apiName: 'Widget Layout',
            parentId: 'CustomObject:ns__Widget__c', // phantom: no node for it
          }),
        ],
        edges: [],
      },
    ]);
    expect(imp.ok).toBe(true);
    const localCtx: Context = {
      vaultRoot: dir,
      manifest: FIXTURE_MANIFEST,
      graph: local,
    };
    const r = await packageImpactHandler(localCtx, {});
    await closeGraph(local);
    rmSync(dir, { recursive: true, force: true });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'inventory') return;
    const ns = r.value.data.packages.find((p) => p.namespace === 'ns');
    expect(ns).toBeDefined();
    expect(ns?.componentCount).toBe(0);
    expect(ns?.extensionCount).toBe(1);
    // totalNamespacedComponents counts OWN namespaced nodes only (here 0).
    expect(r.value.data.totalNamespacedComponents).toBe(0);
  });
});

describe('packageImpactHandler — impact mode', () => {
  it('reports your dependencies on the package (uninstall blast radius)', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'SBQQ' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(3);
    const deps = r.value.data.yourDependencies.map((d) => d.fromId);
    expect(deps).toContain('ApexClass:OrderService');
    expect(r.value.data.dependentComponentCount).toBe(1);
    expect(r.value.data.verdict).toBe('has-dependencies');
  });

  it('excludes parentOf containment edges from dependencies', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'SBQQ' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    const deps = r.value.data.yourDependencies.map((d) => d.fromId);
    // Account is only linked via parentOf to a package field — not a dependency.
    expect(deps).not.toContain('CustomObject:Account');
  });

  it('surfaces your fields grafted onto a package object as extensions', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'SBQQ' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    const ext = r.value.data.yourExtensions.map((e) => e.id);
    expect(ext).toContain('CustomField:SBQQ__Quote__c.MyExt__c');
    expect(r.value.data.yourExtensionTotal).toBe(1);
  });

  it('matches the namespace case-insensitively', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'sbqq' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(3);
  });

  // VLOC HAS a visible member (VLOC__Thing__c) but no inbound edges — the
  // SparkTable-shaped "members present with empty inbound" case. The verdict is
  // NOT the soft `no-detected-dependencies`: a member in the vault IS a package
  // touchpoint (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND).
  it('returns members-present-no-static-inbound for a package with members but no inbound', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'VLOC' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(1);
    expect(r.value.data.yourDependencies.length).toBe(0);
    expect(r.value.data.yourExtensions.length).toBe(0);
    expect(r.value.data.verdict).toBe('members-present-no-static-inbound');
    expect(r.value.data.verdict).not.toBe('no-detected-dependencies');
  });

  it('handles a namespace absent from the vault honestly', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'GHOSTNS' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(0);
    // No members, complete scan, coverage-unknown vault → the genuinely-earned
    // bare verdict (no caveat can fire on a legacy vault).
    expect(r.value.data.verdict).toBe('no-detected-dependencies');
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  // GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE (Fixture C): a `no-detected-dependencies`
  // verdict over a vault that did not retrieve a family that COULD reference the
  // package must carry the SHARED completeness caveat — an absence claim is only
  // as strong as the coverage behind it. FAILS pre-fix (no caveat field existed).
  it('FLIP: an absence-based verdict on a coverage-degraded vault carries a coverageCaveat', async () => {
    const degraded: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        { type: 'ApexClass', requested: true, retrieved: 1, errored: false, neverModeled: false },
        // A producer family that was requested but returned nothing / errored →
        // "not checked", so absence of dependents cannot be proven.
        { type: 'Flow', requested: true, retrieved: 0, errored: true, neverModeled: false },
      ],
      coverageComputedAt: '2026-05-29T12:00:00.000Z',
    };
    const r = await packageImpactHandler(
      { ...ctx, manifest: degraded },
      { namespace: 'VLOC' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    // VLOC has a visible member, so the verdict is members-present (never the
    // soft `no-detected-dependencies`), and the caveat AGREES with it.
    expect(r.value.data.verdict).toBe('members-present-no-static-inbound');
    expect(r.value.data.verdict).not.toBe('no-detected-dependencies');
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain('Flow');
  });

  // STAYS SILENT: a has-dependencies verdict is a POSITIVE claim (we found
  // dependents), so it never carries the absence caveat — even coverage-degraded.
  it('STAYS SILENT: a has-dependencies verdict carries no coverageCaveat', async () => {
    const degraded: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        { type: 'Flow', requested: true, retrieved: 0, errored: true, neverModeled: false },
      ],
      coverageComputedAt: '2026-05-29T12:00:00.000Z',
    };
    const r = await packageImpactHandler(
      { ...ctx, manifest: degraded },
      { namespace: 'SBQQ' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.verdict).toBe('has-dependencies');
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('surfaces the verbatim honesty disclosure', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'SBQQ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/no-detected-dependencies/);
    expect(r.value.data.disclosure).toMatch(/sandbox/);
  });
});

// =============================================================================
// Package-id selector aliases — PACKAGE-IMPACT-IGNORES-PACKAGE-ID.
// A packageId / componentId (the `InstalledPackage:<ns>` id the catalog
// returns, or a bare namespace) must drive IMPACT mode — never be silently
// dropped into full INVENTORY.
// =============================================================================
describe('packageImpactHandler — package-id selector aliases', () => {
  it('routes an InstalledPackage: packageId into IMPACT mode (not inventory)', async () => {
    const r = await packageImpactHandler(ctx, { packageId: 'InstalledPackage:SBQQ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('impact');
    if (r.value.data.mode !== 'impact') return;
    expect(r.value.data.namespace).toBe('SBQQ');
    expect(r.value.data.packageComponentCount).toBe(3);
    expect(r.value.data.verdict).toBe('has-dependencies');
  });

  it('routes an InstalledPackage: componentId (the catalog id shape) into IMPACT mode', async () => {
    const r = await packageImpactHandler(ctx, { componentId: 'InstalledPackage:SBQQ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('impact');
    if (r.value.data.mode !== 'impact') return;
    expect(r.value.data.namespace).toBe('SBQQ');
    expect(r.value.data.packageComponentCount).toBe(3);
  });

  it('accepts a bare namespace via packageId', async () => {
    const r = await packageImpactHandler(ctx, { packageId: 'SBQQ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('impact');
    if (r.value.data.mode !== 'impact') return;
    expect(r.value.data.namespace).toBe('SBQQ');
    expect(r.value.data.packageComponentCount).toBe(3);
  });

  it('an explicit namespace wins over a selector', async () => {
    const r = await packageImpactHandler(ctx, {
      namespace: 'VLOC',
      packageId: 'InstalledPackage:SBQQ',
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.namespace).toBe('VLOC');
  });

  it('rejects an unrecognized selector with invalid-query — never a silent inventory fallback', async () => {
    const r = await packageImpactHandler(ctx, { componentId: 'CustomObject:Payment__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('componentId');
  });
});

// =============================================================================
// PACKAGE-IMPACT-IGNORES-NAMESPACEPREFIX — the Salesforce-shaped `namespacePrefix`
// synonym must drive IMPACT mode (identical to `namespace`), never be silently
// dropped into full INVENTORY. Cousin of the shipped installed_package_catalog
// namespacePrefix fix and the sibling packageId/componentId selector fix.
// =============================================================================
describe('packageImpactHandler — namespacePrefix selector', () => {
  it('routes a bare namespacePrefix into IMPACT mode (not inventory)', async () => {
    const r = await packageImpactHandler(ctx, { namespacePrefix: 'SBQQ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('impact');
    if (r.value.data.mode !== 'impact') return;
    expect(r.value.data.namespace).toBe('SBQQ');
    expect(r.value.data.packageComponentCount).toBe(3);
    expect(r.value.data.verdict).toBe('has-dependencies');
  });

  it('matches namespacePrefix case-insensitively (identical to namespace)', async () => {
    const r = await packageImpactHandler(ctx, { namespacePrefix: 'sbqq' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(3);
  });

  it('accepts an InstalledPackage:<ns> id via namespacePrefix', async () => {
    const r = await packageImpactHandler(ctx, {
      namespacePrefix: 'InstalledPackage:SBQQ',
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.namespace).toBe('SBQQ');
    expect(r.value.data.packageComponentCount).toBe(3);
  });

  it('an explicit namespace wins over namespacePrefix', async () => {
    const r = await packageImpactHandler(ctx, {
      namespace: 'VLOC',
      namespacePrefix: 'SBQQ',
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.namespace).toBe('VLOC');
  });

  it('a namespacePrefix matching nothing is an HONEST miss (impact/empty), not full inventory', async () => {
    const r = await packageImpactHandler(ctx, { namespacePrefix: 'GHOSTNS' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Impact mode with an empty package — NOT the multi-package inventory.
    expect(r.value.data.mode).toBe('impact');
    if (r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(0);
    expect(r.value.data.verdict).toBe('no-detected-dependencies');
  });

  it('rejects an unrecognized namespacePrefix selector with invalid-query — never a silent inventory fallback', async () => {
    const r = await packageImpactHandler(ctx, {
      namespacePrefix: 'CustomObject:Payment__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('namespacePrefix');
  });
});

describe('packageImpactInputSchema', () => {
  it('accepts an empty object (inventory mode)', () => {
    expect(packageImpactInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a namespacePrefix selector', () => {
    expect(
      packageImpactInputSchema.safeParse({ namespacePrefix: 'hed' }).success,
    ).toBe(true);
  });
  it('accepts a namespace + limit', () => {
    expect(
      packageImpactInputSchema.safeParse({ namespace: 'SBQQ', limit: 10 }).success,
    ).toBe(true);
  });
  it('accepts packageId / componentId selectors', () => {
    expect(
      packageImpactInputSchema.safeParse({ packageId: 'InstalledPackage:SBQQ' }).success,
    ).toBe(true);
    expect(
      packageImpactInputSchema.safeParse({ componentId: 'InstalledPackage:SBQQ' }).success,
    ).toBe(true);
  });
  it('rejects a limit over 500', () => {
    expect(
      packageImpactInputSchema.safeParse({ namespace: 'SBQQ', limit: 501 }).success,
    ).toBe(false);
  });
});

// =============================================================================
// PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND
// A managed member named `Namespace__Leaf` with NO standard suffix (a managed
// Apex class / FieldSet / permission set) splits into only 2 `__`-segments, so
// the >=3-segment rule alone misses it and a real installed package reads as
// EMPTY (packageComponentCount 0 → no-detected-dependencies). When an
// `InstalledPackage:<ns>` marker for that namespace is in the vault, those
// 2-segment members must join the package. Guard fails pre-fix (bare
// `namespaceOf` returns null for both members).
// =============================================================================
describe('namespaceOfWithKnownPackages — two-segment managed members', () => {
  const known = new Map<string, string>([['demopkg', 'Demopkg']]);

  it('claims a 2-segment managed Apex class for the known namespace', () => {
    expect(
      namespaceOfWithKnownPackages('ApexClass:Demopkg__GadgetController', known),
    ).toBe('Demopkg');
  });

  it('claims a 2-segment managed FieldSet on a standard object', () => {
    expect(
      namespaceOfWithKnownPackages('FieldSet:Contact.Demopkg__GadgetFields', known),
    ).toBe('Demopkg');
  });

  it('does NOT claim a suffixed 2-segment name (your object) even under a known ns', () => {
    // `Widget__c` is YOUR object — `c` is a standard suffix, not a leaf name.
    expect(namespaceOfWithKnownPackages('CustomObject:Widget__c', known)).toBeNull();
    // Even if the base collided with a package namespace, the suffix wins.
    expect(namespaceOfWithKnownPackages('CustomObject:Demopkg__c', known)).toBeNull();
  });

  it('does NOT invent a namespace when no InstalledPackage marker matches', () => {
    expect(namespaceOfWithKnownPackages('ApexClass:Unknown__Helper', known)).toBeNull();
    expect(namespaceOfWithKnownPackages('ApexClass:Demopkg__GadgetHelper', new Map())).toBeNull();
  });

  it('still honors the 3+-segment rule regardless of markers', () => {
    expect(namespaceOfWithKnownPackages('CustomObject:SBQQ__Quote__c', new Map())).toBe('SBQQ');
  });
});

describe('collectPackageNamespaces', () => {
  it('keys InstalledPackage namespaces lower-case → canonical casing', () => {
    const identities: NodeIdentity[] = [
      { id: 'InstalledPackage:Demopkg', type: 'InstalledPackage', apiName: 'Demopkg', parentId: null },
      { id: 'InstalledPackage:SBQQ', type: 'InstalledPackage', apiName: 'SBQQ', parentId: null },
      { id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account', parentId: null },
    ];
    const known = collectPackageNamespaces(identities);
    expect(known.get('demopkg')).toBe('Demopkg');
    expect(known.get('sbqq')).toBe('SBQQ');
    expect(known.size).toBe(2);
  });
});

describe('packageImpactHandler — two-segment package members (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND)', () => {
  let dir: string;
  let local: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pkg-2seg-'));
    const opened = await openGraph(join(dir, 'twoseg.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    local = opened.value;
    // Demopkg managed package: an InstalledPackage marker + two 2-segment
    // managed members (Apex class, FieldSet). A PermissionSet grants the class
    // (a your-side dependency). Widget__c is YOUR object (must NOT be a pkg).
    const imp = await importExtractionResults(local, [
      {
        nodes: [
          makeNode({ id: 'InstalledPackage:Demopkg', type: 'InstalledPackage', apiName: 'Demopkg' }),
          makeNode({
            id: 'ApexClass:Demopkg__GadgetController',
            type: 'ApexClass',
            apiName: 'Demopkg__GadgetController',
          }),
          makeNode({
            id: 'FieldSet:Contact.Demopkg__GadgetFields',
            type: 'FieldSet',
            apiName: 'Demopkg__GadgetFields',
            parentId: 'CustomObject:Contact',
          }),
          makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
          makeNode({ id: 'PermissionSet:MartechAdmin', type: 'PermissionSet', apiName: 'MartechAdmin' }),
          makeNode({ id: 'CustomObject:Widget__c', type: 'CustomObject', apiName: 'Widget__c' }),
        ],
        edges: [
          makeEdge({
            fromId: 'PermissionSet:MartechAdmin',
            toId: 'ApexClass:Demopkg__GadgetController',
            edgeType: 'grantedBy',
            confidence: 'declared',
          }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: local };
  });

  afterAll(async () => {
    await closeGraph(local);
    rmSync(dir, { recursive: true, force: true });
  });

  it('inventory lists the package with its 2-segment members (was omitted)', async () => {
    const r = await packageImpactHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'inventory') return;
    const pkg = r.value.data.packages.find((p) => p.namespace === 'Demopkg');
    expect(pkg).toBeDefined();
    // The managed Apex class + managed FieldSet both count as own components.
    expect(pkg?.componentCount).toBe(2);
    // Widget__c stays YOUR object — never a package.
    expect(r.value.data.packages.map((p) => p.namespace)).not.toContain('Widget');
  });

  it('impact reports members + a real dependency (not no-detected-dependencies)', async () => {
    const r = await packageImpactHandler(localCtx, { namespace: 'Demopkg' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(2);
    expect(r.value.data.packageComponentSample).toContain(
      'FieldSet:Contact.Demopkg__GadgetFields',
    );
    const deps = r.value.data.yourDependencies.map((d) => d.fromId);
    expect(deps).toContain('PermissionSet:MartechAdmin');
    expect(r.value.data.verdict).toBe('has-dependencies');
  });

  it('routes the InstalledPackage catalog id into a non-empty impact', async () => {
    const r = await packageImpactHandler(localCtx, {
      componentId: 'InstalledPackage:Demopkg',
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.namespace).toBe('Demopkg');
    expect(r.value.data.packageComponentCount).toBe(2);
    expect(r.value.data.verdict).toBe('has-dependencies');
  });
});

// =============================================================================
// W6.1 — targetMissing package touchpoints (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-
// BLIND residual). A managed package's INTERNAL components are usually never
// retrieved, so a reference from YOUR code to `Ns__ManagedThing` points at a
// node that does NOT exist in the graph (a dangling / targetMissing edge). The
// retrieved-node inbound scan cannot see those — the phantom target is not a
// package NODE — so the touchpoint was DROPPED and a USED package read as
// `no-detected-dependencies` (a soft "safe to uninstall"). The dangling-target
// pass must recover them. Guard FAILS pre-fix (no phantom pass → 0 deps →
// no-detected-dependencies).
// =============================================================================
describe('packageImpactHandler — W6.1 targetMissing package touchpoints', () => {
  let dir: string;
  let local: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pkg-phantom-touch-'));
    const opened = await openGraph(join(dir, 'phantomtouch.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    local = opened.value;
    // Ns package: only the InstalledPackage marker is retrieved — its Apex
    // internals are phantoms. Your class references `Ns__Helper` (2-segment
    // managed member) and a PermissionSet grants `Ns__AdminService` — BOTH
    // targets are missing nodes (dangling edges). A PascalCase non-namespaced
    // reference (`YourHelper`) must NOT be claimed.
    const imp = await importExtractionResults(local, [
      {
        nodes: [
          makeNode({ id: 'InstalledPackage:Ns', type: 'InstalledPackage', apiName: 'Ns' }),
          makeNode({ id: 'ApexClass:My_Caller', type: 'ApexClass', apiName: 'My_Caller' }),
          makeNode({ id: 'PermissionSet:My_PermSet', type: 'PermissionSet', apiName: 'My_PermSet' }),
        ],
        edges: [
          makeEdge({
            fromId: 'ApexClass:My_Caller',
            toId: 'ApexClass:Ns__Helper', // phantom: no node
            edgeType: 'references',
            confidence: 'heuristic',
          }),
          makeEdge({
            fromId: 'PermissionSet:My_PermSet',
            toId: 'ApexClass:Ns__AdminService', // phantom: no node — grant-only touchpoint
            edgeType: 'grantedBy',
            confidence: 'declared',
          }),
          makeEdge({
            fromId: 'ApexClass:My_Caller',
            toId: 'ApexClass:YourHelper', // phantom but NOT namespaced — must be ignored
            edgeType: 'references',
            confidence: 'heuristic',
          }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: local };
  });

  afterAll(async () => {
    await closeGraph(local);
    rmSync(dir, { recursive: true, force: true });
  });

  it('claims targetMissing Ns__* references as touchpoints (has-dependencies, was no-detected)', async () => {
    const r = await packageImpactHandler(localCtx, { namespace: 'Ns' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    // The package's own components were never retrieved — only phantom refs exist.
    expect(r.value.data.packageComponentCount).toBe(0);
    const deps = r.value.data.yourDependencies;
    const pairs = deps.map((d) => `${d.fromId} -> ${d.toId}`);
    expect(pairs).toContain('ApexClass:My_Caller -> ApexClass:Ns__Helper');
    // Grant-only touchpoints are claimed too (don't drop them).
    expect(pairs).toContain('PermissionSet:My_PermSet -> ApexClass:Ns__AdminService');
    // The non-namespaced phantom (`YourHelper`) is NOT a package touchpoint.
    expect(pairs.some((p) => p.includes('YourHelper'))).toBe(false);
    // The verdict flips off the soft "safe to uninstall".
    expect(r.value.data.verdict).toBe('has-dependencies');
  });
});

// =============================================================================
// W6.2 — verdict policy (GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE). A
// `no-detected-dependencies` verdict reads as a soft "safe to uninstall". When
// the package HAS visible members but the vault carries no coverage rows, that
// absence is "not checked" — the "members exist with empty inbound edges" trap.
// The verdict must carry the shared completeness caveat (fail-harder), yet STAY
// bare on a fully-covered vault (calibrated, not a blanket floor).
// =============================================================================
describe('packageImpactHandler — W6.2 verdict policy (members-present not bare)', () => {
  const completeCoverage = {
    ...FIXTURE_MANIFEST,
    coverage: DEFAULT_USAGE_SOURCE_FAMILIES.map((type) => ({
      type,
      requested: true,
      retrieved: 2,
      errored: false,
      neverModeled: false,
    })),
    coverageComputedAt: '2026-05-29T12:00:00.000Z',
  };

  // FLIP: VLOC has a visible member (VLOC__Thing__c) but zero inbound edges, on
  // a vault with NO coverage rows. Pre-fix this was bare `no-detected-
  // dependencies` (buildEnumerationCoverageCaveatFor returns undefined on a
  // coverage-unknown vault); the fix fails HARDER because members exist.
  it('FLIP: a package WITH members but empty inbound on an unknown-coverage vault carries a caveat', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'VLOC' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(1); // members > 0
    expect(r.value.data.yourDependencies.length).toBe(0); // empty inbound
    // Verdict is NOT the soft `no-detected-dependencies` — members present is a
    // touchpoint — and the completeness caveat AGREES with it.
    expect(r.value.data.verdict).toBe('members-present-no-static-inbound');
    expect(r.value.data.verdict).not.toBe('no-detected-dependencies');
    expect(r.value.data.coverageCaveat).toBeDefined();
  });

  // STAYS NON-SOFT: the SAME members-present package on a FULLY covered vault
  // drops the caveat (absence is now proven) but the verdict STILL reflects the
  // member touchpoint — never the soft `no-detected-dependencies`.
  it('STAYS NON-SOFT: the same package on a fully-covered vault keeps members-present, drops the caveat', async () => {
    const r = await packageImpactHandler(
      { ...ctx, manifest: completeCoverage },
      { namespace: 'VLOC' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(1);
    expect(r.value.data.verdict).toBe('members-present-no-static-inbound');
    expect(r.value.data.verdict).not.toBe('no-detected-dependencies');
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });
});

// =============================================================================
// PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND (W6 residual) — verdict enum ⇔
// caveat AGREEMENT. The QA-witnessed bug: a SparkTable-shaped two-segment member
// yields `packageComponentCount: 1` yet the verdict was still the soft
// `no-detected-dependencies` (only a coverageCaveat was attached). A caveat alone
// is insufficient — the verdict is what a host acts on. These lock the truthful
// enum: members present / touchpoint / incomplete scan ⇒ NOT soft-uninstall, and
// the bare `no-detected-dependencies` survives ONLY when nothing hides a
// touchpoint.
// =============================================================================
describe('packageVerdictFor — pure verdict policy (enum ⇔ caveat agreement)', () => {
  it('a touchpoint (inbound edge) → has-dependencies, regardless of the rest', () => {
    expect(
      packageVerdictFor({ hasInbound: true, scanIncomplete: false, membersPresent: false, hasCaveat: false }),
    ).toBe('has-dependencies');
    expect(
      packageVerdictFor({ hasInbound: true, scanIncomplete: true, membersPresent: true, hasCaveat: false }),
    ).toBe('has-dependencies');
  });

  it('a truncated scan → incomplete-scan (search not exhaustive)', () => {
    expect(
      packageVerdictFor({ hasInbound: false, scanIncomplete: true, membersPresent: false, hasCaveat: true }),
    ).toBe('incomplete-scan');
  });

  it('visible members but no inbound → members-present-no-static-inbound (the SparkTable trap)', () => {
    expect(
      packageVerdictFor({ hasInbound: false, scanIncomplete: false, membersPresent: true, hasCaveat: true }),
    ).toBe('members-present-no-static-inbound');
    // still non-soft even when fully covered (no caveat).
    expect(
      packageVerdictFor({ hasInbound: false, scanIncomplete: false, membersPresent: true, hasCaveat: false }),
    ).toBe('members-present-no-static-inbound');
  });

  it('no members but an un-provable absence (caveat) → review', () => {
    expect(
      packageVerdictFor({ hasInbound: false, scanIncomplete: false, membersPresent: false, hasCaveat: true }),
    ).toBe('review');
  });

  it('nothing hides a touchpoint → the bare no-detected-dependencies', () => {
    expect(
      packageVerdictFor({ hasInbound: false, scanIncomplete: false, membersPresent: false, hasCaveat: false }),
    ).toBe('no-detected-dependencies');
  });

  it('INVARIANT: a caveat NEVER co-occurs with the soft no-detected-dependencies', () => {
    const bools = [false, true];
    for (const scanIncomplete of bools) {
      for (const membersPresent of bools) {
        // A caveat is only ever computed on an empty-inbound answer, so exercise
        // hasInbound=false with hasCaveat=true across the other axes.
        const v: PackageImpactVerdict = packageVerdictFor({
          hasInbound: false,
          scanIncomplete,
          membersPresent,
          hasCaveat: true,
        });
        expect(v).not.toBe('no-detected-dependencies');
        expect(v).not.toBe('has-dependencies');
      }
    }
    // And the bare verdict implies no caveat drove it.
    expect(
      packageVerdictFor({ hasInbound: false, scanIncomplete: false, membersPresent: false, hasCaveat: false }),
    ).toBe('no-detected-dependencies');
  });
});

describe('packageImpactHandler — SparkTable-shaped two-segment member (verdict ⇔ caveat)', () => {
  let dir: string;
  let local: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pkg-sparktable-'));
    const opened = await openGraph(join(dir, 'sparktable.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    local = opened.value;
    // Zzz managed package (synthetic namespace — NEVER a real vault namespace):
    // an InstalledPackage marker + a two-segment managed FieldSet member that WAS
    // retrieved (packageComponentCount 1) but has NO inbound reference. This is
    // the exact SparkTable shape the QA cited: a member is present yet the tool
    // used to answer the soft `no-detected-dependencies`.
    const imp = await importExtractionResults(local, [
      {
        nodes: [
          makeNode({ id: 'InstalledPackage:Zzz', type: 'InstalledPackage', apiName: 'Zzz' }),
          makeNode({
            id: 'FieldSet:Contact.Zzz__Fields',
            type: 'FieldSet',
            apiName: 'Zzz__Fields',
            parentId: 'CustomObject:Contact',
          }),
          makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: local };
  });

  afterAll(async () => {
    await closeGraph(local);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a retrieved two-segment member with no inbound is members-present, NOT no-detected-dependencies', async () => {
    const r = await packageImpactHandler(localCtx, { namespace: 'Zzz' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    // The member (touchpoint) is claimed and visible in the sample.
    expect(r.value.data.packageComponentCount).toBe(1);
    expect(r.value.data.packageComponentSample).toContain('FieldSet:Contact.Zzz__Fields');
    expect(r.value.data.yourDependencies.length).toBe(0);
    expect(r.value.data.yourExtensions.length).toBe(0);
    // The verdict is the truthful members-present enum — NOT the soft verdict.
    expect(r.value.data.verdict).toBe('members-present-no-static-inbound');
    expect(r.value.data.verdict).not.toBe('no-detected-dependencies');
    // Caveat and verdict AGREE: the completeness caveat is attached to the
    // non-soft verdict (unknown-coverage vault + members present ⇒ fail-harder).
    expect(r.value.data.coverageCaveat).toBeDefined();
  });

  it('routes the InstalledPackage catalog id into the same non-soft verdict', async () => {
    const r = await packageImpactHandler(localCtx, { componentId: 'InstalledPackage:Zzz' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.namespace).toBe('Zzz');
    expect(r.value.data.verdict).toBe('members-present-no-static-inbound');
  });
});

describe('packageImpactHandler — grant-only targetMissing two-segment touchpoint claimed', () => {
  let dir: string;
  let local: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pkg-grant-only-'));
    const opened = await openGraph(join(dir, 'grantonly.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    local = opened.value;
    // Zzz package: ONLY the InstalledPackage marker is retrieved — no member
    // node. A PermissionSet grants a two-segment managed Apex class whose target
    // node is MISSING (a grant-only targetMissing touchpoint). It must be claimed
    // as a dependency so the verdict flips off the soft `no-detected-dependencies`
    // even though packageComponentCount is 0.
    const imp = await importExtractionResults(local, [
      {
        nodes: [
          makeNode({ id: 'InstalledPackage:Zzz', type: 'InstalledPackage', apiName: 'Zzz' }),
          makeNode({ id: 'PermissionSet:My_Admin', type: 'PermissionSet', apiName: 'My_Admin' }),
        ],
        edges: [
          makeEdge({
            fromId: 'PermissionSet:My_Admin',
            toId: 'ApexClass:Zzz__CustomTableController', // phantom: no node — grant-only touchpoint
            edgeType: 'grantedBy',
            confidence: 'declared',
          }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: local };
  });

  afterAll(async () => {
    await closeGraph(local);
    rmSync(dir, { recursive: true, force: true });
  });

  it('claims the grant-only Zzz__* touchpoint and flips off no-detected-dependencies', async () => {
    const r = await packageImpactHandler(localCtx, { namespace: 'Zzz' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    // The package's own components were never retrieved — only a phantom grant.
    expect(r.value.data.packageComponentCount).toBe(0);
    const pairs = r.value.data.yourDependencies.map((d) => `${d.fromId} -> ${d.toId}`);
    expect(pairs).toContain('PermissionSet:My_Admin -> ApexClass:Zzz__CustomTableController');
    // A claimed touchpoint is a positive dependency ⇒ has-dependencies (non-soft).
    expect(r.value.data.verdict).toBe('has-dependencies');
    expect(r.value.data.verdict).not.toBe('no-detected-dependencies');
  });
});

// =============================================================================
// PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND — grant-only count residual at REAL
// VAULT SCALE. The synthetic W6.1 fixtures above have <50 dangling targets, so a
// capped per-group sample happened to include the grant. On a busy org there are
// far MORE than 50 dangling `(ApexClass, grantedBy, declared)` targets across the
// installed packages, and a namespace whose members sort late (`SparkTable__*`)
// falls OUTSIDE the smallest-50 sample — its grant touchpoint was DROPPED and
// `yourDependencyTotal` under-counted the footprint (soft-verdict was already
// correct; only the COUNT was low). This fixture floods the dangling grant group
// with 60 filler targets that all sort BEFORE the managed class, so a smallest-50
// sample necessarily excludes it. The uncapped, namespace-scoped recovery must
// still count the grant. Guard FAILS against a 50-capped pass.
// =============================================================================
describe('packageImpactHandler — grant-only touchpoint counted past the 50-per-group sample cap', () => {
  let dir: string;
  let local: GraphStore;
  let localCtx: Context;
  const FILLER_COUNT = 60;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pkg-grant-scale-'));
    const opened = await openGraph(join(dir, 'grantscale.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    local = opened.value;
    // Acme package: ONLY the InstalledPackage marker is retrieved. A PermissionSet
    // grants a two-segment managed Apex class whose node is MISSING (grant-only
    // targetMissing). Beta package: a retrieved 2-segment member, NO grants — must
    // stay byte-identical (members-present, zero deps). The 60 filler grants point
    // at phantom `ApexClass:Aa0000..Aa0059` ids (unnamespaced, sort BEFORE
    // `Acme__…`), bloating the dangling grant group past any 50-sample so the Acme
    // grant would be excluded by a capped pass.
    const fillerEdges: Edge[] = [];
    for (let i = 0; i < FILLER_COUNT; i += 1) {
      const n = String(i).padStart(4, '0');
      fillerEdges.push(
        makeEdge({
          fromId: 'PermissionSet:Filler_PS',
          toId: `ApexClass:Aa${n}`, // phantom, unnamespaced, sorts before Acme__…
          edgeType: 'grantedBy',
          confidence: 'declared',
        }),
      );
    }
    const imp = await importExtractionResults(local, [
      {
        nodes: [
          makeNode({ id: 'InstalledPackage:Acme', type: 'InstalledPackage', apiName: 'Acme' }),
          makeNode({ id: 'InstalledPackage:Beta', type: 'InstalledPackage', apiName: 'Beta' }),
          makeNode({
            id: 'FieldSet:Contact.Beta__Fields',
            type: 'FieldSet',
            apiName: 'Beta__Fields',
            parentId: 'CustomObject:Contact',
          }),
          makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
          makeNode({ id: 'PermissionSet:Acme_Admin', type: 'PermissionSet', apiName: 'Acme_Admin' }),
          makeNode({ id: 'PermissionSet:Filler_PS', type: 'PermissionSet', apiName: 'Filler_PS' }),
        ],
        edges: [
          makeEdge({
            fromId: 'PermissionSet:Acme_Admin',
            toId: 'ApexClass:Acme__TableController', // phantom: managed class, grant-only
            edgeType: 'grantedBy',
            confidence: 'declared',
          }),
          ...fillerEdges,
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: local };
  });

  afterAll(async () => {
    await closeGraph(local);
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts the late-sorting managed-class grant even amid 60 filler dangling targets', async () => {
    const r = await packageImpactHandler(localCtx, { namespace: 'Acme' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    // The package's own components were never retrieved — only a phantom grant.
    expect(r.value.data.packageComponentCount).toBe(0);
    // The grant touchpoint is COUNTED (not 0) — the count residual is closed.
    expect(r.value.data.yourDependencyTotal).toBeGreaterThan(0);
    const pairs = r.value.data.yourDependencies.map((d) => `${d.fromId} -> ${d.toId}`);
    expect(pairs).toContain('PermissionSet:Acme_Admin -> ApexClass:Acme__TableController');
    // The unnamespaced fillers are NOT claimed as Acme touchpoints.
    expect(pairs.some((p) => p.includes('ApexClass:Aa'))).toBe(false);
    // A claimed touchpoint is a positive dependency ⇒ has-dependencies (non-soft).
    expect(r.value.data.verdict).toBe('has-dependencies');
    expect(r.value.data.verdict).not.toBe('no-detected-dependencies');
  });

  it('a package with NO grants stays byte-identical (members-present, zero deps)', async () => {
    const r = await packageImpactHandler(localCtx, { namespace: 'Beta' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(1); // the retrieved FieldSet member
    expect(r.value.data.yourDependencyTotal).toBe(0); // no grants → unchanged
    expect(r.value.data.yourDependencies.length).toBe(0);
    // Members present, no inbound → the non-soft members-present verdict (unchanged).
    expect(r.value.data.verdict).toBe('members-present-no-static-inbound');
    expect(r.value.data.verdict).not.toBe('no-detected-dependencies');
  });
});

// =============================================================================
// review / coverage-gap-absence — no visible members and a COMPLETE scan, but a
// producer family that could reference the package was not fully retrieved, so
// the absence is un-provable. The verdict is `review` (NOT the soft verdict) and
// the caveat AGREES with it (PACKAGE-IMPACT-TWO-SEGMENT-NAMESPACE-BLIND #3).
// =============================================================================
describe('packageImpactHandler — review verdict on an un-provable absence', () => {
  it('no members + a retrieve-coverage gap → review + agreeing caveat', async () => {
    const degraded: VaultManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        { type: 'ApexClass', requested: true, retrieved: 3, errored: false, neverModeled: false },
        // A producer family requested but errored → the absence cannot be proven.
        { type: 'Flow', requested: true, retrieved: 0, errored: true, neverModeled: false },
      ],
      coverageComputedAt: '2026-05-29T12:00:00.000Z',
    };
    // GHOSTNS has ZERO visible members, so this is the no-members / complete-scan
    // path — the caveat is what makes the absence un-provable.
    const r = await packageImpactHandler(
      { ...ctx, manifest: degraded },
      { namespace: 'GHOSTNS' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(0);
    expect(r.value.data.verdict).toBe('review');
    expect(r.value.data.verdict).not.toBe('no-detected-dependencies');
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain('Flow');
  });
});
