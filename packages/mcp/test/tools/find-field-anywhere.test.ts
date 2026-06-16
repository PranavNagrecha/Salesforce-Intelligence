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
  findFieldAnywhereHandler,
  findFieldAnywhereInputSchema,
} from '../../src/tools/find-field-anywhere.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-ffa',
};

const FIELD_ID = 'CustomField:Account.Industry__c';

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
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
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
    }),
    makeNode({
      id: FIELD_ID,
      type: 'CustomField',
      apiName: 'Account.Industry__c',
      parentId: 'CustomObject:Account',
    }),
    makeNode({
      id: 'ApexClass:AccountSvc',
      type: 'ApexClass',
      apiName: 'AccountSvc',
    }),
    makeNode({
      id: 'ApexClass:LegacyAccountFetcher',
      type: 'ApexClass',
      apiName: 'LegacyAccountFetcher',
    }),
    makeNode({
      id: 'Flow:Account_Update',
      type: 'Flow',
      apiName: 'Account_Update',
    }),
    makeNode({
      id: 'Layout:Account-Standard',
      type: 'Layout',
      apiName: 'Account-Standard',
    }),
    makeNode({
      id: 'ValidationRule:Account.Industry_Required',
      type: 'ValidationRule',
      apiName: 'Industry_Required',
      parentId: 'CustomObject:Account',
    }),
  ],
  edges: [
    // parentOf — should be filtered out by find_field_anywhere
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: FIELD_ID,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'custom-object-extractor',
    }),
    // Apex read
    makeEdge({
      fromId: 'ApexClass:AccountSvc',
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
    }),
    // Apex write
    makeEdge({
      fromId: 'ApexClass:AccountSvc',
      toId: FIELD_ID,
      edgeType: 'writesTo',
      source: 'apex-scanner',
    }),
    // Second Apex read from a different class
    makeEdge({
      fromId: 'ApexClass:LegacyAccountFetcher',
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
    }),
    // Flow read
    makeEdge({
      fromId: 'Flow:Account_Update',
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
    }),
    // Layout placement
    makeEdge({
      fromId: 'Layout:Account-Standard',
      toId: FIELD_ID,
      edgeType: 'usedInLayout',
      confidence: 'declared',
      source: 'layout-extractor',
    }),
    // ValidationRule reference
    makeEdge({
      fromId: 'ValidationRule:Account.Industry_Required',
      toId: FIELD_ID,
      edgeType: 'references',
      confidence: 'declared',
      source: 'formula-tokenizer',
      properties: { tokenizedFromField: 'errorConditionFormula' },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ffa-'));
  const opened = await openGraph(join(tempDir, 'ffa.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('findFieldAnywhereHandler', () => {
  it('returns groups for every ComponentType that references the field', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const types = r.value.data.groups.map((g) => g.componentType).sort();
    expect(types).toEqual([
      'ApexClass',
      'Flow',
      'Layout',
      'ValidationRule',
    ]);
  });

  it('totalCount equals the number of non-parentOf incoming edges', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 3 apex (readsFrom AccountSvc + writesTo AccountSvc + readsFrom LegacyAccountFetcher)
    // + 1 flow + 1 layout + 1 validation rule = 6
    expect(r.value.data.totalCount).toBe(6);
  });

  it('filters out parentOf edges', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // CustomObject:Account would only have a parentOf edge to the field;
    // it must not appear as a referrer group.
    expect(
      r.value.data.groups.find((g) => g.componentType === 'CustomObject'),
    ).toBeUndefined();
  });

  it('byEdgeType tallies the edge-type distribution across the full set', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.byEdgeType['readsFrom']).toBe(3);
    expect(r.value.data.byEdgeType['writesTo']).toBe(1);
    expect(r.value.data.byEdgeType['usedInLayout']).toBe(1);
    expect(r.value.data.byEdgeType['references']).toBe(1);
  });

  it('surfaces the verbatim dynamic-SOQL boundary when matches exist', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('Dynamic SOQL');
    expect(joined).toContain('managed-package');
  });

  it('surfaces only the report/dashboard caveat when the field has no other references', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: 'CustomField:Account.NoSuchField__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    // No graph references, but report/dashboard usage is only modeled with
    // `--with-reports` — so a "nothing references this" answer must still hedge
    // that the field could be used in an un-pulled report. That caveat is the
    // sole boundary (the static-graph / managed-package disclosures only apply
    // when there are actual references).
    expect(r.value.data.boundaries.length).toBe(1);
    expect(r.value.data.boundaries[0]).toContain('--with-reports');
  });

  it('sorts references within a group by componentId ASC then edgeType ASC', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const apex = r.value.data.groups.find(
      (g) => g.componentType === 'ApexClass',
    );
    expect(apex).toBeDefined();
    if (apex === undefined) return;
    const ids = apex.references.map(
      (ref) => `${ref.componentId}|${ref.edgeType}`,
    );
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('groups are sorted alphabetically by component type', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const types = r.value.data.groups.map((g) => g.componentType);
    const sorted = [...types].sort();
    expect(types).toEqual(sorted);
  });

  it('truncates to limit and flips truncated=true', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: FIELD_ID,
      limit: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.truncated).toBe(true);
    // Per-group sum should be <= 2 (truncation across the total).
    let sum = 0;
    for (const g of r.value.data.groups) sum += g.references.length;
    expect(sum).toBeLessThanOrEqual(2);
  });

  it('returns invalid-query when targetId does not start with CustomField:', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: 'ApexClass:NotAField',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('targetId');
  });

  it('accepts `fieldId` as an alias for `targetId` (field-family parity)', async () => {
    const viaAlias = await findFieldAnywhereHandler(ctx, { fieldId: FIELD_ID });
    const viaCanonical = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(viaAlias.ok).toBe(true);
    expect(viaCanonical.ok).toBe(true);
    if (!viaAlias.ok || !viaCanonical.ok) return;
    // The alias resolves to the same field and the same result.
    expect(viaAlias.value.data.targetId).toBe(FIELD_ID);
    expect(viaAlias.value.data.totalCount).toBe(viaCanonical.value.data.totalCount);
  });

  it('returns invalid-query when NEITHER targetId nor fieldId is supplied', async () => {
    const r = await findFieldAnywhereHandler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('targetId');
  });

  it('preserves edge metadata (source, confidence, properties) on each reference', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vr = r.value.data.groups.find(
      (g) => g.componentType === 'ValidationRule',
    );
    expect(vr).toBeDefined();
    if (vr === undefined) return;
    const ref = vr.references[0];
    expect(ref).toBeDefined();
    expect(ref?.source).toBe('formula-tokenizer');
    expect(ref?.confidence).toBe('declared');
    expect(ref?.properties['tokenizedFromField']).toBe('errorConditionFormula');
  });

  it('filters by componentTypes when supplied', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: FIELD_ID,
      componentTypes: ['ApexClass'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.groups.length).toBe(1);
    expect(r.value.data.groups[0]?.componentType).toBe('ApexClass');
    // 2 reads + 1 write = 3 apex references
    expect(r.value.data.totalCount).toBe(3);
  });

  it("group's count field matches the unfiltered per-type total", async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const apex = r.value.data.groups.find(
      (g) => g.componentType === 'ApexClass',
    );
    expect(apex?.count).toBe(3);
  });

  it('returns componentType-filtered empty result when filter matches nothing', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: FIELD_ID,
      componentTypes: ['Profile'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.groups.length).toBe(0);
  });
});

describe('findFieldAnywhereInputSchema', () => {
  it('accepts a valid CustomField id', () => {
    expect(
      findFieldAnywhereInputSchema.safeParse({ targetId: FIELD_ID }).success,
    ).toBe(true);
  });

  it('accepts the `fieldId` alias at the schema level', () => {
    expect(
      findFieldAnywhereInputSchema.safeParse({ fieldId: FIELD_ID }).success,
    ).toBe(true);
  });

  it('accepts {} at the schema level (one-of-required enforced in the handler)', () => {
    // targetId/fieldId are both optional in the schema so either alias parses;
    // the handler returns invalid-query when NEITHER is supplied (tested above).
    expect(findFieldAnywhereInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects limit above 500', () => {
    expect(
      findFieldAnywhereInputSchema.safeParse({
        targetId: FIELD_ID,
        limit: 501,
      }).success,
    ).toBe(false);
  });
});
