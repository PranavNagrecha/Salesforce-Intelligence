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
  apexBuildAdvisorHandler,
  apexBuildAdvisorInputSchema,
} from '../../src/tools/apex-build-advisor.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { ApexClass: 3, CustomObject: 1 },
  edges: { callsApex: 1, readsFrom: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const node = (id: string, type: Node['type'], props: Record<string, unknown> = {}): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: `${id}.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: props,
});

const edge = (fromId: string, toId: string, edgeType: Edge['edgeType']): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
});

const seed: ExtractionResult = {
  nodes: [
    node('ApexClass:SvcA', 'ApexClass'),
    node('ApexClass:SvcB', 'ApexClass'),
    node('ApexClass:SvcATest', 'ApexClass', { isTest: true }),
    node('CustomObject:Foo__c', 'CustomObject', { label: 'Foo' }),
  ],
  edges: [
    edge('ApexClass:SvcATest', 'ApexClass:SvcA', 'callsApex'),
    edge('ApexClass:SvcA', 'CustomObject:Foo__c', 'readsFrom'),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-apexadv-'));
  const opened = await openGraph(join(tempDir, 'apexadv.db'));
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

describe('apexBuildAdvisorHandler', () => {
  it('synthesises governor / test / FLS sections and recommendations', async () => {
    const r = await apexBuildAdvisorHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.governorPitfalls).not.toBeNull();
    expect(d.testExpectations).not.toBeNull();
    expect(d.flsCrudNorms).not.toBeNull();
    // SvcB has no covering test → at least one untested class.
    expect(d.testExpectations?.untestedClasses).toBeGreaterThanOrEqual(1);
    expect(d.recommendations.length).toBeGreaterThan(0);
  });

  it('adds similarLogic when scoped to an object', async () => {
    const r = await apexBuildAdvisorHandler(ctx, { objectApiName: 'Foo__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.similarLogic?.apexTouchingObject).toContain('ApexClass:SvcA');
  });

  it('omits similarLogic when no object is given', async () => {
    const r = await apexBuildAdvisorHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.similarLogic).toBeUndefined();
  });
});

describe('apexBuildAdvisorInputSchema', () => {
  it('accepts empty input and an objectApiName', () => {
    expect(apexBuildAdvisorInputSchema.safeParse({}).success).toBe(true);
    expect(apexBuildAdvisorInputSchema.safeParse({ objectApiName: 'Account' }).success).toBe(true);
  });
});
