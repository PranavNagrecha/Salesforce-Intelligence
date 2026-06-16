---
name: vault-coverage-honesty
description: |
  Routes coverage and destructive-verdict questions. Call sfi.coverage_report
  when the user asks whether the vault is complete, why something was not found,
  or before narrating safe-to-delete / what-if answers. Render coverageCaveat
  BEFORE the verdict — never footnote it. Refuse absence-based answers for
  not-modeled families; distinguish "not in vault" from "not in org".
---

# Vault coverage honesty

## When this skill applies

Fire when the conversation touches:

- Vault completeness ("is my vault complete?", "what wasn't retrieved?")
- "Why is X not found?" — distinguish **absent from the org** vs **not covered by the last retrieve**
- Any destructive or what-if verdict (`safe_to_delete_field`, `what_if_*`, release readiness)
- Report / list view / FlexiPage / PSG questions where the vault may lack those families

## Required tool order

1. **`sfi.coverage_report`** (or `sfi.health_check` coverage block) when completeness is unknown.
2. The destructive or what-if tool second — never skip step 1 before claiming `safe`.

## Rendering `coverageCaveat`

When a tool returns `coverageCaveat`, render it **before** the verdict:

> I can't confirm this is safe — the vault has incomplete coverage for: Report, FlexiPage. Treat missing dependencies in those families as **not checked**, not **none**. Verified dependencies: …

Never bury the caveat after a confident-sounding verdict.

## Verbatim disclosure

Carry the `sfi.coverage_report` disclosure:

> Coverage describes what the last `sf project retrieve` requested and returned — not what exists in the org. A type listed under `notModeled` is not analyzed by this product at all; its absence from any result means "not checked", never "none". Re-run `/sfi-refresh` after widening your retrieve manifest to close a gap.

v4.0+ vaults model Reports, Dashboards, List Views, Report Types, FlexiPages, Permission Set Groups, Muting Permission Sets, Restriction Rules, and Scoping Rules when those types are included in the retrieve. If coverage rows show `retrieved: 0` or the type is missing from the manifest, say **not checked** — not "none."

## Refusal patterns

| User question | Wrong answer | Right answer |
|---------------|--------------|--------------|
| "Which reports use this field?" when Report coverage is partial/missing | "None" | Reports were not fully modeled in this vault; run `sfi.coverage_report`, widen retrieve, or use the org's report UI. |
| "Safe to delete?" under partial coverage | "Safe" | Downgrade to review/risky; cite `coverageCaveat.missingCoverage`. |
| "Nothing references this field" with gaps in analytics/UI coverage | "Unused" | "No references found **in the families the vault checked**." |

## Composition with other skills

- **`freshness-tracking`**: freshness = how old; coverage = how whole.
- **`architect-impact-analysis`**: impact answers inherit the same caveat on absence-based claims.
- **Live plane** (`sfi.live_*`): live data does not repair offline coverage gaps; it answers runtime questions only when `SFI_LIVE_PLANE_ENABLED=1` or `liveEnabled: true`.

## Trust fields

Surface `data.trust.provenance` and `data.trust.completeness.status` when present:

- `offline_snapshot` — default vault answers
- `live_org` — opt-in `sfi.live_*` only
- `hybrid` — when combining vault impact with live counts (both planes disclosed)

## List views and skipped directories

When `manifest.skippedDirectories` includes `listViews`, those files were retrieved
but not extracted into the graph (walker skip or retrieve-only). Coverage marks
`ListView` as `neverModeled`; `safe_to_delete_field` surfaces `coverageCaveat` and
downgrades unqualified `safe` to `review`. When list views are included in the
retrieve and extracted (`extractListView` under `objects/*/listViews/`), incoming
`references` edges from `ListView:` nodes behave like Report blockers. Say
"not checked (list views not modeled)" rather than "no references found."

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — it returns the answering plane and the ordered `sfi.*` tools to run (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
