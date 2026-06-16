/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  Edge,
  EdgeType,
  ExtractionResult,
  Node,
} from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import { computePhantomBucketSummary } from '../src/phantom-bucket-summary.js';
import { classifyPhantom, type CoverageStatus } from '../src/phantom-classify.js';
import { listEdges } from '../src/queries.js';
import { closeGraph, openGraph, type GraphStore } from '../src/store.js';

const node = (id: ComponentId, type: ComponentType): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const edge = (
  fromId: ComponentId,
  edgeType: EdgeType,
  toId: ComponentId,
  confidence: ConfidenceLevel,
): Edge => ({ fromId, toId, edgeType, confidence, source: 'test', properties: {} });

let tempDir: string;

const buildGraph = async (result: ExtractionResult): Promise<GraphStore> => {
  const dbPath = join(tempDir, `g-${Math.random().toString(36).slice(2)}.duckdb`);
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(opened.error.message);
  const imp = await importExtractionResults(opened.value, [result]);
  if (!imp.ok) throw new Error(imp.error.message);
  return opened.value;
};

const coverageOf = (): CoverageStatus => 'covered';

const onDemandBuckets = async (store: GraphStore): Promise<Record<string, number>> => {
  const rows = await store.connection.runAndReadAll(
    `SELECT DISTINCT e.to_id AS id FROM edges e LEFT JOIN nodes n ON e.to_id = n.id WHERE n.id IS NULL`,
    [],
  );
  const ids = (rows.getRowObjectsJS() as { id: string }[]).map((r) => r.id);
  const buckets: Record<string, number> = {};
  for (const id of ids) {
    const inbound = await listEdges(store, id as ComponentId, { direction: 'in' });
    const edges = inbound.ok ? inbound.value : [];
    const edgeKinds = [...new Set(edges.map((e) => e.edgeType))];
    const nonHeuristic = [
      ...new Set(edges.filter((e) => e.confidence !== 'heuristic').map((e) => e.edgeType)),
    ];
    const classification = classifyPhantom(
      id as ComponentId,
      edgeKinds,
      nonHeuristic,
      coverageOf(),
    );
    buckets[classification] = (buckets[classification] ?? 0) + 1;
  }
  return buckets;
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-phantom-summary-'));
});
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('computePhantomBucketSummary', () => {
  it('matches on-demand classifyPhantom buckets on a pinned dangling-target fixture', async () => {
    const store = await buildGraph({
      nodes: [
        node('ApexTrigger:Acme_OrderTrigger', 'ApexTrigger'),
        node('CustomObject:Acme_Order__c', 'CustomObject'),
      ],
      edges: [
        edge('ApexTrigger:Acme_OrderTrigger', 'triggersOn', 'CustomObject:Acme_Order__c', 'declared'),
        edge('ApexTrigger:Acme_OrderTrigger', 'triggersOn', 'CustomObject:Acme_Missing__c', 'declared'),
        edge('ApexTrigger:Acme_OrderTrigger', 'callsApex', 'ApexClass:Acme_MissingSvc', 'declared'),
        edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:Acme_GrantTarget__c', 'declared'),
        edge('ApexClass:Acme_Svc', 'readsFrom', 'CustomField:Acme_Missing__c.Foo__c', 'heuristic'),
      ],
    });
    try {
      const summary = await computePhantomBucketSummary(store, coverageOf);
      const expected = await onDemandBuckets(store);
      expect(summary.distinctPhantoms).toBe(Object.keys(expected).reduce((s, k) => s + expected[k]!, 0));
      expect(summary.buckets).toEqual(expected);
      expect(summary.buckets['automation-critical']).toBe(2);
      expect(summary.buckets['grant-only']).toBe(1);
      expect(summary.buckets.unknown).toBe(1);
    } finally {
      await closeGraph(store);
    }
  });
});
