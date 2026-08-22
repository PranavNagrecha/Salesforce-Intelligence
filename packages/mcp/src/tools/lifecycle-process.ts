/**
 * Handler for the `sfi.lifecycle_process` MCP tool (P11-LIFECYCLE-process).
 *
 * "What happens when {Object}.{field} becomes {value}?" — a value / stage
 * LIFECYCLE view, not a bare DML-event view. `order_of_execution` and
 * `what_happens_on_save` answer "what runs on an insert/update"; nothing
 * stitched the parts into the JOURNEY of a specific transition (Opportunity →
 * Closed Won, a Case status flip, a record submitted for approval). This does:
 * it composes the documented order of execution for the transition's event and
 * ANNOTATES which automation is coupled to the field/value — the steps whose
 * entry condition references the field, or mentions the value literal.
 *
 * It is a COMPOSITION over `order_of_execution` (so the two always agree on the
 * chain) plus condition-coupling analysis — no new graph data.
 *
 * Input: `{ objectApiName, field?, value?, event?, limit?, offset? }`.
 * `confidence: 'parsed'` — the chain is declared metadata; the value coupling
 * is a literal match over the parsed condition expression.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  canonicalizeObjectScope,
  mergeInputAliases,
  toCustomObjectId,
  toObjectApiName,
} from './input-aliases.js';
import { composeSoeForEvents, type SoeStep } from './order-of-execution.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * This handler's OWN byte budget for the paged `process` array.
 *
 * LIFECYCLE-PROCESS-LAUNDERS-UPSTREAM-TRUNCATION. This tool used to call the
 * fully-composed, byte-budget-ENFORCED `order_of_execution` response and then
 * recompute its totals from the survivors — so it asserted `truncated: false`
 * over a sequence the enforcer had already cut, and could never RETURN the
 * steps that were cut. It now composes the chain itself
 * ({@link composeSoeForEvents}, untruncated) and makes the cut HERE, where the
 * handler owns `limit` / `offset` / `cursor` and can report it.
 *
 * Sized like `TEST_COVERAGE_GAPS_PAYLOAD_BUDGET_BYTES` (38 KB) minus the
 * `coupledAutomation` block this response also carries whole.
 */
const LIFECYCLE_PAYLOAD_BUDGET_BYTES = 34_000;

/** A value transition is an update; record creation with a value is an insert. */
const LIFECYCLE_EVENTS = ['insert', 'update'] as const;
type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

const LIFECYCLE_PROCESS_ACCEPTED_KEYS = [
  'objectApiName',
  'objectId',
  'field',
  'value',
  'event',
  'recordType',
  'recordTypeId',
  'businessProcess',
  'limit',
  'offset',
  'cursor',
] as const;

/**
 * FIX 12. `.strict()`'s default text ("Unrecognized key(s) in object") does not
 * tell a caller what the tool DOES accept, so a typo'd knob reads as a bug in
 * the tool. This errorMap names the offending key AND the real knob list.
 * Passed at construction (not to `.strict(message)`, which is static and would
 * drop the key name) and preserved by the argument-less `.strict()` below.
 */
const strictKeyErrorMap =
  (accepted: readonly string[]): z.ZodErrorMap =>
  (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return {
        message: `Unknown argument '${issue.keys.join("', '")}'. This tool accepts: ${accepted.join(', ')}. Refusing rather than ignoring it — a silently-dropped argument returns a confident answer to a question you did not ask.`,
      };
    }
    return { message: ctx.defaultError };
  };

const lifecycleProcessInputBaseSchema = z.object(
  {
  objectApiName: z.string().min(1),
  /**
   * ADVERTISED ALIAS, declared so `.strict()` cannot reject the very call the
   * alias merge exists to serve. `mergeInputAliases` COPIES `objectId` into
   * `objectApiName`; it never DELETES the source key, so an undeclared alias
   * would be an unrecognized key on an otherwise valid `{objectId: '<Obj>'}`
   * request. The handler still reads only the canonical `objectApiName`.
   *
   * "ADVERTISED" was a claim, not a fact, until `LIFECYCLE_PROCESS_INPUT_SCHEMA`
   * in `roster.ts` actually listed it — for the whole life of this comment the
   * key was accepted and unadvertised, which is the opposite of what it says.
   * `advertised-schema-parity.test.ts` now asserts the claim for every tool, so
   * the comment can only be true.
   */
  objectId: z.string().min(1).optional(),
  field: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  event: z.enum(LIFECYCLE_EVENTS).optional(),
  /**
   * Optional RecordType developer name (e.g. `Priority_Type`) to scope the
   * lifecycle to. When set (or `recordTypeId`/`businessProcess`), automation
   * whose entry condition POSITIVELY gates `RecordType.DeveloperName` to record
   * type(s) OUTSIDE this scope is excluded — see `appliedScope`. Unknown record
   * types are rejected with `invalid-query` (never silently ignored).
   */
  recordType: z.string().min(1).optional(),
  /** Canonical RecordType id (`RecordType:{Object}.{DevName}`) — alternative to `recordType`. */
  recordTypeId: z.string().min(1).optional(),
  /** BusinessProcess name — scopes to the set of record types that use it. */
  businessProcess: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0 / explicit `offset`).
  cursor: z.string().min(1).optional(),
  },
  { errorMap: strictKeyErrorMap(LIFECYCLE_PROCESS_ACCEPTED_KEYS) },
).strict();

/** Zod schema for the `sfi.lifecycle_process` tool input. */
export const lifecycleProcessInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    { canonical: 'objectApiName', aliases: ['objectId'] },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const name = typeof o.objectApiName === 'string' ? o.objectApiName : '';
    if (name.length > 0) o.objectApiName = toObjectApiName(name);
  }
  return merged;
}, lifecycleProcessInputBaseSchema);

export type LifecycleProcessInput = z.infer<typeof lifecycleProcessInputSchema>;

/**
 * A step's classification against a requested RecordType scope, derived from
 * `RecordType.DeveloperName`/`.Name` comparisons in its entry-condition
 * expression:
 *   - `in-scope`      — positively gates to a record type that IS in scope.
 *   - `out-of-scope`  — positively gates ONLY to record type(s) NOT in scope
 *                       (this automation cannot fire for the requested scope).
 *   - `unconditional` — no positive RecordType-DeveloperName gate detected, so
 *                       it fires for all record types (retained under any scope).
 */
export type RecordTypeScope = 'in-scope' | 'out-of-scope' | 'unconditional';

/** One automation step in the lifecycle, annotated with its transition coupling. */
export interface LifecycleStep {
  readonly phase: string;
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  /** The step's entry-condition expression, when one was extracted. */
  readonly conditionExpression?: string;
  /** The condition references the transition field. */
  readonly coupledToField: boolean;
  /** The condition expression mentions the transition value literal. */
  readonly coupledToValue: boolean;
  /**
   * Present ONLY when a RecordType scope was applied: how this step relates to
   * it. `out-of-scope` steps are EXCLUDED from `process`/`coupledAutomation`;
   * retained steps carry `in-scope` or `unconditional`.
   */
  readonly recordTypeScope?: RecordTypeScope;
}

/**
 * Positive/negative `RecordType.DeveloperName`/`.Name` equality gates parsed
 * from a condition expression. Only the DeveloperName/Name axis is evaluated —
 * hard-coded 18-char `RecordTypeId` literals are not resolved offline (the step
 * is then treated as unconditional, i.e. retained).
 */
const RECORD_TYPE_GATE_RE =
  /\$?RecordType\.(?:DeveloperName|Name)\s*(==?|!=|<>)\s*['"]([^'"]+)['"]/g;

/**
 * Classify a step's condition expression against the in-scope record-type set.
 * SAFE by construction: a step is only ruled `out-of-scope` when its condition
 * POSITIVELY (`=`/`==`) gates the record type to name(s) NONE of which are in
 * scope — so a record-type-mismatched validation (e.g. `RecordType.DeveloperName
 * = 'Standard_Type'` under an `Priority_Type` scope) is dropped, while
 * unconditional automation and negations (`<>`/`!=`) are conservatively
 * RETAINED (never a false absence).
 */
export const classifyRecordTypeScope = (
  expression: string | undefined,
  inScope: ReadonlySet<string>,
): RecordTypeScope => {
  if (expression === undefined || expression.length === 0) return 'unconditional';
  const positives: string[] = [];
  RECORD_TYPE_GATE_RE.lastIndex = 0;
  for (const m of expression.matchAll(RECORD_TYPE_GATE_RE)) {
    const op = m[1]!;
    const name = m[2]!;
    if (op === '=' || op === '==') positives.push(name);
  }
  if (positives.length === 0) return 'unconditional';
  return positives.some((n) => inScope.has(n)) ? 'in-scope' : 'out-of-scope';
};

/**
 * Echo of an applied RecordType scope (present ONLY when `recordType`,
 * `recordTypeId`, or `businessProcess` was supplied) so a scoped answer is
 * never silently identical to an unscoped one.
 */
export interface LifecycleAppliedScope {
  /** How the scope was requested. */
  readonly kind: 'recordType' | 'businessProcess';
  /** The requested value verbatim (dev name or business-process name). */
  readonly requested: string;
  /** The record-type developer names the scope resolved to (≥ 1). */
  readonly resolvedRecordTypes: readonly string[];
  /** Steps dropped because they positively gate to record type(s) out of scope. */
  readonly excludedStepCount: number;
  /** The component ids of those excluded steps (deduped). */
  readonly excludedComponentIds: readonly ComponentId[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface LifecycleProcessOutput {
  readonly object: string;
  readonly event: LifecycleEvent;
  readonly transition: {
    readonly field: string | null;
    readonly value: string | null;
    readonly description: string;
  };
  /**
   * Present only when a RecordType/BusinessProcess scope was applied — the
   * resolved record types and what the scope excluded. Absent on an unscoped
   * call (byte-identical to pre-scope behavior).
   */
  readonly appliedScope?: LifecycleAppliedScope;
  /** The ordered automation chain for the event (paginated). */
  readonly process: readonly LifecycleStep[];
  /** The COMPLETE subset of steps coupled to the field/value (the value-add). */
  readonly coupledAutomation: readonly LifecycleStep[];
  readonly summary: {
    readonly totalSteps: number;
    readonly coupledSteps: number;
    readonly fieldCoupledSteps: number;
    readonly valueCoupledSteps: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token, present ONLY when the process page was
   * truncated (more steps remain past `limit`). Echo it back as `cursor` to
   * resume. Absent on a whole-fits page so an in-budget response stays
   * byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  readonly confidence: 'parsed';
  readonly disclosures: readonly string[];
}

/**
 * Internal page carrier: a {@link LifecycleStep} plus the SOE `stepIndex` used
 * as the CR-22 cursor's UNIQUE total-order key. `stepIndex` is NEVER emitted
 * (the page is mapped back to bare LifecycleStep before serialization) so the
 * visible output stays byte-identical to pre-CR-22. It is the right tiebreak:
 * an ApexTrigger registered for BOTH before and after events appears as a
 * `pre-save-triggers` row AND an `after-triggers` row with identical
 * componentId/componentType/apiName (only `phase` differs, and `phase` is not
 * unique either), so no emitted-row field is a unique key — but `stepIndex` is
 * a single monotonic 0-based counter incremented after EVERY emitted step in
 * the event chain, so it is globally unique and stable per (object, event).
 */
interface LifecycleStepCarrier {
  readonly step: LifecycleStep;
  readonly stepIndex: number;
}

const annotate = (
  step: SoeStep,
  fieldId: string | null,
  value: string | null,
  recordTypeScope: RecordTypeScope | null,
): LifecycleStep => {
  const cond = step.conditional;
  const expression = cond?.expression;
  // FIX 15 (3). `conditional.fieldRefs` is now GROUNDED-ONLY: a ref the
  // condition mentions but that names no node in this vault moves to
  // `ungroundedRefs`. Coupling must read BOTH. "This condition references the
  // transition field" is a fact about the CONDITION, not about whether the
  // field happened to be retrieved — gating it on groundedness would turn an
  // incomplete vault into a silent `coupledToField: false`, which is exactly
  // the false-clean answer this tool exists to avoid.
  const coupledToField =
    fieldId !== null &&
    cond !== undefined &&
    (cond.fieldRefs.includes(fieldId as ComponentId) ||
      (cond.ungroundedRefs ?? []).some((u) => u.raw === fieldId));
  const coupledToValue =
    value !== null &&
    expression !== undefined &&
    expression.toLowerCase().includes(value.toLowerCase());
  return {
    phase: step.phase,
    componentId: step.componentId,
    componentType: step.componentType,
    apiName: step.apiName,
    ...(expression !== undefined ? { conditionExpression: expression } : {}),
    coupledToField,
    coupledToValue,
    ...(recordTypeScope !== null ? { recordTypeScope } : {}),
  };
};

/**
 * The resolved RecordType scope, or an `invalid-query` error when the requested
 * record type / business process does not exist on the object. `null` means no
 * scope was requested (the tool behaves exactly as before).
 */
interface ResolvedScope {
  readonly appliedScopeKind: 'recordType' | 'businessProcess';
  readonly requested: string;
  readonly inScope: ReadonlySet<string>;
}

/**
 * Resolve a `recordType` / `recordTypeId` / `businessProcess` input against the
 * object's RecordType nodes. Returns:
 *   - `ok(null)` when no scope arg was supplied,
 *   - `ok(ResolvedScope)` with the in-scope developer-name set,
 *   - an `invalid-query` McpError when the named record type / business process
 *     matches no RecordType on the object (so a typo is surfaced, never
 *     silently ignored — the LIFECYCLE-PROCESS-SILENTLY-IGNORES-RECORDTYPE-SCOPE
 *     defect).
 */
const resolveRecordTypeScope = async (
  ctx: Context,
  object: string,
  input: LifecycleProcessInput,
): Promise<Result<ResolvedScope | null, McpError>> => {
  const rawRecordType = input.recordType ?? null;
  // `recordTypeId` may be a canonical id (`RecordType:{Object}.{DevName}`) or a
  // bare dev name — take the segment after the last dot when it is an id.
  const rawRecordTypeId = input.recordTypeId ?? null;
  const recordTypeIdDevName =
    rawRecordTypeId === null
      ? null
      : rawRecordTypeId.startsWith('RecordType:')
        ? (rawRecordTypeId.split('.').pop() ?? rawRecordTypeId)
        : rawRecordTypeId;
  const requestedRecordType = rawRecordType ?? recordTypeIdDevName;
  const requestedBusinessProcess = input.businessProcess ?? null;

  if (requestedRecordType === null && requestedBusinessProcess === null) {
    return ok(null);
  }

  // Fetch the org's RecordType nodes (cap is the node-scan max; real orgs carry
  // well under it across all objects) and keep the ones on this object.
  const rtResult = await listNodesByType(ctx.graph, 'RecordType', { limit: 500 });
  if (!rtResult.ok) {
    return err({ kind: 'internal', message: rtResult.error.message });
  }
  const prefix = `RecordType:${object}.`;
  const objectRecordTypes: Node[] = rtResult.value.filter((n) => n.id.startsWith(prefix));
  const devNameOf = (n: Node): string => n.id.slice(prefix.length);

  if (requestedRecordType !== null) {
    const match = objectRecordTypes.find((n) => devNameOf(n) === requestedRecordType);
    if (match === undefined) {
      const known = objectRecordTypes.map(devNameOf).sort();
      return err({
        kind: 'invalid-query',
        message:
          `No RecordType \`${requestedRecordType}\` on \`${object}\`. ` +
          (known.length > 0
            ? `Known record types: ${known.join(', ')}.`
            : `This object has no extracted record types.`),
      });
    }
    return ok({
      appliedScopeKind: 'recordType',
      requested: requestedRecordType,
      inScope: new Set([requestedRecordType]),
    });
  }

  // businessProcess: scope = the set of record types that use it. A record type
  // stores its process in `properties.businessProcess`; match case-insensitively
  // and tolerate URL-encoded values (Salesforce serializes e.g. `A%2FB`).
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const target = decode(requestedBusinessProcess!).toLowerCase();
  const inScope = objectRecordTypes
    .filter((n) => {
      const bp = n.properties['businessProcess'];
      return typeof bp === 'string' && decode(bp).toLowerCase() === target;
    })
    .map(devNameOf);
  if (inScope.length === 0) {
    const knownBps = [
      ...new Set(
        objectRecordTypes
          .map((n) => n.properties['businessProcess'])
          .filter((b): b is string => typeof b === 'string')
          .map(decode),
      ),
    ].sort();
    return err({
      kind: 'invalid-query',
      message:
        `No RecordType on \`${object}\` uses BusinessProcess \`${requestedBusinessProcess}\`. ` +
        (knownBps.length > 0
          ? `Known business processes: ${knownBps.join(', ')}.`
          : `This object's record types declare no business process.`),
    });
  }
  return ok({
    appliedScopeKind: 'businessProcess',
    requested: requestedBusinessProcess!,
    inScope: new Set(inScope),
  });
};

/**
 * The `sfi.lifecycle_process` MCP tool. Composes the order of execution for a
 * value/stage transition and highlights the automation coupled to it.
 */
export const lifecycleProcessHandler = async (
  ctx: Context,
  input: LifecycleProcessInput,
): Promise<Result<McpResponse<LifecycleProcessOutput>, McpError>> => {
  // Salesforce api names are case-insensitive, so `contact` names `Contact`.
  // ONE shared canonicalizer decides that for the whole object-scoped surface;
  // it rewrites to the VAULT's exact casing, refuses a case-only ambiguity by
  // name, and leaves an unknown name untouched so the SOE composition below
  // still produces its own `component-not-found`.
  const canonical = await canonicalizeObjectScope(ctx.graph, {
    componentId: toCustomObjectId(input.objectApiName),
    object: toObjectApiName(input.objectApiName),
  });
  if (!canonical.ok) return err(canonical.error);
  const object = canonical.value.object;
  const event: LifecycleEvent = input.event ?? 'update';
  const field = input.field ?? null;
  const value = input.value ?? null;
  const fieldId = field !== null ? `CustomField:${object}.${field}` : null;

  // Reuse the tested SOE COMPOSITION SEAM so the chain always agrees with
  // order_of_execution — but take the UNTRUNCATED composition, not that tool's
  // byte-budget-enforced response. `composeSoeForEvents` runs the same object
  // admission (`evaluateSoeAdmission` / `soeNotAdmittedMessage`), so an unknown
  // or not-modeled object surfaces the identical `component-not-found`.
  // Composing ONE event instead of four also removes ~75% of the graph work.
  const composed = await composeSoeForEvents(ctx, object, [event]);
  if (!composed.ok) return err(composed.error);
  const perEvent = composed.value.byEvent[event];
  if (perEvent === undefined) {
    return err({
      kind: 'internal',
      message: `SOE composition returned no chain for the \`${event}\` event on \`${object}\``,
    });
  }

  // Resolve an optional RecordType / BusinessProcess scope. Unknown scopes are
  // rejected with `invalid-query` rather than silently ignored (the
  // LIFECYCLE-PROCESS-SILENTLY-IGNORES-RECORDTYPE-SCOPE defect). `null` = no
  // scope requested (behaves exactly as before).
  const scopeResult = await resolveRecordTypeScope(ctx, object, input);
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;

  // Pair each annotated step with its source SoeStep's stepIndex (index-aligned
  // with the surviving steps) so the cursor can carry the unique total-order key
  // WITHOUT emitting it on the visible row. When a scope is active, classify
  // each step and DROP the ones that positively gate to a record type OUT of
  // scope — a safe exclusion (unconditional automation and negations are
  // retained, never a false absence).
  let rawExcludedStepCount = 0;
  const excludedIdSet = new Set<ComponentId>();
  const carriers: LifecycleStepCarrier[] = [];
  for (const s of perEvent.soe) {
    const rtScope =
      scope === null
        ? null
        : classifyRecordTypeScope(s.conditional?.expression, scope.inScope);
    if (rtScope === 'out-of-scope') {
      rawExcludedStepCount += 1;
      excludedIdSet.add(s.componentId);
      continue;
    }
    carriers.push({ step: annotate(s, fieldId, value, rtScope), stepIndex: s.stepIndex });
  }
  const allSteps = carriers.map((c) => c.step);

  const appliedScope: LifecycleAppliedScope | null =
    scope === null
      ? null
      : {
          kind: scope.appliedScopeKind,
          requested: scope.requested,
          resolvedRecordTypes: [...scope.inScope].sort(),
          excludedStepCount: rawExcludedStepCount,
          excludedComponentIds: [...excludedIdSet].sort(),
        };

  const coupledAutomation = allSteps.filter((s) => s.coupledToField || s.coupledToValue);
  const fieldCoupledSteps = allSteps.filter((s) => s.coupledToField).length;
  const valueCoupledSteps = allSteps.filter((s) => s.coupledToValue).length;

  // The TRUE total comes from the composition's own summary, never from the
  // surviving page — that laundering is the defect this fix closes. The
  // record-type exclusion is this tool's OWN, deliberate, and disclosed cut, so
  // it is SUBTRACTED here rather than hidden: `excludedStepCount + totalSteps`
  // reconciles back to the composition's `summary.totalSteps`.
  const total = perEvent.summary.totalSteps - rawExcludedStepCount;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22: resolve the resume offset — an echoed cursor wins over an explicit
  // `offset`; a stale/forged cursor (changed object/field/value/event, different
  // tool, or refreshed vault) is rejected with `invalid-query`. argsFingerprint
  // binds the narrowing args so a different transition can't replay the cursor.
  const fingerprint = argsFingerprint({
    objectApiName: object,
    ...(field !== null ? { field } : {}),
    ...(value !== null ? { value } : {}),
    event,
    // Bind the scope so a cursor minted under one record-type/business-process
    // scope cannot be replayed against a different (or unscoped) result set.
    ...(appliedScope !== null
      ? { scopeKind: appliedScope.kind, scope: appliedScope.requested }
      : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.lifecycle_process',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // A REAL per-handler byte budget: this handler, not the global envelope
  // reducer, decides what is cut and therefore is the layer that can report it.
  // A page trimmed below `limit` to fit gets the byte-budget disclosure below
  // and a resumable `nextCursor`; the SEQUENCE stays complete at `total`.
  const paged = paginateLegacy(carriers, {
    offset,
    limit,
    byteBudget: LIFECYCLE_PAYLOAD_BUDGET_BYTES,
    binding: {
      tool: 'sfi.lifecycle_process',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
    keyOf: (c) => String(c.stepIndex),
  });
  // Strip the internal stepIndex so the emitted page is bare LifecycleStep[].
  const page = paged.items.map((c) => c.step);
  const hasMore = paged.hasMore;
  // INVARIANT: `truncated === (process.length + offset < totalSteps)`. It is a
  // statement about the SEQUENCE ("steps remain past this page"), which is
  // exactly `hasMore`. A resumed LAST page (offset > 0, nothing left) is not
  // truncated — but it is still a page, so the pagination disclosure below
  // fires on `offset > 0` too and the caller is never left thinking a partial
  // view is the whole chain.
  const truncated = hasMore;
  // True when the page was cut BELOW `limit` by this handler's byte budget
  // rather than by `limit` itself — a case that could not be expressed at all
  // while the byte budget was effectively unbounded.
  const byteTrimmedPage = paged.byteTrimmed && page.length < limit;
  const emitCursor = paged.nextCursor !== null;

  const description =
    field !== null && value !== null
      ? `When ${object}.${field} becomes "${value}" (an ${event})`
      : field !== null
        ? `When ${object}.${field} changes (an ${event})`
        : `When a ${object} record is ${event === 'insert' ? 'created' : 'updated'}`;

  const disclosures: string[] = [
    `Composed from the documented order of execution for the ${event} event — conditions are LISTED but NOT EVALUATED; whether a given record actually matches ${field !== null && value !== null ? `${field} = "${value}"` : 'the transition'} needs record data.`,
    'Value coupling is a literal match of the value over the parsed condition expression — it can miss a value encoded in a formula and can over-match a substring. Field coupling uses the condition’s extracted field references.',
    'This is the metadata automation chain. It does not include manual user actions, the runtime field-history / audit trail, or external callouts. Parent Summary (roll-up) field recalculation IS included (inherited from order_of_execution’s post-save-rollup-recalc phase) but capped to one level — a grandparent’s own rollup on the recalculated parent is not walked — and does not expand the parent’s own automation.',
    'Distinct record ACTIONS — Lead Convert (IsConverted), Approval submission, and Activation — are not plain field edits and are not modeled as save-order steps: their action-specific automation (for Lead Convert, the Convert field mapping, matching / duplicate rules, and any managed-package auto-convert; for approval / activation, the approval or activation process itself) is outside this insert/update view. Treat a conversion / approval / activation answer as the save-time slice only, not the whole operation.',
  ];
  if (field === null || value === null) {
    disclosures.push(
      'No specific value transition supplied — showing the full automation chain. Pass `field` + `value` (e.g. field="StageName", value="Closed Won") to highlight the automation coupled to that transition.',
    );
  }
  if (appliedScope !== null) {
    disclosures.push(
      `Scoped to ${appliedScope.kind === 'businessProcess' ? 'business process' : 'record type'} \`${appliedScope.requested}\` (record types: ${appliedScope.resolvedRecordTypes.join(', ')}). ` +
        `Excluded ${appliedScope.excludedStepCount} step(s) whose entry condition positively gates \`RecordType.DeveloperName\` to a record type OUTSIDE this scope. ` +
        `\`summary.totalSteps\` (${total}) is the POST-exclusion total: ${appliedScope.excludedStepCount} excluded + ${total} returned reconciles to the ${perEvent.summary.totalSteps} step(s) the unscoped composition holds for this event. ` +
        `This is a SAFE, conservative filter: only positive-equality record-type gates are excluded — unconditional automation (which fires for every record type) and negated gates are RETAINED, so a step is never wrongly dropped. RecordType scoping via hard-coded 18-char RecordTypeId literals or record-type logic encoded in a formula this parser does not read is NOT filtered; treat the scoped chain as "everything that can fire for this record type", not a per-record guarantee.`,
    );
  }
  if (truncated || offset > 0) {
    disclosures.push(
      `Process paginated: showing steps ${offset}–${offset + page.length} of ${total}. coupledAutomation + summary are complete; page with offset/limit.`,
    );
  }
  if (byteTrimmedPage) {
    disclosures.push(
      `Page trimmed to ${page.length} of ${limit} requested steps to stay within this response's byte budget; the sequence is COMPLETE at ${total} steps and the remainder is reachable — advance with the returned nextCursor. This is a page boundary, not a missing step.`,
    );
  }

  return ok({
    data: {
      object,
      event,
      transition: { field, value, description },
      ...(appliedScope !== null ? { appliedScope } : {}),
      process: page,
      coupledAutomation,
      summary: {
        totalSteps: total,
        coupledSteps: coupledAutomation.length,
        fieldCoupledSteps,
        valueCoupledSteps,
      },
      limit,
      offset,
      hasMore,
      truncated,
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      confidence: 'parsed',
      disclosures,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
