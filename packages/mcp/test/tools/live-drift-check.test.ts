/// <reference types="vitest/globals" />

/**
 * sfi.live_drift_check contract pins.
 *
 * All fixtures are SYNTHETIC. The live describe is injected by stubbing
 * `liveDescribeHandler` (the handler takes no `exec` seam of its own), and the
 * default stub DELEGATES to the real handler so the live-plane-gate test still
 * exercises the genuine gate.
 *
 * The load-bearing pins:
 *  1. R4 — an object the vault does not hold is REFUSED, never billed `inSync`.
 *  2. R4 — a wrong-CASE object name resolves to the vault's casing instead of
 *     silently diffing against an empty field set.
 *  3. R6 — the vault-side field read windows past the 500-row graph ceiling, so
 *     field 501+ is not reported as "added live since the refresh".
 */

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

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import {
  diffFields,
  liveDriftCheckHandler,
  liveDriftCheckInputSchema,
} from '../../src/tools/live-drift-check.js';

const { liveDescribeStub } = vi.hoisted(() => ({ liveDescribeStub: vi.fn() }));

vi.mock('../../src/tools/live-plane.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/tools/live-plane.js')>();
  return { ...actual, liveDescribeHandler: liveDescribeStub };
});

const actualLivePlane = await vi.importActual<
  typeof import('../../src/tools/live-plane.js')
>('../../src/tools/live-plane.js');

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

/** Vault holds 600 custom fields on Account — 100 past the 500-row graph cap. */
const VAULT_FIELD_COUNT = 600;
const fieldName = (i: number): string => `F${String(i).padStart(4, '0')}__c`;

const objectNode = (apiName: string): Node => ({
  id: `CustomObject:${apiName}`,
  type: 'CustomObject',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: `objects/${apiName}/${apiName}.object-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const fieldNode = (object: string, field: string): Node => ({
  id: `CustomField:${object}.${field}`,
  type: 'CustomField',
  apiName: field,
  label: field,
  parentId: `CustomObject:${object}`,
  sourcePath: `objects/${object}/fields/${field}.field-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const seed: ExtractionResult = {
  nodes: [
    objectNode('Account'),
    ...Array.from({ length: VAULT_FIELD_COUNT }, (_, i) =>
      fieldNode('Account', fieldName(i + 1)),
    ),
    objectNode('Contact'),
    fieldNode('Contact', 'Legacy_Id__c'),
  ],
  edges: [],
};

/** Stub the live describe with an explicit field-name list. */
const stubLive = (names: readonly string[]): void => {
  liveDescribeStub.mockImplementation(
    async (_ctx: Context, input: { objectApiName: string }) => ({
      ok: true,
      value: {
        data: {
          objectApiName: input.objectApiName,
          describe: { fields: names.map((name) => ({ name })) },
          trust: { plane: 'live' },
        },
        vaultState: {
          sourceTreeHash: FIXTURE_MANIFEST.sourceTreeHash,
          refreshedAt: FIXTURE_MANIFEST.refreshedAt,
        },
      },
    }),
  );
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ldc-'));
  const opened = await openGraph(join(tempDir, 'ldc.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
    liveCapability: mintLiveCapability('primary'),
  } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Default: the REAL live handler, so the gate test is genuine.
  liveDescribeStub.mockImplementation(actualLivePlane.liveDescribeHandler);
});

describe('diffFields', () => {
  it('flags vault-only fields (stale) and custom live-only fields (added)', () => {
    const d = diffFields(['A__c', 'B__c', 'Name'], ['A__c', 'C__c', 'Name']);
    expect(d.onlyInVault).toEqual(['B__c']); // in snapshot, gone live → stale
    expect(d.onlyInLiveCustom).toEqual(['C__c']); // added live, custom
  });

  it('excludes standard fields from the live-only set (no noise)', () => {
    const d = diffFields(['A__c'], ['A__c', 'Industry', 'Phone']); // Industry/Phone are standard
    expect(d.onlyInVault).toEqual([]);
    expect(d.onlyInLiveCustom).toEqual([]);
  });

  it('reports nothing when the field sets match', () => {
    const d = diffFields(['A__c', 'B__c'], ['B__c', 'A__c']);
    expect(d.onlyInVault).toEqual([]);
    expect(d.onlyInLiveCustom).toEqual([]);
  });
});

describe('liveDriftCheckHandler', () => {
  it('propagates the live-plane-disabled error when not enabled', async () => {
    const r = await liveDriftCheckHandler(ctx, { objectApiName: 'Account' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // liveDescribeHandler refuses when the plane is off.
    expect(r.error.message.toLowerCase()).toContain('live');
  });

  // R4 — the object-scope existence check.
  it('REFUSES an object the vault does not hold instead of billing it inSync', async () => {
    stubLive(['Id', 'Name', 'Widget_Code__c']);
    const r = await liveDriftCheckHandler(ctx, {
      objectApiName: 'Widget__c',
      liveEnabled: true,
    });
    if (r.ok) {
      throw new Error(
        `expected refusal, got inSync=${String(r.value.data.inSync)} / ${r.value.data.interpretation}`,
      );
    }
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Widget__c');
  });

  // R4 — wrong CASE is a first-class case, not an edge case.
  it('resolves a wrong-CASE object name to the vault casing', async () => {
    stubLive(['Id', 'Legacy_Id__c']);
    const r = await liveDriftCheckHandler(ctx, {
      objectApiName: 'contact',
      liveEnabled: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.message);
    // Echoed scope is the VAULT's casing, with the caller's spelling disclosed.
    expect(r.value.data.objectApiName).toBe('Contact');
    expect(r.value.data.resolvedFrom).toBe('contact');
    expect(r.value.data.interpretation).toContain("Resolved 'contact'");
    expect(r.value.data.vaultFieldCount).toBe(1);
    expect(r.value.data.onlyInVault).toEqual([]);
    expect(r.value.data.onlyInLiveCustom).toEqual([]);
    expect(r.value.data.inSync).toBe(true);
  });

  it('leaves resolvedFrom null when the caller already used the vault casing', async () => {
    stubLive(['Id', 'Legacy_Id__c']);
    const r = await liveDriftCheckHandler(ctx, {
      objectApiName: 'Contact',
      liveEnabled: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.resolvedFrom).toBeNull();
    expect(r.value.data.interpretation).not.toContain('Resolved');
  });

  // R6 — the vault read must window past the 500-row graph ceiling.
  it('reads every vault field past the 500-row cap (no phantom "added live")', async () => {
    const liveNames = [
      'Id',
      'Name',
      ...Array.from({ length: VAULT_FIELD_COUNT }, (_, i) => fieldName(i + 1)),
    ];
    stubLive(liveNames);
    const r = await liveDriftCheckHandler(ctx, {
      objectApiName: 'Account',
      liveEnabled: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.vaultFieldCount).toBe(VAULT_FIELD_COUNT);
    expect(r.value.data.onlyInLiveCustom).toEqual([]);
    expect(r.value.data.onlyInVault).toEqual([]);
    expect(r.value.data.inSync).toBe(true);
    // The whole object was read, so nothing is withheld.
    expect(r.value.data.vaultScanIncomplete).toBe(false);
  });

  // R6 — windowing is real paging, not a bigger single page: shrink the window
  // to 7 rows and the 600-field object must still come back whole.
  it('windows the vault read at whatever page size the graph allows', async () => {
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '7';
    try {
      stubLive(
        Array.from({ length: VAULT_FIELD_COUNT }, (_, i) => fieldName(i + 1)),
      );
      const r = await liveDriftCheckHandler(ctx, {
        objectApiName: 'Account',
        liveEnabled: true,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.data.vaultFieldCount).toBe(VAULT_FIELD_COUNT);
      expect(r.value.data.onlyInLiveCustom).toEqual([]);
      expect(r.value.data.vaultScanIncomplete).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });

  // R4 — a real object in the vault whose fields genuinely drifted still reads
  // as STALE; the existence check must not swallow the signal it exists for.
  it('still reports genuine staleness for an object the vault does hold', async () => {
    stubLive(['Id']); // Legacy_Id__c has gone from the live org
    const r = await liveDriftCheckHandler(ctx, {
      objectApiName: 'Contact',
      liveEnabled: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.onlyInVault).toEqual(['Legacy_Id__c']);
    expect(r.value.data.inSync).toBe(false);
    expect(r.value.data.interpretation).toContain('STALE');
  });
});

describe('liveDriftCheckInputSchema', () => {
  it('requires objectApiName and accepts liveEnabled', () => {
    expect(liveDriftCheckInputSchema.safeParse({}).success).toBe(false);
    expect(liveDriftCheckInputSchema.safeParse({ objectApiName: 'Account', liveEnabled: true }).success).toBe(true);
  });
});
