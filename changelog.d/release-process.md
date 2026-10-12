### Added
- `RELEASING.md`: the release cadence (a minor on the first Tuesday of each month, with batched patches for user-facing or security bugs) and the exact release order, with the known traps.
- `pnpm release:check` (`scripts/release-check.mjs`): runs every step of CI's `unit-test` and `build-test` jobs locally, read from `.github/workflows/ci.yml` so it cannot drift. It fails closed when the org-leak blocklist is missing.
- `.github/workflows/release-reminder.yml`: opens a "Release vX.Y.0 due" issue on the first Tuesday of each month, with the checklist and the commits since the last tag.
