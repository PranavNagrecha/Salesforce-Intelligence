/// <reference types="vitest/globals" />

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { scanApexSource } from '../src/apex-scanner.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const EDU_APEX_FIXTURE_REL =
  'tests/fixtures/edu-org/source/main/default/classes/MRK_ClearLogsBatch.cls';

const wrapClass = (body: string): string =>
  `public class Foo {\n    void run() {\n        ${body}\n    }\n}`;

describe('scanApexSource error cases', () => {
  it('rejects empty input with empty-source', () => {
    const result = scanApexSource('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty-source');
    expect(result.error.offset).toBe(0);
  });

  it('rejects whitespace-only input with empty-source', () => {
    const result = scanApexSource('   \n\t  ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty-source');
  });

  it('rejects source with no class or trigger keyword', () => {
    const result = scanApexSource('// just a comment\nString x = 1;');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-class-or-trigger');
  });

  it('rejects unbalanced outer braces', () => {
    const result = scanApexSource('public class Foo {\n    void run() {\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unbalanced-braces');
  });
});

describe('scanApexSource — empty and trivial cases', () => {
  it('returns empty output for a class with no method bodies', () => {
    const result = scanApexSource(
      'public class Foo {\n    public String name;\n    public static final Integer LIMIT_VAL = 10;\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
    expect(result.value.methodCalls).toEqual([]);
    expect(result.value.methodBodyCount).toBe(0);
  });

  it('reports method body count for a class with one empty method', () => {
    const result = scanApexSource('public class Foo {\n    void run() {}\n}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.methodBodyCount).toBe(1);
  });
});

describe('scanApexSource — EventBus.subscribe channel capture (P3b)', () => {
  it('captures a static __e Platform Event channel literal as an eventSubscription', () => {
    const result = scanApexSource(
      wrapClass(`EventBus.subscribe('Account_Change__e', this);`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eventSubscriptions).toHaveLength(1);
    const sub = result.value.eventSubscriptions[0];
    expect(sub?.channel).toBe('Account_Change__e');
    expect(sub?.resolved).toBe(true);
    expect(typeof sub?.offset).toBe('number');
  });

  it('captures the slash-prefixed event channel form, stripping the /event/ prefix', () => {
    const result = scanApexSource(
      wrapClass(`EventBus.subscribe('/event/Order_Placed__e', new H());`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eventSubscriptions).toHaveLength(1);
    expect(result.value.eventSubscriptions[0]?.channel).toBe('Order_Placed__e');
    expect(result.value.eventSubscriptions[0]?.resolved).toBe(true);
  });

  it('flags a dynamic / computed channel arg as NOT resolved (no phantom)', () => {
    const result = scanApexSource(
      wrapClass(`String chan = buildChannel(); EventBus.subscribe(chan, this);`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // String literals are blanked before scanning, so a variable arg leaves
    // an empty channel — recorded as unresolved, never a fabricated name.
    expect(result.value.eventSubscriptions).toHaveLength(1);
    expect(result.value.eventSubscriptions[0]?.resolved).toBe(false);
  });

  it('does not capture EventBus.publish as a subscription', () => {
    const result = scanApexSource(
      wrapClass(`EventBus.publish(new Account_Change__e());`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eventSubscriptions).toEqual([]);
  });
});

describe('scanApexSource — field writes', () => {
  it('detects a simple assignment as one write', () => {
    const result = scanApexSource(wrapClass(`acc.Industry__c = 'Tech';`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
    const access = result.value.fieldAccesses[0];
    expect(access?.type).toBe('write');
    expect(access?.object).toBe('acc');
    expect(access?.field).toBe('Industry__c');
  });

  it('detects a compound assignment as a write', () => {
    const result = scanApexSource(wrapClass('acc.Revenue__c += 100;'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
    expect(result.value.fieldAccesses[0]?.type).toBe('write');
    expect(result.value.fieldAccesses[0]?.field).toBe('Revenue__c');
  });

  it('detects a postfix increment as a write', () => {
    const result = scanApexSource(wrapClass('acc.Revenue__c++;'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
    expect(result.value.fieldAccesses[0]?.type).toBe('write');
    expect(result.value.fieldAccesses[0]?.field).toBe('Revenue__c');
  });

  it('does not classify equality comparison as a write', () => {
    const result = scanApexSource(
      wrapClass(`if (acc.Industry__c == 'Tech') { System.debug(1); }`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const writes = result.value.fieldAccesses.filter((a) => a.type === 'write');
    expect(writes).toEqual([]);
    const reads = result.value.fieldAccesses.filter((a) => a.type === 'read');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.field).toBe('Industry__c');
  });
});

describe('scanApexSource — field reads', () => {
  it('detects a simple read', () => {
    const result = scanApexSource(wrapClass('String x = acc.Industry__c;'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reads = result.value.fieldAccesses.filter((a) => a.type === 'read');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.field).toBe('Industry__c');
  });

  it('emits one write and one read for mixed RHS-then-LHS use', () => {
    const result = scanApexSource(
      wrapClass('acc.Industry__c = acc.Sector__c;'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const writes = result.value.fieldAccesses.filter((a) => a.type === 'write');
    const reads = result.value.fieldAccesses.filter((a) => a.type === 'read');
    expect(writes.map((w) => w.field)).toEqual(['Industry__c']);
    expect(reads.map((r) => r.field)).toEqual(['Sector__c']);
  });
});

describe('scanApexSource — method calls', () => {
  it('detects a Class.method(...) call', () => {
    const result = scanApexSource(wrapClass('TriggerHandler.process(acc);'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.methodCalls).toHaveLength(1);
    expect(result.value.methodCalls[0]?.className).toBe('TriggerHandler');
    expect(result.value.methodCalls[0]?.methodName).toBe('process');
    expect(result.value.fieldAccesses).toEqual([]);
  });
});

describe('scanApexSource — Schema describe member phantom guard (CALL-GRAPH-PHANTOM-SCHEMA-FIELDS)', () => {
  it('never mints a phantom callsApex against `.fields.getMap()`', () => {
    // `describeResult.fields.getMap()` is the Schema describe idiom — `fields`
    // is a `Map<String, Schema.SObjectField>` accessor, NOT a user Apex class.
    // Before the fix the `IDENT.IDENT(` sweep saw `fields.getMap(` and minted
    // `callsApex ApexClass:fields`, which call_graph rendered as a real callee
    // and get_component mis-classified as a missing / managed-package class.
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    Schema.DescribeSObjectResult d = describeIt();\n' +
        '    Map<String, Schema.SObjectField> fieldMap = d.fields.getMap();\n' +
        '    TriggerHandler.process(fieldMap);\n' +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const callees = result.value.methodCalls.map((c) => c.className);
    // The phantom is gone…
    expect(callees).not.toContain('fields');
    // …but a genuine user call in the same body is still surfaced.
    expect(callees).toContain('TriggerHandler');
  });

  it('never mints a phantom callsApex against `.fieldSets.getMap()`', () => {
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    Schema.DescribeSObjectResult d = describeIt();\n' +
        '    Map<String, Schema.FieldSet> fs = d.fieldSets.getMap();\n' +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.methodCalls.map((c) => c.className)).not.toContain(
      'fieldSets',
    );
  });
});

describe('scanApexSource — declared-local call filtering (phantom-node guard)', () => {
  it('never mints a phantom call edge against a local variable NAME', () => {
    // `acc` / `oldMap` / `helper` are local NAMES, never classes — they must
    // NOT appear as callee class names. `oldMap` (a collection) is dropped;
    // `helper` (a constructed user class) is REDIRECTED to `AccountHelper`
    // (see the dedicated redirect test below), so the name itself is gone.
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    Map<Id, Account> oldMap = new Map<Id, Account>();\n' +
        '    oldMap.put(acc.Id, acc);\n' +
        '    AccountHelper helper = new AccountHelper();\n' +
        '    helper.process();\n' +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const callees = result.value.methodCalls.map((c) => c.className);
    expect(callees).not.toContain('oldMap');
    expect(callees).not.toContain('helper');
    expect(result.value.instantiations.map((i) => i.className)).toContain(
      'AccountHelper',
    );
  });

  it('redirects an instance-local method call to its constructed class type', () => {
    // THE FIX (bugs 18/19/20): `Helper h = new Helper(); h.run()` must mint
    // the real `callsApex ApexClass:Helper` edge — the trigger→helper /
    // class→helper pattern — not drop it (the old behavior, which left only
    // a `references` edge that callsApex-only consumers never followed).
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    AccountHelper helper = new AccountHelper();\n' +
        '    helper.process();\n' +
        '    helper.finish();\n' +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const helperCalls = result.value.methodCalls.filter(
      (c) => c.className === 'AccountHelper',
    );
    expect(helperCalls.map((c) => c.methodName).sort()).toEqual([
      'finish',
      'process',
    ]);
    expect(result.value.methodCalls.map((c) => c.className)).not.toContain(
      'helper',
    );
  });

  it('drops a built-in SObject instance method on a constructed local', () => {
    // `new Account(); a.addError('x')` — `addError` is an SObject API method,
    // not a user-class call, so the redirect is suppressed (no phantom
    // `ApexClass:Account.addError` call edge). A non-SObject method on the
    // same local would redirect (heuristic tier; `targetMissing` hides it).
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    Account a = new Account();\n' +
        "    a.addError('bad');\n" +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.methodCalls.some((c) => c.methodName === 'addError'),
    ).toBe(false);
  });

  it('does NOT redirect a local whose type was not constructed in-body', () => {
    // Conservative: only a local KNOWN to hold a fresh `new Type()` is
    // redirected. `Helper h = factory();` gives no strong type signal, so
    // `h.run()` is dropped (no phantom `ApexClass:h`, no guessed redirect).
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    Helper h = HelperFactory.make();\n' +
        '    h.run();\n' +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const callees = result.value.methodCalls.map((c) => c.className);
    expect(callees).not.toContain('h');
    expect(callees).not.toContain('Helper');
    // The static call on HelperFactory is still captured.
    expect(callees).toContain('HelperFactory');
  });

  it('keeps a static call on a real class alongside a redirected local', () => {
    // Over-filtering guard: a static call on the real class `Service` is
    // kept; the declared local `svc` redirects to `Service.go` (not `svc`).
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    Service svc = new Service();\n' +
        '    Service.staticRun();\n' +
        '    svc.go();\n' +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const calls = result.value.methodCalls;
    const serviceMethods = calls
      .filter((c) => c.className === 'Service')
      .map((c) => c.methodName)
      .sort();
    expect(serviceMethods).toEqual(['go', 'staticRun']);
    expect(calls.map((c) => c.className)).not.toContain('svc');
  });

  it('resolves a declared local receiver to its type (not filtered like calls)', () => {
    // Field accesses on a local are KEPT (only `callsApex` on a local is
    // dropped), and the receiver is RESOLVED to the local's declared type:
    // `Account acc; acc.Region__c` → the real edge `CustomField:Account.Region__c`,
    // not the alias phantom `CustomField:acc.Region__c`.
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    Account acc = new Account();\n' +
        '    String r = acc.Region__c;\n' +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const access = result.value.fieldAccesses.find((a) => a.field === 'Region__c');
    expect(access).toBeDefined();
    expect(access?.object).toBe('Account');
  });

  it('resolves a for-each loop variable to its element type', () => {
    // The canonical case: `for (Account a : accs) { a.Status__c = ... }` —
    // the loop variable `a` resolves to `Account`, minting the real
    // `CustomField:Account.Status__c` edge instead of `CustomField:a.Status__c`.
    const result = scanApexSource(
      'public class Foo {\n  void run(List<Account> accs) {\n' +
        '    for (Account a : accs) {\n' +
        "      a.Status__c = 'Open';\n" +
        '    }\n  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const access = result.value.fieldAccesses.find((a) => a.field === 'Status__c');
    expect(access?.object).toBe('Account');
    expect(access?.type).toBe('write');
  });

  it('does NOT resolve a local declared with conflicting types (conservative)', () => {
    // Two declarations of `x` with different types is ambiguous — keep the
    // alias rather than guess. (`var` and collection types are also excluded.)
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    Account x = new Account();\n' +
        '    Contact x = new Contact();\n' +
        "    x.Foo__c = 'y';\n" +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const access = result.value.fieldAccesses.find((a) => a.field === 'Foo__c');
    expect(access?.object).toBe('x');
  });

  it('drops `this` and `super` call receivers', () => {
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        '    this.cleanup();\n' +
        '    super.init();\n' +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const callees = result.value.methodCalls.map((c) => c.className);
    expect(callees).not.toContain('this');
    expect(callees).not.toContain('super');
  });

  it('drops `this` and `super` field accesses (never an sObject field)', () => {
    // Regression: `this.accounts = x` / `super.config` minted phantom
    // `CustomField:this.accounts` edges that rode into explain_apex_method
    // and what_happens_on_save output.
    const result = scanApexSource(
      'public class Foo {\n  void run() {\n' +
        "    this.accounts = 'x';\n" +
        '    Integer n = super.config;\n' +
        '  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const objects = result.value.fieldAccesses.map((a) => a.object);
    expect(objects).not.toContain('this');
    expect(objects).not.toContain('super');
  });
});

describe('scanApexSource — constructor instantiations', () => {
  it('captures a new ClassName() passed as a method argument', () => {
    // `Dispatcher.Run(new HandlerClass())` names HandlerClass ONLY via
    // the constructor — the IDENT.IDENT( method-call sweep is blind to
    // it. This is the IEEAccountTrigger-shaped case the fix targets.
    const result = scanApexSource(
      wrapClass('IEETriggerDispatcher.Run(new IEEAccountTriggerHandler());'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instantiations.map((i) => i.className)).toContain(
      'IEEAccountTriggerHandler',
    );
    // The method call on the dispatcher is still captured separately.
    expect(
      result.value.methodCalls.some(
        (c) => c.className === 'IEETriggerDispatcher' && c.methodName === 'Run',
      ),
    ).toBe(true);
  });

  it('captures a plain new MyHelper() instantiation', () => {
    const result = scanApexSource(wrapClass('MyHelper h = new MyHelper();'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instantiations).toHaveLength(1);
    const inst = result.value.instantiations[0];
    expect(inst?.className).toBe('MyHelper');
  });

  it('denylists generic collection constructors (List / Map / Set)', () => {
    const result = scanApexSource(
      wrapClass(
        'List<Account> a = new List<Account>(); Map<Id,String> m = new Map<Id,String>(); Set<Id> s = new Set<Id>();',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instantiations).toEqual([]);
  });

  it('deduplicates instantiations by className', () => {
    const result = scanApexSource(
      wrapClass('MyHelper a = new MyHelper(); MyHelper b = new MyHelper(1);'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instantiations).toHaveLength(1);
    expect(result.value.instantiations[0]?.className).toBe('MyHelper');
  });
});

describe('scanApexSource — deduplication', () => {
  it('deduplicates writes by (object, field)', () => {
    const result = scanApexSource(
      wrapClass(`acc.Industry__c = 'A'; acc.Industry__c = 'B';`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
    expect(result.value.fieldAccesses[0]?.type).toBe('write');
  });

  it('deduplicates method calls by (className, methodName)', () => {
    const result = scanApexSource(
      wrapClass('TriggerHandler.process(acc); TriggerHandler.process(acc);'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.methodCalls).toHaveLength(1);
  });
});

describe('scanApexSource — keyword filter', () => {
  it('filters System.X as a static helper, not a field access', () => {
    const result = scanApexSource(wrapClass(`System.debug('hi');`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
    expect(result.value.methodCalls).toEqual([]);
  });

  it('filters String.X', () => {
    const result = scanApexSource(wrapClass('String s = String.valueOf(x);'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
    expect(result.value.methodCalls).toEqual([]);
  });

  it('filters Database.X', () => {
    const result = scanApexSource(
      wrapClass('Database.executeBatch(b, 10);'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.methodCalls).toEqual([]);
  });
});

describe('scanApexSource — comment and string stripping', () => {
  it('ignores writes inside line comments', () => {
    const result = scanApexSource(
      wrapClass(`// acc.Foo__c = 'bar';\nInteger x = 1;`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
  });

  it('ignores accesses inside string literals', () => {
    const result = scanApexSource(
      wrapClass(`String s = 'acc.Foo__c';`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
  });

  it('ignores accesses inside block comments', () => {
    const result = scanApexSource(
      wrapClass('/* acc.Foo__c = 1; */ Integer x = 1;'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
  });
});

describe('scanApexSource — outer-body scanning', () => {
  it('scans a single-statement trigger body (no inner braces)', () => {
    const result = scanApexSource(
      'trigger T on Account (before insert) { OtherClass.doStuff(); }',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.methodCalls).toHaveLength(1);
    expect(result.value.methodCalls[0]?.className).toBe('OtherClass');
    expect(result.value.methodCalls[0]?.methodName).toBe('doStuff');
    expect(result.value.fieldAccesses).toEqual([]);
    // methodBodyCount counts inner brace-balanced regions only — a
    // single-statement trigger body has none.
    expect(result.value.methodBodyCount).toBe(0);
  });

  it('scans a class field initializer with a method call', () => {
    const result = scanApexSource(
      'public class C { public Object cached = Registry.fetch(); }',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.methodCalls).toHaveLength(1);
    expect(result.value.methodCalls[0]?.className).toBe('Registry');
    expect(result.value.methodCalls[0]?.methodName).toBe('fetch');
    expect(result.value.fieldAccesses).toEqual([]);
    expect(result.value.methodBodyCount).toBe(0);
  });

  it('scans a class field initializer with a field read', () => {
    const result = scanApexSource(
      'public class C { public String x = obj.fieldName; }',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toHaveLength(1);
    const access = result.value.fieldAccesses[0];
    expect(access?.type).toBe('read');
    expect(access?.object).toBe('obj');
    expect(access?.field).toBe('fieldName');
    expect(result.value.methodCalls).toEqual([]);
  });

  it('dedupes across outer body and inner method body, keeping the outer offset', () => {
    const source =
      'public class C { public Object x = Reg.fetch(); void run() { Reg.fetch(); } }';
    const result = scanApexSource(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.methodCalls).toHaveLength(1);
    const call = result.value.methodCalls[0];
    expect(call?.className).toBe('Reg');
    expect(call?.methodName).toBe('fetch');
    // The first source-order occurrence is the outer field initializer.
    // Its offset must be the byte index of `Reg` in the original
    // source — earlier than the inner call inside `run() { ... }`.
    const expectedOffset = source.indexOf('Reg.fetch()');
    expect(call?.offset).toBe(expectedOffset);
  });
});

describe('scanApexSource — inline SOQL FROM objects (P13)', () => {
  const objects = (body: string): string[] => {
    const r = scanApexSource(wrapClass(body));
    if (!r.ok) return [];
    return r.value.soqlFromObjects.map((s) => s.object);
  };

  it('captures the primary object of a simple inline query', () => {
    expect(objects(`List<Account> a = [SELECT Id, Name FROM Account WHERE Id != null];`)).toEqual([
      'Account',
    ]);
  });

  it('captures a __c / __mdt object and a SOQL-for-loop query', () => {
    expect(objects(`for (Payment__c p : [SELECT Id FROM Payment__c]) { }`)).toEqual(['Payment__c']);
    expect(objects(`List<X> x = [SELECT Id FROM My_Setting__mdt LIMIT 1];`)).toEqual([
      'My_Setting__mdt',
    ]);
  });

  it('takes the top-level FROM and SKIPS child-relationship subqueries', () => {
    // The subquery FROM (Contacts) is a relationship, not an SObject — it must
    // NOT become an edge. Only the depth-0 Account is captured.
    expect(
      objects(`List<Account> a = [SELECT Id, (SELECT Id FROM Contacts) FROM Account];`),
    ).toEqual(['Account']);
  });

  it('captures a semi-join subquery FROM — it names a real SObject the query reads', () => {
    expect(
      objects(`List<Account> a = [SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)];`),
    ).toEqual(['Account', 'Contact']);
  });

  it('captures a NOT IN anti-join subquery FROM', () => {
    expect(
      objects(`List<Lead> l = [SELECT Id FROM Lead WHERE Id NOT IN (SELECT Lead__c FROM Application__c)];`),
    ).toEqual(['Lead', 'Application__c']);
  });

  it('captures nested semi-joins while still skipping a child-relationship subquery', () => {
    expect(
      objects(
        `List<A__c> r = [SELECT Id, (SELECT Id FROM Items__r) FROM A__c WHERE X__c IN (SELECT Y__c FROM B__c WHERE Z__c IN (SELECT W__c FROM C__c))];`,
      ),
    ).toEqual(['A__c', 'B__c', 'C__c']);
  });

  it('does not treat a non-IN parenthesized clause as a semi-join', () => {
    // Parens in a WHERE boolean group contain no FROM; the only capture is the
    // primary object. (A child-rel subquery inside a semi-join stays skipped.)
    expect(
      objects(
        `List<Case> c = [SELECT Id FROM Case WHERE (Status = NULL OR Origin = NULL) AND Id IN (SELECT CaseId FROM CaseComment)];`,
      ),
    ).toEqual(['Case', 'CaseComment']);
  });

  it('is blind to dynamic SOQL in a string literal (the documented blind spot)', () => {
    expect(objects(`String q = 'SELECT Id FROM Account'; List<sObject> r = Database.query(q);`)).toEqual(
      [],
    );
  });

  it('never treats plain list/array indexing as SOQL', () => {
    expect(objects(`Account a = accs[0]; Integer n = nums[i];`)).toEqual([]);
  });

  it('dedupes repeated queries on the same object, first occurrence wins', () => {
    const r = scanApexSource(
      wrapClass(`List<Account> a = [SELECT Id FROM Account]; Integer c = [SELECT count() FROM Account];`),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.soqlFromObjects.map((s) => s.object)).toEqual(['Account']);
  });

  it('reports an offset that points at the object name in source', () => {
    const src = wrapClass(`List<Lead> l = [SELECT Id FROM Lead];`);
    const r = scanApexSource(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [hit] = r.value.soqlFromObjects;
    expect(hit?.object).toBe('Lead');
    expect(src.slice(hit?.offset ?? 0, (hit?.offset ?? 0) + (hit?.length ?? 0))).toBe('Lead');
  });
});

describe('scanApexSource — determinism and real fixture', () => {
  it('returns identical output for repeated calls', () => {
    const source = wrapClass(
      `acc.Industry__c = 'A'; String x = acc.Sector__c; TriggerHandler.process(acc);`,
    );
    const a = scanApexSource(source);
    const b = scanApexSource(source);
    expect(a).toEqual(b);
  });

  itHarness('produces a non-empty structured result for an edu-org Apex file', async () => {
    const fixturePath = resolve(HARNESS_ROOT, EDU_APEX_FIXTURE_REL);
    const source = await readFile(fixturePath, 'utf-8');
    const result = scanApexSource(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.methodBodyCount).toBeGreaterThan(0);
    // The fixture references mainMarketoSetting.<field> several times.
    const reads = result.value.fieldAccesses.filter((a) => a.type === 'read');
    expect(reads.some((r) => r.object === 'mainMarketoSetting')).toBe(true);
  });
});

describe('scanApexSource — managed-package namespaced local types (LOCAL_DECL_PATTERN)', () => {
  it('resolves a lowercase-namespaced for-each loop variable to its api name, not the alias', () => {
    // `ns__Obj__c` is a managed-package namespaced api name: it starts
    // LOWERCASE and contains `__`. Before the namespace branch, LOCAL_DECL_PATTERN
    // learned only PascalCase types, so `rec` stayed untyped and
    // `rec.My_Field__c = …` fell back to the literal-receiver phantom
    // (`CustomField:rec.My_Field__c`). Now the loop var resolves to the object.
    const result = scanApexSource(
      'public class W {\n  void run(List<ns__Obj__c> items) {\n' +
        '    for (ns__Obj__c rec : items) {\n' +
        '      rec.My_Field__c = 1;\n' +
        '    }\n  }\n}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const write = result.value.fieldAccesses.find((a) => a.field === 'My_Field__c');
    expect(write?.type).toBe('write');
    expect(write?.object).toBe('ns__Obj__c');
    // the alias receiver is gone — no phantom keyed on the loop variable name.
    expect(result.value.fieldAccesses.map((a) => a.object)).not.toContain('rec');
  });

  it('the __-less guard: a primitive local and a bare keyword mint no phantom access', () => {
    // The lowercase-type branch REQUIRES `__`, so `Integer i` (a primitive,
    // no `__`) and `return foo` (a bare lowercase keyword, no `__`) can never
    // be misread as a namespaced declaration → no field access at all.
    const result = scanApexSource(wrapClass('Integer i = 0; return foo;'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fieldAccesses).toEqual([]);
  });
});
