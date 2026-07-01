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
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import { mergeInputAliases, toObjectApiName } from './input-aliases.js';
import { orderOfExecutionHandler, type SoeStep } from './order-of-execution.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** A value transition is an update; record creation with a value is an insert. */
const LIFECYCLE_EVENTS = ['insert', 'update'] as const;
type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

const lifecycleProcessInputBaseSchema = z.object({
  objectApiName: z.string().min(1),
  field: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  event: z.enum(LIFECYCLE_EVENTS).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0 / explicit `offset`).
  cursor: z.string().min(1).optional(),
});

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
): LifecycleStep => {
  const cond = step.conditional;
  const expression = cond?.expression;
  const coupledToField =
    fieldId !== null && cond !== undefined && cond.fieldRefs.includes(fieldId as ComponentId);
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
  };
};

/**
 * The `sfi.lifecycle_process` MCP tool. Composes the order of execution for a
 * value/stage transition and highlights the automation coupled to it.
 */
export const lifecycleProcessHandler = async (
  ctx: Context,
  input: LifecycleProcessInput,
): Promise<Result<McpResponse<LifecycleProcessOutput>, McpError>> => {
  const object = input.objectApiName;
  const event: LifecycleEvent = input.event ?? 'update';
  const field = input.field ?? null;
  const value = input.value ?? null;
  const fieldId = field !== null ? `CustomField:${object}.${field}` : null;

  // Reuse the tested SOE composition so the chain always agrees with
  // order_of_execution. It validates the object + emits the per-event chain.
  const soeResult = await orderOfExecutionHandler(ctx, { objectApiName: object });
  if (!soeResult.ok) return soeResult;
  const perEvent = soeResult.value.data.byEvent[event];
  // Pair each annotated step with its source SoeStep's stepIndex (index-aligned
  // 1:1 with perEvent.soe) so the cursor can carry the unique total-order key
  // WITHOUT emitting it on the visible row.
  const carriers: LifecycleStepCarrier[] = perEvent.soe.map((s) => ({
    step: annotate(s, fieldId, value),
    stepIndex: s.stepIndex,
  }));
  const allSteps = carriers.map((c) => c.step);

  const coupledAutomation = allSteps.filter((s) => s.coupledToField || s.coupledToValue);
  const fieldCoupledSteps = allSteps.filter((s) => s.coupledToField).length;
  const valueCoupledSteps = allSteps.filter((s) => s.coupledToValue).length;

  const total = allSteps.length;
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

  // No per-handler byte budget today (unbounded slice; the global jsonResult
  // guard is the byte backstop). Keep that by setting an effectively-unbounded
  // byteBudget so `paginate()` truncates ONLY on `limit` (byte-identical to the
  // prior open-coded slice — a currently-whole large page is not byte-trimmed).
  const paged = paginateLegacy(carriers, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
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
  const truncated = hasMore || offset > 0;
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
    'This is the metadata automation chain. It does not include manual user actions, the runtime field-history / audit trail, roll-up / cross-object parent recalculation, or external callouts.',
  ];
  if (field === null || value === null) {
    disclosures.push(
      'No specific value transition supplied — showing the full automation chain. Pass `field` + `value` (e.g. field="StageName", value="Closed Won") to highlight the automation coupled to that transition.',
    );
  }
  if (truncated) {
    disclosures.push(
      `Process paginated: showing steps ${offset}–${offset + page.length} of ${total}. coupledAutomation + summary are complete; page with offset/limit.`,
    );
  }

  return ok({
    data: {
      object,
      event,
      transition: { field, value, description },
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
