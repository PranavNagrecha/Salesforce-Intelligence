/// <reference types="vitest/globals" />

/**
 * LANE-D COMMUNITIES — `sfi.community_catalog`.
 *
 * The behaviour under test is the DISTINCTION the product exists to keep: a
 * community whose `selfRegProfile` was READ and found undeclared must not read
 * the same as a community on a vault whose builder never read the element at
 * all. Two separate graph fixtures are seeded for exactly that — one where the
 * Network nodes carry the property key, one where they do not.
 *
 * All names are synthetic.
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
import {
  communityCatalogHandler,
  communityCatalogInputSchema,
} from '../../src/tools/community-catalog.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Network: 2, CustomSite: 3, Profile: 3, PermissionSet: 1 },
  edges: { references: 9 },
  sourceTreeHash: 'sha256:community-fixture',
  coverage: [
    { type: 'Network', requested: true, retrieveConfirmed: true, retrieved: 2, errored: false, neverModeled: false },
    { type: 'CustomSite', requested: true, retrieveConfirmed: true, retrieved: 3, errored: false, neverModeled: false },
    { type: 'Profile', requested: true, retrieveConfirmed: true, retrieved: 3, errored: false, neverModeled: false },
    { type: 'PermissionSet', requested: true, retrieveConfirmed: true, retrieved: 1, errored: false, neverModeled: false },
  ],
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'placeholder',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'network-extractor',
  properties: {},
  ...overrides,
});

// =============================================================================
// Vault A — built by an extractor that DOES read `selfRegProfile`.
//   - MemberPortal: self-registration ON, profile declared AND retrieved.
//   - HandlerPortal: self-registration ON, profile read and found UNDECLARED
//     (a custom Apex registration handler). Its site is NOT retrieved.
//   - PublicDocs: a CustomSite with no Network — a classic Force.com site.
// =============================================================================

const memberPortalSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'Network:MemberPortal',
      type: 'Network',
      apiName: 'MemberPortal',
      label: 'MemberPortal',
      properties: {
        status: 'Live',
        selfRegistration: true,
        selfRegProfile: 'Self Signup User',
        allowInternalUserLogin: true,
        urlPathPrefix: 'members',
        site: 'MemberPortal',
        picassoSite: 'MemberPortal1',
        memberProfiles: ['Staff Profile'],
        memberPermissionSets: ['Reviewer_Access', 'Absent_PermSet'],
      },
    }),
    makeNode({
      id: 'CustomSite:MemberPortal',
      type: 'CustomSite',
      apiName: 'MemberPortal',
      label: 'Member Portal',
      properties: {
        active: true,
        siteType: 'ChatterNetwork',
        masterLabel: 'Member Portal',
        urlPathPrefix: 'members',
        guestProfileName: 'Member Portal Profile',
        guestProfileConvention: 'heuristic',
      },
    }),
    makeNode({ id: 'Profile:Staff Profile', type: 'Profile', apiName: 'Staff Profile' }),
    makeNode({ id: 'Profile:Self Signup User', type: 'Profile', apiName: 'Self Signup User' }),
    makeNode({ id: 'PermissionSet:Reviewer_Access', type: 'PermissionSet', apiName: 'Reviewer_Access' }),
    makeNode({ id: 'VisualforcePage:CommunitiesLogin', type: 'VisualforcePage', apiName: 'CommunitiesLogin' }),
  ],
  edges: [
    makeEdge({
      fromId: 'Network:MemberPortal',
      toId: 'CustomSite:MemberPortal',
      edgeType: 'references',
      properties: { via: 'site' },
    }),
    makeEdge({
      fromId: 'Network:MemberPortal',
      toId: 'Profile:Self Signup User',
      edgeType: 'references',
      properties: { via: 'selfRegProfile' },
    }),
    makeEdge({
      fromId: 'CustomSite:MemberPortal',
      toId: 'VisualforcePage:CommunitiesLogin',
      edgeType: 'references',
      source: 'custom-site-extractor',
      properties: { via: 'authorizationRequiredPage' },
    }),
    // A site reference that is NOT part of the login surface — must be ignored.
    makeEdge({
      fromId: 'CustomSite:MemberPortal',
      toId: 'VisualforcePage:CommunitiesLogin',
      edgeType: 'references',
      source: 'favicon-source',
      properties: { via: 'siteTemplate' },
    }),
  ],
};

const handlerPortalSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'Network:HandlerPortal',
      type: 'Network',
      apiName: 'HandlerPortal',
      label: 'HandlerPortal',
      properties: {
        status: 'UnderConstruction',
        selfRegistration: true,
        // READ and found undeclared — the key is present, the value is null.
        selfRegProfile: null,
        allowInternalUserLogin: null,
        urlPathPrefix: null,
        site: 'HandlerPortalSite',
        picassoSite: null,
        memberProfiles: [],
        memberPermissionSets: [],
      },
    }),
  ],
  edges: [],
};

const publicDocsSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomSite:PublicDocs',
      type: 'CustomSite',
      apiName: 'PublicDocs',
      label: 'Public Docs',
      properties: {
        active: true,
        siteType: 'Visualforce',
        masterLabel: 'Public Docs',
        urlPathPrefix: 'docs',
        guestProfileName: 'Public Docs Profile',
        guestProfileConvention: 'heuristic',
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Vault B — built BEFORE `selfRegProfile` was extracted. Same community shape,
// but the Network node's property bag carries no such key at all.
// =============================================================================

const preExtractionSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'Network:LegacyPortal',
      type: 'Network',
      apiName: 'LegacyPortal',
      label: 'LegacyPortal',
      properties: {
        status: 'Live',
        selfRegistration: true,
        allowInternalUserLogin: false,
        urlPathPrefix: 'legacy',
        site: null,
        picassoSite: null,
        memberProfiles: [],
        memberPermissionSets: [],
      },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

let legacyDir: string;
let legacyStore: GraphStore;
let legacyCtx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-community-'));
  const opened = await openGraph(join(tempDir, 'community.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    memberPortalSeed,
    handlerPortalSeed,
    publicDocsSeed,
  ]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };

  legacyDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-community-legacy-'));
  const openedLegacy = await openGraph(join(legacyDir, 'legacy.db'));
  if (!openedLegacy.ok) throw new Error(`openGraph failed: ${openedLegacy.error.message}`);
  legacyStore = openedLegacy.value;
  const importedLegacy = await importExtractionResults(legacyStore, [preExtractionSeed]);
  if (!importedLegacy.ok) {
    throw new Error(`seed import failed: ${importedLegacy.error.message}`);
  }
  legacyCtx = { vaultRoot: legacyDir, manifest: FIXTURE_MANIFEST, graph: legacyStore };
});

afterAll(async () => {
  await closeGraph(store);
  await closeGraph(legacyStore);
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });
});

describe('communityCatalogHandler — the community inventory', () => {
  it('returns one entry per Network, joined to its CustomSite', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.communities.map((c) => c.networkId)).toEqual([
      'Network:HandlerPortal',
      'Network:MemberPortal',
    ]);
    const portal = d.communities.find((c) => c.networkId === 'Network:MemberPortal')!;
    expect(portal.status).toBe('Live');
    expect(portal.urlPathPrefix).toBe('members');
    expect(portal.site.siteId).toBe('CustomSite:MemberPortal');
    expect(portal.site.modeled).toBe(true);
    expect(portal.site.siteType).toBe('ChatterNetwork');
    expect(portal.site.active).toBe(true);
  });

  it('marks a declared member permission set that was not retrieved as unmodeled, never as absent', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const portal = result.value.data.communities.find(
      (c) => c.networkId === 'Network:MemberPortal',
    )!;
    expect(portal.loginAccess.memberPermissionSets).toEqual([
      {
        componentId: 'PermissionSet:Reviewer_Access',
        apiName: 'Reviewer_Access',
        kind: 'permissionSet',
        modeled: true,
      },
      {
        componentId: 'PermissionSet:Absent_PermSet',
        apiName: 'Absent_PermSet',
        kind: 'permissionSet',
        modeled: false,
      },
    ]);
  });

  it('reports the login surface from the CustomSite reference elements only', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const portal = result.value.data.communities.find(
      (c) => c.networkId === 'Network:MemberPortal',
    )!;
    // `siteTemplate` is a site reference but NOT a login-surface element.
    expect(portal.loginPages).toEqual([
      {
        role: 'login',
        element: 'authorizationRequiredPage',
        pageId: 'VisualforcePage:CommunitiesLogin',
        apiName: 'CommunitiesLogin',
        modeled: true,
      },
    ]);
  });

  it('puts a CustomSite with no Network in its own section, not in communities', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.communities.some((c) => c.site.siteId === 'CustomSite:PublicDocs')).toBe(false);
    expect(d.sitesWithoutCommunity.map((s) => s.siteId)).toEqual(['CustomSite:PublicDocs']);
    expect(d.summary.sitesWithoutCommunity).toBe(1);
  });

  it('counts the three login doors separately in the summary', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.value.data.summary;
    expect(s.totalCommunities).toBe(2);
    expect(s.liveCommunities).toBe(1);
    expect(s.selfRegistrationEnabled).toBe(2);
    expect(s.internalUserLoginAllowed).toBe(1);
  });

  it('discloses a community whose declared site was not retrieved', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const handler = result.value.data.communities.find(
      (c) => c.networkId === 'Network:HandlerPortal',
    )!;
    expect(handler.site.modeled).toBe(false);
    expect(handler.caveats.join(' ')).toContain('CustomSite:HandlerPortalSite');
    expect(handler.loginPages).toEqual([]);
  });

  it('reports an undeclared allowInternalUserLogin as null, never as false', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const handler = result.value.data.communities.find(
      (c) => c.networkId === 'Network:HandlerPortal',
    )!;
    expect(handler.loginAccess.internalUserLogin).toBeNull();
    expect(handler.caveats.join(' ')).toContain('absent, not false');
  });
});

describe('communityCatalogHandler — self-registration, three distinct states', () => {
  it('names the profile a self-registered visitor is created as', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const portal = result.value.data.communities.find(
      (c) => c.networkId === 'Network:MemberPortal',
    )!;
    expect(portal.loginAccess.selfRegistration).toEqual({
      enabled: true,
      grantsProfile: 'Self Signup User',
      grantsProfileId: 'Profile:Self Signup User',
      grantsProfileModeled: true,
      profileDeclared: true,
    });
    expect(portal.caveats).toEqual([]);
  });

  it('says the profile was READ and found undeclared when the key is present but null', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const handler = result.value.data.communities.find(
      (c) => c.networkId === 'Network:HandlerPortal',
    )!;
    expect(handler.loginAccess.selfRegistration.enabled).toBe(true);
    expect(handler.loginAccess.selfRegistration.grantsProfile).toBeNull();
    expect(handler.loginAccess.selfRegistration.profileDeclared).toBe(true);
    expect(handler.caveats.join(' ')).toContain('custom Apex registration handler');
    // The not-extracted wording must NOT appear on a vault that DID look.
    expect(handler.caveats.join(' ')).not.toContain('never read it');
    expect(result.value.data.boundaries.join(' ')).not.toContain('never read it');
  });

  it('says the builder NEVER LOOKED when no Network node carries the key at all', async () => {
    const result = await communityCatalogHandler(legacyCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    const legacy = d.communities[0]!;
    expect(legacy.loginAccess.selfRegistration.enabled).toBe(true);
    expect(legacy.loginAccess.selfRegistration.grantsProfile).toBeNull();
    expect(legacy.loginAccess.selfRegistration.profileDeclared).toBe(false);
    // "did not check", explicitly NOT "checked and found none".
    expect(legacy.caveats.join(' ')).toContain('never read it');
    expect(legacy.caveats.join(' ')).toContain('it is not "no profile"');
    expect(d.boundaries.join(' ')).toContain('never read it');
  });
});

describe('communityCatalogHandler — the unmodeled Builder page tree', () => {
  // This block previously asserted the DEFECT. It required `unproducedEdgeType`
  // — the repo's strongest honesty absolute, "no refresh on any org can ever
  // produce this" — on a condition that does not establish it, and required the
  // per-community note to say the gap "cannot be resolved by re-running a
  // refresh". `builderTreeUnmodeled` is set whenever a Network declares
  // `picassoSite` and `ExperienceBundle:{picassoSite}` is absent, which is the
  // CLOSABLE case: ExperienceBundle is a supported ComponentType. The handler
  // has no LWR / DigitalExperienceBundle detection, so it cannot tell the two
  // apart — and telling an operator a refresh is futile steers them away from
  // the one action that would work.
  it('names BOTH causes and does not claim a refresh would fail', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    const portal = d.communities.find((c) => c.networkId === 'Network:MemberPortal')!;
    expect(portal.builderPageTree.declaredBundle).toBe('MemberPortal1');
    expect(portal.builderPageTree.modeled).toBe(false);
    // Both causes named, neither asserted.
    expect(portal.builderPageTree.note).toContain('ExperienceBundle');
    expect(portal.builderPageTree.note).toContain('DigitalExperienceBundle');
    expect(portal.builderPageTree.note).toContain('cannot be told from this vault');
    // The closable half must be reachable, not denied.
    expect(portal.builderPageTree.note).toContain('a refresh CAN close');
    expect(portal.builderPageTree.note).not.toContain('cannot be resolved by re-running');
  });

  it('never asserts the unproducible absolute for the page tree', async () => {
    for (const c of [ctx, legacyCtx]) {
      const result = await communityCatalogHandler(c, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        (result.value.data as unknown as Record<string, unknown>)['unproducedEdgeType'],
      ).toBeUndefined();
    }
  });
});

describe('communityCatalogHandler — scope', () => {
  it('scopes to one community by componentId and echoes appliedScope', async () => {
    const result = await communityCatalogHandler(ctx, {
      componentId: 'Network:MemberPortal',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.communities.map((c) => c.networkId)).toEqual(['Network:MemberPortal']);
    expect(d.appliedScope).toEqual({
      componentId: 'Network:MemberPortal',
      mode: 'community',
    });
  });

  it('HONORS every advertised community alias instead of silently stripping it', async () => {
    // The defect this guards: an argument the schema does not declare is
    // stripped by zod, and the tool answers ORG-WIDE to a SCOPED question.
    for (const args of [
      { communityId: 'Network:MemberPortal' },
      { networkName: 'MemberPortal' },
      { siteApiName: 'MemberPortal' },
    ]) {
      const result = await communityCatalogHandler(ctx, args);
      expect(result.ok, JSON.stringify(args)).toBe(true);
      if (!result.ok) continue;
      expect(result.value.data.communities.map((c) => c.networkId), JSON.stringify(args)).toEqual([
        'Network:MemberPortal',
      ]);
      expect(result.value.data.appliedScope, JSON.stringify(args)).toBeDefined();
    }
  });

  it('names BOTH culprits when two aliases disagree', async () => {
    const result = await communityCatalogHandler(ctx, {
      communityId: 'Network:MemberPortal',
      siteApiName: 'HandlerPortalSite',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('communityId');
    expect(result.error.message).toContain('siteApiName');
  });

  it('REFUSES a communityId carrying a non-community prefix', async () => {
    const result = await communityCatalogHandler(ctx, {
      communityId: 'CustomObject:Contact',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('communityId');
  });

  it('scopes by the bare networkApiName alias', async () => {
    const result = await communityCatalogHandler(ctx, { networkApiName: 'MemberPortal' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.communities.map((c) => c.networkId)).toEqual([
      'Network:MemberPortal',
    ]);
  });

  it('omits appliedScope on the org-wide default so the response stays byte-identical', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.appliedScope).toBeUndefined();
  });

  it('REFUSES disagreeing selectors instead of picking one', async () => {
    const result = await communityCatalogHandler(ctx, {
      componentId: 'Network:MemberPortal',
      networkApiName: 'HandlerPortal',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('different communities');
  });

  it('REFUSES an SObject scope instead of silently answering org-wide', async () => {
    const result = await communityCatalogHandler(ctx, { objectApiName: 'Contact' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('cannot be scoped to an SObject');
  });

  it('REFUSES a componentId that is not a community id', async () => {
    const result = await communityCatalogHandler(ctx, {
      componentId: 'ApexClass:AccountService',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for a community id absent from the vault', async () => {
    const result = await communityCatalogHandler(ctx, {
      componentId: 'Network:NotHere',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });
});

describe('communityCatalogHandler — always-on honesty surface', () => {
  it('never presents declared member grants as a user list', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const joined = result.value.data.boundaries.join(' ');
    expect(joined).toContain('not a user list');
    expect(joined).toContain('sfi.live_license_usage');
  });

  it('flags the guest linkage as heuristic and delegates the guest question', async () => {
    const result = await communityCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const portal = result.value.data.communities.find(
      (c) => c.networkId === 'Network:MemberPortal',
    )!;
    expect(portal.loginAccess.guestProfile).toEqual({
      apiName: 'Member Portal Profile',
      componentId: 'Profile:Member Portal Profile',
      modeled: false,
      linkage: 'heuristic',
    });
    expect(result.value.data.boundaries.join(' ')).toContain('sfi.guest_exposure_report');
  });
});

describe('communityCatalogInputSchema', () => {
  it('accepts an empty object (the org-wide default)', () => {
    expect(communityCatalogInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects an empty componentId string', () => {
    expect(communityCatalogInputSchema.safeParse({ componentId: '' }).success).toBe(false);
  });
});
