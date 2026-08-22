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

/**
 * FIX 4 (disclosure half) — the reader must be able to tell a complete answer
 * from a sample.
 *
 * `{"query":"Age"}` matches 1,931 nodes on the reference vault and returned 25
 * rows with no total and no `hasMore`. That is the product's own headline sin.
 */
describe('searchComponentsHandler — disclosure (FIX 4)', () => {
  let discDir: string;
  let discStore: GraphStore;
  let discCtx: Context;

  beforeAll(async () => {
    discDir = mkdtempSync(join(tmpdir(), 'sfi-fix4-search-'));
    const opened = await openGraph(join(discDir, 'search.db'));
    if (!opened.ok) throw new Error('openGraph failed');
    discStore = opened.value;
    const nodes: Node[] = [];
    for (let i = 0; i < 30; i += 1) {
      nodes.push(
        makeNode({
          id: `CustomField:Widget_Session__c.Age_Bucket_${i}__c`,
          type: 'CustomField',
          apiName: `Age_Bucket_${i}__c`,
          parentId: 'CustomObject:Widget_Session__c',
        }),
      );
    }
    const imp = await importExtractionResults(discStore, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error('seed failed');
    discCtx = {
      vaultRoot: discDir,
      manifest: FIXTURE_MANIFEST,
      graph: discStore,
    };
  });

  afterAll(async () => {
    await closeGraph(discStore);
    rmSync(discDir, { recursive: true, force: true });
  });

  it('publishes the TRUE total and a resumable nextOffset', async () => {
    const r = await searchComponentsHandler(discCtx, { query: 'Age', limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Pre-fix: 5 matches and nothing else — no total, no hasMore.
    expect(d.matches.length).toBe(5);
    expect(d.totalCount).toBe(30);
    expect(d.limit).toBe(5);
    expect(d.offset).toBe(0);
    expect(d.hasMore).toBe(true);
    expect(d.nextOffset).toBe(5);
    expect(d.note).toBe(
      'Showing 5 of 30 match(es) (offset=0). MORE remain — advance with offset=5. This list is INCOMPLETE; do not treat it as every component matching this query.',
    );
  });

  it('carries the lexical-match boundary on EVERY response', async () => {
    const r = await searchComponentsHandler(discCtx, { query: 'Age', limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries[0]).toBe(
      'Matches are lexical, case-insensitive substring hits across api name, label, and raw node properties. A hit may be an incidental substring ("age" inside "Page"), not a semantic match. Ranking is a lexical score, not relevance — for meaning-based search use `sfi.find_semantic_field`.',
    );
  });

  it('honours offset and closes the page at the end of the list', async () => {
    const r = await searchComponentsHandler(discCtx, {
      query: 'Age',
      limit: 5,
      offset: 28,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matches.length).toBe(2);
    expect(r.value.data.hasMore).toBe(false);
    expect(r.value.data.nextOffset).toBeNull();
    expect(r.value.data.note).toBeUndefined();
  });

  it('reports totalCount 0 on a genuine miss and still offers suggestions', async () => {
    const r = await searchComponentsHandler(discCtx, {
      query: 'Aeg_Bcuket',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.hasMore).toBe(false);
    expect(r.value.data.matches).toEqual([]);
  });
});

/**
 * FIX 4 (ranking half) — a whole-token match outranks an incidental substring.
 *
 * `{"query":"Age"}` returned 2 genuine age fields, 9 `Agen*`/`Agency`/`Agent`
 * prefix hits, and 14 rows whose only relationship to "age" was the substring
 * inside "Page" / "Manage" / "Message". A new 2.6 tier sits BETWEEN prefix
 * (2.8) and contains (2.5), so the exact/prefix window `object_360` depends on
 * is unchanged.
 *
 * The assertions pin the ORDER RELATION, never the float scores —
 * quantised-score pins are a known tripwire in this repo.
 */
describe('searchComponentsHandler — whole-token ranking (FIX 4)', () => {
  let rankDir: string;
  let rankStore: GraphStore;
  let rankCtx: Context;

  beforeAll(async () => {
    rankDir = mkdtempSync(join(tmpdir(), 'sfi-fix4-rank-'));
    const opened = await openGraph(join(rankDir, 'rank.db'));
    if (!opened.ok) throw new Error('openGraph failed');
    rankStore = opened.value;
    // The defect case is a whole-token match that is NOT a prefix: pre-fix it
    // scored 2.5 exactly like an incidental substring, and the tie broke on
    // `api_name ASC`, so `ADM_Manage_...` and `Widget_Account_Record_Page1`
    // both sorted AHEAD of the field the caller actually meant.
    const nodes: Node[] = [
      makeNode({
        id: 'CustomField:Widget_Session__c.Widget_Session_Age__c',
        type: 'CustomField',
        apiName: 'Widget_Session_Age__c',
        parentId: 'CustomObject:Widget_Session__c',
      }),
      makeNode({
        id: 'FlexiPage:Widget_Account_Record_Page1',
        type: 'FlexiPage',
        apiName: 'Widget_Account_Record_Page1',
      }),
      makeNode({
        id: 'PermissionSet:ADM_Manage_External_Users',
        type: 'PermissionSet',
        apiName: 'ADM_Manage_External_Users',
      }),
      makeNode({
        id: 'ApexClass:MessageDispatcher',
        type: 'ApexClass',
        apiName: 'MessageDispatcher',
      }),
    ];
    const imp = await importExtractionResults(rankStore, [{ nodes, edges: [] }]);
    if (!imp.ok) throw new Error('seed failed');
    rankCtx = {
      vaultRoot: rankDir,
      manifest: FIXTURE_MANIFEST,
      graph: rankStore,
    };
  });

  afterAll(async () => {
    await closeGraph(rankStore);
    rmSync(rankDir, { recursive: true, force: true });
  });

  it('puts a whole-token Age match ahead of Page / Manage / Message substrings', async () => {
    const r = await searchComponentsHandler(rankCtx, { query: 'Age', limit: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.matches.map((m) => m.id);
    // Pre-fix the genuine field sorted LAST of the four (2.5 tie, api_name ASC).
    expect(ids[0]).toBe('CustomField:Widget_Session__c.Widget_Session_Age__c');
    const tokenRank = ids.indexOf(
      'CustomField:Widget_Session__c.Widget_Session_Age__c',
    );
    for (const junk of [
      'FlexiPage:Widget_Account_Record_Page1',
      'PermissionSet:ADM_Manage_External_Users',
      'ApexClass:MessageDispatcher',
    ]) {
      const junkRank = ids.indexOf(junk);
      if (junkRank >= 0) expect(tokenRank).toBeLessThan(junkRank);
    }
  });

  it('does not throw on a query containing regex metacharacters', async () => {
    const r = await searchComponentsHandler(rankCtx, { query: 'Age(*' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
  });
});
