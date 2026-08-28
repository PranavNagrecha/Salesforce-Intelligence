/// <reference types="vitest/globals" />

/**
 * Adversarial honesty tests for the `sfi.review_change` access-parity resolver
 * (`resolveAccessParity`).
 *
 * Two defects are pinned here, both of which make the tool assert a security
 * fact it never established:
 *
 *   R1(a) the ViewAllData / ModifyAllData scan issued ONE `listNodesByType`
 *         page (`ORDER BY id ASC LIMIT 500 OFFSET 0`), so in an org with more
 *         than 500 Profiles + PermissionSets the sole ModifyAllData holder
 *         sorting past node 500 was NEVER read — and every ungranted custom
 *         field was falsely flagged "would deploy with access to NOBODY".
 *
 *   R1(b) when no component reached the zero-grant branch the org-wide scan is
 *         skipped, and the result still published
 *         `systemPermHolders: { viewAllData: 0, modifyAllData: 0 }` — a
 *         NOT-CHECKED value rendered as a CHECKED zero.
 *
 * Placeholder org data only — no real org names.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
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
import { resolveAccessParity } from '../../src/tools/access-parity.js';

const REFRESHED_AT = '2026-05-30T09:00:00Z';

const manifest = (): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: REFRESHED_AT,
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-access-parity-honesty',
});

const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const makeEdge = (
  o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({ confidence: 'declared', source: 'unit-test', properties: {}, ...o });

// ---------------------------------------------------------------------------
// Store BIG — 500 permission sets with NO system permission, plus ONE holder of
// ModifyAllData/ViewAllData whose id (`PermissionSet:zzz_...`) sorts AFTER all
// 500 under `ORDER BY id ASC`. A single 500-row page never reaches it.
// ---------------------------------------------------------------------------
const FILLER_COUNT = 500;
const BIG: ExtractionResult = {
  nodes: [
    ...Array.from({ length: FILLER_COUNT }, (_, i) => {
      const name = `Aaa_PS_${String(i).padStart(4, '0')}`;
      return makeNode({ id: `PermissionSet:${name}`, type: 'PermissionSet', apiName: name });
    }),
    makeNode({
      id: 'PermissionSet:zzz_Blanket_PS',
      type: 'PermissionSet',
      apiName: 'zzz_Blanket_PS',
      properties: { userPermissions: ['ModifyAllData', 'ViewAllData'] },
    }),
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({
      id: 'CustomField:Account.Orphan__c',
      apiName: 'Account.Orphan__c',
      parentId: 'CustomObject:Account',
    }),
  ],
  edges: [],
};

// ---------------------------------------------------------------------------
// Store SMALL — one permission set granting one field, one ungranted field, and
// NO system-perm holder anywhere.
// ---------------------------------------------------------------------------
const SMALL: ExtractionResult = {
  nodes: [
    makeNode({ id: 'PermissionSet:Sales_PS', type: 'PermissionSet', apiName: 'Sales_PS' }),
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({
      id: 'CustomField:Account.Granted__c',
      apiName: 'Account.Granted__c',
      parentId: 'CustomObject:Account',
    }),
    makeNode({
      id: 'CustomField:Account.Orphan__c',
      apiName: 'Account.Orphan__c',
      parentId: 'CustomObject:Account',
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'PermissionSet:Sales_PS',
      toId: 'CustomField:Account.Granted__c',
      edgeType: 'grantedBy',
      properties: { readable: true },
    }),
  ],
};

let dirBig: string;
let dirSmall: string;
let storeBig: GraphStore;
let storeSmall: GraphStore;
const ctxBig = (): Context => ({ vaultRoot: dirBig, manifest: manifest(), graph: storeBig });
const ctxSmall = (): Context => ({ vaultRoot: dirSmall, manifest: manifest(), graph: storeSmall });

beforeAll(async () => {
  dirBig = mkdtempSync(join(tmpdir(), 'sfi-parity-big-'));
  dirSmall = mkdtempSync(join(tmpdir(), 'sfi-parity-small-'));
  const ob = await openGraph(join(dirBig, 'graph.duckdb'));
  if (!ob.ok) throw new Error(ob.error.message);
  storeBig = ob.value;
  const ib = await importExtractionResults(storeBig, [BIG]);
  if (!ib.ok) throw new Error(ib.error.message);
  const openedSmall = await openGraph(join(dirSmall, 'graph.duckdb'));
  if (!openedSmall.ok) throw new Error(openedSmall.error.message);
  storeSmall = openedSmall.value;
  const is = await importExtractionResults(storeSmall, [SMALL]);
  if (!is.ok) throw new Error(is.error.message);
}, 120_000);

afterAll(async () => {
  await closeGraph(storeBig);
  await closeGraph(storeSmall);
  rmSync(dirBig, { recursive: true, force: true });
  rmSync(dirSmall, { recursive: true, force: true });
});

describe('access parity — the system-perm scan reaches past the first page', () => {
  it('finds a ModifyAllData holder sorting past node 500 (no false "ships for nobody")', async () => {
    const r = await resolveAccessParity(ctxBig(), [
      { type: 'CustomField', apiName: 'Account.Orphan__c', changeKind: 'added' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.shipsForNobody).toEqual([]);
    expect(r.value.systemPermCovered).toBe(1);
    expect(r.value.systemPermHolders.modifyAllData).toBe(1);
    expect(r.value.systemPermHolders.viewAllData).toBe(1);
  }, 120_000);

  it('does not claim truncation when every grantor type was exhausted', async () => {
    const r = await resolveAccessParity(ctxBig(), [
      { type: 'CustomField', apiName: 'Account.Orphan__c', changeKind: 'added' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scanTruncated).toBe(false);
    expect(r.value.boundaries.some((b) => b.includes('Full scan capped'))).toBe(false);
  }, 120_000);
});

describe('access parity — NOT-CHECKED holder counts are not a checked zero', () => {
  it('reports null holder counts when the org-wide scan never ran', async () => {
    const r = await resolveAccessParity(ctxSmall(), [
      { type: 'CustomField', apiName: 'Account.Granted__c', changeKind: 'added' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Nothing reached the zero-grant branch, so nothing was scanned.
    expect(r.value.explicitlyGranted).toBe(1);
    expect(r.value.systemPermHolders.viewAllData).toBeNull();
    expect(r.value.systemPermHolders.modifyAllData).toBeNull();
  });

  it('reports a CHECKED zero (0, not null) when the scan ran and found none', async () => {
    const r = await resolveAccessParity(ctxSmall(), [
      { type: 'CustomField', apiName: 'Account.Orphan__c', changeKind: 'added' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.shipsForNobody.map((f) => f.id)).toEqual(['CustomField:Account.Orphan__c']);
    expect(r.value.systemPermHolders.viewAllData).toBe(0);
    expect(r.value.systemPermHolders.modifyAllData).toBe(0);
  });

  it('a standard-field-only changeset never scans, so holders stay null', async () => {
    const r = await resolveAccessParity(ctxSmall(), [
      { type: 'CustomField', apiName: 'Account.Industry', changeKind: 'added' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.standardDefault).toBe(1);
    expect(r.value.systemPermHolders.viewAllData).toBeNull();
    expect(r.value.systemPermHolders.modifyAllData).toBeNull();
  });
});
