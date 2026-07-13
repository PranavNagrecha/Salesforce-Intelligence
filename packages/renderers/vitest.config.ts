import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // Scaffold has no tests yet; Phase C tasks add them. Without this flag
    // vitest exits with code 1 when zero test files match, breaking the
    // test gate for an empty shell package.
    passWithNoTests: true,
  },
});
