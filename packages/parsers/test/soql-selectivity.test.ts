/// <reference types="vitest/globals" />

import { extractSoqlSelectivityFacts } from '../src/soql-selectivity.js';

/**
 * WHERE-clause selectivity walker — the parser-grade extraction the index-aware
 * non-selective-SOQL analysis needs (the existing `readsFrom` edges track WHICH
 * fields a query reads, NOT whether a field is a WHERE-clause filter predicate,
 * with what operator, against what value shape).
 *
 * Every fixture is a synthetic Apex source parsed through the real ANTLR pass —
 * only Account / Contact + generic placeholder fields, no org identifiers.
 */

const cls = (body: string): string => `public class C { void m(){ ${body} } }`;

describe('extractSoqlSelectivityFacts — inline query WHERE walk', () => {
  it('captures the FROM object, field, operator, and value shape of each predicate', () => {
    const r = extractSoqlSelectivityFacts(
      cls(`List<Account> a = [SELECT Id FROM Account WHERE Industry__c = 'Tech'];`),
    );
    expect(r.parseError).toBeNull();
    expect(r.queries).toHaveLength(1);
    const q = r.queries[0]!;
    expect(q.sObject).toBe('Account');
    expect(q.hasWhereClause).toBe(true);
    expect(q.whereFilters).toHaveLength(1);
    expect(q.whereFilters[0]).toMatchObject({
      field: 'Industry__c',
      operator: 'eq',
      valueShape: 'stringLiteral',
      leadingWildcard: false,
      relationshipTraversal: false,
    });
  });

  it('flags a LEADING-wildcard LIKE (but not a trailing one)', () => {
    const lead = extractSoqlSelectivityFacts(
      cls(`List<Account> a = [SELECT Id FROM Account WHERE Name LIKE '%foo'];`),
    ).queries[0]!;
    expect(lead.hasLeadingWildcardLike).toBe(true);
    expect(lead.whereFilters[0]?.leadingWildcard).toBe(true);

    const trail = extractSoqlSelectivityFacts(
      cls(`List<Account> a = [SELECT Id FROM Account WHERE Name LIKE 'foo%'];`),
    ).queries[0]!;
    expect(trail.hasLeadingWildcardLike).toBe(false);
    expect(trail.whereFilters[0]?.leadingWildcard).toBe(false);
  });

  it('normalizes negative operators (!=, <>, NOT IN, EXCLUDES)', () => {
    const q = extractSoqlSelectivityFacts(
      cls(
        `List<Account> a = [SELECT Id FROM Account WHERE Status__c != 'X' AND Type <> 'Y' AND Region__c NOT IN ('Z')];`,
      ),
    ).queries[0]!;
    expect(q.hasNegativeOperator).toBe(true);
    expect(q.whereFilters.map((f) => f.operator)).toEqual(['neq', 'neq', 'notIn']);
  });

  it('marks a relationship traversal and captures a bind value shape', () => {
    const q = extractSoqlSelectivityFacts(
      cls(`List<Contact> a = [SELECT Id FROM Contact WHERE Account.Industry__c = :val];`),
    ).queries[0]!;
    expect(q.whereFilters[0]).toMatchObject({
      field: 'Account.Industry__c',
      relationshipTraversal: true,
      valueShape: 'bind',
    });
  });

  it('reports no WHERE clause distinctly from an empty predicate list', () => {
    const q = extractSoqlSelectivityFacts(
      cls(`List<Account> a = [SELECT Id FROM Account];`),
    ).queries[0]!;
    expect(q.hasWhereClause).toBe(false);
    expect(q.whereFilters).toHaveLength(0);
  });

  it('attributes a semi-join subquery predicate to the SUBQUERY, not the outer object (scope-aware)', () => {
    // The outer WHERE has one top-level predicate (Id IN (subquery)); the inner
    // `Email != 'x'` belongs to the Contact subquery and must NOT appear as an
    // Account predicate.
    const q = extractSoqlSelectivityFacts(
      cls(
        `List<Account> a = [SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Email != 'x')];`,
      ),
    ).queries[0]!;
    expect(q.sObject).toBe('Account');
    expect(q.whereFilters.map((f) => f.field)).toEqual(['Id']);
    expect(q.whereFilters[0]?.operator).toBe('in');
    expect(q.hasNegativeOperator).toBe(false); // the inner `Email != 'x'` is out of scope
  });

  it('returns a parseError (no facts) for source the grammar cannot parse — a caller blind spot', () => {
    const r = extractSoqlSelectivityFacts('public class Broken { void m() { ');
    expect(r.parseError).not.toBeNull();
    expect(r.queries).toHaveLength(0);
  });
});
