/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { orgCardHandler } from '../../src/tools/org-card.js';

/**
 * P13-CARD-tool — `sfi.org_card` is a pure cache read of `meta/org-card.json`:
 * present → the parsed card verbatim; absent → honest `available: false` with
 * the refresh remedy (an old vault is not an error); corrupt → recoverable
 * internal error naming the regeneration step. It never recomputes the card.
 */

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-09T22:00:00.000Z',
  sourceOrg: 'org-card-tool-fixture',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:org-card-tool-fixture',
} as never;

const CARD = {
  generatedAt: '2026-06-09T22:00:00.000Z',
  kind: 'org-card',
  totals: { components: 42, edges: 99 },
  topObjects: [{ id: 'CustomObject:Alpha__c', inboundRefs: 7 }],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-org-card-tool-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  mkdirSync(join(tempDir, 'meta'), { recursive: true });
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('sfi.org_card', () => {
  it('serves the cached card verbatim when present', async () => {
    writeFileSync(join(tempDir, 'meta', 'org-card.json'), JSON.stringify(CARD));
    const r = await orgCardHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.card).toEqual(CARD);
    expect(r.value.vaultState.sourceTreeHash).toBe(FIXTURE_MANIFEST.sourceTreeHash);
  });

  it('returns honest available:false with the refresh remedy when the card is absent', async () => {
    rmSync(join(tempDir, 'meta', 'org-card.json'), { force: true });
    const r = await orgCardHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(false);
    expect(r.value.data.card).toBeUndefined();
    expect(r.value.data.remedy).toContain('refresh');
  });

  it('fails recoverably (with the regeneration step) on corrupt JSON', async () => {
    writeFileSync(join(tempDir, 'meta', 'org-card.json'), '{not json');
    const r = await orgCardHandler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('internal');
    expect(r.error.message).toContain('refresh --no-pull');
  });

  // coverage-aware-zero: the card surfaces automation counts (WorkflowRule /
  // ApprovalProcess). When those families were NOT retrieved, the served card
  // must carry a coverageCaveat so a bare automation 0 is not mistaken for a
  // proven "no legacy automation".
  it('attaches a coverageCaveat when automation families were not retrieved', async () => {
    writeFileSync(join(tempDir, 'meta', 'org-card.json'), JSON.stringify(CARD));
    const covManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
        { type: 'WorkflowRule', requested: true, retrieved: 0, errored: false, neverModeled: false },
        { type: 'ApprovalProcess', requested: true, retrieved: 0, errored: false, neverModeled: false },
      ],
    } as never;
    const r = await orgCardHandler({ ...ctx, manifest: covManifest }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toEqual(
      expect.arrayContaining(['WorkflowRule', 'ApprovalProcess']),
    );
    expect(r.value.data.coverageCaveat?.message).toMatch(/not checked/);
  });

  it('does NOT attach a coverageCaveat when automation families retrieved clean', async () => {
    writeFileSync(join(tempDir, 'meta', 'org-card.json'), JSON.stringify(CARD));
    const covManifest = {
      ...FIXTURE_MANIFEST,
      coverage: [
        { type: 'WorkflowRule', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
        { type: 'ApprovalProcess', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
      ],
    } as never;
    const r = await orgCardHandler({ ...ctx, manifest: covManifest }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });
});

/**
 * CARD-CENSUS-RECONCILIATION — the card is a CACHED artifact rendered at
 * refresh time from `manifest.components`, an allow-list that can (and on a
 * real vault does) go stale. When a family is minted into the graph but never
 * registered in that per-type census, the served card shows NO ROW for it, its
 * `totals.components` is short by that family's size, and the omission appears
 * in NONE of `coverage.partialTypes` / `notModeledTypes` / `erroredTypes`.
 *
 * A host told to "warm the org card first" then reads a card with no row for
 * the family and answers "this org has none" — a confident zero over real,
 * retrieved components. The tool cannot re-render the card (that would forge
 * the refresh-time provenance the card promises), but it CAN reconcile the
 * card's census against the graph it is served beside and say what the card
 * left out. Absence of the reconciliation, or a `checked` it did not earn, is
 * the same certification defect.
 */
describe('sfi.org_card — census reconciliation against the graph', () => {
  let censusDir: string;
  let censusStore: GraphStore;
  let censusCtx: Context;

  const writeCard = (card: unknown): void => {
    writeFileSync(join(censusDir, 'meta', 'org-card.json'), JSON.stringify(card));
  };

  const insertNode = async (id: string, type: string): Promise<void> => {
    await censusStore.connection.run(
      `INSERT INTO nodes (id, type, api_name, label, parent_id, source_path,
         last_modified_date, last_modified_by, api_version, properties_json)
       VALUES ('${id}', '${type}', '${id}', '${id}', NULL, 'x', NULL, NULL, NULL, '{}');`,
    );
  };

  beforeAll(async () => {
    censusDir = mkdtempSync(join(tmpdir(), 'sfi-org-card-census-'));
    const opened = await openGraph(join(censusDir, 'g.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    censusStore = opened.value;
    mkdirSync(join(censusDir, 'meta'), { recursive: true });
    censusCtx = { vaultRoot: censusDir, manifest: FIXTURE_MANIFEST, graph: censusStore };
    // Two modelled families in the graph. `Type_B` stands in for the family the
    // refresh-time census allow-list never registered.
    await insertNode('Type_A:Obj_A__c', 'Type_A');
    await insertNode('Type_A:Obj_B__c', 'Type_A');
    await insertNode('Type_B:Obj_A__c.Alert_A', 'Type_B');
    await insertNode('Type_B:Obj_A__c.Alert_B', 'Type_B');
    await insertNode('Type_B:Obj_A__c.Alert_C', 'Type_B');
  });

  afterAll(async () => {
    await closeGraph(censusStore);
    rmSync(censusDir, { recursive: true, force: true });
  });

  it('names the family the card census dropped entirely, and closes the totals arithmetic', async () => {
    writeCard({
      generatedAt: '2026-06-09T22:00:00.000Z',
      kind: 'org-card',
      totals: { components: 2, edges: 0 },
      componentCounts: { Type_A: 2 },
      coverage: { status: 'partial', partialTypes: [], notModeledTypes: [], erroredTypes: [] },
    });
    const r = await orgCardHandler(censusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec).toBeDefined();
    expect(rec?.checked).toBe(true);
    expect(rec?.typesMissingFromCard).toEqual([{ type: 'Type_B', graphCount: 3 }]);
    expect(rec?.typesMiscountedOnCard).toEqual([]);
    expect(rec?.cardTotalComponents).toBe(2);
    expect(rec?.graphTotalComponents).toBe(5);
    expect(rec?.unreconciledComponents).toBe(3);
    // A host must be told IN PROSE, not only in a field it may not read.
    expect(rec?.message).toContain('Type_B');
    expect(rec?.message).toMatch(/incomplete/i);
  });

  it('flags a per-type count the card disagrees with the graph about', async () => {
    writeCard({
      kind: 'org-card',
      totals: { components: 4, edges: 0 },
      componentCounts: { Type_A: 2, Type_B: 2 },
    });
    const r = await orgCardHandler(censusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec?.checked).toBe(true);
    expect(rec?.typesMissingFromCard).toEqual([]);
    expect(rec?.typesMiscountedOnCard).toEqual([
      { type: 'Type_B', cardCount: 2, graphCount: 3 },
    ]);
  });

  it('certifies a matching census as a CHECKED zero', async () => {
    writeCard({
      kind: 'org-card',
      totals: { components: 5, edges: 0 },
      componentCounts: { Type_A: 2, Type_B: 3 },
    });
    const r = await orgCardHandler(censusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec?.checked).toBe(true);
    expect(rec?.typesMissingFromCard).toEqual([]);
    expect(rec?.typesMiscountedOnCard).toEqual([]);
    expect(rec?.message).toMatch(/reconciled/i);
  });

  // R1: a card with NO componentCounts was never censused. That must NOT read
  // as "censused and clean" — the lists stay null so a machine consumer cannot
  // mistake `[]` for a checked-empty.
  it('does not certify a card that carries no componentCounts at all', async () => {
    writeCard({ kind: 'org-card', totals: { components: 5, edges: 0 } });
    const r = await orgCardHandler(censusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec).toBeDefined();
    expect(rec?.checked).toBe(false);
    expect(rec?.typesMissingFromCard).toBeNull();
    expect(rec?.typesMiscountedOnCard).toBeNull();
    expect(rec?.message).toMatch(/could not/i);
  });

  // A failed census query must degrade to NOT CHECKED, never to a clean bill.
  it('degrades to checked:false when the graph census query fails', async () => {
    writeCard({ kind: 'org-card', totals: { components: 5, edges: 0 }, componentCounts: { Type_A: 2 } });
    const brokenCtx = {
      ...censusCtx,
      graph: {
        ...censusStore,
        connection: {
          runAndReadAll: () => {
            throw new Error('census query failed');
          },
        },
      },
    } as unknown as Context;
    const r = await orgCardHandler(brokenCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec?.checked).toBe(false);
    expect(rec?.typesMissingFromCard).toBeNull();
    expect(rec?.message).toMatch(/could not/i);
  });

  it('reconciles the edge total too', async () => {
    writeCard({
      kind: 'org-card',
      totals: { components: 5, edges: 7 },
      componentCounts: { Type_A: 2, Type_B: 3 },
    });
    const r = await orgCardHandler(censusCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec?.cardTotalEdges).toBe(7);
    expect(rec?.graphTotalEdges).toBe(0);
    expect(rec?.message).toMatch(/edge/i);
  });
});

/**
 * SYMMETRY — the reconciliation exists to stop the card certifying a census it
 * did not earn. A one-directional comparison (graph → card) repeats the defect
 * in the mirror direction: a card that lists a family the graph does not hold,
 * or whose headline `totals.components` does not close, would pass as CLEAN
 * with a prose "every count matches" the code never checked. The manifest
 * allow-list can drift that way too (a renamed graph type, a family registered
 * in the manifest but dropped from the graph, a re-refresh that shrinks the
 * graph), and a host relaying the clean bill would quote a non-zero count over
 * a family with zero nodes.
 */
describe('sfi.org_card — the reconciliation must be symmetric and total-aware', () => {
  let symDir: string;
  let symStore: GraphStore;
  let symCtx: Context;

  const writeCard = (card: unknown): void => {
    writeFileSync(join(symDir, 'meta', 'org-card.json'), JSON.stringify(card));
  };

  const insertNode = async (id: string, type: string): Promise<void> => {
    await symStore.connection.run(
      `INSERT INTO nodes (id, type, api_name, label, parent_id, source_path,
         last_modified_date, last_modified_by, api_version, properties_json)
       VALUES ('${id}', '${type}', '${id}', '${id}', NULL, 'x', NULL, NULL, NULL, '{}');`,
    );
  };

  beforeAll(async () => {
    symDir = mkdtempSync(join(tmpdir(), 'sfi-org-card-symmetry-'));
    const opened = await openGraph(join(symDir, 'g.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    symStore = opened.value;
    mkdirSync(join(symDir, 'meta'), { recursive: true });
    symCtx = { vaultRoot: symDir, manifest: FIXTURE_MANIFEST, graph: symStore };
    await insertNode('Type_A:Obj_A__c', 'Type_A');
    await insertNode('Type_A:Obj_B__c', 'Type_A');
    await insertNode('Type_B:Obj_A__c.Alert_A', 'Type_B');
    await insertNode('Type_B:Obj_A__c.Alert_B', 'Type_B');
    await insertNode('Type_B:Obj_A__c.Alert_C', 'Type_B');
  });

  afterAll(async () => {
    await closeGraph(symStore);
    rmSync(symDir, { recursive: true, force: true });
  });

  it('names a family the CARD lists that the graph does not hold', async () => {
    writeCard({
      kind: 'org-card',
      totals: { components: 104, edges: 0 },
      componentCounts: { Type_A: 2, Type_B: 3, Type_Z: 99 },
    });
    const r = await orgCardHandler(symCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec?.checked).toBe(true);
    expect(rec?.typesOnCardNotInGraph).toEqual([{ type: 'Type_Z', cardCount: 99 }]);
    // The prose must name it: a host that reads only the message must not be
    // told the census checks out over a card that over-counts by 99.
    expect(rec?.message).toContain('Type_Z');
    expect(rec?.message).not.toMatch(/every count matches/i);
  });

  it('refuses a clean bill when the per-type rows match but totals.components does not close', async () => {
    writeCard({
      kind: 'org-card',
      totals: { components: 104, edges: 0 },
      componentCounts: { Type_A: 2, Type_B: 3 },
    });
    const r = await orgCardHandler(symCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec?.checked).toBe(true);
    // The clean-branch prose must not contradict the field beside it.
    expect(rec?.message).not.toMatch(/every count matches/i);
    expect(rec?.message).toContain('104');
    expect(rec?.message).toContain('99');
    expect(rec?.typesMissingFromCard).toEqual([]);
    expect(rec?.typesMiscountedOnCard).toEqual([]);
    expect(rec?.typesOnCardNotInGraph).toEqual([]);
    expect(rec?.unreconciledComponents).toBe(-99);
  });

  it('reports a MALFORMED card count as unreadable, not as a missing row', async () => {
    writeCard({
      kind: 'org-card',
      totals: { components: 5, edges: 0 },
      componentCounts: { Type_A: 2, Type_B: '3' },
    });
    const r = await orgCardHandler(symCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec?.checked).toBe(true);
    // The row EXISTS on the card; saying it is absent points at the wrong remedy.
    expect(rec?.typesMissingFromCard).toEqual([]);
    expect(rec?.typesWithUnreadableCardCount).toEqual(['Type_B']);
    expect(rec?.message).toContain('Type_B');
    expect(rec?.message).toMatch(/unreadable/i);
    expect(rec?.message).not.toMatch(/NO row on the card/);
  });

  it('still certifies a genuinely symmetric, total-closing census', async () => {
    writeCard({
      kind: 'org-card',
      totals: { components: 5, edges: 0 },
      componentCounts: { Type_A: 2, Type_B: 3 },
    });
    const r = await orgCardHandler(symCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec?.checked).toBe(true);
    expect(rec?.typesOnCardNotInGraph).toEqual([]);
    expect(rec?.typesWithUnreadableCardCount).toEqual([]);
    expect(rec?.unreconciledComponents).toBe(0);
    expect(rec?.message).toMatch(/every count matches/i);
  });

  it('nulls the new lists too when the comparison did not run', async () => {
    writeCard({ kind: 'org-card', totals: { components: 5, edges: 0 } });
    const r = await orgCardHandler(symCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.value.data.censusReconciliation;
    expect(rec?.checked).toBe(false);
    expect(rec?.typesOnCardNotInGraph).toBeNull();
    expect(rec?.typesWithUnreadableCardCount).toBeNull();
  });
});
