/// <reference types="vitest/globals" />

/**
 * Tests for the v3.1 R7 `sfi compare-vaults` CLI subcommand.
 *
 * The handler is a thin shim around the `sfi.compare_vaults` MCP tool;
 * these tests verify the CLI's registry resolution, env-var forwarding,
 * table rendering, and error mapping — not the diff algorithm itself
 * (which the MCP tool's own unit tests already cover).
 *
 * The fixture mirrors the `packages/mcp/test/tools/compare-vaults.test.ts`
 * shape: two synthetic vault stores under a co-resident temp root with
 * a deliberate add (`Sandbox_Notes__c`), a deliberate shape drift
 * (`Discount__c` precision 18 → 16), and a deliberate removal
 * (`Contact`).
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
import {
  registerVault,
  saveManifest,
  vaultPaths,
} from '@sf-intelligence/vault';

import {
  renderCompareVaults,
  runCompareVaults,
  type CompareVaultsCliPayload,
} from '../../src/commands/compare-vaults.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

let rootDir: string;
let vaultAPath: string;
let vaultBPath: string;
let storeA: GraphStore;
let storeB: GraphStore;

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sfi-cli-compare-vaults-'));
  vaultAPath = join(rootDir, 'acme-prod');
  vaultBPath = join(rootDir, 'acme-sandbox');
  await mkdir(join(vaultAPath, 'graph'), { recursive: true });
  await mkdir(join(vaultBPath, 'graph'), { recursive: true });
  await saveManifest(vaultAPath, FIXTURE_MANIFEST);
  await saveManifest(vaultBPath, {
    ...FIXTURE_MANIFEST,
    sourceTreeHash: 'sha256:sandbox',
  });

  const dbA = vaultPaths(vaultAPath).graphDb;
  const dbB = vaultPaths(vaultBPath).graphDb;
  const openedA = await openGraph(dbA);
  if (!openedA.ok) throw new Error(openedA.error.message);
  storeA = openedA.value;
  const openedB = await openGraph(dbB);
  if (!openedB.ok) throw new Error(openedB.error.message);
  storeB = openedB.value;

  // Vault A: Account with Discount__c (precision 18,2), plus Contact.
  const seedA: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
        label: 'Account',
        properties: { sharingModel: 'ReadWrite' },
      }),
      makeNode({
        id: 'CustomField:Account.Discount__c',
        type: 'CustomField',
        apiName: 'Discount__c',
        label: 'Discount',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'Number', precision: 18, scale: 2 },
      }),
      makeNode({
        id: 'CustomObject:Contact',
        type: 'CustomObject',
        apiName: 'Contact',
        label: 'Contact',
        properties: { sharingModel: 'Private' },
      }),
    ],
    edges: [],
  };
  // Vault B: Discount__c precision 16,2 (shape drift) + Sandbox_Notes__c (added).
  // Contact removed.
  const seedB: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
        label: 'Account',
        properties: { sharingModel: 'ReadWrite' },
      }),
      makeNode({
        id: 'CustomField:Account.Discount__c',
        type: 'CustomField',
        apiName: 'Discount__c',
        label: 'Discount',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'Number', precision: 16, scale: 2 },
      }),
      makeNode({
        id: 'CustomField:Account.Sandbox_Notes__c',
        type: 'CustomField',
        apiName: 'Sandbox_Notes__c',
        label: 'Sandbox Notes',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'LongTextArea' },
      }),
    ],
    edges: [],
  };
  await importExtractionResults(storeA, [seedA]);
  await importExtractionResults(storeB, [seedB]);
  await registerVault(rootDir, 'acme-prod', vaultAPath);
  await registerVault(rootDir, 'acme-sandbox', vaultBPath);
});

afterAll(async () => {
  await closeGraph(storeA);
  await closeGraph(storeB);
  await rm(rootDir, { recursive: true, force: true });
});

describe('runCompareVaults', () => {
  it('returns a structured CompareVaultsOutput for two registered vaults', async () => {
    const result = await runCompareVaults({
      rootDir,
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value;
    expect(data.summary.addedCount).toBeGreaterThan(0);
    expect(data.summary.removedCount).toBeGreaterThan(0);
    expect(data.summary.shapeModifiedCount).toBeGreaterThan(0);
    expect(data.added.some((c) => c.id === 'CustomField:Account.Sandbox_Notes__c')).toBe(
      true,
    );
    expect(data.removed.some((c) => c.id === 'CustomObject:Contact')).toBe(true);
    expect(
      data.shapeModified.some((c) => c.id === 'CustomField:Account.Discount__c'),
    ).toBe(true);
  });

  it('always surfaces the volatile-property filter disclosure in boundaries', async () => {
    const result = await runCompareVaults({
      rootDir,
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.boundaries.some((b) => b.includes('volatile properties')),
    ).toBe(true);
  });

  it('surfaces alias-not-found when the registry has no matching alias', async () => {
    const result = await runCompareVaults({
      rootDir,
      vaultA: 'acme-prod',
      vaultB: 'no-such-alias',
    });
    // The MCP tool returns a structured vault-not-found payload (not an
    // error envelope) — so the CLI sees `ok` with the disclosure in
    // boundaries[]. This mirrors the Q170 honesty anchor.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.boundaries.some((b) =>
        b.includes("vault alias 'no-such-alias' is not registered"),
      ),
    ).toBe(true);
  });

  it('returns alias-not-found error when vaultA itself is missing', async () => {
    const result = await runCompareVaults({
      rootDir,
      vaultA: 'no-such-alias',
      vaultB: 'acme-prod',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('alias-not-found');
  });

  it('honors the --object filter (Account branch only)', async () => {
    const result = await runCompareVaults({
      rootDir,
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
      object: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const allIds = [
      ...result.value.added,
      ...result.value.removed,
      ...result.value.shapeModified,
    ].map((c) => c.id);
    for (const id of allIds) {
      const isAccount = id === 'CustomObject:Account';
      const isAccountChild = id.startsWith('CustomField:Account.');
      expect(isAccount || isAccountChild).toBe(true);
    }
  });
});

describe('renderCompareVaults', () => {
  const samplePayload: CompareVaultsCliPayload = {
    vaultA: { alias: 'acme-prod' },
    vaultB: { alias: 'acme-sandbox' },
    added: [
      {
        id: 'CustomField:Account.Sandbox_Notes__c',
        type: 'CustomField',
        apiName: 'Sandbox_Notes__c',
      },
    ],
    removed: [
      {
        id: 'CustomObject:Contact',
        type: 'CustomObject',
        apiName: 'Contact',
      },
    ],
    shapeModified: [
      {
        id: 'CustomField:Account.Discount__c',
        type: 'CustomField',
        apiName: 'Discount__c',
        drift: [
          { propertyPath: 'precision', valueA: 18, valueB: 16 },
        ],
      },
    ],
    summary: {
      addedCount: 1,
      removedCount: 1,
      shapeModifiedCount: 1,
      unchangedCount: 1,
    },
    boundaries: ['volatile properties are filtered'],
  };

  it('renders the summary block, boundaries, and per-bucket rows', () => {
    const out = renderCompareVaults(samplePayload);
    expect(out).toContain("Compare 'acme-prod' vs 'acme-sandbox'");
    expect(out).toContain('Added:          1');
    expect(out).toContain('Removed:        1');
    expect(out).toContain('Shape modified: 1');
    expect(out).toContain('volatile properties');
    expect(out).toContain('+ CustomField:Account.Sandbox_Notes__c');
    expect(out).toContain('- CustomObject:Contact');
    expect(out).toContain('~ CustomField:Account.Discount__c');
    expect(out).toContain('precision: 18 -> 16');
  });

  it('renders "(none)" for empty buckets', () => {
    const empty: CompareVaultsCliPayload = {
      vaultA: { alias: 'x' },
      vaultB: { alias: 'y' },
      added: [],
      removed: [],
      shapeModified: [],
      summary: {
        addedCount: 0,
        removedCount: 0,
        shapeModifiedCount: 0,
        unchangedCount: 0,
      },
      boundaries: [],
    };
    const out = renderCompareVaults(empty);
    // Three "(none)" blocks for the three empty buckets PLUS one for boundaries.
    expect(out.split('(none)').length - 1).toBeGreaterThanOrEqual(4);
  });
});
