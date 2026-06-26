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
  findApexUsagesHandler,
  findApexUsagesInputSchema,
} from '../../src/tools/find-apex-usages.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 1,
    CustomField: 1,
    ApexClass: 3,
    ApexTrigger: 1,
    Flow: 1,
  },
  edges: { readsFrom: 2, writesTo: 2, callsApex: 1 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/etc. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Default edge-shape helper. Heuristic apex-scanner source by default. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

// =============================================================================
// Suite 1: mixed-source graph (field target).
//
// Field Industry__c is the target. Three Apex referrers (ApexClass A
// readsFrom, ApexClass B writesTo, ApexTrigger T writesTo) must appear.
// Flow F readsFrom must be filtered out (not Apex). ApexClass A's
// callsApex edge to ApexClass C must also be filtered out — it's an
// edge OUT of A, not IN to the target.
// =============================================================================

const FIELD_ID = 'CustomField:Account.Industry__c';
const APEX_A = 'ApexClass:AlphaService';
const APEX_B = 'ApexClass:BetaService';
const APEX_C = 'ApexClass:GammaService';
const TRIGGER_T = 'ApexTrigger:AccountTrigger';
const FLOW_F = 'Flow:AccountFlow';

const mixedSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: FIELD_ID, type: 'CustomField', apiName: 'Industry__c' }),
    makeNode({ id: APEX_A, type: 'ApexClass', apiName: 'AlphaService' }),
    makeNode({ id: APEX_B, type: 'ApexClass', apiName: 'BetaService' }),
    makeNode({ id: APEX_C, type: 'ApexClass', apiName: 'GammaService' }),
    makeNode({
      id: TRIGGER_T,
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
    }),
    makeNode({ id: FLOW_F, type: 'Flow', apiName: 'AccountFlow' }),
  ],
  edges: [
    // Three Apex usages we must surface.
    makeEdge({
      fromId: APEX_A,
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      properties: { line: 12 },
    }),
    makeEdge({
      fromId: APEX_B,
      toId: FIELD_ID,
      edgeType: 'writesTo',
      properties: { line: 34 },
    }),
    makeEdge({
      fromId: TRIGGER_T,
      toId: FIELD_ID,
      edgeType: 'writesTo',
      properties: { line: 5 },
    }),
    // Flow source — same edgeType set, must be excluded.
    makeEdge({
      fromId: FLOW_F,
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
      confidence: 'parsed',
    }),
    // Unrelated Apex-to-Apex callsApex; both ends are Apex but this
    // edge is OUT of A, not IN to the target field. The handler will
    // not see it because it asks listEdges for direction:'in' on
    // FIELD_ID.
    makeEdge({
      fromId: APEX_A,
      toId: APEX_C,
      edgeType: 'callsApex',
    }),
  ],
};

// =============================================================================
// Suite 2: pure callsApex chain on an ApexClass target.
//
// A second graph where one ApexClass calls another via callsApex.
// Asserts the handler returns the caller when the *target* is an
// ApexClass.
// =============================================================================

const CALLER = 'ApexClass:DelegateCaller';
const CALLEE = 'ApexClass:DelegateCallee';

const callsApexSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: CALLER, type: 'ApexClass', apiName: 'DelegateCaller' }),
    makeNode({ id: CALLEE, type: 'ApexClass', apiName: 'DelegateCallee' }),
  ],
  edges: [
    makeEdge({
      fromId: CALLER,
      toId: CALLEE,
      edgeType: 'callsApex',
      properties: { line: 7 },
    }),
  ],
};

// =============================================================================
// Suite 3: many-referrers field for limit-truncation tests.
//
// Five Apex classes all read from the same field. Used to verify
// stable truncation by id ASC.
// =============================================================================

const CROWDED_FIELD = 'CustomField:Account.Crowded__c';
const CROWDED_REFERRERS = [
  'ApexClass:R01',
  'ApexClass:R02',
  'ApexClass:R03',
  'ApexClass:R04',
  'ApexClass:R05',
];

const crowdedSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: CROWDED_FIELD, type: 'CustomField', apiName: 'Crowded__c' }),
    ...CROWDED_REFERRERS.map((id) =>
      makeNode({
        id,
        type: 'ApexClass',
        apiName: id.replace('ApexClass:', ''),
      }),
    ),
  ],
  edges: CROWDED_REFERRERS.map((id) =>
    makeEdge({ fromId: id, toId: CROWDED_FIELD, edgeType: 'readsFrom' }),
  ),
};

// =============================================================================
// Suite 4: out-of-order ids, single referrer per id, for sort
// determinism. Three Apex classes whose ids are seeded in a
// non-alphabetical order to force the comparator to do real work.
// =============================================================================

const SORT_FIELD = 'CustomField:Account.SortMe__c';
const SORT_REFERRERS = [
  'ApexClass:Zeta',
  'ApexClass:Alpha',
  'ApexClass:Mike',
];

const sortSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: SORT_FIELD, type: 'CustomField', apiName: 'SortMe__c' }),
    ...SORT_REFERRERS.map((id) =>
      makeNode({
        id,
        type: 'ApexClass',
        apiName: id.replace('ApexClass:', ''),
      }),
    ),
  ],
  edges: SORT_REFERRERS.map((id) =>
    makeEdge({ fromId: id, toId: SORT_FIELD, edgeType: 'readsFrom' }),
  ),
};

// One shared graph store + Context across the suite. Vitest's beforeAll
// is enough — all the seeds use distinct ids so there's no cross-test
// interference.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-find-apex-usages-'));
  const dbPath = join(tempDir, 'find-apex-usages.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    mixedSeed,
    callsApexSeed,
    crowdedSeed,
    sortSeed,
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('findApexUsagesHandler', () => {
  it('returns Apex-only referrers and filters out the Flow source', async () => {
    const result = await findApexUsagesHandler(ctx, { targetId: FIELD_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    expect(usages.length).toBe(3);
    // Sorted by id ASC, then edgeType ASC.
    expect(usages.map((u) => [u.id, u.edgeType])).toEqual([
      [APEX_A, 'readsFrom'],
      [APEX_B, 'writesTo'],
      [TRIGGER_T, 'writesTo'],
    ]);
    // Flow node must not appear despite having a readsFrom edge to the
    // same field — that's the Apex-only filter at work.
    expect(usages.map((u) => u.id)).not.toContain(FLOW_F);
    // Sanity on a couple of fields: type carries through from the
    // referrer node, edge metadata from the edge.
    const alpha = usages.find((u) => u.id === APEX_A);
    expect(alpha?.type).toBe('ApexClass');
    expect(alpha?.apiName).toBe('AlphaService');
    expect(alpha?.source).toBe('apex-scanner');
    expect(alpha?.properties).toEqual({ line: 12 });
    // vaultState comes from the manifest, not the edge data.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-27T14:33:08Z');
  });

  it('returns the caller for an ApexClass target via callsApex', async () => {
    const result = await findApexUsagesHandler(ctx, { targetId: CALLEE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    expect(usages.length).toBe(1);
    expect(usages[0]?.id).toBe(CALLER);
    expect(usages[0]?.type).toBe('ApexClass');
    expect(usages[0]?.edgeType).toBe('callsApex');
    expect(usages[0]?.properties).toEqual({ line: 7 });
  });

  it('honors edgeTypes: ["writesTo"] and excludes readsFrom referrers', async () => {
    const result = await findApexUsagesHandler(ctx, {
      targetId: FIELD_ID,
      edgeTypes: ['writesTo'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    expect(usages.length).toBe(2);
    expect(usages.map((u) => u.id)).toEqual([APEX_B, TRIGGER_T]);
    // The readsFrom referrer (APEX_A) must be filtered out.
    expect(usages.map((u) => u.id)).not.toContain(APEX_A);
    for (const u of usages) {
      expect(u.edgeType).toBe('writesTo');
    }
  });

  it('truncates with stable id-ASC ordering when limit is below the referrer count', async () => {
    const result = await findApexUsagesHandler(ctx, {
      targetId: CROWDED_FIELD,
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const usages = result.value.data.usages;
    expect(usages.length).toBe(2);
    // Five referrers (R01..R05); limit=2 keeps the two smallest ids.
    expect(usages.map((u) => u.id)).toEqual([
      'ApexClass:R01',
      'ApexClass:R02',
    ]);
  });

  // CR-13: truncation honesty. A blast-radius tool that silently slices its
  // result at `limit` lets a refactor decision read an undisclosed-incomplete
  // usage list. The page must surface the TRUE total + a truncation note +
  // pagination cursors so the full set is reachable.
  it('discloses the true total, hasMore, and a truncation note when paged below the referrer count', async () => {
    const result = await findApexUsagesHandler(ctx, {
      targetId: CROWDED_FIELD,
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.usages.length).toBe(2);
    // The total is the full pre-slice count, not the page length.
    expect(data.totalCount).toBe(5);
    expect(data.offset).toBe(0);
    expect(data.limit).toBe(2);
    expect(data.hasMore).toBe(true);
    expect(data.nextOffset).toBe(2);
    // A truncation note must appear in boundaries[], naming the true total and
    // disclosing the list is incomplete. The always-on heuristic disclosure
    // stays present.
    const truncationNote = data.boundaries.find((b) => b.includes('INCOMPLETE'));
    expect(truncationNote).toBeDefined();
    expect(truncationNote).toContain('5');
  });

  it('pages the full referrer set via offset (CR-13)', async () => {
    // Page 2: offset 2, limit 2 → R03, R04, still more.
    const page2 = await findApexUsagesHandler(ctx, {
      targetId: CROWDED_FIELD,
      offset: 2,
      limit: 2,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.data.usages.map((u) => u.id)).toEqual([
      'ApexClass:R03',
      'ApexClass:R04',
    ]);
    expect(page2.value.data.totalCount).toBe(5);
    expect(page2.value.data.offset).toBe(2);
    expect(page2.value.data.hasMore).toBe(true);
    expect(page2.value.data.nextOffset).toBe(4);

    // Page 3: offset 4, limit 2 → R05 only, list exhausted.
    const page3 = await findApexUsagesHandler(ctx, {
      targetId: CROWDED_FIELD,
      offset: 4,
      limit: 2,
    });
    expect(page3.ok).toBe(true);
    if (!page3.ok) return;
    expect(page3.value.data.usages.map((u) => u.id)).toEqual(['ApexClass:R05']);
    expect(page3.value.data.totalCount).toBe(5);
    expect(page3.value.data.hasMore).toBe(false);
    expect(page3.value.data.nextOffset).toBe(null);
    // No truncation note on the exhausting page.
    expect(
      page3.value.data.boundaries.find((b) => b.includes('INCOMPLETE')),
    ).toBeUndefined();
  });

  it('leaves the fully-contained case byte-identical: counts present, no truncation note (CR-13 guard)', async () => {
    // CALLEE has exactly one referrer (< default limit). The new fields must be
    // purely additive scalars and the boundaries array must be UNCHANGED from
    // the pre-CR-13 behaviour (heuristic disclosure only, no truncation note).
    const result = await findApexUsagesHandler(ctx, { targetId: CALLEE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.usages.length).toBe(1);
    expect(data.totalCount).toBe(data.usages.length);
    expect(data.offset).toBe(0);
    expect(data.hasMore).toBe(false);
    expect(data.nextOffset).toBe(null);
    // Exactly the always-on heuristic disclosure — no truncation note appended.
    expect(data.boundaries.length).toBe(1);
    expect(
      data.boundaries.find((b) => b.includes('INCOMPLETE')),
    ).toBeUndefined();
  });

  it('returns an empty list for an unknown targetId', async () => {
    const result = await findApexUsagesHandler(ctx, {
      targetId: 'CustomField:Nope.Nope__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usages.length).toBe(0);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('returns an empty list when edgeTypes is explicitly empty', async () => {
    // Per the Spec design choice: empty array means "filter to nothing",
    // not a Zod-level rejection. This keeps the boundary predictable.
    const result = await findApexUsagesHandler(ctx, {
      targetId: FIELD_ID,
      edgeTypes: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.usages.length).toBe(0);
  });

  it('sorts referrers by id ASC even when seeded out of order', async () => {
    const result = await findApexUsagesHandler(ctx, { targetId: SORT_FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.usages.map((u) => u.id);
    expect(ids).toEqual([
      'ApexClass:Alpha',
      'ApexClass:Mike',
      'ApexClass:Zeta',
    ]);
  });
});

describe('findApexUsagesInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = findApexUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts limit at the upper bound (500)', () => {
    const parsed = findApexUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      limit: 500,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects limit greater than 500', () => {
    const parsed = findApexUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      limit: 501,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects limit=0', () => {
    const parsed = findApexUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      limit: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const parsed = findApexUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      limit: 1.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty targetId string', () => {
    const parsed = findApexUsagesInputSchema.safeParse({ targetId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-Apex-emitted edgeType such as "references"', () => {
    const parsed = findApexUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      edgeTypes: ['references'],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the empty edgeTypes array (filter to nothing)', () => {
    const parsed = findApexUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      edgeTypes: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a non-negative offset (CR-13 pagination)', () => {
    const parsed = findApexUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      offset: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a negative offset', () => {
    const parsed = findApexUsagesInputSchema.safeParse({
      targetId: FIELD_ID,
      offset: -1,
    });
    expect(parsed.success).toBe(false);
  });
});
