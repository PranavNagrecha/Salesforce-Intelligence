# Release 0.1.7 — Clean-room packaging verification (P10-G1)

_Generated 2026-06-07. Anonymized; no org identifiers._

Verifies that the publishable `sf-intelligence` package installs and runs from
a freshly-built tarball in an empty project, ships only the intended files, and
that the shipped artifact is privacy-clean.

## Method

1. `pnpm -r build` (via the commit-gate) rebuilds `packages/cli/dist/index.js`
   (esbuild bundle of the workspace packages).
2. `pnpm pack` in `packages/cli/` → `sf-intelligence-0.1.7.tgz` (handles the
   `workspace:*` protocol — devDependencies are stripped/rewritten in the
   packed `package.json`).
3. Empty temp project: `npm init -y` then `npm i <tarball>` (resolves the real
   runtime dependencies from the registry, including the DuckDB native addon).
4. Bin smoke via `node_modules/.bin/sfi`: `--version`, `--help`, `doctor`.
5. Leak scan of the **shipped tarball** contents + the `--git-history` scan.

## Results

| Check | Result |
| --- | --- |
| `pnpm pack` | ✅ `sf-intelligence-0.1.7.tgz` (~448 KB) |
| Tarball contents | ✅ exactly `dist/index.js`, `bin/sfi.js`, `package.json`, `README.md`, `LICENSE` — the `files` whitelist held (no vault, source, tests, or maintainer files) |
| `workspace:*` in packed manifest | ✅ none (devDependencies rewritten/stripped) |
| Clean-room `npm i <tarball>` | ✅ installs; runtime deps = `@duckdb/node-api`, `@inquirer/prompts`, `@modelcontextprotocol/sdk`, `commander`, `fast-xml-parser`, `zod` |
| `sfi --version` | ✅ `0.1.7` |
| `sfi --help` | ✅ lists init / refresh / status / doctor / mcp / snapshot / register-vault / list-vaults / compare-vaults |
| `sfi doctor` (empty project) | ✅ runs, no crash; correctly reports CLI present + vault/org absent with fix guidance (non-zero exit is correct for blocking diagnostics) |
| Tarball leak scan (`scan-org-leaks --strict --paths <extracted>`) | ✅ 0 hits |
| Tarball absolute-path grep (`/Users/<name>`) | ✅ 0 hits |
| Working-tree shipping set (`release-guard`) | ✅ 0 leaks across 639 public files |

The npm-shippable artifact is **clean and installable**. The npx-from-registry
form (`npx -y sf-intelligence`) currently resolves the previously-published
version, not 0.1.7; the 0.1.7 npx path is verifiable only after publish
(P1-Q13), which the tarball test stands in for here.

## Open item — git history is not privacy-clean (does NOT affect the npm package)

The `--git-history` scan (`git log -S`) reports referring-org identifiers in
**historical commit diffs** — predominantly the privacy-scrub commits
themselves (the identifier appears in the diff that *removed* it). This is a
known, separately-tracked item:

- It does **not** ship to npm. The published package is the tarball above
  (`dist` + `bin` + `README` + `LICENSE` + `package.json`), which is clean.
- It is the blocker for making the **GitHub repository public**, not for the
  npm publish. Remediation is a `git filter-repo` history rewrite + force-push,
  deferred (it requires no live worktrees on the branch).

See `.sfi/local/FINDINGS.md` (GIT-HISTORY-ORG-IDENTIFIERS).

## Verdict

**PASS** for npm packaging — the tarball packs, installs, runs, and ships
clean. Git-history scrub remains a tracked prerequisite for GitHub
publicization, independent of the npm release.
