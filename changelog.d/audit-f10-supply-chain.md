### Added

- **Supply-chain hardening (AUDIT-F10).** Consumer guide
  `docs/guides/supply-chain.md` (pinned install, provenance verify, SBOM);
  `scripts/check-pack-allowlist.mjs` / `pnpm pack:check` enforces
  `packages/cli` `files` as the published tarball allowlist (wired into
  `prepublishOnly`); tag publish attaches a CycloneDX SBOM to the GitHub
  Release.
