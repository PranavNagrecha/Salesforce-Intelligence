import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Anti-backslide gate over .github/workflows/ci.yml itself.
 *
 * Placement note: there is no root-level `test/` vitest project in this repo
 * (pnpm-workspace.yaml only lists `packages/*`, and the root package.json's
 * own `test` script is `pnpm -r test && pnpm test:integration`, neither of
 * which would ever discover a file at repo-root `test/`). This file lives
 * here anyway, at the path the task specified, and is wired into CI directly
 * as its own step in `.github/workflows/ci.yml` (search that file for this
 * file's basename) rather than through package.json, which is out of this
 * lane's file-ownership. Run it locally with:
 *   pnpm exec vitest run test/ci-workflow-invariants.test.ts
 * from the repo root.
 *
 * CI run 32974713874 on main was GREEN over a red log: windows-build-test
 * reported success while packages/mcp exited 0xC0000409 (a native abort) and
 * printed no test summary at all, because both of that job's unit-test steps
 * carried `continue-on-error: true`. A comment explaining that away ("slow
 * pass, not a crash") is not a guard — it cannot be executed, and it was
 * itself wrong. This test is the guard: it parses the actual workflow file
 * and fails if the job is silently re-disarmed, rather than describing what
 * the job is supposed to do.
 *
 * All three assertions are about `.github/workflows/ci.yml` ONLY — other
 * workflow files (e.g. publish.yml) are out of scope and do not affect the
 * counts below.
 */

const CI_YML_PATH = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));

const raw = readFileSync(CI_YML_PATH, 'utf8');
const lines = raw.split('\n');

// A step boundary: either "- name: ..." or an unnamed "- uses: ...".
const STEP_START_RE = /^\s*-\s+(name|uses):/;
const CONTINUE_ON_ERROR_RE = /^\s*continue-on-error:\s*true\s*$/;
const WIN_MARKER_RE = /WIN-\d+/;

/**
 * Committed baseline for the Windows hard (non-advisory) tier: the seven
 * packages that carry no DuckDB dependency and already pass 100% on
 * windows-latest per CI run 32974713874 (core 4, tooling-api 6, renderers 10,
 * parsers 9, patterns 3, vault 11, extractors 87 — all green). This is also
 * where all three Windows defects fixed in 0.3.2 lived.
 *
 * This list may only GROW (a superset check): adding a package that also
 * turns out to be Windows-safe is fine and expected over time. Removing one
 * — i.e. carving a currently-hard-gated package back out into "advisory" —
 * must fail this test. If that is ever genuinely necessary, it must be a
 * deliberate edit to this constant, not a silent workflow change.
 */
const HARD_TIER_BASELINE_PACKAGES = [
  'packages/core',
  'packages/tooling-api',
  'packages/renderers',
  'packages/parsers',
  'packages/patterns',
  'packages/vault',
  'packages/extractors',
];

/**
 * Committed baseline for how many `continue-on-error: true` lines this file
 * may contain. It may only DECREASE (as advisory Windows steps get promoted
 * to hard gates): lower this constant deliberately when that happens. It must
 * never silently increase — that would mean a new advisory escape hatch was
 * added, which is exactly the pattern that let three Windows defects ship
 * behind a job that reported green.
 */
const CONTINUE_ON_ERROR_BASELINE_COUNT = 2;

/** Index of the first `- name:` (or `- uses:`) step line at or after `from`. */
function nextStepStart(from: number): number {
  for (let i = from; i < lines.length; i += 1) {
    if (STEP_START_RE.test(lines[i]!)) return i;
  }
  return lines.length;
}

/** The full `run:` line text for the step whose name contains `nameSubstring`. */
function findStepRunLine(nameSubstring: string): { nameIdx: number; runLine: string } {
  const nameIdx = lines.findIndex((l) => STEP_START_RE.test(l) && l.includes(nameSubstring));
  if (nameIdx === -1) {
    throw new Error(
      `No step in ci.yml has a name containing "${nameSubstring}" — has the Windows hard tier step ` +
        'been renamed or removed?',
    );
  }
  const boundary = nextStepStart(nameIdx + 1);
  for (let i = nameIdx + 1; i < boundary; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('run:')) return { nameIdx, runLine: lines[i]! };
  }
  throw new Error(`Found step "${nameSubstring}" at ci.yml:${nameIdx + 1} but no run: line followed it.`);
}

describe('ci.yml — Windows anti-backslide gate', () => {
  it('the hard (non-advisory) Windows tier names at least the committed no-DuckDB package baseline', () => {
    const { runLine } = findStepRunLine('hard gate');
    for (const pkg of HARD_TIER_BASELINE_PACKAGES) {
      expect(runLine, `hard-gate run line is missing "${pkg}":\n  ${runLine}`).toContain(pkg);
    }
  });

  it('the hard-gate step itself carries no continue-on-error (it would not be a hard gate otherwise)', () => {
    const { nameIdx } = findStepRunLine('hard gate');
    const boundary = nextStepStart(nameIdx + 1);
    const hasContinueOnError = lines.slice(nameIdx + 1, boundary).some((l) => CONTINUE_ON_ERROR_RE.test(l));
    expect(hasContinueOnError, `the "hard gate" step (ci.yml:${nameIdx + 1}) carries continue-on-error: true`).toBe(
      false,
    );
  });

  it('the total count of "continue-on-error: true" is at or below the committed baseline (can only decrease)', () => {
    const count = lines.filter((l) => CONTINUE_ON_ERROR_RE.test(l)).length;
    expect(
      count,
      `found ${count} "continue-on-error: true" line(s) in ci.yml; committed baseline is ` +
        `${CONTINUE_ON_ERROR_BASELINE_COUNT}. If a new advisory step was added, that is a re-disarm — give it a ` +
        'named WIN-<n> blocker with a DoD instead (or make it a hard gate). If an advisory step was genuinely ' +
        'promoted to hard and the count went down, lower CONTINUE_ON_ERROR_BASELINE_COUNT to lock the ' +
        'improvement in.',
    ).toBeLessThanOrEqual(CONTINUE_ON_ERROR_BASELINE_COUNT);
  });

  it('every "continue-on-error: true" sits in a step whose comment names a WIN-<n> tracking marker', () => {
    const continueOnErrorIndexes = lines
      .map((line, idx) => (CONTINUE_ON_ERROR_RE.test(line) ? idx : -1))
      .filter((idx) => idx !== -1);

    // Not a hard requirement of the gate itself, but if this ever goes to
    // zero silently (rather than via a deliberate lowering of the baseline
    // above) something upstream already caught it — this just documents the
    // expectation that the Windows job currently has advisory steps at all.
    expect(continueOnErrorIndexes.length).toBeGreaterThan(0);

    for (const idx of continueOnErrorIndexes) {
      let stepStart = -1;
      for (let i = idx; i >= 0; i -= 1) {
        if (STEP_START_RE.test(lines[i]!)) {
          stepStart = i;
          break;
        }
      }
      expect(stepStart, `"continue-on-error: true" at ci.yml:${idx + 1} is not inside any step`).toBeGreaterThanOrEqual(
        0,
      );

      // Walk upward through the contiguous run of blank/comment lines
      // immediately preceding the step — that is its comment block. A real
      // (non-blank, non-comment) line marks the boundary with unrelated,
      // prior step content and stops the walk.
      let blockStart = stepStart;
      for (let i = stepStart - 1; i >= 0; i -= 1) {
        const trimmed = lines[i]!.trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
          blockStart = i;
        } else {
          break;
        }
      }

      const block = lines.slice(blockStart, idx + 1).join('\n');
      expect(
        WIN_MARKER_RE.test(block),
        `"continue-on-error: true" at ci.yml:${idx + 1} has no WIN-<n> tracking marker in its comment block ` +
          `(ci.yml:${blockStart + 1}-${idx + 1}). A comment explaining away a red result is not a guard — that is ` +
          'the exact bug this test exists to catch. Add "WIN-<n>  <one-line symptom>. DoD: <one-line pass ' +
          'condition>." to the comment above this step.',
      ).toBe(true);
    }
  });
});
