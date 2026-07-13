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
  generateArchitectureOverviewHandler,
} from '../../src/tools/generate-architecture-overview.js';
import { jsonResult } from '../../src/tools/index.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, ApexClass: 2 },
  edges: { references: 2, callsApex: 1 },
  sourceTreeHash: 'sha256:arch-fixture',
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

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
    makeNode({ id: 'ApexClass:Service1', type: 'ApexClass', apiName: 'Service1' }),
    makeNode({ id: 'ApexClass:Service2', type: 'ApexClass', apiName: 'Service2' }),
    makeNode({ id: 'NamedCredential:ApiCred', type: 'NamedCredential', apiName: 'ApiCred' }),
  ],
  edges: [
    makeEdge({ fromId: 'ApexClass:Service1', toId: 'CustomObject:Account', edgeType: 'references' }),
    makeEdge({ fromId: 'ApexClass:Service2', toId: 'CustomObject:Account', edgeType: 'references' }),
    makeEdge({ fromId: 'ApexClass:Service2', toId: 'ApexClass:Service1', edgeType: 'callsApex' }),
    // R6-19: a Master-Detail lookupTo edge (Contact.AccountId -> Account),
    // no CustomField node required for the from-side.
    makeEdge({
      fromId: 'CustomField:Contact.AccountId',
      toId: 'CustomObject:Account',
      edgeType: 'lookupTo',
      properties: { relationshipType: 'MasterDetail' },
    }),
  ],
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
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-arch-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('generateArchitectureOverviewHandler (empty graph)', () => {
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

  it('returns a minimal valid document with empty diagrams', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.body).toContain('# ');
    expect(doc.body).toContain('## Org Structure');
  });

  it('still includes the required H2 sections for an empty graph', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## Executive Summary');
    expect(body).toContain('## Org Structure');
    expect(body).toContain('## Entity Relationship Diagram');
    expect(body).toContain('## Domain Clustering');
    expect(body).toContain('## Integration Topology');
    expect(body).toContain('## Automation Footprint');
    expect(body).toContain('## Codebase Footprint');
  });

  it('omits html unless format is html (default markdown)', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.html).toBeUndefined();
  });

  it('returns a self-contained HTML export when format is html (P11-artifacts-html)', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, { format: 'html' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { document, html } = result.value.data;
    // The markdown document is still returned alongside the HTML.
    expect(document.body).toContain('## Org Structure');
    expect(html).toBeDefined();
    expect(html?.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>');
    // The document title and body made it into the page.
    expect(document.frontmatter.title).toContain('Architecture Overview');
    expect(html).toContain('Architecture Overview');
    expect(html).toContain('Org Structure');
  });
});

describe('generateArchitectureOverviewHandler (seeded graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('seeded.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns a valid frontmatter with title and source-tree hash', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.frontmatter.title).toContain('Architecture Overview');
    expect(doc.frontmatter.sourceTreeHash).toBe('sha256:arch-fixture');
  });

  it('deduplicates componentIds — an id selected by two source lists appears once', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.document.frontmatter.componentIds;
    // Frontmatter componentIds is a provenance SET: no id may repeat even
    // when it is selected by more than one source list (a top object by
    // inbound references that is ALSO a domain-cluster centre, etc.).
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('includes mermaid blocks for org structure and integration topology', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const mermaidCount = (body.match(/```mermaid/g) ?? []).length;
    expect(mermaidCount).toBeGreaterThanOrEqual(2);
  });

  it('surfaces the top objects in the Org Structure section', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Account');
  });

  it('populates the integration topology with NamedCredential nodes', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('ApiCred');
    expect(body).toContain('NamedCredential');
  });

  it('populates sectionConfidence for every section', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conf = result.value.data.document.sectionConfidence;
    expect(conf['Executive Summary']).toBe('declared');
    expect(conf['Org Structure']).toBeDefined();
    expect(conf['Domain Clustering']).toBeDefined();
    expect(conf['Integration Topology']).toBeDefined();
  });

  it('R6-19: renders an Entity Relationship Diagram section from lookupTo edges', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## Entity Relationship Diagram');
    const erdIdx = body.indexOf('## Entity Relationship Diagram');
    const erdSection = body.slice(erdIdx, body.indexOf('## Domain Clustering'));
    expect(erdSection).toContain('erDiagram');
    expect(erdSection).toContain('||--|{');
    expect(erdSection).toContain('MasterDetail (AccountId)');
    expect(erdSection).toContain('Account');
    expect(erdSection).toContain('Contact');
  });

  it('R6-19: the ERD mermaid fence survives into the HTML export (html-document.ts renders every ```mermaid fence generically)', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, { format: 'html' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { document, html } = result.value.data;
    expect(document.body).toContain('## Entity Relationship Diagram');
    expect(html).toBeDefined();
    expect(html).toContain('erDiagram');
    expect(html).toContain('MasterDetail (AccountId)');
  });

  it('R6-19: sectionConfidence and boundaries carry the ERD entries', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.sectionConfidence['Entity Relationship Diagram']).toBe('declared');
    expect(doc.boundaries.join('\n')).toContain('lookupTo` edges, extraction-time');
  });

  it('surfaces the heuristic-cluster boundary disclosure', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.document.boundaries;
    const joined = boundaries.join('\n');
    expect(joined).toContain('offline vault');
    expect(joined).toContain('heuristic');
  });
});

// CR-P3-4 / CR-RV8: a LARGE arch overview rendered as html must not become a
// silently-chopped artifact. The old `budget / 2` reserve double-counted the
// body (the html is built FROM document.body, so the envelope carries it twice)
// without measuring the ACTUAL assembled envelope, so the global guard's
// slimDataStrings 1024-char cut hit `html` and left it with no `</html>`.
const seedLargeIntegrationGraph = async (
  store: GraphStore,
): Promise<void> => {
  // Many integration nodes → a long Integration Topology section + table, so
  // the assembled markdown body is comfortably over a few KB.
  const nodes: Node[] = [];
  for (let i = 0; i < 60; i += 1) {
    nodes.push(
      makeNode({
        id: `NamedCredential:Cred_${i.toString()}`,
        type: 'NamedCredential',
        apiName: `Credential_With_A_Reasonably_Long_Api_Name_${i.toString()}`,
      }),
    );
  }
  for (let i = 0; i < 30; i += 1) {
    nodes.push(
      makeNode({
        id: `CustomObject:Obj_${i.toString()}`,
        type: 'CustomObject',
        apiName: `Custom_Object_With_A_Long_Api_Name_${i.toString()}`,
      }),
    );
  }
  const edges: Edge[] = [];
  for (let i = 0; i < 29; i += 1) {
    edges.push(
      makeEdge({
        fromId: `CustomObject:Obj_${i.toString()}`,
        toId: `CustomObject:Obj_${(i + 1).toString()}`,
        edgeType: 'references',
      }),
    );
  }
  const imported = await importExtractionResults(store, [{ nodes, edges }]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
};

describe('generateArchitectureOverviewHandler (large html artifact fits, CR-P3-4)', () => {
  let store: GraphStore;
  let ctx: Context;
  const prevMax = process.env['SFI_MAX_RESPONSE_BYTES'];

  beforeAll(async () => {
    // A modest budget: large enough that a fitted html artifact CAN be returned
    // well-formed, but small enough that the OLD `budget / 2` math left the
    // assembled envelope over the global guard's reductionCap (silent chop).
    process.env['SFI_MAX_RESPONSE_BYTES'] = '9000';
    const opened = await openGraph(join(tempDir, 'large-html-fits.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
    await seedLargeIntegrationGraph(store);
  });

  afterAll(async () => {
    await closeGraph(store);
    if (prevMax === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
    else process.env['SFI_MAX_RESPONSE_BYTES'] = prevMax;
  });

  it('returns a well-formed html artifact — not a guard-chopped one', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {
      format: 'html',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Route the handler's envelope through the REAL global guard (jsonResult),
    // exactly as the dispatcher does. This is where the silent chop happened.
    const envelope = jsonResult({
      data: result.value.data,
      vaultState: result.value.vaultState,
    });
    const text = (envelope.content[0] as { readonly text: string }).text;
    const parsed = JSON.parse(text) as {
      readonly data?: { readonly html?: string };
      readonly error?: { readonly kind?: string };
    };

    // At this budget a fitted artifact fits — the guard must not have engaged.
    expect(parsed.error).toBeUndefined();
    const html = parsed.data?.html;
    expect(html).toBeDefined();
    if (html === undefined) return;
    expect(html).not.toContain('bytes trimmed]');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    // The honesty footer must survive in the paired markdown document.
    expect(result.value.data.document.body).toContain('## Boundaries');
  });
});

describe('generateArchitectureOverviewHandler (irreducible html → oversize error, CR-P3-4)', () => {
  let store: GraphStore;
  let ctx: Context;
  const prevMax = process.env['SFI_MAX_RESPONSE_BYTES'];

  beforeAll(async () => {
    // A budget so small that even a maximally-reduced document + the fixed html
    // wrapper cannot fit: the handler must return a structured oversize error,
    // NOT a slim-chopped artifact.
    process.env['SFI_MAX_RESPONSE_BYTES'] = '4000';
    const opened = await openGraph(join(tempDir, 'large-html-oversize.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
    await seedLargeIntegrationGraph(store);
  });

  afterAll(async () => {
    await closeGraph(store);
    if (prevMax === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
    else process.env['SFI_MAX_RESPONSE_BYTES'] = prevMax;
  });

  it('returns a structured oversize error rather than a chopped artifact', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {
      format: 'html',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('oversize');
    expect(result.error.message).toContain('markdown');
  });
});

describe('generateArchitectureOverviewHandler — R6-19 ERD object cap', () => {
  let store: GraphStore;
  let ctx: Context;
  const OBJECT_COUNT = 15; // > ARCHITECTURE_ERD_MAX_OBJECTS (12)

  beforeAll(async () => {
    const opened = await openGraph(join(tempDir, 'erd-object-cap.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };

    // Each Spoke_i__c has ONE outgoing MasterDetail lookupTo to a DISTINCT
    // Parent_i__c — 15 independent (parent, child) pairs, so every object
    // has degree 1 (a flat tie) and the disclosure names the true total.
    const edges: Edge[] = [];
    for (let i = 0; i < OBJECT_COUNT; i += 1) {
      const suffix = i.toString().padStart(2, '0');
      edges.push(
        makeEdge({
          fromId: `CustomField:Spoke_${suffix}__c.Parent__c`,
          toId: `CustomObject:Parent_${suffix}__c`,
          edgeType: 'lookupTo',
          properties: { relationshipType: 'MasterDetail' },
        }),
      );
    }
    const imported = await importExtractionResults(store, [{ nodes: [], edges }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('caps the ERD at ARCHITECTURE_ERD_MAX_OBJECTS and discloses the true total honestly', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const erdIdx = body.indexOf('## Entity Relationship Diagram');
    const erdSection = body.slice(erdIdx, body.indexOf('## Domain Clustering'));
    // 30 distinct objects (15 disjoint Spoke/Parent pairs) all tie at degree
    // 1 — the object cap keeps only 12 of them, and a relationship line only
    // renders when BOTH its endpoints survived the cap (a disjoint-pair
    // structure like this one can legitimately keep 0 complete pairs). The
    // property under test is the CAP + honest disclosure, not a specific
    // relationship count.
    const relationshipLines = erdSection.split('\n').filter((l) => l.includes('||--'));
    expect(relationshipLines.length).toBeLessThanOrEqual(6);
    expect(erdSection).toMatch(/top 12 of 30 objects/);
  });
});



// =============================================================================
// CR-22-B6 — the top-5 (Org Structure) / top-20 (Integration Topology) mermaid
// diagram node caps, and the `sfi.governor_limit_risks` ENTRY_PATH_MAX_PATHS
// walk cap (see governor-limit-risks.test.ts), were previously JSDoc-only. A
// fixture exceeding EACH cap here asserts the "showing first N of M" line
// renders both inline (document.body) and in document.boundaries.
// =============================================================================
const seedCapExceedingGraph = async (store: GraphStore): Promise<void> => {
  const nodes: Node[] = [];
  // 8 CustomObjects, chained by `references` so 7 of them accumulate an
  // inbound reference (org_overview's topObjects ranking) — well past the
  // ORG_STRUCTURE_DIAGRAM_CAP=5 local slice, and the TRUE CustomObject count
  // (8) is what the disclosure compares against.
  for (let i = 0; i < 8; i += 1) {
    nodes.push(
      makeNode({ id: `CustomObject:CapObj_${i.toString()}`, type: 'CustomObject', apiName: `CapObj_${i.toString()}` }),
    );
  }
  const edges: Edge[] = [];
  for (let i = 0; i < 7; i += 1) {
    edges.push(
      makeEdge({
        fromId: `CustomObject:CapObj_${i.toString()}`,
        toId: `CustomObject:CapObj_${(i + 1).toString()}`,
        edgeType: 'references',
      }),
    );
  }
  // Integration surfaces spread across TWO ComponentTypes (15 each). Each
  // type is independently capped by integration_map's own `perCategoryLimit`
  // (~13 at the default `limit: 100` over 8 types) — a SINGLE type can never
  // exceed that per-category cap, but the CONCATENATED `allIntegrationNodes`
  // this tool builds from all 8 categories comfortably exceeds
  // INTEGRATION_DIAGRAM_CAP=20 once two categories are each near their cap.
  for (let i = 0; i < 15; i += 1) {
    nodes.push(
      makeNode({
        id: `NamedCredential:CapCred_${i.toString()}`,
        type: 'NamedCredential',
        apiName: `CapCred_${i.toString()}`,
      }),
    );
    nodes.push(
      makeNode({
        id: `AuthProvider:CapAuth_${i.toString()}`,
        type: 'AuthProvider',
        apiName: `CapAuth_${i.toString()}`,
      }),
    );
  }
  const imported = await importExtractionResults(store, [{ nodes, edges }]);
  if (!imported.ok) throw new Error(`cap-exceeding seed import failed: ${imported.error.message}`);
};

describe('generateArchitectureOverviewHandler (diagram cap disclosures — CR-22-B6)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const opened = await openGraph(join(tempDir, 'cap-disclosure.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
    await seedCapExceedingGraph(store);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('discloses the Org Structure diagram cap inline and in boundaries', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toMatch(/showing the top 5 of 8 CustomObjects/);
    const boundaries = result.value.data.document.boundaries.join('\n');
    expect(boundaries).toContain('Org Structure diagram capped');
    expect(boundaries).toContain('top 5 of 8');
  });

  it('discloses the Integration Topology diagram cap inline and in boundaries', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toMatch(/diagram shows the first 20 of \d+ integration surfaces/);
    const boundaries = result.value.data.document.boundaries.join('\n');
    expect(boundaries).toContain('Integration Topology diagram capped');
  });

  it('the Type/Count table is unaffected by the diagram cap (still shows the full counts)', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // Each of the two seeded categories independently caps at integration_map's
    // own perCategoryLimit — the table row still reports that (capped) count,
    // not zero and not silently different from what the diagram used.
    expect(body).toMatch(/\| NamedCredential \| \d+ \|/);
    expect(body).toMatch(/\| AuthProvider \| \d+ \|/);
  });
});

describe('generateArchitectureOverviewHandler (under-cap graph stays byte-identical — CR-22-B6)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('under-cap.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('emits neither cap disclosure when both counts are under their caps', async () => {
    const result = await generateArchitectureOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const boundaries = result.value.data.document.boundaries.join('\n');
    expect(body).not.toContain('showing the top');
    expect(body).not.toContain('diagram shows the first');
    expect(boundaries).not.toContain('diagram capped');
  });
});