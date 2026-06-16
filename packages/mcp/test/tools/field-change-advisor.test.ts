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
  fieldChangeAdvisorHandler,
  fieldChangeAdvisorInputSchema,
} from '../../src/tools/field-change-advisor.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 1, CustomField: 1, Layout: 1 },
  edges: { parentOf: 1, usedInLayout: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const node = (id: string, type: Node['type'], props: Record<string, unknown> = {}): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: type === 'CustomField' ? 'CustomObject:Acct__c' : null,
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

// A field placed on a layout (so deletion is "review", not "blocking").
const FIELD = 'CustomField:Acct__c.Region__c';
const seed: ExtractionResult = {
  nodes: [
    node('CustomObject:Acct__c', 'CustomObject', { label: 'Acct' }),
    node(FIELD, 'CustomField', { label: 'Region', type: 'Text', required: false }),
    node('Layout:Acct__c-Acct Layout', 'Layout', { label: 'Acct Layout' }),
  ],
  edges: [
    edge('CustomObject:Acct__c', FIELD, 'parentOf'),
    edge('Layout:Acct__c-Acct Layout', FIELD, 'usedInLayout'),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-fca-'));
  const opened = await openGraph(join(tempDir, 'fca.db'));
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

describe('fieldChangeAdvisorHandler', () => {
  it('synthesises makeRequired + deletion sections and recommendations', async () => {
    const r = await fieldChangeAdvisorHandler(ctx, { fieldId: FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.makeRequired).not.toBeNull();
    expect(r.value.data.deletion).not.toBeNull();
    // The field is on a (page) layout → deletion verdict is "review", not "blocking".
    expect(r.value.data.deletion?.verdict).toBe('review');
    expect(r.value.data.recommendations.length).toBeGreaterThan(0);
    expect(r.value.data.changeType).toBeUndefined();
  });

  it('returns component-not-found for an unknown field', async () => {
    const r = await fieldChangeAdvisorHandler(ctx, { fieldId: 'CustomField:Acct__c.Nope__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });
});

describe('fieldChangeAdvisorInputSchema', () => {
  it('requires fieldId, allows optional newType', () => {
    expect(fieldChangeAdvisorInputSchema.safeParse({}).success).toBe(false);
    expect(fieldChangeAdvisorInputSchema.safeParse({ fieldId: FIELD }).success).toBe(true);
    expect(fieldChangeAdvisorInputSchema.safeParse({ fieldId: FIELD, newType: 'Number' }).success).toBe(true);
  });
});
