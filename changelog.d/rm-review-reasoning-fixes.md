# RM-review — 18 reasoning-model correctness fixes (Graph B / sfi.interpret)

**Type:** fix
**Scope:** packages/mcp (concept model + interpret engine + disambiguate_concepts), packages/contracts

## Changes

Corrects 18 adversarially-verified defects in the offline reasoning model (the
org-independent Concept Model that `sfi.interpret` joins against the vault). No
behaviour change to any rule that was already correct — every legit interpretation
stays byte-identical; only the fabricating / over-claiming cases are fixed.

- **Endpoint-type gate (new `toTypeIn` / `fromTypeIn` predicate).** Five edge-bind
  rules fired on the wrong query root because `componentTypes` scopes only which
  endpoints are *cited*, not which edges *match*. Now:
  - `profile-grant-provenance` / `profile-field-grant-provenance` no longer label a
    **permission-set** grant as a *Profile* grant when a PermissionSet is queried.
  - `external-service-named-credential` / `external-data-source-auth-provider` no
    longer fabricate a binding from an ordinary Apex `callout:{NamedCredential}`.
  - `custom-permission-referenced-gate` no longer fires on a Flow→subflow reference
    (target must actually be a CustomPermission).
- **SF-fidelity corrections.** `flow-run-mode/system-without-sharing` drops the false
  claim that an Apex `without sharing` class enforces object CRUD/FLS; the dead
  `role-access/case-controlled-by-parent` rule (an enum value Salesforce never emits)
  is removed; `custom-permission-gating` no longer asserts an ungrounded gate
  *direction*; `unique-constraint` reports `StatusCode.DUPLICATE_VALUE` (not
  `FIELD_INTEGRITY_EXCEPTION`); OWD posture fixes (Controlled-by-Parent ≠ master-detail,
  Public Read/Write/Transfer keeps its transfer grant, Public Full Access acknowledges
  restriction rules); `recursive-self-write` distinguishes before- vs after-save
  re-entry; `stacked-record-triggered-flows` hedges Flow Trigger Order; `flow-field-writer-collision`
  no longer frames non-record-triggered writers as a same-save race; the async
  queueable/@future rules list all cited targets (`{ids}`) instead of truncating to
  the first pair; `test-class-without-assertions` ships at `heuristic` (not `parsed`).
- **`disambiguate_concepts` honesty.** Field counts, differences, and the "when to use
  each" inference are now computed over the FULL match set, not the display-capped
  slice — surfaced counts are true, disjoint recommendations are no longer fabricated
  from an alphabetically-biased subset, and each bucket exposes `totalMatchCount` /
  `truncated` with a boundary disclosure.
- **Leak-gate + proof completeness.** The concept-model parity gate now scans
  witnessPartition free-prose templates, endpoint predicates, and operator operands
  for canonical ids. A new rule-proof completeness gate fails the suite if any shipped
  rule has no firing proof; the three previously unproven rules are backfilled.
