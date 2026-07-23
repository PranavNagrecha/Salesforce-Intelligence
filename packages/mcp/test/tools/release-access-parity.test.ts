/// <reference types="vitest/globals" />

/**
 * Access-parity ("ships for nobody") grant-completeness check folded into
 * `sfi.review_change` behind the opt-in `checkAccessParity` flag.
 *
 * Proves the four sanity contracts:
 *   (a) an ADDED custom field granted by a permission set in the vault → NOT flagged;
 *   (b) an ADDED custom field with no grant anywhere → flagged "ships for nobody";
 *   (c) a STANDARD field, and a custom field covered by a ModifyAllData holder → NOT flagged;
 * plus the honesty axes: the freshness stamp is the vault refresh time, the
 * section is ABSENT by default (byte-identity), grants are `declared`, and
 * deleted / non-field-object entries are out of scope.
 *
 * Two graphs are used because the ViewAllData / ModifyAllData scan is ORG-WIDE:
 * store A has NO system-perm holder (so a zero-grant field flags), store B has a
 * ModifyAllData holder (so a zero-grant field is covered, not flagged).
 * Placeholder org data only — no real org names.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtractionResult,
  Edge,
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
import { reviewChangeHandler } from '../../src/tools/review-change.js';

const REFRESHED_AT = '2026-05-30T09:00:00Z';

const manifest = (): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: REFRESHED_AT,
  sourceOrg: 'me@example.com',
  components: { CustomField: 4, CustomObject: 2, PermissionSet: 1, Profile: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture-access-parity',
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
// Store A — NO ViewAllData / ModifyAllData holder.
//   Sales_PS grants Account.Granted__c (FLS readable) and Widget__c (object read).
//   Account.Orphan__c / Ghost__c have NO grant → "ships for nobody".
//   Account.Industry is a STANDARD field (no __c) → default access.
// ---------------------------------------------------------------------------
const STORE_A: ExtractionResult = {
  nodes: [
    makeNode({ id: 'PermissionSet:Sales_PS', type: 'PermissionSet', apiName: 'Sales_PS' }),
    makeNode({ id: 'Profile:Standard_User', type: 'Profile', apiName: 'Standard_User' }),
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({ id: 'CustomField:Account.Granted__c', apiName: 'Account.Granted__c', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'CustomField:Account.Orphan__c', apiName: 'Account.Orphan__c', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'CustomField:Account.Industry', apiName: 'Account.Industry', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'CustomObject:Widget__c', type: 'CustomObject', apiName: 'Widget__c' }),
    makeNode({ id: 'CustomObject:Ghost__c', type: 'CustomObject', apiName: 'Ghost__c' }),
  ],
  edges: [
    makeEdge({ fromId: 'PermissionSet:Sales_PS', toId: 'CustomField:Account.Granted__c', edgeType: 'grantedBy', properties: { readable: true } }),
    makeEdge({ fromId: 'PermissionSet:Sales_PS', toId: 'CustomObject:Widget__c', edgeType: 'grantedBy', properties: { allowRead: true } }),
  ],
};

// ---------------------------------------------------------------------------
// Store B — a ModifyAllData holder exists. A zero-grant custom field is covered
// by that system perm → NOT flagged.
// ---------------------------------------------------------------------------
const STORE_B: ExtractionResult = {
  nodes: [
    makeNode({ id: 'Profile:System_Admin', type: 'Profile', apiName: 'System_Admin', properties: { userPermissions: ['ModifyAllData'] } }),
    makeNode({ id: 'PermissionSet:Viewer_PS', type: 'PermissionSet', apiName: 'Viewer_PS', properties: { userPermissions: ['ViewAllData'] } }),
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({ id: 'CustomField:Account.AdminOnly__c', apiName: 'Account.AdminOnly__c', parentId: 'CustomObject:Account' }),
  ],
  edges: [],
};

let dirA: string;
let dirB: string;
let storeA: GraphStore;
let storeB: GraphStore;
const ctxA = (): Context => ({ vaultRoot: dirA, manifest: manifest(), graph: storeA });
const ctxB = (): Context => ({ vaultRoot: dirB, manifest: manifest(), graph: storeB });

beforeAll(async () => {
  dirA = mkdtempSync(join(tmpdir(), 'sfi-parity-a-'));
  dirB = mkdtempSync(join(tmpdir(), 'sfi-parity-b-'));
  const oa = await openGraph(join(dirA, 'graph.duckdb'));
  if (!oa.ok) throw new Error(oa.error.message);
  storeA = oa.value;
  const ia = await importExtractionResults(storeA, [STORE_A]);
  if (!ia.ok) throw new Error(ia.error.message);
  const ob = await openGraph(join(dirB, 'graph.duckdb'));
  if (!ob.ok) throw new Error(ob.error.message);
  storeB = ob.value;
  const ib = await importExtractionResults(storeB, [STORE_B]);
  if (!ib.ok) throw new Error(ib.error.message);
});

afterAll(async () => {
  await closeGraph(storeA);
  await closeGraph(storeB);
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe('review_change access parity — default (flag off) is byte-identity-safe', () => {
  it('omits the accessParity section when checkAccessParity is unset', async () => {
    const r = await reviewChangeHandler(ctxA(), {
      components: [{ type: 'CustomField', apiName: 'Account.Orphan__c', changeKind: 'added' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.accessParity).toBeUndefined();
  });

  it('omits the accessParity section when checkAccessParity is explicitly false', async () => {
    const r = await reviewChangeHandler(ctxA(), {
      components: [{ type: 'CustomField', apiName: 'Account.Orphan__c', changeKind: 'added' }],
      checkAccessParity: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.accessParity).toBeUndefined();
  });
});

describe('review_change access parity — grant resolution', () => {
  it('(a) an added custom field granted by a permission set is NOT flagged', async () => {
    const r = await reviewChangeHandler(ctxA(), {
      components: [{ type: 'CustomField', apiName: 'Account.Granted__c', changeKind: 'added' }],
      checkAccessParity: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ap = r.value.data.accessParity;
    expect(ap).toBeDefined();
    expect(ap?.shipsForNobody).toEqual([]);
    expect(ap?.explicitlyGranted).toBe(1);
    expect(ap?.checked).toBe(1);
  });

  it('(b) an added custom field with no grant is flagged "ships for nobody"', async () => {
    const r = await reviewChangeHandler(ctxA(), {
      components: [{ type: 'CustomField', apiName: 'Account.Orphan__c', changeKind: 'added' }],
      checkAccessParity: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ap = r.value.data.accessParity;
    expect(ap?.shipsForNobody.map((f) => f.id)).toEqual(['CustomField:Account.Orphan__c']);
    expect(ap?.shipsForNobody[0]?.reason).toMatch(/NOBODY|no modeled/i);
    expect(ap?.explicitlyGranted).toBe(0);
    expect(ap?.systemPermCovered).toBe(0);
  });

  it('(c) a STANDARD field is NOT flagged (default access)', async () => {
    const r = await reviewChangeHandler(ctxA(), {
      components: [{ type: 'CustomField', apiName: 'Account.Industry', changeKind: 'added' }],
      checkAccessParity: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ap = r.value.data.accessParity;
    expect(ap?.shipsForNobody).toEqual([]);
    expect(ap?.standardDefault).toBe(1);
  });

  it('(c) a custom field covered by a ModifyAllData holder is NOT flagged', async () => {
    const r = await reviewChangeHandler(ctxB(), {
      components: [{ type: 'CustomField', apiName: 'Account.AdminOnly__c', changeKind: 'added' }],
      checkAccessParity: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ap = r.value.data.accessParity;
    expect(ap?.shipsForNobody).toEqual([]);
    expect(ap?.systemPermCovered).toBe(1);
    expect(ap?.systemPermHolders.modifyAllData).toBe(1);
    expect(ap?.systemPermHolders.viewAllData).toBe(1);
  });

  it('objects: explicit-grant object NOT flagged, zero-grant object IS flagged', async () => {
    const r = await reviewChangeHandler(ctxA(), {
      components: [
        { type: 'CustomObject', apiName: 'Widget__c', changeKind: 'modified' },
        { type: 'CustomObject', apiName: 'Ghost__c', changeKind: 'added' },
      ],
      checkAccessParity: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ap = r.value.data.accessParity;
    expect(ap?.shipsForNobody.map((f) => f.id)).toEqual(['CustomObject:Ghost__c']);
    expect(ap?.explicitlyGranted).toBe(1); // Widget__c
    expect(ap?.checked).toBe(2);
  });
});

describe('review_change access parity — honesty axes', () => {
  it('stamps the verdict with the vault last-refresh time and declared confidence', async () => {
    const r = await reviewChangeHandler(ctxA(), {
      components: [{ type: 'CustomField', apiName: 'Account.Orphan__c', changeKind: 'added' }],
      checkAccessParity: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ap = r.value.data.accessParity;
    expect(ap?.stamp).toBe(REFRESHED_AT);
    expect(ap?.confidence).toBe('declared');
    expect(ap?.disclosure).toMatch(/ships for/i);
    expect(ap?.boundaries.length).toBeGreaterThanOrEqual(5);
    // "ships for everybody" is deferred to the live plane — disclosed.
    expect(ap?.boundaries.join(' ')).toMatch(/live_permset_holders/);
  });

  it('deleted fields and non-field/object components are OUT of scope', async () => {
    const r = await reviewChangeHandler(ctxA(), {
      components: [
        { type: 'CustomField', apiName: 'Account.Orphan__c', changeKind: 'deleted' },
        { type: 'ApexClass', apiName: 'SomeService', changeKind: 'added' },
      ],
      checkAccessParity: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ap = r.value.data.accessParity;
    expect(ap?.checked).toBe(0);
    expect(ap?.shipsForNobody).toEqual([]);
  });
});
