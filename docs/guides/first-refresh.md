# Your first refresh

This guide walks you through the first end-to-end refresh of an
SfIntelligence vault, from running `/sfi-init` to committing the result
and asking your first question. By the end you'll have an `org-kb/` tree
checked in, a manifest that records the source-tree hash, and Claude able
to answer schema questions about your org from the local vault.

It assumes you've already installed the plugin — `/help` shows the setup
commands. If not, start with
[`docs/guides/installation.md`](./installation.md).

If you want the guided path, run `/sfi-onboard` instead. This page documents the
manual steps behind that guided flow.

## 1. Prerequisites

Before this guide you need:

- The SfIntelligence plugin loaded — `/help` lists the `/sfi-*`
  commands. See [`installation.md`](./installation.md) if not.
- A Salesforce DX project repo as your working directory (the one with
  `sfdx-project.json` and `force-app/`).
- An `sf` CLI authenticated against the org you want to index. Confirm:

  ```sh
  sf org list --json
  ```

  The target org's entry should show `"connectedStatus": "Connected"`.
  If not, re-authenticate with `sf org login web --alias <your-alias>`
  before proceeding.

That's it. Everything else this guide does happens inside Claude Code.

## 2. Initialize the vault: `/sfi-init`

Open a Claude Code session whose working directory is your DX repo. Run:

```
/sfi-init
```

The CLI prompts for two things:

1. **Vault root directory.** Press Enter for the default `org-kb`. This
   directory sits next to `force-app/` and holds the committed vault.
2. **Target org alias.** Press Enter to accept your default `sf` org,
   or type the alias (e.g. `my-org-prod`). The alias persists in the
   vault's config and is used by every later `/sfi-refresh`.

Skip the prompts by passing flags:

```
/sfi-init --target-org my-org-prod --vault-root org-kb
```

### What gets created

A successful `/sfi-init` leaves the following layout in your repo:

```
your-dx-repo/
├── force-app/                      # untouched
├── org-kb/
│   ├── source/                     # empty for now; refresh fills this
│   ├── components/                 # empty for now
│   ├── graph/                      # empty for now
│   └── meta/
│       ├── config.json             # { targetOrg, vaultRoot, version, createdAt }
│       └── version.txt             # "0.1.0\n"
└── .gitignore                      # gains two new entries
```

`/sfi-init` appends `org-kb/source/` and `org-kb/graph/` to
`.gitignore`. Both directories hold regenerable artifacts — the raw DX
retrieve output and the DuckDB graph file — so they don't belong in git.
The committed half is `org-kb/components/` and `org-kb/meta/`; that's
where the team-shared value of the vault lives.

A summary at the end confirms what was done:

```
Initialised vault at /home/you/my-org-repo/org-kb
Target org: my-org-prod
Updated .gitignore
Next: run sfi refresh
```

### Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `vault already exists: ...` | You've already initialised; the safety check refuses to overwrite. | Pass `--force` to overwrite the config, or accept the interactive prompt's "overwrite" option. The committed `components/` directory is left alone either way. |
| `sfi init: failed to create directory: ...` | Filesystem permission error. | Run from a directory you own; check the parent directory's permissions. |
| The `.gitignore` line says `(or could not be written)` | The file was locked or unwritable. | Add the two ignore entries manually before committing. |
| The "Target org alias" prompt offered no default | No default org set in `sf`. | Type the alias you authenticated against, or set a default with `sf config set target-org=my-alias`. |

If you initialised against the wrong alias, re-run with `--force`:

```
/sfi-init --force --target-org the-correct-alias
```

`--force` rewrites `meta/config.json` and `meta/version.txt`. It does
not delete committed components — those persist until the next refresh
overwrites them.

## 3. Run the first refresh: `/sfi-refresh`

Once `/sfi-init` is done, run:

```
/sfi-refresh
```

The refresh runs five stages in order:

1. **Pull** — `sf project retrieve` writes raw DX source into
   `org-kb/source/`. The only network step; the slow one on real orgs.
2. **Extract** — walk `org-kb/source/` and dispatch each file to the
   extractor for its metadata type.
3. **Import** — load nodes and edges into the DuckDB graph at
   `org-kb/graph/graph.duckdb`.
4. **Render** — write one Markdown file per component under
   `org-kb/components/<Type>/`, plus the vault index.
5. **Manifest** — hash the source tree, write `org-kb/meta/manifest.json`.

### What to expect

Stage 1 dominates on a real org — the package.xml requests every type
at `*`, so Salesforce streams back tens of megabytes of XML. Expect:

- **5–15 minutes** for a typical production org; longer for very large
  ones. A real production-scale org lands around **10–12 minutes**
  end-to-end under the defaults.
- **Under a minute** for a small scratch org or focused sandbox.
- Silence during retrieve. There is no progress bar; `sf` is quiet until
  it finishes.

Two of the defaults add real, bounded time on large orgs:

- The **usage-ranked reports pull** (part of stage 1): a read-only SOQL
  ranks Reports/Dashboards by actual usage and retrieves the top
  `SFI_REPORTS_CAP` (500) — roughly **a minute or two** on a
  report-heavy org. `--no-reports` skips it; `--with-reports` pulls
  everything, uncapped (slow).
- The **parser-grade Apex pass** (part of stage 2): seconds per few
  hundred classes (~15s on a 500-class org). `--no-apex-ast` opts out,
  at the cost of parsed-confidence Apex edges.

The remaining local stages (import, render, manifest) take under 30
seconds combined on a small org; 1–3 minutes on a 2,000+ component org.

### Impatient? `sfi refresh --staged`

On a large org, the staged build gives you a servable vault in minutes
instead of waiting for the full pull:

- **T0 (seconds)** — ~5 read-only COUNT queries write a skeleton org card
  (`partial: true`, approximate scale) and a manifest whose coverage rows
  are all `pending`.
- **T1 (minutes)** — retrieves the 10 priority families behind most
  questions (objects, fields, validation rules, Flows, Apex classes and
  triggers, layouts, record types, Profiles, PermissionSets). The vault
  answers questions about those types from here on.
- **T2** — a full monolithic refresh through a transactional side-build:
  the live graph is replaced only on success, so an interruption leaves
  the T1 vault servable. The end state is identical to a plain refresh.
- **T3** — only with `--with-reports`: the folder-based Report/Dashboard
  pass.

Mid-build honesty is automatic: `sfi.health_check` reports
`degraded (building tier i/n)`, `sfi.coverage_report` lists queued types
under `pending`, and absence answers ("no Flows reference X") stay
qualified until the type's tier has landed. The build is resumable — a
re-run of `--staged` skips completed tiers.

### Targeting a different alias

To override the alias in `meta/config.json` for one run only:

```
/sfi-refresh --target-org my-other-alias
```

The persisted alias does not change. To switch the alias permanently,
re-run `/sfi-init --force --target-org my-other-alias`.

### The summary

When the pipeline finishes, the CLI prints a summary like:

```
Refresh success in 412318 ms

Components
  ApexClass: 142
  ApexTrigger: 18
  CustomField: 612
  CustomObject: 47
  Flow: 23
  Layout: 39
  PermissionSet: 12
  Profile: 5
  ValidationRule: 88

Edges
  grantedBy: 1240
  parentOf: 700
  triggersOn: 18
  usedInLayout: 412
```

A `success` status means every stage finished cleanly. `partial` means
some files failed extraction (the summary lists each failure with its
`error.kind`); the vault is still coherent for files that succeeded.
`failed` means a fatal step aborted — the summary ends with a `Fatal:`
line.

Claude (under `.claude/skills/refreshing-the-org-vault/SKILL.md`)
re-reads `org-kb/meta/manifest.json` after the run and reports
`refreshedAt` plus per-type counts. Read that summary before assuming
the refresh succeeded.

## 4. Refresh outcomes and partial vaults

A refresh ends in one of three states, printed at the top of the summary:

- **`success`** — every stage finished cleanly across the whole corpus.
  This is the expected outcome on a healthy org of any size; the pipeline
  streams the graph import in bounded batches and renders array-valued
  properties (picklist values, Apex modifiers, trigger events, permission
  flags) without issue.
- **`partial`** — some individual files failed extraction. The vault is
  still coherent for every file that succeeded, and the summary lists each
  failure with its `error.kind` (e.g. a single malformed Flow XML file is
  reported as a per-file `parse-error` and skipped — it does not abort the
  run). Commit the partial vault; note the skipped components in the commit
  message.
- **`failed`** — a fatal step aborted before producing a usable vault. The
  summary ends with a `Fatal:` line naming the stage. The usual cause is an
  environment problem (the retrieve could not authenticate, or the source
  tree is empty), not the indexing pipeline.

If a refresh ends `failed`, run `/sfi-status` and read the `Fatal:` line and
the manifest's `errors` array before re-running. To re-extract from the
source tree you already pulled — without another network round-trip — re-run
with `--no-pull` (see §8).

## 5. What got created

Refresh populates the four `org-kb/` subdirectories that `/sfi-init`
left empty. Concretely:

```
org-kb/
├── source/main/default/{objects,classes,triggers,flows,...}/   # raw DX retrieve
├── components/
│   ├── CustomObject/Account.md
│   ├── CustomField/Account/Industry__c.md
│   ├── ValidationRule/, ApexClass/, ApexTrigger/, Layout/,
│   ├── PermissionSet/, Profile/, Flow/
│   └── index.md
├── graph/graph.duckdb                                           # DuckDB
└── meta/{config.json, version.txt, manifest.json}
```

Brief tour:

- **`source/`** — gitignored. Raw `sf project retrieve` output. Used
  by the extractors as input, and by `sfi.search_apex_source` /
  `sfi.search_flow_metadata` as the corpus for grep tools. Regenerate
  any time with the next refresh.
- **`components/`** — committed. This is the value the team shares.
  One Markdown file per component, organised by type. A `git diff`
  here after a refresh shows exactly what changed in the org since the
  last refresh; reviewers read it as a metadata changelog.
- **`graph/graph.duckdb`** — gitignored. The DuckDB graph backing
  `sfi.get_edges` and `sfi.get_subgraph`. Regenerable by re-running
  refresh against the same `source/` tree (try `--no-pull`).
- **`meta/`** — committed. `config.json` is the persisted target-org
  alias and vault root. `version.txt` is the version stamp. The
  `manifest.json` written by the refresh contains:
  - `version` — the SfIntelligence version that last refreshed.
  - `refreshedAt` — ISO-8601 timestamp.
  - `sourceOrg` — the alias that was used.
  - `components` — per-type counts.
  - `edges` — per-edge-type counts.
  - `sourceTreeHash` — content hash of `org-kb/source/`. Mismatches
    with the on-disk source indicate drift.

Run `/sfi-status` at any time to print the manifest's key fields in a
compact form.

## 6. First commit

Once refresh prints `success` (or `partial` with errors you've read),
commit two paths:

```sh
git add org-kb/components/ org-kb/meta/
git commit -m "Initial SfIntelligence vault for my-org-prod"
```

Don't add `org-kb/source/` or `org-kb/graph/` — both are in
`.gitignore`. The source tree is large raw XML; the graph is a binary
DuckDB file. Both are regenerable, so committing them slows clones and
produces noisy diffs. If you `git add` one by accident, undo with
`git reset HEAD org-kb/source/`; the `.gitignore` entries prevent it
on subsequent adds.

A `partial` vault is still commitable — what got rendered is real.
Note the missing types in the commit message so future readers
understand the scope.

## 7. Asking your first question

Once `components/` and `meta/` are committed, you can ask Claude
questions about the org. The MCP server reads the vault and the graph;
no Salesforce API call happens during a conversation. Open Claude Code
in the same DX repo and try one of:

- "What custom objects do we have?"
- "What fields exist on Account?"
- "Show me the validation rules on Contact."
- "What's our naming convention for custom fields?"

Claude will use `sfi.list_components`, `sfi.search_components`,
`sfi.get_component`, and `sfi.get_edges`, citing canonical component
IDs (`CustomObject:Account`, `ValidationRule:Contact.Phone_Required`)
as it goes.

A useful non-question right after refresh is `/sfi-status` — it prints
freshness, source-tree hash, and component counts in a few lines. Run
it whenever you re-open the repo or wonder whether the vault is
current.

The full question reference — what the vault can answer, how the
conversational front door handles vague or misspelled phrasing, and where
the boundaries are — is in
[`docs/guides/asking-questions.md`](./asking-questions.md), with worked
examples for every category.

## 8. Refreshing again

The vault is a snapshot. It only learns about new metadata when you
run `/sfi-refresh` again. Reasons to refresh:

- **You deployed metadata changes to the org** and want the vault to
  reflect them. Refresh.
- **You're about to ask Claude about something you just changed.** Run
  `/sfi-status` first; if `sourceTreeHash` is stale or
  `health_check` returns `stale`, refresh.
- **You just ran `sf project retrieve` separately** (e.g., as part of
  a different workflow) and want to re-build the vault from the new
  source without another network round-trip. Use `--no-pull`:

  ```
  /sfi-refresh --no-pull
  ```

  This skips stage 1 entirely and runs extract → import → render →
  manifest against whatever is already on disk under
  `org-kb/source/`. Faster, and useful when you've already paid the
  network cost.

- **You upgraded SfIntelligence to a new version.** Refresh to let
  the new extractors and renderers populate the vault with their
  richer output. The committed `components/` will see the new edges
  and types as a git diff. See
  [`docs/architecture.md`](../architecture.md) §8 for the upgrade
  semantics.

A common team rhythm: refresh before reviewing a PR that touches
Salesforce metadata, so the committed vault diff matches the PR's
intent. The CLI exits non-zero on failure, so a simple cron line covers
nightly refresh.

### Components deleted in the org

A normal **pulled** `/sfi-refresh` reconciles `org-kb/source/` against
the authoritative retrieve set for the metadata types pulled this run:
files the org no longer has are removed from source and dropped from the
graph (for types that extracted cleanly). Additions and modifications
behave as before.

Guards so a partial or flaky run never wipes unrelated data:

- A **scoped** refresh (`--types …`) reconciles only the scoped types;
  everything else is preserved.
- Types with extractor failures this run are **not** reconciled in the
  graph — a parse error must not delete a node.
- A **no-pull** refresh still mirrors whatever is on disk; remove stale
  files manually (or re-`/sfi-init`) when you edited source outside the
  CLI.

If you need to drop a deletion without pulling again: delete the stale
file(s) under `org-kb/source/` and run `/sfi-refresh --no-pull` (full,
not scoped).

If a refresh ends `failed`, read the `Fatal:` line and the manifest's
`errors` array (§4) before re-running.

## 9. Sharing a vault externally

Sometimes you need to hand the vault to someone outside the org — a
consultant, a support ticket, a demo. Don't just zip up `org-kb/`: it
contains the org alias, and (depending what you ask it to answer)
component descriptions can carry emails, URLs, or other free text. Use:

```sh
sfi vault anonymize --out ../shared-copy
```

This writes a REDACTED copy to `--out` (which must be outside the source
vault): the org alias is replaced everywhere it appears as literal text
with a stable placeholder, and free text is scrubbed for emails, URLs,
Salesforce record ids, and phone numbers. Component/field API names are
KEPT (the default `--mode redact`) — most consultants need them, and a
generated `README.md` in the output spells out that residual risk (an API
name can itself be identifying if your naming convention embeds a company
name). `graph/` (the binary dependency graph) and `snapshots/` are never
copied — rebuild the graph locally with `sfi refresh --no-pull` inside
`--out` if the recipient needs it.

`--mode pseudonymize` (custom API names ALSO replaced with a stable,
non-reversible mapping) is not yet implemented; the command explains why
and exits non-zero if you ask for it.

The command prints a residual-scan summary before exiting — read it before
sending the copy anywhere. Your source vault is never modified; every
write happens under `--out`.

## Where to go next

- [`docs/guides/asking-questions.md`](./asking-questions.md) — the
  question reference; read before trying complex questions.
- [`docs/architecture.md`](../architecture.md) — data flow, the MCP
  tool surface, edge semantics, component/edge coverage.
- [`docs/guides/installation.md`](./installation.md) — re-installing
  or moving the plugin between machines.

If something here doesn't match what you see, run `/sfi-status` and read
the manifest — `refreshedAt`, the `sourceTreeHash`, the per-type counts, and
the `errors` array (§4) usually surface the cause.
