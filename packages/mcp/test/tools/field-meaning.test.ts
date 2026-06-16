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
  fieldMeaningHandler,
  fieldMeaningInputSchema,
} from '../../src/tools/field-meaning.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, CustomField: 4 },
  edges: { parentOf: 4, readsFrom: 2, writesTo: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Industry__c',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
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

// =============================================================================
// Seed 1: Account.Industry__c — a fully classified field.
//   - sourceOfTruth: { value: 'manual', confidence: 'heuristic' }
//   - semanticCategory: { value: 'unknown', confidence: 'heuristic' }
//   - 2 readers, 1 writer (asymmetric usage)
//   - Lead.Industry as a similar field (shared "industry" token)
// =============================================================================

const ACCOUNT_OBJ = 'CustomObject:Account';
const LEAD_OBJ = 'CustomObject:Lead';
const ACCOUNT_INDUSTRY = 'CustomField:Account.Industry__c';
const LEAD_INDUSTRY = 'CustomField:Lead.Industry';
const UNRELATED_FIELD = 'CustomField:Account.Notes__c';
const PRE_V29_FIELD = 'CustomField:Account.Old_Field__c';
const APEX_READER = 'ApexClass:AccountReader';
const APEX_WRITER = 'ApexClass:AccountWriter';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT_OBJ, type: 'CustomObject', apiName: 'Account' }),
    makeNode({ id: LEAD_OBJ, type: 'CustomObject', apiName: 'Lead' }),
    makeNode({
      id: ACCOUNT_INDUSTRY,
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Industry',
        type: 'Picklist',
        description: 'The industry the account operates in.',
        picklistValues: [
          { value: 'Banking', label: 'Banking' },
          { value: 'Tech', label: 'Tech' },
        ],
        sourceOfTruth: { value: 'manual', confidence: 'heuristic' },
        semanticCategory: { value: 'unknown', confidence: 'heuristic' },
      },
    }),
    makeNode({
      id: LEAD_INDUSTRY,
      type: 'CustomField',
      apiName: 'Industry',
      label: 'Industry',
      parentId: LEAD_OBJ,
      properties: {
        label: 'Industry',
        type: 'Picklist',
        description: null,
        sourceOfTruth: { value: 'manual', confidence: 'heuristic' },
        semanticCategory: { value: 'unknown', confidence: 'heuristic' },
      },
    }),
    makeNode({
      id: UNRELATED_FIELD,
      type: 'CustomField',
      apiName: 'Notes__c',
      label: 'Notes',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Notes',
        type: 'TextArea',
        description: null,
        sourceOfTruth: { value: 'manual', confidence: 'heuristic' },
        semanticCategory: { value: 'descriptor', confidence: 'heuristic' },
      },
    }),
    makeNode({
      id: PRE_V29_FIELD,
      type: 'CustomField',
      apiName: 'Old_Field__c',
      label: 'Old Field',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Old Field',
        type: 'Text',
        description: null,
        // No sourceOfTruth / semanticCategory — pre-v2.9 vault.
      },
    }),
    makeNode({ id: APEX_READER, type: 'ApexClass', apiName: 'AccountReader' }),
    makeNode({ id: APEX_WRITER, type: 'ApexClass', apiName: 'AccountWriter' }),
  ],
  edges: [
    // Two readers + one writer => asymmetric usage.
    makeEdge({
      fromId: APEX_READER,
      toId: ACCOUNT_INDUSTRY,
      edgeType: 'readsFrom',
      confidence: 'heuristic',
    }),
    makeEdge({
      fromId: APEX_WRITER,
      toId: ACCOUNT_INDUSTRY,
      edgeType: 'readsFrom',
      confidence: 'heuristic',
    }),
    makeEdge({
      fromId: APEX_WRITER,
      toId: ACCOUNT_INDUSTRY,
      edgeType: 'writesTo',
      confidence: 'heuristic',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-field-meaning-'));
  const dbPath = join(tempDir, 'field-meaning.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('fieldMeaningInputSchema', () => {
  it('accepts a valid fieldId', () => {
    const r = fieldMeaningInputSchema.safeParse({ fieldId: ACCOUNT_INDUSTRY });
    expect(r.success).toBe(true);
  });

  it('rejects an empty fieldId', () => {
    const r = fieldMeaningInputSchema.safeParse({ fieldId: '' });
    expect(r.success).toBe(false);
  });
});

describe('fieldMeaningHandler', () => {
  it('returns object field list suggestion when a CustomObject id is passed (FLD-02)', async () => {
    // Passing CustomObject:Account should return a helpful suggestion (FLD-02).
    const result = await fieldMeaningHandler(ctx, {
      fieldId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data as unknown as Record<string, unknown>;
    expect(data['objectId']).toBe('CustomObject:Account');
    expect(data['objectApiName']).toBe('Account');
    expect(Array.isArray(data['fieldIds'])).toBe(true);
    expect(data['score']).toBe(1);
  });

  it('returns invalid-query when fieldId has an unrecognised non-CustomField prefix', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: 'ApexClass:SomeThing',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown CustomField id', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: 'CustomField:Account.Nope__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('returns the full meaning payload for a classified field', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: ACCOUNT_INDUSTRY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.fieldId).toBe(ACCOUNT_INDUSTRY);
    expect(data.apiName).toBe('Industry__c');
    expect(data.label).toBe('Industry');
    expect(data.description).toBe('The industry the account operates in.');
    expect(data.type).toBe('Picklist');
    expect(data.parentObjectId).toBe(ACCOUNT_OBJ);
    expect(data.parentObjectApiName).toBe('Account');
    // Picklist values projected from properties.
    expect(data.picklistValues).toEqual([
      { value: 'Banking', label: 'Banking' },
      { value: 'Tech', label: 'Tech' },
    ]);
    // Asymmetric usage: 2 reads, 1 write.
    expect(data.usageFrequency).toEqual({
      incomingReads: 2,
      incomingWrites: 1,
    });
    // Classifications projected from properties.
    expect(data.sourceOfTruth).toEqual({
      value: 'manual',
      confidence: 'heuristic',
    });
    expect(data.semanticCategory).toEqual({
      value: 'unknown',
      confidence: 'heuristic',
    });
    // similarFields includes Lead.Industry (shared "industry" token).
    expect(data.similarFields.length).toBeGreaterThan(0);
    expect(data.similarFields[0]?.fieldId).toBe(LEAD_INDUSTRY);
    expect(data.similarFields[0]?.parentObjectApiName).toBe('Lead');
    expect(data.similarFields[0]?.similarityScore).toBeGreaterThan(0);
    // Boundaries include the v2.9-wide axes.
    expect(data.boundaries.some((b) => b.includes('org-specific'))).toBe(true);
    expect(data.boundaries.some((b) => b.includes('static analysis'))).toBe(
      true,
    );
    // Heuristic classification → heuristic boundary surfaces.
    expect(
      data.boundaries.some((b) => b.includes('writes-fabric inference')),
    ).toBe(true);
    // semanticCategory is 'unknown' → name-pattern boundary suppressed.
    expect(
      data.boundaries.some((b) => b.includes('name-pattern')),
    ).toBe(false);
  });

  it('finds a similar field beyond the first 50 by id (paginates the full CustomField corpus)', async () => {
    // Regression: findSimilarFields scanned listNodesByType('CustomField')
    // with no limit, which defaults to 50 — so the similarity corpus was
    // truncated to the first 50 fields by id ASC. On real acme (1034
    // fields) the identical-name twin CustomField:Disability__c.Contact__c
    // was missed for CustomField:API_Contact__c.Contact__c. Seed 55 filler
    // fields that sort first, plus a seed + an identical-token twin that both
    // sort beyond #50; the twin (max token overlap) must still be found.
    const FILLERS = 55;
    const nodes: Node[] = [
      makeNode({ id: 'CustomObject:Aaa__c', type: 'CustomObject', apiName: 'Aaa__c' }),
      makeNode({
        id: 'CustomObject:Zzz_Seed__c',
        type: 'CustomObject',
        apiName: 'Zzz_Seed__c',
      }),
      makeNode({
        id: 'CustomObject:Zzz_Twin__c',
        type: 'CustomObject',
        apiName: 'Zzz_Twin__c',
      }),
    ];
    for (let i = 0; i < FILLERS; i += 1) {
      const n = String(i).padStart(2, '0');
      nodes.push(
        makeNode({
          id: `CustomField:Aaa__c.F${n}__c`,
          apiName: `F${n}__c`,
          label: `Filler ${n}`,
          parentId: 'CustomObject:Aaa__c',
          properties: { label: `Filler ${n}`, type: 'Text' },
        }),
      );
    }
    const SEED_ID = 'CustomField:Zzz_Seed__c.Reimbursement_Amount__c';
    const TWIN_ID = 'CustomField:Zzz_Twin__c.Reimbursement_Amount__c';
    nodes.push(
      makeNode({
        id: SEED_ID,
        apiName: 'Reimbursement_Amount__c',
        label: 'Reimbursement Amount',
        parentId: 'CustomObject:Zzz_Seed__c',
        properties: { label: 'Reimbursement Amount', type: 'Currency' },
      }),
      makeNode({
        id: TWIN_ID,
        apiName: 'Reimbursement_Amount__c',
        label: 'Reimbursement Amount',
        parentId: 'CustomObject:Zzz_Twin__c',
        properties: { label: 'Reimbursement Amount', type: 'Currency' },
      }),
    );
    const dir = mkdtempSync(join(tmpdir(), 'sfi-fm-trunc-'));
    const opened = await openGraph(join(dir, 'trunc.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const localStore = opened.value;
    try {
      const imp = await importExtractionResults(localStore, [
        { nodes, edges: [] },
      ]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = {
        vaultRoot: dir,
        manifest: FIXTURE_MANIFEST,
        graph: localStore,
      };
      const r = await fieldMeaningHandler(localCtx, { fieldId: SEED_ID });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(
        r.value.data.similarFields.some((s) => s.fieldId === TWIN_ID),
      ).toBe(true);
    } finally {
      await closeGraph(localStore);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces the semantic-name-pattern boundary when semanticCategory is non-unknown', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: UNRELATED_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.semanticCategory.value).toBe('descriptor');
    expect(
      result.value.data.boundaries.some((b) => b.includes('name-pattern')),
    ).toBe(true);
  });

  it('surfaces classification-missing boundary on a pre-v2.9 field', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: PRE_V29_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.sourceOfTruth).toEqual({
      value: 'unknown',
      confidence: 'heuristic',
    });
    expect(result.value.data.semanticCategory).toEqual({
      value: 'unknown',
      confidence: 'heuristic',
    });
    expect(
      result.value.data.boundaries.some((b) =>
        b.includes('classifier has not run'),
      ),
    ).toBe(true);
  });

  it('vaultState carries the manifest hash and refresh timestamp', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: ACCOUNT_INDUSTRY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe(
      '2026-05-27T14:33:08Z',
    );
  });
});
