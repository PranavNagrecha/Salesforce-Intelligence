---
description: Set up SfIntelligence for this Salesforce org repository.
argument-hint: "[--target-org ALIAS] [--vault PATH] [--force]"
---

You are about to initialize SfIntelligence for this repository.

## Running the CLI

The plugin installs the MCP server, not the `sfi` command. Before the first
command, run `command -v sfi` via the Bash tool. If it prints a path, run the
commands below as written. If it prints nothing, run every `sfi …` command
below as `npx -y sf-intelligence@0.4.0 …` instead, with the same arguments.
The Bash tool has no terminal, so the CLI cannot prompt: always pass the
flags it would otherwise ask for.

## What to do

1. Load `.claude/skills/using-sf-intelligence/SKILL.md` so you understand
   the product context (the offline vault, the `sfi.*` MCP tool cascade)
   before running anything.
2. If the user did not pass `--target-org`, run
   `sf org list --skip-connection-status --json` (local, does not contact
   any org), show the aliases, and ASK the user which org this project
   models. Never pick one yourself, and never run `sfi init` without
   `--target-org`.
3. Run `sfi init --target-org <alias>` via the Bash tool from the
   repository root, forwarding any other user-supplied flags exactly as
   given.
4. If `sfi init` exits 0, tell the user the next step is `/sfi-refresh`
   to populate the vault from `sf project retrieve`. If it printed a
   warning that the alias is not authenticated, relay it.

## Argument handling

`$ARGUMENTS` may contain any of:

- `--target-org <alias>` — Salesforce org alias to bind to this vault.
  If omitted, ask the user (step 2) — the CLI cannot prompt here.
- `--vault <path>` (or `--vault-root <path>`) — vault root directory.
  Defaults to `org-kb` when omitted.
- `--force` — overwrite an existing `org-kb/` vault config.

If `org-kb/` already exists and `--force` is not passed, the CLI exits
non-zero saying so. Ask the user before re-running with `--force`, and do
not retry if they decline.

## Stopping conditions

Stop and report cleanly to the user when:

- The current directory has no `sfdx-project.json`. `sfi init` would
  scaffold a minimal DX project here, so confirm with the user that this
  is the directory that represents the org before running it.
- The `sf` CLI is not installed or not on `PATH`. Tell the user to
  install the Salesforce CLI before initialising.
- `sfi init` exits non-zero. Surface the stderr message; do not
  retry blindly.
- The user has already declined to overwrite an existing vault.
