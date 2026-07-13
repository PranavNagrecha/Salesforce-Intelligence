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
  downstreamEffectsHandler,
  downstreamEffectsInputSchema,
} from '../../src/tools/downstream-effects.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-de',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
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

// Root → A → B (call chain).
// Root writes Field1. A dispatches AsyncJob. B sends EmailTemplate.
// Root also calls C (downstream sibling), C has NO side effects.
const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'ApexClass:Root', apiName: 'Root' }),
    makeNode({ id: 'ApexClass:A', apiName: 'A' }),
    makeNode({ id: 'ApexClass:B', apiName: 'B' }),
    makeNode({ id: 'ApexClass:C', apiName: 'C' }),
    makeNode({ id: 'ApexClass:AsyncJob', apiName: 'AsyncJob' }),
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
    }),
    makeNode({
      id: 'EmailTemplate:WelcomeEmail',
      type: 'EmailTemplate',
      apiName: 'WelcomeEmail',
    }),
  ],
  edges: [
    // Call chain
    makeEdge({
      fromId: 'ApexClass:Root',
      toId: 'ApexClass:A',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:A',
      toId: 'ApexClass:B',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:Root',
      toId: 'ApexClass:C',
      edgeType: 'callsApex',
    }),
    // Effects
    makeEdge({
      fromId: 'ApexClass:Root',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'writesTo',
    }),
    makeEdge({
      fromId: 'ApexClass:A',
      toId: 'ApexClass:AsyncJob',
      edgeType: 'dispatchesAsync',
    }),
    makeEdge({
      fromId: 'ApexClass:B',
      toId: 'EmailTemplate:WelcomeEmail',
      edgeType: 'sendsEmail',
    }),
    // Phantom apex-scanner field-write: the receiver's object could not be
    // resolved, so the target id `CustomField:localVar.Ghost__c` has NO
    // corresponding node and the edge is flagged `targetMissing: true`
    // (exactly the real shape — every acme apex writesTo→CustomField
    // edge is such a phantom). C is reachable (Root → C) so its out-edges
    // are scanned; downstream_effects must NOT surface this as an effect.
    makeEdge({
      fromId: 'ApexClass:C',
      toId: 'CustomField:localVar.Ghost__c',
      edgeType: 'writesTo',
      properties: { targetMissing: true },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-de-'));
  const opened = await openGraph(join(tempDir, 'de.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('downstreamEffectsHandler', () => {
  it('surfaces every category of side effect across the reachable class set', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const categories = r.value.data.effects.map((e) => e.category);
    expect(categories).toContain('field-write');
    expect(categories).toContain('async-dispatch');
    expect(categories).toContain('email');
  });

  it('categorises writesTo as field-write with the field target metadata', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fieldWrite = r.value.data.effects.find(
      (e) => e.category === 'field-write',
    );
    expect(fieldWrite).toBeDefined();
    expect(fieldWrite?.targetId).toBe('CustomField:Account.Industry__c');
    expect(fieldWrite?.targetType).toBe('CustomField');
    expect(fieldWrite?.targetApiName).toBe('Industry__c');
    expect(fieldWrite?.sourceClassId).toBe('ApexClass:Root');
  });

  it('drops unresolved/phantom writesTo targets (apex-scanner targetMissing) instead of surfacing a null-named field-write', async () => {
    // ApexClass:C carries a writesTo edge to CustomField:localVar.Ghost__c,
    // a target with no node in the graph (the apex scanner could not
    // resolve the receiver object; the edge is flagged targetMissing:true).
    // It must NOT appear as a downstream effect — surfacing it over-reports
    // a field-write to a field that isn't in the graph, with a null
    // targetType/targetApiName. Mirrors what_if_disable_trigger, which
    // already drops null-target out-edges.
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const effects = r.value.data.effects;
    // The phantom target is excluded entirely.
    expect(
      effects.some((e) => e.targetId === 'CustomField:localVar.Ghost__c'),
    ).toBe(false);
    // No surfaced effect carries an unresolved (null) target.
    expect(
      effects.every((e) => e.targetType !== null && e.targetApiName !== null),
    ).toBe(true);
    // C's only out-edge was the phantom write, so it contributes nothing.
    expect(effects.some((e) => e.sourceClassId === 'ApexClass:C')).toBe(false);
  });

  it('reports a non-empty summary with per-category counts', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.fieldWrite).toBeGreaterThanOrEqual(1);
    expect(r.value.data.summary.asyncDispatch).toBeGreaterThanOrEqual(1);
    expect(r.value.data.summary.email).toBeGreaterThanOrEqual(1);
  });

  it('reports the reachable class count (root + downstream chain)', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Root + A + B + C.
    expect(r.value.data.reachableClassCount).toBe(4);
  });

  it('respects maxDepth: 1 (no second-hop effects)', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
      maxDepth: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // At depth 1 we reach Root + A + C. B (depth 2) and its email
    // are excluded.
    const emails = r.value.data.effects.filter((e) => e.category === 'email');
    expect(emails.length).toBe(0);
    // Root's writesTo and A's dispatchesAsync remain.
    const writes = r.value.data.effects.filter(
      (e) => e.category === 'field-write',
    );
    expect(writes.length).toBe(1);
  });

  it('returns component-not-found for CustomObject root when object is absent (RTG-04)', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'CustomObject:Account',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('returns component-not-found for an unknown class', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Nonexistent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('surfaces the verbatim disclosure', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/Optional `method`/);
    expect(r.value.data.disclosure).toMatch(/callouts/i);
  });

  it('discloses that Apex-originated email (Messaging.sendEmail) is NOT modeled', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/Messaging\.sendEmail/);
    expect(r.value.data.disclosure).toMatch(/declarative-only/i);
  });

  it('frames an EMPTY effects list as "no MODELED effects", never side-effect-free (P14-USAGE-downstream-effects-honesty)', async () => {
    const r = await downstreamEffectsHandler(ctx, { classApiName: 'ApexClass:C' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.effects).toEqual([]);
    expect(r.value.data.disclosure).toMatch(/no MODELED effects/);
    expect(r.value.data.disclosure).toMatch(/side-effect-free/);
  });

  it('does NOT append the empty framing when effects exist', async () => {
    const r = await downstreamEffectsHandler(ctx, { classApiName: 'ApexClass:Root' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.effects.length).toBeGreaterThan(0);
    expect(r.value.data.disclosure).not.toMatch(/no MODELED effects/);
  });

  it('returns deterministic sort order (source, category, target)', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const effects = r.value.data.effects;
    for (let i = 1; i < effects.length; i += 1) {
      const prev = effects[i - 1];
      const curr = effects[i];
      if (prev === undefined || curr === undefined) continue;
      if (prev.sourceClassId !== curr.sourceClassId) {
        expect(prev.sourceClassId < curr.sourceClassId).toBe(true);
      } else if (prev.category !== curr.category) {
        expect(prev.category < curr.category).toBe(true);
      } else {
        expect(prev.targetId <= curr.targetId).toBe(true);
      }
    }
  });

  it('uses default maxDepth=3 when omitted', async () => {
    const r = await downstreamEffectsHandler(ctx, {
      classApiName: 'ApexClass:Root',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const emails = r.value.data.effects.filter((e) => e.category === 'email');
    expect(emails.length).toBe(1);
  });
});

// RTG-04: object-root discovery uses triggersOn + parentOf; declarative
// firers contribute direct effects and callsApex walks.
const objectAutomationSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
    }),
    makeNode({
      id: 'Flow:Account_After',
      type: 'Flow',
      apiName: 'Account_After',
    }),
    makeNode({
      id: 'WorkflowRule:Account.WF_Rule',
      type: 'WorkflowRule',
      apiName: 'Account.WF_Rule',
    }),
    makeNode({
      id: 'ApprovalProcess:Account.Discount_Approval',
      type: 'ApprovalProcess',
      apiName: 'Account.Discount_Approval',
    }),
    makeNode({
      id: 'ApexTrigger:AccountTrigger',
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
    }),
    makeNode({ id: 'ApexClass:WfHelper', apiName: 'WfHelper' }),
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
    }),
    makeNode({
      id: 'EmailTemplate:Alert',
      type: 'EmailTemplate',
      apiName: 'Alert',
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'Flow:Account_After',
      toId: 'CustomObject:Account',
      edgeType: 'triggersOn',
    }),
    makeEdge({
      fromId: 'WorkflowRule:Account.WF_Rule',
      toId: 'CustomObject:Account',
      edgeType: 'triggersOn',
    }),
    makeEdge({
      fromId: 'ApexTrigger:AccountTrigger',
      toId: 'CustomObject:Account',
      edgeType: 'triggersOn',
    }),
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'ApprovalProcess:Account.Discount_Approval',
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: 'Flow:Account_After',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'writesTo',
      source: 'flow-extractor',
    }),
    makeEdge({
      fromId: 'WorkflowRule:Account.WF_Rule',
      toId: 'EmailTemplate:Alert',
      edgeType: 'sendsEmail',
      source: 'workflow-rule-extractor',
    }),
    makeEdge({
      fromId: 'ApprovalProcess:Account.Discount_Approval',
      toId: 'EmailTemplate:Alert',
      edgeType: 'sendsEmail',
      source: 'approval-process-extractor',
    }),
    makeEdge({
      fromId: 'ApprovalProcess:Account.Discount_Approval',
      toId: 'ApexClass:WfHelper',
      edgeType: 'callsApex',
      source: 'approval-process-extractor',
    }),
    makeEdge({
      fromId: 'ApexTrigger:AccountTrigger',
      toId: 'ApexClass:WfHelper',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexClass:WfHelper',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'writesTo',
    }),
  ],
};

describe('downstreamEffectsHandler — CustomObject root (RTG-04)', () => {
  let objectTempDir: string;
  let objectStore: GraphStore;
  let objectCtx: Context;

  beforeAll(async () => {
    objectTempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-de-obj-'));
    const opened = await openGraph(join(objectTempDir, 'de-obj.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    objectStore = opened.value;
    const imp = await importExtractionResults(objectStore, [objectAutomationSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    objectCtx = {
      vaultRoot: objectTempDir,
      manifest: FIXTURE_MANIFEST,
      graph: objectStore,
    };
  });

  afterAll(async () => {
    await closeGraph(objectStore);
    rmSync(objectTempDir, { recursive: true, force: true });
  });

  it('discovers triggersOn firers and parentOf ApprovalProcess in automationNodes', async () => {
    const r = await downstreamEffectsHandler(objectCtx, {
      classApiName: 'CustomObject:Account',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = (r.value.data.automationNodes ?? []).map((n) => n.id).sort();
    expect(ids).toEqual(
      [
        'ApprovalProcess:Account.Discount_Approval',
        'ApexTrigger:AccountTrigger',
        'Flow:Account_After',
        'WorkflowRule:Account.WF_Rule',
      ].sort(),
    );
  });

  it('surfaces declarative effects and Apex effects reachable via callsApex', async () => {
    const r = await downstreamEffectsHandler(objectCtx, {
      classApiName: 'CustomObject:Account',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const effects = r.value.data.effects;

    const flowWrite = effects.find(
      (e) =>
        e.sourceClassId === 'Flow:Account_After' &&
        e.category === 'field-write',
    );
    expect(flowWrite?.targetId).toBe('CustomField:Account.Industry__c');

    const wfEmail = effects.find(
      (e) =>
        e.sourceClassId === 'WorkflowRule:Account.WF_Rule' &&
        e.category === 'email',
    );
    expect(wfEmail?.targetId).toBe('EmailTemplate:Alert');

    const approvalEmail = effects.find(
      (e) =>
        e.sourceClassId === 'ApprovalProcess:Account.Discount_Approval' &&
        e.category === 'email',
    );
    expect(approvalEmail?.targetId).toBe('EmailTemplate:Alert');

    const apexWrite = effects.find(
      (e) =>
        e.sourceClassId === 'ApexClass:WfHelper' &&
        e.category === 'field-write',
    );
    expect(apexWrite?.targetId).toBe('CustomField:Account.Industry__c');

    // WfHelper reached from trigger + approval — one row after dedupe.
    expect(
      effects.filter(
        (e) =>
          e.sourceClassId === 'ApexClass:WfHelper' &&
          e.category === 'field-write',
      ).length,
    ).toBe(1);

    expect(r.value.data.reachableClassCount).toBe(2); // trigger + WfHelper
  });
});

describe('downstreamEffectsInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    expect(
      downstreamEffectsInputSchema.safeParse({
        classApiName: 'ApexClass:X',
      }).success,
    ).toBe(true);
  });

  it('accepts the optional method filter (P15 method-level composites)', () => {
    expect(
      downstreamEffectsInputSchema.safeParse({
        classApiName: 'ApexClass:Repo',
        method: 'deleteRecord',
      }).success,
    ).toBe(true);
  });

  it('accepts maxDepth at the upper bound (5)', () => {
    expect(
      downstreamEffectsInputSchema.safeParse({
        classApiName: 'ApexClass:X',
        maxDepth: 5,
      }).success,
    ).toBe(true);
  });

  it('rejects maxDepth > 5', () => {
    expect(
      downstreamEffectsInputSchema.safeParse({
        classApiName: 'ApexClass:X',
        maxDepth: 10,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty classApiName', () => {
    expect(
      downstreamEffectsInputSchema.safeParse({ classApiName: '' }).success,
    ).toBe(false);
  });
});

// =============================================================================
// P15-GRAPH-method-level-composites: optional `method` narrows the root's
// direct callsApex edges — save vs deleteRecord paths surface different writes.
// =============================================================================

describe('downstreamEffectsHandler: method filter (P15)', () => {
  let dir2: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-de-methods-'));
    const opened = await openGraph(join(dir2, 'de-methods.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    const seed2: ExtractionResult = {
      nodes: [
        makeNode({ id: 'ApexClass:Repo', apiName: 'Repo' }),
        makeNode({ id: 'ApexClass:SaveHelper', apiName: 'SaveHelper' }),
        makeNode({ id: 'ApexClass:Writer', apiName: 'Writer' }),
        makeNode({
          id: 'CustomField:Account.SaveField__c',
          type: 'CustomField',
          apiName: 'SaveField__c',
        }),
        makeNode({
          id: 'CustomField:Account.DeleteField__c',
          type: 'CustomField',
          apiName: 'DeleteField__c',
        }),
      ],
      edges: [
        makeEdge({
          fromId: 'ApexClass:Repo',
          toId: 'ApexClass:SaveHelper',
          edgeType: 'callsApex',
          properties: { methods: ['save'], methodName: 'save' },
        }),
        makeEdge({
          fromId: 'ApexClass:Repo',
          toId: 'ApexClass:Writer',
          edgeType: 'callsApex',
          properties: { methods: ['deleteRecord'], methodName: 'deleteRecord' },
        }),
        makeEdge({
          fromId: 'ApexClass:SaveHelper',
          toId: 'CustomField:Account.SaveField__c',
          edgeType: 'writesTo',
        }),
        makeEdge({
          fromId: 'ApexClass:Writer',
          toId: 'CustomField:Account.DeleteField__c',
          edgeType: 'writesTo',
        }),
      ],
    };
    const imported = await importExtractionResults(store2, [seed2]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx2 = { vaultRoot: dir2, manifest: FIXTURE_MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('unfiltered walk surfaces writes from both save and deleteRecord paths', async () => {
    const r = await downstreamEffectsHandler(ctx2, {
      classApiName: 'ApexClass:Repo',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const targets = r.value.data.effects
      .filter((e) => e.category === 'field-write')
      .map((e) => e.targetId);
    expect(targets).toContain('CustomField:Account.SaveField__c');
    expect(targets).toContain('CustomField:Account.DeleteField__c');
  });

  it('method:deleteRecord surfaces only the deleteRecord path write', async () => {
    const r = await downstreamEffectsHandler(ctx2, {
      classApiName: 'ApexClass:Repo',
      method: 'deleteRecord',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const targets = r.value.data.effects
      .filter((e) => e.category === 'field-write')
      .map((e) => e.targetId);
    expect(targets).toEqual(['CustomField:Account.DeleteField__c']);
  });

  it('method:save surfaces only the save path write', async () => {
    const r = await downstreamEffectsHandler(ctx2, {
      classApiName: 'ApexClass:Repo',
      method: 'save',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const targets = r.value.data.effects
      .filter((e) => e.category === 'field-write')
      .map((e) => e.targetId);
    expect(targets).toEqual(['CustomField:Account.SaveField__c']);
  });
});

// =============================================================================
// N+1 query budget (finding C-1). collectReachableClasses (BFS) is batched one
// listEdgesForNodes per depth level; collectEffectsForClasses batches the whole
// reachable closure's outgoing edges + effect targets into two round-trips;
// resolveApiNames + collectAutomationNodesForObject batch their node fetches.
// The query count must scale with DEPTH, never frontier WIDTH. Plus a golden-
// output assertion over a transitive chain with an effect at every level.
// =============================================================================
describe('downstreamEffectsHandler — bounded graph queries (transitive)', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context, s: GraphStore) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-de-budget-'));
    const opened = await openGraph(join(dir, 'de.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const out = await run(localCtx, s);
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  // Root --callsApex--> Mid --callsApex--> Leaf. Effects at every level:
  //   Root writesTo F1__c, Mid dispatchesAsync Job, Leaf sendsEmail Welcome.
  const goldenSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'ApexClass:Root', apiName: 'Root' }),
      makeNode({ id: 'ApexClass:Mid', apiName: 'Mid' }),
      makeNode({ id: 'ApexClass:Leaf', apiName: 'Leaf' }),
      makeNode({ id: 'ApexClass:Job', apiName: 'Job' }),
      makeNode({ id: 'CustomField:Account.F1__c', type: 'CustomField', apiName: 'F1__c' }),
      makeNode({ id: 'EmailTemplate:Welcome', type: 'EmailTemplate', apiName: 'Welcome' }),
    ],
    edges: [
      makeEdge({ fromId: 'ApexClass:Root', toId: 'ApexClass:Mid', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexClass:Mid', toId: 'ApexClass:Leaf', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexClass:Root', toId: 'CustomField:Account.F1__c', edgeType: 'writesTo' }),
      makeEdge({ fromId: 'ApexClass:Mid', toId: 'ApexClass:Job', edgeType: 'dispatchesAsync' }),
      makeEdge({ fromId: 'ApexClass:Leaf', toId: 'EmailTemplate:Welcome', edgeType: 'sendsEmail' }),
    ],
  };

  it('golden: transitive effects are unchanged by batching', async () => {
    const result = await withStore(goldenSeed, (localCtx) =>
      downstreamEffectsHandler(localCtx, { classApiName: 'ApexClass:Root' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.reachableClassCount).toBe(3); // Root, Mid, Leaf (Job is not callsApex-reachable)
    expect(d.summary).toEqual({ fieldWrite: 1, asyncDispatch: 1, email: 1 });
    expect(
      d.effects.map((e) => ({ sourceClassId: e.sourceClassId, category: e.category, targetId: e.targetId })),
    ).toEqual([
      { sourceClassId: 'ApexClass:Leaf', category: 'email', targetId: 'EmailTemplate:Welcome' },
      { sourceClassId: 'ApexClass:Mid', category: 'async-dispatch', targetId: 'ApexClass:Job' },
      { sourceClassId: 'ApexClass:Root', category: 'field-write', targetId: 'CustomField:Account.F1__c' },
    ]);
  });

  // Root callsApex `width` leaf classes (wide frontier at depth 1); each leaf
  // has no outgoing edges. Depth is fixed; the edge-query count is bounded by
  // depth (one listEdgesForNodes per BFS level + one for the effects closure).
  const seedWideFrontier = (width: number): ExtractionResult => ({
    nodes: [
      makeNode({ id: 'ApexClass:Root', apiName: 'Root' }),
      ...Array.from({ length: width }, (_u, i) =>
        makeNode({ id: `ApexClass:Leaf${i}`, apiName: `Leaf${i}` }),
      ),
    ],
    edges: Array.from({ length: width }, (_u, i) =>
      makeEdge({ fromId: 'ApexClass:Root', toId: `ApexClass:Leaf${i}`, edgeType: 'callsApex' }),
    ),
  });

  it('edge-query count does NOT scale with frontier width', async () => {
    const measure = (width: number) =>
      withStore(seedWideFrontier(width), (localCtx, s) =>
        measureGraphQueries(s, () =>
          downstreamEffectsHandler(localCtx, { classApiName: 'ApexClass:Root' }),
        ),
      );
    const narrow = await measure(60);
    const wide = await measure(200);
    expect(narrow.result.ok).toBe(true);
    expect(wide.result.ok).toBe(true);
    // Flat: one listEdgesForNodes per BFS depth level + one effects-closure
    // batch, NOT one listEdges per reachable class. An N+1 would be ~width.
    expect(wide.edgeQueries).toBe(narrow.edgeQueries);
    expect(wide.edgeQueries).toBeLessThan(15);
  });
});
