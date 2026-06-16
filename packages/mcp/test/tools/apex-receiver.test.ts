/// <reference types="vitest/globals" />

import {
  isUnresolvedApexCallTarget,
  isUnresolvedFieldReceiver,
} from '../../src/tools/apex-receiver.js';

describe('isUnresolvedFieldReceiver', () => {
  it('flags this/super members and local-variable receivers', () => {
    expect(isUnresolvedFieldReceiver('CustomField:this.caseLogId')).toBe(true);
    expect(isUnresolvedFieldReceiver('CustomField:super.x')).toBe(true);
    expect(isUnresolvedFieldReceiver('CustomField:acc.Status__c')).toBe(true);
    expect(isUnresolvedFieldReceiver('CustomField:comment.CommentBody')).toBe(true);
    expect(isUnresolvedFieldReceiver('CustomField:courseOffering.Compensation__c')).toBe(true);
  });

  it('keeps real standard / custom / namespaced receivers', () => {
    expect(isUnresolvedFieldReceiver('CustomField:Account.Industry__c')).toBe(false);
    expect(isUnresolvedFieldReceiver('CustomField:FeedComment.CommentBody')).toBe(false);
    expect(isUnresolvedFieldReceiver('CustomField:Payment__c.Amount__c')).toBe(false);
    expect(isUnresolvedFieldReceiver('CustomField:hed__Course__c.hed__Name__c')).toBe(false);
  });

  it('returns false for a non-CustomField id', () => {
    expect(isUnresolvedFieldReceiver('ApexClass:Foo')).toBe(false);
    expect(isUnresolvedFieldReceiver('CustomField:NoDotHere')).toBe(false);
  });
});

describe('isUnresolvedApexCallTarget', () => {
  it('flags lowercase local-variable "class" tokens', () => {
    expect(isUnresolvedApexCallTarget('ApexClass:acc')).toBe(true);
    expect(isUnresolvedApexCallTarget('ApexClass:oldMap')).toBe(true);
    expect(isUnresolvedApexCallTarget('ApexClass:newMap')).toBe(true);
  });

  it('keeps PascalCase and namespaced classes (conservative — never drop a real call)', () => {
    expect(isUnresolvedApexCallTarget('ApexClass:MRK_NewPartnerAccountHelper')).toBe(false);
    expect(isUnresolvedApexCallTarget('ApexClass:Account')).toBe(false);
    expect(isUnresolvedApexCallTarget('ApexClass:dlrs__RollupService')).toBe(false);
  });

  it('keeps non-PascalCase real class api names with underscores (GRF-01 pkb_Controller)', () => {
    expect(isUnresolvedApexCallTarget('ApexClass:pkb_Controller')).toBe(false);
  });

  it('returns false for non-ApexClass ids', () => {
    expect(isUnresolvedApexCallTarget('CustomField:acc.X')).toBe(false);
    expect(isUnresolvedApexCallTarget('Flow:foo')).toBe(false);
  });
});
