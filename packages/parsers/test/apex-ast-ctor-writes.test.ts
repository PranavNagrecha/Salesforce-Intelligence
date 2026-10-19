/// <reference types="vitest/globals" />

import { extractApexAstEdges } from '../src/apex-ast-edges.js';

/**
 * APEX-CTOR-FIELD-WRITES: `new Demo_Obj__c(Id = recId, Demo_Field__c = v)`
 * followed by `update` / `Database.update` / `insert` is the second way Apex
 * writes a field. Only `record.Field__c = v;` minted a write, so a class whose
 * writes are all constructor-shaped existed in the graph as a reader only.
 */
const KNOWN_OBJECTS = new Set(['Demo_Obj__c']);
const run = (body: string): ReturnType<typeof extractApexAstEdges> =>
  extractApexAstEdges(
    `public class DemoWriter { public void run(Demo_Obj__c other, Id recId) { ${body} } }`,
    'DemoWriter',
    { knownClasses: new Set(['DemoWriter']), knownObjects: KNOWN_OBJECTS },
  );

describe('extractApexAstEdges — named-argument SObject constructors are writes', () => {
  it('FAIL-BEFORE/PASS-AFTER: new Demo_Obj__c(Id = recId, Demo_Field__c = x) writes Demo_Field__c', () => {
    const out = run("Demo_Obj__c o = new Demo_Obj__c(Id = recId, Demo_Field__c = 'x'); update o;");
    expect(out.parseError).toBeUndefined();
    expect(out.writes).toEqual(['Demo_Obj__c.Demo_Field__c', 'Demo_Obj__c.Id']);
  });

  it('FAIL-BEFORE/PASS-AFTER: inside a list literal and inside Database.update(new List<..>{ .. })', () => {
    const out = run(
      'List<Demo_Obj__c> rows = new List<Demo_Obj__c>{ new Demo_Obj__c(Id = recId, Demo_A__c = 1) };' +
        'Database.update(new List<Demo_Obj__c>{ new Demo_Obj__c(Id = recId, Demo_B__c = 2) });',
    );
    expect(out.writes).toEqual(['Demo_Obj__c.Demo_A__c', 'Demo_Obj__c.Demo_B__c', 'Demo_Obj__c.Id']);
    expect(out.calls).toContain('Database.update');
  });

  it('a constructor value read keeps its readsFrom (new Demo_Obj__c(Name = other.Name))', () => {
    const out = run('insert new Demo_Obj__c(Name = other.Name);');
    expect(out.reads).toEqual(['Demo_Obj__c.Name']);
    expect(out.writes).toEqual(['Demo_Obj__c.Name']);
  });

  it('an empty constructor followed by a dot assignment is unchanged', () => {
    const out = run('Demo_Obj__c o = new Demo_Obj__c(); o.Demo_Field__c = 1;');
    expect(out.writes).toEqual(['Demo_Obj__c.Demo_Field__c']);
    expect(out.reads).toEqual([]);
  });

  it('a lowercase constructed type canonicalises against the roster; an unknown-cased one does not guess', () => {
    expect(run("insert new demo_obj__c(Demo_Field__c = 'x');").writes).toEqual(['Demo_Obj__c.Demo_Field__c']);
    const noRoster = extractApexAstEdges(
      "public class DemoWriter { public void run() { insert new demo_obj__c(Demo_Field__c = 'x'); } }",
      'DemoWriter',
    );
    expect(noRoster.writes).toEqual([]);
  });

  it('a plain local assignment or a system-type constructor mints nothing', () => {
    const out = run("Integer n = 0; n = 2; Map<String, Object> m = new Map<String, Object>{ 'a' => 1 };");
    expect(out.writes).toEqual([]);
  });
});
