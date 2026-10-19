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

  it('mints a heuristic subscribesToChange edge for a resolved Change Event channel (never listensTo)', () => {
    const source =
      "public class Demo_CdcSub { void run() { EventBus.subscribe('Demo_Channel__ChangeEvent', this); } }";
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_CdcSub');
    const subscribes = result.edges.filter((e) => e.edgeType === 'subscribesToChange');
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0]?.toId).toBe('CustomObject:Demo_Channel__ChangeEvent');
    expect(subscribes[0]?.confidence).toBe('heuristic');
    expect(subscribes[0]?.properties).toMatchObject({
      mechanism: 'eventBusSubscribe',
      changeEventName: 'Demo_Channel__ChangeEvent',
    });
    expect(result.unresolvedSubscriptions).toBe(0);
  });

  it('resolves the /data/ CDC channel form to the Change Event', () => {
    const source =
      "public class Demo_CdcSub { void run() { EventBus.subscribe('/data/Demo_Channel__ChangeEvent', this); } }";
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_CdcSub');
    const subscribes = result.edges.filter((e) => e.edgeType === 'subscribesToChange');
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0]?.toId).toBe('CustomObject:Demo_Channel__ChangeEvent');
  });

  it('counts a dynamic / computed channel as unresolvedSubscriptions and mints NO edge', () => {
    const source =
      'public class Demo_DynSub { void run() { String chan = pick(); EventBus.subscribe(chan, this); EventBus.subscribe(other(), this); } }';
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_DynSub');
    expect(result.unresolvedSubscriptions).toBe(2);
    expect(result.edges.some((e) => e.edgeType === 'subscribesToChange' || e.edgeType === 'listensTo')).toBe(false);
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

describe('buildApexScannerEdges — literal Type.forName → references (P21-MOAT-apex-frameworks)', () => {
  it('emits a heuristic references edge for a string-literal operand, tagged mechanism Type.forName', () => {
    const source =
      "public class Demo_Dispatcher { void run() { Object h = Type.forName('Demo_Handler').newInstance(); } }";
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_Dispatcher');
    const edge = result.edges.find((e) => e.toId === 'ApexClass:Demo_Handler');
    expect(edge).toBeDefined();
    expect(edge?.edgeType).toBe('references');
    expect(edge?.confidence).toBe('heuristic');
    expect(edge?.properties['mechanism']).toBe('Type.forName');
    expect(result.unresolvedDynamicDispatch).toBe(0);
  });

  it('resolves the two-argument same-namespace form Type.forName(\'\', \'Name\')', () => {
    const source =
      "public class Demo_Dispatcher { void run() { Type t = Type.forName('', 'Demo_Handler'); } }";
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_Dispatcher');
    expect(result.edges.some((e) => e.toId === 'ApexClass:Demo_Handler')).toBe(true);
  });

  it('mints NO edge for a variable operand and counts it as unresolvedDynamicDispatch', () => {
    const source =
      'public class Demo_Dispatcher { void run(String name) { Object h = Type.forName(name).newInstance(); } }';
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_Dispatcher');
    expect(result.edges.some((e) => e.properties['mechanism'] === 'Type.forName')).toBe(false);
    expect(result.unresolvedDynamicDispatch).toBe(1);
  });

  it('ignores a commented-out Type.forName (no edge, not counted)', () => {
    const source =
      "public class Demo_Dispatcher { void run() { // Type.forName('Demo_Ghost').newInstance();\n /* Type.forName(name) */ Integer x = 1; } }";
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_Dispatcher');
    expect(result.edges.some((e) => e.toId === 'ApexClass:Demo_Ghost')).toBe(false);
    expect(result.unresolvedDynamicDispatch).toBe(0);
  });
});

describe('buildApexScannerEdges — platform classes are never ApexClass targets (NO-MINTED-PLATFORM-IDS)', () => {
  const source = [
    'public class Demo_Caller {',
    '  void run(List<Account> recs) {',
    "    Type t = Type.forName('Demo_Helper');",
    '    Database.update(recs);',
    '    Database.insert(recs);',
    '    Map<String, Schema.SObjectType> g = Schema.getGlobalDescribe();',
    '    PageReference p = ApexPages.currentPage();',
    "    PageReference q = new PageReference('/home');",
    '    Demo_Helper.run(recs);',
    '  }',
    '}',
  ].join('\n');

  it('mints exactly one callsApex (to the local class) and counts the platform calls', () => {
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_Caller');
    const calls = result.edges.filter((e) => e.edgeType === 'callsApex').map((e) => e.toId);
    expect(calls).toEqual(['ApexClass:Demo_Helper']);
    // One count per distinct platform method called (the scanner dedups by
    // class + method), keyed by the platform class's canonical spelling.
    expect(result.platformCalls).toEqual({ ApexPages: 1, Database: 2, Schema: 1, Type: 1 });
  });

  it('never mints an ApexClass edge of any kind to a platform class', () => {
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_Caller');
    const apexTargets = result.edges
      .filter((e) => e.toId.startsWith('ApexClass:'))
      .map((e) => e.toId);
    // `new PageReference(...)` is not a user-class instantiation either.
    expect(apexTargets.every((id) => id === 'ApexClass:Demo_Helper')).toBe(true);
  });

  it('is case-insensitive and keys the count by the canonical spelling (WOW-10)', () => {
    const result = buildApexScannerEdges(
      "public class Demo_Lower { void run(Account a) { system.debug('x'); Boolean b = string.isBlank(a.Name); database.insert(a); } }",
      'ApexClass:Demo_Lower',
    );
    expect(result.edges.filter((e) => e.edgeType === 'callsApex')).toEqual([]);
    expect(result.platformCalls).toEqual({ Database: 1, String: 1, System: 1 });
  });

  it('is empty when nothing platform is called', () => {
    const result = buildApexScannerEdges(
      'public class Demo_Plain { void run() { Demo_Helper.run(); } }',
      'ApexClass:Demo_Plain',
    );
    expect(result.platformCalls).toEqual({});
  });
});

describe('buildApexScannerEdges — sObject-named receivers are never ApexClass targets (NO-MINTED-PLATFORM-IDS)', () => {
  const source = [
    'public class Demo_Describer {',
    '  void run() {',
    '    Schema.SObjectType t = Account.getSObjectType();',
    '    Contact c = new Contact(LastName = \'x\');',
    '    List<ContentVersion> v = [SELECT Id FROM ContentVersion];',
    '    Schema.SObjectType cv = ContentVersion.getSObjectType();',
    '    Schema.SObjectType o = Opportunity.sObjectType;',
    '    Demo_Helper.run(v);',
    '  }',
    '}',
  ].join('\n');

  it('reroutes a static call or `new` on a standard object, or an object this file queries, to the CustomObject node', () => {
    const result = buildApexScannerEdges(source, 'ApexClass:Demo_Describer');
    const apexTargets = result.edges.filter((e) => e.toId.startsWith('ApexClass:')).map((e) => e.toId);
    expect(apexTargets).toEqual(['ApexClass:Demo_Helper']);
    const objectRefs = result.edges
      .filter((e) => e.edgeType === 'references' && e.toId.startsWith('CustomObject:'))
      .map((e) => `${e.toId}:${String(e.properties['mechanism'])}`);
    expect(objectRefs).toEqual([
      'CustomObject:Account:apexStaticObjectRef',
      'CustomObject:Contact:instantiation',
      'CustomObject:ContentVersion:apexStaticObjectRef',
      'CustomObject:Opportunity:apexStaticObjectRef',
    ]);
  });

  it('reroutes a Change Event receiver the same way', () => {
    const result = buildApexScannerEdges(
      'public class Demo_Cdc { void run() { Object h = AccountChangeEvent.getSObjectType(); } }',
      'ApexClass:Demo_Cdc',
    );
    expect(result.edges.some((e) => e.toId.startsWith('ApexClass:'))).toBe(false);
    expect(result.edges.map((e) => e.toId)).toContain('CustomObject:AccountChangeEvent');
  });
});
