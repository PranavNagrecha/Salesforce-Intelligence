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
