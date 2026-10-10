/// <reference types="vitest/globals" />
/**
 * CH-4 drift guard: the harness locator exists in three packages (each
 * package's tsconfig compiles its own test/ tree, so they cannot import one
 * shared file). They must stay byte-identical, or one package's fixture
 * suites could silently start skipping again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgs = join(__dirname, '..', '..');
const read = (pkg: string): string => readFileSync(join(pkgs, pkg, 'test', 'harness-root.ts'), 'utf8');

describe('harness-root.ts copies (CH-4)', () => {
  it('are byte-identical across extractors, parsers and renderers', () => {
    const canonical = read('extractors');
    expect(read('parsers')).toBe(canonical);
    expect(read('renderers')).toBe(canonical);
  });

  it('honours an explicit SFI_HARNESS_ROOT and refuses a wrong one (FAIL-BEFORE: no override, silent skip)', async () => {
    const { findHarnessRoot } = await import('./harness-root.js');
    const prior = process.env['SFI_HARNESS_ROOT'];
    try {
      process.env['SFI_HARNESS_ROOT'] = join(pkgs, 'definitely-not-a-harness');
      expect(() => findHarnessRoot()).toThrow(/has no tests\/fixtures/);
    } finally {
      if (prior === undefined) delete process.env['SFI_HARNESS_ROOT'];
      else process.env['SFI_HARNESS_ROOT'] = prior;
    }
  });
});
