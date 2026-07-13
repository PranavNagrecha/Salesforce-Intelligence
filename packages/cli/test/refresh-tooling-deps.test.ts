/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node } from '@sf-intelligence/contracts';
import { ok } from '@sf-intelligence/core';
import {
  closeGraph,
  importExtractionResults,
  listEdges,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type {
  Dependency,
  ToolingApiClient,
} from '@sf-intelligence/tooling-api';
import { vaultPaths } from '@sf-intelligence/vault';

import { runToolingApiEnrichment } from '../src/commands/refresh.js';

/**
 * #16 — `runToolingApiEnrichment` must call `enrichDependencies` after
 * freshness enrichment, stamp `confirmedByApi` on matching edges, and
 * append new `dependsOnFromApi` edges. Stubbed Tooling client — no live org.
 */

const makeNode = (
  overrides: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>,
): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'src/fixture.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const seedGraph = async (
  vaultRoot: string,
): Promise<GraphStore> => {
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  await mkdir(paths.graph, { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'test',
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-07-12T00:00:00.000Z',
    }),
    'utf8',
  );
  const opened = await openGraph(paths.graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  const store = opened.value;
  const seed: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'ApexClass:AccountService',
        type: 'ApexClass',
        apiName: 'AccountService',
        sourcePath: 'classes/AccountService.cls',
      }),
      makeNode({
        id: 'CustomField:Account.Industry__c',
        type: 'CustomField',
        apiName: 'Industry__c',
        parentId: 'CustomObject:Account',
        sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
      }),
      makeNode({
        id: 'CustomField:Account.ApiOnly__c',
        type: 'CustomField',
        apiName: 'ApiOnly__c',
        parentId: 'CustomObject:Account',
        sourcePath: 'objects/Account/fields/ApiOnly__c.field-meta.xml',
      }),
    ],
    edges: [
      {
        fromId: 'ApexClass:AccountService',
        toId: 'CustomField:Account.Industry__c',
        edgeType: 'readsFrom',
        confidence: 'heuristic',
        source: 'apex-scanner',
        properties: { line: 12 },
      },
    ],
  };
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  return store;
};

const buildStubClient = (): ToolingApiClient => ({
  query: async <T>(soql: string) => {
    // Freshness enricher: return a LastModifiedDate row for ApexClass only.
    if (soql.includes('FROM ApexClass')) {
      return ok([
        {
          Id: '01p000000ACCOUNT',
          Name: 'AccountService',
          LastModifiedDate: '2026-07-01T00:00:00.000Z',
          LastModifiedById: '005xxxxxxxxxxxxAA',
          LastModifiedBy: { Name: 'Stub User' },
          ApiVersion: 60.0,
        },
      ] as unknown as readonly T[]);
    }
    return ok([] as readonly T[]);
  },
  getDependencies: async (componentId: string) => {
    // Confirm the pre-existing Apex→Industry edge when the field is queried,
    // and emit an API-only edge to ApiOnly__c (no pre-existing edge).
    if (componentId === 'CustomField:Account.Industry__c') {
      return ok([
        {
          Id: 'dep-confirm',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'AccountService',
          RefMetadataComponentId: '00N1',
          RefMetadataComponentType: 'CustomField',
          RefMetadataComponentName: 'Account.Industry__c',
        },
      ] as readonly Dependency[]);
    }
    if (componentId === 'CustomField:Account.ApiOnly__c') {
      return ok([
        {
          Id: 'dep-new',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'AccountService',
          RefMetadataComponentId: '00N2',
          RefMetadataComponentType: 'CustomField',
          RefMetadataComponentName: 'Account.ApiOnly__c',
        },
      ] as readonly Dependency[]);
    }
    return ok([] as readonly Dependency[]);
  },
});

describe('runToolingApiEnrichment — dependency confirmation (#16)', () => {
  it('stamps confirmedByApi on matching edges and appends dependsOnFromApi edges', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-deps-'));
    const vaultRoot = join(cwd, 'org-kb');
    const store = await seedGraph(vaultRoot);
    try {
      const summary = await runToolingApiEnrichment(store, 'test', {
        cwd,
        noPull: true,
        withToolingApi: true,
        toolingApiClient: buildStubClient(),
      });
      expect(summary.outcome).toBe('ok');
      expect(summary.dependencyConfirmedCount).toBe(1);
      expect(summary.dependencyNewEdgeCount).toBe(1);

      const industryEdges = await listEdges(
        store,
        'CustomField:Account.Industry__c',
        { direction: 'in' },
      );
      expect(industryEdges.ok).toBe(true);
      if (!industryEdges.ok) return;
      const confirmed = industryEdges.value.find(
        (e) =>
          e.fromId === 'ApexClass:AccountService' &&
          e.edgeType === 'readsFrom',
      );
      expect(confirmed).toBeDefined();
      expect(confirmed?.properties['confirmedByApi']).toBe(true);
      // Confidence / edgeType preserved (enricher contract).
      expect(confirmed?.confidence).toBe('heuristic');
      expect(confirmed?.source).toBe('apex-scanner');

      const apiOnlyEdges = await listEdges(
        store,
        'CustomField:Account.ApiOnly__c',
        { direction: 'in' },
      );
      expect(apiOnlyEdges.ok).toBe(true);
      if (!apiOnlyEdges.ok) return;
      const apiEdge = apiOnlyEdges.value.find(
        (e) => e.edgeType === 'dependsOnFromApi',
      );
      expect(apiEdge).toBeDefined();
      expect(apiEdge?.fromId).toBe('ApexClass:AccountService');
      expect(apiEdge?.confidence).toBe('declared');
      expect(apiEdge?.source).toBe('tooling-api-dependency');
      expect(apiEdge?.properties['isApiOnly']).toBe(true);
    } finally {
      await closeGraph(store);
    }
  });

  it('skips dependency enrichment when there are no candidates (offline path untouched)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-deps-empty-'));
    const vaultRoot = join(cwd, 'org-kb');
    const paths = vaultPaths(vaultRoot);
    await mkdir(paths.meta, { recursive: true });
    await mkdir(paths.graph, { recursive: true });
    const opened = await openGraph(paths.graphDb);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      const summary = await runToolingApiEnrichment(opened.value, 'test', {
        cwd,
        noPull: true,
        withToolingApi: true,
        toolingApiClient: buildStubClient(),
      });
      expect(summary.outcome).toBe('no-enrichable-nodes');
      expect(summary.dependencyConfirmedCount).toBeUndefined();
    } finally {
      await closeGraph(opened.value);
    }
  });
});
