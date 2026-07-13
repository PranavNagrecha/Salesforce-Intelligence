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
    // Hidden tools (back-compat aliases) are exempt: they are un-advertised and
    // deliberately un-routed, so they need NO utterance entry. Parity is
    // enforced only over the ADVERTISED roster (`!t.hidden`); a stray corpus key
    // for a hidden tool still fails via `staleKeys` below (the corpus must not
    // route to a hidden alias).
    const registry = new Set(V01_TOOLS.filter((t) => !t.hidden).map((t) => t.name));
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
      // Was 'order of execution for Account inserts'. Wiring sfi.record_creation_paths
      // (decision 5) added a tool whose OWN vocabulary IS record creation/insertion
      // ("how do records get created", "Apex DML inserts are NOT modeled"), so an
      // insert-flavored query is now a genuine two-tool tie, not order_of_execution's
      // exclusive vocabulary. Per the R7-W7 precedent above, rephrase to an equally
      // natural DML-qualified query on an event the create-only tool has zero affinity
      // for ('updates'), keeping order_of_execution the exact-vocabulary #1 with a
      // healthy margin — not loosening the assertion.
      { q: 'order of execution for Account updates', top1: 'sfi.order_of_execution' },
      { q: 'effective permissions for the Sales profile', top1: 'sfi.effective_permissions' },
      { q: 'find dependency cycles in this org', top1: 'sfi.find_dependency_cycles' },
      // R7-W7: was 'pii inventory for this org' — at the pre-R7 186-tool corpus
      // size that phrase's margin over sfi.generate_compliance_report (which
      // ITSELF composes pii_inventory and echoes "PII Inventory" in its own
      // description) was ~0.007, already razor-thin. Adding the 187th tool
      // (sfi.history_tracking_gaps) shifts every document's global idf enough
      // to flip it — verified content-independent: even swapping
      // history_tracking_gaps's real description/utterances for inert
      // placeholder text reproduced the exact same flip, so this is corpus-
      // SCALE fragility in a hardcoded near-tie, not a routing regression this
      // tool's design caused. Rephrased to an equally natural "exact
      // vocabulary" query with a healthy margin (0.42 vs 0.35) instead of
      // loosening the assertion.
      { q: 'inventory of pii fields', top1: 'sfi.pii_inventory' },
      { q: 'what happens on save for Case', top1: 'sfi.what_happens_on_save' },
    ];
    for (const { q, top1 } of exact) {
      const got = semanticCandidates(q, 8)[0]?.tool;
      expect(got, `exact-vocabulary query flipped: "${q}"`).toBe(top1);
    }
  });
});
