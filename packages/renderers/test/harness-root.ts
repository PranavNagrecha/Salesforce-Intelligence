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
 * Locate the build harness root — the directory holding the maintainer-only
 * `tests/fixtures` + `tests/golden` trees (real-org fixtures that never ship).
 *
 * CH-4: this used to be a silent walk-up for ANY ancestor `tests/fixtures`, so
 * 136 extractor assertions skipped on every machine but a frozen harness copy
 * (including CI) without anyone choosing that — and an unrelated ancestor
 * `tests/fixtures` would have switched them on against the wrong data. Now:
 *
 *   1. `SFI_HARNESS_ROOT=<dir>` names the harness explicitly (run the suites
 *      from any checkout). A set-but-wrong path THROWS — never a quiet skip.
 *   2. Otherwise walk up, but only accept an ancestor holding BOTH
 *      `tests/fixtures` and `tests/golden`.
 *   3. `SFI_REQUIRE_HARNESS=1` turns a missing harness into a failure (for
 *      maintainer gate runs that must not pass while asserting nothing).
 *
 * Kept byte-identical in packages/{extractors,parsers,renderers}/test —
 * enforced by packages/extractors/test/harness-root-parity.test.ts.
 */
export function findHarnessRoot(): string | null {
  const explicit = process.env['SFI_HARNESS_ROOT'];
  if (explicit !== undefined && explicit.trim() !== '') {
    const root = resolve(explicit.trim());
    if (!existsSync(resolve(root, 'tests', 'fixtures'))) {
      throw new Error(`SFI_HARNESS_ROOT=${root} has no tests/fixtures — fix the path or unset it.`);
    }
    return root;
  }
  let current = process.cwd();
  for (let level = 0; level <= MAX_WALK_UP_LEVELS; level += 1) {
    if (existsSync(resolve(current, 'tests', 'fixtures')) && existsSync(resolve(current, 'tests', 'golden'))) {
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
  const message =
    'SfIntelligence: harness fixtures NOT found — every itHarness test in this file is SKIPPED and asserts nothing. ' +
    'Set SFI_HARNESS_ROOT=<path to the build harness> to run them, or SFI_REQUIRE_HARNESS=1 to make a missing harness fail.';
  if (process.env['SFI_REQUIRE_HARNESS'] === '1') {
    throw new Error(message);
  }
  // eslint-disable-next-line no-console -- one-time operator note, test-only.
  console.warn(message);
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
