/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok } from '@sf-intelligence/core';
import {
  closeGraph,
  listNodesByType,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type {
  Dependency,
  ToolingApiClient,
} from '@sf-intelligence/tooling-api';
import { vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';

/**
 * Stage a minimal vault with one ApexClass source file + meta-xml under
 * `source/main/default/classes/` so the refresh pipeline's extractor
 * walker emits at least one node the v1.7 enricher can hydrate.
 */
const seedVault = async (cwd: string): Promise<{ readonly vaultRoot: string }> => {
  const vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  await mkdir(paths.source, { recursive: true });
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'test',
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-05-27T00:00:00.000Z',
    }),
    'utf8',
  );
  const classesDir = join(paths.source, 'main', 'default', 'classes');
  await mkdir(classesDir, { recursive: true });
  await writeFile(
    join(classesDir, 'FooBar.cls'),
    `public class FooBar { public static void greet() { System.debug('hi'); } }`,
    'utf8',
  );
  await writeFile(
    join(classesDir, 'FooBar.cls-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
    'utf8',
  );
  return { vaultRoot };
};

const STUB_TOOLING_RESPONSE = [
  {
    Id: '01p000001ABCDEAA',
    Name: 'FooBar',
    LastModifiedDate: '2026-05-15T12:00:00.000Z',
    LastModifiedById: '005xxxxxxxxxxxxAA',
    LastModifiedBy: { Name: 'Stubbed User' },
    ApiVersion: 60.0,
  },
];

const buildStubClient = (): {
  readonly client: ToolingApiClient;
  readonly queries: string[];
} => {
  const queries: string[] = [];
  const client: ToolingApiClient = {
    query: async <T>(soql: string) => {
      queries.push(soql);
      if (soql.includes('FROM ApexClass')) {
        return ok(STUB_TOOLING_RESPONSE as unknown as readonly T[]);
      }
      // The enrichment runner iterates over the v1.7 R2 dispatch
      // table; types not present in the seeded vault still issue a
      // query when their node count is non-zero. The fixture only
      // emits ApexClass, so every other branch returns an empty
      // response.
      return ok([] as readonly T[]);
    },
    getDependencies: async () => ok([] as readonly Dependency[]),
  };
  return { client, queries };
};

describe('runRefresh with --with-tooling-api', () => {
  it('runs the offline pipeline AND the Tooling API enrichment, returning a toolingApi summary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-tapi-'));
    try {
      const { vaultRoot } = await seedVault(cwd);
      const { client, queries } = buildStubClient();

      const result = await runRefresh({
        cwd,
        noPull: true,
        withToolingApi: true,
        toolingApiClient: client,
      });
      expect(result.status === 'success' || result.status === 'partial').toBe(true);
      expect(result.toolingApi).toBeDefined();
      if (result.toolingApi === undefined) return;
      expect(result.toolingApi.outcome).toBe('ok');
      expect(result.toolingApi.enrichedCount).toBeGreaterThanOrEqual(1);

      // The stub recorded the per-type SOQL query that the enricher
      // issued.
      expect(queries.some((q) => q.includes('FROM ApexClass'))).toBe(true);

      // The graph now carries the enrichment on the FooBar node.
      const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const store: GraphStore = opened.value;
      try {
        const nodes = await listNodesByType(store, 'ApexClass', { limit: 10 });
        expect(nodes.ok).toBe(true);
        if (!nodes.ok) return;
        const foo = nodes.value.find((n) => n.id === 'ApexClass:FooBar');
        expect(foo).toBeDefined();
        if (foo === undefined) return;
        // Both the top-level field AND the properties overlay carry
        // the enriched lastModifiedDate so consumers reading either
        // axis (legacy node.lastModifiedDate vs new
        // properties.lastModifiedDate) see the live value.
        expect(foo.lastModifiedDate).toBe('2026-05-15T12:00:00.000Z');
        expect(foo.properties['lastModifiedDate']).toBe('2026-05-15T12:00:00.000Z');
        const lmb = foo.properties['lastModifiedBy'] as { id?: string; name?: string };
        expect(lmb.id).toBe('005xxxxxxxxxxxxAA');
        expect(lmb.name).toBe('Stubbed User');
      } finally {
        await closeGraph(store);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns toolingApi: undefined when --with-tooling-api is not set (default path stays offline)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-default-'));
    try {
      await seedVault(cwd);
      const result = await runRefresh({ cwd, noPull: true });
      expect(result.status === 'success' || result.status === 'partial').toBe(true);
      expect(result.toolingApi).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('surfaces enrichment failures via the toolingApi.outcome axis without flipping refresh status', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-refresh-tapi-fail-'));
    try {
      await seedVault(cwd);
      // Inject a client whose `query` throws so the runner's
      // try/catch surfaces `enrichment-threw` — the path operators
      // hit when the Tooling API's response itself is malformed in a
      // way the runner doesn't pre-handle.
      const throwingClient: ToolingApiClient = {
        query: async () => {
          throw new Error('synthetic transport error');
        },
        getDependencies: async () => ok([] as readonly Dependency[]),
      };
      const result = await runRefresh({
        cwd,
        noPull: true,
        withToolingApi: true,
        toolingApiClient: throwingClient,
      });
      expect(result.status === 'success' || result.status === 'partial').toBe(true);
      expect(result.toolingApi).toBeDefined();
      if (result.toolingApi === undefined) return;
      expect(result.toolingApi.outcome).toBe('enrichment-threw');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
