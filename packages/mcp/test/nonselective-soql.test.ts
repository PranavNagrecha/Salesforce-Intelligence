/// <reference types="vitest/globals" />

/**
 * Unit tests for the PURE selectivity classifier of `sfi.nonselective_soql`.
 *
 * Every fixture is a SYNTHETIC parsed-query fact + a synthetic {@link IndexOracle}
 * — no vault, no DuckDB, no ANTLR, no org identifiers (only Account / Contact and
 * generic placeholder field names). The whole point of factoring `classifyQuery`
 * out of the handler is that the selectivity logic + index rules are testable with
 * zero I/O.
 *
 * Coverage mirrors the pass/fail axis: a WHERE on only a non-indexed custom text
 * field → nonSelective (HIGH); a WHERE including Id / a lookup / an ExternalId →
 * selective (NOT flagged); a leading-wildcard LIKE → flagged; a `!=`-only WHERE →
 * flagged; a CustomIndex-covered field → selective; no-WHERE → flagged; a
 * relationship traversal → selective; and the unknown-object suppression guard.
 */

import type {
  SoqlOperator,
  SoqlSelectivityFact,
  SoqlValueShape,
  SoqlWhereFilter,
} from '@sf-intelligence/parsers/soql-selectivity';

import {
  classifyQuery,
  isStandardForeignKeyName,
  STANDARD_INDEXED_FIELDS,
  type IndexOracle,
} from '../src/tools/nonselective-soql.js';

// ---- synthetic fixture builders -------------------------------------------

const filter = (
  field: string,
  operator: SoqlOperator,
  extra?: {
    leadingWildcard?: boolean;
    valueShape?: SoqlValueShape;
    relationshipTraversal?: boolean;
  },
): SoqlWhereFilter => ({
  field,
  operator,
  valueShape: extra?.valueShape ?? 'bind',
  leadingWildcard: extra?.leadingWildcard ?? false,
  relationshipTraversal: extra?.relationshipTraversal ?? field.includes('.'),
});

const NEGATIVE = new Set<SoqlOperator>(['neq', 'notIn', 'excludes']);

const query = (
  filters: readonly SoqlWhereFilter[],
  opts?: { sObject?: string; hasWhereClause?: boolean },
): SoqlSelectivityFact => ({
  sObject: opts?.sObject ?? 'Account',
  whereFilters: filters,
  hasWhereClause: opts?.hasWhereClause ?? filters.length > 0,
  hasLeadingWildcardLike: filters.some((f) => f.leadingWildcard),
  hasNegativeOperator: filters.some((f) => NEGATIVE.has(f.operator)),
  line: 1,
});

/** An oracle over a known object whose indexed fields are exactly `indexed`. */
const oracle = (...indexed: string[]): IndexOracle => {
  const set = new Set(indexed.map((f) => f.toLowerCase()));
  return { objectKnown: true, isIndexed: (f) => set.has(f.toLowerCase()) };
};

/** An oracle for an object NOT in the vault (custom indexes unknown). */
const unknownObject: IndexOracle = { objectKnown: false, isIndexed: () => false };

describe('classifyQuery — core "only non-indexed filters" rule', () => {
  it('flags a WHERE on only a non-indexed custom text field as nonSelective (HIGH)', () => {
    const v = classifyQuery(query([filter('Description__c', 'eq')]), oracle());
    expect(v.selective).toBe(false);
    expect(v.rule).toBe('nonselective-non-indexed-filters');
    expect(v.severity).toBe('high');
  });

  it('does NOT flag when the WHERE includes an equality on Id (indexed) → selective', () => {
    const v = classifyQuery(
      query([filter('Id', 'eq'), filter('Description__c', 'eq')]),
      oracle('Id'),
    );
    expect(v.selective).toBe(true);
    expect(v.rule).toBeNull();
    expect(v.matchedIndexedFields).toContain('Id');
  });

  it('does NOT flag when the WHERE includes a lookup field (indexed) → selective', () => {
    // A custom lookup field the handler marks indexed via CustomField dataType.
    const v = classifyQuery(
      query([filter('Owner__c', 'eq')]),
      oracle('Owner__c'),
    );
    expect(v.selective).toBe(true);
    expect(v.rule).toBeNull();
  });

  it('does NOT flag when the WHERE includes an ExternalId field (indexed) → selective', () => {
    const v = classifyQuery(
      query([filter('Legacy_Key__c', 'eq'), filter('Status__c', 'eq')]),
      oracle('Legacy_Key__c'),
    );
    expect(v.selective).toBe(true);
    expect(v.rule).toBeNull();
  });

  it('does NOT flag when the sole filter is on a CustomIndex-covered field → selective', () => {
    const v = classifyQuery(
      query([filter('Region__c', 'eq')]),
      // the handler adds custom-index field names to the oracle set
      oracle('Region__c'),
    );
    expect(v.selective).toBe(true);
    expect(v.rule).toBeNull();
  });

  it('treats a range predicate on an indexed field as selective', () => {
    const v = classifyQuery(
      query([filter('CreatedDate', 'range')]),
      oracle('CreatedDate'),
    );
    expect(v.selective).toBe(true);
  });
});

describe('classifyQuery — leading-wildcard LIKE', () => {
  it('flags a lone leading-wildcard LIKE (MEDIUM), even on an indexed field', () => {
    const v = classifyQuery(
      query([filter('Name', 'like', { leadingWildcard: true, valueShape: 'stringLiteral' })]),
      oracle('Name'),
    );
    expect(v.selective).toBe(false);
    expect(v.rule).toBe('leading-wildcard-like');
    expect(v.severity).toBe('medium');
  });

  it('does NOT flag a trailing-wildcard LIKE on an indexed field → selective', () => {
    const v = classifyQuery(
      query([filter('Name', 'like', { leadingWildcard: false, valueShape: 'stringLiteral' })]),
      oracle('Name'),
    );
    expect(v.selective).toBe(true);
  });

  it('an indexed equality alongside a leading-wildcard LIKE stays selective (core rule suppressed)', () => {
    const v = classifyQuery(
      query([
        filter('Id', 'eq'),
        filter('Name', 'like', { leadingWildcard: true, valueShape: 'stringLiteral' }),
      ]),
      oracle('Id', 'Name'),
    );
    expect(v.selective).toBe(true);
  });
});

describe('classifyQuery — negative-operator-only', () => {
  it('flags a WHERE whose only filter is `!=` (MEDIUM)', () => {
    const v = classifyQuery(query([filter('Status__c', 'neq')]), oracle());
    expect(v.selective).toBe(false);
    expect(v.rule).toBe('negative-operator-only');
    expect(v.severity).toBe('medium');
  });

  it('flags NOT IN / EXCLUDES only filters', () => {
    expect(classifyQuery(query([filter('Type', 'notIn')]), oracle()).rule).toBe(
      'negative-operator-only',
    );
    expect(
      classifyQuery(query([filter('Tags__c', 'excludes')]), oracle()).rule,
    ).toBe('negative-operator-only');
  });

  it('a HIGH non-indexed positive predicate outranks a co-occurring negative', () => {
    const v = classifyQuery(
      query([filter('Description__c', 'eq'), filter('Status__c', 'neq')]),
      oracle(),
    );
    expect(v.rule).toBe('nonselective-non-indexed-filters');
    expect(v.severity).toBe('high');
  });
});

describe('classifyQuery — no WHERE clause', () => {
  it('flags a query with no WHERE clause (MEDIUM, unbounded)', () => {
    const v = classifyQuery(query([], { hasWhereClause: false }), oracle());
    expect(v.selective).toBe(false);
    expect(v.rule).toBe('no-where-clause');
    expect(v.severity).toBe('medium');
  });

  it('does NOT flag a WHERE that only used unresolvable (function) predicates', () => {
    const v = classifyQuery(query([], { hasWhereClause: true }), oracle());
    expect(v.selective).toBe(true);
    expect(v.rule).toBeNull();
  });
});

describe('classifyQuery — relationship traversal + unknown-object soundness', () => {
  it('treats a relationship-traversal equality as potentially selective (benefit of the doubt)', () => {
    const v = classifyQuery(
      query([filter('Account.Industry__c', 'eq', { relationshipTraversal: true })]),
      oracle(), // no indexed fields, but the relationship gets the benefit of the doubt
    );
    expect(v.selective).toBe(true);
  });

  it('SUPPRESSES the HIGH non-indexed rule when the FROM object is not in the vault', () => {
    const v = classifyQuery(query([filter('Weird__c', 'eq')]), unknownObject);
    expect(v.selective).toBe(true);
    expect(v.rule).toBeNull();
  });

  it('still flags a leading-wildcard LIKE even for an unknown object (operator-shape rule)', () => {
    const v = classifyQuery(
      query([filter('Weird__c', 'like', { leadingWildcard: true, valueShape: 'stringLiteral' })]),
      unknownObject,
    );
    expect(v.rule).toBe('leading-wildcard-like');
  });

  it('still flags a negative-only WHERE for an unknown object', () => {
    const v = classifyQuery(query([filter('Weird__c', 'neq')]), unknownObject);
    expect(v.rule).toBe('negative-operator-only');
  });

  it('does NOT flag an unknown object when a POSITIVE predicate could be a hidden index (managed lookup IN + negative)', () => {
    // The real-vault ContactAffiliation shape: `WHERE Managed_Lookup__c IN :ids
    // AND Other__c != null` on a managed object absent from the vault. The IN may
    // well be on a lookup index we cannot see — so we must not fall through to
    // negative-operator-only.
    const v = classifyQuery(
      query([filter('Managed_Lookup__c', 'in'), filter('Other__c', 'neq')]),
      unknownObject,
    );
    expect(v.selective).toBe(true);
    expect(v.rule).toBeNull();
  });
});

describe('standard-index table includes the developer-name index', () => {
  it('does NOT flag a Custom Metadata Type queried by DeveloperName (a standard unique-name index)', () => {
    const v = classifyQuery(
      query([filter('DeveloperName', 'eq')], { sObject: 'Config__mdt' }),
      // the handler's oracle treats DeveloperName as indexed via STANDARD_INDEXED_FIELDS
      { objectKnown: true, isIndexed: (f) => STANDARD_INDEXED_FIELDS.has(f.toLowerCase()) },
    );
    expect(v.selective).toBe(true);
    expect(STANDARD_INDEXED_FIELDS.has('developername')).toBe(true);
  });
});

describe('standard-index table + foreign-key naming rule', () => {
  it('recognizes the general standard-indexed field names', () => {
    for (const f of ['id', 'name', 'createddate', 'ownerid', 'recordtypeid', 'systemmodstamp']) {
      expect(STANDARD_INDEXED_FIELDS.has(f)).toBe(true);
    }
  });

  it('treats <Relationship>Id names as foreign keys, but not custom fields', () => {
    expect(isStandardForeignKeyName('AccountId')).toBe(true);
    expect(isStandardForeignKeyName('ParentId')).toBe(true);
    expect(isStandardForeignKeyName('WhatId')).toBe(true);
    // custom fields (even if they end in Id-ish) are resolved via dataType, not here
    expect(isStandardForeignKeyName('Legacy_Id__c')).toBe(false);
    expect(isStandardForeignKeyName('Status__c')).toBe(false);
    // bare 'Id' is covered by the standard table, not the FK-naming rule
    expect(isStandardForeignKeyName('Id')).toBe(false);
  });
});
