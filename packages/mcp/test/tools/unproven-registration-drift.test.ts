/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { findDeadCodeHandler } from '../../src/tools/find-dead-code.js';
import { methodReachabilityHandler } from '../../src/tools/method-reachability.js';

/**
 * S10 — ONE rule about unproven dynamic registration, stated ONCE.
 *
 * `find_dead_code` and `method_reachability` each defined a constant named
 * `UNPROVEN_REGISTRATION_DISCLOSURE`, with DIFFERENT text. The predicates
 * (`isFrameworkSubclass` / `isCallableDispatch`) had been correctly centralised
 * into `apex-reachability.ts`; the sentence had not. Two copies of one rule
 * behind one name is a drift seam by construction — an editor who corrected the
 * claim in either file would have corrected half of it.
 *
 * This test does not reference the shared constant by name. It asserts
 * BEHAVIOURALLY that the two tools state the same substantive claim, using
 * phrases that pre-fix appeared in exactly one of them:
 *
 *   - "zero incoming edges by construction"  — was find_dead_code's only
 *   - 'never as "proven reachable"'          — was method_reachability's only
 *
 * so a future re-fork of the sentence fails here rather than shipping.
 */

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-unproven-drift',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Zero in-edges on both — that is the point: the registration mints none. */
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'ApexClass:WidgetAffiliationHandler',
      apiName: 'WidgetAffiliationHandler',
      properties: { isTest: false, superclass: 'pkg.TriggerRunnable' },
    }),
    makeNode({
      id: 'ApexClass:WidgetAddressHelper',
      apiName: 'WidgetAddressHelper',
      properties: { isTest: false, implements: ['Callable'] },
    }),
  ],
  edges: [],
};

const withStore = async <T>(run: (ctx: Context) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), 'sfi-unproven-drift-'));
  const opened = await openGraph(join(dir, 'drift.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  const out = await run({ vaultRoot: dir, manifest: MANIFEST, graph: store } as Context);
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
  return out;
};

/** The claim both tools must state, in the words they must both use. */
const SHARED_CLAIM_PHRASES = [
  'declares the Callable dynamic-invocation interface',
  'zero incoming edges by construction',
  // Was 'NEITHER proves the registration is live' while the rule covered
  // exactly two signals. The rule now covers three (async dispatch joined it —
  // 16 of 18 org-wide `likely_dead` classes were Schedulable or Batchable), so
  // the sentence had to stop saying "neither". The INVARIANT this pinned is
  // unchanged: both tools must ship the same words for it.
  'NONE of them proves the registration is live',
  'never as "proven reachable"',
  // PLATFORM TRUTH, pinned here because a wrong verdict on it gets a running
  // scheduled job deleted. Setup > Schedule Apex writes a CronTrigger RECORD;
  // records are not metadata, are never retrieved, and no refresh can change
  // that — so a metadata walk cannot see the registration at all.
  'implements Queueable / Database.Batchable / Schedulable',
  'CronTrigger is DATA, not metadata',
  'no refresh can close that gap',
] as const;

describe('unproven dynamic registration — one rule, one sentence (S10)', () => {
  it('find_dead_code states the shared claim in its boundaries', async () => {
    const boundaries = await withStore(async (ctx) => {
      const r = await findDeadCodeHandler(ctx, {
        types: ['ApexClass'],
        includeUncertain: true,
        limit: 500,
      });
      if (!r.ok) throw new Error(`handler failed: ${r.error.message}`);
      return r.value.data.boundaries;
    });
    const entry = boundaries.find((b) => b.includes('dynamic registration'));
    expect(entry).toBeDefined();
    for (const phrase of SHARED_CLAIM_PHRASES) {
      expect(entry).toContain(phrase);
    }
    // …and keeps its own verdict framing, which only this tool has.
    expect(entry).toContain('never `definitely_dead`');
  });

  it('method_reachability states the SAME claim in its disclosure', async () => {
    const disclosure = await withStore(async (ctx) => {
      const r = await methodReachabilityHandler(ctx, {
        classApiName: 'ApexClass:WidgetAddressHelper',
      });
      if (!r.ok) throw new Error(`handler failed: ${r.error.message}`);
      return r.value.data.disclosure;
    });
    for (const phrase of SHARED_CLAIM_PHRASES) {
      expect(disclosure).toContain(phrase);
    }
    // …and keeps its own framing about THIS response's entry points.
    expect(disclosure).toContain(
      'Every entry point found here is an UNPROVEN dynamic registration',
    );
  });

  it('the two tools ship the claim BYTE-IDENTICALLY, not merely equivalently', async () => {
    const [boundaries, disclosure] = await withStore(async (ctx) => {
      const dead = await findDeadCodeHandler(ctx, {
        types: ['ApexClass'],
        includeUncertain: true,
        limit: 500,
      });
      const reach = await methodReachabilityHandler(ctx, {
        classApiName: 'ApexClass:WidgetAddressHelper',
      });
      if (!dead.ok || !reach.ok) throw new Error('handler failed');
      return [dead.value.data.boundaries, reach.value.data.disclosure] as const;
    });
    const entry = boundaries.find((b) => b.includes('dynamic registration'));
    expect(entry).toBeDefined();
    // The shared body starts at the same word in both and runs to the end.
    const start = 'A class that extends a base class from ANOTHER namespace';
    const deadAt = entry?.indexOf(start) ?? -1;
    const reachAt = disclosure.indexOf(start);
    // Both must actually CARRY the shared body — a -1 here is the pre-fix
    // state, where each tool had its own paraphrase and neither contained it.
    expect(deadAt).toBeGreaterThanOrEqual(0);
    expect(reachAt).toBeGreaterThanOrEqual(0);
    expect(entry?.slice(deadAt)).toBe(disclosure.slice(reachAt));
  });
});
