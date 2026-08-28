import { defineConfig } from 'vitest/config';

/** One budget for both clocks — see packages/mcp/vitest.config.ts for why. */
const TIMEOUT_MS = 20_000;

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // The refresh / incremental-graph tests do full DuckDB graph rebuilds and
    // byte-compares; under the parallel thread pool on constrained CI runners
    // they can exceed the 5s default and time out (a slow runner, not a hang).
    testTimeout: TIMEOUT_MS,
    // SAME ASYMMETRY, LATENT HERE. `hookTimeout` was never set, so it kept
    // vitest's 10s default while tests got 20s — the shape that starved a
    // DuckDB-building `beforeAll` in packages/mcp and cost the Windows job its
    // entire run (see packages/mcp/vitest.config.ts). No failure is attributed
    // to it in this package; it is closed because the cost of the asymmetry is
    // paid by whoever adds the first heavy fixture, and they will not know why.
    hookTimeout: TIMEOUT_MS,
    // Scaffold has no tests yet; Phase G tasks (init/refresh/status/mcp) add
    // them. Without this flag vitest exits with code 1 when zero test files
    // match, breaking the test gate for an empty shell package.
    passWithNoTests: true,
  },
});
