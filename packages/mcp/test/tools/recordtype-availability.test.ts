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

import type { Context } from '../../src/server.js';
import { recordtypeAvailabilityHandler } from '../../src/tools/recordtype-availability.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: { Profile: 1 },
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

const SALES = 'Profile:Sales';

const seed: ExtractionResult = {
  nodes: [
    node({
      id: SALES,
      type: 'Profile',
      apiName: 'Sales',
      label: 'Sales',
      properties: {
        recordTypeVisibilities: [
          { recordType: 'Account.Business', visible: true, default: true },
          { recordType: 'Account.Person', visible: true, default: false },
          { recordType: 'Case.Support', visible: false, default: false },
          // Older-format entry: <visible> omitted → treated as visible.
          { recordType: 'Lead.Inbound', default: false },
        ],
      },
    }),
    // A profile from a pre-extraction / stale vault: NO recordTypeVisibilities key.
    node({ id: 'Profile:Bare', type: 'Profile', apiName: 'Bare', label: 'Bare', properties: {} }),
  ],
  edges: [],
};

let store: GraphStore;
let tempDir: string;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-rt-avail-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('recordtypeAvailabilityHandler', () => {
  it('groups record types by object with default + visibility', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: SALES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { objects, summary } = r.value.data;
    const account = objects.find((o) => o.object === 'Account')!;
    expect(account.recordTypes.map((t) => t.name)).toEqual(['Business', 'Person']);
    expect(account.defaultRecordType).toBe('Business');
    expect(account.recordTypes.every((t) => t.visible)).toBe(true);
    // Objects with no default → defaultRecordType null.
    const cas = objects.find((o) => o.object === 'Case')!;
    expect(cas.defaultRecordType).toBeNull();
    expect(cas.recordTypes[0]?.visible).toBe(false);
    expect(summary.objects).toBe(3); // Account, Case, Lead
    expect(summary.visibleRecordTypes).toBe(3); // Business, Person, Lead.Inbound (Case.Support not visible)
  });

  it('treats an omitted <visible> as visible (older metadata)', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: SALES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lead = r.value.data.objects.find((o) => o.object === 'Lead')!;
    expect(lead.recordTypes[0]?.visible).toBe(true);
  });

  it('rejects a non-Profile/PermissionSet id with invalid-query', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown profile', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: 'Profile:Ghost' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('discloses "not modeled" when recordTypeVisibilities is absent, not a verified empty (P12-HONESTY-recordtype-not-modeled)', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: 'Profile:Bare' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objects).toEqual([]);
    expect(r.value.data.summary.visibleRecordTypes).toBe(0);
    expect(r.value.data.boundaryNote).toMatch(/not modeled/);
    expect(r.value.data.boundaryNote).toMatch(/sfi-refresh/);
  });

  it('does NOT cry "not modeled" when the property IS present (the extracted path)', async () => {
    const r = await recordtypeAvailabilityHandler(ctx, { componentId: SALES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaryNote).not.toMatch(/not modeled/);
    expect(r.value.data.boundaryNote).toMatch(/recordTypeVisibilities/);
  });
});
