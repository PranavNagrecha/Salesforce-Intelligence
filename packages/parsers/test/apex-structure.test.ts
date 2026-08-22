/// <reference types="vitest/globals" />

import { parseApexStructure } from '../src/apex-structure.js';

/**
 * Unit tests for the AST STRUCTURE projection.
 *
 * Every fixture is SYNTHETIC — no org identifier appears in this file. The
 * tests are grouped by the claim they defend rather than by function, because
 * the claims are what ship: a signature that is really the declared signature,
 * a loop-body test that does NOT fire on a for-each header query, an absent
 * value that stays absent, and a parse failure that yields `null` rather than
 * an empty structure.
 */

const parse = async (source: string, kind: 'class' | 'trigger' = 'class') =>
  parseApexStructure(source, { kind });

describe('parseApexStructure — declaration facts', () => {
  it('reads modifiers, sharing, superclass and interfaces as written', async () => {
    const r = await parse(`
      @SuppressWarnings('PMD')
      public with sharing class WidgetService extends BaseService implements Queueable, Database.AllowsCallouts {
        public void run() {}
      }
    `);
    expect(r.parsed).toBe(true);
    const s = r.structure!;
    expect(s.kind).toBe('class');
    expect(s.name).toBe('WidgetService');
    // `with sharing` survives ANTLR's whitespace-free getText().
    expect(s.modifiers).toContain('with sharing');
    expect(s.modifiers).toContain('public');
    expect(s.sharing).toBe('with sharing');
    expect(s.annotations).toEqual(["@SuppressWarnings('PMD')"]);
    expect(s.superclass).toBe('BaseService');
    expect(s.interfaces).toEqual(['Queueable', 'Database.AllowsCallouts']);
  });

  it('reports NO sharing keyword as null — never as "without sharing"', async () => {
    const r = await parse('public class WidgetService { public void run() {} }');
    // The single most consequential null in the payload: Apex does not default
    // a no-keyword class to `without sharing`.
    expect(r.structure!.sharing).toBeNull();
  });

  it('renders a method signature from the declaration, with typed params', async () => {
    const r = await parse(`
      public class WidgetService {
        @AuraEnabled(cacheable=true)
        public static List<String> lookup(Map<Id, String> byId, Integer limitCount) {
          return null;
        }
      }
    `);
    const m = r.structure!.methods[0]!;
    expect(m.name).toBe('lookup');
    expect(m.signature).toBe(
      'public static List<String> lookup(Map<Id,String> byId, Integer limitCount)',
    );
    expect(m.returnType).toBe('List<String>');
    expect(m.params).toEqual([
      { name: 'byId', type: 'Map<Id,String>' },
      { name: 'limitCount', type: 'Integer' },
    ]);
    expect(m.annotations).toEqual(['@AuraEnabled(cacheable=true)']);
    expect(m.isStatic).toBe(true);
    expect(m.visibilityDeclared).toBe(true);
    expect(m.hasBody).toBe(true);
  });

  it('marks an UNDECLARED visibility as the language default, not as read', async () => {
    const r = await parse(`
      public class WidgetService {
        Integer counter;
        void hidden() {}
      }
    `);
    const method = r.structure!.methods.find((m) => m.name === 'hidden')!;
    expect(method.visibility).toBe('private');
    // The flag is what keeps `private` from reading as a modifier in the source.
    expect(method.visibilityDeclared).toBe(false);
    const member = r.structure!.members.find((m) => m.name === 'counter')!;
    expect(member.visibilityDeclared).toBe(false);
  });

  it('gives a constructor a null returnType — it has none to read', async () => {
    const r = await parse(`
      public class WidgetService {
        public WidgetService(Integer seed) {}
      }
    `);
    const ctor = r.structure!.methods.find((m) => m.isConstructor)!;
    expect(ctor.returnType).toBeNull();
    expect(ctor.name).toBe('WidgetService');
  });

  it('names inner types and attributes each method to its owning type', async () => {
    const r = await parse(`
      public class WidgetService {
        public void outer() {}
        public class Result {
          public void inner() {}
        }
        public enum Mode { FAST, SLOW }
        public interface Sink { void accept(String s); }
      }
    `);
    const s = r.structure!;
    expect(s.innerTypes.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'class:Result',
      'enum:Mode',
      'interface:Sink',
    ]);
    expect(s.methods.find((m) => m.name === 'outer')!.ownerType).toBe('WidgetService');
    expect(s.methods.find((m) => m.name === 'inner')!.ownerType).toBe(
      'WidgetService.Result',
    );
    // An interface method has no body — reported, not inferred.
    expect(s.methods.find((m) => m.name === 'accept')!.hasBody).toBe(false);
  });

  it('reads a trigger object and its events', async () => {
    const r = await parse(
      'trigger WidgetTrigger on Widget__c (before insert, after update) { Integer i = 1; }',
      'trigger',
    );
    const s = r.structure!;
    expect(s.kind).toBe('trigger');
    expect(s.trigger).toEqual({
      object: 'Widget__c',
      events: ['before insert', 'after update'],
    });
    // A trigger declares no sharing keyword — null, not a default.
    expect(s.sharing).toBeNull();
  });
});

describe('parseApexStructure — data-access sites', () => {
  it('does NOT call a for-each HEADER query a loop-body query', async () => {
    // The header query runs ONCE. Reporting it as in-loop would manufacture a
    // governor-limit finding out of correct code.
    const r = await parse(`
      public class WidgetService {
        public void run() {
          for (Widget__c w : [SELECT Id FROM Widget__c]) {
            System.debug(w);
          }
        }
      }
    `);
    const site = r.structure!.soqlSites[0]!;
    expect(site.objects).toEqual(['Widget__c']);
    expect(site.inLoopBody).toBe(false);
    expect(site.inMethod).toBe('run');
  });

  it('DOES call a query in the loop body a loop-body query', async () => {
    const r = await parse(`
      public class WidgetService {
        public void run(List<Id> ids) {
          for (Id i : ids) {
            Widget__c w = [SELECT Id FROM Widget__c WHERE Id = :i];
            insert w;
          }
        }
      }
    `);
    const s = r.structure!;
    expect(s.soqlSites[0]!.inLoopBody).toBe(true);
    expect(s.dmlSites[0]!).toMatchObject({
      operation: 'insert',
      form: 'statement',
      inLoopBody: true,
      inMethod: 'run',
    });
  });

  it('treats an inner loop HEADER inside an outer loop BODY as in-loop', async () => {
    // The inner header query is not in the inner loop's body, but it still runs
    // once per OUTER iteration — so the walk must not stop at the inner loop.
    const r = await parse(`
      public class WidgetService {
        public void run(List<Id> ids) {
          for (Id i : ids) {
            for (Widget__c w : [SELECT Id FROM Widget__c WHERE Id = :i]) {
              System.debug(w);
            }
          }
        }
      }
    `);
    expect(r.structure!.soqlSites[0]!.inLoopBody).toBe(true);
  });

  it('separates a DML statement from a Database.<op> call and reads its options', async () => {
    const r = await parse(`
      public class WidgetService {
        public void run(List<Widget__c> rows) {
          Database.insert(rows, false);
          Database.SaveResult[] kept = Database.update(rows, true);
          delete rows;
        }
      }
    `);
    const s = r.structure!;
    const partial = s.dmlSites.find(
      (d) => d.form === 'database-method' && d.operation === 'insert',
    )!;
    expect(partial.allOrNone).toBe(false);
    expect(partial.resultDiscarded).toBe(true);
    const assigned = s.dmlSites.find(
      (d) => d.form === 'database-method' && d.operation === 'update',
    )!;
    expect(assigned.allOrNone).toBe(true);
    expect(assigned.resultDiscarded).toBe(false);
    const stmt = s.dmlSites.find((d) => d.form === 'statement')!;
    // A DML statement returns nothing, so "was the result discarded" has no
    // answer — null, not false.
    expect(stmt.resultDiscarded).toBeNull();
    expect(stmt.allOrNone).toBeNull();
  });

  it('leaves allOrNone null when the argument is absent — never defaulted to true', async () => {
    const r = await parse(`
      public class WidgetService {
        public void run(List<Widget__c> rows) { Database.insert(rows); }
      }
    `);
    expect(r.structure!.dmlSites[0]!.allOrNone).toBeNull();
  });

  it('flags an inline query assigned to a single sObject, but not to a collection or a count', async () => {
    const r = await parse(`
      public class WidgetService {
        public void run() {
          Widget__c one = [SELECT Id FROM Widget__c LIMIT 1];
          List<Widget__c> many = [SELECT Id FROM Widget__c];
          Integer total = [SELECT COUNT() FROM Widget__c];
        }
      }
    `);
    const flagged = r.structure!.soqlSites.filter((s) => s.assignedToSingleSObject);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.line).toBe(r.structure!.soqlSites[0]!.line);
  });

  it('recognises an Http receiver declared in this file, and says nothing about a wrapper', async () => {
    const r = await parse(`
      public class WidgetService {
        public void direct(HttpRequest req) {
          Http h = new Http();
          HttpResponse res = h.send(req);
        }
        public void viaWrapper(HttpRequest req) {
          RestClient.post(req);
        }
      }
    `);
    const callouts = r.structure!.calloutSites;
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.kind).toBe('http-send');
    expect(callouts[0]!.inMethod).toBe('direct');
  });

  it('collects async dispatch and dynamic-Apex sites with their loop context', async () => {
    const r = await parse(`
      public class WidgetService {
        public void run(List<Id> ids, String soql) {
          for (Id i : ids) {
            System.enqueueJob(new WidgetJob(i));
          }
          List<SObject> rows = Database.query(soql);
          Type t = Type.forName('WidgetJob');
        }
      }
    `);
    const s = r.structure!;
    expect(s.asyncDispatchSites).toHaveLength(1);
    expect(s.asyncDispatchSites[0]!).toMatchObject({
      kind: 'queueable-enqueue',
      inLoopBody: true,
    });
    expect(s.dynamicApexSites.map((d) => d.kind).sort()).toEqual([
      'dynamic-soql',
      'reflective-type',
    ]);
  });

  it('reports a catch block statement count, so an empty catch is visible', async () => {
    const r = await parse(`
      public class WidgetService {
        public void run() {
          try { Integer i = 1; } catch (DmlException e) { }
          try { Integer j = 2; } catch (Exception e) { System.debug(e); }
        }
      }
    `);
    const counts = r.structure!.catchClauses.map((c) => c.statementCount);
    expect(counts).toEqual([0, 1]);
    expect(r.structure!.catchClauses[0]!.exceptionType).toBe('DmlException');
  });

  it('attributes a site outside any method to no method — null, never a guess', async () => {
    const r = await parse(
      'trigger WidgetTrigger on Widget__c (after insert) { delete Trigger.new; }',
      'trigger',
    );
    expect(r.structure!.dmlSites[0]!.inMethod).toBeNull();
  });
});

describe('parseApexStructure — failure posture', () => {
  it('returns structure: null on a syntax error, NEVER an empty structure', async () => {
    const r = await parse('public class Broken { public void go( { }');
    expect(r.parsed).toBe(false);
    // The whole point: "could not read" must not render as "declares nothing".
    expect(r.structure).toBeNull();
    expect(r.parseErrors.length).toBeGreaterThan(0);
  });

  it('returns structure: null when the source declares no type at all', async () => {
    const r = await parse('   ');
    expect(r.parsed).toBe(false);
    expect(r.structure).toBeNull();
  });

  it('never throws on garbage input', async () => {
    await expect(parse('  not apex at all }}}')).resolves.toMatchObject({
      parsed: false,
      structure: null,
    });
  });
});
