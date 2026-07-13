/// <reference types="vitest/globals" />

import {
  encodeCsvField,
  encodeCsvRow,
  fitCsvRowsToBudget,
  renderCsv,
  renderCsvComments,
  renderCsvWithDisclosures,
} from '../src/csv.js';

describe('encodeCsvField', () => {
  it('leaves a plain field unquoted', () => {
    expect(encodeCsvField('Account')).toBe('Account');
  });

  it('quotes a field containing a comma', () => {
    expect(encodeCsvField('a,b')).toBe('"a,b"');
  });

  it('quotes and doubles an embedded double quote', () => {
    expect(encodeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a field containing a line feed', () => {
    expect(encodeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('quotes a field containing a carriage return', () => {
    expect(encodeCsvField('line1\rline2')).toBe('"line1\rline2"');
  });

  it('handles unicode content without mangling it', () => {
    expect(encodeCsvField('Café résumé — 日本語')).toBe('Café résumé — 日本語');
  });

  it('quotes unicode content that also needs quoting', () => {
    expect(encodeCsvField('Café, résumé')).toBe('"Café, résumé"');
  });

  it('renders an empty string as an empty (unquoted) field', () => {
    expect(encodeCsvField('')).toBe('');
  });
});

describe('encodeCsvRow', () => {
  it('joins cells with commas', () => {
    expect(encodeCsvRow(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('stringifies numbers and booleans without quoting', () => {
    expect(encodeCsvRow([1, true, false, 3.5])).toBe('1,true,false,3.5');
  });

  it('renders null and undefined as empty fields', () => {
    expect(encodeCsvRow(['a', null, undefined, 'd'])).toBe('a,,,d');
  });

  it('quotes only the cells that need it', () => {
    expect(encodeCsvRow(['plain', 'has,comma', 'plain2'])).toBe(
      'plain,"has,comma",plain2',
    );
  });
});

describe('renderCsv', () => {
  it('renders a header row plus one data row per entry, newline-terminated', () => {
    const csv = renderCsv(['id', 'name'], [['1', 'Alice'], ['2', 'Bob']]);
    expect(csv).toBe('id,name\n1,Alice\n2,Bob\n');
  });

  it('renders header-only for an empty row set', () => {
    const csv = renderCsv(['id', 'name'], []);
    expect(csv).toBe('id,name\n');
  });

  it('round-trips through a naive line/comma split when no cell needs quoting', () => {
    const csv = renderCsv(['a', 'b'], [['x', 'y']]);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toEqual(['a,b', 'x,y']);
  });

  it('preserves row order (no implicit sorting)', () => {
    const csv = renderCsv(['id'], [['3'], ['1'], ['2']]);
    expect(csv).toBe('id\n3\n1\n2\n');
  });
});

describe('renderCsvComments', () => {
  it('prefixes each disclosure with `# `', () => {
    const out = renderCsvComments(['generated 2026-01-01', 'heuristic']);
    expect(out).toBe('# generated 2026-01-01\n# heuristic\n');
  });

  it('returns an empty string for zero disclosures', () => {
    expect(renderCsvComments([])).toBe('');
  });

  it('flattens an embedded newline in a disclosure to a single comment line', () => {
    const out = renderCsvComments(['line1\nline2']);
    expect(out).toBe('# line1 line2\n');
  });
});

describe('renderCsvWithDisclosures', () => {
  it('emits comment lines ahead of the header + rows', () => {
    const out = renderCsvWithDisclosures(
      ['generated 2026-01-01', 'heuristic recognizer'],
      ['id', 'name'],
      [['1', 'Alice']],
    );
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('# generated 2026-01-01');
    expect(lines[1]).toBe('# heuristic recognizer');
    expect(lines[2]).toBe('id,name');
    expect(lines[3]).toBe('1,Alice');
  });

  it('a downstream CSV parser sees comment lines as ordinary (ignorable) rows', () => {
    // Sanity: verify the comment lines don't collide with real column counts
    // — a naive split-on-comma parser sees the disclosure as a single cell.
    const out = renderCsvWithDisclosures(['note'], ['a', 'b'], [['1', '2']]);
    const rows = out.trimEnd().split('\n').map((l) => l.split(','));
    expect(rows[0]).toEqual(['# note']);
    expect(rows[1]).toEqual(['a', 'b']);
    expect(rows[2]).toEqual(['1', '2']);
  });
});

describe('fitCsvRowsToBudget', () => {
  const bigRows = (n: number): readonly (readonly string[])[] =>
    Array.from({ length: n }, (_, i) => [
      String(i),
      `Field_${String(i)}__c`,
      'a fairly verbose description that pads out the row length a bit',
    ]);

  it('returns the full CSV unchanged when it fits under budget', () => {
    const rows = bigRows(5);
    const fit = fitCsvRowsToBudget(['generated 2026-01-01'], ['id', 'apiName', 'description'], rows, 100_000);
    expect(fit.truncated).toBe(false);
    expect(fit.keptRows).toBe(5);
    expect(fit.totalRows).toBe(5);
    expect(fit.csv).toContain('# generated 2026-01-01');
    expect(fit.csv).toContain('Field_4__c');
  });

  it('drops rows from the tail and appends a truncation comment when over budget', () => {
    const rows = bigRows(500);
    const fit = fitCsvRowsToBudget(['generated 2026-01-01'], ['id', 'apiName', 'description'], rows, 4_000);
    expect(fit.truncated).toBe(true);
    expect(fit.totalRows).toBe(500);
    expect(fit.keptRows).toBeGreaterThan(0);
    expect(fit.keptRows).toBeLessThan(500);
    expect(Buffer.byteLength(fit.csv, 'utf8')).toBeLessThanOrEqual(4_000);
    expect(fit.csv).toContain('# truncated: showing');
    // Kept rows are the earliest ones (tail-dropped, not head-dropped).
    expect(fit.csv).toContain('Field_0__c');
    expect(fit.csv).not.toContain(`Field_${String(rows.length - 1)}__c`);
  });

  it('never produces a document over the byte budget even at the extreme (rows dropped to zero)', () => {
    const rows = bigRows(50);
    // A budget too small for even one row plus the disclosures/header.
    const fit = fitCsvRowsToBudget(['a disclosure line'], ['id', 'apiName', 'description'], rows, 80);
    expect(fit.keptRows).toBe(0);
    expect(fit.truncated).toBe(true);
    expect(fit.csv).toContain('# truncated: showing 0 of 50 rows');
  });

  it('is deterministic — same input yields byte-identical output', () => {
    const rows = bigRows(200);
    const a = fitCsvRowsToBudget(['x'], ['id', 'apiName', 'description'], rows, 3_000);
    const b = fitCsvRowsToBudget(['x'], ['id', 'apiName', 'description'], rows, 3_000);
    expect(a.csv).toBe(b.csv);
    expect(a.keptRows).toBe(b.keptRows);
  });
});
