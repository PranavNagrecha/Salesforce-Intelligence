/// <reference types="vitest/globals" />

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

  it('respects the per-category limit cap', async () => {
    // limit=8 -> ceil(8/8)=1 per category. AuthProvider has 7 nodes
    // (2 topology + 5 many-auth), but the limit caps at 1.
    const result = await integrationMapHandler(ctx, { filter: 'all', limit: 8 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.authProviders.length).toBeLessThanOrEqual(1);
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
});
