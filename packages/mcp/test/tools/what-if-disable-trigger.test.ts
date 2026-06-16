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
  whatIfDisableTriggerHandler,
  whatIfDisableTriggerInputSchema,
} from '../../src/tools/what-if-disable-trigger.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T10:30:00Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    CustomField: 2,
    ApexTrigger: 2,
    ApexClass: 2,
  },
  edges: {
    triggersOn: 2,
    callsApex: 1,
    writesTo: 1,
    readsFrom: 1,
    dispatchesAsync: 1,
    listensTo: 1,
  },
  sourceTreeHash: 'sha256:fixture',
  coverageComputedAt: '2026-05-29T12:00:00.000Z',
  coverage: ['ApexTrigger', 'ApexClass', 'CustomObject', 'PlatformEvent'].map(
    (type) => ({
      type,
      requested: true,
      retrieved: 1,
      errored: false,
      neverModeled: false,
    }),
  ),
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
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

// =============================================================================
// Suite 1: rich-impact trigger on Account with events ['before insert',
// 'after update']. The trigger writes to a field, reads another, calls
// an Apex class, and dispatches an async job.
// =============================================================================

const TRIGGER_RICH = 'ApexTrigger:AccountTrigger';
const ACCOUNT_OBJ = 'CustomObject:Account';
const APEX_HANDLER = 'ApexClass:AccountHandler';
const APEX_ASYNC = 'ApexClass:AccountQueueable';
const FIELD_INDUSTRY = 'CustomField:Account.Industry__c';
const FIELD_REVENUE = 'CustomField:Account.AnnualRevenue';

const richSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TRIGGER_RICH,
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      properties: {
        status: 'Active',
        events: ['before insert', 'after update'],
        triggerObject: 'Account',
      },
    }),
    makeNode({
      id: ACCOUNT_OBJ,
      type: 'CustomObject',
      apiName: 'Account',
    }),
    makeNode({
      id: APEX_HANDLER,
      type: 'ApexClass',
      apiName: 'AccountHandler',
    }),
    makeNode({
      id: APEX_ASYNC,
      type: 'ApexClass',
      apiName: 'AccountQueueable',
    }),
    makeNode({
      id: FIELD_INDUSTRY,
      type: 'CustomField',
      apiName: 'Industry__c',
    }),
    makeNode({
      id: FIELD_REVENUE,
      type: 'CustomField',
      apiName: 'AnnualRevenue',
    }),
  ],
  edges: [
    makeEdge({
      fromId: TRIGGER_RICH,
      toId: ACCOUNT_OBJ,
      edgeType: 'triggersOn',
      confidence: 'declared',
      source: 'apex-trigger-extractor',
      properties: { events: ['before insert', 'after update'] },
    }),
    makeEdge({
      fromId: TRIGGER_RICH,
      toId: APEX_HANDLER,
      edgeType: 'callsApex',
      properties: { methodName: 'handle' },
    }),
    makeEdge({
      fromId: TRIGGER_RICH,
      toId: APEX_ASYNC,
      edgeType: 'dispatchesAsync',
    }),
    makeEdge({
      fromId: TRIGGER_RICH,
      toId: FIELD_INDUSTRY,
      edgeType: 'readsFrom',
    }),
    makeEdge({
      fromId: TRIGGER_RICH,
      toId: FIELD_REVENUE,
      edgeType: 'writesTo',
    }),
  ],
};

// =============================================================================
// Suite 2: Platform Event subscriber trigger. Emits a `listensTo` edge
// to the __e CustomObject; the impact category is metadata-blocker
// (the subscription would silently stop).
// =============================================================================

const TRIGGER_PE = 'ApexTrigger:AccountChangeTrigger';
const PE_OBJ = 'CustomObject:Account_Change__e';

const peSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TRIGGER_PE,
      type: 'ApexTrigger',
      apiName: 'AccountChangeTrigger',
      properties: {
        status: 'Active',
        events: ['after insert'],
        triggerObject: 'Account_Change__e',
        isPlatformEventSubscriber: true,
      },
    }),
    makeNode({
      id: PE_OBJ,
      type: 'CustomObject',
      apiName: 'Account_Change__e',
    }),
  ],
  edges: [
    makeEdge({
      fromId: TRIGGER_PE,
      toId: PE_OBJ,
      edgeType: 'triggersOn',
      confidence: 'declared',
      source: 'apex-trigger-extractor',
    }),
    makeEdge({
      fromId: TRIGGER_PE,
      toId: PE_OBJ,
      edgeType: 'listensTo',
      confidence: 'declared',
      source: 'apex-trigger-extractor',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-what-if-disable-trigger-'));
  const dbPath = join(tempDir, 'widt.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [richSeed, peSeed]);
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

describe('whatIfDisableTriggerHandler', () => {
  it('emits one impact per recognised outgoing edge type for a rich trigger', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_RICH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.triggerId).toBe(TRIGGER_RICH);
    expect(data.apiName).toBe('AccountTrigger');
    expect(data.status).toBe('Active');
    // Five impacts: triggersOn + callsApex + dispatchesAsync + readsFrom + writesTo.
    expect(data.impacts.length).toBe(5);
    const ids = data.impacts.map((i) => i.componentId).sort();
    expect(ids).toEqual(
      [
        ACCOUNT_OBJ,
        APEX_HANDLER,
        APEX_ASYNC,
        FIELD_INDUSTRY,
        FIELD_REVENUE,
      ].sort(),
    );
  });

  it('surfaces the parent object as a scalar field', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_RICH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.parentObject).toBe(ACCOUNT_OBJ);
  });

  it('surfaces the events list from the trigger node properties', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_RICH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.events).toEqual([
      'before insert',
      'after update',
    ]);
  });

  it('classifies impact categories per the rule table', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_RICH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(
      result.value.data.impacts.map((i) => [i.componentId, i]),
    );
    // triggersOn → metadata-blocker
    expect(byId.get(ACCOUNT_OBJ)?.category).toBe('metadata-blocker');
    // writesTo → metadata-blocker
    expect(byId.get(FIELD_REVENUE)?.category).toBe('metadata-blocker');
    // callsApex → code-needs-update
    expect(byId.get(APEX_HANDLER)?.category).toBe('code-needs-update');
    // dispatchesAsync → code-needs-update
    expect(byId.get(APEX_ASYNC)?.category).toBe('code-needs-update');
    // readsFrom → code-needs-update
    expect(byId.get(FIELD_INDUSTRY)?.category).toBe('code-needs-update');
  });

  it('aggregates verdict to `blocking` when writesTo / triggersOn impacts exist', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_RICH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
  });

  it('classifies listensTo as a metadata-blocker for Platform Event subscribers', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_PE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Two impacts: triggersOn + listensTo, both pointing at PE_OBJ.
    expect(data.impacts.length).toBe(2);
    for (const impact of data.impacts) {
      expect(impact.category).toBe('metadata-blocker');
    }
    expect(data.parentObject).toBe(PE_OBJ);
    expect(data.verdict).toBe('blocking');
  });

  it('returns invalid-query for a non-ApexTrigger prefix', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: 'ApexClass:NotATrigger',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown triggerId', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: 'ApexTrigger:NoSuchTrigger',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('emits the verbatim honesty-axis disclosure', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_RICH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('v2.3 what-if analysis');
    expect(result.value.data.disclosure).toContain('TriggerHandler');
    expect(result.value.data.disclosure).toContain('fflib');
  });

  it('echoes the manifest vaultState into the response envelope', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_RICH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-28T10:30:00Z');
  });
});

describe('whatIfDisableTriggerInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = whatIfDisableTriggerInputSchema.safeParse({
      triggerId: TRIGGER_RICH,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty triggerId', () => {
    const parsed = whatIfDisableTriggerInputSchema.safeParse({
      triggerId: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing triggerId', () => {
    const parsed = whatIfDisableTriggerInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});
