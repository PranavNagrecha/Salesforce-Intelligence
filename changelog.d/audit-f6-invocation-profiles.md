### Changed

- **Core-by-default + strict invocation (AUDIT-F6).** Default `SFI_TOOL_PROFILE`
  is `core` (19-tool spine, incl. `sfi.live_consent`). Direct `tools/call` outside the advertised set is
  denied under core — use `sfi.run_analysis` (target must be a registered tool).
  `sfi.describe_analysis` gains progressive `detail` (`summary` | `schema` |
  `full`; default `summary` under core). Set `SFI_TOOL_PROFILE=full` for the
  previous advertise-everything behavior.
