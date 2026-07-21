### Added
- **Reasoning model — eight new offline concepts (96 → 104 concepts, 145 → 154 rules).**
  A parallel discovery pass surfaced, and this change ships, eight additional
  org-independent structural-implication concepts behind `sfi.interpret`, each grounded
  on an already-extracted node/edge property with no new engine primitive and no
  extraction change:
  - **`concept:duplicate-rule-bypass-sharing-match`** — a duplicate rule whose
    `securityOption` is `BypassSharingRules` runs its matching in system context,
    comparing an incoming record against records the running user cannot see.
  - **`concept:duplicate-rule-references-inactive-matching-rule`** — an active duplicate
    rule that references a matching rule whose `ruleStatus` is not `Active` performs no
    detection on that matcher: dead duplicate protection that silently lets duplicates save.
  - **`concept:approval-process-final-lock-record-readonly`** — an approval process with
    `finalApprovalRecordLock` / `finalRejectionRecordLock` leaves the record locked
    read-only after it completes, so later user edits and automation updates fail until
    it is unlocked.
  - **`concept:record-type-inactive`** — a record type with `active=false` is not
    assignable to new records; excluded from layout / business-process routing reasoning.
  - **`concept:remote-site-setting-protocol-security-disabled`** — a remote site setting
    with `disableProtocolSecurity=true` permits non-HTTPS outbound callouts to its host
    (`isActive` gates whether it applies at all).
  - **`concept:apex-intentional-system-mode-dml`** — Apex DML issued with an explicit
    `AccessLevel.SYSTEM_MODE` argument *deliberately* opts out of the running user's object
    CRUD and field-level security for that write. Surfaced as a review surface, honestly
    NOT a proven defect (a system-context write is often correct); heuristic, from
    tokenized source.
  - **`concept:field-longtext-richtext-not-filterable`** — Long Text Area and Rich Text
    (`Html`) fields cannot appear in a SOQL `WHERE` / `ORDER BY` / `GROUP BY`, a list-view
    or report filter, and cannot be an external id or unique field.
  - **`concept:dataraptor-field-security-unenforced`** — a DataRaptor
    (`OmniDataTransform`) with `fieldLevelSecurityEnabled=false` reads/writes SObject
    fields without enforcing the running user's FLS.
  Deterministic and offline throughout — cited `groundedIn`, confidence-tiered claims, no
  LLM, no live org read. Each ships with a firing `interpret()` seed proof.

### Notes
- **All eight concepts are NL-reachable via the grow-forever funnel** (see the
  companion `sfi.interpret` per-concept-card change). These concepts were first shipped
  *model-integrated only*, because the `sfi.interpret` funnel document was saturated —
  adding natural-language utterances the old way regressed existing borderline concepts
  (permission-set-group muting, dependent-picklist orphaned value, trigger-reachable
  bulkification) out of the funnel top-5. The funnel engine change removes that ceiling:
  each concept is now scored as its own independent card, so all eight rank `sfi.interpret`
  in the top-5 for their natural questions **without** moving any existing concept.
  Two discovery candidates (`permission-set-license-scoped`,
  `session-based-permission-set-dormant`) remain dropped: their query space is fully owned
  by permission-set specialist tools.
