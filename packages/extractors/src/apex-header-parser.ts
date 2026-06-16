import type { Result } from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';

/**
 * Structured result of parsing the header of an Apex `.cls` source file.
 *
 * Captures only what `sf-intelligence` v0.1 needs for the ApexClass node:
 * the access modifiers, sharing model, class name, superclass, implemented
 * interfaces, annotations, and whether the class is a test class.
 *
 * v1.5 extends the type with `methodAnnotations` (the set of annotation
 * names that appear on any method declaration in the source — used by
 * the apex-class extractor to drive the `hasFutureMethod` /
 * `hasInvocableMethod` / `hasAuraEnabledMethod` booleans and the
 * `exposes` edges for `@InvocableMethod` / `@AuraEnabled` surfaces) and
 * `restUrlMapping` (extracted from any class-level
 * `@RestResource(urlMapping='/X')` annotation; null when not present).
 *
 * The class-level `annotations` list still carries the raw `@...` source
 * lines (including arguments). `methodAnnotations` only captures the
 * bare annotation name — `'future'`, `'InvocableMethod'`, `'AuraEnabled'`
 * — without arguments, because the v1.5 producers only need to know
 * whether each annotation is present anywhere in the class.
 */
export interface ApexHeader {
  readonly modifiers: readonly string[];
  readonly sharingModel: 'with sharing' | 'without sharing' | 'inherited sharing' | null;
  readonly className: string;
  readonly superclass: string | null;
  readonly implements: readonly string[];
  readonly annotations: readonly string[];
  readonly isTest: boolean;
  /**
   * Bare annotation names found on any method declaration in the source
   * (e.g., `['future', 'InvocableMethod', 'AuraEnabled']`). Excludes
   * annotations that decorate the class declaration itself — those go
   * in `annotations`. Case is preserved as written in source.
   */
  readonly methodAnnotations: readonly string[];
  /**
   * The `urlMapping` argument value from a class-level
   * `@RestResource(urlMapping='/X')` annotation, with the leading
   * slash preserved (e.g., `'/Accounts'`). `null` when no
   * `@RestResource` is present on the class.
   */
  readonly restUrlMapping: string | null;
}

/**
 * The error shape `parseApexHeader` returns on failure.
 *
 * `no-class-declaration` means the source contained no `class` keyword
 * outside comments or strings. `malformed-header` means a `class` keyword
 * was found but its name or `extends`/`implements` clause was missing or
 * unrecognized.
 */
export interface ApexHeaderError {
  readonly kind: 'no-class-declaration' | 'malformed-header';
  readonly message: string;
}

type SharingModel = NonNullable<ApexHeader['sharingModel']>;

const RECOGNIZED_MODIFIERS = new Set(['public', 'private', 'global', 'protected']);
const SHARING_KEYWORDS = new Set(['with', 'without', 'inherited']);

interface Token {
  readonly text: string;
  readonly start: number;
}

const isIdentStart = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';

const isIdentCont = (ch: string): boolean =>
  isIdentStart(ch) || (ch >= '0' && ch <= '9');

// Single regex that matches any line comment, block comment, or
// single-quoted string in the order they appear. Block comments do not
// nest in Apex. String escape rules: `\` escapes the next character
// (including `\'` and `\\`). There are no double-quoted strings.
const COMMENT_OR_STRING = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'/g;

// Replace comments and string contents with spaces, preserving newlines and
// total length so original-source offsets stay valid.
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

// Parse one type reference at `start`: a dotted identifier (`A.B.C`) with an
// optional generic suffix (`<X<Y>>`). Returns the joined text or empty
// string if the start token is not an identifier.
const readTypeRef = (
  tokens: readonly Token[],
  start: number,
): { text: string; next: number } => {
  const first = tokens[start];
  if (first === undefined || !isIdentStart(first.text[0] ?? '')) {
    return { text: '', next: start };
  }
  let text = first.text;
  let i = start + 1;
  while (i + 1 < tokens.length) {
    const dot = tokens[i];
    const ident = tokens[i + 1];
    if (dot?.text !== '.' || ident === undefined) break;
    if (!isIdentStart(ident.text[0] ?? '')) break;
    text += `.${ident.text}`;
    i += 2;
  }
  if (tokens[i]?.text === '<') {
    let depth = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === undefined) break;
      text += t.text;
      if (t.text === '<') depth += 1;
      else if (t.text === '>') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
  }
  return { text, next: i };
};

// Recover the original (untouched) trimmed line containing `offset`.
// Cleaning preserved line/column positions, so offsets are interchangeable.
const lineTextAt = (source: string, offset: number): string => {
  const start = source.lastIndexOf('\n', offset - 1) + 1;
  const nl = source.indexOf('\n', offset);
  return source.slice(start, nl === -1 ? source.length : nl).trim();
};

// Extract the bare annotation name token (no leading `@`, no arguments)
// from the next non-`@` token after position `i` in `tokens`. Returns
// `null` when the next token isn't an identifier (malformed annotation).
// Used by both the class-level pre-class scan and the method-annotation
// in-body scan so they agree on what counts as an annotation name.
const readAnnotationNameAfterAt = (
  tokens: readonly Token[],
  i: number,
): { name: string | null; next: number } => {
  // Skip whitespace tokens; `@` and the name may be space-separated.
  const nameToken = tokens[i];
  if (nameToken === undefined || !isIdentStart(nameToken.text[0] ?? '')) {
    return { name: null, next: i };
  }
  let cursor = i + 1;
  // Skip an optional parenthesized argument list (treat balanced `(...)`
  // as a single span; do not parse the contents here).
  if (tokens[cursor]?.text === '(') {
    let depth = 1;
    cursor += 1;
    while (cursor < tokens.length && depth > 0) {
      const ch = tokens[cursor]?.text;
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      cursor += 1;
    }
  }
  return { name: nameToken.text, next: cursor };
};

// Extract a single-quoted string argument value from an annotation's
// raw parenthesized argument text. Returns `null` when the named
// argument is absent or the string is malformed. Case-insensitive on
// the argument name to tolerate `urlMapping` vs `urlmapping` spellings.
//
// Used by the apex-class extractor (v1.5) to pull `urlMapping='/Foo'`
// out of `@RestResource(urlMapping='/Foo')` for the synthetic-id
// construction (`ExternalApi:rest/Foo`).
const extractStringArg = (
  annotationLine: string,
  argName: string,
): string | null => {
  // Match the argument name followed by `=` then a single-quoted string.
  // Tolerates whitespace and escaped quotes inside the value.
  const pattern = new RegExp(
    `\\b${argName}\\s*=\\s*'((?:\\\\.|[^'\\\\])*)'`,
    'i',
  );
  const match = pattern.exec(annotationLine);
  return match?.[1] ?? null;
};

interface PreHeader {
  readonly annotations: readonly string[];
  readonly modifiers: readonly string[];
  readonly sharingModel: SharingModel | null;
}

// Walk tokens before the `class` keyword to collect annotation lines,
// recognized access modifiers, and a sharing-model phrase. Unrecognized
// keywords (e.g., `abstract`, `virtual`) are skipped silently.
const collectPreClassHeader = (
  tokens: readonly Token[],
  classIndex: number,
  source: string,
): PreHeader => {
  const annotations: string[] = [];
  const modifiers: string[] = [];
  let sharingModel: SharingModel | null = null;
  let i = 0;
  while (i < classIndex) {
    const t = tokens[i];
    if (t === undefined) {
      i += 1;
      continue;
    }
    if (t.text === '@') {
      annotations.push(lineTextAt(source, t.start));
      // Skip annotation name and any parenthesized args. The captured
      // line already holds the full annotation text.
      i += tokens[i + 1] === undefined ? 1 : 2;
      if (tokens[i]?.text === '(') {
        let depth = 1;
        i += 1;
        while (i < classIndex && depth > 0) {
          const ch = tokens[i]?.text;
          if (ch === '(') depth += 1;
          else if (ch === ')') depth -= 1;
          i += 1;
        }
      }
      continue;
    }
    if (RECOGNIZED_MODIFIERS.has(t.text)) {
      modifiers.push(t.text);
      i += 1;
      continue;
    }
    if (
      SHARING_KEYWORDS.has(t.text) &&
      tokens[i + 1]?.text === 'sharing'
    ) {
      sharingModel = `${t.text} sharing` as SharingModel;
      i += 2;
      continue;
    }
    i += 1;
  }
  return { annotations, modifiers, sharingModel };
};

// Scan the post-class-declaration token stream and collect the bare
// names of all annotations that appear inside the class body. Used by
// the v1.5 apex-class extension to set the per-class booleans
// `hasFutureMethod` / `hasInvocableMethod` / `hasAuraEnabledMethod`
// without requiring the apex scanner to parse method declarations.
//
// Scans for any `@Name` token sequence; tolerates the `@` and name being
// separated by whitespace (the tokenizer drops whitespace). Does NOT
// distinguish annotations that decorate a method declaration from
// annotations that decorate a class-level field or a top-level inner
// class — that fidelity isn't needed for the v1.5 producers, which
// only ask "is `@future` present anywhere in this class body".
const collectMethodAnnotations = (
  tokens: readonly Token[],
  bodyStart: number,
): readonly string[] => {
  const names: string[] = [];
  let i = bodyStart;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t?.text === '@') {
      const result = readAnnotationNameAfterAt(tokens, i + 1);
      if (result.name !== null) {
        names.push(result.name);
      }
      i = result.next;
      continue;
    }
    i += 1;
  }
  return names;
};

// Parse the comma-separated `implements A, B<C>, D.E` list. Stops at the
// first `{` or end of stream.
const readImplementsList = (
  tokens: readonly Token[],
  start: number,
): readonly string[] => {
  const list: string[] = [];
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined || t.text === '{') break;
    if (t.text === ',') {
      i += 1;
      continue;
    }
    const typeRef = readTypeRef(tokens, i);
    if (typeRef.next === i) {
      i += 1;
      continue;
    }
    list.push(typeRef.text);
    i = typeRef.next;
  }
  return list;
};

/**
 * Parse the header of an Apex `.cls` source file.
 *
 * Performs a tokenizer-based shallow scan that respects line comments,
 * block comments, and single-quoted string literals — finding `class`
 * inside a comment or string does not produce a false match. Captures
 * access modifiers, the sharing model, class name, superclass,
 * implemented interfaces, and any annotations on lines above the class
 * declaration.
 *
 * Returns `no-class-declaration` when no `class` keyword exists outside
 * comments/strings, and `malformed-header` when `class` is present but
 * not followed by an identifier (or `extends` is not followed by one).
 *
 * @example
 *   const result = parseApexHeader(
 *     '@isTest\nglobal class FooTest implements HttpCalloutMock {}'
 *   );
 *   if (result.ok) {
 *     console.log(result.value.className); // 'FooTest'
 *     console.log(result.value.modifiers); // ['global']
 *     console.log(result.value.annotations); // ['@isTest']
 *     console.log(result.value.isTest); // true
 *   }
 */
export const parseApexHeader = (
  source: string,
): Result<ApexHeader, ApexHeaderError> => {
  const cleaned = stripCommentsAndStrings(source);
  const tokens = tokenize(cleaned);
  // Recognize an interface declaration as well as a class. An Apex interface
  // (`public interface IFoo { ... }`) has no `class` keyword, but it IS a real
  // component — other classes `implements` it — and must parse as an ApexClass
  // node, not error "no class declaration found" (4 interfaces broke the
  // mass.gov refresh). The name / modifiers / extends parsing below is
  // keyword-agnostic; an interface's `extends` parent is captured as superclass.
  // Apex keywords are CASE-INSENSITIVE: `public Interface IFoo{}` (capital I,
  // as in the real mass.gov IIntegrationService) is valid and must parse like
  // lowercase `interface`. Match the keyword case-insensitively.
  const classIndex = tokens.findIndex((t) => {
    const lower = t.text.toLowerCase();
    return lower === 'class' || lower === 'interface';
  });
  if (classIndex === -1) {
    return err({
      kind: 'no-class-declaration',
      message: 'no class or interface declaration found',
    });
  }

  const pre = collectPreClassHeader(tokens, classIndex, source);
  const nameToken = tokens[classIndex + 1];
  if (nameToken === undefined || !isIdentStart(nameToken.text[0] ?? '')) {
    return err({
      kind: 'malformed-header',
      message: 'class keyword not followed by an identifier',
    });
  }
  let cursor = classIndex + 2;

  let superclass: string | null = null;
  if (tokens[cursor]?.text === 'extends') {
    const superRef = readTypeRef(tokens, cursor + 1);
    if (superRef.text.length === 0) {
      return err({
        kind: 'malformed-header',
        message: 'extends keyword not followed by an identifier',
      });
    }
    superclass = superRef.text;
    cursor = superRef.next;
  }

  const implementsList =
    tokens[cursor]?.text === 'implements'
      ? readImplementsList(tokens, cursor + 1)
      : [];

  // Find the opening `{` of the class body to mark where method-level
  // annotations begin. The pre-class scan above stopped at `class`; any
  // `@` token after the opening brace is body-scope.
  let bodyStart = cursor;
  while (bodyStart < tokens.length && tokens[bodyStart]?.text !== '{') {
    bodyStart += 1;
  }
  // `bodyStart` now points at `{` (or `tokens.length` if the source
  // lacks one — a malformed source the v0.3 scanner already rejects,
  // but parseApexHeader is tolerant: missing body means zero method
  // annotations rather than a parse error).
  const methodAnnotations = collectMethodAnnotations(tokens, bodyStart + 1);

  // Find any class-level @RestResource(urlMapping='/X') annotation and
  // extract the urlMapping argument value for the synthetic-id
  // construction (see ApexClass:exposes edge production in v1.5).
  const restAnnotationLine = pre.annotations.find((line) =>
    /^@\s*RestResource\b/i.test(line),
  );
  const restUrlMapping =
    restAnnotationLine !== undefined
      ? extractStringArg(restAnnotationLine, 'urlMapping')
      : null;

  return ok({
    modifiers: pre.modifiers,
    sharingModel: pre.sharingModel,
    className: nameToken.text,
    superclass,
    implements: implementsList,
    annotations: pre.annotations,
    isTest: pre.annotations.some((line) => /^@\s*isTest\b/i.test(line)),
    methodAnnotations,
    restUrlMapping,
  });
};
