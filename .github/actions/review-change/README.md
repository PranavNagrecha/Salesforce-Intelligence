# `review-change` composite Action

Wraps `sfi review-change` for GitHub Actions: offline analysis against an
**already-materialized** org-kb vault, emitting SARIF 2.1.0 and/or a PR-comment
markdown summary. The Action never runs `sfi refresh` and never invokes the
`sf` CLI — it only reads `vault-path`.

Inputs/outputs: see [`action.yml`](./action.yml).

End-to-end PR-gate template (checkout, vault setup, Action call, SARIF upload,
PR comment, gate): [`docs/ci/review-change-pr-gate.example.yml`](../../../docs/ci/review-change-pr-gate.example.yml).

Live PR smoke against a real Salesforce repo is **USER/CI** — not required to
validate this Action in the product repo.

---

## Vault availability (pick ONE)

`sfi review-change` needs a vault that includes **`graph/graph.duckdb`**. A
source-only checkout is not enough. Two supported ways to get that onto the
runner:

### Mode A — Cached artifact (recommended default)

A **separate, trusted** job (scheduled or on merge to the default branch) that
*does* have org access runs `sfi refresh` and uploads the resulting `org-kb/`
directory as a build artifact (or release asset / object-storage blob). The
PR-gate job downloads that artifact and points `vault-path` at it.

- Freshness = how often the trusted producer runs.
- Stale vaults stay honest: the review report always names the vault's
  last-refresh timestamp.
- PR-gate credentials stay org-free (no `sf`, no org alias, no auth secret).

See the active `Download the org-kb vault artifact` step in the example
workflow.

### Mode B — Vault-git clone + cached `graph/`

If the vault has git history enabled (`sfi vault git enable`), refresh commits
`source/`, `components/`, `meta/manifest.json`, and `meta/history.jsonl` when
the source tree changes. Push that history to a **private** vault remote the
runner can read (deploy key or fine-grained read-only PAT), then `git clone`
it in the PR-gate job.

**Caveat:** the generated `.gitignore` excludes `graph/` (rebuildable binary).
A plain clone is source-only — **not** enough for `review-change`.

Do **not** rebuild the graph on the PR runner with `sfi refresh --no-pull`:
even with `--no-pull`, refresh may still attempt a best-effort `sf sobject
describe` (org-touching). Instead, the same trusted job that pushes vault-git
history should also cache `graph/` (e.g. `actions/cache`, keyed on the vault
repo commit SHA). The PR-gate job restores that cache beside the clone with
`fail-on-cache-miss: true` — no fallback rebuild.

See the commented Option B block in the example workflow.

---

## Hard guarantee

Either mode keeps the PR-gate Salesforce CLI footprint at zero: no `sf` binary,
no org alias, no auth secret. Org contact belongs only in the trusted vault
producer job.
