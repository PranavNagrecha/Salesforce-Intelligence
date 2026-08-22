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


// =============================================================================
// Suite 3 (FIX 5): the VERDICT-CARRIES-INFORMATION fixtures. Four invented
// triggers with deliberately different edge sets AND different runtime states,
// so the verdict distribution can be asserted as a RELATION (more than one
// distinct value) rather than a pinned constant.
//
//   WidgetTrigger   Active,  triggersOn ONLY            → safe (+ notProvenHarmless)
//   LedgerTrigger   Inactive, triggersOn + writesTo     → already-inactive / blocking
//   SprocketTrigger Active,  triggersOn + callsApex     → risky / risky
//   GadgetTrigger   NO status property, + readsFrom     → currentlyRunning null, safe
// =============================================================================

const TRIGGER_ENTRY_ONLY = 'ApexTrigger:WidgetTrigger';
const OBJ_WIDGET = 'CustomObject:Widget__c';
const TRIGGER_INACTIVE = 'ApexTrigger:LedgerTrigger';
const OBJ_LEDGER = 'CustomObject:Ledger__c';
const FIELD_LEDGER_TOTAL = 'CustomField:Ledger__c.Total__c';
const TRIGGER_CALLS = 'ApexTrigger:SprocketTrigger';
const OBJ_SPROCKET = 'CustomObject:Sprocket__c';
const APEX_SPROCKET = 'ApexClass:SprocketService';
const TRIGGER_NO_STATUS = 'ApexTrigger:GadgetTrigger';
const OBJ_GADGET = 'CustomObject:Gadget__c';
const FIELD_GADGET_SERIAL = 'CustomField:Gadget__c.Serial__c';

const verdictSpreadSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TRIGGER_ENTRY_ONLY,
      type: 'ApexTrigger',
      apiName: 'WidgetTrigger',
      properties: { status: 'Active', events: ['before insert'] },
    }),
    makeNode({ id: OBJ_WIDGET, type: 'CustomObject', apiName: 'Widget__c' }),
    makeNode({
      id: TRIGGER_INACTIVE,
      type: 'ApexTrigger',
      apiName: 'LedgerTrigger',
      properties: { status: 'Inactive', events: ['after update'] },
    }),
    makeNode({ id: OBJ_LEDGER, type: 'CustomObject', apiName: 'Ledger__c' }),
    makeNode({
      id: FIELD_LEDGER_TOTAL,
      type: 'CustomField',
      apiName: 'Total__c',
    }),
    makeNode({
      id: TRIGGER_CALLS,
      type: 'ApexTrigger',
      apiName: 'SprocketTrigger',
      properties: { status: 'Active', events: ['before update'] },
    }),
    makeNode({ id: OBJ_SPROCKET, type: 'CustomObject', apiName: 'Sprocket__c' }),
    makeNode({
      id: APEX_SPROCKET,
      type: 'ApexClass',
      apiName: 'SprocketService',
    }),
    makeNode({
      // NO `status` property at all — the vault does not record it.
      id: TRIGGER_NO_STATUS,
      type: 'ApexTrigger',
      apiName: 'GadgetTrigger',
      properties: { events: ['before insert'] },
    }),
    makeNode({ id: OBJ_GADGET, type: 'CustomObject', apiName: 'Gadget__c' }),
    makeNode({
      id: FIELD_GADGET_SERIAL,
      type: 'CustomField',
      apiName: 'Serial__c',
    }),
  ],
  edges: [
    makeEdge({
      fromId: TRIGGER_ENTRY_ONLY,
      toId: OBJ_WIDGET,
      edgeType: 'triggersOn',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: TRIGGER_INACTIVE,
      toId: OBJ_LEDGER,
      edgeType: 'triggersOn',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: TRIGGER_INACTIVE,
      toId: FIELD_LEDGER_TOTAL,
      edgeType: 'writesTo',
    }),
    makeEdge({
      fromId: TRIGGER_CALLS,
      toId: OBJ_SPROCKET,
      edgeType: 'triggersOn',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: TRIGGER_CALLS,
      toId: APEX_SPROCKET,
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: TRIGGER_NO_STATUS,
      toId: OBJ_GADGET,
      edgeType: 'triggersOn',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: TRIGGER_NO_STATUS,
      toId: FIELD_GADGET_SERIAL,
      edgeType: 'readsFrom',
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
  const imported = await importExtractionResults(store, [
    richSeed,
    peSeed,
    verdictSpreadSeed,
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
    // UPDATED (FIX 5a) — INVARIANT: an entry point is not a dependent.
    // `triggersOn` used to be a 5th impact; it is the trigger's own attachment
    // point and is now RECATEGORISED (never dropped) into `entryPoints`.
    // Four impacts remain: callsApex + dispatchesAsync + readsFrom + writesTo.
    expect(data.impacts.length).toBe(4);
    const ids = data.impacts.map((i) => i.componentId).sort();
    expect(ids).toEqual(
      [APEX_HANDLER, APEX_ASYNC, FIELD_INDUSTRY, FIELD_REVENUE].sort(),
    );
    // Nothing was dropped: the parent object is still reported, as an entry point.
    expect(data.entryPoints).toEqual([
      {
        kind: 'triggersOn',
        componentId: ACCOUNT_OBJ,
        note: 'the object this trigger attaches to; disabling removes the handler here',
      },
    ]);
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
    // UPDATED (FIX 5a) — INVARIANT: entry points leave `impacts`; a READ is an
    // INPUT, not a downstream effect.
    // triggersOn → NOT an impact any more (see `entryPoints`)
    expect(byId.has(ACCOUNT_OBJ)).toBe(false);
    // writesTo → metadata-blocker
    expect(byId.get(FIELD_REVENUE)?.category).toBe('metadata-blocker');
    // callsApex → code-needs-update
    expect(byId.get(APEX_HANDLER)?.category).toBe('code-needs-update');
    // dispatchesAsync → code-needs-update
    expect(byId.get(APEX_ASYNC)?.category).toBe('code-needs-update');
    // readsFrom → input-only (was code-needs-update)
    expect(byId.get(FIELD_INDUSTRY)?.category).toBe('input-only');
  });

  it('aggregates verdict to `blocking` when writesTo / triggersOn impacts exist', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_RICH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
  });

  it('recategorises listensTo + triggersOn as ENTRY POINTS for Platform Event subscribers', async () => {
    const result = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_PE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // UPDATED (FIX 5a) — INVARIANT: a Platform Event SUBSCRIPTION is where the
    // runtime enters this trigger, not something downstream of it. Both edges
    // used to be `metadata-blocker` impacts, which is what made every trigger
    // read `blocking`. They move to `entryPoints`; nothing is dropped.
    expect(data.impacts.length).toBe(0);
    expect(data.entryPoints.map((e) => e.kind).sort()).toEqual([
      'listensTo',
      'triggersOn',
    ]);
    for (const entry of data.entryPoints) {
      expect(entry.componentId).toBe(PE_OBJ);
      expect(entry.note.length).toBeGreaterThan(0);
    }
    expect(data.parentObject).toBe(PE_OBJ);
    // With no verdict-bearing impact the structural answer is `safe` — and it
    // ships the "not proven harmless" sentence, because `safe` alone
    // over-claims.
    expect(data.structuralVerdict).toBe('safe');
    expect(data.verdict).toBe('safe');
    expect(data.notProvenHarmless).toContain('not a proof that disabling is harmless');
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


// =============================================================================
// FIX 5 — the verdict must carry information.
//
// Two independent causes, both asserted here:
//   (a) de-tautologise — `triggersOn` / `listensTo` are the trigger's own
//       ENTRY POINT and must not pin the verdict; `readsFrom` is an INPUT.
//   (b) runtime state is its own axis — a trigger that is already off must not
//       be told that disabling it breaks things.
// =============================================================================

describe('whatIfDisableTriggerHandler — FIX 5 verdict information content', () => {
  it('a trigger whose ONLY edge is its entry point is `safe`, with the not-proven sentence', async () => {
    // FAIL-BEFORE: `triggersOn` was an unconditional metadata-blocker, so this
    // returned `blocking` — the tautology that made 22/22 triggers `blocking`.
    const r = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_ENTRY_ONLY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect(data.impacts).toEqual([]);
    expect(data.structuralVerdict).toBe('safe');
    expect(data.verdict).toBe('safe');
    // `safe` alone over-claims; the boundary sentence ships with it verbatim.
    expect(data.notProvenHarmless).toBe(
      'No downstream effect is visible in this vault. That is a statement about the edge types walked (writesTo, callsApex, dispatchesAsync, sendsEmail, subflow references), not a proof that disabling is harmless — dynamic dispatch, managed-package callers, and framework wiring are invisible here.',
    );
    // The entry point is reported, not dropped.
    expect(data.entryPoints).toEqual([
      {
        kind: 'triggersOn',
        componentId: OBJ_WIDGET,
        note: 'the object this trigger attaches to; disabling removes the handler here',
      },
    ]);
  });

  it('an INACTIVE trigger with a real dependent reads `already-inactive`, not `blocking`', async () => {
    // FAIL-BEFORE: the status was resolved and emitted but never consulted, so
    // this returned `blocking` about a handler that does not run today.
    const r = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_INACTIVE,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect(data.verdict).toBe('already-inactive');
    // The structural answer is NOT lost — the write is still blocking.
    expect(data.structuralVerdict).toBe('blocking');
    expect(data.runtimeState.status).toBe('Inactive');
    expect(data.runtimeState.currentlyRunning).toBe(false);
    expect(data.runtimeState.note).toBe(
      'This ApexTrigger is Inactive — it does not run in the org today, so disabling it changes no runtime behaviour. structuralVerdict below describes what WOULD stop if it were Active. That is NOT a claim that nothing depends on it: 1 dependent(s) are listed in impacts, and they will be affected if it is ever reactivated.',
    );
    // The dependent is still listed.
    expect(data.impacts.map((i) => i.componentId)).toEqual([
      FIELD_LEDGER_TOTAL,
    ]);
  });

  it('an ACTIVE trigger reports both axes and they agree', async () => {
    const r = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_CALLS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect(data.runtimeState.currentlyRunning).toBe(true);
    expect(data.verdict).toBe('risky');
    expect(data.structuralVerdict).toBe('risky');
    expect(data.verdict).toBe(data.structuralVerdict);
  });

  it('an ABSENT status is `currentlyRunning: null` — never a fabricated false', async () => {
    const r = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_NO_STATUS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect(data.runtimeState.currentlyRunning).toBeNull();
    expect(data.runtimeState.currentlyRunning).not.toBe(false);
    expect(data.runtimeState.status).toBeNull();
    expect(data.runtimeState.note).toBe(
      "This component's activation status is not recorded in this vault, so whether it runs today is UNKNOWN — not assumed active and not assumed inactive. Treat the verdict as the structural answer only, and confirm the status in the org.",
    );
    // Unknown status must NOT be read as "off": the headline is the structural
    // answer, not `already-inactive`.
    expect(data.verdict).not.toBe('already-inactive');
    expect(data.verdict).toBe(data.structuralVerdict);
  });

  it('a readsFrom impact is `input-only` and its explanation drops "stops this action"', async () => {
    // FAIL-BEFORE: category was `code-needs-update` and the sentence claimed
    // the read was an action with downstream consequences.
    const r = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_NO_STATUS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const read = r.value.data.impacts.find(
      (i) => i.componentId === FIELD_GADGET_SERIAL,
    );
    expect(read?.category).toBe('input-only');
    expect(read?.explanation).toBe(
      "ApexTrigger 'GadgetTrigger' reads CustomField 'Serial__c'. Disabling the trigger removes that read; 'Serial__c' itself is unchanged and nothing downstream of it is affected. Listed because it is a dependency of this trigger, not a dependent on it.",
    );
    expect(read?.explanation).not.toContain('stops this action');
    // …and it contributes NOTHING to the verdict: a read-only trigger is safe.
    expect(r.value.data.structuralVerdict).toBe('safe');
  });

  it('VERDICT-DISTRIBUTION INVARIANT: different edge sets produce different verdicts', async () => {
    // The regression this catches is the one the fix exists for: a verdict that
    // is the same word for every input carries no information. Assert the
    // RELATION (more than one distinct verdict), never an org-wide constant.
    const ids = [
      TRIGGER_ENTRY_ONLY,
      TRIGGER_INACTIVE,
      TRIGGER_CALLS,
      TRIGGER_RICH,
    ];
    const verdicts: string[] = [];
    for (const id of ids) {
      const r = await whatIfDisableTriggerHandler(ctx, { triggerId: id });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      verdicts.push(r.value.data.verdict);
    }
    expect(verdicts).toHaveLength(4);
    expect(new Set(verdicts).size).toBeGreaterThan(1);
  });

  it('every entryPoints row names a node that exists in the graph', async () => {
    // "Never emit a canonical component id that names no node."
    const r = await whatIfDisableTriggerHandler(ctx, {
      triggerId: TRIGGER_RICH,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const entry of r.value.data.entryPoints) {
      expect(entry.componentId).toBe(ACCOUNT_OBJ);
      expect(entry.note.length).toBeGreaterThan(0);
    }
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
