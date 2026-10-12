# Releasing sf-intelligence

This is the release process. Follow it every time, in this order. It is written for people **and**
AI agents: if you are an agent asked to release, ship, publish, tag or bump the version, this file
is your checklist. Do not work from memory.

## Cadence

| Kind | When | Version | Contents |
|---|---|---|---|
| **Minor** | First Tuesday of every month | `0.X.0` | Features and fixes merged since the last release, plus a release post on the website |
| **Patch** | Within a few days of a user-facing bug or a security issue | `0.X.Y` | Fixes only. Batch them; at most one patch a week unless something is broken for users |

- A scheduled workflow (`.github/workflows/release-reminder.yml`) opens a **"Release due"** issue on
  the first Tuesday of each month. Close it when the release is live, or comment why it was skipped.
- Do not ship many releases in one day. If a release needs a follow-up the same day, that is a
  sign the checks below were skipped.
- A month with nothing user-facing to ship: skip it, say so on the issue, and close it.

## Versioning

- `packages/cli/package.json` is the single source of truth for the published version.
- Minor bump for new tools, new arguments or output sections, or any change a host or script could
  notice (for example 0.4.0 dropped `structuredContent`). Patch bump for fixes only.
- The MCP Registry name in `packages/cli/server.json` must equal `mcpName` in
  `packages/cli/package.json`. `scripts/check-version-consistency.mjs` enforces this before publish.

## Release steps

### 1. Prepare (on a branch, never on `main`)

- Make sure `scripts/forbidden-names.local.json` exists (it is gitignored). Without it every
  privacy scan passes vacuously, and `pnpm release:check` refuses to run.
- Bump the version everywhere `node scripts/check-version-consistency.mjs` checks:
  - `packages/cli/package.json`;
  - `packages/cli/server.json` (`version` and `packages[0].version`);
  - `.claude-plugin/plugin.json` and `marketplace.json`;
  - the version pins in `.claude/commands/*.md`;
  - the supported-versions table in `SECURITY.md`.
- Fold the `changelog.d/*.md` fragments into `CHANGELOG.md`. Back up `CHANGELOG.md` and
  `changelog.d/` first, because `pnpm changelog:assemble` replaces the `[Unreleased]` block wholesale.
  Then rename that block to `## [X.Y.Z] — YYYY-MM-DD`, delete the shipped fragments (see
  `changelog.d/README.md`), and compare the result with the backup before committing.
- Regenerate the derived files:
  - `pnpm product-manifest` and `node scripts/product-surface.mjs --write`;
  - `node website/recalibrate.mjs`, which refreshes the website's counts, `tools.json` and page dates;
  - `pnpm regen:embedding-index`, if tool descriptions changed (`pnpm check:embedding-index` tells you).
- Write the release post under `website/src/content/guides/blog/`. `llms.txt` and the blog index
  are generated from the content collection.

### 2. Run every CI check locally

```bash
pnpm install --frozen-lockfile
pnpm release:check
```

This runs each step of CI's `unit-test` and `build-test` jobs, read straight from
`.github/workflows/ci.yml`, with CI's environment. That covers the org-leak scans (tree and full git
history), the release privacy guard, lint, typecheck, unit tests, the routing gate, the e2e smoke,
the retrieval and analytical evals, and the scale gates.

Do not tag until it prints `PASS`. The unit suite on its own is not enough. The 0.4.0 release
failed CI twice, on the leak scan and on the analytical eval, both of which the unit suite skips.

For the website, also run `npm run build`, `npm run verify-markup` and
`node scripts/verify-seo-indexing.mjs` in `website/`. Then, with `npx astro preview --port 4455`
running, run `npm run crawl-test`.

### 3. Squash onto `main` (privacy)

`main` is public. Ship the release as **one squashed commit** on top of `origin/main`, so no
intermediate commit (WIP messages, scratch notes, anything that once named a customer) becomes
public history:

```bash
git fetch origin
TREE=$(git rev-parse <release-branch>^{tree})
C=$(git commit-tree "$TREE" -p origin/main -F release-message.txt)
git branch -f release/X.Y.Z "$C"
```

Before using it, check the commit message against the blocklist as well.

### 4. Get CI green on the exact commit

```bash
git push origin release/X.Y.Z      # CI runs on release/** branches
gh run watch <run-id>              # every job must be green
```

`publish.yml` refuses to publish a commit without a green CI run, and CI does not run on tags. If CI
fails: fix the cause on your branch, re-squash, force-push `release/X.Y.Z`, and wait again. Never
use the `bypass_ci_check` dispatch input for a normal release.

### 5. Publish

```bash
git tag -a vX.Y.Z <commit> -m "vX.Y.Z"
git push origin vX.Y.Z
```

`publish.yml` publishes to npm (keyless OIDC, with provenance), then to the official MCP Registry,
then creates the GitHub release with the SBOM. Watch it to completion, then confirm:

```bash
npm view sf-intelligence version        # must print X.Y.Z
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=salesforce-intelligence"
gh release view vX.Y.Z
```

### 6. Deploy the website (only after npm serves the new version)

The website deploys from `main` and tells people to run `npx sf-intelligence@latest`. Fast-forward
`main` only once npm actually serves the release:

```bash
git push origin <commit>:refs/heads/main     # a fast-forward; never force-push main
git push origin --delete release/X.Y.Z
```

Check that the new pages return 200 on https://sfi.auditforce.cloud and that CI on `main` is green.

### 7. After release

- Post the release (the post, LinkedIn, relevant communities). Releases are the main moments that
  bring people to the project.
- Re-check directory listings that show versions (Glama, PulseMCP, MCP Market).
- Close the "Release due" issue with links to the npm version, the GitHub release and the post.

## Known traps

| Symptom | Cause | Fix |
|---|---|---|
| Leak scan fails in CI with "not valid JSON" | The `ORG_LEAK_BLOCKLIST` Actions secret is corrupted | `gh secret set ORG_LEAK_BLOCKLIST < scripts/forbidden-names.local.json` |
| Local scans pass but prove nothing | `scripts/forbidden-names.local.json` is missing in this checkout or worktree | Copy it in. `release:check` fails closed without it |
| Router or commit-gate checks crash with "no vault" in a worktree | `org-kb/` is gitignored | Symlink a gate vault's `org-kb` into the worktree |
| Release guard rejects a docs page | A home-directory path in an example (`/Users/...`) | Use `/absolute/path/to/...` placeholders |
| npm published but the registry is behind | `mcpName` ≠ `server.json` name | Guarded by `check-version-consistency`. If it still happens, fix it and release a patch |
| Someone runs `pnpm release` | A legacy script that publishes from a laptop, skipping the CI gate, provenance, the registry and the GitHub release | Don't. Releases go out only by pushing the tag (step 5) |
| `git push --ff-only` "succeeds" but pushes nothing | It isn't a push flag | Push the commit to `refs/heads/main` explicitly |
