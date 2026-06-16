/// <reference types="vitest/globals" />

import { coercePrefix } from '../../src/tools/coerce-id.js';

const APEX = ['ApexClass:', 'ApexTrigger:'] as const;

describe('coercePrefix', () => {
  it('returns an already-prefixed id unchanged', () => {
    expect(coercePrefix('ApexClass:Foo', APEX)).toBe('ApexClass:Foo');
    expect(coercePrefix('ApexTrigger:Bar', APEX)).toBe('ApexTrigger:Bar');
    expect(coercePrefix('Flow:My_Flow', ['Flow:'])).toBe('Flow:My_Flow');
  });

  it('prepends the PRIMARY prefix to a bare apiName', () => {
    expect(coercePrefix('Foo', APEX)).toBe('ApexClass:Foo');
    expect(coercePrefix('My_Flow', ['Flow:'])).toBe('Flow:My_Flow');
    // A bare object.field form coerces too (CustomField needs the qualifier).
    expect(coercePrefix('Account.Email__c', ['CustomField:'])).toBe(
      'CustomField:Account.Email__c',
    );
  });

  it('leaves a WRONG-type id unchanged so the caller can reject it', () => {
    // A CustomObject id handed to a class tool keeps its colon -> returned as-is
    // so the caller's prefix check fires its precise wrong-type message.
    expect(coercePrefix('CustomObject:Account', APEX)).toBe('CustomObject:Account');
    expect(coercePrefix('CustomField:Account.X__c', ['Flow:'])).toBe(
      'CustomField:Account.X__c',
    );
  });

  it('is a no-op-ish for empty accepted prefixes (defensive)', () => {
    expect(coercePrefix('Foo', [])).toBe('Foo');
  });
});
