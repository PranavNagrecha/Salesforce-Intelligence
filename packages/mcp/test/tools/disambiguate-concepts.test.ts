/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
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

import type { Context } from '../../src/server.js';
import {
  disambiguateConceptsHandler,
  disambiguateConceptsInputSchema,
} from '../../src/tools/disambiguate-concepts.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3, CustomField: 5 },
  edges: { parentOf: 5 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Foo__c',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed (per PLAN-v2.9 Q149):
//   - Opportunity.Status__c, Opportunity.Stage__c
//   - Case.Status (standard)
//   - Lead.Status (standard)
//   - No *Stage* outside Opportunity.
// Expected: conceptA(Status) → 3 fields (Opp/Case/Lead);
//           conceptB(Stage) → 1 field (Opp).
//           differences include parent-object axis.
// =============================================================================

const OPP_OBJ = 'CustomObject:Opportunity';
const CASE_OBJ = 'CustomObject:Case';
const LEAD_OBJ = 'CustomObject:Lead';

const OPP_STATUS = 'CustomField:Opportunity.Status__c';
const OPP_STAGE = 'CustomField:Opportunity.Stage__c';
const CASE_STATUS = 'CustomField:Case.Status';
const LEAD_STATUS = 'CustomField:Lead.Status';
const OPP_AMOUNT = 'CustomField:Opportunity.Amount';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: OPP_OBJ, type: 'CustomObject', apiName: 'Opportunity' }),
    makeNode({ id: CASE_OBJ, type: 'CustomObject', apiName: 'Case' }),
    makeNode({ id: LEAD_OBJ, type: 'CustomObject', apiName: 'Lead' }),
    makeNode({
      id: OPP_STATUS,
      type: 'CustomField',
      apiName: 'Status__c',
      label: 'Status',
      parentId: OPP_OBJ,
      properties: {
        label: 'Status',
        type: 'Picklist',
        semanticCategory: { value: 'status', confidence: 'heuristic' },
      },
    }),
    // NOTE: in a fully-classified vault, Opportunity.Stage__c would
    // ALSO have semanticCategory: 'status' (the v2.9 classifier matches
    // both Status and Stage to the same status category). For Q149's
    // bucket-separation test, we leave semanticCategory unset on Stage__c
    // so the apiName-token axis is exercised in isolation. A separate
    // test covers the semantic-category cross-match below.
    makeNode({
      id: OPP_STAGE,
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: OPP_OBJ,
      properties: {
        label: 'Stage',
        type: 'Picklist',
      },
    }),
    makeNode({
      id: CASE_STATUS,
      type: 'CustomField',
      apiName: 'Status',
      label: 'Status',
      parentId: CASE_OBJ,
      properties: {
        label: 'Status',
        type: 'Picklist',
        semanticCategory: { value: 'status', confidence: 'heuristic' },
      },
    }),
    makeNode({
      id: LEAD_STATUS,
      type: 'CustomField',
      apiName: 'Status',
      label: 'Status',
      parentId: LEAD_OBJ,
      properties: {
        label: 'Status',
        type: 'Picklist',
        semanticCategory: { value: 'status', confidence: 'heuristic' },
      },
    }),
    // Decoy field — neither Status nor Stage. Must NOT match either bucket.
    makeNode({
      id: OPP_AMOUNT,
      type: 'CustomField',
      apiName: 'Amount',
      label: 'Amount',
      parentId: OPP_OBJ,
      properties: {
        label: 'Amount',
        type: 'Currency',
        semanticCategory: { value: 'amount', confidence: 'heuristic' },
      },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-disambig-'));
  const dbPath = join(tempDir, 'disambig.db');
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

describe('disambiguateConceptsInputSchema', () => {
  it('accepts two non-empty concepts', () => {
    const r = disambiguateConceptsInputSchema.safeParse({
      conceptA: 'Status',
      conceptB: 'Stage',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty conceptA', () => {
    const r = disambiguateConceptsInputSchema.safeParse({
      conceptA: '',
      conceptB: 'Stage',
    });
    expect(r.success).toBe(false);
  });

  it('rejects limit outside [1, 200]', () => {
    const r = disambiguateConceptsInputSchema.safeParse({
      conceptA: 'A',
      conceptB: 'B',
      limit: 999,
    });
    expect(r.success).toBe(false);
  });
});

describe('disambiguateConceptsHandler', () => {
  it('partitions Status (3 fields) and Stage (1 field) per Q149', async () => {
    const result = await disambiguateConceptsHandler(ctx, {
      conceptA: 'Status',
      conceptB: 'Stage',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.conceptA.name).toBe('Status');
    expect(data.conceptB.name).toBe('Stage');
    const aIds = data.conceptA.matchingFields.map((m) => m.fieldId).sort();
    expect(aIds).toEqual([CASE_STATUS, LEAD_STATUS, OPP_STATUS].sort());
    const bIds = data.conceptB.matchingFields.map((m) => m.fieldId);
    expect(bIds).toEqual([OPP_STAGE]);
    // Decoy was NOT matched by either bucket.
    expect(aIds).not.toContain(OPP_AMOUNT);
    expect(bIds).not.toContain(OPP_AMOUNT);
  });

  it('emits the parent-object difference axis for Status vs Stage', async () => {
    const result = await disambiguateConceptsHandler(ctx, {
      conceptA: 'Status',
      conceptB: 'Stage',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const axes = result.value.data.differences.map((d) => d.axis);
    expect(axes).toContain('parent-object');
  });

  it('surfaces the verbatim Q155 boundary on every result', async () => {
    const result = await disambiguateConceptsHandler(ctx, {
      conceptA: 'Status',
      conceptB: 'Stage',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.boundaries).toHaveLength(1);
    const boundary = result.value.data.boundaries[0] ?? '';
    expect(boundary).toContain("Vocabulary is org-specific");
    expect(boundary).toContain("one org's 'Status' is another org's 'Stage'");
    expect(boundary).toContain('THIS org');
    expect(boundary).toContain('Verify');
  });

  it('returns empty differences and null suggested when same concept passed twice (Q150)', async () => {
    const result = await disambiguateConceptsHandler(ctx, {
      conceptA: 'Status',
      conceptB: 'Status',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.differences).toEqual([]);
    expect(result.value.data.suggestedWhenToUseEach).toBeNull();
    // Buckets are mirror images for the same concept.
    expect(result.value.data.conceptA.matchingFields.length).toBe(
      result.value.data.conceptB.matchingFields.length,
    );
  });

  it('treats same-concept comparison case-insensitively', async () => {
    const result = await disambiguateConceptsHandler(ctx, {
      conceptA: 'STATUS',
      conceptB: 'status',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.differences).toEqual([]);
  });

  it('records matchedOn axes for evidence', async () => {
    const result = await disambiguateConceptsHandler(ctx, {
      conceptA: 'Status',
      conceptB: 'Stage',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const oppStatusMatch = result.value.data.conceptA.matchingFields.find(
      (m) => m.fieldId === OPP_STATUS,
    );
    expect(oppStatusMatch).toBeDefined();
    // Must surface at least one of the three axes.
    expect(oppStatusMatch!.matchedOn.length).toBeGreaterThan(0);
    // semantic-category fires because the field has semanticCategory: 'status'.
    expect(oppStatusMatch!.matchedOn).toContain('semantic-category');
  });

  it('infers when-to-use-each only when parent distributions are disjoint', async () => {
    // Status vs Stage: Status appears on Opp/Case/Lead; Stage appears on
    // Opp ONLY. The Opp parent appears in both → distributions overlap →
    // suggestedWhenToUseEach must be null.
    const result = await disambiguateConceptsHandler(ctx, {
      conceptA: 'Status',
      conceptB: 'Stage',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.suggestedWhenToUseEach).toBeNull();
  });

  it('respects the limit cap', async () => {
    const result = await disambiguateConceptsHandler(ctx, {
      conceptA: 'Status',
      conceptB: 'Stage',
      limit: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.conceptA.matchingFields.length).toBe(1);
  });
});

describe('disambiguateConceptsHandler — full CustomField corpus scan', () => {
  // A graph with MORE than the graph layer's 50-row default page of
  // CustomFields, where the ONLY field matching the concept sorts LAST by id
  // (beyond the first page). A non-paginating scan silently misses it — the
  // real acme org has 1034 CustomFields, so this is not hypothetical.
  let bigDir: string;
  let bigStore: GraphStore;
  let bigCtx: Context;

  beforeAll(async () => {
    bigDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-disambig-big-'));
    const opened = await openGraph(join(bigDir, 'big.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    bigStore = opened.value;
    const obj = 'CustomObject:Acct';
    const nodes: Node[] = [
      makeNode({ id: obj, type: 'CustomObject', apiName: 'Acct' }),
    ];
    // 60 filler fields whose ids sort BEFORE the match and carry no concept
    // token, filling past the 50-row default page.
    for (let i = 0; i < 60; i++) {
      const n = String(i).padStart(3, '0');
      nodes.push(
        makeNode({
          id: `CustomField:Acct.aaa_filler_${n}__c`,
          apiName: `aaa_filler_${n}__c`,
          label: `Filler ${n}`,
          parentId: obj,
        }),
      );
    }
    // The one Status field — id sorts LAST (zzz_), so it is the 61st row and
    // is dropped by a single 50-row page.
    nodes.push(
      makeNode({
        id: 'CustomField:Acct.zzz_Status__c',
        apiName: 'zzz_Status__c',
        label: 'ZZZ Status',
        parentId: obj,
        properties: { label: 'ZZZ Status', type: 'Picklist' },
      }),
    );
    const imported = await importExtractionResults(bigStore, [
      { nodes, edges: [] },
    ]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    bigCtx = { vaultRoot: bigDir, manifest: FIXTURE_MANIFEST, graph: bigStore };
  });

  afterAll(async () => {
    await closeGraph(bigStore);
    rmSync(bigDir, { recursive: true, force: true });
  });

  it('finds a matching field that sorts beyond the first 50-row page', async () => {
    // 61 CustomFields; the only "Status" match (zzz_Status__c) is the last by
    // id, past the graph layer's 50-row default page. The handler must page
    // through the whole corpus — a non-paginating scan reports 0 matches.
    const result = await disambiguateConceptsHandler(bigCtx, {
      conceptA: 'Status',
      conceptB: 'Stage',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.conceptA.matchingFields.length).toBe(1);
    expect(result.value.data.conceptA.matchingFields[0]?.fieldId).toBe(
      'CustomField:Acct.zzz_Status__c',
    );
  });
});
