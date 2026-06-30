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
  outboundMessageCatalogHandler,
  outboundMessageCatalogInputSchema,
} from '../../src/tools/outbound-message-catalog.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    OutboundMessage: 3,
    WorkflowRule: 2,
  },
  edges: { parentOf: 3, references: 2 },
  sourceTreeHash: 'sha256:outbound-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'OutboundMessage',
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
  source: 'workflow-rule-extractor',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: an Account.SendOrderToWarehouse outbound message invoked by one
// WorkflowRule. Full property set including endpointUrl, fields list.
// =============================================================================

const ACCOUNT_OBJECT = 'CustomObject:Account';
const ACCOUNT_OM = 'OutboundMessage:Account.SendOrderToWarehouse';
const ACCOUNT_RULE = 'WorkflowRule:Account.NotifyWarehouseOnOrder';

const accountSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ACCOUNT_OBJECT,
      type: 'CustomObject',
      apiName: 'Account',
    }),
    makeNode({
      id: ACCOUNT_OM,
      type: 'OutboundMessage',
      apiName: 'Account.SendOrderToWarehouse',
      label: 'SendOrderToWarehouse',
      parentId: ACCOUNT_OBJECT,
      properties: {
        name: 'SendOrderToWarehouse',
        endpointUrl: 'https://warehouse.example.com/inbound',
        includeSessionId: true,
        useDeadLetterQueue: false,
        integrationUser: 'integration@example.com',
        fields: ['Id', 'Name', 'Amount'],
      },
    }),
    makeNode({
      id: ACCOUNT_RULE,
      type: 'WorkflowRule',
      apiName: 'Account.NotifyWarehouseOnOrder',
    }),
  ],
  edges: [
    makeEdge({
      fromId: ACCOUNT_OBJECT,
      toId: ACCOUNT_OM,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: ACCOUNT_RULE,
      toId: ACCOUNT_OM,
      edgeType: 'references',
      properties: { actionType: 'OutboundMessage' },
    }),
  ],
};

// =============================================================================
// Seed 2: a second Account outbound message with no known invoker (an
// orphan). Used to verify the catalog surfaces orphans with an empty
// invokedByWorkflowRules array.
// =============================================================================

const ORPHAN_OM = 'OutboundMessage:Account.OrphanOutboundMessage';

const orphanSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ORPHAN_OM,
      apiName: 'Account.OrphanOutboundMessage',
      label: 'OrphanOutboundMessage',
      parentId: ACCOUNT_OBJECT,
      properties: {
        name: 'OrphanOutboundMessage',
        endpointUrl: 'https://orphan.example.com/inbound',
        includeSessionId: false,
        useDeadLetterQueue: true,
        integrationUser: null,
        fields: ['Id'],
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: ACCOUNT_OBJECT,
      toId: ORPHAN_OM,
      edgeType: 'parentOf',
    }),
  ],
};

// =============================================================================
// Seed 3: an outbound message on a different parent (Contact) — used to
// verify the objectFilter narrowing.
// =============================================================================

const CONTACT_OBJECT = 'CustomObject:Contact';
const CONTACT_OM = 'OutboundMessage:Contact.SyncContactToCdp';
const CONTACT_RULE = 'WorkflowRule:Contact.SyncToCdpOnCreate';

const contactSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CONTACT_OBJECT,
      type: 'CustomObject',
      apiName: 'Contact',
    }),
    makeNode({
      id: CONTACT_OM,
      apiName: 'Contact.SyncContactToCdp',
      label: 'SyncContactToCdp',
      parentId: CONTACT_OBJECT,
      properties: {
        name: 'SyncContactToCdp',
        endpointUrl: 'https://cdp.example.com/contacts',
        includeSessionId: false,
        useDeadLetterQueue: false,
        integrationUser: null,
        fields: ['Id', 'Email', 'FirstName', 'LastName'],
      },
    }),
    makeNode({
      id: CONTACT_RULE,
      type: 'WorkflowRule',
      apiName: 'Contact.SyncToCdpOnCreate',
    }),
  ],
  edges: [
    makeEdge({
      fromId: CONTACT_OBJECT,
      toId: CONTACT_OM,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: CONTACT_RULE,
      toId: CONTACT_OM,
      edgeType: 'references',
      properties: { actionType: 'OutboundMessage' },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-outbound-message-'));
  const opened = await openGraph(join(tempDir, 'outbound.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    accountSeed,
    orphanSeed,
    contactSeed,
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

describe('outboundMessageCatalogHandler', () => {
  it('returns every OutboundMessage in the graph by default', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.entries).toHaveLength(3);
    expect(d.summary.totalEntries).toBe(3);
    expect(d.summary.totalObjects).toBe(2);
  });

  it("narrows the catalog by objectFilter='Account'", async () => {
    const result = await outboundMessageCatalogHandler(ctx, {
      objectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.entries).toHaveLength(2);
    const ids = d.entries.map((e) => e.outboundMessageId);
    expect(ids).toContain(ACCOUNT_OM);
    expect(ids).toContain(ORPHAN_OM);
    expect(ids).not.toContain(CONTACT_OM);
    expect(d.summary.totalObjects).toBe(1);
  });

  it('surfaces endpoint properties verbatim', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {
      objectFilter: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.data.entries.find(
      (e) => e.outboundMessageId === ACCOUNT_OM,
    );
    expect(entry?.endpointUrl).toBe('https://warehouse.example.com/inbound');
    expect(entry?.includeSessionId).toBe(true);
    expect(entry?.useDeadLetterQueue).toBe(false);
    expect(entry?.integrationUser).toBe('integration@example.com');
    expect(entry?.fields).toEqual(['Id', 'Name', 'Amount']);
    expect(entry?.name).toBe('SendOrderToWarehouse');
    expect(entry?.parentObjectId).toBe(ACCOUNT_OBJECT);
  });

  it('surfaces invokedByWorkflowRules computed from incoming references edges', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.data.entries.find(
      (e) => e.outboundMessageId === ACCOUNT_OM,
    );
    expect(entry?.invokedByWorkflowRules).toHaveLength(1);
    expect(entry?.invokedByWorkflowRules[0]?.workflowRuleId).toBe(ACCOUNT_RULE);
    expect(entry?.invokedByWorkflowRules[0]?.apiName).toBe(
      'Account.NotifyWarehouseOnOrder',
    );
  });

  it('surfaces orphan entries (no invokers) with an empty invokedByWorkflowRules', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const orphan = result.value.data.entries.find(
      (e) => e.outboundMessageId === ORPHAN_OM,
    );
    expect(orphan).toBeDefined();
    expect(orphan?.invokedByWorkflowRules).toEqual([]);
    expect(orphan?.useDeadLetterQueue).toBe(true);
  });

  it('groups entries by parent object in entriesByObject', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grouped = result.value.data.entriesByObject;
    expect(Object.keys(grouped).sort()).toEqual(['Account', 'Contact']);
    expect(grouped['Account']?.length).toBe(2);
    expect(grouped['Contact']?.length).toBe(1);
  });

  it('sorts entries by outboundMessageId ASC', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.entries.map((e) => e.outboundMessageId);
    expect(ids).toEqual([...ids].sort());
  });

  it('returns honest summary counts', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.summary.totalEntries).toBe(3);
    expect(d.summary.totalObjects).toBe(2);
    // 2 of the 3 entries have known invokers (Account.SendOrderToWarehouse,
    // Contact.SyncContactToCdp); the orphan does not.
    expect(d.summary.entriesWithKnownInvokers).toBe(2);
  });

  it('returns an honest disclosure mentioning the URL-not-validated boundary', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('NOT VALIDATED');
    expect(result.value.data.disclosure).toContain('endpointUrl');
  });

  it('carries vaultState from the manifest', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(
      'sha256:outbound-fixture',
    );
  });
});

describe('outboundMessageCatalogInputSchema', () => {
  it('accepts an empty input', () => {
    expect(outboundMessageCatalogInputSchema.safeParse({}).success).toBe(true);
  });

  it("accepts objectFilter='Account'", () => {
    expect(
      outboundMessageCatalogInputSchema.safeParse({ objectFilter: 'Account' })
        .success,
    ).toBe(true);
  });

  it('rejects an empty-string objectFilter', () => {
    expect(
      outboundMessageCatalogInputSchema.safeParse({ objectFilter: '' }).success,
    ).toBe(false);
  });
});

// =============================================================================
// QA batch 8: a zero-outbound-message org must NOT be framed as a coverage
// gap when the backing WorkflowRule family is fully covered. The classic SOAP
// `<outboundMessages>` definitions live inside the same `.workflow-meta.xml`
// the WorkflowRule extractor retrieves, so "complete WorkflowRule coverage +
// zero OutboundMessage nodes" is a DETERMINATE NEGATIVE (the org defines
// none), not "we failed to retrieve them".
// =============================================================================

describe('outboundMessageCatalogHandler — zero-result honesty (batch 8)', () => {
  let emptyDir: string;
  let emptyStore: GraphStore;

  beforeAll(async () => {
    emptyDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-outbound-empty-'));
    const opened = await openGraph(join(emptyDir, 'empty.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    emptyStore = opened.value;
    // An org with workflow rules but ZERO outbound messages.
    const seed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'CustomObject:Account',
          type: 'CustomObject',
          apiName: 'Account',
        }),
        makeNode({
          id: 'WorkflowRule:Account.SendWelcomeEmail',
          type: 'WorkflowRule',
          apiName: 'Account.SendWelcomeEmail',
        }),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(emptyStore, [seed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  afterAll(async () => {
    await closeGraph(emptyStore);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('reports coverageStatus=complete and a determinate-negative disclosure when WorkflowRule coverage is complete', async () => {
    const completeManifest = {
      version: '0.1.0',
      refreshedAt: '2026-05-27T14:33:08Z',
      sourceOrg: 'me@example.com',
      components: { CustomObject: 1, WorkflowRule: 1 },
      edges: {},
      sourceTreeHash: 'sha256:outbound-empty-complete',
      // A real refreshed vault carries explicit coverage rows. The
      // WorkflowRule family — host of classic `<outboundMessages>` — was
      // confirmed-cleanly retrieved, so its coverage is COMPLETE.
      coverage: [
        {
          type: 'WorkflowRule',
          requested: true,
          retrieved: 1,
          errored: false,
          neverModeled: false,
          retrieveConfirmed: true,
        },
      ],
    } as unknown as VaultManifest;
    const localCtx: Context = {
      vaultRoot: emptyDir,
      manifest: completeManifest,
      graph: emptyStore,
    };
    const result = await outboundMessageCatalogHandler(localCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.summary.totalEntries).toBe(0);
    expect(d.coverageStatus).toBe('complete');
    // Determinate negative: must state the org defines none and must NOT
    // imply the data is merely un-retrieved.
    expect(d.disclosure).toContain('No outbound message definitions exist');
    expect(d.disclosure).toContain('determinate negative');
    expect(d.disclosure).not.toContain('inconclusive');
  });

  it('reports coverageStatus!=complete and an inconclusive disclosure when WorkflowRule coverage is partial', async () => {
    const partialManifest = {
      version: '0.1.0',
      refreshedAt: '2026-05-27T14:33:08Z',
      sourceOrg: 'me@example.com',
      components: { CustomObject: 1, WorkflowRule: 0 },
      edges: {},
      sourceTreeHash: 'sha256:outbound-empty-partial',
      // Explicit coverage row: WorkflowRule requested but retrieved zero
      // WITHOUT a confirmed-clean retrieve => partial (not a confirmed empty).
      coverage: [
        {
          type: 'WorkflowRule',
          requested: true,
          retrieved: 0,
          errored: false,
          neverModeled: false,
        },
      ],
    } as unknown as VaultManifest;
    const localCtx: Context = {
      vaultRoot: emptyDir,
      manifest: partialManifest,
      graph: emptyStore,
    };
    const result = await outboundMessageCatalogHandler(localCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.summary.totalEntries).toBe(0);
    expect(d.coverageStatus).not.toBe('complete');
    expect(d.disclosure).toContain('INCONCLUSIVE');
    expect(d.disclosure).not.toContain('No outbound message definitions exist');
  });
});
