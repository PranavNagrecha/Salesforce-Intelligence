/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { guestExposureReportHandler } from '../../src/tools/guest-exposure-report.js';
import { V01_TOOLS } from '../../src/tools/index.js';

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

// A community surface (Network -> CustomSite -> ExperienceBundle) whose guest
// profile (heuristic "MemberPortal Profile") over-exposes data. All synthetic.
const seed: ExtractionResult = {
  nodes: [
    node({
      id: 'Network:MemberPortal',
      type: 'Network',
      apiName: 'MemberPortal',
      properties: { status: 'Live', selfRegistration: true, enableGuestFileAccess: true, site: 'MemberPortal', picassoSite: 'MemberPortal1' },
    }),
    node({
      id: 'CustomSite:MemberPortal',
      type: 'CustomSite',
      apiName: 'MemberPortal',
      label: 'MemberPortal',
      properties: { active: true, siteType: 'ChatterNetwork', masterLabel: 'MemberPortal', guestProfileName: 'MemberPortal Profile' },
    }),
    node({ id: 'ExperienceBundle:MemberPortal1', type: 'ExperienceBundle', apiName: 'MemberPortal1', properties: { type: 'ChatterNetworkPicasso', pageCount: 12 } }),
    // The guest profile the naming convention resolves to.
    node({ id: 'Profile:MemberPortal Profile', type: 'Profile', apiName: 'MemberPortal Profile', properties: { userPermissions: [] } }),
    // Objects + fields.
    node({ id: 'CustomObject:Case', type: 'CustomObject', apiName: 'Case', label: 'Case', properties: { sharingModel: 'Private' } }),
    node({ id: 'CustomObject:Public_Info__c', type: 'CustomObject', apiName: 'Public_Info__c', label: 'Public Info', properties: { sharingModel: 'Read' } }),
    node({ id: 'CustomField:Case.SSN__c', type: 'CustomField', apiName: 'SSN__c', parentId: 'CustomObject:Case', properties: { dataType: 'EncryptedText' } }),
    // A PII field on an object the guest CANNOT read — must NOT count (FLS w/o object read).
    node({ id: 'CustomField:Account.SSN__c', type: 'CustomField', apiName: 'SSN__c', parentId: 'CustomObject:Account', properties: { dataType: 'EncryptedText' } }),
    node({ id: 'ApexClass:GuestController', type: 'ApexClass', apiName: 'GuestController' }),
    // Guest sharing rule attached to this site (CR-CAP-16 shape).
    node({ id: 'SharingRule:Case.Guest_Share', type: 'SharingRule', apiName: 'Case.Guest_Share', properties: { ruleType: 'guest', accessLevel: 'Read', siteName: 'MemberPortal', sObjectType: 'Case' } }),
    // A SECOND object the guest can WRITE, carrying its own guest-readable PII
    // (critical) + guest sharing rule. The object-scope filter must drop ALL of
    // this when the caller asks about Case only ("Lead criticals absent").
    node({ id: 'CustomObject:Lead', type: 'CustomObject', apiName: 'Lead', label: 'Lead', properties: { sharingModel: 'Private' } }),
    node({ id: 'CustomField:Lead.SSN__c', type: 'CustomField', apiName: 'SSN__c', parentId: 'CustomObject:Lead', properties: { dataType: 'EncryptedText' } }),
    node({ id: 'SharingRule:Lead.Guest_Lead', type: 'SharingRule', apiName: 'Lead.Guest_Lead', properties: { ruleType: 'guest', accessLevel: 'Edit', siteName: 'MemberPortal', sObjectType: 'Lead' } }),
  ],
  edges: [
    edge({ fromId: 'Network:MemberPortal', toId: 'CustomSite:MemberPortal', edgeType: 'references', properties: { via: 'site' } }),
    edge({ fromId: 'CustomSite:MemberPortal', toId: 'Profile:MemberPortal Profile', edgeType: 'references', confidence: 'heuristic', properties: { via: 'guest-profile' } }),
    // Guest grants: WRITE on Case (which has a guest-readable PII field) -> critical.
    edge({ fromId: 'Profile:MemberPortal Profile', toId: 'CustomObject:Case', edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true } }),
    // Read-only on a non-PII object -> low.
    edge({ fromId: 'Profile:MemberPortal Profile', toId: 'CustomObject:Public_Info__c', edgeType: 'grantedBy', properties: { allowRead: true } }),
    // FLS read on the Case SSN (object read present -> exposed) -> medium finding + makes Case critical.
    edge({ fromId: 'Profile:MemberPortal Profile', toId: 'CustomField:Case.SSN__c', edgeType: 'grantedBy', properties: { readable: true } }),
    // FLS read on Account.SSN but NO object read on Account -> must NOT count.
    edge({ fromId: 'Profile:MemberPortal Profile', toId: 'CustomField:Account.SSN__c', edgeType: 'grantedBy', properties: { readable: true } }),
    // Apex class access -> low.
    edge({ fromId: 'Profile:MemberPortal Profile', toId: 'ApexClass:GuestController', edgeType: 'grantedBy', properties: { enabled: true } }),
    // Guest grants on the SECOND object (Lead): WRITE + guest-readable PII -> critical.
    edge({ fromId: 'Profile:MemberPortal Profile', toId: 'CustomObject:Lead', edgeType: 'grantedBy', properties: { allowRead: true, allowCreate: true } }),
    edge({ fromId: 'Profile:MemberPortal Profile', toId: 'CustomField:Lead.SSN__c', edgeType: 'grantedBy', properties: { readable: true } }),
  ],
};

// A second site whose guest profile is NOT in the vault (unresolved -> disclosed).
const unresolvedSeed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomSite:PublicHelp', type: 'CustomSite', apiName: 'PublicHelp', label: 'PublicHelp', properties: { active: true, siteType: 'Visualforce', masterLabel: 'PublicHelp', guestProfileName: 'PublicHelp Profile' } }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-guest-exposure-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed, unresolvedSeed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('guestExposureReportHandler', () => {
  it('rejects a non-Network/CustomSite communityId with invalid-query', async () => {
    const r = await guestExposureReportHandler(ctx, { communityId: 'Profile:Admin' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('ranks a public-write-on-PII-object as critical, carries heuristic confidence + real node ids', async () => {
    const r = await guestExposureReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Headline confidence is heuristic (guest-profile linkage is a convention).
    expect(d.confidence).toBe('heuristic');
    // The Case object grant is critical (write + guest-readable PII field).
    const caseFinding = d.findings.find((f) => f.nodeId === 'CustomObject:Case');
    expect(caseFinding).toBeDefined();
    expect(caseFinding!.severity).toBe('critical');
    expect(caseFinding!.kind).toBe('object-crud');
    expect(caseFinding!.guestReadablePiiFieldCount).toBe(1);
    expect(caseFinding!.grantConfidence).toBe('declared');
    expect(caseFinding!.guestLinkageConfidence).toBe('heuristic');
    // Critical sorts first.
    expect(d.findings[0]!.severity).toBe('critical');
    // The SSN FLS finding exists (real field node id, medium since read-only).
    const flsFinding = d.findings.find((f) => f.nodeId === 'CustomField:Case.SSN__c');
    expect(flsFinding).toBeDefined();
    expect(flsFinding!.kind).toBe('pii-field-fls');
    expect(flsFinding!.severity).toBe('medium');
    expect(flsFinding!.piiClassification).toBe('pii');
    // Apex + guest sharing rule findings present (low).
    expect(d.findings.some((f) => f.nodeId === 'ApexClass:GuestController')).toBe(true);
    expect(d.findings.some((f) => f.nodeId === 'SharingRule:Case.Guest_Share' && f.kind === 'guest-sharing-rule')).toBe(true);
    expect(d.summary.critical).toBeGreaterThanOrEqual(1);
  });

  it('does NOT count an FLS grant on a PII field whose object the guest cannot read', async () => {
    const r = await guestExposureReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Account.SSN__c has FLS read but the guest has NO object read on Account,
    // so it is not visible and must NOT appear as a finding.
    expect(r.value.data.findings.some((f) => f.nodeId === 'CustomField:Account.SSN__c')).toBe(false);
  });

  it('surfaces the community metadata: selfRegistration, status, correlated network/bundle', async () => {
    const r = await guestExposureReportHandler(ctx, { communityId: 'CustomSite:MemberPortal' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const community = r.value.data.communities.find((c) => c.communityId === 'CustomSite:MemberPortal');
    expect(community).toBeDefined();
    expect(community!.selfRegistration).toBe(true);
    expect(community!.status).toBe('Live');
    expect(community!.networkId).toBe('Network:MemberPortal');
    expect(community!.experienceBundleId).toBe('ExperienceBundle:MemberPortal1');
    expect(community!.guestProfileResolved).toBe(true);
    expect(community!.guestProfileId).toBe('Profile:MemberPortal Profile');
  });

  it('resolves a Network communityId through its <site>', async () => {
    const r = await guestExposureReportHandler(ctx, { communityId: 'Network:MemberPortal' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.communities.map((c) => c.communityId)).toEqual(['CustomSite:MemberPortal']);
  });

  it('discloses an unresolved guest profile per community, never "no exposure"', async () => {
    const r = await guestExposureReportHandler(ctx, { communityId: 'CustomSite:PublicHelp' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const community = r.value.data.communities[0]!;
    expect(community.guestProfileResolved).toBe(false);
    expect(community.findingCount).toBe(0);
    expect(r.value.data.disclosures.some((s) => s.includes('NO resolvable guest profile'))).toBe(true);
  });
});

// =============================================================================
// GUEST-EXPOSURE-MISSING-OBJECT-SCOPE -- "guest exposure for Case" must scope to
// that object (its CRUD + its fields' FLS + its guest sharing rules) instead of
// silently stripping the object arg and returning every object's guest grants.
// Pre-fix the object arg was Zod-stripped: the scoped call was byte-identical to
// the bare call (Lead criticals mixed in) with no appliedScope echo.
// =============================================================================
describe('guestExposureReportHandler — object scope (GUEST-EXPOSURE-MISSING-OBJECT-SCOPE)', () => {
  it('bare call echoes appliedScope=all and includes BOTH objects', async () => {
    const r = await guestExposureReportHandler(ctx, { limit: 200 });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.appliedScope).toEqual({ community: null, object: null, mode: 'all' });
    // Both Case and Lead object-crud findings are present in an unscoped audit.
    expect(d.findings.some((f) => f.nodeId === 'CustomObject:Case')).toBe(true);
    expect(d.findings.some((f) => f.nodeId === 'CustomObject:Lead')).toBe(true);
    // Both are critical (write + guest-readable PII).
    expect(d.summary.critical).toBeGreaterThanOrEqual(2);
  });

  it('objectApiName scopes findings to that object + its fields; other objects absent', async () => {
    const r = await guestExposureReportHandler(ctx, { objectApiName: 'Case', limit: 200 });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.appliedScope).toEqual({ community: null, object: 'Case', mode: 'object' });
    // Every finding is about Case (object node, a Case field, or a Case guest rule).
    for (const f of d.findings) {
      const obj =
        f.nodeId.startsWith('CustomObject:') ? f.nodeId.slice('CustomObject:'.length)
        : f.nodeId.startsWith('CustomField:') ? f.nodeId.slice('CustomField:'.length).split('.')[0]
        : f.nodeId.startsWith('SharingRule:') ? f.nodeId.slice('SharingRule:'.length).split('.')[0]
        : null;
      expect(obj).toBe('Case');
    }
    // No Lead node of ANY kind leaks in — the mistaken-cross-object bug.
    expect(d.findings.some((f) => f.nodeId.includes('Lead'))).toBe(false);
    // Object-independent Apex findings drop out of an object scope.
    expect(d.findings.some((f) => f.kind === 'apex-enabled')).toBe(false);
    // The Case object-crud critical is still present.
    const caseFinding = d.findings.find((f) => f.nodeId === 'CustomObject:Case');
    expect(caseFinding?.severity).toBe('critical');
    // summary + per-community counts reflect the object scope (fewer than bare).
    const community = d.communities[0]!;
    expect(community.findingCount).toBe(d.findings.length);
    expect(d.summary.totalFindings).toBe(d.findings.length);
    // A scope disclosure is surfaced.
    expect(d.disclosures.some((s) => s.includes("Scoped to object 'Case'"))).toBe(true);
  });

  it('objectId (CustomObject: id) resolves to the same scope as objectApiName', async () => {
    const byId = await guestExposureReportHandler(ctx, { objectId: 'CustomObject:Case', limit: 200 });
    const byName = await guestExposureReportHandler(ctx, { objectApiName: 'Case', limit: 200 });
    expect(byId.ok && byName.ok).toBe(true); if (!byId.ok || !byName.ok) return;
    expect(byId.value.data.appliedScope).toEqual({ community: null, object: 'Case', mode: 'object' });
    expect(byId.value.data.summary.totalFindings).toBe(byName.value.data.summary.totalFindings);
    expect(byId.value.data.findings.map((f) => f.nodeId).sort()).toEqual(
      byName.value.data.findings.map((f) => f.nodeId).sort(),
    );
  });

  it('a malformed objectId is an invalid-query, never a silent strip', async () => {
    const r = await guestExposureReportHandler(ctx, { objectId: 'Case' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('objectId');
  });

  it('conflicting objectId/objectApiName is an invalid-query', async () => {
    const r = await guestExposureReportHandler(ctx, {
      objectId: 'CustomObject:Case',
      objectApiName: 'Lead',
    });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('community + object scope compose (mode=community+object)', async () => {
    const r = await guestExposureReportHandler(ctx, {
      communityId: 'CustomSite:MemberPortal',
      objectApiName: 'Case',
      limit: 200,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({
      community: 'CustomSite:MemberPortal',
      object: 'Case',
      mode: 'community+object',
    });
    expect(r.value.data.findings.some((f) => f.nodeId.includes('Lead'))).toBe(false);
  });
});

describe('guestExposureReportHandler — fail closed on an empty vault', () => {
  it('reports "no Experience Cloud surface" rather than "no exposure"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-guest-empty-'));
    const opened = await openGraph(join(dir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const emptyStore = opened.value;
    try {
      const emptyCtx: Context = { vaultRoot: dir, manifest: MANIFEST, graph: emptyStore };
      const r = await guestExposureReportHandler(emptyCtx, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.communities).toEqual([]);
      expect(r.value.data.findings).toEqual([]);
      expect(r.value.data.disclosures.some((s) => s.includes('No Experience Cloud surface'))).toBe(true);
      expect(r.value.data.confidence).toBe('heuristic');
      // appliedScope is echoed even on the fail-closed path.
      expect(r.value.data.appliedScope).toEqual({ community: null, object: null, mode: 'all' });
    } finally {
      await closeGraph(emptyStore);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// GUARD (GUEST-EXPOSURE-IGNORES-NETWORK-SCOPE + GUEST-EXPOSURE-MISSING-OBJECT-
// SCOPE residual): a host asking "guest exposure on {community}?" sends
// networkApiName / networkName / siteApiName / componentId: Network:… ; these
// were Zod-stripped so EVERY call ran org-wide over all communities. And the
// object-scope componentId (CustomObject:…) was likewise stripped. The aliases
// must now scope like communityId / objectApiName. Pre-fix each scoped call is
// byte-identical to the bare org-wide call (both communities, appliedScope
// absent), so the single-community / object assertions are RED.
describe('guestExposureReportHandler — network + object componentId scope (guard)', () => {
  it('networkApiName scopes to the one community (was org-wide over all communities)', async () => {
    const byAlias = await guestExposureReportHandler(ctx, {
      networkApiName: 'MemberPortal',
      limit: 200,
    });
    const byCommunityId = await guestExposureReportHandler(ctx, {
      communityId: 'Network:MemberPortal',
      limit: 200,
    });
    expect(byAlias.ok && byCommunityId.ok).toBe(true);
    if (!byAlias.ok || !byCommunityId.ok) return;
    // Only the one resolved community — NOT the org-wide roster (which also
    // holds CustomSite:PublicHelp).
    expect(byAlias.value.data.communities.map((c) => c.communityId)).toEqual([
      'CustomSite:MemberPortal',
    ]);
    expect(byAlias.value.data.appliedScope.community).toBe('Network:MemberPortal');
    expect(byAlias.value.data.appliedScope.mode).toBe('community');
    expect(byAlias.value.data.findings.map((f) => f.nodeId).sort()).toEqual(
      byCommunityId.value.data.findings.map((f) => f.nodeId).sort(),
    );
  });

  it('siteApiName scopes to the CustomSite community', async () => {
    const r = await guestExposureReportHandler(ctx, { siteApiName: 'MemberPortal', limit: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.communities.map((c) => c.communityId)).toEqual([
      'CustomSite:MemberPortal',
    ]);
    expect(r.value.data.appliedScope.community).toBe('CustomSite:MemberPortal');
  });

  it('componentId: Network:… / CustomSite:… scope to that community', async () => {
    const byNet = await guestExposureReportHandler(ctx, {
      componentId: 'Network:MemberPortal',
      limit: 200,
    });
    const bySite = await guestExposureReportHandler(ctx, {
      componentId: 'CustomSite:MemberPortal',
      limit: 200,
    });
    expect(byNet.ok && bySite.ok).toBe(true);
    if (!byNet.ok || !bySite.ok) return;
    expect(byNet.value.data.communities.map((c) => c.communityId)).toEqual([
      'CustomSite:MemberPortal',
    ]);
    expect(bySite.value.data.communities.map((c) => c.communityId)).toEqual([
      'CustomSite:MemberPortal',
    ]);
    expect(byNet.value.data.appliedScope.community).toBe('Network:MemberPortal');
  });

  it('componentId: CustomObject:… scopes to that object (residual object-scope alias)', async () => {
    const byComponent = await guestExposureReportHandler(ctx, {
      componentId: 'CustomObject:Case',
      limit: 200,
    });
    const byObjectApiName = await guestExposureReportHandler(ctx, {
      objectApiName: 'Case',
      limit: 200,
    });
    expect(byComponent.ok && byObjectApiName.ok).toBe(true);
    if (!byComponent.ok || !byObjectApiName.ok) return;
    expect(byComponent.value.data.appliedScope).toEqual({
      community: null,
      object: 'Case',
      mode: 'object',
    });
    // No Lead node leaks in (the org-wide-instead-of-object bug).
    expect(byComponent.value.data.findings.some((f) => f.nodeId.includes('Lead'))).toBe(false);
    expect(byComponent.value.data.findings.map((f) => f.nodeId).sort()).toEqual(
      byObjectApiName.value.data.findings.map((f) => f.nodeId).sort(),
    );
  });

  it('componentId + object aliases can compose (Network community + CustomObject object)', async () => {
    const r = await guestExposureReportHandler(ctx, {
      componentId: 'Network:MemberPortal',
      objectApiName: 'Case',
      limit: 200,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({
      community: 'Network:MemberPortal',
      object: 'Case',
      mode: 'community+object',
    });
  });

  it('an unsupported componentId prefix is invalid-query (never a silent org-wide fallback)', async () => {
    const r = await guestExposureReportHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('componentId');
  });

  it('disagreeing community selectors are invalid-query', async () => {
    const r = await guestExposureReportHandler(ctx, {
      communityId: 'Network:MemberPortal',
      siteApiName: 'PublicHelp',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  // The MCP-advertised inputSchema must SURFACE the object-scope selectors the
  // handler now honors — a schema that omits `componentId` / `objectApiName`
  // leaves the object scope undiscoverable to hosts (a documentation-shaped
  // silent-strip). Guards roster.ts against regressing to the communityId-only
  // schema.
  it('roster advertises the componentId + object-scope selectors', () => {
    const def = V01_TOOLS.find((t) => t.name === 'sfi.guest_exposure_report');
    expect(def).toBeDefined();
    const props = (def!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    for (const key of [
      'communityId',
      'networkApiName',
      'siteApiName',
      'componentId',
      'objectApiName',
      'objectId',
    ]) {
      expect(props).toHaveProperty(key);
    }
  });
});
