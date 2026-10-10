/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  orgRiskReportHandler,
  permissionRiskReportHandler,
} from '../../src/tools/synthesis-reports.js';

/**
 * ARCH-05. org_risk_report omitted guest-user exposure entirely and ranked
 * Salesforce-defined standard profiles (which carry god-mode by design) as
 * `critical` over-privilege ahead of everything else. All names synthetic.
 */
const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-07-10T00:00:00Z',
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

describe('org_risk_report — guest exposure and standard profiles (ARCH-05)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-org-risk-guest-'));
    const opened = await openGraph(join(dir, 'g.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          node({
            id: 'Network:HelpPortal',
            type: 'Network',
            apiName: 'HelpPortal',
            properties: { status: 'Live', site: 'HelpPortal', picassoSite: 'HelpPortal1' },
          }),
          node({
            id: 'CustomSite:HelpPortal',
            type: 'CustomSite',
            apiName: 'HelpPortal',
            label: 'HelpPortal',
            properties: { active: true, siteType: 'ChatterNetwork', masterLabel: 'HelpPortal', guestProfileName: 'HelpPortal Profile' },
          }),
          node({ id: 'Profile:HelpPortal Profile', type: 'Profile', apiName: 'HelpPortal Profile', properties: { userPermissions: [], custom: true } }),
          // A second site whose guest profile reaches the SAME object.
          node({
            id: 'Network:PartnerPortal',
            type: 'Network',
            apiName: 'PartnerPortal',
            properties: { status: 'Live', site: 'PartnerPortal', picassoSite: 'PartnerPortal1' },
          }),
          node({
            id: 'CustomSite:PartnerPortal',
            type: 'CustomSite',
            apiName: 'PartnerPortal',
            label: 'PartnerPortal',
            properties: { active: true, siteType: 'ChatterNetwork', masterLabel: 'PartnerPortal', guestProfileName: 'PartnerPortal Profile' },
          }),
          node({ id: 'Profile:PartnerPortal Profile', type: 'Profile', apiName: 'PartnerPortal Profile', properties: { userPermissions: [], custom: true } }),
          node({ id: 'CustomObject:Invoice__c', type: 'CustomObject', apiName: 'Invoice__c', properties: { sharingModel: 'Private' } }),
          node({ id: 'CustomField:Invoice__c.SSN__c', type: 'CustomField', apiName: 'SSN__c', parentId: 'CustomObject:Invoice__c', properties: { dataType: 'EncryptedText' } }),
          // A Salesforce-defined standard profile: god-mode by design.
          node({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin', properties: { userPermissions: ['ModifyAllData', 'ViewAllData'], custom: false } }),
          // A custom permission set granting the same: the actionable risk.
          node({ id: 'PermissionSet:Ops_Superuser', type: 'PermissionSet', apiName: 'Ops_Superuser', properties: { userPermissions: ['ModifyAllData', 'ViewAllData'] } }),
        ],
        edges: [
          edge({ fromId: 'Network:HelpPortal', toId: 'CustomSite:HelpPortal', edgeType: 'references', properties: { via: 'site' } }),
          edge({ fromId: 'CustomSite:HelpPortal', toId: 'Profile:HelpPortal Profile', edgeType: 'references', confidence: 'heuristic', properties: { via: 'guest-profile' } }),
          edge({ fromId: 'Profile:HelpPortal Profile', toId: 'CustomObject:Invoice__c', edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true } }),
          edge({ fromId: 'Profile:HelpPortal Profile', toId: 'CustomField:Invoice__c.SSN__c', edgeType: 'grantedBy', properties: { readable: true } }),
          edge({ fromId: 'Network:PartnerPortal', toId: 'CustomSite:PartnerPortal', edgeType: 'references', properties: { via: 'site' } }),
          edge({ fromId: 'CustomSite:PartnerPortal', toId: 'Profile:PartnerPortal Profile', edgeType: 'references', confidence: 'heuristic', properties: { via: 'guest-profile' } }),
          edge({ fromId: 'Profile:PartnerPortal Profile', toId: 'CustomObject:Invoice__c', edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true } }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: composes guest exposure into the ranked findings', async () => {
    const r = await orgRiskReportHandler(ctx, {});
    if (!r.ok) throw new Error(r.error.message);
    const guest = r.value.data.findings.find((f) => f.category === 'guest-exposure');
    expect(guest).toBeDefined();
    expect(guest?.severity).toBe('critical');
    expect(guest?.evidence.length).toBeGreaterThan(0);
  });

  it('FAIL-BEFORE/PASS-AFTER: guest-exposure evidence names each node once', async () => {
    // Several guest findings cite the same object (object read + field read
    // on it); the evidence list repeated it.
    const r = await orgRiskReportHandler(ctx, {});
    if (!r.ok) throw new Error(r.error.message);
    const guest = r.value.data.findings.find((f) => f.category === 'guest-exposure');
    const ev = guest?.evidence ?? [];
    expect(ev).toContain('CustomObject:Invoice__c');
    expect(new Set(ev).size).toBe(ev.length);
  });

  it('FAIL-BEFORE/PASS-AFTER: a standard profile ranks below a custom grantor of the same permissions', async () => {
    const r = await permissionRiskReportHandler(ctx, { limit: 20 });
    if (!r.ok) throw new Error(r.error.message);
    const op = r.value.data.findings.filter((f) => f.category === 'over-privilege');
    const stock = op.find((f) => f.evidence.includes('Profile:Admin'));
    const custom = op.find((f) => f.evidence.includes('PermissionSet:Ops_Superuser'));
    expect(custom?.severity).toBe('critical');
    expect(stock?.severity).toBe('medium');
    expect(stock?.summary).toMatch(/^Standard Profile Admin/);
    expect((custom?.rank ?? 99) < (stock?.rank ?? 0)).toBe(true);
    // Still rostered: the god-mode census is unchanged.
    expect(r.value.data.privilege.modifyAllDataGrantors).toContain('Profile:Admin');
  });
});
