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
    // MEASURED empties: `memberChannels: []` is the sentinel the current
    // extractor writes once it has walked EVERY `<queueMembers>` channel, so
    // these zeros are checked zeros. Before the membership-honesty fix these
    // fixtures carried no sentinel, which made this suite assert that an
    // unwalked queue is a confirmed empty — the defect itself, pinned as
    // expected behavior. The unwalked shape now has its own honest cases in
    // the "an unmeasured zero is never a measured zero" block below.
    makeNode({
      id: Q_STALE,
      apiName: 'Stale_Q3',
      properties: {
        memberCount: 0,
        memberChannels: [],
        queueMembersDeclared: false,
        queueMembersUnparsed: false,
        objectTypes: ['Case'],
      },
    }),
    makeNode({
      id: Q_LEGACY,
      apiName: 'LegacyRouting',
      lastModifiedDate: STALE_DATE,
      properties: {
        memberCount: 0,
        memberChannels: [],
        queueMembersDeclared: false,
        queueMembersUnparsed: false,
        objectTypes: ['Lead'],
      },
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

  // SPLIT from "lists empty groups but excludes groups with members", which
  // asserted that a zero-declared-member group is a CONFIRMED empty
  // (`memberSource !== 'unknown'`). It cannot be: the retrieved Group metadata
  // carries no membership element at all, so that zero was never measured. The
  // two honest halves are (a) a group with declared members is never listed,
  // and (b) a zero-declared group is listed as unknown-membership.
  it('never lists a group that declares members', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.groups.map((g) => g.id)).not.toContain(G_FULL);
  });

  it('lists a zero-declared-member group as unknown-membership, not as empty', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.value.data.groups.find((x) => x.id === G_EMPTY);
    expect(g).toBeDefined();
    expect(g?.memberSource).toBe('unknown');
    expect(g?.memberCountUnknownReason).toBe('group-membership-not-in-metadata');
    expect(r.value.data.confirmedEmptyGroups).toBe(0);
  });

  it('flags Group with unknown member source', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unknownMemberCountGroups).toBeGreaterThanOrEqual(1);
    const g = r.value.data.groups.find((g) => g.id === G_UNKNOWN);
    expect(g?.memberSource).toBe('unknown');
  });

  // EMPTY-QUEUES-AND-GROUPS-FALSE-EMPTY-LIVE-DRIFT: no listed row is ever
  // cleanup-ready. A MEASURED empty queue is `review-not-delete` (vault
  // emptiness drifts from the live roster); a group whose membership was never
  // measurable is `unknown-membership`. The earlier version of this case
  // asserted `memberSource !== 'unknown'` on the group, i.e. it required the
  // fabricated provenance; the measured-row half now rides on the queue, which
  // really does carry a walked-every-channel zero.
  it('marks every listed row non-delete, measured or not', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.data.queues.find((x) => x.id === Q_STALE);
    expect(q?.memberCount).toBe(0);
    expect(q?.memberSource).not.toBe('unknown');
    expect(q?.cleanupVerdict).toBe('review-not-delete');
    const g = r.value.data.groups.find((x) => x.id === G_EMPTY);
    expect(g?.memberCount).toBe(0);
    expect(g?.cleanupVerdict).toBe('unknown-membership');
    // every emitted queue/group row carries a non-delete verdict
    for (const row of [...r.value.data.queues, ...r.value.data.groups]) {
      expect(['review-not-delete', 'unknown-membership']).toContain(
        row.cleanupVerdict,
      );
    }
    // unknown-membership rows get their own verdict
    const gUnknown = r.value.data.groups.find((x) => x.id === G_UNKNOWN);
    expect(gUnknown?.cleanupVerdict).toBe('unknown-membership');
    expect(gUnknown?.memberCountUnknownReason).toBe('no-member-data-extracted');
    // the drift boundary points the reader at the live confirmation tool
    expect(
      r.value.data.boundaries.some(
        (b) => b.includes('live_group_members') && b.includes('review-not-delete'),
      ),
    ).toBe(true);
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

describe('emptyQueuesAndGroupsHandler — nameContains scope (EMPTY-QUEUES-AND-GROUPS-IGNORES-NAMECONTAINS)', () => {
  it('a bare no-filter call omits appliedScope (byte-identical to the pre-filter golden)', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('appliedScope' in r.value.data).toBe(false);
  });

  it('a matching nameContains returns the SUBSET (case-insensitive) with appliedScope echoed', async () => {
    const bare = await emptyQueuesAndGroupsHandler(ctx, {});
    const scoped = await emptyQueuesAndGroupsHandler(ctx, {
      nameContains: 'legacy',
    });
    expect(bare.ok).toBe(true);
    expect(scoped.ok).toBe(true);
    if (!bare.ok || !scoped.ok) return;
    const d = scoped.value.data;
    // 'legacy' matches only LegacyRouting among the listed queues, and no group.
    expect(d.queues.map((q) => q.id)).toEqual([Q_LEGACY]);
    expect(d.queues.length).toBeLessThan(bare.value.data.queues.length);
    expect(d.groups).toEqual([]);
    expect(d.totalQueues).toBe(1);
    expect(d.totalGroups).toBe(0);
    expect(d.appliedScope).toEqual({
      nameContains: 'legacy',
      mode: 'nameContains',
    });
  });

  it('a non-matching nameContains returns an honest empty result, never the bare inventory', async () => {
    const r = await emptyQueuesAndGroupsHandler(ctx, {
      nameContains: 'NoSuchName_ZZZ',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.queues).toEqual([]);
    expect(d.groups).toEqual([]);
    expect(d.totalQueues).toBe(0);
    expect(d.totalGroups).toBe(0);
    expect(d.appliedScope?.nameContains).toBe('NoSuchName_ZZZ');
  });

  it('binds nameContains into the cursor fingerprint (a scoped cursor cannot replay against the bare list)', async () => {
    // 'n' matches LegacyRouting + UnknownMembership (2 listed queues); limit 1
    // forces a page and mints a nextCursor bound to the scoped fingerprint.
    const scoped = await emptyQueuesAndGroupsHandler(ctx, {
      nameContains: 'n',
      limit: 1,
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    const cursor = scoped.value.data.nextCursor;
    expect(cursor).toBeDefined();
    if (cursor === undefined) return;
    // Replaying that cursor WITHOUT the filter must be rejected — the
    // fingerprint differs, so a scoped cursor can't pull the bare inventory.
    const replay = await emptyQueuesAndGroupsHandler(ctx, { limit: 1, cursor });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});

describe('emptyQueuesAndGroupsHandler — nameContains matches label + is case-insensitive', () => {
  let dir: string;
  let s: GraphStore;
  const M: VaultManifest = {
    ...FIXTURE_MANIFEST,
    sourceTreeHash: 'sha256:fixture-name',
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-eqg-name-'));
    const o = await openGraph(join(dir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    s = o.value;
    await importExtractionResults(s, [
      {
        nodes: [
          makeNode({
            id: 'Queue:Alpha_Queue',
            apiName: 'Alpha_Queue',
            label: 'Alpha Support',
            properties: { memberCount: 0, objectTypes: [] },
          }),
          makeNode({
            id: 'Queue:Beta_Queue',
            apiName: 'Beta_Queue',
            label: 'Beta Team',
            properties: { memberCount: 0, objectTypes: [] },
          }),
          makeNode({
            id: 'Group:Alpha_Group',
            type: 'Group',
            apiName: 'Alpha_Group',
            label: 'Alpha Group',
            properties: { memberCount: 0, type: 'Regular' },
          }),
        ],
        edges: [],
      },
    ]);
  });

  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches on apiName across queues and groups, case-insensitively', async () => {
    const r = await emptyQueuesAndGroupsHandler(
      { vaultRoot: dir, manifest: M, graph: s },
      { nameContains: 'alpha' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.queues.map((q) => q.id)).toEqual(['Queue:Alpha_Queue']);
    expect(r.value.data.groups.map((g) => g.id)).toEqual(['Group:Alpha_Group']);
    expect(r.value.data.appliedScope).toEqual({
      nameContains: 'alpha',
      mode: 'nameContains',
    });
  });

  it('matches on the display label when the apiName does not contain the needle', async () => {
    const r = await emptyQueuesAndGroupsHandler(
      { vaultRoot: dir, manifest: M, graph: s },
      { nameContains: 'support' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 'support' appears only in Alpha_Queue's LABEL ('Alpha Support').
    expect(r.value.data.queues.map((q) => q.id)).toEqual(['Queue:Alpha_Queue']);
    expect(r.value.data.groups).toEqual([]);
  });
});

describe('emptyQueuesAndGroupsInputSchema', () => {
  it('accepts empty input', () => {
    expect(emptyQueuesAndGroupsInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a nameContains filter', () => {
    expect(
      emptyQueuesAndGroupsInputSchema.safeParse({ nameContains: 'Routing' })
        .success,
    ).toBe(true);
  });

  it('rejects an empty nameContains (min length 1)', () => {
    expect(
      emptyQueuesAndGroupsInputSchema.safeParse({ nameContains: '' }).success,
    ).toBe(false);
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

// R6 (BRIEF 084 / scan-tail-unreachable) — a single un-offset `listNodesByType`
// page caps the SCAN axis (not just the OUTPUT axis) at 500 nodes per type. A
// Queue/Group sorted past row 500 in id-ASC order is never fetched at all, so
// no cursor can ever reach it — distinct from CR-22 output pagination, which
// only pages a list that was already built from the capped window. 500 filler
// Queues (non-empty, so they'd never surface as "empty" even if scanned) sort
// FIRST; one target Queue sorts LAST (row 501) and is genuinely empty.
describe('emptyQueuesAndGroupsHandler — past the 500-node SCAN cap (R6 scan-tail-unreachable)', () => {
  let dir: string;
  let st: GraphStore;
  let bigCtx: Context;

  const FILLER = 500;
  const bigNodes: Node[] = [];
  for (let i = 0; i < FILLER; i += 1) {
    bigNodes.push(
      makeNode({
        id: `Queue:Cls${String(i).padStart(3, '0')}`,
        apiName: `Cls${String(i).padStart(3, '0')}`,
        // Non-empty: must NEVER surface even once reachable — isolates the
        // scan-reachability bug from the emptiness filter.
        properties: { memberCount: 5 },
      }),
    );
  }
  bigNodes.push(
    makeNode({
      id: 'Queue:Zqueue',
      apiName: 'Zqueue',
      properties: { memberCount: 0 },
    }),
  );
  const bigSeed: ExtractionResult = { nodes: bigNodes, edges: [] };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-eq-scancap-'));
    const opened = await openGraph(join(dir, 'eq.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    st = opened.value;
    const imp = await importExtractionResults(st, [bigSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    bigCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: st };
  });

  afterAll(async () => {
    await closeGraph(st);
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the empty Queue sorted past row 500 (fail-before on the un-offset single page)', async () => {
    const r = await emptyQueuesAndGroupsHandler(bigCtx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Pre-fix: the un-offset `listNodesByType` page holds only Cls000..Cls499
    // (all non-empty), so `queues` is empty and `totalQueues` is 0 — a
    // permanently incomplete cleanup shortlist that no cursor can recover,
    // even though the tool's own `scanTruncated` disclosure below is honest
    // about there being 501 Queue nodes.
    expect(r.value.data.totalQueues).toBe(1);
    expect(r.value.data.queues.map((q) => q.id)).toContain('Queue:Zqueue');
  });

  it('does not falsely disclose scanTruncated once the full 501-node type is walked', async () => {
    // 501 < FULL_SCAN_MAX_NODES (20,000), so the multi-window walk completes
    // and there is nothing left to disclose as truncated.
    const r = await emptyQueuesAndGroupsHandler(bigCtx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('scanTruncated' in r.value.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MEMBERSHIP HONESTY — a zero the tool never measured must not be certified.
//
// Two real-org shapes produced a CONFIDENT ZERO with a fabricated provenance
// label (`memberSource: 'user-direct'`, i.e. "a direct user reference was
// read") over membership the vault never read:
//
//  1. QUEUE, legacy extraction. `<queueMembers>` is a container of one WRAPPER
//     PER MEMBER CHANNEL (`<users>`, `<roles>`, …). An older refresh read only
//     the `<users>` channel, so a queue staffed ENTIRELY by a role extracted as
//     `memberCount: 0` — and this tool, whose whole job is to name the EMPTY
//     queues, then named the one queue in the org that is NOT empty. The
//     current extractor walks every channel and stamps `memberChannels`; a node
//     WITHOUT that property came from a refresh that only looked at `<users>`,
//     so its zero is "we only looked in one place", never "nobody is in it".
//     R1: decided by whether the node CARRIES the sentinel, never by the count.
//
//  2. GROUP. The retrieved `Group` metadata declares no membership element at
//     all; public-group membership lives in GroupMember DATA, which a metadata
//     retrieve never emits (which is exactly why `sfi.live_group_members`
//     exists and queries it over the API). A zero declared count is therefore
//     NOT-MEASURED for every public group in every org, forever — a re-refresh
//     cannot fix it. Certifying it as empty hands a cleanup shortlist that is
//     just the shape of the metadata format.
//
// Both must land in the tool's OWN unknown bucket (`memberSource: 'unknown'`,
// `cleanupVerdict: 'unknown-membership'`, counted in `unknownMemberCount*`) and
// stay out of the confirmed-empty counters — the handling its sibling
// `sfi.unassigned_permission_sets` already gives the identical unknowable.
// ---------------------------------------------------------------------------
describe('emptyQueuesAndGroupsHandler — an unmeasured zero is never a measured zero', () => {
  let hDir: string;
  let hStore: GraphStore;
  let hCtx: Context;

  // Legacy (users-only) refresh: no `memberChannels` sentinel. This is the
  // real-org shape — a role-staffed queue whose role member was dropped.
  const Q_LEGACY_VAULT = 'Queue:Queue_A';
  // Modern refresh, genuinely nothing declared: `memberChannels: []` proves
  // EVERY channel was walked, so this zero IS a measurement.
  const Q_WALKED_CLEAN = 'Queue:Queue_B';
  // Modern refresh, role-staffed: not empty at all, must never be listed.
  const Q_ROLE_STAFFED = 'Queue:Queue_C';
  // Modern refresh whose `<queueMembers>` block could not be read.
  const Q_UNREADABLE = 'Queue:Queue_D';
  // Public group with zero declared members — unmeasurable by construction.
  const G_ZERO_DECLARED = 'Group:Group_E';

  beforeAll(async () => {
    hDir = mkdtempSync(join(tmpdir(), 'sfi-eqg-honesty-'));
    const o = await openGraph(join(hDir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    hStore = o.value;
    const imp = await importExtractionResults(hStore, [
      {
        nodes: [
          makeNode({
            id: Q_LEGACY_VAULT,
            apiName: 'Queue_A',
            // Verbatim shape of a Queue node on a real vault: no
            // `memberChannels` sentinel, and NO `objectTypes` property — no
            // extractor has ever written that key.
            properties: { memberCount: 0, memberEmails: [], sobjectTypeCount: 1 },
          }),
          makeNode({
            id: Q_WALKED_CLEAN,
            apiName: 'Queue_B',
            properties: {
              memberCount: 0,
              memberEmails: [],
              memberChannels: [],
              queueMembersDeclared: false,
              queueMembersUnparsed: false,
              memberSource: 'user-direct',
              objectTypes: ['Case'],
            },
          }),
          makeNode({
            id: Q_ROLE_STAFFED,
            apiName: 'Queue_C',
            properties: {
              memberCount: 1,
              memberEmails: [],
              memberChannels: [
                { channel: 'roles', memberKind: 'role', memberCount: 1, topologyAsserted: true },
              ],
              queueMembersDeclared: true,
              queueMembersUnparsed: false,
              memberSource: 'role-resolved',
              objectTypes: ['Case'],
            },
          }),
          makeNode({
            id: Q_UNREADABLE,
            apiName: 'Queue_D',
            properties: {
              memberCount: 0,
              memberEmails: [],
              memberChannels: [],
              queueMembersDeclared: true,
              queueMembersUnparsed: true,
              memberSource: 'unknown',
              objectTypes: ['Case'],
            },
          }),
          makeNode({
            id: G_ZERO_DECLARED,
            type: 'Group',
            apiName: 'Group_E',
            properties: { memberCount: 0, emails: [], doesIncludeBosses: true },
          }),
        ],
        edges: [
          // What the Queue extractor really emits per `<queueSobject>`.
          makeEdge({
            fromId: Q_LEGACY_VAULT,
            toId: 'CustomObject:Obj_A__c',
            edgeType: 'sharedWith',
            properties: { relationship: 'queueOwner' },
          }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    hCtx = {
      vaultRoot: hDir,
      manifest: { ...FIXTURE_MANIFEST, sourceTreeHash: 'sha256:fixture-honesty' },
      graph: hStore,
    };
  });

  afterAll(async () => {
    await closeGraph(hStore);
    rmSync(hDir, { recursive: true, force: true });
  });

  it('a queue from a users-only refresh is unknown-membership, not a confirmed empty', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.data.queues.find((x) => x.id === Q_LEGACY_VAULT);
    expect(q).toBeDefined();
    // The defect: 'user-direct' asserts a direct user reference WAS read.
    expect(q?.memberSource).toBe('unknown');
    expect(q?.cleanupVerdict).toBe('unknown-membership');
    expect(q?.memberCountUnknownReason).toBe('queue-member-channels-not-extracted');
    expect(r.value.data.unknownMemberCountQueues).toBeGreaterThanOrEqual(1);
  });

  it('a queue walked across every channel keeps its measured zero', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.data.queues.find((x) => x.id === Q_WALKED_CLEAN);
    expect(q?.memberSource).toBe('user-direct');
    expect(q?.cleanupVerdict).toBe('review-not-delete');
    expect('memberCountUnknownReason' in (q ?? {})).toBe(false);
    // …and the confirmed counter counts THIS one and only this one.
    expect(r.value.data.confirmedEmptyQueues).toBe(1);
  });

  // NOT IN THE BRIEF, same disease, same rows: `objectTypes` was read from a
  // node property no extractor has ever written, so every listed queue said it
  // owns NOTHING. On a cleanup shortlist that reads as extra permission to
  // delete — the queue in the real org owns Cases.
  it('reports the sObjects a queue owns from its sharedWith edges, not an unwritten property', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.data.queues.find((x) => x.id === Q_LEGACY_VAULT);
    expect(q?.objectTypes).toEqual(['Obj_A__c']);
  });

  it('a queue that owns nothing reports an empty objectTypes list', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.data.queues.find((x) => x.id === Q_WALKED_CLEAN);
    expect(q?.objectTypes).toEqual([]);
  });

  it('a role-staffed queue is never listed as empty', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.queues.map((q) => q.id)).not.toContain(Q_ROLE_STAFFED);
  });

  it('an unreadable member block is unknown, never a zero', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.data.queues.find((x) => x.id === Q_UNREADABLE);
    expect(q?.memberSource).toBe('unknown');
    expect(q?.memberCountUnknownReason).toBe('queue-member-block-unreadable');
  });

  it('a group with zero DECLARED members is unknown-membership, not a confirmed empty', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, { type: 'Group' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.value.data.groups.find((x) => x.id === G_ZERO_DECLARED);
    expect(g).toBeDefined();
    expect(g?.memberSource).toBe('unknown');
    expect(g?.cleanupVerdict).toBe('unknown-membership');
    expect(g?.memberCountUnknownReason).toBe('group-membership-not-in-metadata');
    expect(r.value.data.unknownMemberCountGroups).toBe(1);
    expect(r.value.data.confirmedEmptyGroups).toBe(0);
  });

  it('the boundary names the queue gap and tells the reader to re-refresh', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, { type: 'Queue' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/memberChannels/);
    expect(joined).toMatch(/sfi-refresh/);
  });

  it('the boundary says a re-refresh CANNOT populate group membership', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, { type: 'Group' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/GroupMember/);
    expect(joined).toMatch(/live_group_members/);
    // A re-refresh is the WRONG remedy here and the text must not imply it.
    expect(joined).toMatch(/not populate|never emits|cannot be/i);
  });

  it('the confirmed-empty counters exclude every unknown row (the boundary made true)', async () => {
    const r = await emptyQueuesAndGroupsHandler(hCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.confirmedEmptyQueues).toBe(
      d.queues.filter((q) => q.memberSource !== 'unknown').length,
    );
    expect(d.confirmedEmptyGroups).toBe(
      d.groups.filter((g) => g.memberSource !== 'unknown').length,
    );
    expect(d.confirmedEmptyQueues + d.unknownMemberCountQueues).toBe(d.totalQueues);
    expect(d.confirmedEmptyGroups + d.unknownMemberCountGroups).toBe(d.totalGroups);
  });
});
