# Maintainer and CI variables

Environment variables read only by the eval, test and release scripts. None
of them is read in a normal session; the end-user variables are in
[`configuration.md`](../configuration.md).

| Variable | Used by | Purpose |
| --- | --- | --- |
| `EVAL_STRICT=1` | `pnpm eval`, `pnpm eval:analytical` | Fail eval on any regression |
| `SF_INTELLIGENCE_REGISTRY_PATH` | eval scripts, `pnpm fleet` | Point eval at a vault registry |
| `SF_INTELLIGENCE_VAULT_ROOT` | `pnpm sast` | Override the vault root for the SAST gate |
| `SCALE_BUDGET_MS` | `pnpm eval:scale` | Resolve benchmark time budget (default 2000) |
| `SCALE_IMPORT_BUDGET_MS` | scale-import test | Import time budget (default 90000) |
| `SCALE_REFRESH_FIELD_COUNT` | scale-refresh test | Synthetic field count (default 1000) |
| `SCALE_REFRESH_BUDGET_MS` | scale-refresh test | Full refresh time budget (default 600000) |
| `EVAL_REPORT_PATH` | `pnpm eval:analytical` | Write the JSON scoreboard to a path |
| `SAST_MAX_FINDINGS` | `pnpm sast` | Maximum findings before the gate fails |
| `SAST_FAIL_ON` | `pnpm sast` | Severities that fail the gate (default `critical,high`) |
| `NL_ROUTING_ONLY=1` | routing eval | Skip live calls in the NL harness |
| `NL_VAULTS` / `STRESS_VAULTS` | stress / NL harness | Comma-separated `name=path` vault list |
| `STRESS_COMPONENTS` | stress test | Sample size (default 250) |

Graph import batch size is a constant (`IMPORT_BATCH_SIZE=500` in
`packages/graph/src/import.ts`), not an env var.
