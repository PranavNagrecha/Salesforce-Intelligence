/// <reference types="vitest/globals" />

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { it } from 'vitest';

/**
 * Maximum number of ancestor directories to inspect before giving up the
 * walk-up search. Eight levels comfortably spans both supported layouts
 * (the build harness, where `tests/fixtures` sits four levels above a
 * package, and any deeper future nesting) without risking an unbounded
 * loop on filesystems where `dirname` never converges to a fixed point.
 */
const MAX_WALK_UP_LEVELS = 8;

/**
 * Walk up from the current working directory looking for the build harness
 * root — the first ancestor directory that contains a `tests/fixtures`
 * folder. Returns that absolute path, or `null` when no such ancestor exists
 * within {@link MAX_WALK_UP_LEVELS} levels (the published product copy, which
 * ships without the harness-side fixtures, hits this `null` case).
 *
 * The function never throws: a missing harness is an expected, recoverable
 * condition that callers handle by skipping fixture-bound suites.
 *
 * @example
 * const HARNESS_ROOT = findHarnessRoot();
 * if (HARNESS_ROOT !== null) {
 *   const fixture = resolve(HARNESS_ROOT, 'tests/fixtures/dx/...');
 * }
 */
export function findHarnessRoot(): string | null {
  let current = process.cwd();
  for (let level = 0; level <= MAX_WALK_UP_LEVELS; level += 1) {
    if (existsSync(resolve(current, 'tests', 'fixtures'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

const HARNESS_FIXTURES_AVAILABLE = findHarnessRoot() !== null;

if (!HARNESS_FIXTURES_AVAILABLE) {
  // eslint-disable-next-line no-console -- one-time operator note, test-only.
  console.info(
    'SfIntelligence: harness fixtures not found (this is the published product ' +
      'copy); harness-bound tests skipped. Run from the build harness for full coverage.',
  );
}

/**
 * `it`, but skipped when the harness fixtures are absent. Use this in place of
 * `it` for any test that reads a file under `tests/fixtures` or `tests/golden`;
 * fixture-free tests in the same file keep using the plain `it` so they still
 * run in the published product copy.
 *
 * @example
 * itHarness('produces the golden output', async () => {
 *   const fixture = resolve(findHarnessRoot()!, FIXTURE_PATH_REL);
 *   // ...read fixture, assert against golden
 * });
 */
export const itHarness: ReturnType<typeof it.skipIf> = it.skipIf(!HARNESS_FIXTURES_AVAILABLE);
