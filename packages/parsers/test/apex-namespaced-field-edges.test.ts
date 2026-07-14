/// <reference types="vitest/globals" />

import { extractApexAstEdges } from '../src/apex-ast-edges.js';

/**
 * BUG 2 (apex namespace) — `isSObjectish` now admits managed-package
 * namespaced api names, which start LOWERCASE and always contain `__`
 * (`ns__Obj__c`), alongside the PascalCase forms. The old `/^[A-Z]/`-only
 * test silently rejected every namespaced object, so a resolved
 * `ns__Obj__c` receiver was dropped and the write fell to the scanner's
 * literal-receiver phantom (`CustomField:rec.My_Field__c`).
 *
 * These lock the fix at the AST seam (`extractApexAstEdges`), mirroring the
 * regex-scanner coverage in apex-scanner.test.ts. The `__` requirement is the
 * guard: a true local alias (`rec`, `i`, `foo`) never contains `__`, so the
 * namespace branch cannot re-admit one.
 */
describe('extractApexAstEdges — managed-package namespaced sObject writes (isSObjectish)', () => {
  it('keys the writesTo on the namespaced object api name, not the loop alias', () => {
    const out = extractApexAstEdges(
      [
        'public class W {',
        '  public void run(List<ns__Obj__c> items) {',
        '    for (ns__Obj__c rec : items) {',
        '      rec.My_Field__c = 1;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      'W',
      {},
    );
    expect(out.parseError).toBeUndefined();
    expect(out.writes).toContain('ns__Obj__c.My_Field__c');
    // the resolved receiver type replaces the alias — no `rec.` phantom write.
    expect(out.writes.some((w) => w.startsWith('rec.'))).toBe(false);
  });

  it('the __-less guard: a primitive local and a bare return mint no CustomField-shaped write', () => {
    const out = extractApexAstEdges(
      [
        'public class W {',
        '  public Integer run(List<ns__Obj__c> items) {',
        '    Integer i = 0;',
        '    for (ns__Obj__c rec : items) {',
        '      rec.My_Field__c = i;',
        '    }',
        '    return i;',
        '  }',
        '}',
      ].join('\n'),
      'W',
      {},
    );
    expect(out.parseError).toBeUndefined();
    // The ONLY write is the namespaced field; `i` (Integer / no `__`) is never
    // admitted as an sObject receiver, nor is the primitive type name.
    expect(out.writes).toEqual(['ns__Obj__c.My_Field__c']);
    expect(out.writes.some((w) => w.startsWith('i.'))).toBe(false);
    expect(out.writes.some((w) => w.startsWith('Integer'))).toBe(false);
  });
});
