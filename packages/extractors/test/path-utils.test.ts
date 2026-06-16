/// <reference types="vitest/globals" />

import { deriveComponentApiName, deriveParentApiName } from '../src/path-utils.js';

describe('deriveComponentApiName', () => {
  it('strips a matching suffix from the basename', () => {
    expect(
      deriveComponentApiName('/foo/bar/Account.object-meta.xml', '.object-meta.xml'),
    ).toBe('Account');
  });

  it('falls back to stripping the extension when the suffix is absent', () => {
    expect(deriveComponentApiName('Account.xml', '.object-meta.xml')).toBe('Account');
  });

  it('returns the basename unchanged when there is no extension or matching suffix', () => {
    expect(deriveComponentApiName('Account', '.object-meta.xml')).toBe('Account');
  });

  it('handles a path with multiple directory segments', () => {
    expect(
      deriveComponentApiName(
        'objects/Account/fields/Industry__c.field-meta.xml',
        '.field-meta.xml',
      ),
    ).toBe('Industry__c');
  });
});

describe('deriveParentApiName', () => {
  it('returns the parent object name for a CustomField path', () => {
    expect(
      deriveParentApiName('objects/Account/fields/Industry__c.field-meta.xml', 2),
    ).toBe('Account');
  });

  it('returns the immediate parent directory for parentDirLevel = 1', () => {
    expect(
      deriveParentApiName('objects/Account/fields/Industry__c.field-meta.xml', 1),
    ).toBe('fields');
  });

  it('returns an empty string when the path is too short for the requested level', () => {
    expect(deriveParentApiName('Foo.xml', 1)).toBe('');
    expect(deriveParentApiName('a/Foo.xml', 5)).toBe('');
  });

  it('returns an empty string when parentDirLevel is less than 1', () => {
    expect(deriveParentApiName('objects/Account/fields/Industry__c.field-meta.xml', 0)).toBe('');
  });
});
