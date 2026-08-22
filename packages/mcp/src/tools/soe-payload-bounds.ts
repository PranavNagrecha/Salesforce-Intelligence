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

import { toolLocalPayloadBudgetBytes } from './response-budget.js';

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
  /**
   * The grounding census. Carried through Pass 3 DELIBERATELY.
   *
   * The trim empties `fieldRefs`, and an empty `fieldRefs` is only readable
   * because this census says whether the refs were CHECKED and how many were
   * grounded. A type that discarded it would turn every trimmed condition into
   * an unreadable `fieldRefs: []` — "this condition reads nothing" — which is
   * the exact false-absence this batch exists to remove. It lives here rather
   * than being re-stamped by the handler afterwards so that a future change to
   * this pass cannot silently reintroduce that shape.
   */
  refGrounding?: {
    readonly checked: boolean;
    readonly grounded: number;
    readonly ungrounded: number;
  };
  /**
   * The verbose ungrounded roster. Declared so this pass OWNS the decision to
   * drop it rather than discarding it by omission: it is the bloat the budget
   * came for, and `refGrounding.ungrounded` still reports how many there were.
   */
  ungroundedRefs?: readonly unknown[];
}

export interface BoundableStep {
  actions: readonly BoundableAction[];
  actionsOmitted?: number;
  conditional?: BoundableConditional;
  conditionalTruncated?: boolean;
}

/**
 * The cap a composed SOE payload is fitted to, DERIVED from the global response
 * budget.
 *
 * It used to be a hard-coded `40_000` — the same number as the global budget's
 * default, which reserves 1 024 of that for the envelope's own fields. Its
 * effective ceiling is therefore 38 976, so a save-order payload fitted to
 * EXACTLY 40 000 was unconditionally over it, and the global reducer — which
 * IS allowed to drop steps — trimmed a payload whose own guard had refused to
 * drop any. Measured on a real org: a busy object's save order lost 55 of 109
 * steps that way, with `allowStepDrop: false` in force the whole time.
 *
 * Two magic numbers that must stay ordered drift the moment either moves, so
 * this one is computed instead. `soeBudgetBytes() < responseReductionCap()`
 * holds by construction at every value of `SFI_MAX_RESPONSE_BYTES`, and
 * `response-budget.test.ts` pins the ORDERING, not the values.
 */
export const soeBudgetBytes = (): number => toolLocalPayloadBudgetBytes();

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
  /**
   * Ceiling this pass trims the payload to, in bytes. Defaults to
   * {@link soeBudgetBytes}.
   *
   * A caller that appends HONESTY scaffolding to the payload AFTER enforcement
   * — the four-event `order_of_execution` view attaches per-event
   * `phasesOmitted` and a phases-dropped disclosure note once it knows what the
   * step-drop shed — passes a value BELOW {@link soeBudgetBytes} to
   * reserve headroom for those additions. Without the reserve the post-
   * enforcement additions push the payload back over budget, forcing the global
   * dispatch guard to mangle the (load-bearing) disclosure or — since the nested
   * per-event `soe` arrays are not reducible by that guard — reject the whole
   * answer. Reserving here keeps the FINAL `data` (scaffolding included) within
   * budget, so both save-order tools obey one envelope law
   * (ORDER-OF-EXECUTION-OVERSIZE-HARD-FAIL). Never raised above
   * {@link soeBudgetBytes}.
   */
  readonly budgetBytes?: number;
}

/**
 * Enforce {@link soeBudgetBytes} on a composed SOE payload, IN PLACE.
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
  // Never above the global SOE ceiling; a caller may reserve headroom below it.
  const ceiling = soeBudgetBytes();
  const budgetBytes = Math.min(options.budgetBytes ?? ceiling, ceiling);
  if (sizeOf(payload) <= budgetBytes) {
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
  const budgetForActions = budgetBytes - nonActionBytes;
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
    if (sizeOf(payload) <= budgetBytes) break;
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
    if (sizeOf(payload) <= budgetBytes) break;
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
    const priorConditional = target.conditional!;
    target.conditional = {
      conditionContextId: priorConditional.conditionContextId,
      expression: '',
      fieldRefs: [],
      // PRESERVE the census. `fieldRefs: []` next to `conditionalTruncated:
      // true` says the list was CUT; without these counts it would instead read
      // as "this condition reads nothing".
      ...(priorConditional.refGrounding !== undefined
        ? { refGrounding: priorConditional.refGrounding }
        : {}),
      // `ungroundedRefs` is intentionally NOT carried: it is the verbose part
      // the budget cut, and refGrounding.ungrounded still names how many.
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
    if (sizeOf(payload) <= budgetBytes) break;
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
 * The clause {@link soeTruncationNote} adds when THIS layer dropped no step.
 *
 * It is a claim about the payload as the tool-local guard left it, and the
 * GLOBAL response reducer can invalidate it afterwards by tail-truncating
 * `soe`. Named here so {@link reconcileSoePhasesOmittedAfterGlobalTrim} can
 * excise the exact clause once that has happened, instead of leaving a
 * response asserting "every save-order STEP is present" beside a `soe` holding
 * 27 of 109 steps. Removing it leaves the sentence in precisely the shape the
 * `stepsOmitted > 0` branch produces.
 */
const ALL_STEPS_PRESENT_CLAIM =
  ': every save-order STEP is present and in order, but';

/**
 * The verbatim note appended to a truncated SOE response's disclosure so the
 * caller knows the step list is complete but per-step detail was capped to fit.
 */
export const soeTruncationNote = (result: SoeBudgetResult): string => {
  const budgetKb = Math.round(soeBudgetBytes() / 1000);
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
      : `Response trimmed to fit the ~${budgetKb} KB MCP response budget${ALL_STEPS_PRESENT_CLAIM}`;
  return `${lead} ${parts.join('; ')}. Query a single object/event for full detail.`;
};

// ---------------------------------------------------------------------------
// Shared phase-omission contract (the truncation-honesty half of the envelope
// law). BOTH save-order tools — `what_happens_on_save` (single event) and
// `order_of_execution` (four events) — must agree on which automation phases a
// composed SOE has, how to count them, and how a byte-budget-truncated payload
// discloses a phase it could no longer fully represent. Previously each tool
// carried its own copy of these types + helpers; a divergence between the two
// copies would let one tool's truncated payload silently contradict its own
// `phaseCounts` while the other stayed honest. They live here so there is ONE
// definition (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES /
// ORDER-OF-EXECUTION-OVERSIZE-HARD-FAIL). Each tool re-exports them so its
// public type surface is unchanged.
// ---------------------------------------------------------------------------

/**
 * Which phase of the documented Salesforce order of execution a step comes
 * from. The order matches the platform's evaluation sequence; `save` is a
 * placeholder representing the database write itself (not org automation).
 */
export type SoePhase =
  | 'before-save-flows'
  | 'pre-save-triggers'
  | 'pre-save-validation'
  | 'duplicate-rules'
  | 'save'
  | 'after-triggers'
  | 'post-save-assignment'
  | 'post-save-workflows'
  | 'post-save-flows'
  | 'post-save-approval'
  | 'post-save-rollup-recalc'
  | 'post-save-async';

/**
 * Every {@link SoePhase} except the `save` placeholder, frozen in documented
 * SOE order so a per-phase count map iterates in firing sequence. `as const` so
 * it doubles as the `phase`-filter enum on both tools' input schemas.
 */
export const AUTOMATION_PHASES = [
  'before-save-flows',
  'pre-save-triggers',
  'pre-save-validation',
  'duplicate-rules',
  'after-triggers',
  'post-save-assignment',
  'post-save-workflows',
  'post-save-flows',
  'post-save-approval',
  'post-save-rollup-recalc',
  'post-save-async',
] as const satisfies readonly Exclude<SoePhase, 'save'>[];

/**
 * Grounded per-phase active-component counts for a composed SOE. Each key is an
 * automation phase (the `save` placeholder excluded — it is the platform's own
 * write, not org automation); each value is the number of ACTIVE components
 * emitted into that phase. Every phase is present (zero when empty) for a
 * stable, indexable map.
 */
export type SoePhaseCounts = Readonly<Record<Exclude<SoePhase, 'save'>, number>>;

/**
 * Tally the active components emitted into each automation phase. The `save`
 * placeholder is never counted. Phases with zero emitted steps are present with
 * a `0` so the map is a complete, stable shape every caller can index.
 */
export const tallyPhaseCounts = (
  soe: readonly { readonly phase: SoePhase }[],
): SoePhaseCounts => {
  const counts = Object.fromEntries(
    AUTOMATION_PHASES.map((p) => [p, 0]),
  ) as Record<Exclude<SoePhase, 'save'>, number>;
  for (const step of soe) {
    if (step.phase === 'save') continue;
    counts[step.phase] += 1;
  }
  return counts;
};

/**
 * One phase whose full step roster could not fit the returned `soe` after
 * byte-budget enforcement dropped trailing steps: `declared` is the true
 * per-phase count (still in `summary.phaseCounts`), `present` is how many of
 * that phase's steps survived in `soe`. Surfaced so a truncated payload can
 * NEVER silently contradict `phaseCounts` — a phase the counts claim but the
 * sequence omits is named here, with a pointer to the `phase` filter for
 * recovery.
 */
export interface SoePhaseOmission {
  readonly phase: Exclude<SoePhase, 'save'>;
  readonly declared: number;
  readonly present: number;
}

/**
 * Compute the phases whose `soe` representation fell below their true
 * `phaseCounts` after enforcement dropped steps. Empty when the sequence still
 * fully represents every phase (the norm for `what_happens_on_save`, which
 * never drops steps; the four-event `order_of_execution` view is where
 * step-drop actually bites).
 */
export const computePhasesOmitted = (
  declared: SoePhaseCounts,
  survivingSoe: readonly { readonly phase: SoePhase }[],
  /**
   * When the payload is PHASE-FILTERED, restrict the comparison to that one
   * phase. A phase-filtered `soe` is an intentional subset, so comparing it
   * against every phase's declared count would flag every such response; but
   * comparing it against ITS OWN declared count is exactly the question that
   * matters — "did the requested phase come back whole?". Omitting the
   * parameter keeps the full cross-phase behaviour byte-identical.
   */
  onlyPhase?: SoePhase,
): SoePhaseOmission[] => {
  const survived = tallyPhaseCounts(survivingSoe);
  const omitted: SoePhaseOmission[] = [];
  for (const phase of AUTOMATION_PHASES) {
    if (onlyPhase !== undefined && phase !== onlyPhase) continue;
    if (declared[phase] > survived[phase]) {
      omitted.push({ phase, declared: declared[phase], present: survived[phase] });
    }
  }
  return omitted;
};

/** Escape a literal so it can be embedded in a `RegExp` source. */
const escapeRegExp = (raw: string): string =>
  raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The two halves of the PHASE-FILTERED shortfall sentence, either side of its
 * one variable slot (`present`). The sentence AND the matcher that finds an
 * already-baked copy are both assembled from these, so a rewording can never
 * leave behind a matcher that silently stops matching and starts appending
 * duplicate prose.
 */
const filteredPhaseShortfallHead = (
  phase: Exclude<SoePhase, 'save'>,
  declared: number,
): string => `You asked for the ${phase} phase, which holds ${declared} step(s); `;
const FILTERED_PHASE_SHORTFALL_TAIL =
  ' fitted in this response. This is a byte-budget cut, not a smaller phase — narrow further with limit/offset, or pass includeConceptReasoning: false.';

/**
 * Verbatim shortfall sentence for a truncated PHASE-FILTERED call.
 *
 * Lives here, beside {@link computePhasesOmitted}, because the numbers in it
 * are that function's output and nothing else's. The handler bakes it from the
 * step count it can see; the GLOBAL budget can cut `soe` again afterwards, and
 * {@link reconcileSoePhasesOmittedAfterGlobalTrim} then rewrites this sentence
 * from the RECONCILED omission — one template, one source of numbers, so the
 * prose and `phasesOmitted` can never state two different counts for one fact.
 */
export const filteredPhaseShortfallNote = (
  omission: SoePhaseOmission,
): string =>
  `${filteredPhaseShortfallHead(omission.phase, omission.declared)}${
    omission.present
  }${FILTERED_PHASE_SHORTFALL_TAIL}`;

/** The two halves of the CROSS-PHASE sentence, either side of its phase list. */
const CROSS_PHASE_SHORTFALL_HEAD = 'Note: ';
const CROSS_PHASE_SHORTFALL_TAIL =
  ' truncated out of the returned sequence — re-query with the `phase` filter to see the full roster.';

/** Verbatim CROSS-PHASE shortfall sentence, from the same reconciled list. */
export const crossPhaseShortfallNote = (
  omitted: readonly SoePhaseOmission[],
): string =>
  `${CROSS_PHASE_SHORTFALL_HEAD}${omitted
    .map((p) => `${p.phase} (${p.present}/${p.declared} shown)`)
    .join(', ')}${CROSS_PHASE_SHORTFALL_TAIL}`;

/**
 * Replace an already-baked shortfall sentence with the one built from the
 * RECONCILED omission, or append it when the handler baked none (the global
 * trim can create a shortfall the handler never saw).
 */
const restatePhaseShortfall = (
  disclosure: string,
  fresh: string,
  head: string,
  slot: string,
  tail: string,
): string => {
  const pattern = new RegExp(
    `${escapeRegExp(head)}${slot}${escapeRegExp(tail)}`,
    'g',
  );
  return pattern.test(disclosure)
    ? disclosure.replace(pattern, fresh)
    : `${disclosure} ${fresh}`;
};

/**
 * Reconcile `phasesOmitted` on a composed-SOE payload AFTER the GLOBAL response
 * budget (`jsonResult`) tail-truncated its `data.soe` array — the second half of
 * the envelope law, closing the residual the tool-local guard cannot reach.
 *
 * The single-event `what_happens_on_save` view runs {@link enforceSoeByteBudget}
 * with `allowStepDrop: false`, so it never drops a firing STEP — but it can hand
 * the dispatcher a payload that is STILL over budget when the step COUNT alone
 * blows it (dozens of firers each with a tiny action list nothing can trim). The
 * global `jsonResult` guard then tail-truncates the largest `data` array —
 * `soe` — to fit, and because SOE order runs pre-save → save → post-save →
 * async, tail-dropping sheds the LATER phases first (after-triggers,
 * duplicate-rules relative to the survivors, post-save-flows, async). Left
 * unreconciled the trimmed `soe` lets a host invent "no duplicate rules / no
 * after-triggers fire on save" while `summary.phaseCounts` still reports them —
 * the exact honesty break this closes.
 *
 * This recomputes {@link computePhasesOmitted} from the SURVIVING `soe` against
 * the (untouched) `summary.phaseCounts` and stamps `phasesOmitted`, so a
 * globally-trimmed SOE payload obeys the SAME shared omission contract the
 * tool-local path and `order_of_execution` already do — ONE definition, never a
 * divergent copy (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES).
 *
 * No-op unless `data` is a composed-SOE payload (an `soe` array of phase-tagged
 * steps + a `summary.phaseCounts` map). It runs on the phase-FILTERED view too,
 * scoped to the requested phase: that view is the RECOVERY path the full view
 * points at, so a shortfall there is the last place a caller can find out.
 * Every non-SOE payload is left byte-identical. Mutates `data` in place.
 *
 * @returns `true` when it changed `phasesOmitted`, else `false`.
 */
export const reconcileSoePhasesOmittedAfterGlobalTrim = (
  data: unknown,
): boolean => {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const rec = data as Record<string, unknown>;
  // A phase-filtered view narrows `soe` on purpose while `phaseCounts` stays the
  // whole composition, so a CROSS-PHASE delta there is not an omission. That
  // reasoning is right and the old action was not: returning early skipped the
  // backstop entirely, so a phase-filtered payload trimmed by the GLOBAL budget
  // lost steps with nothing to say so — the defect surviving in the very path
  // that exists to catch it. Narrow the comparison to the requested phase
  // instead: a phase filter chooses WHICH phase comes back, never consents to
  // getting a partial one silently.
  const appliedPhaseFilterRaw = rec['appliedPhaseFilter'];
  const onlyPhase =
    typeof appliedPhaseFilterRaw === 'string'
      ? (appliedPhaseFilterRaw as SoePhase)
      : undefined;
  const soe = rec['soe'];
  const summary = rec['summary'];
  if (
    !Array.isArray(soe) ||
    summary === null ||
    typeof summary !== 'object' ||
    Array.isArray(summary)
  ) {
    return false;
  }
  const phaseCounts = (summary as Record<string, unknown>)['phaseCounts'];
  if (
    phaseCounts === null ||
    typeof phaseCounts !== 'object' ||
    Array.isArray(phaseCounts)
  ) {
    return false;
  }
  // Only touch a genuine SOE step list — every element must be a phase-tagged
  // step. Guards against a same-named non-SOE `soe` array on another tool.
  const isSoeSteps = soe.every(
    (s): s is { readonly phase: SoePhase } =>
      s !== null &&
      typeof s === 'object' &&
      typeof (s as Record<string, unknown>)['phase'] === 'string',
  );
  if (!isSoeSteps) return false;
  const omitted = computePhasesOmitted(
    phaseCounts as SoePhaseCounts,
    soe as readonly { readonly phase: SoePhase }[],
    onlyPhase,
  );
  if (omitted.length > 0) {
    rec['phasesOmitted'] = omitted;
    // The handler baked its shortfall PROSE from the step count it could see;
    // the global trim has since cut `soe` further. Leaving the sentence alone
    // shipped two numbers for one fact ("25 fitted in this response" beside
    // `phasesOmitted: [{declared: 40, present: 12}]`). Restate it from the
    // reconciled omission — and APPEND it when the handler baked none, which is
    // the ordinary case on the cross-phase path where the tool-local guard
    // never drops a step and only the global trim does.
    const disclosure = rec['disclosure'];
    if (typeof disclosure === 'string') {
      const sole = omitted[0];
      // The tool-local guard ran with `allowStepDrop: false`, so its truncation
      // note claims "every save-order STEP is present and in order". Steps have
      // since been dropped, so that clause is now false — excise it before
      // restating the counts.
      const corrected = disclosure.replace(ALL_STEPS_PRESENT_CLAIM, '');
      rec['disclosure'] =
        onlyPhase !== undefined && omitted.length === 1 && sole !== undefined
          ? restatePhaseShortfall(
              corrected,
              filteredPhaseShortfallNote(sole),
              filteredPhaseShortfallHead(sole.phase, sole.declared),
              '\\d+',
              FILTERED_PHASE_SHORTFALL_TAIL,
            )
          : restatePhaseShortfall(
              corrected,
              crossPhaseShortfallNote(omitted),
              CROSS_PHASE_SHORTFALL_HEAD,
              '[^.]+?',
              CROSS_PHASE_SHORTFALL_TAIL,
            );
    }
    return true;
  }
  // Survivors still fully represent every phase — drop any stale marker so a
  // globally-trimmed payload never carries a contradictory omission list.
  if ('phasesOmitted' in rec) {
    delete rec['phasesOmitted'];
    return true;
  }
  return false;
};
