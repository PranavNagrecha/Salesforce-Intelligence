/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
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
import { whatIfChangeFieldValueHandler } from '../../src/tools/what-if-change-field-value.js';

const REQUIRED = [
  'CustomField', 'ValidationRule', 'Flow', 'ApexClass', 'ApexTrigger',
  'WorkflowRule', 'Layout', 'SharingRule', 'DuplicateRule',
];

const completeCoverage = (types: readonly string[]): readonly CoverageEntry[] =>
  types.map((type) => ({ type, requested: true, retrieved: 1, errored: false, neverModeled: false }));

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-01T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, CustomField: 5 },
  edges: { parentOf: 4, references: 1 },
  sourceTreeHash: 'sha256:fixture',
  coverageComputedAt: '2026-06-01T00:00:00.000Z',
  coverage: completeCoverage(REQUIRED),
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject', apiName: 'Account', label: null, parentId: null,
  sourcePath: 'unused.xml', lastModifiedDate: null, lastModifiedBy: null,
  apiVersion: null, properties: {}, ...overrides,
});
const makeEdge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

const ACCOUNT = 'CustomObject:Account';
const KEY = 'CustomField:Account.Marketo_Id__c';
const UNIQUE = 'CustomField:Account.Code__c';
const FORMULA = 'CustomField:Account.Doubled__c';
const PLAIN = 'CustomField:Account.Notes__c';
const USERNAME = 'CustomField:User.Username';
const VR = 'ValidationRule:Account.CheckMarketo';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT, apiName: 'Account' }),
    makeNode({ id: KEY, type: 'CustomField', apiName: 'Marketo_Id__c', parentId: ACCOUNT, properties: { dataType: 'Text', externalId: true } }),
    makeNode({ id: UNIQUE, type: 'CustomField', apiName: 'Code__c', parentId: ACCOUNT, properties: { dataType: 'Text', unique: true } }),
    makeNode({ id: FORMULA, type: 'CustomField', apiName: 'Doubled__c', parentId: ACCOUNT, properties: { dataType: 'Number', formula: 'Amount__c * 2' } }),
    makeNode({ id: PLAIN, type: 'CustomField', apiName: 'Notes__c', parentId: ACCOUNT, properties: { dataType: 'LongTextArea' } }),
    makeNode({ id: USERNAME, type: 'CustomField', apiName: 'Username', properties: { dataType: 'Text' } }),
    makeNode({ id: VR, type: 'ValidationRule', apiName: 'Account.CheckMarketo', parentId: ACCOUNT }),
  ],
  edges: [
    makeEdge({ fromId: ACCOUNT, toId: KEY, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT, toId: UNIQUE, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT, toId: FORMULA, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT, toId: PLAIN, edgeType: 'parentOf' }),
    makeEdge({ fromId: VR, toId: KEY, edgeType: 'references', source: 'validation-rule-extractor' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-wi-cfv-'));
  const opened = await openGraph(join(tempDir, 'wi-cfv.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('whatIfChangeFieldValueHandler', () => {
  it('rejects a non-CustomField prefix with invalid-query', async () => {
    const r = await whatIfChangeFieldValueHandler(ctx, { fieldId: 'Flow:NotAField' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown field', async () => {
    const r = await whatIfChangeFieldValueHandler(ctx, { fieldId: 'CustomField:Account.Nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('rates an externalId integration key high, with an automation bucket from the referencing VR', async () => {
    const r = await whatIfChangeFieldValueHandler(ctx, { fieldId: KEY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.overallSeverity).toBe('high');
    expect(d.mutable).toBe(true);
    expect(d.buckets.some((b) => b.bucket === 'integration-key')).toBe(true);
    expect(d.buckets.some((b) => b.bucket === 'automation')).toBe(true);
    expect(d.disclosures.length).toBeGreaterThan(0);
  });

  it('flags a formula field as not mutable (info)', async () => {
    const r = await whatIfChangeFieldValueHandler(ctx, { fieldId: FORMULA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mutable).toBe(false);
    expect(r.value.data.overallSeverity).toBe('info');
  });

  it('rates User.Username critical (identity)', async () => {
    const r = await whatIfChangeFieldValueHandler(ctx, { fieldId: USERNAME });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.overallSeverity).toBe('critical');
    expect(r.value.data.buckets.some((b) => b.bucket === 'identity')).toBe(true);
  });

  it('rates a unique-only field as uniqueness/medium (not integration-key)', async () => {
    const r = await whatIfChangeFieldValueHandler(ctx, { fieldId: UNIQUE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.buckets.some((b) => b.bucket === 'uniqueness')).toBe(true);
    expect(r.value.data.buckets.some((b) => b.bucket === 'integration-key')).toBe(false);
  });

  it('adds a targeted check when newValue is supplied', async () => {
    const r = await whatIfChangeFieldValueHandler(ctx, { fieldId: KEY, newValue: 'ABC123' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.newValue).toBe('ABC123');
    expect(r.value.data.recommendedChecks.some((c) => c.includes('ABC123'))).toBe(true);
  });
});
