/// <reference types="vitest/globals" />

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const INACTIVE_PICKLIST_FIELD = 'CustomField:Account.Stage__c';
const APEX_READER = 'ApexClass:AccountReader';
const APEX_WRITER = 'ApexClass:AccountWriter';
// FIX 5 — value-consuming edge vocabulary fixture.
const DECLARATIVE_FIELD = 'CustomField:Account.Duration_Minutes__c';
const ORPHAN_FIELD = 'CustomField:Account.Orphan_Marker__c';
const FORMULA_FIELD = 'CustomField:Account.Duration_Hours__c';
const DECLARATIVE_VR = 'ValidationRule:Account.Duration_Positive';
const DECLARATIVE_LIST_VIEW = 'ListView:Account.Long_Sessions';
const LAYOUT_A = 'Layout:Account-Sales Layout';
const LAYOUT_B = 'Layout:Account-Service Layout';
const PERM_SET = 'PermissionSet:Widget_Session_Editor';

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
      id: INACTIVE_PICKLIST_FIELD,
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: ACCOUNT_OBJ,
      properties: {
        label: 'Stage',
        type: 'Picklist',
        description: null,
        // H10: object shape with one DEACTIVATED value, plus a legacy bare
        // string (which must normalize to active) — mixed-shape tolerance.
        picklistValues: [
          'Open',
          { value: 'Cancelled', isActive: false, label: 'Cancelled' },
        ],
        sourceOfTruth: { value: 'manual', confidence: 'heuristic' },
        semanticCategory: { value: 'status', confidence: 'heuristic' },
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
    // FIX 5 fixture — a field consumed ONLY by declarative `references`
    // edges, plus the inbound edge types that must be seen and excluded.
    makeNode({
      id: DECLARATIVE_FIELD,
      apiName: 'Duration_Minutes__c',
      label: 'Duration Minutes',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: ORPHAN_FIELD,
      apiName: 'Orphan_Marker__c',
      label: 'Orphan Marker',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: FORMULA_FIELD,
      apiName: 'Duration_Hours__c',
      label: 'Duration Hours',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: DECLARATIVE_VR,
      type: 'ValidationRule',
      apiName: 'Duration_Positive',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: DECLARATIVE_LIST_VIEW,
      type: 'ListView',
      apiName: 'Long_Sessions',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({ id: LAYOUT_A, type: 'Layout', apiName: 'Account-Sales Layout' }),
    makeNode({
      id: LAYOUT_B,
      type: 'Layout',
      apiName: 'Account-Service Layout',
    }),
    makeNode({
      id: PERM_SET,
      type: 'PermissionSet',
      apiName: 'Widget_Session_Editor',
    }),
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
    // FIX 5: three value-CONSUMING `references` edges and ZERO `readsFrom`.
    makeEdge({
      fromId: FORMULA_FIELD,
      toId: DECLARATIVE_FIELD,
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
    }),
    makeEdge({
      fromId: DECLARATIVE_VR,
      toId: DECLARATIVE_FIELD,
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
    }),
    makeEdge({
      fromId: DECLARATIVE_LIST_VIEW,
      toId: DECLARATIVE_FIELD,
      edgeType: 'references',
      confidence: 'declared',
      source: 'extractor:list-view',
    }),
    // Seen and EXCLUDED: placement and permission are not reads.
    makeEdge({
      fromId: LAYOUT_A,
      toId: DECLARATIVE_FIELD,
      edgeType: 'usedInLayout',
    }),
    makeEdge({
      fromId: LAYOUT_B,
      toId: DECLARATIVE_FIELD,
      edgeType: 'usedInLayout',
    }),
    makeEdge({
      fromId: PERM_SET,
      toId: DECLARATIVE_FIELD,
      edgeType: 'grantedBy',
    }),
    makeEdge({
      fromId: APEX_WRITER,
      toId: DECLARATIVE_FIELD,
      edgeType: 'writesTo',
      confidence: 'heuristic',
    }),
    // FIX 5 zero case: structure only.
    makeEdge({
      fromId: ACCOUNT_OBJ,
      toId: ORPHAN_FIELD,
      edgeType: 'parentOf',
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
    // Picklist values projected from properties — H10: each gains isActive.
    // These seed entries carry no isActive, so both normalize to active.
    expect(data.picklistValues).toEqual([
      { value: 'Banking', label: 'Banking', isActive: true },
      { value: 'Tech', label: 'Tech', isActive: true },
    ]);
    // Asymmetric usage: 2 reads, 1 write. FIX 5 widened the shape — the two
    // counts are unchanged here because this field's readers are `readsFrom`.
    expect(data.usageFrequency.incomingReads).toBe(2);
    expect(data.usageFrequency.incomingWrites).toBe(1);
    expect(data.usageFrequency.readsByEdgeType).toEqual({ readsFrom: 2 });
    expect(data.usageFrequency.countedEdgeTypes).toEqual([
      'readsFrom',
      'references',
    ]);
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

  it('H10: carries isActive (false for deactivated; true for legacy bare string) and surfaces the inactive boundary', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: INACTIVE_PICKLIST_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Both values LISTED: the bare string normalizes to active, the object
    // carries isActive:false — listed-and-marked, never dropped.
    expect(data.picklistValues).toEqual([
      { value: 'Open', label: 'Open', isActive: true },
      { value: 'Cancelled', label: 'Cancelled', isActive: false },
    ]);
    // The inactive-values boundary surfaces so the host LLM can mark them.
    expect(
      data.boundaries.some((b) => b.includes('inactive value')),
    ).toBe(true);
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

/**
 * FIX 5 — `incomingReads` counts every edge that CONSUMES the field's value.
 *
 * It used to count `readsFrom` alone, so a field read by formulas, validation
 * rules and list views reported `incomingReads: 0` — the number an admin
 * deletes a field on. On the reference vault that was wrong for 2,911 fields.
 */
describe('fieldMeaningHandler — value-consuming edge vocabulary (FIX 5)', () => {
  it('counts declarative `references` edges as reads', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: DECLARATIVE_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usage = result.value.data.usageFrequency;
    // Pre-fix: 0 — the three referencers were invisible.
    expect(usage.incomingReads).toBe(3);
    expect(usage.readsByEdgeType).toEqual({ references: 3 });
    expect(usage.countedEdgeTypes).toEqual(['readsFrom', 'references']);
  });

  it('publishes the inbound edges it SAW and rejected, rather than dropping them', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: DECLARATIVE_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usage = result.value.data.usageFrequency;
    expect(usage.incomingReads).toBe(3);
    expect(usage.excludedByEdgeType).toEqual({
      usedInLayout: 2,
      grantedBy: 1,
    });
  });

  it('leaves incomingWrites on `writesTo` alone', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: DECLARATIVE_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usageFrequency.incomingWrites).toBe(1);
  });

  it('carries the verbatim note on every response', async () => {
    const result = await fieldMeaningHandler(ctx, {
      fieldId: DECLARATIVE_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usageFrequency.note).toBe(
      "`incomingReads` counts every inbound edge that CONSUMES this field's value: `readsFrom` (Apex, Flow, condition contexts) and `references` (formulas, validation rules, list views, report types, Lightning pages, quick actions, web links). `usedInLayout` (placement) and `grantedBy` (permission) are not reads and are excluded — their counts are in `excludedByEdgeType`.",
    );
  });

  it('makes a genuine zero readable as CHECKED', async () => {
    const result = await fieldMeaningHandler(ctx, { fieldId: ORPHAN_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.usageFrequency.incomingReads).toBe(0);
    expect(data.usageFrequency.readsByEdgeType).toEqual({});
    expect(data.usageFrequency.excludedByEdgeType).toEqual({ parentOf: 1 });
    expect(data.boundaries).toContain(
      'A zero here means no value-consuming edge was found among the metadata families this vault retrieved. It is not proof the field is unused — reports, dashboards, list-view filters, and dynamic Apex are named in `boundaries` where they are not covered.',
    );
  });
});

/**
 * R1 — a picklist's `picklistValues` collapses THREE distinct states into
 * one `null`: (a) not a picklist, (b) a real zero-value inline definition,
 * (c) a GlobalValueSet-driven picklist whose values live off-node. The
 * sibling `explain_field` distinguishes all three and resolves (c) through
 * the `usesValueSet` edge (`resolveGlobalValueSetValues`); this tool did
 * neither, so the SAME field answers differently depending which tool is
 * asked, and a GVS-driven picklist reads as "no values" with no boundary
 * naming the gap.
 */
describe('fieldMeaningHandler — picklist honesty (R1)', () => {
  const R1_ACCOUNT = 'CustomObject:Account';
  const EMPTY_INLINE_FIELD = 'CustomField:Account.Empty_Picklist__c';
  const GVS_FIELD_ID = 'CustomField:Account.Region__c';
  const GVS_ID = 'GlobalValueSet:Region_Codes';
  const UNRESOLVED_GVS_FIELD_ID = 'CustomField:Account.Segment__c';
  const NON_PICKLIST_FIELD = 'CustomField:Account.Plain_Text__c';

  let r1Dir: string;
  let r1Store: GraphStore;
  let r1Ctx: Context;

  beforeAll(async () => {
    const nodes: Node[] = [
      makeNode({ id: R1_ACCOUNT, type: 'CustomObject', apiName: 'Account' }),
      makeNode({
        id: EMPTY_INLINE_FIELD,
        apiName: 'Empty_Picklist__c',
        label: 'Empty Picklist',
        parentId: R1_ACCOUNT,
        properties: {
          label: 'Empty Picklist',
          type: 'Picklist',
          // A real inline definition declaring ZERO values — distinct from
          // "not a picklist" and from "values live elsewhere".
          picklistValues: [],
        },
      }),
      makeNode({
        id: GVS_FIELD_ID,
        apiName: 'Region__c',
        label: 'Region',
        parentId: R1_ACCOUNT,
        properties: {
          label: 'Region',
          type: 'Picklist',
          picklistValues: null,
        },
      }),
      makeNode({
        id: GVS_ID,
        type: 'GlobalValueSet',
        apiName: 'Region_Codes',
        label: 'Region Codes',
        properties: {
          values: ['EMEA', 'APAC', 'AMER'],
        },
      }),
      makeNode({
        id: UNRESOLVED_GVS_FIELD_ID,
        apiName: 'Segment__c',
        label: 'Segment',
        parentId: R1_ACCOUNT,
        properties: {
          label: 'Segment',
          type: 'Picklist',
          // No inline values AND no usesValueSet edge — pre-0.1.10 vault, or
          // the value set truly was not retrieved. Must stay honestly null
          // but say WHY, not read like a checked-and-empty picklist.
          picklistValues: null,
        },
      }),
      makeNode({
        id: NON_PICKLIST_FIELD,
        apiName: 'Plain_Text__c',
        label: 'Plain Text',
        parentId: R1_ACCOUNT,
        properties: {
          label: 'Plain Text',
          type: 'Text',
        },
      }),
    ];
    const edges: Edge[] = [
      makeEdge({ fromId: R1_ACCOUNT, toId: EMPTY_INLINE_FIELD, edgeType: 'parentOf' }),
      makeEdge({ fromId: R1_ACCOUNT, toId: GVS_FIELD_ID, edgeType: 'parentOf' }),
      makeEdge({ fromId: R1_ACCOUNT, toId: UNRESOLVED_GVS_FIELD_ID, edgeType: 'parentOf' }),
      makeEdge({ fromId: R1_ACCOUNT, toId: NON_PICKLIST_FIELD, edgeType: 'parentOf' }),
      makeEdge({ fromId: GVS_FIELD_ID, toId: GVS_ID, edgeType: 'usesValueSet' }),
    ];
    r1Dir = mkdtempSync(join(tmpdir(), 'sfi-fm-picklist-'));
    const opened = await openGraph(join(r1Dir, 'picklist.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    r1Store = opened.value;
    const imported = await importExtractionResults(r1Store, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    r1Ctx = { vaultRoot: r1Dir, manifest: FIXTURE_MANIFEST, graph: r1Store };
  });

  afterAll(async () => {
    await closeGraph(r1Store);
    rmSync(r1Dir, { recursive: true, force: true });
  });

  it('returns an empty array — not null — for a real zero-value inline picklist definition', async () => {
    const result = await fieldMeaningHandler(r1Ctx, {
      fieldId: EMPTY_INLINE_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.picklistValues).toEqual([]);
    expect(result.value.data.picklistValues).not.toBeNull();
  });

  it('stays null for a genuinely non-picklist field', async () => {
    const result = await fieldMeaningHandler(r1Ctx, {
      fieldId: NON_PICKLIST_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.picklistValues).toBeNull();
  });

  it('resolves a GlobalValueSet-driven picklist through the usesValueSet edge instead of reporting null', async () => {
    const result = await fieldMeaningHandler(r1Ctx, { fieldId: GVS_FIELD_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.picklistValues).toEqual([
      { value: 'EMEA', label: 'EMEA', isActive: true },
      { value: 'APAC', label: 'APAC', isActive: true },
      { value: 'AMER', label: 'AMER', isActive: true },
    ]);
  });

  it('discloses a non-inline picklist with no resolvable value set as a named boundary, not a silent null', async () => {
    const result = await fieldMeaningHandler(r1Ctx, {
      fieldId: UNRESOLVED_GVS_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.picklistValues).toBeNull();
    expect(
      result.value.data.boundaries.some(
        (b) => b.includes('GlobalValueSet') && b.includes('not inline'),
      ),
    ).toBe(true);
  });
});

/**
 * R6 — the similar-fields corpus scan was a second copy of
 * `scanAllNodesOfTypes`'s offset-windowing loop, guarded only by a comment,
 * with a private `SIMILAR_FIELDS_PAGE_SIZE = 500` standing in for the shared
 * `NODE_SCAN_HARD_CAP`. A behavioral test cannot distinguish the two
 * (both walk the full corpus identically today) — this is a duplication /
 * drift-risk finding, so the bite proof is a source-level adoption guard:
 * it fails while the private loop exists and passes once field-meaning.ts
 * calls the shared helper instead.
 */
describe('fieldMeaningHandler — similar-fields scan adoption (R6)', () => {
  it('derives the CustomField corpus scan from the shared scanAllNodesOfTypes helper, not a private hardcoded page-size loop', () => {
    const src = readFileSync(
      new URL('../../src/tools/field-meaning.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/scanAllNodesOfTypes/);
    expect(src).not.toMatch(/SIMILAR_FIELDS_PAGE_SIZE/);
  });
});
