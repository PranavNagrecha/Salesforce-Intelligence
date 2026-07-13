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
  queryGraphHandler,
  queryGraphInputSchema,
} from '../../src/tools/query-graph.js';

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
