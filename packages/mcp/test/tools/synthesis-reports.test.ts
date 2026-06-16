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
  fieldCleanupCandidatesHandler,
  orgRiskReportHandler,
  permissionRiskReportHandler,
  releaseReadinessReportHandler,
} from '../../src/tools/synthesis-reports.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00.000Z',
  sourceOrg: 'synthesis-test',
  components: { CustomObject: 1 },
  edges: {},
  sourceTreeHash: 'sha256:synthesis-fixture',
  coverageComputedAt: '2026-05-29T00:00:00.000Z',
  coverage: [
    {
      type: 'CustomObject',
      requested: true,
      retrieved: 1,
      errored: false,
      neverModeled: false,
    },
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-synthesis-'));
  const opened = await openGraph(join(tempDir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('orgRiskReportHandler (R7)', () => {
  it('returns ranked findings with trust and disclosure', async () => {
    const r = await orgRiskReportHandler(ctx, { limit: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { findings, trust, disclosure } = r.value.data;
    expect(trust.provenance).toBe('offline_snapshot');
    expect(disclosure.length).toBeGreaterThan(0);
    expect(findings.length).toBeGreaterThan(0);
    for (let i = 1; i < findings.length; i += 1) {
      expect(findings[i]?.rank).toBeGreaterThanOrEqual(findings[i - 1]?.rank ?? 0);
    }
    for (const f of findings) {
      expect(f.summary.length).toBeGreaterThan(0);
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(['critical', 'high', 'medium', 'low']).toContain(f.severity);
    }
  });

  it('is deterministic across two calls', async () => {
    const a = await orgRiskReportHandler(ctx, { limit: 5 });
    const b = await orgRiskReportHandler(ctx, { limit: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('composes permission-risk and PII exposure — not only tech debt', async () => {
    const r = await orgRiskReportHandler(ctx, { limit: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const categories = new Set(r.value.data.findings.map((f) => f.category));
    expect(categories.has('tech-debt')).toBe(true);
    expect(r.value.data.techDebt).not.toBeNull();
    expect(r.value.data.permissionRisk).not.toBeNull();
    expect(r.value.data.piiExposure).not.toBeNull();
  });
});

describe('releaseReadinessReportHandler — coverage gating', () => {
  it('does NOT block readiness on never-modeled families (product limitation, not actionable)', async () => {
    // Regression: `ready` was permanently false for EVERY vault because the 5
    // always-unmodeled families (ListView etc.) made coverage.status 'partial'
    // and the gate blocked on `status !== complete`.
    const neverModeledManifest: VaultManifest = {
      ...MANIFEST,
      coverage: [
        { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false },
        { type: 'ListView', requested: true, retrieved: 5, errored: false, neverModeled: true },
      ],
    };
    const r = await releaseReadinessReportHandler(
      { ...ctx, manifest: neverModeledManifest },
      { limit: 10 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.blockers.some((b) => b.includes('ListView'))).toBe(false);
    // ...but the not-modeled scope is still disclosed honestly via trust.
    expect(r.value.data.trust.completeness?.missingCoverage).toContain('ListView');
  });

  it('DOES block readiness on an actionable gap (a requested type that errored)', async () => {
    const erroredManifest: VaultManifest = {
      ...MANIFEST,
      coverage: [
        { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false },
        { type: 'Flow', requested: true, retrieved: 0, errored: true, neverModeled: false },
      ],
    };
    const r = await releaseReadinessReportHandler(
      { ...ctx, manifest: erroredManifest },
      { limit: 10 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.ready).toBe(false);
    expect(r.value.data.blockers.some((b) => b.includes('Flow'))).toBe(true);
  });
});

describe('permissionRiskReportHandler — over-privilege / god-mode (admin analysis)', () => {
  let opDir: string;
  let opStore: GraphStore;
  let opCtx: Context;

  const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
    type: 'Profile',
    apiName: 'Anon',
    label: null,
    parentId: null,
    sourcePath: 'x',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
    ...o,
  });
  const makeEdge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>): Edge => ({
    edgeType: 'grantedBy',
    confidence: 'declared',
    source: 'unit-test',
    properties: {},
    ...o,
  });

  beforeAll(async () => {
    opDir = mkdtempSync(join(tmpdir(), 'sfi-synth-op-'));
    const opened = await openGraph(join(opDir, 'op.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    opStore = opened.value;
    const imp = await importExtractionResults(opStore, [
      {
        nodes: [
          makeNode({
            id: 'Profile:GodAdmin',
            apiName: 'GodAdmin',
            properties: {
              // ApiEnabled is intentionally NOT a flagged system perm.
              userPermissions: [
                'ModifyAllData',
                'ViewAllData',
                'AuthorApex',
                'ApiEnabled',
              ],
            },
          }),
          makeNode({
            id: 'PermissionSet:Benign',
            type: 'PermissionSet',
            apiName: 'Benign',
            properties: { userPermissions: ['ApiEnabled'] },
          }),
          makeNode({
            id: 'CustomObject:Account',
            type: 'CustomObject',
            apiName: 'Account',
          }),
          makeNode({
            id: 'CustomObject:Contact',
            type: 'CustomObject',
            apiName: 'Contact',
          }),
        ],
        edges: [
          makeEdge({
            fromId: 'Profile:GodAdmin',
            toId: 'CustomObject:Account',
            properties: { allowRead: true, modifyAllRecords: true },
          }),
          makeEdge({
            fromId: 'Profile:GodAdmin',
            toId: 'CustomObject:Contact',
            properties: { allowRead: true, viewAllRecords: true },
          }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    opCtx = { vaultRoot: opDir, manifest: MANIFEST, graph: opStore };
  });

  afterAll(async () => {
    await closeGraph(opStore);
    rmSync(opDir, { recursive: true, force: true });
  });

  it('rosters the ModifyAllData / ViewAllData (god-mode) grantors', async () => {
    const r = await permissionRiskReportHandler(opCtx, { limit: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value.data.privilege;
    expect(p.modifyAllDataGrantors).toEqual(['Profile:GodAdmin']);
    expect(p.viewAllDataGrantors).toEqual(['Profile:GodAdmin']);
    // Benign (ApiEnabled only, no object escalation) is NOT over-privileged.
    expect(p.overPrivilegedGrantorCount).toBe(1);
    expect(p.scanned.profiles).toBe(1);
    expect(p.scanned.permissionSets).toBe(1);
  });

  it('emits one aggregated critical finding with system perms + object escalation', async () => {
    const r = await permissionRiskReportHandler(opCtx, { limit: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const op = r.value.data.findings.find(
      (f) => f.category === 'over-privilege',
    );
    expect(op?.severity).toBe('critical');
    expect(op?.summary).toContain('ModifyAllData');
    expect(op?.summary).toContain('ViewAllData');
    expect(op?.summary).toContain('AuthorApex');
    expect(op?.summary).not.toContain('ApiEnabled');
    expect(op?.summary).toContain('Modify All on 1 object(s)');
    expect(op?.summary).toContain('View All on 1 object(s)');
    expect(op?.evidence).toContain('Profile:GodAdmin');
  });
});

describe('permissionRiskReportHandler — Permission Set Group god-mode (effective via members)', () => {
  let psgDir: string;
  let psgStore: GraphStore;
  let psgCtx: Context;

  const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
    type: 'PermissionSet',
    apiName: 'Anon',
    label: null,
    parentId: null,
    sourcePath: 'x',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
    ...o,
  });

  beforeAll(async () => {
    psgDir = mkdtempSync(join(tmpdir(), 'sfi-synth-psg-'));
    const opened = await openGraph(join(psgDir, 'psg.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    psgStore = opened.value;
    const imp = await importExtractionResults(psgStore, [
      {
        nodes: [
          makeNode({
            id: 'PermissionSet:God_PS',
            apiName: 'God_PS',
            properties: { userPermissions: ['ModifyAllData'] },
          }),
          makeNode({
            id: 'PermissionSetGroup:GodGroup',
            type: 'PermissionSetGroup',
            apiName: 'GodGroup',
            properties: {
              permissionSets: ['God_PS'],
              mutingPermissionSets: ['Mute_PS'],
            },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    psgCtx = { vaultRoot: psgDir, manifest: MANIFEST, graph: psgStore };
  });

  afterAll(async () => {
    await closeGraph(psgStore);
    rmSync(psgDir, { recursive: true, force: true });
  });

  it('rosters a PSG as a ModifyAllData grantor via its member permission set', async () => {
    const r = await permissionRiskReportHandler(psgCtx, { limit: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value.data.privilege;
    // Both the direct permset AND the group that contains it confer ModifyAllData.
    expect(p.modifyAllDataGrantors).toContain('PermissionSet:God_PS');
    expect(p.modifyAllDataGrantors).toContain('PermissionSetGroup:GodGroup');
    expect(p.scanned.permissionSetGroups).toBe(1);
  });

  it('emits a critical PSG finding noting the membership + the muting caveat', async () => {
    const r = await permissionRiskReportHandler(psgCtx, { limit: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const psgFinding = r.value.data.findings.find((f) =>
      f.summary.startsWith('PermissionSetGroup GodGroup'),
    );
    expect(psgFinding?.severity).toBe('critical');
    expect(psgFinding?.summary).toContain('ModifyAllData');
    expect(psgFinding?.summary).toContain('member permission set');
    expect(psgFinding?.summary).toContain('muting permission set');
    expect(psgFinding?.evidence).toContain('PermissionSet:God_PS');
  });
});

describe('fieldCleanupCandidatesHandler — byte budget (oversize fix)', () => {
  let s: GraphStore;
  let dir: string;
  let localCtx: Context;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-cleanup-'));
    const opened = await openGraph(join(dir, 'g.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    s = opened.value;
    const node = (id: string, type: Node['type'], properties = {}): Node => ({
      id, type, apiName: id.split(':')[1] ?? id, label: null, parentId: null,
      sourcePath: 'x', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties,
    });
    const obj = 'CustomObject:Big_Cleanup_Object__c';
    const nodes: Node[] = [node(obj, 'CustomObject')];
    const edges: Edge[] = [];
    // 120 custom fields whose only edge is parentOf → all flagged unused → a
    // large `fields` payload that must be byte-trimmed. apiName is the FIELD api
    // name (not Object.Field) and parentId is the object, matching the extractor.
    for (let i = 0; i < 120; i++) {
      const fieldApi = `Very_Long_Unused_Custom_Field_For_Oversize_${i}__c`;
      const fid = `CustomField:Big_Cleanup_Object__c.${fieldApi}`;
      nodes.push({
        ...node(fid, 'CustomField', { dataType: 'Text' }),
        apiName: fieldApi,
        parentId: obj,
      });
      edges.push({ fromId: obj, toId: fid, edgeType: 'parentOf', confidence: 'declared', source: 'test', properties: {} });
    }
    // A field used only by a report column carries the folded `usedInReport`
    // property. It must be EXCLUDED from cleanup candidates (the handler
    // delegates to unused_fields_deep's exclusion) even though its only edge is
    // parentOf — so it can never be byte-trimmed in or out, it is simply absent.
    const reportFieldApi = 'Report_Backed_Field__c';
    const reportFid = `CustomField:Big_Cleanup_Object__c.${reportFieldApi}`;
    nodes.push({
      ...node(reportFid, 'CustomField', { dataType: 'Text', usedInReport: true }),
      apiName: reportFieldApi,
      parentId: obj,
    });
    edges.push({ fromId: obj, toId: reportFid, edgeType: 'parentOf', confidence: 'declared', source: 'test', properties: {} });
    const imp = await importExtractionResults(s, [{ nodes, edges }]);
    if (!imp.ok) throw new Error(imp.error.message);
    localCtx = { vaultRoot: dir, manifest: MANIFEST, graph: s };
  });
  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('trims findings+fields together to fit the response guard and sets a note', async () => {
    const r = await fieldCleanupCandidatesHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(Buffer.byteLength(JSON.stringify(d), 'utf8')).toBeLessThanOrEqual(45_000);
    expect(d.fields.length).toBeGreaterThan(0);
    expect(d.findings.length).toBe(d.fields.length); // parallel
    expect(typeof d.note).toBe('string'); // trimmed → note present
  });

  it('excludes report/dashboard-used fields and discloses the --with-reports caveat', async () => {
    const r = await fieldCleanupCandidatesHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The cleanup list is an absence-of-usage set; the caveat keeps it from
    // being mistaken for a safe-to-delete set when the vault lacks reports.
    expect(d.disclosure).toContain('--with-reports');
    // The report-backed field is in use → never a cleanup candidate.
    expect(
      d.fields.some(
        (f) => f.id === 'CustomField:Big_Cleanup_Object__c.Report_Backed_Field__c',
      ),
    ).toBe(false);
  });

  it('FLD-01: objectId (canonical) narrows results to that object only', async () => {
    const r = await fieldCleanupCandidatesHandler(localCtx, {
      objectId: 'CustomObject:Big_Cleanup_Object__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // All returned fields must belong to Big_Cleanup_Object__c.
    expect(d.fields.every((f) => f.parentObjectApiName === 'Big_Cleanup_Object__c')).toBe(true);
  });

  it('FLD-01: objectId (bare api name) narrows results identically to canonical form', async () => {
    const byCanonical = await fieldCleanupCandidatesHandler(localCtx, {
      objectId: 'CustomObject:Big_Cleanup_Object__c',
    });
    const byBare = await fieldCleanupCandidatesHandler(localCtx, {
      objectId: 'Big_Cleanup_Object__c',
    });
    expect(byCanonical.ok).toBe(true);
    expect(byBare.ok).toBe(true);
    if (!byCanonical.ok || !byBare.ok) return;
    expect(byCanonical.value.data.fields.map((f) => f.id).sort()).toEqual(
      byBare.value.data.fields.map((f) => f.id).sort(),
    );
  });

  it('FLD-01: objectApiName synonym narrows results identically to objectId', async () => {
    const byObjectId = await fieldCleanupCandidatesHandler(localCtx, {
      objectId: 'Big_Cleanup_Object__c',
    });
    const byApiName = await fieldCleanupCandidatesHandler(localCtx, {
      objectApiName: 'Big_Cleanup_Object__c',
    });
    expect(byObjectId.ok).toBe(true);
    expect(byApiName.ok).toBe(true);
    if (!byObjectId.ok || !byApiName.ok) return;
    expect(byObjectId.value.data.fields.map((f) => f.id).sort()).toEqual(
      byApiName.value.data.fields.map((f) => f.id).sort(),
    );
  });
});
