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

// APEX-SOBJECT-REF-MINTED-AS-APEXCLASS: sObject / custom-setting tokens used in
// Apex (a static custom-setting call, an sObject constructor) were projected as
// callsApex/references to ApexClass:{token} phantoms while the real CustomObject
// node stayed graph-orphan. Object-suffixed tokens must route to CustomObject.
describe('buildApexScannerEdges — sObject/custom-setting tokens route to CustomObject, not ApexClass (APEX-SOBJECT-REF-MINTED-AS-APEXCLASS)', () => {
  it('routes a static custom-setting call (X__c.getOrgDefaults()) to references CustomObject, not callsApex ApexClass', () => {
    const source = [
      'public class CalcBatch {',
      '  void run() {',
      '    Widget_Setting__c cfg = Widget_Setting__c.getOrgDefaults();',
      '  }',
      '}',
    ].join('\n');
    const result = buildApexScannerEdges(source, 'ApexClass:CalcBatch');
    // No phantom ApexClass for the custom-setting token.
    expect(
      result.edges.some((e) => e.toId === 'ApexClass:Widget_Setting__c'),
    ).toBe(false);
    // The real object node gets a references edge instead.
    const objRef = result.edges.find(
      (e) => e.toId === 'CustomObject:Widget_Setting__c' && e.edgeType === 'references',
    );
    expect(objRef).toBeDefined();
    expect(objRef?.properties['mechanism']).toBe('apexStaticObjectRef');
  });

  it('routes a new X__c() sObject constructor to references CustomObject, not ApexClass', () => {
    const source =
      'public class Maker { void run() { Widget__c p = new Widget__c(); } }';
    const result = buildApexScannerEdges(source, 'ApexClass:Maker');
    expect(result.edges.some((e) => e.toId === 'ApexClass:Widget__c')).toBe(false);
    const objRef = result.edges.find(
      (e) => e.toId === 'CustomObject:Widget__c' && e.edgeType === 'references',
    );
    expect(objRef).toBeDefined();
    expect(objRef?.properties['mechanism']).toBe('instantiation');
  });

  it('keeps a managed-namespaced object token (ns__Widget__c) off the ApexClass family', () => {
    const source =
      'public class Svc { void run() { ns__Widget__c.getAll(); } }';
    const result = buildApexScannerEdges(source, 'ApexClass:Svc');
    expect(
      result.edges.some((e) => e.toId === 'ApexClass:ns__Widget__c'),
    ).toBe(false);
    expect(
      result.edges.some((e) => e.toId === 'CustomObject:ns__Widget__c'),
    ).toBe(true);
  });

  it('does NOT reroute a real Apex class call/instantiation (no false CustomObject)', () => {
    const source =
      'public class Foo { void run() { Handler.go(); Helper h = new Helper(); } }';
    const result = buildApexScannerEdges(source, 'ApexClass:Foo');
    expect(
      result.edges.some((e) => e.toId === 'ApexClass:Handler' && e.edgeType === 'callsApex'),
    ).toBe(true);
    expect(
      result.edges.some((e) => e.toId === 'ApexClass:Helper' && e.edgeType === 'references'),
    ).toBe(true);
    expect(result.edges.some((e) => e.toId.startsWith('CustomObject:'))).toBe(false);
  });
});

// APEX-STATIC-FIELD-CUSTOMFIELD-PHANTOMS: Apex static fields on utility classes
// (WidgetGuard.guardBefore) were minted as CustomField:{Class}.{field} phantoms,
// stealing the usage from the real ApexClass:{Class}. A camelCase-no-`__` member
// on a PascalCase class token must route to references ApexClass instead.
describe('buildApexScannerEdges — Apex static fields route to references ApexClass, not CustomField (APEX-STATIC-FIELD-CUSTOMFIELD-PHANTOMS)', () => {
  it('routes ClassName.camelCaseStaticField to references ApexClass, dropping the CustomField phantom', () => {
    const source = [
      'public class WidgetTrigger {',
      '  void run() {',
      '    WidgetGuard.guardBefore = true;',
      '    Boolean b = WidgetGuard.guardAfter;',
      '  }',
      '}',
    ].join('\n');
    const result = buildApexScannerEdges(source, 'ApexClass:WidgetTrigger');
    // No CustomField phantoms on the Apex class' static fields.
    expect(
      result.edges.some((e) => e.toId.startsWith('CustomField:WidgetGuard.')),
    ).toBe(false);
    // The real class dependency is emitted instead (usages land on it).
    const ref = result.edges.find(
      (e) => e.toId === 'ApexClass:WidgetGuard' && e.edgeType === 'references',
    );
    expect(ref).toBeDefined();
    expect(ref?.properties['mechanism']).toBe('apexStaticField');
  });

  it('keeps a genuine schema field access (Type.Field / Type.Attr__c) as CustomField', () => {
    const source = [
      'public class Repo {',
      '  void run(Account a) {',
      '    String n = a.Name;',
      '    Object v = a.Sector__c;',
      '  }',
      '}',
    ].join('\n');
    const result = buildApexScannerEdges(source, 'ApexClass:Repo');
    const targets = result.edges.map((e) => e.toId);
    expect(targets).toContain('CustomField:Account.Name');
    expect(targets).toContain('CustomField:Account.Sector__c');
    // PascalCase / __c fields are NOT rerouted to ApexClass.
    expect(targets).not.toContain('ApexClass:Account');
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

// NAMED-CREDENTIAL-APEX-CALLOUT-UNGRAPHED: `callout:{NamedCredential}` endpoint
// literals live INSIDE strings (which the scanner blanks), so they produced no
// graph edge — the credential read as orphaned / safe-to-delete despite the
// grep tier surfacing it. buildApexScannerEdges must now emit the edge.
describe('buildApexScannerEdges — callout:NamedCredential → references (NAMED-CREDENTIAL-APEX-CALLOUT-UNGRAPHED)', () => {
  it('emits a heuristic references edge to the Named Credential named in a callout: endpoint', () => {
    const source =
      "public class DataIngestController { void run() { HttpRequest req = new HttpRequest(); req.setEndpoint('callout:My_Named_Credential/services/data'); } }";
    const result = buildApexScannerEdges(source, 'ApexClass:DataIngestController');
    const edge = result.edges.find(
      (e) => e.edgeType === 'references' && e.toId === 'NamedCredential:My_Named_Credential',
    );
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe('heuristic');
    expect(edge?.properties['referenceKind']).toBe('apexCallout');
  });

  it('captures a bare callout:Name with no trailing path', () => {
    const source =
      "public class Caller { void run() { String ep = 'callout:Payments_API'; } }";
    const result = buildApexScannerEdges(source, 'ApexClass:Caller');
    expect(
      result.edges.some((e) => e.toId === 'NamedCredential:Payments_API'),
    ).toBe(true);
  });

  it('mints NO edge for a dynamic callout: built by string concatenation', () => {
    const source =
      "public class Dyn { void run() { String ep = 'callout:' + ncName; } }";
    const result = buildApexScannerEdges(source, 'ApexClass:Dyn');
    expect(
      result.edges.some((e) => e.toId.startsWith('NamedCredential:')),
    ).toBe(false);
  });

  it('mints NO edge for a commented-out callout', () => {
    const source =
      "public class C { void run() { // req.setEndpoint('callout:Ghost_NC');\n Integer x = 1; } }";
    const result = buildApexScannerEdges(source, 'ApexClass:C');
    expect(
      result.edges.some((e) => e.toId === 'NamedCredential:Ghost_NC'),
    ).toBe(false);
  });
});
