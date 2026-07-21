### Changed
- **Grow-forever funnel routing for `sfi.interpret` (per-concept cards).** The semantic
  funnel scored each tool as one TF-IDF document, so every reasoning concept's utterances
  piled onto a single `sfi.interpret` document. Under length normalization that document
  saturated: adding utterances for a new concept diluted every term and pushed existing
  borderline concepts out of the funnel top-5, capping how many reasoning concepts could be
  natural-language-reachable. `sfi.interpret` is now scored as the **maximum** over its
  base document plus one small, independent **card per concept**
  (`INTERPRET_CONCEPT_CARDS` in `funnel-utterances.ts`). Each card is vectorized on its own
  length, so:
  - **Adding a concept never dilutes another** — the model can grow without bound. A new
    reasoning concept becomes NL-reachable by adding one key to `INTERPRET_CONCEPT_CARDS`;
    the flat `sfi.interpret` utterance list is no longer the growth surface.
  - **Existing routing is unchanged** — the base card is byte-identical to the prior
    `sfi.interpret` document and the IDF corpus is untouched, so every other tool's ranking
    and every previously-passing `sfi.interpret` query score exactly as before (a max only
    lifts). Verified: the three borderline concepts that used to regress
    (permission-set-group muting, dependent-picklist orphaned value, trigger-reachable
    bulkification) hold their exact top-5 rank.
  - The eight `arc2-concept-discovery` concepts, previously model-only, now rank
    `sfi.interpret` in the top-5 for their natural questions. Guarded by a new grow-forever
    invariant test (`semantic-funnel.test.ts`) that asserts every concept card is
    independently reachable and that cards do not displace specialist tools on unrelated
    queries. Deterministic and offline throughout — no new dependency, no package-weight
    change.
