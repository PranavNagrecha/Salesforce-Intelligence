/// <reference types="vitest/globals" />

import {
  detectPicklistLiteralMismatch,
  extractEqualityLiterals,
  scanSoqlForPicklistMismatches,
} from '../../src/tools/picklist-literal-check.js';

describe('extractEqualityLiterals', () => {
  it('pulls a single field = "literal" equality', () => {
    const eqs = extractEqualityLiterals(
      "SELECT COUNT() FROM Account WHERE Status__c = 'Withdrawn'",
    );
    expect(eqs).toEqual([{ field: 'Status__c', literals: ['Withdrawn'] }]);
  });

  it('expands an IN (...) list into multiple literals', () => {
    const eqs = extractEqualityLiterals(
      "SELECT Id FROM Account WHERE Status__c IN ('Open', 'Closed')",
    );
    expect(eqs).toEqual([
      { field: 'Status__c', literals: ['Open', 'Closed'] },
    ]);
  });

  it('ignores non-equality operators (LIKE / >)', () => {
    const eqs = extractEqualityLiterals(
      "SELECT Id FROM Account WHERE Name LIKE 'A%' AND Age > 5",
    );
    expect(eqs).toEqual([]);
  });

  it('unescapes a backslash-escaped quote in a literal', () => {
    const eqs = extractEqualityLiterals(
      "SELECT Id FROM Account WHERE Name = 'O\\'Brien'",
    );
    expect(eqs).toEqual([{ field: 'Name', literals: ["O'Brien"] }]);
  });
});

describe('detectPicklistLiteralMismatch', () => {
  // A re-extracted (object-shaped) picklist with one DEACTIVATED value.
  const objValues = [
    { value: 'Withdrawn Application', isActive: true },
    { value: 'Withdraw Transfer', isActive: true },
    { value: 'Withdrawn Change', isActive: false },
    { value: 'Submitted', isActive: true },
  ];

  it('reports a literal that matches NO defined picklist value (the Withdrawn bug)', () => {
    const m = detectPicklistLiteralMismatch(
      'Status__c',
      ['Withdrawn'],
      objValues,
    );
    expect(m).not.toBeNull();
    expect(m?.unmatchedLiterals).toEqual(['Withdrawn']);
    // The real variants are surfaced as near-match suggestions.
    expect(m?.suggestions).toContain('Withdrawn Application');
    expect(m?.disclosure).toMatch(/not a defined picklist value/i);
    expect(m?.disclosure).toMatch(/Withdrawn Application/);
  });

  it('returns null when the literal exactly matches a defined value', () => {
    expect(
      detectPicklistLiteralMismatch('Status__c', ['Submitted'], objValues),
    ).toBeNull();
  });

  it('matches case-insensitively (no false alarm on casing)', () => {
    expect(
      detectPicklistLiteralMismatch('Status__c', ['submitted'], objValues),
    ).toBeNull();
  });

  it('matches an INACTIVE value (records may still hold it)', () => {
    expect(
      detectPicklistLiteralMismatch('Status__c', ['Withdrawn Change'], objValues),
    ).toBeNull();
  });

  it('tolerates the legacy bare-string picklist shape', () => {
    const m = detectPicklistLiteralMismatch(
      'Status__c',
      ['Withdrawn'],
      ['Withdrawn Application', 'Submitted'],
    );
    expect(m).not.toBeNull();
    expect(m?.suggestions).toContain('Withdrawn Application');
  });

  it('returns null when the field has no inline picklist definition (not a picklist)', () => {
    expect(
      detectPicklistLiteralMismatch('Notes__c', ['anything'], undefined),
    ).toBeNull();
    expect(
      detectPicklistLiteralMismatch('Notes__c', ['anything'], null),
    ).toBeNull();
  });

  it('flags every literal of an IN list that misses', () => {
    const m = detectPicklistLiteralMismatch(
      'Status__c',
      ['Withdrawn', 'Cancelled'],
      objValues,
    );
    expect(m?.unmatchedLiterals).toEqual(['Withdrawn', 'Cancelled']);
  });
});

describe('scanSoqlForPicklistMismatches', () => {
  const lookup = (ref: string): unknown =>
    ref === 'Status__c'
      ? ['Withdrawn Application', 'Withdraw Transfer', 'Submitted']
      : null;

  it('flags the non-existent Withdrawn literal in a full SOQL string', () => {
    const out = scanSoqlForPicklistMismatches(
      "SELECT COUNT() FROM AcmeApplication__c WHERE Status__c = 'Withdrawn'",
      lookup,
    );
    expect(out).toHaveLength(1);
    const first = out[0];
    expect(first?.field).toBe('Status__c');
    expect(first?.disclosure).toMatch(/Withdrawn Application/);
  });

  it('returns empty when the literal is a real value', () => {
    const out = scanSoqlForPicklistMismatches(
      "SELECT COUNT() FROM AcmeApplication__c WHERE Status__c = 'Submitted'",
      lookup,
    );
    expect(out).toHaveLength(0);
  });

  it('skips fields with no inline picklist definition', () => {
    const out = scanSoqlForPicklistMismatches(
      "SELECT Id FROM AcmeApplication__c WHERE Name = 'Nope'",
      lookup,
    );
    expect(out).toHaveLength(0);
  });
});
