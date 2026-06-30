/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
  listComponentsHandler,
  listComponentsInputSchema,
} from '../../src/tools/list-components.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, CustomField: 7 },
  edges: { parentOf: 7 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: 'Account',
  parentId: null,
  sourcePath: 'objects/Account/Account.object-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

// Seven CustomFields across two parents lets us exercise pagination
// (limit < total), parent narrowing, and the hasMore signal in a single
// fixture.
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      apiName: 'Account',
      label: 'Account',
    }),
    makeNode({
      id: 'CustomObject:Opportunity',
      apiName: 'Opportunity',
      label: 'Opportunity',
    }),
    makeNode({
      id: 'CustomField:Account.AlphaField__c',
      type: 'CustomField',
      apiName: 'AlphaField__c',
      label: 'Alpha',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/AlphaField__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Account.BetaField__c',
      type: 'CustomField',
      apiName: 'BetaField__c',
      label: 'Beta',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/BetaField__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Account.GammaField__c',
      type: 'CustomField',
      apiName: 'GammaField__c',
      label: 'Gamma',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/GammaField__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Account.DeltaField__c',
      type: 'CustomField',
      apiName: 'DeltaField__c',
      label: 'Delta',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/DeltaField__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Account.EpsilonField__c',
      type: 'CustomField',
      apiName: 'EpsilonField__c',
      label: 'Epsilon',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/EpsilonField__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Opportunity.Stage__c',
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: 'CustomObject:Opportunity',
      sourcePath: 'objects/Opportunity/fields/Stage__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Opportunity.CloseDate__c',
      type: 'CustomField',
      apiName: 'CloseDate__c',
      label: 'CloseDate',
      parentId: 'CustomObject:Opportunity',
      sourcePath: 'objects/Opportunity/fields/CloseDate__c.field-meta.xml',
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-list-components-'));
  const dbPath = join(tempDir, 'list-components.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
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

describe('listComponentsHandler', () => {
  it('returns the CustomField nodes for the seed', async () => {
    const result = await listComponentsHandler(ctx, { type: 'CustomField' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.components.length).toBe(7);
    // listNodesByType sorts ascending by id, so every entry is a Node and
    // the first comes from the Account parent (alphabetically first).
    expect(result.value.data.components[0]!.id).toBe(
      'CustomField:Account.AlphaField__c',
    );
    expect(result.value.data.components[0]!.type).toBe('CustomField');
    expect(result.value.data.limit).toBe(50);
    expect(result.value.data.offset).toBe(0);
    // Seven fields fit comfortably under the default limit, so no further
    // page is implied.
    expect(result.value.data.hasMore).toBe(false);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-27T14:33:08Z');
  });

  it('paginates results when limit and offset are provided', async () => {
    const firstPage = await listComponentsHandler(ctx, {
      type: 'CustomField',
      limit: 2,
      offset: 0,
    });
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.value.data.components.length).toBe(2);
    expect(firstPage.value.data.limit).toBe(2);
    expect(firstPage.value.data.offset).toBe(0);
    const firstIds = firstPage.value.data.components.map((n) => n.id);

    const secondPage = await listComponentsHandler(ctx, {
      type: 'CustomField',
      limit: 2,
      offset: 2,
    });
    expect(secondPage.ok).toBe(true);
    if (!secondPage.ok) return;
    expect(secondPage.value.data.components.length).toBe(2);
    expect(secondPage.value.data.offset).toBe(2);
    const secondIds = secondPage.value.data.components.map((n) => n.id);

    // Pages must not overlap, proving the offset is honored.
    for (const id of secondIds) {
      expect(firstIds).not.toContain(id);
    }
  });

  it('narrows results to a single parent when parentId is provided', async () => {
    const result = await listComponentsHandler(ctx, {
      type: 'CustomField',
      parentId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Five fields under Account; none of the Opportunity ones must leak.
    expect(result.value.data.components.length).toBe(5);
    for (const node of result.value.data.components) {
      expect(node.parentId).toBe('CustomObject:Account');
    }
  });

  it('returns invalid-query at the Zod boundary for an unknown component type', async () => {
    // dispatchTool would normally Zod-parse before calling the handler;
    // exercising the boundary directly keeps the test focused on this
    // tool's contract.
    const parsed = listComponentsInputSchema.safeParse({ type: 'InvalidType' });
    expect(parsed.success).toBe(false);
  });

  it('returns invalid-query when the type argument is absent', async () => {
    const result = await listComponentsHandler(ctx, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toMatch(/type is required/);
  });

  it('signals hasMore=true while a full page is returned and hasMore=false on the tail page', async () => {
    // Page size 5 against 7 rows: first page is full → hasMore true; second
    // page returns 2 < 5 → hasMore false. The hint matches the iteration
    // contract documented on `ListComponentsOutput`.
    const fullPage = await listComponentsHandler(ctx, {
      type: 'CustomField',
      limit: 5,
      offset: 0,
    });
    expect(fullPage.ok).toBe(true);
    if (!fullPage.ok) return;
    expect(fullPage.value.data.components.length).toBe(5);
    expect(fullPage.value.data.hasMore).toBe(true);

    const tailPage = await listComponentsHandler(ctx, {
      type: 'CustomField',
      limit: 5,
      offset: 5,
    });
    expect(tailPage.ok).toBe(true);
    if (!tailPage.ok) return;
    expect(tailPage.value.data.components.length).toBe(2);
    expect(tailPage.value.data.hasMore).toBe(false);
  });
});

describe('listComponentsHandler retrievalHint (FRESH-02)', () => {
  // The seed has no StaticResource / Report / Dashboard nodes, so each query
  // returns an empty first page — the coverage block decides which honest hint.
  const COVERAGE_MANIFEST = {
    ...FIXTURE_MANIFEST,
    coverage: [
      // requested but retrieve pulled nothing → "not retrieved / not checked"
      // (C2: byte-identical to "confirmed none in org", so the honest reading
      // is "not retrieved" — never silently "none in the org").
      { type: 'StaticResource', requested: true, retrieved: 0, errored: false, neverModeled: false },
      // a scoped refresh never pulled this type → "not retrieved"
      { type: 'Report', requested: false, retrieved: 0, errored: false, neverModeled: false },
      // no extractor for this type → "not modeled / not analyzed"
      { type: 'Dashboard', requested: false, retrieved: 0, errored: false, neverModeled: true },
    ],
  };

  it('does not claim "none in the org" for standard-object field lists', async () => {
    const covCtx: Context = {
      ...ctx,
      manifest: {
        ...COVERAGE_MANIFEST,
        coverage: [
          { type: 'CustomField', requested: true, retrieved: 100, errored: false, neverModeled: false },
        ],
      },
    };
    const r = await listComponentsHandler(covCtx, {
      type: 'CustomField',
      parentId: 'CustomObject:Case',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.retrievalHint).toContain('NOT proof');
    expect(r.value.data.retrievalHint).not.toContain('none in the org');
  });

  it('says "not retrieved — /sfi-refresh" (NOT "none in the org") when a requested type retrieved zero rows (C2)', async () => {
    // C2 / Systemic #1: requested + retrieved:0 is byte-identical to "the org
    // genuinely has none of this type", so list_components must NOT assert
    // "retrieved X and found none — this is none in the org". The coverage fix
    // routes the requested-but-empty type into missingCoverage, so the honest
    // "did not pull this type, run /sfi-refresh" hint fires instead. (Used to
    // assert the bug: retrievalHint contained "none in the org".)
    const covCtx: Context = { ...ctx, manifest: COVERAGE_MANIFEST };
    const r = await listComponentsHandler(covCtx, { type: 'StaticResource' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components).toHaveLength(0);
    expect(r.value.data.retrievalHint).not.toContain('none in the org');
    expect(r.value.data.retrievalHint).toContain('/sfi-refresh');
    expect(r.value.data.retrievalHint).toContain('did not pull');
  });

  it('says "not retrieved — /sfi-refresh" when a scoped refresh skipped the type', async () => {
    const covCtx: Context = { ...ctx, manifest: COVERAGE_MANIFEST };
    const r = await listComponentsHandler(covCtx, { type: 'Report' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.retrievalHint).toContain('/sfi-refresh');
    expect(r.value.data.retrievalHint).toContain('did not pull');
  });

  it('says "not modeled" when the type has no extractor', async () => {
    const covCtx: Context = { ...ctx, manifest: COVERAGE_MANIFEST };
    const r = await listComponentsHandler(covCtx, { type: 'Dashboard' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.retrievalHint).toContain('NOT modeled');
  });

  it('omits the hint when the page is non-empty', async () => {
    const r = await listComponentsHandler(ctx, { type: 'CustomField' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components.length).toBeGreaterThan(0);
    expect(r.value.data.retrievalHint).toBeUndefined();
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('attaches coverageCaveat on a non-empty page when the type was not requested', async () => {
    const covCtx: Context = {
      ...ctx,
      manifest: {
        ...FIXTURE_MANIFEST,
        coverage: [
          {
            type: 'CustomField',
            requested: false,
            retrieved: 7,
            errored: false,
            neverModeled: false,
          },
        ],
      },
    };
    const r = await listComponentsHandler(covCtx, { type: 'CustomField' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components.length).toBeGreaterThan(0);
    expect(r.value.data.coverageCaveat?.status).toBe('partial');
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain('CustomField');
    expect(r.value.data.coverageCaveat?.message).toContain('not checked');
  });

  it('attaches coverageCaveat on empty not-requested pages alongside retrievalHint', async () => {
    const covCtx: Context = { ...ctx, manifest: COVERAGE_MANIFEST };
    const r = await listComponentsHandler(covCtx, { type: 'Report' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.retrievalHint).toContain('/sfi-refresh');
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain('Report');
  });
});

describe('listComponentsHandler formula-field classification', () => {
  // A formula field encodes its RETURN type in <type> (Text/Currency here), NOT
  // the literal 'Formula'. The extractor flags it with properties.isFormula=true;
  // list_components surfaces the TRUE count so a caller never concludes "No
  // Formula fields were found" by grouping on dataType alone.
  let fDir: string;
  let fStore: GraphStore;
  let fCtx: Context;

  const fSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'CustomObject:Payment__c', apiName: 'Payment__c', label: 'Payment' }),
      // Two formula fields whose <type> is the RETURN type, not 'Formula'.
      makeNode({
        id: 'CustomField:Payment__c.Clock_Number__c',
        type: 'CustomField',
        apiName: 'Clock_Number__c',
        label: 'Clock Number',
        parentId: 'CustomObject:Payment__c',
        properties: { dataType: 'Text', formula: 'TEXT(Seq__c)', isFormula: true },
      }),
      makeNode({
        id: 'CustomField:Payment__c.Net__c',
        type: 'CustomField',
        apiName: 'Net__c',
        label: 'Net',
        parentId: 'CustomObject:Payment__c',
        properties: { dataType: 'Currency', formula: 'Gross__c - Tax__c', isFormula: true },
      }),
      // One stored field — no isFormula key (OMIT-when-false).
      makeNode({
        id: 'CustomField:Payment__c.Amount__c',
        type: 'CustomField',
        apiName: 'Amount__c',
        label: 'Amount',
        parentId: 'CustomObject:Payment__c',
        properties: { dataType: 'Currency' },
      }),
    ],
    edges: [],
  };

  beforeAll(async () => {
    fDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-list-formula-'));
    const opened = await openGraph(join(fDir, 'formula.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    fStore = opened.value;
    const imported = await importExtractionResults(fStore, [fSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    fCtx = { vaultRoot: fDir, manifest: FIXTURE_MANIFEST, graph: fStore };
  });

  afterAll(async () => {
    await closeGraph(fStore);
    rmSync(fDir, { recursive: true, force: true });
  });

  it('reports the TRUE formulaFieldCount across the whole CustomField type', async () => {
    const r = await listComponentsHandler(fCtx, { type: 'CustomField' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Three fields total, two of them formula — and the count must NOT be zero,
    // which is the symptom of "No Formula fields were found".
    expect(r.value.data.formulaFieldCount).toBe(2);
  });

  it('scopes formulaFieldCount to a parentId narrow', async () => {
    const r = await listComponentsHandler(fCtx, {
      type: 'CustomField',
      parentId: 'CustomObject:Payment__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.formulaFieldCount).toBe(2);
  });

  it('counts formula fields independent of pagination (page size 1)', async () => {
    // The count is a COUNT(*), not a per-page tally, so a tiny page still
    // reports the full formula total.
    const r = await listComponentsHandler(fCtx, { type: 'CustomField', limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components.length).toBe(1);
    expect(r.value.data.formulaFieldCount).toBe(2);
  });

  it('omits formulaFieldCount for non-CustomField types', async () => {
    const r = await listComponentsHandler(fCtx, { type: 'CustomObject' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.formulaFieldCount).toBeUndefined();
  });
});

// =============================================================================
// CR-22 — single-axis continuation cursor. list_components pages
// listNodesByType DIRECTLY by SQL OFFSET, so `o` already IS the SQL offset (it
// natively reaches node 501+); no separate scan axis. A truncated page emits an
// opaque nextCursor + a TRUE total (countNodesByType); a whole-fits final page
// is byte-identical.
// =============================================================================
describe('listComponentsHandler — continuation cursor (CR-22)', () => {
  it('a final page (hasMore=false) omits nextCursor/pageInfo (byte-identical)', async () => {
    // All 7 CustomFields fit in one default page → hasMore is false → no cursor.
    const r = await listComponentsHandler(ctx, { type: 'CustomField' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.hasMore).toBe(false);
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
  });

  it('a truncated page emits a cursor + TRUE total and resumes with no gaps or dupes', async () => {
    const all = await listComponentsHandler(ctx, { type: 'CustomField', limit: 500 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.components.map((c) => c.id);
    expect(fullOrder.length).toBe(7);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await listComponentsHandler(
        ctx,
        cursor !== undefined ? { type: 'CustomField', limit: 2, cursor } : { type: 'CustomField', limit: 2 },
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const c of page.value.data.components) seen.push(c.id);
      // pageInfo (when present) carries the TRUE total of 7, not a capped length.
      if (page.value.data.pageInfo !== undefined) {
        expect(page.value.data.pageInfo.totalCount).toBe(7);
      }
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 20) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('TRUE total respects a parentId narrow (countNodesByType filtered)', async () => {
    // Account has 5 CustomFields; a limit of 2 truncates and the pageInfo total
    // must be the FILTERED 5, not the whole-type 7.
    const r = await listComponentsHandler(ctx, {
      type: 'CustomField',
      parentId: 'CustomObject:Account',
      limit: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.hasMore).toBe(true);
    expect(r.value.data.pageInfo?.totalCount).toBe(5);
  });

  it('rejects a cursor minted for a DIFFERENT type (argsFingerprint bind)', async () => {
    const first = await listComponentsHandler(ctx, { type: 'CustomField', limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    const replay = await listComponentsHandler(ctx, { type: 'CustomObject', cursor });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a cursor minted for a DIFFERENT parentId (argsFingerprint bind)', async () => {
    const first = await listComponentsHandler(ctx, {
      type: 'CustomField',
      parentId: 'CustomObject:Account',
      limit: 2,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    if (typeof cursor !== 'string') return;
    const replay = await listComponentsHandler(ctx, {
      type: 'CustomField',
      parentId: 'CustomObject:Opportunity',
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});

describe('listComponentsInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = listComponentsInputSchema.safeParse({ type: 'CustomField' });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty object (handler enforces the type requirement)', () => {
    // Zod itself does not reject this — the handler emits the
    // `invalid-query` envelope. Splitting the validation lets the schema
    // stay reusable for a v0.2 list-all mode.
    const parsed = listComponentsInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('accepts CompactLayout (v4.x decomposed child metadata)', () => {
    const parsed = listComponentsInputSchema.safeParse({ type: 'CompactLayout' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown component type', () => {
    const parsed = listComponentsInputSchema.safeParse({ type: 'Bogus' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty parentId string', () => {
    const parsed = listComponentsInputSchema.safeParse({
      type: 'CustomField',
      parentId: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit greater than 500', () => {
    const parsed = listComponentsInputSchema.safeParse({
      type: 'CustomField',
      limit: 501,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const parsed = listComponentsInputSchema.safeParse({
      type: 'CustomField',
      limit: 2.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative offset', () => {
    const parsed = listComponentsInputSchema.safeParse({
      type: 'CustomField',
      offset: -1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('listComponentsHandler: ApexClass boolean filters (P4-interface-impl)', () => {
  let dir2: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-listcomp-bool-'));
    const opened = await openGraph(join(dir2, 'lc.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    const apex = (name: string, props: Record<string, unknown>): Node =>
      makeNode({ id: `ApexClass:${name}`, type: 'ApexClass', apiName: name, properties: props });
    const imported = await importExtractionResults(store2, [
      {
        nodes: [
          apex('BillingBatch', { isBatchable: true }),
          apex('SyncQueueable', { isQueueable: true }),
          apex('NightlyJob', { isSchedulable: true, isBatchable: true }),
          apex('PlainService', {}),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx2 = { vaultRoot: dir2, manifest: FIXTURE_MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('lists only Batchable implementers when isBatchable:true', async () => {
    const result = await listComponentsHandler(ctx2, {
      type: 'ApexClass',
      isBatchable: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.components.map((c) => c.id).sort()).toEqual([
      'ApexClass:BillingBatch',
      'ApexClass:NightlyJob',
    ]);
  });

  it('ANDs filters: isSchedulable + isBatchable', async () => {
    const result = await listComponentsHandler(ctx2, {
      type: 'ApexClass',
      isSchedulable: true,
      isBatchable: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.components.map((c) => c.id)).toEqual([
      'ApexClass:NightlyJob',
    ]);
  });

  it('an empty filtered result has NO coverage retrievalHint (not a coverage gap)', async () => {
    const result = await listComponentsHandler(ctx2, {
      type: 'ApexClass',
      isRestResource: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.components).toEqual([]);
    expect(result.value.data.retrievalHint).toBeUndefined();
  });

  it('coerces a stringified boolean filter (host sends "true") — found via live MCP testing', () => {
    // MCP hosts frequently stringify scalar args, especially when a client's
    // cached tool schema predates the new param. The schema must coerce.
    const parsed = listComponentsInputSchema.safeParse({
      type: 'ApexClass',
      isBatchable: 'true',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.isBatchable).toBe(true);
    const parsedFalse = listComponentsInputSchema.safeParse({
      type: 'ApexClass',
      isBatchable: 'false',
    });
    expect(parsedFalse.success).toBe(true);
    if (parsedFalse.success) expect(parsedFalse.data.isBatchable).toBe(false);
  });

  it('still rejects a non-true/false string', () => {
    const parsed = listComponentsInputSchema.safeParse({
      type: 'ApexClass',
      isBatchable: 'yes',
    });
    expect(parsed.success).toBe(false);
  });
});
