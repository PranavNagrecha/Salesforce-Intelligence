### Changed
- **The Windows CI job is a hard gate again.** It had been `if: github.event_name == 'workflow_dispatch'` — never running on push or PR — *and* excluded four tests plus three whole CLI test files. The gate was disarmed at precisely the files carrying the Windows defects this release fixes. It now runs the full unit suite on every push, identical to the macOS job.
- The platform-fragile tests are no longer hidden by CI-only `-t` / `--exclude` filters. Genuinely POSIX-only fixtures (a `#!/bin/sh` script, a `0600` file mode, a `COMSPEC`-stubbed win32 simulation) are `describe.skipIf(process.platform === 'win32')` in their own source, where a reader can see them; the rest now derive their expectations from `node:path` instead of hardcoding a POSIX rendering.
- New `pnpm check:portability` gate (wired into CI): fails the build if hand-rolled path-separator logic reappears in a package source tree. The four legitimate exceptions are allowlisted with their reasons.

### Fixed
- Two tests passed vacuously and now assert something real: `serve-http`'s username-redaction check seeded its vault in `tmpdir()`, which is outside `$HOME` on macOS/Linux, so there was never anything to redact; and the consent-file `0600` check used a bare `return` on Windows, which vitest reports as **passed** rather than skipped.
