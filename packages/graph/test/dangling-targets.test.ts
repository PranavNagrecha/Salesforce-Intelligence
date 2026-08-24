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
import { danglingTargetSummary } from '../src/queries.js';
import { closeGraph, openGraph, type GraphStore } from '../src/store.js';

// Synthetic-only fixtures (no real org names) — `danglingTargetSummary` groups
// every edge whose target id has no node by (targetType, edgeKind, confidence).

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

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-dangling-'));
});
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('danglingTargetSummary', () => {
  it('groups edges to missing targets by (targetType, edgeKind, confidence) and skips resolved targets', async () => {
    const store = await buildGraph({
      nodes: [
        node('ApexTrigger:Acme_OrderTrigger', 'ApexTrigger'),
        node('CustomObject:Acme_Order__c', 'CustomObject'),
      ],
      edges: [
        // Resolved — target node exists; must NOT appear.
        edge('ApexTrigger:Acme_OrderTrigger', 'triggersOn', 'CustomObject:Acme_Order__c', 'declared'),
        // Dangling automation/code references.
        edge('ApexTrigger:Acme_OrderTrigger', 'triggersOn', 'CustomObject:Acme_Missing__c', 'declared'),
        edge('ApexTrigger:Acme_OrderTrigger', 'callsApex', 'ApexClass:Acme_MissingSvc', 'declared'),
        // Dangling permission grant.
        edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:Acme_GrantTarget__c', 'declared'),
        // Dangling heuristic scanner phantom.
        edge('ApexClass:Acme_Svc', 'readsFrom', 'CustomField:Acme_Missing__c.Foo__c', 'heuristic'),
      ],
    });
    try {
      const r = await danglingTargetSummary(store);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const groups = r.value;

      // The resolved target never appears in any group's samples.
      const allSamples = groups.flatMap((g) => g.sampleTargets);
      expect(allSamples).not.toContain('CustomObject:Acme_Order__c');

      const find = (t: string, k: string, c: string) =>
        groups.find((g) => g.targetType === t && g.edgeType === k && g.confidence === c);

      const trig = find('CustomObject', 'triggersOn', 'declared');
      expect(trig?.distinctTargets).toBe(1);
      expect(trig?.sampleTargets).toContain('CustomObject:Acme_Missing__c');

      expect(find('ApexClass', 'callsApex', 'declared')?.distinctTargets).toBe(1);
      expect(find('CustomObject', 'grantedBy', 'declared')?.sampleReferencedBy).toContain(
        'PermissionSet:Acme_PS',
      );
      expect(find('CustomField', 'readsFrom', 'heuristic')?.confidence).toBe('heuristic');
    } finally {
      await closeGraph(store);
    }
  });

  it('returns [] for a fully covered vault (every edge target resolves)', async () => {
    const store = await buildGraph({
      nodes: [
        node('ApexTrigger:Acme_OrderTrigger', 'ApexTrigger'),
        node('CustomObject:Acme_Order__c', 'CustomObject'),
      ],
      edges: [
        edge('ApexTrigger:Acme_OrderTrigger', 'triggersOn', 'CustomObject:Acme_Order__c', 'declared'),
      ],
    });
    try {
      const r = await danglingTargetSummary(store);
      expect(r.ok && r.value).toEqual([]);
    } finally {
      await closeGraph(store);
    }
  });
});
