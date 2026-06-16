import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INTEGRATION_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Locate `tests/fixtures` for integration suites. Supports:
 * - Harness layout: `sf-intelligence-builder/output/sf-intelligence/tests/integration`
 * - Product repo with `sf-intelligence/tests/fixtures`
 * - Monorepo sibling: `sf-intelligence` next to `sf-intelligence-builder`
 */
export function resolveHarnessFixturesRoot(): string {
  const candidates = [
    resolve(INTEGRATION_DIR, '..', '..', '..', '..', 'tests', 'fixtures'),
    resolve(INTEGRATION_DIR, '..', '..', 'tests', 'fixtures'),
    resolve(
      INTEGRATION_DIR,
      '..',
      '..',
      '..',
      'sf-intelligence-builder',
      'tests',
      'fixtures',
    ),
  ];
  for (const root of candidates) {
    if (existsSync(resolve(root, 'edu-org', 'source'))) {
      return root;
    }
  }
  throw new Error(
    `edu-org fixture not found. Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

export const HARNESS_FIXTURES_ROOT = resolveHarnessFixturesRoot();
export const FIXTURE_SOURCE = resolve(HARNESS_FIXTURES_ROOT, 'edu-org', 'source');
export const FIXTURE_ROOT = HARNESS_FIXTURES_ROOT;
