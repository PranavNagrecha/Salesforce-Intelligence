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
import { cpqDependencyMapHandler } from '../../src/tools/cpq-dependency-map.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    CpqPriceRule: 1,
    CpqLookupQuery: 1,
  },
  edges: { parentOf: 2 },
  sourceTreeHash: 'sha256:cpq-deps-fixture',
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

// =============================================================================
// A CpqPriceRule + CpqLookupQuery seed. The values mirrors carry several
// SBQQ__-prefixed token references; the dependency walker should surface
// each unique token with its occurrence count.
// =============================================================================

const PRICE_RULE_TYPE_ID = 'CustomObject:SBQQ__PriceRule__c';
const PRICE_RULE_ID = 'CpqPriceRule:SBQQ__PriceRule__c.HighDiscountAlert';

const LOOKUP_QUERY_TYPE_ID = 'CustomObject:SBQQ__LookupQuery__c';
const LOOKUP_QUERY_ID = 'CpqLookupQuery:SBQQ__LookupQuery__c.Q1';

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PRICE_RULE_TYPE_ID,
      type: 'CustomObject',
      apiName: 'SBQQ__PriceRule__c',
    }),
    makeNode({
      id: PRICE_RULE_ID,
      type: 'CpqPriceRule',
      apiName: 'SBQQ__PriceRule__c.HighDiscountAlert',
      label: 'High Discount',
      parentId: PRICE_RULE_TYPE_ID,
      properties: {
        active: true,
        evaluationOrder: 10,
        recognitionConfidence: 'heuristic',
        values: [
          // Two distinct tokens — SBQQ__Quote__c appears once, the
          // SBQQ__Discount__c field appears once.
          {
            field: 'SBQQ__LookupObject__c',
            value: 'SBQQ__Quote__c',
            valueType: 'string',
            isMasked: false,
          },
          {
            field: 'SBQQ__Field__c',
            value: 'SBQQ__Discount__c',
            valueType: 'string',
            isMasked: false,
          },
          // A non-string value — should be ignored by the walker
          // (only string values get the prefix scan).
          {
            field: 'SBQQ__EvaluationOrder__c',
            value: 10,
            valueType: 'number',
            isMasked: false,
          },
          // A masked value — should be ignored to avoid spurious
          // matches on the underlying (unknown) content.
          {
            field: 'SBQQ__SecretField__c',
            value: null,
            valueType: 'string',
            isMasked: true,
          },
        ],
      },
    }),
    makeNode({
      id: LOOKUP_QUERY_TYPE_ID,
      type: 'CustomObject',
      apiName: 'SBQQ__LookupQuery__c',
    }),
    makeNode({
      id: LOOKUP_QUERY_ID,
      type: 'CpqLookupQuery',
      apiName: 'SBQQ__LookupQuery__c.Q1',
      label: 'Lookup Query 1',
      parentId: LOOKUP_QUERY_TYPE_ID,
      properties: {
        recognitionConfidence: 'heuristic',
        values: [
          // The same field appears twice in the same value — should
          // surface as occurrenceCount: 2.
          {
            field: 'SBQQ__Filters__c',
            value: 'SBQQ__Discount__c AND SBQQ__Discount__c',
            valueType: 'string',
            isMasked: false,
          },
          // Cross-reference to the parent rule — the walker doesn't
          // resolve the reference, just surfaces the matched token.
          {
            field: 'SBQQ__PriceRule__c',
            value: 'SBQQ__PriceRule__c.HighDiscountAlert',
            valueType: 'string',
            isMasked: false,
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
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cpq-deps-'));
  const dbPath = join(tempDir, 'cpq-deps.db');
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

describe('cpqDependencyMapHandler', () => {
  it('returns dependencies for a single CPQ component when cpqComponentId is provided', async () => {
    const result = await cpqDependencyMapHandler(ctx, {
      cpqComponentId: PRICE_RULE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { dependencies, scannedComponentCount } = result.value.data;
    expect(scannedComponentCount).toBe(1);
    // Two unique tokens from the PriceRule's string values; the
    // numeric value and masked value are excluded.
    const tokens = dependencies
      .map((d) => d.referencedFieldToken)
      .sort();
    expect(tokens).toEqual(['SBQQ__Discount__c', 'SBQQ__Quote__c']);
    // Every emission carries the source component identity.
    expect(
      dependencies.every((d) => d.fromComponentId === PRICE_RULE_ID),
    ).toBe(true);
  });

  it('counts repeat occurrences of the same token in one value', async () => {
    const result = await cpqDependencyMapHandler(ctx, {
      cpqComponentId: LOOKUP_QUERY_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { dependencies } = result.value.data;
    const discountEntry = dependencies.find(
      (d) => d.referencedFieldToken === 'SBQQ__Discount__c',
    );
    expect(discountEntry).toBeDefined();
    if (!discountEntry) return;
    // The SBQQ__Discount__c token appears twice in the single
    // SBQQ__Filters__c value entry — both occurrences are counted.
    expect(discountEntry.occurrenceCount).toBe(2);
  });

  it('scans every CPQ-typed node when cpqComponentId is omitted', async () => {
    const result = await cpqDependencyMapHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { dependencies, scannedComponentCount } = result.value.data;
    // Both nodes scanned.
    expect(scannedComponentCount).toBe(2);
    // Dependencies from both sources surface in the merged list.
    const sourceIds = new Set(dependencies.map((d) => d.fromComponentId));
    expect(sourceIds.has(PRICE_RULE_ID)).toBe(true);
    expect(sourceIds.has(LOOKUP_QUERY_ID)).toBe(true);
  });

  it('surfaces the verbatim heuristic disclosure on every response', async () => {
    const result = await cpqDependencyMapHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { disclosure } = result.value.data;
    expect(disclosure).toContain('heuristic');
    expect(disclosure).toContain('formula-walked');
    expect(disclosure).toContain('starting point');
  });

  it('returns invalid-query when cpqComponentId has a non-CPQ prefix', async () => {
    const result = await cpqDependencyMapHandler(ctx, {
      cpqComponentId: 'CustomField:Account.Industry',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an unknown CPQ id', async () => {
    const result = await cpqDependencyMapHandler(ctx, {
      cpqComponentId: 'CpqPriceRule:SBQQ__PriceRule__c.NoSuchRule',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });
});

// =============================================================================
// CR-22 B4 — full-scan output cursor (Option A: scanAllNodesOfTypes + paginate
// the dependency list). A whole-fits no-cursor full-scan is byte-identical;
// a truncated page resumes the full set with no gaps / dupes. The single-
// component path never paginates.
// =============================================================================
describe('cpqDependencyMapHandler — output cursor (CR-22)', () => {
  it('full-scan whole-fits no-cursor call omits all paging fields', async () => {
    const r = await cpqDependencyMapHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(d['truncated']).toBe(false);
  });

  it('single-component path never emits a cursor', async () => {
    const r = await cpqDependencyMapHandler(ctx, { cpqComponentId: PRICE_RULE_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect('limit' in d).toBe(false);
  });

  it('a truncated full-scan page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await cpqDependencyMapHandler(ctx, { limit: 200 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const key = (d: { fromComponentId: string; referencedFieldToken: string; occurrenceCount: number }) =>
      `${d.fromComponentId}|${d.referencedFieldToken}|${d.occurrenceCount}`;
    const fullOrder = all.value.data.dependencies.map(key);
    expect(fullOrder.length).toBeGreaterThan(2);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof cpqDependencyMapHandler>> =
        await cpqDependencyMapHandler(
          ctx,
          cursor !== undefined ? { limit: 1, cursor } : { limit: 1 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const d of page.value.data.dependencies) seen.push(key(d));
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 50) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
