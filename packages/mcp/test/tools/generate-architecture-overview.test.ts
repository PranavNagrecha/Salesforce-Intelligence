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
