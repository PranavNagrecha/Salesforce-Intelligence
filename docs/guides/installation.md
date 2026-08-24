# Installing sf-intelligence

This guide walks a Salesforce admin or architect through installing
`sf-intelligence` against a per-org Salesforce DX repo. By the end you'll have
the `sfi.*` MCP tools available in your client and a clean baseline ready for
the first vault refresh.

`sf-intelligence` is published on npm as **`sf-intelligence`** — an MCP
server plus the `sfi` command-line tool. There is no repo to clone and nothing
to build: `npx` (or a one-line global install) fetches it. If you only want the
short version, see the [README](../../README.md); this guide goes deeper and
names the common failures.

## 1. Prerequisites

You need two things on the machine that runs your MCP client (Claude Code,
Claude Desktop, etc.). Versions are minimums; later versions are fine.

### Node.js 20+

```sh
node --version
# v20.x or later
```

`npx`, which launches the server, ships with Node. If `node --version` reports
an older version or "command not found", install Node.js 20 LTS from
[nodejs.org](https://nodejs.org) (or use `nvm` if you manage multiple versions).

### Salesforce CLI (`sf`), authenticated

`sfi refresh` shells out to `sf project retrieve`, so you need a working `sf`
CLI logged in to your target org.

```sh
sf --version
# @salesforce/cli/2.x.x
```

Confirm the org is reachable — `connectedStatus` must be `"Connected"`:

```sh
sf org list --json
```

If it shows `"RefreshTokenAuthError"` or anything else, re-authenticate:

```sh
sf org login web --alias my-org-alias
```

You'll pass that alias to `sfi refresh` later.

### A Salesforce DX project repo

`sf-intelligence` vaults **a per-org repo** — the git repo that holds your
`sfdx-project.json` and `force-app/` source. The vault (`org-kb/`) lives next to
that source. If you don't have a DX repo yet:

```sh
sf project generate --name my-org-repo
cd my-org-repo
```

You do **not** need Python, pnpm, or a checkout of this project to *use*
`sf-intelligence` — those are only for [contributing](../../CONTRIBUTING.md).

## 2. Install

There are three ways to run `sf-intelligence`. You don't choose one to the
exclusion of the others — the MCP server is almost always registered with `npx`,
and you separately pick how you want the `sfi` CLI for setup. At a glance:

| Mode | How you invoke it | Best for |
|---|---|---|
| **`npx` (zero-install)** | `npx -y sf-intelligence <command>` | The MCP server registration (recommended) and a quick try-out — nothing to install; re-checks the npm registry on each run |
| **Global install** | `npm install -g sf-intelligence`, then `sfi <command>` | A short, fast `sfi` command for day-to-day CLI use across every repo on the machine |
| **Local (in the DX repo)** | `npm install sf-intelligence`, then `npx sf-intelligence <command>` | Pinning the version per repo / sharing it with a team; `npx` resolves the repo-local copy with no re-download |

The next two subsections set up the MCP server (with `npx`) and, optionally, the
CLI (global or local).

### Register the MCP server

**Claude Code** — from your DX repo, register it project-scoped (writes
`.mcp.json` at the repo root, which you can commit so your team shares it):

```sh
claude mcp add --transport stdio --scope project sf-intelligence -- npx -y sf-intelligence mcp
```

Use `--scope user` instead to make it available in every project on your
machine, or `--scope local` (the default) for just this project, private to you.

**Claude Desktop** — add this block to the client's MCP config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\\Claude\\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "sf-intelligence": {
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp", "--vault", "/abs/path/to/org-kb"]
    }
  }
}
```

Quit and reopen the client (closing the window is not enough).

**Pass an absolute `--vault` path.** The server resolves `./org-kb` against
*its own* working directory, which the host chooses — Claude Desktop is launched
from the Dock or Start menu and never runs inside your Salesforce project.

**Using VS Code + GitHub Copilot, or Codex?** Both use a different config file
*and* a different format — VS Code's top-level key is `servers`, not
`mcpServers`, and Codex uses TOML. See
[**mcp-hosts.md**](./mcp-hosts.md) for the exact block for every host on macOS
and Windows.

> **Cursor (and other IDE MCP clients):** after editing the MCP config you must
> reload it — Cursor does not pick up `.cursor/mcp.json` changes live. Toggle
> the server off/on in Settings → MCP (or restart the IDE). Until you do, the
> `sfi.*` tools won't appear in the agent's tool list.

### Optional: install the CLI globally — or locally in the repo

`npx -y sf-intelligence …` works without installing anything, but it's
verbose and re-checks the registry each run. A global install gives you a short
`sfi` command for setup:

```sh
npm install -g sf-intelligence
sfi --version
```

Prefer not to install globally? Add it to the DX repo instead and call it with
`npx` (which then resolves the local copy, no re-download):

```sh
npm install sf-intelligence      # adds it to the repo's package.json
npx sf-intelligence --version    # resolves node_modules/.bin/sfi
```

### Production pin (required for shared / CI installs)

Floating on `latest` is fine for a quick try-out. For production MCP configs and
shared DX repos, **pin an exact version** (`sf-intelligence@X.Y.Z` in `npx`
args, or an exact version in `package.json` — no `^` / `~`). See
[Supply chain — pin, verify, SBOM](./supply-chain.md) for pinned MCP JSON,
provenance verification (`npm audit signatures`), the published tarball
allowlist, and SBOM generation.

## 3. Verify the install

In a session with your MCP client, confirm the server connected and answers:

- **Claude Code** — run `/mcp`. `sf-intelligence` should be listed as
  connected.
- **Any client** — ask the model to run the `sfi.health_check` tool. A
  `healthy` envelope means the server is wired up correctly.

Before your first refresh there is no vault yet, so the server starts in
**setup mode**: it connects and offers a single tool, `sfi.setup_status`, which
reports where it looked for a vault and the exact commands to build one. Seeing
only that tool is the expected first state, not a broken install — ask your
assistant "what do you need from me?" and it will walk you through §4.

If the server isn't listed or won't connect, see the troubleshooting table in §5.

## 4. First-run setup

From your DX repo:

```sh
sfi init                               # create org-kb/, record the org alias
sfi refresh --target-org my-org-alias  # retrieve metadata, build the vault
sfi status                             # freshness, source-tree hash, counts
```

The first refresh runs `sf project retrieve` then the extractor → renderer →
graph-import pipeline; it takes a few minutes on a typical sandbox. Later
refreshes re-extract and rebuild the graph in full by default (results always
match a cold build) — pass `--incremental` to reuse the previous run's
per-file parse cache, and `--incremental-graph` to also re-import only the
changed nodes/edges into the graph, for the same result, faster. (No global
install? Prefix each command with `npx -y sf-intelligence`.) For the manual
walkthrough and the `org-kb/` git policy, see
[`first-refresh.md`](./first-refresh.md).

### Keeping the vault current

The vault is a point-in-time snapshot; the live org keeps changing after a
refresh. Two tools tell you when it's time to re-pull, so a stale answer is
never presented as current:

- **`sfi.health_check`** reports a `freshness` block — the vault's age in days,
  a `stale` flag, and a plain-language `nudge` once the vault is more than a
  week old. It is purely advisory (it never downgrades the health verdict on
  age alone); the nudge is the yellow flag that keeps a stale snapshot from
  being narrated as current.
- **`sfi.live_drift_check`** goes further: for an object you name, it compares
  the fields the vault recorded at the last refresh against a **live** describe
  of the org and reports `onlyInVault` (fields the snapshot has but the live org
  no longer returns — the high-signal "this vault is stale" indicator),
  `onlyInLiveCustom` (custom fields added live since the refresh), and `inSync`,
  with a plain-language `interpretation`. It is the one tool that reads both
  planes at once, and it never mutates the org. Because it queries the org, it
  needs the **opt-in live plane** — enable it once per org
  (`sfi.live_consent { grant: true }`) or set `SFI_LIVE_PLANE_ENABLED=1`
  (per-call `liveEnabled: true` is intent only, not consent); without a grant
  it returns a clear "live plane disabled" error rather than calling
  Salesforce. See
  [`configuration.md`](../configuration.md).

When either flags drift, run `sfi refresh --target-org my-org-alias` to re-pull
and rebuild the vault.

### Scheduling a recurring refresh (the weekly pulse)

A refresh does more than rebuild the vault. On completion it also:

- writes a **pulse** to `org-kb/meta/pulse.json` — the graph growth/shrink
  headline plus per-domain watch-lines (new/changed Flows, new fields that may
  carry PII, Apex/Flow growth to check against governor limits);
- logs the org's tech-debt score to `org-kb/meta/risk-scores.jsonl`, so the next
  `sfi.tech_debt_score` reports a `scoreDelta` versus this refresh; and
- regenerates the onboarding handbook at `org-kb/docs/onboarding.md`.

Run the refresh on a schedule and those become a standing **weekly pulse** — a
short "what changed this week" report you (or an agent) can read without lifting
a finger. This is the observability axis: the vault stops being only a Q&A
surface and starts telling you when something moved.

**cron** (macOS / Linux) — a weekly Monday-morning refresh. On **Windows** use Task Scheduler instead:
`schtasks /create /tn sfi-refresh /sc weekly /d MON /st 07:00 /tr "cmd /c cd /d C:\\path\\to\\dx-project && npx -y sf-intelligence refresh --target-org my-org-alias"`


```cron
# Re-pull + rebuild every Monday at 07:00; the pulse, risk-score log, and
# onboarding handbook refresh with it. sfi exits non-zero on failure, so the
# log captures a failed run.
0 7 * * 1  cd /path/to/dx-project && sfi refresh --target-org my-org-alias >> /path/to/sfi-refresh.log 2>&1
```

After each run the headline is one read away:

```sh
cat /path/to/dx-project/org-kb/meta/pulse.json   # graph deltas + watch-lines
```

**Claude Code `/schedule`** — if you drive sfi from Claude Code, a scheduled
routine can run the refresh and summarize the result for you on the same
cadence. The `/schedule` command creates a cron-scheduled remote agent; point it
at a prompt that runs `sfi refresh`, then reads `org-kb/meta/pulse.json` and the
`scoreDelta` from `sfi.tech_debt_score`, and posts the weekly digest.

The output lives entirely under the gitignored `org-kb/` — nothing here is
published or written back to the org.

## 5. Common install issues

| Symptom | Likely cause | Fix |
|---|---|---|
| MCP server not listed in `/mcp` (or no `sfi.*` tools) | Client not reloaded, or config in the wrong file | Reload/restart the client. For Claude Code, confirm `.mcp.json` is at the repo root and you launched Claude from that directory. For Cursor, reload the MCP config (Settings → MCP) after editing `.cursor/mcp.json` |
| `sfi doctor` says `sf` not found, but it is installed | IDE/MCP subprocess didn't inherit your shell `PATH` (e.g. `/usr/local/bin`, `/opt/homebrew/bin`) | doctor now probes those locations and reports a PATH warning; add the Salesforce CLI directory to the PATH of whatever launches the client |
| `npx` re-downloads the package every run | That's how `npx` works | Run `npm install -g sf-intelligence` once, then use the `sfi` command |
| `sfi: command not found` | The CLI isn't installed globally | `npm install -g sf-intelligence`, or call it through `npx -y sf-intelligence <command>` |
| `sfi init` reports "no DX project" | You're not in a Salesforce DX project | `cd` into the directory that contains `sfdx-project.json`, then re-run |
| `sfi refresh` reports "no vault" | `sfi init` hasn't run in this repo yet | Run `sfi init` first; pick a target-org alias when prompted |
| `sf project retrieve` fails during refresh | `sf` not authenticated, or wrong alias | `sf org login web --alias my-org-alias`, then re-run `sfi refresh --target-org my-org-alias` |
| Server connects but offers only `sfi.setup_status` | No vault built yet — this is setup mode, working as intended | Run `sfi init` then `sfi refresh` (§4), then restart the client. Ask your chat to run `sfi.setup_status` for the exact commands |
| Server connects but finds no vault even though you built one | The host launched the server from a directory that isn't your DX repo, so `./org-kb` didn't resolve | Add `--vault <absolute path to org-kb>` to the server's args. `sfi.setup_status` reports the directory it actually used |
| VS Code: no server in `MCP: List Servers`, no error | `.vscode/mcp.json` uses `mcpServers` (the Claude key) instead of `servers` | Rename the top-level key to `servers`. See [mcp-hosts.md](./mcp-hosts.md) |
| Windows: `'sfi' is not recognized …` | The CLI isn't installed globally | `npm install -g sf-intelligence`, or call it as `npx -y sf-intelligence <command>` |
| Windows / macOS GUI apps: `spawn ENOENT` on `npx` | The app was launched from Explorer/Dock and inherited the *system* PATH, not your shell's — so `node`/`npx` aren't visible | Use absolute paths for both: `"command": "<abs path to node>", "args": ["<abs path>/sf-intelligence/bin/sfi.js", "mcp", "--vault", "…"]`. Find them with `where node` / `which node` and `npm root -g` |

If you hit something not on this table, run `sfi doctor` — it checks the `sf`
CLI, the vault, target-org auth, freshness, and the graph file, and prints an
actionable fix for each problem.

## 6. What it does and doesn't do

Once installed, `sf-intelligence` is a **read-only, offline-first** knowledge
base for one org. After a refresh, vault answers come from the local Markdown
vault and DuckDB graph — no network egress for those tools. The boundaries are
deliberate, and the product names them plainly rather than guessing:

- **Offline by default** — vault tools never call Salesforce mid-conversation.
  Run `sfi refresh` to update metadata.
- **Opt-in live plane** — curated read-only tools (`sfi.live_count`,
  `sfi.live_sample`, `sfi.live_describe`, and others) can query the org when you
  enable them once per org (`sfi.live_consent { grant: true }`) or set
  `SFI_LIVE_PLANE_ENABLED=1`. Per-call `liveEnabled: true` is intent only and
  does not grant access. See
  [`configuration.md`](../configuration.md).
- **No arbitrary live SOQL** — only the curated `sfi.live_*` roster; no generic
  query tool.
- **No record data in the vault** — the vault holds schema and source, not rows.
  Live tools return capped runtime samples only when explicitly enabled.
- **Static analysis, not runtime** — dynamic SOQL and reflective Apex are
  invisible, so "no references found" means "no static evidence", not
  "definitely unused".
- **Read-only** — there is no write path back to the org.

For the full capability map and these boundaries in depth, see the
[README](../../README.md), [`architecture.md`](../architecture.md) §2, and
[`asking-questions.md`](./asking-questions.md).

## 7. Next steps

Once `/mcp` (or `sfi.health_check`) confirms the server is connected and §4 has
built your first vault, you're ready. Read [`first-refresh.md`](./first-refresh.md)
for the vault layout and git policy, and
[`asking-questions.md`](./asking-questions.md) for what to ask and how the
resolver behaves.

> **Using Claude Code as a plugin?** When `sf-intelligence` is loaded as a
> Claude Code plugin, the `/sfi-onboard`, `/sfi-init`, `/sfi-refresh`, and
> `/sfi-status` slash commands wrap the `sfi` CLI, and the coaching skills
> auto-activate. The npm install above gives you the MCP tools and CLI; the
> plugin layer adds those conveniences.

For a deeper read on the data flow, the DuckDB graph store, the MCP tools, and
configuration, see [`architecture.md`](../architecture.md) and
[`configuration.md`](../configuration.md).
