/// <reference types="vitest/globals" />

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePropertiesJson } from '@sf-intelligence/graph';

/**
 * CH-8 (FAIL-BEFORE/PASS-AFTER): seven tools carried a private copy of the
 * `properties_json` parser whose `catch { return {} }` turned a malformed row
 * into "this component has no properties" with no trace, so a cross-vault diff
 * could report "no change" for a row it never read. The graph's parser warns
 * and names the row. This guard keeps a private copy from coming back.
 */
const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(here, '..', '..', '..');

const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));

describe('one properties_json parser (CH-8)', () => {
  it('no mcp or cli source defines its own properties_json parser', () => {
    const copies = ['mcp', 'cli']
      .flatMap((pkg) => tsFiles(join(packagesDir, pkg, 'src')))
      .filter((f) =>
        /const parse(Edge)?PropertiesJson\s*=/.test(readFileSync(f, 'utf-8')),
      );
    expect(copies).toEqual([]);
  });

  it('the shared parser warns on a malformed row instead of degrading silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(parsePropertiesJson('{not json', 'CustomObject:Invoice__c')).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('CustomObject:Invoice__c');
      expect(parsePropertiesJson('{"a":1}')).toEqual({ a: 1 });
    } finally {
      warn.mockRestore();
    }
  });
});
