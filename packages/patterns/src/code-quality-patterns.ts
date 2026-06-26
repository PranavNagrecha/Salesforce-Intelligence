/**
 * Code-quality pattern recognizers for Apex source.
 *
 * The v2.1 sub-milestone shipping the 15-rule Apex quality catalog
 * documented in `docs/vendor/salesforce-metadata/ApexQualitySemantics.md`.
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
 *   directly. This is the only deviation from v0.3's strip-first
 *   posture, documented in §"Tokenization input" of
 *   `ApexQualitySemantics.md`.
 *
 * Known limitations (mirroring ApexQualitySemantics.md §"Known
 * limitations"):
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
 *   (`Security.stripInaccessible(AccessType.CREATABLE|UPDATABLE, …)`)
 *   gates a write. `isAccessible()` is a READ check and never clears a
 *   write.
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
 *   Full reasoning lives in `ApexQualitySemantics.md`.
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
 * Offset of the `{` that opens the ENCLOSING METHOD (or class) body that
 * contains `offset`, found by walking out one enclosing block at a time
 * until the block's controlling clause looks like a method/ctor signature
 * (`) {`) rather than a control-flow header (`if`/`for`/`while`/`try`/…).
 * Falls back to the outermost block (or 0) when no method-shaped block is
 * found. Offsets align with `source`.
 *
 * Used as the WIDER fallback window for the CRUD-check recognizer: an
 * early-return / throw guard at the top of a method (`if (!X.isUpdateable())
 * throw ...; ... update x;`) lives in method scope, not the DML's innermost
 * block, so a same-method write-CRUD hint on the RESOLVED sObject is allowed
 * to clear the finding (the dominant guard idiom).
 */
const enclosingMethodStart = (stripped: string, offset: number): number => {
  let cursor = offset;
  let outermost = 0;
  for (let guard = 0; guard < 64; guard += 1) {
    const blockOpen = enclosingBlockStart(stripped, cursor);
    if (blockOpen === 0) return outermost;
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
        const controlFlow = new Set([
          'if',
          'for',
          'while',
          'switch',
          'catch',
          'else',
        ]);
        if (!controlFlow.has(word)) return blockOpen; // method / ctor body
      }
    }
    // Otherwise climb to the parent block.
    cursor = blockOpen;
  }
  return outermost;
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

// Salesforce key prefixes for the common object types — used to
// distinguish a real ID literal from any 15-character alphanumeric.
const KNOWN_KEY_PREFIXES = new Set<string>([
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

// Strict email shape: local@domain.tld. Matches the conservative
// pattern from ApexQualitySemantics.md §4. Whole-literal match so
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
//     AccessType.CREATABLE|UPDATABLE, …)` — field-FLS WRITE stripping. These
//     enforce field FLS but NOT object CRUD by themselves; accepted as a write
//     gate consistent with the recognizer's heuristic leniency (see comment on
//     the delete carve-out in `detectMissingCrudCheck`).
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
  /\bSecurity\.stripInaccessible\s*\(\s*AccessType\.(?:CREATABLE|UPDATABLE)\b/g,
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
    if (t.length > 0 && t !== varName) return t;
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
      const methodStart = enclosingMethodStart(stripped, m.index);
      const methodWindow = stripped.slice(methodStart, m.index);

      // Resolve the DML target's sObject type for the sObject-match filter.
      const resolvedType = resolveVarSObjectType(
        source,
        varName,
        methodWindow,
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
const INLINE_SOQL_PATTERN = /\[\s*SELECT\b([\s\S]*?)\]/gi;

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
    issues.push({
      rule: 'missing-fls-check',
      severity: 'high',
      location: `line ${offsetToLine(source, m.index)}`,
      explanation:
        'SOQL query without WITH SECURITY_ENFORCED / USER_MODE — field-level security not enforced on the result. ' +
        'Add the clause or check Schema.sObjectType.X.fields.Y.isAccessible() before reading.',
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
  const re = new RegExp(
    `(?:[A-Za-z_][A-Za-z_0-9<>,\\s.]*\\s+)?${escapeForRegex(
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
    // preserves byte length.
    const argExpr = source.slice(openParen + 1, closeParen).trim();
    if (argExpr.length === 0) continue;

    // Case 1: arg contains a concatenation. Tokenize and check each token.
    if (argExpr.includes('+')) {
      const tokens = tokenizeConcatExpr(argExpr);
      const unsafe = tokens.some(
        (t) => t.length > 0 && !tokenIsSafe(t, source, m!.index),
      );
      if (unsafe) {
        issues.push({
          rule: 'soql-injection',
          severity: 'critical',
          location: `line ${offsetToLine(source, m.index)}`,
          explanation:
            'Database.query argument is built by string concatenation with an unescaped variable — ' +
            'SOQL injection risk. Use binding variables (:var) or String.escapeSingleQuotes() on every input.',
          confidence: 'heuristic',
        });
      }
      continue;
    }

    // Case 2: arg is a bare identifier. Walk back to find its assignment;
    // if the assignment is itself an unsafe concatenation, flag.
    if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(argExpr)) {
      const rhs = findVarAssignment(source, argExpr, m.index);
      if (rhs === null) continue;
      if (rhs.includes('+')) {
        const tokens = tokenizeConcatExpr(rhs);
        const unsafe = tokens.some(
          (t) => t.length > 0 && !tokenIsSafe(t, source, m!.index),
        );
        if (unsafe) {
          issues.push({
            rule: 'soql-injection',
            severity: 'critical',
            location: `line ${offsetToLine(source, m.index)}`,
            explanation:
              `Database.query argument '${argExpr}' was built via unsafe concatenation — ` +
              'SOQL injection risk. Use binding variables (:var) or String.escapeSingleQuotes().',
            confidence: 'heuristic',
          });
        }
      }
    }
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
 * non-whitespace characters within the 2 lines preceding (per
 * ApexQualitySemantics.md §9).
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

const detectWithoutSharingNoComment = (
  source: string,
): readonly QualityIssue[] => {
  const issues: QualityIssue[] = [];
  const re = new RegExp(WITHOUT_SHARING_CLASS_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (hasPrecedingComment(source, m.index)) continue;
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

// ---------- recognizer 10: trigger-no-recursion-guard ---------------------

// Trigger source starts with the keyword `trigger`. The recognizer
// pattern-matches the body for a recognized guard shape.
const TRIGGER_HEADER_PATTERN = /\btrigger\s+([A-Za-z_][A-Za-z_0-9]*)\s+on\b/;

const RECURSION_GUARD_PATTERNS = [
  // Static Boolean flag pattern.
  /\bstatic\s+Boolean\s+(?:isFirstRun|hasRun|alreadyRan|running|executed|isFirstExecution|isExecuting)\b/i,
  // Static Set<Id> pattern.
  /\bstatic\s+Set\s*<\s*Id\s*>\s+(?:processedIds|firedIds|seenIds|handledIds)\b/i,
  // Common TriggerHandler framework class references.
  /\bTriggerHandler\.|new\s+TriggerHandler\s*\(/,
  // `Trigger.isExecuting` static check.
  /\bTrigger\.isExecuting\b/,
];

const detectTriggerNoRecursionGuard = (
  source: string,
  stripped: string,
): readonly QualityIssue[] => {
  const triggerMatch = TRIGGER_HEADER_PATTERN.exec(stripped);
  if (triggerMatch === null) return [];
  for (const p of RECURSION_GUARD_PATTERNS) {
    if (p.test(source)) return [];
  }
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
const FAKE_ASSERT_BOOL_PATTERN =
  /\bSystem\.assert\s*\(\s*(?:true|false)\s*[,)]/g;
const FAKE_ASSERTEQUALS_SELF_PATTERN =
  /\bSystem\.assertEquals\s*\(\s*([A-Za-z_][A-Za-z_0-9.]*)\s*,\s*([A-Za-z_][A-Za-z_0-9.]*)\s*[,)]/g;
const FAKE_ASSERTEQUALS_LITERAL_PATTERN =
  /\bSystem\.assertEquals\s*\(\s*('(?:\\.|[^'\\])*'|\d+)\s*,\s*('(?:\\.|[^'\\])*'|\d+)\s*[,)]/g;

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
  while ((m = re1.exec(stripped)) !== null) flag(m.index, 'tautology boolean');
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

// Sandbox-specific literal shapes per ApexQualitySemantics.md §14.
// Covers:
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
    ...detectTriggerNoRecursionGuard(source, stripped),
    ...detectOldApiVersion(metadata),
    ...detectDatabaseUpsertNoOptions(source, stripped),
    ...detectFakeAssertion(source, stripped, metadata.isTest),
    ...detectHardcodedSandboxData(source, metadata.isTest),
    ...detectSwallowedException(source, stripped),
  ];

  // Sort by line number (extracted from the `location` field), then
  // rule id, so output is stable and matches the source-order
  // convention `ApexQualitySemantics.md` §"Recognizer module
  // integration" calls out.
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
