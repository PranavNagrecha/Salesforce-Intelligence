import { existsSync, readFileSync } from 'node:fs';
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
const PUBLISH_YML_PATH = fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url));

const raw = readFileSync(CI_YML_PATH, 'utf8');
const lines = raw.split('\n');
const publishLines = readFileSync(PUBLISH_YML_PATH, 'utf8').split('\n');

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
function nextStepStart(ls: string[], from: number): number {
  for (let i = from; i < ls.length; i += 1) {
    if (STEP_START_RE.test(ls[i]!)) return i;
  }
  return ls.length;
}

/** Index of the step-start line at or before `from` (-1 if there is none). */
function enclosingStepStart(ls: string[], from: number): number {
  for (let i = from; i >= 0; i -= 1) {
    if (STEP_START_RE.test(ls[i]!)) return i;
  }
  return -1;
}

/**
 * The whole `- name: …` block for the step whose name line contains
 * `nameSubstring`, from its name line up to (not including) the next step.
 * Throws with the workflow's own name if the step was renamed or deleted —
 * a silently-missing step must break this test, not skip an assertion.
 */
function stepBlock(ls: string[], file: string, nameSubstring: string): { start: number; end: number; text: string } {
  const start = ls.findIndex((l) => STEP_START_RE.test(l) && l.includes(nameSubstring));
  if (start === -1) {
    throw new Error(
      `No step in ${file} has a name containing "${nameSubstring}" — it was renamed or removed. ` +
        'Every assertion that depended on it just stopped being checked, which is the backslide ' +
        'this file exists to catch: update the substring here deliberately, or restore the step.',
    );
  }
  const end = nextStepStart(ls, start + 1);
  return { start, end, text: ls.slice(start, end).join('\n') };
}

/** The full `run:` line text for the step whose name contains `nameSubstring`. */
function findStepRunLine(ls: string[], nameSubstring: string): { nameIdx: number; runLine: string } {
  const nameIdx = ls.findIndex((l) => STEP_START_RE.test(l) && l.includes(nameSubstring));
  if (nameIdx === -1) {
    throw new Error(
      `No step in ci.yml has a name containing "${nameSubstring}" — has the Windows hard tier step ` +
        'been renamed or removed?',
    );
  }
  const boundary = nextStepStart(ls, nameIdx + 1);
  for (let i = nameIdx + 1; i < boundary; i += 1) {
    const trimmed = ls[i]!.trim();
    if (trimmed.startsWith('run:')) return { nameIdx, runLine: ls[i]! };
  }
  throw new Error(`Found step "${nameSubstring}" at ci.yml:${nameIdx + 1} but no run: line followed it.`);
}

/** The `id:` declared by the step starting at `start`, or null. */
function stepId(ls: string[], start: number): string | null {
  const end = nextStepStart(ls, start + 1);
  for (let i = start; i < end; i += 1) {
    const m = /^\s*id:\s*(\S+)\s*$/.exec(ls[i]!);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * True when `block` contains a line matching `guard` that is followed by an
 * `exit 1` within the next `within` lines — i.e. the branch actually REFUSES
 * rather than merely printing. Used to pin publish.yml's fail-closed paths:
 * a guard whose `exit 1` is deleted still reads like a check.
 */
function refusesWithin(block: string, guard: RegExp, within = 8): boolean {
  const bl = block.split('\n');
  for (let i = 0; i < bl.length; i += 1) {
    if (!guard.test(bl[i]!)) continue;
    for (let j = i; j < Math.min(bl.length, i + within); j += 1) {
      if (/^\s*exit 1\s*$/.test(bl[j]!)) return true;
    }
  }
  return false;
}

describe('ci.yml — Windows anti-backslide gate', () => {
  it('the hard (non-advisory) Windows tier names at least the committed no-DuckDB package baseline', () => {
    const { runLine } = findStepRunLine(lines, 'hard gate');
    for (const pkg of HARD_TIER_BASELINE_PACKAGES) {
      expect(runLine, `hard-gate run line is missing "${pkg}":\n  ${runLine}`).toContain(pkg);
    }
  });

  it('the hard-gate step itself carries no continue-on-error (it would not be a hard gate otherwise)', () => {
    const { nameIdx } = findStepRunLine(lines, 'hard gate');
    const boundary = nextStepStart(lines, nameIdx + 1);
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

/**
 * Sibling invariant, same failure family, different file.
 *
 * `test:integration:gate` — the RELEASE gate — named five test files, two of
 * which (`reference-questions.test.ts`, `deep-smoke.test.ts`) do not exist.
 * Vitest treats a filter that matches nothing as "nothing to run" for that
 * name, not as an error: verified live, a run naming one real file and one
 * imaginary one reports `Test Files 1 passed` and exits 0.
 *
 * So the release gate reported GREEN while executing three of the five suites
 * it claimed. That is the same shape as the Windows job above and as
 * `scan:leaks` passing without its gitignored config: a gate that cannot fail
 * because it is not looking at anything. The filenames are a promise; this
 * asserts the promise is keepable.
 */
describe('package.json — the release gate cannot name a suite that does not exist', () => {
  it('every test file named in test:integration:gate is present on disk', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.['test:integration:gate'];
    expect(script, 'test:integration:gate script is missing').toBeTruthy();

    const named = (script as string).match(/[\w.-]+\.test\.ts/g) ?? [];
    // A filter list that has silently emptied is the vacuity case: the gate
    // would run the WHOLE suite (or nothing) and still look deliberate.
    expect(named.length, 'test:integration:gate names no test files').toBeGreaterThan(0);

    const missing = named.filter(
      (f) => !existsSync(fileURLToPath(new URL(`../tests/integration/${f}`, import.meta.url))),
    );
    expect(
      missing,
      `test:integration:gate names ${missing.length} file(s) that do not exist under tests/integration/: ` +
        `${missing.join(', ')}. Vitest ignores an unmatched filter and still exits 0, so the release gate ` +
        'would report green while silently skipping them. Fix the name or delete it from the script.',
    ).toEqual([]);
  });
});

/**
 * The release gate must not be able to mistake an advisory pass for a real one.
 *
 * On the published 0.3.2, ci.yml's windows-build-test job carried
 * `continue-on-error: true` on BOTH unit-test steps, so packages/mcp died with
 * exit 3221226505 and printed no summary at all while the job — and therefore
 * the whole run — concluded `success`. publish.yml gates the npm release on
 * that conclusion, and it is deliberately fail-closed everywhere else ("API
 * unreadable / ci.yml missing -> hard fail (cannot verify == no)"). So the
 * release gate was refusing to publish on an unreadable API while cheerfully
 * publishing on an unchecked platform: one green tick meaning either "Windows
 * passed" or "Windows was allowed to fail", with nothing able to tell them
 * apart.
 *
 * The shape of the fix, which these tests pin:
 *   1. ci.yml's windows job ATTESTS its own scope — each tier's outcome BEFORE
 *      `continue-on-error` is applied — and uploads it as an artifact.
 *   2. publish.yml READS that attestation instead of only the run's colour, and
 *      fails closed when it is absent, unreadable, or says the hard tier lost.
 *   3. Whatever it finds — partial coverage, or a `bypass_ci_check` publish with
 *      no verified CI at all — is stamped into the GitHub release body, which
 *      outlives the run log a `::warning` disappears into.
 *
 * The advisory tier itself is NOT the defect and is not forbidden here. What is
 * forbidden is an advisory tier that the release gate cannot see.
 */
describe('the release gate reads what CI actually gated, not just its colour', () => {
  const ATTESTATION = stepBlock(lines, 'ci.yml', 'Windows tier attestation (what a green tick');
  const UPLOAD = stepBlock(lines, 'ci.yml', 'Upload the Windows tier attestation');
  const HARD_GATE = stepBlock(lines, 'ci.yml', 'hard gate');
  const CI_GREEN_GATE = stepBlock(publishLines, 'publish.yml', 'Require a green CI run on the tagged commit');
  const WIN_SCOPE = stepBlock(publishLines, 'publish.yml', 'Verify what that green CI run actually gated');
  const RELEASE = stepBlock(publishLines, 'publish.yml', 'Create or update the GitHub release');

  it('the windows job attests its own scope, and does so even when a step above it failed', () => {
    expect(
      /^\s*if:\s*always\(\)\s*$/m.test(ATTESTATION.text),
      'the Windows tier attestation step has no `if: always()` — it would be skipped by the very failure ' +
        'it exists to report, and publish.yml would then see no attestation at all.',
    ).toBe(true);

    expect(
      /^\s*if:\s*always\(\)\s*$/m.test(UPLOAD.text),
      'the attestation upload step has no `if: always()`, so the report would not survive a red run.',
    ).toBe(true);

    expect(
      UPLOAD.text,
      'the attestation upload does not use actions/upload-artifact — publish.yml downloads it by name.',
    ).toContain('actions/upload-artifact');

    expect(
      UPLOAD.text,
      'the attestation upload must set `if-no-files-found: error`; otherwise a missing report uploads an ' +
        'empty artifact, which publish.yml would see as "present" and the ambiguity comes straight back.',
    ).toContain('if-no-files-found: error');
  });

  it('every Windows tier — hard AND advisory — is named in the attestation, so a new escape hatch cannot hide', () => {
    const hardId = stepId(lines, HARD_GATE.start);
    expect(hardId, 'the Windows hard-gate step declares no `id:`, so its true outcome cannot be attested').toBeTruthy();
    expect(
      ATTESTATION.text,
      `the attestation does not reference the hard-gate step id "${hardId ?? ''}" — it cannot be reporting its outcome.`,
    ).toContain(hardId!);

    const advisoryStarts = lines
      .map((line, idx) => (CONTINUE_ON_ERROR_RE.test(line) ? enclosingStepStart(lines, idx) : -1))
      .filter((idx) => idx !== -1);
    expect(advisoryStarts.length).toBeGreaterThan(0);

    for (const start of advisoryStarts) {
      const id = stepId(lines, start);
      expect(
        id,
        `the advisory step at ci.yml:${start + 1} declares no \`id:\`. Without one, \`steps.<id>.outcome\` ` +
          'cannot be read, the attestation cannot report that this tier was red, and the release gate is ' +
          'back to a tick that means two different things.',
      ).toBeTruthy();
      expect(
        ATTESTATION.text,
        `the advisory step id "${id ?? ''}" (ci.yml:${start + 1}) never appears in the attestation step. A new ` +
          'advisory escape hatch was added without being reported downstream — add it to the attestation report.',
      ).toContain(id!);
    }
  });

  it('the attested hard-tier package list is derived from the same source the gate filters on', () => {
    const envLine = lines.find((l) => /^\s*WIN_HARD_TIER_PACKAGES:\s*\S/.test(l));
    expect(
      envLine,
      'ci.yml no longer defines WIN_HARD_TIER_PACKAGES — the attestation would report a package list that no ' +
        'longer comes from the same place the hard gate filters on, i.e. a second copy free to drift.',
    ).toBeTruthy();

    const declared = envLine!
      .replace(/^\s*WIN_HARD_TIER_PACKAGES:\s*/, '')
      .trim()
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .sort();

    const { runLine } = findStepRunLine(lines, 'hard gate');
    const filtered = [...runLine.matchAll(/packages\/([\w-]+)/g)].map((m) => m[1]!).sort();

    expect(
      declared,
      `WIN_HARD_TIER_PACKAGES (${declared.join(', ')}) and the hard-gate --filter list (${filtered.join(', ')}) ` +
        'disagree. The attestation would then claim coverage the gate did not run, or omit coverage it did — ' +
        'exactly the "second copy guarded only by a comment" failure this repo keeps hitting.',
    ).toEqual(filtered);
  });

  it('publish.yml downloads that attestation by the same name ci.yml uploads it under', () => {
    const m = /^\s*ARTIFACT_NAME:\s*(\S+)\s*$/m.exec(WIN_SCOPE.text);
    expect(
      m,
      'publish.yml\'s Windows-scope step no longer names an ARTIFACT_NAME — it cannot be reading the ' +
        'attestation at all.',
    ).toBeTruthy();
    const artifact = m![1]!;

    expect(WIN_SCOPE.text, 'the Windows-scope step never downloads the artifact it names').toMatch(
      /gh run download/,
    );
    expect(
      UPLOAD.text,
      `publish.yml downloads artifact "${artifact}" but ci.yml uploads it under a different name. The gate ` +
        'would then fail closed on every release — or, worse, be "fixed" by deleting the check.',
    ).toMatch(new RegExp(`name:\\s*${artifact}\\s*$`, 'm'));
  });

  it('publish.yml refuses to publish when the scope is missing, unreadable, or says the hard tier lost', () => {
    expect(
      stepId(publishLines, CI_GREEN_GATE.start),
      'the CI-green gate step lost its `id:`, so the Windows-scope step below can no longer consume the run it ' +
        'verified.',
    ).toBe('ci_gate');

    expect(
      WIN_SCOPE.text,
      'the Windows-scope step does not consume the CI-green gate\'s run id — it would be inspecting some other ' +
        'run, or none.',
    ).toContain('steps.ci_gate.outputs.run_id');

    expect(
      refusesWithin(WIN_SCOPE.text, /downloaded.*-ne 1/),
      'a failed artifact download no longer exits 1. "Green tick, no recorded scope" must be treated as a NO — ' +
        'the same fail-closed rule this workflow already applies to an unreadable API.',
    ).toBe(true);

    expect(
      refusesWithin(WIN_SCOPE.text, /\$\{schema\}.*!=\s*"1"/),
      'an unrecognised attestation schema no longer exits 1. A gate that cannot read its evidence must not pass.',
    ).toBe(true);

    expect(
      refusesWithin(WIN_SCOPE.text, /\$\{hard_outcome\}.*!=\s*"success"/),
      'the Windows-scope step no longer refuses when the hard-gated tier did not pass. That single check is the ' +
        'difference between "CI was green" and "Windows worked", which is the entire point of this gate.',
    ).toBe(true);
  });

  it('what was actually verified — including a bypass — is stamped on the release, not just logged', () => {
    expect(
      CI_GREEN_GATE.text,
      'the bypass_ci_check branch no longer records `bypassed=true` as a step output. A ::warning in a run log ' +
        'is not a record: nothing downstream can then tell that the published build had no verified CI.',
    ).toMatch(/bypassed=true/);

    expect(
      WIN_SCOPE.text,
      'the bypass path no longer produces a scope naming itself a bypass, so a bypassed release would be ' +
        'indistinguishable from a verified one in its own release notes.',
    ).toMatch(/BYPASS/);

    expect(
      RELEASE.text,
      'the GitHub release step no longer consumes steps.win_scope.outputs.scope — the permanent, reader-facing ' +
        'record of what this release was verified against has been dropped.',
    ).toContain('steps.win_scope.outputs.scope');

    expect(
      RELEASE.text,
      'the release step reads the scope but never writes RELEASE_VERIFICATION_SCOPE into the notes body.',
    ).toMatch(/RELEASE_VERIFICATION_SCOPE[\s\S]*RELEASE_VERIFICATION_SCOPE/);

    // Both release paths — CHANGELOG section and --generate-notes fallback —
    // must carry the stamp. The fallback writes a body we did not author, so
    // it has to re-stamp; if that is dropped, some releases silently ship with
    // no verification statement at all.
    const stampWrites = [...RELEASE.text.matchAll(/cat "\$SCOPE_FILE" >>/g)].length;
    expect(
      stampWrites,
      `the verification-scope block is appended to only ${stampWrites} release-body path(s); both the CHANGELOG ` +
        'path and the --generate-notes fallback must carry it, or a release can ship with no scope stated.',
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * The attestation above removes the AMBIGUITY in a green tick. It does not by
   * itself refuse a release while the advisory Windows suites are red — that is
   * a deliberate tier, and blocking every release on a crash that cannot be
   * reproduced off-Windows would be its own dishonesty.
   *
   * But it IS a policy choice, and the maintainer has to be able to make it
   * without editing YAML under time pressure during a release. The switch is a
   * repository variable, default unset, so today's behaviour is unchanged until
   * someone deliberately turns it on. This test exists because a switch nobody
   * can find is the same as no switch, and one that is quietly deleted is worse
   * — the release would go back to publishing over red advisory tiers with
   * nobody noticing the control had gone.
   */
  it('the maintainer can refuse a partially-verified release without editing YAML', () => {
    expect(
      WIN_SCOPE.text,
      'the Windows-scope step no longer reads the REQUIRE_WINDOWS_FULLY_VERIFIED repository variable, so ' +
        'there is no way to say "no more releases until Windows is green" short of editing this workflow.',
    ).toContain('REQUIRE_WINDOWS_FULLY_VERIFIED');

    expect(
      WIN_SCOPE.text,
      'REQUIRE_WINDOWS_FULLY_VERIFIED is read but never bound from `vars`, so setting the repository variable ' +
        'would have no effect — a control that looks present and does nothing.',
    ).toMatch(/vars\.REQUIRE_WINDOWS_FULLY_VERIFIED/);

    // The switch has to REFUSE, not warn. A second `emit ... "false"` in the
    // strict branch would leave it publishing exactly as before.
    const strictBranch = WIN_SCOPE.text.slice(
      WIN_SCOPE.text.indexOf('REQUIRE_WINDOWS_FULLY_VERIFIED:-'),
    );
    expect(
      strictBranch.slice(0, strictBranch.indexOf('emit ')),
      'the REQUIRE_WINDOWS_FULLY_VERIFIED branch does not exit non-zero before falling through to the ' +
        'publish-with-a-caveat path, so turning it on would change the log and nothing else.',
    ).toMatch(/exit 1/);
  });
});
