/// <reference types="vitest/globals" />

import { buildApexScannerEdges } from '../src/apex-edges.js';

describe('buildApexScannerEdges — inline SOQL FROM → object readsFrom (P13)', () => {
  it('emits an object-level readsFrom for the inline SOQL FROM object', () => {
    const source = `public class Repo { void run() { List<Account> a = [SELECT Id, Name FROM Account WHERE IsDeleted = false]; } }`;
    const result = buildApexScannerEdges(source, 'ApexClass:Repo');
    const soql = result.edges.find(
      (e) => e.edgeType === 'readsFrom' && e.toId === 'CustomObject:Account',
    );
    expect(soql).toBeDefined();
    expect(soql?.confidence).toBe('heuristic');
    expect(soql?.properties['mechanism']).toBe('soql');
  });

  it('keeps the field-level readsFrom distinct from the object-level one', () => {
    const source = `public class Repo { void run() { for (Account a : [SELECT Id FROM Account]) { String n = a.Name; } } }`;
    const result = buildApexScannerEdges(source, 'ApexClass:Repo');
    const targets = result.edges.filter((e) => e.edgeType === 'readsFrom').map((e) => e.toId);
    expect(targets).toContain('CustomObject:Account'); // SOQL FROM (object-level)
    // The typed for-loop local `Account a` resolves `a.Name` to the object —
    // a SEPARATE field-level readsFrom, distinct from the object-level one.
    expect(targets).toContain('CustomField:Account.Name');
  });

  it('does not mint an object edge for a child-relationship subquery', () => {
    const source = `public class Repo { void run() { List<Account> a = [SELECT Id, (SELECT Id FROM Contacts) FROM Account]; } }`;
    const result = buildApexScannerEdges(source, 'ApexClass:Repo');
    const objs = result.edges
      .filter((e) => e.edgeType === 'readsFrom' && e.toId.startsWith('CustomObject:'))
      .map((e) => e.toId);
    expect(objs).toEqual(['CustomObject:Account']);
    expect(objs).not.toContain('CustomObject:Contacts');
  });
});

describe('buildApexScannerEdges callsApex method-level aggregation (P4-C5)', () => {
  it('aggregates multiple methods of the SAME target class into one edge with a complete methods[]', () => {
    // Foo calls two distinct methods of Handler. Before P4-C5 the
    // (from,to,edgeType) dedup kept only the first methodName, silently
    // dropping the other method-level caller relationship.
    const source = [
      'public class Foo {',
      '  void run() {',
      '    Handler.save(rec);',
      '    Handler.deleteRecord(rec);',
      '  }',
      '}',
    ].join('\n');

    const result = buildApexScannerEdges(source, 'ApexClass:Foo');
    expect(result.warnings).toEqual([]);

    const callsApex = result.edges.filter(
      (e) => e.edgeType === 'callsApex' && e.toId === 'ApexClass:Handler',
    );
    // Exactly ONE edge to Handler (not two), carrying BOTH methods.
    expect(callsApex).toHaveLength(1);
    expect(callsApex[0]?.properties['methods']).toEqual([
      'deleteRecord',
      'save',
    ]);
    // methodName stays as the alphabetically-first for pre-P4-C5 readers.
    expect(callsApex[0]?.properties['methodName']).toBe('deleteRecord');
  });

  it('keeps distinct target classes as separate edges, each with its own methods[]', () => {
    const source = [
      'public class Foo {',
      '  void run() {',
      '    Alpha.one(x);',
      '    Beta.two(y);',
      '    Alpha.three(z);',
      '  }',
      '}',
    ].join('\n');

    const result = buildApexScannerEdges(source, 'ApexClass:Foo');
    const byTarget = new Map(
      result.edges
        .filter((e) => e.edgeType === 'callsApex')
        .map((e) => [e.toId, e.properties['methods']]),
    );
    expect(byTarget.get('ApexClass:Alpha')).toEqual(['one', 'three']);
    expect(byTarget.get('ApexClass:Beta')).toEqual(['two']);
  });

  it('a single-method call still yields methods:[m] and methodName:m (back-compat)', () => {
    const source = 'public class Foo { void run() { Helper.go(); } }';
    const result = buildApexScannerEdges(source, 'ApexClass:Foo');
    const edge = result.edges.find(
      (e) => e.edgeType === 'callsApex' && e.toId === 'ApexClass:Helper',
    );
    expect(edge?.properties['methods']).toEqual(['go']);
    expect(edge?.properties['methodName']).toBe('go');
  });
});

describe('buildApexScannerEdges — drops unresolvable trigger-context phantoms (G3)', () => {
  it('does not emit callsApex to newMap/oldMap (Trigger.newMap/.oldMap parse artifacts)', () => {
    const source = [
      'public class Handler {',
      '  void run(Map<Id, Account> newMap, Map<Id, Account> oldMap) {',
      '    Account a = newMap.get(someId);',
      '    Account b = oldMap.get(someId);',
      '    RealService.process(a);',
      '  }',
      '}',
    ].join('\n');
    const result = buildApexScannerEdges(source, 'ApexClass:Handler');
    const callTargets = result.edges
      .filter((e) => e.edgeType === 'callsApex')
      .map((e) => e.toId);
    expect(callTargets).not.toContain('ApexClass:newMap');
    expect(callTargets).not.toContain('ApexClass:oldMap');
    // A real call is still emitted — no over-filtering.
    expect(callTargets).toContain('ApexClass:RealService');
  });

  it('does not emit field-access edges on the trigger / this / super receivers', () => {
    const source = [
      'public class Handler {',
      '  void run() {',
      '    Object x = trigger.newMap;',
      '    Object y = this.cachedValue;',
      '    Real__c r = realRecord;',
      '    Object z = r.Status__c;',
      '  }',
      '}',
    ].join('\n');
    const result = buildApexScannerEdges(source, 'ApexClass:Handler');
    const fieldTargets = result.edges
      .filter((e) => e.edgeType === 'readsFrom' || e.edgeType === 'writesTo')
      .map((e) => e.toId);
    expect(fieldTargets.some((t) => t.startsWith('CustomField:trigger.'))).toBe(false);
    expect(fieldTargets.some((t) => t.startsWith('CustomField:this.'))).toBe(false);
  });
});

describe('buildApexScannerEdges — EventBus.subscribe → listensTo (P3b)', () => {
  it('mints a heuristic listensTo edge for a resolved static __e channel', () => {
    const source =
      "public class AccountChangeSub { void run() { EventBus.subscribe('Account_Change__e', this); } }";
    const result = buildApexScannerEdges(source, 'ApexClass:AccountChangeSub');
    expect(result.warnings).toEqual([]);
    const listensTo = result.edges.filter((e) => e.edgeType === 'listensTo');
    expect(listensTo).toHaveLength(1);
    expect(listensTo[0]?.toId).toBe('CustomObject:Account_Change__e');
    expect(listensTo[0]?.confidence).toBe('heuristic');
    expect(listensTo[0]?.properties['mechanism']).toBe('eventBusSubscribe');
  });

  it('resolves the /event/ slash-prefixed channel form to the event node', () => {
    const source =
      "public class OrderSub { void run() { EventBus.subscribe('/event/Order_Placed__e', new H()); } }";
    const result = buildApexScannerEdges(source, 'ApexClass:OrderSub');
    const listensTo = result.edges.filter((e) => e.edgeType === 'listensTo');
    expect(listensTo).toHaveLength(1);
    expect(listensTo[0]?.toId).toBe('CustomObject:Order_Placed__e');
  });

  it('mints NO listensTo edge for a dynamic / computed channel arg (no phantom)', () => {
    const source =
      'public class DynSub { void run() { String chan = pick(); EventBus.subscribe(chan, this); } }';
    const result = buildApexScannerEdges(source, 'ApexClass:DynSub');
    expect(result.edges.some((e) => e.edgeType === 'listensTo')).toBe(false);
  });

  it('mints NO listensTo edge for a non-__e channel (e.g. a CDC channel) to keep listensTo Platform-Event-only', () => {
    const source =
      "public class CdcSub { void run() { EventBus.subscribe('Account_ChangeEvent', this); } }";
    const result = buildApexScannerEdges(source, 'ApexClass:CdcSub');
    expect(result.edges.some((e) => e.edgeType === 'listensTo')).toBe(false);
  });
});
