# Release 0.1.7 — Phase 1 Gate Report

**Date:** 2026-06-02 · **Branch:** `release/0.1.7` · **Status:** ✅ all Phase 1 gates met

Metrics are from the full battery run against a refreshed demo vault (real
identifiers anonymized). This report is the **P1-Q12** deliverable: it confirms
every Phase 1 ship gate before the npm publish step (P1-Q13).

## Phase 1 ship gates

| Gate | Target | Result | |
|------|--------|--------|---|
| 1000Q effective (ok + expected_live) | ≥ 970/1000 (97%) | **978/1000 (97.8%)** | ✅ |
| 1000Q hard errors | 0 | **0** | ✅ |
| B21 route_gap | 0 | **0** | ✅ |
| Route-question contract (`routeMismatches`) | 0 | **0** | ✅ |
| Complex + long | ≥ 72/75 | **72/75** | ✅ |
| Baseline-300 solved (product-ready) | ≥ 55% (stretch) | **83%** (score 75%) | ✅ |
| Integration battery | pass | **30/30** | ✅ |
| Tool smoke | 0 hard errors | **35/35, 0 errors** | ✅ |
| Conversational | ≥ 10 sensible | **10/10** | ✅ |
| SCRUB history | 0 hits OR documented exception | release branch **0 hits / 82 commits** (main rewrite documented-deferred) | ✅ |
| GitHub CI | green on `release/0.1.7` | **green** | ✅ |

## Unit tests (CI, `pnpm -r test`)

| Package | Tests |
|---------|-------|
| mcp | 1781 |
| extractors | 708 (+149 harness-skipped) |
| graph | 133 |
| cli | 99 |
| vault | 54 |
| **Total** | **2773 green** |

(The lone `pnpm -r test` failure under parallel load is a perf-test timeout on
`get-impact`, which passes 27/27 in isolation — an environment flake, not a code
regression.)

## Static / hygiene gates

- `pnpm lint` — clean
- `pnpm guard` (privacy scan of shipping set) — OK, no private identifiers
- `pnpm scan:leaks --strict` — 0 hits
- `check-route-contract` (harness) — OK (scored batteries route via `routeQ`)

## Real-data volume validation (beyond unit tests)

Each behavior fix was exercised against the full real-data variety, 0 failures:

- **NI-2** (ApprovalProcess step counts) — all **25** approval processes match
  their source `<approvalStep>` count.
- **B29** (phantom-object honesty) — **6/6** phantom objects honestly disclosed
  (`targetMissing`), **12/12** real objects with no false phantom claim.
- **FRESH-02** (`list_components` retrieval hint) — **48/48** component types
  classified correctly (empty → hint, populated → no hint).

## Conclusion

All Phase 1 gates are green. **0.1.7 is publish-ready.** The remaining step is
P1-Q13 (npm publish), gated on a maintainer with publish credentials.
