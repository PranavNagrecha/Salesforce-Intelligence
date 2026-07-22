### Added

- `sfi.picklist_integrity_scan` — org-wide picklist value-set integrity scan, the
  inverse of `what_if_remove_picklist_value`. Sweeps every inline-value-set
  Picklist / MultiselectPicklist field and flags declarative literals (Validation
  Rule / formula-field formulas + `ISPICKVAL`, Flow decision criteria and literal
  assignments, Workflow-Rule criteria, field defaults) that reference a value the
  field does not define (`orphaned`, HIGH, with a spelling near-match) or defines
  only as inactive (`inactive-only`, MEDIUM). Distinguishes a COMPARISON (flagged
  — a branch that silently died on a value rename) from an ASSIGNMENT (a defect
  only for a `restricted` picklist; a free-text write to an unrestricted picklist
  is not flagged). Metadata-only and offline; Apex picklist-literal comparison is
  out of scope and disclosed as a verbatim boundary.
