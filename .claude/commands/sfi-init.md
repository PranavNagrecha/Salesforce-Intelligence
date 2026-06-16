---
description: Set up SfIntelligence for this Salesforce org repository.
argument-hint: "[--target-org ALIAS] [--vault-root PATH] [--force]"
---

You are about to initialize SfIntelligence for this repository.

## What to do

1. Load `.claude/skills/using-sf-intelligence/SKILL.md` so you understand
   the product context (the offline vault, the nine v0.1 metadata types,
   the `sfi.*` MCP tool cascade) before running anything.
2. Run `sfi init` via the Bash tool from the repository root. Forward
   any user-supplied flags exactly as given — do not re-parse them or
   prompt the user yourself; the CLI handles interactive prompts.
3. If `sfi init` exits 0, tell the user the next step is `/sfi-refresh`
   to populate the vault from `sf project retrieve`.

## Argument handling

`$ARGUMENTS` may contain any of:

- `--target-org <alias>` — Salesforce org alias to bind to this vault.
  If omitted, `sfi init` prompts (defaulting to the user's `sf` default
  org when one is configured).
- `--vault-root <path>` — vault root directory, relative to CWD.
  Defaults to `org-kb` when omitted.
- `--force` — overwrite an existing `org-kb/` vault config.

If no arguments are passed, run `sfi init` with no flags and let the CLI
prompt the user.

If `org-kb/` already exists and `--force` is not passed, the CLI will
ask before overwriting. Do not retry with `--force` if the user
declines.

## Stopping conditions

Stop and report cleanly to the user when:

- The current directory is not a Salesforce DX project repo (no
  `force-app/` or `sfdx-project.json`). Tell the user to `cd` into a
  DX project and try again.
- The `sf` CLI is not installed or not on `PATH`. Tell the user to
  install the Salesforce CLI before initialising.
- `sfi init` exits non-zero. Surface the stderr message; do not
  retry blindly.
- The user has already declined to overwrite an existing vault.
