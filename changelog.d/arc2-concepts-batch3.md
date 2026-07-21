### Added
- **Reasoning model — five more offline concepts (104 → 109 concepts, 154 → 159 rules),
  all NL-reachable via the grow-forever funnel.** Each grounds on an already-extracted
  property with no new engine primitive, ships a firing `interpret()` seed proof, and gets
  its own funnel card so it ranks `sfi.interpret` top-5 for its natural questions without
  diluting any existing concept:
  - **`concept:field-classic-encrypted-text`** — a classic Encrypted Text field is masked
    for users without "View Encrypted Data" and is not filterable/sortable/groupable, nor an
    external id / unique / formula input (distinct from Shield Platform Encryption).
  - **`concept:field-autonumber-system-assigned-readonly`** — an Auto Number field is
    system-assigned at insert, read-only on every write path, null in before-save context,
    and stored as a formatted string.
  - **`concept:field-multiselect-picklist-storage-semantics`** — a multi-select picklist
    stores selections as one semicolon-delimited string, so SOQL/reports must use
    INCLUDES/EXCLUDES (not `=`/`IN`) and it cannot be a dependency controlling field.
  - **`concept:permission-set-license-scoped`** — a permission set bound to a specific user
    license is only assignable to users who hold that license.
  - **`concept:session-based-permission-set-dormant`** — a session-based permission set
    grants none of its permissions until it is session-activated; its grants are dormant
    otherwise.
  The last two were shipped-then-dropped earlier this cycle as funnel-losers (their query
  space is shared with permission-set specialist tools); the grow-forever per-concept-card
  funnel makes them independently reachable, so they are revived. Deterministic and offline
  throughout — cited `groundedIn`, confidence-tiered claims, no LLM, no live org read.
