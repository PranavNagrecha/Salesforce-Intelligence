/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  RECORD_ID_NO_INDEX_MESSAGE,
  resolveFlowRef,
} from '../../src/tools/flow-ref.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Flow: 5 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/properties. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Flow',
  apiName: 'TestFlow',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Default edge-shape helper. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'flow',
  properties: {},
  ...overrides,
});

// A synthetic Flow node — a Flow whose apiName/label are set from the caller.
const flowNode = (apiName: string, label: string): Node =>
  makeNode({
    id: `Flow:${apiName}`,
    type: 'Flow',
    apiName,
    label,
    properties: {
      label,
      status: 'Active',
      processType: 'AutoLaunchedFlow',
    },
  });

// =============================================================================
// Seeds — all synthetic. Distinct token sets so the Flow-scoped fuzzy fallback
// picks cleanly: `My_Flow` (canonical + bare exact), `Widget_Sync_Notification`
// (single fuzzy winner), two `Order_Escalation_*` (>1 → ambiguous), and an
// `ApexTrigger:AccountTrigger` (same-named non-Flow → alt-type hint).
// =============================================================================

const MY_FLOW_ID = 'Flow:My_Flow';
const WIDGET_FLOW_ID = 'Flow:Widget_Sync_Notification';
const ORDER_ONE_ID = 'Flow:Order_Escalation_One';
const ORDER_TWO_ID = 'Flow:Order_Escalation_Two';
const ACCOUNT_TRIGGER_ID = 'ApexTrigger:AccountTrigger';

const seed: ExtractionResult = {
  nodes: [
    flowNode('My_Flow', 'My Flow'),
    flowNode('Widget_Sync_Notification', 'Widget Sync Notification'),
    flowNode('Order_Escalation_One', 'Order Escalation One'),
    flowNode('Order_Escalation_Two', 'Order Escalation Two'),
    makeNode({
      id: ACCOUNT_TRIGGER_ID,
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      label: 'AccountTrigger',
      properties: {},
    }),
  ],
  edges: [
    // A single edge so the resolve-index's inbound-count query has a row.
    makeEdge({
      fromId: WIDGET_FLOW_ID,
      toId: 'ApexClass:Notifier',
      edgeType: 'callsApex',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-flow-ref-'));
  // NOTE: deliberately NO meta/flow-id-index.json here — the fail-closed
  // record-id test relies on the index being absent in this vault root.
  const opened = await openGraph(join(tempDir, 'flow-ref.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveFlowRef — §3 reference-resolution table', () => {
  it('resolves a canonical component id (Flow:My_Flow) directly', async () => {
    const r = await resolveFlowRef(ctx, MY_FLOW_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('resolved');
    if (r.value.outcome !== 'resolved') return;
    const { resolved, node } = r.value;
    expect(resolved.requested).toBe(MY_FLOW_ID);
    expect(resolved.resolvedForm).toBe('canonical-id');
    expect(resolved.matchConfidence).toBe('exact');
    expect(resolved.componentId).toBe(MY_FLOW_ID);
    expect(resolved.apiName).toBe('My_Flow');
    expect(resolved.label).toBe('My Flow');
    // No candidates on an exact resolution.
    expect(resolved.candidates).toBeUndefined();
    expect(node.type).toBe('Flow');
    expect(node.id).toBe(MY_FLOW_ID);
  });

  it('resolves a bare API name (My_Flow) via prefix coercion + exact lookup', async () => {
    const r = await resolveFlowRef(ctx, 'My_Flow');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('resolved');
    if (r.value.outcome !== 'resolved') return;
    const { resolved } = r.value;
    expect(resolved.requested).toBe('My_Flow');
    // A bare name resolves as 'api-name', not 'canonical-id'.
    expect(resolved.resolvedForm).toBe('api-name');
    expect(resolved.matchConfidence).toBe('exact');
    expect(resolved.componentId).toBe(MY_FLOW_ID);
    expect(resolved.candidates).toBeUndefined();
  });

  it('falls back to a Flow-scoped fuzzy match on a bare-name typo (single winner)', async () => {
    // Direct getNodeById('Flow:Widget_Sync_Notificaton') misses → fuzzy fallback
    // finds the single Flow whose name it typos.
    const r = await resolveFlowRef(ctx, 'Widget_Sync_Notificaton');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('resolved');
    if (r.value.outcome !== 'resolved') return;
    const { resolved } = r.value;
    expect(resolved.resolvedForm).toBe('api-name');
    // A fuzzy resolution is flagged as such and carries the winning candidate.
    expect(resolved.matchConfidence).toBe('fuzzy');
    expect(resolved.componentId).toBe(WIDGET_FLOW_ID);
    expect(resolved.candidates).toBeDefined();
    expect(resolved.candidates?.[0]?.componentId).toBe(WIDGET_FLOW_ID);
  });
});

describe('resolveFlowRef — ambiguity is a SUCCESS envelope (never a pick)', () => {
  it('returns candidates without picking when >1 Flow matches fuzzily', async () => {
    // Both Order_Escalation_One and Order_Escalation_Two typo-match; the
    // resolver must NOT choose — it hands both back for disambiguation.
    const r = await resolveFlowRef(ctx, 'Order_Escalaton');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('ambiguous');
    if (r.value.outcome !== 'ambiguous') return;
    expect(r.value.requested).toBe('Order_Escalaton');
    expect(r.value.candidates.length).toBeGreaterThanOrEqual(2);
    const ids = r.value.candidates.map((c) => c.componentId);
    expect(ids).toContain(ORDER_ONE_ID);
    expect(ids).toContain(ORDER_TWO_ID);
    // Every candidate carries the projected shape.
    for (const c of r.value.candidates) {
      expect(typeof c.apiName).toBe('string');
      expect(typeof c.score).toBe('number');
    }
  });
});

describe('resolveFlowRef — record-id path', () => {
  it('FAILS CLOSED with invalid-query for a 15-char record id and no index', async () => {
    const r = await resolveFlowRef(ctx, '301A00000000001');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toBe(RECORD_ID_NO_INDEX_MESSAGE);
    expect(r.error.path).toBe('flowRef');
  });

  it('FAILS CLOSED for an 18-char record id and no index', async () => {
    const r = await resolveFlowRef(ctx, '300A00000000001XYZ');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toBe(RECORD_ID_NO_INDEX_MESSAGE);
  });

  it('resolves a record id through an on-disk meta/flow-id-index.json when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-flow-ref-idx-'));
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(
      join(dir, 'meta', 'flow-id-index.json'),
      JSON.stringify({ '301B00000000002': 'Indexed_Flow' }),
      'utf-8',
    );
    const opened = await openGraph(join(dir, 'idx.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [
      { nodes: [flowNode('Indexed_Flow', 'Indexed Flow')], edges: [] },
    ]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    const idxCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };

    const r = await resolveFlowRef(idxCtx, '301B00000000002');
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('resolved');
    if (r.value.outcome !== 'resolved') return;
    expect(r.value.resolved.resolvedForm).toBe('record-id');
    expect(r.value.resolved.matchConfidence).toBe('exact');
    expect(r.value.resolved.componentId).toBe('Flow:Indexed_Flow');
    expect(r.value.resolved.apiName).toBe('Indexed_Flow');
    // requested echoes the raw record id, not the resolved api name.
    expect(r.value.resolved.requested).toBe('301B00000000002');
  });

  it('returns component-not-found for a record id absent from an EXISTING index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-flow-ref-idx2-'));
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(
      join(dir, 'meta', 'flow-id-index.json'),
      JSON.stringify({ '301B00000000002': 'Indexed_Flow' }),
      'utf-8',
    );
    const opened = await openGraph(join(dir, 'idx.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [
      { nodes: [flowNode('Indexed_Flow', 'Indexed Flow')], edges: [] },
    ]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    const idxCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };

    // A well-formed record id the enriched index does NOT know → not-found,
    // distinct from the no-index fail-closed case.
    const r = await resolveFlowRef(idxCtx, '301C00000000003');
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('resolves a record id from a manifest-carried flowIdIndex map', async () => {
    const manifestWithIndex = {
      ...FIXTURE_MANIFEST,
      flowIdIndex: { '300D00000000004XYZ': 'My_Flow' },
    } as unknown as VaultManifest;
    const manifestCtx: Context = {
      vaultRoot: tempDir,
      manifest: manifestWithIndex,
      graph: store,
    };
    const r = await resolveFlowRef(manifestCtx, '300D00000000004XYZ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('resolved');
    if (r.value.outcome !== 'resolved') return;
    expect(r.value.resolved.resolvedForm).toBe('record-id');
    expect(r.value.resolved.componentId).toBe(MY_FLOW_ID);
  });
});

describe('resolveFlowRef — adversarial QA (Wave-0 gap hunt)', () => {
  it('resolves a lowercase bare name via case-insensitive fuzzy fallback', async () => {
    // getNodeById('Flow:my_flow') misses (SQL id lookup is case-sensitive), so
    // this only succeeds if the bare-name miss correctly falls through to the
    // Flow-scoped fuzzy fallback, whose tokenizer lowercases both sides.
    const r = await resolveFlowRef(ctx, 'my_flow');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('resolved');
    if (r.value.outcome !== 'resolved') return;
    expect(r.value.resolved.componentId).toBe(MY_FLOW_ID);
    expect(r.value.resolved.matchConfidence).toBe('fuzzy');
  });

  it('resolves an all-caps bare name via case-insensitive fuzzy fallback', async () => {
    const r = await resolveFlowRef(ctx, 'MY_FLOW');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('resolved');
    if (r.value.outcome !== 'resolved') return;
    expect(r.value.resolved.componentId).toBe(MY_FLOW_ID);
  });

  it('does NOT match a lowercase "flow:" prefix (case-sensitive prefix, consistent with coercePrefix elsewhere)', async () => {
    // Documents actual behavior: a lowercase-prefixed ref is treated as a bare
    // name containing a colon, which coercePrefix passes through unchanged, so
    // it is rejected as invalid-query rather than silently normalized.
    const r = await resolveFlowRef(ctx, 'flow:My_Flow');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('16-char and 17-char near-record-ids do NOT match the record-id regex (boundary check)', async () => {
    // The record-id pattern is exactly 15 or exactly 18 chars; 16/17-char
    // strings that merely START with a 301/300 prefix must fall through to the
    // bare-name path (giving an honest component-not-found), NOT the
    // misleading "needs a Tooling-API-enriched vault" fail-closed message —
    // that message must be reserved for genuine 15/18-char record-id shapes.
    const sixteen = '301A000000000012';
    expect(sixteen.length).toBe(16);
    const r16 = await resolveFlowRef(ctx, sixteen);
    expect(r16.ok).toBe(false);
    if (r16.ok) return;
    expect(r16.error.kind).toBe('component-not-found');

    const seventeen = '301A0000000000123';
    expect(seventeen.length).toBe(17);
    const r17 = await resolveFlowRef(ctx, seventeen);
    expect(r17.ok).toBe(false);
    if (r17.ok) return;
    expect(r17.error.kind).toBe('component-not-found');
  });

  it('a stale index entry (id present but its mapped apiName has no Flow node) fails as component-not-found, not a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-flow-ref-stale-'));
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(
      join(dir, 'meta', 'flow-id-index.json'),
      // The index claims this id maps to 'Ghost_Flow', but no such Flow node
      // is seeded below — an enrichment/vault drift scenario.
      JSON.stringify({ '301E00000000005': 'Ghost_Flow' }),
      'utf-8',
    );
    const opened = await openGraph(join(dir, 'stale.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [
      { nodes: [flowNode('My_Flow', 'My Flow')], edges: [] },
    ]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    const staleCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };

    const r = await resolveFlowRef(staleCtx, '301E00000000005');
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('surfaces a single low-confidence fuzzy candidate as an ambiguous envelope (never silently dropped)', async () => {
    // Querying a single meaningful token of a multi-token Flow name ("Widget",
    // one of the 3 tokens of Widget_Sync_Notification) is exactly the kind of
    // partial/keyword phrasing the tool must route from (spec's own example:
    // "show me the structure of My_Flow" / "what are the branches in this
    // flow"). The underlying `resolveComponents` DOES find the Flow — an exact
    // single-token match, base 1.0 — but reports it `disposition: 'ambiguous'`
    // (its own nameCoverage gate: "widget" only covers 1 of 3 name tokens, so it
    // can't be a confident sole `exact`). The resolver must surface that lone
    // candidate for confirmation — never auto-pick, never silently drop —
    // mirroring `sfi.resolve` (which surfaces `disposition: 'ambiguous'` verbatim
    // regardless of candidate count; see packages/mcp/src/tools/resolve.ts). §3.
    const r = await resolveFlowRef(ctx, 'Widget');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('ambiguous');
    if (r.value.outcome !== 'ambiguous') return;
    expect(r.value.requested).toBe('Widget');
    const ids = r.value.candidates.map((c) => c.componentId);
    expect(ids).toContain(WIDGET_FLOW_ID);
  });

  it('surfaces a sole strong single-token candidate rather than losing it (same class, different query)', async () => {
    // A second, independent repro of the same class using a different query
    // shape: a query that strongly matches ONE flow ("Notification", a token of
    // Widget_Sync_Notification) previously hit the single-candidate blind spot;
    // it must now come back as an ambiguous envelope carrying that candidate.
    const r = await resolveFlowRef(ctx, 'Notification');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('ambiguous');
    if (r.value.outcome !== 'ambiguous') return;
    const ids = r.value.candidates.map((c) => c.componentId);
    expect(ids).toContain(WIDGET_FLOW_ID);
  });
});

describe('resolveFlowRef — invalid input and misses', () => {
  it('rejects a wrong Type: prefix with invalid-query', async () => {
    const r = await resolveFlowRef(ctx, 'CustomObject:Account');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Flow:');
    expect(r.error.path).toBe('flowRef');
  });

  it('points at a same-named non-Flow (ApexTrigger) instead of a dead end', async () => {
    // Bare 'AccountTrigger' has no Flow (exact or fuzzy) but IS an ApexTrigger.
    const r = await resolveFlowRef(ctx, 'AccountTrigger');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain(ACCOUNT_TRIGGER_ID);
    expect(r.error.message).toMatch(/not a Flow/);
  });

  it('gives a plain not-found when nothing (Flow or other) matches', async () => {
    const r = await resolveFlowRef(ctx, 'Zzz_Unknown');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain('no Flow with id Flow:Zzz_Unknown');
  });

  it('does NOT fuzzy-fallback a canonical id that misses (exact-or-nothing)', async () => {
    // A caller who pinned a `Flow:` id gets a definitive not-found, never a
    // guessed neighbour — even though similarly-named Flows exist.
    const r = await resolveFlowRef(ctx, 'Flow:Ghost');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain('no Flow with id Flow:Ghost');
    expect(r.error.path).toBe('Flow:Ghost');
  });

  it('returns component-not-found when a Flow: id resolves to a non-Flow node', async () => {
    // Defensive: a Flow: id whose graph node is not a Flow. We seed a node with
    // a Flow: id but ApexTrigger type to exercise the type guard directly.
    const dir = mkdtempSync(join(tmpdir(), 'sfi-flow-ref-wt-'));
    const opened = await openGraph(join(dir, 'wt.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [
      {
        nodes: [
          makeNode({
            id: 'Flow:Mislabeled',
            type: 'ApexTrigger',
            apiName: 'Mislabeled',
            label: 'Mislabeled',
          }),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    const wtCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
    const r = await resolveFlowRef(wtCtx, 'Flow:Mislabeled');
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toMatch(/is not a Flow/);
  });
});
