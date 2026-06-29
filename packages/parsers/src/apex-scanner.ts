import { err, ok, type Result } from '@sf-intelligence/core';

/**
 * The categorical kinds of `scanApexSource` errors. The scanner is
 * fail-fast: the first detected structural problem wins.
 */
export type ApexScannerErrorKind =
  | 'empty-source'
  | 'no-class-or-trigger'
  | 'unbalanced-braces';

/**
 * The error shape `scanApexSource` returns on failure. `offset` is the
 * 0-indexed character offset in the original source where the problem
 * was detected.
 */
export interface ApexScannerError {
  readonly kind: ApexScannerErrorKind;
  readonly message: string;
  readonly offset: number;
}

/**
 * One field access detected by the heuristic scanner.
 *
 * `object` is the left-hand side of the dot. When the left-hand
 * identifier is a local/parameter whose declared type the scanner could
 * resolve (`Account acc; acc.Name` → `Account`), `object` is that
 * resolved SObject-ish type; otherwise it is the raw identifier as it
 * appears in source (a real object/static-class name, or an alias whose
 * type could not be resolved). `field` is the identifier on the right.
 * Downstream extractors map `object` to a canonical SObject id.
 *
 * `offset` and `length` describe the span in the *original* source
 * (offsets are preserved across the comment/string-stripping pass).
 */
export interface FieldAccess {
  readonly type: 'read' | 'write';
  readonly object: string;
  readonly field: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * One `ClassName.methodName(` call site detected by the heuristic
 * scanner. Bare self-references (`doStuff(...)` with no leading
 * class) are NOT extracted in v0.3.
 */
export interface MethodCallSite {
  readonly className: string;
  readonly methodName: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * One `new ClassName(` constructor invocation detected by the
 * heuristic scanner. Captures the generic instantiation case the
 * `IDENT.IDENT(` method-call sweep is blind to — e.g.
 * `Dispatcher.Run(new HandlerClass())` names `HandlerClass` only via
 * the constructor, not via any `IDENT.IDENT(` shape.
 *
 * `className` is the constructed type as it appears in source (NOT a
 * resolved canonical id). Generic collection built-ins (`List`, `Map`,
 * `Set`, `Iterator`) and the static-helper `KEYWORD_CLASSES` names are
 * filtered out before an `Instantiation` is recorded — see `scanBody`.
 *
 * `offset` and `length` describe the span (`new ClassName(`) in the
 * *original* source.
 */
export interface Instantiation {
  readonly className: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * An object queried by an INLINE SOQL statement
 * (`[SELECT ... FROM {object} ...]`). Captured: the primary (paren-depth-0)
 * `FROM` object, plus each SEMI-JOIN subquery's object — `WHERE Id IN
 * (SELECT ... FROM Contact)` names a real SObject the query reads.
 * Child-relationship subqueries (`(SELECT ... FROM Contacts)`, an opener NOT
 * after `IN`) are deliberately skipped, since their `FROM` names a
 * relationship, not an SObject API name. Dynamic SOQL built from string
 * concatenation is invisible here (string literals are blanked before
 * scanning) — that remains the documented dynamic-SOQL blind spot.
 */
export interface SoqlFromObject {
  readonly object: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * One `EventBus.subscribe(channel, ...)` registration detected by the
 * heuristic scanner (P3b). `channel` is the FIRST argument's resolved
 * channel/event name when it was a STATIC string literal (a `/event/X__e`
 * form is normalized to `X__e`); it is `''` when the first argument was
 * dynamic/computed (a variable, a method call, a concatenation) — string
 * literals are blanked before scanning, so a non-literal arg leaves nothing
 * to capture.
 *
 * `resolved` records whether a static channel string was recovered. The
 * extractor mints a `listensTo` edge ONLY for a `resolved: true` entry whose
 * channel names a real Platform Event (`__e` suffix); a `resolved: false`
 * entry is the honest "dynamic channel — not resolved" signal and produces NO
 * edge (no phantom). This mirrors the EventBus.publish publisher honesty.
 *
 * `offset` and `length` describe the span of the `EventBus.subscribe(` call in
 * the *original* source.
 */
export interface EventSubscription {
  readonly channel: string;
  readonly resolved: boolean;
  readonly offset: number;
  readonly length: number;
}

/**
 * The structured success payload from `scanApexSource`.
 *
 * `fieldAccesses` is deduplicated by `(object, field)` partitioned by
 * `type` (a read and a write for the same pair are two entries).
 * `methodCalls` is deduplicated by `(className, methodName)`.
 *
 * `instantiations` is deduplicated by `className`.
 *
 * `methodBodyCount` is a smoke-test signal: it counts only the
 * top-level brace-balanced regions *inside* the outer class/trigger
 * body (method bodies, accessor blocks, static initializers, inner
 * classes). Since v0.3-R3.5 the scanner also sweeps the outer body
 * itself (catching single-statement triggers and class field
 * initializers), so a `methodBodyCount: 0` no longer implies that
 * scanning produced no edges. Use the lengths of `fieldAccesses`,
 * `methodCalls`, and `instantiations` for that.
 */
export interface ApexScannerOutput {
  readonly fieldAccesses: readonly FieldAccess[];
  readonly methodCalls: readonly MethodCallSite[];
  readonly instantiations: readonly Instantiation[];
  /**
   * Objects named by the top-level `FROM` of inline SOQL queries — plus
   * semi-join subquery (`IN (SELECT ...)`) objects — deduplicated by
   * `object` (first source-order occurrence wins).
   */
  readonly soqlFromObjects: readonly SoqlFromObject[];
  /**
   * `EventBus.subscribe(channel, ...)` registrations (P3b). Each entry records
   * the first argument's resolved static channel (or `resolved: false` for a
   * dynamic arg). Deduplicated by `channel` for resolved entries (first
   * source-order occurrence wins); unresolved entries are kept individually so
   * the consumer can disclose how many dynamic subscriptions were skipped.
   */
  readonly eventSubscriptions: readonly EventSubscription[];
  readonly methodBodyCount: number;
}

/**
 * Static-helper / built-in class names whose `Class.method(...)` and
 * `Class.field` shapes must NOT be reported as SObject field accesses.
 * User-defined helper classes are reclassified by the extractor after
 * cross-checking against the org's known Apex set; this set covers the
 * names that cannot be user-defined.
 */
const KEYWORD_CLASSES = new Set<string>([
  'Blob',
  'Boolean',
  'Crypto',
  'Database',
  'Date',
  'Datetime',
  'Decimal',
  'Double',
  'EncodingUtil',
  'Http',
  'HttpRequest',
  'HttpResponse',
  'Id',
  'Integer',
  'JSON',
  'Limits',
  'Long',
  'Math',
  'Object',
  'Schema',
  'String',
  'System',
  'Test',
  'Time',
  'Trigger',
  'URL',
  'UserInfo',
]);

/**
 * Generic-collection type names that are pure noise when captured as a
 * `new {Name}(...)` instantiation. `new List<Account>()` /
 * `new Map<Id,String>()` / `new Set<Id>()` / `new Iterator(...)` name a
 * built-in container, not a user component, so the instantiation sweep
 * drops them (in addition to the `KEYWORD_CLASSES` static-helper set).
 * SObject constructors (`new Account()`) are NOT denylisted — they emit
 * an `ApexClass:Account` edge that import-time `targetMissing` tagging
 * hides from the subgraph, which is acceptable for this heuristic tier.
 */
const COLLECTION_CLASSES = new Set<string>([
  'List',
  'Map',
  'Set',
  'Iterator',
]);

/**
 * Built-in SObject INSTANCE methods. When a method call's receiver is a local
 * whose declared type was instantiated via `new` in the same body (so the
 * call would otherwise be REDIRECTED to a `callsApex` edge against that type —
 * see `emitCall`), a call to one of these is an SObject API call, not a user
 * Apex-class invocation. `new Account(); a.addError('x')` must NOT mint a
 * phantom `callsApex ApexClass:Account.addError` — the redirect is suppressed
 * and the call is dropped, preserving the pre-redirect behavior for SObjects.
 */
const SOBJECT_INSTANCE_METHODS = new Set<string>([
  'addError',
  'clear',
  'clone',
  'get',
  'getCloneSourceId',
  'getErrors',
  'getOptions',
  'getPopulatedFieldsAsMap',
  'getQuickActionName',
  'getSObject',
  'getSObjects',
  'getSObjectType',
  'isClone',
  'isSet',
  'put',
  'putSObject',
  'recalculateFormulas',
]);

// Match line comments, block comments, and single-quoted strings.
// Block comments do not nest in Apex; strings honor `\` escapes.
const COMMENT_OR_STRING = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'/g;

// Capture an `IDENT.IDENT` pair followed by a write-shaped operator.
// `=(?!=)` excludes the equality comparison `==`. Assignment operators
// covered: `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `|=`, `&=`, `^=`, `<<=`,
// `>>=`, `>>>=`, plus `++` and `--` postfix.
const WRITE_PATTERN =
  /\b([A-Za-z_][A-Za-z_0-9]*)\.([A-Za-z_][A-Za-z_0-9]*)\s*(\+\+|--|<<=|>>>=|>>=|[+\-*/%|&^]=|=(?!=))/g;

// Capture an `IDENT.IDENT(` pair (method call). The trailing `(` is
// part of the match length so spans are useful for hover diagnostics.
const METHOD_CALL_PATTERN = /\b([A-Za-z_][A-Za-z_0-9]*)\.([A-Za-z_][A-Za-z_0-9]*)\s*\(/g;

// Capture an `IDENT.IDENT` pair that is NOT a write and NOT a method
// call. The IDENTs are anchored with negative lookbehind/lookahead on
// identifier characters so the regex cannot back off to a shorter
// prefix of either identifier (e.g., matching `TriggerHandler.proces`
// from `TriggerHandler.process(`).
const READ_PATTERN =
  /(?<![A-Za-z_0-9])([A-Za-z_][A-Za-z_0-9]*)\.([A-Za-z_][A-Za-z_0-9]*)(?![A-Za-z_0-9])(?!\s*(?:\+\+|--|<<=|>>>=|>>=|[+\-*/%|&^]=|=(?!=)|\())/g;

// Capture a `new ClassName(` constructor invocation (a SINGLE
// identifier, unlike the `IDENT.IDENT` pair patterns). The trailing `(`
// is part of the match length so spans are useful for hover
// diagnostics. A generic suffix like `new List<Account>(` matches
// `List` here — generic collections are dropped by COLLECTION_CLASSES
// in the instantiation sweep, so the `<...>` arg is intentionally not
// part of the capture.
const NEW_PATTERN = /\bnew\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(/g;

// Capture a local-variable / parameter DECLARATION of the conservative
// shape `TypeName localName` — `TypeName` PascalCase (Apex class naming
// convention), `localName` camelCase — terminated by `=`, `;`, `:`
// (for-each), `,` (next param), or `)` (last param). Group 1 is the
// declared TYPE; group 2 is the declared identifier. A generic suffix
// (`Map<Id, X>`) or array suffix (`String[]`) on the type is tolerated and
// not captured (so `List<Account> accs` captures type `List`, NOT the
// element type — collection types are excluded from type-resolution).
// Deliberately conservative: a name is only treated as a local when it is
// explicitly declared this way, so a bare `acc.Foo__c` with no visible
// declaration is still surfaced as a (heuristic) access — usage alone never
// infers a local. A trailing `(` (method declaration `Type name(`) is
// excluded by the lookahead, so method names are not mistaken for locals.
const LOCAL_DECL_PATTERN =
  /\b([A-Z][A-Za-z0-9_]*)(?:\s*<[^;{}()]*>)?(?:\s*\[\s*\])?\s+([a-z][A-Za-z0-9_]*)\s*(?=[=;:),])/g;

// Capture an INLINE SOQL statement `[SELECT ... ]`. Anchored on `[` followed
// by optional whitespace and the `SELECT` keyword so plain list/array indexing
// (`myList[0]`, `arr[i]`) is never mistaken for a query. Non-greedy to the
// first `]` — SOQL never nests `[...]` (bind variables use `:`, subqueries
// `(...)`), so the first `]` closes the statement. Runs on the comment/string
// -stripped source, so a `[SELECT...]`-shaped STRING literal cannot match.
// Case-insensitive: SOQL keywords are case-insensitive in Apex.
const INLINE_SOQL_PATTERN = /\[\s*SELECT\b[\s\S]*?\]/gi;

// A `FROM` keyword inside a SOQL statement. Used to find the primary object;
// matches at paren depth > 0 (child-relationship subqueries) are rejected by
// the caller's depth check.
const SOQL_FROM_PATTERN = /\bFROM\b/gi;

// The object identifier immediately following a `FROM` keyword (allowing a
// namespace prefix / `__c` / `__mdt` suffix, all plain identifier chars).
const SOQL_FROM_OBJECT_PATTERN = /^(\s+)([A-Za-z_][A-Za-z0-9_]*)/;

// Capture an `EventBus.subscribe(` call opener (P3b). Tolerates whitespace
// around the dots and before the paren. The trailing `(` is part of the match
// so the scanner can read the FIRST argument that follows. Detection runs on
// the comment/string-stripped source so a commented-out or quoted call cannot
// match; the channel literal itself is then read from the ORIGINAL source at
// the same (preserved) offset, since string literals are blanked in `stripped`.
const EVENT_BUS_SUBSCRIBE_PATTERN =
  /\bEventBus\s*\.\s*subscribe\s*\(/g;

// The FIRST argument of an EventBus.subscribe(...) call, read from the ORIGINAL
// source, when it is a STATIC single-quoted string literal. Group 1 is the
// string contents. Anchored at the start (the slice begins right after the
// opening paren); leading whitespace is tolerated. A non-literal first arg
// (a variable, method call, or concatenation) does not match → unresolved.
const EVENT_BUS_CHANNEL_LITERAL_PATTERN = /^\s*'((?:\\[\s\S]|[^'\\])*)'/;

// The Platform Event channel-routing prefix Salesforce uses for the string
// form of `EventBus.subscribe`. `'/event/Order_Placed__e'` and
// `'Order_Placed__e'` name the same event; normalize to the bare API name.
const EVENT_CHANNEL_PREFIX = '/event/';

const blankOut = (text: string): string => text.replace(/[^\n]/g, ' ');

/**
 * Replace comments and string literals with spaces. Preserves byte
 * length and newline layout so caller-side offsets stay valid.
 */
const stripCommentsAndStrings = (source: string): string =>
  source.replace(COMMENT_OR_STRING, blankOut);

/** The names + resolved declared types of the locals in one body. */
interface DeclaredLocals {
  /** Every declared local / parameter name (seeded with `this` / `super`). */
  readonly locals: ReadonlySet<string>;
  /**
   * `localName → declared TYPE` for the subset whose type is RESOLVABLE: a
   * single, consistent, SObject-ish PascalCase type. Names declared with
   * conflicting types, or typed as a collection / built-in helper, are
   * omitted (left to fall back to the alias).
   */
  readonly localTypes: ReadonlyMap<string, string>;
  /**
   * `localName → declared TYPE` for the subset of {@link localTypes} whose
   * type is ALSO instantiated via `new Type(...)` somewhere in the same body.
   * A local known to hold a freshly-constructed user class (`Helper h = new
   * Helper(); h.run()`) lets the call sweep emit the REAL
   * `callsApex ApexClass:Helper` edge instead of a phantom `ApexClass:h`
   * (the local name) — fixing trigger→helper / class→helper call visibility.
   */
  readonly instanceLocalTypes: ReadonlyMap<string, string>;
}

/**
 * Collect the locally declared variables and parameters in the
 * (comment/string-stripped) class or trigger body. Two products:
 *
 * 1. `locals` — every declared name, so the method-call sweep can drop
 *    phantom call edges whose receiver is a local (e.g.
 *    `Account acc = ...; acc.doWork()` must not mint a phantom
 *    `ApexClass:acc` — a local is never an Apex class). Seeded with
 *    `this` / `super`, which are never user component references.
 *
 * 2. `localTypes` — the receiver TYPE-RESOLUTION map for field accesses.
 *    A field access on a local (`acc.Name` where `Account acc` was
 *    declared) is resolved to the real edge `CustomField:Account.Name`
 *    instead of the meaningless alias `CustomField:acc.Name`. This both
 *    removes the alias phantom AND mints the correct apex→field edge.
 *    Deliberately CONSERVATIVE — a name is resolved only when its type is
 *    unambiguous (a single declaration, or repeated declarations that all
 *    agree). Names declared with conflicting types are dropped (the
 *    alias is kept). Collection types (`List`/`Map`/`Set`/`Iterator` —
 *    `List<Account> accs` captures `List`, not the element type) and
 *    built-in helper / primitive types (`KEYWORD_CLASSES`) are excluded,
 *    since a field access on them is not a real SObject field reference.
 *    `var` locals never match `LOCAL_DECL_PATTERN` (lowercase type), so
 *    they are excluded by construction.
 */
const collectDeclaredLocals = (
  stripped: string,
  start: number,
  end: number,
): DeclaredLocals => {
  const locals = new Set<string>(['this', 'super']);
  const firstType = new Map<string, string>();
  const conflicting = new Set<string>();
  const body = stripped.slice(start, end);
  LOCAL_DECL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOCAL_DECL_PATTERN.exec(body)) !== null) {
    const type = match[1];
    const name = match[2];
    if (name === undefined) continue;
    locals.add(name);
    if (type === undefined) continue;
    const prior = firstType.get(name);
    if (prior === undefined) firstType.set(name, type);
    else if (prior !== type) conflicting.add(name);
  }
  const localTypes = new Map<string, string>();
  for (const [name, type] of firstType) {
    if (conflicting.has(name)) continue;
    if (KEYWORD_CLASSES.has(type) || COLLECTION_CLASSES.has(type)) continue;
    localTypes.set(name, type);
  }
  // Types constructed with `new Type(...)` in this body — the strong signal
  // that a declared local of that type holds a real (user) class instance, so
  // a call on it can be redirected to the class (`callsApex`) rather than
  // minting a phantom edge against the local's name.
  const instantiatedTypes = new Set<string>();
  NEW_PATTERN.lastIndex = 0;
  let nm: RegExpExecArray | null;
  while ((nm = NEW_PATTERN.exec(body)) !== null) {
    const type = nm[1];
    if (type !== undefined) instantiatedTypes.add(type);
  }
  const instanceLocalTypes = new Map<string, string>();
  for (const [name, type] of localTypes) {
    if (instantiatedTypes.has(type)) instanceLocalTypes.set(name, type);
  }
  return { locals, localTypes, instanceLocalTypes };
};

/**
 * Find the offset of the first `{` that opens the outer class or
 * trigger body. Returns `-1` if no `class` or `trigger` keyword was
 * found, or `-2` if the keyword was found but no `{` follows.
 */
const findOuterBraceStart = (stripped: string): number => {
  const re = /\b(?:class|trigger)\b/g;
  const match = re.exec(stripped);
  if (match === null) return -1;
  for (let i = match.index + match[0].length; i < stripped.length; i += 1) {
    if (stripped[i] === '{') return i;
  }
  return -2;
};

/**
 * Find the offset of the `}` that matches the `{` at `openIndex`.
 * Returns `-1` if the braces are unbalanced (no matching close).
 */
const findMatchingBrace = (stripped: string, openIndex: number): number => {
  let depth = 0;
  for (let i = openIndex; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/**
 * Walk the class body and collect the byte ranges (open-brace offset,
 * close-brace offset) of each top-level brace-balanced region. Each
 * such region is a candidate method body, accessor block, static
 * initializer, or inner class — the scanner treats them the same.
 */
const findMethodBodies = (
  stripped: string,
  classBodyStart: number,
  classBodyEnd: number,
): readonly { readonly start: number; readonly end: number }[] => {
  const bodies: { start: number; end: number }[] = [];
  let i = classBodyStart + 1;
  while (i < classBodyEnd) {
    const ch = stripped[i];
    if (ch === '{') {
      const close = findMatchingBrace(stripped, i);
      if (close === -1 || close > classBodyEnd) break;
      bodies.push({ start: i, end: close });
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return bodies;
};

interface PairMatch {
  readonly left: string;
  readonly right: string;
  readonly absOffset: number;
  readonly length: number;
}

// Sweep one `IDENT.IDENT`-shaped pattern across `body` and yield each
// well-formed, non-keyword match with offsets translated to the
// original source. Filters out empty captures and any pair whose
// left identifier is a known static-helper class.
function* sweepPairs(
  pattern: RegExp,
  body: string,
  startOffset: number,
): Generator<PairMatch> {
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    const left = m[1] ?? '';
    const right = m[2] ?? '';
    if (left === '' || right === '') continue;
    if (KEYWORD_CLASSES.has(left)) continue;
    yield {
      left,
      right,
      absOffset: startOffset + m.index,
      length: m[0].length,
    };
  }
}

interface BodyContext {
  readonly accesses: FieldAccess[];
  readonly calls: MethodCallSite[];
  readonly instantiations: Instantiation[];
  readonly seenAccesses: Set<string>;
  readonly seenCalls: Set<string>;
  readonly seenInstantiations: Set<string>;
  /** Locally declared variable / parameter names to exclude as left-hand sides. */
  readonly locals: ReadonlySet<string>;
  /** `localName → declared SObject-ish type` for field-access receiver resolution. */
  readonly localTypes: ReadonlyMap<string, string>;
  /** `localName → declared class type` for locals constructed via `new` in-body. */
  readonly instanceLocalTypes: ReadonlyMap<string, string>;
}

// Translate a pair-match into a FieldAccess of `type` and push it iff
// `(type, object, field)` is new. Returns the absolute offset so the
// caller can record write spans for later read-pass exclusion.
const emitAccess = (
  ctx: BodyContext,
  type: 'read' | 'write',
  match: PairMatch,
): number => {
  // `this.x` / `super.x` read or write the current instance's own members,
  // never an sObject field — they can only mint a phantom `CustomField:this.x`.
  if (match.left === 'this' || match.left === 'super') return match.absOffset;
  // Resolve a declared local to its SObject-ish type so `acc.Field` (with
  // `Account acc` in scope) becomes the real `CustomField:Account.Field`
  // instead of the alias phantom `CustomField:acc.Field`. Unknown receivers
  // (real object/static-class names, or aliases we could not resolve) pass
  // through unchanged. Dedup keys on the RESOLVED object so two aliases of the
  // same type+field collapse to one access.
  const object = ctx.localTypes.get(match.left) ?? match.left;
  const key = `${type}:${object}.${match.right}`;
  if (ctx.seenAccesses.has(key)) return match.absOffset;
  ctx.seenAccesses.add(key);
  ctx.accesses.push({
    type,
    object,
    field: match.right,
    offset: match.absOffset,
    length: match.length,
  });
  return match.absOffset;
};

// Translate a pair-match into a MethodCallSite and push it iff
// `(className, methodName)` is new.
const emitCall = (ctx: BodyContext, match: PairMatch): void => {
  let className = match.left;
  if (ctx.locals.has(match.left)) {
    // `match.left` is a declared local. If its declared type was constructed
    // via `new Type(...)` in this body, the call is `instance.method()` on a
    // real class — REDIRECT the edge to that class so `Helper h = new
    // Helper(); h.run()` mints the real `callsApex ApexClass:Helper` instead
    // of a phantom `ApexClass:h` (the local name). Without that strong signal
    // the callee class is unresolvable, so the call is dropped as before.
    const redirected = ctx.instanceLocalTypes.get(match.left);
    if (redirected === undefined) return;
    // A built-in SObject instance method on a `new Account()` local is an
    // SObject API call, not a user-class invocation — drop it (no phantom).
    if (SOBJECT_INSTANCE_METHODS.has(match.right)) return;
    className = redirected;
  }
  const key = `${className}.${match.right}`;
  if (ctx.seenCalls.has(key)) return;
  ctx.seenCalls.add(key);
  ctx.calls.push({
    className,
    methodName: match.right,
    offset: match.absOffset,
    length: match.length,
  });
};

// Push an Instantiation for `className` iff it is new AND not a
// denylisted built-in (static-helper class or generic collection).
// `new ClassName(` yields a single identifier, so this consumes the
// NEW_PATTERN match directly rather than going through `sweepPairs`.
const emitInstantiation = (
  ctx: BodyContext,
  className: string,
  absOffset: number,
  length: number,
): void => {
  if (KEYWORD_CLASSES.has(className) || COLLECTION_CLASSES.has(className)) {
    return;
  }
  if (ctx.seenInstantiations.has(className)) return;
  ctx.seenInstantiations.add(className);
  ctx.instantiations.push({ className, offset: absOffset, length });
};

/**
 * Run the four regex sweeps over a single method body and append
 * unique entries to the running collections. The read sweep also
 * skips offsets the write sweep consumed; the regex lookaheads can
 * still match a read-shape at a write site under specific spacing.
 *
 * The fourth sweep (`NEW_PATTERN`) captures `new ClassName(`
 * constructor invocations. Unlike the other three it captures a single
 * identifier (not an `IDENT.IDENT` pair), so it runs its own small loop
 * rather than going through `sweepPairs`; the denylist filtering and
 * dedupe live in `emitInstantiation`.
 */
const scanBody = (
  stripped: string,
  start: number,
  end: number,
  ctx: BodyContext,
): void => {
  const body = stripped.slice(start, end);
  const writeOffsets = new Set<number>();
  for (const match of sweepPairs(WRITE_PATTERN, body, start)) {
    writeOffsets.add(emitAccess(ctx, 'write', match));
  }
  for (const match of sweepPairs(METHOD_CALL_PATTERN, body, start)) {
    emitCall(ctx, match);
  }
  for (const match of sweepPairs(READ_PATTERN, body, start)) {
    if (writeOffsets.has(match.absOffset)) continue;
    emitAccess(ctx, 'read', match);
  }
  NEW_PATTERN.lastIndex = 0;
  let nm: RegExpExecArray | null;
  while ((nm = NEW_PATTERN.exec(body)) !== null) {
    const className = nm[1] ?? '';
    if (className === '') continue;
    emitInstantiation(ctx, className, start + nm.index, nm[0].length);
  }
};

/** A parenthesized SOQL subquery is a SEMI-JOIN iff its opener follows IN / NOT IN. */
const SEMI_JOIN_OPENER_PATTERN = /\b(?:not\s+)?in\s*$/i;

/**
 * Collect every `FROM {object}` in one inline SOQL statement `query` (the full
 * `[SELECT ... ]` text) that names a REAL SObject, with each offset RELATIVE
 * to `query`. Two shapes qualify:
 *
 *   1. The PRIMARY paren-depth-0 `FROM` of the query.
 *   2. A semi-join subquery's `FROM` — `WHERE Id IN (SELECT ... FROM Contact)`
 *      — whose opening paren directly follows `IN` / `NOT IN`. Those FROMs
 *      name real SObjects and the query genuinely reads them.
 *
 * Child-relationship subqueries `(SELECT ... FROM Contacts)` (an opener NOT
 * after IN — they sit in the SELECT clause) stay skipped: their `FROM` names a
 * relationship, not an SObject API name — minting an edge there would be a
 * phantom. Empty when the query has no resolvable `FROM` at all.
 */
const collectSoqlFroms = (
  query: string,
): Array<{ readonly object: string; readonly relOffset: number }> => {
  const out: Array<{ readonly object: string; readonly relOffset: number }> = [];
  SOQL_FROM_PATTERN.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = SOQL_FROM_PATTERN.exec(query)) !== null) {
    // Paren-opener stack up to this FROM. Cheap because a single inline
    // query is short; correctness beats micro-optimization here.
    const openers: number[] = [];
    for (let i = 0; i < fm.index; i++) {
      const c = query[i];
      if (c === '(') openers.push(i);
      else if (c === ')') openers.pop();
    }
    if (openers.length > 0) {
      // Inside a subquery: a semi-join's innermost opener follows IN/NOT IN;
      // anything else is a child-relationship subquery → skip.
      const openerIdx = openers[openers.length - 1] ?? 0;
      if (!SEMI_JOIN_OPENER_PATTERN.test(query.slice(0, openerIdx))) continue;
    }
    const after = query.slice(fm.index + 4); // skip the 4 chars of "FROM"
    const idMatch = SOQL_FROM_OBJECT_PATTERN.exec(after);
    if (idMatch && (idMatch[2] ?? '') !== '') {
      out.push({
        object: idMatch[2] ?? '',
        relOffset: fm.index + 4 + (idMatch[1] ?? '').length,
      });
    }
  }
  return out;
};

/**
 * Sweep `stripped[start..end]` for inline SOQL statements and return the
 * SObject-naming `FROM` objects of each (primary + semi-join subqueries),
 * deduplicated by object name (first source-order occurrence wins, mirroring
 * the other sweeps' offset stability). Offsets are absolute in the original
 * source.
 */
const scanSoqlFromObjects = (
  stripped: string,
  start: number,
  end: number,
): SoqlFromObject[] => {
  const body = stripped.slice(start, end);
  const out: SoqlFromObject[] = [];
  const seen = new Set<string>();
  INLINE_SOQL_PATTERN.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = INLINE_SOQL_PATTERN.exec(body)) !== null) {
    for (const found of collectSoqlFroms(sm[0])) {
      if (seen.has(found.object)) continue;
      seen.add(found.object);
      out.push({
        object: found.object,
        offset: start + sm.index + found.relOffset,
        length: found.object.length,
      });
    }
  }
  return out;
};

/**
 * Sweep `stripped[start..end]` for `EventBus.subscribe(channel, ...)` calls
 * (P3b) and recover each first-argument channel from the ORIGINAL `source`.
 * Detection runs on the stripped text (so commented-out / quoted calls are
 * skipped); the channel literal is read from `source` at the same preserved
 * offset because `stripped` has the string contents blanked to spaces.
 *
 * A static single-quoted literal yields `{ channel, resolved: true }` (a
 * `/event/X__e` form normalized to `X__e`); any other first arg (variable,
 * method call, concatenation) yields `{ channel: '', resolved: false }` — the
 * honest "dynamic channel, not resolved" signal that mints NO edge downstream.
 *
 * Resolved entries are deduped by channel (first source-order occurrence wins);
 * unresolved entries are kept individually.
 */
const scanEventSubscriptions = (
  source: string,
  stripped: string,
  start: number,
  end: number,
): EventSubscription[] => {
  const out: EventSubscription[] = [];
  const seenResolved = new Set<string>();
  EVENT_BUS_SUBSCRIBE_PATTERN.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = EVENT_BUS_SUBSCRIBE_PATTERN.exec(stripped)) !== null) {
    if (m.index >= end) break;
    const argStart = m.index + m[0].length;
    // Read the first argument from the ORIGINAL source (string literals are
    // intact there, blanked in `stripped`).
    const litMatch = EVENT_BUS_CHANNEL_LITERAL_PATTERN.exec(
      source.slice(argStart, end),
    );
    if (litMatch === null || litMatch[1] === undefined) {
      out.push({ channel: '', resolved: false, offset: m.index, length: m[0].length });
      continue;
    }
    const raw = litMatch[1];
    const channel = raw.startsWith(EVENT_CHANNEL_PREFIX)
      ? raw.slice(EVENT_CHANNEL_PREFIX.length)
      : raw;
    if (channel.length === 0) {
      out.push({ channel: '', resolved: false, offset: m.index, length: m[0].length });
      continue;
    }
    if (seenResolved.has(channel)) continue;
    seenResolved.add(channel);
    out.push({ channel, resolved: true, offset: m.index, length: m[0].length });
  }
  return out;
};

/**
 * Scan Apex source for field accesses and method calls using a pure
 * regex / brace-balanced heuristic. Suitable for the v0.3 release —
 * v0.4 will add a PMD AST layer alongside this for the cases regex
 * cannot handle (SOQL strings, dynamic field access, etc.).
 *
 * Returns `empty-source` for whitespace-only input,
 * `no-class-or-trigger` if no `class` or `trigger` keyword exists
 * outside comments and strings, and `unbalanced-braces` if the outer
 * class body's `{` has no matching `}`.
 *
 * The scan covers the entire outer class/trigger body, including all
 * inner method bodies, accessor blocks, static initializers, and
 * inner classes — plus statements at the outer top level such as
 * single-line trigger bodies and class field initializers.
 *
 * Output is deterministic: the same input always produces the same
 * output, including the order of `fieldAccesses`, `methodCalls`, and
 * `instantiations`. The lists are deduplicated by `(object, field)`
 * (partitioned by `type`), `(className, methodName)`, and `className`
 * respectively; first occurrence in source order wins (so its `offset`
 * and `length` are the ones reported). `instantiations` additionally
 * drops generic-collection and static-helper built-ins (see
 * `COLLECTION_CLASSES` / `KEYWORD_CLASSES`).
 *
 * @example
 *   const result = scanApexSource(
 *     'public class Foo { void run() { acc.Industry__c = "Tech"; } }',
 *   );
 *   if (result.ok) {
 *     const writes = result.value.fieldAccesses.filter((a) => a.type === 'write');
 *     console.log(writes[0]?.field); // 'Industry__c'
 *   }
 */
export const scanApexSource = (
  source: string,
): Result<ApexScannerOutput, ApexScannerError> => {
  if (source.trim().length === 0) {
    return err({
      kind: 'empty-source',
      message: 'source is empty or whitespace-only',
      offset: 0,
    });
  }

  const stripped = stripCommentsAndStrings(source);
  const outerOpen = findOuterBraceStart(stripped);
  if (outerOpen === -1) {
    return err({
      kind: 'no-class-or-trigger',
      message: 'no class or trigger declaration found outside comments/strings',
      offset: 0,
    });
  }
  if (outerOpen === -2) {
    return err({
      kind: 'unbalanced-braces',
      message: 'class or trigger keyword has no opening brace',
      offset: 0,
    });
  }
  const outerClose = findMatchingBrace(stripped, outerOpen);
  if (outerClose === -1) {
    return err({
      kind: 'unbalanced-braces',
      message: `unbalanced braces starting at offset ${outerOpen}`,
      offset: outerOpen,
    });
  }

  const bodies = findMethodBodies(stripped, outerOpen, outerClose);
  const declared = collectDeclaredLocals(stripped, outerOpen, outerClose);
  const ctx: BodyContext = {
    accesses: [],
    calls: [],
    instantiations: [],
    seenAccesses: new Set<string>(),
    seenCalls: new Set<string>(),
    seenInstantiations: new Set<string>(),
    locals: declared.locals,
    localTypes: declared.localTypes,
    instanceLocalTypes: declared.instanceLocalTypes,
  };
  // Sweep the entire outer body in one pass. This catches single-
  // statement trigger bodies and class field initializers that sit
  // outside any inner method body, while also covering everything
  // inside inner method bodies (a superset of the previous behavior).
  // The dedupe in BodyContext keeps the first-source-order occurrence,
  // so callers that depended on stable offsets from inner-only
  // scanning continue to see those same offsets — the offsets only
  // change when the outer body contains an earlier-source-order
  // occurrence of the same `(type, object, field)` or
  // `(className, methodName)`.
  scanBody(stripped, outerOpen, outerClose, ctx);
  return ok({
    fieldAccesses: ctx.accesses,
    methodCalls: ctx.calls,
    instantiations: ctx.instantiations,
    soqlFromObjects: scanSoqlFromObjects(stripped, outerOpen, outerClose),
    eventSubscriptions: scanEventSubscriptions(
      source,
      stripped,
      outerOpen,
      outerClose,
    ),
    methodBodyCount: bodies.length,
  });
};
