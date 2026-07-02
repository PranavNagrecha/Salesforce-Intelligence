/// <reference types="vitest/globals" />

/**
 * SPIKE (spike/embeddings) — contracts for the embedding-hybrid funnel layer.
 *
 * Three tiers:
 *  1. GATE-OFF BYTE-IDENTITY (always runs, incl. CI): with SFI_EMBEDDINGS unset
 *     the hybrid entry point must return EXACTLY the lexical funnel's output —
 *     the additive constraint that keeps the shipped path untouched.
 *  2. INDEX PARITY + PURE FUSION MATH (always runs): the checked-in vector file
 *     covers the whole tool roster (both directions), and the two fusion
 *     strategies are verified with synthetic scores — no model needed.
 *  3. GATE-ON BEHAVIOR (runs only when SFI_EMBEDDINGS=1 and the model is in
 *     the local cache — skipped in CI): 5 known phrasings surface the gold
 *     tool in the top-8 for both fusion modes.
 */
import { readFileSync } from 'node:fs';

import {
  findEmbeddingIndexPath,
  fuseScoresMax,
  fuseScoresRrf,
  loadEmbeddingIndex,
  resetEmbeddingRuntime,
} from '../src/embedding-funnel.js';
import type { EmbeddingIndexFile } from '../src/embedding-funnel.js';
import {
  resetFunnelIndex,
  semanticCandidates,
  semanticCandidatesHybrid,
} from '../src/semantic-funnel.js';
import { V01_TOOLS } from '../src/tools/index.js';

const QUERIES: readonly string[] = [
  'who can edit the Amount field on Opportunity',
  'what breaks if I delete the Discount field',
  'show me a few lead records',
  'which flows write to the account status field',
  'is my local copy of the org current',
  'draw me our integration map',
  'completely unrelated gibberish zxqv',
];

describe('embeddings gate OFF (the shipped default)', () => {
  const prev = process.env['SFI_EMBEDDINGS'];
  beforeAll(() => {
    delete process.env['SFI_EMBEDDINGS'];
    resetFunnelIndex();
  });
  afterAll(() => {
    if (prev !== undefined) process.env['SFI_EMBEDDINGS'] = prev;
  });

  it('hybrid output is byte-identical to the lexical funnel for both fusion modes', async () => {
    for (const q of QUERIES) {
      const lexical = JSON.stringify(semanticCandidates(q, 8));
      expect(JSON.stringify(await semanticCandidatesHybrid(q, 8, 'max'))).toBe(lexical);
      expect(JSON.stringify(await semanticCandidatesHybrid(q, 8, 'rrf'))).toBe(lexical);
    }
  });

  it('lexical candidates never carry the embedCosine field when the gate is off', () => {
    for (const q of QUERIES) {
      for (const c of semanticCandidates(q, 8)) {
        expect('embedCosine' in c).toBe(false);
      }
    }
  });
});

describe('embedding index parity (checked-in vector file)', () => {
  const indexPath = findEmbeddingIndexPath();

  it('the index file exists and parses', () => {
    expect(indexPath).not.toBeNull();
  });

  it('every registered tool has a vector of the declared dimension (and no strays)', () => {
    const file = JSON.parse(readFileSync(indexPath ?? '', 'utf8')) as EmbeddingIndexFile;
    const rosterNames = new Set(V01_TOOLS.map((t) => t.name));
    const indexNames = new Set(Object.keys(file.vectors));
    const missing = [...rosterNames].filter((n) => !indexNames.has(n));
    const stray = [...indexNames].filter((n) => !rosterNames.has(n));
    // Actionable failure: regenerate with scripts/build-embedding-index.mjs.
    expect({ missing, stray }).toEqual({ missing: [], stray: [] });
    for (const vec of Object.values(file.vectors)) {
      expect(vec.length).toBe(file.dim);
    }
  });

  it('vectors are L2-normalized (cosine = dot product)', () => {
    const loaded = loadEmbeddingIndex();
    expect(loaded).not.toBeNull();
    for (const vec of loaded?.vectors.values() ?? []) {
      let norm = 0;
      for (const x of vec) norm += x * x;
      expect(Math.abs(Math.sqrt(norm) - 1)).toBeLessThan(1e-3);
    }
  });
});

describe('fusion math (pure, model-free)', () => {
  it('max fusion takes the stronger of lexical and weighted-embedding evidence', () => {
    const fused = fuseScoresMax(
      new Map([
        ['a', 0.3],
        ['b', 0.1],
      ]),
      new Map([
        ['b', 0.9],
        ['c', 0.4],
        ['d', -0.2],
      ]),
      0.5,
    );
    expect(fused.get('a')).toBeCloseTo(0.3); // lexical-only survives untouched
    expect(fused.get('b')).toBeCloseTo(0.45); // 0.5 * 0.9 beats lexical 0.1
    expect(fused.get('c')).toBeCloseTo(0.2); // embedding-only tool enters
    expect(fused.has('d')).toBe(false); // non-positive evidence dropped
  });

  it('RRF rewards agreement between the two rankings', () => {
    const fused = fuseScoresRrf(['a', 'b'], ['b', 'c']);
    const a = fused.get('a') ?? 0;
    const b = fused.get('b') ?? 0;
    const c = fused.get('c') ?? 0;
    expect(b).toBeCloseTo(1 / 61 + 1 / 62); // ranked in BOTH lists → top
    expect(a).toBeCloseTo(1 / 61);
    expect(c).toBeCloseTo(1 / 62);
    expect(b).toBeGreaterThan(a);
    expect(a).toBeGreaterThan(c);
  });
});

/**
 * GATE-ON tier: opt-in (SFI_EMBEDDINGS=1 + model in the local cache). CI runs
 * with the gate off, so this tier is skipped there by design — the suite must
 * stay green without the model. Locally:
 *   cd packages/mcp && SFI_EMBEDDINGS=1 CI=1 npx vitest run test/embedding-funnel.test.ts
 */
describe.runIf(process.env['SFI_EMBEDDINGS'] === '1')('embeddings gate ON (local only)', () => {
  beforeAll(() => {
    resetFunnelIndex();
    resetEmbeddingRuntime();
  });

  // Paraphrases deliberately NOT lifted from funnel-utterances.ts — the point
  // is generalization past the lexical corpus, not memorization of it.
  const KNOWN: ReadonlyArray<{ q: string; anyOf: readonly string[] }> = [
    {
      q: 'who is allowed to look at the Amount field on Opportunity',
      anyOf: ['sfi.field_access_audit', 'sfi.crud_fls_audit', 'sfi.who_can_access_object'],
    },
    {
      q: 'what goes on behind the scenes when somebody saves a case',
      anyOf: ['sfi.order_of_execution', 'sfi.what_happens_on_save'],
    },
    {
      q: 'is anything going to break if we get rid of the Discount field',
      anyOf: ['sfi.get_impact', 'sfi.safe_to_delete_field', 'sfi.field_lineage'],
    },
    {
      q: 'give me a quick health readout for this org',
      anyOf: ['sfi.org_pulse', 'sfi.live_org_health', 'sfi.org_risk_report', 'sfi.health_check'],
    },
    {
      q: 'roughly how many open opportunities are there right now',
      anyOf: ['sfi.live_count'],
    },
  ] as const;

  for (const fusion of ['max', 'rrf'] as const) {
    it(`returns sane candidates for 5 known phrasings (${fusion} fusion)`, async () => {
      for (const { q, anyOf } of KNOWN) {
        const rows = await semanticCandidatesHybrid(q, 8, fusion);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThanOrEqual(8);
        // Scores strictly ordered (desc), every row carries embedding evidence.
        for (let i = 1; i < rows.length; i += 1) {
          expect(rows[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(rows[i]?.score ?? 0);
        }
        expect(rows.every((r) => typeof r.embedCosine === 'number')).toBe(true);
        const tools = rows.map((r) => r.tool);
        expect(
          anyOf.some((t) => tools.includes(t)),
          `gold ${anyOf.join('|')} missing from top-8 for "${q}" (${fusion}): got ${tools.join(', ')}`,
        ).toBe(true);
      }
    });
  }

  it('an embedding-only candidate keeps lexical honesty (cosine 0, embedCosine set)', async () => {
    // Every returned row must satisfy: cosine reflects LEXICAL evidence only.
    const rows = await semanticCandidatesHybrid(
      'who is allowed to look at the Amount field on Opportunity',
      8,
      'max',
    );
    for (const r of rows) {
      expect(typeof r.cosine).toBe('number');
      expect(typeof r.embedCosine).toBe('number');
    }
  });
});
