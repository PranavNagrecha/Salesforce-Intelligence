/**
 * Handler for the `sfi.action_chain` MCP tool.
 *
 * ## What this closes
 *
 * The product models exactly ONE Salesforce action as a chain — the record save
 * (`order_of_execution` / `what_happens_on_save`). `lifecycle_process` already
 * ships the honest disclosure that the OTHER distinct record actions are out of
 * that view:
 *
 *   > "Distinct record ACTIONS — Lead Convert (IsConverted), Approval
 *   > submission, and Activation — are not plain field edits and are not
 *   > modeled as save-order steps …"
 *
 * That disclosure is both honest and a precise specification of the gap. This
 * tool closes two of the named ones: **Lead Convert** and **approval
 * submission / approve / reject / recall**. It does NOT close owner change,
 * merge, activation, delete/undelete or login — those remain out of scope and
 * are named as such in the refusal message, so an unmodeled action is a
 * refusal, never a wrong answer.
 *
 * ## Method
 *
 * Identical in method to the save-order engine: take the DOCUMENTED Salesforce
 * sequence for the action and instantiate it against THIS org's extracted
 * automation. Where a step fires a record save, the save-order engine is CALLED
 * (`what_happens_on_save`) rather than reimplemented, so the nested view can
 * never disagree with the save-order tools.
 *
 * ## Honesty axis
 *
 * Every documented step is emitted whether or not this vault could fill it, and
 * an unfilled step carries a TYPED reason:
 *
 *   - `unresolved`    — the vault lacks the metadata (a HOLE, never a zero).
 *   - `not-modeled`   — this tool does not model the surface (a blind spot,
 *                       named out loud).
 *   - `verified-none` — the org provably has none, justified against the
 *                       manifest's own family coverage.
 *
 * Conditions are LISTED, NOT EVALUATED. Nested saves are depth-capped at 1 and
 * the cap is disclosed on every response. Nothing here claims runtime
 * behaviour — it is static composition over declared metadata.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  APPROVAL_OUTCOMES,
  type ApprovalOutcome,
  approvalChainDisclosures,
  composeApprovalProcessChain,
} from './action-chain-approval.js';
import { composeLeadConvertChain } from './action-chain-lead-convert.js';
import {
  ACTION_CHAIN_ACTIONS,
  ACTION_CHAIN_MAX_PAYLOAD_BYTES,
  type ActionChainAction,
  actionChainTrust,
  assertChainStepJustified,
  buildActionChainEvidenceEnvelope,
  capStepComponents,
  type ChainResolutionCounts,
  type ChainStep,
  enforceNestedSaveBudget,
  NESTED_SAVE_DEPTH_CAP,
  NESTED_SAVE_DEPTH_DISCLOSURE,
  sizeOfBytes,
  tallyResolutions,
  unknownActionError,
} from './action-chain-model.js';
import { resolveExistingObjectScope } from './input-aliases.js';

/** Default / max number of ApprovalProcess components composed in one call. */
const DEFAULT_PROCESS_LIMIT = 5;
const MAX_PROCESS_LIMIT = 25;

/** The object a lead convert is always scoped to. */
const LEAD_OBJECT = 'Lead';

/** Canonical id prefix for an ApprovalProcess, named once so the three sites
 * that parse, build and rebuild the id can never drift apart. */
const APPROVAL_PROCESS_PREFIX = 'ApprovalProcess:';

/**
 * Accepted spellings for each modeled action. Hosts and routers phrase the same
 * action several ways; every spelling here resolves to exactly one modeled
 * chain, and anything NOT here is refused by name rather than guessed at.
 */
const ACTION_ALIASES: Readonly<Record<string, ActionChainAction>> = Object.freeze({
  // Every CANONICAL name, spread from the single source of truth so a new
  // modeled action is accepted by its own name without touching this table.
  ...(Object.fromEntries(ACTION_CHAIN_ACTIONS.map((a) => [a, a])) as Record<
    string,
    ActionChainAction
  >),
  'lead_convert': 'lead-convert',
  leadconvert: 'lead-convert',
  'convert-lead': 'lead-convert',
  'convert_lead': 'lead-convert',
  convert: 'lead-convert',
  'approval_submit': 'approval-submit',
  approvalsubmit: 'approval-submit',
  approval: 'approval-submit',
  'submit-for-approval': 'approval-submit',
  'submit_for_approval': 'approval-submit',
  approve: 'approval-submit',
});

/**
 * The verbatim honesty disclosure every response carries. Deliberately shaped
 * like the save-order tools' `DISCLOSURE`: it states the method, then names
 * every boundary rather than leaving the reader to discover them.
 */
const DISCLOSURE =
  "This composes the DOCUMENTED Salesforce sequence for a record ACTION and instantiates it against THIS org's extracted metadata — the same method `order_of_execution` uses for the record save, applied to an action that is not a plain field edit. Conditions ARE listed but NOT EVALUATED: the tool does not know whether a particular record satisfies them at runtime, and it never claims a step executed. Every documented step is emitted even when this vault cannot fill it, carrying a typed reason — `unresolved` means the metadata is MISSING (a hole, never a zero), `not-modeled` means THIS TOOL does not model the surface (a blind spot, not an org fact), and `verified-none` means the org provably has none, justified against the vault manifest's own family-coverage row. Those three are never interchangeable. Runtime state is out of scope throughout: per-user permission evaluation, the records an action touches, and the live status of any in-flight request are not in an offline metadata vault.";

/** Zod schema for the `sfi.action_chain` tool input. */
export const actionChainInputSchema = z
  .object({
    /**
     * DELIBERATELY a free string here, not a Zod enum, though the advertised
     * JSON Schema DOES carry the enum (a documented, precedented divergence —
     * `integrationMapInputSchema` accepts args only to refuse them with a
     * better message). A bare enum rejects `action: 'owner-change'` with
     * "Invalid enum value", which reads as "you typed it wrong". The truth is
     * different and worth saying: owner change IS a chain of ten things, this
     * tool just does not model it yet. {@link unknownActionError} says that.
     */
    action: z.string().min(1),
    objectApiName: z.string().min(1).optional(),
    object: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    /**
     * Narrow an `approval-submit` chain to ONE process — a canonical
     * `ApprovalProcess:{Object}.{Name}` id, or the bare process name when the
     * object is also named.
     */
    approvalProcess: z.string().min(1).optional(),
    /** Which terminal branch(es) of an approval chain to expand. Default `all`. */
    outcome: z.enum(APPROVAL_OUTCOMES).optional(),
    /**
     * `0` names each nested save without expanding it; `1` (the default, and
     * the cap) expands the save orders the action itself performs. See
     * `NESTED_SAVE_DEPTH_DISCLOSURE` for why there is no depth 2.
     */
    nestedSaveDepth: z.union([z.literal(0), z.literal(1)]).optional(),
    limit: z.number().int().min(1).max(MAX_PROCESS_LIMIT).optional(),
  })
  .strict();

export type ActionChainInput = z.infer<typeof actionChainInputSchema>;

/** One composed chain: the subject it belongs to plus its ordered steps. */
export interface ActionChainView {
  readonly subject: {
    /** `object` for a lead convert; `component` for one approval process. */
    readonly kind: 'object' | 'component';
    readonly componentId: ComponentId | null;
    readonly apiName: string;
    /** Present for an approval process: whether it is active. */
    readonly active?: boolean;
  };
  readonly steps: readonly ChainStep[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ActionChainOutput {
  readonly action: ActionChainAction;
  readonly appliedScope: {
    readonly action: ActionChainAction;
    readonly object: string;
    readonly outcome?: ApprovalOutcome;
    readonly approvalProcess?: ComponentId;
    readonly nestedSaveDepth: 0 | 1;
  };
  /** One chain per subject, in canonical id order. */
  readonly chains: readonly ActionChainView[];
  readonly summary: {
    readonly chains: number;
    readonly totalSteps: number;
    /** Steps by resolution across every chain. Every key present (zero when empty). */
    readonly resolutionCounts: ChainResolutionCounts;
    /** Save orders composed by calling the save-order engine. */
    readonly nestedSaves: number;
    /** Steps whose components resolved but whose firing switch did not. */
    readonly unresolvedGates: number;
  };
  /** Subjects found but NOT composed because the process cap was hit. */
  readonly omittedSubjects?: readonly ComponentId[];
  readonly confidence: 'declared';
  readonly disclosures: readonly string[];
  readonly evidenceEnvelope: ReturnType<typeof buildActionChainEvidenceEnvelope>;
}

/**
 * Resolve the ApprovalProcess node(s) in scope. Either one named process or
 * every process parented to the named object, capped and disclosed.
 */
const resolveApprovalProcesses = async (
  ctx: Context,
  objectApiName: string,
  approvalProcess: string | undefined,
  limit: number,
): Promise<
  Result<
    { readonly processes: readonly Node[]; readonly omitted: readonly ComponentId[] },
    McpError
  >
> => {
  if (approvalProcess !== undefined) {
    const id = approvalProcess.startsWith(APPROVAL_PROCESS_PREFIX)
      ? approvalProcess
      : `${APPROVAL_PROCESS_PREFIX}${objectApiName}.${approvalProcess}`;
    const node = await getNodeById(ctx.graph, id as ComponentId);
    if (!node.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
    }
    if (node.value === null) {
      return err({
        kind: 'component-not-found',
        message: `no ApprovalProcess \`${id}\` in this vault. Omit \`approvalProcess\` to compose every approval process on \`${objectApiName}\`, or check the name with \`sfi.list_components\`.`,
        path: id,
      });
    }
    return ok({ processes: [node.value], omitted: [] });
  }
  const all = await listNodesByType(ctx.graph, 'ApprovalProcess', {
    parentId: `CustomObject:${objectApiName}`,
    limit: MAX_PROCESS_LIMIT + 1,
  });
  if (!all.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${all.error.message}` });
  }
  const sorted = [...all.value].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ok({
    processes: sorted.slice(0, limit),
    omitted: sorted.slice(limit).map((n) => n.id),
  });
};

/**
 * The `sfi.action_chain` MCP tool.
 *
 * @example
 *   const r = await actionChainHandler(ctx, { action: 'lead-convert' });
 *   if (r.ok) for (const step of r.value.data.chains[0]!.steps) {
 *     console.log(step.stepIndex, step.phase, step.resolution, step.title);
 *   }
 */
export const actionChainHandler = async (
  ctx: Context,
  input: ActionChainInput,
): Promise<Result<McpResponse<ActionChainOutput>, McpError>> => {
  // Normalize the phrasings a host or router is likely to produce, then refuse
  // anything still unrecognized BY NAME (see `unknownActionError`) rather than
  // guessing at the closest modeled action.
  const requestedAction = ACTION_ALIASES[input.action.trim().toLowerCase()];
  if (requestedAction === undefined) return err(unknownActionError(input.action));
  const action: ActionChainAction = requestedAction;

  // ACTION-CHAIN-UNCHECKED-OBJECT-SCOPE: the named object is VERIFIED to exist
  // in the vault before anything is templated from it. The sync
  // `resolveObjectAlias` alone never asks the graph, so `objectApiName:
  // 'opportunity'` became `parentId: 'CustomObject:opportunity'` — an id no
  // vault holds — the ApprovalProcess query came back empty, and the empty
  // branch below then emitted the strongest affirmative sentence this tool
  // owns ("a VERIFIED NONE … the object genuinely has no approval process")
  // about an object it had never confirmed exists. An UNCHECKED zero relabelled
  // a CHECKED one. `resolveExistingObjectScope` corrects the caller's casing to
  // the vault's exact spelling, refuses an api name the vault does not hold,
  // and refuses two ids that differ only by case rather than picking one — so
  // by the time `object` reaches the parentId template it is a real node id.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input);
  if (!scopeResult.ok) return err(scopeResult.error);
  const namedObject = scopeResult.value?.object ?? null;
  const nestedSaveDepth: 0 | 1 = input.nestedSaveDepth ?? NESTED_SAVE_DEPTH_CAP;

  const disclosures: string[] = [DISCLOSURE, NESTED_SAVE_DEPTH_DISCLOSURE];
  // The save-order engine's own verbatim disclosure, deduped across every
  // nested chain and surfaced ONCE — four byte-identical copies of it alone
  // overran the response budget on the real sandbox.
  const soeDisclosureSink = new Set<string>();
  let chains: readonly ActionChainView[];
  let object: string;
  let omitted: readonly ComponentId[] = [];
  let outcome: ApprovalOutcome | undefined;
  let approvalProcessId: ComponentId | undefined;

  if (action === 'lead-convert') {
    // A lead convert is Lead-scoped by definition. Naming a DIFFERENT object is
    // a caller error worth refusing: silently answering for Lead would hand back
    // a confidently wrong chain for the object they asked about.
    if (namedObject !== null && namedObject !== LEAD_OBJECT) {
      return err({
        kind: 'invalid-query',
        message: `\`action: 'lead-convert'\` is Lead-scoped by definition; you named \`${namedObject}\`. Omit the object, or pass \`Lead\`. This tool does not model a convert-like action on \`${namedObject}\`.`,
        path: 'objectApiName',
      });
    }
    object = LEAD_OBJECT;
    const composed = await composeLeadConvertChain(ctx, { nestedSaveDepth, soeDisclosureSink });
    if (!composed.ok) return err({ kind: 'internal', message: composed.error });
    chains = [
      {
        subject: { kind: 'object', componentId: 'CustomObject:Lead', apiName: LEAD_OBJECT },
        steps: composed.value,
      },
    ];
  } else {
    // approval-submit
    const fromProcessId =
      input.approvalProcess !== undefined &&
      input.approvalProcess.startsWith(APPROVAL_PROCESS_PREFIX)
        ? (input.approvalProcess.slice(APPROVAL_PROCESS_PREFIX.length).split('.')[0] ?? null)
        : null;
    const resolvedObject = namedObject ?? fromProcessId;
    if (resolvedObject === null) {
      return err({
        kind: 'invalid-query',
        message:
          "name the object whose approval chain you want — pass `objectApiName` (e.g. \"Opportunity\"), `object`, `objectId`, a `CustomObject:` `componentId`, or a canonical `ApprovalProcess:{Object}.{Name}` id as `approvalProcess`.",
        path: 'objectApiName',
      });
    }
    // Salesforce api names are case-INSENSITIVE, and `namedObject` is now the
    // VAULT's spelling while `fromProcessId` is still the caller's, so a byte
    // comparison here would manufacture a "disagreement" out of casing alone
    // — `{objectApiName: 'opportunity', approvalProcess:
    // 'ApprovalProcess:opportunity.X'}` names ONE object twice. Fold the case
    // for the DISAGREEMENT test only; a genuine mismatch is still refused.
    if (
      namedObject !== null &&
      fromProcessId !== null &&
      namedObject.toLowerCase() !== fromProcessId.toLowerCase()
    ) {
      return err({
        kind: 'invalid-query',
        message: `the named object (\`${namedObject}\`) and the object in \`approvalProcess\` (\`${fromProcessId}\`) disagree; pass one or the other.`,
        path: 'approvalProcess',
      });
    }
    object = resolvedObject;
    outcome = input.outcome ?? 'all';
    const limit = input.limit ?? DEFAULT_PROCESS_LIMIT;
    // A canonical `ApprovalProcess:` id carries the CALLER's spelling of its
    // object segment; `object` carries the VAULT's. Rebuild the id around the
    // vault's spelling so a fold-equal id is not looked up verbatim and missed.
    // Identity when the caller named no object (then `object` IS the id's own
    // segment) or when the id has no `.Name` tail to preserve.
    let processArg = input.approvalProcess;
    if (processArg !== undefined && fromProcessId !== null) {
      const tail = processArg.slice(APPROVAL_PROCESS_PREFIX.length + fromProcessId.length);
      if (tail.startsWith('.')) processArg = `${APPROVAL_PROCESS_PREFIX}${object}${tail}`;
    }
    const resolved = await resolveApprovalProcesses(ctx, object, processArg, limit);
    if (!resolved.ok) return err(resolved.error);
    omitted = resolved.value.omitted;
    if (input.approvalProcess !== undefined) {
      approvalProcessId = resolved.value.processes[0]?.id;
    }

    if (resolved.value.processes.length === 0) {
      // An honest empty: emit no chain, and say WHY there is none rather than
      // returning a bare empty array a host could read as "approval does nothing".
      const counted = ctx.manifest.components['ApprovalProcess'];
      disclosures.push(
        counted === undefined
          ? `No ApprovalProcess is parented to \`${object}\` in this vault, AND this vault's manifest carries no count for the ApprovalProcess family — so this is UNRESOLVED, not a finding that \`${object}\` has no approval process. Re-run \`sfi refresh\`.`
          : `No ApprovalProcess is parented to \`${object}\` in this vault. The ApprovalProcess family IS extracted here (${counted} component(s) org-wide), so this is a VERIFIED NONE for \`${object}\` — the object genuinely has no approval process — not a coverage gap.`,
      );
    }

    // Composing the same object's update save order once PER PROCESS would
    // duplicate an identical chain N times and blow the response budget for no
    // information. Expand it only when exactly one process is in scope; say so
    // otherwise instead of silently dropping it.
    const perProcessDepth: 0 | 1 =
      resolved.value.processes.length === 1 ? nestedSaveDepth : 0;
    if (perProcessDepth === 0 && nestedSaveDepth === 1 && resolved.value.processes.length > 1) {
      disclosures.push(
        `${resolved.value.processes.length} approval processes are in scope, so the field-update re-entry save order (identical for every one of them — it is the \`${object}\` update chain) is NAMED but NOT expanded, to keep the response in budget. Re-query with \`approvalProcess\` to expand it for one process, or call \`sfi.what_happens_on_save\` with \`{ objectApiName: '${object}', event: 'update' }\` directly.`,
      );
    }

    const views: ActionChainView[] = [];
    for (const process of resolved.value.processes) {
      const composed = await composeApprovalProcessChain(ctx, process, object, {
        outcome,
        nestedSaveDepth: perProcessDepth,
        soeDisclosureSink,
      });
      if (!composed.ok) return err({ kind: 'internal', message: composed.error });
      views.push({
        subject: {
          kind: 'component',
          componentId: composed.value.componentId,
          apiName: composed.value.apiName,
          active: composed.value.active,
        },
        steps: composed.value.chain,
      });
    }
    chains = views;
    disclosures.push(...approvalChainDisclosures(resolved.value.processes.length));
    if (outcome !== 'all') {
      disclosures.push(
        `\`outcome: '${outcome}'\` narrowed the chain to that terminal branch — the other branches' steps are OMITTED BY YOUR REQUEST, not absent from the process. Re-query with \`outcome: 'all'\` for the whole chain.`,
      );
    }
  }

  // The save-order engine's verbatim disclosures, held back so the budget pass
  // below can decide whether they fit. They are ~3.5 KB EACH and a lead convert
  // yields up to four variants — worth carrying when there is room, worth
  // trading for the chain itself when there is not.
  const soeDisclosures = [...soeDisclosureSink]
    .sort()
    .map(
      (d) =>
        `Nested save order (verbatim from \`what_happens_on_save\`, which composed it): ${d}`,
    );
  disclosures.push(...soeDisclosures);

  // ---- response-size enforcement -----------------------------------------
  //
  // Measured against the real sandbox: an un-enforced lead convert came back at
  // 85 KB and a 10-process approval object at 215 KB, against a 45 KB
  // dispatcher cap. The tool trims itself DELIBERATELY, in a documented
  // priority order, each pass naming a recovery call — never letting the
  // global guard tail-truncate an array and leave the payload contradicting
  // its own summary. Order is CHEAPEST-LOSS-FIRST: cap per-step component
  // rosters, then trade the save-order engine's verbatim disclosures for a
  // pointer at the tool that owns them (one call recovers the exact text),
  // then shed nested save STEP SEQUENCES largest-first (summary + recovery
  // retained), and only last shed whole approval-process chains — a shed chain
  // is the one loss a caller cannot recover without knowing it existed, so it
  // goes last and is always named in `omittedSubjects`.
  const cappedSteps: string[] = [];
  chains = chains.map((c) => {
    const capped = capStepComponents(c.steps, (step) =>
      step.nestedSave !== undefined
        ? `sfi.what_happens_on_save { objectApiName: '${step.nestedSave.objectApiName}', event: '${step.nestedSave.event}' }`
        : `sfi.order_of_execution { objectApiName: '${object}' } (or sfi.list_components for the full roster of this component family)`,
    );
    cappedSteps.push(...capped.cappedSteps);
    return { ...c, steps: capped.steps };
  });
  if (cappedSteps.length > 0) {
    disclosures.push(
      `Response budget: ${cappedSteps.length} step(s) resolved to more components than fit inline (${cappedSteps.join('; ')}); their rosters are CAPPED. Each capped step carries \`componentsOmitted\` and a \`componentsRecovery\` call. The step's resolution, note and gate are unaffected — only the inline roster is short.`,
    );
  }

  const trimmedNested: string[] = [];
  const shedChains: ComponentId[] = [];
  /**
   * The CURRENT budget-omission state. Read live by `trustFor` / `measure` /
   * the final envelope build so the honesty fields always describe the payload
   * actually being emitted, never an earlier, larger one.
   */
  const budgetOmissions = (): {
    readonly omittedSubjects: readonly ComponentId[];
    readonly cappedSteps: readonly string[];
  } => ({
    omittedSubjects: [...omitted, ...shedChains],
    cappedSteps,
  });
  /**
   * Trust completeness obeys the SAME two-axis law as the evidence envelope: a
   * composition hole OR a budget omission makes the answer partial. A response
   * that shed a whole approval process is not "complete" just because every
   * surviving step resolved.
   */
  const trustFor = (steps: readonly ChainStep[]) => {
    const gaps = budgetOmissions();
    const limitations = [
      ...steps
        .filter((s) => s.resolution === 'unresolved' || s.resolution === 'not-modeled')
        .map((s) => `${s.phase}: ${s.title}`),
      ...gaps.omittedSubjects.map((id) => `budget-omitted-subject: ${id}`),
      ...gaps.cappedSteps.map((t) => `budget-capped-roster: ${t}`),
    ];
    return actionChainTrust(ctx, limitations, limitations.length === 0);
  };
  // Measures the WHOLE emitted payload, not just the chains: the disclosures
  // and the derived evidence envelope are the other half of the bytes, and an
  // optimistic estimate here is what lets the dispatcher's blunt guard fire.
  const measure = (views: readonly ActionChainView[]): number => {
    const steps = views.flatMap((v) => v.steps);
    const gaps = budgetOmissions();
    return sizeOfBytes({
      action,
      appliedScope: { action, object, outcome, nestedSaveDepth },
      chains: views,
      summary: {
        chains: views.length,
        totalSteps: steps.length,
        resolutionCounts: tallyResolutions(steps),
        nestedSaves: 0,
        unresolvedGates: 0,
      },
      omittedSubjects: gaps.omittedSubjects,
      confidence: 'declared',
      disclosures,
      evidenceEnvelope: buildActionChainEvidenceEnvelope({
        action,
        steps,
        trust: trustFor(steps),
        disclosures,
        ...gaps,
      }),
    });
  };

  // Pass 1 — trade the save-order engine's VERBATIM disclosures for a pointer
  // at the tool that owns them. They are the cheapest thing to shed: the text
  // is recoverable in one call, whereas a shed chain is not recoverable without
  // knowing it existed.
  if (soeDisclosures.length > 0 && measure(chains) > ACTION_CHAIN_MAX_PAYLOAD_BYTES) {
    for (const d of soeDisclosures) {
      const at = disclosures.indexOf(d);
      if (at >= 0) disclosures.splice(at, 1);
    }
    disclosures.push(
      `Response budget: the save-order engine's ${soeDisclosures.length} verbatim disclosure(s) for the nested chain(s) were too large to carry here. They apply IN FULL to every nested chain above — read them by calling \`sfi.what_happens_on_save\` for the object and event each nested chain names. The nested-save caps this tool adds on top of them are stated above and are NOT affected.`,
    );
  }

  // Pass 2 — shed nested save STEP SEQUENCES (summary + recovery retained),
  // tightening the nested budget until the whole payload fits.
  for (const nestedBudget of [24_000, 12_000, 4_000, 0]) {
    if (measure(chains) <= ACTION_CHAIN_MAX_PAYLOAD_BYTES) break;
    chains = chains.map((c) => {
      const enforced = enforceNestedSaveBudget(c.steps, nestedBudget);
      trimmedNested.push(...enforced.trimmed);
      return { ...c, steps: enforced.steps };
    });
  }
  if (trimmedNested.length > 0) {
    disclosures.push(
      `Response budget: the nested save order(s) for ${[...new Set(trimmedNested)].join(', ')} were too large to carry in full, so their STEP SEQUENCES were dropped. Each keeps its COMPLETE \`summary\` (totalSteps, activeComponents, phaseCounts) plus a \`recovery\` call — the counts are still true, only the per-step roster is missing. This is a RESPONSE-SIZE truncation, NOT a finding that less fires.`,
    );
  }

  // Pass 3 — shed whole trailing chains (approval processes). Always keeps at
  // least one, and every shed subject is named in `omittedSubjects`.
  while (chains.length > 1 && measure(chains) > ACTION_CHAIN_MAX_PAYLOAD_BYTES) {
    const dropped = chains[chains.length - 1];
    const droppedId = dropped?.subject.componentId;
    if (droppedId !== null && droppedId !== undefined) shedChains.push(droppedId);
    chains = chains.slice(0, -1);
  }
  if (shedChains.length > 0) {
    // `budgetOmissions()` already read `shedChains` live during the loop, so the
    // measurements above were never optimistic; this just makes the shed set the
    // caller-visible `omittedSubjects`.
    omitted = [...omitted, ...shedChains];
    shedChains.length = 0;
    disclosures.push(
      `Response budget: ${shedChains.length} approval process chain(s) were dropped whole to fit the response — they are named in \`omittedSubjects\`. Re-query each with \`approvalProcess\` to compose it. They EXIST; they are omitted from this response, not absent from the org.`,
    );
  }

  const allSteps = chains.flatMap((c) => c.steps);
  for (const step of allSteps) assertChainStepJustified(step);

  if (omitted.length > 0) {
    disclosures.push(
      `${omitted.length} further approval process(es) on \`${object}\` were NOT composed because the per-call cap was reached: ${omitted.join(', ')}. Raise \`limit\` (max ${MAX_PROCESS_LIMIT}) or name one with \`approvalProcess\`. They exist — they are omitted from this response, not absent from the org.`,
    );
  }
  if (nestedSaveDepth === 0) {
    disclosures.push(
      '`nestedSaveDepth: 0` — each nested save order is NAMED but NOT expanded. The steps that fire one still say so; re-query at the default depth to see what fires.',
    );
  }

  const resolutionCounts = tallyResolutions(allSteps);
  const trust = trustFor(allSteps);

  return ok({
    data: {
      action,
      appliedScope: {
        action,
        object,
        ...(outcome !== undefined ? { outcome } : {}),
        ...(approvalProcessId !== undefined ? { approvalProcess: approvalProcessId } : {}),
        nestedSaveDepth,
      },
      chains,
      summary: {
        chains: chains.length,
        totalSteps: allSteps.length,
        resolutionCounts,
        nestedSaves: allSteps.filter(
          (s) => s.nestedSave !== undefined && s.nestedSave.suppressedByDepthCap !== true,
        ).length,
        unresolvedGates: allSteps.filter((s) => s.gate !== undefined).length,
      },
      ...(omitted.length > 0 ? { omittedSubjects: omitted } : {}),
      confidence: 'declared',
      disclosures,
      evidenceEnvelope: buildActionChainEvidenceEnvelope({
        action,
        steps: allSteps,
        trust,
        disclosures,
        ...budgetOmissions(),
      }),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
