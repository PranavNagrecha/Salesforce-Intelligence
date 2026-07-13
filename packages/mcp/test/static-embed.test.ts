/// <reference types="vitest/globals" />

/**
 * spike/embeddings (static, option 4a) — contracts for the static-embedding
 * fusion layer.
 *
 * Tiers:
 *  1. GATE-OFF (always, incl. CI): with the default (gate off) the funnel output
 *     is the pure lexical shortlist — no `embedCosine`, byte-identical to an
 *     explicit `SFI_STATIC_EMBED=0`. This is the SHIPPED path.
 *  2. GRACEFUL DEGRADE (always): `SFI_STATIC_EMBED=1` with the index absent must
 *     fall back to lexical, never throw.
 *  3. FUSION (runs only when the checked-in/built index is present — skipped in
 *     CI, where the ~8.5 MB assets are gitignored): determinism, embedCosine
 *     presence, the additive "never drops a strong lexical hit" safety property,
 *     and the head pin.
 */
import { resetFunnelIndex, semanticCandidates } from '../src/semantic-funnel.js';
import {
  embedTextStatic,
  loadStaticTable,
  resetStaticEmbed,
  staticEmbedRanking,
  staticIndexAvailable,
} from '../src/static-embed.js';

const QUERIES: readonly string[] = [
  'who can edit the Amount field on Opportunity',
  'what breaks if I delete the Discount field',
  'show me a few lead records',
  'which flows write to the account status field',
  'is my local copy of the org current',
  'draw me our integration map',
  'completely unrelated gibberish zxqv',
];

const PRIOR = process.env['SFI_STATIC_EMBED'];
const setGate = (v: string | undefined): void => {
  if (v === undefined) delete process.env['SFI_STATIC_EMBED'];
  else process.env['SFI_STATIC_EMBED'] = v;
};
afterAll(() => setGate(PRIOR));
beforeEach(() => {
  resetFunnelIndex();
  resetStaticEmbed();
});

describe('static-embed gate OFF (the shipped default)', () => {
  afterEach(() => setGate(PRIOR));

  it('default (unset) output carries no embedCosine and equals explicit gate off', () => {
    setGate(undefined);
    const dflt = QUERIES.map((q) => JSON.stringify(semanticCandidates(q, 8)));
    setGate('0');
    const off = QUERIES.map((q) => JSON.stringify(semanticCandidates(q, 8)));
    expect(dflt).toEqual(off);
    setGate(undefined);
    for (const q of QUERIES) {
      for (const c of semanticCandidates(q, 8)) expect('embedCosine' in c).toBe(false);
    }
  });
});

describe.runIf(!staticIndexAvailable())('static-embed graceful degrade (index absent)', () => {
  afterEach(() => setGate(PRIOR));
  it('gate ON with no index falls back to the lexical shortlist, no throw', () => {
    setGate('0');
    const lexical = QUERIES.map((q) => JSON.stringify(semanticCandidates(q, 8)));
    setGate('1');
    const on = QUERIES.map((q) => JSON.stringify(semanticCandidates(q, 8)));
    expect(on).toEqual(lexical);
  });
});

describe.runIf(staticIndexAvailable())('static-embed fusion (index present)', () => {
  afterEach(() => setGate(PRIOR));

  it('the query embedding is deterministic — same input, identical vector', () => {
    const table = loadStaticTable();
    expect(table).not.toBeNull();
    for (const q of QUERIES) {
      const a = embedTextStatic(q, table!);
      const b = embedTextStatic(q, table!);
      expect(a === null ? null : Array.from(a)).toEqual(b === null ? null : Array.from(b));
    }
  });

  it('the embedding ranking and the fused shortlist are deterministic', () => {
    setGate('1');
    for (const q of QUERIES) {
      expect(JSON.stringify([...staticEmbedRanking(q)])).toBe(
        JSON.stringify([...staticEmbedRanking(q)]),
      );
      expect(JSON.stringify(semanticCandidates(q, 8))).toBe(
        JSON.stringify(semanticCandidates(q, 8)),
      );
    }
  });

  it('gate ON stamps embedCosine on every returned candidate', () => {
    setGate('1');
    for (const q of QUERIES.slice(0, 6)) {
      const rows = semanticCandidates(q, 8);
      if (rows.length === 0) continue;
      expect(rows.every((r) => typeof r.embedCosine === 'number')).toBe(true);
    }
  });

  it('is ADDITIVE: fusion never drops a strong lexical hit (lexical top-3 ⊆ fused top-8)', () => {
    for (const q of QUERIES.slice(0, 6)) {
      setGate('0');
      const lexTop3 = semanticCandidates(q, 3).map((c) => c.tool);
      setGate('1');
      const fusedTop8 = semanticCandidates(q, 8).map((c) => c.tool);
      for (const t of lexTop3) expect(fusedTop8).toContain(t);
    }
  });

  it('head pin: the strongest lexical candidate stays at position 0 after fusion', () => {
    for (const q of QUERIES.slice(0, 6)) {
      setGate('0');
      const lexTop1 = semanticCandidates(q, 1)[0]?.tool;
      setGate('1');
      const fusedTop1 = semanticCandidates(q, 8)[0]?.tool;
      if (lexTop1 !== undefined) expect(fusedTop1).toBe(lexTop1);
    }
  });
});
