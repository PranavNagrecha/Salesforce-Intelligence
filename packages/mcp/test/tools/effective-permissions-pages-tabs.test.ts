/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER:
 *  - ADM-11: "what does this permission set grant" left out Visualforce page
 *    access and tab visibility entirely (the extractor captures both), and
 *    reported `summary.recordTypeVisibilities: 0` for a container whose
 *    record-type data was never extracted — a 0 that reads as verified.
 *  - B07: with several groups the answer was only the flattened union; telling
 *    which group adds what took one get_edges call per group. `perContainer`
 *    now returns each container's own contribution and how it was reached.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  effectivePermissionsHandler,
  effectivePermissionsInputSchema,
} from '../../src/tools/effective-permissions.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
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

const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Notice__c', type: 'CustomObject', apiName: 'Notice__c' }),
    node({ id: 'CustomObject:Ledger__c', type: 'CustomObject', apiName: 'Ledger__c' }),
    node({
      id: 'PermissionSet:Portal_Access',
      type: 'PermissionSet',
      apiName: 'Portal_Access',
      properties: {
        pageGrantCount: 2,
        recordTypeVisibilities: [
          { recordType: 'Notice__c.Client', visible: true },
          { recordType: 'Ledger__c.Client', visible: true },
          { recordType: 'Ledger__c.Internal', visible: false },
        ],
        tabVisibilities: [
          { tab: 'Notice__c', visibility: 'Visible' },
          { tab: 'Ledger__c', visibility: 'None' },
        ],
      },
    }),
    // Built before record-type / tab extraction: no keys at all.
    node({ id: 'PermissionSet:Legacy_Set', type: 'PermissionSet', apiName: 'Legacy_Set' }),
    node({ id: 'PermissionSet:Worker_Base', type: 'PermissionSet', apiName: 'Worker_Base', properties: { pageGrantCount: 0, recordTypeVisibilities: [{ recordType: 'Ledger__c.Client', visible: true }], tabVisibilities: [] } }),
    node({ id: 'PermissionSet:Worker_Extra', type: 'PermissionSet', apiName: 'Worker_Extra', properties: { pageGrantCount: 0, recordTypeVisibilities: [{ recordType: 'Notice__c.Client', visible: true }, { recordType: 'Ledger__c.Internal', visible: true }], tabVisibilities: [] } }),
    node({ id: 'PermissionSetGroup:Worker_Group', type: 'PermissionSetGroup', apiName: 'Worker_Group', properties: { permissionSets: ['Worker_Base', 'Worker_Extra'] } }),
    node({ id: 'VisualforcePage:SelfRegister', type: 'VisualforcePage', apiName: 'SelfRegister' }),
    node({ id: 'VisualforcePage:Landing', type: 'VisualforcePage', apiName: 'Landing' }),
  ],
  edges: [
    edge({ fromId: 'PermissionSet:Portal_Access', toId: 'VisualforcePage:SelfRegister', edgeType: 'grantedBy', properties: { enabled: true } }),
    edge({ fromId: 'PermissionSet:Portal_Access', toId: 'VisualforcePage:Landing', edgeType: 'grantedBy', properties: { enabled: true } }),
    edge({ fromId: 'PermissionSet:Worker_Base', toId: 'CustomObject:Notice__c', edgeType: 'grantedBy', properties: { allowRead: true } }),
    edge({ fromId: 'PermissionSet:Worker_Extra', toId: 'CustomObject:Notice__c', edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true, allowDelete: true } }),
    edge({ fromId: 'PermissionSetGroup:Worker_Group', toId: 'PermissionSet:Worker_Base', edgeType: 'references' }),
    edge({ fromId: 'PermissionSetGroup:Worker_Group', toId: 'PermissionSet:Worker_Extra', edgeType: 'references' }),
  ],
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-effective-pages-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

const run = async (args: Record<string, unknown>) => {
  const r = await effectivePermissionsHandler(ctx, effectivePermissionsInputSchema.parse(args));
  if (!r.ok) throw new Error(r.error.message);
  return r.value.data;
};

describe('effective_permissions — pages, tabs, record types (ADM-11)', () => {
  it('lists Visualforce pages and visible tabs, and counts record-type visibilities', async () => {
    const d = await run({ permissionSetIds: ['PermissionSet:Portal_Access'] });
    expect(d.visualforcePages).toEqual(['Landing', 'SelfRegister']);
    expect(d.summary.visualforcePages).toBe(2);
    expect(d.tabs).toEqual([{ tab: 'Notice__c', visibility: 'Visible' }]);
    expect(d.summary.tabs).toBe(1);
    expect(d.summary.recordTypeVisibilities).toBe(3);
  });

  // FAIL-BEFORE/PASS-AFTER (second review): an unconditional disclosure said tab
  // visibility is "not part of this permission union" while the same response
  // returns `tabs` and calls them "the declared union". One story now.
  it('never says tab visibility is outside the union it returns', async () => {
    const d = await run({ permissionSetIds: ['PermissionSet:Portal_Access'] });
    const text = d.disclosures.join(' ');
    expect(text).not.toMatch(/tab visibility are a separate surface/i);
    expect(text).toMatch(/App visibility is a separate surface/);
  });

  it('reports null, not 0, when no container carries record-type or tab data', async () => {
    const d = await run({ permissionSetIds: ['PermissionSet:Legacy_Set'] });
    expect(d.summary.recordTypeVisibilities).toBeNull();
    expect(d.summary.tabs).toBeNull();
  });
});

describe('effective_permissions — perContainer breakdown (B07)', () => {
  it('names what each group member adds and how it was reached', async () => {
    const d = await run({
      permissionSetIds: ['PermissionSetGroup:Worker_Group'],
      objectApiName: 'Notice__c',
      perContainer: true,
    });
    const by = new Map((d.perContainer ?? []).map((c) => [c.containerId, c]));
    expect(by.get('PermissionSet:Worker_Base')?.reachedVia).toEqual(['PermissionSetGroup:Worker_Group']);
    expect(by.get('PermissionSet:Worker_Base')?.objectPermissions?.['Notice__c']?.allowDelete).toBe(false);
    expect(by.get('PermissionSet:Worker_Extra')?.objectPermissions?.['Notice__c']?.allowDelete).toBe(true);
  });

  it('is absent unless asked for', async () => {
    const d = await run({ permissionSetIds: ['PermissionSetGroup:Worker_Group'] });
    expect(d.perContainer).toBeUndefined();
  });
});

// FAIL-BEFORE/PASS-AFTER (review): `summary.visualforcePages` was always a
// number, so a container built before page grants were extracted (no
// `pageGrantCount`) reported 0 pages with no disclosure — beside a `null`
// tabs / record-type count for the very same container. And `perContainer`
// narrowed objects and FLS to the scoped object but counted record types
// across every object.
describe('effective_permissions — unchecked pages are null, per-container record types are scoped', () => {
  it('reports null pages and discloses it for a container built before page-grant extraction', async () => {
    const d = await run({ permissionSetIds: ['PermissionSet:Legacy_Set'] });
    expect(d.summary.visualforcePages).toBeNull();
    const text = d.disclosures.join(' ');
    expect(text).toMatch(/Visualforce page access was NOT checked.*pageGrantCount.*PermissionSet:Legacy_Set/);
    expect(text).toMatch(/Tab visibility was NOT checked/);
  });

  it('keeps a checked zero as 0 and names only the unchecked container in a mixed bundle', async () => {
    const d = await run({ permissionSetIds: ['PermissionSet:Worker_Base', 'PermissionSet:Legacy_Set'], perContainer: true });
    expect(d.summary.visualforcePages).toBe(0);
    const by = new Map((d.perContainer ?? []).map((c) => [c.containerId, c]));
    expect(by.get('PermissionSet:Worker_Base')?.visualforcePages).toBe(0);
    expect(by.get('PermissionSet:Legacy_Set')?.visualforcePages).toBeNull();
  });

  it('scopes each container\'s record-type count to the asked object, like the summary', async () => {
    const d = await run({
      permissionSetIds: ['PermissionSetGroup:Worker_Group'],
      objectApiName: 'Notice__c',
      perContainer: true,
    });
    const by = new Map((d.perContainer ?? []).map((c) => [c.containerId, c]));
    expect(by.get('PermissionSet:Worker_Base')?.recordTypeVisibilities).toBe(0);
    expect(by.get('PermissionSet:Worker_Extra')?.recordTypeVisibilities).toBe(1);
    expect(d.summary.recordTypeVisibilities).toBe(1);
  });
});
