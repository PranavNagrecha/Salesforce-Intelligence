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
    // B-GRAPH-BUILD: totalCount is always present at the top level and must
    // equal the true graph count, not components.length (which is bounded by
    // limit and byte-budget trimming).
    expect(result.value.data.totalCount).toBe(7);
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
    // B-GRAPH-BUILD: totalCount must be 7 on every page, regardless of how
    // many rows this page contains.
    expect(fullPage.value.data.totalCount).toBe(7);

    const tailPage = await listComponentsHandler(ctx, {
      type: 'CustomField',
      limit: 5,
      offset: 5,
    });
    expect(tailPage.ok).toBe(true);
    if (!tailPage.ok) return;
    expect(tailPage.value.data.components.length).toBe(2);
    expect(tailPage.value.data.hasMore).toBe(false);
    // totalCount stays 7 on the tail page too.
    expect(tailPage.value.data.totalCount).toBe(7);
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

// =============================================================================
// LIST-COMPONENTS-CERTIFIED-ZERO-CONTRADICTED-BY-OWN-GRAPH.
//
// Same shared fact `unusedComponentsHandler` reads via
// `referencedButAbsentFamilies` (`../../src/tools/referenced-but-absent.js`),
// exercised here through list_components's own org-wide "none in the org"
// branch. Measured on a real production vault: a folder-scoped metadata
// family with 0 nodes, while the vault's own `declared`/`parsed` edges (from
// other retrieved components) name specific members of it that were never
// retrieved. Before this fix, `list_components` certified that as "none in
// the org" — the exact sentence `unused_components` and `coverage_report`
// were independently found to disagree with on the same vault, same run.
// =============================================================================
describe('listComponentsHandler — a certified zero its own graph contradicts', () => {
  const REFERENCED_ABSENT_A = 'EmailTemplate:Folder_A/Template_B';
  const REFERENCED_ABSENT_B = 'EmailTemplate:Folder_A/Template_C';
  const ALERT_A = 'WorkflowAlert:Obj_A__c.Alert_D';
  const APPROVAL_A = 'ApprovalProcess:Obj_A__c.Approval_E';
  const PHANTOM_TARGET = 'GlobalValueSet:Phantom_G';
  const PHANTOM_SOURCE = 'ApexClass:Scanner_H';

  const makeDanglingNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
    type: 'ApexClass',
    apiName: 'Unused',
    label: null,
    parentId: null,
    sourcePath: 'unused.cls',
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

  /** EmailTemplate/GlobalValueSet/Letterhead all read "requested, confirmed
   *  clean, zero members" — the exact upstream fact the org-wide "none in the
   *  org" branch is built on. Letterhead has no dangling referrer at all, so
   *  it is the control: a genuinely confirmed-empty type must read unchanged. */
  const confirmedCleanManifest: VaultManifest = {
    ...FIXTURE_MANIFEST,
    coverage: [
      {
        type: 'EmailTemplate',
        requested: true,
        retrieved: 0,
        retrieveConfirmed: true,
        errored: false,
        neverModeled: false,
      },
      {
        type: 'GlobalValueSet',
        requested: true,
        retrieved: 0,
        retrieveConfirmed: true,
        errored: false,
        neverModeled: false,
      },
      {
        type: 'Letterhead',
        requested: true,
        retrieved: 0,
        retrieveConfirmed: true,
        errored: false,
        neverModeled: false,
      },
    ],
  };

  let danglingDir: string;
  let danglingStore: GraphStore;
  let danglingCtx: Context;

  beforeAll(async () => {
    danglingDir = mkdtempSync(join(tmpdir(), 'sfi-list-components-dangling-'));
    const opened = await openGraph(join(danglingDir, 'dangling.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    danglingStore = opened.value;
    const imported = await importExtractionResults(danglingStore, [
      {
        nodes: [
          // NO EmailTemplate node exists. These are the referrers that name
          // templates the refresh never brought back.
          makeDanglingNode({ id: ALERT_A, type: 'WorkflowAlert', apiName: 'Obj_A__c.Alert_D' }),
          makeDanglingNode({
            id: APPROVAL_A,
            type: 'ApprovalProcess',
            apiName: 'Obj_A__c.Approval_E',
          }),
          makeDanglingNode({ id: PHANTOM_SOURCE, type: 'ApexClass', apiName: 'Scanner_H' }),
        ],
        edges: [
          makeEdge({ fromId: ALERT_A, toId: REFERENCED_ABSENT_A, edgeType: 'references' }),
          makeEdge({ fromId: APPROVAL_A, toId: REFERENCED_ABSENT_A, edgeType: 'sendsEmail' }),
          makeEdge({ fromId: APPROVAL_A, toId: REFERENCED_ABSENT_B, edgeType: 'references' }),
          // A HEURISTIC scanner phantom at a wholly-absent family — must NOT
          // be strong enough to unseat a checked zero (same rule
          // `unused_components` enforces via CONTRADICTING_CONFIDENCE).
          makeEdge({
            fromId: PHANTOM_SOURCE,
            toId: PHANTOM_TARGET,
            edgeType: 'references',
            confidence: 'heuristic',
          }),
        ],
      },
    ]);
    if (!imported.ok) throw new Error('importExtractionResults failed');
    danglingCtx = {
      vaultRoot: danglingDir,
      manifest: confirmedCleanManifest,
      graph: danglingStore,
    };
  });

  afterAll(async () => {
    await closeGraph(danglingStore);
    rmSync(danglingDir, { recursive: true, force: true });
  });

  it('does NOT certify "none in the org" for a family its own edges name members of', async () => {
    const r = await listComponentsHandler(danglingCtx, { type: 'EmailTemplate' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components).toEqual([]);
    expect(r.value.data.retrievalHint).toBeDefined();
    // Neither sentence a reader of the old bug saw may survive.
    expect(r.value.data.retrievalHint).not.toContain('this is "none in the org"');
    // The contradiction is quantified and named as NOT CHECKED, matching the
    // fact `unused_components` reports for the identical fixture shape.
    expect(r.value.data.retrievalHint).toContain('NOT CHECKED');
    expect(r.value.data.retrievalHint).toContain('3 declared/parsed reference edge(s)');
    expect(r.value.data.retrievalHint).toContain('retrieve_blindspot_report');
  });

  it('a heuristic-only dangling reference does NOT unseat a confirmed-empty zero', async () => {
    const r = await listComponentsHandler(danglingCtx, { type: 'GlobalValueSet' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.retrievalHint).toContain('this is "none in the org"');
  });

  it('leaves a genuinely confirmed-empty type unchanged when nothing dangles at it', async () => {
    const r = await listComponentsHandler(danglingCtx, { type: 'Letterhead' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.retrievalHint).toBe(
      'The last refresh retrieved `Letterhead` and found none — this is "none in the org", not "not retrieved".',
    );
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

// =============================================================================
// B-GRAPH-BUILD — totalCount is the authoritative vault count regardless of
// payload trimming. Reproduces the FlexiPage 39-of-86 scenario: nodes with
// large `properties` blobs exhaust the 38 KB byte budget before the full page
// is returned, so `components.length` < `limit` < true total. A cascade that
// reads `components.length` for a count answer reports the wrong number;
// `totalCount` (from `countNodesByType`) must always be correct.
// =============================================================================
describe('listComponentsHandler — B-GRAPH-BUILD totalCount beats byte-budget trim', () => {
  let bDir: string;
  let bStore: GraphStore;
  let bCtx: Context;

  // Generate a node whose serialized JSON is guaranteed to exceed 1 KB so that
  // a page of 50 of them easily exceeds the 38 KB budget.
  const makeLargeNode = (n: number): Node =>
    makeNode({
      id: `FlexiPage:Page${String(n).padStart(3, '0')}__c`,
      type: 'FlexiPage',
      apiName: `Page${String(n).padStart(3, '0')}__c`,
      label: `FlexiPage ${n}`,
      sourcePath: `flexipages/Page${n}.flexipage-meta.xml`,
      properties: {
        // Simulate the `fieldRefs` array that makes real FlexiPage nodes large:
        // each entry is ~40 bytes; 30 entries ≈ 1.2 KB per node, so 50 nodes ≈
        // 60 KB — well above the 38 KB LIST_PAYLOAD_BUDGET_BYTES guard.
        fieldRefs: Array.from({ length: 30 }, (_, i) => `CustomField:SObject__c.Field${i}__c`),
        description: `Auto-generated FlexiPage fixture number ${n} for B-GRAPH-BUILD budget-trim test.`,
      },
    });

  beforeAll(async () => {
    bDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-flexipage-budget-'));
    const opened = await openGraph(join(bDir, 'budget.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    bStore = opened.value;
    // Seed 86 large FlexiPage nodes — reproduces the 39-of-86 count loss
    // reported in B-GRAPH-BUILD.
    const nodes = Array.from({ length: 86 }, (_, i) => makeLargeNode(i + 1));
    const imported = await importExtractionResults(bStore, [{ nodes, edges: [] }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    bCtx = { vaultRoot: bDir, manifest: FIXTURE_MANIFEST, graph: bStore };
  });

  afterAll(async () => {
    await closeGraph(bStore);
    rmSync(bDir, { recursive: true, force: true });
  });

  it('totalCount is 86 even when budget trimming stops components at fewer than limit (B-GRAPH-BUILD)', async () => {
    // default limit=50, but large nodes exhaust the 38 KB budget before 50
    // nodes are serialized — components.length < 50. The legacy approach of
    // reading components.length for a count answer reports the wrong number.
    const r = await listComponentsHandler(bCtx, { type: 'FlexiPage' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The byte budget must have kicked in: fewer nodes than the default limit.
    expect(r.value.data.components.length).toBeLessThan(50);
    // truncated=true confirms the budget guard trimmed the page.
    expect(r.value.data.truncated).toBe(true);
    // hasMore=true because the page was trimmed (more nodes remain).
    expect(r.value.data.hasMore).toBe(true);
    // THE KEY ASSERTION: totalCount must be the TRUE vault count from
    // countNodesByType, not the trimmed components.length.
    expect(r.value.data.totalCount).toBe(86);
    // The truncation note must reference the correct totalCount.
    expect(r.value.data.note).toContain('86');
  });

  it('totalCount stays 86 on page 2 (post-trim cursor resume) — count is never lost mid-pagination', async () => {
    const page1 = await listComponentsHandler(bCtx, { type: 'FlexiPage', limit: 10 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.data.totalCount).toBe(86);

    const page2 = await listComponentsHandler(bCtx, { type: 'FlexiPage', limit: 10, offset: 10 });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.data.totalCount).toBe(86);
  });
});

// =============================================================================
// Per-item slimming — grant-heavy rows must not exhaust the page budget.
// Reproduces the Profile "1 of 59" bug: each Profile node carries ~37 KB of
// declarative grants in `properties`, LIST_PAYLOAD_BUDGET_BYTES is 38 KB, and
// `fitNodesToBudget` measures the FULL node — so each page held exactly ONE
// profile. Slimming oversized rows to scalar properties (marked
// `propertiesTruncated: true`) must let the whole inventory fit one page,
// while small nodes pass through byte-identical.
// =============================================================================
describe('listComponentsHandler — oversized rows are slimmed, not budget-starved (Profile 1-of-59)', () => {
  let pDir: string;
  let pStore: GraphStore;
  let pCtx: Context;

  // Generate a Profile node whose serialized JSON is ~37 KB — matching the
  // real-vault measurement that reproduced the 1-of-59 bug. The bulk is a
  // `fieldPermissions` array (the grant dump slimming must drop); the scalar
  // props (`custom`, `userLicense`) are what slimming must preserve.
  const makeGrantHeavyProfile = (n: number): Node =>
    makeNode({
      id: `Profile:Fixture_Profile_${String(n).padStart(3, '0')}`,
      type: 'Profile',
      apiName: `Fixture_Profile_${String(n).padStart(3, '0')}`,
      label: `Fixture Profile ${n}`,
      sourcePath: `profiles/Fixture_Profile_${n}.profile-meta.xml`,
      properties: {
        custom: true,
        userLicense: 'Salesforce',
        // ~600 grant entries × ~62 bytes each ≈ 37 KB — one node alone nearly
        // fills the whole 38 KB LIST_PAYLOAD_BUDGET_BYTES page budget.
        fieldPermissions: Array.from({ length: 600 }, (_, i) => ({
          field: `Obj${i % 40}__c.Field${String(i).padStart(3, '0')}__c`,
          readable: true,
          editable: i % 2 === 0,
        })),
      },
    });

  // A small node (a few hundred bytes) that must pass through UNTOUCHED —
  // no slimming, no `propertiesTruncated` key.
  const smallObjectNode = makeNode({
    id: 'CustomObject:SmallFixture__c',
    apiName: 'SmallFixture__c',
    label: 'Small Fixture',
    sourcePath: 'objects/SmallFixture__c/SmallFixture__c.object-meta.xml',
    properties: { sharingModel: 'ReadWrite', deploymentStatus: 'Deployed' },
  });

  beforeAll(async () => {
    pDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-profile-slim-'));
    const opened = await openGraph(join(pDir, 'slim.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    pStore = opened.value;
    // Seed 59 grant-heavy Profile nodes — the exact shape of the 1-of-59 bug —
    // plus one small CustomObject to prove small rows are untouched.
    const nodes = [
      ...Array.from({ length: 59 }, (_, i) => makeGrantHeavyProfile(i + 1)),
      smallObjectNode,
    ];
    const imported = await importExtractionResults(pStore, [{ nodes, edges: [] }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    pCtx = { vaultRoot: pDir, manifest: FIXTURE_MANIFEST, graph: pStore };
  });

  afterAll(async () => {
    await closeGraph(pStore);
    rmSync(pDir, { recursive: true, force: true });
  });

  it('returns ALL 59 grant-heavy profiles on one page, each slimmed to scalar properties', async () => {
    const r = await listComponentsHandler(pCtx, { type: 'Profile', limit: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // THE KEY ASSERTION: the whole inventory fits one page (pre-fix: 1 of 59).
    expect(r.value.data.components).toHaveLength(59);
    expect(r.value.data.totalCount).toBe(59);
    expect(r.value.data.hasMore).toBe(false);
    // The top-level flag tells the caller detail was slimmed page-wide.
    expect(r.value.data.propertiesSlimmed).toBe(true);
    for (const node of r.value.data.components) {
      // Every slimmed row is marked, keeps its scalar props, and drops the
      // bulky grant dump.
      expect(node.properties['propertiesTruncated']).toBe(true);
      expect(node.properties['custom']).toBe(true);
      expect(node.properties['userLicense']).toBe('Salesforce');
      expect(node.properties['fieldPermissions']).toBeUndefined();
    }
  });

  it('small nodes pass through untouched — no slimming, no propertiesTruncated key', async () => {
    const r = await listComponentsHandler(pCtx, { type: 'CustomObject' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components).toHaveLength(1);
    const node = r.value.data.components[0] as Node;
    // Properties are returned exactly as seeded — no marker key injected.
    expect(node.properties).toEqual({
      sharingModel: 'ReadWrite',
      deploymentStatus: 'Deployed',
    });
    expect('propertiesTruncated' in node.properties).toBe(false);
    // And the top-level flag is ABSENT (not `false`) when nothing was slimmed.
    expect('propertiesSlimmed' in r.value.data).toBe(false);
  });
});

describe('listComponentsHandler: Flow property filters', () => {
  let dir3: string;
  let store3: GraphStore;
  let ctx3: Context;

  beforeAll(async () => {
    dir3 = mkdtempSync(join(tmpdir(), 'sfi-mcp-listcomp-flow-'));
    const opened = await openGraph(join(dir3, 'lc.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store3 = opened.value;
    const imported = await importExtractionResults(store3, [
      {
        nodes: [
          makeNode({
            id: 'Flow:RT_App_Active',
            type: 'Flow',
            apiName: 'RT_App_Active',
            label: 'RT App Active',
            properties: {
              status: 'Active',
              triggerObject: 'hed__Application__c',
              triggerType: 'RecordAfterSave',
            },
          }),
          makeNode({
            id: 'Flow:RT_App_Draft',
            type: 'Flow',
            apiName: 'RT_App_Draft',
            label: 'RT App Draft',
            properties: {
              status: 'Draft',
              triggerObject: 'hed__Application__c',
              triggerType: 'RecordAfterSave',
            },
          }),
          makeNode({
            id: 'Flow:RT_Case_Active',
            type: 'Flow',
            apiName: 'RT_Case_Active',
            label: 'RT Case Active',
            properties: {
              status: 'Active',
              triggerObject: 'Case',
              triggerType: 'RecordAfterSave',
            },
          }),
          makeNode({
            id: 'Flow:Screen_App',
            type: 'Flow',
            apiName: 'Screen_App',
            label: 'Screen App',
            properties: {
              status: 'Active',
              triggerObject: 'hed__Application__c',
              triggerType: 'Screen',
            },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx3 = { vaultRoot: dir3, manifest: FIXTURE_MANIFEST, graph: store3 };
  });

  afterAll(async () => {
    await closeGraph(store3);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('filters flows by triggerObject, status, and recordTriggered', async () => {
    const r = await listComponentsHandler(ctx3, {
      type: 'Flow',
      triggerObject: 'hed__Application__c',
      status: 'Active',
      recordTriggered: true,
      limit: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(1);
    expect(r.value.data.components.map((n) => n.id)).toEqual(['Flow:RT_App_Active']);
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

describe('listComponentsHandler — description-presence filter', () => {
  // Report fixture: one WITH a description, two WITHOUT (a JSON-null variant and
  // a key-omitted variant) — the two enterprise/custom "none present" shapes.
  const descSeed: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'Report:HasDesc',
        type: 'Report',
        apiName: 'HasDesc',
        label: 'Has Desc',
        sourcePath: 'reports/HasDesc.report-meta.xml',
        properties: { description: 'A documented report.' },
      }),
      makeNode({
        id: 'Report:NullDesc',
        type: 'Report',
        apiName: 'NullDesc',
        label: 'Null Desc',
        sourcePath: 'reports/NullDesc.report-meta.xml',
        properties: { description: null },
      }),
      makeNode({
        id: 'Report:NoDescKey',
        type: 'Report',
        apiName: 'NoDescKey',
        label: 'No Desc Key',
        sourcePath: 'reports/NoDescKey.report-meta.xml',
        properties: { rawReferenceCount: 0 },
      }),
    ],
    edges: [],
  };

  let descDir: string;
  let descStore: GraphStore;
  let descCtx: Context;

  beforeAll(async () => {
    descDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-list-desc-'));
    const opened = await openGraph(join(descDir, 'desc.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    descStore = opened.value;
    const imported = await importExtractionResults(descStore, [descSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    descCtx = {
      vaultRoot: descDir,
      manifest: { ...FIXTURE_MANIFEST, components: { Report: 3 } },
      graph: descStore,
    };
  });

  afterAll(async () => {
    await closeGraph(descStore);
    rmSync(descDir, { recursive: true, force: true });
  });

  it('missingDescription:true returns the two undescribed reports; totalCount is the count', async () => {
    const r = await listComponentsHandler(descCtx, {
      type: 'Report',
      missingDescription: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components.map((n) => n.id)).toEqual([
      'Report:NoDescKey',
      'Report:NullDesc',
    ]);
    expect(r.value.data.totalCount).toBe(2);
  });

  it('hasDescription:true returns only the documented report', async () => {
    const r = await listComponentsHandler(descCtx, {
      type: 'Report',
      hasDescription: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components.map((n) => n.id)).toEqual(['Report:HasDesc']);
    expect(r.value.data.totalCount).toBe(1);
  });

  it('missing + has counts sum to the unfiltered type total', async () => {
    const missing = await listComponentsHandler(descCtx, {
      type: 'Report',
      missingDescription: true,
    });
    const has = await listComponentsHandler(descCtx, { type: 'Report', hasDescription: true });
    const all = await listComponentsHandler(descCtx, { type: 'Report' });
    expect(missing.ok && has.ok && all.ok).toBe(true);
    if (!missing.ok || !has.ok || !all.ok) return;
    expect(missing.value.data.totalCount + has.value.data.totalCount).toBe(
      all.value.data.totalCount,
    );
  });

  it('rejects the contradiction of both missingDescription and hasDescription', async () => {
    const r = await listComponentsHandler(descCtx, {
      type: 'Report',
      missingDescription: true,
      hasDescription: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('an empty description-filtered page does not emit a coverage retrievalHint', async () => {
    // Every report HAS a description-key state, so a `hasDescription` filter that
    // matches nothing (e.g. after excluding the only documented one) must read
    // as "no match", not a coverage gap. Use a filter guaranteed to be empty by
    // querying a type with no nodes but requesting the description filter.
    const r = await listComponentsHandler(descCtx, {
      type: 'Dashboard',
      missingDescription: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components).toHaveLength(0);
    // FRESH-02 retrievalHint is suppressed under a description filter.
    expect(r.value.data.retrievalHint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LIST-COMPONENTS-PENDING-READ-AS-NEVER-PULLED
//
// A `pending` coverage row means requested + retrieved + not turned into nodes:
// the default reports pull is usage-ranked and capped, and what it reads is
// FOLDED onto CustomField nodes (`usedInReport`) rather than minted as `Report`
// nodes. That row is (correctly) folded into `missingCoverage`, so an empty
// `Report` page fell into the generic branch and told the user the refresh
// "did not pull this type" and to widen `--types` — on a vault whose own
// manifest recorded hundreds of reports landed, and whose field tools answer
// `usedInReport: true` off exactly that pull. Both halves of the sentence were
// false, and `--types` is not even the lever (`--with-reports` is).
// ---------------------------------------------------------------------------
describe('listComponentsHandler retrievalHint — pending vs never-pulled', () => {
  const PENDING_MANIFEST = {
    ...FIXTURE_MANIFEST,
    coverage: [
      // Requested, retrieved, capped: node minting is what is pending.
      { type: 'Report', requested: true, retrieved: 0, errored: false, neverModeled: false, pending: true },
      // Never requested at all — the genuine "did not pull" case, kept as the
      // control so the two sentences cannot collapse back into one.
      { type: 'StaticResource', requested: false, retrieved: 0, errored: false, neverModeled: false },
    ],
    reportsCap: {
      reports: { total: 4296, requested: 359, retrieved: 284 },
      dashboards: { total: 83, requested: 83, retrieved: 75 },
    },
  };

  let dir: string;
  let s: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-lc-pending-'));
    const opened = await openGraph(join(dir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    s = opened.value;
    const imp = await importExtractionResults(s, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: dir, manifest: PENDING_MANIFEST, graph: s };
  });

  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT claim the refresh skipped a pending type, and cites the pull volume off the manifest', async () => {
    const r = await listComponentsHandler(ctx, { type: 'Report' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.components).toHaveLength(0);
    const hint = r.value.data.retrievalHint ?? '';
    // The false sentence, gone.
    expect(hint).not.toContain('did not pull');
    expect(hint).not.toContain('--types` to include Report');
    // What is actually true, with the manifest's own numbers.
    expect(hint).toContain('DID retrieve');
    expect(hint).toContain('pending');
    expect(hint).toContain('284');
    expect(hint).toContain('359');
    expect(hint).toContain('4296');
    expect(hint).toContain('usedInReport');
    // and the remedy that actually mints nodes.
    expect(hint).toContain('--with-reports');
    // still never proof of absence.
    expect(hint).toContain('never proof the org has none');
  });

  it('keeps the "did not pull" sentence for a type the refresh genuinely never requested', async () => {
    const r = await listComponentsHandler(ctx, { type: 'StaticResource' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.retrievalHint).toContain('did not pull');
    expect(r.value.data.retrievalHint).toContain('/sfi-refresh');
  });

  it('prescribes --with-reports (never --types) even on the never-requested analytics branch', async () => {
    const notRequested: Context = {
      ...ctx,
      manifest: {
        ...FIXTURE_MANIFEST,
        coverage: [
          { type: 'Report', requested: false, retrieved: 0, errored: false, neverModeled: false },
        ],
      },
    };
    const r = await listComponentsHandler(notRequested, { type: 'Report' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.retrievalHint).toContain('--with-reports');
    expect(r.value.data.retrievalHint).not.toContain('--types` to include Report');
  });

  it('emits NO hint at all when the pending type actually has nodes (the fresh-vault case)', async () => {
    // A vault where the Report row is still `pending` but node minting DID
    // happen returns rows, so the sentence must not fire at all — the stale and
    // fresh vaults have to differ here, not just in wording.
    const withReports = mkdtempSync(join(tmpdir(), 'sfi-lc-reports-'));
    const opened = await openGraph(join(withReports, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const imp = await importExtractionResults(opened.value, [
      {
        nodes: [
          makeNode({
            id: 'Report:Folder/Alpha',
            type: 'Report',
            apiName: 'Folder/Alpha',
            label: 'Alpha',
            sourcePath: 'reports/Folder/Alpha.report-meta.xml',
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    const r = await listComponentsHandler(
      { vaultRoot: withReports, manifest: PENDING_MANIFEST, graph: opened.value },
      { type: 'Report' },
    );
    await closeGraph(opened.value);
    rmSync(withReports, { recursive: true, force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(1);
    expect(r.value.data.retrievalHint).toBeUndefined();
    // The row is still `pending`, so the inventory is still not authoritative.
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain('Report');
  });
});

/**
 * LIST-COMPONENTS-SILENTLY-DROPS-OBJECT-SCOPE.
 *
 * Found against a real production org. `sfi.list_components
 * { type: 'ValidationRule', objectApiName: '<Obj_L>' }` returned the ORG-WIDE
 * total (332) with a first row belonging to an unrelated managed package —
 * byte-identical to the same call with no filter at all, and byte-identical to
 * the same call with a nonsense key. `objectApiName` is the canonical scope key
 * across the rest of the product, so it is precisely the argument a host LLM
 * reaches for; it was not in this tool's schema, so Zod stripped it and the
 * handler certified an org-wide answer as the scoped one.
 *
 * `sfi.what_happens_on_save` already refuses an unknown argument by name for
 * exactly this reason. This block holds this tool to the same doctrine on both
 * halves: HONOR the object scope, and REFUSE what it cannot honor.
 *
 * The second half is the same disease one level down: a `parentId` narrow that
 * matched nothing was certified `"none in the org"`. The product's OWN router
 * suggests `{ type: 'ApexTrigger', parentId: 'CustomObject:<X>' }`, and
 * ApexTrigger nodes are top-level (no object parent) in a real vault — so that
 * certification read "this org has no triggers" on an org that has 22.
 */
describe('listComponentsHandler — object scope (LIST-COMPONENTS-SILENTLY-DROPS-OBJECT-SCOPE)', () => {
  let scopeDir: string;
  let scopeStore: GraphStore;
  let scopeCtx: Context;

  beforeAll(async () => {
    scopeDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-listcomp-scope-'));
    const opened = await openGraph(join(scopeDir, 'scope.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    scopeStore = opened.value;
    const vr = (parent: string, name: string): Node =>
      makeNode({
        id: `ValidationRule:${parent}.${name}`,
        type: 'ValidationRule',
        apiName: name,
        label: name,
        parentId: `CustomObject:${parent}`,
        sourcePath: `objects/${parent}/validationRules/${name}.validationRule-meta.xml`,
      });
    const imported = await importExtractionResults(scopeStore, [
      {
        nodes: [
          makeNode({ id: 'CustomObject:Obj_A__c', apiName: 'Obj_A__c', label: 'Obj A' }),
          makeNode({ id: 'CustomObject:Obj_B__c', apiName: 'Obj_B__c', label: 'Obj B' }),
          vr('Obj_A__c', 'Rule_One'),
          vr('Obj_A__c', 'Rule_Two'),
          vr('Obj_B__c', 'Rule_Three'),
          // Top-level: no object parent, so no `CustomObject:` narrow can ever
          // match one. This is the shape ApexTrigger / Flow / ApexClass have.
          makeNode({
            id: 'Flow:Flow_B',
            type: 'Flow',
            apiName: 'Flow_B',
            label: 'Flow B',
            // Record-triggered so the `recordTriggered` short-circuit term can
            // be exercised as a SEPARATE case from `status`.
            properties: { status: 'Active', triggerType: 'RecordAfterSave' },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    scopeCtx = { vaultRoot: scopeDir, manifest: FIXTURE_MANIFEST, graph: scopeStore };
  });

  afterAll(async () => {
    await closeGraph(scopeStore);
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it('honors objectApiName instead of returning the org-wide list', async () => {
    // FAIL-BEFORE: `objectApiName` was not a schema key, so the handler saw
    // `{type}` alone and answered totalCount 3 — every rule in the vault.
    const parsed = listComponentsInputSchema.safeParse({
      type: 'ValidationRule',
      objectApiName: 'Obj_A__c',
    });
    expect(parsed.success).toBe(true);
    const r = await listComponentsHandler(scopeCtx, {
      type: 'ValidationRule',
      objectApiName: 'Obj_A__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(2);
    expect(r.value.data.components.map((n) => n.id)).toEqual([
      'ValidationRule:Obj_A__c.Rule_One',
      'ValidationRule:Obj_A__c.Rule_Two',
    ]);
    // The applied narrow must be echoed, or a caller cannot tell a scoped
    // answer from an org-wide one.
    expect(r.value.data.appliedScope).toEqual({
      object: 'Obj_A__c',
      componentId: 'CustomObject:Obj_A__c',
      narrowedBy: 'parentId',
    });
  });

  it('honors the `object` and `objectId` aliases identically', async () => {
    for (const key of ['object', 'objectId'] as const) {
      const r = await listComponentsHandler(scopeCtx, {
        type: 'ValidationRule',
        [key]: 'Obj_B__c',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.totalCount).toBe(1);
      expect(r.value.data.appliedScope?.componentId).toBe('CustomObject:Obj_B__c');
    }
  });

  it('resolves a WRONG-CASE object name to the vault casing rather than answering org-wide', async () => {
    // Salesforce api names are case-insensitive. On the real org the lower-case
    // form produced a confident "no PII on <Obj>" where the truth was nine.
    const r = await listComponentsHandler(scopeCtx, {
      type: 'ValidationRule',
      objectApiName: 'obj_a__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(2);
    expect(r.value.data.appliedScope?.componentId).toBe('CustomObject:Obj_A__c');
    expect(r.value.data.appliedScope?.resolvedFrom).toBe('CustomObject:obj_a__c');
  });

  it('REFUSES an object that does not exist in the vault instead of widening to org-wide', async () => {
    const r = await listComponentsHandler(scopeCtx, {
      type: 'ValidationRule',
      objectApiName: 'Obj_Z__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Obj_Z__c');
  });

  it('REFUSES an objectApiName that disagrees with an explicit parentId', async () => {
    const r = await listComponentsHandler(scopeCtx, {
      type: 'ValidationRule',
      objectApiName: 'Obj_A__c',
      parentId: 'CustomObject:Obj_B__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('CustomObject:Obj_A__c');
    expect(r.error.message).toContain('CustomObject:Obj_B__c');
  });

  it('REFUSES an unknown argument by name rather than silently dropping it', () => {
    // The doctrine `sfi.what_happens_on_save` already states verbatim. Before
    // the fix this parsed clean and the answer was byte-identical to the
    // unfiltered call.
    const parsed = listComponentsInputSchema.safeParse({
      type: 'ValidationRule',
      zzzNonsense: 'xyz',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = parsed.error.issues.map((i) => i.message).join(' ');
    expect(message).toContain('zzzNonsense');
    expect(message).toContain(
      'Refusing rather than ignoring it — a silently-dropped argument returns a confident answer to a question you did not ask.',
    );
    // The refusal must name what the tool DOES accept, including the scope keys.
    expect(message).toContain('objectApiName');
    expect(message).toContain('parentId');
  });

  it('does NOT certify "none in the org" when an object narrow matched nothing', async () => {
    // FAIL-BEFORE: the empty page fell through to
    // `"…retrieved `Flow` and found none — this is \"none in the org\"…"`,
    // which is false on a vault holding a Flow: the narrow is PARENT-based and
    // a top-level type can never match it.
    const r = await listComponentsHandler(scopeCtx, {
      type: 'Flow',
      objectApiName: 'Obj_A__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.retrievalHint).toBeDefined();
    // The CERTIFICATION is what has to go: the old sentence asserted the zero
    // as an org-wide fact. The replacement may quote the phrase to negate it.
    expect(r.value.data.retrievalHint).not.toContain('this is "none in the org"');
    expect(r.value.data.retrievalHint).toContain('PARENT-scoped zero');
    // TYPED, so a machine consumer cannot skip past the prose.
    expect(r.value.data.scopeCaveat).toEqual({
      parentId: 'CustomObject:Obj_A__c',
      narrowedBy: 'parentId',
      countWithoutParentNarrow: 1,
      parentScopedOnly: true,
    });
  });

  it('gives the same honest hint for a bare parentId narrow (the router suggests these)', async () => {
    const r = await listComponentsHandler(scopeCtx, {
      type: 'Flow',
      parentId: 'CustomObject:Obj_B__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.retrievalHint).not.toContain('this is "none in the org"');
    expect(r.value.data.retrievalHint).toContain('PARENT-scoped zero');
    expect(r.value.data.scopeCaveat?.countWithoutParentNarrow).toBe(1);
  });

  it('still discloses the scoped zero when a PROPERTY filter is also active', async () => {
    // The coverage prose is deliberately suppressed under a property filter (an
    // empty result there is the filter's doing, not a coverage gap). The SCOPE
    // disclosure is a different fact and must survive that suppression, or a
    // filtered scoped zero is certified silently. `countWithoutParentNarrow`
    // keeps every other filter intact and drops ONLY the parent narrow.
    const r = await listComponentsHandler(scopeCtx, {
      type: 'Flow',
      objectApiName: 'Obj_A__c',
      status: 'Active',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.scopeCaveat?.countWithoutParentNarrow).toBe(1);
    expect(r.value.data.appliedScope?.componentId).toBe('CustomObject:Obj_A__c');
    // A TYPED field alone is half a disclosure: a prose-only host renders
    // `retrievalHint` and never looks at `scopeCaveat`, so it read this back as
    // a bare zero. The scope sentence must survive the coverage-guard
    // short-circuit that the property filter triggers.
    expect(r.value.data.retrievalHint).toBeDefined();
    expect(r.value.data.retrievalHint).toContain('PARENT-scoped zero');
    expect(r.value.data.retrievalHint).not.toContain('this is "none in the org"');
  });

  it('carries the scope prose for a recordTriggered-filtered scoped zero too', async () => {
    // recordTriggered is a separate short-circuit term in the same guard, so it
    // is checked separately rather than assumed to follow from `status`.
    const r = await listComponentsHandler(scopeCtx, {
      type: 'Flow',
      objectApiName: 'Obj_A__c',
      recordTriggered: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.retrievalHint).toContain('PARENT-scoped zero');
  });

  it('REFUSES a whitespace-only object scope instead of silently widening to the org', async () => {
    // The exact defect this lane exists to kill, surviving on a degenerate
    // input: `z.string().min(1)` measures the RAW string, so '   ' cleared the
    // check, then trimmed away downstream and resolved to NO scope — the
    // ORG-WIDE list returned under a scoped question, with no `appliedScope` to
    // give the reader a clue. Every alias is checked: they share one resolver
    // but they are three separate schema entries.
    // Asserted through the HANDLER first, so the failure output names the
    // actual harm (the org-wide 3 with no `appliedScope`) rather than a schema
    // technicality, and so the test still bites if the refusal ever moves out
    // of Zod and into the handler.
    const parsed = listComponentsInputSchema.safeParse({
      type: 'ValidationRule',
      objectApiName: '   ',
    });
    if (parsed.success) {
      const r = await listComponentsHandler(scopeCtx, parsed.data);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(
        { totalCount: r.value.data.totalCount, appliedScope: r.value.data.appliedScope },
        'a blank scope must never return the org-wide count with no appliedScope',
      ).not.toEqual({ totalCount: 3, appliedScope: undefined });
    }
    // Every alias: they share one resolver but are three separate schema entries.
    for (const key of ['objectApiName', 'object', 'objectId'] as const) {
      for (const blank of ['   ', '\t', '\n ']) {
        expect(
          listComponentsInputSchema.safeParse({ type: 'ValidationRule', [key]: blank })
            .success,
          `${key}=${JSON.stringify(blank)} must be refused, not widened`,
        ).toBe(false);
      }
    }
  });

  it('still accepts a scope with incidental surrounding whitespace', async () => {
    // Trim REFUSES an empty scope; it must not refuse a real one a host padded.
    const r = await listComponentsHandler(scopeCtx, {
      type: 'ValidationRule',
      objectApiName: listComponentsInputSchema.parse({
        type: 'ValidationRule',
        objectApiName: '  Obj_A__c  ',
      }).objectApiName,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(2);
    expect(r.value.data.appliedScope?.componentId).toBe('CustomObject:Obj_A__c');
  });

  it('does NOT invent a caveat when the parent narrow is the only thing that could have matched', async () => {
    // Same query, a filter nothing satisfies: dropping the parent narrow still
    // returns zero, so there is no second zero to distinguish and no caveat.
    const r = await listComponentsHandler(scopeCtx, {
      type: 'Flow',
      objectApiName: 'Obj_A__c',
      status: 'Obsolete',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.scopeCaveat).toBeUndefined();
  });

  it('leaves the unscoped shape untouched — no appliedScope, no scopeCaveat', async () => {
    const r = await listComponentsHandler(scopeCtx, { type: 'ValidationRule' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(3);
    expect(r.value.data.appliedScope).toBeUndefined();
    expect(r.value.data.scopeCaveat).toBeUndefined();
  });

  it('an honestly-empty narrow on a parented type still says "none under this parent", not "none in the org"', async () => {
    // Obj_B__c HAS validation rules, but none named by this parent+type pair
    // once we narrow to a parent that has none of them.
    const empty = await listComponentsHandler(scopeCtx, {
      type: 'RecordType',
      objectApiName: 'Obj_A__c',
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value.data.totalCount).toBe(0);
    // RecordType was never retrieved into this fixture vault, so coverage — not
    // the scope — owns the sentence. It must still not claim "none in the org".
    expect(empty.value.data.retrievalHint).not.toContain(
      'this is "none in the org"',
    );
  });
});
