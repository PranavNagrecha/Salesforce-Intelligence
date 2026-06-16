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

import type { Context } from '../../src/server.js';
import { resolveHandler, resolveInputSchema } from '../../src/tools/resolve.js';

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
    node({ id: 'CustomField:Payment__c.Payment_Status__c', type: 'CustomField', apiName: 'Payment_Status__c', label: 'Payment Status', parentId: 'CustomObject:Payment__c' }),
    node({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
    node({ id: 'CustomObject:Contact', apiName: 'Contact', label: 'Contact' }),
    node({ id: 'CustomField:Account.Email__c', type: 'CustomField', apiName: 'Email__c', label: 'Email', parentId: 'CustomObject:Account' }),
    node({ id: 'CustomField:Contact.Email__c', type: 'CustomField', apiName: 'Email__c', label: 'Email', parentId: 'CustomObject:Contact' }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-resolve-'));
  const opened = await openGraph(join(tempDir, 'resolve.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveHandler', () => {
  it('resolves a typo to one confident candidate (paymnet -> Payment__c, exact)', async () => {
    const r = await resolveHandler(ctx, { query: 'paymnet' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disposition).toBe('exact');
    expect(r.value.data.candidates[0]?.componentId).toBe('CustomObject:Payment__c');
    expect(r.value.data.candidates[0]?.matchKind).toBe('fuzzy');
  });

  it('always tags resolution heuristic and carries a disclosure', async () => {
    const r = await resolveHandler(ctx, { query: 'paymnet' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.confidence).toBe('heuristic');
    expect(r.value.data.disclosure.length).toBeGreaterThan(0);
    expect(r.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('flags ambiguity when a field lives on multiple objects (email)', async () => {
    const r = await resolveHandler(ctx, { query: 'email' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disposition).toBe('ambiguous');
    const ids = r.value.data.candidates.map((c) => c.componentId);
    expect(ids).toContain('CustomField:Account.Email__c');
    expect(ids).toContain('CustomField:Contact.Email__c');
  });

  it('returns disposition none with no candidates for gibberish', async () => {
    const r = await resolveHandler(ctx, { query: 'zzzqqq' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disposition).toBe('none');
    expect(r.value.data.candidates).toEqual([]);
  });

  it('returns disposition none for impossible no-match phrasing', async () => {
    const r = await resolveHandler(ctx, { query: 'zzzz_no_such_component_94817' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disposition).toBe('none');
    expect(r.value.data.candidates).toEqual([]);
  });

  it('surfaces a ready-to-ask clarifying question on ambiguous (email)', async () => {
    const r = await resolveHandler(ctx, { query: 'email' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.clarification).not.toBeNull();
    expect(
      (r.value.data.clarification?.options.length ?? 0),
    ).toBeGreaterThanOrEqual(2);
  });

  it('the ambiguous clarification is a complete, ready-to-show envelope (P3-clarification-envelope)', async () => {
    const r = await resolveHandler(ctx, { query: 'email' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.disposition).toBe('ambiguous');
    const c = d.clarification;
    expect(c).not.toBeNull();
    // A host can ask the user directly from this envelope alone.
    expect(typeof c?.question).toBe('string');
    expect(c?.question.length ?? 0).toBeGreaterThan(0);
    expect(c?.options.length ?? 0).toBeGreaterThanOrEqual(2);
    // Every option carries a label + a canonical-id value to pick.
    for (const opt of c?.options ?? []) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.value).toContain(':'); // canonical id form
    }
    expect(typeof c?.disambiguateBy).toBe('string');
    // `rendered` is the ready-to-display markdown prompt, and it embeds the
    // question so a host can surface it verbatim.
    expect(d.rendered.length).toBeGreaterThan(0);
    expect(d.rendered).toContain(c?.question ?? '');
  });

  it('offers refresh-or-stop next actions when nothing matched', async () => {
    const r = await resolveHandler(ctx, { query: 'zzzqqq' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.clarification).toBeNull();
    const actions = r.value.data.nextActions.map((a) => a.action);
    expect(actions).toContain('refresh');
    expect(actions).toContain('stop');
  });

  it('honors a type filter', async () => {
    const r = await resolveHandler(ctx, { query: 'email', types: ['CustomField'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.candidates.every((c) => c.type === 'CustomField')).toBe(true);
  });
});

describe('resolveInputSchema', () => {
  it('accepts a minimal input', () => {
    expect(resolveInputSchema.safeParse({ query: 'payment' }).success).toBe(true);
  });
  it('rejects an empty query', () => {
    expect(resolveInputSchema.safeParse({ query: '' }).success).toBe(false);
  });
  it('rejects a limit over 50', () => {
    expect(resolveInputSchema.safeParse({ query: 'x', limit: 51 }).success).toBe(false);
  });
});

describe('glossary aliases (P13-ANNOT-glossary-resolve)', () => {
  const annotate = async (
    componentId: string,
    value: string,
    opts?: { readonly source?: 'human' | 'ai'; readonly confirmed?: boolean },
  ): Promise<void> => {
    const { appendAnnotationEvent } = await import('@sf-intelligence/vault');
    await appendAnnotationEvent(ctx.vaultRoot, {
      componentId,
      key: 'glossary',
      value,
      author: 'pranav',
      source: opts?.source ?? 'human',
      confirmed: opts?.confirmed ?? true,
      at: '2026-06-10T00:00:00.000Z',
      op: 'set',
    });
  };
  const clearOverlay = (): void => {
    rmSync(join(ctx.vaultRoot, 'meta', 'annotations.jsonl'), { force: true });
  };

  afterEach(clearOverlay);

  it('a confirmed glossary synonym resolves to its component (curated, marked glossary-alias)', async () => {
    await annotate('CustomField:Contact.Email__c', 'primary correspondence address');
    const r = await resolveHandler(ctx, { query: 'primary correspondence address' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disposition).toBe('exact');
    expect(r.value.data.candidates[0]?.componentId).toBe('CustomField:Contact.Email__c');
    expect(r.value.data.candidates[0]?.matchKind).toBe('glossary-alias');
    expect(r.value.data.candidates[0]?.evidence).toContain('curated synonym');
  });

  it('ADVERSARIAL: an alias NEVER shadows an exact api-name match', async () => {
    // The query "Payment__c" is an exact whole-name match for the real object;
    // a curated alias maliciously points the same phrase at Contact.
    await annotate('CustomObject:Contact', 'Payment__c');
    const r = await resolveHandler(ctx, { query: 'Payment__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disposition).toBe('exact');
    expect(r.value.data.candidates[0]?.componentId).toBe('CustomObject:Payment__c');
    expect(r.value.data.candidates[0]?.matchKind).not.toBe('glossary-alias');
  });

  it('conflicting aliases (two components share the synonym) → ambiguous + clarification, never a silent pick', async () => {
    await annotate('CustomField:Account.Email__c', 'official electronic mail');
    await annotate('CustomField:Contact.Email__c', 'official electronic mail');
    const r = await resolveHandler(ctx, { query: 'official electronic mail' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disposition).toBe('ambiguous');
    const aliasIds = r.value.data.candidates
      .filter((c) => c.matchKind === 'glossary-alias')
      .map((c) => c.componentId);
    expect(aliasIds).toEqual([
      'CustomField:Account.Email__c',
      'CustomField:Contact.Email__c',
    ]);
    expect(r.value.data.clarification).not.toBeNull();
  });

  it('an UNCONFIRMED AI glossary proposal never resolves', async () => {
    await annotate('CustomObject:Contact', 'mystery synonym', { source: 'ai', confirmed: false });
    const r = await resolveHandler(ctx, { query: 'mystery synonym' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.candidates.every((c) => c.matchKind !== 'glossary-alias')).toBe(true);
    expect(r.value.data.disposition).not.toBe('exact');
  });

  it('an alias pointing at a vanished component is skipped (orphan surface owns it)', async () => {
    await annotate('CustomObject:Deleted_Thing__c', 'ghost synonym');
    const r = await resolveHandler(ctx, { query: 'ghost synonym' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.candidates.every((c) => c.matchKind !== 'glossary-alias')).toBe(true);
  });
});
