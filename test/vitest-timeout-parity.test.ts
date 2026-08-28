import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * HOOK-TIMEOUT-STARVES-THE-HEAVIEST-STEP.
 *
 * Vitest defaults `hookTimeout` to 10s and leaves it there when you raise
 * `testTimeout`. A `beforeAll` that builds a DuckDB fixture routinely does MORE
 * work than the tests that read it, so the default hands the heaviest step the
 * smallest budget — silently, and only under load.
 *
 * ## Why this is a gate and not a one-time edit
 *
 * The repo has now hit this THREE times.
 *   - packages/graph found it first and fixed it (GRAPH-QUERIES-BEFOREALL-FLAKE).
 *   - packages/mcp copied the DIAGNOSIS into a comment saying "Equal budgets"
 *     and set 45000 / 20000 — the comment was false the day it was written. The
 *     Windows job dies in that package's heaviest `beforeAll`, and when vitest
 *     kills a hook mid-DuckDB-call the Napi layer aborts the process rather than
 *     failing softly, taking 300+ files of results with it.
 *   - cli / extractors / patterns each set `testTimeout` and never set
 *     `hookTimeout` at all, so all three sat on the 10s default.
 *
 * A comment asserting parity is exactly what failed. This measures it.
 *
 * ## VACUITY RISK
 * The config list is derived from disk, not hand-written, and the count is
 * asserted: a glob that returned nothing would otherwise satisfy every
 * assertion over nothing.
 */
const CONFIGS = [
  'packages/cli/vitest.config.ts',
  'packages/core/vitest.config.ts',
  'packages/contracts/vitest.config.ts',
  'packages/extractors/vitest.config.ts',
  'packages/graph/vitest.config.ts',
  'packages/mcp/vitest.config.ts',
  'packages/parsers/vitest.config.ts',
  'packages/patterns/vitest.config.ts',
  'packages/renderers/vitest.config.ts',
  'packages/tooling-api/vitest.config.ts',
  'packages/vault/vitest.config.ts',
  'tests/integration/vitest.config.ts',
];

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Strip comments so a value quoted in prose is never read as the setting. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** The literal or identifier a key is set to, or null when the key is absent. */
const settingOf = (src: string, key: string): string | null => {
  const m = new RegExp(`\\b${key}\\s*:\\s*([A-Za-z0-9_.]+)`).exec(src);
  return m?.[1] ?? null;
};

describe('a hook never gets a smaller budget than the tests it feeds', () => {
  const read = (rel: string): string | null => {
    try {
      return stripComments(readFileSync(repoRoot + rel, 'utf8'));
    } catch {
      return null;
    }
  };

  const present = CONFIGS.map((rel) => ({ rel, src: read(rel) })).filter(
    (c): c is { rel: string; src: string } => c.src !== null,
  );

  it('the corpus is real — a wrong path list must not pass over nothing', () => {
    expect(present.length).toBeGreaterThanOrEqual(8);
  });

  it('every config that raises testTimeout raises hookTimeout to match', () => {
    const drifted: string[] = [];
    for (const { rel, src } of present) {
      const test = settingOf(src, 'testTimeout');
      if (test === null) continue; // vitest's defaults apply to both — no asymmetry
      const hook = settingOf(src, 'hookTimeout');
      if (hook === null) {
        drifted.push(
          `${rel}: testTimeout=${test} but hookTimeout is UNSET, so hooks keep vitest's 10s default`,
        );
        continue;
      }
      if (hook !== test) {
        drifted.push(`${rel}: testTimeout=${test} but hookTimeout=${hook}`);
      }
    }
    expect(
      drifted,
      'A beforeAll that builds a fixture does more work than the tests that read it. Giving it the ' +
        'smaller clock starves the heaviest step, and a vitest-killed DuckDB call aborts the whole ' +
        'process rather than failing softly:\n  ' +
        drifted.join('\n  '),
    ).toEqual([]);
  });

  it('the packages that share a budget derive it, rather than writing it twice', () => {
    // The mcp config carried a comment claiming "equal budgets" beside 45000 and
    // 20000. Deriving both from one constant is what makes the claim checkable.
    const notDerived: string[] = [];
    for (const { rel, src } of present) {
      const test = settingOf(src, 'testTimeout');
      const hook = settingOf(src, 'hookTimeout');
      if (test === null || hook === null) continue;
      if (/^\d/.test(test) && /^\d/.test(hook) && test === hook) {
        notDerived.push(`${rel}: both are the literal ${test} — one constant, used twice`);
      }
    }
    expect(
      notDerived,
      'Two matching literals agree until someone edits one of them. Name the budget once:\n  ' +
        notDerived.join('\n  '),
    ).toEqual([]);
  });
});
