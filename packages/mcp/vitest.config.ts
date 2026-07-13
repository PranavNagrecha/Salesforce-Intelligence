import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // Shell package — no tests yet. Phase F's mcp-server-lifecycle and the
    // ten mcp-tool-* tasks add the real tests. Avoid vitest exiting
    // non-zero in the meantime.
    passWithNoTests: true,
  },
});
