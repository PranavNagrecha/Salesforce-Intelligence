/// <reference types="vitest/globals" />

import { parseTriggerHeader } from '../src/trigger-header-parser.js';

describe('parseTriggerHeader', () => {
  describe('happy path', () => {
    it('parses a minimal single-event trigger', () => {
      const result = parseTriggerHeader(
        'trigger AccountTrigger on Account (after insert) {}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        triggerName: 'AccountTrigger',
        objectApiName: 'Account',
        events: ['after insert'],
      });
    });

    it('parses multiple events separated by commas', () => {
      const result = parseTriggerHeader(
        'trigger ContactTrigger on Contact (after insert,after update) {}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.events).toEqual(['after insert', 'after update']);
    });

    it('recognizes all seven valid event types', () => {
      const result = parseTriggerHeader(
        'trigger AllEventsTrigger on Account (before insert, before update, before delete, after insert, after update, after delete, after undelete) {}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.events).toEqual([
        'before insert',
        'before update',
        'before delete',
        'after insert',
        'after update',
        'after delete',
        'after undelete',
      ]);
    });

    it('handles arbitrary whitespace between tokens', () => {
      const result = parseTriggerHeader(
        '   trigger\t\tAccountTrigger   on   Account   (   after   insert   ,   after   update   )   {}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggerName).toBe('AccountTrigger');
      expect(result.value.objectApiName).toBe('Account');
      expect(result.value.events).toEqual(['after insert', 'after update']);
    });

    it('parses a header that spans multiple lines', () => {
      const source = `trigger AccountTrigger
        on Account
        (
          before insert,
          before update,
          after insert
        ) {
          // body here
        }`;
      const result = parseTriggerHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.events).toEqual([
        'before insert',
        'before update',
        'after insert',
      ]);
    });

    it('handles custom object names ending in __c', () => {
      const result = parseTriggerHeader(
        'trigger MarketoLogTrigger on Marketo_Log__c (after insert) {}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.objectApiName).toBe('Marketo_Log__c');
    });

    it('handles namespaced object names with double underscore', () => {
      const result = parseTriggerHeader(
        'trigger CourseEnroll on hed__Course_Enrollment__c (after insert) {}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.objectApiName).toBe('hed__Course_Enrollment__c');
    });
  });

  describe('comment- and string-aware tokenization', () => {
    it('ignores a `trigger` keyword inside a line comment', () => {
      const source = `// trigger FakeTrigger on Account (before insert) {
trigger RealTrigger on Account (after insert) {}`;
      const result = parseTriggerHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggerName).toBe('RealTrigger');
    });

    it('ignores a `trigger` keyword inside a block comment', () => {
      const source = `/*
 * trigger FakeTrigger on Account (before insert) {}
 */
trigger RealTrigger on Account (after insert) {}`;
      const result = parseTriggerHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggerName).toBe('RealTrigger');
    });

    it('ignores a `trigger` keyword inside a string literal', () => {
      const source = `trigger RealTrigger on Account (after insert) {
  String s = 'trigger Fake on Lead (before insert)';
}`;
      const result = parseTriggerHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggerName).toBe('RealTrigger');
      expect(result.value.objectApiName).toBe('Account');
    });

    it('handles escaped quotes inside string literals', () => {
      const source = `trigger Foo on Bar__c (after insert) {
  String s = 'it\\'s trigger time on Lead (before insert)';
}`;
      const result = parseTriggerHeader(source);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggerName).toBe('Foo');
    });
  });

  describe('error cases', () => {
    it('returns no-trigger-keyword for a source without the trigger keyword', () => {
      const result = parseTriggerHeader('// nothing of interest here\n');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('no-trigger-keyword');
    });

    it('returns no-trigger-keyword for empty source', () => {
      const result = parseTriggerHeader('');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('no-trigger-keyword');
    });

    it('returns cannot-parse-header when `on` is missing', () => {
      const result = parseTriggerHeader(
        'trigger Foo Account (after insert) {}',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
    });

    it('returns cannot-parse-header when object name is missing', () => {
      const result = parseTriggerHeader('trigger Foo on (after insert) {}');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
    });

    it('returns cannot-parse-header when the opening `(` is missing', () => {
      const result = parseTriggerHeader('trigger Foo on Account after insert {}');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
    });

    it('returns cannot-parse-header when the event list is empty', () => {
      const result = parseTriggerHeader('trigger Foo on Account () {}');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
    });

    it('returns cannot-parse-header when the closing `{` is missing', () => {
      const result = parseTriggerHeader(
        'trigger Foo on Account (after insert)',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
    });

    it('returns unknown-event when an event lead word is unrecognized', () => {
      const result = parseTriggerHeader(
        'trigger Foo on Account (before sneeze) {}',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unknown-event');
      expect(result.error.message).toBe('unknown trigger event: before sneeze');
    });

    it('returns unknown-event when the lead is neither before nor after', () => {
      const result = parseTriggerHeader(
        'trigger Foo on Account (during insert) {}',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('unknown-event');
    });
  });

  // Each of the following tests exercises the specific improvement made
  // to the parser's error reporting. The original `cannot parse trigger
  // header` message was the same for every grammar failure — these tests
  // pin each grammar step to its own message so future regressions get
  // caught before they reach the extractor's malformed-input mapping.
  describe('specific error messages', () => {
    it('reports trigger keyword missing when the source has no trigger', () => {
      const result = parseTriggerHeader('// nothing of interest here\n');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('no-trigger-keyword');
      expect(result.error.message).toBe(
        'trigger keyword not found outside comments and strings',
      );
    });

    it('reports test-class misfile when @isTest is present but no trigger keyword', () => {
      // Real-world misfile pattern: a test class accidentally lives in
      // `triggers/`. The parser flags this distinctly so the operator can
      // tell "wrong file in this directory" from "this is a malformed
      // trigger source."
      const source = `@isTest
private class FooTest {
  static testMethod void bar() {
    System.assertEquals(1, 1);
  }
}`;
      const result = parseTriggerHeader(source);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('no-trigger-keyword');
      expect(result.error.message).toBe(
        'file appears to be a test class, not a trigger',
      );
    });

    it('reports missing trigger name when the keyword is the last token', () => {
      const result = parseTriggerHeader('trigger ');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
      expect(result.error.message).toBe(
        "missing trigger name after 'trigger' keyword",
      );
    });

    it("reports missing 'on' clause distinctly", () => {
      const result = parseTriggerHeader('trigger Foo Account (after insert) {}');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
      expect(result.error.message).toBe(
        "missing 'on' clause after trigger name",
      );
    });

    it('reports missing object name distinctly', () => {
      const result = parseTriggerHeader('trigger Foo on (after insert) {}');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
      expect(result.error.message).toBe("missing object name after 'on'");
    });

    it("reports missing '(' distinctly", () => {
      const result = parseTriggerHeader(
        'trigger Foo on Account after insert {}',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
      expect(result.error.message).toBe("missing '(' to open event list");
    });

    it("reports missing ')' distinctly", () => {
      const result = parseTriggerHeader('trigger Foo on Account (after insert');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
      expect(result.error.message).toBe("missing ')' to close event list");
    });

    it('reports empty event list distinctly', () => {
      const result = parseTriggerHeader('trigger Foo on Account () {}');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
      expect(result.error.message).toBe('event list is empty');
    });

    it("reports missing '{' distinctly", () => {
      const result = parseTriggerHeader('trigger Foo on Account (after insert)');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('cannot-parse-header');
      expect(result.error.message).toBe("missing '{' after event list");
    });
  });

  // Apex keywords are case-insensitive. The real-world fixture
  // `FSR_TriggerhedCourseEnrollmentTest.trigger` in the edu-org capitalizes
  // `Trigger` and previously failed with the uninformative `no-trigger-keyword`
  // error. Case-insensitive matching of the keyword fixes that without
  // touching any other token (object name, trigger name, etc., remain
  // case-sensitive identifiers).
  describe('case-insensitive trigger keyword', () => {
    it('parses a capitalized `Trigger` keyword (real-world fixture)', () => {
      const result = parseTriggerHeader(
        'Trigger FSR_TriggerhedCourseEnrollmentTest on hed__Course_Enrollment__c(after insert, after update){}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        triggerName: 'FSR_TriggerhedCourseEnrollmentTest',
        objectApiName: 'hed__Course_Enrollment__c',
        events: ['after insert', 'after update'],
      });
    });

    it('parses an all-uppercase `TRIGGER` keyword', () => {
      const result = parseTriggerHeader(
        'TRIGGER Foo on Account (after insert) {}',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.triggerName).toBe('Foo');
    });
  });
});
