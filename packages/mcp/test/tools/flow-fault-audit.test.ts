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
  //
  // UPDATED by FIX 4 (flow-fault pagination). The INVARIANT this pinned is
  // unchanged and is still asserted below: full count honest + explicit
  // `truncated` + rendered text naming the way out. Only the WAY OUT moved —
  // `raise limit (max 500)` was a dead end once the list passed 500, so the
  // recovery path is now the returned `nextCursor`. The old copy is asserted
  // ABSENT so nobody reintroduces a limit-only escape hatch.
  it('FAIL-BEFORE/PASS-AFTER: limit caps the worst-first list with explicit truncation disclosure', async () => {
    const r = await flowFaultAuditHandler(ctx, { limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Full count survives the cap; the list is cut worst-first.
    expect(r.value.data.flowsWithUnhandledFaults).toBe(2);
    expect(r.value.data.flows).toHaveLength(1);
    expect(r.value.data.flows[0]?.id).toBe('Flow:BeforeSaveAutomation');
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.rendered).toMatch(/Showing the worst 1 of 2 flagged flows/i);
    expect(r.value.data.rendered).toMatch(/pass the returned nextCursor/i);
    expect(r.value.data.rendered).not.toMatch(/raise `limit`/i);
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

  // FIX 8(a→b) OBJECT-SCOPE-PREFIX-REFUSAL. This tool has NO reverse mode: it
  // scopes only by OBJECT. A `componentId` carrying any other prefix used to be
  // dropped by the shared resolver and the call fell through to the FULL
  // org-wide report — answering a question the caller did not ask, with no
  // indication that the selector had been discarded.
  it('FAIL-BEFORE/PASS-AFTER: a Flow: componentId is REFUSED, never widened to org-wide', async () => {
    const r = await flowFaultAuditHandler(scopeCtx, {
      componentId: 'Flow:ContactBeforeSave',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('componentId');
    expect(r.error.message).toContain(
      "componentId 'Flow:ContactBeforeSave' is a Flow: id, and this tool scopes only by OBJECT.",
    );
    expect(r.error.message).toContain('Refusing rather than returning the org-wide report');
  });

  it('FAIL-BEFORE/PASS-AFTER: an ApexClass: componentId is refused too (same root)', async () => {
    const r = await flowFaultAuditHandler(scopeCtx, {
      componentId: 'ApexClass:WidgetLedgerService',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('is a ApexClass: id');
  });
});

// =============================================================================
// FIX 4 — page honestly instead of letting the envelope silently eat half the
// rows. The pre-fix lie this reproduces: `truncated` was
// `entries.length > limit`, so a call with `limit: 500` over 234 flagged flows
// reported `truncated: false` — a completeness claim — while the payload blew
// past the transport ceiling and the global envelope reducer dropped rows
// downstream. There was no offset and no cursor, so the dropped tail was
// unreachable BY ANY ARGUMENT.
// =============================================================================

/** Flagged flows in the paging fixture. Matches the design's measured 234. */
const PAGING_FLOW_COUNT = 234;

/**
 * Invented names only — long enough that 234 rows exceed the handler's 30 KB
 * page budget, which is the whole point: the cut must come from the BUDGET,
 * not from `limit`.
 */
const pagingFlowName = (i: number): string =>
  `Widget_Ledger_Sync_Automation_Flow_${String(i).padStart(4, '0')}`;

const pagingSeed: ExtractionResult = {
  nodes: Array.from({ length: PAGING_FLOW_COUNT }, (_, i) =>
    makeFlow({
      id: `Flow:${pagingFlowName(i)}`,
      apiName: pagingFlowName(i),
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
        status: 'Active',
        // Deliberately EQUAL across most rows so the `id ASC` final tiebreak is
        // what makes the order total — without it an offset resume dups/skips.
        faultableElementCount: 4,
        elementsWithoutFault: 3,
        hasUnhandledFaults: true,
      },
    }),
  ),
  edges: [],
};

describe('flowFaultAuditHandler — FIX 4 honest paging', () => {
  let pageDir: string;
  let pageStore: GraphStore;
  let pageCtx: Context;

  beforeAll(async () => {
    pageDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ffa-page-'));
    const opened = await openGraph(join(pageDir, 'ffa-page.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    pageStore = opened.value;
    const imp = await importExtractionResults(pageStore, [pagingSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    pageCtx = { vaultRoot: pageDir, manifest: FIXTURE_MANIFEST, graph: pageStore };
  });

  afterAll(async () => {
    await closeGraph(pageStore);
    rmSync(pageDir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: limit 500 over 234 flagged flows no longer claims truncated:false', async () => {
    const r = await flowFaultAuditHandler(pageCtx, { limit: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Pre-fix: `entries.length (234) > limit (500)` was false → truncated:false
    // while the payload was far over budget and rows vanished downstream.
    expect(d.truncated).toBe(true);
    expect(d.flows.length).toBeLessThan(PAGING_FLOW_COUNT);
    expect(d.nextCursor).toBeDefined();
    expect(typeof d.nextCursor).toBe('string');
    // The FULL counts stay full-set — only `flows` is the page.
    expect(d.flowsWithUnhandledFaults).toBe(PAGING_FLOW_COUNT);
    expect(d.totalCount).toBe(PAGING_FLOW_COUNT);
    expect(d.totalUnhandledElements).toBe(PAGING_FLOW_COUNT * 3);
  });

  it('the two truncations stay SEPARATE flags with separate sentences', async () => {
    const r = await flowFaultAuditHandler(pageCtx, { limit: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Page boundary fired; the SCAN ceiling did not. Never merged.
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.scanTruncated).toBe(false);
    expect(r.value.data.rendered).toMatch(/pass the returned nextCursor/i);
    expect(r.value.data.rendered).not.toMatch(/flow ceiling/i);
  });

  it('ROUND TRIP: paging with the returned cursor reaches the tail with no dups', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let total = -1;
    let pages = 0;
    for (;;) {
      const r = await flowFaultAuditHandler(
        pageCtx,
        cursor === undefined ? { limit: 500 } : { limit: 500, cursor },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      pages += 1;
      total = d.totalCount;
      for (const f of d.flows) seen.push(f.id);
      if (!d.truncated) break;
      expect(d.nextCursor).toBeDefined();
      cursor = d.nextCursor;
      // Guard: forward progress must terminate.
      expect(pages).toBeLessThan(50);
    }
    expect(total).toBe(PAGING_FLOW_COUNT);
    expect(pages).toBeGreaterThan(1);
    // The union covers the FULL set exactly once — the tail is reachable.
    expect(new Set(seen).size).toBe(total);
    expect(seen).toHaveLength(total);
  });

  it('a whole-fits page reports truncated:false and emits NO cursor', async () => {
    const r = await flowFaultAuditHandler(pageCtx, { limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 5 of 234 → still truncated. Now walk to the last page and check the tail.
    expect(r.value.data.truncated).toBe(true);
    const tail = await flowFaultAuditHandler(pageCtx, {
      limit: 500,
      offset: PAGING_FLOW_COUNT - 3,
    });
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    expect(tail.value.data.flows).toHaveLength(3);
    expect(tail.value.data.truncated).toBe(false);
    expect(tail.value.data.nextCursor).toBeUndefined();
    expect(tail.value.data.pageInfo).toBeUndefined();
    // Full-set totals are unchanged on a tail page.
    expect(tail.value.data.totalCount).toBe(PAGING_FLOW_COUNT);
  });

  it('rendered table row count === flows.length, always', async () => {
    for (const args of [{ limit: 500 }, { limit: 7 }, { limit: 500, offset: 230 }]) {
      const r = await flowFaultAuditHandler(pageCtx, args);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Table = header + separator + one line per row, all starting with '|'.
      const tableLines = r.value.data.rendered
        .split('\n')
        .filter((l) => l.startsWith('|'));
      expect(tableLines.length - 2).toBe(r.value.data.flows.length);
    }
  });

  it('a cursor minted org-wide cannot be replayed against a scoped call', async () => {
    const first = await flowFaultAuditHandler(pageCtx, { limit: 500 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    const replay = await flowFaultAuditHandler(pageCtx, {
      limit: 500,
      cursor,
      objectApiName: 'Widget__c',
    });
    // The object does not exist in this fixture, so the scope refusal fires
    // first; either way the org-wide cursor never silently narrows the answer.
    expect(replay.ok).toBe(false);
  });
});

// =============================================================================
// FIX 7 — the flow audits must say a flow is switched off. `properties.status`
// is on every Flow node, so this costs zero extra queries; before, a quarter of
// the flagged rows were Obsolete/Draft flows whose findings cannot fire today
// and the response gave the reader no way to tell.
// =============================================================================

const statusSeed: ExtractionResult = {
  nodes: [
    makeFlow({
      id: 'Flow:Widget_Intake_Active_Flow',
      apiName: 'Widget_Intake_Active_Flow',
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordBeforeSave',
        status: 'Active',
        faultableElementCount: 2,
        elementsWithoutFault: 1,
        hasUnhandledFaults: true,
      },
    }),
    makeFlow({
      id: 'Flow:Widget_Renewal_Active_Flow',
      apiName: 'Widget_Renewal_Active_Flow',
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
        status: 'Active',
        faultableElementCount: 2,
        elementsWithoutFault: 1,
        hasUnhandledFaults: true,
      },
    }),
    // Obsolete rows carry the WORST counts on purpose: pre-FIX-7 the sort was
    // `elementsWithoutFault DESC` alone, so these two topped the list and the
    // reader's attention went to automation that cannot run.
    makeFlow({
      id: 'Flow:Ledger_Sync_Obsolete_Flow',
      apiName: 'Ledger_Sync_Obsolete_Flow',
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
        status: 'Obsolete',
        faultableElementCount: 9,
        elementsWithoutFault: 9,
        hasUnhandledFaults: true,
      },
    }),
    makeFlow({
      id: 'Flow:Ledger_Archive_Draft_Flow',
      apiName: 'Ledger_Archive_Draft_Flow',
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
        status: 'Draft',
        faultableElementCount: 8,
        elementsWithoutFault: 8,
        hasUnhandledFaults: true,
      },
    }),
    // No `status` property at all — UNKNOWN, and it must NOT become `false`.
    makeFlow({
      id: 'Flow:Widget_Legacy_NoStatus_Flow',
      apiName: 'Widget_Legacy_NoStatus_Flow',
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
        faultableElementCount: 3,
        elementsWithoutFault: 2,
        hasUnhandledFaults: true,
      },
    }),
  ],
  edges: [],
};

describe('flowFaultAuditHandler — FIX 7 activation status', () => {
  let statusDir: string;
  let statusStore: GraphStore;
  let statusCtx: Context;

  beforeAll(async () => {
    statusDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ffa-status-'));
    const opened = await openGraph(join(statusDir, 'ffa-status.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    statusStore = opened.value;
    const imp = await importExtractionResults(statusStore, [statusSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    statusCtx = { vaultRoot: statusDir, manifest: FIXTURE_MANIFEST, graph: statusStore };
  });

  afterAll(async () => {
    await closeGraph(statusStore);
    rmSync(statusDir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: partitions the flagged set into Active vs not-runnable', async () => {
    const r = await flowFaultAuditHandler(statusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.flowsWithUnhandledFaults).toBe(5);
    expect(d.flowsWithUnhandledFaultsActive).toBe(2);
    expect(d.flowsWithUnhandledFaultsNotRunnable).toBe(2);
    expect(d.flowsWithUnhandledFaultsStatusUnknown).toBe(1);
    // The partition is exhaustive — no row falls out of the census.
    expect(
      d.flowsWithUnhandledFaultsActive +
        d.flowsWithUnhandledFaultsNotRunnable +
        d.flowsWithUnhandledFaultsStatusUnknown,
    ).toBe(d.flowsWithUnhandledFaults);
    // Element totals split the same way: 1 + 1 for the two Active flows.
    expect(d.totalUnhandledElementsActive).toBe(2);
    expect(d.totalUnhandledElements).toBe(21);
  });

  it('every row carries its status and a tri-state isRunnable', async () => {
    const r = await flowFaultAuditHandler(statusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.flows.map((f) => [f.id, f]));
    expect(byId.get('Flow:Widget_Intake_Active_Flow')?.status).toBe('Active');
    expect(byId.get('Flow:Widget_Intake_Active_Flow')?.isRunnable).toBe(true);
    expect(byId.get('Flow:Ledger_Sync_Obsolete_Flow')?.status).toBe('Obsolete');
    expect(byId.get('Flow:Ledger_Sync_Obsolete_Flow')?.isRunnable).toBe(false);
    expect(byId.get('Flow:Ledger_Archive_Draft_Flow')?.status).toBe('Draft');
    expect(byId.get('Flow:Ledger_Archive_Draft_Flow')?.isRunnable).toBe(false);
  });

  it('an absent status is null / null — NEVER false and NEVER "Active"', async () => {
    const r = await flowFaultAuditHandler(statusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const unknown = r.value.data.flows.find(
      (f) => f.id === 'Flow:Widget_Legacy_NoStatus_Flow',
    );
    expect(unknown?.status).toBeNull();
    expect(unknown?.isRunnable).toBeNull();
    expect(unknown?.isRunnable).not.toBe(false);
    expect(unknown?.status).not.toBe('Active');
  });

  it('SORT: not-runnable rows come after every runnable row, whatever their counts', async () => {
    const r = await flowFaultAuditHandler(statusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.flows.map((f) => f.id);
    const lastRunnable = Math.max(
      ...r.value.data.flows
        .map((f, i) => (f.isRunnable === false ? -1 : i))
        .filter((i) => i >= 0),
    );
    const firstNotRunnable = r.value.data.flows.findIndex(
      (f) => f.isRunnable === false,
    );
    expect(firstNotRunnable).toBeGreaterThan(lastRunnable);
    // The Obsolete flow has the WORST count (9) and still sorts last.
    expect(ids[ids.length - 2]).toBe('Flow:Ledger_Sync_Obsolete_Flow');
    expect(ids[ids.length - 1]).toBe('Flow:Ledger_Archive_Draft_Flow');
  });

  it('the headline partitions and the activation boundary is UNCONDITIONAL', async () => {
    const r = await flowFaultAuditHandler(statusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rendered).toContain('**2** of 2 ACTIVE flows');
    expect(r.value.data.rendered).toContain(
      'A further **2** flagged flows are not Active (1 Draft, 1 Obsolete) and cannot run today — they are listed below, marked, and sorted last.',
    );
    expect(r.value.data.rendered).toContain(
      'Activation status is reported per row. A flow whose status is Obsolete, Draft, or InvalidDraft does not run in the org today, so its findings are latent, not live. A null status means this vault does not record it — that is UNKNOWN, not Active.',
    );
  });
});

// FIX 4 edge case: a vault whose fault coverage IS recorded and whose flows are
// all clean. The zero must read as CHECKED — full counts present, `truncated`
// explicitly false, `totalCount: 0` — and the activation boundary must still
// fire, because a clean result is the response that most needs to say what it
// checked.
const cleanSeed: ExtractionResult = {
  nodes: [
    makeFlow({
      id: 'Flow:Widget_Guarded_Flow',
      apiName: 'Widget_Guarded_Flow',
      properties: {
        processType: 'AutoLaunchedFlow',
        triggerType: 'RecordAfterSave',
        status: 'Active',
        faultableElementCount: 3,
        elementsWithoutFault: 0,
        hasUnhandledFaults: false,
      },
    }),
  ],
  edges: [],
};

describe('flowFaultAuditHandler — a clean vault is a CHECKED zero', () => {
  let cleanDir: string;
  let cleanStore: GraphStore;
  let cleanCtx: Context;

  beforeAll(async () => {
    cleanDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ffa-clean-'));
    const opened = await openGraph(join(cleanDir, 'ffa-clean.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    cleanStore = opened.value;
    const imp = await importExtractionResults(cleanStore, [cleanSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    cleanCtx = { vaultRoot: cleanDir, manifest: FIXTURE_MANIFEST, graph: cleanStore };
  });

  afterAll(async () => {
    await closeGraph(cleanStore);
    rmSync(cleanDir, { recursive: true, force: true });
  });

  it('zero flagged flows: totalCount 0, truncated false, boundary still fires', async () => {
    const r = await flowFaultAuditHandler(cleanCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.propertyAvailable).toBe(true);
    expect(d.flows).toEqual([]);
    expect(d.totalCount).toBe(0);
    expect(d.truncated).toBe(false);
    expect(d.scanTruncated).toBe(false);
    // The scan HAPPENED: one active flow, three faultable elements, none unhandled.
    expect(d.totalFlows).toBe(1);
    expect(d.totalFaultableElements).toBe(3);
    expect(d.flowsWithUnhandledFaultsActive).toBe(0);
    expect(d.flowsWithUnhandledFaultsNotRunnable).toBe(0);
    expect(d.flowsWithUnhandledFaultsStatusUnknown).toBe(0);
    expect(d.rendered).toContain(
      'Activation status is reported per row. A flow whose status is Obsolete, Draft, or InvalidDraft does not run in the org today, so its findings are latent, not live. A null status means this vault does not record it — that is UNKNOWN, not Active.',
    );
    // No paging fields on a whole-fits call.
    expect(d.nextCursor).toBeUndefined();
    expect(d.pageInfo).toBeUndefined();
  });
});
