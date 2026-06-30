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
});
