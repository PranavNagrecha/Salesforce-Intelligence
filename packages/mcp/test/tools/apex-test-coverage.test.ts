/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  apexTestCoverageHandler,
  apexTestCoverageInputSchema,
} from '../../src/tools/apex-test-coverage.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { ApexClass: 5 },
  edges: { callsApex: 2 },
  sourceTreeHash: 'sha256:fixture',
};

const cls = (name: string, test = false): Node => ({
  id: `ApexClass:${name}`,
  type: 'ApexClass',
  apiName: name,
  label: null,
  parentId: null,
  sourcePath: `${name}.cls`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: test ? { isTest: true } : {},
});

const calls = (from: string, to: string): Edge => ({
  fromId: `ApexClass:${from}`,
  toId: `ApexClass:${to}`,
  edgeType: 'callsApex',
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
});

// SvcA <- SvcATest, SvcB <- SvcBTest, SvcC has no test.
const seed: ExtractionResult = {
  nodes: [cls('SvcA'), cls('SvcB'), cls('SvcC'), cls('SvcATest', true), cls('SvcBTest', true)],
  edges: [calls('SvcATest', 'SvcA'), calls('SvcBTest', 'SvcB')],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-cov-'));
  const opened = await openGraph(join(tempDir, 'cov.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('apexTestCoverageHandler — single class', () => {
  it('lists the covering test for a referenced class', async () => {
    const r = await apexTestCoverageHandler(ctx, { classApiName: 'SvcA' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('single-class');
    expect(r.value.data.target?.status).toBe('has-test-references');
    expect(r.value.data.target?.coveringTests).toEqual(['ApexClass:SvcATest']);
  });

  it('reports no-test-references-found for an untested class', async () => {
    const r = await apexTestCoverageHandler(ctx, { classApiName: 'SvcC' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.target?.status).toBe('no-test-references-found');
    expect(r.value.data.target?.coveringTests).toEqual([]);
  });

  it('returns component-not-found for an unknown class', async () => {
    const r = await apexTestCoverageHandler(ctx, { classApiName: 'NoSuchClass' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('accepts the apexClass alias and stays in single-class mode (no silent org-wide downgrade)', async () => {
    const r = await apexTestCoverageHandler(ctx, { apexClass: 'SvcA' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The bug: a wrong-but-plausible key used to be stripped, dropping the
    // request to org-wide mode and answering a different question silently.
    expect(r.value.data.mode).toBe('single-class');
    expect(r.value.data.target?.classApiName).toBe('SvcA');
    expect(r.value.data.target?.coveringTests).toEqual(['ApexClass:SvcATest']);
  });

  it('prefers classApiName when both keys are present', async () => {
    const r = await apexTestCoverageHandler(ctx, { classApiName: 'SvcA', apexClass: 'SvcB' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.target?.classApiName).toBe('SvcA');
  });
});

describe('apexTestCoverageHandler — org-wide', () => {
  it('lists only the untested non-test classes and counts correctly', async () => {
    const r = await apexTestCoverageHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('org-wide');
    expect(r.value.data.untestedClasses).toEqual(['ApexClass:SvcC']);
    expect(r.value.data.summary).toMatchObject({
      testClasses: 2,
      nonTestClasses: 3,
      classesWithTestReferences: 2,
      classesWithoutTestReferences: 1,
    });
  });
});

describe('apexTestCoverageInputSchema', () => {
  it('accepts empty input and a classApiName', () => {
    expect(apexTestCoverageInputSchema.safeParse({}).success).toBe(true);
    expect(apexTestCoverageInputSchema.safeParse({ classApiName: 'X' }).success).toBe(true);
  });
  it('accepts the apexClass alias', () => {
    expect(apexTestCoverageInputSchema.safeParse({ apexClass: 'X' }).success).toBe(true);
  });
  it('rejects limit above 500', () => {
    expect(apexTestCoverageInputSchema.safeParse({ limit: 501 }).success).toBe(false);
  });
});
