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
  classifyFaultSurface,
  flowFaultAuditHandler,
} from '../../src/tools/flow-fault-audit.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-29T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-ffa',
};

const makeFlow = (
  overrides: Partial<Node> & Pick<Node, 'id'>,
): Node => ({
  type: 'Flow',
  apiName: 'AnonFlow',
  label: null,
  parentId: null,
  sourcePath: 'unused.flow-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

// Two flows with unhandled faults: a before-save record-triggered flow (runs
// inside the triggering DML transaction) and a screen flow (user interview).
const seed: ExtractionResult = {
  nodes: [
    makeFlow({
      id: 'Flow:BeforeSaveAutomation',
      apiName: 'BeforeSaveAutomation',
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordBeforeSave',
        recordTriggerType: 'CreateAndUpdate',
        faultableElementCount: 2,
        elementsWithoutFault: 2,
        hasUnhandledFaults: true,
      },
    }),
    makeFlow({
      id: 'Flow:UserScreenFlow',
      apiName: 'UserScreenFlow',
      properties: {
        processType: 'Flow',
        triggerType: null,
        recordTriggerType: null,
        faultableElementCount: 1,
        elementsWithoutFault: 1,
        hasUnhandledFaults: true,
      },
    }),
    // Fully-handled flow — should not appear.
    makeFlow({
      id: 'Flow:CleanFlow',
      apiName: 'CleanFlow',
      properties: {
        processType: 'AutoLaunchedFlow',
        faultableElementCount: 1,
        elementsWithoutFault: 0,
        hasUnhandledFaults: false,
      },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ffa-'));
  const opened = await openGraph(join(tempDir, 'ffa.db'));
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

describe('classifyFaultSurface', () => {
  it('classifies record-triggered flows (incl. before-save) as transactional', () => {
    expect(
      classifyFaultSurface({
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordBeforeSave',
      }),
    ).toBe('transactional');
    expect(
      classifyFaultSurface({
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
      }),
    ).toBe('transactional');
  });

  it('classifies plain screen flows as screen', () => {
    expect(
      classifyFaultSurface({ processType: 'Flow', triggerType: null }),
    ).toBe('screen');
  });

  it('classifies untriggered autolaunched flows as transactional', () => {
    expect(classifyFaultSurface({ processType: 'AutoLaunchedFlow' })).toBe(
      'transactional',
    );
  });

  it('returns unknown when processType is absent', () => {
    expect(classifyFaultSurface({})).toBe('unknown');
  });
});

describe('flowFaultAuditHandler — fault surfacing honesty (Bug batch 6)', () => {
  it('FAIL-BEFORE/PASS-AFTER: rendered text does NOT claim unhandled faults are silent', async () => {
    const r = await flowFaultAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The old copy said "halt the interview silently" — factually wrong: an
    // unhandled fault is surfaced (error screen / runtime error), never silent.
    expect(r.value.data.rendered).not.toMatch(/silently/i);
    expect(r.value.data.rendered).toMatch(/surfaced, not silent/i);
    // It must explain the transactional rollback-with-visible-error path.
    expect(r.value.data.rendered).toMatch(/rolls? back/i);
  });

  it('tags each unhandled-fault flow with how its fault surfaces', async () => {
    const r = await flowFaultAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.flows.map((f) => [f.id, f.faultSurface]));
    expect(byId.get('Flow:BeforeSaveAutomation')).toBe('transactional');
    expect(byId.get('Flow:UserScreenFlow')).toBe('screen');
    expect(byId.has('Flow:CleanFlow')).toBe(false);
  });

  it('still reports only flows with unhandled faults', async () => {
    const r = await flowFaultAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.flowsWithUnhandledFaults).toBe(2);
    expect(r.value.data.flows.map((f) => f.id).sort()).toEqual([
      'Flow:BeforeSaveAutomation',
      'Flow:UserScreenFlow',
    ]);
  });

  // P15 oversize-enumeration guard (0.2.0 gate): the handler cap must DISCLOSE
  // truncation — the full offender count stays honest, the cut list carries an
  // explicit `truncated` flag, and rendered text tells the caller the way out.
  it('FAIL-BEFORE/PASS-AFTER: limit caps the worst-first list with explicit truncation disclosure', async () => {
    const r = await flowFaultAuditHandler(ctx, { limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Full count survives the cap; the list is cut worst-first.
    expect(r.value.data.flowsWithUnhandledFaults).toBe(2);
    expect(r.value.data.flows).toHaveLength(1);
    expect(r.value.data.flows[0]?.id).toBe('Flow:BeforeSaveAutomation');
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.rendered).toMatch(/truncated to the worst 1 of 2/i);
    expect(r.value.data.rendered).toMatch(/raise `limit`/i);
  });

  it('does not claim truncation when everything fits (and the scan completed)', async () => {
    const r = await flowFaultAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.truncated).toBe(false);
    expect(r.value.data.scanTruncated).toBe(false);
    expect(r.value.data.rendered).not.toMatch(/truncated/i);
  });

  // Bare-call byte-identity guard for the object-scope fix: an unscoped call
  // must NOT carry an `appliedScope` block (its shape is unchanged).
  it('BARE CALL: no appliedScope on an unscoped org-wide call', async () => {
    const r = await flowFaultAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('appliedScope' in r.value.data).toBe(false);
  });
});

// FLOW-FAULT-AUDIT-IGNORES-OBJECT-SCOPE: an object scope narrows the sweep to
// record-triggered flows on that object and echoes appliedScope; an object
// absent from the vault is refused with invalid-query.
const makeObjectNode = (id: string): Node => ({
  id,
  type: 'CustomObject',
  apiName: id.slice('CustomObject:'.length),
  label: null,
  parentId: null,
  sourcePath: 'unused.object-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const scopeSeed: ExtractionResult = {
  nodes: [
    makeObjectNode('CustomObject:Contact'),
    makeObjectNode('CustomObject:Opportunity'),
    // A record-triggered flow ON Contact with unhandled faults.
    makeFlow({
      id: 'Flow:ContactBeforeSave',
      apiName: 'ContactBeforeSave',
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordBeforeSave',
        triggerObject: 'Contact',
        faultableElementCount: 2,
        elementsWithoutFault: 2,
        hasUnhandledFaults: true,
      },
    }),
    // A record-triggered flow ON Opportunity with unhandled faults.
    makeFlow({
      id: 'Flow:OpportunityAfterSave',
      apiName: 'OpportunityAfterSave',
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
        triggerObject: 'Opportunity',
        faultableElementCount: 1,
        elementsWithoutFault: 1,
        hasUnhandledFaults: true,
      },
    }),
    // A screen flow with unhandled faults but no single object — excluded under
    // any object scope, included org-wide.
    makeFlow({
      id: 'Flow:ScreenNoObject',
      apiName: 'ScreenNoObject',
      properties: {
        processType: 'Flow',
        triggerType: null,
        faultableElementCount: 1,
        elementsWithoutFault: 1,
        hasUnhandledFaults: true,
      },
    }),
  ],
  edges: [],
};

describe('flowFaultAuditHandler — object scope (FLOW-FAULT-AUDIT-IGNORES-OBJECT-SCOPE)', () => {
  let scopeDir: string;
  let scopeStore: GraphStore;
  let scopeCtx: Context;

  beforeAll(async () => {
    scopeDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ffa-scope-'));
    const opened = await openGraph(join(scopeDir, 'ffa-scope.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    scopeStore = opened.value;
    const imp = await importExtractionResults(scopeStore, [scopeSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    scopeCtx = { vaultRoot: scopeDir, manifest: FIXTURE_MANIFEST, graph: scopeStore };
  });

  afterAll(async () => {
    await closeGraph(scopeStore);
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it('HONOR: objectApiName narrows to record-triggered flows on that object + emits appliedScope', async () => {
    const r = await flowFaultAuditHandler(scopeCtx, { objectApiName: 'Contact' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({
      object: 'CustomObject:Contact',
      mode: 'component',
    });
    expect(r.value.data.flows.map((f) => f.id)).toEqual(['Flow:ContactBeforeSave']);
    expect(r.value.data.totalFlows).toBe(1);
  });

  it('NARROWS DIFFERENTLY per object — Contact ≠ Opportunity ≠ bare', async () => {
    const [contact, opp, bare] = await Promise.all([
      flowFaultAuditHandler(scopeCtx, { objectApiName: 'Contact' }),
      flowFaultAuditHandler(scopeCtx, { objectApiName: 'Opportunity' }),
      flowFaultAuditHandler(scopeCtx, {}),
    ]);
    expect(contact.ok && opp.ok && bare.ok).toBe(true);
    if (!contact.ok || !opp.ok || !bare.ok) return;
    expect(contact.value.data.flows.map((f) => f.id)).toEqual(['Flow:ContactBeforeSave']);
    expect(opp.value.data.flows.map((f) => f.id)).toEqual(['Flow:OpportunityAfterSave']);
    // Bare is org-wide: all three faulted flows, and NO appliedScope.
    expect(bare.value.data.flowsWithUnhandledFaults).toBe(3);
    expect('appliedScope' in bare.value.data).toBe(false);
    // The scoped pages differ from each other and from bare.
    expect(JSON.stringify(contact.value.data.flows)).not.toBe(
      JSON.stringify(opp.value.data.flows),
    );
  });

  it('accepts a CustomObject: componentId alias equivalently to objectApiName', async () => {
    const [byApi, byComponent] = await Promise.all([
      flowFaultAuditHandler(scopeCtx, { objectApiName: 'Opportunity' }),
      flowFaultAuditHandler(scopeCtx, { componentId: 'CustomObject:Opportunity' }),
    ]);
    expect(byApi.ok && byComponent.ok).toBe(true);
    if (!byApi.ok || !byComponent.ok) return;
    expect(byComponent.value.data.appliedScope).toEqual({
      object: 'CustomObject:Opportunity',
      mode: 'component',
    });
    expect(byComponent.value.data.flows.map((f) => f.id)).toEqual(
      byApi.value.data.flows.map((f) => f.id),
    );
  });

  it('REFUSE: an object absent from the vault → named invalid-query (never org-wide)', async () => {
    const r = await flowFaultAuditHandler(scopeCtx, { objectApiName: 'NoSuchObject__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/no object named 'NoSuchObject__c'/i);
  });

  it('REFUSE: disagreeing object aliases → invalid-query', async () => {
    const r = await flowFaultAuditHandler(scopeCtx, {
      objectApiName: 'Contact',
      object: 'Opportunity',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});
