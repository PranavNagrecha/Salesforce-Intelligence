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
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import type { Context } from '../../src/server.js';
import { liveCountHandler, liveSampleHandler } from '../../src/tools/live-plane.js';
import { resetLiveSession } from '../../src/tools/live-session.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 1, CustomField: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const baseNode = (
  o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>,
): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

// AcmeApplication__c.Status__c has withdrawn-variant picklist values but NO
// literal value named 'Withdrawn' — exactly the shape of the live-count
// false-negative bug.
const seed: ExtractionResult = {
  nodes: [
    baseNode({
      id: 'CustomObject:AcmeApplication__c',
      type: 'CustomObject',
      apiName: 'AcmeApplication__c',
    }),
    baseNode({
      id: 'CustomField:AcmeApplication__c.Status__c',
      type: 'CustomField',
      apiName: 'Status__c',
      parentId: 'CustomObject:AcmeApplication__c',
      properties: {
        dataType: 'Picklist',
        picklistValues: [
          { value: 'Withdrawn Application', isActive: true },
          { value: 'Withdraw Transfer', isActive: true },
          { value: 'Submitted', isActive: true },
        ],
      },
    }),
  ],
  edges: [],
};

let dir: string;
let store: GraphStore;
let ctx: Context;
let consentDir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-pmm-'));
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
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-pmm-consent-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'c.json');
  delete process.env.SFI_LIVE_PLANE_ENABLED;
});

afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_CONSENT_PATH;
  rmSync(consentDir, { recursive: true, force: true });
});

// COUNT() returns 0 for the non-existent literal (the artifact the bug warns about).
const zeroCountExec: ExecCommand = async () => ({
  stdout: JSON.stringify({ result: { totalSize: 0, records: [{ expr0: 0 }] } }),
  stderr: '',
});

const emptySampleExec: ExecCommand = async () => ({
  stdout: JSON.stringify({ result: { records: [], totalSize: 0 } }),
  stderr: '',
});

describe('live_count picklist-literal mismatch disclosure (Withdrawn bug)', () => {
  it('surfaces a value-mismatch disclosure when the WHERE literal is not a defined picklist value', async () => {
    const r = await liveCountHandler(
      ctx,
      {
        liveEnabled: true,
        soql: "SELECT COUNT() FROM AcmeApplication__c WHERE Status__c = 'Withdrawn'",
      },
      zeroCountExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.count).toBe(0);
    // The count is still reported, but a disclosure makes clear the 0 is a
    // value mismatch — not proof zero withdrawn records exist.
    expect(r.value.data.picklistMismatches).toBeDefined();
    expect(r.value.data.picklistMismatches?.[0]?.field).toBe('Status__c');
    expect(r.value.data.picklistMismatches?.[0]?.suggestions).toContain(
      'Withdrawn Application',
    );
    expect(r.value.data.rendered).toMatch(/not a defined picklist value/i);
    expect(r.value.data.rendered).toMatch(/Withdrawn Application/);
  });

  it('does NOT add a disclosure when the WHERE literal is a real value', async () => {
    const r = await liveCountHandler(
      ctx,
      {
        liveEnabled: true,
        soql: "SELECT COUNT() FROM AcmeApplication__c WHERE Status__c = 'Submitted'",
      },
      zeroCountExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.picklistMismatches).toBeUndefined();
    expect(r.value.data.rendered).not.toMatch(/not a defined picklist value/i);
  });
});

describe('live_sample picklist-literal mismatch disclosure', () => {
  it('surfaces the disclosure on an empty sample for a non-existent value', async () => {
    const r = await liveSampleHandler(
      ctx,
      {
        liveEnabled: true,
        soql: "SELECT Id FROM AcmeApplication__c WHERE Status__c = 'Withdrawn'",
      },
      emptySampleExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.picklistMismatches).toBeDefined();
    expect(r.value.data.picklistMismatches?.[0]?.suggestions).toContain(
      'Withdrawn Application',
    );
  });
});
