/// <reference types="vitest/globals" />

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  matchConceptCountFacts,
  checkArchitectureGraphTables,
} = await import(
  pathToFileURL(join(repoRoot, 'scripts/lib/build-product-manifest.mjs')).href
);

describe('doc-sync concept-count pin regex', () => {
  it('matches slash, and, comma, and bold phrasings', () => {
    const samples = [
      'Concept Model (142 concepts / 193 rules) — org-independent',
      'the Concept Model is a curated set of **142** reasoning concepts and **193** rules',
      'Graph B: 142 concepts, 193 rules of general Salesforce truth',
      'Concept Model grew to **142** concepts / **193** rules',
    ];
    for (const sample of samples) {
      const matches = matchConceptCountFacts(sample);
      expect(matches, sample).toHaveLength(1);
      expect(matches[0]?.concepts).toBe(142);
      expect(matches[0]?.rules).toBe(193);
    }
  });

  it('flags a stale 94/143 "and" phrasing that previously slipped the gate', () => {
    const stale =
      'The Concept Model is a curated, org-independent set of **94** reasoning concepts and **143** rules';
    const matches = matchConceptCountFacts(stale);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.concepts).toBe(94);
    expect(matches[0]?.rules).toBe(143);
  });
});

describe('architecture graph-table pin', () => {
  it('requires backtick-delimited table names (bare "facts" substring is not enough)', () => {
    const withArtifactsOnly =
      'The vault stores artifacts and schema details but no inventory list.';
    expect(checkArchitectureGraphTables(withArtifactsOnly)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('`facts`'),
        expect.stringContaining('`nodes`'),
      ]),
    );

    const withBackticks = [
      '- `nodes(id)`',
      '- `edges(from_id)`',
      '- `facts(subject_id)`',
      '- `schema_version(id)`',
    ].join('\n');
    expect(checkArchitectureGraphTables(withBackticks)).toEqual([]);
  });

  it('fails when the facts bullet is removed from an otherwise complete inventory', () => {
    const inventoryMinusFacts = [
      '- `nodes(id, type)`',
      '- `edges(from_id, to_id)`',
      '- `schema_version(id, version)`',
    ].join('\n');
    const failures = checkArchitectureGraphTables(inventoryMinusFacts) as string[];
    expect(failures.some((m: string) => m.includes('`facts`'))).toBe(true);
    expect(failures.some((m: string) => m.includes('`nodes`'))).toBe(false);
  });
});
