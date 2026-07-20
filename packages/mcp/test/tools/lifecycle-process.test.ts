/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  classifyRecordTypeScope,
  lifecycleProcessHandler,
} from '../../src/tools/lifecycle-process.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

const OPP = 'CustomObject:Opportunity';
const WON_WF = 'WorkflowRule:Opportunity.OnClosedWon';
const WON_COND = 'ConditionalContext:WorkflowRule:Opportunity.OnClosedWon.condition-0';
const OTHER_WF = 'WorkflowRule:Opportunity.OnAmount';
const OTHER_COND = 'ConditionalContext:WorkflowRule:Opportunity.OnAmount.condition-0';

// Opportunity with two update workflows: one gated on StageName = Closed Won,
// one gated on Amount — to prove the lifecycle coupling filter.
const seed: ExtractionResult = {
  nodes: [
    node({ id: OPP, type: 'CustomObject', apiName: 'Opportunity', properties: { sharingModel: 'Private' } }),
    node({ id: WON_WF, type: 'WorkflowRule', apiName: 'Opportunity.OnClosedWon', parentId: OPP, properties: { triggerType: 'onAllChanges', active: true } }),
    node({
      id: WON_COND,
      type: 'ConditionalContext',
      apiName: 'WorkflowRule:Opportunity.OnClosedWon.condition-0',
      parentId: WON_WF,
      properties: {
        kind: 'criteria',
        expression: 'Opportunity.StageName equals Closed Won',
        fieldRefs: ['CustomField:Opportunity.StageName'],
        synthesized: false,
      },
    }),
    node({ id: OTHER_WF, type: 'WorkflowRule', apiName: 'Opportunity.OnAmount', parentId: OPP, properties: { triggerType: 'onAllChanges', active: true } }),
    node({
      id: OTHER_COND,
      type: 'ConditionalContext',
      apiName: 'WorkflowRule:Opportunity.OnAmount.condition-0',
      parentId: OTHER_WF,
      properties: {
        kind: 'criteria',
        expression: 'Opportunity.Amount greater than 1000',
        fieldRefs: ['CustomField:Opportunity.Amount'],
        synthesized: false,
      },
    }),
  ],
  edges: [
    edge({ fromId: OPP, toId: WON_WF, edgeType: 'parentOf' }),
    edge({ fromId: WON_WF, toId: OPP, edgeType: 'triggersOn', properties: { triggerType: 'onAllChanges' } }),
    edge({ fromId: WON_WF, toId: WON_COND, edgeType: 'firesWhen', confidence: 'parsed' }),
    edge({ fromId: OPP, toId: OTHER_WF, edgeType: 'parentOf' }),
    edge({ fromId: OTHER_WF, toId: OPP, edgeType: 'triggersOn', properties: { triggerType: 'onAllChanges' } }),
    edge({ fromId: OTHER_WF, toId: OTHER_COND, edgeType: 'firesWhen', confidence: 'parsed' }),
  ],
};

// Ticket__c: record types + update validation rules gated by
// RecordType.DeveloperName, to exercise the RecordType/BusinessProcess scope
// (LIFECYCLE-PROCESS-SILENTLY-IGNORES-RECORDTYPE-SCOPE). Two record types share
// a business process so the BP scope resolves to a SET.
const TICKET = 'CustomObject:Ticket__c';
const TICKET_RT_STD = 'RecordType:Ticket__c.Standard_Ticket';
const TICKET_RT_VIP = 'RecordType:Ticket__c.Vip_Ticket';
const TICKET_RT_LEGACY = 'RecordType:Ticket__c.Legacy_Ticket';
const VR_STD_ONLY = 'ValidationRule:Ticket__c.Standard_Only';
const VR_VIP_ONLY = 'ValidationRule:Ticket__c.Vip_Only';
const VR_ALWAYS = 'ValidationRule:Ticket__c.Always';
const VR_NOT_VIP = 'ValidationRule:Ticket__c.Not_Vip';

const vrWithCondition = (
  vrId: string,
  apiName: string,
  expression: string,
): { nodes: Node[]; edges: Edge[] } => {
  const condId = `ConditionalContext:${vrId}.condition-0`;
  return {
    nodes: [
      node({ id: vrId, type: 'ValidationRule', apiName, parentId: TICKET, properties: { active: true, errorMessage: `${apiName} failed`, errorDisplayField: null } }),
      node({
        id: condId,
        type: 'ConditionalContext',
        apiName: `${vrId}.condition-0`,
        parentId: vrId,
        properties: { kind: 'formula', expression, fieldRefs: ['CustomField:RecordType.DeveloperName'], synthesized: false },
      }),
    ],
    edges: [
      edge({ fromId: TICKET, toId: vrId, edgeType: 'parentOf' }),
      edge({ fromId: vrId, toId: condId, edgeType: 'firesWhen', confidence: 'parsed' }),
    ],
  };
};

const ticketVrs = [
  vrWithCondition(VR_STD_ONLY, 'Ticket__c.Standard_Only', "RecordType.DeveloperName ='Standard_Ticket' && ISBLANK(Subject)"),
  vrWithCondition(VR_VIP_ONLY, 'Ticket__c.Vip_Only', "RecordType.DeveloperName ='Vip_Ticket' && ISBLANK(Owner)"),
  vrWithCondition(VR_NOT_VIP, 'Ticket__c.Not_Vip', "RecordType.DeveloperName <>'Vip_Ticket' && ISBLANK(Notes__c)"),
];

const ticketSeed: ExtractionResult = {
  nodes: [
    node({ id: TICKET, type: 'CustomObject', apiName: 'Ticket__c', properties: { sharingModel: 'Private' } }),
    node({ id: TICKET_RT_STD, type: 'RecordType', apiName: 'Ticket__c.Standard_Ticket', parentId: TICKET, properties: { developerName: 'Standard_Ticket', businessProcess: 'Standard Process' } }),
    node({ id: TICKET_RT_VIP, type: 'RecordType', apiName: 'Ticket__c.Vip_Ticket', parentId: TICKET, properties: { developerName: 'Vip_Ticket', businessProcess: 'Vip Process' } }),
    node({ id: TICKET_RT_LEGACY, type: 'RecordType', apiName: 'Ticket__c.Legacy_Ticket', parentId: TICKET, properties: { developerName: 'Legacy_Ticket', businessProcess: 'Standard Process' } }),
    // An unconditional VR (no RecordType gate) — retained under every scope.
    node({ id: VR_ALWAYS, type: 'ValidationRule', apiName: 'Ticket__c.Always', parentId: TICKET, properties: { active: true, errorMessage: 'Always failed', errorDisplayField: null } }),
    ...ticketVrs.flatMap((v) => v.nodes),
  ],
  edges: [
    edge({ fromId: TICKET, toId: TICKET_RT_STD, edgeType: 'parentOf' }),
    edge({ fromId: TICKET, toId: TICKET_RT_VIP, edgeType: 'parentOf' }),
    edge({ fromId: TICKET, toId: TICKET_RT_LEGACY, edgeType: 'parentOf' }),
    edge({ fromId: TICKET, toId: VR_ALWAYS, edgeType: 'parentOf' }),
    ...ticketVrs.flatMap((v) => v.edges),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-lifecycle-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed, ticketSeed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('lifecycleProcessHandler', () => {
  it('couples automation to the field/value transition', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      field: 'StageName',
      value: 'Closed Won',
      event: 'update',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.transition.field).toBe('StageName');
    expect(d.transition.value).toBe('Closed Won');
    // The Closed-Won workflow is coupled to BOTH the field and the value.
    const won = d.coupledAutomation.find((s) => s.componentId === WON_WF);
    expect(won?.coupledToField).toBe(true);
    expect(won?.coupledToValue).toBe(true);
    // The Amount workflow is NOT coupled to this transition.
    expect(d.coupledAutomation.some((s) => s.componentId === OTHER_WF)).toBe(false);
    expect(d.summary.fieldCoupledSteps).toBe(1);
    expect(d.summary.valueCoupledSteps).toBe(1);
  });

  it('still lists the full chain (both workflows appear in process)', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      field: 'StageName',
      value: 'Closed Won',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.process.map((s) => s.componentId);
    expect(ids).toContain(WON_WF);
    expect(ids).toContain(OTHER_WF);
    expect(r.value.data.confidence).toBe('parsed');
  });

  it('hints to pass a transition when field/value are omitted', async () => {
    const r = await lifecycleProcessHandler(ctx, { objectApiName: 'Opportunity' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.transition.field).toBe(null);
    expect(r.value.data.coupledAutomation.length).toBe(0);
    expect(r.value.data.disclosures.some((s) => s.includes('Pass `field`'))).toBe(true);
  });

  it('always discloses the conditions-not-evaluated boundary', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      field: 'StageName',
      value: 'Closed Won',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosures.some((s) => s.includes('NOT EVALUATED'))).toBe(true);
  });

  it('discloses that Lead Convert / approval / activation are distinct actions outside the insert/update view', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      field: 'StageName',
      value: 'Closed Won',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.disclosures.some((s) => s.includes('Lead Convert')),
    ).toBe(true);
  });

  it('propagates the underlying not-found error for an unknown object', async () => {
    const r = await lifecycleProcessHandler(ctx, { objectApiName: 'NoSuchObj__c' });
    // order_of_execution surfaces component-not-found for an unknown object.
    expect(r.ok).toBe(false);
  });
});

describe('classifyRecordTypeScope (LIFECYCLE-PROCESS-SILENTLY-IGNORES-RECORDTYPE-SCOPE)', () => {
  const std = new Set(['Standard_Ticket']);
  const vip = new Set(['Vip_Ticket']);
  it('positive gate to an in-scope record type → in-scope', () => {
    expect(classifyRecordTypeScope("RecordType.DeveloperName ='Standard_Ticket'", std)).toBe('in-scope');
  });
  it('positive gate to an out-of-scope record type → out-of-scope', () => {
    expect(classifyRecordTypeScope("RecordType.DeveloperName ='Standard_Ticket'", vip)).toBe('out-of-scope');
  });
  it('a negated gate is conservatively retained (unconditional), never dropped', () => {
    // `<> 'Vip_Ticket'` fires for everything except Vip — retained even under Vip scope.
    expect(classifyRecordTypeScope("RecordType.DeveloperName <>'Vip_Ticket'", vip)).toBe('unconditional');
  });
  it('no record-type gate / absent expression → unconditional', () => {
    expect(classifyRecordTypeScope('ISBLANK(Subject)', std)).toBe('unconditional');
    expect(classifyRecordTypeScope(undefined, std)).toBe('unconditional');
  });
  it('$RecordType.DeveloperName and == are recognized; hard-coded RecordTypeId is NOT filtered', () => {
    expect(classifyRecordTypeScope("$RecordType.DeveloperName == 'Standard_Ticket'", std)).toBe('in-scope');
    // A raw RecordTypeId literal is not resolvable offline → treated as unconditional (retained).
    expect(classifyRecordTypeScope("RecordTypeId = '0121234567890ABC'", vip)).toBe('unconditional');
  });
});

describe('lifecycleProcessHandler — RecordType/BusinessProcess scope', () => {
  it('FAIL-BEFORE/PASS-AFTER: an unscoped call lists every VR; recordType scope drops out-of-scope-gated VRs', async () => {
    const bare = await lifecycleProcessHandler(ctx, { objectApiName: 'Ticket__c', event: 'update' });
    const scoped = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Ticket__c',
      event: 'update',
      recordType: 'Standard_Ticket',
    });
    expect(bare.ok && scoped.ok).toBe(true);
    if (!bare.ok || !scoped.ok) return;

    const bareIds = bare.value.data.process.map((s) => s.componentId);
    // Unscoped: no appliedScope, and every VR (incl. the Vip-only one) is present.
    expect(bare.value.data.appliedScope).toBeUndefined();
    expect(bareIds).toContain(VR_VIP_ONLY);
    expect(bareIds).toContain(VR_STD_ONLY);

    const scopedIds = scoped.value.data.process.map((s) => s.componentId);
    // FAIL-BEFORE: scope was Zod-stripped so scoped === bare. Now:
    // - Vip_Only positively gates a DIFFERENT record type → excluded.
    expect(scopedIds).not.toContain(VR_VIP_ONLY);
    // - Standard_Only positively gates the requested RT → retained, in-scope.
    expect(scopedIds).toContain(VR_STD_ONLY);
    // - Always (unconditional) and Not_Vip (negation) → retained.
    expect(scopedIds).toContain(VR_ALWAYS);
    expect(scopedIds).toContain(VR_NOT_VIP);
    // The proof the scope did something: fewer steps than the unscoped call.
    expect(scopedIds.length).toBeLessThan(bareIds.length);

    // appliedScope echoes the resolution + exclusion (never silently identical).
    const s = scoped.value.data.appliedScope;
    expect(s?.kind).toBe('recordType');
    expect(s?.requested).toBe('Standard_Ticket');
    expect(s?.resolvedRecordTypes).toEqual(['Standard_Ticket']);
    expect(s?.excludedComponentIds).toContain(VR_VIP_ONLY);
    expect(s?.excludedStepCount).toBeGreaterThanOrEqual(1);

    // Per-step scope tags are surfaced on retained steps.
    const stdStep = scoped.value.data.process.find((p) => p.componentId === VR_STD_ONLY);
    expect(stdStep?.recordTypeScope).toBe('in-scope');
    const alwaysStep = scoped.value.data.process.find((p) => p.componentId === VR_ALWAYS);
    expect(alwaysStep?.recordTypeScope).toBe('unconditional');
  });

  it('recordTypeId (canonical id) resolves to the same scope as recordType', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Ticket__c',
      event: 'update',
      recordTypeId: 'RecordType:Ticket__c.Standard_Ticket',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope?.resolvedRecordTypes).toEqual(['Standard_Ticket']);
    expect(r.value.data.process.map((s) => s.componentId)).not.toContain(VR_VIP_ONLY);
  });

  it('businessProcess scope resolves to the SET of record types that use it', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Ticket__c',
      event: 'update',
      businessProcess: 'Standard Process',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.data.appliedScope;
    expect(s?.kind).toBe('businessProcess');
    // Two record types share "Standard Process".
    expect([...(s?.resolvedRecordTypes ?? [])].sort()).toEqual(['Legacy_Ticket', 'Standard_Ticket']);
    // The Vip-only VR is still out of scope.
    expect(r.value.data.process.map((x) => x.componentId)).not.toContain(VR_VIP_ONLY);
  });

  it('an unknown record type is rejected with invalid-query (never silently ignored)', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Ticket__c',
      recordType: 'Nope_Ticket',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/Standard_Ticket/);
  });

  it('an unknown business process is rejected with invalid-query', async () => {
    const r = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Ticket__c',
      businessProcess: 'No Such Process',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

describe('lifecycleProcessHandler — CR-22 continuation cursor', () => {
  it('in-budget whole-fits call emits NO cursor/pageInfo and no stepIndex on rows', async () => {
    const r = await lifecycleProcessHandler(ctx, { objectApiName: 'Opportunity', event: 'update' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.hasMore).toBe(false);
    // The internal stepIndex tiebreak must never leak onto a process row.
    for (const s of d.process) {
      expect('stepIndex' in s).toBe(false);
    }
  });

  it('a truncated (limit 1) page emits a nextCursor that resumes with no gaps/dupes', async () => {
    const full = await lifecycleProcessHandler(ctx, { objectApiName: 'Opportunity', event: 'update' });
    expect(full.ok).toBe(true); if (!full.ok) return;
    const totalSteps = full.value.data.summary.totalSteps;
    expect(totalSteps).toBeGreaterThanOrEqual(2);

    const collected: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const r = await lifecycleProcessHandler(ctx, {
        objectApiName: 'Opportunity',
        event: 'update',
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(r.ok).toBe(true); if (!r.ok) return;
      const d = r.value.data;
      for (const s of d.process) collected.push(`${s.phase}|${s.componentId}`);
      if (d.hasMore) {
        expect(typeof d.nextCursor).toBe('string');
        expect(d.pageInfo?.nextCursor).toBe(d.nextCursor);
        cursor = d.nextCursor as string;
      } else {
        expect('nextCursor' in d).toBe(false);
        break;
      }
      if (++guard > 50) throw new Error('cursor loop did not terminate');
    }
    expect(collected.length).toBe(totalSteps); // every step walked, no gaps
    expect(new Set(collected).size).toBe(totalSteps); // no dupes

    const fullIds = full.value.data.process.map((s) => `${s.phase}|${s.componentId}`);
    expect(collected).toEqual(fullIds); // identical order to the whole-list walk
  });

  it('rejects a cursor minted for a DIFFERENT transition (changed field/value)', async () => {
    const first = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      event: 'update',
      limit: 1,
    });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    const replay = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      event: 'update',
      field: 'StageName',
      value: 'Closed Won',
      limit: 1,
      cursor,
    });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed / forged cursor string', async () => {
    const replay = await lifecycleProcessHandler(ctx, {
      objectApiName: 'Opportunity',
      cursor: 'not-a-real-cursor',
    });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});
