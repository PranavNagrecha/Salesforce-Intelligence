/**
 * Boilerplate stripped from tool descriptions BEFORE they enter the funnel's
 * BM25 corpus.
 *
 * WHY THIS EXISTS. `tool.description` serves two roles with opposite
 * requirements: it is the host-facing CONTRACT (which wants exhaustive caveats,
 * repeated verbatim wherever they apply) and it is the RETRIEVAL DOCUMENT
 * (which wants vocabulary that DISCRIMINATES between tools). Text that is
 * identical across N tools is maximally useful to a reader and actively harmful
 * to retrieval: it depresses the inverse document frequency of every term it
 * contains, for every tool in the corpus — including tools that never mention
 * the subject.
 *
 * Two measured instances, both real regressions caught by tests:
 *
 *   1. A declared-only dependency WARNING appended to four permission tools.
 *      Indexing it broke FOUR routing tests, including `sfi.org_card` — a tool
 *      the change never touched — because ~90 words of permission-and-`org`-heavy
 *      prose depressed `org`'s df corpus-wide. Stripping it restored org_card's
 *      self-recall to its clean-HEAD 5/6 exactly.
 *
 *   2. A `conceptReasoning` paragraph appended to four component-anchored tools.
 *      Individually harmless; jointly it diluted the very vocabulary
 *      (`concept`, `reasoning`, `rules`, `claims`) that distinguishes
 *      `sfi.interpret`, and displaced it from a top-5 recall assertion by
 *      0.0010 of a score point. Neither parent branch failed alone; only the
 *      merge did.
 *
 * This is the THIRD exception to "index the description" — `CORPUS_EXCLUDED`
 * (whole-tool) was the first. Three exceptions is the design telling us the
 * description should not BE the corpus. The durable fix is a curated retrieval
 * document per tool, decoupled from the advertised contract; `TOOL_KEYWORDS` is
 * already a curated retrieval channel and shows the shape. Until then, this
 * module is the single place that knows the difference — so a fourth instance
 * is a data change here, not a new mechanism somewhere else.
 *
 * INVARIANT: stripping changes ONLY what is indexed. The advertised description
 * a host reads is untouched, and a guard test asserts each marker is present in
 * every advertised description that should carry it and absent from every
 * indexed document.
 */

/**
 * A block that is repeated verbatim across tools and therefore pollutes IDF.
 *
 * `endsAtDescriptionEnd` blocks run to the end of the description (truncate at
 * the marker). Otherwise the block is bounded and `tail` closes it, so prose
 * written AFTER the block survives.
 */
interface BoilerplateRule {
  readonly id: string;
  readonly marker: string;
  readonly tail?: string;
  readonly endsAtDescriptionEnd: boolean;
}

const RULES: readonly BoilerplateRule[] = [
  {
    id: 'declared-only-dependency-warning',
    marker:
      ' DEPENDENCY EXPANSION IS NOT APPLIED HERE: this tool answers from DECLARED grants only, so its ',
    tail: 'for the expanded set.',
    endsAtDescriptionEnd: false,
  },
  {
    id: 'concept-reasoning-block',
    marker: 'Every response also carries `conceptReasoning`',
    endsAtDescriptionEnd: true,
  },
  {
    // FLOW-ORDER-IS-ALPHABETICAL. The within-phase-order caveat is carried
    // VERBATIM by both SOE composition tools, because they must stay in
    // lockstep — a host reading either one must get the same contract. Two
    // carriers is enough to matter: the block is ~110 words dense in
    // `flow`/`order`/`phase`/`trigger`, the exact vocabulary that separates the
    // flow tools from each other, so indexing it twice would depress those
    // terms' IDF across the whole corpus for no retrieval gain.
    id: 'within-phase-order-caveat',
    marker: ' WITHIN-PHASE ORDER IS NOT DETERMINED:',
    // The block ends at the three-state explanation, NOT at the `sfi refresh`
    // mention — that phrase appears MID-block and closes with a paren, so the
    // old tail matched nothing and the rule half-matched. A half-matched rule
    // is deliberately left ALONE (never truncated to the end), so the whole
    // ~1.1 KB block stayed in the indexed document for BOTH tools that carry
    // it — which is precisely the repeated-text IDF poisoning this module
    // exists to prevent. Pinned by corpus-boilerplate.test.ts.
    tail: 'because there is no gap to close).',
    endsAtDescriptionEnd: false,
  },
];

/** The markers, for the guard test that pins advertised-present / indexed-absent. */
export const CORPUS_BOILERPLATE_MARKERS: readonly string[] = RULES.map(
  (r) => r.marker,
);

/**
 * Remove every known repeated block from a description, for INDEXING ONLY.
 *
 * Returns the input unchanged when no rule matches, so a tool that carries no
 * boilerplate is byte-identical and cannot be perturbed by this pass. A rule
 * whose marker is present but whose bounded `tail` is missing is left ALONE
 * rather than truncated to the end — a half-matched rule must not silently eat
 * real capability prose.
 */
export const stripCorpusBoilerplate = (description: string): string => {
  let out = description;
  for (const rule of RULES) {
    const at = out.indexOf(rule.marker);
    if (at === -1) continue;
    if (rule.endsAtDescriptionEnd) {
      out = out.slice(0, at).trimEnd();
      continue;
    }
    const end = out.indexOf(rule.tail as string, at);
    if (end === -1) continue;
    out = out.slice(0, at) + out.slice(end + (rule.tail as string).length);
  }
  return out;
};
