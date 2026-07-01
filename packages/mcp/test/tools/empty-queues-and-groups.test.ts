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
  emptyQueuesAndGroupsHandler,
  emptyQueuesAndGroupsInputSchema,
} from '../../src/tools/empty-queues-and-groups.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Queue: 4, Group: 3 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Queue',
  apiName: 'AnonQueue',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// Queues
const Q_TIER1 = 'Queue:Tier1_Routing'; // has members, has refs
const Q_STALE = 'Queue:Stale_Q3'; // empty, no refs
const Q_LEGACY = 'Queue:LegacyRouting'; // empty, has refs = routing trap
const Q_UNKNOWN = 'Queue:UnknownMembership';
// Groups
const G_FULL = 'Group:Marketing_Team';
const G_EMPTY = 'Group:Stale_Group';
const G_UNKNOWN = 'Group:UnknownMembers';

const STALE_DATE = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: Q_TIER1,
      apiName: 'Tier1_Routing',
      properties: {
        memberCount: 5,
        objectTypes: ['Lead', 'Case'],
      },
    }),
    makeNode({
      id: Q_STALE,
      apiName: 'Stale_Q3',
      properties: { memberCount: 0, objectTypes: ['Case'] },
    }),
    makeNode({
      id: Q_LEGACY,
      apiName: 'LegacyRouting',
      lastModifiedDate: STALE_DATE,
      properties: { memberCount: 0, objectTypes: ['Lead'] },
    }),
    makeNode({
      id: Q_UNKNOWN,
      apiName: 'UnknownMembership',
      properties: { objectTypes: ['Case'] },
    }),
    makeNode({
      id: 'AssignmentRule:Lead.AR1',
      type: 'AssignmentRule',
      apiName: 'Lead.AR1',
    }),
    makeNode({
      id: 'AssignmentRule:Lead.AR2',
      type: 'AssignmentRule',
      apiName: 'Lead.AR2',
    }),
    makeNode({
      id: 'AssignmentRule:Lead.AR3',
      type: 'AssignmentRule',
      apiName: 'Lead.AR3',
    }),
    makeNode({
      id: G_FULL,
      type: 'Group',
      apiName: 'Marketing_Team',
      properties: { memberCount: 12, type: 'Regular' },
    }),
    makeNode({
      id: G_EMPTY,
      type: 'Group',
      apiName: 'Stale_Group',
      properties: { memberCount: 0, type: 'Regular' },
    }),
    makeNode({
      id: G_UNKNOWN,
      type: 'Group',
      apiName: 'UnknownMembers',
      properties: { type: 'Regular' },
    }),
  ],
  edges: [
    // Tier1 has incoming AR ref
    makeEdge({
      fromId: 'AssignmentRule:Lead.AR1',
      toId: Q_TIER1,
      edgeType: 'references',
    }),
    makeEdge({
      fromId: 'AssignmentRule:Lead.AR2',
      toId: Q_TIER1,
      edgeType: 'references',
    }),
    // Legacy has 3 incoming AR refs → routing trap
    makeEdge({
      fromId: 'AssignmentRule:Lead.AR1',
      toId: Q_LEGACY,
      edgeType: 'references',
    }),
    makeEdge({
      fromId: 'AssignmentRule:Lead.AR2',
      toId: Q_LEGACY,
      edgeType: 'references',
    }),
    makeEdge({
      fromId: 'AssignmentRule:Lead.AR3',
      toId: Q_LEGACY,
      edgeType: 'references',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-eq-'));
  const opened = await openGraph(join(tempDir, 'eq.db'));
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

describe('emptyQueuesAndGroupsHandler', () => {
  it('does NOT include queues with members > 0', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const emptyQs = r.value.data.queues
      .filter((q) => q.memberSource !== 'unknown')
      .map((q) => q.id);
    expect(emptyQs).not.toContain(Q_TIER1);
  });

  it('includes empty queues with zero references (genuine stale)', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.data.queues.find((q) => q.id === Q_STALE);
    expect(q).toBeDefined();
    expect(q?.memberCount).toBe(0);
    expect(q?.incomingAssignmentRuleCount).toBe(0);
    expect(q?.isLikelyStale).toBe(false);
  });

  it("surfaces the routing-trap variant prominently with isLikelyStale=true", async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.data.queues.find((q) => q.id === Q_LEGACY);
    expect(q).toBeDefined();
    expect(q?.memberCount).toBe(0);
    expect(q?.incomingAssignmentRuleCount).toBe(3);
    expect(q?.isLikelyStale).toBe(true);
  });

  it("flags Queue with memberSource 'unknown' separately", async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unknownMemberCountQueues).toBeGreaterThanOrEqual(1);
    const q = r.value.data.queues.find((q) => q.id === Q_UNKNOWN);
    expect(q?.memberSource).toBe('unknown');
  });

  it('lists empty groups but excludes groups with members', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.groups
      .filter((g) => g.memberSource !== 'unknown')
      .map((g) => g.id);
    expect(ids).toContain(G_EMPTY);
    expect(ids).not.toContain(G_FULL);
  });

  it('flags Group with unknown member source', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unknownMemberCountGroups).toBeGreaterThanOrEqual(1);
    const g = r.value.data.groups.find((g) => g.id === G_UNKNOWN);
    expect(g?.memberSource).toBe('unknown');
  });

  it('respects the type filter (Queue only)', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.groups.length).toBe(0);
    expect(r.value.data.queues.length).toBeGreaterThan(0);
  });

  it('respects the type filter (Group only)', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, { type: 'Group' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.queues.length).toBe(0);
    expect(r.value.data.groups.length).toBeGreaterThan(0);
  });

  it('emits verbatim boundary disclosure about runtime membership invisibility', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toMatch(
      /runtime membership changes/,
    );
  });
});

describe('emptyQueuesAndGroupsHandler — CR-22 cursor', () => {
  it('whole-fits omits cursor block + scanTruncated (byte-identical golden)', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('nextCursor' in r.value.data).toBe(false);
    expect('pageInfo' in r.value.data).toBe(false);
    expect('otherSections' in r.value.data).toBe(false);
    expect('scanTruncated' in r.value.data).toBe(false);
    expect(r.value.data.truncated).toBe(false);
  });

  it('paging the queues list emits nextCursor + discloses groups', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, { limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.queues.length).toBe(1);
    expect(r.value.data.designatedList).toBe('queues');
    expect(r.value.data.nextCursor).toBeDefined();
    const others = r.value.data.otherSections ?? [];
    expect(others.find((s) => s.listId === 'groups')?.totalCount).toBe(2);
    // totals stay full.
    expect(r.value.data.totalQueues).toBe(3);
  });

  it('resume walks the queues list with no dup/skip', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i += 1) {
      const r = await emptyQueuesAndGroupsHandler(ctx, {
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const q of r.value.data.queues) seen.push(q.id);
      cursor = r.value.data.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen.sort()).toEqual([Q_LEGACY, Q_STALE, Q_UNKNOWN].sort());
  });

  it('rejects a cursor minted for a different type filter', async () => {
    const p1 = await emptyQueuesAndGroupsHandler(ctx, { limit: 1 });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const cursor = p1.value.data.nextCursor!;
    const stale = await emptyQueuesAndGroupsHandler(ctx, { type: 'Queue', limit: 1, cursor });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('invalid-query');
  });
});

describe('emptyQueuesAndGroupsInputSchema', () => {
  it('accepts empty input', () => {
    expect(emptyQueuesAndGroupsInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects invalid type', () => {
    expect(
      emptyQueuesAndGroupsInputSchema.safeParse({ type: 'Other' }).success,
    ).toBe(false);
  });

  it('rejects limit above 500', () => {
    expect(
      emptyQueuesAndGroupsInputSchema.safeParse({ limit: 501 }).success,
    ).toBe(false);
  });

  it('accepts both queue and group types', () => {
    expect(
      emptyQueuesAndGroupsInputSchema.safeParse({ type: 'both' }).success,
    ).toBe(true);
    expect(
      emptyQueuesAndGroupsInputSchema.safeParse({ type: 'Queue' }).success,
    ).toBe(true);
    expect(
      emptyQueuesAndGroupsInputSchema.safeParse({ type: 'Group' }).success,
    ).toBe(true);
  });
});

describe('coverage-aware-zero — Queue/Group not retrieved', () => {
  let covDir: string;
  let covStore: GraphStore;

  beforeAll(async () => {
    covDir = mkdtempSync(join(tmpdir(), 'sfi-eqg-cov-'));
    const o = await openGraph(join(covDir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    covStore = o.value;
    await importExtractionResults(covStore, [
      { nodes: [makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' })], edges: [] },
    ]);
  });

  afterAll(async () => {
    await closeGraph(covStore);
    rmSync(covDir, { recursive: true, force: true });
  });

  const COV_MANIFEST: VaultManifest = {
    version: '0.1.0',
    refreshedAt: '2026-05-27T14:33:08Z',
    sourceOrg: 'me@example.com',
    components: { CustomObject: 1 },
    edges: {},
    sourceTreeHash: 'sha256:fixture-cov',
    coverage: [
      { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'Queue', requested: true, retrieved: 0, errored: false, neverModeled: false },
      { type: 'Group', requested: true, retrieved: 0, errored: false, neverModeled: false },
    ],
  };

  it('attaches a coverageCaveat naming both unretrieved families', async () => {
    const r = await emptyQueuesAndGroupsHandler(
      { vaultRoot: covDir, manifest: COV_MANIFEST, graph: covStore },
      {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalQueues).toBe(0);
    expect(r.value.data.totalGroups).toBe(0);
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toEqual(
      expect.arrayContaining(['Queue', 'Group']),
    );
    expect(r.value.data.coverageCaveat?.message).toMatch(/not checked/);
  });

  it('scopes the caveat to the requested type filter', async () => {
    const r = await emptyQueuesAndGroupsHandler(
      { vaultRoot: covDir, manifest: COV_MANIFEST, graph: covStore },
      { type: 'Queue' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain('Queue');
    expect(r.value.data.coverageCaveat?.missingCoverage).not.toContain('Group');
  });
});
