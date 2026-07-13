/// <reference types="vitest/globals" />

import { parseApexHeader } from '../src/apex-header-parser.js';

describe('parseApexHeader', () => {
  describe('happy path', () => {
    it('parses a minimal public class', () => {
      const result = parseApexHeader('public class Foo {}');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        modifiers: ['public'],
        sharingModel: null,
        className: 'Foo',
        superclass: null,
        implements: [],
        annotations: [],
        isTest: false,
        methodAnnotations: [],
        restUrlMapping: null,
      });
    });

    it('parses an interface declaration (not just class)', () => {
      // An Apex interface has no `class` keyword but IS a real component (other
      // classes `implements` it) — it must parse, not error "no class
      // declaration found" (4 such interfaces broke the example.gov refresh).
      const result = parseApexHeader(
        'public interface IFoo {\n  void executeBatch(Integer jobSize);\n}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.className).toBe('IFoo');
      expect(result.value.modifiers).toEqual(['public']);
    });

    it('parses an interface that extends another interface', () => {
      const result = parseApexHeader('global interface IBar extends IFoo {}');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.className).toBe('IBar');
      expect(result.value.superclass).toBe('IFoo');
    });

    it('recognizes a capitalized Interface/Class keyword (Apex keywords are case-insensitive)', () => {
      // Apex keywords are case-insensitive. The real example.gov interface
      // IIntegrationService declares `public Interface IIntegrationService{...}`
      // (capital I) — the parser must not require a lowercase `interface`.
      const iface = parseApexHeader(
        'public Interface IIntegrationService { void invokeCallout(); }',
      );
      expect(iface.ok).toBe(true);
      if (!iface.ok) return;
      expect(iface.value.className).toBe('IIntegrationService');

      const klass = parseApexHeader('public Class Foo {}');
      expect(klass.ok).toBe(true);
      if (!klass.ok) return;
      expect(klass.value.className).toBe('Foo');
    });

    it('parses a class with sharing, extends, and implements (generics)', () => {
      const source =
        'public with sharing class Foo extends Bar.Base implements Database.Batchable<sObject>, Database.Stateful {}';
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.modifiers).toEqual(['public']);
      expect(result.value.sharingModel).toBe('with sharing');
      expect(result.value.className).toBe('Foo');
      expect(result.value.superclass).toBe('Bar.Base');
      expect(result.value.implements).toEqual([
        'Database.Batchable<sObject>',
        'Database.Stateful',
      ]);
    });

    it('captures annotations on lines above the class declaration', () => {
      const source = `@isTest
@SuppressWarnings('PMD')
private class FooTest {}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.annotations).toEqual(["@isTest", "@SuppressWarnings('PMD')"]);
      expect(result.value.isTest).toBe(true);
      expect(result.value.modifiers).toEqual(['private']);
    });

    it('treats @isTest detection as case-insensitive', () => {
      const result = parseApexHeader('@IsTest\nglobal class FooTest {}');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.isTest).toBe(true);
    });

    it('handles each sharing model keyword', () => {
      const withResult = parseApexHeader('public with sharing class Foo {}');
      const withoutResult = parseApexHeader('public without sharing class Foo {}');
      const inheritedResult = parseApexHeader('public inherited sharing class Foo {}');
      expect(withResult.ok && withResult.value.sharingModel).toBe('with sharing');
      expect(withoutResult.ok && withoutResult.value.sharingModel).toBe('without sharing');
      expect(inheritedResult.ok && inheritedResult.value.sharingModel).toBe(
        'inherited sharing',
      );
    });

    it('returns null sharingModel when not specified', () => {
      const result = parseApexHeader('global class Foo {}');
      expect(result.ok && result.value.sharingModel).toBe(null);
    });

    it('returns empty implements list when not present', () => {
      const result = parseApexHeader('public class Foo extends Bar {}');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.implements).toEqual([]);
      expect(result.value.superclass).toBe('Bar');
    });
  });

  describe('comment- and string-aware tokenization', () => {
    it('does not treat the word class inside a line comment as the declaration', () => {
      const source = `// abstract class FakeClass {} -- this is just a comment
public class RealClass {}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.className).toBe('RealClass');
    });

    it('does not treat the word class inside a block comment as the declaration', () => {
      const source = `/*
 * class FakeClass {}
 */
private class RealClass {}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.className).toBe('RealClass');
      expect(result.value.modifiers).toEqual(['private']);
    });

    it('does not treat the word class inside a string literal as the declaration', () => {
      const source = `public class Foo {
  String s = 'global class FakeClass {';
}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.className).toBe('Foo');
      expect(result.value.modifiers).toEqual(['public']);
    });

    it('handles escaped quotes inside string literals', () => {
      const source = `public class Foo {
  String s = 'it\\'s class time';
}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.className).toBe('Foo');
    });

    it('ignores annotation-looking text that lives inside a comment', () => {
      const source = `// @isTest -- not a real annotation
public class Foo {}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.annotations).toEqual([]);
      expect(result.value.isTest).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('skips Apex modifiers not in the recognized set (abstract, virtual)', () => {
      const result = parseApexHeader('public abstract class Foo {}');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.modifiers).toEqual(['public']);
      expect(result.value.className).toBe('Foo');
    });

    it('captures an annotation with parenthesized arguments on one line', () => {
      const source = `@RestResource(urlMapping='/path/*')
global class Foo {}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.annotations).toEqual(["@RestResource(urlMapping='/path/*')"]);
    });

    it('handles multiple modifiers in source order', () => {
      // Apex compiler does not actually allow this, but the parser should
      // capture whichever access modifiers are present in the order found.
      const result = parseApexHeader('global private class Foo {}');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.modifiers).toEqual(['global', 'private']);
    });

    it('handles nested generics in implements', () => {
      const result = parseApexHeader(
        'public class Foo implements Comparable<Map<String, List<Integer>>> {}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.implements).toEqual([
        'Comparable<Map<String,List<Integer>>>',
      ]);
    });

    it('captures generics on the extends type', () => {
      const result = parseApexHeader(
        'public class Foo extends List<Account> implements Comparable {}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.superclass).toBe('List<Account>');
      expect(result.value.implements).toEqual(['Comparable']);
    });

    it('handles header spread across multiple lines', () => {
      const source = `public
        with sharing
        class Foo
        extends Bar
        implements IFoo {}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.modifiers).toEqual(['public']);
      expect(result.value.sharingModel).toBe('with sharing');
      expect(result.value.className).toBe('Foo');
      expect(result.value.superclass).toBe('Bar');
      expect(result.value.implements).toEqual(['IFoo']);
    });
  });

  describe('error cases', () => {
    it('returns no-class-declaration for a comments-and-whitespace-only source', () => {
      const source = `// just a comment
/* and another */
   `;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('no-class-declaration');
    });

    it('returns no-class-declaration for empty source', () => {
      const result = parseApexHeader('');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('no-class-declaration');
    });

    it('returns malformed-header when class is followed by non-identifier', () => {
      const result = parseApexHeader('public class { }');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('malformed-header');
    });
  });

  // v1.5-R3: methodAnnotations and restUrlMapping. The v1.5 extension
  // captures all `@Name` patterns inside the class body so the
  // apex-class extractor can set its `hasFutureMethod` /
  // `hasInvocableMethod` / `hasAuraEnabledMethod` booleans without a
  // separate body-scan pass, and pulls the `urlMapping` argument out
  // of any class-level `@RestResource` for synthetic-id construction.
  describe('v1.5 method-annotation and restUrlMapping extraction', () => {
    it('captures @future on a method', () => {
      const source = `public class AccountActions {
  @future(callout=true)
  public static void notifyExternal(Set<Id> ids) {}
}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.methodAnnotations).toContain('future');
    });

    it('captures @InvocableMethod with arguments', () => {
      const source = `public class AccountActions {
  @InvocableMethod(label='Snooze' description='Pause for N days')
  public static List<Result> snooze(List<Input> inputs) { return null; }
}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.methodAnnotations).toContain('InvocableMethod');
    });

    it('captures @AuraEnabled across multiple methods', () => {
      const source = `public class Service {
  @AuraEnabled public static String a() { return null; }
  @AuraEnabled(cacheable=true) public static String b() { return null; }
}`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The collector pushes every occurrence — both AuraEnabled
      // annotations land in the list. The apex-class extractor wraps
      // it in a Set before checking presence.
      expect(
        result.value.methodAnnotations.filter((n) => n === 'AuraEnabled'),
      ).toHaveLength(2);
    });

    it('returns empty methodAnnotations when no @-prefixed tokens appear in body', () => {
      const result = parseApexHeader('public class Plain { void run() {} }');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.methodAnnotations).toEqual([]);
    });

    it('extracts restUrlMapping from class-level @RestResource', () => {
      const source = `@RestResource(urlMapping='/Accounts/*')
global class AccountResource { }`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.restUrlMapping).toBe('/Accounts/*');
    });

    it('returns null restUrlMapping when no @RestResource is present', () => {
      const result = parseApexHeader('public class Plain { }');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.restUrlMapping).toBeNull();
    });

    it('returns null restUrlMapping when @RestResource has no urlMapping argument', () => {
      const source = `@RestResource
global class WeirdResource { }`;
      const result = parseApexHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No `urlMapping='...'` was extractable; the property stays null
      // even though the annotation is present. The extractor uses this
      // to decide whether to emit an `exposes` edge.
      expect(result.value.restUrlMapping).toBeNull();
    });
  });
});
