/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import {
  generateAdminHandbookHandler,
} from '../../src/tools/generate-admin-handbook.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    Profile: 2,
    PermissionSet: 1,
    ApexClass: 2,
    Flow: 1,
  },
  edges: {},
  sourceTreeHash: 'sha256:handbook-fixture',
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
    makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    makeNode({ id: 'Profile:Standard', type: 'Profile', apiName: 'Standard' }),
    makeNode({ id: 'PermissionSet:Bonus', type: 'PermissionSet', apiName: 'Bonus' }),
    makeNode({
      id: 'ApexClass:Foo',
      type: 'ApexClass',
      apiName: 'Foo',
      lastModifiedDate: '2026-05-20T10:00:00Z',
      lastModifiedBy: 'Alice',
    }),
    makeNode({ id: 'ApexClass:Bar', type: 'ApexClass', apiName: 'Bar' }),
    makeNode({
      id: 'Flow:Lead_Nurture',
      type: 'Flow',
      apiName: 'Lead_Nurture',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: 'WorkflowRule:Account.OldRule',
      type: 'WorkflowRule',
      apiName: 'Account.OldRule',
      properties: { active: true },
    }),
    makeNode({ id: 'NamedCredential:ExternalApi', type: 'NamedCredential', apiName: 'ExternalApi' }),
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
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-handbook-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('generateAdminHandbookHandler (empty graph)', () => {
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

  it('returns a minimal valid document with zero counts', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.body).toContain('Admin Handbook');
    expect(doc.body).toContain('Total extracted components: 0');
  });

  it('surfaces the v1.7 enrichment disclosure when no nodes have lastModifiedDate', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Recent-change data depends on v1.7 enrichment');
  });
});

describe('generateAdminHandbookHandler (seeded graph, admin default)', () => {
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

  it('returns a valid frontmatter shape with title and componentIds', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.frontmatter.title).toContain('Admin Handbook');
    expect(doc.frontmatter.sourceTreeHash).toBe('sha256:handbook-fixture');
    expect(doc.frontmatter.componentIds.length).toBeGreaterThan(0);
    expect(doc.frontmatter.componentIds).toContain('CustomObject:Account');
  });

  it('emits all required H2 section headings (admin persona)', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## Purpose and Audience');
    expect(body).toContain('## Main Objects');
    expect(body).toContain('## Automation Summary');
    expect(body).toContain('## Permission Structure');
    expect(body).toContain('## Integration Topology');
    expect(body).toContain('## Recent Changes');
  });

  it('includes a mermaid block for Main Objects', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('```mermaid');
    expect(body).toContain('graph LR');
  });

  it('populates Recent Changes when at least one node carries lastModifiedDate', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // Alice's last-modified Foo should land in the Recent Changes table.
    expect(body).toContain('Alice');
    expect(body).toContain('ApexClass:Foo');
  });

  it('always surfaces the Q125 freshness disclosure', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.document.boundaries;
    expect(boundaries.join('\n')).toContain('offline vault');
  });
});

describe('generateAdminHandbookHandler (developer persona variation)', () => {
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

  it('adds a Codebase Footprint section for the developer persona', async () => {
    const result = await generateAdminHandbookHandler(ctx, {
      personaFocus: 'developer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## Codebase Footprint');
    // Codebase Footprint should appear BEFORE Permission Structure for developer.
    const codeIdx = body.indexOf('## Codebase Footprint');
    const permIdx = body.indexOf('## Permission Structure');
    expect(codeIdx).toBeGreaterThan(0);
    expect(codeIdx).toBeLessThan(permIdx);
  });
});
