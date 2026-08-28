/// <reference types="vitest/globals" />

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import { appendAnnotationEvent, readAnnotations } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import {
  annotationsHandler,
  confirmAnnotationHandler,
  proposeAnnotationHandler,
  PROPOSE_SESSION_CAP,
  rejectAnnotationHandler,
  resetProposalSessionCap,
  reviewAnnotationsHandler,
} from '../../src/tools/annotations.js';

/**
 * P13-ANNOT-tools + R8-ANNOTATION-REVIEW — sfi.annotations (read) +
 * sfi.propose_annotation + review/confirm/reject.
 */

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-10T00:00:00.000Z',
  sourceOrg: 'test',
  components: { ApexClass: 1 },
  edges: {},
  sourceTreeHash: 'sha256:annotations-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: overrides.id.slice(overrides.id.indexOf(':') + 1),
  label: null,
  parentId: null,
  sourcePath: 'src',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-annotations-'));
  const opened = await openGraph(join(tempDir, 'a.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const seed: ExtractionResult = {
    nodes: [makeNode({ id: 'ApexClass:Alpha', type: 'ApexClass' })],
    edges: [],
  };
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetProposalSessionCap();
  rmSync(join(tempDir, 'meta', 'annotations.jsonl'), { force: true });
});

describe('sfi.annotations (read)', () => {
  it('empty overlay reads as zero annotations with the disclosure', async () => {
    const r = await annotationsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.annotations).toEqual([]);
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.disclosure).toContain('CURATED');
  });

  it('scopes by componentId and key; counts unconfirmed AI proposals', async () => {
    const at = '2026-06-10T01:00:00.000Z';
    await appendAnnotationEvent(tempDir, {
      componentId: 'ApexClass:Alpha', key: 'owner', value: 'Platform',
      author: 'pranav', source: 'human', confirmed: true, at, op: 'set',
    });
    await appendAnnotationEvent(tempDir, {
      componentId: 'ApexClass:Alpha', key: 'status', value: 'deprecated',
      author: 'ai', source: 'ai', confirmed: false, at, op: 'set',
    });
    await appendAnnotationEvent(tempDir, {
      componentId: 'CustomObject:Other', key: 'note', value: 'x',
      author: 'pranav', source: 'human', confirmed: true, at, op: 'set',
    });
    const scoped = await annotationsHandler(ctx, { componentId: 'ApexClass:Alpha' });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.value.data.totalCount).toBe(2);
    expect(scoped.value.data.unconfirmedProposals).toBe(1);
    const keyed = await annotationsHandler(ctx, { componentId: 'ApexClass:Alpha', key: 'status' });
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;
    expect(keyed.value.data.annotations.map((a) => a.value)).toEqual(['deprecated']);
  });

  // R1 (BRIEF 063): `proposeAnnotationHandler` already publishes `componentExists`
  // (line 151-152 of annotations.ts) precisely because a proposal on a phantom
  // subject is "allowed but flagged". The read path shares the same `ctx.graph`
  // handle and omitted the same check, so a real, un-annotated component and a
  // typo'd/wrong-case componentId were BOTH `annotations: [], totalCount: 0` —
  // indistinguishable. `componentExists` must be `null` for a whole-vault query
  // (the question does not apply), and boolean when componentId is given.
  it('distinguishes a phantom componentId from a real-but-unannotated one', async () => {
    const wholeVault = await annotationsHandler(ctx, {});
    expect(wholeVault.ok).toBe(true);
    if (!wholeVault.ok) return;
    expect(wholeVault.value.data.componentExists).toBeNull();

    const real = await annotationsHandler(ctx, { componentId: 'ApexClass:Alpha' });
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    expect(real.value.data.annotations).toEqual([]);
    expect(real.value.data.componentExists).toBe(true);

    // Wrong-case is a first-class case per the brief's traps, not a mere typo.
    const wrongCase = await annotationsHandler(ctx, { componentId: 'apexclass:Alpha' });
    expect(wrongCase.ok).toBe(true);
    if (!wrongCase.ok) return;
    expect(wrongCase.value.data.annotations).toEqual([]);
    expect(wrongCase.value.data.componentExists).toBe(false);

    const typo = await annotationsHandler(ctx, { componentId: 'ApexClass:NotInGraph' });
    expect(typo.ok).toBe(true);
    if (!typo.ok) return;
    expect(typo.value.data.annotations).toEqual([]);
    expect(typo.value.data.componentExists).toBe(false);
  });

  // R2 (BRIEF 063): neither `sfi.annotations` nor `sfi.review_annotations`
  // advertised (or enforced) a `limit`/`offset`/`cursor`, so a vault with more
  // curated rows than fit one response had NO way to reach the tail — the
  // dropped rows were genuinely unreachable through the tool.
  it('pages a large overlay instead of returning it unbounded and unresumable', async () => {
    const at = '2026-06-10T03:00:00.000Z';
    // The overlay is last-write-wins per (componentId, key) — ANNOTATION_KEYS
    // has only 5 members, so distinct rows require distinct componentIds, not
    // repeated writes to the same pair.
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      await appendAnnotationEvent(tempDir, {
        componentId: `CustomField:Bulk__c.Field${String(i).padStart(4, '0')}__c`,
        key: 'note',
        value: `bulk-note-${String(i).padStart(4, '0')}`,
        author: 'pranav',
        source: 'human',
        confirmed: true,
        at,
        op: 'set',
      });
    }
    const first = await annotationsHandler(ctx, { limit: 100 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.data.totalCount).toBe(total);
    expect(first.value.data.annotations.length).toBe(100);
    expect(first.value.data.hasMore).toBe(true);
    expect(first.value.data.nextOffset).toBe(100);

    const second = await annotationsHandler(ctx, {
      limit: 100,
      offset: first.value.data.nextOffset ?? undefined,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.data.annotations.length).toBe(100);

    const third = await annotationsHandler(ctx, { limit: 100, offset: 200 });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.data.annotations.length).toBe(total - 200);
    expect(third.value.data.hasMore).toBe(false);
    expect(third.value.data.nextOffset).toBeNull();

    // The full 250 rows are reachable across pages, and never dumped unbounded
    // in one response (the default page is bounded, not `total`).
    const seen = new Set<string>();
    for (const a of [...first.value.data.annotations, ...second.value.data.annotations, ...third.value.data.annotations]) {
      seen.add(a.value);
    }
    expect(seen.size).toBe(total);

    const noLimit = await annotationsHandler(ctx, {});
    expect(noLimit.ok).toBe(true);
    if (!noLimit.ok) return;
    expect(noLimit.value.data.annotations.length).toBeLessThan(total);
  });
});

describe('sfi.propose_annotation', () => {
  it('writes ALWAYS as source:ai confirmed:false; reports componentExists', async () => {
    const r = await proposeAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
      value: 'deprecated',
      rationale: 'user said so',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.proposal.source).toBe('ai');
    expect(r.value.data.proposal.confirmed).toBe(false);
    expect(r.value.data.componentExists).toBe(true);
    expect(r.value.data.confirmHint).toContain('sfi annotate');
    const stored = await readAnnotations(tempDir);
    expect(stored[0]?.source).toBe('ai');
    expect(stored[0]?.confirmed).toBe(false);
    expect(stored[0]?.author).toContain('user said so');

    const phantom = await proposeAnnotationHandler(ctx, {
      componentId: 'CustomObject:NotInGraph__c',
      key: 'note',
      value: 'proposal on a phantom is allowed but flagged',
    });
    expect(phantom.ok).toBe(true);
    if (!phantom.ok) return;
    expect(phantom.value.data.componentExists).toBe(false);
  });

  it('enforces the session rate-cap with an actionable error', async () => {
    for (let i = 0; i < PROPOSE_SESSION_CAP; i += 1) {
      const r = await proposeAnnotationHandler(ctx, {
        componentId: 'ApexClass:Alpha',
        key: 'note',
        value: `proposal ${i}`,
      });
      expect(r.ok).toBe(true);
    }
    const over = await proposeAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'note',
      value: 'one too many',
    });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error.message).toContain('session cap');
    expect(over.error.message).toContain('sfi.confirm_annotation');
  });
});

describe('sfi.review_annotations / confirm / reject (R8-ANNOTATION-REVIEW)', () => {
  it('lists only unconfirmed proposals and filters by componentId/key/author', async () => {
    const at = '2026-06-10T01:00:00.000Z';
    await appendAnnotationEvent(tempDir, {
      componentId: 'ApexClass:Alpha', key: 'owner', value: 'Platform',
      author: 'pranav', source: 'human', confirmed: true, at, op: 'set',
    });
    await appendAnnotationEvent(tempDir, {
      componentId: 'ApexClass:Alpha', key: 'status', value: 'deprecated',
      author: 'ai (lifecycle)', source: 'ai', confirmed: false, at, op: 'set',
    });
    await appendAnnotationEvent(tempDir, {
      componentId: 'CustomObject:Other', key: 'note', value: 'x',
      author: 'ai', source: 'ai', confirmed: false, at, op: 'set',
    });

    const all = await reviewAnnotationsHandler(ctx, {});
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.data.totalCount).toBe(2);
    expect(all.value.data.proposals.every((p) => !p.confirmed)).toBe(true);

    const scoped = await reviewAnnotationsHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
      author: 'lifecycle',
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.value.data.proposals.map((p) => p.value)).toEqual(['deprecated']);
  });

  // R2 (BRIEF 063): same unbounded/unresumable read as `sfi.annotations`, on
  // `sfi.review_annotations`.
  it('pages unconfirmed proposals instead of returning them all unbounded', async () => {
    const at = '2026-06-10T04:00:00.000Z';
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      await appendAnnotationEvent(tempDir, {
        componentId: `CustomField:Bulk__c.Field${String(i).padStart(4, '0')}__c`,
        key: 'note',
        value: `proposal-${String(i).padStart(4, '0')}`,
        author: 'ai',
        source: 'ai',
        confirmed: false,
        at,
        op: 'set',
      });
    }
    const page = await reviewAnnotationsHandler(ctx, { limit: 50 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.data.totalCount).toBe(total);
    expect(page.value.data.proposals.length).toBe(50);
    expect(page.value.data.hasMore).toBe(true);
    expect(page.value.data.nextOffset).toBe(50);

    const unbounded = await reviewAnnotationsHandler(ctx, {});
    expect(unbounded.ok).toBe(true);
    if (!unbounded.ok) return;
    expect(unbounded.value.data.proposals.length).toBeLessThan(total);
  });

  it('confirm promotes an AI proposal to human-confirmed; idempotent when already confirmed', async () => {
    await appendAnnotationEvent(tempDir, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
      value: 'deprecated',
      author: 'ai',
      source: 'ai',
      confirmed: false,
      at: '2026-06-10T01:00:00.000Z',
      op: 'set',
    });
    const r = await confirmAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
      author: 'reviewer',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.confirmed).toBe(true);
    expect(r.value.data.alreadyConfirmed).toBe(false);
    expect(r.value.data.annotation.source).toBe('human');
    const stored = await readAnnotations(tempDir);
    const status = stored.find((a) => a.key === 'status');
    expect(status?.confirmed).toBe(true);
    expect(status?.source).toBe('human');
    expect(status?.author).toBe('reviewer');

    const again = await confirmAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.data.alreadyConfirmed).toBe(true);
  });

  it('reject unsets an unconfirmed proposal and refuses confirmed entries', async () => {
    await appendAnnotationEvent(tempDir, {
      componentId: 'ApexClass:Alpha',
      key: 'note',
      value: 'temp proposal',
      author: 'ai',
      source: 'ai',
      confirmed: false,
      at: '2026-06-10T01:00:00.000Z',
      op: 'set',
    });
    const rejected = await rejectAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'note',
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.data.rejected).toBe(true);
    expect(rejected.value.data.previousValue).toBe('temp proposal');
    expect(await readAnnotations(tempDir)).toEqual([]);

    await appendAnnotationEvent(tempDir, {
      componentId: 'ApexClass:Alpha',
      key: 'owner',
      value: 'Platform',
      author: 'pranav',
      source: 'human',
      confirmed: true,
      at: '2026-06-10T02:00:00.000Z',
      op: 'set',
    });
    const refuse = await rejectAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'owner',
    });
    expect(refuse.ok).toBe(false);
    if (refuse.ok) return;
    expect(refuse.error.message).toContain('already confirmed');
  });

  it('confirm/reject fail closed when the pair is missing', async () => {
    const missingConfirm = await confirmAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
    });
    expect(missingConfirm.ok).toBe(false);
    const missingReject = await rejectAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
    });
    expect(missingReject.ok).toBe(false);
  });

  it('attributes propose/confirm/reject to Context.callerIdentity when known (R8-PERCALLER-TOKENS)', async () => {
    const identified: Context = {
      ...ctx,
      callerIdentity: { id: 'synth-alice', label: 'Alice Synth' },
    };
    const proposed = await proposeAnnotationHandler(identified, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
      value: 'deprecated',
      rationale: 'lifecycle',
    });
    expect(proposed.ok).toBe(true);
    expect((await readAnnotations(tempDir))[0]?.author).toBe('Alice Synth (lifecycle)');

    const confirmed = await confirmAnnotationHandler(identified, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
    });
    expect(confirmed.ok).toBe(true);
    expect((await readAnnotations(tempDir))[0]?.author).toBe('Alice Synth');
    expect((await readAnnotations(tempDir))[0]?.confirmed).toBe(true);

    rmSync(join(tempDir, 'meta', 'annotations.jsonl'), { force: true });
    const bob: Context = { ...ctx, callerIdentity: { id: 'synth-bob' } };
    await proposeAnnotationHandler(bob, {
      componentId: 'ApexClass:Alpha',
      key: 'note',
      value: 'temp',
    });
    const rejected = await rejectAnnotationHandler(bob, {
      componentId: 'ApexClass:Alpha',
      key: 'note',
    });
    expect(rejected.ok).toBe(true);
    const raw = readFileSync(join(tempDir, 'meta', 'annotations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { op: string; author: string });
    expect(raw.some((e) => e.op === 'unset' && e.author === 'synth-bob')).toBe(true);

    rmSync(join(tempDir, 'meta', 'annotations.jsonl'), { force: true });
    const idOnly = await proposeAnnotationHandler(
      { ...ctx, callerIdentity: { id: 'synth-carol' } },
      { componentId: 'ApexClass:Alpha', key: 'owner', value: 'Platform' },
    );
    expect(idOnly.ok).toBe(true);
    expect((await readAnnotations(tempDir))[0]?.author).toBe('synth-carol');
  });
});
