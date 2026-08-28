/// <reference types="vitest/globals" />

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
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
import { generateOnboardingDocHandler } from '../../src/tools/generate-onboarding-doc.js';

// A graph query that FAILS must not be reported as an absent v1.7 enrichment.
// There is no way to make a real DuckDB query fail for one type, so
// `listNodesByType` is wrapped: ApexClass reads are counted, and the read whose
// 1-based index is >= `scanState.failFrom` returns a typed query-failed Result.
// `failFrom` is +Infinity by default, so every other case in this file runs
// against the real, unmocked query.
const { scanState } = vi.hoisted(() => ({
  scanState: { apexCalls: 0, failFrom: Number.POSITIVE_INFINITY },
}));

vi.mock('@sf-intelligence/graph', async () => {
  const actual = await vi.importActual<typeof import('@sf-intelligence/graph')>(
    '@sf-intelligence/graph',
  );
  return {
    ...actual,
    listNodesByType: async (
      store: Parameters<typeof actual.listNodesByType>[0],
      type: Parameters<typeof actual.listNodesByType>[1],
      options?: Parameters<typeof actual.listNodesByType>[2],
    ) => {
      if (type !== 'ApexClass') return actual.listNodesByType(store, type, options);
      scanState.apexCalls += 1;
      if (scanState.apexCalls >= scanState.failFrom) {
        return {
          ok: false as const,
          error: {
            kind: 'query-failed' as const,
            message: 'listNodesByType: simulated store failure',
          },
        };
      }
      return actual.listNodesByType(store, type, options);
    },
  };
});

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'acme@example.com',
  components: { CustomObject: 2, CustomField: 4, ApexClass: 1 },
  edges: { parentOf: 4 },
  sourceTreeHash: 'sha256:onboarding-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
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

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account', label: 'Account' }),
    makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact', label: 'Contact' }),
    // Field with a label only on Account — should appear in glossary.
    makeNode({
      id: 'CustomField:Account.StrategicTier__c',
      type: 'CustomField',
      apiName: 'StrategicTier__c',
      label: 'Strategic Tier',
      parentId: 'CustomObject:Account',
      properties: { dataType: 'Text' },
    }),
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: 'CustomObject:Account',
      properties: { dataType: 'Picklist' },
    }),
    makeNode({
      id: 'CustomField:Contact.Title__c',
      type: 'CustomField',
      apiName: 'Title__c',
      label: 'Title',
      parentId: 'CustomObject:Contact',
      properties: { dataType: 'Text' },
    }),
    makeNode({
      id: 'CustomField:Contact.AccountScore__c',
      type: 'CustomField',
      apiName: 'AccountScore__c',
      label: 'Account Score',
      parentId: 'CustomObject:Contact',
      properties: { dataType: 'Number' },
    }),
    makeNode({
      id: 'ApexClass:HelloWorld',
      type: 'ApexClass',
      apiName: 'HelloWorld',
      lastModifiedDate: '2026-05-20T10:00:00Z',
      lastModifiedBy: 'Alice',
    }),
    makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
  ],
  edges: [],
};

let tempDir: string;

const makeFreshCtx = async (
  dbName: string,
): Promise<{ ctx: Context; store: GraphStore }> => {
  const opened = await openGraph(join(tempDir, dbName));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const ctx: Context = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
  return { ctx, store };
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-onboarding-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('generateOnboardingDocHandler (empty graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('empty.db');
    store = built.store;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns a minimal valid document and surfaces Key Contacts disclosure', async () => {
    const result = await generateOnboardingDocHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.body).toContain('Welcome to acme@example.com');
    expect(doc.body).toContain('Key Contacts data depends on v1.7 enrichment');
  });
});

describe('generateOnboardingDocHandler (seeded graph, admin persona)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('seeded-admin.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns a valid frontmatter with title and componentIds', async () => {
    const result = await generateOnboardingDocHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.frontmatter.title).toContain('Welcome to acme@example.com');
    expect(doc.frontmatter.sourceTreeHash).toBe('sha256:onboarding-fixture');
    expect(doc.frontmatter.componentIds.length).toBeGreaterThan(0);
  });

  it('deduplicates componentIds across the chained handbook + arch + top objects', async () => {
    const result = await generateOnboardingDocHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.document.frontmatter.componentIds;
    // Onboarding merges the admin-handbook's componentIds + the architecture
    // overview's componentIds + the top objects — the same objects appear in
    // all three sources. The frontmatter id list is a provenance SET.
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('emits all required H2 sections', async () => {
    const result = await generateOnboardingDocHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## What This Org Does');
    expect(body).toContain('## Main Data Model');
    expect(body).toContain('## Common Workflows');
    expect(body).toContain('## How Security Works');
    expect(body).toContain('## Naming Conventions');
    expect(body).toContain('## Glossary');
    expect(body).toContain('## Key Contacts');
    expect(body).toContain('## Where To Go Next');
  });

  it('surfaces org-specific labels in the glossary', async () => {
    const result = await generateOnboardingDocHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // Both 'Strategic Tier' and 'Account Score' appear on a single
    // object → they qualify as glossary entries.
    expect(body).toContain('Strategic Tier');
    expect(body).toContain('Account Score');
  });

  it('populates Key Contacts when at least one node carries lastModifiedBy', async () => {
    const result = await generateOnboardingDocHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Alice');
  });

  it('surfaces admin-persona tool hints in Where To Go Next', async () => {
    const result = await generateOnboardingDocHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const idx = body.indexOf('## Where To Go Next');
    expect(idx).toBeGreaterThan(0);
    const nextSection = body.slice(idx);
    expect(nextSection).toContain('sfi.org_overview');
  });
});

describe('generateOnboardingDocHandler (developer persona)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('seeded-dev.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('surfaces developer-persona tool hints in Where To Go Next', async () => {
    const result = await generateOnboardingDocHandler(ctx, {
      personaFocus: 'developer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const idx = body.indexOf('## Where To Go Next');
    expect(idx).toBeGreaterThan(0);
    const nextSection = body.slice(idx);
    expect(nextSection).toContain('sfi.find_code_usages');
  });

  it('still surfaces glossary heuristic boundary when developer persona', async () => {
    const result = await generateOnboardingDocHandler(ctx, {
      personaFocus: 'developer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.document.boundaries;
    const joined = boundaries.join('\n');
    expect(joined).toContain('Glossary entries are heuristic');
  });
});

describe('generateOnboardingDocHandler — full CustomField corpus glossary', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('big-glossary.db');
    store = built.store;
    ctx = built.ctx;
    // More than the graph layer's 500-row page of CustomFields. Each filler
    // carries a distinct label (objectCount 1, so all glossary-eligible) on
    // object Acct, with ids that sort FIRST. The one target term lives on a
    // LATE-sorting object (zzz_Late_Obj) so its field id sorts LAST — past the
    // first 500-row page — yet its apiName (aaa_term__c) sorts FIRST, heading
    // the glossary's objectCount-then-apiName order. So the term tops the
    // glossary, but only if the handler scans the whole corpus.
    const obj = 'CustomObject:Acct';
    const lateObj = 'CustomObject:zzz_Late_Obj';
    const nodes: Node[] = [
      makeNode({
        id: obj,
        type: 'CustomObject',
        apiName: 'Acct',
        label: 'Acct',
      }),
      makeNode({
        id: lateObj,
        type: 'CustomObject',
        apiName: 'zzz_Late_Obj',
        label: 'Late Obj',
      }),
    ];
    for (let i = 0; i < 505; i++) {
      const n = String(i).padStart(3, '0');
      nodes.push(
        makeNode({
          id: `CustomField:Acct.bbb_filler_${n}__c`,
          type: 'CustomField',
          apiName: `bbb_filler_${n}__c`,
          label: `Filler ${n}`,
          parentId: obj,
        }),
      );
    }
    nodes.push(
      makeNode({
        id: 'CustomField:zzz_Late_Obj.aaa_term__c',
        type: 'CustomField',
        apiName: 'aaa_term__c',
        label: 'AAA Onboarding Term',
        parentId: lateObj,
      }),
    );
    const imported = await importExtractionResults(store, [
      { nodes, edges: [] },
    ]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('surfaces a glossary term whose field sorts beyond the first 500-row page', async () => {
    // 506 CustomFields; the target term's field is the last by id, past the
    // graph layer's 500-row page, and its label heads the glossary sort. A
    // non-paginating scan never sees it, so the Glossary section omits it.
    const result = await generateOnboardingDocHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.document.body).toContain('AAA Onboarding Term');
  });
});

describe('generateOnboardingDocHandler — Key Contacts over the FULL code corpus', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('big-key-contacts.db');
    store = built.store;
    ctx = built.ctx;
    // 505 ApexClasses. The first 500 by id ASC were all last modified by one
    // person; the 5 that sort LAST were modified by someone else. A single
    // capped `listNodesByType` page (limit 500, OFFSET 0) sees only the
    // alphabetically-first 500, so the late modifier is invisible and the
    // 'Key Contacts' table silently presents ONE person as the org's key
    // people — with no truncation note anywhere in the document.
    const nodes: Node[] = [];
    for (let i = 0; i < 500; i++) {
      const n = String(i).padStart(3, '0');
      nodes.push(
        makeNode({
          id: `ApexClass:aaa_early_${n}`,
          type: 'ApexClass',
          apiName: `aaa_early_${n}`,
          lastModifiedBy: 'Early Modifier',
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      nodes.push(
        makeNode({
          id: `ApexClass:zzz_late_${String(i)}`,
          type: 'ApexClass',
          apiName: `zzz_late_${String(i)}`,
          lastModifiedBy: 'Late Modifier',
        }),
      );
    }
    const imported = await importExtractionResults(store, [
      { nodes, edges: [] },
    ]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('names a modifier whose ApexClasses sort beyond the first 500-row page', async () => {
    const result = await generateOnboardingDocHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Early Modifier');
    // Only reachable when the scan windows the SQL OFFSET forward.
    expect(body).toContain('Late Modifier');
  });
});

describe('generateOnboardingDocHandler — a failed code scan is NOT an enrichment gap', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('scan-failure.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  afterAll(async () => {
    await closeGraph(store);
    scanState.failFrom = Number.POSITIVE_INFINITY;
    scanState.apexCalls = 0;
  });

  it('propagates a graph failure instead of printing the v1.7 enrichment remedy', async () => {
    // Calibrate: how many ApexClass list queries does one full run issue?
    // The LAST one is the Key Contacts scan (step 5) — everything before it
    // belongs to the chained handbook / architecture / org-overview calls,
    // which propagate their own errors already.
    scanState.failFrom = Number.POSITIVE_INFINITY;
    scanState.apexCalls = 0;
    const calibration = await generateOnboardingDocHandler(ctx, {});
    expect(calibration.ok).toBe(true);
    const totalApexCalls = scanState.apexCalls;
    expect(totalApexCalls).toBeGreaterThan(0);

    // Arm: fail ONLY that final Key Contacts scan.
    scanState.apexCalls = 0;
    scanState.failFrom = totalApexCalls;
    const result = await generateOnboardingDocHandler(ctx, {});

    // A graph error must surface as an error. Reporting a query failure as
    // "run `sfi refresh --with-tooling-api`" prescribes a remedy that would
    // change nothing.
    expect(result.ok).toBe(false);
    if (result.ok) {
      expect(result.value.data.document.body).not.toContain(
        'Key Contacts data depends on v1.7 enrichment',
      );
      return;
    }
    expect(result.error.kind).toBe('internal');
    expect(result.error.message).toContain('graph query failed');
  });
});

describe('generate-onboarding-doc full-scan adoption (drift guard)', () => {
  const SOURCE = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/tools/generate-onboarding-doc.ts',
    ),
    'utf8',
  );

  it('issues no single-page listNodesByType scan', () => {
    expect(/listNodesByType\(/.test(SOURCE)).toBe(false);
  });

  it('calls the shared scanAllNodesOfTypes helper', () => {
    expect(SOURCE).toContain('scanAllNodesOfTypes');
  });

  it('derives its page size from the shared cap rather than a local literal', () => {
    // R6: `const TYPE_SCAN_CAP = 500` asserted parity with the graph layer's
    // LIST_MAX_LIMIT in a COMMENT instead of deriving it. The shared helper
    // reads clampedNodeScanLimit() itself.
    expect(SOURCE).not.toMatch(/TYPE_SCAN_CAP\s*=\s*\d+/);
  });
});
