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
    expect(d.inboundApis).toHaveLength(2);
    const restEntry = d.inboundApis.find((e) => e.endpointKind === 'rest');
    expect(restEntry).toBeDefined();
    expect(restEntry?.direction).toBe('inbound');
    expect(restEntry?.sourceComponentId).toBe(REST_CLASS);
    const auraEntry = d.inboundApis.find((e) => e.endpointKind === 'aura');
    expect(auraEntry).toBeDefined();
    expect(auraEntry?.url).toBe('LeadAuraApi.getLeads');
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
    // 2 inbound + (1 outbound msg + 1 EDS + 2 NCs + 2 omni-rest) = 6 outbound.
    expect(d.summary.inboundCount).toBe(2);
    expect(d.summary.outboundCount).toBe(6);
    expect(d.summary.totalEndpoints).toBe(8);
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

  it('the bare no-scope call is unchanged (byte-identical golden — 8 endpoints, no appliedScope)', async () => {
    const r = await endpointCatalogHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.totalEndpoints).toBe(8);
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
