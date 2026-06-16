# Contributing to sf-intelligence

Thank you for helping improve SfIntelligence. This project is MIT + Commons Clause;
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
- `.claude/skills/` → agent skills (edit in place or stage in `skill-updates/`)

Each package has co-located unit tests under `packages/*/test/`. Cross-package
integration tests live in `tests/integration/` (requires maintainer fixtures;
not run in CI by default).

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Compile all packages |
| `pnpm test` | Unit tests + integration suite |
| `pnpm lint` | ESLint |
| `pnpm eval` | Retrieval golden eval |
| `pnpm eval:analytical` | Analytical tool eval |
| `pnpm v4-gate` | Full release gate (lint, test, eval, scale, guard) |
| `pnpm guard` | Privacy scan of shipping set |
| `pnpm e2e` | MCP transport smoke (graph-level vault) |
| `pnpm onboard:smoke` | New-user onboarding chain on a synthetic fixture (init → refresh → doctor → samples) |

Run `pnpm v4-gate` before opening a PR that touches MCP tools, extractors, or
release artifacts.

## Adding or changing MCP tools

1. Add a handler in `packages/mcp/src/tools/<tool-name>.ts`.
2. Register in `packages/mcp/src/tools/index.ts` (`V01_TOOLS` + dispatch).
3. Add co-located tests in `packages/mcp/test/tools/<tool-name>.test.ts`.
4. Update skills if user-facing behavior changes (especially
   `.claude/skills/using-sf-intelligence/SKILL.md` and
   `.claude/skills/answering-org-questions/SKILL.md`).
5. If the tool affects trust boundaries, update `docs/architecture.md` and
   `docs/guides/asking-questions.md`.
6. **Rebuild the CLI bundle after any `packages/mcp/` change — especially
   `intent-router.ts`.** The `sfi` command bundles the MCP server into a single
   `dist/index.js` via esbuild, so an MCP/router edit is NOT live in `sfi mcp`
   (or the QA harness, which drives `sfi mcp`) until you run:

   ```sh
   pnpm --filter sf-intelligence build   # rebuilds packages/cli/dist/index.js
   ```

   `pnpm -r build` (and CI's build step) covers this, but the targeted command is
   the fast path while iterating. Forgetting it makes stale-dist mask your change.
7. **For a NEW tool, also:** bump `website/site-data.json` `toolCount` (the
   `verify-doc-sync` gate fails on a mismatch), add the tool to the
   order-sensitive roster in `packages/mcp/test/server.test.ts` (two lists), and
   **add it to `sf-intelligence-qa/scripts/tool-smoke.mjs` `MINIMAL` with a
   verified vault id** so the gate exercises it against a REAL org — unit tests
   run on synthetic graphs; without a `tool-smoke` entry a new tool is never run
   against real-org data. Verify the id returns `ok` (don't guess).

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
7. **Router + harness locked** — a gold-set case per family + a collision vs the
   nearest describe/impact intent; the A4 honesty battery checks the empty-result
   wording.

The full contract + a per-component-family describe-vs-usage matrix lives in the
capability audit (`.sfi/local/CAPABILITY-AUDIT.md` → "Usage & discovery").

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

Agent skills live in `.claude/skills/*/SKILL.md`. The build harness sometimes
stages skill rewrites in `skill-updates/` for manual review before copy.

## Pull request checklist

- [ ] `pnpm lint` passes
- [ ] `pnpm -r test` passes
- [ ] New behavior has tests (unit or eval cases where appropriate)
- [ ] Docs updated if user-visible behavior changed
- [ ] No org-specific data, vault paths, or secrets in the diff
- [ ] CHANGELOG entry under `[Unreleased]` or the next version section
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

Before `npm publish` from `packages/cli`, the **`prepublishOnly`** hook runs
`scripts/prepublish-check.mjs` (`pnpm scan:leaks` + `pnpm guard`). Publish
aborts if either check fails — fix leaks or complete Phase 1 SCRUB work first.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
Report unacceptable behavior to the maintainers via the contact in that file.
