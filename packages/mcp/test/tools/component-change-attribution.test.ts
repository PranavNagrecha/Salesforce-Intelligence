/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  ATTRIBUTION_DISCLOSURE,
  attributionNeedles,
  componentChangeAttributionHandler,
  correlateAuditRows,
  parsePersistedAuditRows,
  SETUP_AUDIT_TRAIL_FILENAME,
} from '../../src/tools/component-change-attribution.js';

/**
 * #39 — sfi.component_change_attribution: offline heuristic correlation
 * against fixture SetupAuditTrail JSONL. No live org; no real customer names.
 */

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-07-12T00:00:00.000Z',
  sourceOrg: 'fixture',
  components: { ValidationRule: 1, ApexClass: 1 },
  edges: {},
  sourceTreeHash: 'sha256:audit39-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'source/main/default/classes/AlphaController.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const trailLines = [
  {
    id: '0Axxx0000001',
    action: 'changedValidation',
    section: 'Validation Rules',
    createdDate: '2026-06-10T10:00:00.000Z',
    display: 'Changed validation rule Status_Required on Account',
    createdByName: 'Fixture Admin',
    capturedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: '0Axxx0000002',
    action: 'changedApexClass',
    section: 'Apex Class',
    createdDate: '2026-06-11T11:00:00.000Z',
    display: 'Changed Apex Class AlphaController',
    createdByName: 'Fixture Admin',
    capturedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: '0Axxx0000003',
    action: 'changedProfile',
    section: 'Profiles',
    createdDate: '2026-06-12T12:00:00.000Z',
    display: 'Changed profile Standard User',
    createdByName: 'Fixture Admin',
    capturedAt: '2026-07-01T00:00:00.000Z',
  },
];

describe('attributionNeedles + correlateAuditRows (pure)', () => {
  it('prefers longer needles (Object.Name before Object)', () => {
    const needles = attributionNeedles({
      apiName: 'Account.Status_Required',
      objectApiName: 'Account',
    });
    expect(needles[0]?.needle).toBe('Account.Status_Required');
    expect(needles.map((n) => n.needle)).toContain('Status_Required');
    expect(needles.map((n) => n.needle)).toContain('Account');
  });

  it('matches Display text heuristically and ranks newest first', () => {
    const rows = parsePersistedAuditRows(trailLines.map((r) => JSON.stringify(r)).join('\n'));
    const needles = attributionNeedles({
      apiName: 'Account.Status_Required',
      objectApiName: 'Account',
    });
    const matched = correlateAuditRows(rows, needles, 10);
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched[0]?.id).toBe('0Axxx0000001');
    expect(matched[0]?.confidence).toBe('heuristic');
    expect(matched[0]?.createdByName).toBe('Fixture Admin');
  });
});

describe('sfi.component_change_attribution', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = mkdtempSync(join(tmpdir(), 'sfi-attr-'));
    mkdirSync(join(vaultRoot, 'meta'), { recursive: true });
    writeFileSync(
      join(vaultRoot, 'meta', SETUP_AUDIT_TRAIL_FILENAME),
      trailLines.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );

    const opened = await openGraph(join(vaultRoot, 'graph.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'ValidationRule:Account.Status_Required',
          type: 'ValidationRule',
          apiName: 'Account.Status_Required',
          sourcePath: 'source/main/default/objects/Account/validationRules/Status_Required.validationRule-meta.xml',
        }),
        makeNode({
          id: 'ApexClass:AlphaController',
          type: 'ApexClass',
          apiName: 'AlphaController',
        }),
      ],
      edges: [],
    };
    const imp = await importExtractionResults(store, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('returns available:false + enable hint when the JSONL is missing', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'sfi-attr-empty-'));
    try {
      const opened = await openGraph(join(emptyRoot, 'graph.db'));
      if (!opened.ok) throw new Error(opened.error.message);
      const emptyStore = opened.value;
      try {
        const emptyCtx: Context = {
          vaultRoot: emptyRoot,
          manifest: FIXTURE_MANIFEST,
          graph: emptyStore,
        };
        // objectApiName path does not require a graph node — isolates the
        // missing-JSONL disposition from component-not-found.
        const r = await componentChangeAttributionHandler(emptyCtx, {
          objectApiName: 'Account',
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.data.available).toBe(false);
        expect(r.value.data.remedy).toContain('--with-audit-trail');
        expect(r.value.data.disclosure).toBe(ATTRIBUTION_DISCLOSURE);
        expect(r.value.data.confidence).toBe('heuristic');
      } finally {
        await closeGraph(emptyStore);
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('correlates a ValidationRule to matching Display text', async () => {
    const r = await componentChangeAttributionHandler(ctx, {
      componentId: 'ValidationRule:Account.Status_Required',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.totalPersisted).toBe(3);
    expect(r.value.data.changes.length).toBeGreaterThanOrEqual(1);
    expect(r.value.data.changes[0]?.action).toBe('changedValidation');
    expect(r.value.data.changes[0]?.confidence).toBe('heuristic');
    expect(r.value.data.disclosure).toContain('HEURISTIC');
    expect(r.value.data.disclosure).toContain('--with-audit-trail');
  });

  it('correlates by objectApiName alone', async () => {
    const r = await componentChangeAttributionHandler(ctx, {
      objectApiName: 'Account',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.changes.some((c) => c.id === '0Axxx0000001')).toBe(true);
  });

  it('returns available:true with empty changes when nothing correlates', async () => {
    const r = await componentChangeAttributionHandler(ctx, {
      objectApiName: 'NonexistentObject__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.changes).toEqual([]);
    expect(r.value.data.totalMatched).toBe(0);
  });

  it('fails closed on unknown componentId', async () => {
    const r = await componentChangeAttributionHandler(ctx, {
      componentId: 'ApexClass:DoesNotExist',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });
});
