/// <reference types="vitest/globals" />
/**
 * PERF-11 — FAIL-BEFORE/PASS-AFTER: every `sfi` start (including the MCP
 * server a host spawns) parsed the ~8 MB bundle from scratch. The bin now
 * enables Node's on-disk compile cache BEFORE loading the bundle; a static
 * `import … from '../dist/index.js'` would be hoisted above that call and
 * silently bypass the cache, so this pins the order.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('bin/sfi.js compile cache (PERF-11)', () => {
  const src = readFileSync(join(__dirname, '..', 'bin', 'sfi.js'), 'utf8');

  it('enables the compile cache, then loads the bundle dynamically', () => {
    const enable = src.indexOf('enableCompileCache');
    const load = src.indexOf("await import('../dist/index.js')");
    expect(enable).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(enable);
    expect(src).not.toMatch(/^import [^\n]*'\.\.\/dist\/index\.js'/m);
  });
});
