---
description: Refresh the SfIntelligence vault from the Salesforce org.
argument-hint: "[--target-org ALIAS] [--no-pull] [--types TYPE,TYPE,...]"
---

You are about to refresh the SfIntelligence vault.

## What to do

1. Load `.claude/skills/refreshing-the-org-vault/SKILL.md` — it owns
   the operational steps (pre-flight `sf org list` check, the 5–15
   minute expectation-setting before retrieve, and the
   success/partial/failure reporting rules). Do not paraphrase it
   here; follow it.
2. Run `sfi refresh` via the Bash tool from the repository root,
   forwarding any user-provided flags exactly as given. Do not add
   flags the user didn't ask for.
3. After the command exits, follow the skill's instructions for
   reading `org-kb/meta/manifest.json` and summarizing the result.

## Argument handling

`$ARGUMENTS` may contain any of:

- `--target-org <alias>` — override the `targetOrg` stored in
  `org-kb/meta/config.json` for this run only. The skill explains
  when to also offer to update the persisted config.
- `--no-pull` — skip `sf project retrieve` and re-extract from the
  existing `org-kb/source/` tree. Only forward this when the user
  explicitly says the source is already populated.
- `--types <CSV>` — restrict the refresh to a comma-separated subset
  of the nine v0.1 metadata types (e.g.
  `--types CustomObject,CustomField,ValidationRule`). The filter is
  by type, not by individual component.

If no arguments are passed, run `sfi refresh` with no flags. The CLI
reads the target org and vault root from `org-kb/meta/config.json`.

If `org-kb/meta/config.json` does not exist, the CLI exits non-zero
with a "Run `sfi init` first" message. Surface that verbatim and
point the user at `/sfi-init`; do not try to recover.

## Stopping conditions

Stop and report cleanly to the user when:

- `org-kb/meta/config.json` is missing — the user has not run
  `/sfi-init`. Tell them to run it first.
- `sf org list --json` shows the target alias is not `Connected`,
  or `sf` itself is not on `PATH`. Surface the skill's
  re-authentication message; do not retry.
- The refresh exits with `status: 'failed'`. Surface the `Fatal:`
  line verbatim per the skill's failure-modes table.
- The refresh exits with `status: 'partial'`. List the per-file
  errors and their `error.kind` honestly — do not flatten partial
  into success.
- Two consecutive retries fail with the same `Fatal:` line. Stop
  and ask the user before a third attempt.
