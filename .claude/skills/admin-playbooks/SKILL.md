---
name: admin-playbooks
description: |
  Saved, repeatable admin routines for the sf-intelligence org that batch the
  right `sfi.*` tools in one request, then synthesize ONE report. Fire when the
  user asks for a named routine rather than a single fact — "run my pre-deploy
  checklist", "I inherited this org, give me the tour", "run a security audit",
  "what's junk in this org / what can I clean up", "is my org healthy / on fire",
  "audit sweep", "cleanup sweep", "go-live check". Each playbook is an ordered
  tool batch; run it end to end, then summarize. Single-fact questions go to
  `answering-org-questions` instead.
---

# Admin playbooks

## Usage & discovery (§C3 contract)

When a playbook (or a single ask) needs "where is X used / what references / what
depends on X" — for ANY component type — use `sfi.find_component_usages` (resolve
the name first), or the family specialist (`find_field_anywhere` for a field,
`layout_assignments` for a layout, `find_code_usages` for code). Route by VERB:
*describe* asks ("what is / list / what values") use describe tools, not usage
tools. Cite evidence tiers; an empty usage result is "no static evidence in the
vault", NEVER "nothing uses this".

## Overview

A playbook is a **named, repeatable routine** that runs several `sfi.*` tools in
a fixed order and folds the results into one report — the thing an admin does
the same way every release/audit/onboarding. The user asks for the *routine*
("run my pre-deploy checklist"), not a single fact; you run the whole batch,
then synthesize.

Two rules hold for every playbook:

1. **Confirm freshness first.** `sfi.health_check` once at the start; if
   `status` is `degraded` or `unhealthy`, or `freshness.stale` is true, stop and
   route to `/sfi-refresh` (or `/sfi-init` when the vault is missing). A stale
   vault makes every step below confidently wrong.
2. **Live steps are consent-gated.** Steps marked **(live)** need the opt-in,
   per-org live plane. If it is off, run the offline steps, then offer to enable
   live once with `sfi.live_consent { grant: true }` (read-only, persists) and
   re-run the live steps — never infer live facts from the vault.

Cite canonical component IDs throughout, and stamp each finding's provenance
(`offline_snapshot` / `live_org`) and confidence (`declared` / `parsed` /
`heuristic`). Use any tool's `rendered` field verbatim when present.

## The playbooks

### `pre-deploy` — "run my pre-deploy checklist" / "go-live check" / "is this safe to ship?"

The gate before a release. Run in order, then give a go / no-go with the blockers
named:

1. `sfi.coverage_report` — is the vault complete enough to trust the verdicts? Surface any `coverageCaveat` first.
2. `sfi.release_readiness_report` — the composite gate.
3. `sfi.test_coverage_gaps` — untested classes that will block deploy.
4. `sfi.governor_limit_risks` — SOQL/DML-in-loop and unbounded queries.
5. `sfi.find_hardcoded_values` — hardcoded IDs/URLs that break across orgs.
6. `sfi.crud_fls_audit` — CRUD/FLS gaps.
7. **(live)** `sfi.live_org_health` — failed jobs / paused flows / governors near limit *right now*.

Report: **GO** or **NO-GO**, then the ranked blockers, each with its tool + id.

### `onboard` — "I inherited this org" / "give me the tour" / "get me up to speed"

The new-admin orientation:

1. `sfi.org_overview` — the headline shape (counts, biggest objects, automation load).
2. `sfi.domain_clusters` — the functional areas the org breaks into.
3. `sfi.generate_architecture_overview` — data model / ERD.
4. `sfi.integration_map` — what external systems it talks to.
5. `sfi.permission_risk_report` — who holds the keys.
6. `sfi.org_history` — what's been changing lately.

Report: a plain-English tour, domain by domain, with an ERD and the "who/what to
watch" callouts.

### `security-audit` — "run a security audit" / "audit is asking" / "are we exposed?"

The access + exposure sweep:

1. `sfi.permission_risk_report` — over-permissioned profiles/permsets, god-mode.
2. `sfi.crud_fls_audit` — object + field-level security gaps.
3. `sfi.unassigned_permission_sets` + `sfi.empty_queues_and_groups` — dead access cruft.
4. `sfi.generate_sharing_summary` — OWD / sharing rules / role hierarchy.
5. `sfi.pii_inventory` — where sensitive data lives (FERPA/GDPR framing if relevant).
6. `sfi.generate_compliance_report` — the exposure write-up.
7. **(live)** `sfi.live_inactive_users` — dormant accounts to reclaim/disable.

Report: an access matrix + the ranked risks + a tightening recommendation.

### `cleanup` — "what's junk in this org?" / "what can I clean up?" / "cleanup sweep"

The dead-vs-alive sweep (read-only — names candidates, never deletes):

1. `sfi.unused_fields_deep` — fields with no static references.
2. `sfi.field_cleanup_candidates` — ranked deletion candidates.
3. `sfi.unused_components` — orphaned metadata.
4. `sfi.find_dead_code` — unreachable Apex.
5. **(live)** `sfi.live_report_usage` — reports not run in 90+ days.
6. **(live)** `sfi.live_email_template_usage` — Classic/unused templates to retire.
7. **(live)** `sfi.live_field_population` on the top candidates — confirm "defined AND empty in production" before recommending removal.

Report: a quantified dead-vs-alive list, ordered by safety, each with coverage
caveats. **Never** say "safe to delete" without `sfi.coverage_report` complete.

### `health` — "is my org healthy?" / "is my org on fire?" / "any problems right now?"

The operational pulse (mostly live):

1. **(live)** `sfi.live_org_health` — failed/pending async jobs, paused flows, governors ≥80%.
2. **(live)** `sfi.live_org_limits` — full limits headroom.
3. `sfi.org_risk_report` — offline tech-debt/risk to pair with the live signals.

Report: a red/amber/green pulse, with the specific failing signals named.

## Component-scoped diagnostics

The sweeps above are org-wide. These are the **targeted, high-frequency jobs** an
admin runs against ONE named component — `sfi.resolve` the component first, then
run the batch. Same rules: one synthesized report, ids + provenance, freshness
checked once.

### `field-visibility` — "who can see/edit this field?" / "why can't user X see it?"

The field-access diagnostic:

1. `sfi.resolve` — pin the field to its canonical `CustomField:` id.
2. `sfi.field_access_audit` — FLS read / edit / update grantors (which profiles & permission sets).
3. `sfi.why_cant_user_see_record` with `accessLevel` — the record-level cascade for a specific user/profile (FLS is necessary, not sufficient).
4. `sfi.field_360` — the full field profile to ground the answer.

Report: who can see vs edit, and the exact stage that grants or blocks each.

### `field-deletion-impact` — "is it safe to delete this field?"

The pre-deletion safety check (read-only — never deletes):

1. `sfi.coverage_report` — the completeness floor; surface any `coverageCaveat` BEFORE a verdict (never "safe to delete" under partial coverage).
2. `sfi.resolve` — pin the field.
3. `sfi.safe_to_delete_field` — the verdict + the references it found.
4. `sfi.get_impact` — the full incoming-dependency walk (carries a `soundness` envelope — a `dynamic-apex` blind spot means a dependent may be invisible).
5. `sfi.field_change_advisor` — the risk framing.

Report: SAFE / RISKY with the ranked dependents and the coverage + soundness caveats.

### `object-automation-map` — "what automation runs on this object?"

The save-time behavior map:

1. `sfi.resolve` — pin the object.
2. `sfi.what_happens_on_save` (per DML event) — the triggers / flows / workflow rules that fire on save.
3. `sfi.order_of_execution` — the full ordered save sequence (before-save flows → triggers → after-save → …).
4. `sfi.automation_risk_report` — the automation-risk overlay for the object.
5. `sfi.governor_limit_risks` — SOQL/DML-in-loop in the Apex that runs.

Report: the ordered save-time automation, with the risky steps flagged.

### `permission-risk-review` — "review permission risk" / "who holds the keys?"

The access-tightening review (scoped):

1. `sfi.permission_risk_report` — over-permissioned profiles / permission sets, god-mode (`ViewAllData` / `ModifyAllData`).
2. `sfi.effective_permissions` — the max-wins union for a named profile + its permission sets.
3. `sfi.who_can_access_object` — the reverse enumeration for a sensitive object ("who can read/edit these records").
4. `sfi.unassigned_permission_sets` — granted-but-unused access to reclaim.

Report: the ranked permission risks + a least-privilege tightening recommendation.

### `recent-change-analysis` — "what changed recently?" / "what's been touched lately?"

The change-since review:

1. `sfi.what_changed_since_refresh` — what moved between the last two vault states.
2. `sfi.changed_since` — components modified since a given date.
3. `sfi.org_history` — the longer change timeline.
4. `sfi.last_modified` on the hot components — who last touched each.

Report: a dated change timeline with who / what, newest first.

### `release-readiness` — "are we ready to release?" / "release-readiness review"

The focused go/no-go (lighter than the full `pre-deploy` sweep):

1. `sfi.release_readiness_report` — the composite readiness gate.
2. `sfi.promotion_readiness` — the promotion-specific check.
3. `sfi.what_changed_since_refresh` — exactly what's in this release.
4. `sfi.tests_for_change` — the minimal test set to run for the change.

Report: READY / NOT-READY, the blockers, and the tests to run.

## When NOT to fire

- **Single-fact questions** ("who can edit SSN?", "how many Accounts?") →
  `answering-org-questions` / `sfi.route_question`, not a playbook.
- **No vault yet** → `/sfi-init` first.
- **The user wants an artifact generated** (a `destructiveChanges.xml`, a
  permission set) → out of scope; the product is read-only/advisory. Name the
  boundary and hand them the analysis instead.

## Composition rules

- Run steps in order; a step that returns a structured error (e.g. live plane
  off, object unavailable) is **skipped with a note**, not a stop — keep going
  and report what you could and couldn't gather.
- **One report at the end**, not seven raw tool dumps. Lead with the verdict
  (GO/NO-GO, R/A/G, the headline), then the ranked detail with ids + provenance.
- If `sfi.route_question` returns `unknown`/a `gap` for part of the ask, say that
  capability isn't built yet (it's logged) — don't fabricate that step.

## Verification

Before sending:

- [ ] I ran `sfi.health_check` first and stopped on `degraded`/`unhealthy`/`freshness.stale`.
- [ ] I ran the playbook's steps in order; live steps only after consent (or I
      offered consent and ran the offline subset).
- [ ] I synthesized ONE report (verdict + ranked detail), not raw tool output.
- [ ] Every named artifact has a canonical id; every finding has provenance +
      confidence.
- [ ] For cleanup/destructive framing I checked `sfi.coverage_report` and never
      said "safe to delete" under partial coverage.
- [ ] I named any skipped step (live off, object unavailable, gap) instead of
      silently dropping it.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
