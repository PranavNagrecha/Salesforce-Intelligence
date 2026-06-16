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
      "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.",
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
