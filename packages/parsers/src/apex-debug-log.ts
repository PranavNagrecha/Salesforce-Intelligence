/**
 * Apex DEBUG LOG parser — the missing primitive under every runtime question.
 *
 * A Salesforce debug log is not a stack trace with noise around it: it is a
 * line-oriented EVENT STREAM. Each logged line is
 * `HH:MM:SS.mmm (nanosOffset)|EVENT_NAME|payload…`, preceded by a single
 * header line that declares the log LEVEL per CATEGORY
 * (`57.0 APEX_CODE,FINE;DB,INFO;…`). Everything an admin actually wants to know
 * — the execution timeline, where the CPU went, which automation fired in what
 * order, what each limit consumed — is a PROJECTION of that stream, and none of
 * it is reachable by regexing names out of the text.
 *
 * This module turns the raw text into a typed, ORDERED, DEPTH-TRACKED stream
 * plus paired FRAMES (a `CODE_UNIT`/`METHOD`/`SOQL`/`DML`/flow-element stack
 * reconstructed from the nanosecond offsets already on every line). It performs
 * NO org access, NO network I/O and NO graph lookups — it is a pure function of
 * the pasted text, so it works on a log from an org this vault has never seen.
 *
 * THE HONESTY AXIS THIS DOMAIN IS BUILT ON
 *
 * A debug log records ONLY the categories a DebugLevel enabled, at the level it
 * enabled. `VALIDATION,NONE` means `VALIDATION_RULE` lines were NEVER WRITTEN —
 * it does NOT mean no validation rule ran. Confusing those two is the single
 * most damaging mistake a log reader can make, so the distinction is
 * STRUCTURAL here, not a footnote: {@link debugLogCoverage} answers, per
 * category, "was this logged at all?" and names the events that were therefore
 * absent-by-configuration. A projection built on this parser must consult it
 * before saying anything of the form "no X happened".
 *
 * Two further truths the parser encodes rather than papers over:
 *
 *  - **Wall-clock ≠ CPU.** The `(nanos)` column is elapsed nanoseconds since
 *    the transaction started. Pairing entry/exit yields WALL time. Salesforce's
 *    own CPU-time governor excludes database and callout wait, so a CPU figure
 *    is only honest once SOQL/SOSL/DML/callout spans are subtracted — hence
 *    {@link frameSelfNanos} and the per-kind descendant sums the projection
 *    layer uses. The result remains an ESTIMATE from wall spans, never the
 *    platform's own CPU accounting (`CUMULATIVE_LIMIT_USAGE` carries that).
 *  - **Logs truncate.** Salesforce caps a log at 20 MB and drops the middle,
 *    leaving `*** Skipped N bytes of detailed log` / `MAXIMUM DEBUG LOG SIZE
 *    REACHED` markers. After a skip, counts and pairings are provably
 *    incomplete — {@link ParsedApexDebugLog.truncation} says so, and frames left
 *    open at EOF are reported `unpaired`, never silently given an end time.
 *
 * @example
 *   const parsed = parseApexDebugLog(pastedText);
 *   parsed.header.levels.VALIDATION;      // 'NONE'  → rules were NOT LOGGED
 *   parsed.frames.filter((f) => f.kind === 'code-unit');
 *   parsed.limits.find((l) => l.metric === 'CPU time');
 */

/**
 * The DebugLevel categories a TraceFlag can set independently. `DATA_ACCESS`
 * and `WAVE` are absent from the public event-table documentation but are
 * declared by real orgs — `DATA_ACCESS` appeared in EVERY header of an
 * 18-log sample from a live sandbox, and was being reported as an
 * unrecognized category on 100% of real input.
 */
export type DebugLogCategory =
  | 'APEX_CODE'
  | 'APEX_PROFILING'
  | 'CALLOUT'
  | 'DATA_ACCESS'
  | 'DB'
  | 'NBA'
  | 'SYSTEM'
  | 'VALIDATION'
  | 'VISUALFORCE'
  | 'WAVE'
  | 'WORKFLOW';

/** The eight DebugLevel levels, ascending in verbosity. `NONE` = not logged. */
export type DebugLogLevel =
  | 'NONE'
  | 'ERROR'
  | 'WARN'
  | 'INFO'
  | 'DEBUG'
  | 'FINE'
  | 'FINER'
  | 'FINEST';

/** Every category name, in the order Salesforce writes the header. */
export const DEBUG_LOG_CATEGORIES: readonly DebugLogCategory[] = Object.freeze([
  'APEX_CODE',
  'APEX_PROFILING',
  'CALLOUT',
  'DATA_ACCESS',
  'DB',
  'NBA',
  'SYSTEM',
  'VALIDATION',
  'VISUALFORCE',
  'WAVE',
  'WORKFLOW',
] as const);

const LEVEL_SET: ReadonlySet<string> = new Set([
  'NONE',
  'ERROR',
  'WARN',
  'INFO',
  'DEBUG',
  'FINE',
  'FINER',
  'FINEST',
]);

const CATEGORY_SET: ReadonlySet<string> = new Set(DEBUG_LOG_CATEGORIES);

/** The header line: which categories were captured, and at what level. */
export interface DebugLogHeader {
  /** True when a recognizable `<version> CAT,LEVEL;…` header line was found. */
  readonly declared: boolean;
  /** API version the log was written at (`'57.0'`), or null. */
  readonly apiVersion: string | null;
  /** Declared level per category. An ABSENT key means the header omitted it. */
  readonly levels: Readonly<Partial<Record<DebugLogCategory, DebugLogLevel>>>;
  /** Verbatim header line, for display. */
  readonly rawHeaderLine: string | null;
  /** Category tokens in the header this parser does not model. */
  readonly unrecognizedCategories: readonly string[];
}

/** The frame kinds this parser pairs into spans. */
export type DebugLogFrameKind =
  | 'execution'
  | 'code-unit'
  | 'method'
  | 'constructor'
  | 'system-method'
  | 'soql'
  | 'sosl'
  | 'dml'
  | 'callout'
  | 'flow-interview'
  | 'flow-element'
  | 'workflow-eval'
  | 'workflow-criteria'
  | 'validation-rule';

/** What a `CODE_UNIT_STARTED` unit name turned out to BE. */
export type CodeUnitKind =
  | 'trigger'
  | 'apex-method'
  | 'anonymous'
  | 'flow'
  | 'workflow'
  | 'validation'
  | 'visualforce'
  | 'batch'
  | 'queueable'
  | 'future'
  | 'other';

/** One parsed line of the event stream. */
export interface DebugLogEvent {
  /** 0-based ordinal among PARSED events (not physical lines). */
  readonly index: number;
  /** 1-based physical line number in the pasted text. */
  readonly line: number;
  /** `'09:41:12.001'`, or null on a line with no timestamp column. */
  readonly timestamp: string | null;
  /** Nanoseconds since the start of the transaction, or null. */
  readonly nanos: number | null;
  /** Event token, e.g. `'METHOD_ENTRY'`. */
  readonly event: string;
  /** Pipe-delimited payload after the event token. */
  readonly fields: readonly string[];
  /** The `[42]` source-line marker when present (`[EXTERNAL]` → null). */
  readonly sourceLine: number | null;
  /** Frame depth this event sits at (0 = top level). */
  readonly depth: number;
  /** Untimestamped lines that belong to this event (stack traces, limit rows). */
  readonly continuation: readonly string[];
}

/** A paired span reconstructed from the event stream. */
export interface DebugLogFrame {
  readonly id: number;
  readonly parentId: number | null;
  readonly kind: DebugLogFrameKind;
  /** Display name: unit name, method signature, element name, query text… */
  readonly name: string;
  /** For a `code-unit` frame, what kind of unit it is. */
  readonly codeUnitKind: CodeUnitKind | null;
  readonly depth: number;
  readonly startNanos: number | null;
  readonly endNanos: number | null;
  /** `endNanos - startNanos`, or null when the frame never closed. */
  readonly durationNanos: number | null;
  readonly startIndex: number;
  readonly endIndex: number | null;
  /**
   * True when this frame has no matching close event in the text — the log was
   * truncated, or the transaction died inside it. Its duration is UNKNOWN, and
   * is reported as null rather than guessed from the next sibling.
   */
  readonly unpaired: boolean;
  /** Ids of the frames directly inside this one, in start order. */
  readonly childIds: readonly number[];
  /** Kind-specific parsed payload (query text, DML op/rows, element type…). */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/** One row of a `LIMIT_USAGE_FOR_NS` / `CUMULATIVE_LIMIT_USAGE` block. */
export interface DebugLogLimitRow {
  /** `'(default)'` for the org's own code, else the managed namespace. */
  readonly namespace: string;
  /** Verbatim label, e.g. `'Number of SOQL queries'`. */
  readonly resource: string;
  /** Label with the `Number of` / `Maximum` prefix stripped: `'SOQL queries'`. */
  readonly metric: string;
  readonly used: number;
  readonly allowed: number;
  readonly exceeded: boolean;
  /** Which block the row came from. */
  readonly source: 'CUMULATIVE_LIMIT_USAGE' | 'LIMIT_USAGE_FOR_NS' | 'LIMIT_USAGE';
}

/** Truncation the platform itself marked in the text. */
export interface DebugLogTruncation {
  readonly truncated: boolean;
  /** True when the log carries the 20 MB ceiling marker. */
  readonly maximumSizeReached: boolean;
  /** Sum of the bytes the platform said it skipped, when it said. */
  readonly skippedBytes: number | null;
  /** Verbatim skip markers, in order. */
  readonly markers: readonly string[];
}

/** A `USER_DEBUG` statement the developer left in the code. */
export interface DebugLogUserDebug {
  readonly index: number;
  readonly nanos: number | null;
  readonly level: string;
  readonly message: string;
  readonly sourceLine: number | null;
}

/** An `EXCEPTION_THROWN` / `FATAL_ERROR` frame. */
export interface DebugLogError {
  readonly index: number;
  readonly nanos: number | null;
  readonly kind: 'EXCEPTION_THROWN' | 'FATAL_ERROR';
  readonly message: string;
  readonly sourceLine: number | null;
  /** The untimestamped stack-trace lines that followed, verbatim. */
  readonly stack: readonly string[];
}

/** A structured note about something the parser could not do faithfully. */
export interface DebugLogParseCaveat {
  readonly kind:
    | 'no-header'
    | 'unpaired-open'
    | 'orphan-close'
    | 'implicit-close'
    | 'close-name-mismatch'
    | 'negative-duration'
    | 'unparsed-line'
    | 'event-cap-reached';
  readonly detail: string;
  readonly count: number;
}

/** The whole parse. Pure function of the input text. */
export interface ParsedApexDebugLog {
  /** False when the text carries no debug-log event lines at all. */
  readonly isDebugLog: boolean;
  readonly header: DebugLogHeader;
  readonly events: readonly DebugLogEvent[];
  readonly frames: readonly DebugLogFrame[];
  readonly limits: readonly DebugLogLimitRow[];
  readonly truncation: DebugLogTruncation;
  readonly userDebug: readonly DebugLogUserDebug[];
  readonly errors: readonly DebugLogError[];
  /** Count of each event token seen, for "was this even logged" questions. */
  readonly eventCounts: Readonly<Record<string, number>>;
  /** First event's nanos, or null. */
  readonly firstNanos: number | null;
  /** Last event's nanos, or null. */
  readonly lastNanos: number | null;
  /** `lastNanos - firstNanos`, the wall span the log covers. */
  readonly elapsedNanos: number | null;
  readonly physicalLines: number;
  readonly parseCaveats: readonly DebugLogParseCaveat[];
}

/** Options for {@link parseApexDebugLog}. */
export interface ParseApexDebugLogOptions {
  /**
   * Hard ceiling on parsed EVENTS, so a pasted 20 MB log cannot detonate the
   * caller. Reaching it emits an `event-cap-reached` caveat and the parse is
   * a prefix — never silently a whole-log claim. Default 200_000.
   */
  readonly maxEvents?: number;
}

const DEFAULT_MAX_EVENTS = 200_000;

// ---------------------------------------------------------------------------
// Line grammar
// ---------------------------------------------------------------------------

/** `09:41:12.001 (1200000)|EVENT|payload…` */
const EVENT_LINE = /^(\d{1,2}:\d{2}:\d{2}\.\d+)\s+\((\d+)\)\|(.*)$/;

/** `57.0 APEX_CODE,FINE;DB,INFO;…` — the version prefix is optional. */
const HEADER_LINE = /^(?:(\d+\.\d+)\s+)?([A-Z_]+,[A-Z]+(?:;[A-Z_]+,[A-Z]+)*);?\s*$/;

/**
 * A header line that ENDS in `;` is a wrapped header: Salesforce's own
 * documented example breaks the category list across two lines, the second
 * indented. Matching only the tail left `apiVersion: null` and 3 of 8
 * categories declared, and `debugLogCoverage` then reported the 5 lost
 * categories as "the header did not declare this category" — a confidently
 * wrong "absence proves nothing" for categories that were captured at FINEST.
 */
const HEADER_PREFIX = /^(?:(?:\d+\.\d+)\s+)?[A-Z_]+,[A-Z]+(?:;[A-Z_]+,[A-Z]+)*;$/;
const HEADER_CONTINUATION = /^\s+[A-Z_]+,[A-Z]+(?:;[A-Z_]+,[A-Z]+)*;?\s*$/;

/** `[42]` source-line marker; `[EXTERNAL]` means "no Apex line applies". */
const SOURCE_LINE_MARKER = /^\[(\d+|EXTERNAL)\]$/;

/** A 15/18-character Salesforce record id, which never resolves offline. */
const BARE_SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** `  Number of SOQL queries: 101 out of 100` */
const LIMIT_ROW = /^\s*(.+?):\s*(\d+)\s+out of\s+(\d+)\s*$/;

/** `*** Skipped 226,905 bytes of detailed log` */
const SKIP_MARKER = /^\*{2,}\s*Skipped\s+([\d,]+)\s+(bytes|lines)\s+of\s+detailed\s+log/i;

/** The 20 MB ceiling marker Salesforce appends when it stops writing. */
const MAX_SIZE_MARKER = /MAXIMUM DEBUG LOG SIZE REACHED/i;

/**
 * Open → close event pairs, and the frame kind each produces. A close event
 * pops the NEAREST open frame of the same kind (see the pairing note in
 * {@link parseApexDebugLog}).
 */
const FRAME_PAIRS: readonly (readonly [string, string, DebugLogFrameKind])[] =
  Object.freeze([
    ['EXECUTION_STARTED', 'EXECUTION_FINISHED', 'execution'],
    ['CODE_UNIT_STARTED', 'CODE_UNIT_FINISHED', 'code-unit'],
    ['METHOD_ENTRY', 'METHOD_EXIT', 'method'],
    ['CONSTRUCTOR_ENTRY', 'CONSTRUCTOR_EXIT', 'constructor'],
    ['SYSTEM_METHOD_ENTRY', 'SYSTEM_METHOD_EXIT', 'system-method'],
    ['SYSTEM_CONSTRUCTOR_ENTRY', 'SYSTEM_CONSTRUCTOR_EXIT', 'system-method'],
    ['SOQL_EXECUTE_BEGIN', 'SOQL_EXECUTE_END', 'soql'],
    ['SOSL_EXECUTE_BEGIN', 'SOSL_EXECUTE_END', 'sosl'],
    ['DML_BEGIN', 'DML_END', 'dml'],
    ['CALLOUT_REQUEST', 'CALLOUT_RESPONSE', 'callout'],
    ['FLOW_START_INTERVIEW_BEGIN', 'FLOW_START_INTERVIEW_END', 'flow-interview'],
    ['FLOW_ELEMENT_BEGIN', 'FLOW_ELEMENT_END', 'flow-element'],
    ['WF_RULE_EVAL_BEGIN', 'WF_RULE_EVAL_END', 'workflow-eval'],
    ['WF_CRITERIA_BEGIN', 'WF_CRITERIA_END', 'workflow-criteria'],
  ] as const);

const OPEN_EVENTS = new Map<string, DebugLogFrameKind>(
  FRAME_PAIRS.map(([open, , kind]) => [open, kind] as const),
);
const CLOSE_EVENTS = new Map<string, DebugLogFrameKind>(
  FRAME_PAIRS.map(([, close, kind]) => [close, kind] as const),
);

// `VALIDATION_RULE` opens; either verdict closes. Registered separately
// because the pair is one-to-many on the close side.
OPEN_EVENTS.set('VALIDATION_RULE', 'validation-rule');
CLOSE_EVENTS.set('VALIDATION_PASS', 'validation-rule');
CLOSE_EVENTS.set('VALIDATION_FAIL', 'validation-rule');

// ---------------------------------------------------------------------------
// Category coverage — the "absent means NOT LOGGED" machinery
// ---------------------------------------------------------------------------

/**
 * Which events each DebugLevel category governs. Used to turn a `CAT,NONE`
 * header entry into the concrete sentence "these event types were not written,
 * so their absence proves nothing".
 */
const CATEGORY_EVENTS: Readonly<Record<DebugLogCategory, readonly string[]>> =
  Object.freeze({
    APEX_CODE: [
      'CODE_UNIT_STARTED',
      'CODE_UNIT_FINISHED',
      'METHOD_ENTRY',
      'METHOD_EXIT',
      'CONSTRUCTOR_ENTRY',
      'CONSTRUCTOR_EXIT',
      'USER_DEBUG',
      'EXCEPTION_THROWN',
      'FATAL_ERROR',
      'STATEMENT_EXECUTE',
      'VARIABLE_ASSIGNMENT',
      'HEAP_ALLOCATE',
      'VF_APEX_CALL_START',
      'VF_APEX_CALL_END',
      'VF_PAGE_MESSAGE',
    ],
    APEX_PROFILING: [
      'CUMULATIVE_LIMIT_USAGE',
      'LIMIT_USAGE_FOR_NS',
      'LIMIT_USAGE',
      'CUMULATIVE_PROFILING',
    ],
    CALLOUT: ['CALLOUT_REQUEST', 'CALLOUT_RESPONSE'],
    DB: [
      'SOQL_EXECUTE_BEGIN',
      'SOQL_EXECUTE_END',
      'SOSL_EXECUTE_BEGIN',
      'SOSL_EXECUTE_END',
      'DML_BEGIN',
      'DML_END',
      'QUERY_MORE_BEGIN',
      'QUERY_MORE_END',
    ],
    NBA: ['NBA_NODE_BEGIN', 'NBA_NODE_END', 'NBA_STRATEGY_BEGIN', 'NBA_STRATEGY_END'],
    SYSTEM: [
      'SYSTEM_METHOD_ENTRY',
      'SYSTEM_METHOD_EXIT',
      'SYSTEM_CONSTRUCTOR_ENTRY',
      'SYSTEM_CONSTRUCTOR_EXIT',
      'SYSTEM_MODE_ENTER',
      'SYSTEM_MODE_EXIT',
    ],
    VALIDATION: [
      'VALIDATION_RULE',
      'VALIDATION_FORMULA',
      'VALIDATION_PASS',
      'VALIDATION_FAIL',
    ],
    // VF_APEX_CALL_START/END and VF_PAGE_MESSAGE are APEX_CODE events, NOT
    // Visualforce ones (they are listed under Apex Code in the platform event
    // table). Claiming them here made `VISUALFORCE=NONE` emit "these were NOT
    // LOGGED, so their absence is a logging setting, not evidence" for events
    // that APEX_CODE=FINE would have written — the honesty axis inverted into
    // a confidently false excuse. The view-state events below really are
    // Visualforce-gated.
    VISUALFORCE: [
      'VF_SERIALIZE_VIEWSTATE_BEGIN',
      'VF_SERIALIZE_VIEWSTATE_END',
      'VF_DESERIALIZE_VIEWSTATE_BEGIN',
      'VF_DESERIALIZE_VIEWSTATE_END',
      'VF_EVALUATE_FORMULA_BEGIN',
      'VF_EVALUATE_FORMULA_END',
    ],
    // Declared by real orgs (every header in an 18-log live sample) but its
    // governed event set is NOT in the public event table. Left deliberately
    // EMPTY rather than guessed — `debugLogCoverage` has a branch for an
    // unmodeled event set so this reports "not modeled", never "0 seen".
    DATA_ACCESS: [],
    WAVE: ['WAVE_APP_LIFECYCLE'],
    WORKFLOW: [
      'WF_RULE_EVAL_BEGIN',
      'WF_RULE_EVAL_END',
      'WF_CRITERIA_BEGIN',
      'WF_CRITERIA_END',
      'WF_FIELD_UPDATE',
      'WF_ACTION',
      'WF_APPROVAL',
      'WF_EMAIL_SENT',
      'WF_TIME_TRIGGER',
      'FLOW_START_INTERVIEWS_BEGIN',
      'FLOW_START_INTERVIEW_BEGIN',
      'FLOW_START_INTERVIEW_END',
      'FLOW_ELEMENT_BEGIN',
      'FLOW_ELEMENT_END',
      'FLOW_VALUE_ASSIGNMENT',
    ],
  });

/**
 * Per-category answer to "was this logged at all?" — the structural form of the
 * product's core rule that "checked and found nothing" is not "did not check".
 */
/**
 * The MINIMUM level at which each modeled event is written, from the platform
 * event table. Levels are CUMULATIVE (FINE also writes DEBUG/INFO/WARN/ERROR),
 * so an event appears only when its category's declared level is at or above
 * the entry here.
 *
 * Without this, coverage was binary — "the category is not NONE, therefore
 * everything it governs was written". That is false for the DEFAULT capture of
 * an Apex test (`APEX_CODE=DEBUG`, below the FINE that `METHOD_ENTRY` needs)
 * and for any `WORKFLOW=INFO` log, where `FLOW_ELEMENT_BEGIN/END` are FINE+:
 * the answer reported a flow interview whose element list was EMPTY, reading
 * as "this flow ran no elements" when the elements were simply never written.
 * Events absent from this map are treated as INFO, the level at which most
 * events begin.
 */
const EVENT_MIN_LEVEL: Readonly<Record<string, DebugLogLevel>> = Object.freeze({
  // Apex Code
  CODE_UNIT_STARTED: 'ERROR',
  CODE_UNIT_FINISHED: 'ERROR',
  EXECUTION_STARTED: 'ERROR',
  EXECUTION_FINISHED: 'ERROR',
  FATAL_ERROR: 'ERROR',
  USER_INFO: 'ERROR',
  EXCEPTION_THROWN: 'INFO',
  EMAIL_QUEUE: 'INFO',
  VF_APEX_CALL_START: 'INFO',
  VF_APEX_CALL_END: 'INFO',
  VF_PAGE_MESSAGE: 'INFO',
  USER_DEBUG: 'DEBUG',
  METHOD_ENTRY: 'FINE',
  METHOD_EXIT: 'FINE',
  CONSTRUCTOR_ENTRY: 'FINE',
  CONSTRUCTOR_EXIT: 'FINE',
  ENTERING_MANAGED_PKG: 'FINE',
  HEAP_ALLOCATE: 'FINER',
  HEAP_DEALLOCATE: 'FINER',
  STATEMENT_EXECUTE: 'FINER',
  VARIABLE_ASSIGNMENT: 'FINEST',
  VARIABLE_SCOPE_BEGIN: 'FINEST',
  VARIABLE_SCOPE_END: 'FINEST',
  BULK_HEAP_ALLOCATE: 'FINEST',
  // Apex Profiling
  CUMULATIVE_LIMIT_USAGE: 'INFO',
  CUMULATIVE_LIMIT_USAGE_END: 'INFO',
  TESTING_LIMITS: 'INFO',
  CUMULATIVE_PROFILING: 'FINE',
  STACK_FRAME_VARIABLE_LIST: 'FINE',
  STATIC_VARIABLE_LIST: 'FINE',
  TOTAL_EMAIL_RECIPIENTS_QUEUED: 'FINE',
  LIMIT_USAGE_FOR_NS: 'INFO',
  // Database
  DML_BEGIN: 'INFO',
  DML_END: 'INFO',
  SOQL_EXECUTE_BEGIN: 'INFO',
  SOQL_EXECUTE_END: 'INFO',
  SOSL_EXECUTE_BEGIN: 'INFO',
  SOSL_EXECUTE_END: 'INFO',
  SAVEPOINT_SET: 'INFO',
  SAVEPOINT_ROLLBACK: 'INFO',
  QUERY_MORE_BEGIN: 'INFO',
  QUERY_MORE_END: 'INFO',
  SOQL_EXECUTE_EXPLAIN: 'FINEST',
  IDEAS_QUERY_EXECUTE: 'FINEST',
  // Workflow (incl. flows and processes)
  WF_RULE_EVAL_BEGIN: 'INFO',
  WF_RULE_EVAL_END: 'INFO',
  WF_CRITERIA_BEGIN: 'INFO',
  WF_CRITERIA_END: 'INFO',
  WF_FIELD_UPDATE: 'INFO',
  WF_ACTION: 'INFO',
  WF_APPROVAL: 'INFO',
  WF_EMAIL_SENT: 'INFO',
  WF_TIME_TRIGGER: 'INFO',
  FLOW_START_INTERVIEWS_BEGIN: 'INFO',
  FLOW_START_INTERVIEWS_END: 'INFO',
  FLOW_START_INTERVIEW_BEGIN: 'INFO',
  FLOW_START_INTERVIEW_END: 'INFO',
  FLOW_CREATE_INTERVIEW_BEGIN: 'INFO',
  FLOW_CREATE_INTERVIEW_END: 'INFO',
  FLOW_INTERVIEW_PAUSED: 'INFO',
  FLOW_INTERVIEW_RESUMED: 'INFO',
  FLOW_ELEMENT_FAULT: 'WARN',
  FLOW_ELEMENT_BEGIN: 'FINE',
  FLOW_ELEMENT_END: 'FINE',
  FLOW_ELEMENT_DEFERRED: 'FINE',
  FLOW_BULK_ELEMENT_BEGIN: 'FINE',
  FLOW_BULK_ELEMENT_END: 'FINE',
  WF_FLOW_ACTION_DETAIL: 'FINE',
  FLOW_VALUE_ASSIGNMENT: 'FINER',
  FLOW_ASSIGNMENT_DETAIL: 'FINER',
  FLOW_RULE_DETAIL: 'FINER',
  FLOW_LOOP_DETAIL: 'FINER',
  FLOW_ACTIONCALL_DETAIL: 'FINER',
  FLOW_SUBFLOW_DETAIL: 'FINER',
  FLOW_ELEMENT_LIMIT_USAGE: 'FINER',
  FLOW_BULK_ELEMENT_LIMIT_USAGE: 'FINER',
  FLOW_START_INTERVIEW_LIMIT_USAGE: 'FINER',
  FLOW_INTERVIEW_FINISHED_LIMIT_USAGE: 'FINER',
  // Validation
  VALIDATION_RULE: 'INFO',
  VALIDATION_FORMULA: 'INFO',
  VALIDATION_PASS: 'INFO',
  VALIDATION_FAIL: 'INFO',
  VALIDATION_ERROR: 'INFO',
  // Callout
  CALLOUT_REQUEST: 'INFO',
  CALLOUT_RESPONSE: 'INFO',
  NAMED_CREDENTIAL_REQUEST: 'INFO',
  NAMED_CREDENTIAL_RESPONSE: 'INFO',
  NAMED_CREDENTIAL_RESPONSE_DETAIL: 'FINER',
  // System
  SYSTEM_MODE_ENTER: 'INFO',
  SYSTEM_MODE_EXIT: 'INFO',
  POP_TRACE_FLAGS: 'INFO',
  PUSH_TRACE_FLAGS: 'INFO',
  SYSTEM_METHOD_ENTRY: 'FINE',
  SYSTEM_METHOD_EXIT: 'FINE',
  SYSTEM_CONSTRUCTOR_ENTRY: 'FINE',
  SYSTEM_CONSTRUCTOR_EXIT: 'FINE',
  // Visualforce
  VF_SERIALIZE_VIEWSTATE_BEGIN: 'INFO',
  VF_SERIALIZE_VIEWSTATE_END: 'INFO',
  VF_DESERIALIZE_VIEWSTATE_BEGIN: 'INFO',
  VF_DESERIALIZE_VIEWSTATE_END: 'INFO',
  VF_EVALUATE_FORMULA_BEGIN: 'FINER',
  VF_EVALUATE_FORMULA_END: 'FINER',
});

/** Ascending verbosity; index comparison decides "at or above". */
const LEVEL_ORDER: readonly DebugLogLevel[] = Object.freeze([
  'NONE',
  'ERROR',
  'WARN',
  'INFO',
  'DEBUG',
  'FINE',
  'FINER',
  'FINEST',
]);

/** True when `declared` is at or above the level `event` requires. */
const eventIsWritten = (event: string, declared: DebugLogLevel): boolean =>
  LEVEL_ORDER.indexOf(declared) >= LEVEL_ORDER.indexOf(EVENT_MIN_LEVEL[event] ?? 'INFO');

export interface DebugLogCategoryCoverage {
  readonly category: DebugLogCategory;
  /** The declared level, or null when the header did not mention the category. */
  readonly level: DebugLogLevel | null;
  /** True only when the category was declared at a level above `NONE`. */
  readonly logged: boolean;
  /** The event tokens this category governs. */
  readonly eventsGoverned: readonly string[];
  /** How many of those events actually appear in the parsed stream. */
  readonly eventsSeen: number;
  /**
   * Events this category governs that the DECLARED level was too low to write.
   * Empty when the level covers everything modeled. Their absence from the
   * stream is a LOGGING SETTING, never evidence the activity did not happen.
   */
  readonly eventsBelowLevel: readonly string[];
  /** A verbatim sentence a projection can surface without rewriting. */
  readonly meaning: string;
}

/**
 * Classify every DebugLevel category as LOGGED / NOT LOGGED / UNDECLARED for a
 * parsed log, so a caller never reports "no validation rule fired" when the
 * truth is "VALIDATION was set to NONE and no such line was ever written".
 *
 * @example
 *   const cov = debugLogCoverage(parsed);
 *   cov.filter((c) => !c.logged).map((c) => c.meaning); // the disclosures
 */
export const debugLogCoverage = (
  parsed: ParsedApexDebugLog,
): readonly DebugLogCategoryCoverage[] =>
  DEBUG_LOG_CATEGORIES.map((category) => {
    const level = parsed.header.levels[category] ?? null;
    const eventsGoverned = CATEGORY_EVENTS[category];
    const eventsSeen = eventsGoverned.reduce(
      (sum, name) => sum + (parsed.eventCounts[name] ?? 0),
      0,
    );
    const logged = level !== null && level !== 'NONE';
    const sample = eventsGoverned.slice(0, 4).join(' / ');
    // Levels are CUMULATIVE, so "not NONE" does NOT mean "everything this
    // category governs was written". Name what this level was too low for.
    const belowLevel =
      level === null || level === 'NONE'
        ? []
        : eventsGoverned.filter((name) => !eventIsWritten(name, level));
    const raiseTo = belowLevel.reduce<DebugLogLevel>((worst, name) => {
      const need = EVENT_MIN_LEVEL[name] ?? 'INFO';
      return LEVEL_ORDER.indexOf(need) > LEVEL_ORDER.indexOf(worst) ? need : worst;
    }, 'NONE');
    const meaning = eventsGoverned.length === 0
      ? `${category}${level === null ? '' : `=${level}`}: this build does not model which event lines this ` +
        'category governs, so nothing can be concluded from what is present or absent for it. ' +
        'Its declared level is reported; its coverage is NOT.'
      : !parsed.header.declared
      ? `${category}: this log carries NO header line, so the capture level is UNKNOWN. ` +
        `The absence of ${sample} lines is NOT evidence that nothing of that kind ran.`
      : level === null
        ? `${category}: the header did not declare this category, so whether ${sample} ` +
          `lines would have been written is UNKNOWN — absence proves nothing.`
        : level === 'NONE'
          ? `${category}=NONE: ${sample} lines were NOT LOGGED in this transaction. ` +
            `Their absence is a LOGGING SETTING, not evidence that no ${category.toLowerCase()} activity occurred. ` +
            `Re-run with ${category} above NONE to see it.`
          : belowLevel.length > 0
            ? `${category}=${level}: logged, but PARTIALLY — ${belowLevel.length.toString()} event type(s) this ` +
              `category governs need a level ABOVE ${level} and were therefore NOT written: ` +
              `${belowLevel.slice(0, 6).join(' / ')}${belowLevel.length > 6 ? ' …' : ''}. ` +
              `Anything reported as empty for those events means NOT CAPTURED, never "did not happen". ` +
              `Re-run with ${category} at ${raiseTo} or above to see them. ` +
              `(${eventsSeen.toString()} matching event line${eventsSeen === 1 ? '' : 's'} were written at ${level}.)`
            : `${category}=${level}: logged (${eventsSeen} matching event line${eventsSeen === 1 ? '' : 's'} in this log).`;
    return { category, level, logged, eventsGoverned, eventsSeen, eventsBelowLevel: belowLevel, meaning };
  });

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

const parseSourceLine = (token: string | undefined): number | null => {
  if (token === undefined) return null;
  const m = SOURCE_LINE_MARKER.exec(token);
  if (m === null) return null;
  return m[1] === 'EXTERNAL' ? null : Number(m[1]);
};

/**
 * Pick the human-meaningful NAME out of a `CODE_UNIT_STARTED` payload. The
 * payload shape varies (`[EXTERNAL]|<id>|<unit>|__sfdc_trigger/X`,
 * `[EXTERNAL]|<unit>`, `[64]|<unit>`), and the `<id>` field is a Salesforce
 * record id that — verified — NEVER resolves offline: the vault's Tooling
 * enricher folds back only `{componentId, lastModifiedDate, lastModifiedBy,
 * apiVersion}` and no durable ids. So an id-only unit stays an id here, and
 * the projection must type it UNRESOLVABLE rather than invent a component.
 */
const codeUnitName = (fields: readonly string[]): string => {
  const candidates = fields.filter(
    (f) => !SOURCE_LINE_MARKER.test(f) && !f.startsWith('__sfdc_trigger/') && f !== '',
  );
  // The unit name is the LAST descriptive field: Salesforce writes the record
  // id (when it writes one) BEFORE the human-readable unit, and some payloads
  // carry only the id (`Flow:301…`, an unresolvable-offline identity). Scanning
  // from the tail and skipping bare ids therefore handles every shape without
  // special-casing which optional fields were present.
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i];
    if (candidate !== undefined && !BARE_SALESFORCE_ID.test(candidate)) return candidate;
  }
  return candidates[candidates.length - 1] ?? '';
};

const TRIGGER_UNIT = /^(\S+)\s+on\s+(\S+)\s+trigger\s+event\s+(\S+)/i;

/**
 * Classify a `CODE_UNIT_STARTED` unit name. Returns `'other'` rather than
 * guessing when the shape is unfamiliar — an unknown unit is reported as
 * unknown, never folded into the nearest familiar bucket.
 */
export const classifyCodeUnit = (name: string): CodeUnitKind => {
  if (TRIGGER_UNIT.test(name) || /^__sfdc_trigger\//.test(name)) return 'trigger';
  if (/^execute_anonymous_apex$/i.test(name)) return 'anonymous';
  if (/^Flow[:.]/i.test(name)) return 'flow';
  if (/^Workflow[:.]/i.test(name)) return 'workflow';
  if (/^Validation[:.]/i.test(name)) return 'validation';
  if (/^VF[:.]/i.test(name) || /^apex_page/i.test(name)) return 'visualforce';
  if (/\bBatchApexWorker\b|\bbatch\b/i.test(name)) return 'batch';
  if (/\bqueueable\b/i.test(name)) return 'queueable';
  if (/\bfuture\b/i.test(name)) return 'future';
  if (/^[A-Za-z_][\w.]*\.[A-Za-z_]\w*(?:\(.*\))?$/.test(name)) return 'apex-method';
  return 'other';
};

/**
 * Split a trigger code-unit name into its parts. Returns null when the name is
 * not a trigger unit.
 *
 * @example
 *   parseTriggerUnit('ContactTrigger on Contact trigger event BeforeUpdate');
 *   // { triggerName: 'ContactTrigger', objectApiName: 'Contact', event: 'BeforeUpdate' }
 */
export const parseTriggerUnit = (
  name: string,
): { readonly triggerName: string; readonly objectApiName: string; readonly event: string } | null => {
  const m = TRIGGER_UNIT.exec(name);
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
    return null;
  }
  return { triggerName: m[1], objectApiName: m[2], event: m[3] };
};

/**
 * The leftmost Apex type name in a `METHOD_ENTRY` signature — the class whose
 * source the vault would hold. `Outer.Inner.method(...)` yields `Outer`,
 * because an inner class is not a separate `ApexClass` component.
 */
export const apexClassOfSignature = (signature: string): string | null => {
  const m = /^([A-Za-z_]\w*)\s*\./.exec(signature.trim());
  return m?.[1] ?? null;
};

const kvNumber = (fields: readonly string[], key: string): number | null => {
  for (const f of fields) {
    const m = new RegExp(`^${key}\\s*:\\s*(-?\\d+)$`, 'i').exec(f.trim());
    if (m?.[1] !== undefined) return Number(m[1]);
  }
  return null;
};

const kvString = (fields: readonly string[], key: string): string | null => {
  for (const f of fields) {
    const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'i').exec(f.trim());
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
};

/** Build the kind-specific `detail` payload for an opening event. */
const openDetail = (
  kind: DebugLogFrameKind,
  fields: readonly string[],
): Record<string, string | number | boolean | null> => {
  switch (kind) {
    case 'soql':
    case 'sosl': {
      // `[21]|Aggregations:0|SELECT …` — the query may itself contain pipes.
      const rest = fields.slice(1);
      const aggregations = kvNumber(fields, 'Aggregations');
      const queryParts = rest.filter((f) => !/^Aggregations\s*:/i.test(f));
      return { query: queryParts.join('|').trim(), aggregations };
    }
    case 'dml':
      return {
        operation: kvString(fields, 'Op'),
        objectApiName: kvString(fields, 'Type'),
        rows: kvNumber(fields, 'Rows'),
      };
    case 'flow-element':
      return { interview: fields[0] ?? null, elementType: fields[1] ?? null };
    case 'flow-interview':
      return { interview: fields[0] ?? null };
    case 'callout':
      return { request: fields[fields.length - 1] ?? null };
    case 'validation-rule':
      return { ruleIdInLog: fields[0] ?? null };
    case 'workflow-criteria':
      return { record: fields[0] ?? null, ruleIdInLog: fields[2] ?? null };
    default:
      return {};
  }
};

/** Frame display name for an opening event. */
/**
 * The unit name carried on a CLOSE line, when the event carries one.
 *
 * `CODE_UNIT_FINISHED` repeats the unit name it is closing. Pairing ignored it
 * and popped the nearest open frame OF THE SAME KIND, which is wrong exactly
 * when it matters: a >20 MB log is trimmed by removing older lines from ANY
 * location, so an inner unit's close can go missing while the outer unit's
 * close survives. The outer close then landed on the INNER frame — the inner
 * one got a duration it never had and `unpaired: false`, while the unit that
 * really did close was flagged unpaired. "The slowest code unit" became a
 * fabricated ranking with the disclosure attached to the wrong row. Returns
 * `null` for kinds whose close carries no name, leaving LIFO in charge there.
 */
const closeName = (
  kind: DebugLogFrameKind,
  fields: readonly string[],
): string | null => {
  if (kind !== 'code-unit') return null;
  const name = codeUnitName(fields);
  return name === '' ? null : name;
};

const openName = (
  kind: DebugLogFrameKind,
  event: string,
  fields: readonly string[],
): string => {
  switch (kind) {
    case 'execution':
      return 'EXECUTION';
    case 'code-unit':
      return codeUnitName(fields);
    case 'method':
    case 'constructor':
    case 'system-method':
      return fields[fields.length - 1] ?? event;
    case 'soql':
    case 'sosl': {
      const q = String(openDetail(kind, fields)['query'] ?? '');
      return q === '' ? event : q;
    }
    case 'dml': {
      const d = openDetail(kind, fields);
      return `${String(d['operation'] ?? '?')} ${String(d['objectApiName'] ?? '?')} (${String(d['rows'] ?? '?')} rows)`;
    }
    case 'callout':
      return fields[fields.length - 1] ?? event;
    case 'flow-interview':
      return fields[1] ?? '';
    case 'flow-element':
      return fields[2] ?? '';
    case 'workflow-eval':
      return fields[0] ?? 'Workflow';
    case 'workflow-criteria':
      return fields[1] ?? '';
    case 'validation-rule':
      return fields[fields.length - 1] ?? '';
    default:
      return event;
  }
};

/** Payload merged into the frame when its CLOSE event carries data. */
const closeDetail = (
  kind: DebugLogFrameKind,
  event: string,
  fields: readonly string[],
): Record<string, string | number | boolean | null> => {
  switch (kind) {
    case 'soql':
    case 'sosl':
      return { rows: kvNumber(fields, 'Rows') };
    case 'callout':
      return { response: fields[fields.length - 1] ?? null };
    case 'validation-rule':
      return { verdict: event === 'VALIDATION_PASS' ? 'pass' : 'fail' };
    case 'workflow-criteria':
      return { criteriaMet: fields[0] === 'true' };
    default:
      return {};
  }
};

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

interface MutableFrame {
  readonly id: number;
  parentId: number | null;
  readonly kind: DebugLogFrameKind;
  name: string;
  codeUnitKind: CodeUnitKind | null;
  readonly depth: number;
  readonly startNanos: number | null;
  endNanos: number | null;
  readonly startIndex: number;
  endIndex: number | null;
  unpaired: boolean;
  readonly childIds: number[];
  detail: Record<string, string | number | boolean | null>;
}

/**
 * Parse a pasted Apex debug log into a typed, ordered, depth-tracked event
 * stream plus paired frames. Pure: no I/O, no org access, no graph.
 *
 * PAIRING CONTRACT. A close event pops the NEAREST open frame of the same kind.
 * Frames left open above it (a truncated section, or an exception that unwound
 * past them) are closed IMPLICITLY: they keep `endNanos: null`, are flagged
 * `unpaired`, and raise an `implicit-close` caveat — their duration is reported
 * as unknown, never inferred. A close with no open frame of its kind raises
 * `orphan-close` and is otherwise ignored. Frames still open at EOF are
 * `unpaired` too. Nothing in this module ever manufactures a missing timestamp.
 *
 * @example
 *   const parsed = parseApexDebugLog(text);
 *   if (!parsed.isDebugLog) return; // not an event stream — a bare stack trace
 *   const soqlWallNanos = parsed.frames
 *     .filter((f) => f.kind === 'soql' && f.durationNanos !== null)
 *     .reduce((n, f) => n + (f.durationNanos ?? 0), 0);
 */
export const parseApexDebugLog = (
  logText: string,
  options?: ParseApexDebugLogOptions,
): ParsedApexDebugLog => {
  const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
  const rawPhysicalLines = logText.split(/\r?\n/);
  // Join a WRAPPED header before scanning, so the version prefix and every
  // category survive. Only the first few lines are considered — a `CAT,LEVEL;`
  // line cannot legitimately appear once event lines have begun.
  const physicalLines = ((): string[] => {
    for (let i = 0; i < Math.min(rawPhysicalLines.length - 1, 4); i += 1) {
      const here = rawPhysicalLines[i];
      const next = rawPhysicalLines[i + 1];
      if (here === undefined || next === undefined) break;
      if (HEADER_PREFIX.test(here.trim()) && HEADER_CONTINUATION.test(next)) {
        const merged = rawPhysicalLines.slice();
        merged.splice(i, 2, `${here.trim()}${next.trim()}`);
        return merged;
      }
    }
    return rawPhysicalLines;
  })();

  const events: DebugLogEvent[] = [];
  const frames: MutableFrame[] = [];
  const openStack: MutableFrame[] = [];
  const limits: DebugLogLimitRow[] = [];
  const userDebug: DebugLogUserDebug[] = [];
  const errors: DebugLogError[] = [];
  const eventCounts: Record<string, number> = {};
  const skipMarkers: string[] = [];
  let skippedBytes: number | null = null;
  let maximumSizeReached = false;
  let unparsedLines = 0;
  let orphanCloses = 0;
  let nameMismatchCloses = 0;
  let negativeDurations = 0;
  let implicitCloses = 0;
  let eventCapReached = false;

  let header: DebugLogHeader = {
    declared: false,
    apiVersion: null,
    levels: {},
    rawHeaderLine: null,
    unrecognizedCategories: [],
  };

  // Continuation state: which event (and which limit block) trailing
  // untimestamped lines belong to.
  let currentContinuation: string[] | null = null;
  let currentLimitNamespace: string | null = null;
  let currentLimitSource: DebugLogLimitRow['source'] = 'LIMIT_USAGE_FOR_NS';
  let inCumulativeBlock = false;
  let currentError: { readonly stack: string[] } | null = null;

  const pushCaveatCounts = (): DebugLogParseCaveat[] => {
    const out: DebugLogParseCaveat[] = [];
    if (!header.declared) {
      out.push({
        kind: 'no-header',
        detail:
          'No `<version> CATEGORY,LEVEL;…` header line was found, so which categories this log captured is UNKNOWN. ' +
          'Any absent event type may mean "not logged" rather than "did not happen" — this parse cannot tell you which.',
        count: 1,
      });
    }
    const stillOpen = frames.filter((f) => f.unpaired).length;
    if (stillOpen > 0) {
      out.push({
        kind: 'unpaired-open',
        detail:
          `${stillOpen} frame(s) never closed (truncated log, or the transaction died inside them). ` +
          'Their duration is reported as null, never estimated from the next event.',
        count: stillOpen,
      });
    }
    if (orphanCloses > 0) {
      out.push({
        kind: 'orphan-close',
        detail:
          `${orphanCloses} close event(s) had no matching open frame — the log begins mid-transaction or a section was skipped.`,
        count: orphanCloses,
      });
    }
    if (nameMismatchCloses > 0) {
      out.push({
        kind: 'close-name-mismatch',
        detail:
          `${nameMismatchCloses} close event(s) named a unit that was not open. The named unit's own start line is ` +
          'missing (a trimmed log drops older lines from ANY location, not only the head), so this close was NOT ' +
          'applied to a different open frame — its duration is unknown rather than borrowed from a neighbour.',
        count: nameMismatchCloses,
      });
    }
    if (negativeDurations > 0) {
      out.push({
        kind: 'negative-duration',
        detail:
          `${negativeDurations} frame(s) closed at an offset EARLIER than they opened, so their duration cannot be ` +
          'computed and is reported as null. Two transactions may have been merged by a trimmed log, or the ' +
          'nanosecond offsets restarted. Any elapsed total over this log is unreliable.',
        count: negativeDurations,
      });
    }
    if (implicitCloses > 0) {
      out.push({
        kind: 'implicit-close',
        detail:
          `${implicitCloses} frame(s) were closed implicitly by a parent's close event (an unwound exception or a skipped section).`,
        count: implicitCloses,
      });
    }
    if (unparsedLines > 0) {
      out.push({
        kind: 'unparsed-line',
        detail: `${unparsedLines} line(s) matched neither the event grammar nor a recognized continuation shape and were skipped.`,
        count: unparsedLines,
      });
    }
    if (eventCapReached) {
      out.push({
        kind: 'event-cap-reached',
        detail:
          `Parsing stopped at the ${maxEvents}-event ceiling. Everything reported is a PREFIX of the transaction, not the whole of it.`,
        count: maxEvents,
      });
    }
    return out;
  };

  const closeFrame = (
    frame: MutableFrame,
    nanos: number | null,
    index: number,
    detail: Record<string, string | number | boolean | null>,
  ): void => {
    // A close whose offset precedes its open cannot be timed. That happens when
    // a hole merges two transactions, or when offsets restart inside one log.
    // Reporting the subtraction would yield a NEGATIVE duration, which then
    // flows into self-time and the hot-spot ranking as a nonsense number. An
    // unknown duration is `null` here, exactly as for a frame that never
    // closed — and it is disclosed rather than silently clamped to zero.
    if (nanos !== null && frame.startNanos !== null && nanos < frame.startNanos) {
      negativeDurations += 1;
      frame.endNanos = null;
      frame.endIndex = index;
      frame.unpaired = true;
      frame.detail = { ...frame.detail, ...detail, durationUnknown: 'end-before-start' };
      return;
    }
    frame.endNanos = nanos;
    frame.endIndex = index;
    frame.unpaired = false;
    frame.detail = { ...frame.detail, ...detail };
  };

  for (let li = 0; li < physicalLines.length; li += 1) {
    const rawLine = physicalLines[li] ?? '';
    if (rawLine === '') {
      currentLimitNamespace = null;
      continue;
    }

    // --- truncation markers (they can appear anywhere) ---------------------
    const skip = SKIP_MARKER.exec(rawLine);
    if (skip !== null) {
      skipMarkers.push(rawLine.trim());
      if (skip[2]?.toLowerCase() === 'bytes' && skip[1] !== undefined) {
        skippedBytes = (skippedBytes ?? 0) + Number(skip[1].replace(/,/g, ''));
      }
      currentContinuation = null;
      currentLimitNamespace = null;
      continue;
    }
    if (MAX_SIZE_MARKER.test(rawLine)) {
      maximumSizeReached = true;
      continue;
    }

    // --- header ------------------------------------------------------------
    if (!header.declared) {
      const h = HEADER_LINE.exec(rawLine.trim());
      if (h !== null && h[2] !== undefined) {
        const levels: Partial<Record<DebugLogCategory, DebugLogLevel>> = {};
        const unrecognized: string[] = [];
        for (const pair of h[2].split(';')) {
          const [cat, lvl] = pair.split(',');
          if (cat === undefined || lvl === undefined) continue;
          if (CATEGORY_SET.has(cat) && LEVEL_SET.has(lvl)) {
            levels[cat as DebugLogCategory] = lvl as DebugLogLevel;
          } else {
            unrecognized.push(pair);
          }
        }
        if (Object.keys(levels).length > 0) {
          header = {
            declared: true,
            apiVersion: h[1] ?? null,
            levels,
            rawHeaderLine: rawLine.trim(),
            unrecognizedCategories: unrecognized,
          };
          continue;
        }
      }
    }

    // --- event line --------------------------------------------------------
    const m = EVENT_LINE.exec(rawLine);
    if (m === null) {
      // Continuation of the previous event: a limit row, a stack frame, or
      // free text the platform wrote without a timestamp.
      const limitMatch = currentLimitNamespace !== null ? LIMIT_ROW.exec(rawLine) : null;
      if (limitMatch !== null && limitMatch[1] !== undefined) {
        const resource = limitMatch[1].trim();
        const used = Number(limitMatch[2]);
        const allowed = Number(limitMatch[3]);
        limits.push({
          namespace: currentLimitNamespace ?? '(default)',
          resource,
          metric: resource.replace(/^(?:Number of|Maximum)\s+/i, ''),
          used,
          allowed,
          exceeded: used > allowed,
          source: currentLimitSource,
        });
        currentContinuation?.push(rawLine);
        continue;
      }
      if (currentError !== null && rawLine.trim() !== '') {
        currentError.stack.push(rawLine.trim());
      }
      if (currentContinuation !== null) {
        currentContinuation.push(rawLine);
      } else if (rawLine.trim() !== '') {
        unparsedLines += 1;
      }
      continue;
    }

    if (events.length >= maxEvents) {
      eventCapReached = true;
      break;
    }

    const rest = m[3] ?? '';
    const parts = rest.split('|');
    const event = parts[0] ?? '';
    const fields = parts.slice(1);
    const nanos = m[2] === undefined ? null : Number(m[2]);
    const index = events.length;
    const continuation: string[] = [];
    currentContinuation = continuation;
    currentError = null;
    currentLimitNamespace = null;

    eventCounts[event] = (eventCounts[event] ?? 0) + 1;

    // Depth is the stack depth BEFORE an open pushes / AFTER a close pops, so
    // a matched pair reports the same depth.
    const closeKind = CLOSE_EVENTS.get(event);
    const openKind = OPEN_EVENTS.get(event);

    let depth = openStack.length;
    if (closeKind !== undefined) {
      let at = -1;
      // Prefer the nearest open frame of this kind whose NAME matches the
      // close line. Fall back to plain LIFO only when the close carries no
      // name, or names a unit that is not open (a hole removed its open line).
      const wantName = closeName(closeKind, fields);
      if (wantName !== null) {
        for (let i = openStack.length - 1; i >= 0; i -= 1) {
          const cand = openStack[i];
          if (cand?.kind === closeKind && cand.name === wantName) {
            at = i;
            break;
          }
        }
        if (at === -1) nameMismatchCloses += 1;
      }
      if (at === -1 && wantName === null) {
        for (let i = openStack.length - 1; i >= 0; i -= 1) {
          if (openStack[i]?.kind === closeKind) {
            at = i;
            break;
          }
        }
      }
      if (at === -1) {
        orphanCloses += 1;
        depth = openStack.length;
      } else {
        // Everything above `at` never closed — implicit close, unknown duration.
        for (let i = openStack.length - 1; i > at; i -= 1) {
          const orphan = openStack[i];
          if (orphan !== undefined) {
            orphan.unpaired = true;
            implicitCloses += 1;
          }
        }
        const frame = openStack[at];
        openStack.length = at;
        if (frame !== undefined) {
          closeFrame(frame, nanos, index, closeDetail(closeKind, event, fields));
          depth = frame.depth;
        }
      }
    } else if (openKind !== undefined) {
      const parent = openStack[openStack.length - 1] ?? null;
      const name = openName(openKind, event, fields);
      const frame: MutableFrame = {
        id: frames.length,
        parentId: parent?.id ?? null,
        kind: openKind,
        name,
        codeUnitKind: openKind === 'code-unit' ? classifyCodeUnit(name) : null,
        depth: openStack.length,
        startNanos: nanos,
        endNanos: null,
        startIndex: index,
        endIndex: null,
        unpaired: true,
        childIds: [],
        detail: openDetail(openKind, fields),
      };
      if (openKind === 'code-unit') {
        const trig = parseTriggerUnit(name);
        if (trig !== null) {
          frame.detail = {
            ...frame.detail,
            triggerName: trig.triggerName,
            objectApiName: trig.objectApiName,
            triggerEvent: trig.event,
          };
        }
        const marker = fields.find((f) => f.startsWith('__sfdc_trigger/'));
        if (marker !== undefined) {
          frame.detail = {
            ...frame.detail,
            triggerMarker: marker.slice('__sfdc_trigger/'.length),
          };
        }
      }
      parent?.childIds.push(frame.id);
      frames.push(frame);
      openStack.push(frame);
      depth = frame.depth;
    }

    // --- non-frame events we surface directly ------------------------------
    if (event === 'USER_DEBUG') {
      userDebug.push({
        index,
        nanos,
        level: fields[1] ?? 'DEBUG',
        message: fields.slice(2).join('|'),
        sourceLine: parseSourceLine(fields[0]),
      });
    } else if (event === 'EXCEPTION_THROWN' || event === 'FATAL_ERROR') {
      const hasMarker = SOURCE_LINE_MARKER.test(fields[0] ?? '');
      const stack: string[] = [];
      errors.push({
        index,
        nanos,
        kind: event,
        message: (hasMarker ? fields.slice(1) : fields).join('|').trim(),
        sourceLine: parseSourceLine(fields[0]),
        stack,
      });
      currentError = { stack };
    } else if (event === 'CUMULATIVE_LIMIT_USAGE') {
      inCumulativeBlock = true;
    } else if (event === 'CUMULATIVE_LIMIT_USAGE_END') {
      inCumulativeBlock = false;
    } else if (event === 'LIMIT_USAGE_FOR_NS') {
      currentLimitNamespace = fields[0] ?? '(default)';
      currentLimitSource = inCumulativeBlock ? 'CUMULATIVE_LIMIT_USAGE' : 'LIMIT_USAGE_FOR_NS';
    } else if (event === 'LIMIT_USAGE') {
      // Older single-line form: `LIMIT_USAGE|[26]|SOQL|1|100`.
      const resource = fields[1];
      const used = Number(fields[2]);
      const allowed = Number(fields[3]);
      if (resource !== undefined && Number.isFinite(used) && Number.isFinite(allowed)) {
        limits.push({
          namespace: '(default)',
          resource,
          metric: resource,
          used,
          allowed,
          exceeded: used > allowed,
          source: 'LIMIT_USAGE',
        });
      }
    }

    events.push({
      index,
      line: li + 1,
      timestamp: m[1] ?? null,
      nanos,
      event,
      fields,
      sourceLine: parseSourceLine(fields[0]),
      depth,
      continuation,
    });
  }

  const firstNanos = events.find((e) => e.nanos !== null)?.nanos ?? null;
  let lastNanos: number | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const n = events[i]?.nanos;
    if (n !== undefined && n !== null) {
      lastNanos = n;
      break;
    }
  }

  const frozenFrames: DebugLogFrame[] = frames.map((f) => ({
    id: f.id,
    parentId: f.parentId,
    kind: f.kind,
    name: f.name,
    codeUnitKind: f.codeUnitKind,
    depth: f.depth,
    startNanos: f.startNanos,
    endNanos: f.endNanos,
    durationNanos:
      f.startNanos !== null && f.endNanos !== null ? f.endNanos - f.startNanos : null,
    startIndex: f.startIndex,
    endIndex: f.endIndex,
    unpaired: f.unpaired,
    childIds: f.childIds,
    detail: f.detail,
  }));

  return {
    isDebugLog: events.length > 0,
    header,
    events,
    frames: frozenFrames,
    limits,
    truncation: {
      truncated: skipMarkers.length > 0 || maximumSizeReached,
      maximumSizeReached,
      skippedBytes,
      markers: skipMarkers,
    },
    userDebug,
    errors,
    eventCounts,
    firstNanos,
    lastNanos,
    // A negative span is not a duration. If the last offset precedes the first
    // — merged transactions, or offsets that restarted — the elapsed time is
    // UNKNOWN, not a negative number carrying a footnote.
    elapsedNanos:
      firstNanos !== null && lastNanos !== null && lastNanos >= firstNanos
        ? lastNanos - firstNanos
        : null,
    physicalLines: physicalLines.length,
    parseCaveats: pushCaveatCounts(),
  };
};

// ---------------------------------------------------------------------------
// Projection helpers (still pure — the MCP layer adds vault resolution)
// ---------------------------------------------------------------------------

/** Frame kinds whose wall time is DB or network wait, not Apex CPU. */
export const NON_CPU_FRAME_KINDS: readonly DebugLogFrameKind[] = Object.freeze([
  'soql',
  'sosl',
  'dml',
  'callout',
] as const);

/**
 * Wall nanoseconds spent inside a frame but NOT inside any of its children —
 * the frame's own contribution to the timeline.
 *
 * Children with an unknown duration (`unpaired`) contribute 0, so `selfNanos`
 * OVERSTATES a truncated frame's own cost. Callers must disclose that rather
 * than presenting the number as exact.
 */
export const frameSelfNanos = (
  frame: DebugLogFrame,
  byId: ReadonlyMap<number, DebugLogFrame>,
): number | null => {
  if (frame.durationNanos === null) return null;
  let childSum = 0;
  for (const id of frame.childIds) {
    childSum += byId.get(id)?.durationNanos ?? 0;
  }
  return Math.max(0, frame.durationNanos - childSum);
};

/**
 * Sum the wall duration of every DESCENDANT frame of the given kinds — used to
 * subtract database and callout wait from a code unit's wall time so the
 * remainder can be described as CPU-ish. Unpaired descendants contribute 0 and
 * are counted separately so the caller can disclose the shortfall.
 */
export const descendantNanosByKind = (
  frame: DebugLogFrame,
  byId: ReadonlyMap<number, DebugLogFrame>,
  kinds: readonly DebugLogFrameKind[],
): { readonly nanos: number; readonly count: number; readonly unpairedCount: number } => {
  const want = new Set(kinds);
  let nanos = 0;
  let count = 0;
  let unpairedCount = 0;
  // OUTERMOST-ONLY for the time sum. A span of a wanted kind nested inside
  // another span of a wanted kind is ALREADY INSIDE its ancestor's wall time,
  // so adding both double counts. The commonest Apex shape hits this — a DML
  // that fires a trigger that does its own DML — and the sum then exceeds the
  // unit that contains it: measured 184 ms of DML inside a 96 ms unit, and on
  // a real 1 MB log 8,054 ms of DML inside a 7,948 ms unit. The caller
  // subtracts this from wall time to estimate CPU, so the overshoot drove
  // cpuEstimateMs negative and it was silently clamped to 0 — an 8-second
  // transaction reporting zero CPU. `count` still counts EVERY span, because
  // "how many DML statements ran" is a different question from "how much wall
  // time did they occupy".
  const walk = (id: number, insideWanted: boolean): void => {
    const f = byId.get(id);
    if (f === undefined) return;
    const matches = want.has(f.kind);
    if (matches) {
      count += 1;
      if (f.durationNanos === null) unpairedCount += 1;
      else if (!insideWanted) nanos += f.durationNanos;
    }
    for (const child of f.childIds) walk(child, insideWanted || matches);
  };
  for (const child of frame.childIds) walk(child, false);
  return { nanos, count, unpairedCount };
};

/** Index frames by id — every projection helper needs this map. */
export const indexFrames = (
  frames: readonly DebugLogFrame[],
): ReadonlyMap<number, DebugLogFrame> => new Map(frames.map((f) => [f.id, f] as const));
