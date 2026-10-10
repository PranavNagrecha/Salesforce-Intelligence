/**
 * Code-quality pattern recognizers for Apex source.
 *
 * The Apex quality catalog. THIS FILE is the catalog: every recognizer,
 * its severity and its blind spots are declared below and nowhere else.
 *
 * It used to cite a vendored `docs/vendor/salesforce-metadata/*.md` spec that
 * this repository does not ship, from nineteen sites including host-facing MCP
 * tool descriptions — so a host could quote a section number at a user for a
 * document nobody could open. Every such citation is gone; what the sections
 * said is stated inline, next to the code that implements it, where it cannot
 * drift out of sync with the behaviour.
 *
 * Each recognizer is a heuristic pattern matcher that consumes raw
 * `.cls` / `.trigger` source plus the small metadata bag the extractor
 * already has (`apiVersion`, `isTest`). The module's single entry
 * point — `detectCodeQualityIssues(source, metadata)` — runs every
 * recognizer in sequence and returns a flat `QualityIssue[]` ordered
 * by source-position so the renderer-side output is deterministic.
 *
 * The recognizer family sits ABOVE the v0.3 `apex-scanner` in the
 * extraction stack: the scanner extracts structural edges (read/write
 * pairs, method-call sites), while this module observes anti-patterns
 * the scanner does not surface. The two are intentionally independent
 * — adding a new quality recognizer does NOT require touching the
 * scanner, and adding a new scanner edge does NOT require touching
 * the quality module.
 *
 * Confidence floor: every recognizer emits `confidence: 'heuristic'`
 * exclusively. Regex pattern matching cannot prove anything; it can
 * only recognize a shape. The literal-type narrows the `confidence`
 * field to the single value at the type level so a future PMD-based
 * AST layer would be a separate confidence track (a `'parsed'` floor)
 * rather than an opt-in promotion of these recognizers.
 *
 * String / comment stripping discipline:
 *
 * - The DEFAULT stripped source (comments + string literals replaced
 *   with spaces, offsets preserved) drives loop-body / DML / SOQL
 *   detection. The recognizers that need to SEE string contents
 *   (`hardcoded-id`, `hardcoded-email`, `hardcoded-username`,
 *   `hardcoded-sandbox-data`) opt out by working on the raw source
 *   directly. This is the only deviation from the strip-first posture:
 *   a hardcoded literal IS the string, so blanking strings first would
 *   blank the very evidence these four recognizers look for.
 *
 * Known limitations — the recognizers are pattern matchers, not a compiler,
 * and these are the shapes they provably cannot see:
 *
 * - **Cross-method blindness.** A method that delegates the dangerous
 *   operation to a helper is analyzed in isolation; the helper's
 *   behavior is invisible.
 * - **Three orthogonal access planes (CR-04).** CRUD (object-level),
 *   FLS (field-level), and record sharing are distinct; the
 *   `missing-crud-check` recognizer is about WRITE AUTHORIZATION only.
 *   A SOQL `WITH SECURITY_ENFORCED` / `WITH USER_MODE` clause enforces
 *   READ FLS + object read on the QUERY and does NOT clear a later DML
 *   write — only an object write-CRUD check
 *   (`Schema.sObjectType.X.is{Createable|Updateable|Deletable}()`),
 *   user-mode DML (`insert x as user`, `Database.insert(x,
 *   AccessLevel.USER_MODE)`), or a write-FLS strip
 *   (`Security.stripInaccessible(AccessType.CREATABLE|UPDATABLE|UPSERTABLE,
 *   …)`) gates a write. `isAccessible()` is a READ check and never clears
 *   a write. Explicit `Database.insert(x, AccessLevel.SYSTEM_MODE)` is a
 *   DELIBERATE opt-out (system mode) — NOT a `missing-crud-check` omission:
 *   it is reclassified as an `intentional-system-mode-dml` review finding
 *   (`info`), surfaced with the honest "switch to USER_MODE to enforce"
 *   remediation rather than a high-severity "add a Schema check" alarm (W7.3).
 *   Symmetrically, the `missing-fls-check` READ recognizer clears a query
 *   whose result is sanitized with a READ-path strip
 *   (`Security.stripInaccessible(AccessType.READABLE, <resultVar>)`) — the
 *   modern read-FLS pattern, equivalent to `WITH SECURITY_ENFORCED`.
 * - **Custom security utility helpers invisible.** Only the standard
 *   constructs above are recognized; org-specific
 *   `SecurityUtils.canCreate(...)` helpers trigger false positives.
 * - **Dynamic SOQL strings invisible.** The contents of
 *   `Database.query('SELECT...')` strings are stripped before
 *   pattern passes; the recognizer cannot analyze the embedded SQL.
 * - **Reflective field access invisible.** `obj.get('FieldName')`
 *   and `Schema.fieldSetMember.getFieldPath()` do not show up as
 *   field reads to the FLS recognizer.
 * - **Trigger-framework recognition partial.** Only the
 *   static-Boolean and static-`Set<Id>` recursion-guard shapes are
 *   recognized; framework base classes (fflib's TriggerHandler,
 *   custom team-specific handlers) are invisible.
 *
 * Boundary disclosures: callers (the `developer-code-quality` skill
 * in particular) MUST surface the relevant verbatim disclosure when
 * a finding intersects one of these boundaries. The recognizer only
 * produces the finding; the skill provides the honesty.
 */

/**
 * One quality observation produced by a recognizer.
 *
 * - `rule`: canonical pattern id (e.g., `'soql-in-loop'`,
 *   `'hardcoded-id'`). Stable across releases.
 * - `severity`: fixed per rule per the v2.1 catalog. Industry-
 *   consensus assignment; not overridable in v2.1.
 * - `location`: a best-effort source pointer of the shape
 *   `'line {N}'` for raw-line matches, `'method:{name}:line{N}'`
 *   when a containing method is known, or `'class' / 'trigger'` for
 *   recognizers that flag a declaration rather than a body span.
 * - `explanation`: brief human-readable why-this-matters string.
 *   Each recognizer's own comment block below carries the full reasoning.
 * - `confidence`: always the literal `'heuristic'`.
 */
export interface QualityIssue {
  readonly rule: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  readonly location: string;
  readonly explanation: string;
  readonly confidence: 'heuristic';
}

/** Metadata the extractor already has on hand — passed to the recognizer family. */
export interface CodeQualityMetadata {
  readonly apiVersion: number;
  readonly isTest: boolean;
}

// ---------- string / comment stripping (mirrors apex-scanner) -------------

// Match line comments, block comments, and single-quoted strings.
// Block comments do not nest in Apex; strings honor `\` escapes.
const COMMENT_OR_STRING_PATTERN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'/g;

const blankOut = (text: string): string => text.replace(/[^\n]/g, ' ');

/**
 * Replace comments and string literals with spaces. Preserves byte
 * length and line layout so caller-side offsets / line numbers stay
 * valid. The stripped source is the input every recognizer EXCEPT
 * the four hardcoded-literal ones reads.
 */
const stripCommentsAndStrings = (source: string): string =>
  source.replace(COMMENT_OR_STRING_PATTERN, blankOut);

/**
 * Convert a character offset in the source to a 1-indexed line
 * number. Used to populate the `location` field on each issue.
 */
const offsetToLine = (source: string, offset: number): number => {
  if (offset <= 0) return 1;
  let line = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
};

// ---------- assertion counting (test-quality density input) ---------------

/**
 * Any assertion invocation the runtime recognises as a real assert: the classic
 * `System.assert*(` family (assert / assertEquals / assertNotEquals) AND the
 * modern `Assert.*(` class (`Assert.areEqual`, `Assert.isTrue`,
 * `Assert.isNotNull`, …) — Salesforce's recommended assertion API since
 * Spring '22, written either bare (`Assert.areEqual`) or fully-qualified
 * (`System.Assert.areEqual`, matched via the `Assert.` branch).
 */
const ASSERTION_PATTERN = /\b(?:System\.assert\w*|Assert\.\w+)\s*\(/g;

/**
 * Count assertion invocations in Apex source, comments / string literals
 * stripped first so an assertion mentioned in a comment or string is not
 * counted. Recognises both the legacy `System.assert*` family and the modern
 * `Assert.*` class — the raw assertion frequency `sfi.meaningful_test_audit`
 * divides by source size for its density metric. NOTE: the separate
 * fake-assertion recognizer that flags meaningless asserts is still scoped to
 * `System.assertEquals` shapes, so an `Assert.areEqual(x, x)` self-equal is
 * counted here but not (yet) flagged fake; helper-method wrappers remain an
 * acknowledged blind spot. Returns 0 when none match.
 */
export const countAssertions = (source: string): number => {
  const matches = stripCommentsAndStrings(source).match(ASSERTION_PATTERN);
  return matches === null ? 0 : matches.length;
};

// ---------- brace-balanced loop body extraction ---------------------------

/** A loop-body span detected in the stripped source. */
interface LoopBody {
  /** Offset of the loop's opening `{`. */
  readonly bodyStart: number;
  /** Offset of the matching closing `}`. */
  readonly bodyEnd: number;
  /** Offset of the loop keyword (`for` / `while` / `do`) for line reporting. */
  readonly keywordOffset: number;
}

/**
 * Find the matching `}` for the `{` at `openIndex` in `stripped`.
 * Returns -1 when braces are unbalanced; the caller silently skips
 * the malformed span rather than aborting the whole class scan.
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
 * Offset of the `{` that opens the innermost block enclosing `offset`,
 * found by walking BACKWARD over the stripped source and counting brace
 * depth. Returns 0 (file start) when no enclosing `{` is found (e.g. a
 * statement at top level). Offsets align with `source` because
 * `stripCommentsAndStrings` preserves byte length.
 *
 * Used by the CRUD-check recognizer to bound its hint scan to the block
 * that lexically contains a DML statement — so a security check in one
 * method cannot clear an ungated DML in a DIFFERENT method.
 */
const enclosingBlockStart = (stripped: string, offset: number): number => {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i -= 1) {
    const ch = stripped[i];
    if (ch === '}') depth += 1;
    else if (ch === '{') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return 0;
};

/**
 * Reserved Apex statement / control-flow keywords that must NEVER be treated
 * as a declared TYPE. Single source of truth for two consumers:
 *   1. `enclosingMethodStart` — distinguishes a method body (token before the
 *      param `(` is a method NAME) from a control-flow header (`if`/`for`/…).
 *   2. `resolveVarSObjectType` — the declaration regex (`<Type> var`) has no
 *      keyword guard, so a statement like `return acc;` would otherwise be
 *      parsed as type=`return`, var=`acc` (CR-RV9). Rejecting these keywords
 *      makes the resolver fall through to the safe loose-path degrade.
 * The set is a SUPERSET of the old local control-flow set: `return`, `throw`,
 * `new`, `final`, `do`, `try` are added (they were never valid method-name
 * tokens before a `(`, so the extra entries are harmless to consumer 1, and
 * they ARE the statement keywords the resolver must reject for consumer 2).
 */
const APEX_NON_TYPE_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'else',
  'return',
  'throw',
  'new',
  'final',
  'do',
  'try',
]);

/**
 * Offset boundaries of the ENCLOSING METHOD (or class) body that contains
 * `offset`, found by walking out one enclosing block at a time until the
 * block's controlling clause looks like a method/ctor signature (`) {`)
 * rather than a control-flow header (`if`/`for`/`while`/`try`/…). Returns
 * `{ bodyStart, sigStart }`:
 *   - `bodyStart` — offset of the method body's `{` (the prior behaviour).
 *   - `sigStart`  — offset of the parameter-list `(` for the method-shaped
 *     block, i.e. the start of the SIGNATURE span `[sigStart, bodyStart)`
 *     which contains the param list incl. its closing `)`. Falls back to
 *     `bodyStart` when no method shape is found (outermost / 0 fallbacks).
 * Offsets align with `source`.
 *
 * `bodyStart` is the WIDER fallback window for the CRUD-check recognizer: an
 * early-return / throw guard at the top of a method (`if (!X.isUpdateable())
 * throw ...; ... update x;`) lives in method scope, not the DML's innermost
 * block, so a same-method write-CRUD hint on the RESOLVED sObject is allowed
 * to clear the finding (the dominant guard idiom).
 *
 * `sigStart` exposes the parameter list to `resolveVarSObjectType` so a DML
 * target that is a method PARAMETER (`void save(Account acc){ … insert acc; }`,
 * the dominant service idiom) resolves to its SObject type — without it the
 * resolver window starts AFTER the param list and the type is invisible,
 * forcing the loose any-gate clear (CR-P3-2 security false-negative).
 */
const enclosingMethodStart = (
  stripped: string,
  offset: number,
): { bodyStart: number; sigStart: number } => {
  let cursor = offset;
  let outermost = 0;
  for (let guard = 0; guard < 64; guard += 1) {
    const blockOpen = enclosingBlockStart(stripped, cursor);
    if (blockOpen === 0) return { bodyStart: outermost, sigStart: outermost };
    outermost = blockOpen;
    // Inspect the text immediately before the `{`: a method/ctor body opens
    // after a `)` (the parameter list), whereas an `if`/`for`/`while`/`try`
    // body does too — so additionally require the controlling keyword NOT be
    // a control-flow keyword. Walk back over whitespace + a balanced `(...)`.
    let j = blockOpen - 1;
    while (j >= 0 && /\s/.test(stripped[j] ?? '')) j -= 1;
    if (j >= 0 && stripped[j] === ')') {
      const paramOpen = matchOpenParenBackward(stripped, j);
      if (paramOpen >= 0) {
        // The token(s) immediately before the `(` decide method vs control-flow.
        let k = paramOpen - 1;
        while (k >= 0 && /\s/.test(stripped[k] ?? '')) k -= 1;
        const end = k;
        while (k >= 0 && /[A-Za-z_0-9]/.test(stripped[k] ?? '')) k -= 1;
        const word = stripped.slice(k + 1, end + 1);
        if (!APEX_NON_TYPE_KEYWORDS.has(word)) {
          // Method / ctor body. The signature span `[paramOpen, blockOpen)`
          // contains the param list incl. its closing `)`.
          return { bodyStart: blockOpen, sigStart: paramOpen };
        }
      }
    }
    // Otherwise climb to the parent block.
    cursor = blockOpen;
  }
  return { bodyStart: outermost, sigStart: outermost };
};

/**
 * Walk BACKWARD from a `)` at `closeParen` to the matching `(`. Returns -1
 * when unbalanced. Mirrors `findMatchingParen` (forward) for the reverse
 * direction.
 */
const matchOpenParenBackward = (s: string, closeParen: number): number => {
  let depth = 0;
  for (let i = closeParen; i >= 0; i -= 1) {
    const ch = s[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

// Find each loop keyword (`for`, `while`, `do`) and the offset of the
// `{` that opens its body. `do` blocks open IMMEDIATELY at the `{`;
// `for` and `while` are followed by `(...)`. We walk linearly to find
// the next `{` after the loop header — this handles arbitrary header
// content (including nested parens, type names, etc.).
const LOOP_KEYWORD_PATTERN = /\b(for|while|do)\b/g;

/**
 * Skip the `(...)` header of a `for` / `while` loop, returning the
 * offset of the first character after the closing `)`. Returns -1 if
 * no balanced header is found.
 */
const skipLoopHeader = (stripped: string, start: number): number => {
  // Advance to the opening paren.
  let i = start;
  while (i < stripped.length && stripped[i] !== '(' && stripped[i] !== '{') {
    i += 1;
  }
  if (i >= stripped.length || stripped[i] !== '(') return i;
  let depth = 0;
  for (; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
};

/**
 * Locate the `{` that opens the body following a loop header.
 * Tolerates whitespace; returns -1 if the next non-whitespace
 * character is something other than `{` (single-statement loops
 * without braces — those are governor-limit-relevant too, but
 * structurally harder to span, so v2.1 deliberately skips them).
 */
const findBodyOpenBrace = (stripped: string, start: number): number => {
  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') continue;
    if (ch === '{') return i;
    return -1;
  }
  return -1;
};

/**
 * Enumerate every loop body in the stripped source. A loop body is
 * the brace-balanced region following a `for`, `while`, or `do`
 * keyword. Single-statement loops without braces are not enumerated.
 */
const findLoopBodies = (stripped: string): readonly LoopBody[] => {
  const bodies: LoopBody[] = [];
  const re = new RegExp(LOOP_KEYWORD_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const keyword = m[1] ?? '';
    const keywordOffset = m.index;
    const headerEnd =
      keyword === 'do'
        ? keywordOffset + keyword.length
        : skipLoopHeader(stripped, keywordOffset + keyword.length);
    if (headerEnd === -1) continue;
    const open = findBodyOpenBrace(stripped, headerEnd);
    if (open === -1) continue;
    const close = findMatchingBrace(stripped, open);
    if (close === -1) continue;
    bodies.push({ bodyStart: open, bodyEnd: close, keywordOffset });
  }
  return bodies;
};

// ---------- recognizer 1: soql-in-loop ------------------------------------

const SOQL_IN_LOOP_PATTERN =
  /\[\s*(?:SELECT|FIND)\b|\bDatabase\.(?:query|queryWithBinds|getQueryLocator|countQuery)\s*\(/gi;

const detectSoqlInLoop = (
  source: string,
  stripped: string,
  loops: readonly LoopBody[],
): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  // A statement nested N loops deep falls inside N loop bodies, so it would be
  // matched (and reported) once per enclosing loop. Dedupe by the statement's
  // ABSOLUTE source offset — nested re-matches share it; genuinely distinct
  // statements (even on the same line) have different offsets and are kept.
  const seenOffsets = new Set<number>();
  for (const loop of loops) {
    const body = stripped.slice(loop.bodyStart, loop.bodyEnd);
    const re = new RegExp(SOQL_IN_LOOP_PATTERN.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const absOffset = loop.bodyStart + m.index;
      if (seenOffsets.has(absOffset)) continue;
      seenOffsets.add(absOffset);
      issues.push({
        rule: 'soql-in-loop',
        severity: 'critical',
        location: `line ${offsetToLine(source, absOffset)}`,
        explanation:
          'SOQL query inside a loop body — risks the 100-SOQL-per-transaction governor limit. ' +
          'Move the query outside the loop and iterate the result set.',
        confidence: 'heuristic',
      });
    }
  }
  return issues;
};

// ---------- recognizer 2: dml-in-loop -------------------------------------

const DML_IN_LOOP_PATTERN =
  /\b(?:insert|update|delete|upsert|merge)\s+[A-Za-z_][A-Za-z_0-9]*|\bDatabase\.(?:insert|update|delete|upsert|merge)\s*\(/g;

const detectDmlInLoop = (
  source: string,
  stripped: string,
  loops: readonly LoopBody[],
): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  // Dedupe nested-loop re-matches by absolute offset (see detectSoqlInLoop).
  const seenOffsets = new Set<number>();
  for (const loop of loops) {
    const body = stripped.slice(loop.bodyStart, loop.bodyEnd);
    const re = new RegExp(DML_IN_LOOP_PATTERN.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const absOffset = loop.bodyStart + m.index;
      if (seenOffsets.has(absOffset)) continue;
      seenOffsets.add(absOffset);
      issues.push({
        rule: 'dml-in-loop',
        severity: 'critical',
        location: `line ${offsetToLine(source, absOffset)}`,
        explanation:
          'DML statement inside a loop body — risks the 150-DML-per-transaction governor limit. ' +
          'Collect records and DML the list once after the loop.',
        confidence: 'heuristic',
      });
    }
  }
  return issues;
};

// ---------- recognizer 3: hardcoded-id ------------------------------------

/**
 * Salesforce key prefixes for the common object types — used to distinguish a
 * real ID literal from any 15-character alphanumeric.
 *
 * EXPORTED because a second consumer needs the same answer.
 * `sfi.find_hardcoded_values_anywhere` scans the formula / validation-rule /
 * workflow-rule / restriction-rule / custom-label corpora for the same
 * "hardcoded record id" finding this recognizer makes over Apex, and it had
 * grown its own private copy of the rule that disagreed with this one on both
 * axes: it required a leading `0` (so it could never see Case `500`, Campaign
 * `701`, Contract `800`, the legacy Order/OrderItem prefixes, or ANY of the six
 * custom-object prefixes `a00`-`a05` — 12 of the 35 below), and it applied no
 * prefix filter at all (so `0zzzzzzzzzzzzzz` came back as an id). One set, one
 * predicate, so the two corpora cannot drift again.
 */
export const KNOWN_KEY_PREFIXES: ReadonlySet<string> = new Set<string>([
  '001', // Account
  '003', // Contact
  '005', // User
  '006', // Opportunity
  '008', // Activity
  '00D', // Organization
  '00E', // UserRole
  '00G', // Group
  '00I', // Order
  '00N', // CustomField
  '00P', // Attachment
  '00Q', // Lead
  '00T', // Task
  '00U', // Event
  '00e', // Profile
  '00h', // Layout
  '012', // RecordType
  '015', // Document
  '016', // Folder
  '01p', // ApexClass
  '01q', // ApexTrigger
  '0DM', // CollaborationGroup
  '0F9', // Network
  '0H4', // Site
  '300', // OrderItem
  '500', // Case
  '701', // Campaign
  '800', // Contract
  '801', // Order (legacy)
  '802', // OrderItem (legacy)
  'a00', // Custom-object reserved range start
  'a01',
  'a02',
  'a03',
  'a04',
  'a05',
]);

const STRING_LITERAL_PATTERN = /'((?:\\[\s\S]|[^'\\])*)'/g;
const ID_15_OR_18_PATTERN = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/**
 * True when `value` is shaped like a Salesforce record id (15 or 18
 * alphanumeric characters) AND carries a key prefix this codebase recognizes.
 *
 * Both halves matter and neither is sufficient. Shape alone matches session
 * keys, hashes, and any 15-character token; prefix alone is three characters of
 * a longer string. Callers scanning free text should test whole candidate
 * tokens against this, never a leading-character shortcut — the prefix that
 * identifies a CUSTOM object (`a00`-`a05`) does not begin with `0`, so any
 * regex anchored on `0` silently excludes exactly the objects an org built
 * itself.
 */
export const isKnownSalesforceIdLiteral = (value: string): boolean =>
  ID_15_OR_18_PATTERN.test(value) && KNOWN_KEY_PREFIXES.has(value.slice(0, 3));

const detectHardcodedIds = (source: string): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const re = new RegExp(STRING_LITERAL_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const literal = m[1] ?? '';
    if (literal.length !== 15 && literal.length !== 18) continue;
    if (!ID_15_OR_18_PATTERN.test(literal)) continue;
    const prefix = literal.slice(0, 3);
    if (!KNOWN_KEY_PREFIXES.has(prefix)) continue;
    issues.push({
      rule: 'hardcoded-id',
      severity: 'medium',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        `Hardcoded Salesforce ID literal '${literal}' — IDs differ between sandbox/production. ` +
        `Replace with a Custom Setting, Custom Metadata, or Schema.GlobalDescribe lookup.`,
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 4: hardcoded-email ---------------------------------

// Strict email shape: local@domain.tld. Deliberately conservative —
// whole-literal match so
// a string like 'Email: foo@bar.com' isn't flagged piecemeal.
const EMAIL_LITERAL_PATTERN =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Salesforce username pattern — email-shaped with a multi-part TLD or
// a known sandbox/dev/uat suffix. Used by recognizer 5; defined here
// so recognizer 4 can exclude usernames from the email finding.
const USERNAME_LITERAL_PATTERN =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(?:com|net|org|io)\.(?:[a-zA-Z]{2,})$|^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\.(?:sandbox|dev|uat|fullcopy|qa)$/;

const detectHardcodedEmails = (source: string): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const re = new RegExp(STRING_LITERAL_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const literal = m[1] ?? '';
    if (!EMAIL_LITERAL_PATTERN.test(literal)) continue;
    if (USERNAME_LITERAL_PATTERN.test(literal)) continue;
    issues.push({
      rule: 'hardcoded-email',
      severity: 'low',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        `Hardcoded email address '${literal}' — replace with a Custom Setting / Custom Metadata ` +
        `or environment-specific configuration record.`,
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 5: hardcoded-username ------------------------------

const detectHardcodedUsernames = (source: string): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const re = new RegExp(STRING_LITERAL_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const literal = m[1] ?? '';
    if (!USERNAME_LITERAL_PATTERN.test(literal)) continue;
    issues.push({
      rule: 'hardcoded-username',
      severity: 'medium',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        `Hardcoded Salesforce username '${literal}' — usernames are org-specific. ` +
        `Replace with a Custom Setting, Custom Metadata, or runtime lookup by Role/Profile.`,
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 5b: hardcoded-url ----------------------------------

// An http(s) endpoint URL literal. Captures the scheme + host so the
// platform-domain skip-list can be applied to the host.
const URL_LITERAL_PATTERN = /^https?:\/\/([^/\s'"]+)(?:[/?#][^\s'"]*)?$/i;

// Salesforce platform / first-party domains. A hardcoded URL on one of these
// is "namespace-aware"-skipped: it is a platform endpoint (My Domain, a Site,
// Visualforce, the SOAP/REST API host), not an external integration that
// belongs in a Named Credential. Matched as a suffix of the host. The org's
// OWN integrations to THIRD-party hosts are the actionable finding.
const SALESFORCE_DOMAIN_SUFFIXES = [
  '.salesforce.com',
  '.force.com',
  '.visualforce.com',
  '.lightning.force.com',
  '.documentforce.com',
  '.salesforce-sites.com',
  '.content.force.com',
  '.cloudforce.com',
  '.sfdcstatic.com',
];

const isSalesforcePlatformHost = (host: string): boolean => {
  const h = host.toLowerCase();
  return SALESFORCE_DOMAIN_SUFFIXES.some(
    (suffix) => h === suffix.slice(1) || h.endsWith(suffix),
  );
};

/**
 * Flag a hardcoded external endpoint URL literal — an integration endpoint
 * baked into Apex instead of a Named Credential / Remote Site Setting / Custom
 * Metadata, which breaks the sandbox→prod promotion path and hides the org's
 * external surface from the integration tooling. Namespace/domain-aware: a URL
 * on a Salesforce platform domain (My Domain, Site, Visualforce, the API host)
 * is NOT flagged — only third-party hosts are.
 */
const detectHardcodedUrls = (source: string): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const re = new RegExp(STRING_LITERAL_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const literal = m[1] ?? '';
    const urlMatch = URL_LITERAL_PATTERN.exec(literal);
    if (urlMatch === null) continue;
    const host = urlMatch[1] ?? '';
    if (host.length === 0 || isSalesforcePlatformHost(host)) continue;
    issues.push({
      rule: 'hardcoded-url',
      severity: 'medium',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        `Hardcoded endpoint URL '${literal}' — external endpoints baked into Apex ` +
        `break the sandbox→production promotion path and hide the integration from ` +
        `the org's external surface. Move it to a Named Credential, Remote Site ` +
        `Setting, or Custom Metadata.`,
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 5c: dynamic-apex (honesty signal) ------------------

// Dynamic Apex constructs that build object / field / type references at
// RUNTIME. These are INVISIBLE to the static apex-scanner's dependency edges
// (readsFrom / writesTo / callsApex / references), so impact and usage results
// for a class that uses them may be incomplete. This recognizer surfaces that
// honestly as an `info` finding — it is NOT a defect, it is a "static analysis
// is blind here" flag. Deduped by construct KIND per class to stay quiet.
const DYNAMIC_APEX_PATTERNS: ReadonlyArray<{
  readonly regex: RegExp;
  readonly what: string;
}> = [
  {
    regex: /\bDatabase\s*\.\s*(?:query|getQueryLocator|queryWithBinds|getQueryLocatorWithBinds|countQuery)\s*\(/g,
    what: 'dynamic SOQL (Database.query)',
  },
  {
    regex: /\bSchema\s*\.\s*getGlobalDescribe\s*\(/g,
    what: 'dynamic schema describe (Schema.getGlobalDescribe)',
  },
  {
    regex: /\bType\s*\.\s*forName\s*\(/g,
    what: 'reflective type instantiation (Type.forName)',
  },
  {
    regex: /\bJSON\s*\.\s*deserializeUntyped\s*\(/g,
    what: 'untyped deserialization (JSON.deserializeUntyped)',
  },
];

/**
 * Flag dynamic-Apex constructs as an honesty signal: runtime-built references
 * the static scanner cannot see. One `info` finding per construct kind per
 * class, at the first occurrence's line. Runs on the comment/string-stripped
 * source so a `Database.query` inside a comment or string literal is not
 * flagged.
 */
const detectDynamicApex = (stripped: string): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  for (const { regex, what } of DYNAMIC_APEX_PATTERNS) {
    const re = new RegExp(regex.source, 'g');
    const m = re.exec(stripped);
    if (m === null) continue;
    issues.push({
      rule: 'dynamic-apex',
      severity: 'info',
      location: `line ${offsetToLine(stripped, m.index)}`,
      explanation:
        `Uses ${what} — object/field/type references built at runtime are ` +
        `INVISIBLE to static dependency analysis. Impact, usage, and ` +
        `dead-code results for this class may be incomplete; verify by reading the source.`,
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 6: missing-crud-check ------------------------------

// DML statement form. The variable token is `m[2]`; `m[3]` (when present)
// is a trailing ` as user` / ` as system` user-mode suffix. The optional
// middle identifier covers the two-arg `upsert lst Ext__c;` external-id form
// (otherwise that statement would never match — a silent false negative).
const DML_STATEMENT_PATTERN =
  /\b(insert|update|delete|upsert|merge)\s+([A-Za-z_][A-Za-z_0-9]*)(?:\s+[A-Za-z_][A-Za-z_0-9.]*)?(\s+as\s+(?:user|system))?\s*[;,)]/g;
const DML_DATABASE_CALL_PATTERN =
  /\bDatabase\.(insert|update|delete|upsert|merge)\s*\(\s*([A-Za-z_][A-Za-z_0-9]*)/g;

// ---------------------------------------------------------------------------
// CRUD vs FLS vs record-sharing are three orthogonal planes (CR-04). The
// `missing-crud-check` recognizer is about WRITE AUTHORIZATION for a DML
// statement, so its hint set recognizes ONLY constructs that gate a WRITE:
//
//   - `Schema.sObjectType.X.{isCreateable|isUpdateable|isDeletable}()` —
//     object-level write-CRUD checks. `isAccessible()` is a READ FLS check
//     and is deliberately EXCLUDED — it never authorizes a write.
//   - `Schema.X.SObjectType.getDescribe()` — loose existing describe hint.
//   - `Database.SObjectAccessDecision` / `Security.stripInaccessible(
//     AccessType.CREATABLE|UPDATABLE|UPSERTABLE, …)` — field-FLS WRITE
//     stripping. These enforce field FLS but NOT object CRUD by themselves;
//     accepted as a write gate consistent with the recognizer's heuristic
//     leniency (see comment on the delete carve-out in `detectMissingCrudCheck`).
//     `UPSERTABLE` is the upsert-specific AccessType (Winter '20+); READABLE is
//     excluded — a READ strip never authorizes a write.
//
// Deliberately NOT hints (they were the conflation bug):
//   - `WITH SECURITY_ENFORCED` / `WITH USER_MODE` — SOQL clauses that enforce
//     FLS + object READ on the QUERY only. They NEVER authorize a DML write;
//     a class that queries with them and then writes is UNGATED for the write.
//     (They remain valid for the separate `missing-fls-check` recognizer.)
//   - bare `AccessLevel.USER_MODE` — only gates a write when it is an argument
//     to the SAME `Database.*(…)` DML call; a loose prefix token let an
//     unrelated user-mode call clear a different DML. Bound to the call site
//     in `detectMissingCrudCheck` instead.
//   - `insert x as user` — user-mode DML that DOES enforce CRUD/FLS for the
//     write; detected at the DML SITE (the `m[3]` suffix), not as a prefix.
const CRUD_HINT_PATTERNS = [
  /\bSchema\.sObjectType\.([A-Za-z_][A-Za-z_0-9]*)\.(?:isCreateable|isUpdateable|isDeletable)\s*\(/g,
  /\bSchema\.[A-Za-z_][A-Za-z_0-9]*\.SObjectType\.getDescribe\s*\(/g,
  /\bDatabase\.SObjectAccessDecision\b/g,
  // Write-FLS strip. `AccessType.UPSERTABLE` is a first-class enum value used
  // before an `upsert` (Winter '20+); omitting it made every
  // `stripInaccessible(AccessType.UPSERTABLE, …)` before an upsert a false
  // positive. READABLE is deliberately excluded — it is a READ strip and never
  // authorizes a write.
  /\bSecurity\.stripInaccessible\s*\(\s*AccessType\.(?:CREATABLE|UPDATABLE|UPSERTABLE)\b/g,
];

/**
 * Collect the set of sObject type names whose object-level WRITE-CRUD check
 * (`Schema.sObjectType.<Type>.is{Createable|Updateable|Deletable}()`) appears
 * in `window`. The set is empty when only a non-type-bearing hint
 * (getDescribe / SObjectAccessDecision / stripInaccessible) is present — those
 * still mark "a write gate exists in scope" (see `hasAnyWriteGate`) but cannot
 * be pinned to a specific sObject.
 */
const writeCheckedSObjects = (window: string): Set<string> => {
  const types = new Set<string>();
  const re = new RegExp(CRUD_HINT_PATTERNS[0]!.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    const t = m[1];
    if (t !== undefined && t.length > 0) types.add(t);
  }
  return types;
};

/** Whether ANY write-authorization hint (typed or not) appears in `window`. */
const hasAnyWriteGate = (window: string): boolean =>
  CRUD_HINT_PATTERNS.some((p) => {
    const re = new RegExp(p.source, 'g');
    return re.test(window);
  });

/**
 * Whether a NON-type-bearing write-FLS / describe gate appears in `window` —
 * i.e. any hint EXCEPT the typed `Schema.sObjectType.<Type>.is…()` check
 * (`CRUD_HINT_PATTERNS[0]`). Used on the type-resolved path: a typed check for
 * a DIFFERENT sObject must NOT clear (defense in depth), but a non-typed gate
 * (stripInaccessible / getDescribe / SObjectAccessDecision) still can.
 */
const hasNonTypedWriteGate = (window: string): boolean =>
  CRUD_HINT_PATTERNS.slice(1).some((p) => {
    const re = new RegExp(p.source, 'g');
    return re.test(window);
  });

/**
 * Resolve the DECLARED sObject type of a DML target variable, best-effort.
 * Looks for a `Type var` declaration (`Account acc;`, `List<Account> accs;`,
 * `Account acc = …`) in the scan window, then the enclosing method; falls back
 * to the `new Type(` RHS of the most-recent assignment. Returns the bare
 * element type for collection wrappers (`List<Account>` → `Account`). Returns
 * null when unresolvable — the caller then degrades to a scope-only clear
 * rather than risk a false positive. Heuristic regex (no AST): params declared
 * in a signature outside the window, reassignment, and exotic shapes may not
 * resolve.
 */
const COLLECTION_WRAPPER = /^(?:List|Set|Map)\s*<\s*([A-Za-z_][A-Za-z_0-9]*)/;
const unwrapType = (raw: string): string => {
  const wrapped = COLLECTION_WRAPPER.exec(raw.trim());
  if (wrapped !== null && wrapped[1] !== undefined) return wrapped[1];
  return raw.trim();
};
const resolveVarSObjectType = (
  source: string,
  varName: string,
  methodWindow: string,
  offset: number,
): string | null => {
  // 1. A typed declaration `<Type> varName` (with optional `= …` or `;`/`,`/`)`).
  const declRe = new RegExp(
    `\\b([A-Za-z_][A-Za-z_0-9]*(?:\\s*<[^;{}]*>)?)\\s+${escapeForRegex(
      varName,
    )}\\s*(?:=|;|,|\\))`,
  );
  const decl = declRe.exec(methodWindow);
  if (decl !== null && decl[1] !== undefined) {
    const t = unwrapType(decl[1]);
    // CR-RV9: the decl regex has no keyword guard, so a statement like
    // `return acc;` matches with t=`return`. Reject reserved statement /
    // control-flow keywords as bogus types — fall through (do NOT return) so
    // the `new Type(` RHS fallback still runs, then null → safe loose-path.
    if (t.length > 0 && t !== varName && !APEX_NON_TYPE_KEYWORDS.has(t)) {
      return t;
    }
  }
  // 2. The `new Type(` shape of the most-recent assignment RHS.
  const rhs = findVarAssignment(source, varName, offset);
  if (rhs !== null) {
    const newMatch = /^new\s+([A-Za-z_][A-Za-z_0-9]*(?:\s*<[^>]*>)?)/.exec(rhs.trim());
    if (newMatch !== null && newMatch[1] !== undefined) {
      const t = unwrapType(newMatch[1]);
      if (t.length > 0) return t;
    }
  }
  return null;
};

const detectMissingCrudCheck = (
  source: string,
  stripped: string,
  isTest: boolean,
): readonly QualityIssue[] => {
  if (isTest) return [];
  const issues: QualityIssue[] = [];
  const seen = new Set<number>();
  const collect = (re: RegExp, op: string, isDatabaseCall: boolean): void => {
    const r = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(stripped)) !== null) {
      const opKind = m[1] ?? op;
      const varName = m[2] ?? 'records';
      if (seen.has(m.index)) continue;
      seen.add(m.index);

      // --- User-mode DML gates (CR-04 #2), bound to the DML SITE ----------
      if (isDatabaseCall) {
        // `Database.insert(x, AccessLevel.USER_MODE)` enforces CRUD/FLS for the
        // write. Scan THIS call's argument list (to the matching `)`) — not a
        // loose prefix token, so an unrelated user-mode call elsewhere cannot
        // clear a different DML.
        const openParen = stripped.indexOf('(', m.index);
        if (openParen !== -1) {
          const closeParen = findMatchingParen(stripped, openParen);
          if (closeParen !== -1) {
            const args = stripped.slice(openParen, closeParen + 1);
            if (/\bAccessLevel\.USER_MODE\b/.test(args)) continue;
            // `Database.insert(x, [allOrNone,] AccessLevel.SYSTEM_MODE)` is an
            // EXPLICIT, DELIBERATE opt-out: the developer consciously runs the
            // write in system context, so object/field security is intentionally
            // NOT enforced. That is NOT a `missing-crud-check` omission — a
            // developer who consciously chose SYSTEM_MODE has not "forgotten" a
            // CRUD check, and flagging it `high` produces a false alarm hosts
            // remediate by adding an isUpdateable() guard the SYSTEM_MODE write
            // deliberately bypasses (W7.3). Reclassify it as an intentional
            // system-context bypass surfaced for REVIEW (`info`), with the honest
            // "switch to USER_MODE if the running user's CRUD/FLS should apply"
            // remediation. Bound to THIS call site (like USER_MODE) so an
            // unrelated system-mode call cannot mislabel a different DML.
            if (/\bAccessLevel\.SYSTEM_MODE\b/.test(args)) {
              issues.push({
                rule: 'intentional-system-mode-dml',
                severity: 'info',
                location: `line ${offsetToLine(source, m.index)}`,
                explanation:
                  `DML '${opKind} ${varName}' runs in explicit AccessLevel.SYSTEM_MODE — object- and ` +
                  `field-level security are intentionally NOT enforced for this write. This is a ` +
                  `DELIBERATE system-context bypass, not a missing CRUD check: review that the ` +
                  `trusted context is intended (no fix required if so). If the running user's CRUD/FLS ` +
                  `SHOULD apply, switch to AccessLevel.USER_MODE ` +
                  `(\`Database.${opKind}(x, AccessLevel.USER_MODE)\`).`,
                confidence: 'heuristic',
              });
              continue;
            }
          }
        }
      } else if ((m[3] ?? '').length > 0) {
        // `insert x as user` / `update x as user` — user-mode DML enforces
        // CRUD/FLS for this write. (`as system` runs in system mode and does
        // NOT gate, so only ` as user` clears.)
        if (/\bas\s+user\b/.test(m[3] ?? '')) continue;
      }

      // --- Object-level / field-FLS write-CRUD hints (CR-04 #1) -----------
      // Scope the hint scan to the innermost block enclosing the DML plus its
      // controlling `if (...)` clause — a check in method A no longer clears a
      // DML in method B. Then strengthen by matching the hinted sObject to the
      // DML target's type when both resolve.
      const blockStart = enclosingBlockStart(stripped, m.index);
      let windowStart = blockStart;
      // Extend the window LEFT to include the controlling clause of the block
      // (e.g. `if (Schema...isCreateable()) { insert a; }` — the test is
      // OUTSIDE the `{`). Walk back over whitespace; if a `)` precedes the `{`,
      // include from its matching `(`.
      if (blockStart > 0) {
        let j = blockStart - 1;
        while (j >= 0 && /\s/.test(stripped[j] ?? '')) j -= 1;
        if (j >= 0 && stripped[j] === ')') {
          const ctrlOpen = matchOpenParenBackward(stripped, j);
          if (ctrlOpen >= 0) windowStart = ctrlOpen;
        }
      }
      const blockWindow = stripped.slice(windowStart, m.index);
      const { bodyStart: methodStart, sigStart } = enclosingMethodStart(
        stripped,
        m.index,
      );
      // Gate-scan window: from the method BODY `{` (unchanged — the two gate
      // scans below depend on this exact span).
      const methodWindow = stripped.slice(methodStart, m.index);
      // Resolver window: WIDER, from the SIGNATURE `(` so a DML target that is
      // a method PARAMETER (`save(Account acc){ … insert acc; }`) resolves to
      // its SObject type (CR-P3-2). Signatures carry no CRUD-hint/DML tokens,
      // so widening only the resolver read does not affect the gate scans.
      const resolverWindow = stripped.slice(sigStart, m.index);

      // Resolve the DML target's sObject type for the sObject-match filter.
      const resolvedType = resolveVarSObjectType(
        source,
        varName,
        resolverWindow,
        m.index,
      );

      if (resolvedType !== null) {
        // STRICT path: type resolved. Clear only when a write-CRUD check for
        // THIS sObject appears in scope — the block window OR (for the
        // early-return/throw guard idiom) the enclosing method window. A check
        // for a DIFFERENT sObject does NOT clear (defense in depth).
        const inScopeTypes = writeCheckedSObjects(blockWindow);
        for (const t of writeCheckedSObjects(methodWindow)) inScopeTypes.add(t);
        if (inScopeTypes.has(resolvedType)) continue;
        // A NON-type-bearing write-FLS gate (stripInaccessible / describe /
        // SObjectAccessDecision) in the block also clears — but a TYPED
        // isCreateable/etc. check for a DIFFERENT sObject does NOT (it is the
        // wrong-object case the sObject-match filter exists to catch). Also
        // exclude `delete`: there is no field-FLS delete AccessType, so a
        // field-stripping gate does not authorize the object delete.
        if (opKind.toLowerCase() !== 'delete' && hasNonTypedWriteGate(blockWindow)) {
          continue;
        }
      } else {
        // LOOSE fallback: the variable's sObject type could not be resolved
        // (cross-method param, reassignment, exotic shape). Rather than trade
        // the old whole-file false-clean for a false-positive wave, clear when
        // ANY in-scope write gate exists — block window first, then the method
        // window (catches a method-top early-return guard). This is the
        // deliberate strict/loose tradeoff: weaker guarantee, but no new false
        // positive on legitimately-guarded code we simply can't type-resolve.
        if (hasAnyWriteGate(blockWindow) || hasAnyWriteGate(methodWindow)) {
          continue;
        }
      }

      issues.push({
        rule: 'missing-crud-check',
        severity: 'high',
        location: `line ${offsetToLine(source, m.index)}`,
        explanation:
          `DML '${opKind} ${varName}' executes without a preceding object-level CRUD check. ` +
          `Add Schema.sObjectType.X.is{Createable|Updateable|Deletable}(), run the DML in user mode ` +
          `(\`${opKind} x as user\` / \`Database.${opKind}(x, AccessLevel.USER_MODE)\`), or strip with ` +
          `Security.stripInaccessible. NOTE: a SOQL \`WITH SECURITY_ENFORCED\` / \`USER_MODE\` clause ` +
          `enforces READ FLS on the query and does NOT authorize this write.`,
        confidence: 'heuristic',
      });
    }
  };
  collect(DML_STATEMENT_PATTERN, 'dml', false);
  collect(DML_DATABASE_CALL_PATTERN, 'dml', true);
  return issues;
};

// ---------- recognizer 7: missing-fls-check -------------------------------

// Detect SOQL queries WITHOUT a `WITH SECURITY_ENFORCED` / `USER_MODE`
// clause. The naive heuristic flags every inline `[SELECT ... FROM ...]`
// that doesn't carry the FLS clause; the caller's skill is responsible
// for surfacing the Q80 disclosure (custom helpers are invisible).
//
// A query is NOT an unenforced read, however, when its result is sanitized
// with a READ-path field-FLS strip
// (`Security.stripInaccessible(AccessType.READABLE, <resultVar>)`) — the
// modern Salesforce-recommended read pattern (GA API 55+) that enforces
// field-level security exactly as `WITH SECURITY_ENFORCED` does. Flagging
// such a query as missing-FLS is a false positive
// (CRUD-FLS-IGNORES-ACCESSLEVEL-AND-STRIPINACCESSIBLE), so a query whose
// result variable is passed to that strip in the enclosing method is cleared.
const INLINE_SOQL_PATTERN = /\[\s*SELECT\b([\s\S]*?)\]/gi;

// The variable a query is assigned to, read from the text immediately BEFORE
// the `[SELECT` — `List<Contact> cs = [SELECT …]` / `cs = [SELECT …]` (optional
// leading cast). `null` when the query is not bound to a plain variable (a
// `for (X c : [SELECT …])` header or an inline call argument): those cannot be
// strip-sanitized, so they still flag.
const QUERY_ASSIGN_LHS = /([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(?:\([^()]*\)\s*)?$/;

/**
 * Regex matching a READ-path field-FLS strip of `varName`:
 * `Security.stripInaccessible(AccessType.READABLE, <varName>)`. READABLE is the
 * read AccessType — CREATABLE/UPDATABLE/UPSERTABLE are write strips handled by
 * the `missing-crud-check` recognizer, never this read recognizer.
 */
const readStripFor = (varName: string): RegExp =>
  new RegExp(
    `\\bSecurity\\.stripInaccessible\\s*\\(\\s*AccessType\\.READABLE\\s*,\\s*${escapeForRegex(
      varName,
    )}\\b`,
  );

const detectMissingFlsCheck = (
  source: string,
  stripped: string,
  isTest: boolean,
): readonly QualityIssue[] => {
  if (isTest) return [];
  const issues: QualityIssue[] = [];
  const re = new RegExp(INLINE_SOQL_PATTERN.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const queryBody = m[1] ?? '';
    if (/\bWITH\s+SECURITY_ENFORCED\b/i.test(queryBody)) continue;
    if (/\bWITH\s+USER_MODE\b/i.test(queryBody)) continue;

    // Read-path field-FLS strip: when this query's result variable is passed to
    // `Security.stripInaccessible(AccessType.READABLE, <var>)` in the enclosing
    // method, field security IS enforced on the read — clear the finding. Bound
    // to the resolved result variable (not a loose whole-file token) so a strip
    // of a DIFFERENT query in the same method cannot clear an unguarded read.
    const lhs = QUERY_ASSIGN_LHS.exec(stripped.slice(0, m.index));
    const lhsVar = lhs?.[1];
    if (lhsVar !== undefined) {
      const { bodyStart } = enclosingMethodStart(stripped, m.index);
      const methodEnd =
        stripped[bodyStart] === '{' ? findMatchingBrace(stripped, bodyStart) : -1;
      const methodWindow = stripped.slice(
        bodyStart,
        methodEnd === -1 ? stripped.length : methodEnd + 1,
      );
      if (readStripFor(lhsVar).test(methodWindow)) continue;
    }

    issues.push({
      rule: 'missing-fls-check',
      severity: 'high',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        'SOQL query without WITH SECURITY_ENFORCED / USER_MODE — field-level security not enforced on the result. ' +
        'Add the clause, sanitize the result with Security.stripInaccessible(AccessType.READABLE, …), ' +
        'or check Schema.sObjectType.X.fields.Y.isAccessible() before reading.',
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 8: soql-injection ----------------------------------

// Detect `Database.query(...)` calls whose argument is a variable that
// was built by `+` concatenation involving anything other than
// `String.escapeSingleQuotes(...)`. The recognizer's intra-method
// dataflow is intentionally limited; it walks BACK from the call site
// to find the most recent assignment of the variable in the same
// method body.
// Match `Database.query(` / `getQueryLocator(` / `queryWithBinds(` /
// `countQuery(` call sites. We capture only the call start; the
// detector walks paren-balanced from the matched `(` to find the
// matching `)` so call arguments containing string literals with `)`
// inside (escaped or otherwise) don't break the regex span.
const DATABASE_QUERY_CALL_START_PATTERN =
  /\bDatabase\.(?:query|queryWithBinds|getQueryLocator|countQuery)\s*\(/g;

// Escape a regex literal for use inside `new RegExp(...)`.
const escapeForRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Walk paren-balanced from `openParen` (the offset of the `(`) and
 * return the offset of the matching `)`, or -1 if unbalanced. Used
 * to span call arguments that may contain string literals (which
 * the caller passed in stripped form so the literals don't carry
 * raw parens).
 */
const findMatchingParen = (s: string, openParen: number): number => {
  let depth = 0;
  for (let i = openParen; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/**
 * Find the most recent assignment of `varName` BEFORE `offset` in
 * `source`. Returns the right-hand-side expression text, or null
 * when no assignment is found. Reads the RAW source so string
 * literals on the right-hand side participate in the analysis.
 */
const findVarAssignment = (
  source: string,
  varName: string,
  offset: number,
): string | null => {
  // Match `[Type] varName = ...;` — Type optional, type names are
  // identifier-shaped. Skip generic-parameter shapes for v2.1
  // simplicity; if a variable is assigned via `Map<X,Y> v = ...`
  // the regex still matches because the modifier prefix is loose.
  // `\b` before the name: searching `e` must not match `name = ...`.
  const re = new RegExp(
    `(?:[A-Za-z_][A-Za-z_0-9<>,\\s.]*\\s+)?\\b${escapeForRegex(
      varName,
    )}\\s*=\\s*([^;]+);`,
    'g',
  );
  let m: RegExpExecArray | null;
  let lastRhs: string | null = null;
  while ((m = re.exec(source)) !== null) {
    if (m.index >= offset) break;
    lastRhs = (m[1] ?? '').trim();
  }
  return lastRhs;
};

/**
 * Tokenize `expr` along the top-level `+` operators, treating
 * `String.escapeSingleQuotes(...)` calls as safe (a literal SAFE
 * sentinel) before splitting. Top-level only: a `+` inside `(...)`
 * does not split. Used as the dataflow primitive the SOQL injection
 * recognizer walks over.
 */
const tokenizeConcatExpr = (expr: string): readonly string[] => {
  // Pre-strip safe calls. Use a paren-balanced strip because the
  // arg could contain nested parens.
  let stripped = expr;
  const reSafe = /String\.escapeSingleQuotes\s*\(/g;
  let safeMatch: RegExpExecArray | null;
  while ((safeMatch = reSafe.exec(stripped)) !== null) {
    const openParen = safeMatch.index + safeMatch[0].length - 1;
    const closeParen = findMatchingParen(stripped, openParen);
    if (closeParen === -1) break;
    const before = stripped.slice(0, safeMatch.index);
    const after = stripped.slice(closeParen + 1);
    stripped = `${before}__SAFE__${after}`;
    reSafe.lastIndex = before.length + '__SAFE__'.length;
  }
  // Top-level split by `+`, respecting paren / string-literal nesting.
  const tokens: string[] = [];
  let depth = 0;
  let inStr = false;
  let escape = false;
  let start = 0;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') escape = true;
      else if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === '+' && depth === 0) {
      tokens.push(stripped.slice(start, i).trim());
      start = i + 1;
    }
  }
  tokens.push(stripped.slice(start).trim());
  return tokens;
};

/**
 * Decide whether the token represents a known-safe value:
 *
 * - The `__SAFE__` sentinel emitted by `tokenizeConcatExpr` for an
 *   inlined `String.escapeSingleQuotes(...)` call.
 * - A single-quoted string literal.
 * - A variable whose most-recent assignment (within the same
 *   method-body scope) was a `String.escapeSingleQuotes(...)` call
 *   or another known-safe expression.
 *
 * `source` and `offset` enable the variable-origin lookup; pass
 * `null` to skip the lookup (used when the token is structurally
 * non-identifier-shaped).
 */
const tokenIsSafe = (
  token: string,
  source: string | null,
  offset: number,
): boolean => {
  if (token === '__SAFE__') return true;
  if (/^'(?:\\.|[^'\\])*'$/.test(token)) return true;
  // Numeric literal.
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return true;
  // Plain identifier — look up its origin if a source bag is provided.
  if (source !== null && /^[A-Za-z_][A-Za-z_0-9]*$/.test(token)) {
    const rhs = findVarAssignment(source, token, offset);
    if (rhs === null) return false;
    // Recurse: a variable assigned from another safe expression is
    // itself safe. Bound the recursion to one level for simplicity.
    if (/^String\.escapeSingleQuotes\s*\(/.test(rhs)) return true;
    if (/^'(?:\\.|[^'\\])*'$/.test(rhs)) return true;
    // If the RHS is itself a concatenation, check each token.
    if (rhs.includes('+')) {
      const subTokens = tokenizeConcatExpr(rhs);
      return subTokens.every((t) => tokenIsSafe(t, null, offset));
    }
  }
  return false;
};

/**
 * ARCH-07. Where an unsafe concatenation token's value comes from, worst first:
 *   - `input`   — traces to a parameter of the enclosing method, or to a
 *                 Visualforce page parameter (`ApexPages.currentPage()`). A
 *                 caller-controlled string reaches the query: real injection.
 *   - `unknown` — a class member, a method call, or a local whose origin the
 *                 one-method walk cannot see. Worth a review, not proven taint.
 *   - `config`  — read from custom metadata (`__mdt`) or a hierarchy/list
 *                 custom setting (`getInstance` / `getOrgDefaults` / `getAll`):
 *                 admin-controlled configuration, not user input.
 *   - `safe`    — literals, escaped values, ternaries/`String.join` over
 *                 literal-only operands.
 */
type QueryTaint = 'input' | 'unknown' | 'config' | 'safe';
const TAINT_RANK: Readonly<Record<QueryTaint, number>> = { safe: 0, config: 1, unknown: 2, input: 3 };
const worseTaint = (a: QueryTaint, b: QueryTaint): QueryTaint =>
  TAINT_RANK[a] >= TAINT_RANK[b] ? a : b;

const INJECTION_SAFE_SCALAR_TYPES: ReadonlySet<string> = new Set([
  'id', 'integer', 'long', 'decimal', 'double', 'boolean', 'date', 'datetime', 'time',
]);
const PAGE_PARAM_PATTERN = /\bApexPages\s*\.\s*currentPage\s*\(\s*\)\s*\.\s*getParameters\b/;
const CONFIG_READ_PATTERN =
  /__mdt\b|\.\s*getInstance\s*\(|\.\s*getOrgDefaults\s*\(|\.\s*getValues\s*\(|\.\s*getAll\s*\(/;

/**
 * Parameter name → declared type of the method whose body encloses `offset`
 * (empty for none).
 */
const enclosingMethodParams = (stripped: string, offset: number): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  const { bodyStart, sigStart } = enclosingMethodStart(stripped, offset);
  if (sigStart >= bodyStart) return names;
  const close = stripped.lastIndexOf(')', bodyStart);
  if (close <= sigStart) return names;
  const inner = stripped.slice(sigStart + 1, close);
  let depth = 0;
  let start = 0;
  const pushParam = (raw: string): void => {
    const m = /^(?:final\s+)?([\s\S]*?)\s+([A-Za-z_][A-Za-z_0-9]*)$/.exec(raw.trim());
    if (m !== null && m[2] !== undefined) names.set(m[2], (m[1] ?? '').replace(/\s+/g, ''));
  };
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') depth -= 1;
    else if (ch === ',' && depth === 0) {
      pushParam(inner.slice(start, i));
      start = i + 1;
    }
  }
  pushParam(inner.slice(start));
  return names;
};

/** Split `a ? b : c` at top level; null when `expr` is not a ternary. */
const splitTernary = (expr: string): readonly [string, string] | null => {
  let depth = 0;
  let inStr = false;
  let q = -1;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") inStr = true;
    else if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (depth === 0 && ch === '?' && q < 0) q = i;
    else if (depth === 0 && ch === ':' && q >= 0)
      return [expr.slice(q + 1, i).trim(), expr.slice(i + 1).trim()];
  }
  return null;
};

const stripOuterParens = (expr: string): string => {
  let e = expr.trim();
  while (e.startsWith('(') && findMatchingParen(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  return e;
};

/**
 * Classify one concatenation token. `depth` bounds the local-variable walk
 * (a local assigned from another local, …) so a cycle cannot loop.
 */
const tokenTaint = (
  rawToken: string,
  source: string,
  stripped: string,
  offset: number,
  params: ReadonlyMap<string, string>,
  depth: number,
): QueryTaint => {
  const token = stripOuterParens(rawToken);
  if (token.length === 0 || tokenIsSafe(token, null, offset)) return 'safe';
  if (PAGE_PARAM_PATTERN.test(token)) return 'input';
  const ternary = splitTernary(token);
  if (ternary !== null) {
    return worseTaint(
      tokenTaint(ternary[0], source, stripped, offset, params, depth),
      tokenTaint(ternary[1], source, stripped, offset, params, depth),
    );
  }
  // `new List<String>{ 'a', 'b' }` / `new Set<String>{...}` of literals only.
  const literalCollection = /^new\s+(?:List|Set)\s*<\s*String\s*>\s*\{([\s\S]*)\}$/.exec(token);
  if (literalCollection !== null) {
    const items = (literalCollection[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    return items.every((s) => tokenIsSafe(s, null, offset)) ? 'safe' : 'unknown';
  }
  // `String.join(x, sep)` — the separator is a literal in practice; the
  // joined collection carries the taint.
  const join = /^String\s*\.\s*join\s*\(/.exec(token);
  if (join !== null) {
    const open = token.indexOf('(');
    const close = findMatchingParen(token, open);
    if (close === token.length - 1) {
      const args = tokenizeTopLevelCommas(token.slice(open + 1, close));
      return tokenTaint(args[0] ?? '', source, stripped, offset, params, depth);
    }
  }
  if (CONFIG_READ_PATTERN.test(token)) return 'config';
  const root = /^([A-Za-z_][A-Za-z_0-9]*)/.exec(token)?.[1];
  if (root === undefined) return /\b[A-Za-z_]/.test(token) ? 'unknown' : 'safe';
  const paramType = params.get(root);
  if (paramType !== undefined) {
    // A scalar-typed parameter (`Id`, `Integer`, `Date`, …) cannot carry a quote.
    return token === root && INJECTION_SAFE_SCALAR_TYPES.has(paramType.toLowerCase()) ? 'safe' : 'input';
  }
  // Declared as a custom-metadata record (`for (Cfg__mdt c : ...)`, `Cfg__mdt c = ...`).
  if (new RegExp(`\\b[A-Za-z_][A-Za-z_0-9]*__mdt\\s+${escapeForRegex(root)}\\b`).test(stripped)) {
    return 'config';
  }
  if (depth <= 0) return 'unknown';
  const rhs = findVarAssignment(source, root, offset);
  if (rhs === null) return 'unknown';
  if (/^String\.escapeSingleQuotes\s*\(/.test(rhs)) return 'safe';
  let worst: QueryTaint = 'safe';
  for (const t of tokenizeConcatExpr(rhs)) {
    worst = worseTaint(worst, tokenTaint(t, source, stripped, offset, params, depth - 1));
    if (worst === 'input') break;
  }
  // A collection local assigned from a literal-free builder (`new List<String>()`)
  // is filled elsewhere — the fill is invisible to this walk.
  if (worst === 'safe' && /^new\b/.test(rhs) && !/^new\s+(?:List|Set)\s*<\s*String\s*>\s*\{/.test(rhs)) {
    return 'unknown';
  }
  return worst;
};

/** Top-level comma split (parens / braces / strings respected). */
const tokenizeTopLevelCommas = (expr: string): readonly string[] => {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") inStr = true;
    else if (ch === '(' || ch === '{' || ch === '<') depth += 1;
    else if (ch === ')' || ch === '}' || ch === '>') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(expr.slice(start).trim());
  return out;
};

const SOQL_INJECTION_EXPLANATION: Readonly<Record<Exclude<QueryTaint, 'safe'>, string>> = {
  input:
    'concatenates a method parameter or page parameter into the query — SOQL injection risk. ' +
    'Use binding variables (:var) or String.escapeSingleQuotes() on every input.',
  unknown:
    'concatenates a value whose origin is not traced to a caller input (class member, method call or ' +
    'out-of-method local) — review it; bind (:var) or escape if it can carry user input.',
  config:
    'concatenates values read from custom metadata / custom settings only — admin-controlled ' +
    'configuration, not user input; low injection risk.',
};
const SOQL_INJECTION_SEVERITY: Readonly<Record<Exclude<QueryTaint, 'safe'>, QualityIssue['severity']>> = {
  input: 'critical',
  unknown: 'high',
  config: 'info',
};

/**
 * ARCH-07: taint-aware. `critical` only when a concatenated value traces to a
 * method parameter or Visualforce page parameter; `high` for an untraced value;
 * `info` for configuration-only reads; nothing for literal-only queries.
 */
const detectSoqlInjection = (
  source: string,
  stripped: string,
): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const re = new RegExp(DATABASE_QUERY_CALL_START_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    // The matched `(` is the LAST character of the match.
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingParen(stripped, openParen);
    if (closeParen === -1) continue;
    // Read the arg expression from the RAW source so string literals
    // survive — the offsets are valid because stripCommentsAndStrings
    // preserves byte length. Only the FIRST argument is the query text
    // (`queryWithBinds(q, binds, mode)`).
    const argExpr = tokenizeTopLevelCommas(source.slice(openParen + 1, closeParen))[0] ?? '';
    if (argExpr.length === 0) continue;
    let concat: string | null = null;
    let label = '';
    if (argExpr.includes('+')) {
      concat = argExpr;
    } else if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(argExpr)) {
      const rhs = findVarAssignment(source, argExpr, m.index);
      // `q += ...` appends are folded in: the last plain assignment plus
      // every `q += expr` before the call.
      const appends: string[] = [];
      const appendRe = new RegExp(`\\b${escapeForRegex(argExpr)}\\s*\\+=\\s*([^;]+);`, 'g');
      let a: RegExpExecArray | null;
      while ((a = appendRe.exec(source)) !== null && a.index < m.index) appends.push((a[1] ?? '').trim());
      const parts = [rhs ?? '', ...appends].filter((p) => p.length > 0);
      if (!parts.some((p) => p.includes('+')) && appends.length === 0) continue;
      concat = parts.join(' + ');
      label = ` '${argExpr}'`;
    }
    if (concat === null) continue;
    const params = enclosingMethodParams(stripped, m.index);
    let worst: QueryTaint = 'safe';
    for (const t of tokenizeConcatExpr(concat)) {
      if (t.length === 0) continue;
      worst = worseTaint(worst, tokenTaint(t, source, stripped, m.index, params, 2));
      if (worst === 'input') break;
    }
    if (worst === 'safe') continue;
    issues.push({
      rule: 'soql-injection',
      severity: SOQL_INJECTION_SEVERITY[worst],
      location: `line ${offsetToLine(source, m.index)}`,
      explanation: `Database.query argument${label} ${SOQL_INJECTION_EXPLANATION[worst]}`,
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 9: without-sharing-no-comment ----------------------

// Match a class declaration of the form
// `... without sharing class {ClassName}`. We capture the offset of
// the `without` keyword to check for an immediately-preceding comment.
const WITHOUT_SHARING_CLASS_PATTERN =
  /\b(?:public|private|global|protected)?\s*(?:virtual\s+|abstract\s+)?without\s+sharing\s+class\s+[A-Za-z_][A-Za-z_0-9]*/g;

/**
 * Determine whether the source lines immediately preceding the
 * declaration at `decOffset` contain a substantive comment. The
 * recognizer's "substantive" bar is a single comment of 10+
 * non-whitespace characters within the 2 lines preceding — long enough
 * that a bare `// TODO` does not count as a justification.
 *
 * We read the RAW source for this check because we want to see the
 * actual comment text, not the blanked-out stripped version.
 */
const hasPrecedingComment = (source: string, decOffset: number): boolean => {
  // Walk back to the start of the line containing decOffset, then
  // collect the previous 2 lines.
  let lineStart = decOffset;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart -= 1;
  // Previous line 1.
  const prev1End = lineStart - 1;
  if (prev1End < 0) return false;
  let prev1Start = prev1End;
  while (prev1Start > 0 && source[prev1Start - 1] !== '\n') prev1Start -= 1;
  // Previous line 2.
  const prev2End = prev1Start - 1;
  let prev2Start = Math.max(0, prev2End);
  if (prev2End >= 0) {
    while (prev2Start > 0 && source[prev2Start - 1] !== '\n')
      prev2Start -= 1;
  } else {
    prev2Start = 0;
  }
  const prev1 = source.slice(prev1Start, prev1End);
  const prev2 = prev2End >= 0 ? source.slice(prev2Start, prev2End) : '';
  const text = `${prev2}\n${prev1}`;
  // Look for a `//` or `/*` whose content (after the marker) carries
  // 10+ non-whitespace characters.
  const lineMatch = /\/\/(.*)$/m.exec(text);
  if (lineMatch !== null && (lineMatch[1] ?? '').replace(/\s/g, '').length >= 10) {
    return true;
  }
  const blockMatch = /\/\*([\s\S]*?)\*\//.exec(text);
  if (blockMatch !== null && (blockMatch[1] ?? '').replace(/\s/g, '').length >= 10) {
    return true;
  }
  return false;
};

/**
 * ARCH-07. A justification can also sit in the class doc comment (any length,
 * separated from the declaration only by annotations / blank lines) or as a
 * trailing comment on the declaration line itself.
 */
const hasDocOrTrailingComment = (source: string, decOffset: number): boolean => {
  const substantive = (text: string): boolean =>
    text.replace(/[\s*/]/g, '').length >= 10;
  const lineEnd = source.indexOf('\n', decOffset);
  const declLine = source.slice(decOffset, lineEnd < 0 ? source.length : lineEnd);
  const trailing = /\/\/(.*)$|\/\*([\s\S]*?)\*\//.exec(declLine);
  if (trailing !== null && substantive(trailing[1] ?? trailing[2] ?? '')) return true;
  let lineStart = decOffset;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart -= 1;
  const before = source.slice(0, lineStart).split('\n');
  if (before[before.length - 1] === '') before.pop();
  // Skip blank and annotation lines between the comment and the declaration.
  while (before.length > 0 && /^\s*(?:@[A-Za-z_][\w.]*(?:\([^)]*\))?\s*)*$/.test(before[before.length - 1] ?? '')) {
    before.pop();
  }
  const last = (before[before.length - 1] ?? '').trim();
  if (last.endsWith('*/')) {
    const text = before.join('\n');
    const open = text.lastIndexOf('/*');
    return open >= 0 && substantive(text.slice(open + 2, text.length - 2));
  }
  const lines: string[] = [];
  while (before.length > 0 && /^\s*\/\//.test(before[before.length - 1] ?? '')) {
    lines.push((before.pop() ?? '').replace(/^\s*\/\//, ''));
  }
  return substantive(lines.join(' '));
};

const detectWithoutSharingNoComment = (
  source: string,
): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const re = new RegExp(WITHOUT_SHARING_CLASS_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (hasPrecedingComment(source, m.index)) continue;
    if (hasDocOrTrailingComment(source, m.index)) continue;
    issues.push({
      rule: 'without-sharing-no-comment',
      severity: 'medium',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        'Class declared `without sharing` with no explanatory comment — sharing bypass should be justified. ' +
        'Add a 1-2 line comment above the declaration explaining why, or convert to `with sharing`.',
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 9b: omitted-sharing-on-entry-point ----------------

// The OUTERMOST class declaration (modifiers + optional sharing keyword).
const TOP_LEVEL_CLASS_PATTERN =
  /^\s*((?:(?:public|private|global|protected|virtual|abstract|with\s+sharing|without\s+sharing|inherited\s+sharing)\s+)*)class\s+([A-Za-z_][A-Za-z_0-9]*)/im;
const SERVICE_ENTRY_PATTERN =
  /@(?:RemoteAction|InvocableMethod|RestResource|Http(?:Get|Post|Put|Patch|Delete))\b|\bwebservice\s+static\b/i;
const AURA_ENTRY_PATTERN = /@AuraEnabled\b/i;

/** Rule id shared by every tool that reports a no-keyword entry point. */
export const OMITTED_SHARING_RULE = 'omitted-sharing-on-entry-point';

/**
 * Which caller reaches a no-keyword entry point. `service` = REST / SOAP /
 * remote action / invocable (and any mix that includes one); `lightning` =
 * `@AuraEnabled` only.
 */
export type OmittedSharingSurface = 'service' | 'lightning';

/**
 * THE severity model for "an entry-point class declares no sharing keyword" —
 * the one answer `code_quality_audit` (this recognizer) and `apex_structure`
 * (its parsed check) both emit, so the two can no longer disagree.
 *
 * A REST / SOAP / remote / invocable entry point has no caller sharing context
 * to inherit, so it runs WITHOUT sharing — the same exposure as an explicit
 * `without sharing` entry point (`high`). A Lightning-only controller runs
 * with sharing when invoked from a Lightning component (the platform default
 * for implicit-sharing `@AuraEnabled` controllers); other Apex callers pass
 * their own context — so the keyword is a clarity fix there (`low`).
 */
export const omittedSharingVerdict = (
  surface: OmittedSharingSurface,
  className: string,
  callers: string,
): { readonly severity: 'high' | 'low'; readonly explanation: string } =>
  surface === 'service'
    ? {
        severity: 'high',
        explanation: `Entry-point class '${className}' (${callers}) declares no sharing keyword. The platform is the caller and has no sharing context to pass on, so record sharing is NOT enforced. Declare \`with sharing\` (or \`inherited sharing\`) explicitly.`,
      }
    : {
        severity: 'low',
        explanation: `Lightning controller '${className}' declares no sharing keyword. Called from a Lightning component it runs with sharing (the platform default for implicit-sharing @AuraEnabled controllers); other Apex callers pass their own context. Declare the sharing mode explicitly.`,
      };

/**
 * ARCH-07. A top-level class that is an entry point (Visualforce remote action,
 * invocable action, REST / SOAP service, Lightning controller) and declares NO
 * sharing keyword. Severity and wording come from {@link omittedSharingVerdict}.
 */
const detectOmittedSharingOnEntryPoint = (
  stripped: string,
  isTest: boolean,
): readonly QualityIssue[] => {
  if (isTest || /@isTest\b/i.test(stripped)) return [];
  const decl = TOP_LEVEL_CLASS_PATTERN.exec(stripped);
  if (decl === null) return [];
  // Only the outermost declaration: nothing but annotations / whitespace before it.
  const head = stripped.slice(0, decl.index);
  if (head.includes('{')) return [];
  if (/\bsharing\b/i.test(decl[1] ?? '')) return [];
  const service = SERVICE_ENTRY_PATTERN.test(stripped);
  const aura = AURA_ENTRY_PATTERN.test(stripped);
  if (!service && !aura) return [];
  const verdict = omittedSharingVerdict(
    service ? 'service' : 'lightning',
    decl[2] ?? '',
    service ? 'REST / SOAP / remote action / invocable' : '@AuraEnabled',
  );
  return [
    {
      rule: OMITTED_SHARING_RULE,
      severity: verdict.severity,
      location: `line ${offsetToLine(stripped, decl.index + (decl[0].length - decl[0].trimStart().length))}`,
      explanation: verdict.explanation,
      confidence: 'heuristic',
    },
  ];
};

// ---------- recognizer 10: trigger-no-recursion-guard ---------------------

// Trigger source starts with the keyword `trigger`. The recognizer
// pattern-matches the body for a recognized guard shape.
const TRIGGER_HEADER_PATTERN = /\btrigger\s+([A-Za-z_][A-Za-z_0-9]*)\s+on\b/;

/** The recursion-guard shapes {@link detectRecursionGuard} recognizes. */
export type RecursionGuardKind =
  | 'static-flag'
  | 'static-id-set'
  | 'trigger-handler-framework'
  | 'trigger-is-executing'
  | 'external-static'
  | 'toggled-static-boolean';

const RECURSION_GUARD_PATTERNS: ReadonlyArray<readonly [RecursionGuardKind, RegExp]> = [
  // Static Boolean flag pattern.
  ['static-flag', /\bstatic\s+Boolean\s+(?:isFirstRun|hasRun|alreadyRan|running|executed|isFirstExecution|isExecuting)\b/i],
  // Static Set<Id> pattern.
  ['static-id-set', /\bstatic\s+Set\s*<\s*Id\s*>\s+(?:processedIds|firedIds|seenIds|handledIds)\b/i],
  // Common TriggerHandler framework class references.
  ['trigger-handler-framework', /\bTriggerHandler\.|new\s+TriggerHandler\s*\(/],
  // `Trigger.isExecuting` static check.
  ['trigger-is-executing', /\bTrigger\.isExecuting\b/],
];

/**
 * DEV-08. A guard held as a static on ANOTHER class: the trigger both tests
 * `Helper.flag` in an `if (...)` condition and reassigns `Helper.flag = true|false`,
 * or consults a static collection (`Helper.processedIds.contains(...)` / `.add(...)`).
 */
const hasExternalStaticGuard = (stripped: string): boolean => {
  const assignRe = /\b([A-Z][A-Za-z_0-9]*)\.([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(?:true|false)\b/g;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(stripped)) !== null) {
    const member = `${m[1] ?? ''}\\.${m[2] ?? ''}`;
    if (new RegExp(`\\bif\\s*\\([^{;]*\\b${member}\\b`).test(stripped)) return true;
  }
  return /\b(?!Trigger\.)[A-Z][A-Za-z_0-9]*\.[A-Za-z_][A-Za-z_0-9]*\.(?:contains|containsAll|add|addAll)\s*\(/.test(stripped);
};

/**
 * DEV-08. A trigger whose whole body is ONE delegating call —
 * `Dispatcher.run(new XHandler());`, `ns.RollupService.triggerHandler(...)` —
 * keeps any recursion guard in the class it delegates to, which this per-file
 * recognizer cannot see. Absence of a guard in the trigger file is then not
 * evidence of a missing guard, so no finding is raised.
 */
const isPureDelegationTrigger = (stripped: string): boolean => {
  const open = stripped.indexOf('{');
  const close = stripped.lastIndexOf('}');
  if (open < 0 || close <= open) return false;
  const body = stripped.slice(open + 1, close).trim();
  return /^(?:new\s+)?[A-Za-z_][\w.]*\s*\([^;{}]*\)\s*;$/.test(body);
};

/**
 * A class-level `static Boolean x` that the same source both tests in an
 * `if (...)` and reassigns to `true`/`false` — the generic in-class guard shape
 * whose variable name is not one of the conventional ones above. (A trigger
 * cannot declare statics, so this only ever matches a handler/helper class.)
 */
const hasToggledStaticBoolean = (stripped: string): boolean => {
  const declRe = /\bstatic\s+(?:final\s+)?Boolean\s+([A-Za-z_][A-Za-z_0-9]*)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(stripped)) !== null) {
    const name = m[1] ?? '';
    if (name === '') continue;
    // Apex identifiers are case-insensitive: `DoneOnce` and `doneOnce` are one variable.
    const tested = new RegExp(`\\bif\\s*\\([^{;]*\\b${name}\\b`, 'i').test(stripped);
    const assigned = new RegExp(`\\b${name}\\s*=\\s*(?:true|false)\\b`, 'i').test(stripped);
    if (tested && assigned) return true;
  }
  return false;
};

/**
 * The recursion guard VISIBLE in one Apex source file, or `null` when none of
 * the recognized shapes is present. Shared by the `trigger-no-recursion-guard`
 * recognizer and the save-order re-entry report, so the two can never disagree
 * about what counts as a guard. `null` means "no recognized shape in THIS
 * file" — never "the save is unguarded": a guard can live in another class.
 */
export const detectRecursionGuard = (source: string): RecursionGuardKind | null => {
  for (const [kind, p] of RECURSION_GUARD_PATTERNS) {
    if (p.test(source)) return kind;
  }
  const stripped = stripCommentsAndStrings(source);
  if (hasExternalStaticGuard(stripped)) return 'external-static';
  if (hasToggledStaticBoolean(stripped)) return 'toggled-static-boolean';
  return null;
};

const detectTriggerNoRecursionGuard = (
  source: string,
  stripped: string,
): readonly QualityIssue[] => {
  const triggerMatch = TRIGGER_HEADER_PATTERN.exec(stripped);
  if (triggerMatch === null) return [];
  if (detectRecursionGuard(source) !== null || isPureDelegationTrigger(stripped)) return [];
  return [
    {
      rule: 'trigger-no-recursion-guard',
      severity: 'medium',
      location: 'trigger',
      explanation:
        `Trigger '${triggerMatch[1] ?? ''}' has no recognizable recursion guard — ` +
        'risks the 16-trigger-execution-per-transaction governor limit on recursive saves. ' +
        'Add a static Boolean / Set<Id> guard or use a TriggerHandler framework.',
      confidence: 'heuristic',
    },
  ];
};

// ---------- recognizer 11: old-api-version --------------------------------

const detectOldApiVersion = (
  metadata: CodeQualityMetadata,
): readonly QualityIssue[] => {
  if (!Number.isFinite(metadata.apiVersion)) return [];
  if (metadata.apiVersion >= 50) return [];
  return [
    {
      rule: 'old-api-version',
      severity: 'low',
      location: 'metadata',
      explanation:
        `apiVersion ${metadata.apiVersion} is below the v2.1 threshold of 50.0 — ` +
        'upgrade to a current API version. Older versions are an upgrade-readiness signal, not a runtime bug.',
      confidence: 'heuristic',
    },
  ];
};

// ---------- recognizer 12: database-upsert-no-options ---------------------

// Walk `Database.upsert(` call sites; flag those whose argument list
// has exactly one argument (no allOrNone option, no UpsertOptions).
const DATABASE_UPSERT_PATTERN = /\bDatabase\.upsert\s*\(/g;

const detectDatabaseUpsertNoOptions = (
  source: string,
  stripped: string,
): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const re = new RegExp(DATABASE_UPSERT_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    // Find the matching close paren and count top-level commas.
    let i = m.index + m[0].length;
    let depth = 1;
    let commas = 0;
    for (; i < stripped.length; i += 1) {
      const ch = stripped[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      } else if (ch === ',' && depth === 1) {
        commas += 1;
      }
    }
    if (depth !== 0) continue;
    if (commas > 0) continue;
    issues.push({
      rule: 'database-upsert-no-options',
      severity: 'medium',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        'Database.upsert called with a single argument — no allOrNone flag and no UpsertOptions. ' +
        'Add the `false` argument and inspect Database.SaveResult to handle partial failures explicitly.',
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 13: fake-assertion ---------------------------------

// Tautology assertion shapes. Only fire on @isTest classes / methods.
//
// IMPORTANT: only `System.assert(true, ...)` is a tautology — it always
// passes regardless of behavior. `System.assert(false, ...)` is the OPPOSITE:
// it is a fail-guard placed on a code path that should be UNREACHABLE (e.g.
// the line after a call expected to throw, inside a try before its catch).
// Reaching it FAILS the test, so it verifies real behavior and must NOT be
// flagged. Matching `false` here over-counted every deny/exception test as
// fake, inverting the audit (the strongest tests scored worst).
const FAKE_ASSERT_BOOL_PATTERN =
  /\bSystem\.assert\s*\(\s*true\s*[,)]/g;
const FAKE_ASSERTEQUALS_SELF_PATTERN =
  /\bSystem\.assertEquals\s*\(\s*([A-Za-z_][A-Za-z_0-9.]*)\s*,\s*([A-Za-z_][A-Za-z_0-9.]*)\s*[,)]/g;
const FAKE_ASSERTEQUALS_LITERAL_PATTERN =
  /\bSystem\.assertEquals\s*\(\s*('(?:\\.|[^'\\])*'|\d+)\s*,\s*('(?:\\.|[^'\\])*'|\d+)\s*[,)]/g;

/**
 * DEV-06. True when `offset` sits inside a `catch (...) { ... }` block of
 * `stripped`. `System.assert(true, 'expected exception')` there is the
 * canonical expected-exception acknowledgment (the `try` holds the call and an
 * `assert(false)` fail-guard), not a tautology: reaching the catch IS the
 * behaviour under test.
 */
const isInsideCatchBlock = (stripped: string, offset: number): boolean => {
  const catchRe = /\bcatch\s*\([^)]*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = catchRe.exec(stripped)) !== null) {
    const open = m.index + m[0].length - 1;
    if (open > offset) break;
    let depth = 0;
    for (let i = open; i < stripped.length; i += 1) {
      const ch = stripped[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          if (offset > open && offset < i) return true;
          break;
        }
      }
    }
  }
  return false;
};

const detectFakeAssertion = (
  source: string,
  stripped: string,
  isTest: boolean,
): readonly QualityIssue[] => {
  if (!isTest) return [];
  const issues: QualityIssue[] = [];
  const flag = (offset: number, why: string): void => {
    issues.push({
      rule: 'fake-assertion',
      severity: 'high',
      location: `line ${offsetToLine(source, offset)}`,
      explanation:
        `Fake assertion (${why}) — tests should verify real system behavior. ` +
        'Assert on field values, record counts, or thrown exceptions.',
      confidence: 'heuristic',
    });
  };
  let m: RegExpExecArray | null;
  const re1 = new RegExp(FAKE_ASSERT_BOOL_PATTERN.source, 'g');
  while ((m = re1.exec(stripped)) !== null) {
    if (isInsideCatchBlock(stripped, m.index)) continue; // expected-exception idiom
    flag(m.index, 'tautology boolean');
  }
  const re2 = new RegExp(FAKE_ASSERTEQUALS_SELF_PATTERN.source, 'g');
  while ((m = re2.exec(stripped)) !== null) {
    if ((m[1] ?? '') === (m[2] ?? '')) flag(m.index, 'self-equals');
  }
  // For literal-literal we read the raw source so the string literals
  // survive the strip pass.
  const re3 = new RegExp(FAKE_ASSERTEQUALS_LITERAL_PATTERN.source, 'g');
  while ((m = re3.exec(source)) !== null) {
    if ((m[1] ?? '') === (m[2] ?? '')) flag(m.index, 'literal-equals');
  }
  return issues;
};

// ---------- recognizer 14: hardcoded-sandbox-test-data --------------------

// Sandbox-specific literal shapes. Covers:
//   - username `.sandbox` / `.dev` / `.uat` / `.fullcopy` suffix.
//   - org-prefix `myorg__sandbox` shapes.
//   - Lightning URL containing a `/sandbox` segment.
//   - any URL containing `sandbox.salesforce.com` or `--sandbox`.
//   - sandbox-only ID ranges `001000000` / `00500000` per the catalog.
const SANDBOX_LITERAL_PATTERN =
  /\.sandbox\b|\.dev\b|\.uat\b|\.fullcopy\b|__sandbox\b|--sandbox|sandbox\.salesforce\.com|sandbox\.lightning\.force\.com|\.lightning\.force\.com\/[^]*sandbox|\.salesforce\.com\/[^]*sandbox/i;

const detectHardcodedSandboxData = (
  source: string,
  isTest: boolean,
): readonly QualityIssue[] => {
  if (!isTest) return [];
  const issues: QualityIssue[] = [];
  const re = new RegExp(STRING_LITERAL_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const literal = m[1] ?? '';
    if (!SANDBOX_LITERAL_PATTERN.test(literal)) continue;
    issues.push({
      rule: 'hardcoded-sandbox-test-data',
      severity: 'medium',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        `Hardcoded sandbox-specific literal '${literal}' in a test class — tests should run against any org. ` +
        `Move sandbox-specific values into a Custom Setting / Custom Metadata or @TestSetup.`,
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- recognizer 15: swallowed-exception ----------------------------

// Match a `catch (...)` block. The recognizer then walks brace-balanced
// to find the body span and inspects its contents.
const CATCH_HEADER_PATTERN = /\bcatch\s*\(\s*([A-Za-z_][A-Za-z_0-9.]*\s+[A-Za-z_][A-Za-z_0-9]*)\s*\)\s*\{/g;

// Strip a `Pattern(...)` call from `text` using paren-balanced spans
// so nested calls (`System.debug(e.getMessage())`) are removed in one
// pass. Returns the text with EVERY occurrence stripped.
const stripBalancedCalls = (text: string, startRe: RegExp): string => {
  let out = text;
  let m: RegExpExecArray | null;
  const re = new RegExp(startRe.source, 'g');
  // Iterate until no more matches; each iteration removes one call.
  // Bound the loop to avoid runaway in pathological inputs.
  for (let guard = 0; guard < 200; guard += 1) {
    re.lastIndex = 0;
    m = re.exec(out);
    if (m === null) return out;
    // The captured group ends at `(`; walk to the matching `)`.
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingParen(out, openParen);
    if (closeParen === -1) return out;
    // Also consume a trailing `;` if present.
    let end = closeParen + 1;
    while (end < out.length && /\s/.test(out[end] ?? '')) end += 1;
    if (out[end] === ';') end += 1;
    out = out.slice(0, m.index) + out.slice(end);
  }
  return out;
};

const SYSTEM_DEBUG_CALL_START = /\bSystem\.debug\s*\(/;
const LOGGER_CALL_START = /\bLogger\.(?:error|warn|info|debug)\s*\(/;

const isLogOnlyOrEmpty = (body: string): boolean => {
  const trimmed = body.trim();
  if (trimmed.length === 0) return true;
  let withoutLogging = stripBalancedCalls(trimmed, SYSTEM_DEBUG_CALL_START);
  withoutLogging = stripBalancedCalls(withoutLogging, LOGGER_CALL_START);
  // Drop any leftover whitespace / line-comment markers.
  return withoutLogging.trim().length === 0;
};

const detectSwallowedException = (
  source: string,
  stripped: string,
): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const re = new RegExp(CATCH_HEADER_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    // The matched `{` is the LAST character of the match.
    const open = m.index + m[0].length - 1;
    const close = findMatchingBrace(stripped, open);
    if (close === -1) continue;
    // Read body from the RAW source so log calls show their text.
    const body = source.slice(open + 1, close);
    if (!isLogOnlyOrEmpty(body)) continue;
    issues.push({
      rule: 'swallowed-exception',
      severity: 'high',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        'Catch block is empty or only logs — exceptions are silently swallowed. ' +
        'Rethrow as a user-facing exception, log to a persistent custom object, or take a meaningful recovery action.',
      confidence: 'heuristic',
    });
  }
  return issues;
};

// ---------- module entry point --------------------------------------------

/**
 * Run every quality recognizer over `source` and return the flat
 * `QualityIssue[]` list ordered by source-position (line then rule
 * id). The ordering is deterministic so callers can compare output
 * by deep equality without sort hassles.
 *
 * The recognizers themselves are stateless: each call is independent
 * and the function is referentially transparent — same input always
 * produces the same output.
 *
 * @example
 *   const issues = detectCodeQualityIssues(clsSource, { apiVersion: 50, isTest: false });
 *   const critical = issues.filter((i) => i.severity === 'critical');
 */
export const detectCodeQualityIssues = (
  source: string,
  metadata: CodeQualityMetadata,
): readonly QualityIssue[] => {
  if (source.trim().length === 0) return [];
  const stripped = stripCommentsAndStrings(source);
  const loops = findLoopBodies(stripped);

  const issues: QualityIssue[] = [
    ...detectSoqlInLoop(source, stripped, loops),
    ...detectDmlInLoop(source, stripped, loops),
    ...detectHardcodedIds(source),
    ...detectHardcodedEmails(source),
    ...detectHardcodedUsernames(source),
    ...detectHardcodedUrls(source),
    ...detectDynamicApex(stripped),
    ...detectMissingCrudCheck(source, stripped, metadata.isTest),
    ...detectMissingFlsCheck(source, stripped, metadata.isTest),
    ...detectSoqlInjection(source, stripped),
    ...detectWithoutSharingNoComment(source),
    ...detectOmittedSharingOnEntryPoint(stripped, metadata.isTest),
    ...detectTriggerNoRecursionGuard(source, stripped),
    ...detectOldApiVersion(metadata),
    ...detectDatabaseUpsertNoOptions(source, stripped),
    ...detectFakeAssertion(source, stripped, metadata.isTest),
    ...detectHardcodedSandboxData(source, metadata.isTest),
    ...detectSwallowedException(source, stripped),
  ];

  // Sort by line number (extracted from the `location` field), then
  // rule id, so the output is a stable source-order list every caller can
  // compare by deep equality without re-sorting.
  return issues.slice().sort((a, b) => {
    const la = parseLineFromLocation(a.location);
    const lb = parseLineFromLocation(b.location);
    if (la !== lb) return la - lb;
    if (a.rule < b.rule) return -1;
    if (a.rule > b.rule) return 1;
    return 0;
  });
};

const LINE_LOCATION_PATTERN = /line\s+(\d+)/;

/** Extract the line number embedded in a `location` string, or 0 when none. */
const parseLineFromLocation = (location: string): number => {
  const m = LINE_LOCATION_PATTERN.exec(location);
  if (m === null) return 0;
  return Number(m[1] ?? 0);
};
