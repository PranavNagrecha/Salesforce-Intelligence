---
description: Guided first-run setup for SfIntelligence.
argument-hint: "[--target-org ALIAS] [--vault-root PATH] [--with-tooling-api] [--skip-refresh]"
---

You are about to guide a new user through their first SfIntelligence setup.

This command is the product's first-run wizard. The user has installed the
plugin, but they may not know what a vault is, which Salesforce org is active,
or what question to ask first. Keep the experience direct and operational.

## What this command does

Walk the user through:

1. Pick the Salesforce org alias to connect.
2. Initialize the local vault.
3. Refresh the metadata snapshot.
4. Verify the vault and MCP server.
5. Run one known-good test question.
6. Tell the user they are ready and show the most useful commands.

SfIntelligence is read-only. Say this plainly before the refresh:

> SfIntelligence will retrieve metadata and build a local vault. It will not
> deploy, insert, update, delete, or mutate Salesforce data.

## Argument handling

`$ARGUMENTS` may contain:

- `--target-org <alias>` - use this alias without asking the user to pick.
- `--vault-root <path>` - pass through to `sfi init`; default is `org-kb`.
- `--with-tooling-api` - pass through to `sfi refresh`; this adds live
  read-only Tooling API enrichment for freshness fields after the offline
  retrieve finishes.
- `--skip-refresh` - initialize and verify only; do not run the first refresh.

If no target org is supplied, run `sf org list --json` and show the connected
org aliases/usernames. Ask the user which one to use. If exactly one connected
org exists, recommend it but still name it before proceeding.

Do not ask the user to type npm, node, pnpm, or MCP config commands during this
flow unless a diagnostic failure requires it.

## Step-by-step flow

### Step 1 - Preflight

Run these checks from the current working directory:

```sh
sfi doctor
```

Then run:

```sh
sf org list --json
```

Stop and give a concrete fix when:

- `sfi` is not on PATH: tell the user the plugin CLI is not installed or the
  MCP package is not available yet.
- `sf` is not on PATH: tell the user to install Salesforce CLI.
- no connected org is available: tell the user to run
  `sf org login web --alias <alias>` and then rerun `/sfi-onboard`.
- the current directory is not a Salesforce DX project and `sfi init` would
  need to scaffold one: explain that the recommended setup is to run this from
  the repo that represents the org.

If `sfi doctor` reports `no vault`, continue. That is expected for first run.

### Step 2 - Initialize

Run:

```sh
sfi init --target-org <alias>
```

Forward `--vault-root <path>` when the user supplied it.

If a vault already exists, do not overwrite it automatically. Ask whether they
want to keep it and continue to refresh/status, or rerun init with `--force`.

After successful init, summarize:

- target org alias
- vault root
- whether `.gitignore` was updated

### Step 3 - Refresh / snapshot

If `--skip-refresh` was not supplied, tell the user:

> This can take 5-15 minutes on a real org. The slow part is Salesforce
> metadata retrieve; after that, extraction and graph build are local.

Then run:

```sh
sfi refresh --target-org <alias>
```

Add `--with-tooling-api` only when the user supplied it. Explain that it is
still read-only and enriches component freshness fields.

If refresh returns `partial`, do not call it a success. List the per-file
errors and tell the user the vault is usable for extracted components but has
coverage gaps.

If refresh returns `failed`, surface the `Fatal:` line and stop.

If refresh succeeds, mention that the default config captures a vault snapshot
on refresh when `snapshotOnRefresh` is enabled.

### Step 4 - Verify

Run:

```sh
sfi status
sfi doctor
```

Then use the MCP tools, if available:

1. Call `sfi.health_check` with no arguments.
2. Call `sfi.capabilities` with no arguments.
3. Call `sfi.route_question` with:

```json
{ "question": "what happens when Account is saved?" }
```

If MCP tools are not visible, tell the user the local vault is ready but their
MCP client needs to restart or reload the plugin.

### Step 5 - First answer check

Ask one simple question through the normal route-first behavior:

> Try: "What happens when Account is saved?"

If the user asks you to run it now, call `sfi.route_question` first, then the
recommended tool chain. Keep the answer short and cite provenance/freshness.

### Step 6 - Ready message

When all checks pass, end with this structure:

```text
You are ready.

Connected org: <alias>
Vault: <path>
Last refresh: <refreshedAt>
MCP tools: available

Useful commands:
- /sfi-status - check freshness and component counts
- /sfi-refresh - pull fresh metadata and rebuild the vault
- /sfi-refresh --with-tooling-api - refresh plus last-modified enrichment
- /sfi-init --force --target-org <alias> - rebind this repo to a different org

Good first questions:
- What happens when Account is saved?
- What fields does Contact have?
- What breaks if I delete this field?
- Who can edit Contact Email?
- What external systems does this org talk to?
```

Do not claim the product can answer record data questions from the offline
vault. For counts/samples, explain that live tools are opt-in and read-only.

