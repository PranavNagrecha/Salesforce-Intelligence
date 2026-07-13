/// <reference types="vitest/globals" />

import { extractApexAstEdges } from '../src/apex-ast-edges.js';

/**
 * R6-03 — inline-SOQL field-level reads: the full clause surface.
 *
 * The AST pass (`soqlFrom`) resolves every `FieldName` inside a parsed SOQL
 * expression to `{FromObject}.{Field}`, which the refresh maps to
 * `CustomField:{Object}.{Field}` readsFrom edges at `confidence: 'parsed'`.
 * A field referenced ONLY inside a query — never dot-accessed — must still
 * produce a read, or `unused_fields_deep` / `safe_to_delete_field` would
 * call it unused: a false-"safe" on a destructive verdict.
 *
 * This suite pins the clause-by-clause contract (SELECT, WHERE-only,
 * ORDER BY, GROUP BY / ROLLUP, HAVING, aggregate + date-function arguments,
 * bind expressions) plus the two honesty boundaries:
 *   - string-BUILT (concatenated) dynamic SOQL emits NOTHING — the blind
 *     spot stays disclosed, never guessed at;
 *   - object/field tokens are kept VERBATIM (SOQL is case-insensitive, the
 *     graph is not) — case-folding onto the vaulted node id is owned by
 *     `canonicalizeFieldEdgeTargets` at import time, not by the parser.
 *
 * Scope-attribution edge cases (child subqueries, semi-joins, TYPEOF) are
 * pinned separately in apex-ast-spike.test.ts (CR-06 / H5).
 */
describe('inline-SOQL field-level reads across clauses (R6-03)', () => {
  /** Wrap an inline `[SELECT ...]` query as an Apex method body. */
  const inline = (soql: string): readonly string[] =>
    extractApexAstEdges(
      `public class Q { public void run() { List<SObject> r = ${soql}; } }`,
      'Q',
      {},
    ).reads;

  it('plain SELECT list: every selected field reads from the FROM object', () => {
    expect(inline('[SELECT Id, Name, Custom_Score__c FROM Account]')).toEqual([
      'Account.Custom_Score__c',
      'Account.Id',
      'Account.Name',
    ]);
  });

  it('WHERE-only field (never selected, never dot-accessed) still emits a read', () => {
    // THE false-"safe" scenario: Custom_Flag__c appears ONLY in the WHERE
    // clause. Without this read, a deletion verdict would see zero evidence.
    const reads = inline('[SELECT Id FROM Account WHERE Custom_Flag__c = true]');
    expect(reads).toContain('Account.Custom_Flag__c');
  });

  it('ORDER BY field emits a read', () => {
    const reads = inline('[SELECT Id FROM Account ORDER BY Rating__c DESC NULLS LAST]');
    expect(reads).toContain('Account.Rating__c');
  });

  it('GROUP BY ROLLUP fields emit reads', () => {
    const reads = inline('[SELECT COUNT(Id) FROM Account GROUP BY ROLLUP(Industry, Type)]');
    expect(reads).toContain('Account.Industry');
    expect(reads).toContain('Account.Type');
  });

  it('HAVING aggregate argument emits a read', () => {
    const reads = inline(
      '[SELECT COUNT(Id), StageName FROM Opportunity GROUP BY StageName HAVING SUM(Amount) > 100]',
    );
    expect(reads).toContain('Opportunity.Amount');
  });

  it('date-function argument in WHERE emits the underlying field', () => {
    const reads = inline('[SELECT Id FROM Opportunity WHERE CALENDAR_YEAR(CloseDate) = 2020]');
    expect(reads).toContain('Opportunity.CloseDate');
  });

  it('aggregate alias is NOT emitted as a field', () => {
    // `cnt` is a result alias, not a field on Account.
    expect(inline('[SELECT COUNT(Id) cnt, Name FROM Account GROUP BY Name]')).toEqual([
      'Account.Id',
      'Account.Name',
    ]);
  });

  it('bind expression fields resolve through the APEX symbol table, not the FROM object', () => {
    // `:acc.Priority__c` is an Apex dot-chain on a declared Account variable —
    // it must read Account.Priority__c (dot-chain pass), never
    // Contact.Priority__c (the FROM object) and never a raw `acc.` token.
    const out = extractApexAstEdges(
      [
        'public class Q {',
        '  public void run(Account acc) {',
        '    List<Contact> r = [SELECT Id FROM Contact WHERE OwnerId = :acc.Priority__c];',
        '  }',
        '}',
      ].join('\n'),
      'Q',
      {},
    );
    expect(out.reads).toContain('Contact.Id');
    expect(out.reads).toContain('Contact.OwnerId');
    expect(out.reads).toContain('Account.Priority__c');
    expect(out.reads).not.toContain('Contact.Priority__c');
    expect(out.reads.some((r) => r.startsWith('acc.'))).toBe(false);
  });

  it('relationship path stays verbatim after the FROM object (first-two-segment mapping happens downstream)', () => {
    const reads = inline('[SELECT Id, Account.Owner.Name FROM Contact]');
    expect(reads).toContain('Contact.Account.Owner.Name');
    // never re-keyed onto the traversed object — that would be a guessed hop
    expect(reads.some((r) => r.startsWith('Account.'))).toBe(false);
  });

  it('SOQL inside a for-each loop emits the same reads', () => {
    const out = extractApexAstEdges(
      [
        'public class Q {',
        '  public void run() {',
        "    for (Account a : [SELECT Id FROM Account WHERE Region__c = 'EMEA' ORDER BY Score__c]) {",
        '      System.debug(a.Id);',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      'Q',
      {},
    );
    expect(out.reads).toContain('Account.Region__c');
    expect(out.reads).toContain('Account.Score__c');
  });

  it('SOQL inside a trigger unit emits reads', () => {
    const out = extractApexAstEdges(
      [
        'trigger AccT on Account (before insert) {',
        '  List<Contact> cs = [SELECT Id, Level__c FROM Contact WHERE AccountId != null];',
        '}',
      ].join('\n'),
      'AccT',
      { kind: 'trigger' },
    );
    expect(out.parseError).toBeUndefined();
    expect(out.reads).toContain('Contact.Level__c');
    expect(out.reads).toContain('Contact.AccountId');
  });

  it('string-BUILT dynamic SOQL emits NOTHING (disclosed blind spot, never guessed)', () => {
    const out = extractApexAstEdges(
      [
        'public class Q {',
        '  public void run(String f) {',
        "    String q = 'SELECT Id, ' + f + ' FROM Account WHERE Hidden__c = true';",
        '    List<SObject> r = Database.query(q);',
        '  }',
        '}',
      ].join('\n'),
      'Q',
      {},
    );
    expect(out.parseError).toBeUndefined();
    // Hidden__c lives only inside a concatenated string — no parsed read may
    // claim it; the blind spot is disclosed by consumers, not papered over.
    expect(out.reads).toEqual([]);
  });

  it('CONSTANT-string Database.query IS parsed (the one dynamic form the AST can prove)', () => {
    const out = extractApexAstEdges(
      [
        'public class Q {',
        '  public void run() {',
        "    List<SObject> r = Database.query('SELECT Id FROM Account WHERE Legacy_Code__c != null');",
        '  }',
        '}',
      ].join('\n'),
      'Q',
      {},
    );
    expect(out.reads).toContain('Account.Legacy_Code__c');
  });

  it('object/field tokens are kept VERBATIM — case-folding is the import layer\'s job', () => {
    // SOQL is case-insensitive; the parser must not invent a casing. The
    // graph import canonicalizes onto the vaulted node id
    // (canonicalizeFieldEdgeTargets); the parser pins the raw evidence.
    expect(inline('[select id from account where custom_flag__c = true]')).toEqual([
      'account.custom_flag__c',
      'account.id',
    ]);
  });
});
