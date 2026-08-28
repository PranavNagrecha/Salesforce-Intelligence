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
  automationRiskReportHandler,
  fieldCleanupCandidatesHandler,
  FINDINGS_LIMIT_MAX,
  orgRiskReportHandler,
  permissionRiskReportHandler,
  permissionRiskReportInputSchema,
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

describe('permissionRiskReportHandler — profileFilter honesty (false-premise disclosure)', () => {
  let pfDir: string;
  let pfStore: GraphStore;
  let pfCtx: Context;

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

  beforeAll(async () => {
    pfDir = mkdtempSync(join(tmpdir(), 'sfi-synth-pf-'));
    const opened = await openGraph(join(pfDir, 'pf.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    pfStore = opened.value;
    const imp = await importExtractionResults(pfStore, [
      {
        nodes: [
          // The org has a community login profile but NO integration-user
          // profile — so a request for "AcmeCo_Integration_User" is a FALSE
          // premise: the closest existing profile is the community login one.
          makeNode({
            id: 'Profile:AcmeCo_Community_Login_User',
            apiName: 'AcmeCo_Community_Login_User',
            label: 'AcmeCo Community Login User',
            properties: { userPermissions: ['ApiEnabled'] },
          }),
          makeNode({
            id: 'Profile:AcmeCo_Admin',
            apiName: 'AcmeCo_Admin',
            label: 'AcmeCo Admin',
            properties: { userPermissions: ['ModifyAllData', 'ViewAllData'] },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    pfCtx = { vaultRoot: pfDir, manifest: MANIFEST, graph: pfStore };
  });

  afterAll(async () => {
    await closeGraph(pfStore);
    rmSync(pfDir, { recursive: true, force: true });
  });

  it('STOPS with a profile-not-found result for a nonexistent profile (does NOT dump the org-wide report)', async () => {
    const r = await permissionRiskReportHandler(pfCtx, {
      profileFilter: 'AcmeCo_Integration_User',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    // The premise is false → no findings, no full-org dump.
    expect(data.findings).toEqual([]);
    expect(data.privilege.modifyAllDataGrantors).toEqual([]);
    expect(data.privilege.viewAllDataGrantors).toEqual([]);
    expect(data.privilege.overPrivilegedGrantorCount).toBe(0);
    // The filter is echoed honestly with found:false + the closest match.
    expect(data.profileFilter).toBeDefined();
    expect(data.profileFilter?.found).toBe(false);
    expect(data.profileFilter?.requested).toBe('AcmeCo_Integration_User');
    expect(data.profileFilter?.resolvedId).toBeNull();
    expect(data.profileFilter?.closestMatch).toBe('AcmeCo Community Login User');
    expect(data.profileFilter?.caveat).toContain('AcmeCo_Integration_User');
    expect(data.profileFilter?.caveat.toLowerCase()).toContain('premise is false');
    expect(data.disclosure).toContain('AcmeCo Community Login User');
  });

  it('SCOPES the report to the requested profile when it DOES exist', async () => {
    const r = await permissionRiskReportHandler(pfCtx, {
      profileFilter: 'AcmeCo_Admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect(data.profileFilter?.found).toBe(true);
    expect(data.profileFilter?.resolvedId).toBe('Profile:AcmeCo_Admin');
    // Scoped to ONLY the admin profile — the community profile is not analysed.
    expect(data.privilege.scanned.profiles).toBe(1);
    expect(data.privilege.modifyAllDataGrantors).toEqual(['Profile:AcmeCo_Admin']);
    expect(data.privilege.viewAllDataGrantors).toEqual(['Profile:AcmeCo_Admin']);
    expect(data.findings.length).toBe(1);
    expect(data.findings[0]?.summary).toContain('AcmeCo_Admin');
  });

  it('resolves an exact match by label and by canonical Profile: id', async () => {
    const byLabel = await permissionRiskReportHandler(pfCtx, {
      profileFilter: 'AcmeCo Admin',
    });
    const byId = await permissionRiskReportHandler(pfCtx, {
      profileFilter: 'Profile:AcmeCo_Admin',
    });
    expect(byLabel.ok && byId.ok).toBe(true);
    if (!byLabel.ok || !byId.ok) return;
    expect(byLabel.value.data.profileFilter?.found).toBe(true);
    expect(byId.value.data.profileFilter?.found).toBe(true);
    expect(byId.value.data.profileFilter?.resolvedId).toBe('Profile:AcmeCo_Admin');
  });

  it('omits the profileFilter block entirely when no filter is passed (org-wide report)', async () => {
    const r = await permissionRiskReportHandler(pfCtx, { limit: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.profileFilter).toBeUndefined();
    // Org-wide scan sees BOTH profiles.
    expect(r.value.data.privilege.scanned.profiles).toBe(2);
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

// Perf regression guard: the org-wide over-privilege scan reads each Profile /
// PermissionSet's OUTGOING grantedBy edges. It MUST fetch them in ONE batched
// `listEdgesForNodes` round-trip, NOT an N+1 `listEdges`-per-node loop — that
// N+1 (one DuckDB round-trip per permission container) was the residual cost
// that kept org_risk_report / release_readiness_report over the 60s MCP client
// timeout after the first perf fix (d7a3b8f) batched the sibling hygiene tools.
describe('permissionRiskReportHandler — batched grantedBy scan (no N+1)', () => {
  const PROFILE_COUNT = 60;
  let perfDir: string;
  let perfStore: GraphStore;
  let perfCtx: Context;

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
    perfDir = mkdtempSync(join(tmpdir(), 'sfi-synth-perf-'));
    const opened = await openGraph(join(perfDir, 'perf.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    perfStore = opened.value;
    // One shared object each profile has object-level Modify All over — an
    // object-escalation finding with NO god-mode system perm (so the god-mode
    // roster / active-holder facts path stays empty and can't add edge queries).
    const nodes: Node[] = [
      makeNode({ id: 'CustomObject:Perf__c', type: 'CustomObject', apiName: 'Perf__c' }),
    ];
    const edges: Edge[] = [];
    for (let i = 0; i < PROFILE_COUNT; i += 1) {
      nodes.push(
        makeNode({ id: `Profile:Perf${i}`, apiName: `Perf${i}` }),
      );
      edges.push(
        makeEdge({
          fromId: `Profile:Perf${i}`,
          toId: 'CustomObject:Perf__c',
          properties: { allowRead: true, modifyAllRecords: true },
        }),
      );
    }
    const imp = await importExtractionResults(perfStore, [{ nodes, edges }]);
    if (!imp.ok) throw new Error(imp.error.message);
    perfCtx = { vaultRoot: perfDir, manifest: MANIFEST, graph: perfStore };
  });

  afterAll(async () => {
    await closeGraph(perfStore);
    rmSync(perfDir, { recursive: true, force: true });
  });

  it('issues a bounded number of edge queries regardless of container count', async () => {
    const spy = vi.spyOn(perfStore.connection, 'runAndReadAll');
    const r = await permissionRiskReportHandler(perfCtx, { limit: 500 });
    const edgeQueries = spy.mock.calls.filter(([sql]) =>
      String(sql).includes('FROM edges'),
    ).length;
    spy.mockRestore();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Every profile was scanned (proves the ONE batch covered them all).
    expect(r.value.data.privilege.overPrivilegedGrantorCount).toBe(PROFILE_COUNT);
    expect(r.value.data.privilege.scanned.profiles).toBe(PROFILE_COUNT);
    // ONE batched listEdgesForNodes for the whole grantedBy scan — not one per
    // container. An N+1 would be ~PROFILE_COUNT edge queries.
    expect(edgeQueries).toBeLessThanOrEqual(2);
  });
});

// AUTOMATION-RISK-REPORT-IGNORES-OBJECT-SCOPE: an object scope narrows the
// legacy-automation half to Process Builders parented to that object, excludes
// the org-wide Apex governor-limit half (disclosed), and echoes appliedScope;
// an object absent from the vault is refused with invalid-query.
describe('automationRiskReportHandler — object scope (AUTOMATION-RISK-REPORT-IGNORES-OBJECT-SCOPE)', () => {
  let arDir: string;
  let arStore: GraphStore;
  let arCtx: Context;

  const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
    type: 'Flow',
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
    arDir = mkdtempSync(join(tmpdir(), 'sfi-synth-ar-'));
    const opened = await openGraph(join(arDir, 'ar.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    arStore = opened.value;
    const nodes: Node[] = [
      makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
      makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
      // A Process Builder (Flow processType Workflow) parented to Account — the
      // object-attributable legacy-automation finding.
      makeNode({
        id: 'Flow:Account_PB',
        type: 'Flow',
        apiName: 'Account_PB',
        parentId: 'CustomObject:Account',
        properties: { processType: 'Workflow', active: true, decisionCount: 1, actionCount: 1 },
      }),
      // A governor-limit Apex class — NOT attributable to a single object; it
      // fuels the org-wide bare report and is excluded under any object scope.
      makeNode({
        id: 'ApexClass:GovHeavy',
        type: 'ApexClass',
        apiName: 'GovHeavy',
        properties: {
          qualityIssues: [
            {
              rule: 'soql-in-loop',
              severity: 'high',
              location: 'GovHeavy.cls:10',
              explanation: 'SOQL inside a loop risks the 100-query governor limit.',
            },
          ],
        },
      }),
    ];
    const imp = await importExtractionResults(arStore, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error(imp.error.message);
    arCtx = { vaultRoot: arDir, manifest: MANIFEST, graph: arStore };
  });

  afterAll(async () => {
    await closeGraph(arStore);
    rmSync(arDir, { recursive: true, force: true });
  });

  it('BARE CALL: org-wide report has governor findings and NO appliedScope', async () => {
    const r = await automationRiskReportHandler(arCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('appliedScope' in r.value.data).toBe(false);
    expect(r.value.data.governorClasses).not.toBeNull();
    const categories = r.value.data.findings.map((f) => f.category);
    expect(categories).toContain('governor-limit');
    expect(categories).toContain('legacy-automation');
  });

  it('HONOR: object scope narrows to legacy automation on that object, drops governor, emits appliedScope + disclosure', async () => {
    const r = await automationRiskReportHandler(arCtx, { objectApiName: 'Account' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({ object: 'CustomObject:Account', mode: 'component' });
    // Governor (Apex) half excluded under scope.
    expect(r.value.data.governorClasses).toBeNull();
    const categories = r.value.data.findings.map((f) => f.category);
    expect(categories).not.toContain('governor-limit');
    // The Account Process Builder survives as a legacy-automation finding.
    expect(r.value.data.findings.some((f) => f.summary.includes('Flow:Account_PB'))).toBe(true);
    expect(r.value.data.disclosure).toMatch(/governor-limit findings live in apex classes/i);
    expect(r.value.data.disclosure).toMatch(/excluded/i);
  });

  it('NARROWS DIFFERENTLY per object — Account (has PB) ≠ Contact (none) ≠ bare', async () => {
    const [acct, contact, bare] = await Promise.all([
      automationRiskReportHandler(arCtx, { objectApiName: 'Account' }),
      automationRiskReportHandler(arCtx, { objectApiName: 'Contact' }),
      automationRiskReportHandler(arCtx, {}),
    ]);
    expect(acct.ok && contact.ok && bare.ok).toBe(true);
    if (!acct.ok || !contact.ok || !bare.ok) return;
    // Contact has no automation — scoped findings empty; Account has the PB.
    expect(contact.value.data.findings).toEqual([]);
    expect(acct.value.data.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(acct.value.data.findings)).not.toBe(
      JSON.stringify(bare.value.data.findings),
    );
  });

  it('REFUSE: an object absent from the vault → named invalid-query (never org-wide)', async () => {
    const r = await automationRiskReportHandler(arCtx, { objectApiName: 'NoSuchObject__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/no object named 'NoSuchObject__c'/i);
  });
});

// =============================================================================
// FIX 9 — automation_risk_report must say what it composed and what it did not.
//
// (1) `composedFrom` is an UNCONDITIONAL manifest. The silent-failure bug it
//     closes: `if (pb.ok)` / `if (gov.ok)` meant a FAILED sub-handler
//     contributed nothing and SAID nothing, so it was indistinguishable from a
//     clean zero. A failed row carries `findingCount: null`, never `0`.
// (2) `notChecked` + the verbatim "this report composes TWO analyses" boundary
//     are UNCONDITIONAL, so a zero here can never be read as a zero for the
//     automation layer.
// =============================================================================

describe('automationRiskReportHandler — FIX 9 composition manifest', () => {
  const fixNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
    type: 'Flow',
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

  /** An ApexClass carrying a static governor-limit finding, no Process Builders. */
  const GOV_ONLY_NODES: Node[] = [
    fixNode({
      id: 'ApexClass:LedgerBatchService',
      type: 'ApexClass',
      apiName: 'LedgerBatchService',
      properties: {
        qualityIssues: [
          {
            rule: 'soql-in-loop',
            severity: 'high',
            location: 'LedgerBatchService.cls:22',
            explanation: 'SOQL inside a loop risks the 100-query governor limit.',
          },
        ],
      },
    }),
  ];

  /** A Process Builder and nothing else — the mirror-image degeneration. */
  const PB_ONLY_NODES: Node[] = [
    fixNode({ id: 'CustomObject:Widget__c', type: 'CustomObject', apiName: 'Widget__c' }),
    fixNode({
      id: 'Flow:Widget_Intake_PB',
      type: 'Flow',
      apiName: 'Widget_Intake_PB',
      parentId: 'CustomObject:Widget__c',
      properties: { processType: 'Workflow', active: true, decisionCount: 1, actionCount: 1 },
    }),
  ];

  const dirs: string[] = [];
  const stores: GraphStore[] = [];

  const seedCtx = async (nodes: Node[]): Promise<Context> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-synth-fix9-'));
    dirs.push(dir);
    const opened = await openGraph(join(dir, 'fix9.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    stores.push(opened.value);
    const imp = await importExtractionResults(opened.value, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error(imp.error.message);
    return { vaultRoot: dir, manifest: MANIFEST, graph: opened.value };
  };

  let govOnlyCtx: Context;
  let pbOnlyCtx: Context;
  let emptyCtx: Context;

  /**
   * A graph whose every read throws — the case that could NOT be expressed
   * before: a sub-handler that failed rather than found nothing.
   */
  const brokenCtx: Context = {
    vaultRoot: '/nonexistent',
    manifest: MANIFEST,
    graph: {
      connection: {
        runAndReadAll: () => {
          throw new Error('fixture: graph read failed');
        },
        run: () => {
          throw new Error('fixture: graph read failed');
        },
      },
      instance: {},
    } as unknown as GraphStore,
  };

  beforeAll(async () => {
    govOnlyCtx = await seedCtx(GOV_ONLY_NODES);
    pbOnlyCtx = await seedCtx(PB_ONLY_NODES);
    emptyCtx = await seedCtx([]);
  });

  afterAll(async () => {
    for (const s of stores) await closeGraph(s);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('names a CHECKED zero from the half that ran and found nothing, and names the degeneration', async () => {
    // FAIL-BEFORE: `if (pb.ok)` produced no row at all — a 0-Process-Builder
    // org was byte-identical to one whose PB analysis had errored, and the
    // report never said every finding came from one composed tool.
    const r = await automationRiskReportHandler(govOnlyCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    const pbRow = d.composedFrom?.find(
      (c) => c.analysis === 'sfi.process_builder_migration_candidates',
    );
    const govRow = d.composedFrom?.find(
      (c) => c.analysis === 'sfi.governor_limit_risks',
    );
    expect(pbRow?.status).toBe('ran');
    expect(pbRow?.findingCount).toBe(0);
    expect(pbRow?.note).toBe(
      'This org has 0 Process Builders. That is a CHECKED zero, not a skipped check.',
    );
    expect(govRow?.status).toBe('ran');
    expect(govRow?.findingCount).toBeGreaterThan(0);
    expect(govRow?.note).toBeUndefined();
    expect(d.boundaries).toContain(
      'Every finding in this report came from a single composed analysis (sfi.governor_limit_risks) — the other contributed 0. This report is not adding synthesis over that tool for this org; run it directly for its full options.',
    );
  });

  it('names the degeneration the other way round when only the legacy half contributes', async () => {
    const r = await automationRiskReportHandler(pbOnlyCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(
      d.composedFrom?.find((c) => c.analysis === 'sfi.governor_limit_risks')
        ?.findingCount,
    ).toBe(0);
    expect(d.boundaries).toContain(
      'Every finding in this report came from a single composed analysis (sfi.process_builder_migration_candidates) — the other contributed 0. This report is not adding synthesis over that tool for this org; run it directly for its full options.',
    );
  });

  it('a FAILED sub-analysis is `failed` with findingCount null — never a silent 0', async () => {
    // FAIL-BEFORE: both sub-handlers erred, both were skipped by `if (x.ok)`,
    // and the response was a clean-looking empty report with no way to tell.
    const r = await automationRiskReportHandler(brokenCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.findings).toEqual([]);
    // WRONG-VALUE proof (not a missing-symbol one): pre-fix the ENTIRE payload
    // contained no trace of the failure at all — a clean-looking empty report.
    expect(JSON.stringify(d)).toContain('failed');
    expect(d.composedFrom).toHaveLength(2);
    for (const row of d.composedFrom ?? []) {
      expect(row.status).toBe('failed');
      expect(row.findingCount).toBeNull();
      // The distinction the whole fix exists for.
      expect(row.findingCount).not.toBe(0);
      expect(row.note).toContain('findingCount is null, NOT 0');
    }
    // A failed composition must NOT read as a clean zero: no degeneration
    // sentence (nothing "contributed 0" — nothing ran), and the boundary holds.
    expect(d.boundaries?.join(' ')).not.toContain('came from a single composed analysis');
    expect(d.boundaries).toContain(
      'This report composes TWO analyses: legacy-automation migration candidates and Apex governor-limit findings. It is NOT the whole automation layer. Flow fault handling, Flow bulkification, trigger recursion guards, and inactive automation were NOT checked here and each has its own tool (see notChecked). A zero in this report is a zero for the two analyses named in composedFrom, nothing more.',
    );
  });

  it('notChecked + the TWO-analyses boundary are present on an EMPTY report', async () => {
    const r = await automationRiskReportHandler(emptyCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.findings).toEqual([]);
    // Both halves ran and found nothing — two CHECKED zeros, not silence.
    expect(d.composedFrom?.every((c) => c.status === 'ran')).toBe(true);
    expect(d.composedFrom?.every((c) => c.findingCount === 0)).toBe(true);
    // No degeneration: nothing came from anywhere, so nothing degenerated.
    expect(d.boundaries?.join(' ')).not.toContain('came from a single composed analysis');
    expect(d.notChecked?.map((n) => n.tool)).toEqual([
      'sfi.flow_fault_audit',
      'sfi.flow_bulkification_audit',
      'sfi.code_quality_audit',
      'sfi.order_of_execution',
    ]);
    for (const surface of d.notChecked ?? []) {
      expect(surface.surface.length).toBeGreaterThan(0);
      expect(surface.reason.length).toBeGreaterThan(0);
    }
    expect(d.boundaries?.[0]).toContain('It is NOT the whole automation layer');
  });

  it('an object-scoped call marks the governor half `excluded-by-scope`, with the reason on the row', async () => {
    const r = await automationRiskReportHandler(pbOnlyCtx, {
      objectApiName: 'Widget__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    const govRow = d.composedFrom?.find(
      (c) => c.analysis === 'sfi.governor_limit_risks',
    );
    expect(govRow?.status).toBe('excluded-by-scope');
    // Not checked ⇒ null, never 0.
    expect(govRow?.findingCount).toBeNull();
    expect(govRow?.note).toContain('EXCLUDED from this object-scoped view');
    // The same prose still renders in the disclosure — one constant, two
    // consumers, so the row and the prose cannot drift.
    expect(d.disclosure).toContain(govRow?.note as string);
    // notChecked and the boundary hold under a scope too.
    expect(d.notChecked).toHaveLength(4);
    expect(d.boundaries?.[0]).toContain('composes TWO analyses');
  });
});

describe('permissionRiskReportHandler — the scan is a CENSUS, not a page', () => {
  const dirs: string[] = [];
  const stores: GraphStore[] = [];

  const node = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
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

  /** A graph whose every read FAILS — a broken container, not an empty one. */
  const brokenCtx: Context = {
    vaultRoot: '/nonexistent',
    manifest: MANIFEST,
    graph: {
      connection: {
        runAndReadAll: () => {
          throw new Error('fixture: graph read failed');
        },
        run: () => {
          throw new Error('fixture: graph read failed');
        },
      },
      instance: {},
    } as unknown as GraphStore,
  };

  let bigCtx: Context;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-synth-bigps-'));
    dirs.push(dir);
    const opened = await openGraph(join(dir, 'big.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    stores.push(opened.value);
    // 500 benign permission sets whose ids sort BEFORE the god-mode one, so a
    // single `ORDER BY id ASC LIMIT 500 OFFSET 0` page never reaches it.
    const nodes: Node[] = [];
    for (let i = 0; i < 500; i += 1) {
      const n = String(i).padStart(3, '0');
      nodes.push(
        node({
          id: `PermissionSet:Aaa_Benign_${n}`,
          apiName: `Aaa_Benign_${n}`,
          properties: { userPermissions: ['ApiEnabled'] },
        }),
      );
    }
    nodes.push(
      node({
        id: 'PermissionSet:Zz_Emergency_Admin',
        apiName: 'Zz_Emergency_Admin',
        properties: { userPermissions: ['ModifyAllData'] },
      }),
    );
    const imp = await importExtractionResults(opened.value, [
      { nodes, edges: [] },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    bigCtx = { vaultRoot: dir, manifest: MANIFEST, graph: opened.value };
  });

  afterAll(async () => {
    for (const s of stores) await closeGraph(s);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('finds a god-mode permission set that sorts past the 500-row page', async () => {
    const r = await permissionRiskReportHandler(bigCtx, { limit: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { privilege } = r.value.data;
    expect(privilege.modifyAllDataGrantors).toContain(
      'PermissionSet:Zz_Emergency_Admin',
    );
    expect(privilege.scanned.permissionSets).toBe(501);
  });

  it('a FAILED Profile read is an error, never "that profile does not exist"', async () => {
    const r = await permissionRiskReportHandler(brokenCtx, {
      profileFilter: 'System Administrator',
    });
    expect(r.ok).toBe(false);
    if (r.ok) {
      // The exact false claim the swallow produced.
      expect(JSON.stringify(r.value.data)).not.toContain('exists in this vault');
      return;
    }
    expect(r.error.kind).toBe('internal');
    expect(r.error.message).toContain('graph query failed');
  });

  it('a FAILED org-wide scan is an error, never an empty god-mode roster', async () => {
    const r = await permissionRiskReportHandler(brokenCtx, { limit: 50 });
    expect(r.ok).toBe(false);
    if (r.ok) {
      expect(r.value.data.privilege.scanned.profiles).not.toBe(0);
      return;
    }
    expect(r.error.kind).toBe('internal');
    expect(r.error.message).toContain('graph query failed');
  });
});

// ---------------------------------------------------------------------------
// REAL-ORG FINDING (MEDIUM): the default `limit: 50` silently truncated the
// findings array. The envelope carried no `truncated`, no counts, no note and
// `trust.limitations: []`, so a host read 50 as the whole over-privileged
// population when the analysis had actually produced far more.
//
// REAL-ORG FINDING (LOW): the tool advertises that it "rolls in unassigned
// permission sets", but with no Tooling-API assignment enrichment EVERY
// permission set has UNKNOWN assignment status. The report emitted zero
// unassigned-grant findings and disclosed nothing, so absence read as a
// checked zero. Two sibling tools disclose the same fact.
// ---------------------------------------------------------------------------
describe('permissionRiskReportHandler — truncation + unassigned-coverage honesty', () => {
  const truncDirs: string[] = [];
  const truncStores: GraphStore[] = [];
  let truncCtx: Context;

  /** Number of god-mode profiles in the fixture — deliberately > the page. */
  const GOD_PROFILES = 6;
  /** Page size used to force truncation. */
  const SMALL_LIMIT = 3;

  const psNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
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

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-synth-trunc-'));
    truncDirs.push(dir);
    const opened = await openGraph(join(dir, 'trunc.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    truncStores.push(opened.value);
    const nodes: Node[] = [];
    for (let i = 0; i < GOD_PROFILES; i += 1) {
      nodes.push(
        psNode({
          id: `Profile:Profile_${String(i).padStart(2, '0')}`,
          apiName: `Profile_${String(i).padStart(2, '0')}`,
          properties: { userPermissions: ['ModifyAllData'] },
        }),
      );
    }
    // One permission set so the unassigned sub-analysis has something to scan.
    nodes.push(
      psNode({
        id: 'PermissionSet:PermSet_A',
        type: 'PermissionSet',
        apiName: 'PermSet_A',
        properties: { userPermissions: ['ApiEnabled'] },
      }),
    );
    const imp = await importExtractionResults(opened.value, [
      { nodes, edges: [] },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    truncCtx = { vaultRoot: dir, manifest: MANIFEST, graph: opened.value };
  });

  afterAll(async () => {
    for (const s of truncStores) await closeGraph(s);
    for (const d of truncDirs) rmSync(d, { recursive: true, force: true });
  });

  it('a limit-truncated findings page carries typed truncation state, not silence', async () => {
    const r = await permissionRiskReportHandler(truncCtx, { limit: SMALL_LIMIT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The analysis DID find every over-privileged grantor…
    expect(d.privilege.overPrivilegedGrantorCount).toBe(GOD_PROFILES);
    // …but the page shows fewer. That MUST be typed, not inferred.
    expect(d.truncated).toBe(true);
    expect(d.findingsPage.limit).toBe(SMALL_LIMIT);
    expect(d.findingsPage.totalCount).toBeGreaterThanOrEqual(GOD_PROFILES);
    expect(d.findingsPage.returnedCount).toBe(d.findings.length);
    expect(d.findingsPage.omittedCount).toBe(
      d.findingsPage.totalCount - d.findingsPage.returnedCount,
    );
    expect(d.findingsPage.omittedCount).toBeGreaterThan(0);
    const op = d.findingsPage.byCategory.find(
      (c) => c.category === 'over-privilege',
    );
    expect(op?.totalCount).toBe(GOD_PROFILES);
    expect(op?.returnedCount).toBe(SMALL_LIMIT);
    expect(op?.truncated).toBe(true);
    // A machine consumer must not be able to skip it, and a host must read it.
    expect(d.findingsPage.note).toContain('limit');
    expect(d.trust.limitations.join(' ')).toContain('finding');
    expect(d.disclosure).toContain('limit');
  });

  it('an untruncated page says so without inventing a gap', async () => {
    const r = await permissionRiskReportHandler(truncCtx, { limit: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.truncated).toBe(false);
    expect(d.findingsPage.omittedCount).toBe(0);
    expect(d.findingsPage.returnedCount).toBe(d.findings.length);
    expect(d.findingsPage.note).toBeNull();
    expect(d.trust.limitations.join(' ')).not.toContain('dropped by limit');
  });

  it('discloses that assignment status is UNKNOWN — zero unassigned findings is not a checked zero', async () => {
    const r = await permissionRiskReportHandler(truncCtx, { limit: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The advertised category produced nothing…
    expect(d.findings.some((f) => f.category === 'unassigned-grant')).toBe(false);
    // …because assignment status could not be determined for ANY permission set.
    expect(d.unassignedCoverage.analyzed).toBe(true);
    expect(d.unassignedCoverage.assignmentStatusKnown).toBe(false);
    expect(d.unassignedCoverage.unknownAssignmentCount).toBeGreaterThan(0);
    expect(d.unassignedCoverage.enrichmentStatus).toBe('structural-only');
    expect(d.unassignedCoverage.note).toContain('UNKNOWN');
    // The remedy the sibling tools name must be here too.
    expect(d.unassignedCoverage.note).toContain('--classify-permissions');
    expect(d.trust.limitations.join(' ')).toContain('Assignment status is UNKNOWN');
    expect(d.disclosure).toContain('Assignment status is UNKNOWN');
  });

  it('a profile-scoped report says the unassigned category was NOT evaluated', async () => {
    const r = await permissionRiskReportHandler(truncCtx, {
      profileFilter: 'Profile_00',
      limit: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.profileFilter?.found).toBe(true);
    expect(d.unassignedCoverage.analyzed).toBe(false);
    expect(d.unassignedCoverage.note).toContain('not');
    expect(d.truncated).toBe(false);
    expect(d.findingsPage.returnedCount).toBe(d.findings.length);
  });

  it('a false-premise profileFilter still declares the unassigned category unchecked', async () => {
    const r = await permissionRiskReportHandler(truncCtx, {
      profileFilter: 'No_Such_Profile_Xyz',
      limit: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.profileFilter?.found).toBe(false);
    expect(d.unassignedCoverage.analyzed).toBe(false);
    expect(d.findingsPage.totalCount).toBe(0);
    expect(d.truncated).toBe(false);
  });
});

// The truncation note advises "re-run with limit: N". If that bound and the
// validator's bound ever drift, the advice names a limit the tool would
// REJECT — so the two are derived from one constant and pinned here.
describe('permissionRiskReportHandler — the advised limit is the limit the schema accepts', () => {
  it('FINDINGS_LIMIT_MAX is exactly what the validator admits at the boundary', () => {
    expect(
      permissionRiskReportInputSchema.safeParse({ limit: FINDINGS_LIMIT_MAX }).success,
    ).toBe(true);
    expect(
      permissionRiskReportInputSchema.safeParse({ limit: FINDINGS_LIMIT_MAX + 1 }).success,
    ).toBe(false);
  });
});
