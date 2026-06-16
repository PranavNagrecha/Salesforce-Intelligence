/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import type { Context } from '../../src/server.js';
import { fieldChangeAdvisorHandler } from '../../src/tools/field-change-advisor.js';
import { resetLiveSession } from '../../src/tools/live-session.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 1, CustomField: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const baseNode = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const FIELD = 'CustomField:Acct__c.Region__c';
const seed: ExtractionResult = {
  nodes: [
    baseNode({ id: 'CustomObject:Acct__c', type: 'CustomObject', apiName: 'Acct__c' }),
    baseNode({
      id: FIELD,
      type: 'CustomField',
      apiName: 'Region__c', // realistic: just the field name (SOQL-safe)
      parentId: 'CustomObject:Acct__c',
      properties: { required: false },
    }),
  ],
  edges: [],
};

// 30 of 80 records have the field null; staleness reports fresh.
const liveExec: ExecCommand = async (_bin, args) => {
  const soql = String(args[args.indexOf('--query') + 1] ?? '');
  if (args.includes('--use-tooling-api')) {
    return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
  }
  const count = soql.includes('= null') ? 30 : 80;
  return { stdout: JSON.stringify({ result: { totalSize: count } }), stderr: '' };
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-advisor-live-'));
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

beforeEach(() => resetLiveSession());
afterEach(() => resetLiveSession());

describe('fieldChangeAdvisorHandler — live wiring (P6-live-advisor-wire)', () => {
  it('offline: no live null-rate, recommendations cite only the vault', async () => {
    const r = await fieldChangeAdvisorHandler(ctx, { fieldId: FIELD }, liveExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.makeRequired?.liveNullRate).toBeUndefined();
    expect(r.value.data.recommendations.some((x) => x.includes('Live (read-only)'))).toBe(false);
  });

  it('with the live plane the advisor cites live population alongside the vault impact', async () => {
    const r = await fieldChangeAdvisorHandler(
      ctx,
      { fieldId: FIELD, liveEnabled: true },
      liveExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mr = r.value.data.makeRequired;
    expect(mr?.liveNullRate?.totalCount).toBe(80);
    expect(mr?.liveNullRate?.nullCount).toBe(30);
    expect(mr?.liveNullRate?.nullRate).toBe(0.375);
    // The recommendations cite BOTH planes (live record population + vault verdict).
    expect(r.value.data.recommendations.some((x) => x.includes('Live (read-only)'))).toBe(true);
  });
});
