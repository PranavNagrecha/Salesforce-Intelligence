/**
 * Handler for the `sfi.explain_error` MCP tool (R6-09).
 *
 * Decodes a pasted Salesforce error string (a save-time
 * FIELD_CUSTOM_VALIDATION_EXCEPTION, a Flow fault email, an Apex stack
 * frame, a duplicate-record alert, or a bare REST/API statusCode) to the
 * org component that produced it — the vault already holds every
 * ValidationRule errorMessage, every Flow, every Apex class/trigger name,
 * and every DuplicateRule; nothing else resolves an error TEXT back to its
 * source node.
 *
 * Input: `{ errorText: string, object?: string }`. `object` is an OPTIONAL
 * narrowing hint (the SObject the save was on); when given it filters the
 * ValidationRule / DuplicateRule candidates to that object and drives the
 * status-code category cross-reference.
 *
 * Match strategies, ranked, each candidate carrying its OWN confidence + a
 * `why` string:
 *   1. Validation rule — the extracted message segment (after
 *      FIELD_CUSTOM_VALIDATION_EXCEPTION, or a bare pasted message) is
 *      compared to every `ValidationRule.errorMessage`. An EXACT (trimmed)
 *      equality is a `declared`-grade hit; a normalized (case/whitespace/
 *      trailing-punct-insensitive) or substring match is weaker (`heuristic`).
 *      Returns the rule id, object, `active` flag, and `errorConditionFormula`.
 *   2. Flow fault — recognizes flow-error email shapes ("An error occurred at
 *      element X", "Flow API Name: Y", "caused by element Z") and resolves the
 *      Flow API name to a real `Flow:` node (`declared` — the flow is named in
 *      the email). The element name is echoed and cross-checked against the
 *      flow's `actionCalls`, but flow ELEMENTS are not separate graph nodes,
 *      so element-level resolution is disclosed as unmodeled, never fabricated.
 *   3. Apex — recognizes stack-frame shapes ("Class.MyClass.myMethod: line N",
 *      "Trigger.MyTrigger: line N", "caused by: System.XException") and
 *      resolves the class / trigger name to a real node (`declared`). The
 *      offending LINE is not resolvable offline — disclosed.
 *   4. Duplicate rules — "duplicate" phrasing (DUPLICATES_DETECTED) plus an
 *      object hint lists the ACTIVE `DuplicateRule` nodes on that object as
 *      candidates (`heuristic`, `listing` — the exact rule that fired is not
 *      in the error text).
 *   5. Status-code taxonomy — recognizes common REST/API statusCodes and
 *      explains the CATEGORY + which org component TYPES can produce it,
 *      clearly labeled category-level (never a specific match). For codes whose
 *      producer is object automation (e.g. CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY)
 *      it cross-references the graph — the triggers/flows declared on the hinted
 *      object — from the `triggersOn` edges.
 *   6. Runtime governor-limit signature — a `System.LimitException`, a bare
 *      `Too many … : N`, a CPU/heap signature, or an exceeding `LIMIT_USAGE`
 *      row is CLASSIFIED (which limit fired, the actual, the ceiling) via the
 *      SHARED `parseGovernorLimit` in `./governor-limit-signature.js` — the
 *      SAME detector `sfi.explain_debug_log` uses, so the two tools cannot
 *      disagree about one string. Category-level like strategy 5: it says
 *      WHICH limit blew, never which component consumed it (a limit is
 *      consumed across the whole transaction). A recognised limit therefore
 *      makes the response `matched`, never `none`, even with zero candidates.
 *
 * NOT MODELLED: the Apex exception hierarchy. A `System.*Exception` other than
 * `LimitException` is recognised as an Apex RUNTIME error and pointed at
 * `sfi.explain_debug_log`; this tool's taxonomy is DML / API status codes plus
 * the governor-limit signatures, and it says so rather than asking the caller
 * to paste again what they already pasted.
 *
 * FAIL CLOSED: no confident source → disposition `none` with what was tried and
 * concrete next steps (e.g. `sfi.what_happens_on_save` on the object) — a source
 * is NEVER fabricated. Several plausible sources → `ambiguous` with ranked
 * candidates, mirroring `sfi.resolve`'s disposition contract.
 *
 * Honesty axis: string matching against validation messages is FUZZY (an org
 * can reuse one message across rules, or edit the message since the error was
 * thrown) — every candidate carries an explicit confidence and the response
 * carries a verbatim `disclosure`. The candidate list is byte-budgeted (capped
 * with a `truncated` flag).
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import { STATUS_CODE_TAXONOMY } from '../knowledge/loader.js';
import type { Context } from '../server.js';

import {
  type DetectedGovernorLimit,
  LIMIT_TO_STATIC_RULES,
  parseGovernorLimit,
} from './governor-limit-signature.js';
import { mergeInputAliases, resolveExistingObjectScope } from './input-aliases.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

/** Byte-budget guard: the candidate list is capped, with a `truncated` flag. */
const MAX_CANDIDATES = 25;

/** Object automation rows cross-referenced for a category-level status code. */
const MAX_OBJECT_AUTOMATION = 25;

/**
 * Min length of a ValidationRule `errorMessage` for it to be eligible for a
 * SUBSTRING match against a bare pasted message — a very short message ("Error",
 * "Invalid") would substring-match half the org and manufacture false positives.
 */
const MIN_SUBSTRING_MESSAGE_LEN = 10;

/** Verbatim honesty disclosure, surfaced on every response. */
const EXPLAIN_ERROR_DISCLOSURE =
  "This maps a pasted error back to the org component that most likely produced it — string matching against declared metadata, NOT a runtime trace. A `declared`-confidence candidate is an EXACT match on a declared name/message; `heuristic` candidates are normalized/substring/listing guesses (an org can reuse one validation message across rules, or edit it since the error fired). disposition 'matched' = one confident source; 'ambiguous' = several plausible, confirm before acting; 'none' = nothing matched confidently. TWO category-level recognizers still explain a paste that matched no source: the REST/API status-code taxonomy (categoryExplanation) and the runtime governor-limit signature (detectedLimit) — the latter is the SAME detector sfi.explain_debug_log uses, so the two tools cannot disagree about one string. Neither names the component that produced the error; both say what CLASS of failure it is. Verify the candidate's canonical id before acting.";

/**
 * Verbatim: what this tool does NOT model, for an Apex runtime exception it
 * cannot resolve. `{name}` is the recognized `System.*Exception`; `{n}` is the
 * LIVE size of the status-code taxonomy, interpolated rather than hard-coded so
 * the sentence cannot rot when the taxonomy grows.
 *
 * It deliberately borrows `action_chain`'s shape — "That is a GAP IN THIS TOOL,
 * not a claim that …" — and it replaces the old advice to paste the full error,
 * which told the caller to paste what they had just pasted.
 */
const apexRuntimeExceptionGap = (exceptionName: string): string =>
  `This is an Apex RUNTIME exception (System.${exceptionName}), not a DML / API status code. This tool's taxonomy covers ${Object.keys(STATUS_CODE_TAXONOMY).length.toString()} DML and API status codes and the runtime governor-limit signatures; it does not model the Apex exception hierarchy. For a runtime failure, sfi.explain_debug_log reads the debug log — stack frames, the fired limit, and the static governor-risk cross-reference. That is a GAP IN THIS TOOL, not a claim that nothing explains your error.`;

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const explainErrorInputBaseSchema = z.object({
  errorText: z.string().min(1),
  /**
   * Optional SObject narrowing hint (the object the save was on). VERIFIED
   * against the vault via `resolveExistingObjectScope` (R4) before it is used
   * — a typo or wrong-case name fails closed with a named `invalid-query`
   * rather than silently reading as "no rule/automation on this object";
   * a hint that differs from the vault only by case is resolved to the
   * vault's exact casing before it filters anything.
   */
  object: z.string().min(1).optional(),
});

/**
 * `sfi.explain_error` input. A router / host that pasted the banner naturally
 * reaches for `error` / `message` / `errorMessage` / `text` instead of the
 * canonical `errorText` (EXPLAIN-ERROR-REJECTS-NATURAL-ALIASES). Those are
 * merged into `errorText` before validation via the shared alias normalizer
 * (precedence: canonical `errorText` wins, then `error`, `message`,
 * `errorMessage`, `text`). A call that already carries `errorText` is
 * byte-identical to the pre-alias contract (the merge is a no-op when the
 * canonical is present); a call with NO error text at all still fails closed
 * with the named `errorText: Required` `invalid-query`.
 */
export const explainErrorInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [
      { canonical: 'errorText', aliases: ['error', 'message', 'errorMessage', 'text'] },
    ]),
  explainErrorInputBaseSchema,
);

export type ExplainErrorInput = z.infer<typeof explainErrorInputSchema>;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ExplainErrorStrategy =
  | 'validation-rule'
  | 'flow-fault'
  | 'apex'
  | 'duplicate-rule';

/** Mirrors `sfi.resolve`'s three-way disposition (single / several / none). */
export type ExplainErrorDisposition = 'matched' | 'ambiguous' | 'none';

export type ExplainErrorMatchKind =
  | 'exact'
  | 'normalized'
  | 'substring'
  | 'name'
  | 'listing';

/** One ranked candidate source for the pasted error. */
export interface ExplainErrorCandidate {
  readonly strategy: ExplainErrorStrategy;
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly label: string | null;
  /** The SObject the component belongs to, when applicable (VR / duplicate). */
  readonly objectApiName: string | null;
  /** Active flag for VR / DuplicateRule; null when the concept doesn't apply. */
  readonly active: boolean | null;
  readonly confidence: 'declared' | 'heuristic';
  readonly matchKind: ExplainErrorMatchKind;
  /** Human explanation of WHY this component is the candidate source. */
  readonly why: string;
  /** Strategy-specific extras (errorConditionFormula, elementName, line, …). */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** A single automation component that CAN produce a category-level status code. */
export interface ObjectAutomationRef {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
}

/** Category-level explanation for a recognized REST/API status code. */
export interface StatusCodeCategory {
  readonly statusCode: string;
  readonly category: string;
  readonly explanation: string;
  /** Component TYPES that can produce this status code (category-level). */
  readonly producedByTypes: readonly string[];
  /** Always true — this is a category, never a specific source match. */
  readonly categoryLevel: true;
  /**
   * When the code's producer is object automation AND an `object` hint was
   * given, the triggers/flows declared on that object (from `triggersOn`).
   * Category-level: any of them COULD have produced it — not a specific match.
   */
  readonly objectAutomation?: readonly ObjectAutomationRef[];
  /**
   * True when more automation was declared on the object than
   * {@link ObjectAutomationRef}'s byte-budget cap could carry — present only
   * alongside `objectAutomation` (R1). A reader must not read a full
   * `objectAutomation` list as the complete cross-reference without checking
   * this flag.
   */
  readonly objectAutomationTruncated?: boolean;
}

export interface ExplainErrorOutput {
  readonly disposition: ExplainErrorDisposition;
  /** The recognized REST/API status code (e.g. FIELD_CUSTOM_VALIDATION_EXCEPTION), or null. */
  readonly detectedStatusCode: string | null;
  /** The validation-message segment extracted for matching, or null. */
  readonly extractedMessage: string | null;
  readonly candidates: readonly ExplainErrorCandidate[];
  /** True when more candidates existed than the byte-budget cap. */
  readonly truncated: boolean;
  /** Category-level explanation when a status code is recognized, else null. */
  readonly categoryExplanation: StatusCodeCategory | null;
  /**
   * The runtime governor limit the paste carries, or `null` when the text
   * holds no limit signature. Produced by the SHARED `parseGovernorLimit`, so
   * this is byte-for-byte the `detectedLimit` `sfi.explain_debug_log` returns
   * for the same string. Category-level: it names WHICH limit fired, never
   * which component consumed it.
   */
  readonly detectedLimit: DetectedGovernorLimit | null;
  /** Which match strategies were attempted (transparency on a `none` result). */
  readonly triedStrategies: readonly string[];
  /** Concrete follow-ups (e.g. `sfi.what_happens_on_save`) — always populated. */
  readonly nextSteps: readonly string[];
  /** The TOP candidate's confidence, or 'none' when there is no candidate. */
  readonly confidence: 'declared' | 'heuristic' | 'none';
  readonly disclosure: string;
  readonly boundaries: readonly string[];
}

// ---------------------------------------------------------------------------
// Pure parsers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * The status-code taxonomy — now sourced from the generated concept-model
 * (curated in `packages/mcp/model/status-taxonomy.yaml`, compiled to
 * `../knowledge/generated/concept-model.ts` by `scripts/build-concept-model.mjs`).
 * Re-exported UNCHANGED under the same name so existing consumers — e.g.
 * `explain-debug-log.ts` — keep importing it from this module, and the runtime
 * value stays byte-identical to the former inline literal.
 *
 * `crossRefObjectAutomation` marks codes whose most common producer is object
 * automation (trigger / flow), so the handler lists the object's `triggersOn`
 * sources as a category-level cross-reference.
 */
export { STATUS_CODE_TAXONOMY };

/**
 * Detect a recognized REST/API status code token in the error text. Returns the
 * FIRST recognized code by appearance order (validation exceptions usually lead
 * a DML failure string). Case-insensitive on the token, but only the canonical
 * UPPER_SNAKE tokens in the taxonomy are recognized.
 */
export const detectStatusCode = (errorText: string): string | null => {
  const upper = errorText.toUpperCase();
  let best: { code: string; idx: number } | null = null;
  for (const code of Object.keys(STATUS_CODE_TAXONOMY)) {
    const idx = upper.indexOf(code);
    if (idx < 0) continue;
    if (best === null || idx < best.idx) best = { code, idx };
  }
  return best?.code ?? null;
};

/**
 * Extract the validation-message segment worth matching against
 * `ValidationRule.errorMessage`.
 *
 *   - When the text carries a `FIELD_CUSTOM_VALIDATION_EXCEPTION`, take the
 *     segment after it, strip a leading `,`/`:`/whitespace and a leading
 *     `Error:`, and strip a trailing `: [FieldName, …]` field-list suffix that
 *     Salesforce appends — leaving just the human message.
 *   - When NO status code is present at all, the whole trimmed text is treated
 *     as a bare pasted message (the user copied just the red banner).
 *   - When some OTHER status code is present (REQUIRED_FIELD_MISSING, etc.),
 *     returns null — that text is not a validation message and must not be
 *     fuzzy-matched against validation errorMessages.
 */
export const extractValidationMessage = (errorText: string): string | null => {
  const FCVE = 'FIELD_CUSTOM_VALIDATION_EXCEPTION';
  const upper = errorText.toUpperCase();
  const fcveIdx = upper.indexOf(FCVE);
  if (fcveIdx >= 0) {
    let seg = errorText.slice(fcveIdx + FCVE.length);
    // The validation message is single-line inside the DML error string; a
    // stack trace / additional frames follow on LATER lines — cut at the
    // first newline so an appended `Class.X.method: line N` frame is not
    // swallowed into the matched message.
    const nl = seg.search(/[\r\n]/);
    if (nl >= 0) seg = seg.slice(0, nl);
    // Drop a leading separator (", " or ": ") the status code is followed by.
    seg = seg.replace(/^\s*[,:]\s*/, '');
    // Drop a leading "Error:" that flow/Apex wrappers sometimes prepend.
    seg = seg.replace(/^\s*Error:\s*/i, '');
    // Strip a trailing "): [Field...]" or ": [Field...]" field-list suffix.
    seg = seg.replace(/\s*:?\s*\[[^\]]*\]\s*\.?\s*$/, '');
    // A bulk error string can chain "; first error: <next>"; cut at that.
    const nextErr = seg.search(/;\s*(?:first|next) error:/i);
    if (nextErr >= 0) seg = seg.slice(0, nextErr);
    seg = seg.trim();
    return seg.length > 0 ? seg : null;
  }
  // No FCVE — only treat as a bare message when NO other status code is present.
  if (detectStatusCode(errorText) !== null) return null;
  const trimmed = errorText.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Parse a Flow fault-email shape. Returns `flowApiName` and/or `elementName`
 * when the text looks like a flow fault, else null.
 */
export const parseFlowFault = (
  errorText: string,
): { readonly flowApiName: string | null; readonly elementName: string | null } | null => {
  const apiMatch = errorText.match(/Flow\s+API\s+Name\s*[:=]\s*"?([A-Za-z0-9_]+)"?/i);
  const elemMatch = errorText.match(
    /(?:error occurred at element|caused by element|error element|at element)\s+"?([A-Za-z0-9_]+)"?/i,
  );
  // A generic "An error occurred while trying to run the flow" without either
  // token is still a flow signal, but with nothing to resolve.
  const looksLikeFlow =
    /flow/i.test(errorText) &&
    (apiMatch !== null ||
      elemMatch !== null ||
      /error occurred while.*flow|flow (?:interview|fault)/i.test(errorText));
  if (!looksLikeFlow) return null;
  return {
    flowApiName: apiMatch?.[1] ?? null,
    elementName: elemMatch?.[1] ?? null,
  };
};

/** Parsed Apex stack-frame identity. */
export interface ApexFrame {
  readonly className: string | null;
  readonly methodName: string | null;
  readonly triggerName: string | null;
  readonly line: number | null;
  readonly systemException: string | null;
}

/**
 * Parse an Apex stack-frame shape ("Class.MyClass.myMethod: line N, column M",
 * "Trigger.MyTrigger: line N", "caused by: System.XException"). Returns null
 * when no Apex shape is present.
 */
export const parseApexStackFrame = (errorText: string): ApexFrame | null => {
  const classMatch = errorText.match(
    /\bClass\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*:\s*line\s*(\d+)/i,
  );
  const triggerMatch = errorText.match(
    /\bTrigger\.([A-Za-z0-9_]+)\s*:\s*line\s*(\d+)/i,
  );
  const sysMatch = errorText.match(/\bSystem\.([A-Za-z_][A-Za-z0-9_]*Exception)\b/);
  if (classMatch === null && triggerMatch === null && sysMatch === null) {
    return null;
  }
  return {
    className: classMatch?.[1] ?? null,
    methodName: classMatch?.[2] ?? null,
    triggerName: triggerMatch?.[1] ?? null,
    line:
      classMatch?.[3] !== undefined
        ? Number(classMatch[3])
        : triggerMatch?.[2] !== undefined
          ? Number(triggerMatch[2])
          : null,
    systemException: sysMatch?.[1] ?? null,
  };
};

/** True when the error text carries duplicate-detection phrasing. */
export const looksLikeDuplicate = (errorText: string): boolean =>
  /DUPLICATES_DETECTED|duplicate(?:s)? (?:detected|record|found)|use one of these records|possible duplicate/i.test(
    errorText,
  );

// ---------------------------------------------------------------------------
// Match helpers
// ---------------------------------------------------------------------------

/** Normalize a message for fuzzy comparison: lowercase, collapse ws, trim punct/quotes. */
const normalizeMessage = (s: string): string =>
  s
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/g, '')
    .toLowerCase();

/** Normalize an object hint / api name for equality. */
const normObject = (s: string): string => s.trim().toLowerCase();

/** The object api name a `ValidationRule:` / `DuplicateRule:` node belongs to. */
const objectOf = (node: Node): string | null => {
  if (node.parentId === null) return null;
  const idx = node.parentId.indexOf(':');
  return idx < 0 ? node.parentId : node.parentId.slice(idx + 1);
};

interface VrMatch {
  readonly matchKind: 'exact' | 'normalized' | 'substring';
  readonly confidence: 'declared' | 'heuristic';
}

/** Score how a candidate ValidationRule.errorMessage matches the pasted message. */
const scoreVrMatch = (paste: string, ruleMsg: string): VrMatch | null => {
  if (paste.trim() === ruleMsg.trim()) {
    return { matchKind: 'exact', confidence: 'declared' };
  }
  const np = normalizeMessage(paste);
  const nr = normalizeMessage(ruleMsg);
  if (np.length === 0 || nr.length === 0) return null;
  if (np === nr) return { matchKind: 'normalized', confidence: 'heuristic' };
  if (nr.length >= MIN_SUBSTRING_MESSAGE_LEN && (np.includes(nr) || nr.includes(np))) {
    return { matchKind: 'substring', confidence: 'heuristic' };
  }
  return null;
};

/** Confidence rank for sorting (higher = stronger). */
const CONF_RANK: Readonly<Record<string, number>> = { declared: 2, heuristic: 1 };
const KIND_RANK: Readonly<Record<ExplainErrorMatchKind, number>> = {
  exact: 5,
  name: 4,
  normalized: 3,
  substring: 2,
  listing: 1,
};

// ---------------------------------------------------------------------------
// Strategy runners
// ---------------------------------------------------------------------------

/** Strategy 1: match the extracted message against every ValidationRule. */
const matchValidationRules = async (
  ctx: Context,
  message: string,
  objectHint: string | undefined,
): Promise<Result<{ candidates: ExplainErrorCandidate[]; incompleteTypes: readonly string[] }, string>> => {
  // R6 adoption: the shared full multi-window walk (windows the SQL OFFSET
  // forward until the type is exhausted) replaces a hand-rolled duplicate of
  // the identical loop, and — unlike the hand-rolled version — discloses when
  // a pathological org left the walk incomplete.
  const scan = await scanAllNodesOfTypes(ctx.graph, ['ValidationRule']);
  if (!scan.ok) return err(scan.error.message);
  const out: ExplainErrorCandidate[] = [];
  for (const node of scan.value.nodes) {
    const ruleMsg = node.properties['errorMessage'];
    if (typeof ruleMsg !== 'string' || ruleMsg.length === 0) continue;
    const obj = objectOf(node);
    if (objectHint !== undefined && obj !== null && normObject(obj) !== normObject(objectHint)) {
      continue;
    }
    const match = scoreVrMatch(message, ruleMsg);
    if (match === null) continue;
    const active = typeof node.properties['active'] === 'boolean' ? (node.properties['active'] as boolean) : null;
    const formula =
      typeof node.properties['errorConditionFormula'] === 'string'
        ? (node.properties['errorConditionFormula'] as string)
        : null;
    out.push({
      strategy: 'validation-rule',
      componentId: node.id,
      type: node.type,
      apiName: node.apiName,
      label: node.label,
      objectApiName: obj,
      active,
      confidence: match.confidence,
      matchKind: match.matchKind,
      why:
        match.matchKind === 'exact'
          ? `Its declared errorMessage exactly matches the pasted validation message${active === false ? ' (NOTE: this rule is currently INACTIVE — an active rule with the same message may be the live source)' : ''}.`
          : match.matchKind === 'normalized'
            ? 'Its errorMessage matches the pasted message ignoring case/whitespace/trailing punctuation.'
            : 'Its errorMessage is a substring of (or contains) the pasted message.',
      detail: {
        errorConditionFormula: formula,
        matchedErrorMessage: ruleMsg,
      },
    });
  }
  return ok({ candidates: out, incompleteTypes: scan.value.incompleteTypes });
};

/** Strategy 2: resolve the flow named in a fault email to a real Flow node. */
const matchFlowFault = async (
  ctx: Context,
  parsed: { readonly flowApiName: string | null; readonly elementName: string | null },
): Promise<Result<{ candidate: ExplainErrorCandidate | null; note: string | null }, string>> => {
  if (parsed.flowApiName === null) {
    return ok({
      candidate: null,
      note:
        parsed.elementName !== null
          ? `A flow fault at element "${parsed.elementName}" was recognized, but no "Flow API Name:" was present to resolve the flow — paste the "Flow API Name" line from the fault email.`
          : 'A flow fault shape was recognized but carried no Flow API Name to resolve.',
    });
  }
  const flowId = `Flow:${parsed.flowApiName}` as ComponentId;
  const nodeR = await getNodeById(ctx.graph, flowId);
  if (!nodeR.ok) return err(nodeR.error.message);
  if (nodeR.value === null) {
    return ok({
      candidate: null,
      note: `The fault email names Flow "${parsed.flowApiName}", but no such Flow is in this vault (managed/not-retrieved, or renamed). Not fabricating a match.`,
    });
  }
  const node = nodeR.value;
  // Cross-check the element name against the flow's captured action calls.
  let elementNote = '';
  if (parsed.elementName !== null) {
    const actionCalls = node.properties['actionCalls'];
    const matchedAction =
      Array.isArray(actionCalls) &&
      actionCalls.some(
        (a) =>
          typeof a === 'object' &&
          a !== null &&
          (a as { actionName?: unknown }).actionName === parsed.elementName,
      );
    elementNote = matchedAction
      ? ` The fault element "${parsed.elementName}" matches one of this flow's action calls.`
      : ` The fault element "${parsed.elementName}" is echoed from the email; flow ELEMENTS are not separate graph nodes offline, so it is not resolved to a node.`;
  }
  return ok({
    candidate: {
      strategy: 'flow-fault',
      componentId: node.id,
      type: node.type,
      apiName: node.apiName,
      label: node.label,
      objectApiName:
        typeof node.properties['triggerObject'] === 'string'
          ? (node.properties['triggerObject'] as string)
          : null,
      active:
        node.properties['status'] === 'Active'
          ? true
          : node.properties['status'] === undefined
            ? null
            : false,
      confidence: 'declared',
      matchKind: 'name',
      why: `The fault email names this flow by API name.${elementNote}`,
      detail: {
        elementName: parsed.elementName,
        status:
          typeof node.properties['status'] === 'string'
            ? (node.properties['status'] as string)
            : null,
      },
    },
    note: null,
  });
};

/** Strategy 3: resolve the Apex class / trigger named in a stack frame. */
const matchApex = async (
  ctx: Context,
  frame: ApexFrame,
): Promise<Result<{ candidates: ExplainErrorCandidate[]; note: string | null }, string>> => {
  const candidates: ExplainErrorCandidate[] = [];
  const targets: { id: ComponentId; kind: 'ApexClass' | 'ApexTrigger'; frameLabel: string }[] = [];
  if (frame.className !== null) {
    targets.push({
      id: `ApexClass:${frame.className}` as ComponentId,
      kind: 'ApexClass',
      frameLabel: `${frame.className}.${frame.methodName ?? '?'}${frame.line !== null ? `: line ${frame.line}` : ''}`,
    });
  }
  if (frame.triggerName !== null) {
    targets.push({
      id: `ApexTrigger:${frame.triggerName}` as ComponentId,
      kind: 'ApexTrigger',
      frameLabel: `Trigger.${frame.triggerName}${frame.line !== null ? `: line ${frame.line}` : ''}`,
    });
  }
  const unresolved: string[] = [];
  for (const t of targets) {
    const nodeR = await getNodeById(ctx.graph, t.id);
    if (!nodeR.ok) return err(nodeR.error.message);
    if (nodeR.value === null) {
      unresolved.push(t.id);
      continue;
    }
    const node = nodeR.value;
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
      active: null,
      confidence: 'declared',
      matchKind: 'name',
      why: `Named in the Apex stack frame (${t.frameLabel}). The exact LINE/logic that threw is not resolvable offline.`,
      detail: {
        frame: t.frameLabel,
        line: frame.line,
        method: frame.methodName,
      },
    });
  }
  let note: string | null = null;
  if (unresolved.length > 0) {
    note = `Apex stack frame names ${unresolved.join(', ')}, not in this vault (managed/not-retrieved).`;
  } else if (candidates.length === 0 && frame.systemException !== null) {
    note = `The error is a System.${frame.systemException} with no named user Apex frame — it originated in platform code or a component whose frame was not included.`;
  }
  return ok({ candidates, note });
};

/** Strategy 4: list active DuplicateRules on the hinted object. */
const matchDuplicateRules = async (
  ctx: Context,
  objectHint: string | undefined,
): Promise<
  Result<{ candidates: ExplainErrorCandidate[]; note: string | null; incompleteTypes: readonly string[] }, string>
> => {
  if (objectHint === undefined) {
    return ok({
      candidates: [],
      note:
        'A duplicate-record error was recognized, but no `object` hint was given — pass the SObject to list its active duplicate rules.',
      incompleteTypes: [],
    });
  }
  const candidates: ExplainErrorCandidate[] = [];
  // R6 adoption: was a single un-paged `listNodesByType` call — on an org past
  // 500 DuplicateRules that read only the alphabetical first page and the
  // sibling ValidationRule scan windowed correctly right above it in this same
  // file. The shared full-scan walk closes the gap AND discloses the residual
  // cap.
  const scan = await scanAllNodesOfTypes(ctx.graph, ['DuplicateRule']);
  if (!scan.ok) return err(scan.error.message);
  for (const node of scan.value.nodes) {
    const obj = objectOf(node);
    if (obj === null || normObject(obj) !== normObject(objectHint)) continue;
    const active = node.properties['isActive'] === true;
    if (!active) continue;
    candidates.push({
      strategy: 'duplicate-rule',
      componentId: node.id,
      type: node.type,
      apiName: node.apiName,
      label: node.label,
      objectApiName: obj,
      active: true,
      confidence: 'heuristic',
      matchKind: 'listing',
      why: `An active duplicate rule on ${obj} — the error text does not name which rule fired, so every active rule on the object is a candidate.`,
      detail: {
        alertText:
          typeof node.properties['alertText'] === 'string'
            ? (node.properties['alertText'] as string)
            : null,
      },
    });
  }
  return ok({
    candidates,
    note:
      candidates.length === 0
        ? `No active duplicate rule on "${objectHint}" is in this vault.`
        : null,
    incompleteTypes: scan.value.incompleteTypes,
  });
};

/**
 * Cross-reference: the triggers/flows declared on the hinted object.
 *
 * `objectId` is the ALREADY-VERIFIED, exactly-cased `CustomObject:` id
 * (`resolveExistingObjectScope`'s output) — never a string-templated hint, so
 * a typo or a wrong-cased object name fails closed at the caller instead of
 * silently cross-referencing zero automation for a component that either
 * doesn't exist or exists under a different case (R4).
 *
 * The full edge set is collected and SORTED before the byte-budget slice
 * (R1) — slicing first, as the old code did, kept an arbitrary edge-order
 * subset and then presented it in tidy id-ASC order, which reads as "the
 * first 25 alphabetically" when it was actually "an arbitrary 25, then
 * sorted". `truncated` is returned alongside so the caller can disclose the
 * cap instead of the shape carrying no truncation signal at all.
 */
const objectAutomation = async (
  ctx: Context,
  objectId: ComponentId,
): Promise<Result<{ refs: ObjectAutomationRef[]; truncated: boolean }, string>> => {
  const edgesR = await listEdges(ctx.graph, objectId, {
    direction: 'in',
    edgeType: 'triggersOn',
  });
  if (!edgesR.ok) return err(edgesR.error.message);
  const out: ObjectAutomationRef[] = [];
  const seen = new Set<string>();
  for (const edge of edgesR.value) {
    if (seen.has(edge.fromId)) continue;
    seen.add(edge.fromId);
    const nodeR = await getNodeById(ctx.graph, edge.fromId);
    if (!nodeR.ok) return err(nodeR.error.message);
    const n = nodeR.value;
    out.push({
      componentId: edge.fromId as ComponentId,
      type: n?.type ?? (edge.fromId.slice(0, edge.fromId.indexOf(':')) as ComponentType),
      apiName: n?.apiName ?? edge.fromId,
    });
  }
  out.sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0));
  return ok({ refs: out.slice(0, MAX_OBJECT_AUTOMATION), truncated: out.length > MAX_OBJECT_AUTOMATION });
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * The `sfi.explain_error` MCP tool. Decodes a pasted Salesforce error to the
 * org component that produced it. See module JSDoc for the ranked strategies,
 * the fail-closed contract, and the honesty disclosure.
 *
 * @example
 *   const r = await explainErrorHandler(ctx, {
 *     errorText: 'FIELD_CUSTOM_VALIDATION_EXCEPTION, Close date is required: [CloseDate]',
 *     object: 'Opportunity',
 *   });
 *   if (r.ok && r.value.data.disposition === 'matched')
 *     use(r.value.data.candidates[0].componentId);
 */
export const explainErrorHandler = async (
  ctx: Context,
  input: ExplainErrorInput,
): Promise<Result<McpResponse<ExplainErrorOutput>, McpError>> => {
  const errorText = input.errorText;
  // EXPLAIN-ERROR-UNVERIFIED-OBJECT-HINT (R4): the `object` hint is threaded
  // into three graph reads below (VR filter, DuplicateRule filter, object-
  // automation cross-reference). A raw string-templated hint made a typo, a
  // wrong-CASE object, or a managed-package/never-retrieved object read as a
  // confident "no rule/automation on this object" instead of a refusal.
  // `resolveExistingObjectScope` verifies the hint against the vault AND
  // rewrites it to the vault's exact casing before anything downstream uses
  // it; a bare call (no `object`) stays byte-identical (`scope === null`).
  // `unhandledPrefix: 'refuse'` because this tool has no reverse-mode
  // `componentId` branch of its own.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input, {
    unhandledPrefix: 'refuse',
  });
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;
  const objectHint = scope?.object;
  const detectedStatusCode = detectStatusCode(errorText);
  const flowParsed = parseFlowFault(errorText);
  const apexFrame = parseApexStackFrame(errorText);
  const isDuplicate = looksLikeDuplicate(errorText) || detectedStatusCode === 'DUPLICATES_DETECTED';

  const candidates: ExplainErrorCandidate[] = [];
  const tried: string[] = [];
  const boundaries: string[] = [];
  const nextSteps: string[] = [];
  // R6: full-scan residual-incompleteness types, accumulated across the
  // ValidationRule and DuplicateRule walks below and disclosed once.
  const scanIncompleteTypes = new Set<string>();

  // Strategy 1 — validation rule. Attempt with the FCVE-extracted segment; or,
  // when the paste carries NO other structured shape, the bare message. Never
  // fuzzy-match a bare paste that is actually a flow/apex/other-code error.
  const isFcve = detectedStatusCode === 'FIELD_CUSTOM_VALIDATION_EXCEPTION';
  const otherShape = flowParsed !== null || apexFrame !== null || isDuplicate;
  const vrMessage =
    isFcve || (detectedStatusCode === null && !otherShape)
      ? extractValidationMessage(errorText)
      : null;
  let extractedMessage: string | null = null;
  if (vrMessage !== null) {
    extractedMessage = vrMessage;
    tried.push('validation-rule (message match against ValidationRule.errorMessage)');
    const vrR = await matchValidationRules(ctx, vrMessage, objectHint);
    if (!vrR.ok) return err({ kind: 'internal', message: vrR.error });
    candidates.push(...vrR.value.candidates);
    for (const t of vrR.value.incompleteTypes) scanIncompleteTypes.add(t);
  }

  // Strategy 2 — flow fault.
  if (flowParsed !== null) {
    tried.push('flow-fault (Flow API Name / element resolution)');
    const flowR = await matchFlowFault(ctx, flowParsed);
    if (!flowR.ok) return err({ kind: 'internal', message: flowR.error });
    if (flowR.value.candidate !== null) candidates.push(flowR.value.candidate);
    if (flowR.value.note !== null) boundaries.push(flowR.value.note);
  }

  // Strategy 3 — apex stack frame.
  if (apexFrame !== null) {
    tried.push('apex (class/trigger stack-frame resolution)');
    const apexR = await matchApex(ctx, apexFrame);
    if (!apexR.ok) return err({ kind: 'internal', message: apexR.error });
    candidates.push(...apexR.value.candidates);
    if (apexR.value.note !== null) boundaries.push(apexR.value.note);
  }

  // Strategy 4 — duplicate rules.
  if (isDuplicate) {
    tried.push('duplicate-rule (active DuplicateRule listing on the object)');
    const dupR = await matchDuplicateRules(ctx, objectHint);
    if (!dupR.ok) return err({ kind: 'internal', message: dupR.error });
    candidates.push(...dupR.value.candidates);
    if (dupR.value.note !== null) boundaries.push(dupR.value.note);
    for (const t of dupR.value.incompleteTypes) scanIncompleteTypes.add(t);
  }

  // Strategy 5 — status-code taxonomy (category-level, never a specific match).
  let categoryExplanation: StatusCodeCategory | null = null;
  if (detectedStatusCode !== null) {
    tried.push('status-code taxonomy (category-level classification)');
    const tax = STATUS_CODE_TAXONOMY[detectedStatusCode]!;
    let automation: readonly ObjectAutomationRef[] | undefined;
    let automationTruncated = false;
    if (tax.crossRefObjectAutomation && scope !== null) {
      const autoR = await objectAutomation(ctx, scope.componentId as ComponentId);
      if (!autoR.ok) return err({ kind: 'internal', message: autoR.error });
      automation = autoR.value.refs;
      automationTruncated = autoR.value.truncated;
    }
    categoryExplanation = {
      statusCode: detectedStatusCode,
      category: tax.category,
      explanation: tax.explanation,
      producedByTypes: tax.producedByTypes,
      categoryLevel: true,
      ...(automation !== undefined
        ? { objectAutomation: automation, objectAutomationTruncated: automationTruncated }
        : {}),
    };
  }

  // Strategy 6 — runtime governor-limit signature. The detector is the SAME one
  // sfi.explain_debug_log uses (parseGovernorLimit, lifted to
  // ./governor-limit-signature.js because explain-debug-log already imports
  // FROM this module and the reverse import would close a cycle); this is a
  // RE-USE, not a second implementation, so the two tools can never disagree
  // about one string. It is a DIFFERENT AXIS from strategy 5 — a paste can
  // carry both a status code and a limit signature, and they must not compete.
  const detectedLimit = parseGovernorLimit(errorText);
  if (detectedLimit !== null) {
    tried.push('governor-limit signature (runtime limit classification)');
  }

  // Rank: confidence DESC, then matchKind DESC, then id ASC (total order).
  candidates.sort((a, b) => {
    const c = (CONF_RANK[b.confidence] ?? 0) - (CONF_RANK[a.confidence] ?? 0);
    if (c !== 0) return c;
    const k = (KIND_RANK[b.matchKind] ?? 0) - (KIND_RANK[a.matchKind] ?? 0);
    if (k !== 0) return k;
    return a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0;
  });

  const truncated = candidates.length > MAX_CANDIDATES;
  const page = candidates.slice(0, MAX_CANDIDATES);

  // Disposition — mirror sfi.resolve. A single `declared` candidate is a clean
  // match; several `declared` are ambiguous; a lone heuristic is still a
  // "matched" (its heuristic confidence carries the caveat); zero is `none`.
  const declaredCount = page.filter((c) => c.confidence === 'declared').length;
  let disposition: ExplainErrorDisposition;
  if (page.length === 0) disposition = 'none';
  else if (declaredCount > 1) disposition = 'ambiguous';
  else if (declaredCount === 1) disposition = 'matched';
  else disposition = page.length === 1 ? 'matched' : 'ambiguous';
  // A recognized runtime limit is an EXPLANATION at the category level, exactly
  // as a recognized status code is, so the response must not fail closed as
  // `none`. It never overrides a candidate-derived disposition — the two axes
  // do not compete.
  if (disposition === 'none' && detectedLimit !== null) disposition = 'matched';

  // Next steps — always actionable, fail-closed guidance when nothing matched.
  // Keyed on `page.length === 0`, not on `disposition`: strategy 6 can lift the
  // disposition to `matched` with zero candidates, and "confirm the candidate
  // id" would then name a candidate that does not exist. For every pre-strategy-6
  // input the two conditions are identical, so this is behaviour-preserving.
  const apexRuntimeException = apexFrame?.systemException ?? null;
  if (page.length === 0) {
    if (detectedLimit !== null) {
      // A limit is a TRANSACTION-level failure; save-order enumeration is the
      // wrong next move, so the limit path replaces that guidance entirely.
      nextSteps.push(
        'Run sfi.explain_debug_log against the debug log for the stack frames and the static governor-risk cross-reference.',
      );
      const mappedStaticRules = LIMIT_TO_STATIC_RULES[detectedLimit.limitType];
      // The mapping is REUSED from the shared module, never re-derived here.
      // An empty list is a CHECKED zero — no static rule models this limit — so
      // the sentence is omitted rather than naming a rule that does not exist.
      if (mappedStaticRules.length > 0) {
        const target =
          apexFrame?.className !== null && apexFrame?.className !== undefined
            ? `ApexClass:${apexFrame.className}`
            : apexFrame?.triggerName !== null && apexFrame?.triggerName !== undefined
              ? `ApexTrigger:${apexFrame.triggerName}`
              : 'the suspected class';
        nextSteps.push(
          `Run sfi.governor_limit_risks on ${target} for the static ${mappedStaticRules.join(' / ')} findings that map to this limit.`,
        );
      }
    } else {
      if (apexRuntimeException !== null) {
        nextSteps.push(
          'Run sfi.explain_debug_log against the debug log — it reads the stack frames, the fired governor limit, and the static governor-risk cross-reference.',
        );
      }
      if (objectHint !== undefined) {
        nextSteps.push(
          `Run sfi.what_happens_on_save on CustomObject:${objectHint} to enumerate every rule, flow, and trigger that fires on save.`,
        );
      } else {
        nextSteps.push(
          'Pass the `object` the save was on so validation/duplicate rules and on-save automation can be enumerated (sfi.what_happens_on_save).',
        );
      }
      // Suppressed for a recognized Apex runtime exception: the caller already
      // pasted the whole thing, and the gap is in this tool's model, not in
      // their paste. The boundary below says so instead.
      if (apexRuntimeException === null) {
        nextSteps.push(
          'Paste the FULL error (status code + the "Flow API Name:" line or "Class.X.method: line N" stack frame) so the exact source can be resolved.',
        );
      }
    }
  } else {
    nextSteps.push(
      'Confirm the candidate id, then use sfi.explain_flow / sfi.explain_apex_method / sfi.get_component to see the logic behind it.',
    );
    if (objectHint !== undefined) {
      nextSteps.push(
        `sfi.what_happens_on_save on CustomObject:${objectHint} shows the full save-order context around this source.`,
      );
    }
  }

  boundaries.push(
    'Error-to-source mapping is string matching against declared metadata, not a runtime execution trace — a candidate is where the error MOST LIKELY came from.',
  );
  if (scanIncompleteTypes.size > 0) {
    boundaries.push(fullScanTruncationNote([...scanIncompleteTypes].sort()));
  }
  if (candidates.some((c) => c.strategy === 'validation-rule' && c.matchKind !== 'exact')) {
    boundaries.push(
      'Validation-rule matches below `exact` are fuzzy — the org may reuse one message across rules, or the message may have been edited since the error fired.',
    );
  }
  if (categoryExplanation !== null && page.length === 0) {
    boundaries.push(
      `The status code ${detectedStatusCode} was recognized and explained at the CATEGORY level, but no specific source component was matched — the category names the component TYPES that can produce it, not the exact one.`,
    );
  }
  if (detectedLimit !== null) {
    boundaries.push(
      `A runtime governor limit (${detectedLimit.limitType}) was recognized and classified at the CATEGORY level, not matched to a source component — a governor limit is consumed across the WHOLE transaction, so the frame that threw is not necessarily the code that consumed it.`,
    );
  }
  // The gap statement: an Apex runtime exception this tool does not model.
  if (detectedLimit === null && apexRuntimeException !== null && page.length === 0) {
    boundaries.push(apexRuntimeExceptionGap(apexRuntimeException));
  }

  const topConfidence: 'declared' | 'heuristic' | 'none' =
    page.length === 0 ? 'none' : page[0]!.confidence;

  return ok({
    data: {
      disposition,
      detectedStatusCode,
      extractedMessage,
      candidates: page,
      truncated,
      categoryExplanation,
      detectedLimit,
      triedStrategies: tried,
      nextSteps,
      confidence: topConfidence,
      disclosure: EXPLAIN_ERROR_DISCLOSURE,
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
