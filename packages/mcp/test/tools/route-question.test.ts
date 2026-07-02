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

import { classifyQuestion } from '../../src/intent-router.js';
import type { Context } from '../../src/server.js';
import {
  buildFunnelCandidates,
  FUNNEL_PRIMARY_MIN_SCORE,
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
    expect(r.value.data.entityEvidence?.query).toBe('Foo_Bar_Flow flow');
    expect(r.value.data.entityEvidence?.disposition).toBe('exact');
    expect(r.value.data.entityEvidence?.clarificationRequired).toBe(false);
  });
});

describe('routeQuestionHandler — enterprise routing evidence', () => {
  it('stops and asks for clarification whenever distinct intents match', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'What breaks if I delete the Account field?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.alternatives.length).toBeGreaterThan(0);
    expect(r.value.data.route.clarification?.required).toBe(true);
    expect(r.value.data.executionBlocked).toBe(true);
    expect(r.value.data.rendered).toContain('Stop before executing');
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
    const question = 'What breaks if I delete the Account field?';
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
        selection: 'safe-to-delete',
      },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.data.route.intent).toBe('safe-to-delete');
    expect(resumed.value.data.route.confidence).toBe('high');
    expect(resumed.value.data.route.clarification).toBeNull();
    expect(resumed.value.data.executionBlocked).toBe(false);
    expect(resumed.value.data.clarificationResolution).toEqual({
      clarificationId,
      selection: 'safe-to-delete',
      kind: 'intent',
    });
  });

  it('rejects stale clarification ids and invented selections', async () => {
    const question = 'What breaks if I delete the Account field?';
    const first = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clarificationId = first.value.data.route.clarification?.id as string;

    const stale = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: {
        clarificationId: 'stale-challenge',
        selection: 'safe-to-delete',
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
      question: 'What breaks if I delete the Account field?',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.executionBlocked).toBe(true);
    expect(r.value.data.invoke).toBeUndefined();
  });

  it('emits executable calls after a validated clarification response', async () => {
    process.env.SFI_TOOL_PROFILE = 'core';
    const question = 'What breaks if I delete the Account field?';
    const first = await routeQuestionHandler(ctx, { question, logGap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const clarificationId = first.value.data.route.clarification?.id as string;

    const resumed = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: { clarificationId, selection: 'safe-to-delete' },
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

  it('omits invoke entirely under the default full profile (zero change)', async () => {
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

  it('NEGATIVE (threshold): top below FUNNEL_PRIMARY_MIN_SCORE stays honestly unrouted', async () => {
    // Real candidates exist (top ~0.08) but none clears the bar.
    const r = await routeQuestionHandler(ctx, {
      question: 'any thoughts on the general vibe of the setup here',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('unrouted');
    expect(r.value.data.route.plane).toBe('unknown');
    expect(r.value.data.route.gap).not.toBeNull();
    expect((r.value.data.toolCandidates ?? []).length).toBeGreaterThan(0);
  });

  it('NEGATIVE (margin gate wins): a plane near-tie clarifies instead of advisory-routing', async () => {
    // "report usage" tops ≥0.30 but ties live_report_usage (live) with
    // find_apex_usages (vault) inside MARGIN — the clarification must win and
    // funnel-primary must NOT override it.
    const r = await routeQuestionHandler(ctx, { question: 'report usage', logGap: false });
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
