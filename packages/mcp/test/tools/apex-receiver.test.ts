/// <reference types="vitest/globals" />

import {
  APEX_RECEIVER_TOKEN_CAP,
  apexReceiverDemotionNote,
  apexReceiverTokens,
  buildApexReceiverVerification,
  classifyApexTarget,
  isUnresolvedApexCallTarget,
  isUnresolvedFieldReceiver,
  partitionApexActions,
  type ApexReceiverIndex,
  type ApexReceiverKind,
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

// =============================================================================
// APEX-RECEIVER-VERIFIED (FAIL-BEFORE / PASS-AFTER)
//
// The two lexical predicates above catch a LOWERCASE receiver and nothing else,
// which is why they were never enough: a receiver that merely LOOKS like an
// SObject (`PascalCase`, `Thing__c`, `ns__Thing__c`) was emitted as a real
// component id no matter what it named. These exercise the graph-verified
// classification that supersedes them, including the failed-query path — where
// falling back to the lexical guess IS the defect.
// =============================================================================

/** A stand-in for the batched vault answer, so these stay pure unit tests. */
const indexOf = (
  kinds: Readonly<Record<string, ApexReceiverKind>>,
): ApexReceiverIndex => ({
  tokenCount: Object.keys(kinds).length,
  kindOf: (receiver) => kinds[receiver] ?? 'not-in-vault',
});

describe('classifyApexTarget', () => {
  const index = indexOf({ BoxedObj: 'sobject', ResultBox: 'apex-type' });

  it('claims a field ONLY when its receiver names an SObject node', () => {
    const v = classifyApexTarget('CustomField:BoxedObj.Stage__c', index);
    expect(v.resolved).toBe(true);
    if (v.resolved) expect(v.componentId).toBe('CustomField:BoxedObj.Stage__c');
  });

  it('demotes an APEX-TYPE receiver — the shape the lexical test could not see', () => {
    const v = classifyApexTarget('CustomField:ResultBox.isComplete', index);
    expect(v.resolved).toBe(false);
    if (!v.resolved) {
      // The token is RAW: never re-emitted with a `CustomField:` prefix.
      expect(v.unresolved).toEqual({
        token: 'ResultBox.isComplete',
        reason: 'apex-type-receiver',
      });
    }
  });

  it('separates the four other demotion tiers by their own reason', () => {
    const cases: readonly [string, string][] = [
      ['CustomField:this.caseLogId', 'unresolved-receiver'],
      ['CustomField:acc.Status__c', 'unresolved-receiver'],
      ['CustomField:BoxedObj.fields', 'describe-token'],
      ['CustomField:BoxedObj.SObjectType', 'describe-token'],
      ['CustomField:Parent__r.Code__c', 'relationship-traversal'],
      ['CustomField:BoxedObj.Parent__r.Code__c', 'relationship-traversal'],
      ['CustomField:NotHere.Name', 'receiver-not-in-vault'],
    ];
    for (const [id, reason] of cases) {
      const v = classifyApexTarget(id, index);
      expect(v.resolved).toBe(false);
      if (!v.resolved) expect(v.unresolved.reason).toBe(reason);
    }
  });

  it('classifies an object-LEVEL target the same way', () => {
    expect(classifyApexTarget('CustomObject:BoxedObj', index).resolved).toBe(true);
    const apexType = classifyApexTarget('CustomObject:ResultBox', index);
    expect(apexType.resolved).toBe(false);
    if (!apexType.resolved) expect(apexType.unresolved.reason).toBe('apex-type-receiver');
  });

  it('leaves an id with no receiver alone — this function must not demote it', () => {
    // A `callsApex` target / a Flow id is the caller's business.
    expect(classifyApexTarget('ApexClass:Helper', index).resolved).toBe(true);
    expect(classifyApexTarget('Flow:Some_Flow', index).resolved).toBe(true);
  });

  it('a NULL index (failed query) demotes everything as receiver-not-verified', () => {
    // Never a silent fall back to the lexical guess: a failed check is NOT
    // CHECKED, and nothing may be claimed on it.
    const v = classifyApexTarget('CustomField:BoxedObj.Stage__c', null);
    expect(v.resolved).toBe(false);
    if (!v.resolved) expect(v.unresolved.reason).toBe('receiver-not-verified');
    const o = classifyApexTarget('CustomObject:BoxedObj', null);
    expect(o.resolved).toBe(false);
    if (!o.resolved) expect(o.unresolved.reason).toBe('receiver-not-verified');
  });
});

describe('apexReceiverTokens', () => {
  it('collects one token per distinct receiver, ignoring non-receiver ids', () => {
    expect(
      [
        ...apexReceiverTokens([
          'CustomField:BoxedObj.A__c',
          'CustomField:BoxedObj.B__c',
          'CustomObject:Other',
          'ApexClass:Helper',
          'CustomField:NoDotHere',
        ]),
      ].sort(),
    ).toEqual(['BoxedObj', 'Other']);
  });
});

describe('partitionApexActions', () => {
  const index = indexOf({ BoxedObj: 'sobject', ResultBox: 'apex-type' });

  it('keeps verified field actions and demotes the rest with a reason', () => {
    const split = partitionApexActions(
      [
        { kind: 'readsFrom', targetId: 'CustomField:BoxedObj.Stage__c' },
        { kind: 'writesTo', targetId: 'CustomField:ResultBox.isComplete' },
        { kind: 'sendsEmail', targetId: 'EmailTemplate:Welcome' },
      ],
      index,
    );
    expect(split.kept.map((a) => a.targetId)).toEqual([
      'CustomField:BoxedObj.Stage__c',
      'EmailTemplate:Welcome',
    ]);
    expect(split.demoted).toEqual([
      { token: 'ResultBox.isComplete', reason: 'apex-type-receiver' },
    ]);
  });

  it('RETURNS the local-variable call targets it used to delete silently', () => {
    const split = partitionApexActions(
      [
        { kind: 'callsApex', targetId: 'ApexClass:oldMap' },
        { kind: 'dispatchesAsync', targetId: 'ApexClass:acc' },
        { kind: 'callsApex', targetId: 'ApexClass:RealHelper' },
      ],
      index,
    );
    expect(split.kept.map((a) => a.targetId)).toEqual(['ApexClass:RealHelper']);
    expect(split.demoted.map((d) => d.token)).toEqual(['oldMap', 'acc']);
  });

  it('keeps an action with no targetId', () => {
    const split = partitionApexActions([{ kind: 'readsFrom' }], index);
    expect(split.kept).toHaveLength(1);
    expect(split.demoted).toHaveLength(0);
  });
});

describe('buildApexReceiverVerification', () => {
  it('dedupes by token and reports a CHECKED census', () => {
    const v = buildApexReceiverVerification(
      [
        { token: 'ResultBox.isComplete', reason: 'apex-type-receiver' },
        { token: 'ResultBox.isComplete', reason: 'apex-type-receiver' },
        { token: 'A.fields', reason: 'describe-token' },
      ],
      null,
    );
    expect(v.checked).toBe(true);
    expect(v.reason).toBe(null);
    expect(v.demoted).toEqual({ 'apex-type-receiver': 1, 'describe-token': 1 });
    expect(v.tokens).toEqual([
      { token: 'A.fields', reason: 'describe-token' },
      { token: 'ResultBox.isComplete', reason: 'apex-type-receiver' },
    ]);
    expect(v.tokensTruncated).toBe(false);
  });

  it('an EMPTY demotion list is a CHECKED zero, not an absence', () => {
    const v = buildApexReceiverVerification([], null);
    expect(v.checked).toBe(true);
    // `{}` (checked, nothing demoted) — never `null`, which means NOT CHECKED.
    expect(v.demoted).toEqual({});
  });

  it('a failed query is checked:false with the reason and a NULL census', () => {
    const v = buildApexReceiverVerification([], 'graph read failed: disk error');
    expect(v.checked).toBe(false);
    expect(v.reason).toBe('graph read failed: disk error');
    // Absent, never fabricated as a zero: there IS no census.
    expect(v.demoted).toBe(null);
  });

  it('caps the token sample and says so, while the census stays complete', () => {
    const many = Array.from({ length: APEX_RECEIVER_TOKEN_CAP + 5 }, (_, i) => ({
      token: `Box${String(i).padStart(3, '0')}.x`,
      reason: 'receiver-not-in-vault' as const,
    }));
    const v = buildApexReceiverVerification(many, null);
    expect(v.tokens).toHaveLength(APEX_RECEIVER_TOKEN_CAP);
    expect(v.tokensTruncated).toBe(true);
    expect(v.demoted).toEqual({
      'receiver-not-in-vault': APEX_RECEIVER_TOKEN_CAP + 5,
    });
  });
});

describe('apexReceiverDemotionNote', () => {
  it('says CHECKED-and-nothing-demoted for a zero census', () => {
    const note = apexReceiverDemotionNote({}, 'fieldAccess', 'unresolvedFieldAccess');
    expect(note).toContain('CHECKED');
    expect(note).toContain('CHECKED-and-empty');
  });

  it('names every reason and its count', () => {
    const note = apexReceiverDemotionNote(
      { 'apex-type-receiver': 2, 'describe-token': 1 },
      'fieldAccess',
      'unresolvedFieldAccess',
    );
    expect(note).toContain('3 DISTINCT Apex field-access token(s)');
    expect(note).toContain('2 apex-type-receiver');
    expect(note).toContain('1 describe-token');
  });
});
