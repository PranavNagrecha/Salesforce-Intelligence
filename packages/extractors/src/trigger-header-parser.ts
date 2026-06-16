import type { Result } from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';

/**
 * Structured result of parsing the header of a Salesforce `.trigger` source
 * file.
 *
 * Captures the three pieces of information v0.1 needs: the trigger's own
 * name, the SObject it fires on, and the lifecycle events it listens to.
 */
export interface TriggerHeader {
  readonly triggerName: string;
  readonly objectApiName: string;
  readonly events: readonly string[];
}

/**
 * The error shape `parseTriggerHeader` returns on failure.
 *
 *   - `no-trigger-keyword`: source contained no `trigger` keyword outside
 *     comments or string literals. The `message` field names whether the
 *     source looks like a misfiled test class (`@isTest`) or is simply not
 *     a trigger.
 *   - `cannot-parse-header`: a `trigger` keyword was found but the
 *     subsequent grammar (name, `on`, object, event list, `{`) is malformed.
 *     The `message` field names which grammar piece was unparseable.
 *   - `unknown-event`: the event list contains a token that is not one of
 *     the seven valid Apex trigger events.
 */
export interface TriggerHeaderError {
  readonly kind: 'cannot-parse-header' | 'no-trigger-keyword' | 'unknown-event';
  readonly message: string;
}

const VALID_EVENTS: ReadonlySet<string> = new Set([
  'before insert',
  'before update',
  'before delete',
  'after insert',
  'after update',
  'after delete',
  'after undelete',
]);

const EVENT_LEAD_WORDS: ReadonlySet<string> = new Set(['before', 'after']);

interface Token {
  readonly text: string;
  readonly start: number;
}

const isIdentStart = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';

const isIdentCont = (ch: string): boolean =>
  isIdentStart(ch) || (ch >= '0' && ch <= '9');

// Single regex that matches any line comment, block comment, or
// single-quoted string in the order they appear. Apex block comments do not
// nest. String escape rules: `\` escapes the next character. There are no
// double-quoted strings.
const COMMENT_OR_STRING = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'/g;

// Replace comments and string contents with spaces, preserving newlines and
// total length so original-source offsets stay valid for any future use.
const stripCommentsAndStrings = (source: string): string =>
  source.replace(COMMENT_OR_STRING, (match) =>
    match.replace(/[^\n]/g, ' '),
  );

// Split a cleaned source (comments and string contents already blanked) into
// tokens. Identifiers are joined; everything else is single-character.
const tokenize = (cleaned: string): readonly Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === undefined) break;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < cleaned.length && isIdentCont(cleaned[i] ?? '')) i += 1;
      tokens.push({ text: cleaned.slice(start, i), start });
      continue;
    }
    tokens.push({ text: ch, start: i });
    i += 1;
  }
  return tokens;
};

// Parse the comma-separated event list between `(` and `)`. Each event is a
// two-word phrase (`before insert`, `after undelete`, ...). Returns the list
// of phrases and the index of the closing `)` token. Returns null if the
// list is structurally invalid (missing close, stray non-identifier tokens).
const readEventList = (
  tokens: readonly Token[],
  start: number,
): { events: readonly string[]; nextIndex: number } | null => {
  const events: string[] = [];
  let i = start;
  while (i < tokens.length) {
    const lead = tokens[i];
    if (lead === undefined) return null;
    if (lead.text === ')') {
      return { events, nextIndex: i + 1 };
    }
    if (lead.text === ',') {
      i += 1;
      continue;
    }
    if (!EVENT_LEAD_WORDS.has(lead.text)) {
      // Capture the unrecognized lead word too, so the caller can surface a
      // helpful `unknown-event` error rather than `cannot-parse-header`.
      const second = tokens[i + 1];
      if (second !== undefined && isIdentStart(second.text[0] ?? '')) {
        events.push(`${lead.text} ${second.text}`);
        i += 2;
        continue;
      }
      return null;
    }
    const action = tokens[i + 1];
    if (action === undefined || !isIdentStart(action.text[0] ?? '')) {
      return null;
    }
    events.push(`${lead.text} ${action.text}`);
    i += 2;
  }
  return null;
};

// `trigger` is case-insensitive in Apex (the language treats keywords as
// case-insensitive even though Salesforce convention writes them lowercase).
// One real-world fixture in the edu-org has a capitalized `Trigger` keyword;
// matching only lowercase produced a confusing `no-trigger-keyword` error
// for an otherwise well-formed header.
const isTriggerKeyword = (text: string): boolean =>
  text.toLowerCase() === 'trigger';

// Detect a misfiled Apex test class: the `@isTest` annotation appears
// outside comments/strings but no `trigger` keyword does. Surfacing this
// as a distinct message helps users figure out their source layout has a
// file in `triggers/` that should live in `classes/`.
const looksLikeTestClass = (tokens: readonly Token[]): boolean => {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i]?.text === '@' && tokens[i + 1]?.text?.toLowerCase() === 'istest') {
      return true;
    }
  }
  return false;
};

const cannotParse = (message: string): TriggerHeaderError => ({
  kind: 'cannot-parse-header',
  message,
});

/**
 * Parse the header of a Salesforce `.trigger` source file.
 *
 * Performs a tokenizer-based shallow scan that respects line comments,
 * block comments, and single-quoted string literals — so the `trigger`
 * keyword inside a comment or string does not produce a false match.
 *
 * Recognizes the grammar
 *   `trigger <Name> on <Object> (<event>, <event>, ...) {`
 * and returns the trigger name, object API name, and the list of events.
 * The `trigger` keyword is matched case-insensitively (Apex keywords are
 * case-insensitive); all other tokens are matched as written.
 *
 * Returns `no-trigger-keyword` when no `trigger` keyword exists outside
 * comments/strings (with a special message when the file looks like a
 * misfiled test class), `cannot-parse-header` when the surrounding grammar
 * is malformed (with a message naming the specific grammar piece that
 * failed), and `unknown-event` when an event token is not one of the
 * seven valid Apex trigger events.
 *
 * @example
 *   const result = parseTriggerHeader(
 *     'trigger AccountTrigger on Account (after insert, after update) {}'
 *   );
 *   if (result.ok) {
 *     console.log(result.value.triggerName);   // 'AccountTrigger'
 *     console.log(result.value.objectApiName); // 'Account'
 *     console.log(result.value.events);        // ['after insert', 'after update']
 *   }
 */
export const parseTriggerHeader = (
  source: string,
): Result<TriggerHeader, TriggerHeaderError> => {
  const tokens = tokenize(stripCommentsAndStrings(source));
  const triggerIndex = tokens.findIndex((t) => isTriggerKeyword(t.text));
  if (triggerIndex === -1) {
    const message = looksLikeTestClass(tokens)
      ? 'file appears to be a test class, not a trigger'
      : 'trigger keyword not found outside comments and strings';
    return err({ kind: 'no-trigger-keyword', message });
  }

  const nameToken = tokens[triggerIndex + 1];
  if (nameToken === undefined || !isIdentStart(nameToken.text[0] ?? '')) {
    return err(cannotParse("missing trigger name after 'trigger' keyword"));
  }

  if (tokens[triggerIndex + 2]?.text !== 'on') {
    return err(cannotParse("missing 'on' clause after trigger name"));
  }

  const objectToken = tokens[triggerIndex + 3];
  if (objectToken === undefined || !isIdentStart(objectToken.text[0] ?? '')) {
    return err(cannotParse("missing object name after 'on'"));
  }

  if (tokens[triggerIndex + 4]?.text !== '(') {
    return err(cannotParse("missing '(' to open event list"));
  }

  const parsedEvents = readEventList(tokens, triggerIndex + 5);
  if (parsedEvents === null) {
    return err(cannotParse("missing ')' to close event list"));
  }
  if (parsedEvents.events.length === 0) {
    return err(cannotParse('event list is empty'));
  }
  if (tokens[parsedEvents.nextIndex]?.text !== '{') {
    return err(cannotParse("missing '{' after event list"));
  }

  for (const event of parsedEvents.events) {
    if (!VALID_EVENTS.has(event)) {
      return err({
        kind: 'unknown-event',
        message: `unknown trigger event: ${event}`,
      });
    }
  }

  return ok({
    triggerName: nameToken.text,
    objectApiName: objectToken.text,
    events: parsedEvents.events,
  });
};
