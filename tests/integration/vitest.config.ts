import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the v0.1 end-to-end integration tests.
 *
 * The integration suite copies the committed edu-org fixture (2,193
 * components, ~45 MB) into a temporary directory, runs `runRefresh`
 * across the full pipeline (walk → extract → import → render →
 * patterns → manifest), opens the produced DuckDB graph, and dispatches
 * all 10 MCP tools against it. Real I/O dominates the wall-clock time,
 * so the per-test default (5s) is replaced with a generous `testTimeout`
 * that accommodates the full refresh on slower hardware. The `hookTimeout`
 * is bumped for the same reason — `beforeAll` does the heavy work.
 *
 * The suite is intentionally serial: two suites copying ~45 MB and
 * holding open the same graph store in parallel would interfere with
 * each other and inflate runtime. `fileParallelism` and `pool`
 * defaults discourage concurrency at the file level.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * One budget for both clocks. Written once because two matching literals agree
 * only until somebody edits one of them — which is exactly how packages/mcp
 * ended up at 45000 / 20000 under a comment claiming they were equal.
 */
const TIMEOUT_MS = 600_000;

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  // Pin `root` to this directory so vitest's test discovery does not
  // crawl upward and re-run the per-package suites (each of which has
  // its own fixture-path assumptions and would fail when invoked from
  // outside its own package root). Imports inside the test files use
  // deep relative paths into the packages tree to sidestep the
  // "test sits outside any workspace package" resolution issue.
  root: HERE,
  test: {
    // Only match test files directly inside this directory; the per-package
    // suites are run by `pnpm -r test` and should not be re-collected here.
    include: ['*.test.ts'],
    globals: true,
    // The full refresh against the 2,193-component edu-org fixture across
    // all 9 v0.1 metadata types now takes 2-10 minutes on developer
    // laptops (the batched-import commit cadence is the dominant cost).
    // 600s gives headroom for slower CI environments without masking a
    // real hang.
    testTimeout: TIMEOUT_MS,
    hookTimeout: TIMEOUT_MS,
    // Each integration test file holds open its own copy of the fixture
    // and its own DuckDB graph. Running them in parallel would multiply
    // peak memory and disk usage without speeding up wall time —
    // `beforeAll` already does the bulk of the work.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
