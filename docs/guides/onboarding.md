# Guided onboarding

This is the recommended first-run path for a new SfIntelligence user. It
assumes the plugin is installed and the user is working inside the Salesforce DX
repo for the org they want to understand.

> **npm-only install?** The `/sfi-*` slash commands below come from the Claude
> Code **plugin** layer. If you installed only the npm package (MCP server + CLI),
> you don't have them — use the CLI equivalents instead: `sfi init` for
> `/sfi-init`, `sfi refresh` for `/sfi-refresh`, `sfi status` / `sfi doctor` for
> `/sfi-status`, and just ask your MCP client a question (the `sfi.*` tools)
> rather than `/sfi-onboard`. See [`installation.md`](./installation.md) and
> [`asking-questions.md`](./asking-questions.md).

## What the user does

Open Claude Code in the Salesforce DX repo and run:

```text
/sfi-onboard
```

If they already know the org alias:

```text
/sfi-onboard --target-org my-org-alias
```

For richer freshness fields, use:

```text
/sfi-onboard --target-org my-org-alias --with-tooling-api
```

The onboarding command is read-only. It retrieves Salesforce metadata, builds a
local vault, and verifies that MCP tools can answer questions. It does not
deploy, insert, update, delete, or mutate Salesforce data.

## What the guided flow does

1. **Find the org**
   - Checks `sf org list --json`.
   - Shows connected org aliases.
   - Uses the supplied `--target-org` or asks the user which alias to bind.

2. **Initialize the vault**
   - Runs `sfi init --target-org <alias>`.
   - Creates `org-kb/`.
   - Writes `org-kb/meta/config.json`.
   - Adds generated directories to `.gitignore`.

3. **Run the first metadata snapshot**
   - Runs `sfi refresh --target-org <alias>`.
   - Retrieves metadata with the Salesforce CLI.
   - Extracts components and edges.
   - Builds the DuckDB graph.
   - Renders Markdown components.
   - Writes the manifest and source-tree hash.

4. **Wait honestly**
   - The command tells the user that real org refreshes can take 5-15 minutes.
   - If the refresh is partial, the user sees the skipped files/errors.
   - If the refresh fails, the user sees the fatal line and the next fix.

5. **Verify the setup**
   - Runs `sfi status`.
   - Runs `sfi doctor`.
   - Calls `sfi.health_check`.
   - Calls `sfi.capabilities`.
   - Routes a known question through `sfi.route_question`.

6. **Ask the first question**
   - Recommended first prompt:

     ```text
     What happens when Account is saved?
     ```

   - The assistant should route first, run the recommended tool chain, and show
     provenance/freshness.

7. **Finish with the ready state**
   - Shows the connected org, vault path, last refresh timestamp, and MCP status.
   - Lists the commands the user will need next.

## What "ready" means

The user is ready when:

- `sfi doctor` has no blocking failures.
- `sfi status` shows a refreshed vault.
- `sfi.health_check` reports the graph is readable.
- `sfi.route_question` can route a normal metadata question.
- The first answer includes vault provenance/freshness.

## Helpful commands after onboarding

```text
/sfi-status
```

Check vault freshness and component counts.

```text
/sfi-refresh
```

Retrieve fresh metadata and rebuild the vault.

```text
/sfi-refresh --with-tooling-api
```

Refresh metadata and enrich component freshness fields with read-only Tooling
API calls.

```text
/sfi-init --force --target-org my-other-alias
```

Rebind this repo to a different Salesforce org.

## Reloading the MCP server after a refresh

The MCP server opens the vault — the DuckDB graph and the manifest — **once when
it starts**, and holds it read-only for the life of the process. That shared,
read-only handle is deliberate: it lets more than one `sfi mcp` instance serve
the same vault at once. But it has one consequence worth knowing on day one:

- **A `sfi refresh` is not reflected in an already-running server until you
  reload it.** The refresh rebuilds `org-kb/graph/graph.duckdb`, but the running
  server is still answering from the copy it opened at startup. Reload (or
  restart) the MCP server so it reopens the rebuilt vault.
- **A running server can also block the refresh.** `sfi refresh` needs an
  exclusive write lock; the server's shared read lock can deny it, surfacing as a
  `locked` / "database is locked" error. If you see that, stop or reload the
  server, run the refresh, then bring the server back.

How to reload, by client:

- **Claude Code** — toggle the server off and on (or restart Claude). `/mcp`
  should re-list `sf-intelligence` as connected afterward.
- **Cursor / other IDE clients** — Settings → MCP → reload, or restart the IDE;
  these do not pick up vault or config changes live.
- **Claude Desktop** — quit and reopen the app.

This is only for picking up a *refresh* (or a package upgrade). Ordinary
questions never need a reload — the server answers them from the vault it already
has open. The reload table for *config* changes (a new `.mcp.json`) is in
[`installation.md`](./installation.md) §5.

## Good first questions

- What happens when Account is saved?
- What fields does Contact have?
- What breaks if I delete this field?
- Who can edit Contact Email?
- What external systems does this org talk to?
- Is my vault fresh?
- What changed recently?

## Boundaries to tell users early

- Offline vault answers come from the last refresh.
- Live record counts and samples are opt-in and read-only.
- Static dependency analysis cannot see dynamic SOQL, reflection, or runtime-only
  behavior.
- "No references found" means no static evidence, not proof that something is
  safe to remove.

