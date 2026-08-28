/// <reference types="vitest/globals" />

// =============================================================================
// R6 — NOT_USAGE_EDGE_TYPES adoption drift guard.
//
// apex-reachability.ts is the ONE canonical, DERIVED definition of "usage"
// (D-1 in that file's own header). find-dead-code.ts already imports
// NOT_USAGE_EDGE_TYPES and is drift-tested against it (see
// find-dead-code.test.ts, "non-usage edge-type drift guard"). object-360.ts
// and find-component-usages.ts instead hand-copy the same two-element list as
// a local `NON_USAGE_EDGE_TYPES` constant — neither imports this module, and
// until this test existed nothing anywhere compared their copies to the
// canonical one or to each other. That is a real gap: a change to the
// canonical deny-list here silently would NOT propagate to those two tools,
// and neither `pnpm build` nor `pnpm test` would say a word — sfi.object_360
// and sfi.find_component_usages would keep answering "what's attached to /
// what references this component" against a stale definition of usage while
// sfi.find_dead_code (and every other consumer of this file) answered against
// the new one.
//
// This file cannot import those two constants — object-360.ts and
// find-component-usages.ts are other agents' files and neither exports its
// copy — so the guard reads their source text instead.
//
// THE GUARD MUST NOT PIN THE DEBT IN PLACE. The real R6 fix is for those two
// files to `import { NOT_USAGE_EDGE_TYPES } from './apex-reachability.js'` and
// build their local Set from it. Each drift test below therefore checks for
// that import FIRST and, when it is present, treats the import itself as the
// guard and passes. Only a file that still declares its own bracket literal is
// compared member-by-member. An earlier revision of this file asserted the
// OPPOSITE — that neither file imports yet — which would have turned the suite
// red at the exact moment the defect was actually fixed. Do not reintroduce
// an assertion whose passing condition is that the bug still exists.
// =============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOT_USAGE_EDGE_TYPES } from '../../src/tools/apex-reachability.js';

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools');

/**
 * True when `source` imports the canonical deny-list from this module — i.e.
 * the file has ADOPTED `apex-reachability.ts` rather than hand-copying it.
 * Once this is true the import is the guard and no source-text comparison is
 * needed (or possible: the adopted shape, `new Set(NOT_USAGE_EDGE_TYPES)`,
 * carries no literal to compare).
 */
function importsCanonicalDenyList(source: string): boolean {
  return /import\s*(?:type\s*)?\{[^}]*\bNOT_USAGE_EDGE_TYPES\b[^}]*\}\s*from\s*['"]\.\/apex-reachability\.js['"]/m.test(
    source,
  );
}

/**
 * Extracts the string members of a `new Set([...])` (or `[...] as const`)
 * literal assigned to `constName` in `source`, in source order. Used to read
 * the hand-copied non-usage lists out of object-360.ts and
 * find-component-usages.ts without importing them (neither exports its copy,
 * and neither file is owned by this agent). Returns `null` when the
 * declaration carries no bracket literal at all — which is exactly what the
 * ADOPTED form looks like.
 */
function extractStringSetMembers(source: string, constName: string): string[] | null {
  const declRe = new RegExp(`\\bconst\\s+${constName}\\b[^=]*=\\s*(?:new Set\\()?\\[([^\\]]*)\\]`, 'm');
  const match = declRe.exec(source);
  if (!match) {
    return null;
  }
  const captured = match[1];
  if (captured === undefined) return null;
  return captured
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^['"]|['"]$/g, ''));
}

/**
 * The one assertion shared by both drift tests. ADOPTED (imports the canonical
 * constant) passes outright; a residual literal is still compared, so a file
 * that imports AND keeps a stale hand-typed copy is caught. A file that
 * neither imports nor declares a readable literal is a HARD failure rather
 * than a vacuous pass — that is the shape a silent rename would take.
 *
 * Takes the SOURCE TEXT, not a path, so the tests below can drive this exact
 * function with simulated file contents (adopted / drifted) and prove the
 * guard's behaviour without writing to files this agent does not own.
 */
function assertDenyListNotDrifted(label: string, src: string): void {
  const literal = extractStringSetMembers(src, 'NON_USAGE_EDGE_TYPES');

  if (importsCanonicalDenyList(src)) {
    // ADOPTED — the import is the guard. Nothing further is required, but if
    // the file ALSO kept a literal it must still agree.
    if (literal !== null) {
      expect(literal.slice().sort()).toEqual([...NOT_USAGE_EDGE_TYPES].sort());
    }
    return;
  }

  expect(
    literal,
    `${label} neither imports NOT_USAGE_EDGE_TYPES from './apex-reachability.js' nor declares a readable ` +
      `NON_USAGE_EDGE_TYPES literal — the deny-list is no longer guarded in this file`,
  ).not.toBeNull();
  expect(literal!.slice().sort()).toEqual([...NOT_USAGE_EDGE_TYPES].sort());
}

function readToolSource(fileName: string): string {
  return readFileSync(join(toolsDir, fileName), 'utf8');
}

/** Verbatim the migration recommended in the addenda for the two copies. */
const ADOPTED_FORM = [
  "import { NOT_USAGE_EDGE_TYPES } from './apex-reachability.js';",
  'const NON_USAGE_EDGE_TYPES: ReadonlySet<string> = new Set(NOT_USAGE_EDGE_TYPES);',
].join('\n');

describe('apex-reachability — the drift guard must not punish the real fix', () => {
  it('PASSES on the ADOPTED form (import + `new Set(NOT_USAGE_EDGE_TYPES)`, no literal)', () => {
    // The R6 fix for object-360.ts / find-component-usages.ts. Driven through
    // the SAME function the two file-backed tests use. If this ever throws,
    // the guard has become a booby trap that reds the suite the moment the
    // defect is actually fixed.
    expect(() => assertDenyListNotDrifted('<adopted>', ADOPTED_FORM)).not.toThrow();
  });

  it('PASSES on a hand-copied literal that still agrees with the canonical list', () => {
    const src = "const NON_USAGE_EDGE_TYPES: ReadonlySet<string> = new Set(['grantedBy', 'parentOf']);";
    expect(() => assertDenyListNotDrifted('<in-agreement>', src)).not.toThrow();
  });

  it('FAILS on a hand-copied literal that has DRIFTED from the canonical list', () => {
    const src = "const NON_USAGE_EDGE_TYPES: ReadonlySet<string> = new Set(['parentOf']);";
    expect(() => assertDenyListNotDrifted('<drifted>', src)).toThrow();
  });

  it('FAILS on a file that has neither the import nor a readable literal (silent rename)', () => {
    expect(() => assertDenyListNotDrifted('<renamed>', 'const SOMETHING_ELSE = 1;\n')).toThrow();
  });

  it('FAILS on a file that imports the canonical list but keeps a DRIFTED literal beside it', () => {
    const src = [
      "import { NOT_USAGE_EDGE_TYPES } from './apex-reachability.js';",
      "const NON_USAGE_EDGE_TYPES: ReadonlySet<string> = new Set(['parentOf']);",
    ].join('\n');
    expect(() => assertDenyListNotDrifted('<half-adopted>', src)).toThrow();
  });
});

describe('R6 — object-360.ts and find-component-usages.ts NON_USAGE_EDGE_TYPES drift guard', () => {
  it('object-360.ts either imports the canonical NOT_USAGE_EDGE_TYPES or matches it exactly', () => {
    assertDenyListNotDrifted('object-360.ts', readToolSource('object-360.ts'));
  });

  it('find-component-usages.ts either imports the canonical NOT_USAGE_EDGE_TYPES or matches it exactly', () => {
    assertDenyListNotDrifted('find-component-usages.ts', readToolSource('find-component-usages.ts'));
  });
});
