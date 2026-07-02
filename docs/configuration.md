# Configuration reference

Environment variables and on-disk paths for SfIntelligence. Most installs
need **none** of these — defaults are safe for offline vault use.

For install and first run, start with [`guides/installation.md`](./guides/installation.md).

---

## Live read-only plane

The live plane is **off by default**. Vault tools never call Salesforce.

### Enablement (any one of)

| Method | Scope | How |
| --- | --- | --- |
| Standing consent | Per org, persists | `sfi.live_consent { grant: true, orgAlias: "my-org" }` |
| Environment | All live tools in the MCP process | `SFI_LIVE_PLANE_ENABLED=1` or `true` |
| Per-call flag | Single tool invocation | Pass `liveEnabled: true` in tool args |

Revoke standing consent: `sfi.live_consent { grant: false }`.

### Consent store

| Variable / path | Default | Purpose |
| --- | --- | --- |
| `SFI_CONSENT_PATH` | *(unset)* | Override consent file path (tests) |
| Default file | `~/.sf-intelligence/live-consent.json` | Persisted per-org consent |

Consent is vault-independent so it works before `/sfi-init`.

### Live tools (curated roster)

No generic SOQL tool exists. When enabled, these tools run read-only Salesforce
CLI queries and label answers `provenance: live_org`:

| Tool | What it does |
| --- | --- |
| `sfi.live_count` | `SELECT COUNT()` for one object |
| `sfi.live_sample` | Sample rows (max 200) |
| `sfi.live_field_population` | Null vs populated ratio for one field |
| `sfi.live_group_count` | Value distribution (GROUP BY one field) |
| `sfi.live_stale_records` | Records not touched in N days |
| `sfi.live_recent_activity` | Recently created or modified records |
| `sfi.live_aggregate` | MIN/MAX/AVG/SUM on one numeric field |
| `sfi.live_duplicate_check` | Duplicate values on one field |
| `sfi.live_owner_breakdown` | Record counts by owner (User/Queue names) |
| `sfi.live_storage_by_object` | Top N objects by record count |
| `sfi.live_describe` | Live object describe |
| `sfi.live_org_limits` | Governor limit snapshot |
| `sfi.live_inactive_users` | Users inactive for N days |
| `sfi.live_drift_check` | Compare vault claims vs live org |
| `sfi.live_report_usage` | Stale/unused reports (LastRunDate) |
| `sfi.live_folder_access` | Folder access types |
| `sfi.live_email_template_usage` | Email template usage / migration candidates |
| `sfi.live_license_usage` | License allocation vs. actual usage (paid licenses provisioned but unused) |
| `sfi.live_org_health` | Failed jobs, paused flows, limits at risk |
| `sfi.live_stale_check` | Is the org AHEAD of the vault? (Tooling-API drift count) |
| `sfi.live_picklist_usage` | Which picklist values records actually use (GROUP BY vs the defined value set) |
| `sfi.live_budget` | Session live-query budget + cache state (+ org API headroom when enabled) |
| `sfi.live_consent` | Grant/revoke standing live-plane consent (not a query) |

### Hybrid answers (vault + live)

Some tools **fuse** the offline vault (structure — what depends on what) with a
live read-only query (magnitude — how many records), and stamp
`provenance: 'hybrid'` carrying **both** planes' freshness. A hybrid answer never
lets one plane's freshness imply the other's: when the org is ahead of the vault
it **leads with a staleness warning** (and a drift count) instead of narrating a
fresh live count against stale structure. Live data **never** backfills stale
vault claims.

| Tool | Hybrid value |
| --- | --- |
| `sfi.blast_radius_live` | The static impact graph + a live affected-record count per record-bearing dependency ("847 records hold a non-null value here") |
| `sfi.what_if_make_field_required` | Pass `liveEnabled: true` to add the field's live production **null-rate** |
| `sfi.field_change_advisor` | Pass `liveEnabled: true` to cite the live record population alongside the vault verdict |
| `sfi.live_picklist_usage` | Defined value set (vault) × actual usage (live) |

Without consent these tools still answer from the vault, with a caveat — the
static answer is never blocked on the live plane.

#### Live-plane cost controls

Many-query hybrid answers (e.g. blast radius) are kept cheap and bounded by a
session cache + budget:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SFI_LIVE_QUERY_BUDGET` | `50` | Max live org queries per server session; the plane fails **closed** with an actionable message when spent. A cache hit costs nothing. Check remaining budget (and org API headroom) with `sfi.live_budget`. |
| `SFI_LIVE_CACHE_TTL_MS` | `90000` | TTL for the in-process live-result cache. A repeated identical live query inside the session is served from cache, stamped `cached: true` with the original read time (never passed off as fresh). Memory-only — never persisted. |
| `SFI_BLAST_RADIUS_MAX_LIVE` | `25` | Per-call cap on live COUNT queries for `sfi.blast_radius_live`; beyond it the answer is marked `partial`. |

See [`guides/asking-questions.md`](./guides/asking-questions.md) § live data.

---

## Update checking

On MCP-server startup (`sfi mcp`) the plugin can check npm for a newer
published `sf-intelligence` and, when one exists, print a one-line
"update available" nudge to **stderr** (stdout is reserved for MCP JSON-RPC).
The check is **off in CI**, **opt-out** everywhere, and never blocks the
server.

### Offline vault-version nudge

Separately — and with **no network at all** — `sfi.health_check` compares the
plugin version that BUILT the current vault (`manifest.version`) against the
running plugin. When the running plugin is newer, the freshness `nudge` advises
`/sfi-refresh`, so a vault built by an older version (which may lack newer
extractors — e.g. the CustomPermission / permission-set record-type work in
0.1.19) is rebuilt rather than silently under-reporting. It is a pure local
version comparison: no network, no org data.

### Opt out

| Method | How |
| --- | --- |
| Explicit opt-out | Set `SFI_NO_UPDATE_CHECK=1` |
| CI auto-off | The check disables itself when any common CI marker is set (`CI`, `CONTINUOUS_INTEGRATION`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `TRAVIS`, `BUILDKITE`, `DRONE`, `JENKINS_URL`, `TF_BUILD`) |

### Network behavior (transparency)

The update check:

- Sends a single GET to `https://registry.npmjs.org/sf-intelligence` with a
  ~3-second timeout — **no** telemetry, user identifiers, or org data.
- **Fails silently** — a network error, timeout, or bad response never
  interrupts the server; it simply prints no nudge.
- **Caches locally** for ~24h in `~/.sf-intelligence/update-check.json`, so a
  fresh cache answers with zero network I/O.
- **Never** reads or writes your vault or org metadata.

It is fail-closed: if the check can't confirm a newer version, nothing is
printed.

### Cache location

| Variable / path | Default | Purpose |
| --- | --- | --- |
| `SFI_UPDATE_CACHE_PATH` | *(unset)* | Override the cache file path (tests) |
| Default file | `~/.sf-intelligence/update-check.json` | Cached npm version check (~24h TTL) |

---

## Response size budget

MCP clients reject a tool result above their token limit outright (~55 KB
observed), so every response flows through a global escalating budget: lists
are tail-truncated first (`responseBudget.truncated`/`droppedCount`, plus
`nextOffset` on offset-paginated calls), long strings are trimmed to a head +
marker, and only an answer that still cannot fit returns a structured
`oversize` error naming that tool's own narrowing knobs. Every response carries
`estimatedPayloadBytes`; under-budget responses are untouched apart from that
field.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SFI_MAX_RESPONSE_BYTES` | `40000` | Byte budget for a serialized tool response (floor `2000`). Raise it only if your MCP client tolerates larger results; per-tool budgets (e.g. the 28 KB graph slices) stay primary. |

## Tool profile (advertised roster)

163+ tool schemas cost tens of thousands of context tokens in MCP clients
that do not defer tool definitions. `SFI_TOOL_PROFILE=core` advertises only
the 18-schema core roster (orientation, resolve/route, the universal graph
reads, and the catalog gateway `list_analyses` / `describe_analysis` /
`run_analysis` through which EVERY other analysis stays reachable with
byte-identical output). The profile is fixed at server boot — clients fetch
`tools/list` once — and dispatch is never narrowed: a non-advertised tool
called directly still works.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SFI_TOOL_PROFILE` | `full` | `core` advertises the 18-schema roster; anything else (or unset) advertises everything. Zero behavior change under the default. |

## Router mode

`sfi.route_question` defaults to **hybrid** mode: the meaning-ranked
`toolCandidates` are the primary output and the deterministic `route` is a
non-authoritative hint — the host LLM decides. See
[`routing.md`](./routing.md) for the full host contract (advisory routes,
refusal gates, clarifications, the `context.previous` param).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SFI_ROUTER_MODE` | *(unset — hybrid)* | `offline` makes the deterministic route authoritative and omits candidates — for CI and no-LLM hosts. Refusal gates and clarifications behave identically in both modes. |

The funnel-advisory score floor (`FUNNEL_PRIMARY_MIN_SCORE = 0.30` in
`packages/mcp/src/tools/route-question.ts`) and the synonym-expansion weight
(`EXPANSION_WEIGHT = 0.5` in `packages/mcp/src/semantic-funnel.ts`) are
**source constants, not env vars** — they are calibrated against the routing
evaluation and changing them re-opens the honesty gates.

## Report / Dashboard pull (default: top 500 by usage)

Folder-based Reports/Dashboards are invisible to the wildcard retrieve, so
every full refresh pulls the top `SFI_REPORTS_CAP` (default `500`) ranked by
actual usage (Report `LastRunDate`, Dashboard `LastViewedDate`, fallback
`LastModifiedDate`) via read-only SOQL, folding their field references onto
fields (no report nodes). When the org holds more than the cap, the
Report/Dashboard coverage rows read `pending` — the tail was not checked, so
absence claims stay qualified. `--with-reports` = uncapped full pull;
`--no-reports` = skip.

The refresh summary reports three numbers per type — org total, manifest
members **requested**, and files that actually **landed** on disk. The
Metadata API can silently drop requested members (deleted between the
ranking query and the pull, folder mismatches); a dropped member is named
in the refresh output and counts as *not checked*, keeping the coverage
row `pending` rather than implying it was scanned.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SFI_REPORTS_CAP` | `500` | Usage-ranked pull cap; `0` disables the default pull. |

## Data-shape capture (`refresh --with-data-shape`)

Opt-in record-DATA observations (approximate per-object record counts +
recent-sample field fill rates) captured into the graph's `facts` table at
refresh time. Requires live consent in addition to the flag; read-only;
skips honestly without consent. Record counts are storage-level (archived
activities included for Task/Event). Consumers disclose facts as
`data_snapshot` provenance with the capture stamp — never `live_org`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SFI_DATA_SHAPE_BUDGET` | `60` | Max org API calls per capture (floor `5`). Hitting it yields a disclosed partial capture. |

## Org-drift watcher (`sfi watch`)

A detached daemon running one read-only `stale-sweep` tick per interval
(default 15m, floor 5m, ±10% jitter; single instance per vault via pidfile
with stale-file recovery; `status`/`stop` subcommands; doctor reports it).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SFI_WATCH_DAILY_TICKS` | `96` | The daemon's own daily tick budget — a misconfigured tight interval degrades to idling, never API hammering. |

Optional flags: `--auto-refresh incremental` (drift triggers an incremental
refresh, at most once an hour) and `--drain-demand-queue` (drain queued
phantom hits, at most once an hour — see below).

## HTTP serving (`sfi serve --http`)

Read-only MCP over streamable HTTP: bearer token required (constant-time
compare; `--generate-token` prints one once), binds `127.0.0.1` by default
(non-loopback `--host` warns and requires a token), and the live plane is
HARD-DISABLED over HTTP regardless of the host's consent or env — a remote
caller can never reach your org or spend its API budget. Each request gets
a fresh read-only context, so a refresh underneath is visible immediately.
stdio serving remains `sfi mcp`.

`sfi mcp` serves the `org-kb` vault in its launch directory and prints the
served vault path and its bound `targetOrg` to stderr at startup, so a
wrong-org session is impossible to overlook. Pass `sfi mcp --vault <path>` to
bind a specific vault regardless of the launch directory — the way a
multi-org host points each project at the right org.

## Vault git history (`sfi vault git enable`)

Optional: turn org-kb into its own git repo (generated `.gitignore` keeps
graph db / snapshots / caches / transient meta out). After enabling, every
refresh whose source tree changed auto-commits `source/ + components/ +
manifest + history` with a per-type delta message; unchanged refreshes
commit nothing; a git failure never fails a refresh; non-enabled vaults see
zero change. `sfi vault git status` reports the last commit. The source-hash
walk ignores `.git`, so enabling never perturbs refresh integrity.
Consumers: `sfi.component_history` (timeline + capped diff) and
`sfi.component_as_of` (properties at a ref via the type's extractor);
non-git vaults answer `available: false` with the enable hint.

## Annotations overlay (`meta/annotations.jsonl`)

Curated meaning the org cannot carry — `owner`, `status` (e.g. deprecated),
`glossary` synonyms, `domain`, `note` — event-sourced and surviving every
refresh. Humans write via `sfi annotate <id> --key <k> --value <v>` (and
`confirm` / `list` / `orphans`); AI proposes via `sfi.propose_annotation`
(always `source: 'ai', confirmed: false`, session-capped). Consumers
(`sfi.annotations`, `get_component`, `field_360`, `explain_*`) serve it with
provenance `annotation` — never `offline_snapshot` — and `synthesize_answer`
flags lifecycle claims with no backing annotation
(`ungroundedAnnotationClaims`). Orphans (annotated ids whose component left
the graph) surface in the refresh pulse and `sfi annotate orphans`.

## Demand queue (`meta/demand-queue.jsonl`)

When `sfi.get_component` is asked for an AUTOMATION-CRITICAL phantom (a
component real automation references but the last refresh never retrieved),
the hit is appended to `meta/demand-queue.jsonl` — an append-only event log
folded at read time (N hits on one id = one queued entry; concurrent writers
safe; corrupt lines skipped). Drain it with `sfi refresh
--drain-demand-queue`: queued ids go through the demand-retrieve gate (only
automation-critical CustomObjects are pulled; grant-only / managed /
standard / blindspot ids are refused with the reason) and every processed id
is marked with its outcome (`retrieved` / `already-present` / `refused`). A
new hit after a drain re-queues the id; draining twice is a no-op. The watch
daemon drains automatically with `--drain-demand-queue`.

---

## Governance and observability

| Variable | Default | Purpose |
| --- | --- | --- |
| `SF_INTELLIGENCE_AUDIT_LOG` | *(unset — no logging)* | Append-only JSONL path. Logs tool name, argument **keys only** (never values), vault hash, timestamp. Best-effort; never breaks tool calls. |
| `SFI_METRICS_LOG` | *(unset — no metrics)* | Append-only JSONL path for opt-in per-call observability. One line per `tools/call` with tool name, `ok`/error, `durationMs`, serialized `payloadBytes`, and timestamp — never argument values or org content. Best-effort; never breaks tool calls. Zero overhead when unset (one env lookup, then silence). |

Example:

```sh
export SF_INTELLIGENCE_AUDIT_LOG="$HOME/.sf-intelligence/audit.jsonl"
```

---

## Multi-vault / fleet

Cross-vault tools (`sfi.fleet_find`, `sfi.compare_vaults`,
`sfi.fleet_drift_ranking`, etc.) need a registry of vault roots.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SF_INTELLIGENCE_REGISTRY_PATH` | Walk up from vault for `registry.json`, else `~/sf-intelligence-vaults` | Path to `registry.json` **or** directory containing it |

Register vaults with `sfi register-vault` (CLI) or edit `registry.json` manually.

### The registry

A `registry.json` maps a short alias to each vault's absolute root directory.
Its LOCATION resolves in this order:

1. `SF_INTELLIGENCE_REGISTRY_PATH` pointing at an existing **directory** → the
   `registry.json` inside it.
2. `SF_INTELLIGENCE_REGISTRY_PATH` pointing at any other value → that **exact
   path**, verbatim (the file's name need not be `registry.json`).
3. Unset → walk up from the current vault for a `registry.json`; if none is
   found, the co-resident default `~/sf-intelligence-vaults/registry.json`.

Register vaults (the file is created on first use), then list them:

```sh
sfi register-vault acme-prod    /path/to/acme-prod/org-kb
sfi register-vault acme-sandbox /path/to/acme-sandbox/org-kb
sfi list-vaults
```

The on-disk shape — you can also edit it by hand (keys are sorted on save for
stable diffs):

```json
{
  "version": "1.0",
  "registeredAt": "2026-01-01T00:00:00.000Z",
  "vaults": {
    "acme-prod":    { "path": "/path/to/acme-prod/org-kb",    "registeredAt": "2026-01-01T00:00:00.000Z" },
    "acme-sandbox": { "path": "/path/to/acme-sandbox/org-kb", "registeredAt": "2026-01-01T00:00:00.000Z" }
  }
}
```

Vault paths must be absolute. Per-vault freshness (refresh time, component
counts) is read from each vault's own `meta/manifest.json`, never duplicated
here — so a vault refreshed independently never goes stale in the registry.

### Fleet drift ranking (which org to refresh first)

`sfi.fleet_drift_ranking` runs the `sfi.live_stale_check` staleness probe across
*every* registered vault and ranks them by how far each is behind its live org,
so a team running many orgs knows which vault to `/sfi-refresh` first. It is a
LIVE sweep, so two safeties apply per the live-plane rules above:

- **Consent is per org.** Each vault's `sourceOrg` is gated independently
  (`sfi.live_consent`, `SFI_LIVE_PLANE_ENABLED`, or `liveEnabled: true`). A vault
  whose org isn't consented is an honest `no-consent` *skip* — never a silent
  live call.
- **The session budget bounds the sweep.** Every per-org staleness query
  decrements the same `SFI_LIVE_QUERY_BUDGET` (default 50) the hybrid plane uses;
  N orgs × 6 checks can exhaust it, so a vault the budget can't cover degrades to
  a `budget-exhausted` skip. Raise `SFI_LIVE_QUERY_BUDGET`, pass a `vaults`
  subset, or start a new session to reset.

### Concurrent read-only serving (the vault lock)

The MCP server opens the vault **read-only**, which takes a *shared* DuckDB
lock. Several read-only consumers can therefore serve the SAME vault at once —
for example an IDE's `sfi mcp` server, a CI / eval harness, and a fleet
dashboard — with no lock conflict between them. You no longer need to stop one
server before starting another, or before an eval run, as long as every opener
is read-only.

A `sfi refresh` (or `/sfi-refresh`) needs a writer, and DuckDB allows only
one writer with no other handles. When a serving MCP server holds the vault,
the refresh handles it AUTOMATICALLY: it rebuilds into a side file and
atomically renames it over the target, then bumps `meta/refresh-epoch` — the
open server picks up the NEW vault on its next call (no restart, no pkill).
Other writers (e.g. a concurrent refresh) still fail fast with an actionable
lock error naming the holder.

The rule is **many readers, one writer**: read traffic (every `sfi.*` query
tool, fleet comparisons, the eval harness) is concurrency-safe; only a refresh
serializes, and it tells you exactly who holds the lock when it cannot proceed.

---

## Question gap log (product telemetry, local only)

When routing cannot answer a question, `sfi.route_question` can append a gap
record locally — never sent to the network. This is **opt-in and off by
default** (privacy-first, CR-16): the question text is written only when the
caller passes `logGap: true`. With `logGap` omitted or `false`, nothing is
written to disk and the response reports `gapLogged: false`.

| Variable / path | Default | Purpose |
| --- | --- | --- |
| `SFI_GAP_LOG_PATH` | *(unset)* | Override gap log path (tests) |
| Default file | `~/.sf-intelligence/question-gaps.jsonl` | Local gap log for maintainer/product review |

---

## Maintainer / CI only

These variables are used in development, eval, and release gates — not in
normal Claude Code sessions.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `EVAL_STRICT=1` | `pnpm eval`, `pnpm eval:analytical` | Fail eval on any regression |
| `SF_INTELLIGENCE_REGISTRY_PATH` | eval scripts, `pnpm fleet` | Point eval at CI vault registry |
| `SF_INTELLIGENCE_VAULT_ROOT` | `pnpm sast` | Override vault root for SAST gate |
| `SCALE_BUDGET_MS` | `pnpm eval:scale` | Resolve benchmark time budget (default 2000) |
| `SCALE_IMPORT_BUDGET_MS` | scale-import test | Import time budget (default 90000) |
| `SCALE_REFRESH_FIELD_COUNT` | scale-refresh test | Synthetic field count (default 1000) |
| `SCALE_REFRESH_BUDGET_MS` | scale-refresh test | Full refresh time budget (default 600000) |
| `EVAL_REPORT_PATH` | `pnpm eval:analytical` | Write JSON scoreboard to path |
| `SAST_MAX_FINDINGS` | `pnpm sast` | Max findings before gate fails |
| `SAST_FAIL_ON` | `pnpm sast` | Severities that fail the gate (default `critical,high`) |
| `NL_ROUTING_ONLY=1` | routing eval | Skip live calls in NL harness |
| `NL_VAULTS` / `STRESS_VAULTS` | stress / NL harness | Comma-separated `name=path` vault list |
| `STRESS_COMPONENTS` | stress test | Sample size (default 250) |
| `SFI_WRITE_SMOKE_REPORT=1` | integration deep-smoke | Write smoke report markdown |

Graph import batch size is a **constant** (`IMPORT_BATCH_SIZE=500` in
`packages/graph/src/import.ts`), not an env var.

---

## MCP server registration

Register the server from npm with your MCP client. With Claude Code:

```sh
claude mcp add --transport stdio --scope project sf-intelligence -- npx -y sf-intelligence mcp
```

or add it to the client's MCP config directly:

```json
{
  "mcpServers": {
    "sf-intelligence": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sf-intelligence", "mcp"]
    }
  }
}
```

The MCP server resolves the vault as `org-kb/` relative to the **current
working directory** (your Salesforce DX repo), not the plugin install path.

Local development from this monorepo can use a project-scoped `.mcp.json`
pointing at `node packages/cli/bin/sfi.js mcp`.

---

## Related docs

- [`architecture.md`](./architecture.md) — data flow and trust boundaries
- [`SECURITY.md`](../SECURITY.md) — vulnerability reporting
