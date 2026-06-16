import { describe, expect, it } from 'vitest';

import {
  fieldMatchesObjectScope,
  formatSfCliFailure,
  mergeInputAliases,
  parseFieldParentObjectApiName,
  resolveObjectScopeParentId,
  toCustomObjectId,
  toLayoutId,
  toObjectApiName,
} from '../../src/tools/input-aliases.js';

describe('mergeInputAliases', () => {
  it('copies alias when canonical is missing', () => {
    const out = mergeInputAliases(
      { query: 'customer health', limit: 5 },
      [{ canonical: 'description', aliases: ['query'] }],
    ) as Record<string, unknown>;
    expect(out.description).toBe('customer health');
    expect(out.query).toBe('customer health');
  });

  it('prefers canonical over alias', () => {
    const out = mergeInputAliases(
      { description: 'canonical', query: 'alias' },
      [{ canonical: 'description', aliases: ['query'] }],
    ) as Record<string, unknown>;
    expect(out.description).toBe('canonical');
  });
});

describe('object scope helpers', () => {
  it('resolveObjectScopeParentId coerces bare api names', () => {
    expect(resolveObjectScopeParentId({ objectId: 'Account' })).toBe(
      'CustomObject:Account',
    );
    expect(resolveObjectScopeParentId({ objectApiName: 'Payment__c' })).toBe(
      'CustomObject:Payment__c',
    );
  });

  it('fieldMatchesObjectScope matches parentId or parsed field id', () => {
    expect(
      fieldMatchesObjectScope(
        {
          id: 'CustomField:Student_Record__c.Student_SSN__c',
          parentId: 'CustomObject:Student_Record__c',
        },
        'CustomObject:Student_Record__c',
      ),
    ).toBe(true);
    expect(parseFieldParentObjectApiName('CustomField:Account.Industry__c')).toBe(
      'Account',
    );
  });
});

describe('id helpers', () => {
  it('toCustomObjectId adds prefix', () => {
    expect(toCustomObjectId('Account')).toBe('CustomObject:Account');
  });

  it('toObjectApiName strips prefix', () => {
    expect(toObjectApiName('CustomObject:Account')).toBe('Account');
  });

  it('toLayoutId adds prefix', () => {
    expect(toLayoutId('Account-Account Layout')).toBe('Layout:Account-Account Layout');
  });
});

describe('formatSfCliFailure', () => {
  it('appends upgrade hint for update-available stderr', () => {
    const msg = formatSfCliFailure('Warning: update available from 2.103.7 to 2.137.7');
    expect(msg).toContain('sf update');
  });
});
