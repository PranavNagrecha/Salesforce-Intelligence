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
  QUERY_GRAPH_MAX_LIMIT,
  queryGraphHandler,
  queryGraphInputSchema,
} from '../../src/tools/query-graph.js';
import { jsonResult } from '../../src/tools/tool-dispatch.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, CustomField: 3 },
  edges: { parentOf: 3, triggersOn: 1 },
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
    makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
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
      // An oversized property value to exercise the node-slim path.
      properties: { dataType: 'Text', bigBlob: 'x'.repeat(2_000) },
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
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Industry__c' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Region__c' }),
    makeEdge({ fromId: 'CustomObject:Opportunity', toId: 'CustomField:Opportunity.Stage__c' }),
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'triggersOn',
      confidence: 'heuristic',
      source: 'extractor:fictional',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-query-graph-'));
  const dbPath = join(tempDir, 'query-graph.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('queryGraphHandler — envelope + correctness', () => {
  it('returns matching nodes with the compiled SQL echoed and a raw-view disclosure', async () => {
    const result = await queryGraphHandler(ctx, {
      select: 'nodes',
      where: [{ column: 'type', op: '=', value: 'CustomField' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.select).toBe('nodes');
    expect(d.totalCount).toBe(3);
    expect(d.returnedCount).toBe(3);
    expect(d.hasMore).toBe(false);
    expect(d.query.compiledSql.startsWith('SELECT ')).toBe(true);
    expect(d.query.compiledSql.includes(';')).toBe(false);
    expect(d.query.params).toEqual(['CustomField']);
    expect(d.disclosure).toMatch(/[Rr]aw graph view/);
    expect(d.disclosure).toMatch(/synthesis/);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('filters edges by kind and echoes bound params', async () => {
    const result = await queryGraphHandler(ctx, {
      select: 'edges',
      where: [{ column: 'edgeType', op: '=', value: 'parentOf' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.totalCount).toBe(3);
    expect((result.value.data.rows[0] as Edge).edgeType).toBe('parentOf');
  });

  it('filters nodes by a JSON property accessor', async () => {
    const result = await queryGraphHandler(ctx, {
      select: 'nodes',
      where: [{ column: 'property:dataType', op: '=', value: 'Picklist' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The internal `$.dataType` json path is NOT echoed — only the caller value.
    expect(result.value.data.query.params).toEqual(['Picklist']);
    expect(
      result.value.data.rows.map((n) => (n as Node).apiName).sort(),
    ).toEqual(['Industry__c', 'Stage__c']);
  });

  it('slims an oversized node property and notes it', async () => {
    const result = await queryGraphHandler(ctx, {
      select: 'nodes',
      where: [{ column: 'id', op: '=', value: 'CustomField:Account.Region__c' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.value.data.rows[0] as Node;
    expect((node.properties['bigBlob'] as { __omitted?: boolean }).__omitted).toBe(true);
    expect(result.value.data.note).toMatch(/oversized property/);
  });

  it('reports hasMore when the limit clips the total', async () => {
    const result = await queryGraphHandler(ctx, {
      select: 'nodes',
      where: [{ column: 'type', op: '=', value: 'CustomField' }],
      limit: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.returnedCount).toBe(1);
    expect(result.value.data.totalCount).toBe(3);
    expect(result.value.data.hasMore).toBe(true);
  });
});

/**
 * QUERY-GRAPH-NO-RESUME-POINTER.
 *
 * This tool broke the pagination law on DEFAULT arguments, not merely at a
 * small `limit`. Measured on the demo vault before this fix:
 *
 *   `{ select: 'nodes' }` → totalCount 118, returnedCount 50, hasMore true,
 *   truncated FALSE, and no `offset`, no `nextOffset`, no `nextCursor`.
 *
 * It reported 50 of 118 rows as "not truncated" and shipped no way to reach the
 * other 68. `limit` was the only knob, so seeing row 51 meant re-running the
 * whole query with a bigger limit and re-receiving rows 1-50; past
 * `QUERY_GRAPH_MAX_LIMIT` there was no way at all. A host agent walking the
 * graph therefore analysed the head of the fixed sort as though it were the
 * whole result set.
 *
 * The fix adds an `offset` input and a `nextOffset` pointer, both computed by
 * the shared `paginateLegacy` pager. A pointer that is PRESENT BUT WRONG skips
 * or repeats rows silently, so the load-bearing assertion below is the walk that
 * must see every row exactly once — never the existence check.
 */
describe('queryGraphHandler — resume pointer + exhaustive walk', () => {
  it('a clipped page ships the pointer, the offset, and rows it can account for', async () => {
    const r = await queryGraphHandler(ctx, { select: 'nodes', limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // FAIL-BEFORE: `offset` and `nextOffset` did not exist on this payload.
    expect(d.offset).toBe(0);
    expect(d.returnedCount).toBe(d.rows.length);
    expect(d.hasMore).toBe(true);
    expect(d.nextOffset).toBe(d.offset + d.rows.length);
    expect(d.capReached).toBe(false);
    expect(d.pageableCount).toBe(d.totalCount);
    expect(d.note).toMatch(/Resume with offset=2/);
  });

  it('an exhausted page points nowhere and claims nothing it did not ship', async () => {
    const r = await queryGraphHandler(ctx, { select: 'nodes' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.hasMore).toBe(false);
    expect(d.nextOffset).toBeNull();
    // Law 2: hasMore === false implies offset + rows.length >= totalCount.
    expect(d.offset + d.rows.length).toBeGreaterThanOrEqual(d.totalCount);
  });

  it('a walk driven ONLY by nextOffset reaches every row exactly once', async () => {
    const PAGE = 2;
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    let total = -1;
    while (offset !== null) {
      const r = await queryGraphHandler(ctx, { select: 'nodes', limit: PAGE, offset });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      pages += 1;
      total = d.totalCount;
      expect(d.offset, `page ${String(pages)}: offset echo`).toBe(offset);
      expect(d.returnedCount, `page ${String(pages)}: returnedCount`).toBe(d.rows.length);
      // Law 2, P4: truncated must never contradict hasMore.
      if (d.truncated) expect(d.hasMore).toBe(true);
      for (const row of d.rows) seen.push((row as Node).id);
      if (d.hasMore) {
        expect(d.nextOffset, `page ${String(pages)}: pointer`).toBe(offset + d.rows.length);
      } else {
        expect(d.nextOffset, `page ${String(pages)}: exhausted`).toBeNull();
      }
      offset = d.nextOffset;
      expect(pages).toBeLessThan(50);
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('the same walk holds through the SERIALIZED envelope, not just the handler return', async () => {
    // Asserting on the handler return is how the 0.3.2 `who_can_access_object`
    // bug survived its own tests: the global response guard rewrites `data`
    // AFTER the handler builds it.
    const PAGE = 2;
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    let total = -1;
    while (offset !== null) {
      const args = { select: 'nodes' as const, limit: PAGE, offset };
      const r = await queryGraphHandler(ctx, args);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const block = jsonResult(r.value, { args }).content[0];
      const text = block !== undefined && block.type === 'text' ? block.text : '{}';
      const data = (JSON.parse(text) as { data: Record<string, unknown> }).data;
      const rows = data['rows'] as readonly Node[];
      pages += 1;
      total = data['totalCount'] as number;
      expect(data['returnedCount']).toBe(rows.length);
      expect(data['offset']).toBe(offset);
      const next = data['nextOffset'] as number | null;
      if (data['hasMore'] === true) expect(next).toBe((offset as number) + rows.length);
      else expect(next).toBeNull();
      for (const row of rows) seen.push(row.id);
      offset = next;
      expect(pages).toBeLessThan(50);
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it('an offset past the end returns an empty, honestly-typed page rather than a lie', async () => {
    const r = await queryGraphHandler(ctx, { select: 'nodes', offset: 400 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.rows).toHaveLength(0);
    expect(d.returnedCount).toBe(0);
    expect(d.hasMore).toBe(false);
    expect(d.nextOffset).toBeNull();
    // The empty `rows` is not a bare `[]`: `disclosure` types every absence in
    // this payload (envelope-honesty Law 1).
    expect(d.disclosure.length).toBeGreaterThan(0);
  });

  it('rejects an offset at or past the hard cap instead of answering it with an empty page', async () => {
    // The compiled SELECT has a hard LIMIT and no OFFSET, so no row at or past
    // the cap is addressable. Fail closed and NAME the cap rather than return
    // a `[]` that reads like "nothing matched".
    expect(
      queryGraphInputSchema.safeParse({ select: 'nodes', offset: QUERY_GRAPH_MAX_LIMIT }).success,
    ).toBe(false);
    expect(
      queryGraphInputSchema.safeParse({ select: 'nodes', offset: -1 }).success,
    ).toBe(false);
    expect(
      queryGraphInputSchema.safeParse({ select: 'nodes', offset: QUERY_GRAPH_MAX_LIMIT - 1 })
        .success,
    ).toBe(true);
  });

  it('the byte-trim path still ships a pointer that matches the trimmed page', async () => {
    // Every CustomField row carries a 2 KB blob on Region__c; a 1-row budget is
    // not reachable from the public API, so drive the trim through a page whose
    // rows are slimmed and confirm the pointer tracks what SHIPPED.
    const r = await queryGraphHandler(ctx, { select: 'nodes', limit: 3, offset: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.offset).toBe(1);
    expect(d.returnedCount).toBe(d.rows.length);
    if (d.hasMore) expect(d.nextOffset).toBe(1 + d.rows.length);
  });
});

describe('queryGraphHandler — fail-closed + adversarial', () => {
  it('rejects an unknown column with invalid-query naming the allowlist', async () => {
    const result = await queryGraphHandler(ctx, {
      select: 'nodes',
      where: [{ column: 'properties_json', op: '=', value: 'x' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toMatch(/Allowed columns/);
  });

  it('binds injection payloads as inert values (0 rows) and never mutates the graph', async () => {
    const INJECTIONS = [
      "'; DROP TABLE nodes; --",
      '1 OR 1=1',
      "x' UNION SELECT * FROM nodes --",
      "'; ATTACH 'evil.db' AS evil; --",
    ];
    for (const payload of INJECTIONS) {
      const eq = await queryGraphHandler(ctx, {
        select: 'nodes',
        where: [{ column: 'apiName', op: '=', value: payload }],
      });
      expect(eq.ok, `payload ${payload}`).toBe(true);
      if (eq.ok) expect(eq.value.data.returnedCount).toBe(0);
    }
    // The node set is intact afterwards.
    const intact = await queryGraphHandler(ctx, {
      select: 'nodes',
      where: [{ column: 'type', op: '=', value: 'CustomObject' }],
    });
    expect(intact.ok).toBe(true);
    if (intact.ok) expect(intact.value.data.totalCount).toBe(2);
  });
});

/**
 * THE CEILING, stated out loud.
 *
 * `compileGraphQuery` emits `... ORDER BY <fixed> LIMIT ?` and has NO `OFFSET`,
 * so the rows this tool can address are the first `QUERY_GRAPH_MAX_LIMIT` of the
 * fixed sort — full stop, for every `(limit, offset)` pair. That is a real
 * product limit, and the only honest thing a payload can do at the ceiling is
 * say so: keep `hasMore` TRUE (rows matched that were not delivered), publish no
 * pointer (there is no reachable next row), and NAME the cap.
 *
 * The failure this locks out is the opposite move — folding the unreachable
 * remainder into `hasMore: false` and calling the head of the sort a complete
 * answer. That is the 0.3.2 archetype, and it is what a naive
 * `hasMore = window not exhausted` would have produced here.
 */
const CAP_TYPE = 'ApexClass';
const CAP_ROWS = QUERY_GRAPH_MAX_LIMIT + 7;
const capSeed: ExtractionResult = {
  nodes: Array.from({ length: CAP_ROWS }, (_, i) =>
    makeNode({
      id: `ApexClass:Cap_${String(i).padStart(4, '0')}`,
      type: CAP_TYPE,
      apiName: `Cap_${String(i).padStart(4, '0')}`,
      sourcePath: `classes/Cap_${String(i).padStart(4, '0')}.cls`,
    }),
  ),
  edges: [],
};

describe('queryGraphHandler — the hard-cap ceiling is disclosed, never hidden', () => {
  let capDir: string;
  let capStore: GraphStore;
  let capCtx: Context;

  beforeAll(async () => {
    capDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-query-graph-cap-'));
    const opened = await openGraph(join(capDir, 'cap.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    capStore = opened.value;
    const imported = await importExtractionResults(capStore, [capSeed]);
    if (!imported.ok) throw new Error(imported.error.message);
    capCtx = { vaultRoot: capDir, manifest: FIXTURE_MANIFEST, graph: capStore };
  });

  afterAll(async () => {
    await closeGraph(capStore);
    rmSync(capDir, { recursive: true, force: true });
  });

  it('the first page pages normally and counts the FULL match, not the window', async () => {
    const r = await queryGraphHandler(capCtx, {
      select: 'nodes',
      where: [{ column: 'type', op: '=', value: CAP_TYPE }],
      limit: 100,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.totalCount).toBe(CAP_ROWS);
    expect(d.pageableCount).toBe(QUERY_GRAPH_MAX_LIMIT);
    expect(d.capReached).toBe(true);
    expect(d.returnedCount).toBe(100);
    expect(d.hasMore).toBe(true);
    expect(d.nextOffset).toBe(100);
    expect(d.note).toMatch(/reachable/);
  });

  it('at the ceiling it keeps hasMore true, offers no pointer, and names the cap', async () => {
    const r = await queryGraphHandler(capCtx, {
      select: 'nodes',
      where: [{ column: 'type', op: '=', value: CAP_TYPE }],
      limit: 100,
      offset: QUERY_GRAPH_MAX_LIMIT - 100,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.returnedCount).toBe(100);
    // Rows matched that this response did not deliver — say so.
    expect(d.hasMore).toBe(true);
    // …and do NOT hand back an offset the compiler cannot address.
    expect(d.nextOffset).toBeNull();
    expect(d.capReached).toBe(true);
    expect(d.note).toContain(String(QUERY_GRAPH_MAX_LIMIT));
    expect(d.note).toMatch(/where/);
  });

  it('a walk to the ceiling sees each reachable row exactly once and stops there', async () => {
    const PAGE = 200;
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    let lastHasMore = false;
    while (offset !== null) {
      const r = await queryGraphHandler(capCtx, {
        select: 'nodes',
        where: [{ column: 'type', op: '=', value: CAP_TYPE }],
        limit: PAGE,
        offset,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      pages += 1;
      for (const row of d.rows) seen.push((row as Node).id);
      lastHasMore = d.hasMore;
      offset = d.nextOffset;
      expect(pages).toBeLessThan(20);
    }
    // Every reachable row, exactly once — and the walk ended STILL saying more
    // rows exist, which is the truth the cap forces.
    expect(seen).toHaveLength(QUERY_GRAPH_MAX_LIMIT);
    expect(new Set(seen).size).toBe(QUERY_GRAPH_MAX_LIMIT);
    expect(lastHasMore).toBe(true);
  });
});

describe('queryGraphInputSchema — boundary rejections', () => {
  it('rejects over-cap limit, missing select, and a bad operator', () => {
    expect(queryGraphInputSchema.safeParse({ select: 'nodes', limit: 501 }).success).toBe(false);
    expect(queryGraphInputSchema.safeParse({ select: 'nodes', limit: 0 }).success).toBe(false);
    expect(queryGraphInputSchema.safeParse({ where: [] }).success).toBe(false);
    expect(queryGraphInputSchema.safeParse({ select: 'tables' }).success).toBe(false);
    expect(
      queryGraphInputSchema.safeParse({
        select: 'nodes',
        where: [{ column: 'id', op: 'DROP', value: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('accepts a well-formed structured query', () => {
    const parsed = queryGraphInputSchema.safeParse({
      select: 'edges',
      where: [
        { column: 'edgeType', op: 'IN', value: ['parentOf', 'triggersOn'] },
        { column: 'confidence', op: 'IS NOT NULL' },
      ],
      limit: 25,
    });
    expect(parsed.success).toBe(true);
  });
});
