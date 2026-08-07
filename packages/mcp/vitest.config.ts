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
    // core dump → exit 134) rather than failing softly. Give the graph-backed
    // tests headroom so a slow runner is a slow pass, not a crash.
    testTimeout: 20000,
    passWithNoTests: true,
  },
});
