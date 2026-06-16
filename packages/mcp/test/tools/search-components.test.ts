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
  searchComponentsHandler,
  searchComponentsInputSchema,
} from '../../src/tools/search-components.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, CustomField: 3 },
  edges: { parentOf: 3 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: 'Account',
  parentId: null,
  sourcePath: 'objects/Account/Account.object-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>,
): Edge => ({
  edgeType: 'parentOf',
  confidence: 'declared',
  source: 'extractor:custom-object',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      apiName: 'Account',
      label: 'Account',
    }),
    makeNode({
      id: 'CustomObject:Opportunity',
      apiName: 'Opportunity',
      label: 'Opportunity',
    }),
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
      properties: { dataType: 'Picklist' },
    }),
    makeNode({
      id: 'CustomField:Account.Region__c',
      type: 'CustomField',
      apiName: 'Region__c',
      label: 'Region',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Region__c.field-meta.xml',
      properties: { dataType: 'Text', length: 80 },
    }),
    makeNode({
      id: 'CustomField:Opportunity.Stage__c',
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: 'CustomObject:Opportunity',
      sourcePath: 'objects/Opportunity/fields/Stage__c.field-meta.xml',
      properties: { dataType: 'Picklist' },
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
    }),
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Region__c',
    }),
    makeEdge({
      fromId: 'CustomObject:Opportunity',
      toId: 'CustomField:Opportunity.Stage__c',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-search-'));
  const dbPath = join(tempDir, 'search-components.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
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

describe('searchComponentsHandler', () => {
  it('returns ranked matches for a query that hits the fixture', async () => {
    const result = await searchComponentsHandler(ctx, { query: 'Industry' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches.length).toBe(1);
    const [hit] = result.value.data.matches;
    expect(hit!.id).toBe('CustomField:Account.Industry__c');
    expect(hit!.score).toBeGreaterThan(0);
    expect(hit!.snippet.length).toBeGreaterThan(0);
    // Vault-state envelope copies straight from the manifest, letting
    // clients diff against the source-tree hash they have on hand.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe(
      '2026-05-27T14:33:08Z',
    );
  });

  it('returns ok with an empty matches array when nothing matches', async () => {
    const result = await searchComponentsHandler(ctx, {
      query: 'NonexistentXyzzy',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches).toEqual([]);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('self-heals: a typo with no substring match returns resolver suggestions', async () => {
    const result = await searchComponentsHandler(ctx, { query: 'industy' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches).toEqual([]);
    const sug = result.value.data.suggestions;
    expect(sug).toBeDefined();
    if (sug === undefined) return;
    const ids = sug.candidates.map((c) => c.componentId);
    expect(ids.some((id) => id.endsWith('.Industry__c'))).toBe(true);
  });

  it('does not attach suggestions when the search already has matches', async () => {
    const result = await searchComponentsHandler(ctx, { query: 'Industry' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches.length).toBeGreaterThan(0);
    expect(result.value.data.suggestions).toBeUndefined();
  });

  it('honors the limit option and caps the result count', async () => {
    // `Account` matches CustomObject:Account (exact) plus the two fields
    // whose properties/labels mention Account; limit=1 must cap it.
    const result = await searchComponentsHandler(ctx, {
      query: 'Account',
      limit: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches.length).toBe(1);
  });

  it('narrows to the requested types when the types filter is set', async () => {
    const result = await searchComponentsHandler(ctx, {
      query: 'Opportunity',
      types: ['CustomField'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every returned id must belong to a CustomField; CustomObject:Opportunity
    // is excluded by the type filter even though it would otherwise rank.
    for (const hit of result.value.data.matches) {
      expect(hit.id.startsWith('CustomField:')).toBe(true);
    }
  });
});

describe('searchComponentsInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = searchComponentsInputSchema.safeParse({ query: 'Industry' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty query string', () => {
    const parsed = searchComponentsInputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing query field', () => {
    const parsed = searchComponentsInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit greater than 100', () => {
    const parsed = searchComponentsInputSchema.safeParse({
      query: 'Industry',
      limit: 101,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const parsed = searchComponentsInputSchema.safeParse({
      query: 'Industry',
      limit: 2.5,
    });
    expect(parsed.success).toBe(false);
  });
});
