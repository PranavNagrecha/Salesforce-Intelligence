---
name: pre-flight-checks
description: |
  Diagnostic skill for the SfIntelligence vault. Use when the user
  invokes `/sfi-status`, says "is something wrong?", "the vault feels
  off", "something looks stale", "are we connected?", "is the index
  current?", or when a previous `sfi.*` MCP call returned a `degraded`
  or `unhealthy` status, an unexpected error envelope, or two
  consecutive errors. Runs three probes — `sfi.health_check`,
  `sfi.get_manifest`, and `sf org list --json` — and reports findings
  as a numbered checklist. Reports only; suggests but does not run
  `/sfi-refresh` or `/sfi-init`.
---

# Pre-flight checks

## Overview

This is the diagnostic skill. It runs three probes — `sfi.health_check`,
`sfi.get_manifest`, and a shell-out to `sf org list --json` — and
returns a short numbered report plus one recommended next action.

**The skill never fixes anything.** Reporting is the whole job.
Recovery actions (`/sfi-refresh`, `/sfi-init`,
`sf org login web --alias …`) are user-driven. If you find yourself
trying to "fix" a stale vault from inside this skill, you've slipped
into the refresh skill's lane.

## When to fire

**Explicit:**
- The user typed `/sfi-status`.

**Conversational triggers:**
- "Is something wrong?" / "What's going on?" / "Is the server up?"
- "The vault feels off" / "Something looks stale" / "This doesn't look
  right" / "Are we connected to my org?"
- "Is the index current?" / "How fresh is the data?" (a manifest
  question — answer it with `get_manifest`, but route through this
  skill so the user also sees auth + health).

**Derived triggers (you fire this skill yourself):**
- A `sfi.*` tool call returned `status: 'degraded'` or
  `status: 'unhealthy'` in its envelope.
- A `sfi.*` tool call returned an `error` shape you didn't expect
  (`{ error: { kind: 'internal', message: '...' } }`).
- Two consecutive `sfi.*` calls failed for any reason. Don't keep
  retrying — fire this skill and read the report.

## When NOT to fire

- The user wants the vault **refreshed**. That's
  `refreshing-the-org-vault`. Pre-flight only reports; it doesn't
  invoke `sfi refresh`.
- The user wants the vault **initialized** for the first time. That's
  `/sfi-init`. Pre-flight assumes a vault exists; if `vaultExists` is
  false the report says so and routes the user to init.
- The user is asking a normal org question and there's no signal of
  trouble. Don't run diagnostics before every turn — only when
  something looks off or the user asks.
- A single tool call returned an `error` that the calling skill knows
  how to handle (`component-not-found`, `invalid-query`). One handled
  error is not "trouble".

## The 3 probes

Run all three, in this order, every time. Don't short-circuit — the
report's value is the *combination*. A healthy MCP server with a
broken `sf` CLI auth is still a degraded user experience.

### Probe 1 — `sfi.health_check`

Input: `{}`. Read from the response:

- `data.status` — `'healthy'` | `'degraded'` | `'unhealthy'`.
- `data.issues` — string array; render verbatim, in order. Empty when
  `status === 'healthy'`.
- `data.checks.vaultExists` — `false` means `org-kb/` is missing; route
  to `/sfi-init`.
- `data.checks.graphReadable` — `false` means DuckDB can't be queried;
  `status` will be `'unhealthy'`.
- `data.checks.sourceHashMatches` — `true` | `false` | `null`. `false`
  is the stale-vault signal (route to `/sfi-refresh`). `null` means
  `source/` is absent (typical on a fresh clone where it's gitignored);
  surface as "freshness unknown", not failure.
- `data.coverage` / coverage summary (when present) — if `status` is
  `partial` or `coverageKnown` is false, note that absence-based answers
  are incomplete. Suggest `sfi.coverage_report` for the full breakdown.

### Probe 2 — `sfi.get_manifest`

Input: `{}`. Reads the in-memory manifest snapshot. From the response:

- `data.refreshedAt` — ISO 8601 timestamp; render as both raw and
  human-readable age ("2 days ago", "3 minutes ago").
- `data.sourceOrg` — the `sf` CLI alias the vault was retrieved from;
  use this as the alias to check in Probe 3.
- `data.components` — partial record by `ComponentType`. Surface the
  total ("847 components across 9 types"), not per-type unless asked.
- `data.sourceTreeHash` — last 12 chars are enough.

If `get_manifest` itself errors, the MCP server is in an inconsistent
state — surface verbatim and recommend `/sfi-refresh`.

### Probe 3 — `sf org list --json`

The MCP server runs in a stdio context and **cannot** check `sf` CLI
auth on its own. Shell out:

```bash
sf org list --json
```

Parse the JSON. Look at `result.nonScratchOrgs[]` and
`result.scratchOrgs[]`; each entry has `alias`, `username`, and
`connectedStatus`. Find the alias from `manifest.sourceOrg`:

- Found, `connectedStatus === 'Connected'` → ✓.
- Found, `connectedStatus` mentions `RefreshTokenAuthError` or
  `expired` → ✗; recommend `sf org login web --alias <alias>`.
- Not found → ✗; alias is gone, recommend re-login or `/sfi-init`.
- `sf: command not found` → ✗; point at the Salesforce CLI install docs.

If `sf org list --json` exits non-zero or returns invalid JSON, treat
as ✗ and surface the stderr line.

## Interpreting status

The aggregate verdict drives the recommendation. The mapping:

| Verdict | Meaning | Recommended action |
|---|---|---|
| `healthy` + auth ✓ | Everything's fine. | None — ask the user what they noticed; perception may be unrelated. |
| `healthy` + auth ✗ | Vault is queryable; CLI can't talk to Salesforce. | `sf org login web --alias <alias>`. Read-only org questions still work; refresh is blocked until auth is restored. |
| `degraded` (stale hash) | Source tree changed since last refresh. | `/sfi-refresh`. |
| `degraded` (vault dir missing) | Vault root doesn't exist. | `/sfi-init`. |
| `unhealthy` | Graph isn't queryable; DuckDB store is broken or missing. | `/sfi-refresh` (rebuilds the DB). If that also fails, `/sfi-init`. |

When in doubt between refresh and init: if `vaultExists === false` or
`config.json` is unreadable, init. Otherwise refresh.

## Output format

Report findings as a **short numbered checklist**. Five lines for the
checks, one blank line, one recommendation line. Don't editorialize;
the checklist is the answer.

```
1. sf CLI auth: ✓ (target org `admin@example.com` connected)
2. Vault directory: ✓
3. Graph queryable: ✓
4. Source-tree hash: ✗ (vault is stale — source/ has changed since last refresh)
5. Last refreshed: 2 days ago (2026-05-25T14:33:08Z)

Recommended: run `/sfi-refresh` to bring the vault current.
```

When everything's fine, omit the recommendation line; close with a
question instead:

```
1. sf CLI auth: ✓ (target org `admin@example.com` connected)
2. Vault directory: ✓
3. Graph queryable: ✓
4. Source-tree hash: ✓
5. Last refreshed: 3 minutes ago (2026-05-27T14:30:00Z) — 847 components vaulted

Everything looks healthy. What were you noticing that felt off?
```

Use `✓` and `✗` literally (the user sees them in monospace). Don't
substitute words ("yes"/"no", "ok"/"fail") — the symbols scan faster.
Use `skipped` for the source-hash row when `sourceHashMatches === null`.

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "The user said 'something feels off'; I'll just answer their next question and see if it works." | Run the three probes first. A stale vault answers wrong with confidence; the user won't catch it. |
| "`health_check` returned `healthy`; I don't need to check auth." | Auth is independent of vault health. A degraded `sf` CLI doesn't show up in `health_check` — the MCP server can't see it. Always run Probe 3. |
| "I'll skip `get_manifest` because `health_check` already covers freshness." | `health_check` returns a hash comparison; `get_manifest` returns the timestamp and counts the user can act on. Both. |
| "I'll fix the stale vault by running `sfi refresh` from here." | No. This skill reports; the user types `/sfi-refresh`. `refreshing-the-org-vault` drives that flow with its own pre-flight checks. |
| "Probe 1 errored; the other two are moot." | Run them anyway. Probe 1 failing tells you the MCP server is broken; Probes 2 and 3 may reveal *why* (e.g., auth is bad → refresh will fail too). |
| "`sourceHashMatches === null` is an error." | No — it means `source/` is absent, typical on a fresh clone where the source tree is gitignored. Surface as "freshness unknown". |
| "I'll paraphrase the report as prose." | The numbered format is the diagnostic signal of this skill. Don't dilute it with paragraphs. |
| "Two errors in a row — I'll retry the failing tool once more." | Two errors is the trigger for this skill. Retrying without diagnosis is how stale vaults persist for days. |

## Red flags

Stop and surface the limit, or route to another skill, when:

- **`sfi.health_check` itself fails to dispatch** (not just returns
  `degraded` — the call errors). The MCP server may not be running.
  Surface verbatim and point the user to `INSTALL.md`.
- **`sf org list --json` returns no orgs at all.** Recommend
  `sf org login web --alias <alias>` and stop.
- **The manifest's `sourceOrg` doesn't match any alias the CLI knows.**
  Alias was renamed or the user changed environments. Ask before
  recommending any recovery.
- **`vaultExists === false`.** Recommend `/sfi-init`, not refresh.
- **All three probes pass and the user still says it feels off.** Ask
  what they noticed specifically; route to whichever skill applies.
- **The user asks the skill to run `sfi refresh` directly.** Don't.
  This skill diagnoses; the user invokes the recovery slash command.

## Verification

Before sending a response, confirm:

- [ ] I called `sfi.health_check`, `sfi.get_manifest`, and
      `sf org list --json` — in that order, every time.
- [ ] I formatted the response as a five-line numbered checklist with
      `✓` / `✗` markers, followed by a recommendation line.
- [ ] I mapped the aggregate verdict to exactly one recommended action
      (`/sfi-refresh`, `/sfi-init`, `sf org login web`, or "nothing").
- [ ] I did not run `sfi refresh`, modify the vault, or invoke any
      recovery slash command myself. The user does that.
- [ ] If `sourceHashMatches === null`, I surfaced it as "freshness
      unknown" rather than as a failure.
- [ ] If everything checked out healthy, I asked the user what they
      noticed instead of declaring the issue resolved.
- [ ] I cited the manifest's `refreshedAt` as both raw timestamp and
      human-readable age so the user can sanity-check it themselves.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
