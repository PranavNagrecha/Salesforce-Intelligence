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

// =============================================================================
// ORPHAN GUEST SHARING RULES (spec row 8). A guest rule is matched to a
// community against a 3-key name set (CustomSite api name, site label, Network
// api name). A rule matching none of them — or declaring no `siteName` at all —
// was DROPPED SILENTLY: no finding, no bucket, no disclosure, while the mirror
// case (a Network naming an unmodeled CustomSite) already emitted an
// `orphanNetworks` disclosure. A dropped guest rule is a real declared
// record-level grant to unauthenticated visitors.
//
// The probe vault could NOT exercise this: it holds 31 SharingRule nodes and
// ALL 31 are `criteria` rules — zero guest rules — so the whole guest-rule path
// is inert there and this behaviour is fixture-proved by necessity.
// =============================================================================

const ORPHAN_SITE = 'CustomSite:HelpCentre';

/**
 * One community with a matching guest rule (the control), plus three rules that
 * cannot be attributed: a wrong site name, a rule filed under a second object,
 * and a rule declaring no `siteName` at all.
 */
const orphanSeed: ExtractionResult = {
  nodes: [
    node({
      id: 'Network:HelpCentre',
      type: 'Network',
      apiName: 'HelpCentre',
      properties: { status: 'Live', site: 'HelpCentre' },
    }),
    node({
      id: ORPHAN_SITE,
      type: 'CustomSite',
      apiName: 'HelpCentre',
      label: 'HelpCentre',
      properties: {
        active: true,
        siteType: 'ChatterNetwork',
        masterLabel: 'HelpCentre',
        guestProfileName: 'HelpCentre Profile',
      },
    }),
    node({
      id: 'Profile:HelpCentre Profile',
      type: 'Profile',
      apiName: 'HelpCentre Profile',
      properties: { userPermissions: [] },
    }),
    node({
      id: 'CustomObject:Case',
      type: 'CustomObject',
      apiName: 'Case',
      label: 'Case',
      properties: { sharingModel: 'Private' },
    }),
    node({
      id: 'CustomObject:Order',
      type: 'CustomObject',
      apiName: 'Order',
      label: 'Order',
      properties: { sharingModel: 'Private' },
    }),
    // CONTROL: matches the site api name, so it becomes a finding.
    node({
      id: 'SharingRule:Case.Guest_Matched',
      type: 'SharingRule',
      apiName: 'Case.Guest_Matched',
      properties: {
        ruleType: 'guest',
        accessLevel: 'Read',
        siteName: 'HelpCentre',
        sObjectType: 'Case',
      },
    }),
    // ORPHAN 1: names a site this vault does not model.
    node({
      id: 'SharingRule:Case.Guest_Unmatched',
      type: 'SharingRule',
      apiName: 'Case.Guest_Unmatched',
      properties: {
        ruleType: 'guest',
        accessLevel: 'Edit',
        siteName: 'RetiredPortal',
        sObjectType: 'Case',
      },
    }),
    // ORPHAN 2: same, on a DIFFERENT object — the object-scope axis.
    node({
      id: 'SharingRule:Order.Guest_Unmatched',
      type: 'SharingRule',
      apiName: 'Order.Guest_Unmatched',
      properties: {
        ruleType: 'guest',
        accessLevel: 'Read',
        siteName: 'RetiredPortal',
        sObjectType: 'Order',
      },
    }),
    // ORPHAN 3: declares NO siteName — dropped before the name set was even
    // consulted.
    node({
      id: 'SharingRule:Case.Guest_NoSite',
      type: 'SharingRule',
      apiName: 'Case.Guest_NoSite',
      properties: { ruleType: 'guest', accessLevel: 'Read', sObjectType: 'Case' },
    }),
    // A CRITERIA rule must never enter the guest bucket at all.
    node({
      id: 'SharingRule:Case.Criteria_Rule',
      type: 'SharingRule',
      apiName: 'Case.Criteria_Rule',
      properties: { ruleType: 'criteria', accessLevel: 'Read', sObjectType: 'Case' },
    }),
  ],
  edges: [
    edge({
      fromId: 'Network:HelpCentre',
      toId: ORPHAN_SITE,
      edgeType: 'references',
      properties: { via: 'site' },
    }),
    edge({
      fromId: 'Profile:HelpCentre Profile',
      toId: 'CustomObject:Case',
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
};

describe('guestExposureReportHandler — orphan guest sharing rules', () => {
  let orphanStore: GraphStore;
  let orphanDir: string;
  let orphanCtx: Context;

  beforeAll(async () => {
    orphanDir = mkdtempSync(join(tmpdir(), 'sfi-guest-orphan-'));
    const opened = await openGraph(join(orphanDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    orphanStore = opened.value;
    const imported = await importExtractionResults(orphanStore, [orphanSeed]);
    if (!imported.ok) throw new Error(imported.error.message);
    orphanCtx = { vaultRoot: orphanDir, manifest: MANIFEST, graph: orphanStore };
  });

  afterAll(async () => {
    await closeGraph(orphanStore);
    rmSync(orphanDir, { recursive: true, force: true });
  });

  it('buckets and discloses every guest rule that attached to no community', async () => {
    const r = await guestExposureReportHandler(orphanCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    // The control rule became a finding and is therefore NOT an orphan.
    const ruleFindings = d.findings.filter((f) => f.kind === 'guest-sharing-rule');
    expect(ruleFindings.map((f) => f.nodeId)).toEqual(['SharingRule:Case.Guest_Matched']);

    // The three unattributable rules are all present — none silently dropped.
    const orphans = d.orphanGuestRules ?? [];
    expect(orphans.map((o) => o.ruleId)).toEqual([
      'SharingRule:Case.Guest_NoSite',
      'SharingRule:Case.Guest_Unmatched',
      'SharingRule:Order.Guest_Unmatched',
    ]);
    // A criteria rule is not a guest rule and must not appear anywhere.
    expect(orphans.some((o) => o.ruleId.includes('Criteria'))).toBe(false);
    // The bucket carries the evidence, not just an id.
    const noSite = orphans.find((o) => o.ruleId === 'SharingRule:Case.Guest_NoSite')!;
    expect(noSite.siteName).toBeNull();
    expect(noSite.objectApiName).toBe('Case');
    const unmatched = orphans.find((o) => o.ruleId === 'SharingRule:Case.Guest_Unmatched')!;
    expect(unmatched.siteName).toBe('RetiredPortal');
    expect(unmatched.accessLevel).toBe('Edit');

    // INVARIANT: every guest rule in the vault is either a finding or an orphan.
    // Nothing may fall between the two buckets — that gap WAS the defect.
    const accounted = new Set([
      ...ruleFindings.map((f) => f.nodeId),
      ...orphans.map((o) => o.ruleId),
    ]);
    for (const id of [
      'SharingRule:Case.Guest_Matched',
      'SharingRule:Case.Guest_Unmatched',
      'SharingRule:Order.Guest_Unmatched',
      'SharingRule:Case.Guest_NoSite',
    ]) {
      expect(accounted.has(id)).toBe(true);
    }

    // And it is DISCLOSED, mirroring the orphanNetworks disclosure.
    const disclosure = d.disclosures.find((s) => s.includes('could NOT be attributed'));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain('SharingRule:Case.Guest_Unmatched');
    expect(disclosure).toContain('never read their absence');
  });

  it('honours the object scope on the orphan bucket, exactly as on findings', async () => {
    const r = await guestExposureReportHandler(orphanCtx, { objectApiName: 'Case' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const orphans = r.value.data.orphanGuestRules ?? [];
    expect(orphans.map((o) => o.ruleId)).toEqual([
      'SharingRule:Case.Guest_NoSite',
      'SharingRule:Case.Guest_Unmatched',
    ]);
  });

  it('still names the unattributable rules under a communityId scope, and keeps them out of findings', async () => {
    // The bucket used to be suppressed here on the rationale that other
    // communities' rules are out of scope, not orphaned. That rationale does
    // not hold: an unattributable rule belongs to NO community, so it may well
    // belong to the SCOPED one — a site-label mismatch is exactly how a rule
    // becomes unattributable — and suppressing it restored the full silence
    // this bucket exists to end, for the rules most likely to be in scope.
    const r = await guestExposureReportHandler(orphanCtx, { communityId: ORPHAN_SITE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    const orphans = d.orphanGuestRules ?? [];
    expect(orphans.map((o) => o.ruleId)).toEqual([
      'SharingRule:Case.Guest_NoSite',
      'SharingRule:Case.Guest_Unmatched',
      'SharingRule:Order.Guest_Unmatched',
    ]);
    // …but NOT counted as this community's exposure: they are absent from
    // `findings` and from its `findingCount`.
    expect(d.findings.some((f) => orphans.some((o) => o.ruleId === f.nodeId))).toBe(false);
    // The rule that DOES attribute to this community is still a finding, so the
    // scoped answer did not simply widen into a full run.
    expect(
      d.findings.filter((f) => f.kind === 'guest-sharing-rule').map((f) => f.nodeId),
    ).toEqual(['SharingRule:Case.Guest_Matched']);

    const disclosure = d.disclosures.find((line) => line.includes('could NOT be attributed'));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain('SharingRule:Case.Guest_Unmatched');
    expect(disclosure).toContain(ORPHAN_SITE);
    expect(disclosure).toContain('may well belong to');
  });

  it('judges attribution against ALL communities, so another site\'s rule is not a false orphan', async () => {
    // `Guest_Matched` attributes to the modeled site. Under a scope that does
    // NOT include it, it must still be treated as attributable — the bucket
    // reports unattributable rules, never merely out-of-scope ones.
    const r = await guestExposureReportHandler(orphanCtx, { communityId: ORPHAN_SITE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      (r.value.data.orphanGuestRules ?? []).some(
        (o) => o.ruleId === 'SharingRule:Case.Guest_Matched',
      ),
    ).toBe(false);
  });

  // FAIL-CLOSED PATH: guest rules but NO Experience Cloud surface at all. The
  // scan used to run BELOW the early return, so every guest rule vanished:
  // `findings: []`, no bucket, no disclosure, `totalFindings: 0` — the exact
  // silent drop this bucket exists to end, on the vault state that early
  // return's own disclosure names ("the vault predates the Experience Cloud
  // extraction").
  it('reports every guest rule as an orphan when NO community surface is modeled', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'sfi-guest-nosurface-'));
    const opened = await openGraph(join(bareDir, 'g.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const imported = await importExtractionResults(opened.value, [
        {
          nodes: [
            node({
              id: 'SharingRule:Case.Guest_Edit',
              type: 'SharingRule',
              apiName: 'Case.Guest_Edit',
              properties: {
                ruleType: 'guest',
                accessLevel: 'Edit',
                siteName: 'HelpCentre',
                sObjectType: 'Case',
              },
            }),
            node({
              id: 'SharingRule:Case.Guest_Read',
              type: 'SharingRule',
              apiName: 'Case.Guest_Read',
              properties: {
                ruleType: 'guest',
                accessLevel: 'Read',
                siteName: 'HelpCentre',
                sObjectType: 'Case',
              },
            }),
          ],
          edges: [],
        },
      ]);
      expect(imported.ok).toBe(true);
      const bareCtx = {
        vaultRoot: bareDir,
        manifest: MANIFEST,
        graph: opened.value,
      } as unknown as Context;
      const r = await guestExposureReportHandler(bareCtx, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      // Still fail-closed on the community surface itself…
      expect(d.communities).toEqual([]);
      expect(d.summary.totalFindings).toBe(0);
      // …but the guest rules are NAMED, not dropped.
      expect((d.orphanGuestRules ?? []).map((o) => o.ruleId)).toEqual([
        'SharingRule:Case.Guest_Edit',
        'SharingRule:Case.Guest_Read',
      ]);
      const disclosure = d.disclosures.find((line) => line.includes('guest sharing rule(s)'));
      expect(disclosure).toBeDefined();
      expect(disclosure).toContain('SharingRule:Case.Guest_Edit');
      expect(disclosure).toContain('no guest exposure');
    } finally {
      await closeGraph(opened.value);
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// GUEST-ORPHAN-BUCKET-HAS-NO-PAGING-CONTRACT.
//
// The bucket shipped with no cap and no marker. On a vault holding 600 guest
// sharing rules and no community surface it emitted 500 rows plus a 28,463-
// character disclosure naming every id, at ~102 KB against a 40 KB budget. The
// global envelope guard then tail-trimmed the array to 62 rows while the
// disclosure still claimed all 500 were "listed in `orphanGuestRules`", and the
// dropped 438 grants were unreachable from any call (`limit`/`offset` page
// `findings`, not this bucket). These tests hold the repaired contract: the
// count never disagrees with the rows delivered, the inline id list is capped,
// and `orphanOffset` reaches every row.
// =============================================================================
describe('guestExposureReportHandler — orphan bucket paging contract', () => {
  const RULE_COUNT = 120;
  let pageStore: GraphStore;
  let pageDir: string;
  let pageCtx: Context;
  const allIds = Array.from(
    { length: RULE_COUNT },
    (_, i) => `SharingRule:Case.Guest_R${String(i).padStart(3, '0')}`,
  );

  beforeAll(async () => {
    pageDir = mkdtempSync(join(tmpdir(), 'sfi-guest-orphan-page-'));
    const opened = await openGraph(join(pageDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    pageStore = opened.value;
    const imported = await importExtractionResults(pageStore, [
      {
        nodes: allIds.map((id) =>
          node({
            id,
            type: 'SharingRule',
            apiName: id.slice('SharingRule:'.length),
            properties: {
              ruleType: 'guest',
              accessLevel: 'Read',
              siteName: 'NoSuchSite',
              sObjectType: 'Case',
            },
          }),
        ),
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    pageCtx = { vaultRoot: pageDir, manifest: MANIFEST, graph: pageStore } as unknown as Context;
  });

  afterAll(async () => {
    await closeGraph(pageStore);
    rmSync(pageDir, { recursive: true, force: true });
  });

  it('caps the page, states the total, and never disagrees with the rows delivered', async () => {
    const r = await guestExposureReportHandler(pageCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    const page = d.orphanGuestRulesPage;
    expect(page).toBeDefined();
    if (page === undefined) return;

    expect(page.totalCount).toBe(RULE_COUNT);
    expect(page.returnedCount).toBe((d.orphanGuestRules ?? []).length);
    expect(page.returnedCount).toBeLessThanOrEqual(page.limit);
    expect(page.returnedCount).toBeLessThan(RULE_COUNT);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(page.offset + page.returnedCount);

    // The disclosure states BOTH numbers and names only a capped id sample —
    // it used to spell out every id, which is what made the string 28 KB.
    const disclosure = d.disclosures.find((line) => line.includes('guest sharing rule(s)'));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain(`carries ${String(page.returnedCount)} of the ${String(RULE_COUNT)}`);
    expect((disclosure?.match(/SharingRule:/g) ?? []).length).toBeLessThanOrEqual(10);
    expect(disclosure).toContain('orphanOffset');
  });

  it('reaches every dropped row through orphanOffset — none is unrecoverable', async () => {
    const seen: string[] = [];
    let offset: number | null = 0;
    let guard = 0;
    while (offset !== null && guard < 50) {
      guard += 1;
      const r: Awaited<ReturnType<typeof guestExposureReportHandler>> =
        await guestExposureReportHandler(pageCtx, { orphanOffset: offset });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const page = r.value.data.orphanGuestRulesPage;
      expect(page).toBeDefined();
      if (page === undefined) return;
      expect(page.totalCount).toBe(RULE_COUNT);
      expect(page.returnedCount).toBe((r.value.data.orphanGuestRules ?? []).length);
      seen.push(...(r.value.data.orphanGuestRules ?? []).map((o) => o.ruleId));
      offset = page.nextOffset;
    }
    expect(seen).toEqual(allIds);
  });
});

// =============================================================================
// GUEST-ORPHAN-DISCLOSURE-DENIES-A-NETWORK-THE-SAME-PAYLOAD-NAMES.
//
// `attributableSiteNames` collected Network api names by walking MODELED sites,
// so a Network whose `<site>` points at an unmodeled CustomSite contributed no
// key. A guest rule declaring that Network then landed in `orphanGuestRules`
// under "matches no ... Network api name in this vault", while the disclosure
// directly above it said "1 Network(s) reference a CustomSite not modeled in
// this vault (Network:Partner_Net)" — one payload, two contradictory claims
// about the same node.
// =============================================================================
describe('guestExposureReportHandler — a Network the vault holds is attributable', () => {
  let netStore: GraphStore;
  let netDir: string;
  let netCtx: Context;

  beforeAll(async () => {
    netDir = mkdtempSync(join(tmpdir(), 'sfi-guest-unmodeled-site-'));
    const opened = await openGraph(join(netDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    netStore = opened.value;
    const imported = await importExtractionResults(netStore, [
      {
        nodes: [
          node({
            id: 'CustomSite:Help_Portal',
            type: 'CustomSite',
            apiName: 'Help_Portal',
            label: 'Help Portal',
            properties: { active: true, siteType: 'ChatterNetwork', masterLabel: 'Help Portal' },
          }),
          node({
            id: 'Network:Help_Net',
            type: 'Network',
            apiName: 'Help_Net',
            properties: { status: 'Live', site: 'Help_Portal' },
          }),
          // The Network whose CustomSite this vault does NOT model.
          node({
            id: 'Network:Partner_Net',
            type: 'Network',
            apiName: 'Partner_Net',
            properties: { status: 'Live', site: 'Missing_Portal' },
          }),
          node({
            id: 'SharingRule:Account.Guest_Names_Network',
            type: 'SharingRule',
            apiName: 'Account.Guest_Names_Network',
            properties: {
              ruleType: 'guest',
              accessLevel: 'Read',
              siteName: 'Partner_Net',
              sObjectType: 'Account',
            },
          }),
          node({
            id: 'SharingRule:Account.Guest_Names_Missing_Site',
            type: 'SharingRule',
            apiName: 'Account.Guest_Names_Missing_Site',
            properties: {
              ruleType: 'guest',
              accessLevel: 'Read',
              siteName: 'Missing_Portal',
              sObjectType: 'Account',
            },
          }),
        ],
        edges: [
          edge({
            fromId: 'Network:Help_Net',
            toId: 'CustomSite:Help_Portal',
            edgeType: 'references',
            properties: { via: 'site' },
          }),
        ],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    netCtx = { vaultRoot: netDir, manifest: MANIFEST, graph: netStore } as unknown as Context;
  });

  afterAll(async () => {
    await closeGraph(netStore);
    rmSync(netDir, { recursive: true, force: true });
  });

  it('does not orphan a rule that names a modeled Network with an unmodeled site', async () => {
    const r = await guestExposureReportHandler(netCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    // The Network IS named as holding an unmodeled CustomSite…
    const networkDisclosure = d.disclosures.find((line) =>
      line.includes('reference a CustomSite not modeled'),
    );
    expect(networkDisclosure).toContain('Network:Partner_Net');

    // …so the rule declaring that Network must NOT be reported as matching no
    // Network api name in this vault.
    const orphanIds = (d.orphanGuestRules ?? []).map((o) => o.ruleId);
    expect(orphanIds).toEqual(['SharingRule:Account.Guest_Names_Missing_Site']);
  });

  it('points the remedy at the diagnosed missing CustomSite, not at Setup', async () => {
    const r = await guestExposureReportHandler(netCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const disclosure = r.value.data.disclosures.find((line) =>
      line.includes('could NOT be attributed'),
    );
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain('likelier cause');
    expect(disclosure).toContain('reference a CustomSite this vault does not model');
    expect(disclosure).not.toContain("Confirm each rule's site in Setup");
  });
});

// =============================================================================
// GUEST-EXPOSURE-ANSWERS-FOR-AN-OBJECT-IT-NEVER-FOUND (0.3.3).
//
// The object scope was collected by a hand-rolled alias set and applied as a
// STRING FILTER, with no check that the object exists. Ask
// `{objectApiName: 'Zzz_Nonexistent_Object_9x7__c'}` and every filter matched
// nothing, so the tool returned `findings: []`, `summary.critical: 0` and the
// full confident report shape — a SECURITY answer ("no, the unauthenticated
// internet cannot read this object") about an object it never found. That is
// the unchecked zero wearing a checked zero's clothes the 0.3.2 changelog
// named for `unused_fields_deep`, on the highest-stakes surface this tool has.
// The community half of the same handler ALREADY refused an unresolvable id
// (`component-not-found`); only the object half was silent.
//
// Same case-insensitivity rule as everywhere else: Salesforce api names are
// case-insensitive, so a real object in the wrong case must still ANSWER.
// =============================================================================
describe('guestExposureReportHandler — unresolvable object scope', () => {
  const PHANTOM = 'Zzz_Nonexistent_Object_9x7__c';

  it('refuses an object that exists nowhere in the vault, never reports "no exposure"', async () => {
    const r = await guestExposureReportHandler(ctx, { objectApiName: PHANTOM, limit: 200 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain(PHANTOM);
  });

  it('refuses the same phantom named through objectId / componentId', async () => {
    for (const args of [
      { objectId: `CustomObject:${PHANTOM}` },
      { componentId: `CustomObject:${PHANTOM}` },
    ]) {
      const r = await guestExposureReportHandler(ctx, args);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('invalid-query');
    }
  });

  it('a REAL object in the wrong case still answers, corrected to the vault casing', async () => {
    const lower = await guestExposureReportHandler(ctx, { objectApiName: 'case', limit: 200 });
    const exact = await guestExposureReportHandler(ctx, { objectApiName: 'Case', limit: 200 });
    expect(lower.ok && exact.ok).toBe(true);
    if (!lower.ok || !exact.ok) return;
    // The echo is the VAULT's casing, never the caller's — an appliedScope
    // naming `CustomObject:case` would assert an id this vault does not hold.
    expect(lower.value.data.appliedScope).toEqual({ community: null, object: 'Case', mode: 'object' });
    expect(lower.value.data.findings.map((f) => f.nodeId).sort()).toEqual(
      exact.value.data.findings.map((f) => f.nodeId).sort(),
    );
  });

  it('REGRESSION: the bare org-wide call is untouched by the existence gate', async () => {
    const r = await guestExposureReportHandler(ctx, { limit: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.appliedScope).toEqual({ community: null, object: null, mode: 'all' });
    expect(d.findings.some((f) => f.nodeId === 'CustomObject:Case')).toBe(true);
    expect(d.findings.some((f) => f.nodeId === 'CustomObject:Lead')).toBe(true);
    expect(d.findings.some((f) => f.kind === 'apex-enabled')).toBe(true);
  });
});

// =============================================================================
// GUEST-SHARING-RULE-SCAN-STOPS-AT-ONE-PAGE (R6).
//
// The SharingRule scan was ONE `listNodesByType` page — `ORDER BY id ASC LIMIT
// <cap> OFFSET 0` over the whole type — while CustomSite and Network in the
// same handler were drained window-by-window. Any org whose SharingRule count
// exceeds the per-type cap (routine) had every guest rule past id-rank <cap>
// dropped: no finding, no `orphanGuestRules` row, not in `summary.totalFindings`
// — and the tail was unreachable from ANY call, because `limit`/`offset`/
// `cursor` page `findings` and `orphanOffset` pages the orphan OUTPUT rows.
// Nothing advanced the scan. The `scanTruncated` flag named an answer no caller
// could complete, on the highest-stakes surface this tool has: record-level
// grants to unauthenticated internet visitors.
//
// The cap is env-overridable precisely so this can be exercised without 500+
// fixture nodes. Guest rules are seeded at the id-ASC TAIL, behind a window of
// non-guest rules, so a single-page scan cannot see them.
// =============================================================================
describe('guestExposureReportHandler — the SharingRule scan reaches past the first page', () => {
  const WINDOW = 2;
  let tailStore: GraphStore;
  let tailDir: string;
  let tailCtx: Context;
  let priorLimit: string | undefined;

  const rule = (id: string, ruleType: string) =>
    node({
      id,
      type: 'SharingRule',
      apiName: id.slice('SharingRule:'.length),
      properties: {
        ruleType,
        accessLevel: 'Edit',
        siteName: 'NoSuchSite',
        sObjectType: id.slice('SharingRule:'.length).split('.')[0],
      },
    });

  beforeAll(async () => {
    priorLimit = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = String(WINDOW);
    tailDir = mkdtempSync(join(tmpdir(), 'sfi-guest-scan-tail-'));
    const opened = await openGraph(join(tailDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    tailStore = opened.value;
    const imported = await importExtractionResults(tailStore, [
      {
        nodes: [
          // id-ASC ranks 0..1 — a full first window, and NOT guest rules.
          rule('SharingRule:Account.Criteria_A', 'criteriaBased'),
          rule('SharingRule:Account.Criteria_B', 'criteriaBased'),
          // id-ASC ranks 2..3 — the guest rules, behind the first window.
          rule('SharingRule:Case.Guest_Tail_One', 'guest'),
          rule('SharingRule:Order.Guest_Tail_Two', 'guest'),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    tailCtx = { vaultRoot: tailDir, manifest: MANIFEST, graph: tailStore } as unknown as Context;
  });

  afterAll(async () => {
    await closeGraph(tailStore);
    rmSync(tailDir, { recursive: true, force: true });
    if (priorLimit === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
    else process.env['SFI_NODE_SCAN_LIMIT'] = priorLimit;
  });

  it('finds guest rules that sort BEHIND the first scan window', async () => {
    const r = await guestExposureReportHandler(tailCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect((d.orphanGuestRules ?? []).map((o) => o.ruleId)).toEqual([
      'SharingRule:Case.Guest_Tail_One',
      'SharingRule:Order.Guest_Tail_Two',
    ]);
    expect(d.orphanGuestRulesPage?.totalCount).toBe(2);
    // A criteria rule is not a guest rule — the extra windows must not smuggle
    // non-guest rules into a record-level-exposure bucket.
    expect((d.orphanGuestRules ?? []).some((o) => o.ruleId.includes('Criteria'))).toBe(false);
  });

  // The community corpora had their own walker (`drainType`) until this file
  // adopted the shared helper for all three types. This pins that the swap did
  // not cost them their multi-window reach: a site behind the first window is
  // still audited, not silently dropped from `communities`.
  it('still reaches a CustomSite that sorts BEHIND the first scan window', async () => {
    const siteDir = mkdtempSync(join(tmpdir(), 'sfi-guest-site-tail-'));
    const opened = await openGraph(join(siteDir, 'g.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const site = (name: string) =>
        node({
          id: `CustomSite:${name}`,
          type: 'CustomSite',
          apiName: name,
          label: name,
          properties: {
            active: true,
            siteType: 'Visualforce',
            masterLabel: name,
            guestProfileName: `${name} Profile`,
          },
        });
      const imported = await importExtractionResults(opened.value, [
        { nodes: [site('Aaa_Portal'), site('Bbb_Portal'), site('Zzz_Portal')], edges: [] },
      ]);
      expect(imported.ok).toBe(true);
      const siteCtx = {
        vaultRoot: siteDir,
        manifest: MANIFEST,
        graph: opened.value,
      } as unknown as Context;
      const r = await guestExposureReportHandler(siteCtx, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      expect(d.communities.map((c) => c.communityId)).toEqual([
        'CustomSite:Aaa_Portal',
        'CustomSite:Bbb_Portal',
        'CustomSite:Zzz_Portal',
      ]);
      expect(d.summary.communities).toBe(3);
      expect(d.scanTruncated).toBe(false);
    } finally {
      await closeGraph(opened.value);
      rmSync(siteDir, { recursive: true, force: true });
    }
  });

  it('stops claiming truncation once the type is exhausted, and drops the dead-end note', async () => {
    const r = await guestExposureReportHandler(tailCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The whole type was read across windows, so the count is the org's number
    // — not a floor. `At least N` would now understate what was established.
    expect(d.scanTruncated).toBe(false);
    expect(d.disclosures.some((s) => s.includes('At least'))).toBe(false);
    expect(d.disclosures.some((s) => s.includes('SFI_NODE_SCAN_LIMIT'))).toBe(false);
  });
});
