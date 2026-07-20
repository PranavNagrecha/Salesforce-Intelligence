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
import {
  layoutAssignmentsHandler,
  layoutAssignmentsInputSchema,
} from '../../src/tools/layout-assignments.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: { Layout: 1, Profile: 3 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const LAYOUT = 'Layout:Account.Account Layout';

// Account Layout is assigned by Admin twice (default + Administrative record
// type); Sales assigns a different layout; NoData carries no layoutAssignments.
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    node({ id: LAYOUT, type: 'Layout', apiName: 'Account.Account Layout', label: 'Account Layout' }),
    node({
      id: 'Profile:Admin',
      type: 'Profile',
      apiName: 'Admin',
      properties: {
        layoutAssignments: [
          { layout: 'Account-Account Layout', recordType: null },
          { layout: 'Account-Account Layout', recordType: 'Account.Administrative' },
          { layout: 'Contact-Contact Layout', recordType: null },
        ],
      },
    }),
    node({
      id: 'Profile:Sales',
      type: 'Profile',
      apiName: 'Sales',
      properties: {
        layoutAssignments: [{ layout: 'Account-Partner Account Layout', recordType: 'Account.Partner' }],
      },
    }),
    node({ id: 'Profile:NoData', type: 'Profile', apiName: 'NoData' }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-layout-assignments-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('layoutAssignmentsHandler', () => {
  it('rejects a componentId that is neither Layout: nor CustomObject: with invalid-query', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: 'Flow:Some_Flow' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  // GUARD (L2 alias OS / ADMIN-SURFACE-ALIAS-SKEW-CLUSTER): pre-fix the schema
  // required `componentId` and Zod-STRIPPED `objectApiName` -> `componentId:
  // Required`. Post-fix a natural object alias resolves to the SAME object-mode
  // result as the canonical CustomObject: componentId, with appliedScope echoed.
  it('natural objectApiName ≡ canonical CustomObject componentId (byte-equal + appliedScope)', async () => {
    const run = async (raw: unknown) => {
      const parsed = layoutAssignmentsInputSchema.safeParse(raw);
      if (!parsed.success) return null;
      return layoutAssignmentsHandler(ctx, parsed.data);
    };
    const canonical = await run({ componentId: 'CustomObject:Account' });
    const byObjectApiName = await run({ objectApiName: 'Account' });
    const byObject = await run({ object: 'Account' });
    const byObjectId = await run({ objectId: 'CustomObject:Account' });
    for (const r of [canonical, byObjectApiName, byObject, byObjectId]) {
      expect(r).not.toBeNull();
      expect(r?.ok).toBe(true);
    }
    if (!canonical?.ok || !byObjectApiName?.ok || !byObject?.ok || !byObjectId?.ok) return;
    expect(canonical.value.data.appliedScope).toEqual({
      componentId: 'CustomObject:Account',
      object: 'Account',
    });
    for (const r of [byObjectApiName, byObject, byObjectId]) {
      expect(r.value.data.assignments).toEqual(canonical.value.data.assignments);
      expect(r.value.data.summary).toEqual(canonical.value.data.summary);
      expect(r.value.data.appliedScope).toEqual(canonical.value.data.appliedScope);
    }
  });

  it('layout mode still echoes appliedScope (Layout: componentId + its object)', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: 'Layout:Account.Account Layout' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.mode).toBe('layout');
    expect(r.value.data.appliedScope).toEqual({
      componentId: 'Layout:Account.Account Layout',
      object: 'Account',
    });
  });

  it('disagreeing object aliases → invalid-query', async () => {
    const parsed = layoutAssignmentsInputSchema.safeParse({
      objectApiName: 'Account',
      object: 'Contact',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await layoutAssignmentsHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('a Layout: componentId + an object alias is ambiguous → invalid-query', async () => {
    const parsed = layoutAssignmentsInputSchema.safeParse({
      componentId: 'Layout:Account.Account Layout',
      objectApiName: 'Account',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const r = await layoutAssignmentsHandler(ctx, parsed.data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  // LAYOUT-ASSIGNMENTS-MANGLES-CUSTOMOBJECT-ID: a `CustomObject:` id (the same
  // id `lightning_pages` accepts) must enter OBJECT mode and list assignments
  // across every layout of the object — NOT be mangled into
  // `Layout:CustomObject:Account` (component-not-found). FAILS pre-fix.
  it('accepts a CustomObject: id in object mode and lists the object layout assignments', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.mode).toBe('object');
    expect(d.object).toBe('Account');
    expect(d.layoutId).toBe(null);
    // Two distinct Account layouts carry assignments (Account Layout ×2 + Partner ×1).
    expect(d.layouts).toEqual([
      'Layout:Account.Account Layout',
      'Layout:Account.Partner Account Layout',
    ]);
    expect(d.summary.layouts).toBe(2);
    expect(d.summary.assignments).toBe(3);
    // Every row carries the layout it targets.
    expect(d.assignments.every((a) => typeof a.layoutId === 'string')).toBe(true);
    expect(
      d.assignments.some((a) => a.layoutId === 'Layout:Account.Account Layout'),
    ).toBe(true);
  });

  it('returns component-not-found for an unknown CustomObject id (no bogus Layout:CustomObject mangle)', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: 'CustomObject:Nope__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('returns component-not-found for an unknown layout', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: 'Layout:Account.No Such Layout' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('lists the (profile × record type) assignments targeting the layout', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: LAYOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { assignments, summary, object } = r.value.data;
    expect(object).toBe('Account');
    // Admin assigns it twice (default + Administrative); Sales does not.
    expect(assignments.length).toBe(2);
    expect(assignments.every((a) => a.profileId === 'Profile:Admin')).toBe(true);
    const recordTypes = assignments.map((a) => a.recordType).sort();
    expect(recordTypes).toEqual(['Account.Administrative', null]);
    // The non-null record type carries a canonical RecordType id.
    const rt = assignments.find((a) => a.recordType === 'Account.Administrative');
    expect(rt?.recordTypeId).toBe('RecordType:Account.Administrative');
    const def = assignments.find((a) => a.recordType === null);
    expect(def?.recordTypeId).toBe(null);
    expect(summary.profiles).toBe(1);
    expect(summary.assignments).toBe(2);
  });

  it('paginates the assignment list while keeping the summary complete', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: LAYOUT, limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.assignments.length).toBe(1); // page of 1
    expect(r.value.data.summary.assignments).toBe(2); // full count
    expect(r.value.data.hasMore).toBe(true);
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.boundaryNote).toContain('of 2');
    // Second page returns the rest.
    const r2 = await layoutAssignmentsHandler(ctx, { componentId: LAYOUT, limit: 1, offset: 1 });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.data.assignments.length).toBe(1);
    expect(r2.value.data.hasMore).toBe(false);
  });

  it('discloses the classic-only scope in boundaryNote', async () => {
    const r = await layoutAssignmentsHandler(ctx, { componentId: LAYOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaryNote).toContain('Lightning record pages (FlexiPage)');
    expect(r.value.data.confidence).toBe('declared');
  });
});

// CR-22 B3: the Profile scan now windows past the per-type cap. A profile that
// assigns the layout but sorts PAST a low cap must still be reached (the pre-B3
// scan-tail-unreachable bug), and the output list pages via an opaque cursor.
describe('layoutAssignmentsHandler — full multi-window scan + cursor (CR-22 B3)', () => {
  let b3Dir: string;
  let b3Store: GraphStore;
  let b3Ctx: Context;
  // Three profiles assign the layout; in id-ASC order Z_Late sorts LAST, so a
  // cap of 1 (pre-B3) would never fetch it. Each assigns a distinct record type
  // so the rows are distinct.
  const B3_LAYOUT = 'Layout:Account.Account Layout';

  beforeAll(async () => {
    b3Dir = mkdtempSync(join(tmpdir(), 'sfi-layout-assignments-b3-'));
    const opened = await openGraph(join(b3Dir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    b3Store = opened.value;
    const imported = await importExtractionResults(b3Store, [
      {
        nodes: [
          node({ id: B3_LAYOUT, type: 'Layout', apiName: 'Account.Account Layout', label: 'Account Layout' }),
          node({
            id: 'Profile:A_First',
            type: 'Profile',
            apiName: 'A_First',
            properties: {
              layoutAssignments: [{ layout: 'Account-Account Layout', recordType: 'Account.Alpha' }],
            },
          }),
          node({
            id: 'Profile:M_Mid',
            type: 'Profile',
            apiName: 'M_Mid',
            properties: {
              layoutAssignments: [{ layout: 'Account-Account Layout', recordType: 'Account.Mid' }],
            },
          }),
          node({
            id: 'Profile:Z_Late',
            type: 'Profile',
            apiName: 'Z_Late',
            properties: {
              layoutAssignments: [{ layout: 'Account-Account Layout', recordType: 'Account.Zeta' }],
            },
          }),
        ],
        edges: [],
      } as ExtractionResult,
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    b3Ctx = { vaultRoot: b3Dir, manifest: MANIFEST, graph: b3Store };
  });

  afterAll(async () => {
    await closeGraph(b3Store);
    rmSync(b3Dir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: a cap of 1 still reaches a profile assigning the layout PAST the cap', async () => {
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    try {
      const r = await layoutAssignmentsHandler(b3Ctx, { componentId: B3_LAYOUT, limit: 500 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // All 3 assignments reached even though each window fetched only 1 Profile.
      expect(r.value.data.summary.assignments).toBe(3);
      const profiles = new Set(r.value.data.assignments.map((a) => a.profileId));
      // Z_Late sorts LAST in id ASC — proving the scan reached past window 1.
      expect(profiles.has('Profile:Z_Late')).toBe(true);
      expect(r.value.data.scanTruncated).toBe(false);
      expect(r.value.data.boundaryNote).not.toMatch(/Scan capped/);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });

  it('SFI_NODE_SCAN_LIMIT > 500 no longer hard-errors (RV10-style clamp while touched)', async () => {
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '600';
    try {
      const r = await layoutAssignmentsHandler(b3Ctx, { componentId: B3_LAYOUT });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.summary.assignments).toBe(3);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });

  it('whole-fits no-cursor call omits nextCursor/pageInfo (byte-identical)', async () => {
    const r = await layoutAssignmentsHandler(b3Ctx, { componentId: B3_LAYOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await layoutAssignmentsHandler(b3Ctx, { componentId: B3_LAYOUT, limit: 500 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.assignments.map((a) => `${a.profileId}|${a.recordType ?? ''}`);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await layoutAssignmentsHandler(
        b3Ctx,
        cursor !== undefined
          ? { componentId: B3_LAYOUT, limit: 1, cursor }
          : { componentId: B3_LAYOUT, limit: 1 },
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const a of page.value.data.assignments) seen.push(`${a.profileId}|${a.recordType ?? ''}`);
      if (page.value.data.nextCursor === undefined) break;
      cursor = page.value.data.nextCursor;
      guard += 1;
      if (guard > 20) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

// A vault where the layout exists but NO profile carries layoutAssignments —
// the result must DISCLOSE "not modeled", not a confident empty list.
describe('layoutAssignmentsHandler — extraction gap', () => {
  let gapDir: string;
  let gapStore: GraphStore;
  let gapCtx: Context;

  beforeAll(async () => {
    gapDir = mkdtempSync(join(tmpdir(), 'sfi-layout-assignments-gap-'));
    const opened = await openGraph(join(gapDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    gapStore = opened.value;
    const imported = await importExtractionResults(gapStore, [
      {
        nodes: [
          node({ id: LAYOUT, type: 'Layout', apiName: 'Account.Account Layout' }),
          node({ id: 'Profile:Bare', type: 'Profile', apiName: 'Bare' }),
        ],
        edges: [],
      } as ExtractionResult,
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    gapCtx = { vaultRoot: gapDir, manifest: MANIFEST, graph: gapStore };
  });

  afterAll(async () => {
    await closeGraph(gapStore);
    rmSync(gapDir, { recursive: true, force: true });
  });

  it('discloses the extraction gap when no profile carries layoutAssignments', async () => {
    const r = await layoutAssignmentsHandler(gapCtx, { componentId: LAYOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.assignments.length).toBe(0);
    expect(r.value.data.boundaryNote).toContain('not modeled');
  });
});
