/// <reference types="vitest/globals" />

/**
 * Unit tests for the PURE core of `sfi.permission_set_consolidation`.
 *
 * Every input here is a SYNTHETIC `Map<psId, Set<grantKey>>` — no vault, no
 * DuckDB, no org identifiers (only placeholder `PS_*` names + generic
 * `Account` / `Contact` keys). The core (`computeConsolidationCore` /
 * `rankCandidates`) and the cursor invariant (`packToByteBudget`) are exercised
 * directly, which is the whole point of factoring them out of the handler: the
 * subset / near-duplicate / empty classification, the ranking, and the
 * page-cursor honesty are testable without any I/O.
 *
 * Coverage:
 *   - A ⊆ B detected as a strict subset (and NOT double-reported as near-dup);
 *   - two identical grant sets → a near-duplicate (not a strict subset);
 *   - disjoint grant sets → neither;
 *   - an empty grant set is flagged;
 *   - a high-overlap pair that is NOT a strict subset is a near-duplicate;
 *   - a strict subset with high Jaccard stays a subset (exclusive of near-dup);
 *   - the unified candidate list ranks by consolidation opportunity;
 *   - the page cursor equals the served count on a budget-trimmed page.
 */

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

import type { Context } from '../src/server.js';
import { packToByteBudget } from '../src/tools/limit-headroom-report.js';
import {
  compileGrantKeys,
  computeConsolidationCore,
  permissionSetConsolidationHandler,
  rankCandidates,
  DEFAULT_MIN_OVERLAP,
  type ConsolidationCandidate,
} from '../src/tools/permission-set-consolidation.js';

const grants = (
  entries: Record<string, readonly string[]>,
): Map<string, ReadonlySet<string>> => {
  const m = new Map<string, ReadonlySet<string>>();
  for (const [id, keys] of Object.entries(entries)) m.set(id, new Set(keys));
  return m;
};

const sizesOf = (
  sets: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> => {
  const m = new Map<string, number>();
  for (const [id, s] of sets) m.set(id, s.size);
  return m;
};

describe('permission_set_consolidation pure core', () => {
  it('detects A ⊆ B as a strict subset (A the merge-away candidate)', () => {
    const sets = grants({
      'PermissionSet:PS_Sub': ['obj:Account:read'],
      'PermissionSet:PS_Super': ['obj:Account:read', 'obj:Account:edit'],
    });
    const core = computeConsolidationCore(sets, DEFAULT_MIN_OVERLAP);
    expect(core.empty).toEqual([]);
    expect(core.nearDuplicateClusters).toEqual([]);
    expect(core.subsetPairs).toHaveLength(1);
    expect(core.subsetPairs[0]?.subsetId).toBe('PermissionSet:PS_Sub');
    expect(core.subsetPairs[0]?.supersetId).toBe('PermissionSet:PS_Super');
    expect(core.subsetPairs[0]?.subsetGrantCount).toBe(1);
    expect(core.subsetPairs[0]?.supersetGrantCount).toBe(2);
  });

  it('classifies two identical grant sets as a near-duplicate, not a subset', () => {
    const shared = ['obj:Account:read', 'obj:Account:edit', 'sys:ExportReport'];
    const sets = grants({
      'PermissionSet:PS_A': shared,
      'PermissionSet:PS_B': shared,
    });
    const core = computeConsolidationCore(sets, DEFAULT_MIN_OVERLAP);
    expect(core.subsetPairs).toEqual([]);
    expect(core.empty).toEqual([]);
    expect(core.nearDuplicateClusters).toHaveLength(1);
    const cluster = core.nearDuplicateClusters[0];
    expect(cluster?.members).toEqual(['PermissionSet:PS_A', 'PermissionSet:PS_B']);
    expect(cluster?.pairs).toHaveLength(1);
    expect(cluster?.pairs[0]?.identical).toBe(true);
    expect(cluster?.pairs[0]?.jaccard).toBe(1);
  });

  it('reports disjoint grant sets as neither subset nor near-duplicate', () => {
    const sets = grants({
      'PermissionSet:PS_Sales': ['obj:Account:read'],
      'PermissionSet:PS_Support': ['obj:Case:edit'],
    });
    const core = computeConsolidationCore(sets, DEFAULT_MIN_OVERLAP);
    expect(core.subsetPairs).toEqual([]);
    expect(core.nearDuplicateClusters).toEqual([]);
    expect(core.empty).toEqual([]);
  });

  it('flags a permission set with no grants as empty', () => {
    const sets = grants({
      'PermissionSet:PS_Empty': [],
      'PermissionSet:PS_Has': ['obj:Account:read'],
    });
    const core = computeConsolidationCore(sets, DEFAULT_MIN_OVERLAP);
    expect(core.empty).toEqual(['PermissionSet:PS_Empty']);
    // The empty set is NEVER entered into the pairwise sweep (∅ ⊆ everything is
    // not a useful merge signal).
    expect(core.subsetPairs).toEqual([]);
    expect(core.nearDuplicateClusters).toEqual([]);
  });

  it('classifies a high-overlap non-subset pair as a near-duplicate', () => {
    // 9 shared + 1 unique each: |∩| = 9, |∪| = 11, Jaccard = 9/11 ≈ 0.818.
    const shared = Array.from({ length: 9 }, (_, i) => `fls:Account.F${i}__c:read`);
    const sets = grants({
      'PermissionSet:PS_X': [...shared, 'fls:Account.OnlyX__c:read'],
      'PermissionSet:PS_Y': [...shared, 'fls:Account.OnlyY__c:read'],
    });
    const core = computeConsolidationCore(sets, 0.8);
    expect(core.subsetPairs).toEqual([]);
    expect(core.nearDuplicateClusters).toHaveLength(1);
    const pair = core.nearDuplicateClusters[0]?.pairs[0];
    expect(pair?.identical).toBe(false);
    expect(pair?.intersectionCount).toBe(9);
    expect(pair?.unionCount).toBe(11);
    expect(pair?.jaccard).toBeCloseTo(0.818, 2);
    // Below threshold → NOT a near-duplicate.
    const strict = computeConsolidationCore(sets, 0.9);
    expect(strict.nearDuplicateClusters).toEqual([]);
  });

  it('keeps a strict subset with high Jaccard classified as a subset, not near-dup', () => {
    // A = 9 keys ⊊ B = 10 keys (all of A in B). Jaccard = 9/10 = 0.9.
    const nine = Array.from({ length: 9 }, (_, i) => `obj:Obj${i}__c:read`);
    const sets = grants({
      'PermissionSet:PS_Nine': nine,
      'PermissionSet:PS_Ten': [...nine, 'obj:Extra__c:read'],
    });
    const core = computeConsolidationCore(sets, 0.9);
    expect(core.nearDuplicateClusters).toEqual([]);
    expect(core.subsetPairs).toHaveLength(1);
    expect(core.subsetPairs[0]?.subsetId).toBe('PermissionSet:PS_Nine');
    expect(core.subsetPairs[0]?.jaccard).toBe(0.9);
  });

  it('ranks the unified candidate list by consolidation opportunity', () => {
    const sets = grants({
      // Big subset win: 5-grant PS ⊊ 6-grant PS (opportunity 5).
      'PermissionSet:PS_BigSub': ['a', 'b', 'c', 'd', 'e'],
      'PermissionSet:PS_BigSuper': ['a', 'b', 'c', 'd', 'e', 'f'],
      // Small subset win: 1-grant PS ⊊ 2-grant PS (opportunity 1).
      'PermissionSet:PS_SmallSub': ['x'],
      'PermissionSet:PS_SmallSuper': ['x', 'y'],
      // Empty (opportunity 0).
      'PermissionSet:PS_Empty': [],
    });
    const core = computeConsolidationCore(sets, DEFAULT_MIN_OVERLAP);
    const candidates = rankCandidates(core, sizesOf(sets), new Set(), true);
    expect(candidates[0]?.kind).toBe('strict-subset');
    expect(candidates[0]?.opportunity).toBe(5);
    // Empty ranks last.
    const last = candidates[candidates.length - 1];
    expect(last?.kind).toBe('empty');
    expect(last?.opportunity).toBe(0);
    // includeEmpty:false drops the empty candidate.
    const noEmpty = rankCandidates(core, sizesOf(sets), new Set(), false);
    expect(noEmpty.some((c) => c.kind === 'empty')).toBe(false);
  });

  it('decorates candidates with grant count + PermissionSetGroup membership', () => {
    const sets = grants({
      'PermissionSet:PS_Sub': ['obj:Account:read'],
      'PermissionSet:PS_Super': ['obj:Account:read', 'obj:Account:edit'],
    });
    const core = computeConsolidationCore(sets, DEFAULT_MIN_OVERLAP);
    const candidates = rankCandidates(
      core,
      sizesOf(sets),
      new Set(['PermissionSet:PS_Sub']),
      true,
    );
    const subset = candidates.find(
      (c): c is Extract<ConsolidationCandidate, { kind: 'strict-subset' }> =>
        c.kind === 'strict-subset',
    );
    expect(subset?.subset.inPermissionSetGroup).toBe(true);
    expect(subset?.superset.inPermissionSetGroup).toBe(false);
    expect(subset?.subset.grantCount).toBe(1);
  });

  it('cursor equals served count on a budget-trimmed page (no dropped candidate)', () => {
    // Build many strict-subset candidates so the ranked list has length > 1.
    const entries: Record<string, readonly string[]> = {};
    for (let i = 0; i < 12; i += 1) {
      entries[`PermissionSet:PS_Sub_${i}`] = [`obj:Obj${i}__c:read`];
      entries[`PermissionSet:PS_Super_${i}`] = [`obj:Obj${i}__c:read`, `obj:Obj${i}__c:edit`];
    }
    const sets = grants(entries);
    const core = computeConsolidationCore(sets, DEFAULT_MIN_OVERLAP);
    const candidates = rankCandidates(core, sizesOf(sets), new Set(), true);
    expect(candidates.length).toBeGreaterThan(3);

    // A tiny byte budget forces a trim below the requested limit.
    const offset = 0;
    const limit = candidates.length;
    const packed = packToByteBudget(
      candidates,
      offset,
      limit,
      200, // small budget → byte-trimmed
      (c) => Buffer.byteLength(JSON.stringify(c), 'utf8') + 1,
    );
    // The cursor NEVER overstates the advance.
    expect(packed.nextOffset).toBe(offset + packed.page.length);
    expect(packed.byteTrimmed).toBe(true);
    expect(packed.truncated).toBe(true);
    expect(packed.page.length).toBeLessThan(candidates.length);

    // Walking the cursor drops NO candidate and never repeats one.
    const walked: ConsolidationCandidate[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const pageResult = packToByteBudget(
        candidates,
        cursor,
        limit,
        200,
        (c) => Buffer.byteLength(JSON.stringify(c), 'utf8') + 1,
      );
      walked.push(...pageResult.page);
      expect(pageResult.nextOffset).toBe(cursor + pageResult.page.length);
      cursor = pageResult.nextOffset;
      if (!pageResult.truncated) break;
    }
    expect(walked).toEqual([...candidates]);
  });
});

describe('permission_set_consolidation grant-key compilation', () => {
  it('compiles a compact grant-key set from node properties + grantedBy edges', () => {
    const node = {
      id: 'PermissionSet:PS_Sales',
      type: 'PermissionSet',
      apiName: 'PS_Sales',
      label: 'PS Sales',
      parentId: null,
      sourcePath: 'permissionsets/PS_Sales.permissionset-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        userPermissions: ['ExportReport', 'RunReports'],
        recordTypeVisibilities: [
          { recordType: 'Account.Business', default: false, visible: true },
          { recordType: 'Account.Person', default: false, visible: false }, // hidden → no key
        ],
        applicationVisibilities: [{ application: 'Sales', default: false, visible: true }],
        tabVisibilities: [
          { tab: 'Account', visibility: 'Visible' },
          { tab: 'Report', visibility: 'None' }, // None → no key
        ],
      },
    } as const;
    const edges = [
      {
        fromId: 'PermissionSet:PS_Sales',
        toId: 'CustomObject:Account',
        edgeType: 'grantedBy',
        confidence: 'declared',
        source: 'permission-set-extractor',
        properties: { allowRead: true, allowEdit: true, allowCreate: false },
      },
      {
        fromId: 'PermissionSet:PS_Sales',
        toId: 'CustomField:Account.Name',
        edgeType: 'grantedBy',
        confidence: 'declared',
        source: 'permission-set-extractor',
        properties: { readable: true, editable: false },
      },
      {
        fromId: 'PermissionSet:PS_Sales',
        toId: 'ApexClass:AccountService',
        edgeType: 'grantedBy',
        confidence: 'declared',
        source: 'permission-set-extractor',
        properties: { enabled: true },
      },
    ] as const;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keys = compileGrantKeys(node as any, edges as any);
    expect([...keys].sort()).toEqual(
      [
        'apex:AccountService',
        'app:Sales',
        'fls:Account.Name:read',
        'obj:Account:edit',
        'obj:Account:read',
        'rt:Account.Business',
        'sys:ExportReport',
        'sys:RunReports',
        'tab:Account:Visible',
      ].sort(),
    );
  });
});

/**
 * R6 — the handler's self-fit target must be the DERIVED tool-local budget
 * (`toolLocalPayloadBudgetBytes()`), never a hard-coded sibling of the
 * default global budget. A fixture large enough to comfortably fit the
 * DEFAULT budget but not a tightened `SFI_MAX_RESPONSE_BYTES` override proves
 * whether the self-fit actually reacts to the override.
 */
describe('permission_set_consolidation handler — response-budget target (R6)', () => {
  const PAIR_COUNT = 30;

  const FIXTURE_MANIFEST: VaultManifest = {
    version: '0.2.0',
    refreshedAt: '2026-06-01T10:00:00Z',
    sourceOrg: 'me@example.com',
    components: { PermissionSet: PAIR_COUNT * 2 },
    edges: {},
    sourceTreeHash: 'sha256:permission-set-consolidation-budget-fixture',
  };

  const makeNode = (id: string, perms: readonly string[]): Node => ({
    id: id as Node['id'],
    type: 'PermissionSet',
    apiName: id.slice('PermissionSet:'.length),
    label: null,
    parentId: null,
    sourcePath: `permissionsets/${id.slice('PermissionSet:'.length)}.permissionset-meta.xml`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: { userPermissions: perms },
  });

  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-psc-budget-'));
    const nodes: Node[] = [];
    for (let i = 0; i < PAIR_COUNT; i += 1) {
      // Padded so each candidate serializes to a non-trivial size: a
      // 30-candidate page is comfortably under the 36 KB default target but
      // nowhere near fitting a tightened few-KB override.
      const base = `Perm_${String(i).padStart(3, '0')}_${'x'.repeat(40)}`;
      nodes.push(makeNode(`PermissionSet:PS_Sub_${i}`, [base]));
      nodes.push(makeNode(`PermissionSet:PS_Super_${i}`, [base, `${base}_extra`]));
    }
    const seed: ExtractionResult = { nodes, edges: [] };
    const opened = await openGraph(join(tempDir, 'psc-budget.db'));
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

  it('fits all candidates under the DEFAULT budget (baseline, not byte-trimmed)', async () => {
    const r = await permissionSetConsolidationHandler(ctx, { limit: 100 });
    if (!r.ok) throw new Error(`handler failed: ${r.error.kind} ${r.error.message}`);
    expect(r.value.data.candidates.length).toBe(PAIR_COUNT);
    expect(r.value.data.byteTrimmed).toBeUndefined();
  });

  it('FAIL-BEFORE/PASS-AFTER: a tightened SFI_MAX_RESPONSE_BYTES must actually change the self-fit page', async () => {
    const previous = process.env['SFI_MAX_RESPONSE_BYTES'];
    const under = async (override: string): Promise<{ length: number; byteTrimmed: boolean | undefined }> => {
      process.env['SFI_MAX_RESPONSE_BYTES'] = override;
      const r = await permissionSetConsolidationHandler(ctx, { limit: 100 });
      if (!r.ok) throw new Error(`handler failed: ${r.error.kind} ${r.error.message}`);
      return { length: r.value.data.candidates.length, byteTrimmed: r.value.data.byteTrimmed };
    };
    try {
      // SMALL is derived (toolLocalPayloadBudgetBytes()) to sit far below
      // what 30 padded candidates need; LARGE is derived to comfortably fit
      // all of them. A self-fit that actually reacts to the override must
      // serve fewer candidates (and mark byteTrimmed) under SMALL than under
      // LARGE. A self-fit still targeting the OLD hard-coded 36 000 constant
      // ignores both overrides and serves the identical untrimmed page for
      // each, so this differential is exactly what a hard-coded target gets
      // wrong regardless of which two override values are chosen.
      const small = await under('4000');
      const large = await under('44000');

      expect(large.length).toBe(PAIR_COUNT);
      expect(large.byteTrimmed).toBeUndefined();
      expect(small.length).toBeLessThan(large.length);
      expect(small.byteTrimmed).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
      else process.env['SFI_MAX_RESPONSE_BYTES'] = previous;
    }
  });
});
