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
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import type { Context } from '../../src/server.js';
import { liveAutomationFiredHandler } from '../../src/tools/live-automation-fired.js';
import { resetLiveSession } from '../../src/tools/live-session.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 1, ApexTrigger: 1, Flow: 1 },
  edges: { triggersOn: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'x',
  properties: {},
  ...o,
});

const TRIGGER = 'ApexTrigger:AccountTrigger';
const SCHEDULED_FLOW = 'Flow:NightlyBatch';
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    node({ id: TRIGGER, type: 'ApexTrigger', apiName: 'AccountTrigger' }),
    node({ id: SCHEDULED_FLOW, type: 'Flow', apiName: 'NightlyBatch' }),
  ],
  edges: [
    edge({ fromId: TRIGGER, toId: 'CustomObject:Account', edgeType: 'triggersOn' }),
    // SCHEDULED_FLOW has NO triggersOn edge → not record-triggered.
  ],
};

/** Mock `sf`: staleness fresh; COUNT total + recent driven by the closure config. */
const makeExec = (total: number, recent: number): ExecCommand => async (_bin, args) => {
  const soql = String(args[args.indexOf('--query') + 1] ?? '');
  if (args.includes('--use-tooling-api')) {
    return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
  }
  const count = /LastModifiedDate >=/.test(soql) ? recent : total;
  return { stdout: JSON.stringify({ result: { totalSize: count } }), stderr: '' };
};

let dir: string;
let store: GraphStore;
let ctx: Context;
let consentDir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-autom-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error('openGraph failed');
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error('seed failed');
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetLiveSession();
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-autom-consent-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'c.json');
  delete process.env.SFI_LIVE_PLANE_ENABLED;
});

afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_CONSENT_PATH;
  rmSync(consentDir, { recursive: true, force: true });
});

describe('liveAutomationFiredHandler (P6-live-automation-fired)', () => {
  it('reports applicable:false for a non-record-triggered automation', async () => {
    const r = await liveAutomationFiredHandler(
      ctx,
      { componentId: SCHEDULED_FLOW, liveEnabled: true },
      makeExec(0, 0),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.applicable).toBe(false);
    expect(r.value.data.triggerObject).toBeNull();
    expect(r.value.data.likelyNeverRuns).toBeNull();
  });

  it('without consent returns the resolved trigger object + caveat', async () => {
    const r = await liveAutomationFiredHandler(ctx, { componentId: TRIGGER }, makeExec(5, 5));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.applicable).toBe(true);
    expect(r.value.data.triggerObject).toBe('Account');
    expect(r.value.data.trust.provenance).toBe('offline_snapshot');
    expect(r.value.data.likelyNeverRuns).toBeNull();
  });

  it('flags likelyNeverRuns when the trigger object has ZERO records (heuristic tag)', async () => {
    const r = await liveAutomationFiredHandler(
      ctx,
      { componentId: TRIGGER, liveEnabled: true },
      makeExec(0, 0),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.likelyNeverRuns).toBe(true);
    expect(r.value.data.reason).toContain('ZERO');
    expect(r.value.data.trust.provenance).toBe('hybrid');
    expect(r.value.data.trust.confidence).toBe('heuristic');
  });

  it('flags likelyNeverRuns when records exist but none changed in the window', async () => {
    const r = await liveAutomationFiredHandler(
      ctx,
      { componentId: TRIGGER, liveEnabled: true, staleDays: 30 },
      makeExec(1000, 0),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalRecords).toBe(1000);
    expect(r.value.data.recentlyModified).toBe(0);
    expect(r.value.data.likelyNeverRuns).toBe(true);
  });

  it('does NOT flag when the object is active', async () => {
    const r = await liveAutomationFiredHandler(
      ctx,
      { componentId: TRIGGER, liveEnabled: true },
      makeExec(1000, 250),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.likelyNeverRuns).toBe(false);
    expect(r.value.data.trust.confidence).toBe('heuristic');
  });
});
