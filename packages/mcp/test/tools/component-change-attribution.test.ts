/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  ATTRIBUTION_DISCLOSURE,
  attributionNeedles,
  componentChangeAttributionHandler,
  componentChangeAttributionInputSchema,
  correlateAuditRows,
  parsePersistedAuditRows,
  SETUP_AUDIT_TRAIL_FILENAME,
} from '../../src/tools/component-change-attribution.js';

/**
 * #39 — sfi.component_change_attribution: offline heuristic correlation
 * against fixture SetupAuditTrail JSONL. No live org; no real customer names.
 */

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-07-12T00:00:00.000Z',
  sourceOrg: 'fixture',
  components: { ValidationRule: 1, ApexClass: 1 },
  edges: {},
  sourceTreeHash: 'sha256:audit39-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'source/main/default/classes/AlphaController.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const trailLines = [
  {
    id: '0Axxx0000001',
    action: 'changedValidation',
    section: 'Validation Rules',
    createdDate: '2026-06-10T10:00:00.000Z',
    display: 'Changed validation rule Status_Required on Account',
    createdByName: 'Fixture Admin',
    capturedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: '0Axxx0000002',
    action: 'changedApexClass',
    section: 'Apex Class',
    createdDate: '2026-06-11T11:00:00.000Z',
    display: 'Changed Apex Class AlphaController',
    createdByName: 'Fixture Admin',
    capturedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: '0Axxx0000003',
    action: 'changedProfile',
    section: 'Profiles',
    createdDate: '2026-06-12T12:00:00.000Z',
    display: 'Changed profile Standard User',
    createdByName: 'Fixture Admin',
    capturedAt: '2026-07-01T00:00:00.000Z',
  },
];

describe('attributionNeedles + correlateAuditRows (pure)', () => {
  it('prefers longer needles (Object.Name before Object)', () => {
    const needles = attributionNeedles({
      apiName: 'Account.Status_Required',
      objectApiName: 'Account',
    });
    expect(needles[0]?.needle).toBe('Account.Status_Required');
    expect(needles.map((n) => n.needle)).toContain('Status_Required');
    expect(needles.map((n) => n.needle)).toContain('Account');
  });

  it('matches Display text heuristically and ranks newest first', () => {
    const rows = parsePersistedAuditRows(trailLines.map((r) => JSON.stringify(r)).join('\n'));
    const needles = attributionNeedles({
      apiName: 'Account.Status_Required',
      objectApiName: 'Account',
    });
    const matched = correlateAuditRows(rows, needles, 10);
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched[0]?.id).toBe('0Axxx0000001');
    expect(matched[0]?.confidence).toBe('heuristic');
    expect(matched[0]?.createdByName).toBe('Fixture Admin');
  });
});

describe('sfi.component_change_attribution', () => {
  let vaultRoot: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    vaultRoot = mkdtempSync(join(tmpdir(), 'sfi-attr-'));
    mkdirSync(join(vaultRoot, 'meta'), { recursive: true });
    writeFileSync(
      join(vaultRoot, 'meta', SETUP_AUDIT_TRAIL_FILENAME),
      trailLines.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );

    const opened = await openGraph(join(vaultRoot, 'graph.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const seed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'ValidationRule:Account.Status_Required',
          type: 'ValidationRule',
          apiName: 'Account.Status_Required',
          sourcePath: 'source/main/default/objects/Account/validationRules/Status_Required.validationRule-meta.xml',
        }),
        makeNode({
          id: 'ApexClass:AlphaController',
          type: 'ApexClass',
          apiName: 'AlphaController',
        }),
        // COMPONENT-CHANGE-ATTRIBUTION-UNRESOLVED-OBJECT-SCOPE: the base
        // object node the `objectApiName`-alone tests below scope by. A real
        // vault retrieves Account's own CustomObject metadata separately from
        // its fields/validation rules — this fixture previously never needed
        // that node, but the object-scope existence check the fix adds now
        // resolves against it.
        makeNode({
          id: 'CustomObject:Account',
          type: 'CustomObject',
          apiName: 'Account',
        }),
      ],
      edges: [],
    };
    const imp = await importExtractionResults(store, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('returns available:false + enable hint when the JSONL is missing', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'sfi-attr-empty-'));
    try {
      const opened = await openGraph(join(emptyRoot, 'graph.db'));
      if (!opened.ok) throw new Error(opened.error.message);
      const emptyStore = opened.value;
      try {
        const emptyCtx: Context = {
          vaultRoot: emptyRoot,
          manifest: FIXTURE_MANIFEST,
          graph: emptyStore,
        };
        // objectApiName path does not require a graph node — isolates the
        // missing-JSONL disposition from component-not-found.
        const r = await componentChangeAttributionHandler(emptyCtx, {
          objectApiName: 'Account',
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.data.available).toBe(false);
        expect(r.value.data.remedy).toContain('--with-audit-trail');
        expect(r.value.data.disclosure).toBe(ATTRIBUTION_DISCLOSURE);
        expect(r.value.data.confidence).toBe('heuristic');
      } finally {
        await closeGraph(emptyStore);
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('correlates a ValidationRule to matching Display text', async () => {
    const r = await componentChangeAttributionHandler(ctx, {
      componentId: 'ValidationRule:Account.Status_Required',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.totalPersisted).toBe(3);
    expect(r.value.data.changes.length).toBeGreaterThanOrEqual(1);
    expect(r.value.data.changes[0]?.action).toBe('changedValidation');
    expect(r.value.data.changes[0]?.confidence).toBe('heuristic');
    expect(r.value.data.disclosure).toContain('HEURISTIC');
    expect(r.value.data.disclosure).toContain('--with-audit-trail');
  });

  it('correlates by objectApiName alone', async () => {
    const r = await componentChangeAttributionHandler(ctx, {
      objectApiName: 'Account',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.changes.some((c) => c.id === '0Axxx0000001')).toBe(true);
  });

  it('fails closed on unknown componentId', async () => {
    const r = await componentChangeAttributionHandler(ctx, {
      componentId: 'ApexClass:DoesNotExist',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  // ===========================================================================
  // COMPONENT-CHANGE-ATTRIBUTION-UNRESOLVED-OBJECT-SCOPE. Pre-fix, an
  // `objectApiName` supplied ALONE (no `componentId`) was handed straight to
  // the heuristic needle-builder with no existence check — a made-up object
  // name silently matched zero SetupAuditTrail rows and came back
  // `{available: true, changes: [], totalMatched: 0}`, an UNCHECKED zero
  // indistinguishable from "this real object has no correlated changes".
  // Fixed by resolving + verifying the CALLER-supplied `objectApiName` via
  // the shared object-scope resolver — but only on the path that actually
  // answers with it (AFTER the missing-JSONL early return, which must stay
  // object-scope-free: see the "missing JSONL" test above, which
  // deliberately proves that disposition needs no graph node at all).
  // ===========================================================================

  it('FAIL-BEFORE/PASS-AFTER: refuses an objectApiName absent from the vault, never a silent empty answer', async () => {
    const r = await componentChangeAttributionHandler(ctx, {
      objectApiName: 'Zzz_Nonexistent_Object_9x7__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/no object named 'Zzz_Nonexistent_Object_9x7__c'/i);
  });

  it('a real object typed in the wrong case still answers, corrected to the vault casing', async () => {
    const lower = await componentChangeAttributionHandler(ctx, { objectApiName: 'account' });
    const exact = await componentChangeAttributionHandler(ctx, { objectApiName: 'Account' });
    expect(lower.ok && exact.ok).toBe(true);
    if (!lower.ok || !exact.ok) return;
    expect(lower.value.data.objectApiName).toBe('Account');
    expect(lower.value.data.changes.map((c) => c.id)).toEqual(
      exact.value.data.changes.map((c) => c.id),
    );
  });

  it('a correctly-cased objectApiName-alone call is unaffected (byte-identical to pre-fix)', async () => {
    const r = await componentChangeAttributionHandler(ctx, { objectApiName: 'Account' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.objectApiName).toBe('Account');
    expect(r.value.data.changes.some((c) => c.id === '0Axxx0000001')).toBe(true);
  });

  it('the missing-JSONL disposition still needs no graph node (object scope is unvalidated on that path)', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'sfi-attr-empty2-'));
    try {
      const opened = await openGraph(join(emptyRoot, 'graph.db'));
      if (!opened.ok) throw new Error(opened.error.message);
      const emptyStore = opened.value;
      try {
        const emptyCtx: Context = {
          vaultRoot: emptyRoot,
          manifest: FIXTURE_MANIFEST,
          graph: emptyStore,
        };
        const r = await componentChangeAttributionHandler(emptyCtx, {
          objectApiName: 'Zzz_Nonexistent_Object_9x7__c',
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.data.available).toBe(false);
      } finally {
        await closeGraph(emptyStore);
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('a componentId-derived objectApiName (no explicit objectApiName) is unaffected', async () => {
    const r = await componentChangeAttributionHandler(ctx, {
      componentId: 'ValidationRule:Account.Status_Required',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objectApiName).toBe('Account');
  });
});

// =============================================================================
// COMPONENT-CHANGE-ATTRIBUTION-CAPPED-TOTAL-NO-RESUME. Pre-fix,
// `correlateAuditRows` stopped AT the cap and the handler published that page
// length as `totalMatched` — the CAPPED count sold as the total, with no
// `truncated` / `nextOffset` / `nextCursor` on the payload and no `offset` /
// `cursor` on the input schema. A component touched 200 times reported
// `totalMatched: 50` beside `totalPersisted: 4000`, with nothing saying it was
// capped and NO call that could reach rows 51-200. That is an under-count of a
// compliance/attribution figure, published confidently.
// Fixed by correlating the FULL match set and paging it through the shared
// `paginateLegacy` continuation protocol (page-cursor.ts).
// =============================================================================

describe('component_change_attribution paging honesty', () => {
  const MATCHING_ROWS = 7;
  let pagedRoot: string;
  let pagedStore: GraphStore;
  let pagedCtx: Context;

  /** `MATCHING_ROWS` rows that all match `Account`, plus 2 that match nothing. */
  const pagedTrail = [
    ...Array.from({ length: MATCHING_ROWS }, (_v, i) => ({
      id: `0Axxxpage${String(i).padStart(4, '0')}`,
      action: 'changedValidation',
      section: 'Validation Rules',
      // Descending dates so the newest-first order is deterministic and the
      // page boundaries are stable.
      createdDate: `2026-06-${String(20 - i).padStart(2, '0')}T10:00:00.000Z`,
      display: `Changed validation rule Rule_${String(i)} on Account`,
      createdByName: 'Fixture Admin',
      capturedAt: '2026-07-01T00:00:00.000Z',
    })),
    {
      id: '0Axxxnoise0001',
      action: 'changedProfile',
      section: 'Profiles',
      createdDate: '2026-06-01T10:00:00.000Z',
      display: 'Changed profile Standard User',
      createdByName: 'Fixture Admin',
      capturedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      id: '0Axxxnoise0002',
      action: 'changedProfile',
      section: 'Profiles',
      createdDate: '2026-06-02T10:00:00.000Z',
      display: 'Changed profile Read Only',
      createdByName: 'Fixture Admin',
      capturedAt: '2026-07-01T00:00:00.000Z',
    },
  ];

  beforeAll(async () => {
    pagedRoot = mkdtempSync(join(tmpdir(), 'sfi-attr-page-'));
    mkdirSync(join(pagedRoot, 'meta'), { recursive: true });
    writeFileSync(
      join(pagedRoot, 'meta', SETUP_AUDIT_TRAIL_FILENAME),
      pagedTrail.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
    const opened = await openGraph(join(pagedRoot, 'graph.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    pagedStore = opened.value;
    const seed: ExtractionResult = {
      nodes: [makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' })],
      edges: [],
    };
    const imp = await importExtractionResults(pagedStore, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    pagedCtx = { vaultRoot: pagedRoot, manifest: FIXTURE_MANIFEST, graph: pagedStore };
  });

  afterAll(async () => {
    await closeGraph(pagedStore);
    rmSync(pagedRoot, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: totalMatched is the TRUE match count, not the page length', async () => {
    const r = await componentChangeAttributionHandler(pagedCtx, {
      objectApiName: 'Account',
      limit: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.changes.length).toBe(3);
    // Pre-fix this was 3 — the cap published as the total.
    expect(r.value.data.totalMatched).toBe(MATCHING_ROWS);
  });

  it('FAIL-BEFORE/PASS-AFTER: a capped page carries truncated + a resume pointer', async () => {
    const r = await componentChangeAttributionHandler(pagedCtx, {
      objectApiName: 'Account',
      limit: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.offset).toBe(0);
    expect(r.value.data.limit).toBe(3);
    expect(r.value.data.nextOffset).toBe(3);
    expect(typeof r.value.data.nextCursor).toBe('string');
    expect(r.value.data.pageInfo?.hasMore).toBe(true);
  });

  it('FAIL-BEFORE/PASS-AFTER: offset paging reaches the tail — no permanently unreachable rows', async () => {
    const seenIds: string[] = [];
    for (const offset of [0, 3, 6]) {
      const r = await componentChangeAttributionHandler(pagedCtx, {
        objectApiName: 'Account',
        limit: 3,
        offset,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      seenIds.push(...r.value.data.changes.map((c) => c.id));
    }
    expect(new Set(seenIds).size).toBe(MATCHING_ROWS);
  });

  it('FAIL-BEFORE/PASS-AFTER: the echoed cursor resumes where the page stopped', async () => {
    const first = await componentChangeAttributionHandler(pagedCtx, {
      objectApiName: 'Account',
      limit: 4,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    const second = await componentChangeAttributionHandler(pagedCtx, {
      objectApiName: 'Account',
      limit: 4,
      cursor: cursor as string,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.data.offset).toBe(4);
    expect(second.value.data.changes.map((c) => c.id)).toEqual(
      pagedTrail.slice(4, MATCHING_ROWS).map((r) => r.id),
    );
    expect(second.value.data.truncated).toBe(false);
    expect(second.value.data.nextCursor).toBeUndefined();
    // The total does not shrink as you walk the pages.
    expect(second.value.data.totalMatched).toBe(MATCHING_ROWS);
  });

  it('a cursor minted for a DIFFERENT query is refused, never silently re-offset', async () => {
    const first = await componentChangeAttributionHandler(pagedCtx, {
      objectApiName: 'Account',
      limit: 3,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor as string;
    const wrong = await componentChangeAttributionHandler(pagedCtx, {
      objectApiName: 'Account',
      limit: 3,
      cursor: `${cursor}tampered`,
    });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.kind).toBe('invalid-query');
  });

  it('a whole-fits page is honest in the other direction: truncated false, no pointer', async () => {
    const r = await componentChangeAttributionHandler(pagedCtx, {
      objectApiName: 'Account',
      limit: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.changes.length).toBe(MATCHING_ROWS);
    expect(r.value.data.totalMatched).toBe(MATCHING_ROWS);
    expect(r.value.data.truncated).toBe(false);
    expect(r.value.data.nextOffset).toBeUndefined();
    expect(r.value.data.nextCursor).toBeUndefined();
  });

  it('the input schema VALIDATES the resume knobs (a non-strict object silently DROPPED them)', () => {
    // Asserting `.success` alone is decoration here: the schema is not
    // `.strict()`, so an unknown `offset` parses fine and is stripped. Assert
    // the PARSED value carries them — that is what the handler reads.
    const parsed = componentChangeAttributionInputSchema.safeParse({
      objectApiName: 'Account',
      limit: 3,
      offset: 3,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.offset).toBe(3);

    const withCursor = componentChangeAttributionInputSchema.safeParse({
      objectApiName: 'Account',
      cursor: 'abc',
    });
    expect(withCursor.success).toBe(true);
    if (!withCursor.success) return;
    expect(withCursor.data.cursor).toBe('abc');

    // …and the range guards still bite.
    expect(
      componentChangeAttributionInputSchema.safeParse({
        objectApiName: 'Account',
        offset: -1,
      }).success,
    ).toBe(false);
  });
});
