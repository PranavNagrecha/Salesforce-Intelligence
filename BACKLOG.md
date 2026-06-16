# sf-intelligence Backlog

Items derived from 500Q pre-live validation (2026-06-11). Ordered by impact on score.

## Work Items

- [x] **FLD-01** -- Fix `field_cleanup_candidates` and `unused_fields_deep` to server-side filter by `objectId` when supplied — currently both return org-wide results ignoring the object argument.
- [x] **FLD-02** -- Add graceful object-level routing to all field tools (`field_360`, `field_lineage`, `field_provenance`, `field_meaning`, `explain_field`, `find_formula_references`, `downstream_effects`, `what_if_change_field_type`, `what_if_make_field_required`, `safe_to_delete_field`) — when a `CustomObject` id is passed instead of a `CustomField` id, return the object's field list with guidance rather than erroring.
- [x] **FLD-03** -- Fix `explain_formula` to accept either a `fieldId` (resolve formula expression from vault) or an inline `formulaExpression` string — currently only accepts expression text, causing score=0 when users pass a field id.
- [x] **FLD-04** -- Add `sfi.resolve` auto-suggestion to all field tools: when `component-not-found`, include candidate matches from fuzzy name search so users can self-correct without a separate resolve call.
- [x] **FLD-05** -- Enrich refresh with org `sobject describe` field snapshots for Account, Contact, Opportunity, Lead, Case (Metadata API retrieve does not emit uncustomized standard fields as `.field-meta.xml`; describe overlay is flagged `org-describe-snapshot`).
- [ ] **FLD-05b** -- Describe overlay must **enrich** stub standard-field metadata (type-only `.field-meta.xml` picklists like `Account.Industry`) with org picklist values — skip-only left `explain_field` without values (**TSB-05** / FINDINGS TEST-SANDBOX-STANDARD-SCHEMA-FALSE-NONE).
- [x] **RTG-01** -- Fix `call_graph` to make `direction` optional (default `both`) — currently both `rootId` AND `direction` are required, causing immediate error when direction is omitted.
- [x] **RTG-02** -- Fix `what_if_deactivate_flow` to accept flow label or partial name lookup in addition to exact flowId — resolve via `sfi.resolve` internally when a non-id string is passed.
- [x] **RTG-03** -- Add `EncryptedText` as a supported target type in `what_if_change_field_type` — currently returns unsupported-type error for Shield/Classic encryption field changes.
- [x] **RTG-04** -- Fix `downstream_effects` to support `CustomObject` as a root — currently only `ApexClass`/`ApexTrigger` accepted; object-level downstream should enumerate all triggers + flows + processes on that object.
- [x] **GRF-01** -- Fix graph extraction to resolve heuristic Apex receiver artifacts to real `ApexClass` component nodes — tighten local-variable heuristic (underscore names like `pkb_Controller` are real classes), vault-aware `get_impact` guard, and import-time `callsApex` target casing canonicalization.
