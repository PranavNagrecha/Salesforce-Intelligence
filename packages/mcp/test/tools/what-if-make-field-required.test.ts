/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
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
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import type { Context } from '../../src/server.js';
import { resetLiveSession } from '../../src/tools/live-session.js';
import {
  whatIfMakeFieldRequiredHandler,
  whatIfMakeFieldRequiredInputSchema,
} from '../../src/tools/what-if-make-field-required.js';

const completeCoverage = (types: readonly string[]): readonly CoverageEntry[] =>
  types.map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
  }));

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 2, Layout: 2, Flow: 2, ExternalService: 1 },
  edges: { parentOf: 4, usedInLayout: 1, writesTo: 1 },
  sourceTreeHash: 'sha256:fixture',
  coverageComputedAt: '2026-05-29T12:00:00.000Z',
  coverage: completeCoverage([
    'CustomField',
    'Flow',
    'ApexClass',
    'ApexTrigger',
    'Layout',
    'ExternalService',
    'ExternalDataSource',
    'LightningComponentBundle',
    'AuraDefinitionBundle',
    'VisualforcePage',
    'VisualforceComponent',
    'FlexiPage',
  ]),
};

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

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

const ACCOUNT_OBJ = 'CustomObject:Account';
const TARGET_FIELD = 'CustomField:Account.Industry';
const REQUIRED_FIELD = 'CustomField:Account.AlreadyRequired';
const OTHER_FIELD = 'CustomField:Account.Other';
const FORMULA_FIELD = 'CustomField:Account.Earnings';
const SUMMARY_FIELD = 'CustomField:Account.TotalAmount';
const AUTONUMBER_FIELD = 'CustomField:Account.RecordNo';
const LAYOUT_WITH = 'Layout:Account.WithIndustry';
const LAYOUT_WITHOUT = 'Layout:Account.Minimal';
const FLOW_CREATE_NO_FIELD = 'Flow:QuickCreateAccount';
const FLOW_CREATE_WITH_FIELD = 'Flow:FullCreateAccount';
// Creates Account via an OBJECT-level recordCreate edge ONLY, with no
// field-level writes the vault models. This is the exact real-graph shape
// (every recordCreate writesTo edge had toId prefix CustomObject) that the
// pre-fix consumer missed — it must still be flagged blocking for TARGET_FIELD.
const FLOW_CREATE_BARE = 'Flow:BareCreateAccount';
const EXT_SVC_ID = 'ExternalService:LegacyCRMSync';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT_OBJ, apiName: 'Account' }),
    makeNode({
      id: TARGET_FIELD,
      type: 'CustomField',
      apiName: 'Industry',
      parentId: ACCOUNT_OBJ,
      properties: { type: 'Picklist', required: false },
    }),
    makeNode({
      id: REQUIRED_FIELD,
      type: 'CustomField',
      apiName: 'AlreadyRequired',
      parentId: ACCOUNT_OBJ,
      properties: { type: 'Text', required: true },
    }),
    makeNode({
      id: OTHER_FIELD,
      type: 'CustomField',
      apiName: 'Other',
      parentId: ACCOUNT_OBJ,
      properties: { type: 'Text' },
    }),
    // Non-requirable computed / auto field types. Use the REAL extractor keys
    // (`dataType` / `formula`) — those are what the field-type guard reads.
    makeNode({
      id: FORMULA_FIELD,
      type: 'CustomField',
      apiName: 'Earnings',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Currency', formula: 'Amount__c * 2', required: false },
    }),
    makeNode({
      id: SUMMARY_FIELD,
      type: 'CustomField',
      apiName: 'TotalAmount',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Summary', required: false },
    }),
    makeNode({
      id: AUTONUMBER_FIELD,
      type: 'CustomField',
      apiName: 'RecordNo',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'AutoNumber', required: false },
    }),
    makeNode({
      id: LAYOUT_WITH,
      type: 'Layout',
      apiName: 'Account.WithIndustry',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: LAYOUT_WITHOUT,
      type: 'Layout',
      apiName: 'Account.Minimal',
      parentId: ACCOUNT_OBJ,
    }),
    makeNode({
      id: FLOW_CREATE_NO_FIELD,
      type: 'Flow',
      apiName: 'QuickCreateAccount',
    }),
    makeNode({
      id: FLOW_CREATE_WITH_FIELD,
      type: 'Flow',
      apiName: 'FullCreateAccount',
    }),
    makeNode({
      id: FLOW_CREATE_BARE,
      type: 'Flow',
      apiName: 'BareCreateAccount',
    }),
    makeNode({
      id: EXT_SVC_ID,
      type: 'ExternalService',
      apiName: 'LegacyCRMSync',
    }),
    // A ListView that references the target field (filter/column) — bug 16.
    makeNode({
      id: 'ListView:Account.By_Industry',
      type: 'ListView',
      apiName: 'Account.By_Industry',
    }),
  ],
  edges: [
    makeEdge({ fromId: ACCOUNT_OBJ, toId: TARGET_FIELD, edgeType: 'parentOf' }),
    // ListView → field `references` edge (enterprise-metadata extractor shape).
    makeEdge({
      fromId: 'ListView:Account.By_Industry',
      toId: TARGET_FIELD,
      edgeType: 'references',
    }),
    makeEdge({ fromId: ACCOUNT_OBJ, toId: REQUIRED_FIELD, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT_OBJ, toId: OTHER_FIELD, edgeType: 'parentOf' }),
    // LAYOUT_WITH displays the target field.
    makeEdge({
      fromId: LAYOUT_WITH,
      toId: TARGET_FIELD,
      edgeType: 'usedInLayout',
    }),
    // LAYOUT_WITHOUT does NOT display the target field (no edge).
    //
    // Flow create edges mirror the REAL flow-extractor output: each
    // <recordCreates> emits an OBJECT-level writesTo (toId = CustomObject,
    // marks the flow a creator of that object) PLUS one FIELD-level writesTo
    // (toId = CustomField) per <inputAssignments> field it actually sets.
    // The consumer detects creators on the OBJECT-level edge and reads field
    // coverage off the FIELD-level edges — never the reverse.
    //
    // FLOW_CREATE_NO_FIELD creates Account but sets only OTHER_FIELD —
    // it does NOT set TARGET_FIELD, so making TARGET_FIELD required breaks it.
    makeEdge({
      fromId: FLOW_CREATE_NO_FIELD,
      toId: ACCOUNT_OBJ,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    makeEdge({
      fromId: FLOW_CREATE_NO_FIELD,
      toId: OTHER_FIELD,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    // FLOW_CREATE_WITH_FIELD creates Account AND sets TARGET_FIELD (+ OTHER) —
    // safe under the new required constraint.
    makeEdge({
      fromId: FLOW_CREATE_WITH_FIELD,
      toId: ACCOUNT_OBJ,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    makeEdge({
      fromId: FLOW_CREATE_WITH_FIELD,
      toId: TARGET_FIELD,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    makeEdge({
      fromId: FLOW_CREATE_WITH_FIELD,
      toId: OTHER_FIELD,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    // FLOW_CREATE_BARE creates Account with ONLY an object-level edge (no
    // field-level writes the vault models). The pre-fix consumer resolved
    // this object-level edge's CustomObject target as a "field" and asked for
    // its parentId — always null — so it never counted as a creator and the
    // tool returned a false 'safe'. It must be flagged blocking.
    makeEdge({
      fromId: FLOW_CREATE_BARE,
      toId: ACCOUNT_OBJ,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      confidence: 'parsed',
      properties: { operation: 'recordCreate' },
    }),
    // External Service references the Account object.
    makeEdge({
      fromId: EXT_SVC_ID,
      toId: ACCOUNT_OBJ,
      edgeType: 'references',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-wi-mfr-'));
  const dbPath = join(tempDir, 'wi-mfr.db');
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

describe('whatIfMakeFieldRequiredHandler', () => {
  it('rejects non-requirable computed/auto field types (formula / summary / auto-number)', async () => {
    // Formula / Roll-Up Summary / Auto Number fields are computed or
    // auto-generated — never user-entered — so Salesforce offers no "Required"
    // option for them. Analysing write paths would return a misleading verdict
    // for an operation that cannot be performed; reject with a clear message.
    for (const fieldId of [FORMULA_FIELD, SUMMARY_FIELD, AUTONUMBER_FIELD]) {
      const result = await whatIfMakeFieldRequiredHandler(ctx, { fieldId });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('invalid-query');
      expect(result.error.message).toContain('cannot be made required');
    }
  });

  it('rejects a non-CustomField prefix with invalid-query', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: 'Flow:NotAField',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('fieldId');
  });

  it('returns component-not-found for an unknown CustomField id', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: 'CustomField:Account.DoesNotExist',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('returns no-op safe verdict when the field is already required', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: REQUIRED_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.alreadyRequired).toBe(true);
    expect(result.value.data.verdict).toBe('safe');
    expect(result.value.data.impacts.length).toBe(0);
  });

  it('flags layouts on the parent that do NOT display the field', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).toContain(LAYOUT_WITHOUT);
  });

  it('flags a ListView that references the field (filter/column) — bug 16', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lv = result.value.data.impacts.find(
      (i) => i.componentId === 'ListView:Account.By_Industry',
    );
    expect(lv).toBeDefined();
    expect(lv?.category).toBe('configuration-only');
    expect(lv?.explanation).toContain('ListView');
  });

  it('does NOT flag layouts that already display the field', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).not.toContain(LAYOUT_WITH);
  });

  it('flags Flows creating records on the parent that do NOT set the field', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).toContain(FLOW_CREATE_NO_FIELD);
  });

  it('does NOT flag Flows that DO set the field on create', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).not.toContain(FLOW_CREATE_WITH_FIELD);
  });

  it('flags a Flow that creates the parent via an OBJECT-level edge with no modeled field writes (the real-graph bug)', async () => {
    // Regression guard for the producer/consumer mismatch: on the real graph
    // every recordCreate writesTo edge targets CustomObject, never CustomField.
    // The pre-fix consumer resolved that CustomObject target as a "field",
    // read its null parentId, and concluded the flow was not a creator —
    // returning a false 'safe'. Detecting creators on the object-level edge
    // makes this the metadata-blocker it should always have been.
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const blocker = result.value.data.impacts.find(
      (i) => i.componentId === FLOW_CREATE_BARE,
    );
    expect(blocker?.category).toBe('metadata-blocker');
    expect(result.value.data.verdict).toBe('blocking');
  });

  it('flags External Service integrations referencing the parent object', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).toContain(EXT_SVC_ID);
  });

  it('classifies categories correctly per source type', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(
      result.value.data.impacts.map((i) => [i.componentId, i]),
    );
    expect(byId.get(LAYOUT_WITHOUT)?.category).toBe('configuration-only');
    expect(byId.get(FLOW_CREATE_NO_FIELD)?.category).toBe('metadata-blocker');
    expect(byId.get(EXT_SVC_ID)?.category).toBe('integration-touch');
  });

  it('aggregates verdict as blocking when a metadata-blocker is present', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
  });

  it('sorts impacts by componentId ASC for deterministic output', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('carries the verbatim boundary disclosure about Apex dataflow', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('Apex `insert acc;` sites');
    expect(result.value.data.disclosure).toContain('dataflow analysis');
  });

  it('echoes the fieldId in the response', async () => {
    const result = await whatIfMakeFieldRequiredHandler(ctx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldId).toBe(TARGET_FIELD);
    expect(result.value.data.alreadyRequired).toBe(false);
  });

  it('surfaces coverageCaveat when field-change coverage is incomplete', async () => {
    const partialCoverage = (FIXTURE_MANIFEST.coverage ?? []).filter(
      (entry) => entry.type !== 'FlexiPage',
    );
    const incompleteCtx: Context = {
      ...ctx,
      manifest: {
        ...FIXTURE_MANIFEST,
        coverage: partialCoverage,
      },
    };
    const result = await whatIfMakeFieldRequiredHandler(incompleteCtx, {
      fieldId: TARGET_FIELD,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.coverageCaveat?.missingCoverage).toContain('FlexiPage');
  });
});

describe('whatIfMakeFieldRequiredInputSchema', () => {
  it('accepts a well-formed input', () => {
    const parsed = whatIfMakeFieldRequiredInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty fieldId', () => {
    const parsed = whatIfMakeFieldRequiredInputSchema.safeParse({
      fieldId: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing fieldId', () => {
    const parsed = whatIfMakeFieldRequiredInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('accepts the live params (P6-required-field-whatif)', () => {
    const parsed = whatIfMakeFieldRequiredInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
      liveEnabled: true,
      orgAlias: 'prod',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('whatIfMakeFieldRequiredHandler — live null-rate (P6-required-field-whatif)', () => {
  // 40 of 100 records have the field null; staleness queries report a fresh vault.
  const liveExec: ExecCommand = async (_bin, args) => {
    const soql = String(args[args.indexOf('--query') + 1] ?? '');
    if (args.includes('--use-tooling-api')) {
      return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
    }
    const count = soql.includes('= null') ? 40 : 100;
    return { stdout: JSON.stringify({ result: { totalSize: count } }), stderr: '' };
  };

  beforeEach(() => resetLiveSession());
  afterEach(() => resetLiveSession());

  it('without the live plane returns the offline verdict — no null-rate, offline_snapshot', async () => {
    const r = await whatIfMakeFieldRequiredHandler(ctx, { fieldId: TARGET_FIELD }, liveExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.liveNullRate).toBeUndefined();
    expect(r.value.data.trust.provenance).toBe('offline_snapshot');
  });

  it('with liveEnabled adds the production null-rate and stamps hybrid trust', async () => {
    const r = await whatIfMakeFieldRequiredHandler(
      ctx,
      { fieldId: TARGET_FIELD, liveEnabled: true },
      liveExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nr = r.value.data.liveNullRate;
    expect(nr).toBeDefined();
    expect(nr?.totalCount).toBe(100);
    expect(nr?.nullCount).toBe(40);
    expect(nr?.populatedCount).toBe(60);
    expect(nr?.nullRate).toBe(0.4);
    expect(nr?.interpretation).toContain('40');
    expect(r.value.data.trust.provenance).toBe('hybrid');
    expect(r.value.data.trust.freshness.snapshotRefreshedAt).toBe(FIXTURE_MANIFEST.refreshedAt);
    expect(r.value.data.trust.freshness.liveQueriedAt).toBeDefined();
  });
});

// =============================================================================
// CR-12 — page-to-exhaustion (destructive SAFETY verdict). The Flow scan is
// walked to exhaustion, not just the first page; a non-writing create-path Flow
// sorted PAST the cap by id ASC used to be silently skipped → a false 'safe'
// verdict (a SAFETY false-negative, the worst class for a what-if tool). With
// SFI_NODE_SCAN_LIMIT=2 the loadAllNodes offset loop walks multiple Flow pages.
// =============================================================================
describe('whatIfMakeFieldRequiredHandler — past-cap Flow SAFETY (CR-12 de-cap)', () => {
  let dir: string;
  let s: GraphStore;
  let pagedCtx: Context;

  const acct = 'CustomObject:Account';
  const targetField = 'CustomField:Account.Industry__c';
  // id-ASC Flows: Aaa, Bbb (fillers, no create edges), then ZzzCreate LAST —
  // past a cap of 2. ZzzCreate creates Account via an object-level recordCreate
  // edge and does NOT set the target field → must be a metadata-blocker.
  const pastCapSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: acct, apiName: 'Account' }),
      makeNode({
        id: targetField,
        type: 'CustomField',
        apiName: 'Industry__c',
        parentId: acct,
        properties: { type: 'Text', required: false },
      }),
      makeNode({ id: 'Flow:AaaFiller', type: 'Flow', apiName: 'AaaFiller' }),
      makeNode({ id: 'Flow:BbbFiller', type: 'Flow', apiName: 'BbbFiller' }),
      makeNode({ id: 'Flow:ZzzCreateAccount', type: 'Flow', apiName: 'ZzzCreateAccount' }),
    ],
    edges: [
      makeEdge({ fromId: acct, toId: targetField, edgeType: 'parentOf' }),
      // ZzzCreateAccount creates Account (object-level recordCreate) but never
      // writes the target field → the create will fail under a required field.
      makeEdge({
        fromId: 'Flow:ZzzCreateAccount',
        toId: acct,
        edgeType: 'writesTo',
        source: 'flow-extractor',
        confidence: 'parsed',
        properties: { operation: 'recordCreate' },
      }),
    ],
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-wi-mfr-pastcap-'));
    const opened = await openGraph(join(dir, 'wi-mfr-pastcap.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    s = opened.value;
    const imported = await importExtractionResults(s, [pastCapSeed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
    pagedCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
  });

  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '2';
  });

  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('flags a non-writing create Flow sorted PAST the cap (the SAFETY false-negative)', async () => {
    // BEFORE the fix: the first-2-Flow page (AaaFiller, BbbFiller) dropped
    // ZzzCreateAccount, so the tool returned a false 'safe' verdict.
    const r = await whatIfMakeFieldRequiredHandler(pagedCtx, {
      fieldId: targetField,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const blocker = r.value.data.impacts.find(
      (i) => i.componentId === 'Flow:ZzzCreateAccount',
    );
    expect(blocker?.category).toBe('metadata-blocker');
    expect(r.value.data.verdict).toBe('blocking');
  });
});
