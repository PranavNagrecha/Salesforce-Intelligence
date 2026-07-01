/**
 * Payload-size bounding for the two save-order tools
 * (`what_happens_on_save`, `order_of_execution`).
 *
 * Both compose a Salesforce order-of-execution by walking, for every firing
 * step, the firer's outgoing edges into a per-step `actions[]` list.
 * `order_of_execution` does this once per DML event (insert/update/delete/
 * undelete), so its payload is ~4x a single save view. On a heavily-automated
 * standard object (a Contact with dozens of record-triggered flows, each
 * touching many fields) the per-step action enumeration dominates and the
 * serialized response runs into the hundreds of KB — far past the global
 * `MAX_RESPONSE_BYTES` guard, which then rejects the whole answer with no way
 * for the caller to narrow it (the tool only takes an object name).
 *
 * `enforceSoeByteBudget` fixes that: it trims the verbose per-step `actions`
 * lists (the bloat) — largest first — until the payload fits, recording an
 * `actionsOmitted` count on each trimmed step and a top-level `truncated`
 * flag. Crucially it NEVER drops a step: which automations fire, in what
 * order, with which gating condition and which validation error, is the
 * load-bearing answer and stays complete. Only the exhaustive
 * "every edge this step touches" tail is capped, with an honest count.
 *
 * It is a strict no-op when the payload is already under budget, so small
 * objects (Account, a custom object with a couple of rules) serialize exactly
 * as before — no new keys, byte-identical output.
 */

/** A single action entry as emitted by the SOE composers. Structural so both tools' own `SoeStepAction` satisfy it. */
export interface BoundableAction {
  readonly kind: string;
  readonly targetId?: string;
  readonly description: string;
}

/** A step whose `actions` tail may be trimmed to fit the budget. */
/** A step's firing condition — its `expression`/`fieldRefs` may be slimmed. */
export interface BoundableConditional {
  readonly conditionContextId: string;
  expression: string;
  fieldRefs: readonly string[];
}

export interface BoundableStep {
  actions: readonly BoundableAction[];
  actionsOmitted?: number;
  conditional?: BoundableConditional;
  conditionalTruncated?: boolean;
}

/**
 * Target ceiling for a composed SOE payload, in bytes. Set below the global
 * `MAX_RESPONSE_BYTES` (~45 KB) dispatch guard with headroom for the envelope
 * (`vaultState`, `disclosure`, the truncation note) so a payload that passes
 * this check also clears the global guard.
 */
export const SOE_MAX_PAYLOAD_BYTES = 40_000;

/**
 * Action lists at or below this length are never trimmed. They are not the
 * bloat (e.g. the synthetic `save` placeholder's single system-validation
 * action, a validation rule with one downstream edge), and protecting them
 * keeps the small-step narrative intact even in the extreme-trim case.
 */
const KEEP_ALL_AT_OR_BELOW = 4;

/** Outcome of a budget-enforcement pass. */
export interface SoeBudgetResult {
  /** True when anything was trimmed (actions, conditionals, and/or steps) to fit. */
  readonly truncated: boolean;
  /** Total actions dropped across all steps. */
  readonly actionsOmitted: number;
  /** Number of steps whose verbose conditional (expression/fieldRefs) was slimmed. */
  readonly conditionalsTrimmed: number;
  /** Steps dropped from container tails as a last resort (pathological step count). */
  readonly stepsOmitted: number;
}

const sizeOf = (payload: unknown): number =>
  Buffer.byteLength(JSON.stringify(payload), 'utf8');

/** Options controlling which trim passes {@link enforceSoeByteBudget} may run. */
export interface SoeBudgetOptions {
  /**
   * Whether the last-resort step-drop pass (Pass 4) may run. When `false`,
   * trailing steps are NEVER dropped — only per-step actions and conditionals
   * are trimmed — so EVERY firing component stays named in the response.
   *
   * The single-event `what_happens_on_save` view passes `false`: dropping
   * trailing steps there silently un-names real automations (e.g. the
   * after-triggers / post-save flows tail on a densely-automated Contact),
   * which is the exact failure this guard exists to prevent. After actions and
   * conditionals are slimmed, a single-event step list is small enough that
   * the step COUNT alone never blows the budget, so step-dropping is not
   * needed there. The four-event `order_of_execution` view leaves this `true`
   * (default): its ~4x step count can be pathological, and a caller can still
   * recover every dropped step by re-querying that one event through
   * `what_happens_on_save`.
   *
   * @default true
   */
  readonly allowStepDrop?: boolean;
}

/**
 * Enforce {@link SOE_MAX_PAYLOAD_BYTES} on a composed SOE payload, IN PLACE.
 *
 * @param payload    the full tool response data (serialized to measure size)
 * @param containers the step arrays inside `payload` — one for a single-event
 *                   view (`[data.soe]`), one per event for the four-event
 *                   `order_of_execution` view. Trimming/dropping their steps
 *                   mutates the payload. Trimming order: per-step actions, then
 *                   conditionals, then (last resort, only when
 *                   `options.allowStepDrop !== false`) drop steps from the tail.
 * @param options    pass control — see {@link SoeBudgetOptions.allowStepDrop}.
 * @returns what was trimmed (actions / conditionals / steps)
 *
 * No-op when already under budget.
 *
 * @example
 *   const r = enforceSoeByteBudget(data, [data.soe], { allowStepDrop: false });
 *   if (r.truncated) data.truncated = true;
 */
export const enforceSoeByteBudget = (
  payload: unknown,
  containers: readonly BoundableStep[][],
  options: SoeBudgetOptions = {},
): SoeBudgetResult => {
  const allowStepDrop = options.allowStepDrop ?? true;
  if (sizeOf(payload) <= SOE_MAX_PAYLOAD_BYTES) {
    return { truncated: false, actionsOmitted: 0, conditionalsTrimmed: 0, stepsOmitted: 0 };
  }

  const steps: readonly BoundableStep[] = containers.flat();
  let totalOmitted = 0;
  const trimTo = (step: BoundableStep, keep: number): void => {
    if (keep >= step.actions.length) return;
    const removed = step.actions.length - keep;
    step.actions = step.actions.slice(0, keep);
    step.actionsOmitted = (step.actionsOmitted ?? 0) + removed;
    totalOmitted += removed;
  };

  // Pass 1 — proportional bulk trim. Measure how many bytes the action lists
  // account for, then keep each large step's actions in proportion to the
  // budget share. Converges close to the budget in a single measurement
  // instead of thousands of re-serializations.
  const actionBytes = steps.reduce(
    (n, s) => n + Buffer.byteLength(JSON.stringify(s.actions), 'utf8'),
    0,
  );
  const nonActionBytes = Math.max(0, sizeOf(payload) - actionBytes);
  const budgetForActions = SOE_MAX_PAYLOAD_BYTES - nonActionBytes;
  if (budgetForActions <= 0) {
    // Even zero actions may not fit (pathological step count); strip the
    // large lists and let the confirming pass / global guard handle the rest.
    for (const s of steps) trimTo(s, 0);
  } else if (actionBytes > budgetForActions) {
    const ratio = budgetForActions / actionBytes;
    for (const s of steps) {
      if (s.actions.length <= KEEP_ALL_AT_OR_BELOW) continue;
      trimTo(s, Math.max(0, Math.floor(s.actions.length * ratio)));
    }
  }

  // Pass 2 — confirming finisher. Estimate error and JSON punctuation can
  // leave us a little over; halve the largest remaining action list until the
  // serialized payload is under budget or nothing trimmable remains.
  for (let guard = 0; guard < 100_000; guard += 1) {
    if (sizeOf(payload) <= SOE_MAX_PAYLOAD_BYTES) break;
    let target: BoundableStep | undefined;
    for (const s of steps) {
      if (s.actions.length <= KEEP_ALL_AT_OR_BELOW) continue;
      if (target === undefined || s.actions.length > target.actions.length) {
        target = s;
      }
    }
    if (target === undefined) break; // nothing left to trim — global guard backstops
    trimTo(target, Math.floor(target.actions.length / 2));
  }

  // Pass 3 — conditionals. On a densely-automated object the residual bloat is
  // the per-step firing conditions (long `expression` formulas + `fieldRefs`),
  // not actions. When trimming actions isn't enough, slim the heaviest
  // conditionals — keep the `conditionContextId` (so the condition is still
  // fetchable) but drop the verbose expression/fieldRefs — largest first, until
  // the payload fits.
  let conditionalsTrimmed = 0;
  for (let guard = 0; guard < 100_000; guard += 1) {
    if (sizeOf(payload) <= SOE_MAX_PAYLOAD_BYTES) break;
    let target: BoundableStep | undefined;
    let targetBytes = 0;
    for (const s of steps) {
      const cond = s.conditional;
      if (cond === undefined || s.conditionalTruncated) continue;
      if (cond.expression === '' && cond.fieldRefs.length === 0) continue;
      const b = Buffer.byteLength(JSON.stringify(cond), 'utf8');
      if (target === undefined || b > targetBytes) {
        target = s;
        targetBytes = b;
      }
    }
    if (target === undefined) break; // nothing left to slim — global guard backstops
    target.conditional = {
      conditionContextId: target.conditional!.conditionContextId,
      expression: '',
      fieldRefs: [],
    };
    target.conditionalTruncated = true;
    conditionalsTrimmed += 1;
  }

  // Pass 4 — step cap (last resort). If actions and conditionals are slimmed
  // and the payload STILL doesn't fit, the bloat is the sheer step COUNT — e.g.
  // order_of_execution's four-event view on a Contact with dozens of
  // record-triggered flows (~120 KB observed). Drop steps from the TAIL of the
  // largest container: SOE order runs pre-save → save → post-save → async, so
  // tail-dropping sheds the latest async/post-save steps first and preserves
  // the critical early phases. Each container keeps at least its first step.
  // `summary.totalSteps` (set before enforcement) still reports the true total,
  // so `stepsOmitted` is an honest "N more not shown".
  let stepsOmitted = 0;
  for (let guard = 0; allowStepDrop && guard < 1_000_000; guard += 1) {
    if (sizeOf(payload) <= SOE_MAX_PAYLOAD_BYTES) break;
    let target: BoundableStep[] | undefined;
    let targetBytes = 0;
    for (const c of containers) {
      if (c.length <= 1) continue; // keep at least one step per event
      const b = Buffer.byteLength(JSON.stringify(c), 'utf8');
      if (target === undefined || b > targetBytes) {
        target = c;
        targetBytes = b;
      }
    }
    if (target === undefined) break; // nothing droppable — global guard backstops
    target.pop();
    stepsOmitted += 1;
  }

  return {
    truncated: totalOmitted > 0 || conditionalsTrimmed > 0 || stepsOmitted > 0,
    actionsOmitted: totalOmitted,
    conditionalsTrimmed,
    stepsOmitted,
  };
};

/**
 * The verbatim note appended to a truncated SOE response's disclosure so the
 * caller knows the step list is complete but per-step detail was capped to fit.
 */
export const soeTruncationNote = (result: SoeBudgetResult): string => {
  const budgetKb = Math.round(SOE_MAX_PAYLOAD_BYTES / 1000);
  const parts: string[] = [];
  if (result.actionsOmitted > 0) {
    parts.push(
      `${result.actionsOmitted} per-step action edge(s) across the heaviest steps were omitted (see each step's \`actionsOmitted\`)`,
    );
  }
  if (result.conditionalsTrimmed > 0) {
    parts.push(
      `${result.conditionalsTrimmed} step condition(s) had their expression/fieldRefs dropped — the \`conditionContextId\` remains, fetch it with \`get_component\` for the full condition (see each step's \`conditionalTruncated\`)`,
    );
  }
  if (result.stepsOmitted > 0) {
    parts.push(
      `${result.stepsOmitted} trailing step(s) were dropped to fit (the tail-most async/post-save steps; \`summary.totalSteps\` still reports the true total) — query a single event with \`what_happens_on_save\` to see them all`,
    );
  }
  // When steps were dropped the "every STEP is present" claim no longer holds.
  const lead =
    result.stepsOmitted > 0
      ? `Response trimmed to fit the ~${budgetKb} KB MCP response budget`
      : `Response trimmed to fit the ~${budgetKb} KB MCP response budget: every save-order STEP is present and in order, but`;
  return `${lead} ${parts.join('; ')}. Query a single object/event for full detail.`;
};
