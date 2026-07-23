### Added
- Cited, dependency-ordered **remediation** on concept rules: `sfi.interpret` now
  emits an optional `remediation` on each grounded claim whose firing
  `ConceptRule` authors one — ordered fix steps filled from the SAME grounded ids
  and stamped with the SAME confidence as the claim (a fix is never stronger than
  the finding it attaches to). Authored for the security / governor / structural
  concepts `interpret` most fires on (apex-sharing-mode, external-api-surface,
  system-context-external-surface, view/modify-all object grants, master-detail
  cascade, stacked record-triggered flows) — 11 of 193 rules. Remediation
  templates are org-agnostic general Salesforce guidance (no canonical ids,
  enforced by the concept-model gate).
- `sfi.synthesize_answer` now folds authored remediation into its FIX / NEXT
  slots (`evidence.recommendedFix` / `evidence.nextAction`), attributed
  (concept · rule · confidence), hedged, and cited. A scraped recommendation
  still wins the slot (non-clobbering); a fired claim with NO authored remediation
  yields no fix and an explicit "no cited remediation authored" disclosure rather
  than a fabricated one.

### Changed
- Remediation ships the fix STEPS only and REFUSES counterfactual closure: no
  step, and no synthesized output, asserts the finding is cleared after the fix —
  no `what_if_*` tool mutates the sharing / CRUD / keyword shapes `interpret`
  reasons over, so the engine cannot compute closure. Where a real `what_if_*` /
  impact tool can MODEL the change (e.g. `sfi.what_if_revoke_permset`,
  `sfi.get_impact`, `sfi.what_if_deactivate_flow`), the remediation points at it,
  framed as "models the counterfactual; does not itself close this finding".
