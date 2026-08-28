import { defineConfig } from 'vitest/config';

/** One budget for both clocks — see packages/mcp/vitest.config.ts for why. */
const TIMEOUT_MS = 20_000;

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // Headroom for graph-backed tests under the parallel pool on slow CI
    // runners (a slow runner is a slow pass, not a 5s-timeout crash).
    testTimeout: TIMEOUT_MS,
    // SAME ASYMMETRY, LATENT HERE. `hookTimeout` was never set, so it kept
    // vitest's 10s default while tests got 20s — the shape that starved a
    // DuckDB-building `beforeAll` in packages/mcp and cost the Windows job its
    // entire run (see packages/mcp/vitest.config.ts). No failure is attributed
    // to it in this package; it is closed because the cost of the asymmetry is
    // paid by whoever adds the first heavy fixture, and they will not know why.
    hookTimeout: TIMEOUT_MS,
    // Shell package — no tests yet. Phase E's pattern-naming-convention task
    // adds the real tests. Avoid vitest exiting non-zero in the meantime.
    passWithNoTests: true,
  },
});
