/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node } from '@sf-intelligence/contracts';
import { ok } from '@sf-intelligence/core';
import {
  closeGraph,
  importExtractionResults,
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
 * P2 (enrichment scope): `runToolingApiEnrichment` collected candidates with a
 * single capped `listNodesByType(store, type, { limit: 500 })`, so every node
 * past the first 500 of a type was silently dropped — on a real org this left
 * only ~674/6536 nodes enriched. This test seeds > 500 ApexClass nodes and
 * asserts ALL of them are queried (and enriched), which fails before the
 * paginated candidate loop lands.
 */

const SEED_COUNT = 650; // > LIST_MAX_LIMIT (500) so a single page would truncate.

const makeApexNode = (name: string): Node => ({
  id: `ApexClass:${name}`,
  type: 'ApexClass',
  apiName: name,
  label: null,
  parentId: null,
  sourcePath: `classes/${name}.cls`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const seedGraph = async (
  vaultRoot: string,
): Promise<{ readonly store: GraphStore; readonly names: string[] }> => {
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  await mkdir(paths.graph, { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'test',
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-06-27T00:00:00.000Z',
    }),
    'utf8',
  );
  const opened = await openGraph(paths.graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  const store = opened.value;
  // Zero-pad so ORDER BY id ASC paging is deterministic and human-checkable.
  const names = Array.from({ length: SEED_COUNT }, (_, i) =>
    `Klass_${String(i).padStart(4, '0')}`,
  );
  const result: ExtractionResult = {
    nodes: names.map(makeApexNode),
    edges: [],
  };
  const imported = await importExtractionResults(store, [result]);
  if (!imported.ok) throw new Error(imported.error.message);
  return { store, names };
};

/**
 * Stub tooling client that records every name seen in a `WHERE Name IN (...)`
 * clause and echoes a freshness row back for each, so the enrichment correlates
 * and the candidate set is observable as the union of all queried names.
 */
const buildStubClient = (): {
  readonly client: ToolingApiClient;
  readonly queriedNames: Set<string>;
} => {
  const queriedNames = new Set<string>();
  const client: ToolingApiClient = {
    query: async <T>(soql: string) => {
      if (!soql.includes('FROM ApexClass')) {
        return ok([] as readonly T[]);
      }
      const inMatch = /WHERE Name IN \(([^)]*)\)/.exec(soql);
      const rows: Record<string, unknown>[] = [];
      if (inMatch?.[1] !== undefined) {
        for (const raw of inMatch[1].split(',')) {
          const name = raw.trim().replace(/^'/, '').replace(/'$/, '');
          if (name.length === 0) continue;
          queriedNames.add(name);
          rows.push({
            Id: `01p${name}`,
            Name: name,
            LastModifiedDate: '2026-06-01T00:00:00.000Z',
            LastModifiedById: '005xxxxxxxxxxxxAA',
            LastModifiedBy: { Name: 'Stub' },
            ApiVersion: 60.0,
          });
        }
      }
      return ok(rows as unknown as readonly T[]);
    },
    getDependencies: async () => ok([] as readonly Dependency[]),
  };
  return { client, queriedNames };
};

describe('runToolingApiEnrichment — paginates ALL candidates past the 500 cap', () => {
  // Seeds 650 nodes into DuckDB then enriches; under parallel suite load the
  // native graph import + enrichment can exceed the 5s default, so raise it.
  it('queries and enriches every node of a type with > 500 nodes', { timeout: 30_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-enrich-page-'));
    const vaultRoot = join(cwd, 'org-kb');
    const { store, names } = await seedGraph(vaultRoot);
    const { client, queriedNames } = buildStubClient();
    try {
      const summary = await runToolingApiEnrichment(store, 'test', {
        cwd,
        noPull: true,
        toolingApiClient: client,
        withToolingApi: true,
      });
      // Every seeded node must have been queried — not just the first 500.
      for (const name of names) {
        expect(queriedNames.has(name)).toBe(true);
      }
      expect(queriedNames.size).toBe(SEED_COUNT);
      expect(summary.outcome).toBe('ok');
      expect(summary.enrichedCount).toBe(SEED_COUNT);
    } finally {
      await closeGraph(store);
    }
  });
});
