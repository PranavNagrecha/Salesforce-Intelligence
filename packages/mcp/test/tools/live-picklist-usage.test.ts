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
import { livePicklistUsageHandler } from '../../src/tools/live-picklist-usage.js';
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

const PICKLIST = 'CustomField:Case.Status__c';
const TEXT_FIELD = 'CustomField:Case.Notes__c';
const seed: ExtractionResult = {
  nodes: [
    baseNode({ id: 'CustomObject:Case', type: 'CustomObject', apiName: 'Case' }),
    baseNode({
      id: PICKLIST,
      type: 'CustomField',
      apiName: 'Status__c',
      parentId: 'CustomObject:Case',
      properties: { dataType: 'Picklist', picklistValues: ['New', 'Working', 'Escalated', 'Closed'] },
    }),
    baseNode({
      id: TEXT_FIELD,
      type: 'CustomField',
      apiName: 'Notes__c',
      parentId: 'CustomObject:Case',
      properties: { dataType: 'Text' },
    }),
  ],
  edges: [],
};

// GROUP BY returns New=50, Working=30, Legacy=5 (undefined), null=10.
// 'Escalated' and 'Closed' are defined but unused.
const liveExec: ExecCommand = async (_bin, args) => {
  if (args.includes('--use-tooling-api')) {
    return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
  }
  return {
    stdout: JSON.stringify({
      result: {
        records: [
          { Status__c: 'New', cnt: 50 },
          { Status__c: 'Working', cnt: 30 },
          { Status__c: 'Legacy', cnt: 5 },
          { Status__c: null, cnt: 10 },
        ],
      },
    }),
    stderr: '',
  };
};

let dir: string;
let store: GraphStore;
let ctx: Context;
let consentDir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-pick-'));
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
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-pick-consent-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'c.json');
  delete process.env.SFI_LIVE_PLANE_ENABLED;
});

afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_CONSENT_PATH;
  rmSync(consentDir, { recursive: true, force: true });
});

describe('livePicklistUsageHandler (P6-live-picklist-usage)', () => {
  it('rejects a non-picklist field', async () => {
    const r = await livePicklistUsageHandler(ctx, { fieldId: TEXT_FIELD, liveEnabled: true }, liveExec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('without consent returns defined values + caveat (offline_snapshot), no usage', async () => {
    const r = await livePicklistUsageHandler(ctx, { fieldId: PICKLIST }, liveExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.trust.provenance).toBe('offline_snapshot');
    expect(r.value.data.usage).toBeNull();
    expect(r.value.data.definedValues).toEqual(['New', 'Working', 'Escalated', 'Closed']);
    expect(r.value.data.consentPresent).toBe(false);
  });

  it('with consent fuses live usage with the defined value set', async () => {
    const r = await livePicklistUsageHandler(ctx, { fieldId: PICKLIST, liveEnabled: true }, liveExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.trust.provenance).toBe('hybrid');
    expect(d.blankCount).toBe(10);
    expect(d.totalRecords).toBe(95);
    // Usage ordered by count desc; defined flag set.
    expect(d.usage?.[0]).toEqual({ value: 'New', count: 50, defined: true });
    expect(d.usage?.find((u) => u.value === 'Legacy')?.defined).toBe(false);
    // Cross-reference: Escalated + Closed defined but unused; Legacy used but undefined.
    expect([...d.unusedDefinedValues].sort()).toEqual(['Closed', 'Escalated']);
    expect(d.undefinedUsedValues).toEqual(['Legacy']);
    expect(d.isEmpty).toBe(false);
  });

  it('honest empty when no records use the picklist', async () => {
    const emptyExec: ExecCommand = async (_b, args) => {
      if (args.includes('--use-tooling-api')) {
        return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };
    const r = await livePicklistUsageHandler(ctx, { fieldId: PICKLIST, liveEnabled: true }, emptyExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.isEmpty).toBe(true);
    expect(r.value.data.usage).toEqual([]);
    expect([...r.value.data.unusedDefinedValues].sort()).toEqual(
      ['Closed', 'Escalated', 'New', 'Working'],
    );
  });
});
