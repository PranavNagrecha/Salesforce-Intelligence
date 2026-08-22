### Fixed

- **`sfi.find_formula_references` refuses a field it does not hold.** Four
  distinct causes produced a byte-identical `{ referencers: [], totalCount: 0 }`
  and three of them were lies: a miscased id, a typo'd id, a node of another
  type, and a real field that genuinely has no formula references. Only the last
  is an empty result. The tool now runs the same existence gate nine sibling
  field tools already pay for — `component-not-found` with typo-tolerant
  `resolveSuggestions`, and the phantom-aware wording that keeps a STANDARD
  field id from reading as "does not exist".

  **Behaviour change for callers:** an unknown id that used to return an empty
  list now returns an error envelope.

- **`find_formula_references`'s empty-result coverage caveat is reachable.**
  `FORMULA_REFERENCE_REQUIRED_COVERAGE` named two families (`CustomField`,
  `ValidationRule`) when eleven actually produce `references` edges into a
  field. It is now the observed producer set, censused from both reference
  vaults: `ListView`, `ReportType`, `FlexiPage`, `QuickAction`, `WebLink`,
  `ApprovalProcess`, `MatchingRule`, `CustomMetadataRecord`, and `Index` join
  the two. **This makes the caveat fire on more vaults** — that is the point:
  a zero from a vault missing `ListView` was never "none", it was "not checked".

- **The response-budget guard no longer goes blind on nested lists.** Pass 1
  read only the top-level keys of `data`, so a tool nesting its lists
  (`field_lineage`'s `data.upstream.sources`) offered it no array to cut and the
  whole response fell through to an opaque `oversize` error. It now descends one
  level and names the dotted paths it trimmed in `responseBudget.truncatedPaths`.
  Only payloads that were ALREADY over budget change; nothing under budget moves.

- **`sfi.field_meaning` counts every edge that consumes the field's value.**
  `usageFrequency.incomingReads` counted `readsFrom` alone, so a field read by
  formulas, validation rules and list views reported `0` — the number an admin
  deletes a field on. On the reference vault that was wrong for 2,911 fields.
  It now counts `readsFrom` + `references`, publishes the per-type breakdown in
  `readsByEdgeType` (so the old number is recoverable exactly), names the
  vocabulary in `countedEdgeTypes`, and publishes the inbound edges it saw and
  rejected in `excludedByEdgeType` — `usedInLayout` is placement, `grantedBy` is
  permission, `parentOf` is structure. A verbatim `note` states all of it, and
  `incomingReads: 0` now adds a boundary saying the zero is not proof of disuse.

  **Behaviour change for callers:** `incomingReads` is larger for most fields.
  It is an EDGE count, not a referrer count, so it legitimately differs from
  `find_formula_references`'s `totalCount`.

- **`sfi.value_change_audit` and `sfi.what_if_remove_picklist_value` answer the
  same coverage question the same way.** They carried two hand-copied family
  lists (9 vs 10 entries) and two near-duplicate private caveat formatters, so
  the SAME field on the SAME vault produced `completeness: 'complete'` from one
  and a five-family caveat from the other — a self-contradiction across one
  pair of tools. Both now read the shared `VALUE_LITERAL_READER_COVERAGE`
  through the shared `buildCoverageCaveat`, differing only in the subject noun
  phrase. A set-equality test across the two tools is the guard against drifting
  again.

  **Behaviour change for callers:** the caveat message text changed for both
  tools (private format → shared format), and `value_change_audit` now reports
  `partial` on vaults where it used to claim `complete`.

- **`sfi.explain_formula` reads the resolved relationship edge, and never mints
  an id that names no node.** A dotted path (`Advisor__r.Email`) returned a bare
  `toId: null` even when the refresh's relationship-resolver had already
  produced the target — the join key (`properties.traversalPath`) is
  byte-identical to the tokenizer's `ref.path`, and nothing read it. A
  single-segment reference minted `CustomField:{parent}.{path}` without ever
  asking whether that node existed. Both are the same defect: the resolver
  guessed. Every `toId` now names a real node or is `null` with a `resolution`
  (`relationship-unresolved` | `not-in-vault` | `no-parent-scope`) and a
  verbatim note. On a vault whose refresh produced no resolver edges, every
  dotted path reports `relationship-unresolved` — correct, and pinned by a test.

- **`sfi.explain_formula` emits literal VALUES.** `literals` carried one
  `{value: null}` row per counted literal — asserting three numeric literals
  exist while refusing to say what any of them were. The tokenizer already held
  the text and threw it away. `stringLiteralCount` / `numericLiteralCount` are
  unchanged.

- **`sfi.get_naming_convention_report` stops calling standard fields "custom
  fields".** The recognizer grouped every `CustomField` node, so it reported
  conventions about names Salesforce chose. On the reference vault 22 of 101
  observations described objects with ZERO custom fields, and three objects had
  the reported convention INVERTED by a standard-field majority. Standard fields
  are now excluded before grouping (`isCustomFieldApiName`, new in
  `@sf-intelligence/core`), and the response publishes the denominators —
  `analyzed.objectsWithCustomFields`, `objectsBelowMinimumGroupSize`,
  `minimumGroupSize`, `standardFieldsExcluded` — so an EMPTY observation list
  reads as NOT ENOUGH EVIDENCE rather than "no convention here". A scoped call
  that finds nothing says exactly that in a verbatim `note`.

  **Behaviour change for callers:** `evidence.total` on every existing
  observation is a custom-field-only denominator now, so the ratios move. That
  is a CORRECTION, not a regression.

  Same false label, same trip: `resolve_field_or_suggest`'s object-id
  suggestion said "Here are the N custom field(s) on X" while listing standard
  fields too. The list is deliberately left unfiltered — a caller may want a
  standard field — and the sentence now says what it actually is.

- **`sfi.lookup_record` honours the scope-echo contract.** Its non-strict input
  schema STRIPPED `objectApiName`, so a caller who scoped the question to the
  wrong object got a confident answer about a different one. It now echoes
  `appliedScope` {objectApiName, source} with the record's canonical casing,
  refuses a disagreeing selector with a named `invalid-query`, and — via
  `.strict()`, mirrored as `additionalProperties: false` in the advertised JSON
  Schema — refuses an unrecognized argument rather than ignoring it. Agreement
  is case-insensitive, since Salesforce api names are.

- **`sfi.what_if_remove_picklist_value` checks the value exists before rendering
  a verdict.** A typo'd value returned a `review` verdict byte-identical to a
  real value's — and the caller's next action on this tool's output is a
  metadata delete. The declared value set is now resolved first (inline
  `picklistValues`, else the field's GlobalValueSet edge). A value the field
  does not declare is refused with `invalid-query` listing the declared values
  and a did-you-mean; no impact scan is run. `valueState`
  (`active` | `inactive` | `not-checked`) and `declaredValues` are added to the
  payload. An already-INACTIVE value is still scanned, with a boundary saying
  the removal is a metadata DELETE, not a deactivation. When the value set
  cannot be resolved, the scan proceeds but says the value was NOT CHECKED
  rather than treating unresolvable as fine.

  **Behaviour change for callers:** a host that used to get a verdict for a typo
  now gets a refusal.

- **`sfi.compare_object_across_vaults` tells an extractor gap from org drift.**
  `collectDrift` emitted a row whenever the canonical JSON differed, which is
  true when a key is merely MISSING on one side — so comparing a current vault
  against one built by an older builder manufactured a drift row per object for
  every property that builder never wrote (up to 129 false rows on the
  reference pair). A one-query property-presence census now classifies every
  one-sided difference three ways: an extractor-coverage gap (moved out of
  `objectLevelDrift` into the new `propertyCoverageGaps[]`, with both sides'
  counts), a census-confirmed real absence (stays in drift with
  `presence: 'absent-in-a' | 'absent-in-b'` and a note), or — when the census
  cannot run — a drift row flagged `causeUnknown: true` saying both readings are
  open. It never silently picks a side.

  **Behaviour change for callers:** `PropertyDrift.valueA` / `valueB` are now
  OPTIONAL (omitted, not `null`, when the key is absent on that side), and
  `presence` is new. `compare_vaults` has its own copy of the type and is
  untouched.

- **`sfi.field_lineage` has the knobs its own oversize advice named.** The
  generic oversize message told callers to narrow with `limit` / `offset` /
  `cursor` — knobs this tool did not have — so a hub field's lineage was simply
  unanswerable. It now pages one designated `section`
  (`upstream.sources` | `downstream.effects`) with `limit` (default 200, max
  500) / `offset` / `cursor`, and publishes `upstream.sourceCount` /
  `downstream.effectCount` as TRUE pre-page totals. Paging keys are emitted
  ONLY when the response is actually paged, so an in-budget answer is
  byte-identical. Naming a section the requested `direction` did not produce is
  a named `invalid-query`; the DEFAULT falls back to the section that exists.
