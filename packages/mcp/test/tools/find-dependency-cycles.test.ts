/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  findDependencyCyclesHandler,
  findDependencyCyclesInputSchema,
} from '../../src/tools/find-dependency-cycles.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { ApexClass: 6 },
  edges: { callsApex: 6 },
  sourceTreeHash: 'sha256:fixture',
};

const cls = (name: string): Node => ({
  id: `ApexClass:${name}`,
  type: 'ApexClass',
  apiName: name,
  label: null,
  parentId: null,
  sourcePath: `${name}.cls`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const calls = (from: string, to: string): Edge => ({
  fromId: `ApexClass:${from}`,
  toId: `ApexClass:${to}`,
  edgeType: 'callsApex',
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
});

// Graph:
//   Cycle:    A -> B -> C -> A         (3-node SCC)
//   Self:     R -> R                   (self-recursive)
//   Acyclic:  X -> Y                   (no cycle)
const seed: ExtractionResult = {
  nodes: ['A', 'B', 'C', 'R', 'X', 'Y'].map(cls),
  edges: [
    calls('A', 'B'),
    calls('B', 'C'),
    calls('C', 'A'),
    calls('R', 'R'),
    calls('X', 'Y'),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-cycles-'));
  const opened = await openGraph(join(tempDir, 'cycles.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('findDependencyCyclesHandler', () => {
  it('detects the 3-node A->B->C->A cycle', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const three = r.value.data.cycles.find((c) => c.size === 3);
    expect(three).toBeDefined();
    expect(three?.members).toEqual(['ApexClass:A', 'ApexClass:B', 'ApexClass:C']);
    expect(three?.selfRecursive).toBe(false);
  });

  it('detects the self-recursive class R->R', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const self = r.value.data.cycles.find((c) => c.members[0] === 'ApexClass:R');
    expect(self).toBeDefined();
    expect(self?.size).toBe(1);
    expect(self?.selfRecursive).toBe(true);
  });

  it('does NOT report the acyclic X->Y chain', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.cycles.flatMap((c) => c.members);
    expect(ids).not.toContain('ApexClass:X');
    expect(ids).not.toContain('ApexClass:Y');
  });

  it('reports a summary and carries honesty boundaries', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.cyclicClusters).toBe(2); // the 3-cycle + the self-loop
    expect(r.value.data.summary.largestClusterSize).toBe(3);
    expect(r.value.data.boundaries.length).toBeGreaterThan(0);
  });
});

describe('findDependencyCyclesInputSchema', () => {
  it('accepts empty input', () => {
    expect(findDependencyCyclesInputSchema.safeParse({}).success).toBe(true);
  });
  it('rejects limit above 200', () => {
    expect(findDependencyCyclesInputSchema.safeParse({ limit: 201 }).success).toBe(false);
  });
});
