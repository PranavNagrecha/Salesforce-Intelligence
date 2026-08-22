/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  whyFieldChangedHandler,
  whyFieldChangedInputSchema,
} from '../../src/tools/why-field-changed.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 3 },
  edges: { parentOf: 3, writesTo: 4, firesWhen: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
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
// Seed: an Account.Industry field with 4 writers:
//   - Flow:UpdateIndustryFlow writes (declared)
//   - WorkflowRule:Account.SetIndustry writes (declared) with firesWhen
//   - ApexClass:AccountHandler writes (heuristic, apex-scanner)
//   - ApexTrigger:AccountTrigger writes (heuristic, with events array)
// Plus a 5th unrelated writer (to a different field) used to verify
// the field filter works correctly.
// =============================================================================

const ACCOUNT_OBJ = 'CustomObject:Account';
const INDUSTRY_FIELD = 'CustomField:Account.Industry';
const REVENUE_FIELD = 'CustomField:Account.Revenue';
const UNREFD_FIELD = 'CustomField:Account.Unreferenced';

const FLOW_ID = 'Flow:UpdateIndustryFlow';
const WORKFLOW_ID = 'WorkflowRule:Account.SetIndustry';
const WORKFLOW_COND_ID =
  'ConditionalContext:WorkflowRule:Account.SetIndustry.condition-0';
const APEX_CLASS_ID = 'ApexClass:AccountHandler';
const APEX_TRIGGER_ID = 'ApexTrigger:AccountTrigger';
const UNRELATED_FLOW_ID = 'Flow:UpdatesRevenueOnly';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT_OBJ, apiName: 'Account' }),
    makeNode({
      id: INDUSTRY_FIELD,
      type: 'CustomField',
      apiName: 'Industry',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: REVENUE_FIELD,
      type: 'CustomField',
      apiName: 'Revenue',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: UNREFD_FIELD,
      type: 'CustomField',
      apiName: 'Unreferenced',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: FLOW_ID,
      type: 'Flow',
      apiName: 'UpdateIndustryFlow',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: WORKFLOW_ID,
      type: 'WorkflowRule',
      apiName: 'Account.SetIndustry',
      parentId: ACCOUNT_OBJ,
      properties: { triggerType: 'onCreateOnly' },
    }),
    makeNode({
      id: WORKFLOW_COND_ID,
      type: 'ConditionalContext',
      apiName: 'WorkflowRule:Account.SetIndustry.condition-0',
      parentId: WORKFLOW_ID,
      properties: {
        kind: 'criteria',
        expression: 'Account.Type equals New',
        fieldRefs: ['CustomField:Account.Type'],
        synthesized: false,
      },
    }),
    makeNode({
      id: APEX_CLASS_ID,
      type: 'ApexClass',
      apiName: 'AccountHandler',
    }),
    makeNode({
      id: APEX_TRIGGER_ID,
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      properties: {
        events: ['before insert', 'after update'],
      },
    }),
    makeNode({
      id: UNRELATED_FLOW_ID,
      type: 'Flow',
      apiName: 'UpdatesRevenueOnly',
    }),
  ],
  edges: [
    makeEdge({
      fromId: ACCOUNT_OBJ,
      toId: INDUSTRY_FIELD,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: ACCOUNT_OBJ,
      toId: REVENUE_FIELD,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: ACCOUNT_OBJ,
      toId: UNREFD_FIELD,
      edgeType: 'parentOf',
    }),
    // Flow writes (declared).
    makeEdge({
      fromId: FLOW_ID,
      toId: INDUSTRY_FIELD,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      properties: { operation: 'recordUpdate' },
    }),
    // WorkflowRule writes (declared) + firesWhen.
    makeEdge({
      fromId: WORKFLOW_ID,
      toId: INDUSTRY_FIELD,
      edgeType: 'writesTo',
      source: 'workflow-rule-extractor',
    }),
    makeEdge({
      fromId: WORKFLOW_ID,
      toId: WORKFLOW_COND_ID,
      edgeType: 'firesWhen',
    }),
    // ApexClass writes (heuristic).
    makeEdge({
      fromId: APEX_CLASS_ID,
      toId: INDUSTRY_FIELD,
      edgeType: 'writesTo',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
    // ApexTrigger writes (heuristic).
    makeEdge({
      fromId: APEX_TRIGGER_ID,
      toId: INDUSTRY_FIELD,
      edgeType: 'writesTo',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
    // Unrelated writer to a different field.
    makeEdge({
      fromId: UNRELATED_FLOW_ID,
      toId: REVENUE_FIELD,
      edgeType: 'writesTo',
      source: 'flow-extractor',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-why-fc-'));
  const dbPath = join(tempDir, 'why-fc.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
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

describe('whyFieldChangedHandler', () => {
  it('rejects a non-CustomField prefix with invalid-query', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: 'Flow:NotAField',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('fieldId');
  });

  it('returns component-not-found for an unknown CustomField id', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: 'CustomField:Account.DoesNotExist',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomField:Account.DoesNotExist');
  });

  it('lists every writer to the field', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { writers } = result.value.data;
    expect(writers.length).toBe(4);
    const ids = writers.map((w) => w.id);
    expect(ids).toContain(FLOW_ID);
    expect(ids).toContain(WORKFLOW_ID);
    expect(ids).toContain(APEX_CLASS_ID);
    expect(ids).toContain(APEX_TRIGGER_ID);
    // The unrelated writer points at a different field.
    expect(ids).not.toContain(UNRELATED_FLOW_ID);
  });

  it('sorts writers by id ASC for deterministic output', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.writers.map((w) => w.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('surfaces the firesWhen condition on a writer that has one', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const workflow = result.value.data.writers.find((w) => w.id === WORKFLOW_ID);
    expect(workflow?.conditional?.conditionContextId).toBe(WORKFLOW_COND_ID);
    expect(workflow?.conditional?.expression).toBe('Account.Type equals New');
  });

  it('omits the conditional field on writers without a firesWhen edge', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flow = result.value.data.writers.find((w) => w.id === FLOW_ID);
    expect(flow?.conditional).toBeUndefined();
  });

  it('surfaces triggerEvent on ApexTrigger writers', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trigger = result.value.data.writers.find(
      (w) => w.id === APEX_TRIGGER_ID,
    );
    expect(trigger?.triggerEvent).toBe('before insert, after update');
  });

  it('omits triggerEvent for non-trigger writers', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flow = result.value.data.writers.find((w) => w.id === FLOW_ID);
    expect(flow?.triggerEvent).toBeUndefined();
    const apex = result.value.data.writers.find((w) => w.id === APEX_CLASS_ID);
    expect(apex?.triggerEvent).toBeUndefined();
  });

  it('reports the edge confidence verbatim per writer', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flow = result.value.data.writers.find((w) => w.id === FLOW_ID);
    const apex = result.value.data.writers.find((w) => w.id === APEX_CLASS_ID);
    expect(flow?.confidence).toBe('declared');
    expect(apex?.confidence).toBe('heuristic');
  });

  it('categorises declared vs heuristic writers in summary', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { summary } = result.value.data;
    // Flow + WorkflowRule = 2 declared writers; ApexClass + ApexTrigger = 2 heuristic.
    expect(summary.declaredCount).toBe(2);
    expect(summary.heuristicCount).toBe(2);
  });

  it('returns an empty writer list for a field with no writers', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: UNREFD_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.writers.length).toBe(0);
    expect(result.value.data.summary.declaredCount).toBe(0);
    expect(result.value.data.summary.heuristicCount).toBe(0);
  });

  it('carries the verbatim honesty-axis disclosure', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toBe(
      "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Each writer carries a runnable flag and its declared status: a non-Active Flow (Obsolete/Draft/Inactive/InvalidDraft), an Inactive trigger, an inactive rule, or a TEST class (isTest, status:test-only) is listed with runnable:false and could NOT have written the field in the org's current production state — it is never the sole live suspect. Active-Flow field writes made via an SObject-variable assignment (assignToReference) that the graph did not stamp as a primary writesTo edge are folded in from a supplemental source scan at heuristic confidence (source: flow-field-writers-scan:*); that scan pages EVERY Flow in the vault, and when it stops short (residual ceiling SFI_FLOW_WRITER_SCAN_MAX, or a graph error) supplementalScanTruncation names how many Flows were scanned of how many exist, so an un-scanned writer reads as not checked rather than absent. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.",
    );
  });

  it('echoes the fieldId in the response', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldId).toBe(INDUSTRY_FIELD);
  });
});

describe('whyFieldChangedInputSchema', () => {
  it('accepts a minimal well-formed CustomField id', () => {
    const parsed = whyFieldChangedInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty fieldId', () => {
    const parsed = whyFieldChangedInputSchema.safeParse({
      fieldId: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing fieldId', () => {
    const parsed = whyFieldChangedInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('accepts a CustomField id even when prefix is wrong (handler validates)', () => {
    // The Zod schema only checks non-empty; the prefix check happens
    // inside the handler so the caller gets a typed invalid-query
    // rather than a Zod parse error.
    const parsed = whyFieldChangedInputSchema.safeParse({
      fieldId: 'Flow:NotAField',
    });
    expect(parsed.success).toBe(true);
  });
});

// =============================================================================
// Active-Flow assignment writers + non-runnable partition —
// WHY-FIELD-CHANGED-MISSES-ASSIGNMENT-WRITERS.
//
//   Widget__c.Flag__c    : written by an OBSOLETE Flow via a primary writesTo
//                          edge (dead), AND by an ACTIVE Flow via an
//                          <assignToReference> the graph never stamped
//                          (supplemental source scan). The Active writer must
//                          appear; the Obsolete one must be runnable:false.
//   Widget__c.OnlyDead__c: written ONLY by the OBSOLETE Flow. The sole writer is
//                          non-runnable, so the response must disclose that (note).
// =============================================================================

const WIDGET_OBJ = 'CustomObject:Widget__c';
const FLAG_FIELD = 'CustomField:Widget__c.Flag__c';
const ONLY_DEAD_FIELD = 'CustomField:Widget__c.OnlyDead__c';
const OBSOLETE_FLOW = 'Flow:CloseWidgetObsolete';
const ACTIVE_ASSIGN_FLOW = 'Flow:CloseWidgetActive';

const ACTIVE_FLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <status>Active</status>
  <variables>
    <name>recordVar</name>
    <dataType>SObject</dataType>
    <isCollection>false</isCollection>
    <objectType>Widget__c</objectType>
  </variables>
  <assignments>
    <name>SetFlag</name>
    <assignmentItems>
      <assignToReference>recordVar.Flag__c</assignToReference>
      <operator>Assign</operator>
      <value><stringValue>Resolved</stringValue></value>
    </assignmentItems>
  </assignments>
  <recordUpdates>
    <name>SaveWidget</name>
    <inputReference>recordVar</inputReference>
  </recordUpdates>
</Flow>`;

describe('whyFieldChangedHandler — assignment writers + non-runnable partition', () => {
  let dir: string;
  let s: GraphStore;
  let c: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-why-fc-assign-'));
    mkdirSync(join(dir, 'flows'), { recursive: true });
    writeFileSync(join(dir, 'flows', 'CloseWidgetActive.flow-meta.xml'), ACTIVE_FLOW_XML, 'utf8');

    const opened = await openGraph(join(dir, 'why-fc-assign.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    s = opened.value;

    const assignSeed: ExtractionResult = {
      nodes: [
        makeNode({ id: WIDGET_OBJ, apiName: 'Widget__c' }),
        makeNode({ id: FLAG_FIELD, type: 'CustomField', apiName: 'Flag__c', parentId: WIDGET_OBJ }),
        makeNode({
          id: ONLY_DEAD_FIELD,
          type: 'CustomField',
          apiName: 'OnlyDead__c',
          parentId: WIDGET_OBJ,
        }),
        // Obsolete Flow — a dead writer, reachable only via its primary writesTo edges.
        makeNode({
          id: OBSOLETE_FLOW,
          type: 'Flow',
          apiName: 'CloseWidgetObsolete',
          sourcePath: 'flows/CloseWidgetObsolete.flow-meta.xml', // intentionally not written -> scan skips
          properties: { status: 'Obsolete' },
        }),
        // Active Flow — writes Flag__c only via <assignToReference> (no primary edge).
        makeNode({
          id: ACTIVE_ASSIGN_FLOW,
          type: 'Flow',
          apiName: 'CloseWidgetActive',
          sourcePath: 'flows/CloseWidgetActive.flow-meta.xml',
          properties: { status: 'Active' },
        }),
      ],
      edges: [
        makeEdge({ fromId: WIDGET_OBJ, toId: FLAG_FIELD, edgeType: 'parentOf' }),
        makeEdge({ fromId: WIDGET_OBJ, toId: ONLY_DEAD_FIELD, edgeType: 'parentOf' }),
        makeEdge({
          fromId: OBSOLETE_FLOW,
          toId: FLAG_FIELD,
          edgeType: 'writesTo',
          source: 'flow-extractor',
          properties: { operation: 'recordUpdate' },
        }),
        makeEdge({
          fromId: OBSOLETE_FLOW,
          toId: ONLY_DEAD_FIELD,
          edgeType: 'writesTo',
          source: 'flow-extractor',
          properties: { operation: 'recordUpdate' },
        }),
      ],
    };
    const imported = await importExtractionResults(s, [assignSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    c = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
  });

  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('folds in the Active-Flow assignToReference writer the graph never stamped', async () => {
    const result = await whyFieldChangedHandler(c, { fieldId: FLAG_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.data.writers.map((w) => [w.id, w]));
    const active = byId.get(ACTIVE_ASSIGN_FLOW);
    expect(active).toBeDefined();
    expect(active?.mechanism).toBe('assignToReference');
    expect(active?.confidence).toBe('heuristic');
    expect(active?.runnable).toBe(true);
    expect(active?.status).toBe('Active');
    expect(active?.source.startsWith('flow-field-writers-scan')).toBe(true);
    expect(result.value.data.summary.supplementalCount).toBe(1);
  });

  it('lists the Obsolete Flow as runnable:false with its status, never as the sole live suspect', async () => {
    const result = await whyFieldChangedHandler(c, { fieldId: FLAG_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.data.writers.map((w) => [w.id, w]));
    const obsolete = byId.get(OBSOLETE_FLOW);
    expect(obsolete?.runnable).toBe(false);
    expect(obsolete?.status).toBe('Obsolete');
    const { summary, note } = result.value.data;
    expect(summary.runnableCount).toBe(1);
    expect(summary.nonRunnableCount).toBe(1);
    // A live writer exists (the Active assignment Flow), so no all-dead note.
    expect(note).toBeUndefined();
  });

  it('discloses a non-runnable note when the field\'s ONLY writer is dead automation', async () => {
    const result = await whyFieldChangedHandler(c, { fieldId: ONLY_DEAD_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { writers, summary, note } = result.value.data;
    expect(writers.length).toBe(1);
    expect(writers[0]?.id).toBe(OBSOLETE_FLOW);
    expect(writers[0]?.runnable).toBe(false);
    expect(summary.runnableCount).toBe(0);
    expect(summary.nonRunnableCount).toBe(1);
    expect(summary.supplementalCount).toBe(0);
    expect(note).toBeDefined();
    expect(note).toMatch(/non-runnable|Obsolete/i);
  });
});

// =============================================================================
// Test-class Apex writers are NOT live production writers —
// WHY-FIELD-CHANGED-TEST-WRITERS-MARKED-RUNNABLE.
//
//   Contact.Email : written by a PRODUCTION ApexClass (isTest:false) AND by a
//                   TEST ApexClass (isTest:true). The production writer stays
//                   runnable:true; the test writer must be runnable:false with
//                   status 'test-only' (disclosed, never the sole live suspect).
//   Contact.TestOnly__c : written ONLY by a TEST ApexClass → the sole writer is
//                   non-runnable, so the response discloses that (note).
// =============================================================================

const CONTACT_OBJ = 'CustomObject:Contact';
const EMAIL_FIELD = 'CustomField:Contact.Email';
const TESTONLY_FIELD = 'CustomField:Contact.TestOnly__c';
const PROD_WRITER = 'ApexClass:ContactMergeHandler'; // isTest:false → live
const TEST_WRITER = 'ApexClass:ContactMergeHandlerTest'; // isTest:true → non-runnable

describe('whyFieldChangedHandler — test-class Apex writer partition', () => {
  let dir: string;
  let s: GraphStore;
  let c: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-why-fc-test-'));
    const opened = await openGraph(join(dir, 'why-fc-test.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    s = opened.value;

    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: CONTACT_OBJ, apiName: 'Contact' }),
        makeNode({ id: EMAIL_FIELD, type: 'CustomField', apiName: 'Email', parentId: CONTACT_OBJ }),
        makeNode({
          id: TESTONLY_FIELD,
          type: 'CustomField',
          apiName: 'TestOnly__c',
          parentId: CONTACT_OBJ,
        }),
        // Production Apex writer — a live automation writer.
        makeNode({
          id: PROD_WRITER,
          type: 'ApexClass',
          apiName: 'ContactMergeHandler',
          properties: { isTest: false },
        }),
        // Test Apex writer — writes the field only while a test runs; NOT a live
        // production writer, so runnable must be false (status 'test-only').
        makeNode({
          id: TEST_WRITER,
          type: 'ApexClass',
          apiName: 'ContactMergeHandlerTest',
          properties: { isTest: true },
        }),
      ],
      edges: [
        makeEdge({ fromId: CONTACT_OBJ, toId: EMAIL_FIELD, edgeType: 'parentOf' }),
        makeEdge({ fromId: CONTACT_OBJ, toId: TESTONLY_FIELD, edgeType: 'parentOf' }),
        makeEdge({
          fromId: PROD_WRITER,
          toId: EMAIL_FIELD,
          edgeType: 'writesTo',
          source: 'apex-scanner',
          confidence: 'heuristic',
        }),
        makeEdge({
          fromId: TEST_WRITER,
          toId: EMAIL_FIELD,
          edgeType: 'writesTo',
          source: 'apex-scanner',
          confidence: 'heuristic',
        }),
        makeEdge({
          fromId: TEST_WRITER,
          toId: TESTONLY_FIELD,
          edgeType: 'writesTo',
          source: 'apex-scanner',
          confidence: 'heuristic',
        }),
      ],
    };
    const imported = await importExtractionResults(s, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    c = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
  });

  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks a *_Test ApexClass writer runnable:false with status test-only, never the sole live suspect', async () => {
    const result = await whyFieldChangedHandler(c, { fieldId: EMAIL_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.data.writers.map((w) => [w.id, w]));
    const test = byId.get(TEST_WRITER);
    expect(test).toBeDefined();
    expect(test?.runnable).toBe(false);
    expect(test?.status).toBe('test-only');
  });

  it('leaves a production (non-test) ApexClass writer runnable:true — UNCHANGED', async () => {
    const result = await whyFieldChangedHandler(c, { fieldId: EMAIL_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.data.writers.map((w) => [w.id, w]));
    const prod = byId.get(PROD_WRITER);
    expect(prod).toBeDefined();
    expect(prod?.runnable).toBe(true);
    const { summary, note } = result.value.data;
    expect(summary.runnableCount).toBe(1); // only the production writer
    expect(summary.nonRunnableCount).toBe(1); // the test writer, disclosed
    // A live writer exists, so no all-dead note.
    expect(note).toBeUndefined();
  });

  it('discloses a non-runnable note when the field\'s ONLY writer is a test class', async () => {
    const result = await whyFieldChangedHandler(c, { fieldId: TESTONLY_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { writers, summary, note } = result.value.data;
    expect(writers.length).toBe(1);
    expect(writers[0]?.id).toBe(TEST_WRITER);
    expect(writers[0]?.runnable).toBe(false);
    expect(writers[0]?.status).toBe('test-only');
    expect(summary.runnableCount).toBe(0);
    expect(summary.nonRunnableCount).toBe(1);
    expect(note).toBeDefined();
    expect(note).toMatch(/non-runnable|test-only/i);
  });
});

// =============================================================================
// FIX 1 — componentId / object+field scope (WHY-FIELD-CHANGED-REJECTS-COMPONENTID).
// The tool now names its ONE field via `fieldId`, a `CustomField:`/`CustomObject:`
// `componentId`, or `objectApiName` + `fieldApiName`; echoes `appliedScope` when a
// scope alias was passed; and returns a NAMED invalid-query (never an org-wide
// answer) when a componentId can't resolve to a single field. The bare
// `{ fieldId }` call stays byte-identical. Reuses the main `seed` (Account.Industry
// with 4 writers) via the module-level `ctx`.
// =============================================================================

describe('whyFieldChangedHandler — componentId / object+field scope', () => {
  it('accepts a CustomField componentId as a fieldId alias and echoes appliedScope', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      componentId: INDUSTRY_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldId).toBe(INDUSTRY_FIELD);
    expect(result.value.data.appliedScope).toEqual({
      component: INDUSTRY_FIELD,
      mode: 'component',
    });
    // Same 4 writers as the canonical fieldId call — the alias only renamed the arg.
    expect(result.value.data.writers.length).toBe(4);
  });

  it('resolves objectApiName + fieldApiName into the canonical field (object scope applies)', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      objectApiName: 'Account',
      fieldApiName: 'Industry',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldId).toBe(INDUSTRY_FIELD);
    expect(result.value.data.appliedScope).toEqual({
      component: INDUSTRY_FIELD,
      mode: 'component',
    });
    expect(result.value.data.writers.length).toBe(4);
  });

  it('accepts a CustomObject componentId + fieldApiName as the object scope (field-scope applies)', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      componentId: ACCOUNT_OBJ,
      fieldApiName: 'Industry',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldId).toBe(INDUSTRY_FIELD);
    expect(result.value.data.appliedScope).toEqual({
      component: INDUSTRY_FIELD,
      mode: 'component',
    });
  });

  it('returns a NAMED invalid-query for a CustomObject componentId with no field — never org-wide', async () => {
    const result = await whyFieldChangedHandler(ctx, { componentId: ACCOUNT_OBJ });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toMatch(/OBJECT/);
    // The object name is echoed so the host knows the scope was SEEN, not stripped.
    expect(result.error.message).toContain('Account');
  });

  it('rejects a non-CustomField/-CustomObject componentId prefix with invalid-query on that arg', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      componentId: 'Flow:NotAField',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('componentId');
  });

  it('rejects disagreeing fieldId / componentId aliases (never a silent pick)', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      fieldId: INDUSTRY_FIELD,
      componentId: REVENUE_FIELD,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toMatch(/different fields/);
  });

  it('rejects an object scope that disagrees with the field\'s own object', async () => {
    const result = await whyFieldChangedHandler(ctx, {
      objectApiName: 'Contact',
      fieldApiName: INDUSTRY_FIELD, // CustomField:Account.Industry — object mismatch
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toMatch(/disagrees/);
  });

  it('keeps the unscoped { fieldId } call byte-identical (no appliedScope key)', async () => {
    const bare = await whyFieldChangedHandler(ctx, { fieldId: INDUSTRY_FIELD });
    const scoped = await whyFieldChangedHandler(ctx, {
      componentId: INDUSTRY_FIELD,
    });
    expect(bare.ok).toBe(true);
    expect(scoped.ok).toBe(true);
    if (!bare.ok || !scoped.ok) return;
    // Unscoped omits appliedScope entirely.
    expect('appliedScope' in bare.value.data).toBe(false);
    expect(bare.value.data.appliedScope).toBeUndefined();
    // Scoped data === unscoped data once appliedScope is removed (byte-identical).
    const { appliedScope, ...scopedRest } = scoped.value.data;
    expect(appliedScope).toEqual({ component: INDUSTRY_FIELD, mode: 'component' });
    expect(JSON.stringify(scopedRest)).toBe(JSON.stringify(bare.value.data));
  });
});

// =============================================================================
// FIX 2 — active vs inactive WorkflowRule field-update writer partition. The SAME
// active-writer treatment field_360 gives, applied here via the shared
// `isActiveSoeFirer` predicate (soe-active.ts): an ACTIVE WorkflowRule field
// update stays runnable:true; an inactive (active:false) one is runnable:false
// with status 'Inactive' — listed for completeness, never the sole live suspect.
//   Ticket__c.Owner__c : written by an ACTIVE and an INACTIVE WorkflowRule.
// =============================================================================

const TICKET_OBJ = 'CustomObject:Ticket__c';
const OWNER_FIELD = 'CustomField:Ticket__c.Owner__c';
const ACTIVE_WF = 'WorkflowRule:Ticket__c.AssignOwner';
const INACTIVE_WF = 'WorkflowRule:Ticket__c.LegacyAssignOwner';

describe('whyFieldChangedHandler — active vs inactive WorkflowRule writer partition', () => {
  let dir: string;
  let s: GraphStore;
  let c: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-why-fc-wf-'));
    const opened = await openGraph(join(dir, 'why-fc-wf.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    s = opened.value;

    const wfSeed: ExtractionResult = {
      nodes: [
        makeNode({ id: TICKET_OBJ, apiName: 'Ticket__c' }),
        makeNode({
          id: OWNER_FIELD,
          type: 'CustomField',
          apiName: 'Owner__c',
          parentId: TICKET_OBJ,
        }),
        // Active WorkflowRule field update — a live writer.
        makeNode({
          id: ACTIVE_WF,
          type: 'WorkflowRule',
          apiName: 'Ticket__c.AssignOwner',
          parentId: TICKET_OBJ,
          properties: { active: true },
        }),
        // Inactive WorkflowRule field update — configured but dead.
        makeNode({
          id: INACTIVE_WF,
          type: 'WorkflowRule',
          apiName: 'Ticket__c.LegacyAssignOwner',
          parentId: TICKET_OBJ,
          properties: { active: false },
        }),
      ],
      edges: [
        makeEdge({ fromId: TICKET_OBJ, toId: OWNER_FIELD, edgeType: 'parentOf' }),
        makeEdge({
          fromId: ACTIVE_WF,
          toId: OWNER_FIELD,
          edgeType: 'writesTo',
          source: 'workflow-rule-extractor',
        }),
        makeEdge({
          fromId: INACTIVE_WF,
          toId: OWNER_FIELD,
          edgeType: 'writesTo',
          source: 'workflow-rule-extractor',
        }),
      ],
    };
    const imported = await importExtractionResults(s, [wfSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    c = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
  });

  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('partitions an active WorkflowRule field-update writer from an inactive one', async () => {
    const result = await whyFieldChangedHandler(c, { fieldId: OWNER_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.data.writers.map((w) => [w.id, w]));
    const active = byId.get(ACTIVE_WF);
    const inactive = byId.get(INACTIVE_WF);
    expect(active?.runnable).toBe(true);
    expect(active?.status).toBe('Active');
    expect(inactive?.runnable).toBe(false);
    expect(inactive?.status).toBe('Inactive');
    const { summary, note } = result.value.data;
    expect(summary.runnableCount).toBe(1);
    expect(summary.nonRunnableCount).toBe(1);
    // A live writer exists, so no all-dead note.
    expect(note).toBeUndefined();
  });
});
