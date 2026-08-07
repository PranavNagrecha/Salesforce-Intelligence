### Security

- **Explicit network policy (AUDIT-F2).** Outbound egress is gated by
  `SFI_NETWORK_MODE` (`off` \| `updates-only` \| `salesforce-read`), default
  **`off`**. npm update-check is now **opt-in** (`SFI_UPDATE_CHECK=1` or
  `updates-only` mode) — `sfi mcp` no longer phones the registry by default.
  `sfi refresh` and authorized live reads temporarily elevate to
  `salesforce-read`. Runtime model download is always denied. One adapter in
  `@sf-intelligence/core` (`assertNetworkAllowed` / `withNetworkMode`) is the
  choke point for update-check, Tooling HTTP, and live CLI/REST.
