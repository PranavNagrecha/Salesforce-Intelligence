/**
 * Handler for the `sfi.explain_debug_log` MCP tool (Finding #40).
 *
 * The cheapest RUNTIME-tier wedge: given a pasted Apex DEBUG LOG, a flow fault
 * text, or a governor-limit exception, resolve the referenced components back to
 * the vault graph — with ZERO org access. Where `sfi.explain_error` decodes a
 * SAVE-time error banner (a validation rule, a duplicate rule, an addError) back
 * to the rule that rejected the write, THIS tool decodes a DEVELOPER debug log
 * and a RUNTIME governor-limit exception (`System.LimitException: Too many SOQL
 * queries: 101`, `Apex CPU time limit exceeded`, a `FATAL_ERROR|…` frame) back to
 * the Apex class / trigger / flow that ran — and, when a governor limit fired,
 * cross-references the vault's OWN static `governor_limit_risks` scan so the log
 * lands on the specific `soql-in-loop` / `dml-in-loop` finding that most likely
 * produced it.
 *
 * REUSE: the pasted-error sub-parsers are SHARED from `explain-error.ts`
 * (`parseApexStackFrame`, `parseFlowFault`, `detectStatusCode`, the
 * `STATUS_CODE_TAXONOMY`) — not duplicated. The governor-limit cross-reference
 * calls `governorLimitRisksHandler` directly (the same static engine
 * `sfi.governor_limit_risks` exposes), so there is one source of truth for the
 * loop-risk taxonomy.
 *
 * Input: `{ logText: string, object?: string }`. `object` is an OPTIONAL
 * narrowing hint (the SObject the transaction was on) used only to disambiguate
 * a flow/status cross-reference — the log itself is the primary signal.
 *
 * Strategies, each candidate carrying its OWN confidence + a `why`:
 *   1. APEX IDENTITY — every Apex class / trigger named in the log (stack-trace
 *      frames `Class.X.method: line N` / `Trigger.Y: line N`, debug-log
 *      `CODE_UNIT_STARTED` / `METHOD_ENTRY` event lines, `__sfdc_trigger/Y`
 *      markers) is resolved to a real `ApexClass:` / `ApexTrigger:` node
 *      (`declared` — the log names it). The offending LINE is not resolvable
 *      offline (disclosed). Unresolved names (managed / not-retrieved) are
 *      reported, never fabricated.
 *   2. GOVERNOR LIMIT — a runtime `System.LimitException` (or a bare
 *      `Too many … : N` / CPU / heap signature, or a `LIMIT_USAGE` block that
 *      exceeded) is classified to a limit TYPE, then cross-referenced against
 *      `governor_limit_risks`: for each resolved Apex class in the log, the
 *      static loop-risk findings on it are surfaced, with the ones whose rule
 *      maps to the fired limit (`soql-in-loop` for a SOQL limit, `dml-in-loop`
 *      for a DML limit) ranked first. This is a HEURISTIC correlation — the
 *      static scan is where the limit MOST LIKELY came from, not a runtime proof.
 *      The cross-reference is SCOPED per resolved class (`componentId`), not a
 *      bare org-wide call: the org-wide audit is PAGED at 100 classes, so
 *      reading page 1 and then asserting "the Apex named in the log has no
 *      static loop finding" was a confidently wrong affirmative for class #101+.
 *   3. FLOW FAULT — a fault shape embedded in the log ("Flow API Name: Y") is
 *      resolved to a real `Flow:` node (`declared`), mirroring `explain_error`.
 *   4. STATUS CODE — a recognized REST/API status code is explained at the
 *      CATEGORY level (never a specific match), reusing the shared taxonomy.
 *
 * FAIL CLOSED: nothing resolves → disposition `none` with `triedStrategies` +
 * concrete `nextSteps` (e.g. `sfi.governor_limit_risks`, `sfi.call_graph`) — a
 * source is NEVER fabricated. Several confident sources → `ambiguous` with
 * ranked candidates, mirroring `sfi.resolve`'s disposition contract.
 *
 * SIBLING: `sfi.trace_debug_log` reads the SAME pasted text as an ORDERED EVENT
 * STREAM (timeline, time attribution, automation firing order, per-phase
 * consumption, the CUMULATIVE_LIMIT_USAGE table). This tool answers "WHICH
 * COMPONENT"; that one answers "WHAT HAPPENED, in what order, at what cost".
 *
 * Honesty axis: resolving a NAME to a node is `declared`; correlating a runtime
 * limit to a static loop-risk finding is `heuristic` (the limit can come from a
 * caller, a called static method, or dynamic SOQL the scanner cannot see). Every
 * response carries a verbatim `disclosure` and byte-budgeted candidate list.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  detectStatusCode,
  parseApexStackFrame,
  parseFlowFault,
  STATUS_CODE_TAXONOMY,
} from './explain-error.js';
import {
  governorLimitRisksHandler,
  type GovernorLimitRiskFinding,
} from './governor-limit-risks.js';
import { mergeInputAliases } from './input-aliases.js';

/** Byte-budget guard: the candidate list is capped, with a `truncated` flag. */
const MAX_CANDIDATES = 25;

/** Cap on the number of Apex identifiers harvested from one (large) log. */
const MAX_IDENTIFIERS = 50;

/** Cap on the number of cross-referenced governor-risk classes surfaced. */
const MAX_RISK_CLASSES = 25;

/** Verbatim honesty disclosure, surfaced on every response. */
const EXPLAIN_DEBUG_LOG_DISCLOSURE =
  "This decodes a pasted Apex debug log / flow fault / governor-limit exception back to the org component that ran — offline string matching against declared metadata + the vault's OWN static governor-risk scan, NOT a runtime trace. Resolving a NAMED class/trigger/flow to a node is `declared`; correlating a fired governor limit to a static soql/dml-in-loop finding is `heuristic` (the limit can come from a caller, a called static method, or dynamic SOQL the scanner can't see). disposition 'matched' = one confident source; 'ambiguous' = several, confirm before acting; 'none' = nothing resolved (a recognized limit/status code still explains the CATEGORY). The offending LINE is never resolvable offline. Verify the candidate's canonical id before acting.";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const explainDebugLogInputBaseSchema = z.object({
  logText: z.string().min(1),
  /** Optional SObject narrowing hint (the object the transaction was on). */
  object: z.string().min(1).optional(),
});

/**
 * `sfi.explain_debug_log` input. A router / host that pasted the log naturally
 * reaches for `debugLog` / `log` / `text` / `content` instead of the canonical
 * `logText` (EXPLAIN-DEBUG-LOG-REJECTS-TEXT-ALIAS). Those are merged into
 * `logText` before validation via the shared alias normalizer (precedence:
 * canonical `logText` wins, then `debugLog`, `log`, `text`, `content`). A call
 * that already carries `logText` is byte-identical to the pre-alias contract
 * (the merge is a no-op when the canonical is present); a call with NO log text
 * at all still fails closed with the named `logText: Required` `invalid-query`.
 */
export const explainDebugLogInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [
      { canonical: 'logText', aliases: ['debugLog', 'log', 'text', 'content'] },
    ]),
  explainDebugLogInputBaseSchema,
);

export type ExplainDebugLogInput = z.infer<typeof explainDebugLogInputSchema>;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ExplainDebugLogStrategy = 'apex' | 'governor-limit' | 'flow-fault';

/** Mirrors `sfi.resolve`'s three-way disposition (single / several / none). */
export type ExplainDebugLogDisposition = 'matched' | 'ambiguous' | 'none';

/** The recognized SHAPE of the pasted text (headline classification). */
export type DebugLogKind =
  | 'debug-log'
  | 'governor-limit'
  | 'flow-fault'
  | 'apex-stack'
  | 'unknown';

/**
 * Runtime governor-limit TYPES. Each maps (where a static rule exists) to the
 * `governor_limit_risks` rule most likely to have produced it.
 */
export type GovernorLimitType =
  | 'soql'
  | 'query-rows'
  | 'dml'
  | 'dml-rows'
  | 'cpu'
  | 'heap'
  | 'callouts'
  | 'future-calls'
  | 'email-invocations'
  | 'stack-depth'
  | 'other';

/** One ranked candidate source for the pasted log. */
export interface ExplainDebugLogCandidate {
  readonly strategy: ExplainDebugLogStrategy;
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly label: string | null;
  /** The SObject the component belongs to, when applicable. */
  readonly objectApiName: string | null;
  readonly confidence: 'declared' | 'heuristic';
  /** Human explanation of WHY this component is the candidate source. */
  readonly why: string;
  /** Strategy-specific extras (frame/line, governor risks, flow element, …). */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A parsed runtime governor-limit signature. */
export interface DetectedGovernorLimit {
  readonly limitType: GovernorLimitType;
  /** Plain-language description of the limit + its documented ceiling. */
  readonly description: string;
  /** The verbatim exception message segment that was recognized. */
  readonly message: string;
  /** The actual usage that tripped the limit, when the log stated it. */
  readonly actual: number | null;
  /** The allowed ceiling, when a `LIMIT_USAGE` block stated it. */
  readonly allowed: number | null;
}

/** One cross-referenced Apex class carrying the static loop-risk findings. */
export interface GovernorRiskClassRef {
  readonly componentId: ComponentId;
  readonly apiName: string;
  /** Findings whose rule maps to the FIRED limit type (ranked first). */
  readonly matchedRisks: readonly GovernorLimitRiskFinding[];
  /** All governor-limit findings on this class (superset of matchedRisks). */
  readonly allRisks: readonly GovernorLimitRiskFinding[];
}

/** The governor-limit cross-reference block (category-level correlation). */
export interface GovernorRiskCrossRef {
  readonly limitType: GovernorLimitType;
  /** `governor_limit_risks` rule ids that map to this limit type (may be []). */
  readonly mappedStaticRules: readonly string[];
  /** Resolved Apex classes from the log that carry a static loop risk. */
  readonly classesWithRisks: readonly GovernorRiskClassRef[];
  /**
   * The Apex components the static engine was ACTUALLY queried for — one scoped
   * `governor_limit_risks` call each. This is the evidence behind an affirmative
   * "no static finding" note: without it, "the Apex named in the log is clean"
   * was a claim about whichever classes happened to land on the engine's first
   * PAGE, not about the classes in the log.
   */
  readonly scannedComponents: readonly ComponentId[];
  /**
   * Present ONLY when non-empty: named Apex components whose scoped scan could
   * not be run, so their governor-risk status is UNKNOWN — never folded into the
   * clean verdict. Absent on the normal path, keeping that response shape lean.
   */
  readonly uncheckedComponents?: readonly ComponentId[];
  /** Honest note when nothing correlated (fail-closed, never fabricated). */
  readonly note: string | null;
}

export interface ExplainDebugLogOutput {
  readonly disposition: ExplainDebugLogDisposition;
  readonly logKind: DebugLogKind;
  /** The classified runtime governor limit, or null. */
  readonly detectedLimit: DetectedGovernorLimit | null;
  /** A recognized REST/API status code (category-level), or null. */
  readonly detectedStatusCode: string | null;
  readonly candidates: readonly ExplainDebugLogCandidate[];
  /** True when more candidates existed than the byte-budget cap. */
  readonly truncated: boolean;
  /** Governor-risk cross-reference when a limit fired, else null. */
  readonly governorRiskCrossRef: GovernorRiskCrossRef | null;
  /** Apex names referenced in the log that resolved to no vault node. */
  readonly unresolvedApex: readonly string[];
  /** Which match strategies were attempted (transparency on a `none` result). */
  readonly triedStrategies: readonly string[];
  /** Concrete follow-ups — always populated. */
  readonly nextSteps: readonly string[];
  /** The TOP candidate's confidence, or 'none' when there is no candidate. */
  readonly confidence: 'declared' | 'heuristic' | 'none';
  readonly disclosure: string;
  readonly boundaries: readonly string[];
}

// ---------------------------------------------------------------------------
// Pure parsers (NEW here; exported for unit tests). The pasted-error parsers
// (parseApexStackFrame / parseFlowFault / detectStatusCode) are REUSED from
// explain-error.ts — not redefined.
// ---------------------------------------------------------------------------

/**
 * Debug-log structure markers — pipe-delimited event tokens the Apex debug log
 * emits, a `HH:MM:SS.mmm (nanos)|` timestamp column, an `APEX_CODE,DEBUG;` log
 * header, or the literal phrase "debug log". None of these appears in a
 * save-error banner, so their presence is a strong "this is a developer debug
 * log" signal.
 */
const DEBUG_LOG_EVENT = new RegExp(
  '\\|(?:CODE_UNIT_STARTED|CODE_UNIT_FINISHED|METHOD_ENTRY|METHOD_EXIT|CONSTRUCTOR_ENTRY|' +
    'EXECUTION_STARTED|EXECUTION_FINISHED|USER_DEBUG|SOQL_EXECUTE_BEGIN|SOQL_EXECUTE_END|' +
    'DML_BEGIN|DML_END|LIMIT_USAGE|LIMIT_USAGE_FOR_NS|CUMULATIVE_LIMIT_USAGE|FATAL_ERROR|' +
    'EXCEPTION_THROWN|HEAP_ALLOCATE|VARIABLE_ASSIGNMENT|STATEMENT_EXECUTE|' +
    'FLOW_START_INTERVIEWS?|FLOW_ELEMENT_BEGIN)\\|',
);

/** True when the pasted text is a developer Apex debug log (vs a bare error). */
export const isDebugLog = (logText: string): boolean =>
  DEBUG_LOG_EVENT.test(logText) ||
  /\b\d{2}:\d{2}:\d{2}\.\d+\s*\(\d+\)\|/.test(logText) ||
  /\bAPEX_CODE,(?:NONE|ERROR|WARN|INFO|DEBUG|FINE|FINER|FINEST)\b/i.test(logText) ||
  /\bdebug log\b/i.test(logText);

/**
 * Classifiers for a runtime governor limit, most-specific first. Each carries a
 * documented ceiling for the plain-language `description`.
 */
// The regex matches the RESOURCE NAME (not only the "Too many …" phrasing) so
// both an exception message (`Too many SOQL queries: 101`) and a `LIMIT_USAGE`
// block resource (`Number of SOQL queries: 101 out of 100`) classify. Ordered
// most-specific first (`dml rows` before `dml statements`, `query rows` before
// the SOQL classifier).
const LIMIT_CLASSIFIERS: readonly {
  readonly re: RegExp;
  readonly type: GovernorLimitType;
  readonly description: string;
}[] = [
  { re: /soql queries/i, type: 'soql', description: 'SOQL queries per transaction (100 synchronous / 200 asynchronous)' },
  { re: /query rows/i, type: 'query-rows', description: 'query rows retrieved per transaction (50,000)' },
  { re: /dml rows/i, type: 'dml-rows', description: 'rows processed by DML per transaction (10,000)' },
  { re: /dml statements/i, type: 'dml', description: 'DML statements per transaction (150)' },
  { re: /(?:apex )?cpu time/i, type: 'cpu', description: 'Apex CPU time per transaction (10s synchronous / 60s asynchronous)' },
  { re: /heap size/i, type: 'heap', description: 'Apex heap size per transaction (6MB synchronous / 12MB asynchronous)' },
  { re: /callouts/i, type: 'callouts', description: 'callouts per transaction (100)' },
  { re: /future calls/i, type: 'future-calls', description: 'future method invocations per transaction (50)' },
  { re: /email invocations/i, type: 'email-invocations', description: 'email invocations per transaction (10)' },
  { re: /(?:trigger|stack) depth/i, type: 'stack-depth', description: 'maximum trigger / recursion depth (16)' },
];

/**
 * Parse a runtime governor-limit signature. Recognizes a `System.LimitException`
 * message, a bare `Too many … : N`, a CPU/heap signature, or an exceeding
 * `LIMIT_USAGE` block (`Number of SOQL queries: 101 out of 100`). Returns null
 * when no governor-limit signal is present.
 */
export const parseGovernorLimit = (logText: string): DetectedGovernorLimit | null => {
  const limEx = logText.match(/System\.LimitException:\s*([^\r\n|]+)/i);
  const tooMany = logText.match(/\bToo many [A-Za-z ]+?:\s*\d+/i);
  const cpuHeap = logText.match(
    /(?:Apex )?CPU time limit exceeded|Maximum CPU time exceeded|Apex heap size too large/i,
  );
  // A LIMIT_USAGE row where usage exceeded the ceiling ("101 out of 100").
  let exceededUsage: RegExpMatchArray | null = null;
  for (const m of logText.matchAll(
    /Number of ([A-Za-z ]+?):\s*(\d+)\s+out of\s+(\d+)/gi,
  )) {
    if (Number(m[2]) > Number(m[3])) {
      exceededUsage = m;
      break;
    }
  }

  const message =
    limEx?.[1]?.trim() ??
    tooMany?.[0]?.trim() ??
    cpuHeap?.[0]?.trim() ??
    (exceededUsage !== null
      ? `Number of ${exceededUsage[1]?.trim()}: ${exceededUsage[2]} out of ${exceededUsage[3]}`
      : null);
  if (message === null) return null;

  // Classify from the recognized message first, then fall back to the log.
  let type: GovernorLimitType = 'other';
  let description = 'a governor limit';
  for (const c of LIMIT_CLASSIFIERS) {
    if (c.re.test(message)) {
      type = c.type;
      description = c.description;
      break;
    }
  }
  if (type === 'other') {
    const hay = exceededUsage?.[1] ?? logText;
    for (const c of LIMIT_CLASSIFIERS) {
      if (c.re.test(hay)) {
        type = c.type;
        description = c.description;
        break;
      }
    }
  }

  let actual: number | null = null;
  let allowed: number | null = null;
  if (exceededUsage !== null) {
    actual = Number(exceededUsage[2]);
    allowed = Number(exceededUsage[3]);
  } else {
    const colonNum = message.match(/:\s*(\d+)\s*$/);
    if (colonNum) actual = Number(colonNum[1]);
  }
  return { limitType: type, description, message, actual, allowed };
};

/** A parsed Apex identity (class or trigger) referenced by the log. */
export interface ApexIdentifier {
  readonly kind: 'ApexClass' | 'ApexTrigger';
  readonly name: string;
}

const VALID_APEX_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Harvest the DISTINCT, high-signal Apex class / trigger identities a debug log
 * references, in appearance order:
 *   - stack-trace frames  `Class.Foo.bar` → ApexClass Foo, `Trigger.Foo` → Foo
 *   - `__sfdc_trigger/Foo` markers → ApexTrigger Foo
 *   - `CODE_UNIT_STARTED` trigger units `Foo on Account trigger event …`
 *   - `CODE_UNIT_STARTED` apex units    `…|Foo.bar()` → ApexClass Foo
 * Only these high-precision sources are used (not every `x.y()` method call), so
 * the unresolved list stays honest. Reuse `parseApexStackFrame` for the PRIMARY
 * frame's line/method; this widens it to EVERY frame in a multi-line trace.
 */
export const collectApexIdentifiers = (
  logText: string,
  max: number = MAX_IDENTIFIERS,
): ApexIdentifier[] => {
  const seen = new Set<string>();
  const out: ApexIdentifier[] = [];
  const add = (kind: 'ApexClass' | 'ApexTrigger', name: string | undefined): void => {
    if (name === undefined || !VALID_APEX_NAME.test(name)) return;
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (out.length < max) out.push({ kind, name });
  };
  for (const m of logText.matchAll(/\bClass\.([A-Za-z][A-Za-z0-9_]*)\./g)) add('ApexClass', m[1]);
  for (const m of logText.matchAll(/\bTrigger\.([A-Za-z][A-Za-z0-9_]*)\b/g)) add('ApexTrigger', m[1]);
  for (const m of logText.matchAll(/__sfdc_trigger\/([A-Za-z][A-Za-z0-9_]*)/g)) add('ApexTrigger', m[1]);
  for (const m of logText.matchAll(
    /\bCODE_UNIT_STARTED\b[^\r\n]*?\|([A-Za-z][A-Za-z0-9_]*)\s+on\s+\w+\s+trigger\s+event/gi,
  )) {
    add('ApexTrigger', m[1]);
  }
  for (const m of logText.matchAll(
    /\bCODE_UNIT_STARTED\b[^\r\n]*?\|([A-Za-z][A-Za-z0-9_]*)\.[A-Za-z][A-Za-z0-9_]*\s*\(/gi,
  )) {
    add('ApexClass', m[1]);
  }
  // METHOD_ENTRY / METHOD_EXIT event units (`METHOD_ENTRY|[1]|<id>|Foo.bar(…)`).
  // Without these, a class that appears ONLY as a called method — the common
  // case for a helper the stack trace never reaches — was invisible, so a log
  // naming a class absent from the vault returned `unresolvedApex: []`, i.e. a
  // false "everything in this log resolved". The leftmost segment is taken
  // because `Outer.Inner.method()` is one ApexClass component, not two.
  for (const m of logText.matchAll(
    /\bMETHOD_(?:ENTRY|EXIT)\b[^\r\n]*?\|([A-Za-z][A-Za-z0-9_]*)(?:\.[A-Za-z][A-Za-z0-9_]*)+\s*\(/gi,
  )) {
    add('ApexClass', m[1]);
  }
  return out;
};

/**
 * Ceiling on how many component ids a cross-reference note NAMES inline. The
 * COUNT is always exact and `scannedComponents` always carries the full list;
 * only the prose is bounded, so a 50-frame stack cannot bloat the note.
 */
const MAX_NAMED_SCANNED = 5;

/** Comma-joined id list, capped, with an honest "and N more" tail. */
const namedList = (ids: readonly ComponentId[]): string => {
  const head = ids.slice(0, MAX_NAMED_SCANNED).join(', ');
  const rest = ids.length - Math.min(ids.length, MAX_NAMED_SCANNED);
  return rest > 0 ? `${head}, and ${rest.toString()} more` : head;
};

/**
 * Subject phrase for an affirmative cross-reference note: names WHICH components
 * the clean verdict covers. The old wording ("The Apex named in the log") named
 * nothing, so a reader could not tell whether the scan had actually reached the
 * class they cared about.
 */
const describeScanned = (ids: readonly ComponentId[]): string =>
  ids.length === 1
    ? `The Apex named in the log (${ids[0] as string})`
    : `Each of the ${ids.length.toString()} Apex component(s) named in the log (${namedList(ids)})`;

/** `governor_limit_risks` rule ids each limit type maps to (may be empty). */
const LIMIT_TO_STATIC_RULES: Readonly<Record<GovernorLimitType, readonly string[]>> =
  Object.freeze({
    soql: ['soql-in-loop'],
    'query-rows': ['soql-in-loop'],
    dml: ['dml-in-loop', 'database-upsert-no-options'],
    'dml-rows': ['dml-in-loop', 'database-upsert-no-options'],
    // CPU is frequently burned by the same loop patterns — related, not exact.
    cpu: ['soql-in-loop', 'dml-in-loop'],
    heap: [],
    callouts: [],
    'future-calls': [],
    'email-invocations': [],
    'stack-depth': [],
    other: [],
  });

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * The `sfi.explain_debug_log` MCP tool. Decodes a pasted Apex debug log / flow
 * fault / governor-limit exception to the org component that ran. See module
 * JSDoc for the ranked strategies, the governor-risk cross-reference, the
 * fail-closed contract, and the honesty disclosure.
 *
 * @example
 *   const r = await explainDebugLogHandler(ctx, {
 *     logText:
 *       'FATAL_ERROR|System.LimitException: Too many SOQL queries: 101\n' +
 *       'Class.AccountHandler.recalc: line 42, column 1',
 *   });
 *   if (r.ok && r.value.data.disposition !== 'none')
 *     use(r.value.data.candidates[0].componentId);
 */
export const explainDebugLogHandler = async (
  ctx: Context,
  input: ExplainDebugLogInput,
): Promise<Result<McpResponse<ExplainDebugLogOutput>, McpError>> => {
  const logText = input.logText;

  const detectedLimit = parseGovernorLimit(logText);
  const detectedStatusCode = detectStatusCode(logText);
  const flowParsed = parseFlowFault(logText);
  const apexFrame = parseApexStackFrame(logText);
  const identifiers = collectApexIdentifiers(logText);

  const candidates: ExplainDebugLogCandidate[] = [];
  const tried: string[] = [];
  const boundaries: string[] = [];
  const nextSteps: string[] = [];
  const unresolvedApex: string[] = [];

  // Strategy 1 — resolve every Apex class / trigger named in the log.
  const resolvedApexIds: ComponentId[] = [];
  if (identifiers.length > 0) {
    tried.push('apex (class/trigger identity resolution over debug-log frames + event units)');
    for (const idn of identifiers) {
      const id = `${idn.kind}:${idn.name}` as ComponentId;
      const nodeR = await getNodeById(ctx.graph, id);
      if (!nodeR.ok) return err({ kind: 'internal', message: nodeR.error.message });
      if (nodeR.value === null) {
        unresolvedApex.push(id);
        continue;
      }
      const node = nodeR.value;
      resolvedApexIds.push(node.id);
      const isPrimary =
        (idn.kind === 'ApexClass' && apexFrame?.className === idn.name) ||
        (idn.kind === 'ApexTrigger' && apexFrame?.triggerName === idn.name);
      candidates.push({
        strategy: 'apex',
        componentId: node.id,
        type: node.type,
        apiName: node.apiName,
        label: node.label,
        objectApiName:
          typeof node.properties['triggerObject'] === 'string'
            ? (node.properties['triggerObject'] as string)
            : null,
        confidence: 'declared',
        why:
          `Named in the debug log as ${idn.kind === 'ApexTrigger' ? 'a trigger' : 'a class'} that ran` +
          (isPrimary && apexFrame?.line !== null && apexFrame?.line !== undefined
            ? ` (top stack frame, line ${apexFrame.line} — the exact line/logic is not resolvable offline).`
            : '. The exact line/logic that ran is not resolvable offline.'),
        detail: {
          ...(isPrimary
            ? { line: apexFrame?.line ?? null, method: apexFrame?.methodName ?? null, primaryFrame: true }
            : {}),
        },
      });
    }
  }
  if (unresolvedApex.length > 0) {
    boundaries.push(
      `Named in the log but not in this vault (managed / not-retrieved / renamed): ${unresolvedApex.join(', ')}. Not fabricating a match.`,
    );
  }

  // Strategy 2 — governor-limit cross-reference against the static risk scan.
  let governorRiskCrossRef: GovernorRiskCrossRef | null = null;
  if (detectedLimit !== null) {
    tried.push('governor-limit (classify runtime limit + cross-reference governor_limit_risks)');
    const mappedStaticRules = LIMIT_TO_STATIC_RULES[detectedLimit.limitType];
    const classesWithRisks: GovernorRiskClassRef[] = [];
    // The scan LEDGER: which named components the static engine was actually
    // asked about, and which could not be asked. An affirmative "clean" note is
    // only emitted over `scannedApexIds`, and only when `uncheckedApexIds` is
    // empty — otherwise the note names the gap instead of asserting clean.
    const scannedApexIds: ComponentId[] = [];
    const uncheckedApexIds: ComponentId[] = [];
    let note: string | null = null;

    if (resolvedApexIds.length === 0) {
      note =
        'No Apex class from the log resolved to a vault node, so the fired limit could not be pinned to a specific static finding — run sfi.governor_limit_risks for the org-wide loop-risk scan, or paste the full stack trace so the running class is named.';
    } else {
      // MERGE NOTE: both branches independently fixed the page-1 clean
      // verdict. This side is kept because it has NO silent cap and it
      // records a scan that could not run as UNKNOWN; the other capped at 25
      // resolved classes and skipped errors, which reintroduces the same
      // 'affirmative produced by not looking' at a lower threshold.
      // EXPLAIN-DEBUG-LOG-CLEAN-VERDICT-FROM-PAGE-ONE: this used to call
      // `governorLimitRisksHandler(ctx, {})` — the ORG-WIDE mode, whose `classes`
      // array is a PAGE (default limit 100) and whose `truncated` / `nextOffset`
      // / `nextCursor` were never read. A class named in the log that sorted past
      // the page boundary was simply absent from the lookup, and the handler
      // then emitted the affirmative "has no static soql/dml-in-loop finding" —
      // a confident clean verdict produced by not looking. Ask the engine about
      // exactly the components the log names instead, one SCOPED call each: a
      // scoped call returns at most that one class, so there is no page to fall
      // off, and it is also cheaper than the org-wide scan it replaces.
      const mapped = new Set(mappedStaticRules);
      for (const id of resolvedApexIds) {
        const scoped = await governorLimitRisksHandler(ctx, { componentId: id });
        if (!scoped.ok) {
          // A scan that could not run is NOT a clean result. Record it as
          // UNKNOWN and let the note say so, rather than silently omitting the
          // class and folding it into the affirmative below.
          uncheckedApexIds.push(id);
          continue;
        }
        scannedApexIds.push(id);
        const entry = scoped.value.data.classes.find((c) => c.componentId === id);
        if (entry === undefined || entry.risks.length === 0) continue;
        const matchedRisks = entry.risks.filter((r) => mapped.has(r.rule));
        classesWithRisks.push({
          componentId: entry.componentId,
          apiName: entry.apiName,
          matchedRisks,
          allRisks: entry.risks,
        });
        if (classesWithRisks.length >= MAX_RISK_CLASSES) break;
      }
      // Re-rank the apex candidates: classes carrying a MATCHED loop-risk for the
      // fired limit float up (they are the most likely runtime source).
      const matchedIds = new Set(
        classesWithRisks.filter((c) => c.matchedRisks.length > 0).map((c) => c.componentId),
      );
      for (const c of candidates) {
        if (c.strategy === 'apex' && matchedIds.has(c.componentId)) {
          const cls = classesWithRisks.find((x) => x.componentId === c.componentId)!;
          (c as { confidence: 'declared' | 'heuristic' }).confidence = 'declared';
          (c as { detail: Record<string, unknown> }).detail = {
            ...c.detail,
            governorRisks: cls.matchedRisks,
            firedLimit: detectedLimit.limitType,
          };
          (c as { why: string }).why =
            `${c.why} It carries a static ${cls.matchedRisks.map((r) => r.rule).join(' / ')} finding that maps to the fired "${detectedLimit.description}" limit — the most likely runtime source (HEURISTIC correlation).`;
        }
      }
      if (classesWithRisks.length === 0) {
        note =
          uncheckedApexIds.length > 0
            ? `${describeScanned(scannedApexIds)} carries no static soql/dml-in-loop finding, but ${uncheckedApexIds.length.toString()} further named component(s) could NOT be scanned (${namedList(uncheckedApexIds)}) — their static risk is UNKNOWN, not clean. Re-run sfi.governor_limit_risks on those ids directly.`
            : `${describeScanned(scannedApexIds)} carries no static soql/dml-in-loop finding — each was queried INDIVIDUALLY against the static engine (per-component scope, not a page of an org-wide list). The limit may still come from a caller, a called static method, or dynamic SOQL (Database.query) the static scanner cannot see. Walk the callers with sfi.call_graph.`;
      } else if (matchedIds.size === 0) {
        note = `The named Apex carries governor-risk findings, but none maps to the fired "${detectedLimit.limitType}" limit specifically — see allRisks for the full set.`;
      }
    }
    if (mappedStaticRules.length === 0 && note === null) {
      note = `The "${detectedLimit.limitType}" limit has no directly-mapped static loop rule in governor_limit_risks (which models soql-in-loop / dml-in-loop / database-upsert-no-options) — the resolved class findings, if any, are shown as related context.`;
    }
    governorRiskCrossRef = {
      limitType: detectedLimit.limitType,
      mappedStaticRules,
      classesWithRisks,
      scannedComponents: scannedApexIds,
      ...(uncheckedApexIds.length > 0
        ? { uncheckedComponents: uncheckedApexIds }
        : {}),
      note,
    };
  }

  // Strategy 3 — flow fault embedded in the log.
  if (flowParsed !== null && flowParsed.flowApiName !== null) {
    tried.push('flow-fault (Flow API Name resolution)');
    const flowId = `Flow:${flowParsed.flowApiName}` as ComponentId;
    const nodeR = await getNodeById(ctx.graph, flowId);
    if (!nodeR.ok) return err({ kind: 'internal', message: nodeR.error.message });
    if (nodeR.value === null) {
      boundaries.push(
        `The log names Flow "${flowParsed.flowApiName}", but no such Flow is in this vault (managed / not-retrieved / renamed). Not fabricating a match.`,
      );
    } else {
      const node = nodeR.value;
      candidates.push({
        strategy: 'flow-fault',
        componentId: node.id,
        type: node.type,
        apiName: node.apiName,
        label: node.label,
        objectApiName:
          typeof node.properties['triggerObject'] === 'string'
            ? (node.properties['triggerObject'] as string)
            : null,
        confidence: 'declared',
        why: `A flow fault in the log names this flow by API name.${flowParsed.elementName !== null ? ` Element "${flowParsed.elementName}" is echoed from the log; flow elements are not separate graph nodes offline.` : ''}`,
        detail: { elementName: flowParsed.elementName },
      });
    }
  } else if (flowParsed !== null && flowParsed.elementName !== null) {
    tried.push('flow-fault (Flow API Name resolution)');
    boundaries.push(
      `A flow fault at element "${flowParsed.elementName}" was recognized, but no "Flow API Name:" was present to resolve the flow — paste the "Flow API Name" line.`,
    );
  }

  // Strategy 4 — status-code taxonomy (category-level, never a specific match).
  if (detectedStatusCode !== null) {
    tried.push('status-code taxonomy (category-level classification)');
  }
  const categoryExplanation =
    detectedStatusCode !== null ? STATUS_CODE_TAXONOMY[detectedStatusCode] : undefined;

  // Rank: declared before heuristic, apex before flow, then id ASC.
  const STRATEGY_RANK: Readonly<Record<ExplainDebugLogStrategy, number>> = {
    apex: 3,
    'governor-limit': 2,
    'flow-fault': 1,
  };
  candidates.sort((a, b) => {
    const conf = (b.confidence === 'declared' ? 1 : 0) - (a.confidence === 'declared' ? 1 : 0);
    if (conf !== 0) return conf;
    // Classes with a matched governor risk sort ahead of plain apex candidates.
    const aMatched = 'governorRisks' in a.detail ? 1 : 0;
    const bMatched = 'governorRisks' in b.detail ? 1 : 0;
    if (aMatched !== bMatched) return bMatched - aMatched;
    const strat = STRATEGY_RANK[b.strategy] - STRATEGY_RANK[a.strategy];
    if (strat !== 0) return strat;
    return a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0;
  });

  const truncated = candidates.length > MAX_CANDIDATES;
  const page = candidates.slice(0, MAX_CANDIDATES);

  // Disposition — mirror sfi.resolve. One resolved source = matched; several
  // equally-strong = ambiguous; nothing resolved = none.
  const declaredCount = page.filter((c) => c.confidence === 'declared').length;
  let disposition: ExplainDebugLogDisposition;
  if (page.length === 0) disposition = 'none';
  else if (page.length === 1) disposition = 'matched';
  else if (declaredCount > 1) disposition = 'ambiguous';
  else disposition = 'matched';

  // Log kind — the headline classification (structured debug log wins).
  const logKind: DebugLogKind = isDebugLog(logText)
    ? 'debug-log'
    : detectedLimit !== null
      ? 'governor-limit'
      : flowParsed !== null
        ? 'flow-fault'
        : apexFrame !== null
          ? 'apex-stack'
          : 'unknown';

  // Next steps — always actionable; fail-closed guidance on `none`.
  if (disposition === 'none') {
    if (detectedLimit !== null) {
      nextSteps.push(
        'Run sfi.governor_limit_risks for the org-wide static loop-risk scan, then sfi.call_graph on the suspect entry point.',
      );
    }
    nextSteps.push(
      'Paste the FULL stack trace (the `Class.X.method: line N` frames after the FATAL_ERROR line) so the running class/trigger can be named and resolved.',
    );
    if (input.object !== undefined) {
      nextSteps.push(
        `sfi.what_happens_on_save on CustomObject:${input.object} enumerates the triggers/flows that run on that object.`,
      );
    }
  } else {
    nextSteps.push(
      'Confirm the candidate id, then use sfi.explain_apex_method / sfi.explain_flow / sfi.get_component to see the logic behind it.',
    );
    if (isDebugLog(logText)) {
      nextSteps.push(
        'sfi.trace_debug_log reads this SAME log as an event stream: execution timeline, where the time went (database and callout wait subtracted), which automation fired in what order, per-phase consumption, and the CUMULATIVE_LIMIT_USAGE actual/allowed table.',
      );
    }
    if (detectedLimit !== null) {
      nextSteps.push(
        'sfi.governor_limit_risks shows the full static loop-risk finding (rule + location) for the correlated class; sfi.call_graph traces who calls it.',
      );
    }
  }

  boundaries.push(
    'Debug-log-to-source mapping is offline string matching against declared metadata + the static governor-risk scan, not a runtime execution trace — a candidate is where the log MOST LIKELY came from.',
  );
  if (governorRiskCrossRef !== null && governorRiskCrossRef.classesWithRisks.some((c) => c.matchedRisks.length > 0)) {
    boundaries.push(
      'Correlating a fired governor limit to a static soql/dml-in-loop finding is HEURISTIC — the static scan cannot see SOQL/DML inside a called static method or a dynamic Database.query string, and the limit can be tripped by a caller.',
    );
  }
  if (categoryExplanation !== undefined && page.length === 0) {
    boundaries.push(
      `The status code ${detectedStatusCode} was recognized and explained at the CATEGORY level, but no specific source component resolved.`,
    );
  }

  const topConfidence: 'declared' | 'heuristic' | 'none' =
    page.length === 0 ? 'none' : page[0]!.confidence;

  return ok({
    data: {
      disposition,
      logKind,
      detectedLimit,
      detectedStatusCode,
      candidates: page,
      truncated,
      governorRiskCrossRef,
      unresolvedApex,
      triedStrategies: tried,
      nextSteps,
      confidence: topConfidence,
      disclosure: EXPLAIN_DEBUG_LOG_DISCLOSURE,
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
