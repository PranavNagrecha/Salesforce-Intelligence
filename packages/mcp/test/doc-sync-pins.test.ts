/// <reference types="vitest/globals" />

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const {
  matchConceptCountFacts,
  matchCoreRosterCountFacts,
  checkArchitectureGraphTables,
  checkCoreRosterCountPins,
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

describe('doc-sync core-roster size pin', () => {
  it('matches the phrasings used across README / CLAUDE / website / llms', () => {
    const samples = [
      ['**Default is the 19-tool core roster** (AUDIT-F6)', 19],
      ['advertises a <strong>19-tool core roster</strong>', 19],
      ['only a <strong>19-schema core roster</strong> is advertised', 19],
      ['Default is a 19-tool <code>core</code> roster (token-friendly)', 19],
      ['default is `core` (19 directly invokable tools).', 19],
      ['Default advertise/invoke profile is **`core` (19 tools)** including', 19],
      // "spine" phrasing — docs/configuration.md, configuration.astro and
      // tool-profile.ts state the count this way. It was NOT matched before,
      // so a stale 18 in docs/configuration.md passed the gate.
      ['**Default is `core`**: only that 19-schema spine is advertised', 19],
      ['advertise the 19-tool spine, incl. live_consent', 19],
    ] as const;
    for (const [sample, n] of samples) {
      const hits = matchCoreRosterCountFacts(sample);
      expect(hits.length, sample).toBeGreaterThanOrEqual(1);
      expect(
        hits.every((h: { count: number }) => h.count === n),
        sample,
      ).toBe(true);
    }
  });

  it('fails when a listed surface still teaches 18 after live_consent joined core', () => {
    const { failures, warnings } = checkCoreRosterCountPins(
      {
        'README.md': '**Default is the 18-tool core roster** (AUDIT-F6)',
        'CLAUDE.md': 'default is `core` (19 directly invokable tools)',
      },
      19,
    );
    expect(failures.some((m: string) => m.includes('README.md') && m.includes('18'))).toBe(
      true,
    );
    expect(failures.some((m: string) => m.includes('CLAUDE.md'))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('fails on a stale "N-schema spine" — the form that slipped docs/configuration.md', () => {
    const { failures, warnings } = checkCoreRosterCountPins(
      {
        'docs/configuration.md':
          '**Default is `core`** (AUDIT-F6): only that 18-schema spine is advertised',
        'packages/mcp/src/tools/tool-profile.ts':
          ' * AUDIT-F6: default is `core` (advertise the 19-tool spine, incl. live_consent).',
      },
      19,
    );
    expect(
      failures.some(
        (m: string) => m.includes('docs/configuration.md') && m.includes('18'),
      ),
    ).toBe(true);
    expect(failures.some((m: string) => m.includes('tool-profile.ts'))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('warns when a listed surface has no core-count phrase at all', () => {
    const { failures, warnings } = checkCoreRosterCountPins(
      { 'website/public/llms.txt': 'It exposes 209 read-only tools across eight areas.' },
      19,
    );
    expect(failures).toEqual([]);
    expect(warnings.some((m: string) => m.includes('llms.txt') && m.includes('no core-roster'))).toBe(
      true,
    );
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
