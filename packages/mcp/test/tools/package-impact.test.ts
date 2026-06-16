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
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  namespaceOf,
  packageImpactHandler,
  packageImpactInputSchema,
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

  it('surfaces a package present ONLY via your extensions (phantom package object — HEDA-style, B27)', async () => {
    // A managed object (hed__Course__c) is a phantom — its own definition was
    // never retrieved, so no node carries the `hed` prefix. But you added a
    // layout to it. Inventory must still report `hed` as installed
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
            id: 'Layout:hed__Course__c.Faculty Course Layout',
            type: 'Layout',
            apiName: 'Faculty Course Layout',
            parentId: 'CustomObject:hed__Course__c', // phantom: no node for it
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
    const hed = r.value.data.packages.find((p) => p.namespace === 'hed');
    expect(hed).toBeDefined();
    expect(hed?.componentCount).toBe(0);
    expect(hed?.extensionCount).toBe(1);
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

  it('returns no-detected-dependencies for a clean package', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'VLOC' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(1);
    expect(r.value.data.yourDependencies.length).toBe(0);
    expect(r.value.data.yourExtensions.length).toBe(0);
    expect(r.value.data.verdict).toBe('no-detected-dependencies');
  });

  it('handles a namespace absent from the vault honestly', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'GHOSTNS' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.data.mode !== 'impact') return;
    expect(r.value.data.packageComponentCount).toBe(0);
    expect(r.value.data.verdict).toBe('no-detected-dependencies');
  });

  it('surfaces the verbatim honesty disclosure', async () => {
    const r = await packageImpactHandler(ctx, { namespace: 'SBQQ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/no-detected-dependencies/);
    expect(r.value.data.disclosure).toMatch(/sandbox/);
  });
});

describe('packageImpactInputSchema', () => {
  it('accepts an empty object (inventory mode)', () => {
    expect(packageImpactInputSchema.safeParse({}).success).toBe(true);
  });
  it('accepts a namespace + limit', () => {
    expect(
      packageImpactInputSchema.safeParse({ namespace: 'SBQQ', limit: 10 }).success,
    ).toBe(true);
  });
  it('rejects a limit over 500', () => {
    expect(
      packageImpactInputSchema.safeParse({ namespace: 'SBQQ', limit: 501 }).success,
    ).toBe(false);
  });
});
