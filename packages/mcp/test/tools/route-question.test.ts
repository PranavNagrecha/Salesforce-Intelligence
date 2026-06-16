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
import { appendAnnotationEvent } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { routeQuestionHandler } from '../../src/tools/route-question.js';

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

  it('attaches semantic toolCandidates when the question is unrouted (CAE-01 funnel)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'where does Pranav have access to',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.route.intent).toBe('unrouted');
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
  });

  it('omits toolCandidates for gibberish (no false candidates)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'zxqw plkj vbnm',
      logGap: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('toolCandidates' in r.value.data).toBe(false);
  });
});
