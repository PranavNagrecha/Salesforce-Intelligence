---
name: refreshing-the-org-vault
description: |
  Refreshes the SfIntelligence vault from a live Salesforce org. Use
  when the user invokes `/sfi-refresh`, or says "refresh", "refresh
  the vault", "pull latest", "pull the latest from my org", "rebuild
  the vault", "rebuild the index", "my data is stale", "the vault is
  stale", "I just deployed changes", or any phrase signaling the
  vault is out of date relative to the org. Drives `sfi refresh`,
  which shells out to `sf project retrieve`, runs the full extractor
  graph, imports into DuckDB, renders Markdown, and writes a new
  manifest (including optional **coverage** metadata).
---

# Refreshing the org vault

## Overview

`sfi refresh` is the only way the vault learns about new metadata.
The pipeline runs **five stages in order**, and all five have to
finish for the vault to be usable:

1. **Pull** — `sf project retrieve start --manifest <pkg.xml>
   --target-org <alias> --output-dir org-kb/source/`. Network step.
   The slow one for real orgs.
2. **Extract** — walk `org-kb/source/`, dispatch each file to the
   matching extractor (72 component types including Reports,
   FlexiPages, Permission Set Groups, OmniStudio, CPQ, etc.).
   Per-file failures are captured, not fatal.
3. **Import** — load extracted nodes and edges into the DuckDB graph
   at `org-kb/graph/graph.duckdb`.
4. **Render** — write Markdown component files under
   `org-kb/components/<Type>/...`, plus Apex/Flow source pages and
   the vault index.
5. **Manifest** — recompute the source-tree hash, stamp
   `refreshedAt`, write `org-kb/meta/manifest.json` (including
   **`coverage`** per metadata type when the retrieve result is available).

Optional after a successful refresh: **`sfi snapshot create --label <name>`**
so `sfi.trend` / `sfi.churn` can compare structural history later.

A real org takes **5–15 minutes** end-to-end, dominated by stage 1.
Tell the user this before you start — silence during a long retrieve
reads like a hang.

## When to fire

**Explicit:**
- The user typed `/sfi-refresh`.

**Conversational triggers:**
- "Refresh the vault" / "refresh the index" / "rebuild the vault".
- "Pull the latest from my org" / "pull latest".
- "My data is stale" / "the vault is stale" / "this is out of date".
- "I just deployed changes" / "I just pushed metadata" / "things
  changed in the org".
- `sfi.health_check` returns `status: 'degraded'` or `freshness.stale: true`.
  Tell the user to run `/sfi-refresh`. `status: 'unhealthy'` or
  `checks.vaultExists: false` → route to `/sfi-init`.

**When NOT to fire:**
- The user is asking a question and the vault is already fresh.
  Answer the question first; only refresh if `health_check` flags
  staleness.
- The user wants live record data ("how many Accounts closed
  today?"). Refresh pulls **metadata**, not records. Record counts need
  the opt-in live plane (`sfi.live_*`) or `sf data query`.
- There is no `org-kb/` directory yet. The user hasn't initialized
  the vault — point them to `/sfi-init`, not refresh.

## Pre-flight checks

Run these **before** invoking `sfi refresh`. Each check that fails
stops the flow; do not proceed.

### 1. `sf` CLI authentication

Run:

```bash
sf org list --json
```

Parse the JSON for the alias the user is refreshing (or the
default). If the alias is not present, or its `connectedStatus` is
not `Connected`, stop and tell the user:

> "The `sf` CLI isn't authenticated to `<alias>`. Run
> `sf org login web --alias <alias>` (or `sf org login web
> --set-default --alias <alias>` if this should be the default),
> then ask me to refresh again."

If `sf` itself isn't installed (`command not found`), point the
user to the Salesforce CLI install docs and stop.

### 2. Vault config exists

Confirm `org-kb/meta/config.json` exists and parses. The CLI does
this too, but checking first lets you surface a clearer message:

> "No vault config at `org-kb/meta/config.json`. Run `/sfi-init`
> first."

### 3. Target alias matches (when the user specified one)

If the user said "refresh from `<alias>`" and the config's
`targetOrg` is a different alias, ask before overriding:

> "Config has `targetOrg: <config-alias>`. You asked me to refresh
> from `<user-alias>`. I'll pass `--target-org <user-alias>` for
> this run; want me to update the config too?"

Don't silently override. The config is the persisted intent.

## Steps

1. **Run the pre-flight checks above.** If any fails, stop and
   surface the actionable message.
2. **Set expectations.** Before running the command, say something
   like:
   > "Running `sfi refresh` against `<alias>`. This pulls metadata
   > from Salesforce, runs nine extractors, rebuilds the graph, and
   > re-renders the vault. Expect 5–15 minutes for a real org;
   > faster for a small fixture org."
   If the user passed `--no-pull` (or said "the source tree is
   already populated, just re-extract"), say so:
   > "Skipping `sf project retrieve` (you passed `--no-pull`).
   > Re-extracting from the existing `org-kb/source/` tree."
3. **Run the command.** Forward whatever flags the user provided:
   - `--target-org <alias>` if specified.
   - `--no-pull` if the user said the source tree is already there.
   - `--types <list>` (comma-separated) if the user wants a subset
     refreshed.

   Example invocations:
   ```bash
   sfi refresh
   sfi refresh --target-org admin@example.com
   sfi refresh --no-pull
   sfi refresh --types CustomObject,CustomField,ValidationRule
   ```
4. **Read the new manifest.** After the command exits, read
   `org-kb/meta/manifest.json`. Report:
   - `refreshedAt`
   - `sourceOrg`
   - `components` totals by type
   - `edges` totals by type
   - `sourceTreeHash` (last 12 chars are fine; full hash is noisy)

   If a previous manifest existed, compare counts and surface the
   delta ("CustomField: 312 → 318, +6"). Do this honestly — if a
   count dropped, say so; it usually means a metadata type was
   removed from the org (or a `--types` filter excluded it).
5. **Handle non-success outcomes.** The CLI exits non-zero on
   `partial` and `failed`. See **Failure modes** below.

## Failure modes

| Symptom | Likely cause | What to surface |
|---|---|---|
| `sfi refresh` exits with `Fatal: sf project retrieve failed: ...` and stderr mentions `No authorization information found` | `sf` not authenticated to the target alias | "The `sf` CLI lost its session for `<alias>`. Run `sf org login web --alias <alias>` and try again." |
| `Fatal: sf project retrieve failed: ...` with timeout / `ETIMEDOUT` / `ECONNRESET` | Network blip, slow org, or VPN dropped | "Retrieve timed out. Retry with `/sfi-refresh` once. If it fails twice, check VPN/network and try `sf org list` to confirm the alias still responds." |
| `Refresh partial in N ms` and the summary lists per-file errors | One or more metadata files were malformed or the extractor returned an error | Report exactly which files failed and the `error.kind` from each line. The vault is still coherent for the files that succeeded — say that explicitly. Do not claim success. |
| `Fatal: Vault config not found at .../org-kb/meta/config.json` | `/sfi-init` hasn't been run | "No vault config. Run `/sfi-init` first." |
| `Fatal: openGraph: Could not find ... duckdb-neo` (or `Error: Cannot find module '@duckdb/node-api/...'`) on first install | pnpm blocked DuckDB's native postinstall script | "DuckDB's native binding didn't install. Run `pnpm approve-builds` and accept `@duckdb/node-api`, then try again." |
| `Fatal: renderVault: ...` | Renderer crashed mid-stage; extracted nodes exist but Markdown isn't written | Surface the message verbatim. The graph may have stale data from a previous run. Tell the user the vault is in an inconsistent state and the next refresh will overwrite it. |
| `Fatal: saveManifest: ...` | Filesystem error writing the manifest | The components and edges were rendered, but `manifest.json` is missing or stale. Tell the user to retry — the next refresh will write a fresh manifest. |

When you don't recognize the error, paste the `Fatal:` line back to
the user and ask whether they want to retry or investigate. Do not
guess a recovery path.

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "It probably succeeded; I'll say `done` without reading the new manifest." | The user trusts your summary. Always read the manifest and report the actual counts and `refreshedAt`. |
| "The retrieve takes a while; I'll explain after it finishes." | Tell them **before**: "This may take 5–15 minutes." Silence reads like a hang and they'll cancel halfway. |
| "Partial means basically success." | No. Partial means some files failed. List which ones and the error kind for each. Inflating partial to success is how stale or incomplete vaults end up trusted. |
| "I'll skip the `sf org list` check; if auth is bad, the retrieve will tell us." | The CLI's error message is buried in `sf` output. Catching it pre-flight gives the user a one-line fix instead of a stack trace. |
| "The user said 'refresh' but the vault was refreshed 10 minutes ago; I'll skip it." | Don't decide for them. Run `sfi.health_check` first; if it says `ok`, surface that — "vault was refreshed at HH:MM, sourceTreeHash matches; nothing to refresh. Refresh anyway?" — and let them choose. |
| "I'll just describe what the org probably looks like now." | The refresh's output **is** the org state. Do not speculate about what's in the org before the refresh succeeds. |
| "If `--no-pull` is faster, I'll always pass it." | `--no-pull` only re-extracts the existing source tree. It does not pick up any changes from Salesforce. Only use it when the user explicitly says the source is already populated. |
| "The retrieve failed twice; I'll edit `config.json` to a different alias to see if that works." | Don't. Ask the user. Config edits are persisted intent. |

## Red flags

Stop and ask the user when:

- Two retries of `sfi refresh` both fail with the same `Fatal:`
  line. The third attempt won't help; surface the message and ask
  what the user wants to do.
- The new manifest's component counts are **drastically lower** than
  the previous manifest (e.g., `CustomField: 312 → 8`) and the user
  did not pass `--types`. Something pulled an empty package; ask
  before treating this as the new ground truth.
- `sf org list` shows the target alias as `Connected` but
  `connectedStatus` is followed by a refresh-token expiry warning.
  Surface the warning; the next retrieve may succeed once before
  failing.
- The user wants you to "refresh just one object" or "just the
  fields on Account." The `--types` filter scopes by **metadata
  type**, not by individual component. Tell them: refresh is
  all-or-nothing within a type.
- The user asks you to commit the regenerated vault. That's their
  call — don't `git add` / `git commit` on their behalf. Mention
  that `org-kb/components/`, `org-kb/meta/manifest.json`, and
  `org-kb/graph/graph.duckdb` are the typical commit targets if they
  want a diff-able snapshot.

## Verification

Before telling the user the refresh is done, confirm:

- [ ] Did I run `sf org list --json` (or read prior output) and
      confirm the target alias is `Connected`?
- [ ] Did I tell the user — **before** running the command — that
      this could take 5–15 minutes?
- [ ] Did I read `org-kb/meta/manifest.json` after the run and
      report the actual `refreshedAt`, `sourceOrg`, and counts?
- [ ] If status is `partial`, did I list the per-file errors with
      their `error.kind`, instead of summarizing as "mostly worked"?
- [ ] If status is `failed`, did I surface the `Fatal:` line
      verbatim and name the recovery path?
- [ ] Did I avoid claiming any state about the org's current
      contents that I didn't read from the new manifest or vault?

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
