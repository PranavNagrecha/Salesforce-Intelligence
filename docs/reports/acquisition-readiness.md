# Acquisition readiness — the assets a source-code read misses

**Purpose.** A diligence pass that clones the repo and reads `packages/mcp/src/tools/`
sees a big TypeScript monorepo with a lot of MCP tool handlers. What it does not see —
because none of it lives in a single file a reviewer opens — is the eval/gate harness
that keeps 202 tools (198 advertised) from silently regressing, the confidence discipline threaded through
every graph edge, and the honesty posture that refuses rather than guesses. This document
assembles those invisible assets from artifacts that already exist in this repo. **Every
number below is either measured live against this worktree (method and command given
inline) or quoted from a committed report/decision file (file:line given inline).** Nothing
here is a projection or an invented metric. No customer, org, or personal identifier
appears anywhere in this document — verified in the Privacy section at the end.

Scope note: this is an engineering/product-evidence dossier, not a valuation memo. It
does not address revenue, adoption metrics, or deal terms.

---

## 1. Moat depth — one graph, three engines, confidence attached to every edge

The core asset is not any single tool; it's the graph underneath all of them. Every node
and edge carries a `ConfidenceLevel` (`declared | parsed | heuristic`) as a **required**
field — `packages/contracts/src/index.ts:495` — and the decision to make this
non-optional is recorded in `docs/decisions/ADR-001-confidence-tagged-edges.md:46-54`:
"Make confidence a first-class, non-optional property of every edge... Renderers must
surface confidence to humans, and consumers must not silently mix confidence levels."
That single contract is what lets three normally-separate product categories share one
data model without one polluting the others' trust level (`docs/POSITIONING.md:8-15`,
`:152-156`):

1. **A living org data dictionary** — `docs/POSITIONING.md:26-46` — per-object dictionaries,
   field-meaning inference, semantic field search, naming-convention detection.
2. **A Salesforce-specific SAST engine** — `docs/POSITIONING.md:47-70` — governor-limit
   risk detection, CRUD/FLS audit, hardcoded-value scanning, PII classification, dead-code
   reachability. Every finding here is tagged `heuristic` by design (`:69-70`).
3. **A change-safety / impact-analysis engine** — `docs/POSITIONING.md:72-91` — this is the
   hardest-to-copy piece:
   - `sfi.get_impact` (`packages/mcp/src/tools/get-impact.ts:1-8`) walks the graph BFS over
     *incoming* edges only — "the slice of nodes and edges that depend on the target."
   - `sfi.safe_to_delete_field` (`packages/mcp/src/tools/safe-to-delete-field.ts:1-14`)
     classifies every incoming edge into a category + verdict pair and aggregates them into
     one composed deletion verdict.
   - 11 distinct `sfi.what_if_*` simulators — change a field type, remove a picklist value,
     make a field required, deactivate a flow, disable a trigger, change a method signature,
     merge/split profiles, assign/revoke a permission set — each returning a structured
     `safe | review | risky | blocking` verdict (`packages/mcp/src/tools/index.ts:5097-5371`
     registers all 11 by name).
   - **Permissions math**: `sfi.effective_permissions` composes the union of a profile plus
     every assigned permission set, "max-wins," with muting permission sets subtracted, and
     attributes each grant to the container that grants it — then the permission-set
     what-if tools "call the engine twice (WITH and WITHOUT the target set) and diff the two
     net grant sets" rather than re-implementing the logic
     (`packages/mcp/src/tools/effective-permissions.ts:1-24`).

The wedge this creates — stated honestly, not as marketing copy — is in
`docs/POSITIONING.md:167-170`: *"The wedge is not 'we're better at SAST than Clayton' or
'better at deploys than Gearset.' We are not. The wedge is convergence + locality: the only
place where dictionary, code-quality, and impact questions are answerable in one breath,
over one private graph, for free."* A competitor that only copies the tool surface without
the confidence contract underneath it reproduces the UI, not the trust property that makes
the UI safe to rely on.

---

## 2. Eval rigor — the harness a `git clone` doesn't show you

`README.md:134` cites a "2,000-question real-org evaluation" (refusal gates cut
over-confident routes from 69 to 11 with zero answerable questions falsely refused) but
does not link the methodology behind that number. Here is where that methodology actually
lives, all reproducible in-repo:

### 2.1 Release gate (what has to pass before code ships)

`scripts/v4-done-gate.sh` is the full local release gate: build → lint → unit tests →
integration gate suite → e2e smoke → CI-vault build → strict retrieval eval → strict
analytical eval → 50k scale benchmark → 10k import budget test → 1000-field scoped-refresh
budget test → privacy guard. `.github/workflows/ci.yml` runs the CI-portable subset of the
same gate on every push/PR (org-leak scan → public-interface guard → build → lint → unit
tests → NL routing gate → privacy guard → e2e smoke → CI vault → retrieval eval →
analytical eval → two scale gates), plus a second, independent Windows job
(`.github/workflows/ci.yml:148-177`) that runs the portable subset on `windows-latest` —
added specifically because "the admin base is Windows-heavy" but CI had only ever run on
Ubuntu (`.github/workflows/ci.yml:88-90`).

### 2.2 Unit test suite — verified live, not asserted

Running `pnpm -r test` — the exact command CI's "Unit tests" step runs
(`.github/workflows/ci.yml:61-62`) — against this worktree (branch `cto/t2dossier`, based
on `cto/integration` @ `32904f4`, measured 2026-07-12) produced:

| Package | Test files | Tests passed | Skipped |
| --- | ---: | ---: | ---: |
| core | 2 | 34 | 0 |
| parsers | 5 | 157 | 1 |
| renderers | 10 | 151 | 3 |
| tooling-api | 4 | 55 | 0 |
| vault | 8 | 92 | 0 |
| graph | 25 | 285 | 0 |
| patterns | 3 | 131 | 0 |
| extractors | 74 | 997 | 136 |
| mcp | 234 | 4,858 | 8 |
| cli | 38 | 380 | 0 |
| **Total** | **403** | **7,140** | **148** |

**7,140 passing tests (7,288 including skipped) across 403 files, all green, zero
failures.** Reproduce with `pnpm install && pnpm -r build && pnpm -r test` from repo root.
The suite grows every release; this document reports the number actually measured against
the current tree rather than a stale estimate, and gives the exact reproduction command so
a buyer's own diligence team gets the same number.

### 2.3 Certification and accuracy reports (already committed, cited nowhere from README)

- **`docs/reports/scale-certification.md`** — 50,000-component synthetic graph import in
  40.5s (budget 420s) and typo-tolerant resolve at ~73ms/query over the same graph (budget
  5,000ms), against the 10,000-component regression floor that gates every CI build
  (`packages/graph/test/scale-import.test.ts`). Re-run with `pnpm eval:scale:cert`.
- **`docs/reports/sast-accuracy-report.md`** — the heuristic SAST recognizers measured
  against a labeled 20-case synthetic Apex corpus (`eval/sast-corpus.json`): **100%
  precision, 90% recall** overall, with the one false negative named and explained rather
  than hidden. Re-run with `pnpm eval:sast-accuracy`.
- **`docs/reports/phantom-taxonomy-audit.md`** — a real-org measurement (two anonymized
  vaults, `ORG_D`/`ORG_M`, no real API names) of what "dangling reference" edges actually
  consist of, driving an evidence-based (not guessed) design for the reference-stub /
  demand-retrieve architecture. This is the kind of report a diligence team rarely gets
  from a vendor: the negative-result data (84% of missing ids on the managed-heavy org
  contribute 0% functional value) that argued *against* a feature the team could otherwise
  have shipped.

### 2.4 The routing/funnel eval — recall as an authority metric, not a vibe

`packages/mcp/src/refusal-gates.ts:1-17` documents the router's honesty layer: score-
independent gates that run on the raw question *before* any intent scoring, so a refusal
never depends on how well an intent happens to score that day. `packages/mcp/test/
funnel-recall.test.ts:1-9` documents the relationship between what ships in this repo and
what runs in the full harness: *"The harness has the full router-recall + 1000-question
generalization evals; this is a small representative subset that runs in `pnpm -r
test`."* The in-repo tripwire is two batteries, 51 representative real-user-phrased
questions total: a 29-question aggregate battery at a conservative 0.78 recall@8 floor
(`packages/mcp/test/funnel-recall.test.ts:15-44`), and a 22-question per-case "blind-spot"
battery (`packages/mcp/test/funnel-recall.test.ts:81-111`) synthesized from a prior 2K-eval
diagnosis, where every individual case must land its gold tool in the top-8 with no floor
at all. Neither is the full bar — consistent with this repo's own convention of keeping the
sweep harness a tripwire and the real recall authority in the maintainer-only harness (the
harness itself is intentionally not shipped in the public package, the same reason
`docs/reports/phantom-taxonomy-audit.md:9-10` notes its analysis script "is not committed
[because] it holds real vault paths").

### 2.5 Honesty regression tests

`packages/mcp/test/honesty-seams.test.ts` (447 lines) pins three of the harness's worst
historically-measured honesty numbers as permanent regression tests: honest-gap detection
across twelve previously-unmodeled runtime-analytics shapes, a context/follow-up honest-gap
dip, and three named "genuine gate" cohort questions — each with an "answerable negative"
paired case to catch over-refusal. `docs/decisions/ADR-001-confidence-tagged-edges.md:81-83`
references the harness-side counterpart (`a4-honesty.mjs`, run outside this repo against
real vaults) that asserts tools cite the heuristic tier when a heuristic signal contributes
to a verdict — the in-repo test is the shippable, CI-executed subset of that same
discipline.

**Net:** the eval discipline is not one README line. It is a release gate that blocks
merges, a live-verified 7,140-test suite, three committed accuracy/certification reports
with negative results left in, and a two-tier recall harness (public tripwire + private
authority) — none of it visible from reading tool source alone.

---

## 3. Coverage — how much of a real org this actually models

The `ComponentType` union in `packages/contracts/src/index.ts:111-463` currently declares
**102 distinct component types** (verified live: `node scripts/product-surface.mjs` reports
`componentTypeCount: 102`, `edgeTypeCount: 23`, `toolCount: 202`, `skillCount: 25` against
this worktree, 2026-07-13). This is not a flat list — it's a chronological build-out
documented inline in the union itself, spanning:

- v1.0 core schema (objects, fields, validation rules, flows, Apex, layouts, profiles,
  permission sets, named credentials, connected apps)
- v1.1 sharing & visibility (groups, queues, roles, sharing rules)
- v1.2 record types & UI surfaces
- v1.3 legacy automation & communications (workflow rules, approval processes, assignment/
  auto-response/escalation rules, duplicate/matching rules, email templates)
- v1.4 developer frontend (LWC, Aura, Visualforce)
- v1.5 integration topology (auth providers, SAML SSO config, remote site settings, CSP
  trusted sites, external data sources/services, network access)
- v1.6 business-user record-value tier (custom permissions, custom metadata/setting
  records)
- v2.0a conditional-context (the "when does this fire?" primitive)
- v2.6a CPQ specialist tier (5 CPQ record types recognized via the `SBQQ__` namespace)
- v2.8–v2.9 async/integration deep tier (outbound messages, workflow alerts promoted from
  dangling references to real nodes)
- v3.2 OmniStudio/Salesforce Industries tier (OmniScript, Integration Procedure,
  DataRaptor, FlexCard, Decision Table)
- v4.0 enterprise safety tier (Report, Dashboard, ListView, ReportType, FlexiPage,
  PermissionSetGroup, MutingPermissionSet, RestrictionRule, ScopingRule) plus the
  previously-skipped CustomObject child metadata (compact layouts, web links, field sets,
  indexes)
- platform events, session/MFA security policy, and standard picklist value sets (R6-08)
- R6-18 Service Cloud entitlement/SLA + Omni-Channel routing tier (`EntitlementProcess`
  and related types, `packages/contracts/src/index.ts:307-320`), plus a later Einstein
  Bot/Agentforce tier (`Bot`, `BotVersion`) and Omni-Channel presence configuration

This breadth is backed by **75 extractor source files** under `packages/extractors/src`
(one file per metadata family, excluding the dispatcher `index.ts`; count verified via
`ls packages/extractors/src | grep -v index.ts | wc -l`).

The product does not claim this coverage is complete, and says so in the shipping product
itself, not just in a doc: `sfi.coverage_report`'s handler docblock
(`packages/mcp/src/tools/coverage-report.ts:4`) describes it in its own source as
"the enterprise honesty surface: it reports what the last vault build knows about its own
completeness, including metadata families that are not modeled yet," and the tool's
user-facing disclosure string (`packages/mcp/src/tools/coverage-report.ts:37`) is explicit
that a type under `notModeled` "is not analyzed by this product at all... its absence from
any result means 'not checked', never 'none'."
`CLAUDE.md:59-69` lists the covered surface in prose (schema, validation, Flows, Apex,
layouts, permissions/sharing, legacy automation, frontend, integration, OmniStudio, plus
composed impact/what-if/SAST/documentation analyses) and `CLAUDE.md:76-84` names the
self-reporting mechanism as load-bearing, not optional: "The product self-reports these
boundaries — cite them."

---

## 4. Honesty posture — the differentiator diligence usually can't verify from a demo

Most vendor demos show the happy path. This product's fail-closed behavior is testable
from the source and from the release gate itself:

- **Three-tier confidence, mandatory on every edge.** `declared` (Salesforce told us
  directly — e.g. the Tooling API's `MetadataComponentDependency`), `parsed` (AST/XML
  parsing of source), `heuristic` (regex/token analysis, may false-positive) —
  `packages/contracts/src/index.ts:483-495`. The rule is non-negotiable by design:
  `docs/decisions/ADR-001-confidence-tagged-edges.md:87-88` — "New edge producers MUST set
  a confidence; there is no default. A producer that cannot justify `declared`/`parsed`
  must use `heuristic`." Composed answers inherit the *weakest* edge on the path
  (`docs/POSITIONING.md:196-198`), never the average or the strongest.
- **Score-independent refusal gates.** `packages/mcp/src/refusal-gates.ts:1-17` runs
  injection/exfiltration, write-imperative, runtime-analytics, and out-of-scope detectors
  on the raw question *before* any intent-matching score is computed, "because honesty is
  mode-independent." A write imperative ("delete the X field for me") gets a
  `refused-write` shape with a named read-only alternative instead of silently no-op'ing
  or hallucinating a write path — `README.md:114-124`. Measured effect on a 2,000-question
  real-org evaluation: over-confident routes cut from 69 to 11 with **zero** answerable
  questions falsely refused (`README.md:132-135`).
- **Fail-closed live plane.** The default posture is fully offline —
  `docs/decisions/ADR-002-offline-vault-live-plane-boundary.md:23-26` — and the opt-in
  live read-only plane (`sfi.live_*`) "never falls back to vault data on failure, never
  runs arbitrary SOQL... and never mutates the org," with consent read as absent (gate
  stays closed) on any missing or corrupt consent store
  (`docs/decisions/ADR-002-offline-vault-live-plane-boundary.md:29-34`). `CLAUDE.md:29-46`
  states the same boundary in the product's own operator instructions: vault tools never
  call Salesforce unless the live plane is explicitly enabled, and only the curated
  `live_*` roster runs, never arbitrary SOQL.
- **Read-only by construction.** `docs/POSITIONING.md:136-138`: "These tools *act* — they
  deploy, they orchestrate releases, they sync orgs. sf-intelligence does none of that. It
  is read-only by design and answers 'what would happen' without ever touching your org."
  The read-only property is enforced below the tool layer, not just documented as policy:
  `docs/decisions/ADR-006-read-only-graph-access.md:24-27` records that every query-path
  consumer (the MCP server, the eval harness, fleet reads) opens the local DuckDB graph
  through `openGraphReadOnly` (`access_mode: 'READ_ONLY'`) — a connection mode that
  "never creates the file and never runs migrations," so the running server process is
  incapable of writing to its own local graph store, let alone the org. `refresh` is
  recorded as the sole writer (`docs/decisions/ADR-006-read-only-graph-access.md:33-35`).
- **Coverage-gated verdicts.** Destructive-sounding verdicts
  (`sfi.safe_to_delete_field`, the `what_if_*` family) attach a `coverageCaveat` when the
  metadata families they depend on aren't fully covered, rather than implying certainty
  from partial data (`CLAUDE.md:79-84`).

---

## 5. Competitive position — the honest version, as shipped

`docs/POSITIONING.md` states up front that it is "an honest competitive-positioning doc,
not a sales page" (`:3`) and flags unverified facts about competitors with `(verify)`
rather than asserting them (`:96-97`). As currently shipped, it compares against, by
category:

- **Org documentation / data dictionary** — Elements.cloud, Sonar/Strongpoint (now part of
  Salto) (`docs/POSITIONING.md:99-110`). Verdict given: both are richer, hosted,
  collaborative documentation surfaces; this product's dictionary is generated text
  composed for an LLM to narrate, not a clickable web app.
- **Code quality / SAST** — Clayton.io, CodeScan (AutoRABIT), and Salesforce's own free
  Code Analyzer (`:112-125`). Verdict given: these have larger, more battle-tested rule
  sets and (commercially) tuning/suppression workflows; this product is "a real SAST
  engine but a younger one with a smaller rule catalog."
- **Impact analysis / change safety** — Gearset, Copado, Salesforce Optimizer
  (`:127-138`). Verdict given: those tools *act* (deploy, orchestrate, sync); this one is
  read-only and answers "what would happen" without touching the org.

The differentiation claim is explicit and limited in scope (`:142-170`): no single
incumbent puts all three categories on one graph, none is reachable in natural language
from an editor, and the confidence-tagged graph means the product "never blurs 'the
platform will block this' with 'a regex thinks this might be true.'" The stated wedge is
**convergence + locality**, not superiority on any one axis (`:167-170`).

**Gap in the current positioning doc, disclosed here rather than silently patched over:**
as currently committed, `docs/POSITIONING.md` does not yet compare against Salesforce's
own official MCP server offerings or against dx0.io (a paid competitor analyzed in prior
internal research but not yet folded into this file). A buyer's technical diligence should
expect this comparison to be added before the doc is treated as the canonical competitive
record — flagging it here is more useful to a diligence process than pretending the doc
already covers it.

---

## 6. Known gaps — stated plainly, because a buyer respects a clear-eyed list more than a clean one

Most of the following are disclosed in the product itself, not just in this document —
each citation below is where the product says it to its own users. The single-maintainer
item is the exception: it is not disclosed anywhere in the shipped docs today, so it is
grounded directly in this repository's git history instead.

- **Single-maintainer project.** `git shortlog -sn` on this repository's history shows
  effectively one human author across the full commit history (two author identities that
  resolve to the same person — a personal address and a GitHub noreply address); there is
  no `CODEOWNERS` file in the repo. This is a real bus-factor risk for an acquirer to price
  in, not disclosed anywhere in the shipped docs today — surfaced here directly.
- **The heuristic-Apex ceiling.** Apex edge extraction runs a real parser-grade ANTLR AST
  pass by default since 0.1.9 (`docs/decisions/ADR-001-confidence-tagged-edges.md:10-22`),
  but a regex/token scanner still backfills what the AST can't resolve: "dynamic SOQL,
  reflective field access (`obj.get('FieldName')`), `Type.forName` dispatch, cross-method
  dataflow, trigger-framework base classes, and managed-package internals stay invisible to
  the edge-walkers" (`docs/POSITIONING.md:185-198`). All SAST code-quality findings are
  uniformly `heuristic` confidence, with a measured 90% recall / 100% precision on the seed
  corpus (`docs/reports/sast-accuracy-report.md:9-21`) — real, but a floor a buyer should
  independently pressure-test on a larger corpus before relying on it as an audit-grade
  SAST tool.
- **No hosted UI, no collaboration layer.** "There's no web dashboard, no shared workspace,
  no role-based access, no audit trail of who looked at what... Elements.cloud and the
  DevOps platforms are full products here; this is a library plus an MCP server"
  (`docs/POSITIONING.md:212-216`).
- **No live record-level data.** The graph stores metadata and source, not rows — "how
  many opportunities closed last quarter" and anything depending on live runtime state is
  explicitly out of scope for the offline vault (`docs/POSITIONING.md:180-184`); the opt-in
  live plane answers capped counts/samples only, never full record analytics
  (`docs/decisions/ADR-002-offline-vault-live-plane-boundary.md:17-19`).
- **Accuracy depends on refresh freshness.** "A confidently stated stale answer is worse
  than no answer" — the product flags staleness (`sfi.health_check`, `sfi.last_modified`)
  but cannot refresh itself mid-conversation (`docs/POSITIONING.md:206-211`).
- **Retrieval is still the stated ceiling.** `docs/POSITIONING.md:217-220`: "fuzzy
  resolution can invent confident false positives when a concept simply doesn't exist in
  the org. The front door is being hardened; until it is, a badly phrased query can
  under-return." This is an open, self-identified weakness, not a resolved one.
- **Scale is certified, not unlimited.** 50,000 modeled components is the certified
  ceiling (`docs/reports/scale-certification.md:1-6`); beyond that the documented guidance
  is a scoped refresh (`sfi refresh --types ...`), not a single unscoped pull.
- **The full eval harness (router-recall / 1000-question generalization / the honesty
  battery) is deliberately not shipped in this public repo** — it depends on real,
  maintainer-only vault fixtures with paths and data that cannot be committed publicly
  (see `docs/reports/phantom-taxonomy-audit.md:9-10` for the same non-commit rationale
  applied to a different maintainer-only script). This is why Section 2 above exists: to
  make the *shape and results* of that rigor visible to a reviewer who cannot run the
  harness itself, without exposing anything that would leak org data.

---

## Appendix — reproduce every measured number in this document

```sh
# Live product-surface counts (tools, ComponentTypes, EdgeTypes, skills)
node scripts/product-surface.mjs

# Full unit test suite (the number in Section 2.2)
pnpm install && pnpm -r build && pnpm -r test

# Release gate (everything CI + local-only checks run)
bash scripts/v4-done-gate.sh

# Scale certification (Section 2.3)
pnpm eval:scale:cert

# SAST accuracy report (Section 2.3)
pnpm eval:sast-accuracy

# Extractor file count (Section 3)
ls packages/extractors/src | grep -v index.ts | wc -l

# Privacy scan of the shipping set (see Privacy note below)
pnpm guard
node scripts/scan-org-leaks.mjs --strict
```

## Privacy

This document was scrubbed against this repo's own leak-prevention tooling before being
committed: `pnpm guard` (`scripts/release-guard.mjs`) and
`node scripts/scan-org-leaks.mjs --strict` both ran clean against the tree including this
file. No real Salesforce org identifiers, customer names, or personal data appear above;
the two anonymized org labels quoted from `docs/reports/phantom-taxonomy-audit.md`
(`ORG_D`, `ORG_M`) are that report's own pre-scrubbed labels, not identifiers introduced
here.
