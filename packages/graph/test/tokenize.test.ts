/// <reference types="vitest/globals" />

import {
  expandSynonyms,
  jaroWinkler,
  tokenizeIdentifier,
  tokenizeText,
  trigramDice,
  STOP_WORDS,
} from '../src/tokenize.js';

// Jaro-Winkler against textbook reference vectors. These are the canonical
// values from the literature; if the implementation matches them it is
// correct, independent of any one library.
describe('jaroWinkler', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroWinkler('payment', 'payment')).toBe(1);
  });

  it('matches the MARTHA/MARHTA reference value (~0.961)', () => {
    expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.961, 2);
  });

  it('matches the DWAYNE/DUANE reference value (~0.84)', () => {
    expect(jaroWinkler('DWAYNE', 'DUANE')).toBeCloseTo(0.84, 2);
  });

  it('matches the DIXON/DICKSONX reference value (~0.813)', () => {
    expect(jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.813, 2);
  });

  it('applies no prefix bonus when first chars differ (CRATE/TRACE ~0.733)', () => {
    expect(jaroWinkler('CRATE', 'TRACE')).toBeCloseTo(0.733, 2);
  });

  it('returns 0 for fully disjoint strings', () => {
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('returns 0 when either string is empty', () => {
    expect(jaroWinkler('', 'payment')).toBe(0);
    expect(jaroWinkler('payment', '')).toBe(0);
  });

  it('scores a 1-char typo high (paymnet/payment > 0.9)', () => {
    expect(jaroWinkler('paymnet', 'payment')).toBeGreaterThan(0.9);
  });

  it('scores the org misspelling high (erro/error > 0.9)', () => {
    expect(jaroWinkler('erro', 'error')).toBeGreaterThan(0.9);
  });
});

describe('tokenizeIdentifier', () => {
  it('strips the __c suffix and lowercases', () => {
    expect(tokenizeIdentifier('Payment__c')).toEqual(['payment']);
  });

  it('strips the __e platform-event suffix', () => {
    expect(tokenizeIdentifier('EventLog__e')).toEqual(['event', 'log']);
  });

  it('splits camelCase (EvenLog -> even, log) — preserves a misspelling', () => {
    expect(tokenizeIdentifier('EvenLog__c')).toEqual(['even', 'log']);
  });

  it('splits underscore-delimited names into tokens', () => {
    expect(tokenizeIdentifier('Payment_Status__c')).toEqual([
      'payment',
      'status',
    ]);
  });

  it('keeps the meaningful token from a prefixed name (transaction is reachable)', () => {
    // ACME_ is a single-underscore naming prefix, not a `__` managed
    // namespace, so it survives as tokens — but the key token `transaction`
    // is present for exact matching.
    expect(tokenizeIdentifier('ACME_Transaction__c')).toContain('transaction');
  });

  it('drops tokens shorter than 2 chars', () => {
    expect(tokenizeIdentifier('A_Field__c')).toEqual(['field']);
  });

  it('returns [] for empty input', () => {
    expect(tokenizeIdentifier('')).toEqual([]);
  });
});

describe('tokenizeText', () => {
  it('drops filler/stop words from a messy query', () => {
    expect(tokenizeText('where is the emale field')).toEqual(['emale']);
  });

  it('drops trailing filler ("payment stuff" -> [payment])', () => {
    expect(tokenizeText('payment stuff')).toEqual(['payment']);
  });

  it('keeps domain words that look like stop words but are not (log)', () => {
    expect(tokenizeText('error log')).toEqual(['error', 'log']);
  });

  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenizeText('Customer-Health Score!')).toEqual([
      'customer',
      'health',
      'score',
    ]);
  });

  it('returns [] for a query that is all stop words', () => {
    expect(tokenizeText('where is the')).toEqual([]);
  });

  it('collapses the phrase "social security number" to the ssn token (F1, opt-in)', () => {
    expect(
      tokenizeText('student social security number', { expandPhrases: true }),
    ).toEqual(['student', 'ssn']);
  });

  it('collapses "social security" (no "number") to ssn, longest-first (opt-in)', () => {
    expect(tokenizeText('social security', { expandPhrases: true })).toEqual([
      'ssn',
    ]);
  });

  it('collapses "date of birth" to dob and "zip code"/"postal code" to zip (opt-in)', () => {
    expect(tokenizeText('the date of birth', { expandPhrases: true })).toEqual([
      'dob',
    ]);
    expect(tokenizeText('zip code', { expandPhrases: true })).toEqual(['zip']);
    expect(tokenizeText('postal code', { expandPhrases: true })).toEqual([
      'zip',
    ]);
  });

  it('does NOT collapse phrases by default — the phrase pass is opt-in (router-corpus safety)', () => {
    // The router's doc corpus relies on this: rewriting the corpus shifts IDF
    // and tips borderline gold queries out of the top-K (the F1 regression).
    expect(tokenizeText('social security number')).toEqual([
      'social',
      'security',
      'number',
    ]);
    expect(tokenizeText('the date of birth')).toEqual(['date', 'birth']);
    expect(tokenizeText('zip code')).toEqual(['zip', 'code']);
  });

  it('does NOT collapse "social media" or "social login" to ssn even when opt-in (negative)', () => {
    expect(
      tokenizeText('social media campaign', { expandPhrases: true }),
    ).toEqual(['social', 'media', 'campaign']);
    expect(tokenizeText('social login', { expandPhrases: true })).toEqual([
      'social',
      'login',
    ]);
  });
});

describe('expandSynonyms', () => {
  it('maps a business term to its Salesforce-canonical synonyms (rep -> owner)', () => {
    expect(expandSynonyms('rep')).toContain('owner');
  });

  it('is bidirectional (owner -> rep)', () => {
    expect(expandSynonyms('owner')).toContain('rep');
  });

  it('handles common abbreviations (dob -> birthdate, phone -> telephone)', () => {
    expect(expandSynonyms('dob')).toContain('birthdate');
    expect(expandSynonyms('phone')).toContain('telephone');
  });

  it('always includes the input token itself', () => {
    expect(expandSynonyms('rep')).toContain('rep');
  });

  it('returns just the token when it has no synonyms', () => {
    expect(expandSynonyms('zzqqxx')).toEqual(['zzqqxx']);
  });
});

describe('trigramDice', () => {
  it('returns 1 for identical strings', () => {
    expect(trigramDice('payment', 'payment')).toBe(1);
  });

  it('scores a plural/stem variant high (payment vs payments)', () => {
    expect(trigramDice('payment', 'payments')).toBeGreaterThan(0.7);
  });

  it('scores unrelated strings low', () => {
    expect(trigramDice('payment', 'kitchen')).toBeLessThan(0.3);
  });

  it('returns 0 when either string is empty', () => {
    expect(trigramDice('', 'payment')).toBe(0);
  });

  it('handles sub-trigram-length tokens by exact equality', () => {
    expect(trigramDice('ab', 'ab')).toBe(1);
    expect(trigramDice('ab', 'cd')).toBe(0);
  });
});

describe('STOP_WORDS', () => {
  it('includes common filler but NOT domain-meaningful words', () => {
    expect(STOP_WORDS.has('the')).toBe(true);
    expect(STOP_WORDS.has('field')).toBe(true);
    expect(STOP_WORDS.has('stuff')).toBe(true);
    expect(STOP_WORDS.has('log')).toBe(false);
    expect(STOP_WORDS.has('status')).toBe(false);
    expect(STOP_WORDS.has('payment')).toBe(false);
  });
});
