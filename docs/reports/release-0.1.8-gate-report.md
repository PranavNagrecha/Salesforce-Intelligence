# Release 0.1.8 — Gate Report

**Date:** 2026-06-09 · **Branch:** `release/0.1.8` · **Status:** ✅ all release gates met

Metrics are from the full `commit-gate --release` battery (A7 refresh-integrity
trio on all three vaults) run against refreshed real-org vaults; real
identifiers are anonymized (the three orgs are referenced as **Vault A** /
**Vault B** / **Vault C** — a higher-ed org, a public-sector org, and a services
org respectively). This report is the **P12-REL-gate** deliverable: it confirms
every release gate before the npm publish step (**P12-REL-publish-deploy**,
user-gated on a maintainer's 2FA token).

## Release gates

| Gate | Target | Result | |
|------|--------|--------|---|
| commit-gate `--release` steps | 0 failed | **45/45, 0 failed** | ✅ |
| 1000Q effective (ok + expected_live) | ≥ 970/1000 (97%) | **980/1000 (98.0%)** | ✅ |
| 1000Q hard errors / bug flags | 0 | **0** | ✅ |
| Route-question contract (`routeMismatches`) | 0 | **0** | ✅ |
| Complex + long | ≥ 72/75 | **72/75** | ✅ |
| Baseline-300 (product-ready) | ≥ 55% (stretch) | **83%** (score 79%) | ✅ |
| Integration battery | pass | **30/30** | ✅ |
| Tool smoke (primary vault) | 0 hard errors | **63/63 ok, 0 errors** | ✅ |
| Tool smoke — second-vault P11 family | 0 not-ok | **12/12 ok** | ✅ |
| Conversational | ≥ 10 sensible | **10/10** | ✅ |
| what-if envelope | 0 bad | **6/6 ran, 0 bad (3 skipped)** | ✅ |

## A7 refresh-integrity (full trio, `--release`)

A `refresh --no-pull` re-extraction of each vault must reproduce a
**byte-identical** graph — proof that the shipped extractors + graph builder are
deterministic and that the vault on disk matches what the code produces today.

| Vault | Result | Time |
|-------|--------|------|
| Vault A | **byte-identical** ✅ | 358s |
| Vault B | **byte-identical** ✅ | 104s |
| Vault C | **byte-identical** ✅ | 68s |

## Multi-vault honesty / consistency batteries (all 3 vaults)

| Battery | Vault A | Vault B | Vault C |
|---------|---------|---------|---------|
| a3-consistency (cross-tool agreement) | ✅ | ✅ | ✅ |
| a4-honesty (heuristic-tier / absence≠none citations) | ✅ | ✅ | ✅ |
| a6-live-safety (live-plane consent gate, 0 fail-open) | ✅ | ✅ | ✅ |
| a8-fresh-eyes | ✅ | ✅ | ✅ |

## Unit tests (CI, `pnpm -r test`)

| Package | Tests |
|---------|-------|
| mcp | 2138 |
| extractors | 739 (+149 harness-skipped) |
| graph | 153 |
| cli | 150 |
| patterns | 107 |
| parsers | 92 |
| renderers | 72 |
| vault | 61 |
| tooling-api | 49 |
| **Total** | **3561 green** |

## Static / hygiene gates

- `pnpm lint` — clean
- `pnpm guard` (`ci:guard`, privacy scan of the shipping set) — OK, no private identifiers
- `pnpm scan:leaks` (`ci:scan-leaks`) — 0 hits
- `ci:doc-sync` (tool counts / docs ↔ roster) — OK
- `ci:slash-parity` (`/sfi-*` ↔ CLI commands) — OK
- `ci:response-consistency` + `harness:output-shape` (canonical id-key drift) — OK
- `harness:doc-schema` (every tool inputSchema well-formed + pinned contracts) — OK
- Router protection: `router-goldset`, `router-collisions`, `intent-gold-coverage`,
  `route-contract`, `tool-smoke-coverage`, `battery-right` / `battery-wrong` — all OK

## Findings

`FINDINGS.md` carries **0 open P0/P1**. The single open finding,
`P-PHANTOM-EDGES`, is a documented heuristic-extraction limitation (unresolved
Apex-receiver phantom edges) that the affected tools are phantom-aware about and
that `CLAUDE.md` lists as a standing capability boundary — not a release blocker.

## Scope of 0.1.8

This tag is primarily a **router-accuracy + product-experience** release on top
of 0.1.7's static-analysis moat: the §C3 universal usage & discovery contract
(`find_component_usages`), an `InstalledPackage` catalog, a uniform
static-analysis `soundness` envelope, the Phase-11 access/UI capability closes
(reverse access lookups, CRUD/create verdicts, app/tab/record-type/list-view
visibility), persona-led `capabilities` + grounded next-action `synthesize_answer`,
the router MOAT (gold-set + collision bank + intent-coverage CI gate), a
first-run onboarding suite (`quickstart` / `selftest` / refresh preflight /
`doctor` triage / local `feedback` / org-safety trust statement), and a website
refresh. Tool count **163**, component types **73**, edge types **22**.

## Conclusion

All release gates are green on a fully refreshed, byte-identical three-vault
battery. **0.1.8 is publish-ready.** The remaining step is
**P12-REL-publish-deploy** — `pnpm -r publish` of `sf-intelligence@0.1.8`
(npm before website per BUILD-CONTRACT, then tag `v0.1.8`), gated on a maintainer
with publish credentials and a 2FA token.

## Addendum — post-report verification & fixes (same day)

After this report, an independent verification re-ran the full `--release`
battery (45/45) and an adversarial QA pass landed five further commits, each
individually gated (43/43) and real-vault verified:

1. **CI trigger** (`ci:`) — the GitHub workflow listed release branches
   literally, so this release branch had never run hosted CI; now `release/**`
   (first hosted CI run on the branch is green).
2. **Restriction-rule honesty** (`fix(access)`) — RestrictionRule/ScopingRule
   parents now derive from `<targetEntity>` (top-level retrieve layout left
   `parentId` null, so the restriction caveats — including
   `why_cant_user_see_record`'s god-mode `unknown` — could never fire on real
   metadata); `who_can_access_object` god-mode rows + blind spots and
   `field_access_audit.update` (ModifyAllData counts as object-edit; FLS still
   required) now agree with the cascade.
3. **Router plurals** (`fix(router)`) — "which … fields are empty" reaches the
   hybrid `field-population` intent instead of a vault metadata count.
4. **First-run hardening** (`fix(cli)`) — `selftest` exits 1 on an unopenable
   vault; `feedback export` empty/write-failure guards; refresh temp manifests
   cleaned; doctor distinguishes "no route-gap log yet" from "ran clean".
5. **Semi-join SOQL reads** (`feat(parsers)`) — `IN (SELECT … FROM X)`
   subquery objects now mint `readsFrom` edges (child-relationship subqueries
   stay excluded).

The **final `commit-gate --release` at the new HEAD is GREEN: 45/45, 0
failed** — 1000Q 98.0% effective (0 hard errors, 0 route mismatches),
complex-long ≥ 72/75, baseline-300 83%, router gold-set 63/63 with 0
misroutes, A7 refresh-integrity byte-identical on the full vault trio. A
clean-room `npm pack` smoke at 0.1.8 confirmed the 4-file tarball,
`sfi --version` → 0.1.8, and honest no-vault doctor triage with correct exit
codes. The QA harness's A7 trigger gap (parsers/renderers diffs previously
skipped refresh-integrity) was also closed harness-side.
