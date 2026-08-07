/// <reference types="vitest/globals" />

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import { appendAnnotationEvent } from '@sf-intelligence/vault';

import { classifyQuestion, type RouteResult } from '../../src/intent-router.js';
import type { Context } from '../../src/server.js';
import {
  buildFunnelCandidates,
  buildRouteToolArgsMap,
  FUNNEL_PRIMARY_MIN_SCORE,
  looksLikeComponentName,
  routeQuestionHandler,
} from '../../src/tools/route-question.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
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
  nodes: [
    node({ id: 'CustomObject:Payment__c', apiName: 'Payment__c', label: 'Payment' }),
    node({ id: 'CustomField:Payment__c.Status__c', type: 'CustomField', apiName: 'Status__c', label: 'Status', parentId: 'CustomObject:Payment__c' }),
    node({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
    node({ id: 'CustomField:Account.Status__c', type: 'CustomField', apiName: 'Status__c', label: 'Status', parentId: 'CustomObject:Account' }),
    node({ id: 'CustomObject:Case', apiName: 'Case', label: 'Case' }),
    node({ id: 'CustomField:Case.Status__c', type: 'CustomField', apiName: 'Status__c', label: 'Status', parentId: 'CustomObject:Case' }),
    // Synthetic Flow + a similarly-named calculation flow, so a comparison-clause
    // ("is it the same as the bar calc?") gives the fuzzy resolver a rival to
    // pick up — the shape RESIDUAL 1 fixes (a clean explain-flow must not block).
    node({ id: 'Flow:Foo_Bar_Flow', type: 'Flow', apiName: 'Foo_Bar_Flow', label: 'Foo Bar Flow' }),
    node({ id: 'Flow:Bar_Calc_Flow', type: 'Flow', apiName: 'Bar_Calc_Flow', label: 'Bar Calc' }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-route-'));
  const opened = await openGraph(join(tempDir, 'route.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  const annotationAt = '2026-06-11T18:00:00.000Z';
  await appendAnnotationEvent(tempDir, {
    componentId: 'CustomField:Payment__c.Status__c',
    key: 'glossary',
    value: 'checkout state field',
    author: 'test',
    source: 'human',
    confirmed: true,
    at: annotationAt,
    op: 'set',
  });
  for (const componentId of ['CustomField:Account.Status__c', 'CustomField:Case.Status__c']) {
    await appendAnnotationEvent(tempDir, {
      componentId,
      key: 'glossary',
      value: 'shared state field',
      author: 'test',
      source: 'human',
      confirmed: true,
      at: annotationAt,
      op: 'set',
    });
  }
  await appendAnnotationEvent(tempDir, {
    componentId: 'CustomObject:Payment__c',
    key: 'glossary',
    value: 'secret ledger object',
    author: 'ai',
    source: 'ai',
    confirmed: false,
    at: annotationAt,
    op: 'set',
  });
  await appendAnnotationEvent(tempDir, {
    componentId: 'CustomObject:Account',
    key: 'glossary',
    value: 'Payment__c',
    author: 'test',
    source: 'human',
    confirmed: true,
    at: annotationAt,
    op: 'set',
  });
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('routeQuestionHandler — bare-component resolve fallback (P10-A5)', () => {
  it('rescues a short phrase that names a real component to sfi.resolve on the vault plane', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'payment object', logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const route = r.value.data.route;
    expect(route.plane).toBe('vault');
    expect(['component-lookup', 'resolve-lookup']).toContain(route.intent);
    expect(route.tools).toContain('sfi.resolve');
    expect(route.gap).toBeNull(); // no longer a capability gap
    if (route.intent === 'component-lookup') {
      expect(route.suggestedArgs).toEqual({ query: 'payment object' });
    }
  });

  it('keeps a short phrase that resolves to NOTHING as honest unknown', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'blorp glorp shmorp', logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const route = r.value.data.route;
    expect(route.plane).toBe('unknown');
    expect(route.intent).toBe('unrouted');
    expect(route.gap).not.toBeNull();
  });

  it('does NOT apply the resolve fallback to a long phrase even when a token would resolve (token cap)', async () => {
    // The fallback only ever emits intent 'component-lookup'. A >3-token phrase
    // must never trigger it — whether a rule routes it or it stays unknown.
    const r = await routeQuestionHandler(ctx, { question: 'please show me every payment object right now', logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).not.toBe('component-lookup');
  });

  it('leaves a genuinely-routed question untouched (no false rescue)', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'what custom objects do we have', logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const route = r.value.data.route;
    expect(route.plane).not.toBe('unknown');
    expect(route.intent).not.toBe('component-lookup');
  });
});

describe('routeQuestionHandler — RESIDUAL 1: comparison aside must not block a single-entity explain', () => {
  it('routes explain-flow clean when a trailing "is it the same as X" aside names a second flow', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'explain the Foo_Bar_Flow flow, is it the same as the bar calc?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The comparison target ("bar calc") must NOT seed a rival entity: the
    // primary flow resolves exact and the question routes clean, not blocked.
    expect(r.value.data.route.intent).toBe('explain-flow');
    expect(r.value.data.executionBlocked).toBe(false);
    expect(r.value.data.route.clarification).toBeNull();
    // P4: the underscored api token is captured bare (no trailing type noun).
    expect(r.value.data.entityEvidence?.query).toBe('Foo_Bar_Flow');
    expect(r.value.data.entityEvidence?.disposition).toBe('exact');
    expect(r.value.data.entityEvidence?.clarificationRequired).toBe(false);
  });
});

describe('routeQuestionHandler — enterprise routing evidence', () => {
  it('P4: a complementary intent pair STACKS instead of blocking; a genuine split still stops', async () => {
    // impact-analysis|safe-to-delete is complementary — both reads answer, so
    // the tools stack and execution proceeds (router-v2 P4).
    const stacked = await routeQuestionHandler(ctx, {
      question: 'What breaks if I delete the Account field?',
      logGap: false,
    });
    expect(stacked.ok).toBe(true);
    if (!stacked.ok) return;
    expect(stacked.value.data.route.alternatives.length).toBeGreaterThan(0);
    expect(stacked.value.data.route.clarification).toBeNull();
    expect(stacked.value.data.executionBlocked).toBe(false);
    expect(stacked.value.data.route.tools).toContain('sfi.safe_to_delete_field');
    // runtime-audit-trail|last-modified WITHOUT a named component genuinely
    // diverges (record forensics vs metadata stamp) and still blocks.
    const blocked = await routeQuestionHandler(ctx, {
      question: 'Who changed Account?',
      logGap: false,
    });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.value.data.route.clarification?.required).toBe(true);
    expect(blocked.value.data.executionBlocked).toBe(true);
    expect(blocked.value.data.rendered).toContain('Stop before executing');
  });

  it('attaches vault-backed entity evidence for a named component', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'payment object', logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entityEvidence?.disposition).toBe('exact');
    expect(r.value.data.entityEvidence?.query).toBe('payment object');
    expect(r.value.data.entityEvidence?.typeHints).toEqual(['CustomObject']);
    expect(r.value.data.entityEvidence?.clarificationRequired).toBe(false);
    expect(r.value.data.entityEvidence?.candidates[0]?.componentId).toBe('CustomObject:Payment__c');
  });

  it('does not resolve the entire sentence and create false entity ambiguity', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'find dead code', logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entityEvidence).toBeUndefined();
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('treats a unique literal canonical-id match as exact despite fuzzy neighbours', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'who can edit Payment__c.Status__c',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entityEvidence?.query).toBe('Payment__c.Status__c');
    expect(r.value.data.entityEvidence?.typeHints).toEqual(['CustomField']);
    expect(r.value.data.entityEvidence?.disposition).toBe('exact');
    expect(r.value.data.entityEvidence?.candidates[0]?.componentId).toBe('CustomField:Payment__c.Status__c');
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('still stops when a short field name has multiple literal candidates', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'who can edit the Status field',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entityEvidence?.disposition).toBe('ambiguous');
    expect(r.value.data.entityEvidence?.clarificationRequired).toBe(true);
    expect(r.value.data.executionBlocked).toBe(true);
  });

  it('an object qualifier SCOPES the field — resolver exact, no cross-object menu (Family A)', async () => {
    // Status__c exists on Payment__c, Account, AND Case. Unqualified, that is
    // genuine ambiguity (test above). Qualified with "on Case" the resolver is
    // handed the parent-scoped dotted form and reports exact — emitting the
    // "Several components match" block for a stated object is an over-clarify.
    const r = await routeQuestionHandler(ctx, {
      question: 'who can edit Status__c on Case',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entityEvidence?.query).toBe('Case.Status__c');
    expect(r.value.data.entityEvidence?.disposition).toBe('exact');
    expect(r.value.data.entityEvidence?.candidates[0]?.componentId).toBe(
      'CustomField:Case.Status__c',
    );
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('uses a confirmed org glossary alias in front-door entity routing', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'who can edit the checkout state field',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entityEvidence?.disposition).toBe('exact');
    expect(r.value.data.entityEvidence?.candidates[0]?.componentId).toBe(
      'CustomField:Payment__c.Status__c',
    );
    expect(r.value.data.entityEvidence?.candidates[0]?.matchKind).toBe('glossary-alias');
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('stops when a confirmed org glossary alias points at multiple components', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'who can edit the shared state field',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entityEvidence?.disposition).toBe('ambiguous');
    expect(r.value.data.entityEvidence?.clarificationRequired).toBe(true);
    expect(r.value.data.route.clarification?.options).toEqual(
      expect.arrayContaining([
        'CustomField:Account.Status__c',
        'CustomField:Case.Status__c',
      ]),
    );
    expect(r.value.data.executionBlocked).toBe(true);
  });

  it('ignores unconfirmed AI glossary proposals in front-door routing', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'who can access the secret ledger object',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.entityEvidence?.candidates.some(
        (candidate) => candidate.matchKind === 'glossary-alias',
      ) ?? false,
    ).toBe(false);
  });

  it('never lets a confirmed glossary alias shadow an exact API name', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'who can access Payment__c',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entityEvidence?.disposition).toBe('exact');
    expect(r.value.data.entityEvidence?.candidates[0]?.componentId).toBe(
      'CustomObject:Payment__c',
    );
    expect(r.value.data.entityEvidence?.candidates[0]?.matchKind).not.toBe('glossary-alias');
  });

  it('builds distinct steps for an explicit compound question', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'What happens when Account is updated; who can edit Account?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.plan.map((step) => step.intent)).toContain('trigger-order');
    expect(r.value.data.route.plan.map((step) => step.intent)).toContain('field-access');
    expect(r.value.data.route.plan.every((step) => step.dependsOn.length === 0)).toBe(true);
    expect(r.value.data.route.clarification).toBeNull();
    expect(r.value.data.executionBlocked).toBe(false);
  });

  // ROUTE-COMPOUND-DROPS-GUEST-CLAUSE — a compound "which layout … and can guest
  // users see X too?" must STACK the guest-exposure tool in the executable plan,
  // not silent-drop the second clause (the funnel already surfaced it, but the
  // deterministic plan dropped it because the guest clause routed to `unknown`).
  it('stacks guest_exposure_report alongside layout_for_user for a compound layout+guest question', async () => {
    const r = await routeQuestionHandler(ctx, {
      question:
        'A Faculty user cannot see a Case, which layout do they get, and can guest users see Cases too?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const planIntents = r.value.data.route.plan.map((step) => step.intent);
    expect(planIntents).toContain('layout-access');
    expect(planIntents).toContain('guest-exposure');
    const planTools = r.value.data.route.plan.flatMap((step) => step.tools);
    expect(planTools).toContain('sfi.layout_for_user');
    expect(planTools).toContain('sfi.guest_exposure_report');
    expect(r.value.data.executionBlocked).toBe(false);
    expect(r.value.data.route.clarification).toBeNull();
  });

  it('marks then-linked compound steps as dependent', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'Find Account, then show its blast radius',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.plan.map((step) => step.intent)).toEqual([
      'resolve-lookup',
      'impact-analysis',
    ]);
    expect(r.value.data.route.plan[0]?.dependsOn).toEqual([]);
    expect(r.value.data.route.plan[1]?.dependsOn).toEqual(['step-1']);
    expect(r.value.data.rendered).toContain('after `step-1`');
  });

  it('plans elliptical metadata inventory plus live per-object record counts', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'How many custom objects do we have and how many records does each hold?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.plane).toBe('hybrid');
    expect(r.value.data.route.liveRequired).toBe(true);
    expect(r.value.data.route.tools).toEqual([
      'sfi.list_components',
      'sfi.live_storage_by_object',
    ]);
    expect(r.value.data.route.suggestedArgs).toEqual({ type: 'CustomObject' });
    expect(r.value.data.route.plan.map((step) => step.intent)).toEqual([
      'metadata-count',
      'storage-by-object',
    ]);
    expect(r.value.data.route.plan.every((step) => step.dependsOn.length === 0)).toBe(true);
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('resumes deterministically with an offered alternative intent', async () => {
    // P4: the impact pairs stack (no clarification), so the intent-continuation
    // contract is exercised on the still-blocking runtime/metadata pair.
    const question = 'Who changed Account?';
    const first = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clarificationId = first.value.data.route.clarification?.id;
    expect(clarificationId).toBeDefined();

    const resumed = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: {
        clarificationId: clarificationId as string,
        selection: 'last-modified',
      },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.data.route.intent).toBe('last-modified');
    expect(resumed.value.data.route.confidence).toBe('high');
    expect(resumed.value.data.route.clarification).toBeNull();
    expect(resumed.value.data.executionBlocked).toBe(false);
    expect(resumed.value.data.clarificationResolution).toEqual({
      clarificationId,
      selection: 'last-modified',
      kind: 'intent',
    });
  });

  it('rejects stale clarification ids and invented selections', async () => {
    const question = 'Who changed Account?';
    const first = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clarificationId = first.value.data.route.clarification?.id as string;

    const stale = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: {
        clarificationId: 'stale-challenge',
        selection: 'last-modified',
      },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe('invalid-query');

    const invented = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: {
        clarificationId,
        selection: 'delete-it-now',
      },
    });
    expect(invented.ok).toBe(false);
    if (!invented.ok) expect(invented.error.kind).toBe('invalid-query');
  });

  it('resumes with an explicitly selected canonical entity', async () => {
    const question = 'who can edit the Status field';
    const first = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clarificationId = first.value.data.route.clarification?.id as string;
    const selection = 'CustomField:Payment__c.Status__c';
    expect(first.value.data.route.clarification?.options).toContain(selection);

    const resumed = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: { clarificationId, selection },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.data.executionBlocked).toBe(false);
    expect(resumed.value.data.route.needsResolve).toBe(false);
    expect(resumed.value.data.route.tools).not.toContain('sfi.resolve');
    expect(resumed.value.data.route.suggestedArgs).toEqual({ fieldId: selection });
    expect(resumed.value.data.entityEvidence?.selectedComponentId).toBe(selection);
    expect(resumed.value.data.clarificationResolution?.kind).toBe('entity');
  });

  it('rejects a clarification response when no clarification is active', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'show me the org card',
      logGap: false,
      clarificationResponse: {
        clarificationId: 'not-applicable',
        selection: 'org-card',
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });
});

describe('core-profile gateway envelopes (P13-GW-router-envelope)', () => {
  afterEach(() => {
    delete process.env['SFI_TOOL_PROFILE'];
  });

  it('emits invoke[] under core: non-core tools wrapped in run_analysis, suggestedArgs threaded to the primary', async () => {
    process.env['SFI_TOOL_PROFILE'] = 'core';
    // what-happens-on-save routes to a NON-core tool and derives suggestedArgs
    // (the DML event) — both behaviors must survive the envelope.
    const r = await routeQuestionHandler(ctx, {
      question: 'What happens when an Account is updated?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, invoke } = r.value.data;
    expect(invoke).toBeDefined();
    expect(invoke).toHaveLength(route.tools.length);
    // The resolve preamble (a core tool) stays a direct call with NO args —
    // suggestedArgs belong to the primary answering tool, not resolve.
    const resolveIdx = route.tools.indexOf('sfi.resolve');
    if (resolveIdx !== -1) {
      expect(invoke?.[resolveIdx]).toEqual({ tool: 'sfi.resolve', args: {} });
    }
    const primaryIdx = route.tools.findIndex((t) => t !== 'sfi.resolve');
    const primary = invoke?.[primaryIdx];
    expect(primary?.tool).toBe('sfi.run_analysis');
    const inner = primary?.args as { readonly name: string; readonly args: Record<string, unknown> };
    expect(inner.name).toBe(route.tools[primaryIdx]);
    expect(inner.args).toEqual(route.suggestedArgs ?? {});
  });

  it('keeps core-roster tools as direct calls under core', async () => {
    process.env['SFI_TOOL_PROFILE'] = 'core';
    const r = await routeQuestionHandler(ctx, {
      question: 'show me the org card',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.invoke?.[0]).toEqual({ tool: 'sfi.org_card', args: {} });
  });

  it('withholds executable calls when clarification is required', async () => {
    process.env['SFI_TOOL_PROFILE'] = 'core';
    const r = await routeQuestionHandler(ctx, {
      question: 'Who changed Account?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.executionBlocked).toBe(true);
    expect(r.value.data.invoke).toBeUndefined();
  });

  it('emits executable calls after a validated clarification response', async () => {
    process.env.SFI_TOOL_PROFILE = 'core';
    const question = 'Who changed Account?';
    const first = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clarificationId = first.value.data.route.clarification?.id as string;

    const resumed = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: { clarificationId, selection: 'last-modified' },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.data.executionBlocked).toBe(false);
    expect(resumed.value.data.invoke).toBeDefined();
  });

  it('binds an explicitly selected entity into the executable primary call', async () => {
    process.env.SFI_TOOL_PROFILE = 'core';
    const question = 'who can edit the Status field';
    const first = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clarificationId = first.value.data.route.clarification?.id as string;
    const selection = 'CustomField:Payment__c.Status__c';

    const resumed = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: { clarificationId, selection },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const primary = resumed.value.data.invoke?.[0];
    expect(primary?.tool).toBe('sfi.run_analysis');
    expect(primary?.args).toEqual({
      name: 'sfi.field_access_audit',
      args: { fieldId: selection },
    });
  });

  it('emits executable calls for a mixed inventory and live-storage plan', async () => {
    process.env.SFI_TOOL_PROFILE = 'core';
    const r = await routeQuestionHandler(ctx, {
      question: 'How many custom objects do we have and how many records does each hold?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.invoke).toEqual([
      { tool: 'sfi.list_components', args: { type: 'CustomObject' } },
      {
        tool: 'sfi.run_analysis',
        args: { name: 'sfi.live_storage_by_object', args: {} },
      },
    ]);
  });

  it.each([
    {
      question: 'How many users are assigned to the System Administrator profile?',
      expected: {
        tool: 'sfi.run_analysis',
        args: {
          name: 'sfi.live_group_count',
          args: { objectApiName: 'User', groupByField: 'ProfileId' },
        },
      },
    },
    {
      question: 'Are there any inactive validation rules on the Account object?',
      expected: {
        tool: 'sfi.list_components',
        args: { type: 'ValidationRule' },
      },
    },
    {
      question: 'Which Apex classes have not been modified in over two years?',
      expected: {
        tool: 'sfi.list_components',
        args: { type: 'ApexClass' },
      },
    },
    {
      question: 'Find hardcoded IDs across formulas and validation rules',
      expected: {
        tool: 'sfi.run_analysis',
        args: {
          name: 'sfi.find_hardcoded_values_anywhere',
          args: { category: 'id' },
        },
      },
    },
    {
      question: 'How many reports exist in this org?',
      expected: {
        tool: 'sfi.list_components',
        args: { type: 'Report' },
      },
    },
    {
      question: 'Which pages have the most components and slowest load times?',
      expected: {
        tool: 'sfi.list_components',
        args: { type: 'FlexiPage' },
      },
    },
  ])('emits executable required args for $question', async ({ question, expected }) => {
    process.env.SFI_TOOL_PROFILE = 'core';
    const r = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.invoke).toEqual([expected]);
  });

  it('emits both executable calls for hybrid integration capacity risk', async () => {
    process.env.SFI_TOOL_PROFILE = 'core';
    const r = await routeQuestionHandler(ctx, {
      question: 'What API limits are at risk given current integration volume?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.plane).toBe('hybrid');
    expect(r.value.data.invoke).toEqual([
      {
        tool: 'sfi.run_analysis',
        args: { name: 'sfi.integration_map', args: {} },
      },
      {
        tool: 'sfi.run_analysis',
        args: { name: 'sfi.live_org_limits', args: {} },
      },
    ]);
  });

  it('omits invoke entirely under an explicit full profile', async () => {
    // Unset no longer means full (AUDIT-F6 defaulted SFI_TOOL_PROFILE=core).
    process.env['SFI_TOOL_PROFILE'] = 'full';
    const r = await routeQuestionHandler(ctx, {
      question: 'What happens when an Account is updated?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('invoke' in r.value.data).toBe(false);
  });

  it('attaches semantic toolCandidates when no deterministic intent matches (CAE-01 funnel)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'where does Pranav have access to',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Router-v2 P2: this phrasing's pure-funnel top clears the advisory
    // threshold, so the previously dead 'unrouted' is upgraded to the advisory
    // funnel route — the candidates below are still the primary output.
    expect(r.value.data.route.intent).toBe('funnel-advisory');
    expect(r.value.data.route.confidence).toBe('low');
    const candidates = r.value.data.toolCandidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    const tools = candidates.map((c) => c.tool);
    expect(
      tools.some((t) =>
        [
          'sfi.why_cant_user_see_record',
          'sfi.field_access_audit',
          'sfi.crud_fls_audit',
          'sfi.generate_sharing_summary',
          'sfi.unassigned_permission_sets',
        ].includes(t),
      ),
    ).toBe(true);
    // The rendered markdown surfaces them too, so a prose-reading host sees them.
    expect(r.value.data.rendered).toContain('Candidate tools');
    // CAE-02 planner contract travels with the candidates.
    expect(r.value.data.guidance).toContain('sfi.synthesize_answer');
    expect(r.value.data.guidance).toContain('YOU decide');
  });

  it('omits toolCandidates and guidance for gibberish (no false candidates)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'zxqw plkj vbnm',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('toolCandidates' in r.value.data).toBe(false);
    expect('guidance' in r.value.data).toBe(false);
  });

  it('mode=plan attaches candidates led by the plan family, even on a routed question (CAE-04)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'what breaks if I delete the Status field on Payment',
      logGap: false,
      mode: 'plan',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tools = (r.value.data.toolCandidates ?? []).map((c) => c.tool);
    expect(tools.length).toBeGreaterThan(0);
    expect(r.value.data.guidance).toContain('PLAN mode');
    const planFamily = /^sfi\.(what_if_|get_impact|safe_to_delete|downstream_effects|field_lineage|tests_for_change)/;
    expect(tools.some((t) => planFamily.test(t))).toBe(true);
    expect(planFamily.test(tools[0]!)).toBe(true); // the family leads
  });

  it('mode=assessment yields assessment guidance + candidates (CAE-04)', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'how risky is this org', logGap: false, mode: 'assessment' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.guidance).toContain('ASSESSMENT mode');
    expect((r.value.data.toolCandidates ?? []).length).toBeGreaterThan(0);
  });

  it('mode=ask yields concise-ask guidance (CAE-04)', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'what fields are on Account', logGap: false, mode: 'ask' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.guidance).toContain('ASK mode');
  });

  // CAE-03b: the funnel is PRIMARY in the default hybrid mode — candidates +
  // guidance ride with EVERY routable question, including a confident route, and
  // the regex route is demoted to a non-authoritative hint.
  it('attaches candidates + guidance even on a confidently-routed question (CAE-03b hybrid)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'What happens when an Account is updated?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The regex still routes it (the hint) — it is NOT unrouted...
    expect(r.value.data.route.intent).not.toBe('unrouted');
    // ...yet the funnel candidates are surfaced anyway, as the primary output.
    expect((r.value.data.toolCandidates ?? []).length).toBeGreaterThan(0);
    expect(r.value.data.guidance).toContain('YOU decide');
    expect(r.value.data.rendered).toContain('Candidate tools');
  });

  it('promotes regex route tools + suggestedArgs into toolCandidates for metadata-count', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'How many custom fields are on Contact?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('metadata-count');
    const listComponents = (r.value.data.toolCandidates ?? []).find(
      (c) => c.tool === 'sfi.list_components',
    );
    expect(listComponents).toBeDefined();
    expect(listComponents?.fromRoute).toBe(true);
    expect(listComponents?.suggestedArgs).toEqual({
      type: 'CustomField',
      parentId: 'CustomObject:Contact',
    });
    // I2b — the regex route is a BOUNDED additive feature, not a flat 0.96 pin.
    // list_components is a strong meaning match here (cosine ~0.21), so its FUSED
    // score is well above the ~0.055 bonus floor yet well BELOW the old 0.96
    // re-pin — a genuine cosine+bonus blend, not an override.
    const score = listComponents?.score ?? 0;
    expect(score).toBeGreaterThan(0.055 + 0.1); // clearly above the bonus floor: it earned real cosine
    expect(score).toBeLessThan(0.96); // NOT the old flat pin
    // ...and it still leads every non-route candidate (the route tool is favored,
    // just not by an unbounded override).
    const nonRouteTop = Math.max(
      0,
      ...(r.value.data.toolCandidates ?? [])
        .filter((c) => c.fromRoute !== true)
        .map((c) => c.score),
    );
    expect(score).toBeGreaterThan(nonRouteTop);
  });

  it('emits field_mapping invoke args with object pair and vault alias from config', async () => {
    const prev = process.env.SFI_TOOL_PROFILE;
    process.env.SFI_TOOL_PROFILE = 'core';
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const metaDir = join(tempDir, 'meta');
      await mkdir(metaDir, { recursive: true });
      await writeFile(
        join(metaDir, 'config.json'),
        JSON.stringify({ targetOrg: 'fixture-vault', vaultRoot: tempDir, version: '0.1.0' }),
        'utf8',
      );
      const r = await routeQuestionHandler(ctx, {
        question: 'How do fields map between Lead and Contact?',
        logGap: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.route.intent).toBe('field-mapping');
      expect(r.value.data.invoke?.[0]).toEqual({
        tool: 'sfi.run_analysis',
        args: {
          name: 'sfi.field_mapping_between_objects',
          args: { objectA: 'Lead', objectB: 'Contact', vault: 'fixture-vault' },
        },
      });
    } finally {
      if (prev === undefined) delete process.env.SFI_TOOL_PROFILE;
      else process.env.SFI_TOOL_PROFILE = prev;
    }
  });

  // CAE-03b: SFI_ROUTER_MODE=offline is the deterministic Design-A fallback for
  // no-LLM / CI / air-gapped hosts — the regex route is authoritative and the
  // funnel candidates are omitted (even when a mode is requested).
  it('SFI_ROUTER_MODE=offline omits candidates + guidance (CAE-03b deterministic fallback)', async () => {
    const prev = process.env.SFI_ROUTER_MODE;
    process.env.SFI_ROUTER_MODE = 'offline';
    try {
      const r = await routeQuestionHandler(ctx, {
        question: 'where does Pranav have access to',
        logGap: false,
        mode: 'plan',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // The deterministic route is still returned (authoritative)...
      expect(r.value.data.route).toBeDefined();
      // ...but no funnel candidates / guidance, even with a mode set.
      expect('toolCandidates' in r.value.data).toBe(false);
      expect('guidance' in r.value.data).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SFI_ROUTER_MODE;
      else process.env.SFI_ROUTER_MODE = prev;
    }
  });
});

describe('routeQuestionHandler — gap logging is privacy-first opt-in (CR-16b)', () => {
  let gapDir: string;
  let gapLogPath: string;
  let priorEnv: string | undefined;

  beforeEach(() => {
    priorEnv = process.env.SFI_GAP_LOG_PATH;
    gapDir = mkdtempSync(join(tmpdir(), 'sfi-route-gap-'));
    gapLogPath = join(gapDir, 'question-gaps.jsonl');
    process.env.SFI_GAP_LOG_PATH = gapLogPath;
  });

  afterEach(() => {
    if (priorEnv === undefined) delete process.env.SFI_GAP_LOG_PATH;
    else process.env.SFI_GAP_LOG_PATH = priorEnv;
    rmSync(gapDir, { recursive: true, force: true });
  });

  it('does NOT write the gap log when logGap is omitted (privacy-first default off)', async () => {
    const r = await routeQuestionHandler(ctx, { question: 'blorp glorp shmorp' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Precondition: this unrouted question really does carry a gap, so a write
    // WOULD happen under the old opt-out default — making the test meaningful.
    expect(r.value.data.route.gap).not.toBeNull();
    // Privacy-first: nothing written, gapLogged false, file never created.
    expect(r.value.data.gapLogged).toBe(false);
    expect(existsSync(gapLogPath)).toBe(false);
  });

  it('writes the gap log only when the caller explicitly opts in with logGap:true', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'blorp glorp shmorp',
      logGap: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.gap).not.toBeNull();
    expect(r.value.data.gapLogged).toBe(true);
    expect(existsSync(gapLogPath)).toBe(true);
    const lines = readFileSync(gapLogPath, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0] ?? '{}') as { question?: string };
    expect(written.question).toBe('blorp glorp shmorp');
  });
});

describe('routeQuestionHandler — I3a live-plane consent disclosure in guidance', () => {
  it('discloses the live plane + consent step when a leading candidate is liveRequired', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'How many open Cases in the org?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A live-record-count question routes to the live plane.
    expect(r.value.data.route.plane).toBe('live');
    const cands = r.value.data.toolCandidates ?? [];
    // The shortlist leads with at least one liveRequired candidate (I1 field).
    expect(cands.slice(0, 3).some((c) => c.liveRequired === true)).toBe(true);
    const guidance = r.value.data.guidance ?? '';
    // The guidance must name the live plane, refuse to invent a number, and name
    // the concrete consent step — so a host LLM cannot answer from the vault.
    expect(guidance).toMatch(/LIVE PLANE/i);
    expect(guidance).toMatch(/liveRequired/);
    expect(guidance).toMatch(/sfi\.live_consent/);
    expect(guidance).toMatch(/Do NOT invent/i);
  });

  it('generalizes across the live bucket — a live field-population question also discloses consent', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'How many Contact records actually have the Email field populated right now?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cands = r.value.data.toolCandidates ?? [];
    // Only assert the disclosure when a leading candidate is in fact live-required,
    // so the test pins the MECHANISM (any leading live candidate → disclose), not a
    // single phrasing's routing.
    if (cands.slice(0, 3).some((c) => c.liveRequired === true)) {
      expect(r.value.data.guidance ?? '').toMatch(/sfi\.live_consent/);
    }
  });

  it('does NOT attach the consent disclosure to a pure vault question', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'what custom objects do we have',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cands = r.value.data.toolCandidates ?? [];
    // Sanity: this is a vault question — no leading live-required candidate.
    expect(cands.slice(0, 3).every((c) => c.liveRequired !== true)).toBe(true);
    const guidance = r.value.data.guidance ?? '';
    expect(guidance).not.toMatch(/LIVE PLANE/i);
    expect(guidance).not.toMatch(/sfi\.live_consent/);
  });
});

describe('routeQuestionHandler — schema nouns are intent signals, not entity lookups (Family A)', () => {
  it('save-order phrasing full of bare nouns routes clean — no ApexTrigger menu', async () => {
    // "the Case trigger" is intent vocabulary for the save-order question, not
    // a named component. Pre-fix the extractor sent the whole noun phrase to
    // the resolver and blocked on a menu of unrelated ApexTriggers.
    const r = await routeQuestionHandler(ctx, {
      question: 'Which flows fire before the Case trigger and which run after?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('trigger-order');
    expect(r.value.data.route.tools).toContain('sfi.what_happens_on_save');
    expect(r.value.data.executionBlocked).toBe(false);
    expect(r.value.data.route.clarification).toBeNull();
  });

  it('resolves ONLY the object a save-order intent needs (exact, CustomObject-typed)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question:
        'what actually happens on save for a Case — every trigger, flow, and validation rule',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('trigger-order');
    expect(r.value.data.route.suggestedArgs).toEqual({ event: 'update', objectApiName: 'Case' });
    expect(r.value.data.entityEvidence?.query).toBe('Case');
    expect(r.value.data.entityEvidence?.typeHints).toEqual(['CustomObject']);
    expect(r.value.data.entityEvidence?.disposition).toBe('exact');
    expect(r.value.data.entityEvidence?.candidates[0]?.componentId).toBe('CustomObject:Case');
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('"List every profile with delete permission on Contact" routes clean to who_can_access_object', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'List every profile with delete permission on Contact',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('who-can-access-object');
    expect(r.value.data.route.tools).toContain('sfi.who_can_access_object');
    // The bare noun "profile" must not become an entity lookup.
    expect(r.value.data.entityEvidence).toBeUndefined();
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('"Show me every profile that can access Case" routes clean to who_can_access_object', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'Show me every profile that can access Case',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('who-can-access-object');
    expect(r.value.data.entityEvidence).toBeUndefined();
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('"What is a Profile?" routes to the knowledge concept, never a Profile-record menu', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'What is a Profile?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('guidance');
    expect(r.value.data.route.plane).toBe('knowledge');
    expect(r.value.data.entityEvidence).toBeUndefined();
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('lowercase "difference between a profile and a permission set" compares concepts — no entity menu', async () => {
    // Pinned to compare-profiles by the access-surface fixture; the Family A
    // fix is that the generic type words never reach the resolver.
    const r = await routeQuestionHandler(ctx, {
      question: 'difference between a profile and a permission set',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('compare-profiles');
    expect(r.value.data.entityEvidence).toBeUndefined();
    expect(r.value.data.executionBlocked).toBe(false);
  });
});

// Router-v2 P2 §3 — FUNNEL-PRIMARY advisory fallback. Positive + every
// negative precondition (threshold, margin-gate precedence, premise check),
// plus the §4 floor invariant (T7). Synthetic paraphrases of labeled 2K
// misses; scores verified against the real funnel index.
describe('routeQuestionHandler — funnel-primary advisory fallback (P2 §3)', () => {
  it('POSITIVE: an unrouted question whose pure-funnel top clears the threshold becomes funnel-advisory', async () => {
    // Synthetic paraphrase of a labeled unrouted miss (naming-convention ask,
    // topScore 0.376 ≥ 0.33): no regex rule matches, nothing else blocks.
    const r = await routeQuestionHandler(ctx, {
      question: 'are the naming conventions in this org consistent or a total free-for-all',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, executionBlocked, toolCandidates } = r.value.data;
    expect(route.intent).toBe('funnel-advisory');
    expect(route.tools.length).toBeGreaterThan(0);
    expect(route.tools.length).toBeLessThanOrEqual(3);
    expect(route.tools[0]).toBe('sfi.get_naming_convention_report');
    expect(route.confidence).toBe('low'); // low by construction
    expect(route.reason).toContain('FUNNEL-DERIVED');
    expect(route.gap).toBeNull(); // routed now — no unrouted gap
    expect(route.clarification).toBeNull();
    expect(executionBlocked).toBe(false);
    expect(route.plan).toHaveLength(1);
    expect(route.plan[0]?.tools).toEqual(route.tools);
    // The response candidates are the SAME list the gate scored (computed once).
    expect((toolCandidates ?? [])[0]?.tool).toBe('sfi.get_naming_convention_report');
  });

  it('THRESHOLD (owner-accepted): vague vibe/setup ask advisories above FUNNEL_PRIMARY_MIN_SCORE', async () => {
    // After the AUDIT-F9 description scrub, TF-IDF IDF weights shifted so this
    // question's top candidate clears 0.26 (measured ~0.275 → live_setup_audit_trail).
    // Owner accepted funnel-advisory here rather than raising the threshold.
    const r = await routeQuestionHandler(ctx, {
      question: 'any thoughts on the general vibe of the setup here',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('funnel-advisory');
    expect(r.value.data.route.confidence).toBe('low');
    expect(r.value.data.route.reason).toContain('FUNNEL-DERIVED');
    const top = (r.value.data.toolCandidates ?? [])[0];
    expect(top).toBeDefined();
    expect(top!.score).toBeGreaterThanOrEqual(FUNNEL_PRIMARY_MIN_SCORE);
  });

  it('NEGATIVE (margin gate wins): a risk near-tie clarifies instead of advisory-routing', async () => {
    // P4: the plane axis resolves by live-signal instead of blocking, and
    // "which reports are actually used" now routes deterministically
    // (reports-usage). The gate-beats-advisory precedence is pinned on the
    // still-blocking DESTRUCTIVE/read-only axis.
    const r = await routeQuestionHandler(ctx, {
      question: 'removal simulation or usage readout for that field',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).not.toBe('funnel-advisory');
    expect(r.value.data.route.clarification?.required).toBe(true);
    expect(r.value.data.executionBlocked).toBe(true);
  });

  it('NEGATIVE (premise check wins): an existence-negative discloses, never advisory-routes', async () => {
    // Funnel top ≥0.30 (naming-convention vocabulary) but the named component
    // does not exist in the vault — the stage-6 premise verdict must block the
    // advisory upgrade (DIAGNOSIS §6.4: the nastiest residual class).
    const r = await routeQuestionHandler(ctx, {
      question: 'are our naming conventions consistent for Zorp_Widget__c or a total free-for-all',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, entityEvidence } = r.value.data;
    expect(route.intent).toBe('unrouted'); // NOT funnel-advisory
    expect(route.reason).toContain('PREMISE CHECK');
    expect(entityEvidence?.warning ?? route.reason).toContain('PREMISE CHECK');
    expect(r.value.data.executionBlocked).toBe(false);
  });

  it('design negative (c): "is there a custom permission called … or similar?" never advisory-routes', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'is there a custom permission called Allow_Legacy_Edit or similar?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).not.toBe('funnel-advisory');
  });

  it('T7 invariant: the unrouted funnel-primary path sees PURE cosines — no fromRoute rows, no 0.25 floor mass', () => {
    const route = classifyQuestion(
      'are the naming conventions in this org consistent or a total free-for-all',
    );
    expect(route.intent).toBe('unrouted');
    const cands = buildFunnelCandidates(
      route,
      route.question,
      new Map<string, Readonly<Record<string, unknown>>>(),
      undefined,
    );
    expect(cands.length).toBeGreaterThan(0);
    for (const candidate of cands) {
      expect(candidate.fromRoute).not.toBe(true);
      expect(candidate.score).not.toBe(0.25);
      // Pure path: the fused score IS the raw cosine.
      expect(candidate.cosine).toBe(candidate.score);
    }
    // Pin the threshold relationship the design ships with.
    expect(FUNNEL_PRIMARY_MIN_SCORE).toBeGreaterThan(0.25);
  });
});

// ROUTE-MISSES-SHIPPED-MULTIPLICITY-CONCEPT — end-to-end proof through the SAME
// candidate pipeline the host sees (regex-hint fusion included, not just the
// pure funnel). A "how many active triggers … order undefined" question routes
// to intent `metadata-count` (whose route tools are list_components/get_component
// — interpret is NOT in the route), so the ONLY way sfi.interpret can reach the
// host candidates is the funnel-utterances corpus fix. buildFunnelCandidates is
// exactly what routeQuestionHandler emits as `toolCandidates`, so this pins the
// host-visible reachability, not an internal funnel detail.
describe('routeQuestionHandler candidates — shipped multiplicity reasoning reaches the host (ROUTE-MISSES-SHIPPED-MULTIPLICITY-CONCEPT)', () => {
  const emptyArgs = new Map<string, Readonly<Record<string, unknown>>>();

  it('surfaces sfi.interpret in the top-5 host candidates for the undefined-trigger-order question (metadata-count route)', () => {
    const route = classifyQuestion(
      'How many active Apex triggers fire on Contact, and is their order undefined?',
    );
    // Confirm the fix does NOT re-map the intent — it stays metadata-count and
    // its route tools never include interpret; the funnel alone surfaces it.
    expect(route.intent).toBe('metadata-count');
    expect(route.tools).not.toContain('sfi.interpret');
    const top5 = buildFunnelCandidates(route, route.question, emptyArgs, undefined)
      .slice(0, 5)
      .map((c) => c.tool);
    expect(top5, `top-5 host candidates were: ${top5.join(', ')}`).toContain('sfi.interpret');
  });

  it('surfaces sfi.interpret in the host candidates for a scheduled-path async-fault question', () => {
    const route = classifyQuestion(
      'a scheduled path runs asynchronously after the record commits — can it roll back the original save?',
    );
    const tools = buildFunnelCandidates(route, route.question, emptyArgs, undefined).map((c) => c.tool);
    expect(tools, `host candidates were: ${tools.join(', ')}`).toContain('sfi.interpret');
  });

  it('surfaces sfi.interpret in the top-5 host candidates for the loop-governor Apex question (governor-risks route)', () => {
    const route = classifyQuestion('Which Apex classes on Contact do SOQL or DML inside loops and risk governor limits?');
    expect(route.intent).toBe('governor-risks');
    const args: Map<string, Readonly<Record<string, unknown>>> = new Map([
      ['sfi.governor_limit_risks', {}],
      ['sfi.interpret', {}],
    ]);
    const top5 = buildFunnelCandidates(route, route.question, args, undefined).slice(0, 5).map((c) => c.tool);
    expect(top5, `top-5: ${top5.join(', ')}`).toContain('sfi.interpret');
  });
});

// ROUTE-DEPLOY-PACKAGE-WORD-MISBINDS-PACKAGE-IMPACT — "is it safe to remove this
// Flow from the package?" is a change-risk deploy-artifact question, not a
// managed-package uninstall footprint. Through the SAME candidate pipeline the
// host sees (regex-hint fusion included), review_change must now rank ABOVE
// package_impact. A managed-package retire ("uninstall the acme package") still
// leads with package_impact.
describe('routeQuestionHandler candidates — deploy/change-risk beats package_impact (ROUTE-DEPLOY-PACKAGE-WORD-MISBINDS-PACKAGE-IMPACT)', () => {
  const emptyArgs = new Map<string, Readonly<Record<string, unknown>>>();

  it('routes "remove this Flow from the package" to review-change, not package-impact', () => {
    const route = classifyQuestion('is it safe to remove this Flow from the package');
    expect(route.intent).toBe('review-change');
    expect(route.tools[0]).toBe('sfi.review_change');
  });

  it('ranks review_change above package_impact in the host candidates for the deploy-artifact question', () => {
    const route = classifyQuestion(
      'I am deleting the after-save Flow, is it safe to remove from the package?',
    );
    const tools = buildFunnelCandidates(route, route.question, emptyArgs, undefined).map((c) => c.tool);
    const reviewIdx = tools.indexOf('sfi.review_change');
    const pkgIdx = tools.indexOf('sfi.package_impact');
    expect(reviewIdx, `host candidates were: ${tools.join(', ')}`).toBeGreaterThanOrEqual(0);
    expect(pkgIdx === -1 || reviewIdx < pkgIdx, `host candidates were: ${tools.join(', ')}`).toBe(true);
  });

  it('still routes a genuine managed-package uninstall to package-impact', () => {
    // No component-noun + "from the package" container framing, keeps
    // "uninstall" — the new review-change rule must NOT steal it.
    expect(classifyQuestion('what breaks if we uninstall the acme managed package').intent).toBe(
      'package-impact',
    );
    expect(classifyQuestion('how entangled are we with the vendor package if we uninstall it').intent).toBe(
      'package-impact',
    );
  });
});

// R3 forensics — the funnel-primary FIRING bug: 6 of the 8 eligible 0.1.22
// misses that met every visible stage-7 condition were killed by a PREMISE
// flag raised on a PROSE fragment the typed-phrase extractor scraped ("I want
// a risk report on all", "they say the field"), and 1 more by treating a
// literal TOOL-NAME mention as a ghost component. A `none` resolve on junk is
// not a false premise; real ghost names must still flag (pinned below).
describe('routeQuestionHandler — premise flag fires only on name-shaped extractions (R3)', () => {
  it('looksLikeComponentName: prose fragments are NOT names; real name shapes are', () => {
    // The actual junk extractions from the 0.1.22 forensic set (q703, q1188,
    // q1370, q1918, q1919).
    expect(looksLikeComponentName('I want a risk report on all')).toBe(false);
    expect(looksLikeComponentName('they say the field')).toBe(false);
    expect(looksLikeComponentName('so I can cross-check my report')).toBe(false);
    expect(looksLikeComponentName('If someone is assigned the Billing permission set')).toBe(false);
    expect(
      looksLikeComponentName('some user get AssignZorpLead through their permission set'),
    ).toBe(false);
    // Real name shapes keep the premise family armed: single tokens, typo'd
    // ghosts, Title Case phrases, type-noun-suffixed names, connector names.
    expect(looksLikeComponentName('Zorp_Widget__c')).toBe(true);
    expect(looksLikeComponentName('AlowZorpCodeEdit')).toBe(true);
    expect(looksLikeComponentName('ZorpAid permission set')).toBe(true);
    expect(looksLikeComponentName('Zorp Acommodation')).toBe(true);
    expect(looksLikeComponentName('Course of Study')).toBe(true);
  });

  it('POSITIVE (q703 repro): a prose-junk extraction resolving to none must not block stage 7', async () => {
    // The extractor scrapes "I want a risk report on all" (typed-phrase path,
    // "report" type noun) → resolves `none` → 0.1.22-shape premise flag ate
    // the 0.41 automation_risk_report conversion. Junk prose is not a named
    // ghost: no PREMISE CHECK, funnel-primary fires.
    const r = await routeQuestionHandler(ctx, {
      question:
        'I want a risk report on all our automation — flows and triggers overlapping on the same objects',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route } = r.value.data;
    expect(route.reason).not.toContain('PREMISE CHECK');
    expect(route.intent).toBe('funnel-advisory');
    expect(route.tools[0]).toBe('sfi.automation_risk_report');
  });

  it('POSITIVE (q594 repro): a literal tool-name mention is not a ghost component', async () => {
    // "find_dependency_cycles" matches the underscored api-reference shape but
    // names OUR OWN TOOL — it must not premise-flag as a nonexistent
    // component, and the ask converts to the tool the user literally named.
    const r = await routeQuestionHandler(ctx, {
      question:
        'find_dependency_cycles across triggers too, not just classes — do any triggers call classes in a loop?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, entityEvidence } = r.value.data;
    expect(route.reason).not.toContain('PREMISE CHECK');
    expect(entityEvidence).toBeUndefined(); // no entity extracted at all
    expect(route.intent).toBe('funnel-advisory');
    expect(route.tools[0]).toBe('sfi.find_dependency_cycles');
  });

  it('GUARD: a quoted Title-Case ghost name still premise-flags and blocks the advisory upgrade', async () => {
    // "'Zorp Widget' object" extracts the bare quoted name — name-shaped →
    // the existence premise must still block funnel-primary (the §5b
    // false-premise over-route cluster depends on this staying armed; the
    // underscored-ghost variant is pinned by the P2 §3 negative above).
    const r = await routeQuestionHandler(ctx, {
      question:
        "are our naming conventions consistent for the 'Zorp Widget' object or a total free-for-all",
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route } = r.value.data;
    expect(route.intent).toBe('unrouted'); // NOT funnel-advisory
    expect(route.reason).toContain('PREMISE CHECK');
  });
});

// Router-v2 P2 §4 — the additive `cosine` field: pre-fusion semantic evidence,
// preserved through the regex-bonus fusion; 0 for route-inserted rows.
describe('toolCandidates carry the pre-fusion cosine (P2 §4)', () => {
  it('fused route rows keep cosine < score; inserted rows carry cosine 0 at the 0.25 floor; funnel rows cosine === score', async () => {
    // metadata-count routes [list_components (funnel-surfaced → fused),
    // get_component (not surfaced → inserted at the 0.25 floor)].
    const r = await routeQuestionHandler(ctx, {
      question: 'How many custom fields are on Contact?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cands = r.value.data.toolCandidates ?? [];
    const fused = cands.find((c) => c.tool === 'sfi.list_components');
    expect(fused?.fromRoute).toBe(true);
    expect(fused?.cosine).toBeGreaterThan(0); // real semantic support…
    expect(fused?.cosine ?? 0).toBeLessThan(fused?.score ?? 0); // …plus the bounded bonus
    const inserted = cands.find((c) => c.tool === 'sfi.get_component');
    expect(inserted?.fromRoute).toBe(true);
    expect(inserted?.score).toBe(0.25); // the floor: pure regex assertion
    expect(inserted?.cosine).toBe(0); // declared as ZERO semantic evidence
    for (const c of cands.filter((x) => x.fromRoute !== true)) {
      expect(c.cosine).toBe(c.score); // untouched funnel rows
    }
  });
});

// R3 §5b — PRE-ROUTE EXISTENCE GATE: a question that names an api-shaped
// component but routes an intent that never runs entity resolution (the
// 23-question false-premise over-route cluster) is existence-probed
// pre-commit; a ghost premise-flags, a real name passes untouched, and
// dotted STANDARD references are never probed (the q799 recall shape).
describe('routeQuestionHandler — pre-route existence gate (R3 §5b)', () => {
  it('a ghost custom object in a no-resolve intent (record-count) premise-flags', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'count records in the Ghost_Award__c object by year',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, entityEvidence } = r.value.data;
    expect(route.intent).toBe('record-count'); // route intact — flag, not block
    expect(route.confidence).toBe('low');
    expect(route.reason).toContain('PREMISE CHECK');
    expect(entityEvidence?.disposition).toBe('none');
    expect(entityEvidence?.query).toBe('Ghost_Award__c');
  });

  it('the SAME intent over a real vault component passes untouched (zero recall cost)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'count records in the Payment__c object by year',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.reason).not.toContain('PREMISE CHECK');
  });

  it('a dotted STANDARD field reference is never probed (standard fields are legitimately absent)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'how many records have Case.RecordTypeId populated right now',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.reason).not.toContain('PREMISE CHECK');
  });

  it('a ghost premise from the probe blocks the stage-7 advisory upgrade too', async () => {
    // Unrouted phrasing + ghost underscored flow name that the typed-phrase
    // extractor does not scrape (no type noun adjacency) — the probe must
    // still find and flag it instead of letting funnel-primary advisory-route.
    const r = await routeQuestionHandler(ctx, {
      question: 'whats the impact radius of Zorb_Ghost_Sync on our payment records',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route } = r.value.data;
    expect(route.intent).not.toBe('funnel-advisory');
    expect(route.reason).toContain('PREMISE CHECK');
  });
});

// R3 catch-all narrowing — an ANAPHOR-ONLY fragment with no host context must
// stay honestly unrouted instead of advisory-routing on a cosine graze (the
// funnel-advisory over-route family on the R2 honesty holdouts).
describe('routeQuestionHandler — anaphor-only fragments never advisory-route without context (R3)', () => {
  it.each([
    'does it call an invocable apex at least?',
    "if it doesn't exist just say so, don't guess",
  ])('stays unrouted: %s', async (question) => {
    const r = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).not.toBe('funnel-advisory');
  });

  it('a question with its OWN entity keeps the advisory path (pronoun is rhetoric, not the subject)', async () => {
    // "it" appears, but the question names a real component — the fragment
    // gate must not touch it (entityQuery is the component, not an anaphor).
    const r = await routeQuestionHandler(ctx, {
      question: 'I want a risk report on all our automation — flows and triggers overlapping on the same objects',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('funnel-advisory');
  });
});

// R3 §5b — the identity gap rides the refusal-route contract end to end.
describe('routeQuestionHandler — identity-gap refusal shape (R3 §5b)', () => {
  it('first-person capability ask returns honest-gap-identity with tools [] and the clarify pointer', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'am I allowed to merge two profiles together?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { route, executionBlocked } = r.value.data;
    expect(route.intent).toBe('honest-gap-identity');
    expect(route.tools).toEqual([]);
    expect(route.refusal?.kind).toBe('identity-gap');
    expect(route.reason).toMatch(/Which user or profile should I check\?/);
    expect(executionBlocked).toBe(false);
    expect(route.gap?.category).toBe('identity-gap');
  });
});

// R3 permissions family — the ANSWERABLE PSG-expansion direction must not be
// eaten by the R2 capability-gap intents (which keep the genuinely-
// unanswerable directions gapped).
describe('classifyQuestion — PSG expansion vs the R2 PSG gaps (R3)', () => {
  it('"what does a user get through the <PSG>" is NOT the permset-group-grants gap', () => {
    const r = classifyQuestion(
      'what does a user get through the Advisor_Perm_Group permission set group?',
    );
    expect(r.intent).not.toBe('permset-group-grants');
    expect(r.intent).not.toBe('permset-user-roster');
  });

  it('"which PSG grants the <custom permission>" routes live with the 2-hop gap disclosed (ENGINE-ARC §4 partial flip)', () => {
    const r = classifyQuestion('Which PSG grants the ZorpFullAccess custom permission?');
    expect(r.intent).toBe('permset-group-grants');
    expect(r.tools).toEqual(['sfi.live_permset_holders']);
    expect(r.gap).not.toBeNull();
  });

  it('"which users hold the <perm set>" routes to the LIVE holder roster (ENGINE-ARC §4 full flip)', () => {
    const r = classifyQuestion('which users hold the Zorp_Admin permission set?');
    expect(r.intent).toBe('permset-user-roster');
    expect(r.tools).toEqual(['sfi.live_permset_holders']);
    expect(r.gap).toBeNull();
  });
});

describe('buildRouteToolArgsMap — sfi.interpret arg-binding (RM-wire step 2)', () => {
  // A reasoning-shaped route that stacks sfi.interpret after its specialist.
  // Only the fields buildRouteToolArgsMap reads matter (tools, suggestedArgs,
  // intent); the rest are minimal valid RouteResult scaffolding.
  const reasoningRoute = (
    intent: string,
    tools: readonly string[],
    suggestedArgs: Readonly<Record<string, unknown>>,
  ): RouteResult => ({
    question: 'q',
    plane: 'vault',
    intent,
    tools,
    liveRequired: false,
    needsResolve: false,
    reason: 'test scaffold',
    gap: null,
    confidence: 'high',
    risk: 'informational',
    alternatives: [],
    clarification: null,
    plan: [],
    suggestedArgs,
  });

  it('binds the resolved fieldId as interpret.componentId on a field-anchored reasoning route', async () => {
    const route = reasoningRoute(
      'field-provenance',
      ['sfi.resolve', 'sfi.field_provenance', 'sfi.interpret'],
      { fieldId: 'CustomField:Account.Status__c' },
    );
    const map = await buildRouteToolArgsMap(route, ctx);
    // interpret surfaces with a NON-EMPTY componentId, reusing the specialist's id.
    expect(map.get('sfi.interpret')).toEqual({
      componentId: 'CustomField:Account.Status__c',
    });
    // The specialist keeps its own key; the resolve preamble stays empty.
    expect(map.get('sfi.field_provenance')).toEqual({
      fieldId: 'CustomField:Account.Status__c',
    });
    expect(map.get('sfi.resolve')).toEqual({});
  });

  it('reuses a componentId-keyed anchor (impact-analysis) verbatim for interpret', async () => {
    const route = reasoningRoute(
      'impact-analysis',
      ['sfi.resolve', 'sfi.get_impact', 'sfi.interpret'],
      { componentId: 'CustomObject:Payment__c' },
    );
    const map = await buildRouteToolArgsMap(route, ctx);
    expect(map.get('sfi.interpret')).toEqual({
      componentId: 'CustomObject:Payment__c',
    });
  });

  it('lifts a bare objectApiName anchor to a CustomObject canonical id for interpret', async () => {
    const route = reasoningRoute(
      'automation-on-object',
      ['sfi.automation_collisions', 'sfi.interpret'],
      { objectApiName: 'Account' },
    );
    const map = await buildRouteToolArgsMap(route, ctx);
    expect(map.get('sfi.interpret')).toEqual({ componentId: 'CustomObject:Account' });
  });

  it('lifts the automation_collisions `object` key to a CustomObject id for interpret (F3)', async () => {
    // automation_collisions binds its object under `object`, not `objectApiName`;
    // interpret must still receive the CustomObject anchor so the collision /
    // owd / status-code concepts fire on the object.
    const route = reasoningRoute(
      'automation-collisions',
      ['sfi.automation_collisions', 'sfi.interpret'],
      { object: 'Account' },
    );
    const map = await buildRouteToolArgsMap(route, ctx);
    expect(map.get('sfi.interpret')).toEqual({ componentId: 'CustomObject:Account' });
    // The specialist keeps its own `object` key untouched.
    expect(map.get('sfi.automation_collisions')).toEqual({ object: 'Account' });
  });

  it('surfaces interpret with EMPTY args (never a guessed id) when nothing was resolved', async () => {
    const route = reasoningRoute(
      'field-provenance',
      ['sfi.resolve', 'sfi.field_provenance', 'sfi.interpret'],
      {},
    );
    const map = await buildRouteToolArgsMap(route, ctx);
    expect(map.get('sfi.interpret')).toEqual({});
  });
});
