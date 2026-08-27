import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // Hermetic unit tests stub `sf data query` but not `sf org display`.
    // Production gateLive re-verifies OrgId+principal against the CLI; tests
    // skip that re-bind unless a case explicitly unsets this env var.
    env: {
      SFI_LIVE_SKIP_IDENTITY_VERIFY: '1',
    },
    // The bounded-graph-query tests open real DuckDB connections; under the
    // parallel thread pool on constrained CI runners the default 5s ceiling can
    // be exceeded, and a vitest-killed DuckDB query aborts the worker (Napi
    // core dump → POSIX exit 134 / Windows exit 3221226505 = 0xC0000409 =
    // __fastfail — the same abort, two platforms' encodings) rather than
    // failing softly. Give the graph-backed tests headroom so a slow runner
    // is a slow pass, not a crash.
    //
    // Raised 20s → 45s in 0.3.2 when the Windows job was armed for the first
    // time. THAT DID NOT WORK: CI run 32974713874 (main, still true in 0.3.3)
    // shows packages/mcp exiting 0xC0000409 mid-run on windows-latest at
    // fieldLineageHandler, printing no test summary at all — unlike every
    // other package in the same job, which all print `Test Files N passed
    // (N)`. A longer clock does not change what happens once the query IS
    // killed; the timeout raise never addressed the crash, only made it
    // rarer to trigger.
    //
    // 0.3.3 tried `pool: 'forks'` here on the theory that a native abort
    // kills an isolated child process instead of a vitest worker thread that
    // shares the parent's failure mode. MEASURED on macOS — NOT Windows; this
    // cannot be verified from a non-Windows box, and does not prove the
    // Windows crash is fixed either way. Two runs against the same stable
    // test-suite state (10 failing tests in 1 file / 308 files total, both
    // runs): threads 88.16s vs forks 156.37s wall-clock — forks is ~77%
    // slower for zero observed local benefit. That is a real regression, not
    // run-to-run noise (this pair was matched on failure count precisely to
    // rule that out — see the git history of this file for the raw numbers,
    // including an earlier unmatched pair that was itself confounded by a
    // concurrent change to src/knowledge/). `pool` was left at 'threads'.
    // Tracked as WIN-1 in .github/workflows/ci.yml; do not re-attempt `forks`
    // without a way to measure it on an actual Windows runner.
    testTimeout: 45000,
    // Same root cause as packages/graph (GRAPH-QUERIES-BEFOREALL-FLAKE):
    // `testTimeout` was raised for the DuckDB-backed suites but `hookTimeout`
    // silently kept vitest's 10s default, so the `beforeAll` that OPENS the
    // graph had a third of the budget of the tests that query it. Under the
    // parallel pool that surfaced as an intermittent setup failure in a
    // different package each run — a false red, never a real one. Equal
    // budgets; a hook that truly hangs still fails.
    hookTimeout: 20000,
    passWithNoTests: true,
  },
});
