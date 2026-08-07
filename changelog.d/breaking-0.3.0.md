### Breaking
- **Default tool profile is `core` (19 directly invokable schemas including `sfi.live_consent`).** Unset / empty `SFI_TOOL_PROFILE` no longer means `full`. Non-core tools must be called via `sfi.run_analysis { name, args }` (or set `SFI_TOOL_PROFILE=full`).
- **`liveEnabled: true` is not a live-access path.** Standing consent (`sfi.live_consent`) or `SFI_LIVE_PLANE_ENABLED=1` is required; per-call `liveEnabled` is intent-only and ignored for access.
- **v1 consent records are dropped.** Existing on-disk grants without `grantId` / `expiresAt` stop working — re-grant with `sfi.live_consent { grant: true }`.
- **Grants expire** (`DEFAULT_GRANT_TTL_HOURS = 168` / 7 days) and bind OrgId + principal; re-pointing an alias to another org refuses the grant until re-grant.
- **Update check is opt-in.** Set `SFI_UPDATE_CHECK=1` or `SFI_NETWORK_MODE=updates-only`; the MCP default network mode is `off`.
- **Every success envelope stamps `contentPolicy`** (~280 bytes) marking org metadata as untrusted data for hosts.

### Changed
- **ProductManifest / `sfi.capabilities`** report `defaultProfile: 'core'`, `activeProfile`, and an `advertised` count that matches `tools/list` under the active profile (full roster remains under `profiles.full`).
- **SERVER_INSTRUCTIONS and capabilities routing guidance** teach the core profile + `run_analysis` gateway; they no longer tell hosts to call `sfi.interpret` / `sfi.live_consent` directly or to use `liveEnabled: true` as consent.
