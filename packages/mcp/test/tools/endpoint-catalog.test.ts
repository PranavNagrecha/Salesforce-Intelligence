/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  endpointCatalogHandler,
  endpointCatalogInputSchema,
} from '../../src/tools/endpoint-catalog.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    ApexClass: 2,
    OutboundMessage: 1,
    ExternalDataSource: 1,
    NamedCredential: 1,
    OmniIntegrationProcedure: 1,
  },
  edges: { exposes: 2 },
  sourceTreeHash: 'sha256:endpoint-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'placeholder',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
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
  source: 'apex-class-extractor',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: a REST resource + an Aura-enabled class. Two `exposes` edges to
// synthetic ExternalApi:{kind}/{path} targets.
// =============================================================================

const REST_CLASS = 'ApexClass:AccountRestApi';
const AURA_CLASS = 'ApexClass:LeadAuraApi';

const exposesSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: REST_CLASS, apiName: 'AccountRestApi' }),
    makeNode({ id: AURA_CLASS, apiName: 'LeadAuraApi' }),
  ],
  edges: [
    makeEdge({
      fromId: REST_CLASS,
      toId: 'ExternalApi:rest//services/apexrest/Account/*',
      edgeType: 'exposes',
    }),
    makeEdge({
      fromId: AURA_CLASS,
      toId: 'ExternalApi:aura/LeadAuraApi.getLeads',
      edgeType: 'exposes',
    }),
  ],
};

// =============================================================================
// Seed 2: an OutboundMessage with a verbatim endpointUrl.
// =============================================================================

const ACCOUNT_OM = 'OutboundMessage:Account.SendOrderToWarehouse';

const outboundSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ACCOUNT_OM,
      type: 'OutboundMessage',
      apiName: 'Account.SendOrderToWarehouse',
      properties: {
        name: 'SendOrderToWarehouse',
        endpointUrl: 'https://warehouse.example.com/inbound',
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 3: an ExternalDataSource with an `endpoint` property.
// =============================================================================

const ORDERS_EDS = 'ExternalDataSource:Orders';

const externalDsSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ORDERS_EDS,
      type: 'ExternalDataSource',
      apiName: 'Orders',
      properties: { endpoint: 'https://api.example.com/odata' },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 4: a NamedCredential with a `url` property.
// =============================================================================

const NC_EXTERNAL = 'NamedCredential:ExternalApi';

const namedCredSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NC_EXTERNAL,
      type: 'NamedCredential',
      apiName: 'ExternalApi',
      properties: { url: 'https://api.example.com' },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 5: a NamedCredential with NO url/endpoint property (defensive case).
// =============================================================================

const NC_BAREBONES = 'NamedCredential:Barebones';

const barebonesSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NC_BAREBONES,
      type: 'NamedCredential',
      apiName: 'Barebones',
      properties: {},
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 6: an OmniIntegrationProcedure carrying a `restEndpoints` array (two
// Rest Action callouts, one with a named credential). This is the extraction-
// time shape the omni-integration-procedure extractor now persists.
// =============================================================================

const IP_ORDER_SYNC = 'OmniIntegrationProcedure:Order_Sync_Procedure_1';

const omniIpSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: IP_ORDER_SYNC,
      type: 'OmniIntegrationProcedure',
      apiName: 'Order_Sync_Procedure_1',
      properties: {
        omniProcessType: 'Integration Procedure',
        restEndpointCount: 2,
        restEndpoints: [
          {
            stepName: 'PostOrder',
            path: '/services/data/v58.0/sobjects/Order',
            method: 'POST',
            namedCredential: 'callout:Warehouse_NC',
          },
          {
            stepName: 'GetStatus',
            path: '/status',
            method: 'GET',
            namedCredential: null,
          },
        ],
      },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-endpoint-catalog-'));
  const opened = await openGraph(join(tempDir, 'endpoint.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    exposesSeed,
    outboundSeed,
    externalDsSeed,
    namedCredSeed,
    barebonesSeed,
    omniIpSeed,
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
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

describe('endpointCatalogHandler', () => {
  it('returns inbound APIs from exposes edges', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // ARCH-08: only the REST resource is an integration entry point; the
    // Lightning controller is listed under uiEntryPoints.
    expect(d.inboundApis).toHaveLength(1);
    const restEntry = d.inboundApis.find((e) => e.endpointKind === 'rest');
    expect(restEntry).toBeDefined();
    expect(restEntry?.direction).toBe('inbound');
    expect(restEntry?.sourceComponentId).toBe(REST_CLASS);
    expect(d.inboundApis.some((e) => e.endpointKind === 'aura')).toBe(false);
    const auraEntry = d.uiEntryPoints.find((e) => e.endpointKind === 'aura');
    expect(auraEntry).toBeDefined();
    expect(auraEntry?.url).toBe('LeadAuraApi.getLeads');
    expect(d.summary.uiEntryPointCount).toBe(1);
  });

  it('returns outbound message endpoints', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.outboundMessages).toHaveLength(1);
    expect(d.outboundMessages[0]?.endpointKind).toBe('outbound-message');
    expect(d.outboundMessages[0]?.direction).toBe('outbound');
    expect(d.outboundMessages[0]?.sourceComponentId).toBe(ACCOUNT_OM);
    expect(d.outboundMessages[0]?.url).toBe(
      'https://warehouse.example.com/inbound',
    );
  });

  it('returns ExternalDataSource endpoints', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.externalDataSources).toHaveLength(1);
    expect(d.externalDataSources[0]?.endpointKind).toBe('external-data-source');
    expect(d.externalDataSources[0]?.direction).toBe('outbound');
    expect(d.externalDataSources[0]?.sourceComponentId).toBe(ORDERS_EDS);
    expect(d.externalDataSources[0]?.url).toBe(
      'https://api.example.com/odata',
    );
  });

  it('returns NamedCredential endpoints', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.namedCredentials).toHaveLength(2);
    const externalEntry = d.namedCredentials.find(
      (e) => e.sourceComponentId === NC_EXTERNAL,
    );
    expect(externalEntry?.url).toBe('https://api.example.com');
    expect(externalEntry?.direction).toBe('outbound');
    expect(externalEntry?.endpointKind).toBe('named-credential');
  });

  it('surfaces a null URL for properties-less NamedCredential entries', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const barebones = result.value.data.namedCredentials.find(
      (e) => e.sourceComponentId === NC_BAREBONES,
    );
    expect(barebones?.url).toBeNull();
  });

  it('returns OmniStudio IP REST callouts as outbound endpoints with named credentials', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.omniRestEndpoints).toHaveLength(2);
    for (const e of d.omniRestEndpoints) {
      expect(e.endpointKind).toBe('omni-rest');
      expect(e.direction).toBe('outbound');
      expect(e.sourceComponentId).toBe(IP_ORDER_SYNC);
    }
    const postOrder = d.omniRestEndpoints.find(
      (e) => e.url === '/services/data/v58.0/sobjects/Order',
    );
    expect(postOrder).toBeDefined();
    expect(postOrder?.namedCredential).toBe('callout:Warehouse_NC');
    const getStatus = d.omniRestEndpoints.find((e) => e.url === '/status');
    expect(getStatus?.namedCredential).toBeNull();
  });

  it('rolls up the distinct referenced named credentials from IP REST callouts', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.referencedNamedCredentials).toEqual([
      'callout:Warehouse_NC',
    ]);
  });

  it('returns honest summary counts', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // 1 inbound REST + (1 outbound msg + 1 EDS + 2 NCs + 2 omni-rest) = 6
    // outbound. The Aura controller is a UI entry point, not counted (ARCH-08).
    expect(d.summary.inboundCount).toBe(1);
    expect(d.summary.outboundCount).toBe(6);
    expect(d.summary.totalEndpoints).toBe(7);
  });

  it('sorts each category by sourceComponentId ASC', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    const ncIds = d.namedCredentials.map((e) => e.sourceComponentId);
    expect(ncIds).toEqual([...ncIds].sort());
  });

  it('returns an honest disclosure mentioning the URL-not-validated boundary', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('NOT');
    expect(result.value.data.disclosure).toContain('probe');
  });

  it('carries vaultState from the manifest', async () => {
    const result = await endpointCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(
      'sha256:endpoint-fixture',
    );
  });

  it('returns an empty catalog without erroring against an empty graph', async () => {
    // Open a fresh empty store for this test.
    const tdir = mkdtempSync(join(tmpdir(), 'sfi-mcp-endpoint-empty-'));
    const opened = await openGraph(join(tdir, 'empty.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      rmSync(tdir, { recursive: true, force: true });
      return;
    }
    const emptyCtx: Context = {
      vaultRoot: tdir,
      manifest: FIXTURE_MANIFEST,
      graph: opened.value,
    };
    try {
      const result = await endpointCatalogHandler(emptyCtx, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const d = result.value.data;
      expect(d.summary.totalEndpoints).toBe(0);
      expect(d.inboundApis).toEqual([]);
      expect(d.outboundMessages).toEqual([]);
      expect(d.externalDataSources).toEqual([]);
      expect(d.namedCredentials).toEqual([]);
      expect(d.omniRestEndpoints).toEqual([]);
      expect(d.referencedNamedCredentials).toEqual([]);
      expect(d.remoteSiteSettings).toEqual([]);
      expect(d.cspTrustedSites).toEqual([]);
      expect(d.summary.byKind).toEqual({});
      // An empty ORG still gets the scope boundary — the disclosure is about
      // what the tool does not look at, never about what it happened to find.
      expect(d.boundaries.length).toBeGreaterThan(0);
      expect(d.notCovered.length).toBeGreaterThan(0);
    } finally {
      await closeGraph(opened.value);
      rmSync(tdir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Orphaned-named-credential scenario: one NamedCredential that an
// ExternalService references (NOT orphaned) and one that nothing references
// (orphaned — the "AWS_US_East_1 is unused" shape). The catalog must report
// the orphan as orphaned rather than implying it authorizes a callout.
// Uses its OWN store so it is independent of the shared-suite seeding above.
// =============================================================================

const NC_WIRED = 'NamedCredential:Wired_Api';
const NC_UNUSED = 'NamedCredential:AcmeCloud_US_East_1';
const ES_BINDS_NC = 'ExternalService:DirectorySync';

const orphanSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NC_WIRED,
      type: 'NamedCredential',
      apiName: 'Wired_Api',
      properties: { url: 'https://api.example.com' },
    }),
    makeNode({
      id: NC_UNUSED,
      type: 'NamedCredential',
      apiName: 'AcmeCloud_US_East_1',
      properties: {
        endpoint: 'arn:aws:US-EAST-1:000000000000',
        protocol: 'NoAuthentication',
      },
    }),
    makeNode({
      id: ES_BINDS_NC,
      type: 'ExternalService',
      apiName: 'DirectorySync',
    }),
  ],
  edges: [
    makeEdge({
      fromId: ES_BINDS_NC,
      toId: NC_WIRED,
      edgeType: 'references',
      properties: { role: 'namedCredential' },
    }),
  ],
};

describe('endpointCatalogHandler (orphaned named credential)', () => {
  let orphanDir: string;
  let orphanStore: GraphStore;
  let orphanCtx: Context;

  beforeAll(async () => {
    orphanDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-endpoint-orphan-'));
    const opened = await openGraph(join(orphanDir, 'orphan.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    orphanStore = opened.value;
    const imported = await importExtractionResults(orphanStore, [orphanSeed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    orphanCtx = {
      vaultRoot: orphanDir,
      manifest: FIXTURE_MANIFEST,
      graph: orphanStore,
    };
  });

  afterAll(async () => {
    await closeGraph(orphanStore);
    rmSync(orphanDir, { recursive: true, force: true });
  });

  it('flags an unreferenced NamedCredential as orphaned with referenceCount 0', async () => {
    const result = await endpointCatalogHandler(orphanCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unused = result.value.data.namedCredentials.find(
      (e) => e.sourceComponentId === NC_UNUSED,
    );
    expect(unused).toBeDefined();
    expect(unused?.orphaned).toBe(true);
    expect(unused?.referenceCount).toBe(0);
  });

  it('does NOT flag a referenced NamedCredential as orphaned', async () => {
    const result = await endpointCatalogHandler(orphanCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wired = result.value.data.namedCredentials.find(
      (e) => e.sourceComponentId === NC_WIRED,
    );
    expect(wired).toBeDefined();
    expect(wired?.orphaned).toBe(false);
    expect(wired?.referenceCount).toBe(1);
  });
});

// =============================================================================
// NC-DYNAMIC-CALLOUT-ORPHANED: a shared helper builds `'callout:' + name` at
// runtime, and a trigger hands it the credential NAME as a literal. No literal
// `callout:Name` exists, so the graph has no reference edge — the catalog used
// to call the credential orphaned. The name-literal scan now counts it; a
// credential named nowhere stays orphaned but carries the dynamic caveat.
// =============================================================================

describe('endpointCatalogHandler (dynamic callout name literals — NC-DYNAMIC-CALLOUT-ORPHANED)', () => {
  let dynDir: string;
  let dynStore: GraphStore;
  let dynCtx: Context;

  beforeAll(async () => {
    dynDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-endpoint-dyn-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dynDir, 'classes'), { recursive: true });
    writeFileSync(
      join(dynDir, 'classes', 'CalloutUtil.cls'),
      "public class CalloutUtil {\n  public static void send(String method, String nc, String body) {\n    HttpRequest req = new HttpRequest();\n    req.setEndpoint('callout:' + nc + '/v1');\n  }\n}\n",
    );
    writeFileSync(
      join(dynDir, 'classes', 'InvoiceSync.cls'),
      "public class InvoiceSync {\n  public static void run() { CalloutUtil.send('POST', 'Billing_Api', '{}'); }\n  // CalloutUtil.send('POST', 'Ghost_Api', '{}');\n}\n",
    );
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'ApexClass:CalloutUtil', apiName: 'CalloutUtil', sourcePath: join(dynDir, 'classes', 'CalloutUtil.cls') }),
        makeNode({ id: 'ApexClass:InvoiceSync', apiName: 'InvoiceSync', sourcePath: join(dynDir, 'classes', 'InvoiceSync.cls') }),
        makeNode({ id: 'NamedCredential:Billing_Api', type: 'NamedCredential', apiName: 'Billing_Api' }),
        makeNode({ id: 'NamedCredential:Ghost_Api', type: 'NamedCredential', apiName: 'Ghost_Api' }),
        makeNode({
          id: 'CustomMetadataRecord:Endpoint_Registry.Ledger',
          type: 'CustomMetadataRecord',
          apiName: 'Endpoint_Registry.Ledger',
          properties: { values: { Named_Credential__c: 'Ledger_Api' } },
        }),
        makeNode({ id: 'NamedCredential:Ledger_Api', type: 'NamedCredential', apiName: 'Ledger_Api' }),
        makeNode({ id: 'NamedCredential:Docs_Api', type: 'NamedCredential', apiName: 'Docs_Api' }),
        makeNode({
          id: 'OmniIntegrationProcedure:Docs_Fetch',
          type: 'OmniIntegrationProcedure',
          apiName: 'Docs_Fetch',
          properties: { restEndpoints: [{ stepName: 'Get', path: '/docs', method: 'GET', namedCredential: 'Docs_Api' }] },
        }),
      ],
      edges: [],
    };
    const opened = await openGraph(join(dynDir, 'dyn.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    dynStore = opened.value;
    const imported = await importExtractionResults(dynStore, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    dynCtx = { vaultRoot: dynDir, manifest: FIXTURE_MANIFEST, graph: dynStore };
  });

  afterAll(async () => {
    await closeGraph(dynStore);
    rmSync(dynDir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: a credential named as a literal to a dynamic-callout helper is NOT orphaned', async () => {
    const result = await endpointCatalogHandler(dynCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const billing = result.value.data.namedCredentials.find((e) => e.sourceComponentId === 'NamedCredential:Billing_Api');
    expect(billing?.orphaned).toBe(false);
    expect(billing?.referenceCount).toBe(1);
    expect(billing?.referencedBy).toEqual([{ componentId: 'ApexClass:InvoiceSync', via: 'name-literal' }]);
  });

  it('FAIL-BEFORE/PASS-AFTER: a credential named on a custom-metadata endpoint registry is NOT orphaned', async () => {
    const result = await endpointCatalogHandler(dynCtx, {});
    if (!result.ok) throw new Error('handler failed');
    const ledger = result.value.data.namedCredentials.find((e) => e.sourceComponentId === 'NamedCredential:Ledger_Api');
    expect(ledger?.orphaned).toBe(false);
    expect(ledger?.referencedBy?.[0]?.componentId).toBe('CustomMetadataRecord:Endpoint_Registry.Ledger');
  });

  it('FAIL-BEFORE/PASS-AFTER: a credential an OmniStudio IP Rest Action declares is NOT orphaned', async () => {
    const result = await endpointCatalogHandler(dynCtx, {});
    if (!result.ok) throw new Error('handler failed');
    const docs = result.value.data.namedCredentials.find((e) => e.sourceComponentId === 'NamedCredential:Docs_Api');
    expect(docs?.orphaned).toBe(false);
    expect(docs?.referencedBy).toEqual([{ componentId: 'OmniIntegrationProcedure:Docs_Fetch', via: 'omni-rest' }]);
  });

  it('sfi.integration_map grades the credentials identically (one shared counter)', async () => {
    const { integrationMapHandler } = await import('../../src/tools/integration-map.js');
    const result = await integrationMapHandler(dynCtx, {});
    if (!result.ok) throw new Error('integration_map failed');
    const byId = new Map(result.value.data.namedCredentials.map((n) => [n.id, n]));
    expect(byId.get('NamedCredential:Billing_Api')?.orphaned).toBe(false);
    expect(byId.get('NamedCredential:Ledger_Api')?.orphaned).toBe(false);
    expect(byId.get('NamedCredential:Ghost_Api')?.orphaned).toBe(true);
    expect(byId.get('NamedCredential:Ghost_Api')?.orphanedCaveat).toMatch(/at runtime/);
  });

  it('a credential named only in a COMMENT stays orphaned, with the dynamic-callout caveat', async () => {
    const result = await endpointCatalogHandler(dynCtx, {});
    if (!result.ok) throw new Error('handler failed');
    const ghost = result.value.data.namedCredentials.find((e) => e.sourceComponentId === 'NamedCredential:Ghost_Api');
    expect(ghost?.orphaned).toBe(true);
    expect(ghost?.orphanedCaveat).toMatch(/at runtime/);
    expect(ghost?.orphanedCaveat).toContain('ApexClass:CalloutUtil');
  });
});

// =============================================================================
// Object-scope refusal (ENDPOINT-CATALOG-IGNORES-OBJECT-SCOPE). The catalog is
// ORG-WIDE — endpoints carry no endpoint→object association in the graph — so an
// object / component scope is REFUSED with a named `invalid-query` rather than
// silently returning the whole-org catalog (which was byte-identical for Contact
// vs Account vs bare). Mirrors the closed `integration_map` refusal.
// =============================================================================

describe('endpointCatalogHandler (object scope — ENDPOINT-CATALOG-IGNORES-OBJECT-SCOPE)', () => {
  it('REFUSES an objectApiName scope with a named invalid-query (not a silent org-wide answer)', async () => {
    const r = await endpointCatalogHandler(ctx, { objectApiName: 'Contact' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('cannot scope by object');
    expect(r.error.message).toContain('Contact');
    expect(r.error.path).toBe('objectApiName');
  });

  it('refuses object / objectId / componentId scopes the same way', async () => {
    for (const scoped of [
      { object: 'Account' },
      { objectId: 'CustomObject:Account' },
      { componentId: 'CustomObject:Account' },
    ]) {
      const r = await endpointCatalogHandler(ctx, scoped);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.kind).toBe('invalid-query');
    }
  });

  it('Contact-scoped and Account-scoped both refuse — no longer byte-identical org-wide dumps', async () => {
    const contact = await endpointCatalogHandler(ctx, { objectApiName: 'Contact' });
    const account = await endpointCatalogHandler(ctx, { objectApiName: 'Account' });
    expect(contact.ok).toBe(false);
    expect(account.ok).toBe(false);
  });

  it('the bare no-scope call is unchanged (7 integration endpoints after ARCH-08, no appliedScope)', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.totalEndpoints).toBe(7);
    // No new field leaks onto the bare-call payload.
    expect('appliedScope' in d).toBe(false);
    expect(JSON.stringify(d)).not.toContain('appliedScope');
  });
});

describe('endpointCatalogInputSchema', () => {
  it('accepts an empty input', () => {
    expect(endpointCatalogInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts (and ignores) extra properties', () => {
    expect(
      endpointCatalogInputSchema.safeParse({ ignored: true }).success,
    ).toBe(true);
  });

  it('accepts the object-scope keys at the schema level (the handler refuses them)', () => {
    expect(
      endpointCatalogInputSchema.safeParse({ objectApiName: 'Contact' }).success,
    ).toBe(true);
    expect(
      endpointCatalogInputSchema.safeParse({ componentId: 'CustomObject:Account' })
        .success,
    ).toBe(true);
  });
});

// =============================================================================
// G2 full-scan honesty. Every collector took ONE 500-row `listNodesByType` page
// with no offset, so a `@RestResource` sorting past that prefix was silently
// absent and `summary.totalEndpoints` under-reported with nothing in the
// payload to say so. `SFI_NODE_SCAN_LIMIT=3` shrinks the scan window so 5 nodes
// exercise multi-window paging instead of the 602 QA had to seed.
// =============================================================================

describe('endpointCatalogHandler — full per-category scan (G2)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;
  let priorLimit: string | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-endpoint-fullscan-'));
    const opened = await openGraph(join(dir, 'fullscan.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          makeNode({ id: 'ApexClass:A_Early', apiName: 'A_Early' }),
          ...Array.from({ length: 3 }, (_unused, i) =>
            makeNode({ id: `ApexClass:Filler_${i}`, apiName: `Filler_${i}` }),
          ),
          // Sorts LAST by id ASC — past every scan window.
          makeNode({ id: 'ApexClass:Z_Webhook', apiName: 'Z_Webhook' }),
        ],
        edges: [
          makeEdge({
            fromId: 'ApexClass:A_Early',
            toId: 'ExternalApi:rest//services/apexrest/early',
            edgeType: 'exposes',
          }),
          makeEdge({
            fromId: 'ApexClass:Z_Webhook',
            toId: 'ExternalApi:rest//services/apexrest/webhook',
            edgeType: 'exposes',
          }),
        ],
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

  it('surfaces an endpoint on a class sorting past the scan window', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.inboundApis.map((e) => e.url).sort()).toEqual([
      '/services/apexrest/early',
      '/services/apexrest/webhook',
    ]);
    // Pre-fix this was 1 — the webhook was invisible and indistinguishable
    // from an endpoint that does not exist.
    expect(d.summary.totalEndpoints).toBe(2);
    expect(d.summary.inboundCount).toBe(2);
    // THIS ASSERTION USED TO READ `toEqual([])` — it pinned the very contract
    // the real-org finding killed: an empty `boundaries[]` as the certificate
    // that nothing was omitted. What this case actually proves is that NO
    // FULL-SCAN TRUNCATION note fires (the scan completed); the always-on scope
    // boundary is a separate, permanent statement and must still be there.
    expect(d.boundaries.some((b) => b.includes('Full scan capped'))).toBe(false);
    expect(d.boundaries.some((b) => b.includes('notCovered'))).toBe(true);
  });
});

// =============================================================================
// The literal repro of the defect, at the REAL cap (SFI_NODE_SCAN_LIMIT is not
// set here, so the window is the graph layer's 500). The old collector issued
// one `listNodesByType(..., { limit: 500 })` with no offset, so the endpoint on
// the 502nd class by id ASC was silently absent and `totalEndpoints` said 1.
// =============================================================================

describe('endpointCatalogHandler — past the 500-row page boundary (G2)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-endpoint-over500-'));
    const opened = await openGraph(join(dir, 'over500.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          makeNode({ id: 'ApexClass:AaaEarlyRest', apiName: 'AaaEarlyRest' }),
          ...Array.from({ length: 501 }, (_unused, i) =>
            makeNode({
              id: `ApexClass:Filler${String(i).padStart(4, '0')}`,
              apiName: `Filler${i}`,
            }),
          ),
          makeNode({ id: 'ApexClass:ZWebhook', apiName: 'ZWebhook' }),
        ],
        edges: [
          makeEdge({
            fromId: 'ApexClass:AaaEarlyRest',
            toId: 'ExternalApi:rest//services/apexrest/early',
            edgeType: 'exposes',
          }),
          makeEdge({
            fromId: 'ApexClass:ZWebhook',
            toId: 'ExternalApi:rest//services/apexrest/webhook',
            edgeType: 'exposes',
          }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the endpoint on the class past position 500 by id ASC', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.inboundApis.map((e) => e.url).sort()).toEqual([
      '/services/apexrest/early',
      '/services/apexrest/webhook',
    ]);
    expect(d.summary.totalEndpoints).toBe(2);
  });
});

// =============================================================================
// CERTIFIED-COMPLETENESS-OVER-A-NARROW-CORPUS (real-org finding, HIGH ×3).
//
// The catalog's contract is "every URL / endpoint participating in an
// integration", `summary.totalEndpoints` is documented as "a TRUE total", and
// `boundaries[]` is documented as empty in the normal case. On a real vault it
// returned 34 endpoints with `boundaries: []` while the SAME graph held two
// further fully-extracted, URL-bearing outbound families that appeared in no
// section and in no boundary:
//
//   * RemoteSiteSetting  — the outbound-callout allowlist. `url` is a REQUIRED
//                          element in the extractor, so every node carries one.
//   * CspTrustedSite     — the browser-side external-host allowlist.
//                          `endpointUrl` is likewise REQUIRED.
//
// The sibling `sfi.integration_map` returns both families as first-class rows
// on the same vault, so this is not "the product does not model them". A
// security reviewer asking "every external host this org can reach" was handed
// a certified total that omitted the entire allowlist.
//
// Two fixes are asserted here:
//   (a) both families are enumerated as first-class sections; and
//   (b) `boundaries[]` / `notCovered[]` are NEVER empty — the URL surfaces that
//       are genuinely not modeled (Apex literals, markup, config data) are
//       named in a typed field instead of being certified away.
// =============================================================================

const RSS_ACTIVE = 'RemoteSiteSetting:Site_A';
const RSS_INACTIVE = 'RemoteSiteSetting:Site_B';
const CSP_SITE = 'CspTrustedSite:Csp_C';

const allowlistSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: RSS_ACTIVE,
      type: 'RemoteSiteSetting',
      apiName: 'Site_A',
      properties: {
        url: 'https://vendor-a.example.com',
        isActive: true,
        disableProtocolSecurity: false,
        description: null,
      },
    }),
    makeNode({
      id: RSS_INACTIVE,
      type: 'RemoteSiteSetting',
      apiName: 'Site_B',
      properties: {
        url: 'https://vendor-b.example.com',
        isActive: false,
        disableProtocolSecurity: false,
        description: null,
      },
    }),
    makeNode({
      id: CSP_SITE,
      type: 'CspTrustedSite',
      apiName: 'Csp_C',
      properties: {
        endpointUrl: 'https://cdn-c.example.com',
        isActive: true,
        context: 'All',
      },
    }),
  ],
  edges: [],
};

describe('endpointCatalogHandler — outbound allowlist families (RemoteSiteSetting / CspTrustedSite)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-endpoint-allowlist-'));
    const opened = await openGraph(join(dir, 'allowlist.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [allowlistSeed]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('enumerates every RemoteSiteSetting URL as a first-class outbound entry', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.remoteSiteSettings.map((e) => e.url).sort()).toEqual([
      'https://vendor-a.example.com',
      'https://vendor-b.example.com',
    ]);
    for (const e of d.remoteSiteSettings) {
      expect(e.endpointKind).toBe('remote-site');
      expect(e.direction).toBe('outbound');
    }
    // An INACTIVE allowlist entry is still listed — dropping it would be a
    // second silent omission — but its state is carried so a reviewer can tell.
    const inactive = d.remoteSiteSettings.find(
      (e) => e.sourceComponentId === RSS_INACTIVE,
    );
    expect(inactive?.isActive).toBe(false);
    const active = d.remoteSiteSettings.find(
      (e) => e.sourceComponentId === RSS_ACTIVE,
    );
    expect(active?.isActive).toBe(true);
  });

  it('enumerates every CspTrustedSite endpointUrl as a first-class entry', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.cspTrustedSites).toHaveLength(1);
    expect(d.cspTrustedSites[0]?.url).toBe('https://cdn-c.example.com');
    expect(d.cspTrustedSites[0]?.endpointKind).toBe('csp-trusted-site');
    expect(d.cspTrustedSites[0]?.sourceComponentId).toBe(CSP_SITE);
  });

  it('counts the allowlist families in summary.totalEndpoints (the "TRUE total" claim)', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // 2 RemoteSiteSettings + 1 CspTrustedSite and nothing else in this store.
    expect(d.summary.totalEndpoints).toBe(3);
    expect(d.summary.outboundCount).toBe(3);
    expect(d.summary.inboundCount).toBe(0);
  });

  it('FAIL-BEFORE/PASS-AFTER (ARCH-08): lists Apex callouts and flags a literal host no active remote site authorizes', async () => {
    const classes = join(dir, 'source', 'classes');
    mkdirSync(classes, { recursive: true });
    writeFileSync(
      join(classes, 'InvoiceSync.cls'),
      [
        'public with sharing class InvoiceSync {',
        '  public static void send(String body) {',
        '    HttpRequest a = new HttpRequest();',
        "    a.setEndpoint('https://vendor-a.example.com/v1/invoices');",
        "    a.setEndpoint('https://vendor-b.example.com/v1/invoices');",
        "    a.setEndpoint('https://unlisted.example.org/hook');",
        "    a.setEndpoint('callout:Billing_NC/v2/send');",
        '    a.setEndpoint(Settings__c.getOrgDefaults().Base_Url__c);',
        "    // a.setEndpoint('https://old.example.net');",
        '  }',
        '}',
      ].join('\n'),
    );
    // A test class's mock endpoint never leaves the org: not a callout.
    writeFileSync(
      join(classes, 'InvoiceSyncTest.cls'),
      "@isTest\nprivate class InvoiceSyncTest {\n  static void t() { HttpRequest r = new HttpRequest(); r.setEndpoint('https://mock.example.net/x'); }\n}",
    );
    try {
      const r = await endpointCatalogHandler(ctx, {});
      if (!r.ok) throw new Error('catalog failed');
      const d = r.value.data;
      expect(d.apexCallouts.map((c) => [c.target, c.host, c.namedCredential])).toEqual([
        ['literal-host', 'vendor-a.example.com', null],
        ['literal-host', 'vendor-b.example.com', null],
        ['literal-host', 'unlisted.example.org', null],
        ['named-credential', null, 'Billing_NC'],
        ['dynamic', null, null],
      ]);
      expect(d.apexCallouts[0]?.authorizedBy).toBe('https://vendor-a.example.com');
      expect(d.apexCallouts[0]?.sourceComponentId).toBe('ApexClass:InvoiceSync');
      // vendor-b's remote site is INACTIVE: it authorizes nothing.
      expect(d.summary.unauthorizedCalloutHosts).toEqual(['unlisted.example.org', 'vendor-b.example.com']);
      expect(d.summary.apexCalloutCount).toBe(5);
      // Call sites are not URL declarations: the total is unchanged.
      expect(d.summary.totalEndpoints).toBe(3);
    } finally {
      rmSync(join(dir, 'source'), { recursive: true, force: true });
    }
  });

  it('breaks the total down by endpointKind so an allowlist entry cannot read as a callsite', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.byKind['remote-site']).toBe(2);
    expect(d.summary.byKind['csp-trusted-site']).toBe(1);
  });
});

describe('endpointCatalogHandler — the total is never certified as every URL in the org', () => {
  it('boundaries[] is NEVER empty: the un-modeled URL surfaces are always named', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.boundaries.length).toBeGreaterThan(0);
    expect(d.boundaries.join(' ')).toContain('notCovered');
  });

  it('notCovered[] is a TYPED field naming the Apex-literal callout surface', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const notCovered = r.value.data.notCovered.join(' ');
    expect(notCovered).toContain('setEndpoint');
    expect(notCovered).toContain('Apex');
  });

  it('the disclosure says an allowlist entry is an authorization, not a proven callout', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toContain('ALLOWLIST authorizations');
    expect(r.value.data.disclosure).toContain('not evidence that any code reaches it');
  });
});

// FAIL-BEFORE/PASS-AFTER (eval A09): a helper building `'callout:' + name` read
// `target: 'dynamic'` with nothing tying it to the credential the SAME response
// linked to the helper's callers, and nothing said the callout ran in @future.
describe('endpointCatalogHandler — dynamic callout credential join + async context', () => {
  let jDir: string;
  let jStore: GraphStore;
  let jCtx: Context;

  beforeAll(async () => {
    jDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-endpoint-join-'));
    const classes = join(jDir, 'source', 'classes');
    const triggers = join(jDir, 'source', 'triggers');
    mkdirSync(classes, { recursive: true });
    mkdirSync(triggers, { recursive: true });
    writeFileSync(
      join(classes, 'Relay_Util.cls'),
      [
        'public class Relay_Util {',
        '  @future(callout=true)',
        '  public static void push(String credName, String body) {',
        '    HttpRequest req = new HttpRequest();',
        "    req.setEndpoint('callout:' + credName + '/batch');",
        '    new Http().send(req);',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(triggers, 'Relay_Visit_Trigger.trigger'),
      "trigger Relay_Visit_Trigger on Visit_Event__e (after insert) {\n  Relay_Util.push('Relay_Fn', 'x');\n}\n",
    );
    // An unrelated class naming a different credential: not a caller, no join.
    writeFileSync(
      join(classes, 'Other_Thing.cls'),
      "public class Other_Thing {\n  static String n = 'Unrelated_Fn';\n}\n",
    );
    writeFileSync(
      join(classes, 'Sync_Job.cls'),
      [
        'public class Sync_Job implements Queueable, Database.AllowsCallouts {',
        '  public void execute(QueueableContext ctx) {',
        '    HttpRequest req = new HttpRequest();',
        "    req.setEndpoint('callout:Ledger_Fn/sync');",
        '  }',
        '}',
      ].join('\n'),
    );
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'ApexClass:Relay_Util', apiName: 'Relay_Util', sourcePath: 'source/classes/Relay_Util.cls' }),
        makeNode({ id: 'ApexClass:Other_Thing', apiName: 'Other_Thing', sourcePath: 'source/classes/Other_Thing.cls' }),
        makeNode({ id: 'ApexClass:Sync_Job', apiName: 'Sync_Job', sourcePath: 'source/classes/Sync_Job.cls' }),
        makeNode({
          id: 'ApexTrigger:Relay_Visit_Trigger',
          type: 'ApexTrigger',
          apiName: 'Relay_Visit_Trigger',
          sourcePath: 'source/triggers/Relay_Visit_Trigger.trigger',
        }),
        makeNode({ id: 'NamedCredential:Relay_Fn', type: 'NamedCredential', apiName: 'Relay_Fn' }),
        makeNode({ id: 'NamedCredential:Unrelated_Fn', type: 'NamedCredential', apiName: 'Unrelated_Fn' }),
        makeNode({ id: 'NamedCredential:Ledger_Fn', type: 'NamedCredential', apiName: 'Ledger_Fn' }),
      ],
      edges: [
        makeEdge({
          fromId: 'ApexTrigger:Relay_Visit_Trigger',
          toId: 'ApexClass:Relay_Util',
          edgeType: 'references',
          confidence: 'heuristic',
        }),
      ],
    };
    const opened = await openGraph(join(jDir, 'j.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    jStore = opened.value;
    const imported = await importExtractionResults(jStore, [seed]);
    if (!imported.ok) throw new Error(imported.error.message);
    jCtx = { vaultRoot: jDir, manifest: FIXTURE_MANIFEST, graph: jStore };
  });

  afterAll(async () => {
    await closeGraph(jStore);
    rmSync(jDir, { recursive: true, force: true });
  });

  it('joins a dynamic helper callout to the credential its direct caller names (heuristic tier)', async () => {
    const r = await endpointCatalogHandler(jCtx, {});
    if (!r.ok) throw new Error(r.error.message);
    const relay = r.value.data.apexCallouts.find((c) => c.sourceComponentId === 'ApexClass:Relay_Util');
    expect(relay?.target).toBe('dynamic');
    expect(relay?.credentialCandidates).toEqual([
      {
        namedCredential: 'NamedCredential:Relay_Fn',
        tier: 'direct-caller',
        namedIn: ['ApexTrigger:Relay_Visit_Trigger'],
        confidence: 'heuristic',
      },
    ]);
  });

  it('marks a @future(callout=true) site async at method granularity', async () => {
    const r = await endpointCatalogHandler(jCtx, {});
    if (!r.ok) throw new Error(r.error.message);
    const relay = r.value.data.apexCallouts.find((c) => c.sourceComponentId === 'ApexClass:Relay_Util');
    expect(relay?.asyncContext).toEqual({ mechanism: 'future', allowsCallouts: true, granularity: 'method' });
  });

  it('marks a Queueable + AllowsCallouts class async at class granularity, and adds no candidates to a named site', async () => {
    const r = await endpointCatalogHandler(jCtx, {});
    if (!r.ok) throw new Error(r.error.message);
    const job = r.value.data.apexCallouts.find((c) => c.sourceComponentId === 'ApexClass:Sync_Job');
    expect(job?.target).toBe('named-credential');
    expect(job?.asyncContext).toEqual({ mechanism: 'queueable', allowsCallouts: true, granularity: 'class' });
    expect(job?.credentialCandidates).toBeUndefined();
  });
});

describe('calloutAsyncContext', () => {
  it('does not mark a call site after the @future method body ends', async () => {
    const { calloutAsyncContext } = await import('../../src/tools/apex-callouts.js');
    const src = [
      'public class Mixed {',
      '  @future',
      "  static void later() { String s = '{'; }",
      '  static void now() {',
      "    req.setEndpoint('callout:X');",
      '  }',
      '}',
    ].join('\n');
    expect(calloutAsyncContext(src, 5)).toBeUndefined();
    expect(calloutAsyncContext(src, 3)).toEqual({ mechanism: 'future', allowsCallouts: false, granularity: 'method' });
  });
});
