/// <reference types="vitest/globals" />

/**
 * spike/embeddings — BERT WordPiece tokenizer contracts (pure, no assets, always
 * runs in CI). Pins the algorithm the static-embedding funnel depends on:
 * lowercase → strip accents → punctuation split → greedy `##` WordPiece → `[UNK]`.
 * (Faithfulness against HuggingFace's reference tokenizer over the real corpus is
 * verified at build time; these tests pin the behaviour without the 29 528-token
 * vocab.)
 */
import { encodeToIds } from '../src/wordpiece.js';
import type { WordPieceVocab } from '../src/wordpiece.js';

// A tiny hand-built BERT-style vocab. id 1 = [UNK]. `##ete` is a continuation.
const TOKENS = [
  '[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]', // 0..4
  'the', 'amount', 'field', 'del', '##ete', 'change', 'status', 'value', 'payment', // 5..13
  '_', 'c', 'who', 'can', 'edit', 'on', 'cafe', // 14..20
];
const V: WordPieceVocab = {
  vocab: new Map(TOKENS.map((t, i) => [t, i])),
  unkId: 1,
  maxInputChars: 100,
};
const id = (t: string): number => TOKENS.indexOf(t);

describe('BERT WordPiece tokenizer', () => {
  it('lowercases and maps whole-word hits', () => {
    expect(encodeToIds('The Amount Field', V)).toEqual([id('the'), id('amount'), id('field')]);
  });

  it('greedy WordPiece splits a word into `##` continuation subwords', () => {
    // "delete" → "del" + "##ete"
    expect(encodeToIds('delete', V)).toEqual([id('del'), id('##ete')]);
  });

  it('splits punctuation into its own tokens (underscore is punctuation)', () => {
    // "payment_c" → payment, _, c
    expect(encodeToIds('payment_c', V)).toEqual([id('payment'), id('_'), id('c')]);
  });

  it('strips accents before lookup', () => {
    expect(encodeToIds('café', V)).toEqual([id('cafe')]);
  });

  it('emits a single [UNK] for an out-of-vocabulary word', () => {
    expect(encodeToIds('zzxqwv', V)).toEqual([V.unkId]);
  });

  it('a word is [UNK] as a whole when any piece is missing (no partial match)', () => {
    // "amountz": "amount" is a token but the trailing "z" has no ## piece → whole [UNK].
    expect(encodeToIds('amountz', V)).toEqual([V.unkId]);
  });

  it('empty / whitespace-only input yields no tokens', () => {
    expect(encodeToIds('', V)).toEqual([]);
    expect(encodeToIds('   \t\n', V)).toEqual([]);
  });

  it('is deterministic — identical input yields identical ids', () => {
    const a = encodeToIds('who can edit the amount field', V);
    const b = encodeToIds('who can edit the amount field', V);
    expect(a).toEqual(b);
    expect(a).toEqual([id('who'), id('can'), id('edit'), id('the'), id('amount'), id('field')]);
  });
});
