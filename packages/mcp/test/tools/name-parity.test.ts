/// <reference types="vitest/globals" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { advertisedTools, V01_TOOLS } from '../../src/tools/index.js';

// Guards against the tool-name drift class of bug: a tool advertised in the
// roster but not routed in dispatch (or vice versa), or a roster/docs name
// that doesn't match the dispatch case. This is exactly the failure that
// makes a tool report "unknown-tool" at runtime despite having a handler.
//
// Hidden tools (`hidden: true`) stay in `V01_TOOLS` (so they keep a dispatch
// case and remain resolvable) but are excluded from `advertisedTools()`. The
// roster<->dispatch parity below is checked against the FULL `V01_TOOLS`
// (hidden included, since they must still dispatch); a dedicated case asserts
// the hidden contract explicitly (dispatchable but not advertised).

const here = dirname(fileURLToPath(import.meta.url));
// R7-F2: dispatch switch now lives in tool-dispatch.ts (split from index.ts).
const indexSource = readFileSync(
  join(here, '..', '..', 'src', 'tools', 'tool-dispatch.ts'),
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

  it('V01_TOOLS.length equals dispatch case count (roster/handler size parity)', () => {
    expect(rosterNames.length).toBe(dispatchCaseNames.length);
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

  it('hidden tools are dispatchable but NOT advertised (back-compat alias contract)', () => {
    const advertised = new Set(advertisedTools('full').map((t) => t.name));
    const cases = new Set(dispatchCaseNames);
    const hidden = V01_TOOLS.filter((t) => t.hidden);
    for (const tool of hidden) {
      // A hidden alias must still resolve at dispatch...
      expect(
        cases.has(tool.name),
        `hidden tool ${tool.name} has no dispatch case — it would report unknown-tool`,
      ).toBe(true);
      // ...but must never occupy a tools/list schema slot.
      expect(
        advertised.has(tool.name),
        `hidden tool ${tool.name} is still advertised on tools/list`,
      ).toBe(false);
    }
  });
});
