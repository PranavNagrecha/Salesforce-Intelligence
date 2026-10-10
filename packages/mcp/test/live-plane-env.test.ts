/// <reference types="vitest/globals" />

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * FAIL-BEFORE/PASS-AFTER — one definition of "the live plane env switch is on".
 *
 * Before: `route-question.ts` carried its own copy of `isLivePlaneEnabled()`
 * (guarded only by a comment explaining why it could not import the seam).
 * After: both read `live-plane-env.ts`, a dependency-free leaf; this test
 * fails if any other mcp source file reads the env var directly again.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

describe('live plane env switch has one definition', () => {
  it('only live-plane-env.ts reads process.env SFI_LIVE_PLANE_ENABLED', () => {
    const readers = walk(SRC)
      .filter((f) => /process\.env(?:\.|\[')SFI_LIVE_PLANE_ENABLED/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(readers).toEqual(['live-plane-env.ts']);
  });
});
