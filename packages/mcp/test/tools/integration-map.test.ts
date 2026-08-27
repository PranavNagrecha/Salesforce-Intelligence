/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
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
  integrationMapHandler,
  integrationMapInputSchema,
} from '../../src/tools/integration-map.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    AuthProvider: 2,
    NamedCredential: 2,
    RemoteSiteSetting: 1,
    CspTrustedSite: 1,
    ExternalDataSource: 1,
    ExternalService: 1,
    ConnectedApp: 1,
    NetworkAccess: 1,
  },
  edges: { references: 2 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/properties. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'AuthProvider',
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

/** Default edge-shape helper. Caller overrides fromId/toId/edgeType. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: A full integration topology — two AuthProviders, two NamedCredentials,
// one ExternalDataSource referencing AuthProvider, one ExternalService
// referencing NamedCredential, plus a RemoteSiteSetting, CspTrustedSite,
// ConnectedApp, and NetworkAccess. The references edges form the connected
// integration sub-graph the tool is supposed to surface.
// =============================================================================

const AUTH_OKTA = 'AuthProvider:Okta';
const AUTH_GOOGLE = 'AuthProvider:Google';
const NC_EXT_API = 'NamedCredential:ExternalApi';
const NC_DATAWAREHOUSE = 'NamedCredential:Datawarehouse';
const RSS_INTERNAL = 'RemoteSiteSetting:Internal_API';
const CSP_CDN = 'CspTrustedSite:Cdn_Provider';
const EDS_ORDERS = 'ExternalDataSource:Orders';
const ES_TRACKING = 'ExternalService:OrderTracking';
const CA_PORTAL = 'ConnectedApp:Customer_Portal';
const NA_OFFICE = 'NetworkAccess:HQ_Office';

const fullTopologySeed: ExtractionResult = {
  nodes: [
    makeNode({ id: AUTH_OKTA, type: 'AuthProvider', apiName: 'Okta', label: 'Okta SSO' }),
    makeNode({ id: AUTH_GOOGLE, type: 'AuthProvider', apiName: 'Google' }),
    makeNode({
      id: NC_EXT_API,
      type: 'NamedCredential',
      apiName: 'ExternalApi',
      properties: { url: 'https://api.example.com' },
    }),
    makeNode({
      id: NC_DATAWAREHOUSE,
      type: 'NamedCredential',
      apiName: 'Datawarehouse',
    }),
    makeNode({
      id: RSS_INTERNAL,
      type: 'RemoteSiteSetting',
      apiName: 'Internal_API',
      properties: { url: 'https://internal.example.com' },
    }),
    makeNode({
      id: CSP_CDN,
      type: 'CspTrustedSite',
      apiName: 'Cdn_Provider',
      properties: { endpointUrl: 'https://cdn.example.com' },
    }),
    makeNode({
      id: EDS_ORDERS,
      type: 'ExternalDataSource',
      apiName: 'Orders',
      properties: { type: 'OData' },
    }),
    makeNode({
      id: ES_TRACKING,
      type: 'ExternalService',
      apiName: 'OrderTracking',
    }),
    makeNode({
      id: CA_PORTAL,
      type: 'ConnectedApp',
      apiName: 'Customer_Portal',
    }),
    makeNode({
      id: NA_OFFICE,
      type: 'NetworkAccess',
      apiName: 'HQ_Office',
      properties: { startIpAddress: '203.0.113.0', endIpAddress: '203.0.113.255' },
    }),
  ],
  edges: [
    // EDS_ORDERS references AUTH_OKTA via the dataSource's authProvider.
    makeEdge({
      fromId: EDS_ORDERS,
      toId: AUTH_OKTA,
      edgeType: 'references',
      properties: { role: 'authProvider' },
    }),
    // ES_TRACKING references NC_EXT_API via the externalService's named credential.
    makeEdge({
      fromId: ES_TRACKING,
      toId: NC_EXT_API,
      edgeType: 'references',
      properties: { role: 'namedCredential' },
    }),
    // EDS_ORDERS also references a non-integration CustomObject — must be
    // filtered out of the cross-type references list.
    makeEdge({
      fromId: EDS_ORDERS,
      toId: 'CustomObject:Order__x',
      edgeType: 'references',
      properties: { role: 'externalObject' },
    }),
  ],
};

// =============================================================================
// Seed 2: an unrelated CustomObject + ApexClass to verify the tool does NOT
// surface non-integration nodes. The fact that the graph contains other nodes
// must not pollute the integration map.
// =============================================================================

const unrelatedSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account_Solo',
      type: 'CustomObject',
      apiName: 'Account_Solo',
    }),
    makeNode({
      id: 'ApexClass:Unrelated',
      type: 'ApexClass',
      apiName: 'Unrelated',
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 3: a many-AuthProviders graph to verify the per-category limit cap. Five
// AuthProviders with IDs that sort lexicographically to easy-to-verify slices.
// =============================================================================

const MANY_AUTH_IDS = [
  'AuthProvider:A_Provider',
  'AuthProvider:B_Provider',
  'AuthProvider:C_Provider',
  'AuthProvider:D_Provider',
  'AuthProvider:E_Provider',
];

const manyAuthSeed: ExtractionResult = {
  nodes: MANY_AUTH_IDS.map((id) =>
    makeNode({
      id,
      type: 'AuthProvider',
      apiName: id.replace('AuthProvider:', ''),
    }),
  ),
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-integration-map-'));
  const dbPath = join(tempDir, 'integration-map.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('integrationMapHandler (empty graph)', () => {
  it('returns empty arrays for every category when the graph is empty', async () => {
    // No seeding done yet — the graph is empty at this point in the suite.
    const result = await integrationMapHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.authProviders).toEqual([]);
    expect(d.namedCredentials).toEqual([]);
    expect(d.remoteSiteSettings).toEqual([]);
    expect(d.cspTrustedSites).toEqual([]);
    expect(d.externalDataSources).toEqual([]);
    expect(d.externalServices).toEqual([]);
    expect(d.connectedApps).toEqual([]);
    expect(d.networkAccesses).toEqual([]);
    expect(d.references).toEqual([]);
    // The OmniStudio outbound surface is empty too (no IPs seeded yet).
    expect(d.omniStudio.restCallouts).toEqual([]);
    expect(d.omniStudio.remoteCallouts).toEqual([]);
    expect(d.omniStudio.referencedNamedCredentials).toEqual([]);
    // Honest-empty: a note distinguishes "no integration metadata in this
    // vault" from a broken/empty-looking tool. Fires only when BOTH the
    // classic buckets AND the OmniStudio surface are empty.
    expect(d.note).toBeDefined();
    // vaultState comes from the manifest.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  // ===========================================================================
  // TYPED-ABSENCE-INTEGRATION-MAP. Every one of the arrays asserted above used
  // to ship as a bare `[]`, and `boundaries` — this codebase's dominant honesty
  // vocabulary — shipped empty beside them. A caller reading that payload would
  // have concluded "this org declares no integration surface". On this fixture
  // the truth is that NOTHING was checked: the manifest carries no coverage row
  // for any integration family, so it cannot even say the retrieve requested
  // them.
  // ===========================================================================
  it('classifies each empty list on its own evidence, not with one blanket stamp', async () => {
    const result = await integrationMapHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const absence = result.value.data.absence;
    expect(absence).toBeDefined();
    if (absence === undefined) return;
    expect(absence.status).toBe('not-checked');

    const byPath = new Map(absence.sites.map((site) => [site.path, site]));
    // The eight category buckets: unconfirmed retrieve, so NOT checked.
    for (const path of [
      'authProviders',
      'namedCredentials',
      'remoteSiteSettings',
      'cspTrustedSites',
      'externalDataSources',
      'externalServices',
      'connectedApps',
      'networkAccesses',
    ]) {
      expect(byPath.get(path)?.kind).toBe('family-unconfirmed');
      expect(byPath.get(path)?.status).toBe('not-checked');
    }
    // A DERIVED list gets its own kind — there was no node to walk edges from.
    expect(byPath.get('references')?.kind).toBe('no-subjects-scanned');
    // And the self-describing meta-list is genuinely checked-empty: it is
    // computed in this call from row counts already in hand, so there is no
    // "not retrieved" reading of it at all. This is the assertion that fails
    // if the fifteen lists are ever stamped uniformly to make a gate go green.
    expect(byPath.get('truncatedCategories')?.kind).toBe('checked-empty');
    expect(byPath.get('truncatedCategories')?.status).toBe('proven-none');
    expect(new Set(absence.sites.map((site) => site.kind)).size).toBeGreaterThan(1);
  });

  it('fills `boundaries` with the not-checked verdict instead of shipping it empty', async () => {
    const result = await integrationMapHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.boundaries;
    expect(boundaries.length).toBeGreaterThan(0);
    expect(boundaries.join(' ')).toContain('authProviders');
    // `boundaries` is no longer empty, so it must NOT be listed as an empty
    // list — the payload may not contradict itself.
    expect(
      result.value.data.absence?.sites.some((site) => site.path === 'boundaries'),
    ).toBe(false);
  });
});

describe('integrationMapHandler (full topology)', () => {
  beforeAll(async () => {
    const imported = await importExtractionResults(store, [
      fullTopologySeed,
      unrelatedSeed,
      manyAuthSeed,
    ]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  it("populates every category with the seeded nodes when filter='all'", async () => {
    const result = await integrationMapHandler(ctx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // AuthProviders includes the topology-seed pair plus the five
    // many-auth-seed entries.
    const authIds = d.authProviders.map((n) => n.id);
    expect(authIds).toContain(AUTH_OKTA);
    expect(authIds).toContain(AUTH_GOOGLE);
    // NamedCredentials.
    expect(d.namedCredentials.map((n) => n.id)).toEqual(
      expect.arrayContaining([NC_EXT_API, NC_DATAWAREHOUSE]),
    );
    expect(d.remoteSiteSettings.map((n) => n.id)).toEqual([RSS_INTERNAL]);
    expect(d.cspTrustedSites.map((n) => n.id)).toEqual([CSP_CDN]);
    expect(d.externalDataSources.map((n) => n.id)).toEqual([EDS_ORDERS]);
    expect(d.externalServices.map((n) => n.id)).toEqual([ES_TRACKING]);
    expect(d.connectedApps.map((n) => n.id)).toEqual([CA_PORTAL]);
    expect(d.networkAccesses.map((n) => n.id)).toEqual([NA_OFFICE]);
  });

  // GUARD (INTEGRATION-MAP-IGNORES-OBJECT-SCOPE): pre-fix an object scope was
  // Zod-stripped, so Contact / Opportunity / bare all returned the SAME whole-org
  // catalog. Post-fix the bare call succeeds with `appliedScope.mode: 'all'`, and
  // ANY object / component scope key is refused (never silently answered).
  it('bare call echoes org-wide appliedScope; an object scope is refused', async () => {
    const bare = await integrationMapHandler(ctx, {});
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.value.data.appliedScope).toEqual({ object: null, mode: 'all' });

    for (const scoped of [
      { objectApiName: 'Contact' },
      { objectApiName: 'Opportunity' },
      { object: 'Contact' },
      { objectId: 'CustomObject:Contact' },
      { componentId: 'CustomObject:Contact' },
    ]) {
      const parsed = integrationMapInputSchema.safeParse(scoped);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const r = await integrationMapHandler(ctx, parsed.data);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe('invalid-query');
      expect(r.error.message).toMatch(/org-wide|find_code_usages|endpoint_catalog/);
    }
  });

  it('returns the cross-type references edges connecting integration nodes', async () => {
    const result = await integrationMapHandler(ctx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refs = result.value.data.references;
    // The two integration-to-integration edges must surface.
    const edgeKeys = refs.map((e) => `${e.fromId}|${e.toId}|${e.role ?? ''}`);
    expect(edgeKeys).toContain(`${EDS_ORDERS}|${AUTH_OKTA}|authProvider`);
    expect(edgeKeys).toContain(`${ES_TRACKING}|${NC_EXT_API}|namedCredential`);
    // The CustomObject reference must NOT surface — it points outside the
    // integration surface set.
    expect(edgeKeys.some((k) => k.includes('CustomObject:'))).toBe(false);
  });

  it('does not include unrelated CustomObject / ApexClass nodes', async () => {
    const result = await integrationMapHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const allIds = [
      ...result.value.data.authProviders,
      ...result.value.data.namedCredentials,
      ...result.value.data.remoteSiteSettings,
      ...result.value.data.cspTrustedSites,
      ...result.value.data.externalDataSources,
      ...result.value.data.externalServices,
      ...result.value.data.connectedApps,
      ...result.value.data.networkAccesses,
    ].map((n) => n.id);
    expect(allIds).not.toContain('CustomObject:Account_Solo');
    expect(allIds).not.toContain('ApexClass:Unrelated');
  });

  it("returns only AuthProvider + ConnectedApp when filter='auth'", async () => {
    const result = await integrationMapHandler(ctx, { filter: 'auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // AuthProvider + ConnectedApp are populated; everything else is empty.
    expect(d.authProviders.length).toBeGreaterThan(0);
    expect(d.connectedApps.length).toBe(1);
    expect(d.namedCredentials).toEqual([]);
    expect(d.remoteSiteSettings).toEqual([]);
    expect(d.cspTrustedSites).toEqual([]);
    expect(d.externalDataSources).toEqual([]);
    expect(d.externalServices).toEqual([]);
    expect(d.networkAccesses).toEqual([]);
  });

  it("returns RemoteSiteSetting + CspTrustedSite + NetworkAccess when filter='sites'", async () => {
    const result = await integrationMapHandler(ctx, { filter: 'sites' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.remoteSiteSettings.map((n) => n.id)).toEqual([RSS_INTERNAL]);
    expect(d.cspTrustedSites.map((n) => n.id)).toEqual([CSP_CDN]);
    expect(d.networkAccesses.map((n) => n.id)).toEqual([NA_OFFICE]);
    // Other categories scoped out.
    expect(d.authProviders).toEqual([]);
    expect(d.namedCredentials).toEqual([]);
    expect(d.externalDataSources).toEqual([]);
    expect(d.externalServices).toEqual([]);
    expect(d.connectedApps).toEqual([]);
  });

  it("returns ExternalDataSource + ExternalService when filter='sources'", async () => {
    const result = await integrationMapHandler(ctx, { filter: 'sources' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.externalDataSources.map((n) => n.id)).toEqual([EDS_ORDERS]);
    expect(d.externalServices.map((n) => n.id)).toEqual([ES_TRACKING]);
    expect(d.authProviders).toEqual([]);
    expect(d.namedCredentials).toEqual([]);
  });

  it("returns ExternalDataSource + ExternalService when filter='services' (synonym for sources)", async () => {
    const result = await integrationMapHandler(ctx, { filter: 'services' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.externalDataSources.map((n) => n.id)).toEqual([EDS_ORDERS]);
    expect(d.externalServices.map((n) => n.id)).toEqual([ES_TRACKING]);
  });

  it("returns NamedCredential + AuthProvider + NetworkAccess when filter='access'", async () => {
    const result = await integrationMapHandler(ctx, { filter: 'access' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.namedCredentials.length).toBeGreaterThan(0);
    expect(d.authProviders.length).toBeGreaterThan(0);
    expect(d.networkAccesses.map((n) => n.id)).toEqual([NA_OFFICE]);
    expect(d.connectedApps).toEqual([]);
    expect(d.remoteSiteSettings).toEqual([]);
  });

  it('sorts every node array by id ASC for determinism', async () => {
    const result = await integrationMapHandler(ctx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const authIds = result.value.data.authProviders.map((n) => n.id);
    const sorted = [...authIds].sort();
    expect(authIds).toEqual(sorted);
    const ncIds = result.value.data.namedCredentials.map((n) => n.id);
    expect(ncIds).toEqual([...ncIds].sort());
  });

  it('caps RETURNED rows per category at `limit` and discloses the trim', async () => {
    // G2: `limit` no longer splits a budget eight ways (it used to be
    // ceil(8/8)=1 per category here). It caps the rows RETURNED per category,
    // and anything trimmed is named with its TRUE total.
    const result = await integrationMapHandler(ctx, { filter: 'all', limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // AuthProvider has 7 nodes (2 topology + 5 many-auth).
    expect(d.authProviders.length).toBe(3);
    expect(d.truncatedCategories).toContainEqual({
      type: 'AuthProvider',
      returned: 3,
      total: 7,
    });
    expect(d.boundaries.join(' ')).toContain('AuthProvider 3 of 7');
  });

  it('reports no truncation when every category fits under `limit`', async () => {
    const result = await integrationMapHandler(ctx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.truncatedCategories).toEqual([]);
    // The assertion here USED to be `boundaries === []`, which only held
    // because `boundaries` carried the payload-trim sentence and nothing else.
    // It now also carries the typed-absence verdict, so the trim assertion is
    // stated directly rather than by proxy: no boundary names a trim or a cap.
    const boundaries = result.value.data.boundaries;
    expect(boundaries.some((b) => /Returned rows capped at limit=/.test(b))).toBe(false);
    expect(boundaries.some((b) => /of 7/.test(b))).toBe(false);
  });

  it('returns label normalised to a string (empty string when null)', async () => {
    const result = await integrationMapHandler(ctx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // AUTH_GOOGLE has a null label; the map node should expose '' not null.
    const google = result.value.data.authProviders.find((n) => n.id === AUTH_GOOGLE);
    expect(google?.label).toBe('');
    // AUTH_OKTA has a label.
    const okta = result.value.data.authProviders.find((n) => n.id === AUTH_OKTA);
    expect(okta?.label).toBe('Okta SSO');
  });

  it('passes node properties through verbatim', async () => {
    const result = await integrationMapHandler(ctx, { filter: 'access' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const officeAccess = result.value.data.networkAccesses.find(
      (n) => n.id === NA_OFFICE,
    );
    expect(officeAccess?.properties['startIpAddress']).toBe('203.0.113.0');
    expect(officeAccess?.properties['endIpAddress']).toBe('203.0.113.255');
  });
});

// =============================================================================
// OmniStudio-only org: zero classic integration ComponentTypes, but an
// Integration Procedure that calls external systems via Rest / Remote actions.
// This is the regression scenario — such an org used to report "No integration
// metadata found" with 0 outbound endpoints. Uses its OWN store so it is
// independent of the shared-suite seeding order above.
// =============================================================================

const IP_OMNI_ONLY = 'OmniIntegrationProcedure:Customer_Sync_Procedure_1';

const omniOnlySeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: IP_OMNI_ONLY,
      type: 'OmniIntegrationProcedure',
      apiName: 'Customer_Sync_Procedure_1',
      properties: {
        omniProcessType: 'Integration Procedure',
        restEndpointCount: 1,
        restEndpoints: [
          {
            stepName: 'PushCustomer',
            path: '/services/data/v58.0/sobjects/Customer',
            method: 'POST',
            namedCredential: 'callout:CRM_NC',
          },
        ],
        remoteActions: [
          { stepName: 'Recalc', remoteClass: 'PricingEngine', remoteMethod: 'run' },
        ],
      },
    }),
  ],
  edges: [],
};

describe('integrationMapHandler (OmniStudio-only org)', () => {
  let omniDir: string;
  let omniStore: GraphStore;
  let omniCtx: Context;

  beforeAll(async () => {
    omniDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-integration-map-omni-'));
    const opened = await openGraph(join(omniDir, 'omni.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    omniStore = opened.value;
    const imported = await importExtractionResults(omniStore, [omniOnlySeed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    omniCtx = {
      vaultRoot: omniDir,
      manifest: FIXTURE_MANIFEST,
      graph: omniStore,
    };
  });

  afterAll(async () => {
    await closeGraph(omniStore);
    rmSync(omniDir, { recursive: true, force: true });
  });

  it('does NOT report "No integration metadata found" when an IP has callouts', async () => {
    const result = await integrationMapHandler(omniCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every classic bucket is empty, but the OmniStudio surface is not —
    // so the honest-empty note must be ABSENT.
    expect(result.value.data.note).toBeUndefined();
  });

  it('surfaces the IP REST callout + named credential in the omniStudio section', async () => {
    const result = await integrationMapHandler(omniCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const omni = result.value.data.omniStudio;
    expect(omni.restCallouts).toEqual([
      {
        sourceComponentId: IP_OMNI_ONLY,
        stepName: 'PushCustomer',
        path: '/services/data/v58.0/sobjects/Customer',
        method: 'POST',
        namedCredential: 'callout:CRM_NC',
      },
    ]);
    expect(omni.referencedNamedCredentials).toEqual(['callout:CRM_NC']);
  });

  it('surfaces the IP Remote callout in the omniStudio section', async () => {
    const result = await integrationMapHandler(omniCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.omniStudio.remoteCallouts).toEqual([
      {
        sourceComponentId: IP_OMNI_ONLY,
        stepName: 'Recalc',
        remoteClass: 'PricingEngine',
        remoteMethod: 'run',
      },
    ]);
  });

  it('still surfaces the OmniStudio surface under the sources/access filters', async () => {
    for (const filter of ['sources', 'access'] as const) {
      const result = await integrationMapHandler(omniCtx, { filter });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.omniStudio.restCallouts.length).toBe(1);
      expect(result.value.data.note).toBeUndefined();
    }
  });

  it('omits the OmniStudio surface (empty) under the auth / sites filters', async () => {
    // The pure auth / allowlist cuts keep their narrow classic scope: the
    // OmniStudio surface is out of scope, so it comes back empty AND — with
    // no classic nodes either — the honest-empty note fires.
    for (const filter of ['auth', 'sites'] as const) {
      const result = await integrationMapHandler(omniCtx, { filter });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.omniStudio.restCallouts).toEqual([]);
      expect(result.value.data.omniStudio.remoteCallouts).toEqual([]);
      expect(result.value.data.note).toBeDefined();
    }
  });
});

// =============================================================================
// Callout-authorization scenario: an org whose outbound HTTP callouts are
// authorized by ACTIVE RemoteSiteSettings (hardcoded-URL Apex callouts), plus
// one referenced NamedCredential (wired via an ExternalService) and one
// ORPHANED NamedCredential (present but nothing references it — the
// "AWS_US_East_1 is unused" shape). The tool must surface the orphan AND emit
// a grounded calloutAuthorizationNote instead of abstaining with a coverage gap.
// Uses its OWN store so it is independent of the shared-suite seeding order.
// =============================================================================

const RSS_MARKETO_REST = 'RemoteSiteSetting:Marketo_Prod';
const RSS_MARKETO_SOAP = 'RemoteSiteSetting:MarketoSoapAPI';
const NC_REFERENCED = 'NamedCredential:Google_Site';
const NC_ORPHAN = 'NamedCredential:AcmeCloud_US_East_1';
const ES_USES_NC = 'ExternalService:DirectorySync';

const calloutAuthSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: RSS_MARKETO_REST,
      type: 'RemoteSiteSetting',
      apiName: 'Marketo_Prod',
      properties: { url: 'https://example.mktorest.com', isActive: true },
    }),
    makeNode({
      id: RSS_MARKETO_SOAP,
      type: 'RemoteSiteSetting',
      apiName: 'MarketoSoapAPI',
      properties: { url: 'https://example.mktoapi.com', isActive: true },
    }),
    makeNode({
      id: NC_REFERENCED,
      type: 'NamedCredential',
      apiName: 'Google_Site',
      properties: { url: 'https://www.googleapis.com' },
    }),
    makeNode({
      id: NC_ORPHAN,
      type: 'NamedCredential',
      apiName: 'AcmeCloud_US_East_1',
      properties: {
        endpoint: 'arn:aws:US-EAST-1:000000000000',
        protocol: 'NoAuthentication',
      },
    }),
    makeNode({
      id: ES_USES_NC,
      type: 'ExternalService',
      apiName: 'DirectorySync',
    }),
  ],
  edges: [
    // The ExternalService references the Google_Site NamedCredential — so it
    // is NOT orphaned. AcmeCloud_US_East_1 has ZERO inbound references.
    makeEdge({
      fromId: ES_USES_NC,
      toId: NC_REFERENCED,
      edgeType: 'references',
      properties: { role: 'namedCredential' },
    }),
  ],
};

describe('integrationMapHandler (callout authorization + orphaned named credential)', () => {
  let authDir: string;
  let authStore: GraphStore;
  let authCtx: Context;

  beforeAll(async () => {
    authDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-integration-map-auth-'));
    const opened = await openGraph(join(authDir, 'auth.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    authStore = opened.value;
    const imported = await importExtractionResults(authStore, [calloutAuthSeed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    authCtx = { vaultRoot: authDir, manifest: FIXTURE_MANIFEST, graph: authStore };
  });

  afterAll(async () => {
    await closeGraph(authStore);
    rmSync(authDir, { recursive: true, force: true });
  });

  it('flags the unreferenced NamedCredential as orphaned (referenceCount 0)', async () => {
    const result = await integrationMapHandler(authCtx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const orphan = result.value.data.namedCredentials.find((n) => n.id === NC_ORPHAN);
    expect(orphan).toBeDefined();
    expect(orphan?.orphaned).toBe(true);
    expect(orphan?.referenceCount).toBe(0);
  });

  it('does NOT flag the referenced NamedCredential as orphaned', async () => {
    const result = await integrationMapHandler(authCtx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const referenced = result.value.data.namedCredentials.find(
      (n) => n.id === NC_REFERENCED,
    );
    expect(referenced).toBeDefined();
    expect(referenced?.orphaned).toBe(false);
    expect(referenced?.referenceCount).toBe(1);
  });

  it('emits a grounded calloutAuthorizationNote naming the active RemoteSiteSettings', async () => {
    const result = await integrationMapHandler(authCtx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const note = result.value.data.calloutAuthorizationNote;
    expect(note).toBeDefined();
    // The grounded answer names the present RemoteSiteSettings as the
    // authorizers of hardcoded-URL outbound callouts — not an abstention.
    expect(note).toContain('Marketo_Prod');
    expect(note).toContain('MarketoSoapAPI');
    // It distinguishes the referenced vs orphaned named credentials.
    expect(note).toContain('Google_Site');
    expect(note).toContain('AcmeCloud_US_East_1');
    // It must NOT claim the components are absent / a coverage gap.
    expect(note.toLowerCase()).not.toContain("doesn't contain");
    expect(note.toLowerCase()).not.toContain('not found');
  });
});

// =============================================================================
// Finding #44 — martech connectors: an InstalledPackage node whose namespace
// matches a known martech vendor (Marketing Cloud Connect's `et4ae5`), an
// unrelated InstalledPackage that must NOT match (a negative control), and a
// NamedCredential whose declared endpoint host matches the Marketo hostname
// heuristic. Uses its OWN store so it is independent of the shared-suite
// seeding order above.
// =============================================================================

const PKG_MARKETING_CLOUD_CONNECT = 'InstalledPackage:et4ae5';
const PKG_UNRELATED_ISV = 'InstalledPackage:hed';
const NC_MARKETO_ENDPOINT = 'NamedCredential:Marketo_Prod_NC';
// INTEGRATION-MAP-MARTECH-IGNORES-REMOTE-SITE-HOSTS witnesses: an Active Marketo
// RemoteSiteSetting (the pre-NamedCredential callout pattern), an INACTIVE
// Marketo RemoteSiteSetting (must not classify — dead metadata), and an Active
// non-martech RemoteSiteSetting (negative control).
const RSS_MARKETO_ACTIVE = 'RemoteSiteSetting:MarketoSoapAPI';
const RSS_MARKETO_INACTIVE = 'RemoteSiteSetting:Marketo_Legacy_Off';
const RSS_NONMARTECH_ACTIVE = 'RemoteSiteSetting:Internal_SF';

const martechSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PKG_MARKETING_CLOUD_CONNECT,
      type: 'InstalledPackage',
      apiName: 'et4ae5',
      label: 'et4ae5',
      properties: { namespace: 'et4ae5', versionNumber: '20.3' },
    }),
    makeNode({
      id: PKG_UNRELATED_ISV,
      type: 'InstalledPackage',
      apiName: 'hed',
      label: 'hed',
      properties: { namespace: 'hed', versionNumber: '5.1' },
    }),
    makeNode({
      id: NC_MARKETO_ENDPOINT,
      type: 'NamedCredential',
      apiName: 'Marketo_Prod_NC',
      properties: { endpoint: 'https://example.mktorest.com' },
    }),
    makeNode({
      id: RSS_MARKETO_ACTIVE,
      type: 'RemoteSiteSetting',
      apiName: 'MarketoSoapAPI',
      properties: { url: 'https://example.mktoapi.com', isActive: true },
    }),
    makeNode({
      id: RSS_MARKETO_INACTIVE,
      type: 'RemoteSiteSetting',
      apiName: 'Marketo_Legacy_Off',
      properties: { url: 'https://legacy.mktorest.com', isActive: false },
    }),
    makeNode({
      id: RSS_NONMARTECH_ACTIVE,
      type: 'RemoteSiteSetting',
      apiName: 'Internal_SF',
      properties: { url: 'https://internal.my.salesforce.com', isActive: true },
    }),
  ],
  edges: [],
};

describe('integrationMapHandler (martech connectors — Finding #44)', () => {
  let martechDir: string;
  let martechStore: GraphStore;
  let martechCtx: Context;

  beforeAll(async () => {
    martechDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-integration-map-martech-'));
    const opened = await openGraph(join(martechDir, 'martech.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    martechStore = opened.value;
    const imported = await importExtractionResults(martechStore, [martechSeed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    martechCtx = { vaultRoot: martechDir, manifest: FIXTURE_MANIFEST, graph: martechStore };
  });

  afterAll(async () => {
    await closeGraph(martechStore);
    rmSync(martechDir, { recursive: true, force: true });
  });

  it('surfaces the InstalledPackage namespace match with the friendly product name', async () => {
    const result = await integrationMapHandler(martechCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const match = result.value.data.martechConnectors.find(
      (m) => m.componentId === PKG_MARKETING_CLOUD_CONNECT,
    );
    expect(match).toBeDefined();
    expect(match?.productName).toBe('Marketing Cloud Connect');
    expect(match?.vendor).toBe('Salesforce');
    expect(match?.source).toBe('installed-package');
    expect(match?.confidence).toBe('declared');
  });

  it('does not flag an unrelated InstalledPackage namespace as a martech connector', async () => {
    const result = await integrationMapHandler(martechCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.martechConnectors.map((m) => m.componentId);
    expect(ids).not.toContain(PKG_UNRELATED_ISV);
  });

  it('surfaces a NamedCredential endpoint match against the Marketo hostname heuristic', async () => {
    const result = await integrationMapHandler(martechCtx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const match = result.value.data.martechConnectors.find(
      (m) => m.componentId === NC_MARKETO_ENDPOINT,
    );
    expect(match).toBeDefined();
    expect(match?.productName).toBe('Marketo');
    expect(match?.source).toBe('named-credential-endpoint');
    expect(match?.confidence).toBe('heuristic');
  });

  it('always includes a non-empty martechConnectorDisclosure', async () => {
    const result = await integrationMapHandler(martechCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.martechConnectorDisclosure.length).toBeGreaterThan(0);
  });

  it('does NOT report "No integration metadata found" when only a martech InstalledPackage is present', async () => {
    // filter='auth' scopes NamedCredential out entirely (so the endpoint
    // match disappears), but InstalledPackage detection is filter-
    // independent — the et4ae5 match alone must keep the honest-empty note
    // from firing.
    const result = await integrationMapHandler(martechCtx, { filter: 'auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.authProviders).toEqual([]);
    expect(result.value.data.connectedApps).toEqual([]);
    expect(
      result.value.data.martechConnectors.some(
        (m) => m.componentId === PKG_MARKETING_CLOUD_CONNECT,
      ),
    ).toBe(true);
    expect(result.value.data.note).toBeUndefined();
  });

  it('omits the NamedCredential endpoint match when filter scopes NamedCredential out', async () => {
    const result = await integrationMapHandler(martechCtx, { filter: 'auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.martechConnectors.map((m) => m.componentId);
    expect(ids).not.toContain(NC_MARKETO_ENDPOINT);
  });

  // ===========================================================================
  // INTEGRATION-MAP-MARTECH-IGNORES-REMOTE-SITE-HOSTS guards. Pre-fix these
  // FAIL: the martech classifier matched only NamedCredential/ExternalDataSource
  // URLs, so an Active Marketo `*.mktoapi.com` RemoteSiteSetting appeared under
  // remoteSiteSettings but never as a martechConnector row.
  // ===========================================================================

  it('classifies an Active Marketo RemoteSiteSetting host as a martech connector', async () => {
    const result = await integrationMapHandler(martechCtx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const match = result.value.data.martechConnectors.find(
      (m) => m.componentId === RSS_MARKETO_ACTIVE,
    );
    expect(match).toBeDefined();
    expect(match?.componentType).toBe('RemoteSiteSetting');
    expect(match?.productName).toBe('Marketo');
    expect(match?.vendor).toBe('Adobe (Marketo Engage)');
    expect(match?.source).toBe('remote-site-setting-endpoint');
    expect(match?.confidence).toBe('heuristic');
    expect(match?.matchedOn).toContain('mktoapi.com');
  });

  it('does NOT classify an INACTIVE Marketo RemoteSiteSetting', async () => {
    const result = await integrationMapHandler(martechCtx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.martechConnectors.map((m) => m.componentId);
    expect(ids).not.toContain(RSS_MARKETO_INACTIVE);
  });

  it('does NOT classify an Active non-martech RemoteSiteSetting (negative control)', async () => {
    const result = await integrationMapHandler(martechCtx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.martechConnectors.map((m) => m.componentId);
    expect(ids).not.toContain(RSS_NONMARTECH_ACTIVE);
  });

  it("classifies the RemoteSiteSetting host under filter='sites' (RemoteSiteSetting in scope)", async () => {
    const result = await integrationMapHandler(martechCtx, { filter: 'sites' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.martechConnectors.map((m) => m.componentId);
    expect(ids).toContain(RSS_MARKETO_ACTIVE);
    // The NamedCredential match drops out (NC scoped out of 'sites').
    expect(ids).not.toContain(NC_MARKETO_ENDPOINT);
  });
});

// =============================================================================
// TYPED-ABSENCE-INTEGRATION-MAP — the discriminating controls.
//
// Each case below produces the SAME empty payload as the case beside it and
// differs only in the evidence behind it. If the classification stopped
// discriminating — one blanket marker over fifteen lists — these fail while the
// honesty gate stays green, which is the point: the gate is an any-of at the
// payload level and cannot tell a per-list truth from a uniform one.
// =============================================================================

/** Coverage row shorthand for the controls below. */
const coverageRow = (
  type: string,
  overrides: Partial<CoverageEntry> = {},
): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 0,
  errored: false,
  neverModeled: false,
  ...overrides,
});

const CONFIRMED_EMPTY_MANIFEST: VaultManifest = {
  ...FIXTURE_MANIFEST,
  components: {},
  coverage: [
    'AuthProvider',
    'NamedCredential',
    'RemoteSiteSetting',
    'CspTrustedSite',
    'ExternalDataSource',
    'ExternalService',
    'ConnectedApp',
    'NetworkAccess',
    'InstalledPackage',
    'OmniIntegrationProcedure',
  ].map((type) => coverageRow(type, { retrieveConfirmed: true })),
};

describe('integrationMapHandler — typed absence, confirmed-empty org', () => {
  let dir: string;
  let emptyStore: GraphStore;
  let confirmedCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-integration-map-confirmed-'));
    const opened = await openGraph(join(dir, 'confirmed.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    emptyStore = opened.value;
    confirmedCtx = {
      vaultRoot: dir,
      manifest: CONFIRMED_EMPTY_MANIFEST,
      graph: emptyStore,
    };
  });

  afterAll(async () => {
    await closeGraph(emptyStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports proven-none for every bucket when the retrieve is CONFIRMED complete', async () => {
    // Byte-identical empty payload to the "empty graph" case above. The only
    // difference is `retrieveConfirmed: true` — the manifest's own signal that
    // `{requested: true, retrieved: 0}` means the org has none rather than that
    // the retrieve never landed. The reading must flip.
    const result = await integrationMapHandler(confirmedCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const absence = result.value.data.absence;
    expect(absence?.status).toBe('proven-none');
    expect(
      absence?.sites.every((site) => site.status === 'proven-none'),
    ).toBe(true);
    expect(
      absence?.sites.find((site) => site.path === 'authProviders')?.kind,
    ).toBe('checked-empty');
    // A map with nothing to disclose keeps `boundaries` empty — the not-checked
    // sentence is earned, never boilerplate.
    expect(result.value.data.boundaries).toEqual([]);
    expect(
      absence?.sites.find((site) => site.path === 'boundaries')?.kind,
    ).toBe('checked-empty');
  });

  it('flags a manifest that claims components the graph does not hold', async () => {
    // The third kind of empty, and the one a caller would most badly misread:
    // the vault says the retrieve landed 4 NamedCredentials and the graph has
    // none. That is a VAULT defect, not "this org has no named credentials".
    const disagreeingCtx: Context = {
      ...confirmedCtx,
      manifest: {
        ...CONFIRMED_EMPTY_MANIFEST,
        coverage: [
          coverageRow('NamedCredential', { retrieved: 4 }),
          ...(CONFIRMED_EMPTY_MANIFEST.coverage ?? []).filter(
            (row) => row.type !== 'NamedCredential',
          ),
        ],
      },
    };
    const result = await integrationMapHandler(disagreeingCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const site = result.value.data.absence?.sites.find(
      (entry) => entry.path === 'namedCredentials',
    );
    expect(site?.kind).toBe('coverage-disagrees');
    expect(site?.status).toBe('not-checked');
    expect(site?.reason).toContain('4 NamedCredential');
    // The other seven buckets are still confirmed-empty: one bad row must not
    // repaint the whole payload.
    expect(
      result.value.data.absence?.sites.find((entry) => entry.path === 'authProviders')?.kind,
    ).toBe('checked-empty');
  });

  it('distinguishes a filtered-out category from an unconfirmed one on ONE payload', async () => {
    // `filter: 'auth'` scans AuthProvider + ConnectedApp and skips the rest.
    // Both groups come back `[]`, and before this fix they were
    // indistinguishable — a caller could not tell "this org has no remote
    // sites" from "you did not ask about remote sites".
    const result = await integrationMapHandler(confirmedCtx, { filter: 'auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byPath = new Map(
      (result.value.data.absence?.sites ?? []).map((site) => [site.path, site]),
    );
    expect(byPath.get('remoteSiteSettings')?.kind).toBe('filtered-out');
    expect(byPath.get('remoteSiteSettings')?.status).toBe('not-checked');
    expect(byPath.get('externalDataSources')?.kind).toBe('filtered-out');
    // In-scope and confirmed: the same payload, a different reading.
    expect(byPath.get('authProviders')?.kind).toBe('checked-empty');
    expect(byPath.get('connectedApps')?.kind).toBe('checked-empty');
    // The OmniStudio surface is out of scope under `filter: 'auth'` too.
    expect(byPath.get('omniStudio.restCallouts')?.kind).toBe('filtered-out');
  });
});

// The `not-extracted` case, and its control. This is the law
// `absence-disclosure.ts` states — an absence is decided by whether the node
// carries the property AT ALL, never by an array length — applied to the
// OmniStudio callout surface. `restEndpoints` / `remoteActions` are spread onto
// an IP node ONLY when non-empty, so their absence proves nothing;
// `restEndpointCount` is written unconditionally by the same walk, so ITS
// absence proves the walk never ran. `examples/demo-vault` is the live case: its
// IP node carries `restEndpointCount: 0` and no `restEndpoints` key.
const IP_WALKED = 'OmniIntegrationProcedure:Walked_Clean_1';
const IP_UNWALKED = 'OmniIntegrationProcedure:Legacy_Unwalked_1';

describe('integrationMapHandler — OmniStudio callout walk sentinel', () => {
  let dir: string;
  let ipStore: GraphStore;

  const ctxFor = (): Context => ({
    vaultRoot: dir,
    manifest: CONFIRMED_EMPTY_MANIFEST,
    graph: ipStore,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-integration-map-ipsentinel-'));
    const opened = await openGraph(join(dir, 'ip.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    ipStore = opened.value;
  });

  afterAll(async () => {
    await closeGraph(ipStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an IP carrying the walk sentinel and no callouts is checked-empty', async () => {
    const imported = await importExtractionResults(ipStore, [
      {
        nodes: [
          makeNode({
            id: IP_WALKED,
            type: 'OmniIntegrationProcedure',
            apiName: 'Walked_Clean_1',
            // `restEndpointCount: 0` and NO `restEndpoints` array — exactly what
            // the current extractor writes for an IP with no callouts.
            properties: { omniProcessType: 'Integration Procedure', restEndpointCount: 0 },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const result = await integrationMapHandler(ctxFor(), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const site = result.value.data.absence?.sites.find(
      (entry) => entry.path === 'omniStudio.restCallouts',
    );
    expect(site?.kind).toBe('checked-empty');
    expect(site?.status).toBe('proven-none');
    expect(site?.reason).toContain('restEndpointCount');
  });

  it('an IP built before the callout walk is NOT-EXTRACTED, not "declares none"', async () => {
    const imported = await importExtractionResults(ipStore, [
      {
        nodes: [
          makeNode({
            id: IP_UNWALKED,
            type: 'OmniIntegrationProcedure',
            apiName: 'Legacy_Unwalked_1',
            // No `restEndpointCount` at all: this node was built by a refresh
            // whose extractor never walked the action chain.
            properties: { omniProcessType: 'Integration Procedure' },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const result = await integrationMapHandler(ctxFor(), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byPath = new Map(
      (result.value.data.absence?.sites ?? []).map((site) => [site.path, site]),
    );
    for (const path of [
      'omniStudio.restCallouts',
      'omniStudio.remoteCallouts',
      'omniStudio.referencedNamedCredentials',
    ]) {
      expect(byPath.get(path)?.kind).toBe('not-extracted');
      expect(byPath.get(path)?.status).toBe('not-checked');
    }
    // The shared disclosure names the sentinel property and the offending
    // container, so the reader can see WHICH node was never walked.
    const reason = byPath.get('omniStudio.restCallouts')?.reason ?? '';
    expect(reason).toContain('restEndpointCount');
    expect(reason).toContain(IP_UNWALKED);
    expect(reason).toContain('NEVER a verified');
    // ONE unwalked node is enough: the surface cannot be called complete while
    // any IP in it was never read.
    expect(reason).toContain('1 container(s)');
  });
});

describe('integrationMapHandler — populated lists earn no absence entry', () => {
  let dir: string;
  let popStore: GraphStore;
  let popCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-integration-map-populated-'));
    const opened = await openGraph(join(dir, 'pop.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    popStore = opened.value;
    const imported = await importExtractionResults(popStore, [fullTopologySeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    popCtx = {
      vaultRoot: dir,
      manifest: CONFIRMED_EMPTY_MANIFEST,
      graph: popStore,
    };
  });

  afterAll(async () => {
    await closeGraph(popStore);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists that actually have rows are absent from `absence.sites` entirely', async () => {
    // The mirror-image failure this fix must not introduce: painting a
    // not-checked marker onto an answer that DID find something.
    const result = await integrationMapHandler(popCtx, { filter: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.authProviders.length).toBeGreaterThan(0);
    expect(d.references.length).toBeGreaterThan(0);
    const paths = new Set((d.absence?.sites ?? []).map((site) => site.path));
    for (const populated of [
      'authProviders',
      'namedCredentials',
      'remoteSiteSettings',
      'cspTrustedSites',
      'externalDataSources',
      'externalServices',
      'connectedApps',
      'networkAccesses',
      'references',
    ]) {
      expect(paths.has(populated)).toBe(false);
    }
    // Nothing here is unchecked, so nothing is added to `boundaries` either.
    expect(d.absence?.status).toBe('proven-none');
    expect(d.boundaries).toEqual([]);
  });
});

describe('integrationMapInputSchema', () => {
  it('accepts an empty input (filter defaults to all)', () => {
    expect(integrationMapInputSchema.safeParse({}).success).toBe(true);
  });

  it("accepts filter='all'", () => {
    expect(integrationMapInputSchema.safeParse({ filter: 'all' }).success).toBe(true);
  });

  it('accepts each allowed filter value', () => {
    for (const filter of ['auth', 'sites', 'sources', 'services', 'access', 'all']) {
      expect(integrationMapInputSchema.safeParse({ filter }).success).toBe(true);
    }
  });

  it('rejects an unrecognised filter value', () => {
    expect(integrationMapInputSchema.safeParse({ filter: 'unknown' }).success).toBe(false);
  });

  it('accepts limit at the upper bound (500)', () => {
    expect(integrationMapInputSchema.safeParse({ limit: 500 }).success).toBe(true);
  });

  it('rejects limit > 500', () => {
    expect(integrationMapInputSchema.safeParse({ limit: 501 }).success).toBe(false);
  });

  it('rejects limit < 1', () => {
    expect(integrationMapInputSchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    expect(integrationMapInputSchema.safeParse({ limit: 12.5 }).success).toBe(false);
  });

  // The object / component scope keys parse (so the handler can refuse them with
  // a helpful message) rather than being silently stripped at the Zod boundary.
  it('accepts object / component scope keys at the schema level (handler refuses them)', () => {
    for (const scoped of [
      { objectApiName: 'Contact' },
      { object: 'Contact' },
      { objectId: 'CustomObject:Contact' },
      { componentId: 'CustomObject:Contact' },
    ]) {
      expect(integrationMapInputSchema.safeParse(scoped).success).toBe(true);
    }
  });
});

// =============================================================================
// G2 full-scan honesty. Each category used to take ONE `listNodesByType` page
// capped at ceil(limit / 8) = 13 by default — an alphabetical prefix — and the
// DERIVED fields (martechConnectors, calloutAuthorizationNote) were computed
// off that prefix. `SFI_NODE_SCAN_LIMIT=3` shrinks the scan window so 5 nodes
// exercise multi-window paging instead of the 41 QA had to seed.
// =============================================================================

describe('integrationMapHandler (full category scan — G2)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;
  let priorLimit: string | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-intmap-fullscan-'));
    const opened = await openGraph(join(dir, 'fullscan.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          ...Array.from({ length: 4 }, (_unused, i) =>
            makeNode({
              id: `RemoteSiteSetting:Site_${i}`,
              type: 'RemoteSiteSetting',
              apiName: `Site_${i}`,
              properties: {
                url: `https://plain-${i}.example.com`,
                isActive: true,
              },
            }),
          ),
          // Sorts LAST by id ASC — past every scan window. This is the only
          // martech signal in the org.
          makeNode({
            id: 'RemoteSiteSetting:ZZ_Marketo',
            type: 'RemoteSiteSetting',
            apiName: 'ZZ_Marketo',
            properties: {
              url: 'https://x.mktorest.com/rest',
              isActive: true,
            },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    priorLimit = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '3';
  });

  afterEach(() => {
    if (priorLimit === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
    else process.env['SFI_NODE_SCAN_LIMIT'] = priorLimit;
  });

  it('detects a martech connector that sorts past the scan window, and discloses the payload trim', async () => {
    // limit: 8 -> the old per-category budget was ceil(8/8) = 1.
    const result = await integrationMapHandler(ctx, { limit: 8 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.martechConnectors.map((m) => m.componentId)).toEqual([
      'RemoteSiteSetting:ZZ_Marketo',
    ]);
    // Every one of the 5 fits under limit: 8, so nothing is trimmed.
    expect(d.remoteSiteSettings.length).toBe(5);
    expect(d.truncatedCategories).toEqual([]);
    expect(d.calloutAuthorizationNote).toContain('5 in this org');
  });

  it('names the true total when the payload IS trimmed', async () => {
    const result = await integrationMapHandler(ctx, { limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.remoteSiteSettings.length).toBe(2);
    expect(d.truncatedCategories).toContainEqual({
      type: 'RemoteSiteSetting',
      returned: 2,
      total: 5,
    });
    // The derived fields still read the COMPLETE set behind the trim.
    expect(d.martechConnectors.length).toBe(1);
    expect(d.calloutAuthorizationNote).toContain('5 in this org');
    expect(d.calloutAuthorizationNote).toContain('ZZ_Marketo');
  });
});
