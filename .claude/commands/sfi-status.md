---
description: Show SfIntelligence vault freshness and component counts.
argument-hint: "[--json]"
---

You are about to show the SfIntelligence vault status.

## What to do

1. Run `sfi status` via the Bash tool from the repository root,
   forwarding `--json` exactly if the user passed it. Do not add
   flags the user did not ask for; `sfi status` is read-only and
   always exits 0.
2. Read the CLI's output and route the user based on its `kind`:
   - `no-vault` — the user has not run `/sfi-init`. Tell them to
     run `/sfi-init` followed by `/sfi-refresh`.
   - `no-manifest` — the vault is initialized but has never been
     refreshed. Recommend `/sfi-refresh`.
   - `stale` — `source/` has changed since the last refresh.
     Recommend `/sfi-refresh` and surface the manifest's
     `refreshedAt` so the user can sanity-check the age.
   - `fresh` — everything is current. Don't editorialize; relay
     the summary and stop.
3. If the user explicitly asks for diagnostics — "is something
   off?", "are we connected?", "is the MCP server up?", or a
   previous `sfi.*` MCP call returned a degraded/unhealthy
   envelope — load
   `.claude/skills/pre-flight-checks/SKILL.md` and follow it
   for the three-probe report. `sfi status` alone does not
   check `sf` CLI auth or MCP health; pre-flight does.

## Argument handling

`$ARGUMENTS` may contain:

- `--json` — emit the raw `StatusOutput` as pretty-printed JSON
  instead of the human-readable summary table. Forward it
  verbatim. Use this when the user asks for the raw status
  (e.g. they're piping it into another tool) or when you need
  the structured `kind` / `manifest` / `currentSourceHash`
  fields to drive a follow-up step.

If no arguments are passed, run `sfi status` with no flags and
read the summary table.

## Stopping conditions

This is a read-only command. It never writes to the vault and
always exits 0 — even `no-vault` is a recoverable state, not an
error. Stop and report cleanly to the user when:

- `sfi status` exits non-zero for any reason. That is not an
  expected state; surface the stderr line verbatim and do not
  retry. The CLI may be miswired or the workspace may have a
  broken install — point the user at `docs/guides/installation.md`.
- The user asks you to "fix" the reported state from inside this
  command. Don't. `/sfi-status` reports; recovery is the user's
  call, via `/sfi-init` or `/sfi-refresh`.
- The pre-flight skill (if loaded) returns a verdict that the
  user needs to act on. Surface its numbered checklist and
  recommendation verbatim; do not paraphrase.
