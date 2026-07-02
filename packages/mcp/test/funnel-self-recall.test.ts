/// <reference types="vitest/globals" />

/**
 * router-v2 R2 — CI SELF-RECALL GATE for the funnel utterance corpus.
 *
 * The invariant: every tool must be RETRIEVABLE BY ITS OWN VOCABULARY. For
 * each tool in FUNNEL_UTTERANCES, at least SELF_RECALL_FLOOR of its own
 * utterances must rank the tool inside the semanticCandidates top-8 (pure
 * funnel, no vault, no regex route). This makes "a new tool is invisible to
 * the funnel" a CI failure forever: a tool added with weak/genericized
 * utterances (or one whose vocabulary a later corpus edit washed out via IDF
 * shift) fails HERE, before any eval run can discover it.
 *
 * Why 70%: utterance lists deliberately include cross-vocabulary paraphrases
 * ("what else is affected?") that teach the tool's document useful terms but
 * legitimately lose the top-8 tie to a stronger owner of those words
 * (get_impact). A 100% bar would force every utterance to parrot the tool
 * name and destroy that bridging value. At the time this gate landed the
 * measured floor across gated tools was 77.8% (sfi.field_provenance, 7/9),
 * so 70% passes with real margin while still catching a collapse.
 *
 * Excluded tools: exactly the five meta/orchestration tools that
 * semantic-funnel.ts EXCLUDED_FROM_CANDIDATES drops from the candidate list
 * by design (route_question, synthesize_answer, run_analysis, list_analyses,
 * describe_analysis — they are indexed for IDF stability but never returned,
 * so their self-recall is 0 by construction, not by corpus weakness). This
 * list is asserted against observed behavior below so the two cannot drift
 * apart silently.
 */
import { FUNNEL_UTTERANCES } from '../src/funnel-utterances.js';
import { resetFunnelIndex, semanticCandidates } from '../src/semantic-funnel.js';

beforeEach(() => resetFunnelIndex());

/** Minimum fraction of a tool's own utterances that must retrieve it @top-8. */
const SELF_RECALL_FLOOR = 0.7;

/** Mirrors semantic-funnel.ts EXCLUDED_FROM_CANDIDATES (not exported). */
const CANDIDATE_EXCLUDED = new Set([
  'sfi.route_question',
  'sfi.synthesize_answer',
  'sfi.run_analysis',
  'sfi.list_analyses',
  'sfi.describe_analysis',
]);

const selfRecall = (tool: string, utterances: readonly string[]) => {
  let hits = 0;
  const misses: string[] = [];
  for (const utterance of utterances) {
    const top8 = semanticCandidates(utterance, 8).map((candidate) => candidate.tool);
    if (top8.includes(tool)) hits += 1;
    else misses.push(utterance);
  }
  return { hits, total: utterances.length, fraction: hits / utterances.length, misses };
};

describe('funnel self-recall gate — every tool retrievable by its own utterances', () => {
  it(`every candidate-eligible tool self-recalls ≥ ${SELF_RECALL_FLOOR * 100}% of its own utterances @top-8`, () => {
    const failures: string[] = [];
    for (const [tool, utterances] of Object.entries(FUNNEL_UTTERANCES)) {
      if (CANDIDATE_EXCLUDED.has(tool)) continue;
      const { hits, total, fraction, misses } = selfRecall(tool, utterances);
      if (fraction < SELF_RECALL_FLOOR) {
        failures.push(
          `${tool}: ${hits}/${total} (${(fraction * 100).toFixed(1)}%) — missing utterances:\n` +
            misses.map((m) => `    - ${m}`).join('\n'),
        );
      }
    }
    expect(
      failures,
      `tools invisible to their own vocabulary (enrich their utterances in funnel-utterances.ts):\n${failures.join('\n')}`,
    ).toEqual([]);
  });

  it('the exclusion list matches observed behavior (excluded ⇒ never returned; kept ⇒ retrievable)', () => {
    // If a tool on the local exclusion list ever STARTS appearing as a
    // candidate, semantic-funnel's exclusion set changed and this mirror is
    // stale — fail loudly instead of silently skipping a now-gateable tool.
    for (const tool of CANDIDATE_EXCLUDED) {
      const utterances = FUNNEL_UTTERANCES[tool] ?? [];
      const { hits } = selfRecall(tool, utterances);
      expect(
        hits,
        `${tool} is on the CANDIDATE_EXCLUDED mirror but was returned by semanticCandidates — update this test's exclusion list to match semantic-funnel.ts`,
      ).toBe(0);
    }
  });

  it('reports the corpus-wide floor (diagnostic tripwire against silent decay)', () => {
    let floor = 1;
    let floorTool = '';
    for (const [tool, utterances] of Object.entries(FUNNEL_UTTERANCES)) {
      if (CANDIDATE_EXCLUDED.has(tool)) continue;
      const { fraction } = selfRecall(tool, utterances);
      if (fraction < floor) {
        floor = fraction;
        floorTool = tool;
      }
    }
    // Not pinned to today's exact floor (0.778) — but a collapse below the
    // gate means the first test already failed; this assertion documents the
    // measured floor so a slow slide is visible in the diff history.
    expect(floor, `corpus floor tool: ${floorTool}`).toBeGreaterThanOrEqual(SELF_RECALL_FLOOR);
  });
});
