/// <reference types="vitest/globals" />

/**
 * router-v2 P3 — guards for the generated utterance corpus (funnel-utterances.ts)
 * and the weighted synonym expansion (Quartermaster `expansionWeight` backport).
 *
 * The corpus is a GENERATED data module: exact key parity with the V01_TOOLS
 * registry is enforced here so a renamed/added/removed tool fails the build
 * until the corpus is regenerated (see the module's header for how).
 */
import { FUNNEL_UTTERANCES } from '../src/funnel-utterances.js';
import {
  EXPANSION_WEIGHT,
  expandWeighted,
  resetFunnelIndex,
  semanticCandidates,
} from '../src/semantic-funnel.js';
import { V01_TOOLS } from '../src/tools/index.js';

beforeEach(() => resetFunnelIndex());

describe('FUNNEL_UTTERANCES — registry parity', () => {
  it('has exactly one entry per registered tool (a renamed tool fails here)', () => {
    const registry = new Set(V01_TOOLS.map((t) => t.name));
    const corpus = new Set(Object.keys(FUNNEL_UTTERANCES));
    const staleKeys = [...corpus].filter((k) => !registry.has(k));
    const missingTools = [...registry].filter((k) => !corpus.has(k));
    expect(staleKeys, `corpus keys with no registered tool (regenerate funnel-utterances.ts): ${staleKeys.join(', ')}`).toEqual([]);
    expect(missingTools, `registered tools with no utterance entry (regenerate funnel-utterances.ts): ${missingTools.join(', ')}`).toEqual([]);
  });

  it('every entry is a non-empty list of non-empty utterances', () => {
    for (const [tool, utterances] of Object.entries(FUNNEL_UTTERANCES)) {
      expect(utterances.length, `${tool} has an empty utterance list`).toBeGreaterThan(0);
      for (const u of utterances) expect(u.trim().length, `${tool} has a blank utterance`).toBeGreaterThan(0);
    }
  });

  it('loads at the expected scale (regeneration sanity tripwire)', () => {
    const total = Object.values(FUNNEL_UTTERANCES).reduce((n, u) => n + u.length, 0);
    // Not pinned to the exact count — a regenerated corpus may grow — but a
    // collapse below this floor means the module was truncated, not curated.
    expect(total).toBeGreaterThanOrEqual(1000);
  });
});

describe('expandWeighted — weighted synonym expansion (Quartermaster backport)', () => {
  it('gives original tokens weight 1 and expanded synonyms EXPANSION_WEIGHT', () => {
    const w = expandWeighted(['edit']);
    expect(w.get('edit')).toBe(1);
    // 'access' is a synonym of 'edit' — expanded, so it scores at the reduced weight.
    expect(w.get('access')).toBe(EXPANSION_WEIGHT);
    expect(EXPANSION_WEIGHT).toBeLessThan(1); // originals must always outrank expansions
    expect(EXPANSION_WEIGHT).toBeGreaterThan(0);
  });

  it('never downgrades an original that is also another token’s synonym', () => {
    // 'access' is a synonym of 'edit', but here the user TYPED it — weight 1.
    const w = expandWeighted(['edit', 'access']);
    expect(w.get('edit')).toBe(1);
    expect(w.get('access')).toBe(1);
  });

  it('accumulates repeated originals and does not stack shared synonyms', () => {
    const w = expandWeighted(['field', 'field']);
    expect(w.get('field')).toBe(2);
    // 'usage' is a synonym of both 'touches' and 'relies' — shared synonyms get
    // EXPANSION_WEIGHT once, they do not stack up to rival an original.
    const shared = expandWeighted(['touches', 'relies']);
    expect(shared.get('usage')).toBe(EXPANSION_WEIGHT);
  });

  it('keeps exact-vocabulary queries on their exact tool despite the grown table', () => {
    // Queries phrased in the tool's OWN vocabulary must still rank it #1 — the
    // grown synonym table only nudges at EXPANSION_WEIGHT, it cannot flip an
    // exact-term match (the failure mode unweighted expansion caused, and the
    // reason the table was historically kept small).
    const exact: ReadonlyArray<{ q: string; top1: string }> = [
      { q: 'order of execution for Account inserts', top1: 'sfi.order_of_execution' },
      { q: 'effective permissions for the Sales profile', top1: 'sfi.effective_permissions' },
      { q: 'find dependency cycles in this org', top1: 'sfi.find_dependency_cycles' },
      { q: 'pii inventory for this org', top1: 'sfi.pii_inventory' },
      { q: 'what happens on save for Case', top1: 'sfi.what_happens_on_save' },
    ];
    for (const { q, top1 } of exact) {
      const got = semanticCandidates(q, 8)[0]?.tool;
      expect(got, `exact-vocabulary query flipped: "${q}"`).toBe(top1);
    }
  });
});
