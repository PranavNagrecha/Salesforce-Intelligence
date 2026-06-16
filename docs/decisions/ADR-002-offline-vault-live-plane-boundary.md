# ADR-002: Offline-first vault with an opt-in, fail-closed read-only live plane

## Status
Accepted

## Date
2026-06-07 (retroactively recording the v0.1 offline model + v4.0 live plane)

## Context
SfIntelligence is a knowledge base for a *production* Salesforce org. Two forces
pull in opposite directions:

1. **Trust and safety.** Admins are rightly wary of a tool that calls their org.
   Unbounded live queries can hit governor limits, surface PII, or imply writes.
   An offline tool is auditable, reproducible (the vault is checked into git),
   and cannot mutate anything.
2. **Some questions only the live org can answer.** Record counts, field
   population, inactive users, org limits — none of these live in metadata.

A purely offline product is honest but can't answer "how many Accounts"; a
freely-live product is powerful but dangerous and non-reproducible.

## Decision
Default to **offline**: nearly every `sfi.*` tool answers from the last vault
refresh (`org-kb/components/`, `org-kb/graph/graph.duckdb`,
`org-kb/meta/manifest.json`) and never calls Salesforce during a conversation.

Add a **separate, opt-in, read-only live plane** (`sfi.live_*`) that is
**fail-closed**: it never runs unless the caller explicitly enables it via
per-org `sfi.live_consent`, the `SFI_LIVE_PLANE_ENABLED` env, or a per-call
`liveEnabled: true`. Consent is persisted to a user-level, vault-independent
store (`live-consent.ts`); a missing or corrupt store reads as "no consent" and
the gate stays closed. The live plane never falls back to vault data on failure,
never runs arbitrary SOQL (only the curated `live_*` roster), and never mutates
the org. Provenance is always disclosed (`offline_snapshot` vs `live_org` vs
`hybrid`) so a live count never implies the vault proved something, or vice
versa.

Optional Tooling-API enrichment is a third, refresh-time-only path behind
`sfi refresh --with-tooling-api` — it touches the org at refresh, never during a
conversation, and is the sole producer of the `dependsOnFromApi` edge.

## Alternatives Considered

### Always-live (query the org per question)
- Pros: always current; answers record-level questions natively.
- Cons: non-reproducible, governor-limit and PII exposure, implies a write path
  we deliberately do not have. Rejected.

### Pure offline (no live plane at all)
- Pros: maximum safety, zero org calls.
- Cons: structurally cannot answer record-level questions; users hit a hard wall.
  Rejected in favour of an *opt-in* plane that keeps the safe default.

### Live-by-default with an opt-out
- Pros: convenient.
- Cons: a forgotten opt-out is an org call the admin never intended. The safe
  default must be the *closed* one. Rejected.

## Consequences
- The two planes never bleed: a vault tool cannot call the org, and a live answer
  is stamped `live_org` with its `liveQueriedAt`. The `a6-live-safety.mjs`
  battery asserts every `live_*` tool fails closed without consent.
- Answers are only as fresh as the last refresh; `sfi.health_check` /
  `checks.sourceHashMatches` drive the "re-refresh" nudge.
- The boundary is a documented capability claim (`CLAUDE.md` "Capability
  boundary") and must stay reconciled with code (B7).
- Builds on ADR-001: live answers and hybrid fusions carry their own
  `TrustSummary` provenance.
