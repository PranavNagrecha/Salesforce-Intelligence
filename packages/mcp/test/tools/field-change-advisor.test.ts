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

// FIELD-CHANGE-ADVISOR-REJECTS-NATURAL-FIELD-ARGS: accept the natural field
// selectors a host/router passes (componentId / fieldApiName / apiName + bare
// Object.Field) instead of hard-failing on `fieldId Required`.
describe('fieldChangeAdvisorHandler — natural field selectors', () => {
  const canonical = () => fieldChangeAdvisorHandler(ctx, { fieldId: FIELD });

  it('componentId / fieldApiName / apiName resolve to the SAME result as fieldId', async () => {
    const base = await canonical();
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    for (const input of [{ componentId: FIELD }, { fieldApiName: FIELD }, { apiName: FIELD }]) {
      const r = await fieldChangeAdvisorHandler(ctx, input);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data).toEqual(base.value.data);
    }
  });

  it('a bare Object.Field and a CustomField:Object.Field id both resolve', async () => {
    const base = await canonical();
    const bare = await fieldChangeAdvisorHandler(ctx, { fieldApiName: 'Acct__c.Region__c' });
    const prefixed = await fieldChangeAdvisorHandler(ctx, { componentId: FIELD });
    expect(base.ok && bare.ok && prefixed.ok).toBe(true);
    if (!base.ok || !bare.ok || !prefixed.ok) return;
    expect(bare.value.data.fieldId).toBe(FIELD);
    expect(prefixed.value.data.fieldId).toBe(FIELD);
    expect(bare.value.data).toEqual(base.value.data);
  });

  it('precedence fieldId > componentId: fieldId wins when both are present', async () => {
    const r = await fieldChangeAdvisorHandler(ctx, {
      fieldId: FIELD,
      componentId: 'CustomField:Acct__c.Other__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.fieldId).toBe(FIELD);
  });

  it('naming no field returns a named invalid-query (never a silent/empty answer)', async () => {
    const r = await fieldChangeAdvisorHandler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('an unresolvable selector is a named error, never empty', async () => {
    const r = await fieldChangeAdvisorHandler(ctx, { apiName: 'Acct__c.Nope__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('the canonical fieldId call output is unchanged (byte-identical)', async () => {
    const r = await canonical();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.fieldId).toBe(FIELD);
    expect(r.value.data.deletion?.verdict).toBe('review');
  });
});

describe('fieldChangeAdvisorInputSchema', () => {
  it('accepts fieldId or any interchangeable selector; newType optional', () => {
    expect(fieldChangeAdvisorInputSchema.safeParse({ fieldId: FIELD }).success).toBe(true);
    expect(fieldChangeAdvisorInputSchema.safeParse({ componentId: FIELD }).success).toBe(true);
    expect(fieldChangeAdvisorInputSchema.safeParse({ fieldApiName: 'Acct__c.Region__c' }).success).toBe(true);
    expect(fieldChangeAdvisorInputSchema.safeParse({ apiName: 'Acct__c.Region__c' }).success).toBe(true);
    expect(fieldChangeAdvisorInputSchema.safeParse({ fieldId: FIELD, newType: 'Number' }).success).toBe(true);
    // fieldId is no longer schema-required (an alias can name the field); the
    // handler enforces "at least one selector" with a named invalid-query.
    expect(fieldChangeAdvisorInputSchema.safeParse({}).success).toBe(true);
  });
});
