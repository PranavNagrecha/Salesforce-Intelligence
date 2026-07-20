/**
 * Handler for the `sfi.flow_trace` MCP tool (spec §5).
 *
 * Where `sfi.flow_graph` returns the FAITHFUL, LOSSLESS *structure* of a Flow,
 * `flow_trace` answers the question a human debugs by hand: given a starting
 * record's field values, WHICH PATH executes and WHAT does it write. It is an
 * HONEST PROJECTION over the Flow's DECLARED logic — NOT a Salesforce runtime.
 * It never executes Apex, callouts, DML, or subflows; it never reaches across to
 * other automation's order-of-execution. It evaluates only the tractable common
 * subset (entry criteria, decisions, assignments, formulas, loops over
 * caller-supplied collections, record-op filters) and marks everything it cannot
 * deterministically evaluate `unevaluated` rather than guessing.
 *
 * The honesty spine (spec §5.4), surfaced verbatim in {@link DISCLOSURE}:
 *   - A branch that depends on data NOT in `recordState` is `unknown`, NEVER
 *     assumed. When the executed path reaches a decision whose outcome cannot be
 *     resolved, the walk STOPS honestly (`stoppedReason:'unevaluated-branch'`)
 *     rather than picking a branch.
 *   - Apex actions / subflows / callouts / waits / unmodeled elements on the
 *     executed path ALWAYS stop the walk `unevaluated` — their outputs may feed
 *     later logic and their side effects are invisible here.
 *   - A field written in memory to `$Record.<field>` `persists` only under the
 *     Bug-3 precondition (an after-save flow needs a whole-record `$Record`
 *     update element for its in-memory assignments to reach the database; a
 *     before-save flow persists them automatically). Record-op writes are real
 *     DML and always persist.
 *
 * The cascade mirrors `flow_graph`: resolve ANY `flowRef` via the shared
 * {@link resolveFlowRef} (surfacing an AMBIGUOUS bare name as a SUCCESS envelope,
 * never a silent pick), read the Flow source ON DEMAND from the vault, project it
 * with `parseFlowGraphSource`, then WALK that projection from `<start>`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { McpError, McpResponse, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import type {
  Condition,
  Decision,
  FlowGraphProjection,
} from '@sf-intelligence/extractors';
import { parseFlowGraphSource } from '@sf-intelligence/extractors';
import { tokenizeFormula } from '@sf-intelligence/parsers';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  resolveFlowRef,
  type FlowRefCandidate,
  type ResolvedFlowRef,
} from './flow-ref.js';

/**
 * The verbatim honesty disclosure surfaced on every trace. Frozen so the test
 * suite can assert the exact string and a caller-side rephrasing is a code-review
 * concern, not a silent drift. It makes the runtime boundary explicit.
 */
const DISCLOSURE =
  'Declared-logic projection, NOT a runtime. A branch depending on data not in recordState is unknown, never assumed. No Apex/callout/DML/subflow execution; no cross-automation order-of-execution.';

/** The disclosure carried on an ambiguous-flowRef success envelope. */
const AMBIGUOUS_DISCLOSURE =
  'flowRef matched more than one Flow. No trace was run — pick one candidate and call again with its canonical id. Disclosure over guessing.';

/**
 * A Flow is runnable only when its vault status is `Active` (or absent — an
 * uncaptured status is not asserted non-runnable). Any captured non-`Active`
 * status (`Obsolete` / `Draft` / `Inactive` / `InvalidDraft` / …) means the
 * automation cannot fire in the org (FLOW-TRACE-OMITS-FLOW-STATUS).
 */
const isRunnableStatus = (status: string | null): boolean =>
  status === null || status === 'Active';

/**
 * The verbatim assumption prepended to a non-`Active` Flow's trace. Names the
 * status so a host never reports the projected path/writes as live mutations.
 */
const nonRunnableAssumption = (status: string): string =>
  `Flow status is ${status} — it is not Active and cannot run in the org. The entry decision, path, ` +
  'and writes below are a STRUCTURAL projection of what it WOULD do if Active; nothing persists at runtime.';

/**
 * Salesforce formula functions the safe static evaluator models. Anything
 * outside this set (dates, `$User`, aggregation, text functions, …) makes the
 * formula `unresolved` — this is a projection, not a formula engine (spec §5.3).
 */
const SUPPORTED_FORMULA_FUNCTIONS = new Set<string>(['ISCHANGED', 'PRIORVALUE']);

/** Record-scoped trigger prefixes whose `$Record.` fields come from `recordState`. */
const RECORD_PRIOR_PREFIX = '$Record__Prior.';
const RECORD_PREFIX = '$Record.';

/**
 * Zod schema for `sfi.flow_trace` (spec §5.2).
 *   - `flowRef`: required, non-empty (canonical id / bare name / record id).
 *   - `recordState`: the starting record's field-value map, e.g.
 *     `{ "Status__c": "Active", "Amount__c": 10 }`.
 *   - `priorState`: optional `$Record__Prior` map for `ISCHANGED` / `PRIORVALUE`.
 *   - `maxSteps`: loop/cycle guard (default 500, hard cap 100000 so the guard
 *     cannot be de-fanged by an unbounded value — Fix 8).
 */
export const flowTraceInputSchema = z.object({
  flowRef: z.string().min(1),
  recordState: z.record(z.unknown()),
  priorState: z.record(z.unknown()).optional(),
  maxSteps: z.number().int().positive().max(100000).default(500),
});

/** Parsed input shape, inferred from {@link flowTraceInputSchema}. */
export type FlowTraceInput = z.infer<typeof flowTraceInputSchema>;

/** The three-valued result of a single condition (spec §5.2). */
export interface ConditionEval {
  readonly condition: Condition;
  readonly result: boolean | 'unknown';
  readonly reason?: string;
}

/** One executed canvas element in path order. */
export interface TraceStep {
  readonly element: string;
  readonly type: string;
  readonly decision?: {
    readonly matchedRule: string | null;
    readonly evaluated: readonly ConditionEval[];
  };
  readonly note?: string;
}

/**
 * A net field write the executed path performs. `valueKind` records HOW the
 * value was derived; `persists` mirrors the Bug-3 precondition for `$Record`
 * in-memory assignments (record-op DML always persists).
 */
export interface FieldWrite {
  readonly object: string | null;
  readonly field: string;
  readonly value: string | null;
  readonly valueKind: 'literal' | 'formula' | 'reference' | 'unresolved';
  readonly viaElement: string;
  readonly persists: boolean;
}

/** The honest trace result (spec §5.2). */
export interface FlowTrace {
  readonly flowRef: ResolvedFlowRef;
  /**
   * FLOW-TRACE-OMITS-FLOW-STATUS — set `true` when the Flow's status is NOT
   * `Active` (`Obsolete` / `Draft` / `Inactive` / …), i.e. it cannot run in the
   * org. The `path` / `writes` below are then a STRUCTURAL projection of what the
   * Flow WOULD do if it were Active; every write is forced `persists:false` and an
   * `assumptions` entry names the non-runnable status. A caller must NOT report
   * these as live record mutations. Omitted (undefined) for runnable Flows.
   * The concrete status string is on `flowRef.status`.
   */
  readonly notRunnable?: boolean;
  readonly entered: boolean;
  /**
   * Fix 7 — honest entry signal. `true` when the entry criteria combined to
   * `'unknown'` (they depend on data not in `recordState`), so `entered:false`
   * here means "cannot tell", NOT a definitive no-entry. Omitted when entry was
   * definitively decided (a real `true` or `false`). A caller must not report the
   * record as excluded when this is set.
   */
  readonly entryIndeterminate?: boolean;
  readonly entryEvaluation: readonly ConditionEval[];
  readonly path: readonly TraceStep[];
  readonly writes: readonly FieldWrite[];
  readonly stoppedReason:
    | 'end'
    | 'unevaluated-branch'
    | 'max-steps'
    | 'no-entry'
    | 'fault-unmodeled';
  readonly unevaluated: readonly { readonly element: string; readonly why: string }[];
  readonly assumptions: readonly string[];
  readonly disclosure: string;
}

/**
 * A bare name that fuzzily matched MORE than one Flow — surfaced as a SUCCESS
 * envelope carrying the ranked candidates (mirrors `flow_graph` / `sfi.resolve`).
 * No trace is run.
 */
export interface FlowTraceAmbiguous {
  readonly flowRef: {
    readonly requested: string;
    readonly resolvedForm: 'api-name';
  };
  readonly ambiguous: true;
  readonly candidates: readonly FlowRefCandidate[];
  readonly disclosure: string;
}

/** The success payload: a completed trace OR an ambiguity to surface. */
export type FlowTraceOutput = FlowTrace | FlowTraceAmbiguous;

/** A scalar the in-memory record/variable model can hold. */
type Scalar = string | number | boolean | null;

/** Resolving a reference/formula yields either a value + its provenance, or a reason it is unknown. */
type Resolution =
  | { readonly resolved: true; readonly value: Scalar; readonly source: 'literal' | 'reference' | 'formula' }
  | { readonly resolved: false; readonly reason: string };

/** Kleene AND over three-valued results (false wins, then unknown, then true). */
const threeAnd = (results: readonly (boolean | 'unknown')[]): boolean | 'unknown' => {
  if (results.some((r) => r === false)) return false;
  if (results.some((r) => r === 'unknown')) return 'unknown';
  return true;
};

/** Kleene OR over three-valued results (true wins, then unknown, then false). */
const threeOr = (results: readonly (boolean | 'unknown')[]): boolean | 'unknown' => {
  if (results.some((r) => r === true)) return true;
  if (results.some((r) => r === 'unknown')) return 'unknown';
  return false;
};

/** Coerce a scalar to a finite number, or null when it is not numeric. */
const asNumber = (v: Scalar): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Render a scalar for the `FieldWrite.value` / display channel. */
const display = (v: Scalar): string | null => (v === null ? null : String(v));

/**
 * The stateful walk over one projected Flow. Holds the in-memory record/variable
 * model and every honesty ledger (`unevaluated`, `assumptions`) so the pure
 * evaluation helpers can read/write them without threading state through every
 * call. One instance per `flow_trace` invocation.
 */
class FlowTraceEngine {
  private readonly recordFields: Map<string, Scalar>;
  private readonly priorFields: Map<string, Scalar>;
  private readonly hasPrior: boolean;
  private readonly variables = new Map<string, Scalar>();
  /**
   * Record fields / flow variables that an assignment overwrote with an
   * UNRESOLVED value (Fix 4 — taint). A read of a tainted name resolves to
   * `unknown` so a downstream condition marks its branch `unevaluated` rather
   * than deterministically re-using the stale pre-assignment value.
   */
  private readonly taintedFields = new Set<string>();
  private readonly taintedVars = new Set<string>();
  private readonly decisionsByName: Map<string, Decision>;
  private readonly formulaExprByName: Map<string, string>;
  /** `from` element name → its outgoing connectors (authoritative graph). */
  private readonly outgoing: Map<string, FlowGraphProjection['connectors'][number][]>;
  private readonly elementTypeByName: Map<string, string>;
  private readonly unmodeledNames: ReadonlySet<string>;
  /** Whether an in-memory `$Record.<field>` assignment reaches the DB (Bug-3). */
  private readonly recordAssignPersists: boolean;

  readonly writes: FieldWrite[] = [];
  readonly path: TraceStep[] = [];
  readonly unevaluated: { element: string; why: string }[] = [];
  readonly assumptions: string[] = [];
  /** Loop name → remaining iterations (init lazily on first arrival). */
  private readonly loopRemaining = new Map<string, number>();

  constructor(
    private readonly projection: FlowGraphProjection,
    private readonly recordState: Readonly<Record<string, unknown>>,
    priorState: Readonly<Record<string, unknown>> | undefined,
  ) {
    this.recordFields = new Map(Object.entries(recordState) as [string, Scalar][]);
    this.priorFields = new Map(
      Object.entries(priorState ?? {}) as [string, Scalar][],
    );
    this.hasPrior = priorState !== undefined;
    this.decisionsByName = new Map(projection.decisions.map((d) => [d.name, d]));
    this.formulaExprByName = new Map(
      projection.formulas.map((f) => [f.name, f.expression]),
    );
    this.elementTypeByName = new Map(
      projection.elements.map((e) => [e.name, e.type]),
    );
    this.unmodeledNames = new Set(projection.unmodeled);
    this.outgoing = new Map();
    for (const c of projection.connectors) {
      const list = this.outgoing.get(c.from) ?? [];
      list.push(c);
      this.outgoing.set(c.from, list);
    }
    const beforeSave = projection.start.triggerType === 'RecordBeforeSave';
    const hasWholeRecordUpdate = projection.recordOps.some(
      (op) => op.kind === 'update' && op.objectResolution === 'triggerRecord',
    );
    this.recordAssignPersists = beforeSave || hasWholeRecordUpdate;
  }

  // ---- reference / value resolution --------------------------------------

  /** Look up a `$Record.<field>` (or bare field) value; unknown when tainted or not supplied. */
  private lookupRecordField(field: string): Resolution {
    if (this.taintedFields.has(field)) {
      return { resolved: false, reason: `field '${field}' was overwritten by an unresolved assignment (value now unknown)` };
    }
    if (this.recordFields.has(field)) {
      return { resolved: true, value: this.recordFields.get(field) ?? null, source: 'reference' };
    }
    return { resolved: false, reason: `field '${field}' not in recordState` };
  }

  /**
   * Resolve a Flow reference (a condition's `leftValueReference`, an assignment
   * value's `elementReference`, a `{!merge}` field) to a concrete scalar, or a
   * reason it is unknown. `$Record.` fields come from `recordState`; variables
   * from prior assignments; formulas are evaluated in the safe subset; any other
   * `$`-global (`$User`, `$Flow`, …) or absent name is honestly `unknown`.
   */
  resolveReference(rawRef: string, formulaGuard: ReadonlySet<string> = new Set()): Resolution {
    let ref = rawRef.trim();
    if (ref.startsWith('{!') && ref.endsWith('}')) ref = ref.slice(2, -1).trim();
    if (ref === '$Record' || ref === '$Record__Prior') {
      return { resolved: false, reason: 'whole-record reference is not a scalar' };
    }
    if (ref.startsWith(RECORD_PRIOR_PREFIX)) {
      const field = ref.slice(RECORD_PRIOR_PREFIX.length);
      if (!this.hasPrior) return { resolved: false, reason: 'no priorState supplied' };
      if (this.priorFields.has(field)) {
        return { resolved: true, value: this.priorFields.get(field) ?? null, source: 'reference' };
      }
      return { resolved: false, reason: `field '${field}' not in priorState` };
    }
    if (ref.startsWith(RECORD_PREFIX)) {
      return this.lookupRecordField(ref.slice(RECORD_PREFIX.length));
    }
    if (ref.startsWith('$')) {
      return { resolved: false, reason: `global '${ref}' is not modeled (runtime context)` };
    }
    if (this.taintedVars.has(ref)) {
      return { resolved: false, reason: `variable '${ref}' was assigned an unresolved value (now unknown)` };
    }
    if (this.variables.has(ref)) {
      return { resolved: true, value: this.variables.get(ref) ?? null, source: 'reference' };
    }
    if (this.formulaExprByName.has(ref)) {
      return this.evalFormula(ref, formulaGuard);
    }
    if (this.taintedFields.has(ref)) {
      return { resolved: false, reason: `field '${ref}' was overwritten by an unresolved assignment (value now unknown)` };
    }
    if (this.recordFields.has(ref)) {
      return { resolved: true, value: this.recordFields.get(ref) ?? null, source: 'reference' };
    }
    return { resolved: false, reason: `reference '${ref}' is not in recordState / variables / formulas` };
  }

  // ---- formula evaluation (safe static subset) ---------------------------

  /**
   * Evaluate a `<formulas>` expression in the safe static subset (arithmetic /
   * string concat / `ISCHANGED` / `PRIORVALUE`). Uses {@link tokenizeFormula} as
   * the safe-subset GATE — any function outside {@link SUPPORTED_FORMULA_FUNCTIONS}
   * or any non-`$Record` global makes the whole formula `unresolved` — then a
   * tiny merge-aware evaluator computes the value. A self/mutual formula cycle is
   * guarded and returns `unresolved`.
   */
  evalFormula(name: string, guard: ReadonlySet<string>): Resolution {
    if (guard.has(name)) return { resolved: false, reason: `formula cycle at '${name}'` };
    const expr = this.formulaExprByName.get(name);
    if (expr === undefined) return { resolved: false, reason: `formula '${name}' not found` };
    return this.evalFormulaExpression(expr, new Set([...guard, name]));
  }

  /** Evaluate a raw formula expression string (guarded against formula recursion). */
  private evalFormulaExpression(expr: string, guard: ReadonlySet<string>): Resolution {
    const tok = tokenizeFormula(expr);
    if (!tok.ok) return { resolved: false, reason: `formula does not lex (${tok.error.kind})` };
    for (const fn of tok.value.functionCalls) {
      if (!SUPPORTED_FORMULA_FUNCTIONS.has(fn)) {
        return { resolved: false, reason: `formula uses unmodeled function ${fn}()` };
      }
    }
    for (const g of tok.value.globalReferences) {
      if (!g.path.startsWith(RECORD_PREFIX) && !g.path.startsWith(RECORD_PRIOR_PREFIX)) {
        return { resolved: false, reason: `formula uses runtime global ${g.path}` };
      }
    }
    try {
      const value = new FormulaEvaluator(expr, (r) => this.resolveReference(r, guard), {
        hasPrior: this.hasPrior,
        prior: (f) => (this.priorFields.has(f) ? this.priorFields.get(f) ?? null : undefined),
        current: (f) => (this.recordFields.has(f) ? this.recordFields.get(f) ?? null : undefined),
      }).evaluate();
      return { resolved: true, value, source: 'formula' };
    } catch (e) {
      return { resolved: false, reason: e instanceof FormulaUnresolved ? e.message : 'formula not evaluable' };
    }
  }

  // ---- condition evaluation ----------------------------------------------

  /** Resolve a condition's right operand per its `rightValueKind`. */
  private resolveRight(cond: Condition): Resolution {
    if (cond.rightValueKind === 'null') return { resolved: true, value: null, source: 'literal' };
    if (cond.rightValueKind === 'literal') {
      return { resolved: true, value: cond.rightValue, source: 'literal' };
    }
    return this.resolveReference(cond.rightValue ?? '');
  }

  /** Evaluate one condition to true / false / 'unknown' (three-valued, honest). */
  evalCondition(cond: Condition): ConditionEval {
    const op = cond.operator;
    // Collection membership needs the raw right reference (an array in recordState).
    if (op === 'In' || op === 'NotIn') {
      return this.evalMembership(cond);
    }
    const left = this.resolveReference(cond.leftValueReference);
    if (op === 'IsChanged') return this.evalIsChanged(cond);
    if (!left.resolved) {
      return { condition: cond, result: 'unknown', reason: left.reason };
    }
    if (op === 'IsNull' || op === 'IsBlank' || op === 'IsEmpty') {
      // Fix 3: `IsBlank` (34x) and `IsEmpty` (20x) are very common in real
      // flows — model them with the same null-or-empty test as `IsNull`,
      // honoring the boolean right operand (right `true` = "is blank/empty").
      const wantEmpty = String(cond.rightValue).toLowerCase() === 'true';
      const isEmpty = left.value === null || left.value === '';
      return { condition: cond, result: wantEmpty ? isEmpty : !isEmpty };
    }
    const right = this.resolveRight(cond);
    if (!right.resolved) {
      return { condition: cond, result: 'unknown', reason: right.reason };
    }
    const result = this.applyOperator(op, left.value, right.value);
    if (result === 'unknown') {
      return { condition: cond, result: 'unknown', reason: `operator '${op}' not modeled or non-comparable operands` };
    }
    return { condition: cond, result };
  }

  /** `IsChanged` — compares `recordState` vs `priorState` for the left field. */
  private evalIsChanged(cond: Condition): ConditionEval {
    if (!this.hasPrior) {
      return { condition: cond, result: 'unknown', reason: 'IsChanged needs priorState' };
    }
    const field = cond.leftValueReference.replace(RECORD_PREFIX, '');
    if (!this.recordFields.has(field) || !this.priorFields.has(field)) {
      return { condition: cond, result: 'unknown', reason: `IsChanged needs '${field}' in both recordState and priorState` };
    }
    const changed = String(this.recordFields.get(field)) !== String(this.priorFields.get(field));
    const want = String(cond.rightValue).toLowerCase() !== 'false';
    return { condition: cond, result: want ? changed : !changed };
  }

  /** `In` / `NotIn` — left scalar against a supplied collection reference. */
  private evalMembership(cond: Condition): ConditionEval {
    const left = this.resolveReference(cond.leftValueReference);
    if (!left.resolved) return { condition: cond, result: 'unknown', reason: left.reason };
    const rawColl = cond.rightValue ?? '';
    const supplied = this.recordState[rawColl];
    if (!Array.isArray(supplied)) {
      return { condition: cond, result: 'unknown', reason: `collection '${rawColl}' not supplied in recordState` };
    }
    const member = supplied.some((v) => String(v) === String(left.value));
    return { condition: cond, result: cond.operator === 'In' ? member : !member };
  }

  /** Apply a comparison operator to two resolved scalars (returns 'unknown' for unmodeled ops). */
  private applyOperator(op: string, l: Scalar, r: Scalar): boolean | 'unknown' {
    switch (op) {
      case 'EqualTo':
        return looseEqual(l, r);
      case 'NotEqualTo':
        return !looseEqual(l, r);
      case 'GreaterThan':
      case 'LessThan':
      case 'GreaterThanOrEqualTo':
      case 'LessThanOrEqualTo': {
        // The `…OrEqualTo` names are the verbatim FlowComparisonOperator enum
        // Salesforce writes in Flow metadata (Fix 1) — NOT `GreaterOrEqual` /
        // `LessOrEqual`, which never appear in real flows and left every `>=` /
        // `<=` decision rule falling through to 'unknown'.
        const ln = asNumber(l);
        const rn = asNumber(r);
        if (ln === null || rn === null) return 'unknown';
        if (op === 'GreaterThan') return ln > rn;
        if (op === 'LessThan') return ln < rn;
        if (op === 'GreaterThanOrEqualTo') return ln >= rn;
        return ln <= rn;
      }
      case 'Contains':
        return String(l ?? '').includes(String(r ?? ''));
      case 'StartsWith':
        return String(l ?? '').startsWith(String(r ?? ''));
      case 'EndsWith':
        return String(l ?? '').endsWith(String(r ?? ''));
      default:
        return 'unknown';
    }
  }

  /**
   * Combine a rule's / start's per-condition results under its `conditionLogic`.
   * `null`/`and`/`or` are the common shapes; a custom numeric expression
   * (`1 AND (2 OR 3)`) is evaluated three-valued too. An unparseable custom
   * expression degrades to `'unknown'` (Fix 6) — falling back to AND would GUESS
   * a combinator the metadata did not declare, and honesty (never guess) is the
   * whole product thesis: the caller sees the branch as unevaluated, not decided.
   */
  combineLogic(
    logic: string | null,
    evals: readonly ConditionEval[],
  ): boolean | 'unknown' {
    const results = evals.map((e) => e.result);
    if (results.length === 0) return true;
    const norm = (logic ?? 'and').trim().toLowerCase();
    if (norm === 'and') return threeAnd(results);
    if (norm === 'or') return threeOr(results);
    const custom = evalBooleanExpression(logic ?? '', results);
    return custom ?? 'unknown';
  }

  // ---- element navigation -------------------------------------------------

  /** The default outgoing target for a linear element (assignment / record op / screen / action). */
  private defaultTarget(name: string): string | null {
    const conns = this.outgoing.get(name) ?? [];
    const def = conns.find((c) => c.kind === 'default');
    return def ? def.to : null;
  }

  /** The `<decisions>` default (else-branch) connector target. */
  private decisionDefaultTarget(name: string): string | null {
    const conns = this.outgoing.get(name) ?? [];
    const def = conns.find((c) => c.kind === 'default');
    return def ? def.to : null;
  }

  // ---- assignment application --------------------------------------------

  /** Apply one `<assignments>` element, mutating the model and recording `$Record` writes. */
  private applyAssignment(name: string): void {
    const asn = this.projection.assignments.find((a) => a.name === name);
    if (asn === undefined) return;
    for (const item of asn.items) {
      const resolved = this.resolveAssignmentValue(item.value, item.valueKind, item.operator, item.assignToReference);
      const target = item.assignToReference;
      if (target.startsWith(RECORD_PREFIX)) {
        const field = target.slice(RECORD_PREFIX.length);
        // Update the in-memory record so downstream conditions see the new value.
        // An UNRESOLVED value TAINTS the field (Fix 4): a later condition reading
        // it must be 'unknown', not evaluated against the stale prior value.
        if (resolved.resolved) {
          this.recordFields.set(field, resolved.value);
          this.taintedFields.delete(field);
        } else {
          this.taintedFields.add(field);
        }
        this.writes.push({
          object: this.projection.start.object,
          field,
          value: resolved.resolved ? display(resolved.value) : null,
          valueKind: resolved.resolved
            ? resolved.source === 'formula'
              ? 'formula'
              : item.valueKind === 'literal'
                ? 'literal'
                : 'reference'
            : 'unresolved',
          viaElement: name,
          persists: this.recordAssignPersists,
        });
      } else if (!target.startsWith('$')) {
        // A flow variable — internal state, not a persisted field write. An
        // UNRESOLVED value TAINTS the variable (Fix 4) so downstream reads are
        // 'unknown' rather than silently falling through to a record field.
        if (resolved.resolved) {
          this.variables.set(target, resolved.value);
          this.taintedVars.delete(target);
        } else {
          this.variables.delete(target);
          this.taintedVars.add(target);
        }
      }
    }
  }

  /**
   * Resolve an assignment item's value under its operator. `Assign` takes the RHS
   * directly; `Add`/`Subtract`/`Multiply`/`Divide` combine the target's current
   * numeric value with a numeric RHS; anything else (collection ops, unknown
   * operators, non-numeric arithmetic operands) is honestly `unresolved`.
   */
  private resolveAssignmentValue(
    rawValue: string | null,
    valueKind: 'literal' | 'reference',
    operator: string,
    target: string,
  ): Resolution {
    const rhs: Resolution =
      valueKind === 'literal'
        ? { resolved: true, value: rawValue, source: 'literal' }
        : this.resolveReference(rawValue ?? '');
    if (operator === 'Assign') return rhs;
    if (operator === 'Add' || operator === 'Subtract' || operator === 'Multiply' || operator === 'Divide') {
      // A tainted operand reads as null → the arithmetic is honestly unresolved
      // (and re-taints the target below) rather than using a stale value (Fix 4).
      const recordField = target.slice(RECORD_PREFIX.length);
      const current = target.startsWith(RECORD_PREFIX)
        ? this.taintedFields.has(recordField)
          ? null
          : this.recordFields.get(recordField) ?? null
        : this.taintedVars.has(target)
          ? null
          : this.variables.get(target) ?? null;
      const cn = asNumber(current);
      const rn = rhs.resolved ? asNumber(rhs.value) : null;
      if (cn === null || rn === null) {
        return { resolved: false, reason: `'${operator}' needs numeric operands` };
      }
      const value =
        operator === 'Add'
          ? cn + rn
          : operator === 'Subtract'
            ? cn - rn
            : operator === 'Multiply'
              ? cn * rn
              : rn === 0
                ? NaN
                : cn / rn;
      if (!Number.isFinite(value)) return { resolved: false, reason: 'division by zero' };
      return { resolved: true, value, source: rhs.resolved && rhs.source === 'formula' ? 'formula' : 'reference' };
    }
    return { resolved: false, reason: `assignment operator '${operator}' not modeled` };
  }

  // ---- record-op writes ---------------------------------------------------

  /** Emit `FieldWrite`s for a create/update record op's input assignments (real DML — persists). */
  private applyRecordOp(name: string): void {
    const op = this.projection.recordOps.find((o) => o.name === name);
    if (op === undefined || (op.kind !== 'create' && op.kind !== 'update')) return;
    for (const ia of op.inputAssignments) {
      const resolved =
        ia.valueKind === 'literal'
          ? ({ resolved: true, value: ia.value, source: 'literal' } as Resolution)
          : this.resolveReference(ia.value ?? '');
      this.writes.push({
        object: op.object,
        field: ia.field,
        value: resolved.resolved ? display(resolved.value) : null,
        valueKind: resolved.resolved
          ? resolved.source === 'formula'
            ? 'formula'
            : ia.valueKind === 'literal'
              ? 'literal'
              : 'reference'
          : 'unresolved',
        viaElement: name,
        persists: true,
      });
    }
  }

  // ---- the walk -----------------------------------------------------------

  /**
   * Evaluate the `<start>` entry criteria. Returns the per-filter evaluations and
   * whether the flow definitively entered. An `unknown` combined result stops the
   * walk (`entered:false`) but is surfaced as INDETERMINATE (Fix 7) — the record
   * is never assumed to enter, and never reported as definitively excluded either.
   */
  evaluateEntry(): { evals: ConditionEval[]; entered: boolean; combined: boolean | 'unknown' } {
    const evals = this.projection.start.filters.map((f) => this.evalCondition(f));
    if (evals.length === 0) {
      // FLOW-GRAPH-TRACE-DROPS-START-FILTER-FORMULA — a start with NO structured
      // `<filters>` but a `<filterFormula>` entry gate is NOT unconditional entry:
      // the formula (e.g. ISPICKVAL($Record.Status, 'Submitted')) can EXCLUDE the
      // record. This projection does not run a full formula engine, so entry is
      // INDETERMINATE — never a silent `true` that invents entry (and walks into
      // Apex actions) for records the flow would never select.
      const formula = this.projection.start.filterFormula;
      if (typeof formula === 'string' && formula.trim().length > 0) {
        this.assumptions.push(
          'entry is gated by a start filterFormula this projection does not evaluate ' +
            `(${formula.replace(/\s+/g, ' ').trim()}); whether the record enters is UNKNOWN, not a definitive yes`,
        );
        return { evals, entered: false, combined: 'unknown' };
      }
      return { evals, entered: true, combined: true };
    }
    const combined = this.combineLogic(this.projection.start.filterLogic, evals);
    if (combined === 'unknown') {
      this.assumptions.push(
        'entry criteria could not be fully evaluated (depend on data not in recordState); ' +
          'whether the record enters is UNKNOWN, not a definitive no-entry',
      );
    }
    return { evals, entered: combined === true, combined };
  }

  /**
   * Walk the graph from the first element after `<start>`, mutating the model and
   * recording steps/writes/ledgers. Returns the honest `stoppedReason`.
   */
  walk(maxSteps: number): FlowTrace['stoppedReason'] {
    let current = this.projection.start.connector?.to ?? null;
    let steps = 0;
    while (current !== null) {
      if (steps >= maxSteps) return 'max-steps';
      steps += 1;
      const type = this.elementTypeByName.get(current);

      // Fix 5: an UNMODELED canvas element on the executed path (waits /
      // collectionProcessors / apexPluginCalls / orchestratedStages / transforms
      // / customErrors / recordRollbacks / steps). The projection captured its
      // connectors but not its body/type, so it never lands in the element index
      // (`type` is undefined here). Stop HONESTLY with an unmodeled-type why
      // rather than the misleading "connector target not found" (a real dangling
      // edge) or an Apex/end why. Checked BEFORE `type === undefined`.
      if (this.unmodeledNames.has(current)) {
        this.path.push({ element: current, type: type ?? 'unmodeled' });
        this.unevaluated.push({
          element: current,
          why: `element '${current}' is an unmodeled canvas type — cannot evaluate`,
        });
        return 'unevaluated-branch';
      }
      if (type === undefined) {
        this.unevaluated.push({ element: current, why: 'connector target not found in the projected element index' });
        return 'unevaluated-branch';
      }
      if (type === 'end') {
        this.path.push({ element: current, type });
        return 'end';
      }
      if (type === 'action' || type === 'subflow') {
        this.path.push({ element: current, type });
        this.unevaluated.push({
          element: current,
          why:
            type === 'action'
              ? 'Apex/invocable action — not executed (no Apex/callout semantics); its outputs may gate later logic'
              : 'subflow — not executed (no nested-flow execution); its outputs may gate later logic',
        });
        return 'unevaluated-branch';
      }

      if (type === 'decision') {
        const next = this.stepDecision(current);
        if (next.stop !== undefined) return next.stop;
        current = next.to;
        continue;
      }
      if (type === 'loop') {
        current = this.stepLoop(current);
        continue;
      }
      if (type === 'assignment') {
        this.applyAssignment(current);
        this.path.push({ element: current, type });
        current = this.defaultTarget(current);
        continue;
      }
      if (type === 'recordCreate' || type === 'recordUpdate') {
        this.applyRecordOp(current);
        const note = this.recordOpFilterNote(current);
        this.path.push({ element: current, type, ...(note !== undefined ? { note } : {}) });
        current = this.defaultTarget(current);
        continue;
      }
      if (type === 'recordLookup') {
        this.assumptions.push(`record lookup '${current}' results are unknown (no live query); downstream references to its output are unresolved`);
        this.path.push({ element: current, type });
        current = this.defaultTarget(current);
        continue;
      }
      if (type === 'recordDelete' || type === 'screen') {
        this.path.push({ element: current, type });
        current = this.defaultTarget(current);
        continue;
      }
      // Defensive: a known element type with no explicit branch handler.
      this.path.push({ element: current, type });
      current = this.defaultTarget(current);
    }
    return 'end';
  }

  /** Evaluate a decision and return the next element (or an honest stop). */
  private stepDecision(name: string): { to: string | null; stop?: FlowTrace['stoppedReason'] } {
    const dec = this.decisionsByName.get(name);
    if (dec === undefined) {
      this.path.push({ element: name, type: 'decision' });
      return { to: this.defaultTarget(name) };
    }
    const evaluatedAll: ConditionEval[] = [];
    for (const rule of dec.rules) {
      const evals = rule.conditions.map((c) => this.evalCondition(c));
      evaluatedAll.push(...evals);
      const result = this.combineLogic(rule.conditionLogic, evals);
      if (result === true) {
        this.path.push({ element: name, type: 'decision', decision: { matchedRule: rule.name, evaluated: evals } });
        return { to: rule.connectsTo };
      }
      if (result === 'unknown') {
        this.path.push({ element: name, type: 'decision', decision: { matchedRule: null, evaluated: evaluatedAll } });
        this.unevaluated.push({ element: name, why: `decision '${name}': rule '${rule.name}' depends on data not in recordState (or an unknown operator); branch cannot be resolved` });
        return { to: null, stop: 'unevaluated-branch' };
      }
      // result === false → try the next rule.
    }
    // No rule matched → the default (else) outcome.
    this.path.push({ element: name, type: 'decision', decision: { matchedRule: null, evaluated: evaluatedAll } });
    return { to: this.decisionDefaultTarget(name) };
  }

  /**
   * Step a `<loops>` element. Iterates `nextValue` once per supplied collection
   * item (the loop-back edge re-enters here and decrements), then exits via
   * `noMoreValues`. A collection the caller did not supply is assumed empty
   * (assumption recorded) and exits immediately.
   */
  private stepLoop(name: string): string | null {
    const loop = this.projection.loops.find((l) => l.name === name);
    if (loop === undefined) {
      this.path.push({ element: name, type: 'loop' });
      return null;
    }
    if (!this.loopRemaining.has(name)) {
      const supplied = this.recordState[loop.collectionReference];
      if (Array.isArray(supplied)) {
        this.loopRemaining.set(name, supplied.length);
      } else {
        this.loopRemaining.set(name, 0);
        this.assumptions.push(
          `collection '${loop.collectionReference}' assumed empty (not supplied in recordState)`,
        );
      }
    }
    const remaining = this.loopRemaining.get(name) ?? 0;
    if (remaining > 0) {
      this.loopRemaining.set(name, remaining - 1);
      this.path.push({ element: name, type: 'loop', note: `iteration (${remaining} remaining)` });
      return loop.nextValueConnectsTo;
    }
    this.loopRemaining.delete(name); // allow a re-entry (outer loop) to re-init
    this.path.push({ element: name, type: 'loop', note: 'no more values' });
    return loop.noMoreValuesConnectsTo;
  }

  /** A short note flagging record-op filters that depend on unsupplied data. */
  private recordOpFilterNote(name: string): string | undefined {
    const op = this.projection.recordOps.find((o) => o.name === name);
    if (op === undefined || op.filters.length === 0) return undefined;
    const evals = op.filters.map((f) => this.evalCondition(f));
    if (evals.some((e) => e.result === 'unknown')) {
      return 'some record-op filters depend on data not in recordState (not evaluated)';
    }
    return undefined;
  }
}

/** Thrown internally by {@link FormulaEvaluator} to unwind an unresolvable expression. */
class FormulaUnresolved extends Error {}

/**
 * A tiny, SAFE merge-aware evaluator for the Flow-formula subset (arithmetic
 * `+ - * /`, string concat `&`, parentheses, `{!merge}` fields, numeric/string
 * literals, `TRUE`/`FALSE`/`NULL`, and `ISCHANGED`/`PRIORVALUE`). It is NOT a
 * Salesforce formula engine — anything it cannot evaluate throws
 * {@link FormulaUnresolved}, which the caller turns into an honest `unresolved`.
 * `{!merge}` leaves resolve via the injected `resolve` callback so no fragile
 * string substitution is needed.
 */
class FormulaEvaluator {
  private pos = 0;
  private readonly tokens: readonly FToken[];

  constructor(
    expr: string,
    private readonly resolve: (ref: string) => Resolution,
    private readonly priorCtx: {
      readonly hasPrior: boolean;
      readonly prior: (field: string) => Scalar | undefined;
      readonly current: (field: string) => Scalar | undefined;
    },
  ) {
    this.tokens = tokenizeFormulaExpr(expr);
  }

  evaluate(): Scalar {
    const v = this.parseExpr();
    if (this.pos < this.tokens.length) throw new FormulaUnresolved('trailing tokens in formula');
    return v;
  }

  private peek(): FToken | undefined {
    return this.tokens[this.pos];
  }

  private parseExpr(): Scalar {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-' || t.value === '&')) {
        this.pos += 1;
        const right = this.parseTerm();
        left = applyArith(t.value, left, right);
      } else break;
    }
    return left;
  }

  private parseTerm(): Scalar {
    let left = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.value === '*' || t.value === '/')) {
        this.pos += 1;
        const right = this.parseFactor();
        left = applyArith(t.value, left, right);
      } else break;
    }
    return left;
  }

  private parseFactor(): Scalar {
    const t = this.peek();
    if (t === undefined) throw new FormulaUnresolved('unexpected end of formula');
    if (t.kind === 'number') {
      this.pos += 1;
      return t.value;
    }
    if (t.kind === 'string') {
      this.pos += 1;
      return t.value;
    }
    if (t.kind === 'op' && t.value === '(') {
      this.pos += 1;
      const v = this.parseExpr();
      const close = this.peek();
      if (close?.kind !== 'op' || close.value !== ')') throw new FormulaUnresolved('missing )');
      this.pos += 1;
      return v;
    }
    if (t.kind === 'op' && t.value === '-') {
      // Unary minus.
      this.pos += 1;
      const v = this.parseFactor();
      const n = asNumber(v);
      if (n === null) throw new FormulaUnresolved('unary minus on non-number');
      return -n;
    }
    if (t.kind === 'merge') {
      this.pos += 1;
      const res = this.resolve(t.value);
      if (!res.resolved) throw new FormulaUnresolved(res.reason);
      return res.value;
    }
    if (t.kind === 'ident') {
      const upper = t.value.toUpperCase();
      const next = this.tokens[this.pos + 1];
      if (next?.kind === 'op' && next.value === '(') {
        return this.parseFunctionCall(upper);
      }
      this.pos += 1;
      if (upper === 'TRUE') return true;
      if (upper === 'FALSE') return false;
      if (upper === 'NULL') return null;
      throw new FormulaUnresolved(`bare identifier '${t.value}' is not evaluable`);
    }
    throw new FormulaUnresolved('unexpected token in formula');
  }

  /** Evaluate `ISCHANGED(<merge>)` / `PRIORVALUE(<merge>)`; anything else is unresolved. */
  private parseFunctionCall(fn: string): Scalar {
    this.pos += 1; // consume ident
    this.pos += 1; // consume '('
    const arg = this.peek();
    if (arg?.kind !== 'merge') throw new FormulaUnresolved(`${fn}() expects a field argument`);
    this.pos += 1;
    const close = this.peek();
    if (close?.kind !== 'op' || close.value !== ')') throw new FormulaUnresolved(`${fn}() malformed`);
    this.pos += 1;
    const field = arg.value.replace(RECORD_PRIOR_PREFIX, '').replace(RECORD_PREFIX, '');
    if (!this.priorCtx.hasPrior) throw new FormulaUnresolved(`${fn}() needs priorState`);
    const prior = this.priorCtx.prior(field);
    if (fn === 'PRIORVALUE') {
      if (prior === undefined) throw new FormulaUnresolved(`PRIORVALUE('${field}') not in priorState`);
      return prior;
    }
    // ISCHANGED
    const current = this.priorCtx.current(field);
    if (prior === undefined || current === undefined) {
      throw new FormulaUnresolved(`ISCHANGED('${field}') needs the field in both states`);
    }
    return String(current) !== String(prior);
  }
}

/** A lexer token for {@link FormulaEvaluator}. */
type FToken =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'merge'; readonly value: string }
  | { readonly kind: 'ident'; readonly value: string }
  | { readonly kind: 'op'; readonly value: string };

/**
 * Lex a Flow-formula expression into {@link FToken}s: `{!merge}` fields, numeric
 * and quoted-string literals, identifiers, and the operators `+ - * / & ( )`.
 * Any other character throws {@link FormulaUnresolved} so an unmodeled construct
 * surfaces as `unresolved` rather than a wrong evaluation.
 */
const tokenizeFormulaExpr = (expr: string): readonly FToken[] => {
  const tokens: FToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '{' && expr[i + 1] === '!') {
      const end = expr.indexOf('}', i + 2);
      if (end < 0) throw new FormulaUnresolved('unterminated {! merge field');
      tokens.push({ kind: 'merge', value: expr.slice(i + 2, end).trim() });
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = expr.indexOf(ch, i + 1);
      if (end < 0) throw new FormulaUnresolved('unterminated string literal');
      tokens.push({ kind: 'string', value: expr.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < expr.length && ((expr[j]! >= '0' && expr[j]! <= '9') || expr[j] === '.')) j += 1;
      tokens.push({ kind: 'number', value: Number(expr.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9_.$]/.test(expr[j]!)) j += 1;
      tokens.push({ kind: 'ident', value: expr.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/&()'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new FormulaUnresolved(`unexpected character '${ch}' in formula`);
  }
  return tokens;
};

/** Apply a binary arithmetic / concat operator, throwing when operands do not fit. */
const applyArith = (op: string, l: Scalar, r: Scalar): Scalar => {
  if (op === '&') return `${l ?? ''}${r ?? ''}`;
  const ln = asNumber(l);
  const rn = asNumber(r);
  if (ln === null || rn === null) throw new FormulaUnresolved(`'${op}' needs numeric operands`);
  if (op === '+') return ln + rn;
  if (op === '-') return ln - rn;
  if (op === '*') return ln * rn;
  if (rn === 0) throw new FormulaUnresolved('division by zero');
  return ln / rn;
};

/**
 * Loose scalar equality: numeric ONLY when at least one operand is a real number
 * (`typeof === 'number'`), else exact string; null equals only null.
 *
 * Fix 2: comparing two STRINGS numerically over-coerces — `"01"` and `"1"` are
 * distinct text values a Flow's `EqualTo`/`NotEqualTo` must treat as unequal, so
 * two strings are always compared with `String(a) === String(b)`. A real number
 * vs a numeric-looking string still compares numerically (a field typed Number
 * genuinely equals `"1"`).
 */
const looseEqual = (a: Scalar, b: Scalar): boolean => {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' || typeof b === 'number') {
    const an = asNumber(a);
    const bn = asNumber(b);
    if (an !== null && bn !== null) return an === bn;
  }
  return String(a) === String(b);
};

/**
 * Evaluate a custom `conditionLogic` boolean expression (`1 AND (2 OR 3)`,
 * `NOT 1`) three-valued, where each integer indexes 1-based into `results`.
 * Returns `null` when the expression cannot be parsed (caller degrades to
 * `'unknown'` rather than guessing a combinator — Fix 6).
 */
const evalBooleanExpression = (
  logic: string,
  results: readonly (boolean | 'unknown')[],
): boolean | 'unknown' | null => {
  const raw = logic.trim();
  if (raw === '') return null;
  const tokens = raw.match(/\d+|AND|OR|NOT|\(|\)/gi);
  if (tokens === null) return null;
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const parseOr = (): boolean | 'unknown' => {
    let left = parseAnd();
    while (peek()?.toUpperCase() === 'OR') {
      pos += 1;
      left = threeOr([left, parseAnd()]);
    }
    return left;
  };
  const parseAnd = (): boolean | 'unknown' => {
    let left = parseNot();
    while (peek()?.toUpperCase() === 'AND') {
      pos += 1;
      left = threeAnd([left, parseNot()]);
    }
    return left;
  };
  const parseNot = (): boolean | 'unknown' => {
    if (peek()?.toUpperCase() === 'NOT') {
      pos += 1;
      const v = parseNot();
      return v === 'unknown' ? 'unknown' : !v;
    }
    return parseAtom();
  };
  const parseAtom = (): boolean | 'unknown' => {
    const t = peek();
    if (t === '(') {
      pos += 1;
      const v = parseOr();
      if (peek() !== ')') throw new Error('unbalanced');
      pos += 1;
      return v;
    }
    if (t !== undefined && /^\d+$/.test(t)) {
      pos += 1;
      const idx = Number(t) - 1;
      return results[idx] ?? 'unknown';
    }
    throw new Error('unexpected token');
  };
  try {
    const v = parseOr();
    if (pos !== tokens.length) return null;
    return v;
  } catch {
    return null;
  }
};

/** Read the Flow's display label — `properties.label`, then node label, else null. */
const readLabel = (node: Node): string | null => {
  const raw = node.properties['label'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return node.label;
};

/**
 * The `sfi.flow_trace` MCP tool (spec §5). Resolves `flowRef`, reads + projects
 * the Flow source on demand, walks the projection over `recordState`, and returns
 * the executed path + net writes with every un-evaluable branch honestly marked.
 * See the module JSDoc for the honesty spine.
 *
 * @example
 *   const r = await flowTraceHandler(ctx, {
 *     flowRef: 'My_Flow',
 *     recordState: { Status__c: 'Active' },
 *   });
 *   if (r.ok && !('ambiguous' in r.value.data)) console.log(r.value.data.path);
 */
export const flowTraceHandler = async (
  ctx: Context,
  input: FlowTraceInput,
): Promise<Result<McpResponse<FlowTraceOutput>, McpError>> => {
  const resolution = await resolveFlowRef(ctx, input.flowRef);
  if (!resolution.ok) return err(resolution.error);

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  // Ambiguity is a SUCCESS: surface the candidates, run NO trace.
  if (resolution.value.outcome === 'ambiguous') {
    return ok({
      data: {
        flowRef: { requested: resolution.value.requested, resolvedForm: 'api-name' as const },
        ambiguous: true as const,
        candidates: resolution.value.candidates,
        disclosure: AMBIGUOUS_DISCLOSURE,
      },
      vaultState,
    });
  }

  const { resolved, node } = resolution.value;

  if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) {
    return err({
      kind: 'internal',
      message: `no source path captured for ${resolved.componentId} (re-run /sfi-refresh)`,
      path: resolved.componentId,
    });
  }
  let xml: string;
  try {
    xml = await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
  } catch {
    return err({
      kind: 'internal',
      message: `could not read Flow source for ${resolved.componentId} (source file missing or unreadable — re-run /sfi-refresh)`,
      path: resolved.componentId,
    });
  }

  const projectionResult = parseFlowGraphSource(xml);
  if (!projectionResult.ok) {
    return err({
      kind: 'internal',
      message: `failed to parse Flow source for ${resolved.componentId}: ${projectionResult.error.message}`,
      path: resolved.componentId,
    });
  }
  const projection = projectionResult.value;

  // The resolver echo may lack the on-disk label; overlay the node label so the
  // trace's flowRef is as complete as flow_graph's.
  const flowRef: ResolvedFlowRef = { ...resolved, label: resolved.label ?? readLabel(node) };

  // FLOW-TRACE-OMITS-FLOW-STATUS — an Obsolete/Draft/Inactive Flow cannot run, so
  // its projection is a "would do if Active" structural view, NOT a live mutation.
  const notRunnable = !isRunnableStatus(flowRef.status);
  // `flowRef.status` is non-null when `notRunnable` (isRunnableStatus is true for
  // null); capture it so the assumption/prepend never falls back to a placeholder.
  const withNonRunnable = (base: readonly string[]): readonly string[] =>
    notRunnable && flowRef.status !== null
      ? [nonRunnableAssumption(flowRef.status), ...base]
      : base;

  const engine = new FlowTraceEngine(projection, input.recordState, input.priorState);
  const entry = engine.evaluateEntry();

  if (!entry.entered) {
    return ok({
      data: {
        flowRef,
        ...(notRunnable ? { notRunnable: true as const } : {}),
        entered: false,
        // Fix 7: distinguish "cannot tell" (unknown criteria) from a definitive
        // no-entry so a caller never reports the record as excluded on a guess.
        ...(entry.combined === 'unknown' ? { entryIndeterminate: true as const } : {}),
        entryEvaluation: entry.evals,
        path: [],
        writes: [],
        stoppedReason: 'no-entry',
        unevaluated: engine.unevaluated,
        assumptions: withNonRunnable(engine.assumptions),
        disclosure: DISCLOSURE,
      },
      vaultState,
    });
  }

  const stoppedReason = engine.walk(input.maxSteps);
  // A non-runnable Flow's writes cannot persist — force `persists:false` so no
  // host reads a dead automation as a live field change.
  const writes = notRunnable
    ? engine.writes.map((w) => ({ ...w, persists: false as const }))
    : engine.writes;

  return ok({
    data: {
      flowRef,
      ...(notRunnable ? { notRunnable: true as const } : {}),
      entered: true,
      entryEvaluation: entry.evals,
      path: engine.path,
      writes,
      stoppedReason,
      unevaluated: engine.unevaluated,
      assumptions: withNonRunnable(engine.assumptions),
      disclosure: DISCLOSURE,
    },
    vaultState,
  });
};
