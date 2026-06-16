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
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import { mergeInputAliases, toObjectApiName } from './input-aliases.js';
import { orderOfExecutionHandler, type SoeStep } from './order-of-execution.js';

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
  readonly confidence: 'parsed';
  readonly disclosures: readonly string[];
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
  const allSteps = perEvent.soe.map((s) => annotate(s, fieldId, value));

  const coupledAutomation = allSteps.filter((s) => s.coupledToField || s.coupledToValue);
  const fieldCoupledSteps = allSteps.filter((s) => s.coupledToField).length;
  const valueCoupledSteps = allSteps.filter((s) => s.coupledToValue).length;

  const total = allSteps.length;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const page = allSteps.slice(offset, offset + limit);
  const hasMore = offset + page.length < total;
  const truncated = hasMore || offset > 0;

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
      confidence: 'parsed',
      disclosures,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
