# Contributing to sf-intelligence

Thank you for helping improve SfIntelligence. This project is MIT;
by contributing you agree your contributions are licensed under the same
terms.

## Before you start

1. Read the [README](./README.md) and [documentation index](./docs/README.md).
2. For product boundaries and honest limitations, see
   [`docs/POSITIONING.md`](./docs/POSITIONING.md) and
   [`docs/architecture.md`](./docs/architecture.md).
3. Security issues: see [`SECURITY.md`](./SECURITY.md) — do not file public
   issues for vulnerabilities.

## Development setup

```sh
git clone https://github.com/PranavNagrecha/Salesforce-Intelligence.git
cd sf-intelligence
pnpm install
pnpm build
```

Requirements: **Node.js 20+**, **pnpm 10+**.

## Project layout

See [`REPO-STRUCTURE.md`](./REPO-STRUCTURE.md) for the monorepo map:

- `packages/contracts` → shared types
- `packages/extractors` → metadata → graph nodes/edges
- `packages/graph` → DuckDB store
- `packages/mcp` → MCP server and `sfi.*` tools
- `packages/cli` → `sfi` command and refresh pipeline
- `.claude/skills/` → agent skills (edit in place)

Each package has co-located unit tests under `packages/*/test/`. Cross-package
integration tests live in `tests/integration/` and need maintainer fixtures;
run them with `pnpm test:all` when those fixtures are available (not part of
default CI).

Some extractor unit tests skip unless `SFI_HARNESS_ROOT` points at a directory
that holds both `tests/fixtures` and `tests/golden`. Without it, `pnpm test`
still builds and runs; those skipped assertions simply do not execute.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Compile all packages |
| `pnpm test` | **Builds first**, then package unit tests (`pnpm -r build && pnpm -r test`) |
| `pnpm test:all` | `pnpm test` plus the integration suite |
| `pnpm lint` | ESLint |
| `pnpm eval` | Retrieval golden eval |
| `pnpm eval:analytical` | Analytical tool eval |
| `pnpm v4-gate` | Full release gate (lint, test, eval, scale, guard) |
| `pnpm guard` | Privacy scan of shipping set (needs org blocklist, or `SFI_ALLOW_NO_BLOCKLIST=1`) |
| `pnpm e2e` | MCP transport smoke (graph-level vault) |
| `pnpm onboard:smoke` | New-user onboarding chain on a synthetic fixture (init → refresh → doctor → samples) |

Run `pnpm v4-gate` before opening a PR that touches MCP tools, extractors, or
release artifacts.

## Adding or changing MCP tools

`packages/mcp/src/tools/index.ts` is re-exports only. The live registry is
`packages/mcp/src/tools/roster.ts` (`V01_TOOLS`); dispatch is the switch in
`packages/mcp/src/tools/tool-dispatch.ts`.

A **new** tool touches every row below. The "Outsider can run?" column is what
you can verify from a public clone with no private vaults or harness.

| What to touch | Why | Outsider can run? |
| --- | --- | --- |
| Handler `packages/mcp/src/tools/<tool-name>.ts` | Implementation | Yes — compile / unit test |
| `packages/mcp/src/tools/roster.ts` (`V01_TOOLS`) | Advertised schema | Yes — `pnpm doc-sync` / build |
| `packages/mcp/src/tools/tool-dispatch.ts` switch arm | Runtime invoke | Yes — unit / e2e smoke |
| `packages/mcp/src/intent-router.ts` grandfather list (if not funnel-routable yet) | "every tool is router-reachable or grandfathered" test | Yes — that package test |
| `packages/mcp/test/server.test.ts` expected name list (order-sensitive) | Roster drift test | Yes — that test |
| `packages/mcp/test/tools/<tool-name>.test.ts` | Per-tool coverage | Yes — unit test |
| Funnel-recall gold row in `packages/mcp/test/funnel-recall.test.ts` | Definition of done for routing | Partly — in-repo test yes; authoritative recall harnesses are maintainer-only |
| Regenerate `eval/product-manifest.json` + `eval/product-surface.json` (`pnpm product-manifest` / `pnpm product-surface`) | Manifest / surface check scripts | Yes |
| `website/src/data/site-data.json` `toolCount` | `pnpm doc-sync` | Yes |
| `packages/mcp/src/tools/tool-profile.ts` if the tool is directly invokable on the default profile | Skill-gateway / profile gate | Yes |
| `changelog.d/<slug>.md` fragment | `pnpm changelog:check` | Yes |

Also update skills when user-facing behavior changes (especially
`.claude/skills/using-sf-intelligence/SKILL.md` and
`.claude/skills/answering-org-questions/SKILL.md`), and
`docs/architecture.md` / `docs/guides/asking-questions.md` if trust boundaries
change.

**Rebuild after any `packages/mcp/` change.** The `sfi` command bundles the MCP
server into `packages/cli/dist/index.js`, so an MCP or router edit is not live
in `sfi mcp` until you build. `pnpm test` already builds first; while iterating
you can use:

```sh
pnpm --filter sf-intelligence build   # rebuilds packages/cli/dist/index.js
```

Tools must stay **read-only**. Do not add write paths to Salesforce.

### New reverse-lookup / "where used" tool checklist (the usage & discovery contract)

Any tool, router intent, or skill that answers a reverse / dependency / "where is
X used / who references X / what depends on X" question — for **any** component
type, not just custom metadata — MUST follow this contract:

1. **Resolve first** — natural language → canonical `componentId` via `sfi.resolve`
   before answering. Never guess an id.
2. **Route by verb, not noun** — *describe* (what is / list / store / values) ≠
   *usage* (where used / who references / reads / depends on) ≠ *impact* (what
   breaks if I change/delete). Describe tools (`get_component`, `list_components`,
   `lookup_record`) must NOT win usage phrasing.
3. **One canonical usage surface per component family** — an existing specialized
   tool (e.g. `find_field_anywhere`, `find_code_usages`, `layout_assignments`) OR
   the universal dispatcher `find_component_usages`. Do not fan out across four
   tools per question.
4. **Evidence tiers** — graph referrers carry edge `confidence`
   (`declared`/`parsed`/`heuristic`); an optional source-grep supplement
   (`search_apex_source`, `search_flow_metadata`) is labelled `text-match`; add
   `soundness` / `boundaries[]` when static analysis has blind spots.
5. **Empty ≠ absent** — empty graph + empty grep means **"no static evidence in
   the vault"**, surfaced in `boundaries[]` — NEVER "nothing uses this".
6. **Caps readable** — `truncated` / `scanTruncated` / `boundaryNote` +
   pagination on large lists (see the scan-cap helper).
7. **Router locked** — a funnel-recall gold row per family plus a collision vs
   the nearest describe/impact intent; empty-result wording must stay honest.

## Adding extractors

1. Add extractor in `packages/extractors/src/`.
2. Extend `ComponentType` / `EdgeType` in `packages/contracts` if needed.
3. Add renderer output in `packages/renderers` if new Markdown is required.
4. Add unit tests with fixture metadata under `packages/extractors/test/`.

## Documentation

User-facing doc changes belong in:

- `README.md` — headline behavior and install
- `docs/guides/` — step-by-step user guides
- `docs/architecture.md` — technical depth
- `docs/configuration.md` — env vars and live plane

Update [`docs/README.md`](./docs/README.md) when adding new doc files.

Agent skills live in `.claude/skills/*/SKILL.md`; edit them in place.

## Privacy guard — org identifiers

The scanner in `scripts/scan-org-leaks.mjs` reads a gitignored local config
(`scripts/forbidden-names.local.json`) that lists your org-specific identifiers.
**If you maintain a real org vault, create this file before pushing:**

```sh
cp scripts/forbidden-names.local.example.json scripts/forbidden-names.local.json
# fill in your org names, domains, community slugs, and usernames
```

See [`scripts/FORBIDDEN-NAMES.md`](./scripts/FORBIDDEN-NAMES.md) for the full
config reference and category guide.

## Changelog fragments (required for code changes)

Every PR that touches `packages/**` or `scripts/**` **must** include a
changelog fragment. Create a file `changelog.d/<slug>.md` (a short slug
describing the change) with Keep-a-Changelog subsections:

```markdown
### Added
- What you added and why.

### Changed
- What you changed.

### Fixed
- Bug you fixed.
```

Only include the subsections that apply. The fragment is assembled into
`CHANGELOG.md` under `## [Unreleased]` by:

```sh
pnpm changelog:assemble   # regenerate CHANGELOG.md [Unreleased] block
pnpm changelog:check      # exits 1 if code diff lacks a fragment
```

Docs-only, website-only, and examples-only diffs are exempt. See
[`changelog.d/README.md`](./changelog.d/README.md) for the full specification
and format template (fragments are deleted at release, so there is no checked-in
example file to copy).

## Pull request checklist

- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (builds first, then unit tests)
- [ ] New behavior has tests (unit or eval cases where appropriate)
- [ ] Docs updated if user-visible behavior changed
- [ ] No org-specific data, vault paths, or secrets in the diff
- [ ] `changelog.d/<slug>.md` fragment added (required for `packages/` or `scripts/` changes)
- [ ] If it answers a "where used / who references / depends on" question, it
      follows the reverse-lookup contract above (resolve-first, verb-routed,
      evidence-tiered, empty≠absent, caps readable)

## Code style

- TypeScript strict mode, ESM, `Result<T, E>` over thrown errors in library code
- Match surrounding naming and import order (eslint enforced)
- Comments only for non-obvious business logic
- Cite edge confidence (`declared` / `parsed` / `heuristic`) in tool responses

## Release process (maintainers)

External contributors do not need to publish; maintainers handle tagging and the
npm publish.

**Follow [RELEASING.md](RELEASING.md)**: the release cadence (a minor on the first
Tuesday of each month), the exact order of steps, and the known traps. Run
`pnpm release:check` before tagging; it runs every CI step locally. Releases are
published only by pushing a `vX.Y.Z` tag, never by `npm publish` from a laptop.

As a last line of defence, before any publish of `packages/cli` the **`prepublishOnly`** hook runs
`scripts/prepublish-check.mjs` (`pnpm scan:leaks` + `pnpm guard` +
`pnpm check:version-consistency`). Publish aborts if any check fails — fix
leaks, complete Phase 1 SCRUB work, or reconcile versions first.

**Version source of truth:** `packages/cli/package.json` is the published
product version. It must match `packages/cli/server.json` and the shipped MCP
handshake (`SFI_BUILD_VERSION` / `resolveServerVersion()`). `CHANGELOG.md` must
have a dated `## [X.Y.Z] — YYYY-MM-DD` entry for that version, or pass
`--metadata-only` on the consistency script for an explicit packaging-only
exemption. Internal `@sf-intelligence/*` workspace `package.json` versions are
not independently published and are not required to match.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
Report unacceptable behavior to the maintainers via the contact in that file.
