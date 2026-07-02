/// <reference types="vitest/globals" />

// I6 — margin-based clarification. Two layers of coverage:
//   1. the pure `marginClarification` gate over synthetic candidates — every
//      axis, the threshold boundary, and each non-fire guard, drift-proof;
//   2. the real `routeQuestionHandler` over a fixture vault — proves the gate
//      is wired, fires on a genuine PLANE tie, stays quiet on clear routes and
//      in offline mode, and that a tool selection deterministically resumes.

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

import type { RouteClarification } from '../../src/intent-router.js';
import type { ToolCandidate } from '../../src/semantic-funnel.js';
import type { Context } from '../../src/server.js';
import { MARGIN, marginClarification, routeQuestionHandler } from '../../src/tools/route-question.js';

// --- synthetic candidate builder -------------------------------------------
const cand = (o: Partial<ToolCandidate> & Pick<ToolCandidate, 'tool' | 'score'>): ToolCandidate => ({
  category: null,
  plane: 'vault',
  liveRequired: false,
  confidence: 'medium',
  ...o,
});

describe('marginClarification — the pure I6 gate', () => {
  it('does NOT block on a vault/live plane near-tie (P4: resolvePlaneTie decides by live-signal)', () => {
    // Router-v2 P4: the plane axis no longer stops execution — the tie is
    // resolved by the question's own runtime-data language in resolvePlaneTie
    // (tested in router-v2-p4.test.ts). Only the risk axis still blocks.
    const clar = marginClarification(
      [
        cand({ tool: 'sfi.list_components', score: 0.30, plane: 'vault' }),
        cand({ tool: 'sfi.live_count', score: 0.28, plane: 'live', liveRequired: true }),
      ],
      null,
    );
    expect(clar).toBeNull();
  });

  it('FIRES on a destructive/informational risk near-tie', () => {
    const clar = marginClarification(
      [
        cand({ tool: 'sfi.safe_to_delete_field', score: 0.31, plane: 'vault' }),
        cand({ tool: 'sfi.get_impact', score: 0.30, plane: 'vault' }),
      ],
      null,
    );
    expect(clar?.required).toBe(true);
    expect(clar?.options).toEqual(['sfi.safe_to_delete_field', 'sfi.get_impact']);
    expect(clar?.question).toMatch(/DESTRUCTIVE/);
  });

  it('FIRES for the what_if_* family too (not just safe_to_delete)', () => {
    const clar = marginClarification(
      [
        cand({ tool: 'sfi.what_if_change_field_type', score: 0.40, plane: 'vault' }),
        cand({ tool: 'sfi.find_apex_usages', score: 0.39, plane: 'vault' }),
      ],
      null,
    );
    expect(clar?.required).toBe(true);
    expect(clar?.options).toEqual(['sfi.what_if_change_field_type', 'sfi.find_apex_usages']);
  });

  it('does NOT fire on a clear top-1 (margin wider than MARGIN)', () => {
    const clar = marginClarification(
      [
        cand({ tool: 'sfi.list_components', score: 0.60, plane: 'vault' }),
        cand({ tool: 'sfi.live_count', score: 0.60 - MARGIN - 0.001, plane: 'live', liveRequired: true }),
      ],
      null,
    );
    expect(clar).toBeNull();
  });

  it('does NOT fire on a same-plane, same-risk near-tie (benign)', () => {
    const clar = marginClarification(
      [
        cand({ tool: 'sfi.find_code_usages', score: 0.45, plane: 'vault' }),
        cand({ tool: 'sfi.find_apex_usages', score: 0.44, plane: 'vault' }),
      ],
      null,
    );
    expect(clar).toBeNull();
  });

  it('does NOT fire when both top candidates came from the regex route (coordinated plan)', () => {
    // e.g. an impact route deliberately stacking the simulation + the readout.
    const clar = marginClarification(
      [
        cand({ tool: 'sfi.safe_to_delete_field', score: 0.54, plane: 'vault', fromRoute: true }),
        cand({ tool: 'sfi.get_impact', score: 0.53, plane: 'vault', fromRoute: true }),
      ],
      null,
    );
    expect(clar).toBeNull();
  });

  it('does NOT double-block when a stronger clarification already stopped the route', () => {
    const existing: RouteClarification = {
      required: true,
      question: 'Which component did you mean?',
      options: ['CustomField:Account.Status__c', 'CustomField:Case.Status__c'],
    };
    const clar = marginClarification(
      [
        cand({ tool: 'sfi.safe_to_delete_field', score: 0.30, plane: 'vault' }),
        cand({ tool: 'sfi.get_impact', score: 0.29, plane: 'vault' }),
      ],
      existing,
    );
    expect(clar).toBeNull();
  });

  it('is exactly boundary-inclusive at MARGIN (fires) and exclusive beyond (silent) — risk axis', () => {
    const at = marginClarification(
      [
        cand({ tool: 'sfi.safe_to_delete_field', score: 0.50, plane: 'vault' }),
        cand({ tool: 'sfi.get_impact', score: 0.50 - MARGIN, plane: 'vault' }),
      ],
      null,
    );
    expect(at?.required).toBe(true); // top1 - top2 === MARGIN -> within
    const beyond = marginClarification(
      [
        cand({ tool: 'sfi.safe_to_delete_field', score: 0.50, plane: 'vault' }),
        cand({ tool: 'sfi.get_impact', score: 0.50 - MARGIN - 0.0001, plane: 'vault' }),
      ],
      null,
    );
    expect(beyond).toBeNull();
  });
});

// --- handler integration over a fixture vault ------------------------------
const M: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};
const n = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
  type: 'CustomObject',
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const seed: ExtractionResult = {
  nodes: [n({ id: 'CustomObject:Payment__c', apiName: 'Payment__c', label: 'Payment' })],
  edges: [],
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-margin-'));
  const opened = await openGraph(join(dir, 'margin.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: dir, manifest: M, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

describe('routeQuestionHandler — I6 margin gate wired end to end', () => {
  it('P4: a plane near-tie no longer blocks — "actually used" reports route LIVE deterministically', async () => {
    // Pre-P4 this phrasing BLOCKED on a plane near-tie (live_report_usage vs
    // find_code_usages). Run-history is live LastRunDate — the reports-usage
    // rule now routes it, and the plane axis never stops execution.
    const r = await routeQuestionHandler(ctx, { question: 'which reports are actually used', logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.executionBlocked).toBe(false);
    expect(r.value.data.route.intent).toBe('reports-usage');
    expect(r.value.data.route.tools).toContain('sfi.live_report_usage');
    expect(r.value.data.route.liveRequired).toBe(true);
  });

  it('fires on a genuine DESTRUCTIVE/read-only near-tie and offers the two divergent tools', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'removal simulation or usage readout for that field', logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.executionBlocked).toBe(true);
    const opts = r.value.data.route.clarification?.options ?? [];
    expect(opts).toContain('sfi.safe_to_delete_field');
    expect(opts).toContain('sfi.find_code_usages');
    expect(opts.every((o) => o.startsWith('sfi.'))).toBe(true);
  });

  it('does NOT block a clear vault route (goldset shape stays executable)', async () => {
    for (const question of [
      'what custom objects do we have',
      'what flows run on Account',
      'who can edit Contact.Email',
    ]) {
      const r = await routeQuestionHandler(ctx, { question, logGap: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.executionBlocked).toBe(false);
    }
  });

  it('resumes deterministically when the user picks one of the offered tools', async () => {
    const question = 'removal simulation or usage readout for that field';
    const first = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clarificationId = first.value.data.route.clarification?.id as string;
    expect(clarificationId).toBeDefined();

    const resumed = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: { clarificationId, selection: 'sfi.safe_to_delete_field' },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.data.executionBlocked).toBe(false);
    expect(resumed.value.data.route.clarification).toBeNull();
    expect(resumed.value.data.route.tools).toContain('sfi.safe_to_delete_field');
    expect(resumed.value.data.clarificationResolution).toEqual({
      clarificationId,
      selection: 'sfi.safe_to_delete_field',
      kind: 'tool',
    });
  });

  it('rejects a tool selection that was not one of the offered options', async () => {
    const question = 'removal simulation or usage readout for that field';
    const first = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clarificationId = first.value.data.route.clarification?.id as string;
    const bad = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: { clarificationId, selection: 'sfi.what_if_merge_profiles' },
    });
    expect(bad.ok).toBe(false);
  });

  it('never blocks in offline mode — the deterministic route is authoritative', async () => {
    const prev = process.env.SFI_ROUTER_MODE;
    process.env.SFI_ROUTER_MODE = 'offline';
    try {
      const r = await routeQuestionHandler(ctx, { question: 'which reports are actually used', logGap: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.executionBlocked).toBe(false);
      expect(r.value.data.toolCandidates).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SFI_ROUTER_MODE;
      else process.env.SFI_ROUTER_MODE = prev;
    }
  });
});
