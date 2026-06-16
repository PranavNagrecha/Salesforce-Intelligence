/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orgPulseHandler, orgPulseInputSchema } from '../../src/tools/org-pulse.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:org-pulse-fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
  type: 'CustomObject',
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

// Two components carry author + date; one is unknown — so coverage is 2/3.
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Alpha__c', apiName: 'Alpha__c', lastModifiedBy: 'alice', lastModifiedDate: '2024-01-01T00:00:00Z' }),
    node({ id: 'CustomObject:Beta__c', apiName: 'Beta__c', lastModifiedBy: 'bob', lastModifiedDate: '2026-02-02T00:00:00Z' }),
    node({ id: 'CustomObject:Gamma__c', apiName: 'Gamma__c' }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pulse-'));
  const opened = await openGraph(join(tempDir, 'pulse.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('orgPulseHandler', () => {
  it('reports freshness coverage from lastModifiedDate', async () => {
    const r = await orgPulseHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.freshness.total).toBe(3);
    expect(r.value.data.freshness.withKnownDate).toBe(2);
    expect(r.value.data.freshness.unknownDate).toBe(1);
    expect(r.value.data.freshness.coveragePct).toBeGreaterThan(0);
  });

  it('lists contributors by lastModifiedBy', async () => {
    const r = await orgPulseHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const authors = r.value.data.contributors.contributors.map((c) => c.author);
    expect(authors).toContain('alice');
    expect(authors).toContain('bob');
    expect(r.value.data.contributors.totalWithAuthor).toBe(2);
  });

  it('carries the tooling-API honesty disclosure', async () => {
    const r = await orgPulseHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure.toLowerCase()).toContain('tooling');
    expect(r.value.vaultState.sourceTreeHash).toBe('sha256:org-pulse-fixture');
  });

  it('honours a limit', async () => {
    const r = await orgPulseHandler(ctx, { limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.contributors.contributors.length).toBeLessThanOrEqual(1);
  });
});

describe('orgPulseInputSchema', () => {
  it('accepts empty input and a valid limit', () => {
    expect(orgPulseInputSchema.safeParse({}).success).toBe(true);
    expect(orgPulseInputSchema.safeParse({ limit: 5 }).success).toBe(true);
  });
  it('rejects a limit over 50', () => {
    expect(orgPulseInputSchema.safeParse({ limit: 51 }).success).toBe(false);
  });
});
