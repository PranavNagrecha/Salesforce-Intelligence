# The `sfi` command line

Every command the `sfi` CLI offers, in the order you are likely to meet
them. Run any of them as `sfi <command>` after a global install
(`npm install -g sf-intelligence`) or as `npx -y sf-intelligence <command>`
with nothing installed. `sfi --help` and `sfi <command> --help` print the
same information from the running version.

Two things apply to most commands:

- **`--vault <path>`** names the vault to use: an `org-kb` folder or the
  folder that holds one. Without it the CLI reads `SFI_VAULT`, then
  `./org-kb`. Commands that take it are marked below.
- **Nothing writes to Salesforce.** Every command that contacts the org
  reads from it. The commands that write anything at all write to local
  files under `org-kb/`.

## Getting started

### `sfi quickstart`

The guided first-run path: install check, org auth, `init`, `refresh`, host
connection, and a few starter questions for your org. Start here if you have
never run the tool. Takes `--vault`.

### `sfi init`

Creates the `org-kb/` vault folder in the current Salesforce DX project,
records which org alias it belongs to, and adds the regenerable folders
(`org-kb/source/`, `org-kb/graph/`) to `.gitignore`. Run it once per repo.
When stdin is not a terminal (a script or an agent), pass `--target-org`.

| Option | What it does |
|---|---|
| `--target-org <alias>` | The Salesforce org alias to bind to this vault |
| `--vault <path>` | Vault root (default `./org-kb`); `--vault-root` is an alias |
| `--force` | Overwrite an existing vault config |

### `sfi refresh`

Retrieves the org's metadata with the Salesforce CLI, extracts components
and relationships, builds the graph, renders the Markdown vault and writes
the manifest. The first run on a real org takes minutes; later runs rebuild
in full by default so the result always matches a cold build. A `partial`
status lists each file that failed; a `failed` status ends with a `Fatal:`
line. The common options:

| Option | What it does |
|---|---|
| `--target-org <alias>` | Org to retrieve from (overrides `meta/config.json`) |
| `--no-pull` | Rebuild from the source already on disk; no retrieve, no org contact |
| `--with-describe` | With `--no-pull`, still fetch standard-object field describes |
| `--types <list>` | Restrict the refresh to these metadata types (comma-separated) |
| `--incremental` | Reuse the previous run's per-file parse cache; same result, faster |
| `--incremental-graph` | Re-import only changed nodes and edges into the graph; same result, faster. Combine with `--incremental` |
| `--staged` | Build in tiers so the first answers arrive sooner; resumable; ends in the same state as a plain refresh |
| `--with-tooling-api` | After the refresh, enrich components with last-modified dates and authors, confirm declared dependencies, and capture the permission-dependency graph. Needs the `sf` CLI authenticated |
| `--with-audit-trail` | Append new Setup Audit Trail rows to `meta/setup-audit-trail.jsonl` so who-changed-this can be answered offline |
| `--with-data-shape` | Capture approximate record counts and field fill rates. Needs live consent for the org; skips otherwise |
| `--with-reports` / `--no-reports` | Pull every report and dashboard, or none. The default is the 500 most-used, which leaves Report and Dashboard coverage marked `pending` |
| `--no-apex-ast` | Skip the parser-grade Apex pass (on by default) |
| `--components <list>` | Pull named automation-critical components on demand |
| `--drain-demand-queue` | Pull every automation-critical component the tools have recorded as missing |
| `--vault <path>` | The vault to refresh |

Timeouts for the `sf` calls, and the local auth check that runs first, are
in [configuration.md](./configuration.md) § Salesforce CLI timeouts.

### `sfi status`

Reports the vault's freshness: refresh time, source-tree hash, per-type
component and edge counts. Takes `--vault`.

| Option | What it does |
|---|---|
| `--json` | Raw status as JSON |
| `--skipped` | The per-directory skip inventory from the last refresh (for the "unknown directories" warning) |
| `--strict` | Exit 1 when there is no vault, for cron and CI wrappers |

### `sfi doctor`

Diagnoses the setup: the `sf` CLI, the vault, org auth, freshness and the
graph file, with a fix for each problem it finds. It also probes the usual
PATH locations when a host's subprocess cannot see `sf`. Takes `--vault`.
Run it first when something is off, and include its output in a bug report.

### `sfi demo`

Serves a built-in synthetic demo org ("Verdant Energy", a fictional solar
installer) over MCP, with no Salesforce org and no vault of your own. The
first start unpacks it to `~/.sf-intelligence/demo`. `--rebuild` forces a
rebuild of the cached demo vault. Questions to try are in
[`examples/demo-questions.md`](../examples/demo-questions.md).

## Serving the MCP server

### `sfi mcp`

Runs the MCP server over stdio against the vault. This is the command every
host registers (`npx -y sf-intelligence mcp --vault /abs/path/to/org-kb`).
Takes `--vault`; the precedence is `--vault`, then `SFI_VAULT`, then
`./org-kb`. With no vault it starts in setup mode and offers one tool,
`sfi.setup_status`. Host-by-host registration is in
[guides/mcp-hosts.md](./guides/mcp-hosts.md).

### `sfi serve --http`

Serves the same read-only server over streamable HTTP for a shared or
remote host. A bearer token is required; the live plane is disabled over
HTTP; it binds to `127.0.0.1` unless you say otherwise.

| Option | What it does |
|---|---|
| `--http` | Required (stdio stays `sfi mcp`) |
| `--port <n>` | Port (default 8787) |
| `--host <addr>` | Bind address (default `127.0.0.1`; a non-loopback address warns and requires a token option) |
| `--token <token>` | The bearer token clients must present |
| `--generate-token` | Generate a token, print it once, use it |
| `--tokens-file <path>` | JSON token-to-identity map for per-caller attribution |

## Keeping the vault current

### `sfi stale-sweep`

One read-only drift check: counts the components modified in the org since
the vault's refresh and writes `meta/staleness.json`, which the trust surfaces
read. A drifted org is an answer, not an error. `--target-org <alias>`
overrides the vault config.

### `sfi watch`

A small detached process that runs `stale-sweep` on an interval so
`meta/staleness.json` stays current. One instance per vault.

| Option | What it does |
|---|---|
| `--interval <duration>` | Tick interval, for example `15m` or `1h` (default 15m, floor 5m) |
| `--auto-refresh incremental` | When a tick sees drift, run an incremental refresh automatically (contacts the org, at most once an hour) |
| `--drain-demand-queue` | After a tick, pull queued automation-critical components (at most once an hour) |
| `--foreground` | Run the loop in this process |

Subcommands: `sfi watch status` reports the daemon state and the last sweep;
`sfi watch stop` stops it.

### `sfi snapshot`

Captures, lists and deletes snapshots of the vault state, which `sfi.trend`
and `sfi.diff_snapshots` compare. A refresh captures one by default. All
three take `--vault`.

| Subcommand | What it does |
|---|---|
| `create [--label <label>]` | Capture a snapshot (label defaults to the timestamp) |
| `list` | List every captured snapshot |
| `delete <label>` | Delete one |

## Running tools from a script

### `sfi run <tool>`

Calls any `sfi` tool from a shell, with the same validation and the same
response as the MCP tool. Values are typed from the tool's schema; a nested
input goes in `--input <json>`. Exits 1 when the tool returns an error. `sfi
run` alone lists the tools. Every tool is available here, core or not.

```sh
sfi run find_component_usages --json --componentId CustomField:Project__c.Status__c
sfi run omni_save_trace --json --omniscript Demo_Intake_English_1 --vault ./my-project
```

| Option | What it does |
|---|---|
| `--json` | One line of JSON (default: indented) |
| `--input <json>` | A JSON object of arguments, merged before the `--<arg>` flags |
| `--vault <path>` | The vault to query |

### `sfi review-change`

A pre-deploy change review over a `package.xml` or a git diff, for a CI
gate: it exits 1 when any change is blocking. The analysis is against the
vault's last refresh, which may differ from production; the output says so.

| Option | What it does |
|---|---|
| `--manifest <package.xml>` | Review the components a manifest names |
| `--diff <base>` | Review the components changed since `<base>` (`git diff --name-status`) |
| `--project <dir>` | The DX project tree for `--diff` (default: current directory) |
| `--against <alias\|path>` | Review against a different vault (a registered alias or an `org-kb` path), for example production |
| `--limit <n>` | Cap the detailed rows; summary tallies stay full |
| `--json` | Raw output as JSON |
| `--format sarif\|markdown-comment` | SARIF 2.1.0 for code scanning, or a compact PR comment |
| `--vault <path>` | The vault to review against |

The ready-made GitHub Action is in
[`.github/actions/review-change`](../.github/actions/review-change/README.md).

### `sfi selftest`

Runs real queries against the built vault and reports which question types
it can answer. Takes `--vault`. Useful right after a first refresh.

## Curating the vault

### `sfi annotate`

Adds meaning the org cannot carry (`owner`, `status`, `glossary`, `domain`,
`note`) to a component, stored in `meta/annotations.jsonl`. Annotations
survive refreshes and show up in `get_component`, `field_360`, the
`explain_*` tools and `sfi.annotations`.

```sh
sfi annotate CustomField:Project__c.Risk_Score__c --key owner --value "Ops team"
```

| Option | What it does |
|---|---|
| `--key <key>` | One of `owner`, `status`, `glossary`, `domain`, `note` |
| `--value <value>` | The value to set |
| `--author <name>` | Recorded on the entry (default `human`) |
| `--unset` | Remove that key for the component |

| Subcommand | What it does |
|---|---|
| `confirm <componentId> <key> [--author <name>]` | Confirm an AI-proposed annotation as human-confirmed |
| `list [componentId]` | Print the current overlay, optionally for one component |
| `orphans` | List annotations whose component no longer exists |

### `sfi vault`

Vault maintenance.

| Subcommand | What it does |
|---|---|
| `git enable` | Start a git repository inside `org-kb/` with a generated `.gitignore`; afterwards every refresh that changed the source auto-commits with a delta summary, which `sfi.component_history` and `sfi.component_as_of` read |
| `git status` | Whether vault git history is on, and the last commit |
| `anonymize --out <dir> [--mode redact]` | Export a redacted copy of the vault for sharing (support, a consultant, a demo). Org identity and free text (emails, URLs, record ids, phone numbers) are scrubbed; API names are kept, and the generated README says so. Never copies the graph or snapshots; `--out` must be a new or empty folder outside the vault. Exits 2 when its residual scan finds anything. `--mode pseudonymize` is not implemented and says so |

## Several orgs

### `sfi register-vault <alias> <path>`

Registers a vault under the shared registry root so the cross-vault tools
(`sfi.compare_vaults`, `sfi.fleet_find`, `sfi.fleet_drift_ranking` and the
others) can address it by alias.

| Option | What it does |
|---|---|
| `--force` | Overwrite an existing alias |
| `--root <path>` | Registry root (default `$SF_INTELLIGENCE_REGISTRY_PATH`, then `~/sf-intelligence-vaults`) |

### `sfi list-vaults`

Lists every registered vault and its refresh state. `--json` for raw output;
`--root <path>` as above.

### `sfi compare-vaults <vaultA> <vaultB>`

A structural diff between two registered vaults: components added, removed
or changed in shape.

| Option | What it does |
|---|---|
| `--object <apiName>` | Only one object and what it parents |
| `--type <componentType>` | Only one component type, for example `Profile` |
| `--include-volatile-properties` | Also show last-modified drift, which is hidden by default |
| `--json` | Raw output as JSON |
| `--root <path>` | Registry root |

## Feedback, kept local

### `sfi feedback`

| Subcommand | What it does |
|---|---|
| `mark <question> [--wrong\|--weak]` | Record that an answer to a question was wrong or weak, locally |
| `export [--out <file>] [--all] [--vault <path>]` | Write a scrubbed, shareable feedback file (route gaps and ratings; no org data, nothing uploaded). Scoped to the current vault unless `--all` |

### `sfi gaps report`

Summarises the local log of questions the router could not place well, by
category, with no question text. Entries are written only when
`sfi.route_question` is called with `logGap: true`.

| Option | What it does |
|---|---|
| `--since <window>` | Only gaps on or after a window (`7d`, `24h`) or an ISO date |
| `--top <n>` | The top N categories |
| `--json` | Category counts as JSON |
| `--vault <path>` | Only the gaps asked against that vault; default is every vault on the machine |

## Related

- [guides/installation.md](./guides/installation.md): the first-run path in
  full.
- [guides/troubleshooting.md](./guides/troubleshooting.md): what each error
  means.
- [configuration.md](./configuration.md): every environment variable.
