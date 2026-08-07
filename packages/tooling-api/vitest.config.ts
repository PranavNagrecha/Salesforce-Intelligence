import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // Auth tests stub `sf org display`; allow the spawn under policy.
    env: {
      SFI_NETWORK_MODE: 'salesforce-read',
    },
  },
});
