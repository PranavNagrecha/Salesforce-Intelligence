module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    tsconfigRootDir: __dirname,
    // Type-aware linting (CR-15). projectService auto-discovers the nearest
    // per-package tsconfig for the ~668 in-project files so the type-aware
    // bug-catcher rules (no-floating-promises, no-misused-promises,
    // await-thenable, no-for-in-array) can actually fire.
    projectService: {
      // .ts files outside every package's tsconfig `include` (package-root
      // vitest configs, loose scripts, tests/integration/*) get a per-file
      // inferred default program. Use GLOBS, not explicit filenames, so no
      // path containing an org name (some real-org test filenames embed one)
      // lands in this SHIPPING config — release-guard.mjs / scan-org-leaks.mjs
      // scan shipping files for org tokens. (Some integration files are
      // gitignored-but-on-disk yet still walked by `eslint .`.)
      allowDefaultProject: [
        'packages/*/vitest.config.ts',
        'scripts/*.ts',
        'tests/integration/*.ts',
      ],
      // typescript-eslint v8 enforces a hard default-project cap of 8 files;
      // 20 entries in allowDefaultProject exceed it, so raise the cap.
      maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 25,
    },
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
  ],
  settings: {
    'import/resolver': {
      node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },
      typescript: { alwaysTryTypes: true },
    },
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx'],
    },
  },
  rules: {
    'import/no-unresolved': ['error', { ignore: ['\\.js$'] }],
    'import/no-default-export': 'error',
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc' },
      },
    ],
    '@typescript-eslint/naming-convention': [
      'error',
      { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
      { selector: 'function', format: ['camelCase'] },
      { selector: 'typeLike', format: ['PascalCase'] },
      { selector: 'enumMember', format: ['PascalCase'] },
    ],
    '@typescript-eslint/explicit-module-boundary-types': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    // CR-15: type-aware async/iteration bug-catchers. These make the
    // silent-async-failure class (dropped error / dropped lock release /
    // lost ordering) detectable. The high-noise no-unsafe-* and
    // require-await / no-unnecessary-type-assertion families are
    // deliberately left OFF (deferred to CR-15b) to keep the gate green.
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-for-in-array': 'error',
    'no-throw-literal': 'error',
  },
  // website/ is a self-contained Astro npm project with its own tooling/tsconfig
  // (Astro idioms like `export default` differ from the product's lint rules).
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', 'website/'],
};
