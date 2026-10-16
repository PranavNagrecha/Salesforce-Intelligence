# Troubleshooting

What each error the server or the CLI returns means, and what to do about
it. The tools fail closed on purpose: an error here is the product telling
you something true rather than guessing. For a server that does not connect
at all, start with [mcp-hosts.md](./mcp-hosts.md) § When it does not
connect; for install problems, [installation.md](./installation.md) § 5.

## "not directly invokable under SFI_TOOL_PROFILE=core"

```
Tool 'sfi.get_edges' is not directly invokable under SFI_TOOL_PROFILE=core.
Call sfi.run_analysis { name: 'sfi.get_edges', args } after sfi.describe_analysis, …
```

**What it means.** The server advertises a small core set of tools by
default. Every other analysis exists and returns the same answer, but it is
reached through the `sfi.run_analysis` gateway. This is not a bug and nothing
is missing.

**What to do.** Either of:

- Run the tool through the gateway: `sfi.run_analysis` with
  `{ "name": "sfi.get_edges", "args": { … } }`. `sfi.list_analyses` lists
  every name; `sfi.describe_analysis { name }` shows the arguments.
- Advertise the whole roster: set `SFI_TOOL_PROFILE=full` in the server's
  `env` and restart the host. This costs a lot of context in hosts that do
  not defer tool definitions.

If you are asking in a chat and the host keeps hitting this, the host is
following stale instructions; an up-to-date skill or prompt calls the
gateway. See [upgrading.md](./upgrading.md).

## `invalid-query`

**What it means.** The tool refused to guess. The selectors you passed
disagree with each other (two ids that resolve to different components),
none of them resolves to a real component, or an argument does not apply to
this tool (a `componentId` of the wrong kind). The message names the selector
that failed.

**What to do.**

- Resolve the name first: `sfi.resolve { query }` returns the canonical id
  (`CustomField:Account.Industry__c`, `Profile:Admin`). Use that.
- Pass exactly one selector. `componentId`, `apiName`, `objectApiName`,
  `fieldId`, `profileApiName` and friends are interchangeable, not additive.
- Check `appliedScope` in a successful answer: it echoes what the tool
  actually narrowed to.

Do not read `invalid-query` as "no such thing exists". It means the tool did
not run. The contract is in
[configuration.md](../configuration.md) § Input scope & selectors.

## `component-not-found`

**What it means.** The id is not in the graph, or its vault file is missing
(`vault file missing`). Common causes, most likely first:

1. **The id is wrong.** A label instead of an API name, `Profile:System
   Administrator` instead of `Profile:Admin`, a missing object prefix on a
   field. `sfi.resolve` or `sfi.search_components` finds the right one.
2. **The component is newer than the vault.** Run `sfi refresh`.
3. **The type was never retrieved or is not modeled.** `coverage` in
   `sfi.health_check` shows each metadata family with `retrieved: 0`,
   `neverModeled` or `pending`. `sfi.retrieve_blindspot_report` (through
   `sfi.run_analysis`) lists referenced-but-unretrieved types.
4. **A referenced id that cannot be retrieved as source:** a managed-package
   internal, a standard object, or something only a permission grant points
   at. The error then carries a classification and a `remedy`, which may be
   "stays a stub".

An empty where-used result on a real field is a different case: it means no
static evidence, not "unused". See
[asking-questions.md](./asking-questions.md) § 6.

## `oversize`: the answer did not fit

```
This tool's response (~70 KB) exceeds the response budget (~45 KB, SFI_MAX_RESPONSE_BYTES).
Re-query with a narrower scope — this tool supports: objectId, limit, offset
```

**What it means.** MCP clients reject results above their token limit, so
every answer goes through a byte budget. Lists are tail-truncated first
(`responseBudget.truncated`, `droppedCount`, and `nextOffset` on paged
calls), long strings are trimmed, and only an answer that still cannot fit
becomes this error. The message names the tool's own narrowing arguments.

**What to do.** Narrow the question: one object, one type, a `limit` with
`offset` paging, or whichever knobs the message lists. Raising
`SFI_MAX_RESPONSE_BYTES` (default 40,000) helps only up to its ceiling of
45,000 bytes; a larger value is clamped. For a sweep that is genuinely large,
page through it or run it from the CLI with `sfi run <tool> --json`, which
has no host to protect.

## Only one tool, `sfi.setup_status`: setup mode

**What it means.** The server started without a vault, so it offers one
diagnostic tool and nothing else. Three reasons, and `sfi.setup_status`
tells you which:

- **No vault built yet.** Run `sfi init --target-org <alias>` then
  `sfi refresh` in your Salesforce DX project. This is the normal first
  state, not a failure.
- **The server looked in the wrong place.** It resolved `./org-kb` against
  its launch directory (`serverLaunchDirectory`), which the host chose (often
  your home folder). Add `--vault <absolute path to org-kb>` to the server's
  args, or set `SFI_VAULT`.
- **A `--vault` / `SFI_VAULT` path that does not exist**, which is usually a
  typo. The message prints the path it was given.

After fixing it, **restart the server** (reconnect it in the host). It does
not reload by itself. The Claude Code plugin passes no `--vault`, so with the
plugin set `SFI_VAULT` or launch Claude Code from the folder that holds
`org-kb`.

## Stale vault, or a version-drift warning on every answer

**What it means.** Every answer carries `vaultState.freshness`: the version
that built the vault, the version running, the vault's age in days, and
`stale: true` once it is more than a week old. `sfi.health_check` adds a
plain-language `nudge` and `missingEdgeFamilies`, the edge families a newer
release would add. Answers are still served; they describe the org as it was
at the last refresh.

**What to do.** `sfi refresh --target-org <alias>` (or `/sfi-refresh`). After
upgrading the package this is required before trusting verdicts that depend
on new edge families ([upgrading.md](./upgrading.md)). `sfi status` shows
the refresh time and counts; `sfi doctor` checks auth and freshness and
prints a fix for each problem. To tell whether the org has moved since the
refresh without re-pulling, `sfi stale-sweep` counts changed components.

## VS Code: no server listed, no error

**What it means.** `.vscode/mcp.json` uses the Claude key `mcpServers`. VS
Code expects **`servers`**. The file parses, zero servers register, and
`MCP: List Servers` shows nothing. The editor underlines the key ("Property
mcpServers is not allowed"), which is easy to miss if you wrote the file
elsewhere.

**What to do.** Rename the top-level key to `servers` and restart the server
from `MCP: List Servers`. The exact block, including the `${workspaceFolder}`
form that avoids a hard-coded path, is in [mcp-hosts.md](./mcp-hosts.md).

## Windows: refresh fails with a lock error while the chat is open

**What it means.** On Windows one process cannot replace a file another
process holds open, and a connected MCP server holds the vault's graph
database. The refresh does all the work and then fails to swap the new
database in (the message mentions the file "being used by another process").
On macOS and Linux the swap succeeds behind the live server.

**What to do.** Close the MCP client (or stop `sfi mcp`), run the refresh,
then reopen the client. A scheduled refresh on Windows should run when no
client is attached.

## Live plane disabled

**What it means.** You asked a `sfi.live_*` tool (record counts, samples,
inactive users, org limits, drift checks) and no consent covers this org.
The tool returned an error instead of calling Salesforce. A per-call
`liveEnabled: true` is intent only; it never grants access.

**What to do.** Grant once per org with `sfi.live_consent { grant: true }`
(a standing grant, default scope `aggregate`, seven-day expiry; re-grant with
`scopes: ["sample"]` or `["users"]` for row samples or user lists), or set
`SFI_LIVE_PLANE_ENABLED=1` in the server's `env`. Revoke with
`{ revoke: true }`. Details in [configuration.md](../configuration.md) § Live
read-only plane.

## "Live-query budget exhausted"

```
Live-query budget exhausted mid-read — one or more signals were skipped (shown as n/a, NOT zero).
Raise SFI_LIVE_QUERY_BUDGET or start a new session, then re-run.
```

**What it means.** Every live query in a session draws on one budget
(`SFI_LIVE_QUERY_BUDGET`, default 50). A fleet-wide staleness check or a
hybrid answer across many orgs can use it up; the fields it could not read
show `n/a`, never zero.

**What to do.** Raise `SFI_LIVE_QUERY_BUDGET`, narrow the call (a `vaults`
subset, one object), or start a new session to reset the budget.

## `sfi refresh` problems

| Message | Cause | Fix |
|---|---|---|
| the alias "is not one of your authenticated sf orgs" | The local auth check did not find the alias in `sf org list` | `sf org list` to check the spelling; `sf org login web --alias <alias>` to re-authenticate. If auth comes from an access token in the environment and is invisible to the local list, `SFI_SKIP_AUTH_PREFLIGHT=1`. |
| retrieve times out on a large org | `sf project retrieve` ran longer than ten minutes | Raise `SFI_SF_RETRIEVE_TIMEOUT_MS` (milliseconds). The other `sf` timeouts are in [configuration.md](../configuration.md) § Salesforce CLI timeouts. |
| status `partial` | Some files failed extraction; each is listed with its `error.kind` | The vault is coherent for everything that succeeded. Commit it; note the skipped components. |
| status `failed` with a `Fatal:` line | A stage aborted, usually auth or an empty source tree | Read the `Fatal:` line. To rebuild from source already on disk without contacting the org, `sfi refresh --no-pull`. |
| "no vault" | `sfi init` has not run in this folder | `sfi init --target-org <alias>` first. |
| "Scaffolded sfdx-project.json" | You ran `init` outside a Salesforce DX project | If that was the wrong folder, delete `org-kb/`, `sfdx-project.json` and `force-app/` there and re-run in the right repo. |

## The tools are there but the answer looks wrong

Work through [asking-questions.md](./asking-questions.md) § 6 (freshness,
boundaries, then bug). Two things help a bug report: `sfi feedback mark
"<question>" --wrong` records it locally, and `sfi feedback export` writes a
scrubbed file (no org data) you can attach to an
[issue](https://github.com/PranavNagrecha/Salesforce-Intelligence/issues).
Include the output of `sfi doctor`.
