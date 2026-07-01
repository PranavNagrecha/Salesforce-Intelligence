/**
 * Tokenization + string-similarity primitives for the resolver.
 *
 * Two tokenization paths, deliberately different:
 *   - `tokenizeIdentifier` — for corpus identifiers (`api_name`). Strips the
 *     Salesforce API suffix, splits underscore + camelCase, lowercases, drops
 *     sub-2-char tokens. Does NOT drop stop words: a field literally named
 *     `Status__c` or `Field__c` must keep its token so a query can match it.
 *   - `tokenizeText` — for human query text and labels. Same splitting, plus
 *     stop-word/filler removal so `where is the emale field` reduces to
 *     `[emale]`. Stop words are removed from the QUERY, never from the corpus,
 *     so a dropped filler word can never starve a real match.
 *
 * `jaroWinkler` is the typo-tolerance core. It is a standard implementation
 * verified against the canonical reference vectors (see tokenize.test.ts):
 * MARTHA/MARHTA≈0.961, DWAYNE/DUANE≈0.84, DIXON/DICKSONX≈0.813,
 * CRATE/TRACE≈0.733. We compute it in JS rather than via DuckDB's
 * `jaro_winkler_similarity` because the resolver scores per-token (which
 * fixed the namespaced-name ranking bug), and per-token scoring in SQL would
 * mean N×M scalar calls.
 */

/** Salesforce API-name suffixes stripped before tokenizing an identifier. */
const SUFFIXES = ['__c', '__r', '__mdt', '__e', '__b', '__x', '__s'] as const;

/**
 * Stop words + conversational filler removed from QUERY text only. Includes
 * near-universal English function words, Salesforce-corpus low-signal words
 * (`field`, `custom`, `value`, `record`), and chat filler (`show`, `stuff`).
 * Deliberately excludes domain-meaningful words that look stoppy in isolation
 * (`log`, `status`, `stage`, `payment`) — removing those would break real
 * queries like "error log".
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // function words
  'a', 'an', 'the', 'is', 'are', 'was', 'be', 'at', 'on', 'in', 'of', 'to',
  'for', 'with', 'from', 'by', 'as', 'it', 'this', 'that', 'these', 'those',
  'or', 'and', 'not', 'no', 'but', 'if', 'then', 'else', 'such',
  // low-signal corpus words
  'field', 'fields', 'custom', 'value', 'values', 'record', 'records',
  'component', 'components', 'artifact', 'artifacts', 'metadata',
  // conversational filler
  'show', 'me', 'find', 'get', 'used', 'use', 'do', 'we', 'i', 'my', 'our',
  'where', 'what', 'which', 'who', 'whose', 'does', 'there', 'here', 'about',
  'can', 'you', 'please', 'stuff', 'thingy', 'thing', 'some', 'any', 'all',
]);

/** Split one segment on camelCase / digit boundaries into lowercase pieces. */
const splitCamel = (segment: string): string[] =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter((s) => s.length > 0);

/** Strip a single trailing Salesforce API suffix, if present. */
const stripSuffix = (raw: string): string => {
  for (const suffix of SUFFIXES) {
    if (raw.endsWith(suffix)) return raw.slice(0, -suffix.length);
  }
  return raw;
};

/**
 * Tokenize a Salesforce identifier (`api_name`) into lowercase tokens.
 * Strips the API suffix, splits on underscore + camelCase, drops sub-2-char
 * tokens. Does not remove stop words (corpus tokens are preserved).
 */
export const tokenizeIdentifier = (raw: string): string[] => {
  if (raw.length === 0) return [];
  const stripped = stripSuffix(raw);
  const tokens: string[] = [];
  for (const segment of stripped.split(/[^A-Za-z0-9]+/)) {
    if (segment.length === 0) continue;
    for (const piece of splitCamel(segment)) {
      const lower = piece.toLowerCase();
      if (lower.length >= 2) tokens.push(lower);
    }
  }
  return tokens;
};

/**
 * Ordered, high-precision PHRASE synonyms (F1). Each entry rewrites a
 * multi-word business phrase to its single Salesforce-canonical token BEFORE
 * tokenization splits on non-alphanumerics. Applied longest-phrase-first so
 * "social security number" wins over "social security". Every key is
 * multi-word and unambiguous — no bare single tokens (a bare `social -> ssn`
 * would wrongly collapse "social media"/"social login" and pollute recall).
 *
 * Opt-in (default OFF): the phrase pass runs ONLY when a caller asks for it
 * via `tokenizeText(raw, { expandPhrases: true })`. It is applied to QUERY
 * text (so an "SSN" question matches a `Student_SSN__c` field) but NOT to the
 * router's doc corpus — rewriting the corpus shifts every term's IDF and tips
 * borderline gold queries out of the top-K, so the corpus is tokenized
 * verbatim. The keys are phrase-anchored so a "Social Media Campaign" label is
 * left intact even when expansion is on.
 */
const PHRASE_SYNONYMS: readonly (readonly [string, string])[] = (
  [
    ['social security number', 'ssn'],
    ['social security', 'ssn'],
    ['date of birth', 'dob'],
    ['postal code', 'zip'],
    ['zip code', 'zip'],
  ] as [string, string][]
).sort((a, b) => b[0].length - a[0].length);

/**
 * Apply the ordered phrase-synonym rewrites to a lowercased string. Longest
 * phrase first; each phrase is replaced globally with its canonical token.
 * Word-boundary anchored so "zip code" matches but a substring inside another
 * word does not.
 */
const applyPhraseSynonyms = (lower: string): string => {
  let out = lower;
  for (const [phrase, canonical] of PHRASE_SYNONYMS) {
    if (!out.includes(phrase)) continue;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), canonical);
  }
  return out;
};

/**
 * Tokenize human query / label text into lowercase tokens, dropping stop
 * words and sub-2-char tokens. Splits on any non-alphanumeric run.
 *
 * The ordered {@link PHRASE_SYNONYMS} pass is OPT-IN (default OFF): pass
 * `{ expandPhrases: true }` to collapse multi-word business phrases
 * ("social security number" -> `ssn`) to their canonical token before
 * splitting. Expansion belongs on QUERY text and on find-semantic-field's
 * own label corpus, NEVER on the router's doc corpus — rewriting the corpus
 * shifts every term's TF-IDF/IDF weight and tips borderline gold queries out
 * of the top-K. Default (no opts) tokenizes the raw text verbatim.
 */
export const tokenizeText = (
  raw: string,
  opts?: { readonly expandPhrases?: boolean },
): string[] => {
  if (raw.length === 0) return [];
  const lowered = raw.toLowerCase();
  const normalized =
    opts?.expandPhrases === true ? applyPhraseSynonyms(lowered) : lowered;
  const tokens: string[] = [];
  for (const piece of normalized.split(/[^A-Za-z0-9]+/)) {
    const lower = piece.toLowerCase();
    if (lower.length < 2) continue;
    if (STOP_WORDS.has(lower)) continue;
    tokens.push(lower);
  }
  return tokens;
};

/**
 * Jaro-Winkler similarity in [0, 1]. Identical non-empty strings score 1;
 * an empty operand scores 0. Standard algorithm with Winkler prefix bonus
 * (scaling 0.1, max prefix 4).
 */
export const jaroWinkler = (a: string, b: string): number => {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchDistance = Math.max(
    0,
    Math.floor(Math.max(a.length, b.length) / 2) - 1,
  );
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro =
    (matches / a.length +
      matches / b.length +
      (matches - transpositions) / matches) /
    3;

  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
};

/**
 * Org-agnostic synonym groups: business phrasing <-> Salesforce-canonical
 * terms. Each group is a set of mutually-substitutable tokens; a query token
 * expands to every other member of its group(s) so "rep" can match an "Owner"
 * field and "dob" a "Birthdate" field — the synonym gap a lexical resolver
 * cannot otherwise cross. Conservative by design: synonym hits score below the
 * exact threshold, so they surface as candidates to verify, not silent picks.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['rep', 'representative', 'owner', 'salesrep', 'agent'],
  ['phone', 'telephone', 'tel', 'mobile', 'cell', 'cellular'],
  ['email', 'mail', 'inbox'],
  ['dob', 'birthdate', 'birthday', 'birth'],
  ['address', 'addr'],
  ['quantity', 'qty'],
  ['amount', 'amt', 'total'],
  ['account', 'acct'],
  ['opportunity', 'opp', 'oppty', 'deal'],
  ['description', 'desc', 'notes', 'comment', 'comments'],
  ['number', 'num', 'nbr'],
  ['date', 'dt'],
  ['ssn', 'socialsecurity'],
  ['zip', 'zipcode', 'postal', 'postalcode'],
  ['city', 'town'],
  ['revenue', 'sales', 'income'],
  ['status', 'state', 'stage'],
  ['customer', 'client'],
  ['employee', 'staff', 'worker'],
  ['manager', 'supervisor'],
  ['company', 'organization', 'org', 'business'],
  ['first', 'fname', 'firstname'],
  ['last', 'lname', 'lastname', 'surname'],
  ['percent', 'percentage', 'pct'],
  ['active', 'enabled'],
];

const SYNONYM_MAP: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const set = m.get(term) ?? new Set<string>();
      for (const other of group) if (other !== term) set.add(other);
      m.set(term, set);
    }
  }
  return m;
})();

/** Expand a token to itself plus any org-agnostic synonyms. */
export const expandSynonyms = (token: string): string[] => {
  const syns = SYNONYM_MAP.get(token);
  return syns === undefined ? [token] : [token, ...syns];
};

/**
 * Collapse a name to a comparison key: lowercase, drop the trailing Salesforce
 * suffix (`__c`, `__r`, `__mdt`, …), and strip every non-alphanumeric.
 * `IEEToDo__c` → `ieetodo`; `API Contact Layout` → `apicontactlayout`. Used by
 * the resolver's whole-name exact boost and by the resolve index's normalized-
 * name bucket, so an exact API-name query surfaces its component regardless of
 * how the token splitter chunked it.
 */
export const normalizeName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/__[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]/g, '');

/**
 * Character bigrams of a string (no padding). Used by the resolve index as a
 * recall-safe prefilter: a single-edit typo changes at most two bigrams, so a
 * fuzzy match scoring at/above the matched floor always shares ≥1 bigram with
 * its target (synonyms — which share none — are handled by a separate exact-
 * token expansion). Operands shorter than 2 chars yield no bigrams.
 */
export const charBigrams = (s: string): readonly string[] => {
  const out: string[] = [];
  for (let i = 0; i + 2 <= s.length; i += 1) out.push(s.slice(i, i + 2));
  return out;
};

/**
 * Sorted-character signature of a string. Two strings that are transpositions
 * of each other share the same signature (`test`/`tset` → `estt`), so the
 * resolve index uses it to catch short-token transpositions that destroy every
 * bigram (`test`→`tset` shares no bigram yet scores ~0.92 on Jaro-Winkler).
 */
export const sortedChars = (s: string): string => [...s].sort().join('');

/** Character trigrams of a string (no padding). */
const trigrams = (s: string): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3));
  return out;
};

/**
 * Sørensen–Dice coefficient over character trigrams, in [0,1]. Adds recall for
 * stem/reorder variants that Jaro-Winkler under-scores. Operands shorter than
 * 3 chars fall back to exact equality.
 */
export const trigramDice = (a: string, b: string): number => {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return (2 * inter) / (ta.size + tb.size);
};
