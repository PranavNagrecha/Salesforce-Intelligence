/// <reference types="vitest/globals" />

import {
  deriveComponentApiName,
  deriveEmailTemplateFolderAndName,
  deriveParentApiName,
} from '../src/path-utils.js';

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

/**
 * Separator portability. These are the assertions that were missing while
 * `deriveEmailTemplateFolderAndName` split on a hardcoded `'/'`: on Windows the
 * whole native path collapsed to one segment, the `email` marker was never
 * found, every template returned null, and the vault silently ended up with
 * ZERO EmailTemplate nodes while the refresh still reported partial success.
 *
 * The parameterised form is the point — a per-function equality between the two
 * separator spellings catches the whole class, including any function added
 * later, on a POSIX runner.
 */
describe('path-utils — either separator yields the same answer', () => {
  it('derives an EmailTemplate folder from a native Windows path', () => {
    expect(
      deriveEmailTemplateFolderAndName(
        'force-app\\main\\default\\email\\Marketing\\Welcome.email',
        '.email',
      ),
    ).toEqual({ folderName: 'Marketing', templateName: 'Welcome' });
  });

  it('derives a NESTED EmailTemplate folder from a native Windows path', () => {
    expect(
      deriveEmailTemplateFolderAndName(
        'force-app\\main\\default\\email\\A\\B\\Nested.email',
        '.email',
      ),
    ).toEqual({ folderName: 'A/B', templateName: 'Nested' });
  });

  it('agrees between separators for every path-derivation helper', () => {
    const posixPath = 'force-app/main/default/email/Marketing/Welcome.email';
    const win32Path = 'force-app\\main\\default\\email\\Marketing\\Welcome.email';
    expect(deriveEmailTemplateFolderAndName(win32Path, '.email')).toEqual(
      deriveEmailTemplateFolderAndName(posixPath, '.email'),
    );
  });

  it('still rejects a template that is not under an `email` segment', () => {
    // The fix must not turn "no email folder" into a false positive.
    expect(
      deriveEmailTemplateFolderAndName('force-app\\main\\default\\classes\\Foo.cls', '.cls'),
    ).toBeNull();
  });
});
