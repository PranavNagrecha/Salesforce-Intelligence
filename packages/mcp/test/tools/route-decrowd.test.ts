/// <reference types="vitest/globals" />

/**
 * ROUTER DE-CROWD (0.2.0) — untriggered what_if shortlist demotion,
 * ACTIVE for exactly DECROWD_ACTIVE_FAMILIES (what_if_assign_permset +
 * what_if_revoke_permset — the top-2 measured slot parasites: 487+236
 * parasitic top-5 slots, zero gold questions corpus-wide).
 *
 * Counterfactual pricing on the real 3K depth-10 traces (2026-07-13):
 * this two-tool scope measures +0.42pp recall@5, 27 gains, 0 losses. The
 * broad 11-family scope was MEASURED to lose 40 follow-up/lexicon-gap turns
 * (net +0.25pp, below the bar) and is deliberately NOT shipped. These tests
 * pin the demotion contract:
 *   1. a plain-read question demotes a non-route ACTIVE what_if below the
 *      read tools;
 *   2. a what_if family OUTSIDE the active set is NEVER demoted, even
 *      untriggered;
 *   3. an action/hypothetical question keeps every what_if at its rank;
 *   4. a `fromRoute` what_if is NEVER demoted (the regex route is a plan);
 *   5. the unrouted funnel-primary pure-cosine invariant is untouched
 *      (demotion is a pure reorder — scores/cosines never move);
 *   6. the ACTIVE families' action lexicons stay in lockstep with the
 *      what_if utterance corpus they were derived from.
 */

import { FUNNEL_UTTERANCES } from '../../src/funnel-utterances.js';
import { classifyQuestion } from '../../src/intent-router.js';
import type { ToolCandidate } from '../../src/semantic-funnel.js';
import {
  DECROWD_ACTIVE_FAMILIES,
  demoteUntriggeredWhatIfs,
  WHAT_IF_ACTION_TRIGGERS,
  WHAT_IF_CANDIDATE_FAMILY,
  WHAT_IF_HYPOTHETICAL_TRIGGERS,
  buildFunnelCandidates,
} from '../../src/tools/route-question.js';

const cand = (
  tool: string,
  score: number,
  over: Partial<ToolCandidate> = {},
): ToolCandidate => ({
  tool,
  score,
  cosine: score,
  category: null,
  plane: 'vault',
  liveRequired: false,
  confidence: 'medium',
  ...over,
});

const NO_ARGS = new Map<string, Readonly<Record<string, unknown>>>();

describe('DECROWD_ACTIVE_FAMILIES — measured scope', () => {
  it('is exactly the two counterfactually priced tools (widening REQUIRES a fresh traces replay)', () => {
    expect([...DECROWD_ACTIVE_FAMILIES].sort()).toEqual([
      'sfi.what_if_assign_permset',
      'sfi.what_if_revoke_permset',
    ]);
  });

  it('every active family is a what_if tool with a corpus block and a derived lexicon', () => {
    for (const tool of DECROWD_ACTIVE_FAMILIES) {
      expect(WHAT_IF_CANDIDATE_FAMILY.test(tool)).toBe(true);
      expect(FUNNEL_UTTERANCES[tool]?.length ?? 0).toBeGreaterThan(0);
      expect(WHAT_IF_ACTION_TRIGGERS.has(tool)).toBe(true);
    }
  });
});

describe('demoteUntriggeredWhatIfs — unit contract', () => {
  // Real funnel shape for "which permission sets does this user have":
  // assign (rank 2) and revoke (rank 4) sit parasitically above genuine reads.
  const plainRead = 'which permission sets does this user have';
  const shortlist: readonly ToolCandidate[] = [
    cand('sfi.unassigned_permission_sets', 0.404),
    cand('sfi.what_if_assign_permset', 0.39),
    cand('sfi.effective_permissions', 0.388),
    cand('sfi.what_if_revoke_permset', 0.355),
    cand('sfi.permission_risk_report', 0.353),
    cand('sfi.live_user_permsets', 0.343, { plane: 'live', liveRequired: true }),
  ];

  it('plain-read question: non-route ACTIVE what_if rows drop below every other row', () => {
    const out = demoteUntriggeredWhatIfs(shortlist, plainRead);
    expect(out.map((c) => c.tool)).toEqual([
      'sfi.unassigned_permission_sets',
      'sfi.effective_permissions',
      'sfi.permission_risk_report',
      'sfi.live_user_permsets',
      // demoted, NOT deleted — still present at the tail, original relative order.
      'sfi.what_if_assign_permset',
      'sfi.what_if_revoke_permset',
    ]);
    // Pure reorder: rows are the very same objects, scores/cosines untouched.
    for (const row of out) {
      expect(shortlist).toContain(row);
      expect(row.cosine).toBe(row.score);
    }
  });

  it('INACTIVE what_if families are never demoted, even fully untriggered', () => {
    // Every what_if family outside the active set keeps its rank on a
    // trigger-less question: the broad scope was measured to lose 40 turns
    // (34 follow-ups whose verb lives in the previous turn + 6 lexicon gaps).
    const inactive = Object.keys(FUNNEL_UTTERANCES).filter(
      (t) => WHAT_IF_CANDIDATE_FAMILY.test(t) && !DECROWD_ACTIVE_FAMILIES.has(t),
    );
    expect(inactive.length).toBeGreaterThan(0);
    const q = 'tell me about the account object'; // no trigger for any family
    for (const tool of inactive) {
      const list = [cand(tool, 0.5), cand('sfi.explain_field', 0.4)];
      expect(demoteUntriggeredWhatIfs(list, q).map((c) => c.tool)).toEqual([
        tool,
        'sfi.explain_field',
      ]);
    }
  });

  it('hypothetical question: every what_if keeps its rank', () => {
    const q = 'what happens if I unassign a permission set from this user';
    expect(WHAT_IF_HYPOTHETICAL_TRIGGERS.test(q)).toBe(true);
    expect(demoteUntriggeredWhatIfs(shortlist, q)).toEqual([...shortlist]);
  });

  it("family action verb: keeps THAT family's tool, still demotes the sibling", () => {
    // "revoke" is in the revoke_permset corpus lexicon but not the assign one.
    const q = 'revoke access checkup for the Sales permission set on this user';
    expect(WHAT_IF_HYPOTHETICAL_TRIGGERS.test(q)).toBe(false);
    const out = demoteUntriggeredWhatIfs(shortlist, q);
    expect(out.map((c) => c.tool)).toEqual([
      'sfi.unassigned_permission_sets',
      'sfi.effective_permissions',
      'sfi.what_if_revoke_permset', // kept at its relative rank: its own corpus verb appears
      'sfi.permission_risk_report',
      'sfi.live_user_permsets',
      'sfi.what_if_assign_permset', // demoted: no assign-family verb, no marker
    ]);
  });

  it('fromRoute what_if is never demoted, even on a trigger-less question', () => {
    const routed = shortlist.map((c) =>
      c.tool === 'sfi.what_if_assign_permset' ? { ...c, fromRoute: true } : c,
    );
    const out = demoteUntriggeredWhatIfs(routed, plainRead);
    // assign (fromRoute) holds rank 2; revoke (non-route) still drops to the tail.
    expect(out.map((c) => c.tool)).toEqual([
      'sfi.unassigned_permission_sets',
      'sfi.what_if_assign_permset',
      'sfi.effective_permissions',
      'sfi.permission_risk_report',
      'sfi.live_user_permsets',
      'sfi.what_if_revoke_permset',
    ]);
  });
});

describe('router de-crowd — end-to-end through buildFunnelCandidates', () => {
  it('plain-read question: every non-route ACTIVE what_if ranks below every other candidate', () => {
    const q = 'which permission sets does this user have';
    const route = classifyQuestion(q);
    const cands = buildFunnelCandidates(route, q, NO_ARGS, undefined);
    expect(cands.length).toBeGreaterThan(0);
    const lastNonDemotable = cands.reduce(
      (last, c, i) => (!DECROWD_ACTIVE_FAMILIES.has(c.tool) ? i : last),
      -1,
    );
    for (const [i, c] of cands.entries()) {
      if (DECROWD_ACTIVE_FAMILIES.has(c.tool) && c.fromRoute !== true) {
        expect(i).toBeGreaterThan(lastNonDemotable);
      }
    }
    // The demotion moved real parasites: the raw funnel puts
    // what_if_assign_permset at rank 2 for this question.
    expect(cands.some((c) => !DECROWD_ACTIVE_FAMILIES.has(c.tool))).toBe(true);
  });

  it('action question: the what_if candidate keeps a leading rank (no demotion)', () => {
    const q = 'what happens if I assign the Marketing permission set to this user';
    const route = classifyQuestion(q);
    expect(route.intent).toBe('permset-assign-impact');
    const cands = buildFunnelCandidates(route, q, NO_ARGS, undefined);
    // Fused + never demoted: the routed what_if leads.
    const rank = cands.findIndex((c) => c.tool === 'sfi.what_if_assign_permset');
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThan(3);
    // The list stays score-descending — nothing was demoted on an action ask.
    for (let i = 1; i < cands.length; i += 1) {
      expect(cands[i - 1]!.score).toBeGreaterThanOrEqual(cands[i]!.score);
    }
  });

  it('unrouted funnel-primary invariant untouched: pure cosines, no fromRoute, demotion only reorders', () => {
    const q = 'are the naming conventions in this org consistent or a total free-for-all';
    const route = classifyQuestion(q);
    expect(route.intent).toBe('unrouted');
    const cands = buildFunnelCandidates(route, q, NO_ARGS, undefined);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.fromRoute).not.toBe(true);
      expect(c.cosine).toBe(c.score); // scores never mutated by the demotion
    }
  });
});

describe('router de-crowd — ACTIVE lexicons stay in lockstep with the corpus', () => {
  // Lockstep is only pinned for the families we actually demote: an ACTIVE
  // family whose corpus gains a new verb the lexicon misses would silently
  // demote a genuine action ask. Inactive families' lexicons are dormant
  // plumbing — deliberately NOT pinned so the corpus can evolve without
  // pinning behavior we no longer ship.
  it('no stale lexicon entries for tools missing from the corpus', () => {
    const whatIfTools = Object.keys(FUNNEL_UTTERANCES).filter((t) =>
      WHAT_IF_CANDIDATE_FAMILY.test(t),
    );
    for (const tool of WHAT_IF_ACTION_TRIGGERS.keys()) {
      expect(whatIfTools).toContain(tool);
    }
  });

  it("every corpus utterance for an ACTIVE family carries that family's own trigger", () => {
    // The lexicons are DERIVED from these utterances — so by construction each
    // utterance must be recognized as an action/hypothetical ask. This pins
    // the derivation: adding a new utterance with a new verb forces the
    // lexicon to grow with it (never silently demote a genuine action ask).
    for (const tool of DECROWD_ACTIVE_FAMILIES) {
      const utterances = FUNNEL_UTTERANCES[tool] ?? [];
      expect(utterances.length).toBeGreaterThan(0);
      for (const utterance of utterances) {
        const triggered =
          WHAT_IF_HYPOTHETICAL_TRIGGERS.test(utterance) ||
          (WHAT_IF_ACTION_TRIGGERS.get(tool)?.test(utterance) ?? false);
        expect(triggered, `untriggered utterance for ${tool}: "${utterance}"`).toBe(true);
      }
    }
  });
});
