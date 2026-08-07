### Changed

- **Tool catalog hygiene (AUDIT-F9).** Scrubbed internal milestone / wave
  language (`R6-*`, `AUDIT-*`, `v2.x R2a…`, `P5-*`, …) from MCP tool
  descriptions so `tools/list` and `list_analyses` one-liners read as product
  jobs. `list_analyses` now omits `hidden` retired aliases (same advertise
  contract as `tools/list`; still invokable via `run_analysis`). Structural
  consolidations (−4 hidden aliases) were already shipped; further handler
  merges deferred.
