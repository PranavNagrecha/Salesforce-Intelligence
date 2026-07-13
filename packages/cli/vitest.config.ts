import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // The refresh / incremental-graph tests do full DuckDB graph rebuilds and
    // byte-compares; under the parallel thread pool on constrained CI runners
    // they can exceed the 5s default and time out (a slow runner, not a hang).
    testTimeout: 20000,
    // Scaffold has no tests yet; Phase G tasks (init/refresh/status/mcp) add
    // them. Without this flag vitest exits with code 1 when zero test files
    // match, breaking the test gate for an empty shell package.
    passWithNoTests: true,
  },
});
