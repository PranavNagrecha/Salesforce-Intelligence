### Added
- **Reasoning model — two new offline concepts (94 → 96 concepts, 143 → 145 rules).**
  `sfi.interpret` now recognizes two additional org-independent structural-implication
  concepts, each grounded against already-extracted metadata with no new engine primitive:
  - **`concept:validation-rule-inactive`** — a validation rule whose `active` flag is false
    never evaluates its error-condition formula, so it can neither block a save nor surface
    its message; it is excluded from save-order / save-failure reasoning and required-field
    gate counts. Names the non-enforcing structural fact only (the formula is not evaluated
    offline).
  - **`concept:workflow-rule-inactive-dead`** — an inactive workflow rule is dead legacy
    automation whose field updates, alerts, outbound messages, and time-dependent actions
    never run; it is excluded from save-order and automation-impact counts. Does not claim a
    Flow has replaced it (migration lineage is org-specific).
  Deterministic and offline throughout — cited `groundedIn`, confidence-tiered claims (all
  `declared`), no LLM, no live org read. Each ships with a firing `interpret()` proof and
  natural-language funnel hooks so the concepts are reachable from `sfi.interpret`'s top-5.
