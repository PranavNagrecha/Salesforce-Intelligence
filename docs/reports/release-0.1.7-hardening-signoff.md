# Release 0.1.7 — Phase 10 Hardening Signoff (P10-G2)

**Date:** 2026-06-07 · **Branch:** `release/0.1.7` · **Status:** ✅ gates green ·
**npm publish (P1-Q13): unblocked** (0 P0/P1 for npm; awaits explicit publish
authorization) · **GitHub-public: 1 tracked prerequisite** (git-history scrub).

Consolidated signoff for the Phase-10 hardening effort: the multi-org matrix,
every battery, the Track-B review, and the full bug ledger with disposition.
Anonymized — orgs are described by shape (managed-pkg/HEDA-edu, public-sector,
small/OmniStudio), never named.

This unblocks **P1-Q13 (npm publish)** per the contract gate: 0 open P0/P1
blockers for the npm package and all gates green. Publish itself remains a
deliberate, user-authorized step.

## 1. Front gate — latest `commit-gate.mjs` (release/0.1.7)

| Gate | Target | Result | |
|------|--------|--------|---|
| 1000Q effective (ok + expected_live) | ≥ 97% | **98%** | ✅ |
| 1000Q hard errors | 0 | **0** | ✅ |
| 1000Q route_gap | 0 | **0** | ✅ |
| Complex + long | ≥ 72/75 | **72/75** | ✅ |
| Baseline-300 product-ready | ≥ 55% | **83%** | ✅ |
| Integration battery | all pass | **30/30** | ✅ |
| Tool smoke | 0 hard | **0 hard** | ✅ |
| Conversational | ≥ 10 sensible | **10/10** | ✅ |
| what-if envelope | all enveloped | **6 ran / 6 ok / 3 no-target** | ✅ |
| Right-question routing | 0 gaps | **83/83** | ✅ |
| Wrong-question routing | 0 fabrication | **36/36 → unknown** | ✅ |
| Tool coverage | 0 anomalies | **0 / 149 tools** | ✅ |
| Doc-sync | pass | **pass** | ✅ |
| `pnpm guard` (release-guard) | 0 leaks | **0 / 639 public files** | ✅ |
| `scan:leaks` | 0 hits | **0** | ✅ |

## 2. Multi-org matrix (A1)

149-tool roster × 3 real orgs (managed-pkg-heavy, HEDA-edu, public-sector) via
the org-agnostic matrix harness. Result: **0 OVERSIZE / 0 INTERNAL / 0
EXCEPTION, 0 cross-org divergence**; the global ~45 KB response guard fires
correctly on the large orgs. Detail: `release-0.1.7-tool-matrix.md`.

## 3. Track A — adversarial / safety batteries (per gate vault)

All four roster batteries run on every gate vault (edu/HEDA, public-sector,
small/OmniStudio) on every commit-gate.

| Axis | Result |
|------|--------|
| A1 multi-org sweep | ✅ 0 oversize/internal/exception, 0 divergence |
| A2 oversize class | ✅ global guard intervenes; `get_edges` paginated (was the one un-actionable dead-end) |
| A3 cross-tool consistency | ✅ 5 tool pairs agree on all gate vaults; phantom-class guard hard-fails only on heuristic-local |
| A4 honesty invariants | ✅ plane-bleed / heuristic-tier / absence / phantom invariants hold; `tech_debt_score` heuristic-tier disclosure fixed |
| A5 router adversarial | ✅ 83/83 right, 36/36 wrong→unknown, 1000Q 98% |
| A6 live/hybrid safety | ✅ all 24 `live_*` tools fail closed without consent; budget/cache/staleness unit-proven |
| A7 refresh integrity | ⭐ incremental==cold **byte-identical** on real orgs (upsert + delete); default-refresh deletion-orphan documented |
| A8 fresh-eyes hunt | ✅ 24 adversarial inputs → graceful boundaries; 0 new product bug |
| A7b source-deletion reconcile | ⏸ deferred — needs a real org to build+verify the authoritative-set retrieve-diff |
| A7c gate A7 auto-trigger | ✅ FIXED — `gitChangedPaths()` now reads both repos (productRoot + qaRoot); +11-case unit test |

## 4. Track B — senior-engineer review

| Item | Disposition |
|------|-------------|
| B1 maintainability | ✅ reviewed high-quality; 1 contained fix (`LIVE_TABLE_ROW_CAP`) |
| B2 code docs | ✅ entrypoints + non-obvious internals documented; `core` module JSDoc gap filled |
| B3 architecture ADRs | ✅ 6 ADRs (trust model, vault/live boundary, edge contract, phantom taxonomy, byte budget, RO-graph) |
| B4 test refinement | ✅ approval parallel-approver test moved to the real singular `<approvalStep>` shape + plural fallback guard |
| B5 security | ✅ `live_field_population` SOQL identifier-validation gap fixed +2 negative tests; npm audit 0 high/critical |
| B6 simplification | ✅ 3-renderer cell escaper collapsed to shared `markdown-table.ts`; other clusters verified already DRY |
| B7 boundary doc-truth | ✅ architect-impact v0.2/v0.3 stale cluster reconciled (incl. 2 false "heuristic edge = bug" red flags); `verify-doc-sync` stale-phrase guard extended |

## 5. Bug ledger — disposition (anonymized)

Every real bug found in Phase 10, with disposition. Fix commits are on
`release/0.1.7` (product) or `main` (the `sf-intelligence-qa` harness).

**Closed (fixed this phase):**

- Phantom classifier mislabeled non-schema ids as "standard field" → guarded to schema ids.
- `soql-in-loop` / `dml-in-loop` double-counted nested loops → dedupe by source offset.
- `explain_apex_method` always returned empty quality findings → object-array reader.
- `unused_components` / `unused_fields_deep` / `find_dead_code` counted permission grants as usage → skip `grantedBy`.
- `what_if_change_field_type` analysed computed (Formula/Roll-Up) fields → now `invalid-query`.
- `tech_debt_score` blended heuristic codeQuality without citing the tier → heuristic disclosure (A4).
- Flow `$Record` condition refs minted phantom `CustomField:$Record.*` → resolve to the start object.
- `get_edges` had no pagination → `limit`/`offset`/`totalCount` + byte budget (A2).
- RestrictionRule / ScopingRule used the wrong file layout → never extracted → corrected + tests.
- Sharing rules dropped whole file on `<allPartnerUsers>` → variant added.
- A full `--no-pull` refresh now drops source-removed components (no orphan).
- `live_field_population` SOQL identifier validation (B5).
- site-data.json shipped an absolute maintainer path → removed from data + generator (G1-adjacent).
- A7 gate auto-trigger ran git in a non-repo cwd → reads both repos now (A7c).
- DOC-DRIFT: architect-impact stale boundary cluster (B7); doc-sync gate live.

**Open — disposition:**

| Finding | Severity | Disposition |
|---------|----------|-------------|
| GIT-HISTORY-ORG-IDENTIFIERS | P1 (GitHub-public only) | **Does NOT block npm.** npm ships the clean tarball (G1-verified), not git history. filter-repo rewrite deferred; keep repo PRIVATE until done. |
| P-PHANTOM-EDGES | P2 | Disclosed boundary — phantom taxonomy + uniform disclosure; not presented as fact. |
| EXTRACTION-REFRESH-PENDING | P2 (operational) | Gate vaults predate some extractor fixes; product code is correct. Live-vault bake = P11-Gfinal. |
| A7b source-deletion reconcile | P2 | Deferred — needs a real org to build/verify the retrieve-diff. Manual remedy documented. |
| ROUTER-RESIDUALS | monitor | New patterns added only when a battery proves a real phrasing gap. |
| DOC-DRIFT residual | P2 | Report/dashboard "not extracted" claims are true-by-default; G2b opt-in `--with-reports` note is a future enhancement, not a falsehood. |

**No open P0, and no open P1 that blocks the npm package.** The single P1 (git
history) gates only GitHub publicization, which is independent of npm publish.

## 6. Verdict

Phase-10 hardening is complete. All gates are green across three real org
shapes, the shipped artifact is privacy-clean and installs in a clean room, and
the bug ledger has 0 npm-blocking P0/P1.

**P1-Q13 (npm publish) is unblocked** and awaits the user's explicit
authorization (and OTP/token) per the release process. Making the **GitHub
repository public** additionally requires the git-history scrub
(GIT-HISTORY-ORG-IDENTIFIERS), which is independent of the npm release.
