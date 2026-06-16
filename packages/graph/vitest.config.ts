import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    // Large batched import tests can exceed the default 5s on busy CI hosts.
    testTimeout: 60_000,
    // Shell package — no tests yet. Phase D's graph-* tasks add the real
    // tests. Avoid vitest exiting non-zero in the meantime.
    passWithNoTests: true,
  },
});
