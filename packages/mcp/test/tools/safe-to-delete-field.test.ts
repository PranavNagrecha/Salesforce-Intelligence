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
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { resetLiveSession } from '../../src/tools/live-session.js';
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
    // The remaining condition firers: their ConditionalContext nodes emit
    // readsFrom edges to the fields their criteria test, so an unretrieved one
    // can hide a `condition` blocker.
    'ApprovalProcess',
    'AssignmentRule',
    'AutoResponseRule',
    'EscalationRule',
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

// GROUP-A PII-safety: a PII / encrypted field with NO incoming dependencies.
// The metadata verdict is `safe`, but a PII field must never READ as bland safe —
// the result must carry a non-verdict-lowering compliance escalation.
const PII_SAFE_FIELD = 'CustomField:Account.SSN__c';
const piiSafeFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PII_SAFE_FIELD,
      apiName: 'SSN__c',
      parentId: ACCOUNT_ID,
      properties: { dataType: 'Text' },
    }),
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

// =============================================================================
// Seed: D2 polymorphic Activity field. An Apex class writes a SHARED Activity
// custom field through a Task receiver (`someTask.Foo__c = …`), so the extractor
// keys the writesTo edge on the RECEIVER type — a dangling
// `CustomField:Task.Foo__c`. The import-time polymorphic alias re-points that
// dangling target onto the real `CustomField:Activity.Foo__c`, so this field
// must read as BLOCKING (an Apex write), not a false `safe`.
// =============================================================================

const ACTIVITY_ID = 'CustomObject:Activity';
const ACTIVITY_FIELD = 'CustomField:Activity.Foo__c';
const ACTIVITY_WRITER = 'ApexClass:ActivityTouch';
const activityPolymorphicSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACTIVITY_ID, type: 'CustomObject', apiName: 'Activity' }),
    makeNode({ id: ACTIVITY_FIELD, apiName: 'Foo__c', parentId: ACTIVITY_ID }),
    makeNode({ id: ACTIVITY_WRITER, type: 'ApexClass', apiName: 'ActivityTouch' }),
  ],
  edges: [
    makeEdge({ fromId: ACTIVITY_ID, toId: ACTIVITY_FIELD, edgeType: 'parentOf' }),
    // The write lands on the polymorphic child (Task) receiver, dangling until
    // the import-time polymorphic alias re-points it onto the Activity field.
    makeEdge({
      fromId: ACTIVITY_WRITER,
      toId: 'CustomField:Task.Foo__c',
      edgeType: 'writesTo',
      source: 'apex-ast',
      confidence: 'parsed',
      properties: { path: 'someTask.Foo__c', receiver: 'Task' },
    }),
  ],
};

// D2 describe-snapshot shape: the SAME shared Activity field materialized as
// BOTH a Task and an Event sibling (no Activity base node — the offline
// `sobject describe` path). Apex writes it through a Task receiver, so the
// writesTo attaches to the Task sibling; the mirror must surface it on the
// Event sibling too, so BOTH read blocking (not a false safe).
const TASK_SIBLING_FIELD = 'CustomField:Task.Shared__c';
const EVENT_SIBLING_FIELD = 'CustomField:Event.Shared__c';
const TASK_ID = 'CustomObject:Task';
const EVENT_ID = 'CustomObject:Event';
const SIBLING_WRITER = 'ApexClass:TaskTouch';
const activitySiblingSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: TASK_ID, type: 'CustomObject', apiName: 'Task' }),
    makeNode({ id: EVENT_ID, type: 'CustomObject', apiName: 'Event' }),
    makeNode({
      id: TASK_SIBLING_FIELD,
      apiName: 'Shared__c',
      parentId: TASK_ID,
      sourcePath: 'describe-snapshot:Task',
    }),
    makeNode({
      id: EVENT_SIBLING_FIELD,
      apiName: 'Shared__c',
      parentId: EVENT_ID,
      sourcePath: 'describe-snapshot:Event',
    }),
    makeNode({ id: SIBLING_WRITER, type: 'ApexClass', apiName: 'TaskTouch' }),
  ],
  edges: [
    makeEdge({ fromId: TASK_ID, toId: TASK_SIBLING_FIELD, edgeType: 'parentOf' }),
    makeEdge({ fromId: EVENT_ID, toId: EVENT_SIBLING_FIELD, edgeType: 'parentOf' }),
    makeEdge({
      fromId: SIBLING_WRITER,
      toId: TASK_SIBLING_FIELD,
      edgeType: 'writesTo',
      source: 'apex-ast',
      confidence: 'parsed',
      properties: { path: 'someTask.Shared__c' },
    }),
  ],
};

// A genuinely-unused Activity custom field — no writer, no reader. It must
// still read as `safe` (the polymorphic alias only fires for dangling
// Task/Event targets whose Activity field exists; it never invents a referrer).
const ACTIVITY_UNUSED_FIELD = 'CustomField:Activity.Unused__c';
const activityUnusedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ACTIVITY_UNUSED_FIELD,
      apiName: 'Unused__c',
      parentId: ACTIVITY_ID,
    }),
  ],
  edges: [
    makeEdge({
      fromId: ACTIVITY_ID,
      toId: ACTIVITY_UNUSED_FIELD,
      edgeType: 'parentOf',
    }),
  ],
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
    piiSafeFieldSeed,
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
    activityPolymorphicSeed,
    activitySiblingSeed,
    activityUnusedSeed,
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
      liveCapability: mintLiveCapability('opt-in'),
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

  it('surfaces a PII compliance escalation WITHOUT lowering the safe verdict', async () => {
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: PII_SAFE_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, piiCompliance } = result.value.data;
    // The escalation must NOT flip the verdict — it mirrors coverageCaveat.
    expect(verdict).toBe('safe');
    expect(piiCompliance).toBeDefined();
    expect(piiCompliance?.classification).toBe('pii');
    expect(piiCompliance?.message.toLowerCase()).toMatch(
      /compliance|retention|irreversible/,
    );
  });

  it('renders the PII compliance escalation FIRST in the checklist', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: PII_SAFE_FIELD,
      format: 'checklist',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const checklist = result.value.data.checklist ?? '';
    expect(checklist).toMatch(/PII|compliance/i);
    // The escalation appears before the verdict line.
    const piiIdx = checklist.search(/PII|compliance/i);
    const verdictIdx = checklist.indexOf('Verdict:');
    expect(piiIdx).toBeGreaterThanOrEqual(0);
    expect(piiIdx).toBeLessThan(verdictIdx);
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
    // Unconfirmed heuristic edges must NOT claim API confirmation.
    expect(apex?.apiConfirmed).toBeUndefined();
    expect(apex?.examples[0]?.apiConfirmed).toBeUndefined();
    // The note must spell out the heuristic-confidence boundary
    // so the caller knows to spot-check before deleting.
    expect(apex?.note).toMatch(/heuristic|false positives|spot-check/i);
  });

  it('surfaces apiConfirmed additive evidence when an inbound edge has properties.confirmedByApi (#16)', async () => {
    // Seed a sibling field whose Apex readsFrom edge was stamped by the
    // Tooling-API dependency enricher. Verdict stays risky — confirmation
    // is evidence only.
    const fieldId = 'CustomField:Account.ApiConfirmed__c';
    const readerId = 'ApexClass:ConfirmedReader';
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: fieldId, apiName: 'ApiConfirmed__c', parentId: ACCOUNT_ID }),
        makeNode({ id: readerId, type: 'ApexClass', apiName: 'ConfirmedReader' }),
      ],
      edges: [
        makeEdge({
          fromId: readerId,
          toId: fieldId,
          edgeType: 'readsFrom',
          source: 'apex-scanner',
          confidence: 'heuristic',
          properties: { confirmedByApi: true, line: 7 },
        }),
      ],
    };
    const imported = await importExtractionResults(store, [seed]);
    expect(imported.ok).toBe(true);

    const result = await safeToDeleteFieldHandler(ctx, { fieldId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning, checklist } = result.value.data;
    // Verdict cascade unchanged — still risky (heuristic Apex read).
    expect(verdict).toBe('risky');
    const apex = reasoning.find((r) => r.category === 'apex');
    expect(apex).toBeDefined();
    expect(apex?.verdict).toBe('risky');
    expect(apex?.apiConfirmed).toBe(true);
    expect(apex?.examples[0]?.id).toBe(readerId);
    expect(apex?.examples[0]?.apiConfirmed).toBe(true);

    const checklistResult = await safeToDeleteFieldHandler(ctx, {
      fieldId,
      format: 'checklist',
    });
    expect(checklistResult.ok).toBe(true);
    if (!checklistResult.ok) return;
    const rendered = checklistResult.value.data.checklist ?? checklist ?? '';
    expect(rendered).toMatch(/API-confirmed|Tooling API confirmed/i);
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
      liveCapability: mintLiveCapability('opt-in'),
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
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
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

  it('D2: an Activity custom field written via a Task receiver is NOT safe (polymorphic import alias attaches the write)', async () => {
    // The Apex writesTo edge was minted against the dangling
    // `CustomField:Task.Foo__c`; the import-time polymorphic alias re-points it
    // onto `CustomField:Activity.Foo__c`. Without the fix this field had zero
    // incoming edges and read as a false `safe`.
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: ACTIVITY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning, trust } = result.value.data;
    expect(verdict).toBe('blocking');
    const apex = reasoning.find((r) => r.category === 'apex');
    expect(apex).toBeDefined();
    expect(apex?.verdict).toBe('blocking');
    expect(apex?.examples[0]?.id).toBe(ACTIVITY_WRITER);
    // The polymorphic attribution is disclosed as a name-based import alias.
    expect(
      trust.limitations.some((l) => /polymorphic activity/i.test(l)),
    ).toBe(true);
  });

  it('D2 precision: a genuinely-unused Activity custom field still reads as safe', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: ACTIVITY_UNUSED_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('safe');
    expect(result.value.data.reasoning.length).toBe(0);
  });

  it('D2 (describe-snapshot siblings): the Task-written shared field is NOT safe from the Task representation', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: TASK_SIBLING_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
    const apex = result.value.data.reasoning.find((r) => r.category === 'apex');
    expect(apex?.verdict).toBe('blocking');
    expect(apex?.examples[0]?.id).toBe(SIBLING_WRITER);
  });

  it('D2 (describe-snapshot siblings): the mirror makes the EVENT sibling of a Task-written shared field NOT safe too', async () => {
    // Before the fix, the Event sibling had zero incoming reference edges and
    // read a false safe even though deleting the (one shared) field breaks the
    // Apex that writes it via a Task receiver.
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: EVENT_SIBLING_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
    const apex = result.value.data.reasoning.find((r) => r.category === 'apex');
    expect(apex).toBeDefined();
    expect(apex?.verdict).toBe('blocking');
    // The mirrored edge cites the same Apex writer.
    expect(apex?.examples[0]?.id).toBe(SIBLING_WRITER);
    // The polymorphic attribution is disclosed as a name-based import alias.
    expect(
      result.value.data.trust.limitations.some((l) =>
        /polymorphic activity/i.test(l),
      ),
    ).toBe(true);
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

  it('accepts the live params (CR-CAP-L5)', () => {
    const parsed = safeToDeleteFieldInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      liveEnabled: true,
      orgAlias: 'prod',
    });
    expect(parsed.success).toBe(true);
  });
});

// =============================================================================
// CR-CAP-L5 — live population cross-check on a `safe` static verdict.
// SAFE_FIELD (`CustomField:Account.Safe__c`, apiName `Safe__c`, parent
// `CustomObject:Account`) has zero incoming edges, so its STATIC verdict is
// always `safe` — the fixture the live cross-check is designed to run against.
// =============================================================================
describe('safeToDeleteFieldHandler — live population cross-check (CR-CAP-L5)', () => {
  beforeEach(() => resetLiveSession());
  afterEach(() => resetLiveSession());

  /** 100 total records; `populatedCount` controls how many are non-null. */
  const makePopulationExec = (populatedCount: number): ExecCommand =>
    (async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      const count = soql.includes('= null') ? 100 - populatedCount : 100;
      return { stdout: JSON.stringify({ result: { totalSize: count } }), stderr: '' };
    }) as ExecCommand;

  it('populated → downgrades safe to review with a livePopulation evidence block', async () => {
    const exec = makePopulationExec(40);
    const result = await safeToDeleteFieldHandler(
      ctx,
      { fieldId: SAFE_FIELD, liveEnabled: true },
      exec,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, livePopulation, trust } = result.value.data;
    expect(verdict).toBe('review');
    expect(livePopulation).toBeDefined();
    expect(livePopulation?.totalCount).toBe(100);
    expect(livePopulation?.populatedCount).toBe(40);
    expect(livePopulation?.objectApiName).toBe('Account');
    expect(livePopulation?.fieldApiName).toBe('Safe__c');
    expect(trust.provenance).toBe('hybrid');
    expect(trust.limitations.some((l) => l.includes('downgraded from safe to review'))).toBe(true);
  });

  it('zero population → safe stands, with the live evidence block still attached', async () => {
    const exec = makePopulationExec(0);
    const result = await safeToDeleteFieldHandler(
      ctx,
      { fieldId: SAFE_FIELD, liveEnabled: true },
      exec,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, livePopulation, trust } = result.value.data;
    expect(verdict).toBe('safe');
    expect(livePopulation).toBeDefined();
    expect(livePopulation?.populatedCount).toBe(0);
    expect(livePopulation?.totalCount).toBe(100);
    // The cross-check RAN (evidence attached) — trust reflects the fused answer.
    expect(trust.provenance).toBe('hybrid');
  });

  it('live unavailable (no consent, no liveEnabled) → static verdict stands with a disclosure', async () => {
    const throwExec: ExecCommand = (async () => {
      throw new Error('sf must NOT be spawned — live plane is not enabled');
    }) as ExecCommand;
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: SAFE_FIELD }, throwExec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, livePopulation, trust } = result.value.data;
    expect(verdict).toBe('safe');
    expect(livePopulation).toBeUndefined();
    expect(trust.provenance).toBe('offline_snapshot');
    expect(trust.limitations).toContain('static-only verdict; live population not checked');
  });

  it('live error (budget exhausted) → fails soft to the static verdict with a disclosure, never crashes', async () => {
    const prevBudget = process.env.SFI_LIVE_QUERY_BUDGET;
    process.env.SFI_LIVE_QUERY_BUDGET = '0';
    try {
      const exec = makePopulationExec(40);
      const result = await safeToDeleteFieldHandler(
        ctx,
        { fieldId: SAFE_FIELD, liveEnabled: true },
        exec,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { verdict, livePopulation, trust } = result.value.data;
      // Never a downgrade, never a crash — the offline answer stands alone.
      expect(verdict).toBe('safe');
      expect(livePopulation).toBeUndefined();
      expect(trust.provenance).toBe('offline_snapshot');
      expect(trust.limitations).toContain('static-only verdict; live population not checked');
    } finally {
      if (prevBudget === undefined) delete process.env.SFI_LIVE_QUERY_BUDGET;
      else process.env.SFI_LIVE_QUERY_BUDGET = prevBudget;
    }
  });

  it('never attempts a live call when the static verdict is NOT safe (budget-neutral)', async () => {
    // FLOW_FIELD is `blocking` (a Flow reads it) — the live cross-check must
    // never fire regardless of liveEnabled, so a throwing exec here would only
    // matter if the (wrongly) reached call spawned it.
    const throwExec: ExecCommand = (async () => {
      throw new Error('live must NEVER be reached for a non-safe verdict');
    }) as ExecCommand;
    const result = await safeToDeleteFieldHandler(
      ctx,
      { fieldId: FLOW_FIELD, liveEnabled: true },
      throwExec,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
    expect(result.value.data.livePopulation).toBeUndefined();
    expect(result.value.data.trust.provenance).toBe('offline_snapshot');
  });
});

// =============================================================================
// Finding #35 — format: 'proposal' emits a LOCAL destructiveChanges.xml bundle.
// =============================================================================

/** Strip XML comments + prolog so the tag-balance check ignores comment bodies. */
const stripCommentsAndProlog = (xml: string): string =>
  xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?xml[^>]*\?>/g, '');

/** Minimal well-formedness check: tags balance and nest. */
const isWellFormed = (xml: string): boolean => {
  const body = stripCommentsAndProlog(xml);
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w.-]*)(\s[^>]*)?(\/?)>/g)) {
    const closing = m[1] === '/';
    const name = m[2] ?? '';
    const selfClose = m[4] === '/';
    if (selfClose) continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
};

const fileByPath = (
  files: readonly { path: string; contents: string }[],
  path: string,
): string => files.find((f) => f.path === path)?.contents ?? '';

describe('safeToDeleteFieldHandler — format: proposal (Finding #35)', () => {
  it('emits a well-formed destructiveChanges.xml naming the field, with a safe-verdict evidence comment', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: SAFE_FIELD,
      format: 'proposal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proposal = result.value.data.proposal;
    expect(proposal).toBeDefined();
    if (proposal === undefined) return;

    const destructive = fileByPath(proposal.files, 'destructiveChanges.xml');
    const pkg = fileByPath(proposal.files, 'package.xml');
    expect(destructive).toContain('<members>Account.Safe__c</members>');
    expect(destructive).toContain('<name>CustomField</name>');
    expect(destructive).not.toContain('<version>');
    expect(pkg).toContain('<version>62.0</version>');
    expect(isWellFormed(destructive)).toBe(true);
    expect(isWellFormed(pkg)).toBe(true);

    // Evidence is self-justifying: verdict + vault hash + REVIEW banner inline.
    expect(destructive).toContain('verdict: safe');
    expect(destructive).toContain('sha256:fixture');
    expect(destructive).toMatch(/REVIEW BEFORE DEPLOY/i);
    expect(proposal.evidence.verdict).toBe('safe');
    expect(proposal.summary.componentCount).toBe(1);
  });

  it('still emits a proposal for a BLOCKING field, leading the evidence with verdict: blocking', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: FLOW_FIELD,
      format: 'proposal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proposal = result.value.data.proposal;
    expect(proposal).toBeDefined();
    if (proposal === undefined) return;
    expect(result.value.data.verdict).toBe('blocking');
    expect(proposal.evidence.verdict).toBe('blocking');
    const destructive = fileByPath(proposal.files, 'destructiveChanges.xml');
    expect(destructive).toContain('verdict: blocking');
    // The Flow dependency is named in the evidence so the proposal self-justifies.
    expect(proposal.evidence.reasons.join(' ')).toMatch(/flow/i);
    expect(isWellFormed(destructive)).toBe(true);
  });

  it('R6-24-WIRE — proposal evidence names folded report/dashboard ids that would break', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-std-wire24-'));
    const opened = await openGraph(join(dir, 'wire.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const acct = 'CustomObject:Account';
      const reportField = 'CustomField:Account.ReportNamed__c';
      const local: ExtractionResult = {
        nodes: [
          makeNode({ id: acct, type: 'CustomObject', apiName: 'Account' }),
          makeNode({
            id: reportField,
            apiName: 'ReportNamed__c',
            parentId: acct,
            properties: {
              dataType: 'Text',
              usedInReport: true,
              usedInDashboard: true,
              usedInReports: ['Exec/Forecast', 'Sales/Pipeline'],
              usedInDashboards: ['Exec/KPIs'],
            },
          }),
        ],
        edges: [makeEdge({ fromId: acct, toId: reportField, edgeType: 'parentOf' })],
      };
      const imp = await importExtractionResults(s, [local]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s, liveCapability: mintLiveCapability('opt-in') };
      const result = await safeToDeleteFieldHandler(localCtx, {
        fieldId: reportField,
        format: 'proposal',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.verdict).toBe('blocking');
      expect(result.value.data.reportUsage?.reportNames).toEqual([
        'Exec/Forecast',
        'Sales/Pipeline',
      ]);
      expect(result.value.data.reportUsage?.dashboardNames).toEqual(['Exec/KPIs']);
      const analytics = result.value.data.reasoning.find((r) => r.category === 'analytics');
      expect(analytics?.examples.map((e) => e.id)).toEqual(
        expect.arrayContaining([
          'Report:Exec/Forecast',
          'Report:Sales/Pipeline',
          'Dashboard:Exec/KPIs',
        ]),
      );
      const proposal = result.value.data.proposal;
      expect(proposal).toBeDefined();
      if (proposal === undefined) return;
      const evidenceBlob = proposal.evidence.reasons.join(' ');
      expect(evidenceBlob).toContain('Sales/Pipeline');
      expect(evidenceBlob).toContain('Exec/Forecast');
      expect(evidenceBlob).toContain('Exec/KPIs');
      expect(evidenceBlob).toMatch(/would break/i);
      const destructive = fileByPath(proposal.files, 'destructiveChanges.xml');
      expect(destructive).toContain('Sales/Pipeline');
      expect(destructive).toContain('Exec/KPIs');
      expect(isWellFormed(destructive)).toBe(true);
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not attach a proposal for the default json format', async () => {
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: SAFE_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.proposal).toBeUndefined();
  });
});

// GUARD (L2 alias OS / ADMIN-SURFACE-ALIAS-SKEW-CLUSTER): pre-fix the schema
// required `fieldId` and Zod-STRIPPED `componentId: CustomField:…` -> `fieldId:
// Required`. Post-fix the componentId alias resolves to the SAME verdict as the
// canonical fieldId; disagreeing values -> invalid-query. Built on the current
// L1-gated file (does not revert the trust-gate change).
describe('safeToDeleteFieldHandler — componentId ↔ fieldId alias', () => {
  const run = async (raw: unknown) => {
    const parsed = safeToDeleteFieldInputSchema.safeParse(raw);
    if (!parsed.success) return null;
    return safeToDeleteFieldHandler(ctx, parsed.data);
  };

  it('natural componentId ≡ canonical fieldId (byte-equal verdict + data)', async () => {
    const byField = await run({ fieldId: SAFE_FIELD });
    const byComponent = await run({ componentId: SAFE_FIELD });
    expect(byField).not.toBeNull();
    expect(byComponent).not.toBeNull();
    if (!byField?.ok || !byComponent?.ok) return;
    expect(byComponent.value.data.fieldId).toBe(SAFE_FIELD);
    expect(byComponent.value.data.verdict).toBe(byField.value.data.verdict);
    expect(byComponent.value.data).toEqual(byField.value.data);
  });

  it('disagreeing fieldId / componentId → invalid-query', async () => {
    const parsed = safeToDeleteFieldInputSchema.safeParse({
      fieldId: SAFE_FIELD,
      componentId: 'CustomField:Account.Other_Field__c',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await safeToDeleteFieldHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('neither fieldId nor componentId → schema rejects', () => {
    expect(safeToDeleteFieldInputSchema.safeParse({}).success).toBe(false);
  });
});

// =============================================================================
// CITATION HONESTY — the four defects below all share one shape: a note or a
// description that PROMISED evidence the payload did not carry, or described a
// dependency as something it is not. One fabricated citation (a roll-up summary
// that did not exist) already shipped on this branch; these pin the rest.
// All fixture names are invented.
// =============================================================================

describe('safeToDeleteFieldHandler — per-example citation provenance', () => {
  it('stamps rollupRole on every roll-up example, including summaryFilterItem', async () => {
    // Three roll-ups on the parent, one per declared role. Pre-fix the note
    // described only summarizedField + summaryForeignKey, so a summaryFilterItem
    // coupling — a THIRD of roll-up edges on the reference vault — was cited as
    // something it is not.
    const fieldId = 'CustomField:Opportunity.Stage_Flag__c';
    const summarized = 'CustomField:Account.Total_Amount__c';
    const foreignKey = 'CustomField:Account.Open_Count__c';
    const filterItem = 'CustomField:Account.Won_Count__c';
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: fieldId, apiName: 'Stage_Flag__c', parentId: ACCOUNT_ID }),
        makeNode({ id: summarized, apiName: 'Total_Amount__c', parentId: ACCOUNT_ID }),
        makeNode({ id: foreignKey, apiName: 'Open_Count__c', parentId: ACCOUNT_ID }),
        makeNode({ id: filterItem, apiName: 'Won_Count__c', parentId: ACCOUNT_ID }),
      ],
      edges: (
        [
          [summarized, 'summarizedField'],
          [foreignKey, 'summaryForeignKey'],
          [filterItem, 'summaryFilterItem'],
        ] as const
      ).map(([fromId, rollupRole]) =>
        makeEdge({
          fromId,
          toId: fieldId,
          edgeType: 'references',
          source: 'rollup-summary',
          properties: { rollupRole, summaryOperation: 'sum' },
        }),
      ),
    };
    const imported = await importExtractionResults(store, [seed]);
    expect(imported.ok).toBe(true);

    const result = await safeToDeleteFieldHandler(ctx, { fieldId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rollup = result.value.data.reasoning.find((r) => r.category === 'rollup');
    expect(rollup).toBeDefined();
    expect(rollup?.verdict).toBe('blocking');
    expect(rollup?.count).toBe(3);
    // Each citation names ITS OWN coupling, not the list of possibilities.
    const byId = new Map(rollup?.examples.map((e) => [e.id, e.rollupRole]));
    expect(byId.get(summarized)).toBe('summarizedField');
    expect(byId.get(foreignKey)).toBe('summaryForeignKey');
    expect(byId.get(filterItem)).toBe('summaryFilterItem');
    // …and the note must name all three roles, not two.
    expect(rollup?.note).toContain('summarizedField');
    expect(rollup?.note).toContain('summaryForeignKey');
    expect(rollup?.note).toContain('summaryFilterItem');
  });

  it('renders the rollupRole into the checklist and the proposal evidence', async () => {
    const fieldId = 'CustomField:Opportunity.Filter_Only__c';
    const rollupField = 'CustomField:Account.Filtered_Total__c';
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: fieldId, apiName: 'Filter_Only__c', parentId: ACCOUNT_ID }),
        makeNode({ id: rollupField, apiName: 'Filtered_Total__c', parentId: ACCOUNT_ID }),
      ],
      edges: [
        makeEdge({
          fromId: rollupField,
          toId: fieldId,
          edgeType: 'references',
          source: 'rollup-summary',
          properties: { rollupRole: 'summaryFilterItem' },
        }),
      ],
    };
    const imported = await importExtractionResults(store, [seed]);
    expect(imported.ok).toBe(true);

    const checklist = await safeToDeleteFieldHandler(ctx, {
      fieldId,
      format: 'checklist',
    });
    expect(checklist.ok).toBe(true);
    if (!checklist.ok) return;
    expect(checklist.value.data.checklist).toContain('as summaryFilterItem');

    const proposal = await safeToDeleteFieldHandler(ctx, {
      fieldId,
      format: 'proposal',
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.data.proposal?.evidence.reasons.join(' ')).toContain(
      'as summaryFilterItem',
    );
  });

  it('surfaces the traversalPath the formula note promises, and renders it', async () => {
    // Pre-fix the `formula` note promised "a traversal-derived one also carries
    // the `traversalPath` it was resolved from" — but no such field existed on
    // the example type and nothing populated or rendered it.
    const fieldId = 'CustomField:Programme__c.Status__c';
    const formulaField = 'CustomField:Enrolment__c.Programme_Status__c';
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: fieldId, apiName: 'Status__c', parentId: ACCOUNT_ID }),
        makeNode({
          id: formulaField,
          apiName: 'Programme_Status__c',
          parentId: ACCOUNT_ID,
        }),
      ],
      edges: [
        makeEdge({
          fromId: formulaField,
          toId: fieldId,
          edgeType: 'references',
          source: 'relationship-resolver',
          confidence: 'parsed',
          properties: {
            referenceKind: 'formulaRelationshipTraversal',
            traversalPath: 'Programme__r.Status__c',
          },
        }),
      ],
    };
    const imported = await importExtractionResults(store, [seed]);
    expect(imported.ok).toBe(true);

    const result = await safeToDeleteFieldHandler(ctx, { fieldId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const formula = result.value.data.reasoning.find((r) => r.category === 'formula');
    expect(formula).toBeDefined();
    expect(formula?.verdict).toBe('blocking');
    expect(formula?.examples[0]?.id).toBe(formulaField);
    expect(formula?.examples[0]?.traversalPath).toBe('Programme__r.Status__c');
    // The note's promise is now honoured by the payload AND both renderers.
    expect(formula?.note).toContain('traversalPath');

    const checklist = await safeToDeleteFieldHandler(ctx, {
      fieldId,
      format: 'checklist',
    });
    expect(checklist.ok).toBe(true);
    if (!checklist.ok) return;
    expect(checklist.value.data.checklist).toContain('via Programme__r.Status__c');

    const proposal = await safeToDeleteFieldHandler(ctx, {
      fieldId,
      format: 'proposal',
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.value.data.proposal?.evidence.reasons.join(' ')).toContain(
      'via Programme__r.Status__c',
    );
  });

  it('names the actual condition FIRER, not just the ConditionalContext node', async () => {
    // Seven firer families mint condition edges; pre-fix the note named four,
    // so an ApprovalProcess blocker was described as a Flow / workflow rule.
    const fieldId = 'CustomField:Account.Approval_Amount__c';
    const firerId = 'ApprovalProcess:Account.Big_Deal_Approval';
    const contextId = `ConditionalContext:${firerId}.condition-0`;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({
          id: fieldId,
          apiName: 'Approval_Amount__c',
          parentId: ACCOUNT_ID,
        }),
        makeNode({
          id: contextId,
          type: 'ConditionalContext',
          apiName: `${firerId}.condition-0`,
        }),
      ],
      edges: [
        makeEdge({
          fromId: contextId,
          toId: fieldId,
          edgeType: 'readsFrom',
          source: 'condition-extractor',
          properties: { kind: 'criteria', conditionIndex: 0, firerId },
        }),
      ],
    };
    const imported = await importExtractionResults(store, [seed]);
    expect(imported.ok).toBe(true);

    const result = await safeToDeleteFieldHandler(ctx, { fieldId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const condition = result.value.data.reasoning.find(
      (r) => r.category === 'condition',
    );
    expect(condition).toBeDefined();
    expect(condition?.verdict).toBe('blocking');
    expect(condition?.examples[0]?.firerId).toBe(firerId);
    // All seven wired firer families must be named — an approval-process
    // blocker described as a Flow criterion is a false citation.
    for (const family of [
      'Flow',
      'validation-rule',
      'workflow-rule',
      'approval-process',
      'assignment-rule',
      'auto-response-rule',
      'escalation-rule',
    ]) {
      expect(condition?.note).toContain(family);
    }

    const checklist = await safeToDeleteFieldHandler(ctx, {
      fieldId,
      format: 'checklist',
    });
    expect(checklist.ok).toBe(true);
    if (!checklist.ok) return;
    expect(checklist.value.data.checklist).toContain(`fired by ${firerId}`);
  });

  it('never invents a qualifier for an edge that did not stamp one', async () => {
    // The anti-fabrication pin: a plain Apex readsFrom carries no traversal,
    // role or firer, so the example must carry none — a defaulted qualifier
    // would be a fabricated citation on an otherwise correct verdict.
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: APEX_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const apex = result.value.data.reasoning.find((r) => r.category === 'apex');
    const example = apex?.examples[0];
    expect(example).toBeDefined();
    expect(example?.traversalPath).toBeUndefined();
    expect(example?.rollupRole).toBeUndefined();
    expect(example?.firerId).toBeUndefined();
    // …and the rendered citation stays a bare id.
    const checklist = await safeToDeleteFieldHandler(ctx, {
      fieldId: APEX_FIELD,
      format: 'checklist',
    });
    expect(checklist.ok).toBe(true);
    if (!checklist.ok) return;
    expect(checklist.value.data.checklist).toContain(APEX_READER);
    // No qualifier parenthetical follows the id — the citation is a bare id.
    expect(checklist.value.data.checklist).not.toContain(`${APEX_READER} (`);
  });
});

// =============================================================================
// UPGRADE PATH — a user who installs the new build and does NOT re-refresh has
// a vault with none of the new edge families, so they get exactly the
// false-`safe` this release exists to fix. The coverage caveat cannot see it:
// the metadata families WERE retrieved; the extractor that reads them did not
// exist yet.
// =============================================================================

describe('safeToDeleteFieldHandler — stale-builder upgrade path', () => {
  const PLUGIN_ENV = 'SFI_PLUGIN_VERSION';

  afterEach(() => {
    delete process.env[PLUGIN_ENV];
  });

  /** ctx whose vault manifest records the builder version `version`. */
  const ctxBuiltBy = (version: string): Context => ({
    ...ctx,
    manifest: { ...FIXTURE_MANIFEST, version },
  });

  it('routes an otherwise-safe verdict to review and discloses why', async () => {
    process.env[PLUGIN_ENV] = '0.3.0';
    const result = await safeToDeleteFieldHandler(ctxBuiltBy('0.2.1'), {
      fieldId: SAFE_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, builderVersionCaveat, trust, reasoning } = result.value.data;
    // NOT proven safe — same treatment incomplete coverage already gets.
    expect(verdict).toBe('review');
    // …and not by inventing a dependency that does not exist.
    expect(reasoning).toHaveLength(0);
    expect(builderVersionCaveat).toBeDefined();
    expect(builderVersionCaveat).toContain('0.2.1');
    expect(builderVersionCaveat).toContain('0.3.0');
    expect(builderVersionCaveat).toMatch(/sfi refresh/);
    // Mirrored into limitations so the proposal artifact discloses it too.
    expect(trust.limitations.some((l) => l === builderVersionCaveat)).toBe(true);
  });

  it('surfaces the caveat above the verdict in the checklist (which renders no trust block)', async () => {
    process.env[PLUGIN_ENV] = '0.3.0';
    const result = await safeToDeleteFieldHandler(ctxBuiltBy('0.2.1'), {
      fieldId: SAFE_FIELD,
      format: 'checklist',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const checklist = result.value.data.checklist ?? '';
    expect(checklist).toMatch(/Stale vault/i);
    expect(checklist.indexOf('Stale vault')).toBeLessThan(
      checklist.indexOf('**Verdict:'),
    );
  });

  it('carries the caveat into the proposal disclosures', async () => {
    process.env[PLUGIN_ENV] = '0.3.0';
    const result = await safeToDeleteFieldHandler(ctxBuiltBy('0.2.1'), {
      fieldId: SAFE_FIELD,
      format: 'proposal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proposal = result.value.data.proposal;
    expect(proposal?.evidence.verdict).toBe('review');
    expect(proposal?.evidence.disclosures.join(' ')).toContain('0.2.1');
  });

  it('still discloses on a blocking verdict, without moving it', async () => {
    // A stale vault makes the EVIDENCE incomplete regardless of the verdict, so
    // the reader is told even when the verdict does not move. The caveat only
    // ever demotes safe -> review; it never upgrades or downgrades anything else.
    process.env[PLUGIN_ENV] = '0.3.0';
    const result = await safeToDeleteFieldHandler(ctxBuiltBy('0.2.1'), {
      fieldId: FLOW_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
    expect(result.value.data.builderVersionCaveat).toBeDefined();
  });

  it('stays silent when the vault builder matches, is newer, or the env is unset', async () => {
    const safeVerdict = async (c: Context): Promise<string> => {
      const r = await safeToDeleteFieldHandler(c, { fieldId: SAFE_FIELD });
      expect(r.ok).toBe(true);
      if (!r.ok) return 'error';
      expect(r.value.data.builderVersionCaveat).toBeUndefined();
      return r.value.data.verdict;
    };
    process.env[PLUGIN_ENV] = '0.3.0';
    expect(await safeVerdict(ctxBuiltBy('0.3.0'))).toBe('safe');
    // A DOWNGRADE must not nag: an older running plugin implies nothing missing
    // from a vault a newer one built.
    expect(await safeVerdict(ctxBuiltBy('0.4.0'))).toBe('safe');
    delete process.env[PLUGIN_ENV];
    expect(await safeVerdict(ctxBuiltBy('0.2.1'))).toBe('safe');
  });

  it('never downgrades on an unparseable version on either side', async () => {
    // A guess must never cost a user a `safe` verdict.
    process.env[PLUGIN_ENV] = 'dev';
    const a = await safeToDeleteFieldHandler(ctxBuiltBy('0.2.1'), {
      fieldId: SAFE_FIELD,
    });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.value.data.verdict).toBe('safe');

    process.env[PLUGIN_ENV] = '0.3.0';
    const b = await safeToDeleteFieldHandler(ctxBuiltBy(''), {
      fieldId: SAFE_FIELD,
    });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value.data.verdict).toBe('safe');
  });
});

// =============================================================================
// GUARD (0.3.0): ONE referrer must be counted ONCE.
//
// FAIL-BEFORE: a ValidationRule reaches every field its `errorConditionFormula`
// names by TWO edges tokenized from that one string in one extractor pass —
// `ValidationRule -> CustomField` `references` (source formula-tokenizer) and
// `ConditionalContext:ValidationRule:X.condition-0 -> CustomField` `readsFrom`
// (source condition-extractor, firerId = the rule). The graph edge PK is
// (from_id, to_id, edge_type, source) and the rows differ in three of those
// four columns, so nothing dedups them — correctly, they are two FACTS. But the
// per-edge bucket loop counted per EDGE, so ONE rule was reported as TWO
// blockers under TWO categories with two counts and two examples. On the
// reference vault: 681 such pairs, and 17 fields whose ENTIRE non-structural
// incoming set is one duplicated pair (the checklist printed "condition (1)"
// AND "formula (1)" for a field with one dependency). Inflated referrer counts
// are precisely the clone-propagation double-count this product's own
// field-audit method warns against.
//
// The three cases below pin the fix AND its two boundaries: an additive
// condition must still surface, and a Flow that WRITES and separately TESTS one
// field must still report two rows (that collapse would delete real signal —
// a write and a condition-test have different remediations).
// =============================================================================
describe('safeToDeleteFieldHandler — validation-rule referrer collapse', () => {
  const BOTH_FIELD = 'CustomField:Account.VrBothPaths__c';
  const BOTH_RULE = 'ValidationRule:Account.RequiresBothPaths';
  const BOTH_CONTEXT =
    'ConditionalContext:ValidationRule:Account.RequiresBothPaths.condition-0';

  const ADDITIVE_FIELD = 'CustomField:Account.VrConditionOnly__c';
  const ADDITIVE_RULE = 'ValidationRule:Account.CrossObjectRule';
  const ADDITIVE_CONTEXT =
    'ConditionalContext:ValidationRule:Account.CrossObjectRule.condition-0';

  const FLOW_BOTH_FIELD = 'CustomField:Account.FlowWritesAndTests__c';
  const FLOW_BOTH = 'Flow:Account_Stage_Router';
  const FLOW_BOTH_CONTEXT = 'ConditionalContext:Flow:Account_Stage_Router.condition-0';

  beforeAll(async () => {
    const imported = await importExtractionResults(store, [
      {
        nodes: [
          makeNode({
            id: BOTH_FIELD,
            apiName: 'VrBothPaths__c',
            parentId: ACCOUNT_ID,
          }),
          makeNode({
            id: BOTH_RULE,
            type: 'ValidationRule',
            apiName: 'RequiresBothPaths',
          }),
          makeNode({
            id: BOTH_CONTEXT,
            type: 'ConditionalContext',
            apiName: 'ValidationRule:Account.RequiresBothPaths.condition-0',
            parentId: BOTH_RULE,
          }),
        ],
        edges: [
          // Direct tokenized reference (buildReferencesEdges).
          makeEdge({
            fromId: BOTH_RULE,
            toId: BOTH_FIELD,
            edgeType: 'references',
            source: 'formula-tokenizer',
            confidence: 'parsed',
            properties: { tokenizedFromField: 'errorConditionFormula' },
          }),
          // The SAME string, tokenized again by extractConditions.
          makeEdge({
            fromId: BOTH_CONTEXT,
            toId: BOTH_FIELD,
            edgeType: 'readsFrom',
            source: 'condition-extractor',
            confidence: 'parsed',
            properties: {
              kind: 'formula',
              conditionIndex: 0,
              firerId: BOTH_RULE,
            },
          }),
        ],
      },
      {
        // ADDITIVE: the condition reaches a field the direct tokenizer DROPPED
        // (it discards dotted cross-object paths; the condition extractor keeps
        // them verbatim). No direct edge from this rule to this field, so
        // nothing may collapse.
        nodes: [
          makeNode({
            id: ADDITIVE_FIELD,
            apiName: 'VrConditionOnly__c',
            parentId: ACCOUNT_ID,
          }),
          makeNode({
            id: ADDITIVE_RULE,
            type: 'ValidationRule',
            apiName: 'CrossObjectRule',
          }),
          makeNode({
            id: ADDITIVE_CONTEXT,
            type: 'ConditionalContext',
            apiName: 'ValidationRule:Account.CrossObjectRule.condition-0',
            parentId: ADDITIVE_RULE,
          }),
        ],
        edges: [
          makeEdge({
            fromId: ADDITIVE_CONTEXT,
            toId: ADDITIVE_FIELD,
            edgeType: 'readsFrom',
            source: 'condition-extractor',
            confidence: 'parsed',
            properties: {
              kind: 'formula',
              conditionIndex: 0,
              firerId: ADDITIVE_RULE,
            },
          }),
        ],
      },
      {
        // NEGATIVE: a Flow that WRITES the field and separately TESTS it in a
        // decision. Two facts, two remediations — must stay two rows.
        nodes: [
          makeNode({
            id: FLOW_BOTH_FIELD,
            apiName: 'FlowWritesAndTests__c',
            parentId: ACCOUNT_ID,
          }),
          makeNode({
            id: FLOW_BOTH,
            type: 'Flow',
            apiName: 'Account_Stage_Router',
          }),
          makeNode({
            id: FLOW_BOTH_CONTEXT,
            type: 'ConditionalContext',
            apiName: 'Flow:Account_Stage_Router.condition-0',
            parentId: FLOW_BOTH,
          }),
        ],
        edges: [
          makeEdge({
            fromId: FLOW_BOTH,
            toId: FLOW_BOTH_FIELD,
            edgeType: 'writesTo',
            source: 'flow-extractor',
            confidence: 'declared',
          }),
          makeEdge({
            fromId: FLOW_BOTH_CONTEXT,
            toId: FLOW_BOTH_FIELD,
            edgeType: 'readsFrom',
            source: 'condition-extractor',
            confidence: 'declared',
            properties: {
              kind: 'flow-decision',
              conditionIndex: 0,
              firerId: FLOW_BOTH,
            },
          }),
        ],
      },
    ]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  it('counts a rule that reaches the field BOTH ways once, in the validation category', async () => {
    const result = await safeToDeleteFieldHandler(ctx, { fieldId: BOTH_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('blocking');

    // ONE reason, ONE referrer, ONE citation — not condition(1) + formula(1).
    expect(reasoning.map((r) => r.category)).toEqual(['validation']);
    const validation = reasoning[0];
    expect(validation?.count).toBe(1);
    expect(validation?.verdict).toBe('blocking');
    expect(validation?.examples.map((e) => e.id)).toEqual([BOTH_RULE]);

    // The surviving category is the TRUTHFUL one: a validation rule is not
    // "another formula field", which is what the unscoped formula-tokenizer
    // rule used to label it.
    expect(validation?.note).toContain('Validation Rule');
    // Collapse by DISCLOSURE: the folded category is named on the citation and
    // the note keeps the condition honesty hedge.
    expect(validation?.examples[0]?.alsoVia).toEqual(['condition']);
    expect(validation?.note).toContain('NOT evaluated');
  });

  it('renders one checklist item that discloses the folded condition row', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: BOTH_FIELD,
      format: 'checklist',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = result.value.data.checklist ?? '';
    expect(rendered).toContain('**validation** (1)');
    // FAIL-BEFORE: the checklist printed BOTH of these for one rule.
    expect(rendered).not.toContain('**condition** (1)');
    expect(rendered).not.toContain('**formula** (1)');
    expect(rendered).toContain(`${BOTH_RULE} (also via condition)`);
  });

  it('keeps an ADDITIVE condition (no direct edge from that rule) as its own blocker', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: ADDITIVE_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { verdict, reasoning } = result.value.data;
    expect(verdict).toBe('blocking');
    const condition = reasoning.find((r) => r.category === 'condition');
    expect(condition).toBeDefined();
    expect(condition?.count).toBe(1);
    expect(condition?.examples[0]?.id).toBe(ADDITIVE_CONTEXT);
    expect(condition?.examples[0]?.firerId).toBe(ADDITIVE_RULE);
    expect(condition?.examples[0]?.alsoVia).toBeUndefined();
  });

  it('does NOT collapse a Flow that writes AND tests the same field', async () => {
    const result = await safeToDeleteFieldHandler(ctx, {
      fieldId: FLOW_BOTH_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { reasoning } = result.value.data;
    const flow = reasoning.find((r) => r.category === 'flow');
    const condition = reasoning.find((r) => r.category === 'condition');
    // A write and a condition-test are different facts with different
    // remediations. Two rows, one each.
    expect(flow?.count).toBe(1);
    expect(condition?.count).toBe(1);
    expect(condition?.examples[0]?.firerId).toBe(FLOW_BOTH);
  });
});
