/**
 * The shared "this tool does NOT apply dependency expansion" disclosure.
 *
 * ## Why this exists
 *
 * `sfi.effective_permissions` expands a container's declared system
 * permissions through the org's captured `PermissionDependency` graph, so
 * a set declaring `ManageUsers` reports everything `ManageUsers`
 * transitively requires. Its SIBLINGS do not: they read either the shared
 * declared-grant union engine (`computeEffectiveGrants`) or
 * `properties.userPermissions` straight off the node, and neither carries
 * the closure.
 *
 * That divergence is not a rounding error. It errs toward UNDER-stating
 * access — the direction in which a least-privilege reviewer approves a
 * grant they would otherwise have blocked — and it fails silently and
 * plausibly: "assigning this permission set grants 1 system permission" is
 * a clean, confident, wrong answer. Two tools answering the same question
 * about the same containers WILL disagree, by design, and the user has no
 * way to know which one applied the closure.
 *
 * ## Why it is centralised
 *
 * The text is built here, once, so the four surfaces cannot drift apart as
 * they are edited independently — the failure mode that produced the gap in
 * the first place was each tool being reasoned about on its own. A tool
 * that starts applying the closure should DELETE its call, not reword it.
 *
 * ## What is asserted vs measured
 *
 * The `ManageUsers` figure is an EXAMPLE MEASURED ON ONE ORG, and is
 * labelled as such. The dependency graph is org-VARIABLE (edition + enabled
 * features), which is exactly why the product captures it per-org rather
 * than modelling it; stating a per-org count as a platform constant would
 * be the same unchecked-claim mistake in a different place.
 */

/** Per-tool inputs for {@link declaredOnlyDependencyDisclosure}. */
export interface DeclaredOnlyDisclosureOptions {
  /**
   * What THIS tool's affected output is called, in the tool's own words —
   * e.g. `'system-permission delta'`, `'actionPermissions list'`. Rendered
   * as "its {noun} is a LOWER BOUND".
   */
  readonly noun: string;
  /**
   * Optional tool-specific sentence appended verbatim: a measured example
   * of the understatement biting THIS surface, or a note narrowing which
   * permissions it actually reads. Omitted when there is nothing concrete
   * to add — never padded.
   */
  readonly specifics?: string;
}

/**
 * Build the disclosure. Callers put it at the FRONT of their `disclosures`
 * array: it qualifies the whole answer, not a detail of it.
 *
 * @example
 *   disclosures.unshift(
 *     declaredOnlyDependencyDisclosure({ noun: 'system-permission delta' }),
 *   );
 */
export const declaredOnlyDependencyDisclosure = (
  options: DeclaredOnlyDisclosureOptions,
): string => {
  const specifics = options.specifics === undefined ? '' : ` ${options.specifics}`;
  return (
    'DEPENDENCY EXPANSION IS NOT APPLIED HERE. This tool answers from DECLARED grants only. ' +
    'Salesforce refuses to save a container granting a permission whose required permissions are not also enabled, ' +
    'so a declared system-permission list systematically UNDERSTATES effective access — on one probed org a permission set ' +
    'declaring `ManageUsers` conferred 15 permissions, not 1 (an example measured on ONE org, not a platform constant: the ' +
    'dependency graph is org-VARIABLE, which is why it is captured per-org rather than modelled). ' +
    '`sfi.effective_permissions` expands the declared set through the org’s captured PermissionDependency graph ' +
    '(`meta/permission-dependencies.json`); this tool does NOT, so its ' +
    `${options.noun} is a LOWER BOUND and the two tools will disagree on the same containers BY DESIGN.` +
    specifics +
    ' Run `sfi.effective_permissions` on the same bundle for the expanded set.'
  );
};

/**
 * The ROSTER-facing form of the same warning, appended to the MCP
 * `description` of every declared-only tool so a host LLM reading the tool
 * catalogue is told what the handler's own `disclosures` would tell it.
 *
 * `noun` names the affected output in the tool's own words, e.g.
 * `'system-permission GAIN delta'`.
 */
export const rosterDeclaredOnlyDisclosure = (noun: string): string =>
  ' DEPENDENCY EXPANSION IS NOT APPLIED HERE: this tool answers from DECLARED grants only, so its ' +
  `${noun} is a LOWER BOUND. ` +
  'Salesforce refuses to save a container granting a permission whose required permissions are not also enabled, ' +
  'so a declared list systematically UNDERSTATES effective access (on one probed org a set declaring `ManageUsers` ' +
  'conferred 15 permissions, not 1 — an example measured on ONE org, not a platform constant; the graph is org-VARIABLE). ' +
  "`sfi.effective_permissions` expands the declared set through the org's captured PermissionDependency graph and this tool " +
  'does NOT, so the two WILL disagree on the same containers BY DESIGN — run `sfi.effective_permissions` on the same bundle ' +
  'for the expanded set.';

/**
 * Remove every roster disclosure from a tool description.
 *
 * ## Why the retrieval corpus must not see this text
 *
 * `buildToolDocs` in `semantic-funnel.ts` indexes each tool's MCP
 * `description` VERBATIM as its retrieval document, and that file states the
 * standing invariant plainly: "any corpus edit shifts every term's IDF".
 * This disclosure is ~90 words of near-identical boilerplate repeated across
 * four tools, dense in exactly the vocabulary the permissions family needs to
 * discriminate on (`permission`, `grants`, `declared`, `container`, `org`).
 * Indexing it does three measurable kinds of damage:
 *
 *   1. it makes the four tools look alike, so they crowd each other's
 *      top-k slots;
 *   2. it loads them with generic permission vocabulary, so they outrank the
 *      tool that actually answers a permission question; and
 *   3. it inflates the document frequency of common terms it repeats
 *      (notably `org`), depressing their IDF corpus-wide and weakening
 *      UNRELATED tools that depend on those terms to be found.
 *
 * All three were observed: adding this text sank `sfi.org_card`'s self-recall
 * to 66.7% (below the 70% floor), displaced `sfi.interpret` from a top-5, and
 * pushed `sfi.list_components` out of the top-3 for "what custom permissions
 * are defined?".
 *
 * ## The strip removes the REGRESSION; it does not restore byte-identity
 *
 * Measured, clean-HEAD corpus vs this one (`buildToolDocs` snapshots diffed
 * over the 1,979-utterance funnel query bank):
 *
 *   - 2 of 204 documents changed TEXT — only the two what-if descriptions,
 *     whose "shares the effective-permissions ENGINE" sentence was corrected.
 *     That correction is real capability prose and BELONGS in the index.
 *   - 14 terms shifted document frequency (`closure` 1→3,
 *     `computeeffectivegrants` 0→2, `union` 10→12, …).
 *   - Because a df shift changes that term's IDF, 138 of 204 documents got a
 *     different tf-idf VECTOR despite identical text.
 *   - Net: 137 top-8 ORDER changes, 38 MEMBERSHIP changes, 4 confidence-band
 *     flips. `sfi.org_card` self-recall returned to its clean-HEAD 5/6
 *     (83.3%) — restored exactly, not improved.
 *
 * The pinned routing suites are all green, but they are a SAMPLE and do not
 * observe that residual: two sentences of legitimate prose moved 137
 * orderings. Green pins are not a measurement of corpus stability, and this
 * comment exists so nobody reads them as one.
 *
 * The text is a WARNING, not capability vocabulary — nobody searches for a
 * tool by its caveat — so it belongs in the advertised description and NOT in
 * the index. This mirrors the existing `CORPUS_EXCLUDED` precedent in
 * `semantic-funnel.ts`, which excludes `sfi.route_question` for the same
 * IDF-pollution reason at whole-tool granularity.
 *
 * Stripping is exact rather than fuzzy: the roster appends the output of
 * {@link rosterDeclaredOnlyDisclosure}, and this removes that same string, so
 * the two cannot drift.
 */
export const stripRosterDeclaredOnlyDisclosure = (description: string): string => {
  const marker = ' DEPENDENCY EXPANSION IS NOT APPLIED HERE: this tool answers from DECLARED grants only, so its ';
  const at = description.indexOf(marker);
  if (at === -1) return description;
  const tail = 'for the expanded set.';
  const end = description.indexOf(tail, at);
  if (end === -1) return description;
  return description.slice(0, at) + description.slice(end + tail.length);
};
