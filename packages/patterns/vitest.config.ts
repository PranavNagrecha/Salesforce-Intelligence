import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // Shell package — no tests yet. Phase E's pattern-naming-convention task
    // adds the real tests. Avoid vitest exiting non-zero in the meantime.
    passWithNoTests: true,
  },
});
