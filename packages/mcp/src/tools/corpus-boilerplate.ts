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
 * A SECOND MECHANISM, added later and NOT the one described above. Four of the
 * rules below are carried by exactly ONE tool. Shared text is not why they are
 * stripped: a long contract block inflates its own document's token count, and
 * the scorer normalises term frequency by document length (`f / toks.length`),
 * so a 1KB caveat appended to a 1.4KB description halves the weight of every
 * word that actually discriminates that tool. Measured: the advisory funnel
 * probe fell 0.260 -> 0.258, below `FUNNEL_PRIMARY_MIN_SCORE`, and the tool it
 * demoted was one the change never touched. Stripping the four blocks returned
 * it to 0.261, above both the floor and the pre-change baseline.
 *
 * KNOWN COST of the single-carrier case, stated because it is real: a term that
 * appears ONLY inside a stripped block leaves the corpus entirely, and the
 * scorer treats an unseen term as `idf 0` — so a query built from that
 * vocabulary scores zero against every tool, not just this one. Accepted here
 * because the affected tokens are response-shape jargon (field names, flag
 * names) that a user does not type; `TOOL_KEYWORDS` is the channel to use if
 * any of them ever needs to be reachable. Do NOT strip a single-carrier block
 * whose distinctive vocabulary a user would plausibly say out loud.
 *
 * RULE: every entry below states WHY it is stripped and which of the two
 * mechanisms applies. An entry without that justification is unreviewable.
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
  {
    // CONTAINER-SELECTOR-CONTRACT. Carried verbatim by `user_ability`,
    // `tab_availability` and `effective_permissions` — the three tools whose
    // Profile / PermissionSet selectors route through `resolveContainerAlias`
    // and therefore share one refusal contract a host must read on all three.
    //
    // Measured, not assumed: with the clause written out on all three
    // descriptions and indexed, `sfi.interpret` was displaced from a top-5
    // recall assertion for a muting / permission-set-group question — the
    // sentence is dense in `profile` / `permission` / `container` / `selector`,
    // the exact vocabulary the permissions family needs to discriminate on.
    // The fourth instance of this pattern, and a data change here rather than
    // a new mechanism, as the module header asks.
    id: 'container-selector-contract',
    marker: ' CONTAINER SELECTORS: a bare name is coerced BY THE KEY',
    tail: 'echoed as `appliedScope.container`.',
    endsAtDescriptionEnd: false,
  },
  {
    // AUTOMATION-FAMILY-QA. The honesty batch added long contract blocks to a
    // dozen descriptions — pagination mechanics, activation-status partitions,
    // composed-analysis manifests. Each is REQUIRED reading for a host (code
    // and description must agree) and useless for RETRIEVAL: the blocks are
    // dense in exactly the vocabulary that separates the automation tools from
    // one another (`flow`, `order`, `phase`, `trigger`, `status`, `automation`,
    // `truncated`), so indexing them depressed those terms' IDF corpus-wide.
    //
    // MEASURED, not theorised: the advisory-tier funnel probe
    // ("contact has many active record-triggered flows - is their execution
    // order deterministic, and what is the risk?") fell 0.260 -> 0.258, below
    // FUNNEL_PRIMARY_MIN_SCORE, and the tool it demoted was
    // `sfi.automation_build_advisor` — which the batch never touched. Third
    // instance of this exact failure mode; see the two above.
    id: 'flow-fault-audit-paging-and-status',
    marker: ' The worst-first list PAGES:',
    tail: 'UNKNOWN, never assumed Active.',
    endsAtDescriptionEnd: false,
  },
  {
    // SECOND MECHANISM (length normalisation), single carrier: 733 B of scope
    // and activation-status contract on one tool. Required reading for a host
    // — the tool used to ignore an object scope silently — and pure ballast for
    // retrieval, since it repeats `flow` / `status` / `scope` without
    // distinguishing this tool from its sibling audits.
    id: 'flow-bulkification-scope-and-status',
    marker: ' OBJECT SCOPE is now honored rather than ignored,',
    tail: '`null` when the vault records no status.',
    endsAtDescriptionEnd: false,
  },
  {
    // SECOND MECHANISM, single carrier: 1039 B — 45% of this tool's whole
    // description. It explains that the structural verdict and the activation
    // status are reported on separate axes, which a host must read and a
    // retriever gains nothing from: `trigger` / `verdict` / `status` are the
    // terms the what-if family already competes on.
    id: 'what-if-trigger-two-axis',
    marker: ' TWO AXES, REPORTED SEPARATELY.',
    tail: 'not a proof of harmlessness.',
    endsAtDescriptionEnd: false,
  },
  {
    // SECOND MECHANISM (length normalisation), single carrier: the
    // dynamic-registration block on `find_dead_code`. It is REQUIRED reading —
    // it is the sentence that stops a reader deleting a running scheduled job,
    // and it grew when async dispatch joined the rule (CronTrigger is data, not
    // metadata, so no metadata walk can see a Setup > Schedule Apex
    // registration) — and it is pure ballast for retrieval: `class`, `code`,
    // `registration`, `metadata`, `namespace` are terms the Apex family already
    // competes on, and ~1.2 KB of them on a ~4 KB description dilutes every word
    // that actually discriminates this tool. Stripping keeps the advertised
    // contract byte-for-byte while leaving the indexed document as it was
    // before the block grew.
    id: 'dead-code-dynamic-registration',
    marker: ' DYNAMIC REGISTRATION is separated from death:',
    endsAtDescriptionEnd: true,
  },
  {
    // SECOND MECHANISM, single carrier: 774 B — 44% of the description. The
    // composition manifest names which sub-analyses ran and which did not; it
    // is the honesty payload for a report that previously degenerated into one
    // sub-analysis without saying so. Dense in `automation` / `report` /
    // `composed`, i.e. exactly this tool's own name repeated back at it.
    id: 'automation-risk-report-composition-manifest',
    marker: ' WHAT IT COMPOSED, STATED OUTRIGHT:',
    tail: 'under another name should say so.',
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
