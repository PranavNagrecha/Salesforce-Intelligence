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
import {
  safeToDeleteFieldHandler,
  safeToDeleteFieldInputSchema,
} from '../../src/tools/safe-to-delete-field.js';

const completeFieldDeletionCoverage = (): readonly CoverageEntry[] =>
  [
    'CustomField',
    'ValidationRule',
    'Flow',
    'ApexClass',
    'ApexTrigger',
    'Layout',
    'LightningComponentBundle',
    'AuraDefinitionBundle',
    'VisualforcePage',
    'VisualforceComponent',
    'QuickAction',
    'WorkflowRule',
    'SharingRule',
    'Report',
    'Dashboard',
    'ListView',
    'ReportType',
    'FlexiPage',
  ].map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
  }));

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    CustomField: 8,
    ValidationRule: 1,
    Flow: 1,
    ApexClass: 2,
    ApexTrigger: 1,
    Layout: 1,
    WorkflowRule: 1,
    LightningComponentBundle: 1,
    VisualforcePage: 1,
    QuickAction: 1,
  },
  edges: {
    parentOf: 8,
    references: 3,
    readsFrom: 3,
    writesTo: 3,
    usedInLayout: 1,
  },
  sourceTreeHash: 'sha256:fixture',
  coverageComputedAt: '2026-05-29T12:00:00.000Z',
  coverage: completeFieldDeletionCoverage(),
};

/** Default node-shape helper. */
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

/** Default edge-shape helper. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed: shared parent CustomObject.
// =============================================================================

const ACCOUNT_ID = 'CustomObject:Account';
const accountParentSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT_ID, type: 'CustomObject', apiName: 'Account' }),
  ],
  edges: [],
};

// =============================================================================
// Seed: safe field. No incoming edges of any kind.
// =============================================================================

const SAFE_FIELD = 'CustomField:Account.Safe__c';
const safeFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: SAFE_FIELD, apiName: 'Safe__c', parentId: ACCOUNT_ID }),
  ],
  edges: [],
};

// =============================================================================
// Seed: report-blocking field. Report references this field.
// =============================================================================

const REPORT_FIELD = 'CustomField:Account.ReportCol__c';
const REPORT_NODE = 'Report:Account_Open_Opps';
const reportFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: REPORT_FIELD,
      apiName: 'ReportCol__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: REPORT_NODE,
      type: 'Report',
      apiName: 'Account_Open_Opps',
    }),
  ],
  edges: [
    makeEdge({
      fromId: REPORT_NODE,
      toId: REPORT_FIELD,
      edgeType: 'references',
      source: 'enterprise-metadata',
      confidence: 'parsed',
    }),
  ],
};

// =============================================================================
// Seed: blocking-flow field. Flow reads this field.
// =============================================================================

const FLOW_FIELD = 'CustomField:Account.UsedByFlow__c';
const FLOW_NODE = 'Flow:UsesField';
const flowFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_FIELD,
      apiName: 'UsedByFlow__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({ id: FLOW_NODE, type: 'Flow', apiName: 'UsesField' }),
  ],
  edges: [
    makeEdge({
      fromId: FLOW_NODE,
      toId: FLOW_FIELD,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
      confidence: 'parsed',
    }),
  ],
};

// =============================================================================
// Seed: multi-blocking field. ValidationRule references + Layout uses.
// =============================================================================

const VR_LAYOUT_FIELD = 'CustomField:Account.HasVRAndLayout__c';
const VR_NODE = 'ValidationRule:Account.MustBeSet';
const LAYOUT_NODE = 'Layout:Account.AccountLayout';
const vrLayoutSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: VR_LAYOUT_FIELD,
      apiName: 'HasVRAndLayout__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: VR_NODE,
      type: 'ValidationRule',
      apiName: 'Account.MustBeSet',
    }),
    makeNode({
      id: LAYOUT_NODE,
      type: 'Layout',
      apiName: 'Account.AccountLayout',
    }),
  ],
  edges: [
    makeEdge({
      fromId: VR_NODE,
      toId: VR_LAYOUT_FIELD,
      edgeType: 'references',
    }),
    makeEdge({
      fromId: LAYOUT_NODE,
      toId: VR_LAYOUT_FIELD,
      edgeType: 'usedInLayout',
    }),
  ],
};

// =============================================================================
// Seed: layout-ONLY field. On a page layout, no other references. Deleting it
// is SAFE — Salesforce auto-removes it from the layout, does not block the
// delete, and nothing breaks (only the UI no longer shows it). The verdict
// must be 'review' (a UI heads-up), NOT 'blocking'.
// =============================================================================

const LAYOUT_ONLY_FIELD = 'CustomField:Account.LayoutOnly__c';
const LAYOUT_ONLY_NODE = 'Layout:Account.LayoutOnlyLayout';
const layoutOnlySeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: LAYOUT_ONLY_FIELD,
      apiName: 'LayoutOnly__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: LAYOUT_ONLY_NODE,
      type: 'Layout',
      apiName: 'Account.LayoutOnlyLayout',
    }),
  ],
  edges: [
    makeEdge({
      fromId: LAYOUT_ONLY_NODE,
      toId: LAYOUT_ONLY_FIELD,
      edgeType: 'usedInLayout',
    }),
  ],
};

// =============================================================================
// Seed: risky-apex field. ApexClass readsFrom (heuristic).
// =============================================================================

const APEX_FIELD = 'CustomField:Account.ApexOnly__c';
const APEX_READER = 'ApexClass:AccountService';
const apexFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: APEX_FIELD, apiName: 'ApexOnly__c', parentId: ACCOUNT_ID }),
    makeNode({ id: APEX_READER, type: 'ApexClass', apiName: 'AccountService' }),
  ],
  edges: [
    makeEdge({
      fromId: APEX_READER,
      toId: APEX_FIELD,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
      confidence: 'heuristic',
      properties: { line: 42 },
    }),
  ],
};

// =============================================================================
// Seed: blocking-apex-write field. ApexClass writesTo (blocking).
// =============================================================================

const APEX_WRITE_FIELD = 'CustomField:Account.ApexWrite__c';
const APEX_WRITER = 'ApexClass:WriteService';
const apexWriteSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: APEX_WRITE_FIELD,
      apiName: 'ApexWrite__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({ id: APEX_WRITER, type: 'ApexClass', apiName: 'WriteService' }),
  ],
  edges: [
    makeEdge({
      fromId: APEX_WRITER,
      toId: APEX_WRITE_FIELD,
      edgeType: 'writesTo',
      source: 'apex-scanner',
      confidence: 'heuristic',
    }),
  ],
};

// =============================================================================
// Seed: formula-tokenizer reference. blocking via formula category.
// =============================================================================

const FORMULA_FIELD = 'CustomField:Account.FormulaRef__c';
const FORMULA_SOURCE_FIELD = 'CustomField:Account.HasFormula__c';
const formulaSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FORMULA_FIELD,
      apiName: 'FormulaRef__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: FORMULA_SOURCE_FIELD,
      apiName: 'HasFormula__c',
      parentId: ACCOUNT_ID,
    }),
  ],
  edges: [
    makeEdge({
      fromId: FORMULA_SOURCE_FIELD,
      toId: FORMULA_FIELD,
      edgeType: 'references',
      source: 'formula-tokenizer',
      confidence: 'parsed',
      properties: { tokenizedFromField: 'HasFormula__c' },
    }),
  ],
};

// =============================================================================
// Seed: frontend (LWC) referrer only. Field categorised as 'frontend' risky.
// =============================================================================

const LWC_FIELD = 'CustomField:Account.LwcOnly__c';
const LWC_BUNDLE = 'LightningComponentBundle:accountBadge';
const lwcSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: LWC_FIELD, apiName: 'LwcOnly__c', parentId: ACCOUNT_ID }),
    makeNode({
      id: LWC_BUNDLE,
      type: 'LightningComponentBundle',
      apiName: 'accountBadge',
    }),
  ],
  edges: [
    makeEdge({
      fromId: LWC_BUNDLE,
      toId: LWC_FIELD,
      edgeType: 'readsFrom',
      source: 'lwc-scanner',
      confidence: 'heuristic',
    }),
  ],
};

// =============================================================================
// Seed: workflow-blocking. WorkflowRule writesTo.
// =============================================================================

const WORKFLOW_FIELD = 'CustomField:Account.WorkflowSet__c';
const WORKFLOW_RULE = 'WorkflowRule:Account.SetStatus';
const workflowSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: WORKFLOW_FIELD,
      apiName: 'WorkflowSet__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: WORKFLOW_RULE,
      type: 'WorkflowRule',
      apiName: 'Account.SetStatus',
    }),
  ],
  edges: [
    makeEdge({
      fromId: WORKFLOW_RULE,
      toId: WORKFLOW_FIELD,
      edgeType: 'writesTo',
      source: 'workflow-extractor',
    }),
  ],
};

// =============================================================================
// Seed: many-referrers field to exercise the 5-example cap.
// =============================================================================

const CROWDED_FIELD = 'CustomField:Account.Crowded__c';
const CROWDED_APEX_IDS = [
  'ApexClass:CR01',
  'ApexClass:CR02',
  'ApexClass:CR03',
  'ApexClass:CR04',
  'ApexClass:CR05',
  'ApexClass:CR06',
  'ApexClass:CR07',
];
const crowdedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CROWDED_FIELD,
      apiName: 'Crowded__c',
      parentId: ACCOUNT_ID,
    }),
    ...CROWDED_APEX_IDS.map((id) =>
      makeNode({
        id,
        type: 'ApexClass',
        apiName: id.replace('ApexClass:', ''),
      }),
    ),
  ],
  edges: CROWDED_APEX_IDS.map((id) =>
    makeEdge({
      fromId: id,
      toId: CROWDED_FIELD,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
      confidence: 'heuristic',
    }),
  ),
};

// One shared graph store + Context across the suite.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

// A field whose ONLY incoming edges are its structural parent (parentOf, from
// a PRESENT CustomObject) and an FLS grant (grantedBy, from a PRESENT
// PermissionSet). Neither is a deletion dependency. Earlier fixtures omitted
// the parent NODE, so the sparse-graph skip hid the bug; here both source nodes
// exist, so the classification is genuinely exercised.
const PARENT_PERM_FIELD = 'CustomField:Account.OwnedAndGranted__c';
const PERM_SET_NODE = 'PermissionSet:FieldGranter';
const parentPermSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PARENT_PERM_FIELD,
      apiName: 'OwnedAndGranted__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({ id: PERM_SET_NODE, type: 'PermissionSet', apiName: 'FieldGranter' }),
  ],
  edges: [
    makeEdge({ fromId: ACCOUNT_ID, toId: PARENT_PERM_FIELD, edgeType: 'parentOf' }),
    makeEdge({
      fromId: PERM_SET_NODE,
      toId: PARENT_PERM_FIELD,
      edgeType: 'grantedBy',
    }),
  ],
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-safe-to-delete-'));
  const dbPath = join(tempDir, 'safe-to-delete.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    accountParentSeed,
    safeFieldSeed,
    reportFieldSeed,
    flowFieldSeed,
    vrLayoutSeed,
    layoutOnlySeed,
    apexFieldSeed,
    apexWriteSeed,
    formulaSeed,
    lwcSeed,
    workflowSeed,
    crowdedSeed,
    parentPermSeed,
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
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

describe('safeToDeleteFieldHandler', () => {
  it('returns safe with empty reasoning for a field with no incoming edges', async () => {
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: SAFE_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning, fieldId, coverageCaveat, trust } = result.value.data;
    expect(verdict).toBe('safe');
    expect(reasoning.length).toBe(0);
    expect(fieldId).toBe(SAFE_FIELD);
    expect(coverageCaveat).toBeUndefined();
    expect(trust.completeness.status).toBe('complete');
    // The vaultState comes from the manifest.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('downgrades an otherwise safe field to review when deletion coverage is incomplete', async () => {
    const coverage = FIXTURE_MANIFEST.coverage ?? [];
    const incompleteCtx: Context = {
      ...ctx,
      manifest: {
        ...FIXTURE_MANIFEST,
        coverage: coverage.filter(
          (entry) => entry.type !== 'Report' && entry.type !== 'FlexiPage',
        ),
      },
    };
    const result = await safeToDeleteFieldHandler(incompleteCtx, { fieldId: SAFE_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('review');
    expect(result.value.data.coverageCaveat?.missingCoverage).toEqual([
      'FlexiPage',
      'Report',
    ]);
    expect(result.value.data.trust.completeness.status).toBe('partial');
  });

  it('CR-P3-3: retrieveConfirmed-empty deletion-coverage types yield safe + NO caveat', async () => {
    // A zero-of-those org where SharingRule/Report/Dashboard/ListView/etc. were
    // CONFIRMED-CLEAN empty (describe confirmed support + clean retrieve returned
    // zero), while the code/layout families are covered. Before CR-P3-3 these
    // empty rows were partial -> buildCoverageCaveat fired -> safe flipped to
    // review. Now confirmed-empty == complete, so an unreferenced field is plainly
    // safe with no coverageCaveat.
    const coverage = FIXTURE_MANIFEST.coverage ?? [];
    const emptyButConfirmed = new Set([
      'SharingRule',
      'Report',
      'Dashboard',
      'ListView',
      'ReportType',
      'FlexiPage',
      'WorkflowRule',
    ]);
    const confirmedCtx: Context = {
      ...ctx,
      manifest: {
        ...FIXTURE_MANIFEST,
        coverage: coverage.map((entry) =>
          emptyButConfirmed.has(entry.type)
            ? { ...entry, retrieved: 0, retrieveConfirmed: true }
            : { ...entry, retrieveConfirmed: true },
        ),
      },
    };
    const result = await safeToDeleteFieldHandler(confirmedCtx, { fieldId: SAFE_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('safe');
    expect(result.value.data.coverageCaveat).toBeUndefined();
    expect(result.value.data.trust.completeness.status).toBe('complete');
  });

  it('returns blocking with an analytics category for a Report-referenced field', async () => {
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: REPORT_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('blocking');
    const analytics = reasoning.find((r) => r.category === 'analytics');
    expect(analytics).toBeDefined();
    expect(analytics?.verdict).toBe('blocking');
    expect(analytics?.examples[0]?.id).toBe(REPORT_NODE);
  });

  it('returns blocking with a flow category for a Flow-referenced field', async () => {
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: FLOW_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('blocking');
    const flow = reasoning.find((r) => r.category === 'flow');
    expect(flow).toBeDefined();
    expect(flow?.verdict).toBe('blocking');
    expect(flow?.count).toBe(1);
    expect(flow?.examples[0]?.id).toBe(FLOW_NODE);
    expect(flow?.examples[0]?.type).toBe('Flow');
    expect(flow?.note).toContain('Flow');
  });

  it('returns blocking with both validation and layout reasons when both apply', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: VR_LAYOUT_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('blocking');
    const validation = reasoning.find((r) => r.category === 'validation');
    const layout = reasoning.find((r) => r.category === 'layout');
    expect(validation).toBeDefined();
    expect(validation?.verdict).toBe('blocking');
    expect(validation?.examples[0]?.id).toBe(VR_NODE);
    expect(layout).toBeDefined();
    // A page-layout placement is a UI heads-up (review), not blocking — the
    // overall verdict stays blocking here because of the Validation Rule.
    expect(layout?.verdict).toBe('review');
    expect(layout?.examples[0]?.id).toBe(LAYOUT_NODE);
  });

  it('returns review (not blocking) for a field only used on a page layout', async () => {
    // Salesforce auto-removes a deleted field from its page layouts; the delete
    // is not blocked and nothing breaks. Marking usedInLayout 'blocking'
    // (a real org: ~500 fields) is a false positive inconsistent
    // with the tool's own grantedBy handling (auto-removed → informational).
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: LAYOUT_ONLY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('review');
    const layout = reasoning.find((r) => r.category === 'layout');
    expect(layout?.verdict).toBe('review');
    expect(layout?.examples[0]?.id).toBe(LAYOUT_ONLY_NODE);
  });

  it("returns risky with an apex category for a field with only Apex readsFrom edges and notes the heuristic boundary", async () => {
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: APEX_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('risky');
    const apex = reasoning.find((r) => r.category === 'apex');
    expect(apex).toBeDefined();
    expect(apex?.verdict).toBe('risky');
    expect(apex?.count).toBe(1);
    expect(apex?.examples[0]?.id).toBe(APEX_READER);
    // The note must spell out the heuristic-confidence boundary
    // so the caller knows to spot-check before deleting.
    expect(apex?.note).toMatch(/heuristic|false positives|spot-check/i);
  });

  it('returns blocking when an Apex class writesTo the field (writesTo is structurally stronger than readsFrom)', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: APEX_WRITE_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('blocking');
    const apex = reasoning.find((r) => r.category === 'apex');
    expect(apex?.verdict).toBe('blocking');
  });

  it('classifies formula-tokenizer references into the formula category as blocking', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: FORMULA_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('blocking');
    const formula = reasoning.find((r) => r.category === 'formula');
    expect(formula).toBeDefined();
    expect(formula?.verdict).toBe('blocking');
    expect(formula?.examples[0]?.id).toBe(FORMULA_SOURCE_FIELD);
    // Validation category should NOT also fire for a formula-tokenizer
    // reference (the source marker disambiguates).
    expect(reasoning.find((r) => r.category === 'validation')).toBeUndefined();
  });

  it('classifies LWC readsFrom references into the frontend category as risky', async () => {
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: LWC_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('risky');
    const frontend = reasoning.find((r) => r.category === 'frontend');
    expect(frontend).toBeDefined();
    expect(frontend?.verdict).toBe('risky');
    expect(frontend?.examples[0]?.id).toBe(LWC_BUNDLE);
    expect(frontend?.note).toMatch(/LWC|Aura|Visualforce|spot-check/);
  });

  it('classifies WorkflowRule writesTo into the workflow category as blocking', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: WORKFLOW_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('blocking');
    const workflow = reasoning.find((r) => r.category === 'workflow');
    expect(workflow).toBeDefined();
    expect(workflow?.verdict).toBe('blocking');
    expect(workflow?.examples[0]?.id).toBe(WORKFLOW_RULE);
  });

  it('truncates examples to 5 per category but keeps the full count', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: CROWDED_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const apex = result.value.data.reasoning.find((r) => r.category === 'apex');
    expect(apex).toBeDefined();
    // 7 incoming readsFrom edges from Apex classes; cap is 5.
    expect(apex?.count).toBe(7);
    expect(apex?.examples.length).toBe(5);
    // The 5 examples are the smallest ids (CR01..CR05) sorted ASC.
    expect(apex?.examples.map((e) => e.id)).toEqual([
      'ApexClass:CR01',
      'ApexClass:CR02',
      'ApexClass:CR03',
      'ApexClass:CR04',
      'ApexClass:CR05',
    ]);
  });

  it('returns invalid-query when the fieldId does not start with the CustomField prefix', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: 'ApexClass:NotAField',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('CustomField:');
  });

  it('returns component-not-found when the field is unknown', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: 'CustomField:Account.DoesNotExist__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toContain('CustomField:Account.DoesNotExist__c');
  });

  it('reviews a referenced-but-not-modeled standard field instead of erroring (B12)', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-std-del-'));
    const opened = await openGraph(join(localDir, 'std.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    // Contact.Email: a standard field with no node, referenced by a validation
    // rule. The tool must review (not error, and not "safe").
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'ValidationRule:Contact.RequireEmail',
            type: 'ValidationRule',
            apiName: 'RequireEmail',
          }),
        ],
        edges: [
          makeEdge({
            fromId: 'ValidationRule:Contact.RequireEmail',
            toId: 'CustomField:Contact.Email',
            edgeType: 'references',
          }),
        ],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await safeToDeleteFieldHandler(localCtx, {
      fieldId: 'CustomField:Contact.Email',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Not safe, not an error: a not-modeled standard field is a review.
    expect(r.value.data.verdict).toBe('review');
    expect(r.value.data.reasoning[0]?.note).toMatch(
      /not retrieved|not proven safe/i,
    );
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('does not surface parentOf edges as reasoning entries', async () => {
    // A field always has an incoming parentOf edge from its CustomObject;
    // even so, the safe-field with no other edges must still verdict
    // `safe`.
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: SAFE_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('safe');
    // No layout / parent / etc. category should fire.
    expect(
      result.value.data.reasoning.find((r) => r.category === 'layout'),
    ).toBeUndefined();
  });

  it('excludes parentOf and grantedBy from the verdict — FLS grants surface as flsGrantCount only', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: PARENT_PERM_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('safe');
    expect(result.value.data.reasoning.length).toBe(0);
    expect(result.value.data.flsGrantCount).toBe(1);
  });

  it("emits the reasoning array in the stable category order (apex, flow, ...)", async () => {
    // Construct a synthetic case: read the multi-blocking field. The
    // entries must come back in the documented stable order.
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: VR_LAYOUT_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const categories = result.value.data.reasoning.map((r) => r.category);
    // Validation comes before Layout in CATEGORY_ORDER.
    const validationIdx = categories.indexOf('validation');
    const layoutIdx = categories.indexOf('layout');
    expect(validationIdx).toBeGreaterThanOrEqual(0);
    expect(layoutIdx).toBeGreaterThanOrEqual(0);
    expect(validationIdx).toBeLessThan(layoutIdx);
  });

  it('a field used only in a report/dashboard (usedInReport) is NOT safe to delete', async () => {
    // Dedicated store so the shared seed assertions stay intact.
    const dir = mkdtempSync(join(tmpdir(), 'sfi-std-rpt-'));
    const opened = await openGraph(join(dir, 'rpt.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const acct = 'CustomObject:Account';
      const reportField = 'CustomField:Account.ReportOnly__c';
      const local: ExtractionResult = {
        nodes: [
          makeNode({ id: acct, type: 'CustomObject', apiName: 'Account' }),
          // No incoming dependency edges — the field's only use is a report
          // column, folded onto it as `usedInReport` by the --with-reports pass.
          makeNode({
            id: reportField,
            apiName: 'ReportOnly__c',
            parentId: acct,
            properties: { dataType: 'Text', usedInReport: true },
          }),
        ],
        edges: [makeEdge({ fromId: acct, toId: reportField, edgeType: 'parentOf' })],
      };
      const imp = await importExtractionResults(s, [local]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
      const result = await safeToDeleteFieldHandler(localCtx, { fieldId: reportField });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Without honoring the folded usage this would be `safe` (no edges); it must not be.
      expect(result.value.data.verdict).not.toBe('safe');
      expect(result.value.data.reasoning.map((r) => r.category)).toContain('analytics');
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('safeToDeleteFieldInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = safeToDeleteFieldInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty fieldId string', () => {
    const parsed = safeToDeleteFieldInputSchema.safeParse({ fieldId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing fieldId', () => {
    const parsed = safeToDeleteFieldInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('accepts any non-empty string at the schema level (prefix is handler-validated)', () => {
    // The handler enforces the `CustomField:` prefix; the schema does
    // not. That separation lets the schema be JSON-Schema-expressible
    // (no const prefix support) while the handler returns
    // `invalid-query` with a precise reason.
    const parsed = safeToDeleteFieldInputSchema.safeParse({
      fieldId: 'NotAField',
    });
    expect(parsed.success).toBe(true);
  });
});
