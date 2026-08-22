/// <reference types="vitest/globals" />

import { tokenizeFormula } from '../src/formula-tokenizer.js';

describe('tokenizeFormula error cases', () => {
  it('rejects an empty formula with empty-formula', () => {
    const result = tokenizeFormula('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty-formula');
    expect(result.error.offset).toBe(0);
  });

  it('rejects a whitespace-only formula with empty-formula', () => {
    const result = tokenizeFormula('   \n\t  ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('empty-formula');
  });

  it('rejects an unterminated string literal at the opening-quote offset', () => {
    const result = tokenizeFormula("'unclosed");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unterminated-string');
    expect(result.error.offset).toBe(0);
  });

  it('rejects an unbalanced opening parenthesis', () => {
    const result = tokenizeFormula('IF(Industry__c');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unbalanced-parenthesis');
  });
});

describe('tokenizeFormula references — happy paths', () => {
  it('extracts a single field reference from a bare identifier', () => {
    const result = tokenizeFormula('Industry__c');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.references).toHaveLength(1);
    expect(result.value.references[0]?.path).toBe('Industry__c');
    expect(result.value.functionCalls).toEqual([]);
  });

  it('separates function calls from field references', () => {
    const result = tokenizeFormula('ISBLANK(Industry__c)');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['Industry__c']);
    expect(result.value.functionCalls).toEqual(['ISBLANK']);
  });

  it('handles nested function calls and multiple references', () => {
    const result = tokenizeFormula(
      'IF(AND(NOT(ISBLANK(X__c)), Y__c > 0), TRUE, FALSE)',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['X__c', 'Y__c']);
    expect(result.value.functionCalls).toEqual(['AND', 'IF', 'ISBLANK', 'NOT']);
  });

  it('preserves a single-hop dotted path as one reference', () => {
    const result = tokenizeFormula('Account.Industry__c');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.references).toHaveLength(1);
    expect(result.value.references[0]?.path).toBe('Account.Industry__c');
  });

  it('preserves a multi-segment dotted path verbatim', () => {
    const result = tokenizeFormula('Owner.Account.Name');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.references).toHaveLength(1);
    expect(result.value.references[0]?.path).toBe('Owner.Account.Name');
  });

  it('disambiguates function name from field reference by trailing paren', () => {
    const result = tokenizeFormula('LEN(Industry__c)');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['Industry__c']);
    expect(result.value.functionCalls).toEqual(['LEN']);
  });

  it('does not extract identifiers from inside string literals', () => {
    const result = tokenizeFormula("IF(TEXT(Status__c) = 'Closed', TRUE, FALSE)");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['Status__c']);
    expect(result.value.stringLiteralCount).toBe(1);
  });

  it('honors the doubled-quote escape inside string literals', () => {
    const result = tokenizeFormula("IF(Foo__c = 'don''t', TRUE, FALSE)");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['Foo__c']);
    expect(result.value.stringLiteralCount).toBe(1);
  });

  // Salesforce formula text literals are DOUBLE-quoted ("text"). Their
  // inner words must not surface as field references — otherwise the
  // formula-references extractor mints phantom dependency edges to fields
  // that do not exist.
  it('does not extract identifiers from inside double-quoted string literals', () => {
    const result = tokenizeFormula('IF(TEXT(Status__c) = "Closed Won", TRUE, FALSE)');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['Status__c']);
    expect(result.value.stringLiteralCount).toBe(1);
  });

  it('counts both double-quoted branches of IF as string literals, not field refs', () => {
    const result = tokenizeFormula('IF(Balance__c > 0, "Positive", "Negative")');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['Balance__c']);
    expect(result.value.stringLiteralCount).toBe(2);
    expect(result.value.numericLiteralCount).toBe(1);
  });

  it('handles a backslash-escaped quote inside a double-quoted literal', () => {
    // String.raw keeps `\"` literal: an escaped quote, not the terminator,
    // so the words after it stay inside the string.
    const result = tokenizeFormula(String.raw`Name__c & "x \" y"`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.references.map((r) => r.path)).toEqual(['Name__c']);
    expect(result.value.stringLiteralCount).toBe(1);
  });

  it('flags an unterminated double-quoted string', () => {
    const result = tokenizeFormula('Name__c & "oops');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unterminated-string');
  });

  it('ignores identifiers that appear only inside block comments', () => {
    const result = tokenizeFormula('/* this is a comment */ Industry__c');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['Industry__c']);
  });

  it('skips TRUE, FALSE, and NULL as keyword literals, not references', () => {
    const result = tokenizeFormula('IF(Foo__c = TRUE, NULL, FALSE)');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['Foo__c']);
  });

  it('collects $Variable special-variable paths in globalReferences, not references', () => {
    const result = tokenizeFormula(
      "IF($Profile.Name = 'Admin', TRUE, FALSE)",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // $-prefixed paths are no longer silently dropped: they're surfaced
    // on the dedicated globalReferences channel and kept out of the
    // field `references` (so they don't pollute field-edge extraction).
    expect(result.value.references).toEqual([]);
    expect(result.value.functionCalls).toEqual(['IF']);
    const globalPaths = result.value.globalReferences.map((g) => g.path);
    expect(globalPaths).toEqual(['$Profile.Name']);
  });

  it('collects multiple distinct $Variable globals (e.g. $User and $Setup)', () => {
    const result = tokenizeFormula(
      'IF($User.IsActive, $Setup.MyConfig__c.Threshold__c, 0)',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.references).toEqual([]);
    const globalPaths = result.value.globalReferences.map((g) => g.path).sort();
    expect(globalPaths).toEqual([
      '$Setup.MyConfig__c.Threshold__c',
      '$User.IsActive',
    ]);
    // The matched text is preserved verbatim with offsets into the source.
    for (const g of result.value.globalReferences) {
      expect(g.length).toBe(g.path.length);
    }
  });

  it('treats function-name lookup as case-insensitive', () => {
    const result = tokenizeFormula('if(isblank(Industry__c), 1, 0)');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toEqual(['Industry__c']);
    expect(result.value.functionCalls).toEqual(['IF', 'ISBLANK']);
    expect(result.value.numericLiteralCount).toBe(2);
  });
});

describe('tokenizeFormula real-world fixture', () => {
  it('handles a real-org validation-rule formula (multi-ref, no dedup)', () => {
    const errorConditionFormula =
      "AND(\n" +
      "TEXT( Student_Status__c )='Enrolled-Active',\n" +
      ' ISCHANGED(Widget_Advisor__c),\n' +
      '  ISBLANK(Widget_Advisor__c)\n' +
      ')';
    const result = tokenizeFormula(errorConditionFormula);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.references.map((r) => r.path);
    expect(paths).toContain('Student_Status__c');
    expect(paths).toContain('Widget_Advisor__c');
    // Two occurrences of Widget_Advisor__c — tokenizer does NOT
    // deduplicate; the caller does that when forming edges.
    expect(paths.filter((p) => p === 'Widget_Advisor__c')).toHaveLength(2);
    expect(result.value.functionCalls).toEqual([
      'AND',
      'ISBLANK',
      'ISCHANGED',
      'TEXT',
    ]);
    expect(result.value.stringLiteralCount).toBe(1);
  });
});

describe('tokenizeFormula determinism', () => {
  it('returns identical output for repeated calls with the same input', () => {
    const formula = "AND(ISBLANK(Foo__c), TEXT(Bar__c) = 'x')";
    const a = tokenizeFormula(formula);
    const b = tokenizeFormula(formula);
    expect(a).toEqual(b);
  });
});

/**
 * FIX 11 — the tokenizer emits the literal TEXT it already read.
 *
 * `stringLiteralCount` / `numericLiteralCount` stay exactly as they were (the
 * only fields the pre-existing tests assert), so back-compat is free.
 */
describe('tokenizeFormula — literal values (FIX 11)', () => {
  it('emits numeric literals as raw source text in source order', () => {
    const r = tokenizeFormula('IF(Amount__c > 2000, 2000, 1)');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.numericLiterals).toEqual(['2000', '2000', '1']);
    expect(r.value.numericLiteralCount).toBe(3);
  });

  it('emits string literals with quotes stripped', () => {
    const r = tokenizeFormula("TEXT(Status__c) = 'Completed'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stringLiterals).toEqual(['Completed']);
    expect(r.value.stringLiteralCount).toBe(1);
  });

  it("unescapes the doubled-quote form ('it''s' -> it's)", () => {
    const r = tokenizeFormula("IF(TRUE, 'it''s', 'no')");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stringLiterals).toEqual(["it's", 'no']);
  });

  it('never counts a literal inside a comment', () => {
    const r = tokenizeFormula("/* 999 'hidden' */ Amount__c + 1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stringLiterals).toEqual([]);
    expect(r.value.numericLiterals).toEqual(['1']);
  });
});
