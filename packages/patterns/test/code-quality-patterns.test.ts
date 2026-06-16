/// <reference types="vitest/globals" />

import {
  countAssertions,
  detectCodeQualityIssues,
  type QualityIssue,
} from '../src/code-quality-patterns.js';

/**
 * Convenience: run the recognizer family with sensible defaults for
 * non-test, current-API-version classes so individual tests don't
 * have to thread the metadata bag.
 */
const run = (
  source: string,
  overrides: { apiVersion?: number; isTest?: boolean } = {},
): readonly QualityIssue[] =>
  detectCodeQualityIssues(source, {
    apiVersion: overrides.apiVersion ?? 58,
    isTest: overrides.isTest ?? false,
  });

const rulesOf = (issues: readonly QualityIssue[]): readonly string[] =>
  issues.map((i) => i.rule);

describe('detectCodeQualityIssues — soql-in-loop', () => {
  it('flags an inline SOQL inside a for-loop', () => {
    const src = `public class Svc {
      public static void run(List<Id> ids) {
        for (Id id : ids) {
          Account a = [SELECT Id FROM Account WHERE Id = :id];
        }
      }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('soql-in-loop');
    const soql = issues.find((i) => i.rule === 'soql-in-loop');
    expect(soql?.severity).toBe('critical');
    expect(soql?.confidence).toBe('heuristic');
  });

  it('does not flag SOQL outside the loop', () => {
    const src = `public class Svc {
      public static void run(List<Id> ids) {
        List<Account> accs = [SELECT Id FROM Account WHERE Id IN :ids];
        for (Account a : accs) { a.Name = 'x'; }
      }
    }`;
    expect(rulesOf(run(src))).not.toContain('soql-in-loop');
  });

  it('flags Database.query inside a while loop', () => {
    const src = `public class Svc {
      public static void run() {
        Integer i = 0;
        while (i < 5) {
          List<Account> a = Database.query('SELECT Id FROM Account');
          i++;
        }
      }
    }`;
    expect(rulesOf(run(src))).toContain('soql-in-loop');
  });

  it('reports a SOQL in NESTED loops exactly ONCE (no per-enclosing-loop dup)', () => {
    const src = `public class Svc {
      public static void run(List<List<Id>> groups) {
        for (List<Id> g : groups) {
          for (Id id : g) {
            Account a = [SELECT Id FROM Account WHERE Id = :id];
          }
        }
      }
    }`;
    const soql = run(src).filter((i) => i.rule === 'soql-in-loop');
    expect(soql).toHaveLength(1);
  });
});

describe('detectCodeQualityIssues — dml-in-loop', () => {
  it('flags `update` DML inside a for-loop', () => {
    const src = `public class Svc {
      public static void run(List<Opportunity> opps) {
        for (Opportunity o : opps) {
          o.StageName = 'Closed Won';
          update o;
        }
      }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('dml-in-loop');
    expect(
      issues.find((i) => i.rule === 'dml-in-loop')?.severity,
    ).toBe('critical');
  });

  it('does not flag DML on a collection after the loop', () => {
    const src = `public class Svc {
      public static void run(List<Opportunity> opps) {
        for (Opportunity o : opps) { o.StageName = 'Closed Won'; }
        update opps;
      }
    }`;
    expect(rulesOf(run(src))).not.toContain('dml-in-loop');
  });

  it('flags Database.delete inside a for-loop', () => {
    const src = `public class Svc {
      public static void run(List<Account> accs) {
        for (Account a : accs) { Database.delete(a); }
      }
    }`;
    expect(rulesOf(run(src))).toContain('dml-in-loop');
  });

  it('reports a DML in NESTED loops exactly ONCE (no per-enclosing-loop dup)', () => {
    // The statement falls inside both the outer and inner loop bodies; the
    // recognizer must not emit one finding per enclosing loop (regression:
    // a 3-deep nest produced three identical findings at the same line).
    const src = `public class Svc {
      public static void run(List<List<Account>> groups) {
        for (List<Account> g : groups) {
          for (Account a : g) {
            update a;
          }
        }
      }
    }`;
    const dml = run(src).filter((i) => i.rule === 'dml-in-loop');
    expect(dml).toHaveLength(1);
  });

  it('still reports TWO distinct DML statements on the same line (no over-dedup)', () => {
    const src = `public class Svc {
      public static void run(List<Account> accs) {
        for (Account a : accs) { insert a; update a; }
      }
    }`;
    const dml = run(src).filter((i) => i.rule === 'dml-in-loop');
    expect(dml).toHaveLength(2);
  });
});

describe('detectCodeQualityIssues — hardcoded-id', () => {
  it('flags a 15-character Salesforce ID literal with a known prefix', () => {
    const src = `public class Cfg {
      public static String adminProfileId = '00e000000000001';
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('hardcoded-id');
    const h = issues.find((i) => i.rule === 'hardcoded-id');
    expect(h?.severity).toBe('medium');
  });

  it('flags an 18-character Salesforce ID literal', () => {
    const src = `public class Cfg {
      public static String accId = '001000000000001AAA';
    }`;
    expect(rulesOf(run(src))).toContain('hardcoded-id');
  });

  it('does not flag a string that looks like an ID but has an unknown prefix', () => {
    const src = `public class Cfg {
      public static String x = 'XYZabcdefghi1234';
    }`;
    expect(rulesOf(run(src))).not.toContain('hardcoded-id');
  });

  it('does not flag a short string', () => {
    const src = `public class Cfg {
      public static String s = 'admin';
    }`;
    expect(rulesOf(run(src))).not.toContain('hardcoded-id');
  });
});

describe('detectCodeQualityIssues — dynamic-apex honesty signal (P4-dynamic-patterns)', () => {
  it('flags dynamic SOQL (Database.query) as an info-severity honesty signal', () => {
    const src = `public class Svc {
      List<sObject> run(String q) { return Database.query(q); }
    }`;
    const issues = run(src);
    const d = issues.find((i) => i.rule === 'dynamic-apex');
    expect(d).toBeDefined();
    expect(d?.severity).toBe('info');
    expect(d?.explanation).toMatch(/INVISIBLE to static dependency analysis/);
  });

  it('flags Schema.getGlobalDescribe and Type.forName', () => {
    const src = `public class Svc {
      void a() { Map<String,Schema.SObjectType> m = Schema.getGlobalDescribe(); }
      void b() { Type t = Type.forName('Account'); }
    }`;
    const rules = rulesOf(run(src)).filter((r) => r === 'dynamic-apex');
    // One finding per construct KIND → two here.
    expect(rules).toHaveLength(2);
  });

  it('dedupes by construct kind — many Database.query calls yield ONE finding', () => {
    const src = `public class Svc {
      void a() { Database.query('SELECT Id FROM Account'); }
      void b() { Database.query('SELECT Id FROM Contact'); }
      void c() { Database.query('SELECT Id FROM Lead'); }
    }`;
    const dyn = rulesOf(run(src)).filter((r) => r === 'dynamic-apex');
    expect(dyn).toHaveLength(1);
  });

  it('does not flag static SOQL or a Database.query inside a comment', () => {
    const src = `public class Svc {
      // Database.query is mentioned here in a comment only
      List<Account> a = [SELECT Id FROM Account];
    }`;
    expect(rulesOf(run(src))).not.toContain('dynamic-apex');
  });
});

describe('detectCodeQualityIssues — hardcoded-url (P4-hardcoded-scan)', () => {
  it('flags an external endpoint URL baked into Apex', () => {
    const src = `public class Svc {
      public static String endpoint = 'https://api.example.com/v1/sync';
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('hardcoded-url');
    const h = issues.find((i) => i.rule === 'hardcoded-url');
    expect(h?.severity).toBe('medium');
    expect(h?.explanation).toMatch(/Named Credential/);
  });

  it('flags a plain http external URL too', () => {
    const src = `public class Svc { String u = 'http://legacy.partner.io/hook'; }`;
    expect(rulesOf(run(src))).toContain('hardcoded-url');
  });

  it('does NOT flag a Salesforce platform domain (namespace/domain-aware skip)', () => {
    const src = `public class Svc {
      String a = 'https://mydomain.my.salesforce.com/services/data';
      String b = 'https://acme.force.com/portal';
      String c = 'https://acme.visualforce.com/apex/Page';
    }`;
    expect(rulesOf(run(src))).not.toContain('hardcoded-url');
  });

  it('does not flag a non-URL string', () => {
    const src = `public class Svc { String s = 'just a label'; }`;
    expect(rulesOf(run(src))).not.toContain('hardcoded-url');
  });
});

describe('detectCodeQualityIssues — hardcoded-email', () => {
  it('flags a single hardcoded email literal', () => {
    const src = `public class Alert {
      public static void notify() {
        String to = 'admin@example.com';
      }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('hardcoded-email');
    expect(
      issues.find((i) => i.rule === 'hardcoded-email')?.severity,
    ).toBe('low');
  });

  it('does not flag arbitrary text that looks email-ish but is not', () => {
    const src = `public class A {
      public static String s = 'foo at bar dot com';
    }`;
    expect(rulesOf(run(src))).not.toContain('hardcoded-email');
  });
});

describe('detectCodeQualityIssues — hardcoded-username', () => {
  it('flags a Salesforce username with `.dev` suffix', () => {
    const src = `public class Audit {
      public static void u() {
        String username = 'audit@example.com.dev';
      }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('hardcoded-username');
    expect(
      issues.find((i) => i.rule === 'hardcoded-username')?.severity,
    ).toBe('medium');
  });

  it('flags a Salesforce username with `.sandbox` suffix', () => {
    const src = `public class A {
      public static String u = 'me@example.com.sandbox';
    }`;
    expect(rulesOf(run(src))).toContain('hardcoded-username');
  });

  it('does not double-report a plain email as both email and username', () => {
    const src = `public class A {
      public static String u = 'me@example.com';
    }`;
    const rules = rulesOf(run(src));
    expect(rules).toContain('hardcoded-email');
    expect(rules).not.toContain('hardcoded-username');
  });
});

describe('detectCodeQualityIssues — missing-crud-check', () => {
  it('flags an `insert` without a preceding CRUD check', () => {
    const src = `public class Svc {
      public static void create(Account a) { insert a; }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('missing-crud-check');
    expect(
      issues.find((i) => i.rule === 'missing-crud-check')?.severity,
    ).toBe('high');
  });

  it('does not flag DML preceded by Schema.sObjectType.X.isCreateable()', () => {
    const src = `public class Svc {
      public static void create(Account a) {
        if (Schema.sObjectType.Account.isCreateable()) { insert a; }
      }
    }`;
    expect(rulesOf(run(src))).not.toContain('missing-crud-check');
  });

  it('does not flag DML in a test class', () => {
    const src = `@isTest
    public class SvcTest {
      @isTest static void t() { Account a = new Account(); insert a; }
    }`;
    expect(rulesOf(run(src, { isTest: true }))).not.toContain(
      'missing-crud-check',
    );
  });

  it('does not flag when WITH SECURITY_ENFORCED is used upstream', () => {
    const src = `public class Svc {
      public static void run() {
        Account a = [SELECT Id FROM Account WHERE Id = :id WITH SECURITY_ENFORCED];
        update a;
      }
    }`;
    expect(rulesOf(run(src))).not.toContain('missing-crud-check');
  });
});

describe('detectCodeQualityIssues — missing-fls-check', () => {
  it('flags an inline SOQL without WITH SECURITY_ENFORCED', () => {
    const src = `public class C {
      public static String getEmail(Id cid) {
        Contact c = [SELECT Email FROM Contact WHERE Id = :cid];
        return c.Email;
      }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('missing-fls-check');
    expect(
      issues.find((i) => i.rule === 'missing-fls-check')?.severity,
    ).toBe('high');
  });

  it('does not flag SOQL with WITH SECURITY_ENFORCED', () => {
    const src = `public class C {
      public static String getEmail(Id cid) {
        Contact c = [SELECT Email FROM Contact WHERE Id = :cid WITH SECURITY_ENFORCED];
        return c.Email;
      }
    }`;
    expect(rulesOf(run(src))).not.toContain('missing-fls-check');
  });

  it('does not flag SOQL in a test class', () => {
    const src = `@isTest
    public class C {
      @isTest static void t() {
        Contact c = [SELECT Email FROM Contact LIMIT 1];
      }
    }`;
    expect(rulesOf(run(src, { isTest: true }))).not.toContain(
      'missing-fls-check',
    );
  });
});

describe('detectCodeQualityIssues — soql-injection', () => {
  it('flags a Database.query call built from string concatenation with a variable', () => {
    const src = `public class S {
      public static void search(String input) {
        String q = 'SELECT Id FROM Account WHERE Name = \\'' + input + '\\'';
        Database.query(q);
      }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('soql-injection');
    expect(
      issues.find((i) => i.rule === 'soql-injection')?.severity,
    ).toBe('critical');
  });

  it('does not flag a binding-variable inline SOQL', () => {
    const src = `public class S {
      public static void search(String input) {
        List<Account> a = [SELECT Id FROM Account WHERE Name = :input];
      }
    }`;
    expect(rulesOf(run(src))).not.toContain('soql-injection');
  });

  it('does not flag Database.query with a String.escapeSingleQuotes input', () => {
    const src = `public class S {
      public static void search(String input) {
        String escaped = String.escapeSingleQuotes(input);
        Database.query('SELECT Id FROM Account WHERE Name = \\'' + escaped + '\\'');
      }
    }`;
    // Should not flag — the only variable in the concatenation is `escaped`,
    // which was assigned from `String.escapeSingleQuotes`.
    const issues = run(src);
    expect(issues.filter((i) => i.rule === 'soql-injection')).toHaveLength(0);
  });
});

describe('detectCodeQualityIssues — without-sharing-no-comment', () => {
  it('flags `public without sharing class` with no preceding comment', () => {
    const src = `public without sharing class TaxCalc {
      public static Decimal calc(Decimal a) { return a; }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('without-sharing-no-comment');
    expect(
      issues.find((i) => i.rule === 'without-sharing-no-comment')?.severity,
    ).toBe('medium');
  });

  it('does not flag when a substantive comment precedes the declaration', () => {
    const src = `// Calculates tax across all accounts regardless of sharing.
// Intentional cross-org reporting bypass.
public without sharing class TaxCalc {
  public static Decimal calc(Decimal a) { return a; }
}`;
    expect(rulesOf(run(src))).not.toContain('without-sharing-no-comment');
  });
});

describe('detectCodeQualityIssues — trigger-no-recursion-guard', () => {
  it('flags a trigger with no recognizable guard', () => {
    const src = `trigger AccountTrigger on Account (before update) {
      for (Account a : Trigger.new) {
        a.Name = 'updated';
      }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('trigger-no-recursion-guard');
    expect(
      issues.find((i) => i.rule === 'trigger-no-recursion-guard')?.severity,
    ).toBe('medium');
  });

  it('does not flag a trigger using a static Boolean guard', () => {
    const src = `trigger AccountTrigger on Account (before update) {
      if (TriggerHandler.isFirstRun) {
        TriggerHandler.isFirstRun = false;
      }
    }`;
    expect(rulesOf(run(src))).not.toContain('trigger-no-recursion-guard');
  });

  it('does not flag a non-trigger class', () => {
    const src = `public class NotATrigger { public static void run() {} }`;
    expect(rulesOf(run(src))).not.toContain('trigger-no-recursion-guard');
  });
});

describe('detectCodeQualityIssues — old-api-version', () => {
  it('flags apiVersion 30', () => {
    const src = `public class A {}`;
    const issues = run(src, { apiVersion: 30 });
    expect(rulesOf(issues)).toContain('old-api-version');
    expect(
      issues.find((i) => i.rule === 'old-api-version')?.severity,
    ).toBe('low');
  });

  it('does not flag apiVersion 58', () => {
    const src = `public class A {}`;
    expect(rulesOf(run(src, { apiVersion: 58 }))).not.toContain(
      'old-api-version',
    );
  });

  it('does not flag apiVersion 50 (boundary inclusive)', () => {
    const src = `public class A {}`;
    expect(rulesOf(run(src, { apiVersion: 50 }))).not.toContain(
      'old-api-version',
    );
  });
});

describe('detectCodeQualityIssues — database-upsert-no-options', () => {
  it('flags Database.upsert with a single argument', () => {
    const src = `public class L {
      public static void up(List<Lead> ls) { Database.upsert(ls); }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('database-upsert-no-options');
    expect(
      issues.find((i) => i.rule === 'database-upsert-no-options')?.severity,
    ).toBe('medium');
  });

  it('does not flag Database.upsert with two arguments (records, false)', () => {
    const src = `public class L {
      public static void up(List<Lead> ls) { Database.upsert(ls, false); }
    }`;
    expect(rulesOf(run(src))).not.toContain('database-upsert-no-options');
  });
});

describe('detectCodeQualityIssues — fake-assertion', () => {
  it('flags System.assert(true) in a test class', () => {
    const src = `@isTest
    public class T {
      @isTest static void t() { System.assert(true); }
    }`;
    const issues = run(src, { isTest: true });
    expect(rulesOf(issues)).toContain('fake-assertion');
    expect(
      issues.find((i) => i.rule === 'fake-assertion')?.severity,
    ).toBe('high');
  });

  it('flags System.assertEquals(x, x) in a test class', () => {
    const src = `@isTest
    public class T {
      @isTest static void t() { Integer x = 5; System.assertEquals(x, x); }
    }`;
    expect(rulesOf(run(src, { isTest: true }))).toContain('fake-assertion');
  });

  it('does not flag real assertions in a test class', () => {
    const src = `@isTest
    public class T {
      @isTest static void t() {
        Account a = new Account(Name = 'Test');
        System.assertEquals('Test', a.Name);
      }
    }`;
    expect(rulesOf(run(src, { isTest: true }))).not.toContain('fake-assertion');
  });

  it('does not flag fake assertions in a non-test class', () => {
    const src = `public class T { public static void t() { System.assert(true); } }`;
    expect(rulesOf(run(src, { isTest: false }))).not.toContain('fake-assertion');
  });
});

describe('detectCodeQualityIssues — hardcoded-sandbox-test-data', () => {
  it('flags a sandbox URL literal in a test class', () => {
    const src = `@isTest
    public class O {
      @isTest static void t() {
        String u = 'https://example.lightning.force.com/sandbox/oauth/callback';
      }
    }`;
    const issues = run(src, { isTest: true });
    expect(rulesOf(issues)).toContain('hardcoded-sandbox-test-data');
    expect(
      issues.find((i) => i.rule === 'hardcoded-sandbox-test-data')?.severity,
    ).toBe('medium');
  });

  it('does not flag the same literal in a non-test class', () => {
    const src = `public class O {
      public static String u = 'https://example.lightning.force.com/sandbox/x';
    }`;
    expect(rulesOf(run(src, { isTest: false }))).not.toContain(
      'hardcoded-sandbox-test-data',
    );
  });
});

describe('detectCodeQualityIssues — swallowed-exception', () => {
  it('flags an empty catch block', () => {
    const src = `public class A {
      public static void run() {
        try { Integer i = 1; } catch (Exception e) {}
      }
    }`;
    const issues = run(src);
    expect(rulesOf(issues)).toContain('swallowed-exception');
    expect(
      issues.find((i) => i.rule === 'swallowed-exception')?.severity,
    ).toBe('high');
  });

  it('flags a System.debug-only catch block', () => {
    const src = `public class A {
      public static void run() {
        try { Integer i = 1; } catch (Exception e) { System.debug(e.getMessage()); }
      }
    }`;
    expect(rulesOf(run(src))).toContain('swallowed-exception');
  });

  it('does not flag a catch block that rethrows', () => {
    const src = `public class A {
      public static void run() {
        try { Integer i = 1; } catch (Exception e) { throw new AuraHandledException(e.getMessage()); }
      }
    }`;
    expect(rulesOf(run(src))).not.toContain('swallowed-exception');
  });
});

describe('detectCodeQualityIssues — module behavior', () => {
  it('returns an empty array for a clean class', () => {
    const src = `// Standard service class.
public with sharing class CleanSvc {
  public static Integer doMath(Integer a, Integer b) { return a + b; }
}`;
    const issues = run(src);
    expect(issues).toHaveLength(0);
  });

  it('returns an empty array for empty / whitespace-only input', () => {
    expect(run('')).toHaveLength(0);
    expect(run('   \n  ')).toHaveLength(0);
  });

  it('sorts issues by source line (stable across calls)', () => {
    const src = `public class S {
      public static void run(List<Id> ids) {
        for (Id id : ids) {
          insert new Account();
          Account a = [SELECT Id FROM Account WHERE Id = :id];
        }
      }
    }`;
    const a = run(src);
    const b = run(src);
    expect(a).toEqual(b);
    // Each issue's location embeds the line number, monotonically non-decreasing.
    const lines = a
      .map((i) => Number(/line\s+(\d+)/.exec(i.location)?.[1] ?? 0))
      .filter((n) => n > 0);
    for (let i = 1; i < lines.length; i += 1) {
      const cur = lines[i];
      const prev = lines[i - 1];
      if (cur !== undefined && prev !== undefined) {
        expect(cur).toBeGreaterThanOrEqual(prev);
      }
    }
  });

  it('all issues carry confidence: heuristic', () => {
    const src = `public without sharing class A {
      public static void run() {
        insert new Account();
        try { Integer i = 1; } catch (Exception e) {}
      }
    }`;
    const issues = run(src);
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      expect(i.confidence).toBe('heuristic');
    }
  });

  it('reports a recognizable rule id per finding', () => {
    const src = `public class A {
      public static void run() { insert new Account(); }
    }`;
    const issues = run(src);
    expect(issues.every((i) => typeof i.rule === 'string' && i.rule.length > 0)).toBe(true);
  });
});

describe('countAssertions', () => {
  it('counts every System.assert* invocation', () => {
    const src = `@isTest class T {
      static void m() {
        System.assertEquals(1, x);
        System.assert(y);
        System.assertNotEquals(a, b);
      }
    }`;
    expect(countAssertions(src)).toBe(3);
  });

  it('counts the modern Assert.* class (bare and System-qualified)', () => {
    const src = `@isTest class T {
      static void m() {
        Assert.areEqual(1, x);
        Assert.isTrue(y);
        Assert.isNotNull(z);
        System.Assert.areNotEqual(a, b);
      }
    }`;
    expect(countAssertions(src)).toBe(4);
  });

  it('counts a mix of System.assert* and Assert.* in one class', () => {
    const src = `@isTest class T {
      static void m() {
        System.assertEquals(1, x);
        Assert.isTrue(y);
      }
    }`;
    expect(countAssertions(src)).toBe(2);
  });

  it('ignores assertions inside comments and string literals', () => {
    const src = `@isTest class T {
      static void m() {
        // System.assertEquals(1, 1) in a comment does not count
        String s = 'Assert.isTrue(true) in a string';
        System.assert(real);
      }
    }`;
    expect(countAssertions(src)).toBe(1);
  });

  it('returns 0 for source with no assertions', () => {
    expect(countAssertions('class T { void m() { Integer i = 0; } }')).toBe(0);
  });
});
