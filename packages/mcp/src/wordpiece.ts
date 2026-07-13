/**
 * Pure-TS BERT (uncased) WordPiece tokenizer — no dependencies, deterministic.
 *
 * This is the exact tokenization surface the `minishlab/potion-*` static
 * embedding models expect (their `tokenizer_name` is `baai/bge-base-en-v1.5`,
 * a standard BERT-uncased WordPiece tokenizer). We reimplement it in ~120 lines
 * so the static-embedding funnel (static-embed.ts) can embed a query with a
 * synchronous integer-table lookup and ZERO native / runtime deps — the whole
 * reason static embeddings can be folded into the SYNCHRONOUS funnel chain where
 * the async MiniLM hybrid never could.
 *
 * Faithfulness: validated token-id-for-token-id against HuggingFace's reference
 * tokenizer over the full tool corpus + query battery at build time
 * (scripts/build-static-embedding-index.mjs verification pass). The pipeline
 * mirrors BERT exactly: BertNormalizer (clean text → handle CJK → lowercase →
 * strip accents) → BertPreTokenizer (whitespace + punctuation split) → greedy
 * longest-match WordPiece with the `##` continuation prefix and `[UNK]` fallback.
 *
 * `add_special_tokens = false`: model2vec never prepends [CLS]/appends [SEP] at
 * encode time, so neither do we.
 */

/** ASCII punctuation ranges + any Unicode `P*` category, per BERT `_is_punctuation`. */
const isPunctuation = (cp: number, ch: string): boolean => {
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(ch);
};

/** Space, tab, newline, carriage-return, or a Unicode `Zs` char, per BERT `_is_whitespace`. */
const isWhitespace = (cp: number, ch: string): boolean => {
  if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) return true;
  return /\p{Zs}/u.test(ch);
};

/** Control chars (Unicode `C*`) excluding the whitespace ones, per BERT `_is_control`. */
const isControl = (cp: number, ch: string): boolean => {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return /\p{C}/u.test(ch);
};

/** CJK ideograph blocks BERT wraps in spaces so each glyph is its own token. */
const isChineseChar = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) ||
  (cp >= 0x2b820 && cp <= 0x2ceaf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f);

/**
 * BertNormalizer(clean_text, handle_chinese_chars, lowercase, strip_accents).
 * `strip_accents` is null in the potion tokenizer config, which HF resolves to
 * the `lowercase` value (true) — so accents ARE stripped.
 */
const bertNormalize = (text: string): string => {
  // clean_text + handle_chinese_chars, char by char (codepoint-aware).
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0 || cp === 0xfffd || isControl(cp, ch)) continue;
    if (isWhitespace(cp, ch)) {
      out += ' ';
      continue;
    }
    if (isChineseChar(cp)) {
      out += ` ${ch} `;
      continue;
    }
    out += ch;
  }
  // lowercase → strip accents (NFD then drop combining marks).
  return out.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
};

/** BertPreTokenizer: split on whitespace, then peel punctuation into own tokens. */
const bertPreTokenize = (normalized: string): string[] => {
  const words: string[] = [];
  for (const chunk of normalized.split(/\s+/)) {
    if (chunk.length === 0) continue;
    let cur = '';
    for (const ch of chunk) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isPunctuation(cp, ch)) {
        if (cur.length > 0) {
          words.push(cur);
          cur = '';
        }
        words.push(ch);
      } else {
        cur += ch;
      }
    }
    if (cur.length > 0) words.push(cur);
  }
  return words;
};

/** A loaded WordPiece vocabulary + its parameters. */
export interface WordPieceVocab {
  /** token string → integer id. */
  readonly vocab: ReadonlyMap<string, number>;
  /** id of the `[UNK]` token. */
  readonly unkId: number;
  /** `max_input_chars_per_word` (100 for BERT); longer words map to `[UNK]`. */
  readonly maxInputChars: number;
}

/**
 * Greedy longest-match WordPiece over ONE pre-token, appending token ids to
 * `out`. Unknown / over-long words emit a single `[UNK]` id, exactly as BERT.
 */
const wordpiece = (word: string, v: WordPieceVocab, out: number[]): void => {
  const chars = [...word];
  if (chars.length > v.maxInputChars) {
    out.push(v.unkId);
    return;
  }
  let start = 0;
  const sub: number[] = [];
  while (start < chars.length) {
    let end = chars.length;
    let found = -1;
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
      const id = v.vocab.get(piece);
      if (id !== undefined) {
        found = id;
        break;
      }
      end -= 1;
    }
    if (found === -1) {
      out.push(v.unkId); // whole word is unknown
      return;
    }
    sub.push(found);
    start = end;
  }
  for (const id of sub) out.push(id);
};

/**
 * Tokenize `text` to WordPiece token ids (no special tokens), deterministically.
 * Empty input (or input that normalizes away) yields an empty array.
 */
export const encodeToIds = (text: string, v: WordPieceVocab): number[] => {
  const ids: number[] = [];
  for (const word of bertPreTokenize(bertNormalize(text))) wordpiece(word, v, ids);
  return ids;
};
