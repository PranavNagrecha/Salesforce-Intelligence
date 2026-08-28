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

// =============================================================================
// Seed 4: an object that EXISTS in the vault but defines ZERO outbound
// messages. The scoped-negative case: a zero-entry answer for THIS object is
// not a statement about the org, which defines three.
// =============================================================================

const CASE_OBJECT = 'CustomObject:Case';

const caseSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CASE_OBJECT,
      type: 'CustomObject',
      apiName: 'Case',
    }),
  ],
  edges: [],
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
    caseSeed,
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

// =============================================================================
// OUTBOUND-MESSAGE-CATALOG-UNVERIFIED-OBJECT-SCOPE (R4 / HIGH)
//
// `objectFilter` was a case-SENSITIVE exact string comparison against the
// apiName prefix, with no check that the named object exists — and the
// zero-entry disclosure made an ORG-WIDE determinate-negative claim ("no
// outbound message definitions exist in this org … the org defines none … do
// not suggest a refresh") computed from the count AFTER the narrowing. So a
// scoped call, a wrong-case object name and an outright typo all produced the
// same flatly false org-wide negative, with the disclosure explicitly telling
// the reader not to investigate further.
// =============================================================================

/**
 * A manifest whose WorkflowRule family is CONFIRMED-complete, so
 * `summarizeCoverage` returns `complete` and the zero-entry disclosure takes
 * the DETERMINATE-NEGATIVE branch — the branch the census flagged.
 */
const COMPLETE_COVERAGE_MANIFEST = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3, OutboundMessage: 3, WorkflowRule: 2 },
  edges: {},
  sourceTreeHash: 'sha256:outbound-fixture-complete',
  coverage: [
    {
      type: 'WorkflowRule',
      requested: true,
      retrieved: 2,
      errored: false,
      neverModeled: false,
      retrieveConfirmed: true,
    },
  ],
} as unknown as VaultManifest;

describe('outboundMessageCatalogHandler — objectFilter is a VERIFIED scope', () => {
  it('does not emit the ORG-WIDE determinate negative for a SCOPED zero-result', async () => {
    // The org defines three outbound messages (two on Account, one on
    // Contact) and WorkflowRule coverage is COMPLETE. Scoping to Case — a real
    // object with none — must not turn that into "the org defines none … do
    // not suggest a refresh".
    const completeCtx: Context = {
      vaultRoot: tempDir,
      manifest: COMPLETE_COVERAGE_MANIFEST,
      graph: store,
    };
    const orgWide = await outboundMessageCatalogHandler(completeCtx, {});
    expect(orgWide.ok).toBe(true);
    if (!orgWide.ok) return;
    expect(orgWide.value.data.summary.totalEntries).toBe(3);
    expect(orgWide.value.data.coverageStatus).toBe('complete');

    const scoped = await outboundMessageCatalogHandler(completeCtx, {
      objectFilter: 'Case',
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    const d = scoped.value.data;
    expect(d.summary.totalEntries).toBe(0);
    expect(d.disclosure).not.toContain(
      'No outbound message definitions exist in this org',
    );
    expect(d.disclosure).not.toContain('the org defines none');
    expect(d.disclosure).toContain('Case');
  });

  it('does not claim the ORG defines none when the SCOPE defines none', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {
      objectFilter: 'Case',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // The org defines three outbound messages; Case defines none.
    expect(d.summary.totalEntries).toBe(0);
    expect(d.disclosure).not.toContain('exist in this org');
    expect(d.disclosure).not.toContain('the org defines none');
    // ...and it must say WHICH object the negative is about.
    expect(d.disclosure).toContain('Case');
  });

  it('echoes appliedScope on a scoped call and omits it on a bare call', async () => {
    const scoped = await outboundMessageCatalogHandler(ctx, {
      objectFilter: 'Account',
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.value.data.appliedScope).toEqual({
      object: ACCOUNT_OBJECT,
      mode: 'component',
    });

    const bare = await outboundMessageCatalogHandler(ctx, {});
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.value.data).not.toHaveProperty('appliedScope');
  });

  it("resolves a wrong-CASE objectFilter ('account') to the vault's casing instead of answering about the empty set", async () => {
    const result = await outboundMessageCatalogHandler(ctx, {
      objectFilter: 'account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.summary.totalEntries).toBe(2);
    const ids = d.entries.map((e) => e.outboundMessageId);
    expect(ids).toContain(ACCOUNT_OM);
    expect(ids).toContain(ORPHAN_OM);
    expect(d.appliedScope?.object).toBe(ACCOUNT_OBJECT);
  });

  it('REFUSES an objectFilter naming an object that is not in the vault', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {
      objectFilter: 'Acount__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('Acount__c');
  });

  it('keeps the scoped non-empty answer from reading as an org-wide catalog', async () => {
    const result = await outboundMessageCatalogHandler(ctx, {
      objectFilter: 'Contact',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.summary.totalEntries).toBe(1);
    expect(d.disclosure).toContain('SCOPED');
    expect(d.disclosure).toContain('NOT VALIDATED');
  });
});

// =============================================================================
// OUTBOUND-MESSAGE-CATALOG-CERTIFIES-AN-UNCHECKED-WORKFLOW-CORPUS (R1 / MEDIUM)
//
// The zero-entry disclosure upgraded "no OutboundMessage nodes" into an ORG
// FACT — "the org defines none … do not suggest a refresh" — on the strength of
// ONE manifest row: `summarizeCoverage(manifest, ['WorkflowRule']).status`.
//
// That row is a PER-TYPE retrieve tally. It does not certify that every
// object's `.workflow-meta.xml` reached the vault, and classic SOAP
// `<outboundMessages>` live inside those FILES. On a real vault the row read
// `complete` while retrieved approval processes referenced workflow actions on
// an object for which this vault holds NO modeled workflow component at all —
// so the file that would have carried that object's outbound messages was never
// scanned, and the answer certified it anyway AND told the reader to stop
// looking.
//
// Note on the evidence shape: `WorkflowFieldUpdate:` / `WorkflowTask:`
// references dangle BY DESIGN (no extractor mints those node types), so an
// unresolved reference alone is NOT a gap. The gap is an object that is
// REFERENCED by a workflow-action id while this vault holds NO node of a type
// the workflow extractor actually mints (WorkflowRule / WorkflowAlert /
// OutboundMessage) for it.
// =============================================================================

const MODELED_OBJECT = 'CustomObject:Obj_A__c';
const MODELED_ALERT = 'WorkflowAlert:Obj_A__c.Notify_Owner';
const UNMODELED_OBJECT = 'CustomObject:Pkg_Obj_B__c';

/**
 * A manifest whose WorkflowRule row is `requested + retrieveConfirmed` with a
 * zero tally — EXACTLY the row shape the real vault carries, and the one
 * `summarizeCoverage` reports as `complete`.
 */
const CONFIRMED_WORKFLOW_ROW_MANIFEST = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2 },
  edges: {},
  sourceTreeHash: 'sha256:outbound-workflow-blindspot',
  coverage: [
    {
      type: 'WorkflowRule',
      requested: true,
      retrieved: 0,
      errored: false,
      neverModeled: false,
      retrieveConfirmed: true,
    },
  ],
} as unknown as VaultManifest;

describe('outboundMessageCatalogHandler — a zero is never certified over an unscanned workflow corpus', () => {
  let gapDir: string;
  let gapStore: GraphStore;
  let gapCtx: Context;

  beforeAll(async () => {
    gapDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-outbound-gap-'));
    const opened = await openGraph(join(gapDir, 'gap.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    gapStore = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: MODELED_OBJECT, type: 'CustomObject', apiName: 'Obj_A__c' }),
        // Obj_A__c's workflow metadata IS modeled here (an alert node came out
        // of its `.workflow-meta.xml`), so its dangling field-update reference
        // below is dangling-BY-DESIGN and must NOT be reported as a gap.
        makeNode({
          id: MODELED_ALERT,
          type: 'WorkflowAlert',
          apiName: 'Obj_A__c.Notify_Owner',
          parentId: MODELED_OBJECT,
          properties: { name: 'Notify_Owner' },
        }),
        makeNode({
          id: UNMODELED_OBJECT,
          type: 'CustomObject',
          apiName: 'Pkg_Obj_B__c',
        }),
        makeNode({
          id: 'ApprovalProcess:Obj_A__c.Approve_A',
          type: 'ApprovalProcess',
          apiName: 'Obj_A__c.Approve_A',
        }),
        makeNode({
          id: 'ApprovalProcess:Pkg_Obj_B__c.Approve_B',
          type: 'ApprovalProcess',
          apiName: 'Pkg_Obj_B__c.Approve_B',
        }),
      ],
      edges: [
        makeEdge({
          fromId: 'ApprovalProcess:Obj_A__c.Approve_A',
          toId: 'WorkflowFieldUpdate:Obj_A__c.Set_Status',
          edgeType: 'references',
        }),
        makeEdge({
          fromId: 'ApprovalProcess:Pkg_Obj_B__c.Approve_B',
          toId: 'WorkflowFieldUpdate:Pkg_Obj_B__c.Set_Approved',
          edgeType: 'references',
        }),
        makeEdge({
          fromId: 'ApprovalProcess:Pkg_Obj_B__c.Approve_B',
          toId: 'WorkflowFieldUpdate:Pkg_Obj_B__c.Set_Rejected',
          edgeType: 'references',
        }),
      ],
    };
    const imported = await importExtractionResults(gapStore, [seed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    gapCtx = {
      vaultRoot: gapDir,
      manifest: CONFIRMED_WORKFLOW_ROW_MANIFEST,
      graph: gapStore,
    };
  });

  afterAll(async () => {
    await closeGraph(gapStore);
    rmSync(gapDir, { recursive: true, force: true });
  });

  it('does not report coverageStatus=complete when an object’s workflow metadata is not modeled in this vault', async () => {
    const result = await outboundMessageCatalogHandler(gapCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.summary.totalEntries).toBe(0);
    expect(result.value.data.coverageStatus).not.toBe('complete');
  });

  it('names the unscanned objects in a TYPED coverageGap a machine consumer cannot skip', async () => {
    const result = await outboundMessageCatalogHandler(gapCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gap = result.value.data.coverageGap;
    expect(gap).not.toBeNull();
    // ONLY the object with no modeled workflow component. Obj_A__c also has an
    // unresolved `WorkflowFieldUpdate:` reference, but that family is never
    // minted as nodes, so flagging it would be crying wolf on every vault.
    expect(gap?.objectsWithoutModeledWorkflowMetadata).toEqual(['Pkg_Obj_B__c']);
    expect(gap?.unresolvedWorkflowReferenceCount).toBe(2);
  });

  it('does not tell the reader to stop looking, and says which object was not scanned', async () => {
    const result = await outboundMessageCatalogHandler(gapCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const disclosure = result.value.data.disclosure;
    expect(disclosure).not.toContain('do not suggest a refresh');
    expect(disclosure).not.toContain(
      'No outbound message definitions exist in this org',
    );
    expect(disclosure).toContain('Pkg_Obj_B__c');
  });

  it('a call SCOPED to the unscanned object says the zero is not a checked zero for it', async () => {
    const result = await outboundMessageCatalogHandler(gapCtx, {
      objectFilter: 'Pkg_Obj_B__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.summary.totalEntries).toBe(0);
    expect(d.disclosure).toContain('NOT a checked zero for Pkg_Obj_B__c');
    expect(d.disclosure).not.toContain('determinate negative');
  });

  it('does NOT hedge a scoped answer for an object the gap is not about', async () => {
    const result = await outboundMessageCatalogHandler(gapCtx, {
      objectFilter: 'Obj_A__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // Obj_A__c's own workflow metadata IS modeled, so its zero is a checked
    // zero — the org-wide downgrade must not be laundered into a warning about
    // Obj_A__c that the reader cannot act on...
    expect(d.disclosure).toContain('determinate negative FOR Obj_A__c');
    expect(d.disclosure).not.toContain('NOT a checked zero');
    // ...but the org-wide downgrade is still stated, and still typed.
    expect(d.coverageStatus).toBe('partial');
    expect(d.disclosure).toContain('Org-wide note');
    expect(d.coverageGap?.objectsWithoutModeledWorkflowMetadata).toEqual([
      'Pkg_Obj_B__c',
    ]);
  });

  it('leaves coverageGap null on a vault with no unscanned workflow object (control)', async () => {
    const cleanDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-outbound-clean-'));
    const opened = await openGraph(join(cleanDir, 'clean.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const cleanStore = opened.value;
    const imported = await importExtractionResults(cleanStore, [
      {
        nodes: [
          makeNode({ id: MODELED_OBJECT, type: 'CustomObject', apiName: 'Obj_A__c' }),
          makeNode({
            id: MODELED_ALERT,
            type: 'WorkflowAlert',
            apiName: 'Obj_A__c.Notify_Owner',
            parentId: MODELED_OBJECT,
            properties: { name: 'Notify_Owner' },
          }),
        ],
        edges: [],
      },
    ]);
    expect(imported.ok).toBe(true);
    const result = await outboundMessageCatalogHandler(
      {
        vaultRoot: cleanDir,
        manifest: CONFIRMED_WORKFLOW_ROW_MANIFEST,
        graph: cleanStore,
      },
      {},
    );
    await closeGraph(cleanStore);
    rmSync(cleanDir, { recursive: true, force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.coverageGap).toBeNull();
    expect(result.value.data.coverageStatus).toBe('complete');
    expect(result.value.data.disclosure).toContain('determinate negative');
  });
});
