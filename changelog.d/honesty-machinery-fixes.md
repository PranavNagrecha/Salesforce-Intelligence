### Fixed

- **The response trimmer could shorten the "here is what I did not check"
  list.** When pass 1 of the global byte budget learned to descend one level
  into `data`, `data.trust` and `data.coverageCaveat` — present on every
  analysis tool — became reachable, so `trust.limitations` and
  `coverageCaveat.missingCoverage` turned into trim candidates for the first
  time. Neither publishes a count, so a silently shortened blind-spot roster
  read as the complete one: the single direction a trim must never fail in.
  Disclosure lists are now excluded from trimming outright, at both levels
  (`limitations`, `missingCoverage`, `blindSpots`, `boundaries`,
  `dataNotAvailable`, `phasesOmitted`, … and anything inside `trust` /
  `coverageCaveat`). A payload that cannot fit with its disclosures intact
  falls through to the structured `oversize` error naming the tool's own
  narrowing knobs — an honest refusal beats a quietly truncated caveat.

- **`nextOffset` could index a different list than the one it was returned
  for.** The same descent made a NESTED cut satisfy the `dropped > 0` test, so
  a trimmed `data.upstream.sources` emitted `nextOffset: 50` on a response
  whose top-level `matches` held 12 untouched rows — a host replaying
  `offset=50` gets an empty page and concludes it reached the tail. The hint is
  now emitted only when exactly one TOP-LEVEL list was trimmed; every other
  shape gets the existing note stating plainly that the dropped tail cannot be
  resumed. The nested-trim sentence also stopped asserting that the trimmed
  lists publish their true totals — a claim neither disclosure list makes.

- **`what_happens_on_save` spent the answer's budget on optional enrichment.**
  The concept-reasoning block was built first and its size subtracted from the
  save-order budget, so an opt-out-able block reserved space ahead of the
  order of execution the tool exists to return: on a real org's busiest object,
  `soe` came back with 27 of 109 steps with reasoning on and 54 with
  `includeConceptReasoning: false`. The steps are now fitted first against the
  whole budget and reasoning gets what is left (still capped by its own
  reservation ceiling). On a heavy object nothing remains and the block is
  dropped, with a verbatim note saying the steps kept the budget and that no
  concept layer was checked — "not checked", never "nothing found".

- **A trimmed save-order response contradicted its own prose.** Two sentences
  were baked before the global trim and never revisited: the phase-shortfall
  sentence (`"…25 fitted in this response"` beside a reconciled
  `phasesOmitted` of 12) and the truncation note's claim that *"every
  save-order STEP is present and in order"* on a payload holding 27 of 109
  steps. The reconciler that already re-stamps `phasesOmitted` after a global
  trim now also restates both sentences from that same reconciled value —
  appending the shortfall prose when the trim, not the handler, created the
  shortfall — so every count in the response derives from one source.

- **A container-selector refusal manufactured the disagreement it reported.**
  `{ componentId: 'X', permissionSetApiName: 'X' }` was refused with
  *"container selectors name different targets (PermissionSet:X, Profile:X)"* —
  the Profile came from the resolver's own bare-name default, not from the
  caller. A bare `componentId` states no family, so it no longer competes with
  a typed selector that names the same api name. Genuinely disagreeing
  selectors — two different names, or two different resolved ids — still refuse
  with the same message.

- **A scoped naming-convention report printed an org-wide denominator.**
  `analyzed.standardFieldsExcluded` was counted over every field in the org
  before the scope filter while `objectsWithCustomFields` was counted after it,
  so a single-object scope read `objectsWithCustomFields: 1` beside a figure in
  the thousands. The exclusion count is now scoped to the analyzed object, and
  the org-wide figure ships beside it as `standardFieldsExcludedOrgWide` —
  labelled in the response, not only in the tool description.

- **Two constants, one name, different text.** `find_dead_code` and
  `method_reachability` each defined `UNPROVEN_REGISTRATION_DISCLOSURE` with
  its own wording of the same rule, while the predicates behind it had already
  been centralised. The claim now lives once in `apex-reachability.ts` beside
  `isFrameworkSubclass` / `isCallableDispatch`; each tool prepends only its own
  verdict framing, and a drift test pins the shared body byte-identical across
  both surfaces.
