/// <reference types="vitest/globals" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { V01_TOOLS } from '../../src/tools/index.js';

// Guards against the tool-name drift class of bug: a tool advertised in the
// roster but not routed in dispatch (or vice versa), or a roster/docs name
// that doesn't match the dispatch case. This is exactly the failure that
// makes a tool report "unknown-tool" at runtime despite having a handler.

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(
  join(here, '..', '..', 'src', 'tools', 'index.ts'),
  'utf8',
);

const dispatchCaseNames = [...indexSource.matchAll(/case '([^']+)':/g)]
  .map((m) => m[1] as string)
  .filter((n) => n.startsWith('sfi.'));

const rosterNames = V01_TOOLS.map((t) => t.name);

describe('tool name parity (roster <-> dispatch)', () => {
  it('every advertised roster tool has a dispatch case', () => {
    const cases = new Set(dispatchCaseNames);
    const missing = rosterNames.filter((n) => !cases.has(n));
    expect(missing).toEqual([]);
  });

  it('every dispatch case is an advertised roster tool (no orphans / name drift)', () => {
    const roster = new Set(rosterNames);
    const orphans = dispatchCaseNames.filter((n) => !roster.has(n));
    expect(orphans).toEqual([]);
  });

  it('roster tool names are unique', () => {
    expect(new Set(rosterNames).size).toBe(rosterNames.length);
  });

  it('dispatch case names are unique', () => {
    expect(new Set(dispatchCaseNames).size).toBe(dispatchCaseNames.length);
  });

  it('includes the new sfi.resolve tool in both roster and dispatch', () => {
    expect(rosterNames).toContain('sfi.resolve');
    expect(dispatchCaseNames).toContain('sfi.resolve');
  });
});
