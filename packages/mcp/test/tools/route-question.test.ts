/// <reference types="vitest/globals" />

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { err } from '@sf-intelligence/core';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  resolveComponents,
  type GraphStore,
} from '@sf-intelligence/graph';
import { appendAnnotationEvent } from '@sf-intelligence/vault';

import { semanticCandidates } from '../../src/semantic-funnel.js';
import type { Context } from '../../src/server.js';
import {
  buildFunnelCandidates,
  looksLikeComponentName,
  routeQuestionHandler,
} from '../../src/tools/route-question.js';
import { isDirectlyInvokable } from '../../src/tools/tool-profile.js';

// Only `resolveComponents` is wrapped, and it forwards to the REAL
// implementation by default. A single test below uses `mockImplementationOnce`
// to force the ONE existence-probe call it targets to fail.
vi.mock('@sf-intelligence/graph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sf-intelligence/graph')>();
  return { ...actual, resolveComponents: vi.fn(actual.resolveComponents) };
});

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
    // Three `*_Code__c` fields: the English word "code" must not resolve to them.
    node({ id: 'CustomField:Account.Promo_Code__c', type: 'CustomField', apiName: 'Promo_Code__c', label: 'Promo Code', parentId: 'CustomObject:Account' }),
    node({ id: 'CustomField:Case.Zip_Code__c', type: 'CustomField', apiName: 'Zip_Code__c', label: 'Zip Code', parentId: 'CustomObject:Case' }),
    node({ id: 'CustomField:Payment__c.Auth_Code__c', type: 'CustomField', apiName: 'Auth_Code__c', label: 'Auth Code', parentId: 'CustomObject:Payment__c' }),
    node({ id: 'CustomField:Account.Region_Key__c', type: 'CustomField', apiName: 'Region_Key__c', label: 'Region Key', parentId: 'CustomObject:Account' }),
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

const route = async (question: string, extra: Record<string, unknown> = {}) => {
  const r = await routeQuestionHandler(ctx, { question, logGap: false, ...extra });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.data;
};

describe('routeQuestionHandler — the funnel advises, the host decides (no intent field)', () => {
  it.each([
    'who can edit the Status field on Case',
    'how many custom objects do we have',
    'what breaks if I deactivate the Foo_Bar_Flow flow',
  ])('returns ranked candidates and no `intent`/`route` for: %s', async (question) => {
    const data = await route(question);
    const cands = data.toolCandidates ?? [];
    expect(cands.length).toBeGreaterThan(1);
    // The rows are the funnel's own shortlist (de-crowd / live-sink reorders
    // aside): every tool the handler lists, the funnel surfaced.
    const funnel = new Set(buildFunnelCandidates(question, undefined).map((c) => c.tool));
    for (const c of cands) expect(funnel.has(c.tool)).toBe(true);
    for (const c of cands) {
      expect(c.tool).toMatch(/^sfi\./);
      expect(typeof c.answers).toBe('string');
      expect(['vault', 'live', 'hybrid']).toContain(c.plane);
    }
    expect('intent' in data).toBe(false);
    expect('route' in data).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/"intent"/);
    expect(data.guidance).toContain('YOU decide');
    expect(data.rendered).toContain('Candidate tools');
  });

  it('a self-contained question is deterministic', async () => {
    const a = await route('what custom objects do we have');
    const b = await route('what custom objects do we have');
    expect(a).toEqual(b);
  });
});

describe('routeQuestionHandler — entity evidence', () => {
  it('attaches vault-backed entity evidence for a bare component phrase', async () => {
    const data = await route('payment object');
    expect(data.entityEvidence?.disposition).toBe('exact');
    expect(data.entityEvidence?.query).toBe('payment object');
    expect(data.entityEvidence?.typeHints).toEqual(['CustomObject']);
    expect(data.entityEvidence?.clarificationRequired).toBe(false);
    expect(data.entityEvidence?.candidates[0]?.componentId).toBe('CustomObject:Payment__c');
  });

  it.each(['find dead code', 'show me the flows', 'who can see accounts'])(
    'a plain English word is not a component name, so no clarification: %s',
    async (question) => {
      const data = await route(question);
      expect(data.entityEvidence?.clarificationRequired ?? false).toBe(false);
      expect(data.clarification).toBeNull();
      expect(data.executionBlocked).toBe(false);
    },
  );

  it('a unique api name in prose still binds the field', async () => {
    const data = await route('where is Region_Key__c used');
    expect(data.entityEvidence?.disposition).toBe('exact');
    expect(data.executionBlocked).toBe(false);
    const bound = (data.toolCandidates ?? []).find(
      (c) => c.suggestedArgs?.['fieldId'] === 'CustomField:Account.Region_Key__c',
    );
    expect(bound).toBeDefined();
  });

  it('nonsense gets a low-confidence shortlist and an out-of-scope gap', async () => {
    const data = await route('the the the and and but');
    expect(data.executionBlocked).toBe(false);
    expect(data.gap?.category).toBe('out-of-scope');
    expect(data.toolCandidates?.[0]?.confidence).toBe('low');
  });

  it('treats a unique literal canonical-id match as exact despite fuzzy neighbours', async () => {
    const data = await route('who can edit Payment__c.Status__c');
    expect(data.entityEvidence?.query).toBe('Payment__c.Status__c');
    expect(data.entityEvidence?.typeHints).toEqual(['CustomField']);
    expect(data.entityEvidence?.disposition).toBe('exact');
    expect(data.entityEvidence?.candidates[0]?.componentId).toBe('CustomField:Payment__c.Status__c');
    expect(data.executionBlocked).toBe(false);
    // The exact winner is bound into the field-taking candidates.
    const bound = (data.toolCandidates ?? []).find(
      (c) => c.suggestedArgs?.['fieldId'] === 'CustomField:Payment__c.Status__c',
    );
    expect(bound).toBeDefined();
  });

  it('still stops when a short field name has multiple literal candidates', async () => {
    const data = await route('who can edit the Status field');
    expect(data.entityEvidence?.disposition).toBe('ambiguous');
    expect(data.entityEvidence?.clarificationRequired).toBe(true);
    expect(data.executionBlocked).toBe(true);
    expect(data.clarification?.options).toEqual(
      expect.arrayContaining(['CustomField:Account.Status__c', 'CustomField:Case.Status__c']),
    );
    expect(data.rendered).toContain('Stop before executing');
    expect(data.invoke).toBeUndefined();
  });

  it('an object qualifier SCOPES the field — resolver exact, no cross-object menu', async () => {
    const data = await route('who can edit Status__c on Case');
    expect(data.entityEvidence?.query).toBe('Case.Status__c');
    expect(data.entityEvidence?.disposition).toBe('exact');
    expect(data.entityEvidence?.candidates[0]?.componentId).toBe('CustomField:Case.Status__c');
    expect(data.executionBlocked).toBe(false);
  });

  it('uses a confirmed org glossary alias in front-door entity routing', async () => {
    const data = await route('who can edit the checkout state field');
    expect(data.entityEvidence?.disposition).toBe('exact');
    expect(data.entityEvidence?.candidates[0]?.componentId).toBe('CustomField:Payment__c.Status__c');
    expect(data.entityEvidence?.candidates[0]?.matchKind).toBe('glossary-alias');
    expect(data.executionBlocked).toBe(false);
  });

  it('stops when a confirmed org glossary alias points at multiple components', async () => {
    const data = await route('who can edit the shared state field');
    expect(data.entityEvidence?.disposition).toBe('ambiguous');
    expect(data.entityEvidence?.clarificationRequired).toBe(true);
    expect(data.clarification?.options).toEqual(
      expect.arrayContaining(['CustomField:Account.Status__c', 'CustomField:Case.Status__c']),
    );
    expect(data.executionBlocked).toBe(true);
  });

  it('ignores unconfirmed AI glossary proposals in front-door routing', async () => {
    const data = await route('who can access the secret ledger object');
    expect(
      data.entityEvidence?.candidates.some((candidate) => candidate.matchKind === 'glossary-alias') ?? false,
    ).toBe(false);
  });

  it('never lets a confirmed glossary alias shadow an exact API name', async () => {
    const data = await route('who can access Payment__c');
    expect(data.entityEvidence?.disposition).toBe('exact');
    expect(data.entityEvidence?.candidates[0]?.componentId).toBe('CustomObject:Payment__c');
    expect(data.entityEvidence?.candidates[0]?.matchKind).not.toBe('glossary-alias');
  });
});

describe('routeQuestionHandler — clarification continuation', () => {
  it('rejects stale clarification ids and invented selections', async () => {
    const question = 'who can edit the Status field';
    const first = await route(question);
    const clarificationId = first.clarification?.id as string;
    expect(clarificationId).toBeDefined();

    const stale = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: { clarificationId: 'stale-challenge', selection: 'CustomField:Case.Status__c' },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe('invalid-query');

    const invented = await routeQuestionHandler(ctx, {
      question,
      logGap: false,
      clarificationResponse: { clarificationId, selection: 'delete-it-now' },
    });
    expect(invented.ok).toBe(false);
    if (!invented.ok) expect(invented.error.kind).toBe('invalid-query');
  });

  it('resumes with an explicitly selected canonical entity, bound into the candidates', async () => {
    const question = 'who can edit the Status field';
    const first = await route(question);
    const clarificationId = first.clarification?.id as string;
    const selection = 'CustomField:Payment__c.Status__c';
    expect(first.clarification?.options).toContain(selection);

    const resumed = await route(question, { clarificationResponse: { clarificationId, selection } });
    expect(resumed.executionBlocked).toBe(false);
    expect(resumed.clarification).toBeNull();
    expect(resumed.entityEvidence?.selectedComponentId).toBe(selection);
    expect(resumed.clarificationResolution).toEqual({ clarificationId, selection, kind: 'entity' });
    const bound = (resumed.toolCandidates ?? []).find((c) => c.suggestedArgs?.['fieldId'] === selection);
    expect(bound).toBeDefined();
  });

  it('rejects a clarification response when no clarification is active', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'show me the org card',
      logGap: false,
      clarificationResponse: { clarificationId: 'not-applicable', selection: 'org-card' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });
});

describe('core-profile gateway envelopes', () => {
  afterEach(() => {
    delete process.env['SFI_TOOL_PROFILE'];
  });

  /** The gateway law: a core tool is called directly, anything else through run_analysis. */
  const envelope = (tool: string, args: Record<string, unknown>) =>
    isDirectlyInvokable(tool, 'core')
      ? { tool, args }
      : { tool: 'sfi.run_analysis', args: { name: tool, args } };

  it('emits invoke[] under core for the leading candidates, with their bound args', async () => {
    process.env['SFI_TOOL_PROFILE'] = 'core';
    const data = await route('who can edit Payment__c.Status__c');
    expect(data.invoke).toBeDefined();
    expect(data.invoke!.length).toBeGreaterThan(0);
    expect(data.invoke!.length).toBeLessThanOrEqual(3);
    // An `sfi.resolve {}` step is never offered — the entity is already bound.
    expect(data.invoke!.some((s) => s.tool === 'sfi.resolve')).toBe(false);
    for (const [i, step] of data.invoke!.entries()) {
      const row = data.toolCandidates![i]!;
      expect(step).toEqual({
        ...envelope(row.tool, { ...(row.suggestedArgs ?? {}) }),
        ...(row.missingArgs !== undefined ? { missingArgs: row.missingArgs } : {}),
      });
    }
  });

  it('keeps core-roster tools as direct calls under core', async () => {
    process.env['SFI_TOOL_PROFILE'] = 'core';
    const data = await route('show me the org card');
    expect(data.invoke?.[0]).toEqual(envelope('sfi.org_card', {}));
  });

  it('withholds executable calls when clarification is required', async () => {
    process.env['SFI_TOOL_PROFILE'] = 'core';
    const data = await route('who can edit the Status field');
    expect(data.executionBlocked).toBe(true);
    expect(data.invoke).toBeUndefined();
  });

  it('binds an explicitly selected entity into the executable calls', async () => {
    process.env.SFI_TOOL_PROFILE = 'core';
    const question = 'who can edit the Status field';
    const first = await route(question);
    const clarificationId = first.clarification?.id as string;
    const selection = 'CustomField:Payment__c.Status__c';
    const resumed = await route(question, { clarificationResponse: { clarificationId, selection } });
    const bound = resumed.invoke?.find((step) => {
      const inner = step.args as { readonly name?: string; readonly args?: Record<string, unknown> };
      const args = step.tool === 'sfi.run_analysis' ? inner.args : step.args;
      return (args as Record<string, unknown>)['fieldId'] === selection;
    });
    expect(bound).toBeDefined();
  });

  it('omits invoke entirely under an explicit full profile', async () => {
    process.env['SFI_TOOL_PROFILE'] = 'full';
    const data = await route('What happens when an Account is updated?');
    expect('invoke' in data).toBe(false);
  });
});

describe('routeQuestionHandler — candidates and guidance', () => {
  it('attaches semantic toolCandidates + the planner contract', async () => {
    const data = await route('where does Pranav have access to');
    const tools = (data.toolCandidates ?? []).map((c) => c.tool);
    expect(tools.length).toBeGreaterThan(0);
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
    expect(data.rendered).toContain('Candidate tools');
    expect(data.guidance).toContain('sfi.synthesize_answer');
    expect(data.guidance).toContain('YOU decide');
  });

  it('omits toolCandidates and guidance for gibberish, and says so as a gap', async () => {
    const data = await route('zxqw plkj vbnm');
    expect('toolCandidates' in data).toBe(false);
    expect('guidance' in data).toBe(false);
    expect(data.gap?.category).toBe('unrouted');
    expect(data.rendered).toMatch(/don't have a tool/i);
  });

  it('mode=plan leads with the plan family', async () => {
    const data = await route('what breaks if I delete the Status field on Payment', { mode: 'plan' });
    const tools = (data.toolCandidates ?? []).map((c) => c.tool);
    expect(tools.length).toBeGreaterThan(0);
    expect(data.guidance).toContain('PLAN mode');
    const planFamily = /^sfi\.(what_if_|get_impact|safe_to_delete|downstream_effects|field_lineage|tests_for_change)/;
    expect(planFamily.test(tools[0]!)).toBe(true);
  });

  it('mode=assessment yields assessment guidance + candidates', async () => {
    const data = await route('how risky is this org', { mode: 'assessment' });
    expect(data.guidance).toContain('ASSESSMENT mode');
    expect((data.toolCandidates ?? []).length).toBeGreaterThan(0);
  });

  it('mode=ask yields concise-ask guidance', async () => {
    const data = await route('what fields are on Account', { mode: 'ask' });
    expect(data.guidance).toContain('ASK mode');
  });

  it('every row carries answers + a non-null category', async () => {
    const data = await route('How many custom fields are on Contact?');
    for (const c of data.toolCandidates ?? []) {
      expect(typeof c.answers).toBe('string');
      expect(c.category).not.toBeNull();
    }
  });
});

describe('routeQuestionHandler — gap logging is privacy-first opt-in', () => {
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
    // Precondition: this question really does carry a gap.
    expect(r.value.data.gap).not.toBeNull();
    expect(r.value.data.gapLogged).toBe(false);
    expect(existsSync(gapLogPath)).toBe(false);
  });

  it('writes the gap log only when the caller explicitly opts in with logGap:true', async () => {
    const data = await route('blorp glorp shmorp', { logGap: true });
    expect(data.gap).not.toBeNull();
    expect(data.gapLogged).toBe(true);
    const lines = readFileSync(gapLogPath, 'utf8').trim().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(written['question']).toBe('blorp glorp shmorp');
    expect(written['category']).toBe('unrouted');
    expect('intent' in written).toBe(false);
  });

  it('a placed question logs nothing even with logGap:true', async () => {
    const data = await route('what custom objects do we have', { logGap: true });
    expect(data.gap).toBeNull();
    expect(data.gapLogged).toBe(false);
    expect(existsSync(gapLogPath)).toBe(false);
  });
});

describe('routeQuestionHandler — live-plane consent disclosure in guidance', () => {
  it('discloses the live plane + consent step when a leading candidate is liveRequired', async () => {
    const data = await route('How many open Cases in the org?');
    const cands = data.toolCandidates ?? [];
    expect(cands.slice(0, 3).some((c) => c.liveRequired === true)).toBe(true);
    const guidance = data.guidance ?? '';
    expect(guidance).toMatch(/LIVE PLANE/i);
    expect(guidance).toMatch(/liveRequired/);
    expect(guidance).toMatch(/sfi\.live_consent/);
    expect(guidance).toMatch(/Do NOT invent/i);
  });

  it('does NOT attach the consent disclosure to a pure vault question', async () => {
    const data = await route('what custom objects do we have');
    const cands = data.toolCandidates ?? [];
    expect(cands.slice(0, 3).every((c) => c.liveRequired !== true)).toBe(true);
    expect(data.guidance ?? '').not.toMatch(/LIVE PLANE/i);
  });
});

describe('routeQuestionHandler — gap honesty', () => {
  it('a typo one edit from a corpus word is in scope: no gap, a field finder shortlisted', async () => {
    const data = await route('Where is the where is acount industry?');
    expect(data.gap).toBeNull();
    const top3 = (data.toolCandidates ?? []).slice(0, 3).map((c) => c.tool);
    expect(
      top3.some((t) => ['sfi.find_component_usages', 'sfi.find_field_anywhere', 'sfi.get_component'].includes(t)),
    ).toBe(true);
  });

  it('a real question carries no gap and leads with the right tool', async () => {
    const data = await route('are the naming conventions in this org consistent or a total free-for-all');
    expect(data.gap).toBeNull();
    expect(data.toolCandidates?.[0]?.tool).toBe('sfi.get_naming_convention_report');
    expect(data.executionBlocked).toBe(false);
  });

  it('evidence under the floor is the rows\' own low confidence plus an out-of-scope gap', async () => {
    const data = await route('xyzzy quantum flibbertigibbet metadata');
    expect(data.gap?.category).toBe('out-of-scope');
    expect(data.toolCandidates?.[0]?.confidence).toBe('low');
    expect(data.guidance).toContain('GAP');
    const clear = await route('what custom objects do we have');
    expect(clear.gap).toBeNull();
    expect(clear.guidance ?? '').not.toContain('LOW CONFIDENCE');
  });

  it('the cause of a one-word collision is bare-token attraction, not meaning', () => {
    const bare = semanticCandidates('setup', 5);
    expect(bare[0]?.tool).toBe('sfi.live_setup_audit_trail');
    const full = semanticCandidates('any thoughts on the general vibe of the setup here', 5)[0]?.score ?? 0;
    expect(bare[0]?.score ?? 0).toBeGreaterThan(full);
    expect(semanticCandidates('the office here — any opinions', 5)).toHaveLength(0);
  });

  it('buildFunnelCandidates is pure on (question, mode): scores equal cosines, no inserted rows', () => {
    const cands = buildFunnelCandidates('are the naming conventions in this org consistent or a total free-for-all', undefined);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) expect(c.cosine).toBe(c.score);
  });

  it('a destructive/read-only near-tie clarifies', async () => {
    const data = await route('removal simulation or usage readout for that field');
    expect(data.clarification?.required).toBe(true);
    expect(data.executionBlocked).toBe(true);
    expect(data.clarification?.options.every((o) => o.startsWith('sfi.'))).toBe(true);
  });
});

describe('routeQuestionHandler — premise checks', () => {
  it('looksLikeComponentName: prose fragments are NOT names; real name shapes are', () => {
    expect(looksLikeComponentName('I want a risk report on all')).toBe(false);
    expect(looksLikeComponentName('they say the field')).toBe(false);
    expect(looksLikeComponentName('If someone is assigned the Billing permission set')).toBe(false);
    expect(looksLikeComponentName('Zorp_Widget__c')).toBe(true);
    expect(looksLikeComponentName('AlowZorpCodeEdit')).toBe(true);
    expect(looksLikeComponentName('ZorpAid permission set')).toBe(true);
    expect(looksLikeComponentName('Zorp Acommodation')).toBe(true);
    expect(looksLikeComponentName('Course of Study')).toBe(true);
  });

  it('an existence-negative discloses and binds nothing', async () => {
    const data = await route('are our naming conventions consistent for Zorp_Widget__c or a total free-for-all');
    expect(data.entityEvidence?.disposition).toBe('none');
    expect(data.entityEvidence?.warning).toContain('PREMISE CHECK');
    expect(data.rendered).toContain('PREMISE CHECK');
    for (const c of data.toolCandidates ?? []) {
      expect(JSON.stringify(c.suggestedArgs ?? {})).not.toContain('Zorp');
    }
    expect(data.executionBlocked).toBe(false);
  });

  it('a prose-junk extraction resolving to none is NOT a false premise', async () => {
    const data = await route(
      'I want a risk report on all our automation — flows and triggers overlapping on the same objects',
    );
    expect(data.entityEvidence?.warning ?? '').not.toContain('PREMISE CHECK');
    expect(data.toolCandidates?.[0]?.tool).toBe('sfi.automation_risk_report');
  });

  it('a literal tool-name mention is not a ghost component', async () => {
    const data = await route(
      'find_dependency_cycles across triggers too, not just classes — do any triggers call classes in a loop?',
    );
    expect(data.entityEvidence).toBeUndefined();
    expect(data.toolCandidates?.[0]?.tool).toBe('sfi.find_dependency_cycles');
  });

  it('a quoted Title-Case ghost name still premise-flags', async () => {
    const data = await route(
      "are our naming conventions consistent for the 'Zorp Widget' object or a total free-for-all",
    );
    expect(data.entityEvidence?.warning).toContain('PREMISE CHECK');
  });

  it('a ghost custom object with no extractable entity is existence-probed and flagged', async () => {
    const data = await route('count records in the Ghost_Award__c object by year');
    expect(data.entityEvidence?.disposition).toBe('none');
    expect(data.entityEvidence?.query).toBe('Ghost_Award__c');
    expect(data.entityEvidence?.warning).toContain('PREMISE CHECK');
  });

  it('the SAME shape over a real vault component passes untouched', async () => {
    const data = await route('count records in the Payment__c object by year');
    expect(data.entityEvidence?.warning ?? '').not.toContain('PREMISE CHECK');
  });

  it('a dotted STANDARD field reference is never probed', async () => {
    const data = await route('how many records have Case.RecordTypeId populated right now');
    expect(data.entityEvidence?.warning ?? '').not.toContain('PREMISE CHECK');
  });

  it('a resolveComponents error at the existence probe is disclosed, not treated as a clean pass', async () => {
    const spy = vi.mocked(resolveComponents);
    spy.mockImplementationOnce(() =>
      Promise.resolve(err({ kind: 'query-failed', message: 'simulated graph failure' })),
    );
    const data = await route('count records in the Ghost_Award__c object by year');
    expect(spy).toHaveBeenCalled();
    const warning = data.entityEvidence?.warning ?? '';
    expect(warning).not.toContain('no component named'); // never claim confirmed absence
    expect(warning).toMatch(/premise[^.]*(not|could not|failed to|inconclusive)/i);
  });
});

describe('routeQuestionHandler — anaphor-only fragments are a gap without context', () => {
  it.each([
    'does it call an invocable apex at least?',
    "if it doesn't exist just say so, don't guess",
  ])('gap: %s', async (question) => {
    const data = await route(question);
    expect(data.gap?.category).toBe('unrouted');
    expect(data.gap?.note).toMatch(/context/);
  });

  it('a question with its OWN subject is not touched by the fragment gate', async () => {
    const data = await route(
      'I want a risk report on all our automation — flows and triggers overlapping on the same objects',
    );
    expect(data.gap).toBeNull();
  });
});

describe('routeQuestionHandler — identity-gap refusal shape', () => {
  it('first-person capability ask returns the identity gap with nothing to run', async () => {
    const data = await route('am I allowed to merge two profiles together?');
    expect(data.refusal?.kind).toBe('identity-gap');
    expect(data.refusal?.disclosure).toMatch(/Which user or profile should I check\?/);
    expect(data.executionBlocked).toBe(false);
    expect(data.gap?.category).toBe('identity-gap');
    expect(data.invoke).toBeUndefined();
  });
});
