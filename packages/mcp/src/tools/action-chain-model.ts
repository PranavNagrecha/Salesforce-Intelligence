/**
 * Shared contract for the ACTION-CHAIN composition tools (`sfi.action_chain`).
 *
 * ## Why this module exists
 *
 * `order_of_execution` / `what_happens_on_save` model exactly ONE Salesforce
 * action as a chain: the record save. Every other distinct record ACTION —
 * Lead Convert, approval submission, owner change, merge, activation — is a
 * flat catalog of components in this product, not a sequence. `lifecycle_process`
 * says so verbatim in its own disclosures ("Distinct record ACTIONS … are not
 * modeled as save-order steps").
 *
 * This module is the composition primitive that closes two of those gaps. It
 * copies the METHOD of `soe-payload-bounds.ts` — a frozen, documented phase
 * sequence that the org's own extracted metadata is instantiated into — but the
 * unit is an ACTION step rather than an SOE phase, because an action chain has
 * three properties a save order does not:
 *
 *   1. **Steps can be unresolvable.** A save-order phase either has automation
 *      or it is empty. An action step can exist in Salesforce's documented
 *      sequence while the metadata that would fill it (`LeadConvertSettings`
 *      field mapping, the Lead Settings validation toggle) is not a component
 *      family this vault extracts at all. {@link ChainResolution} makes that a
 *      first-class, countable state instead of a silent omission.
 *   2. **Steps nest.** A convert fires up to four complete save orders (Account,
 *      Contact, Opportunity inserts + the Lead update). Those are composed by
 *      CALLING the save-order engine, not by reimplementing it — see
 *      {@link composeNestedSave} — and the nesting is depth-capped and the cap
 *      is disclosed.
 *   3. **Absence has two different meanings.** "This org has no duplicate rule
 *      on Lead" and "this tool does not model email-approval responses" are
 *      completely different claims. Conflating them is the exact failure this
 *      product exists to avoid, so they are separate {@link ChainResolution}
 *      members (`verified-none` vs `not-modeled`) with separate required
 *      justification fields, and they project onto DIFFERENT
 *      `EvidenceEnvelopeV2.absence.status` values.
 *
 * ## Honesty axis (inherited from the save-order tools, verbatim in spirit)
 *
 * Conditions ARE listed but NOT EVALUATED. Nothing here claims runtime
 * behaviour: every step is static composition over declared metadata. A step
 * that is "configured to run" is not a step whose "condition could match" is not
 * a step that "actually executed", and the output never collapses those three.
 */

import type {
  ComponentId,
  ComponentType,
  EvidenceClaimV2,
  EvidenceEnvelopeV2,
  EvidenceRefV2,
  McpError,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByIds } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { assertEvidenceEnvelopeV2 } from './evidence-envelope.js';
import {
  type SoePhaseCounts,
  tallyPhaseCounts,
} from './soe-payload-bounds.js';
import {
  type SoeStep,
  whatHappensOnSaveHandler,
} from './what-happens-on-save.js';

/** The record ACTIONS this tool models as chains. Deliberately a short list. */
export const ACTION_CHAIN_ACTIONS = ['lead-convert', 'approval-submit'] as const;
export type ActionChainAction = (typeof ACTION_CHAIN_ACTIONS)[number];

/**
 * How much of a documented step this vault could actually fill in. The whole
 * point of the type: a step is NEVER dropped because it could not be resolved —
 * it is emitted carrying the reason it is empty, and the reason is typed.
 *
 *   - `resolved`      — at least one real vault component was matched to the
 *                       step (`components` is non-empty).
 *   - `platform-step` — documented platform behaviour with no org component to
 *                       name (the database write, the re-parenting of activities).
 *                       Analogous to the save-order engine's `save` placeholder.
 *                       NOT an absence claim.
 *   - `verified-none` — the component family IS extracted into this vault and
 *                       this org genuinely has none for this step. Requires
 *                       {@link ChainStep.absenceBasis} to state HOW that was
 *                       verified. This is the only resolution that projects to
 *                       `absence.status: 'proven-none'`.
 *   - `unresolved`    — the step exists in the documented sequence and this org
 *                       may well have configuration for it, but the vault does
 *                       not carry the metadata needed to fill it (the family is
 *                       not retrieved, or the extractor emits no edge for it).
 *                       Requires {@link ChainStep.unresolvedReason}. NOT an
 *                       absence claim — an unresolved step is a HOLE, not a zero.
 *   - `not-modeled`   — a surface THIS TOOL does not model, named out loud so it
 *                       is visible rather than quietly omitted. Requires
 *                       {@link ChainStep.notModeledReason}. NOT an absence claim.
 *
 * `verified-none` vs `unresolved` vs `not-modeled` is the load-bearing
 * three-way split. Collapsing any pair of them produces a confidently wrong
 * answer, which is worse than no answer.
 */
export type ChainResolution =
  | 'resolved'
  | 'platform-step'
  | 'verified-none'
  | 'unresolved'
  | 'not-modeled';

/** One vault component attached to a chain step, with the role it plays there. */
export interface ChainComponentRef {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType | 'unresolved';
  readonly apiName: string;
  /**
   * What this component DOES at this step (`validation-rule`, `approver`,
   * `field-update-target`, …). Roles are step-specific strings, not a closed
   * enum — they exist so a caller never has to guess why a component is listed.
   */
  readonly role: string;
  /**
   * Present when the id was BUILT BY CONVENTION from a name in another
   * component's metadata (e.g. an approval step action's `<name>`) and no node
   * with that id exists in the graph. The reference is then a NAME, not a
   * resolved component — never render it as "this component exists".
   */
  readonly targetMissing?: true;
  /** Free-form per-component note (e.g. the declared operation of a rule). */
  readonly note?: string;
}

/**
 * A firing condition surfaced on a chain step. LISTED, NOT EVALUATED — the tool
 * does not know whether a particular record satisfies it at runtime. Mirrors
 * `SoeStepCondition` on the save-order tools so the two views agree in shape.
 */
export interface ChainStepCondition {
  /** Where the expression came from (`entryCriteria`, `stepEntryCriteria`, …). */
  readonly source: string;
  /** The raw declared expression, or `''` when only a criteria-item count exists. */
  readonly expression: string;
  /** Number of declared criteria items, when the condition is item-based. */
  readonly criteriaItemCount?: number;
  readonly fieldRefs?: readonly ComponentId[];
}

/**
 * A step whose COMPONENTS resolved but whose FIRING is controlled by a switch
 * this vault does not hold. Distinct from an `unresolved` step: the roster is
 * real, the gate is not. Rendering such a step as plain `resolved` would claim
 * the automation runs at this point in the action; rendering it as `unresolved`
 * would hide a real roster. So it is both: `resolution: 'resolved'` plus this.
 */
export interface ChainStepGate {
  /** The Salesforce switch, named as an admin would find it in Setup. */
  readonly setting: string;
  /** Always `unresolved` today — a resolved gate would simply not be emitted. */
  readonly status: 'unresolved';
  readonly reason: string;
}

/** One step of a documented action chain, instantiated against this org. */
export interface ChainStep {
  /** Documented phase this step belongs to (per-action frozen sequence). */
  readonly phase: string;
  /** Monotonic 0-based position in the emitted chain. Unique per chain. */
  readonly stepIndex: number;
  /** The documented step name, phrased as Salesforce's own docs phrase it. */
  readonly title: string;
  readonly resolution: ChainResolution;
  /** What happens here, and what this composition does and does not claim. */
  readonly note: string;
  /** Vault components matched to this step. Empty for every non-`resolved` step. */
  readonly components: readonly ChainComponentRef[];
  /**
   * Components dropped from `components` to keep the response in budget. A
   * dense org puts 100+ validation rules on one step; carrying them all blows
   * the MCP response cap. Present ONLY when the list was capped — and when it
   * is, {@link ChainStep.componentsRecovery} names the call that returns them
   * all. Absent means the list is COMPLETE.
   */
  readonly componentsOmitted?: number;
  /** The call that returns a capped step's full component roster. */
  readonly componentsRecovery?: string;
  /** REQUIRED when `resolution === 'unresolved'`. */
  readonly unresolvedReason?: string;
  /** REQUIRED when `resolution === 'not-modeled'`. */
  readonly notModeledReason?: string;
  /** REQUIRED when `resolution === 'verified-none'` — HOW the none was verified. */
  readonly absenceBasis?: string;
  /** Conditions listed for this step. Never evaluated. */
  readonly conditions?: readonly ChainStepCondition[];
  /** A gate whose components resolved but whose firing switch did not. */
  readonly gate?: ChainStepGate;
  /** The nested save order this step triggers, when it triggers one. */
  readonly nestedSave?: NestedSaveChain;
}

/**
 * A complete save-order chain fired BY an action step — composed by calling the
 * save-order engine, never by reimplementing it, so the nested view and
 * `what_happens_on_save` can never disagree.
 */
export interface NestedSaveChain {
  readonly objectApiName: string;
  readonly event: 'insert' | 'update';
  /** 1 for a save the action itself performs. See {@link NESTED_SAVE_DEPTH_CAP}. */
  readonly depth: number;
  /** False when the object's own metadata is absent (standard objects). */
  readonly objectModeled: boolean;
  readonly soe: readonly SoeStep[];
  readonly summary: {
    readonly totalSteps: number;
    readonly activeComponents: number;
    readonly phaseCounts: SoePhaseCounts;
  };
  /**
   * The save-order engine's verbatim disclosure is NOT repeated here. It is
   * ~3.5 KB, byte-identical across every nested chain of the same shape, and
   * four copies alone overran the response budget on the real sandbox — so it
   * is carried ONCE (deduped) in the response-level `disclosures`. Which chain
   * carried the object-not-modeled variant is readable from
   * {@link NestedSaveChain.objectModeled}.
   */
  /**
   * Present when the save-order engine REFUSED to compose for this object (an
   * unknown/never-retrieved object). The step is still emitted; the chain says
   * the nested save is unresolved rather than pretending it is empty.
   */
  readonly composeError?: string;
  /** Present when `nestedSaveDepth: 0` suppressed the expansion. */
  readonly suppressedByDepthCap?: true;
  /**
   * Steps dropped from `soe` to keep the WHOLE action-chain response inside the
   * MCP response budget. `summary` (totalSteps / activeComponents / phaseCounts)
   * is left INTACT, so a budget-trimmed chain can never contradict its own
   * counts — the counts still report every step, this field says how many of
   * them the sequence could not carry, and {@link NestedSaveChain.recovery}
   * names the one call that returns them.
   */
  readonly stepsOmittedForBudget?: number;
  /** The exact call that returns a budget-trimmed chain in full. */
  readonly recovery?: string;
}

/**
 * Bytes of nested-save `soe` payload one action-chain response may carry.
 *
 * A single composed save order is allowed up to `soeBudgetBytes()` (derived
 * from the global response budget) by the save-order engine, and a lead
 * convert nests FOUR of them — so a densely-automated org would blow the
 * 45 KB whole-response budget four times over and the dispatcher would mangle or reject the answer. Rather than
 * let that happen, the largest nested chains shed their step sequences first,
 * keeping every chain's SUMMARY and naming the recovery call. Sized so the
 * chain scaffolding (steps, notes, disclosures, evidence envelope) still fits
 * under the dispatcher's cap alongside it.
 */
export const ACTION_CHAIN_NESTED_BUDGET_BYTES = 24_000;

/**
 * Whole-payload ceiling for one action-chain response, sized below the
 * dispatcher's `MAX_RESPONSE_BYTES` (45 000) so the tool trims itself
 * DELIBERATELY — shedding nested step sequences, then whole approval
 * processes, each with a named recovery call — instead of letting the global
 * guard tail-truncate an array and leave the payload contradicting its own
 * summary.
 */
export const ACTION_CHAIN_MAX_PAYLOAD_BYTES = 38_000;

/**
 * Components one step may carry inline. Measured against the real sandbox: a
 * single `lead-validation` step there resolved to 100 active validation rules —
 * 21 KB on one step, half the whole response budget. The cap keeps the step's
 * SHAPE (its resolution, note and gate) intact and names a recovery call for
 * the full roster, which is strictly better than a step that silently lists a
 * partial roster or a response the dispatcher rejects.
 */
export const CHAIN_STEP_COMPONENT_CAP = 20;

/**
 * Evidence refs one envelope may carry. `claims[].groundedIn` already carries
 * the per-step grounding; `evidence` is the deduped flat index over it, so
 * capping it loses no grounding — it only shortens the index. Disclosed in
 * `coverage.message` when it bites.
 */
export const ACTION_CHAIN_EVIDENCE_REF_CAP = 60;

/**
 * Cap each step's inline component roster at {@link CHAIN_STEP_COMPONENT_CAP},
 * keeping the FIRST `cap` (composers emit in canonical id order, so the kept
 * slice is deterministic) and stamping `componentsOmitted` + a recovery call.
 *
 * @returns the capped steps and how many steps were capped.
 */
export const capStepComponents = (
  steps: readonly ChainStep[],
  recoveryFor: (step: ChainStep) => string,
): { readonly steps: readonly ChainStep[]; readonly cappedSteps: readonly string[] } => {
  const capped: string[] = [];
  const next = steps.map((step) => {
    if (step.components.length <= CHAIN_STEP_COMPONENT_CAP) return step;
    capped.push(step.title);
    return {
      ...step,
      components: step.components.slice(0, CHAIN_STEP_COMPONENT_CAP),
      componentsOmitted: step.components.length - CHAIN_STEP_COMPONENT_CAP,
      componentsRecovery: recoveryFor(step),
    };
  });
  return { steps: next, cappedSteps: capped };
};

/** Serialized byte size of any value. */
export const sizeOfBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Shed nested-save step sequences, LARGEST FIRST, until the total nested-save
 * payload fits {@link ACTION_CHAIN_NESTED_BUDGET_BYTES}.
 *
 * Trimming is all-or-nothing per chain and deterministic (largest `soe` first,
 * ties broken by object name) so the same vault always yields the same answer.
 * A trimmed chain keeps its `summary` and gains `stepsOmittedForBudget` +
 * `recovery`, so the response never silently claims a shorter save order than
 * the one it counted.
 *
 * @returns the names of the chains that were trimmed, in trim order.
 */
export const enforceNestedSaveBudget = (
  steps: readonly ChainStep[],
  budgetBytes: number = ACTION_CHAIN_NESTED_BUDGET_BYTES,
): { readonly steps: readonly ChainStep[]; readonly trimmed: readonly string[] } => {
  const indexed = steps
    .map((step, i) => ({ step, i }))
    .filter(
      (e) =>
        e.step.nestedSave !== undefined &&
        e.step.nestedSave.soe.length > 0,
    );
  let total = indexed.reduce((n, e) => n + sizeOfBytes(e.step.nestedSave!.soe), 0);
  if (total <= budgetBytes) return { steps, trimmed: [] };

  const order = [...indexed].sort((a, b) => {
    const sa = sizeOfBytes(a.step.nestedSave!.soe);
    const sb = sizeOfBytes(b.step.nestedSave!.soe);
    if (sa !== sb) return sb - sa;
    const na = a.step.nestedSave!.objectApiName;
    const nb = b.step.nestedSave!.objectApiName;
    return na < nb ? -1 : na > nb ? 1 : 0;
  });

  const next = [...steps];
  const trimmed: string[] = [];
  for (const entry of order) {
    if (total <= budgetBytes) break;
    const nested = entry.step.nestedSave!;
    total -= sizeOfBytes(nested.soe);
    const label = `${nested.objectApiName} ${nested.event}`;
    trimmed.push(label);
    next[entry.i] = {
      ...entry.step,
      nestedSave: {
        ...nested,
        soe: [],
        stepsOmittedForBudget: nested.soe.length,
        recovery: `sfi.what_happens_on_save { objectApiName: '${nested.objectApiName}', event: '${nested.event}' }`,
      },
    };
  }
  return { steps: next, trimmed };
};

/**
 * The nesting depth this composition will expand. `1` = the save orders the
 * action itself performs (Account/Contact/Opportunity insert, Lead update,
 * an approval field update re-entering the object's update chain).
 *
 * Depth 2 — the DML that those nested chains' OWN automation performs (an
 * after-insert trigger on Account inserting a Task, and that Task's save order)
 * — is NOT expanded and is NOT derivable from this vault: the Apex extractor
 * records field-level `readsFrom`/`writesTo` edges, not the SObject TYPE of a
 * DML statement, so there is nothing to walk. This is a hard modelling boundary,
 * not a tunable. It is disclosed on every response.
 */
export const NESTED_SAVE_DEPTH_CAP = 1;

/** Verbatim depth-cap disclosure. Emitted on every chain that nests a save. */
export const NESTED_SAVE_DEPTH_DISCLOSURE =
  `Nested save orders are expanded to depth ${NESTED_SAVE_DEPTH_CAP} ONLY — the save orders the action itself performs. Depth ${NESTED_SAVE_DEPTH_CAP + 1} (the DML that those nested chains' own triggers / flows perform, and the save orders THAT DML would fire) is NOT expanded and is NOT derivable offline: the Apex scanner records field-level readsFrom/writesTo edges, not the SObject type of a DML statement. Every nested chain below is therefore a FLOOR on what the action touches, never a ceiling. Each nested chain also inherits the save-order engine's own caps verbatim — roll-up recalculation is capped to one parent level and the recalculated parent's own automation is not expanded, and workflow field-update re-entrancy within a save is listed once rather than re-walked.`;

/** Counts of each {@link ChainResolution} across an emitted chain. */
export type ChainResolutionCounts = Readonly<Record<ChainResolution, number>>;

const RESOLUTIONS: readonly ChainResolution[] = [
  'resolved',
  'platform-step',
  'verified-none',
  'unresolved',
  'not-modeled',
];

/**
 * Tally every step by resolution. Every member is present (zero when empty) so
 * the map is a complete, stable shape a caller can index without guarding —
 * and so "0 unresolved" is an explicit, readable claim rather than an absent key.
 */
export const tallyResolutions = (
  steps: readonly { readonly resolution: ChainResolution }[],
): ChainResolutionCounts => {
  const counts = Object.fromEntries(RESOLUTIONS.map((r) => [r, 0])) as Record<
    ChainResolution,
    number
  >;
  for (const step of steps) counts[step.resolution] += 1;
  return counts;
};

/**
 * Runtime guard for the "a missing step must be VISIBLE, and justified" law:
 * every non-`resolved`, non-`platform-step` resolution carries its mandatory
 * justification field. A composer that forgets one is a bug the caller must
 * never see as a confident empty, so this fails the response rather than
 * shipping an unexplained hole.
 */
export const assertChainStepJustified = (step: ChainStep): void => {
  const missing =
    (step.resolution === 'unresolved' && step.unresolvedReason === undefined) ||
    (step.resolution === 'not-modeled' && step.notModeledReason === undefined) ||
    (step.resolution === 'verified-none' && step.absenceBasis === undefined);
  if (missing) {
    throw new Error(
      `action-chain: step "${step.title}" is ${step.resolution} without its required justification field`,
    );
  }
};

/**
 * The verdict on whether "this org has none of X" is a claim this vault can
 * actually make, plus the sentence that JUSTIFIES the verdict.
 */
export interface FamilyAbsenceVerdict {
  readonly resolution: 'verified-none' | 'unresolved';
  /** Goes straight into `absenceBasis` or `unresolvedReason` on the step. */
  readonly basis: string;
}

/**
 * Decide whether "this org has none of {family}" is a defensible claim.
 *
 * Zero extracted nodes is ambiguous on its face: the org may genuinely have
 * none, OR the family may never have been retrieved (a scoped refresh, a vault
 * built before the extractor existed, a retrieve error, a family this product
 * has never modeled). Those are opposite answers to the user's question and
 * this tool must not guess between them.
 *
 * The manifest settles it. `manifest.coverage` carries a per-family row stating
 * whether the family was REQUESTED, how many were RETRIEVED, whether the
 * retrieve ERRORED, whether a staged refresh has yet to REACH it, and whether
 * the product models it at all. A family that was requested, did not error and
 * is not pending is one whose zero is real. Anything else is a hole.
 *
 * Falls back to `manifest.components` (pre-v4 manifests carry no coverage rows):
 * a family PRESENT in that count map was counted at import, so its zero is real;
 * a family ABSENT from it was never counted and any "none" would be invented.
 */
export const familyAbsence = (
  ctx: Context,
  type: ComponentType,
): FamilyAbsenceVerdict => {
  const row = ctx.manifest.coverage?.find((e) => e.type === type);
  if (row !== undefined) {
    if (row.errored) {
      return {
        resolution: 'unresolved',
        basis: `\`${type}\` retrieve ERRORED for this vault${row.errorReason !== undefined ? ` (${row.errorReason})` : ''} — an empty result here is a retrieve failure, NOT evidence this org has none.`,
      };
    }
    if (row.pending === true) {
      return {
        resolution: 'unresolved',
        basis: `\`${type}\` is still PENDING in an in-progress staged refresh — this vault has not reached that tier yet, so an empty result is not evidence this org has none.`,
      };
    }
    if (row.neverModeled) {
      return {
        resolution: 'unresolved',
        basis: `\`${type}\` is a metadata family this product does not model — an empty result is a product gap, NOT evidence this org has none.`,
      };
    }
    if (!row.requested) {
      return {
        resolution: 'unresolved',
        basis: `\`${type}\` was NOT requested by the refresh that built this vault — an empty result is out-of-scope retrieval, NOT evidence this org has none.`,
      };
    }
    return {
      resolution: 'verified-none',
      basis: `\`${type}\` WAS retrieved into this vault (manifest coverage: requested, ${row.retrieved} component(s) org-wide, no retrieve error) — so a zero here is a verified none for this org, not a coverage gap.`,
    };
  }
  const counted = ctx.manifest.components[type];
  if (counted === undefined) {
    return {
      resolution: 'unresolved',
      basis: `This vault's manifest carries no count for \`${type}\`, so the family's presence cannot be established — an empty result is NOT evidence this org has none. Re-run \`sfi refresh\` to write coverage rows.`,
    };
  }
  return {
    resolution: 'verified-none',
    basis: `\`${type}\` is counted in this vault's manifest (${counted} component(s) org-wide), so a zero here is a verified none for this org, not a coverage gap.`,
  };
};

/**
 * A zeroed {@link SoePhaseCounts} — every phase present with a `0`, taken from
 * the SHARED tally helper rather than hand-listed, so a new save-order phase can
 * never leave this map stale (the exact drift `soe-payload-bounds` centralised
 * the helpers to prevent).
 */
const EMPTY_PHASE_COUNTS: SoePhaseCounts = tallyPhaseCounts([]);

/**
 * Compose the save order an action step fires, by CALLING
 * `what_happens_on_save` — the same engine `order_of_execution` and
 * `lifecycle_process` use. Reuse, not reimplementation: an action chain that
 * disagreed with the save-order tools about what fires on an Account insert
 * would be a worse product than one that has no action chains at all.
 *
 * A refusal from the engine (unknown / never-retrieved object) is CARRIED, not
 * swallowed: the returned chain has `composeError` set and an empty `soe`, so
 * the caller can mark the step unresolved instead of rendering "nothing fires".
 */
export const composeNestedSave = async (
  ctx: Context,
  objectApiName: string,
  event: 'insert' | 'update',
  depth: number,
  /**
   * Collector the save-order engine's verbatim disclosure is deduped into. The
   * caller surfaces it ONCE at response level — see {@link NestedSaveChain}.
   */
  disclosureSink?: Set<string>,
): Promise<NestedSaveChain> => {
  const r = await whatHappensOnSaveHandler(ctx, { objectApiName, event });
  if (!r.ok) {
    return {
      objectApiName,
      event,
      depth,
      objectModeled: false,
      soe: [],
      summary: {
        totalSteps: 0,
        activeComponents: 0,
        phaseCounts: EMPTY_PHASE_COUNTS,
      },
      composeError: `${r.error.kind}: ${r.error.message}`,
    };
  }
  const d = r.value.data;
  disclosureSink?.add(d.disclosure);
  return {
    objectApiName,
    event,
    depth,
    objectModeled: d.objectModeled,
    soe: d.soe,
    summary: {
      totalSteps: d.summary.totalSteps,
      activeComponents: d.summary.activeComponents,
      phaseCounts: d.summary.phaseCounts,
    },
  };
};

/** A depth-0 placeholder: the save is NAMED but deliberately not expanded. */
export const suppressedNestedSave = (
  objectApiName: string,
  event: 'insert' | 'update',
): NestedSaveChain => ({
  objectApiName,
  event,
  depth: 0,
  objectModeled: false,
  soe: [],
  summary: { totalSteps: 0, activeComponents: 0, phaseCounts: EMPTY_PHASE_COUNTS },
  suppressedByDepthCap: true,
});



/**
 * Project a composed chain into an {@link EvidenceEnvelopeV2}.
 *
 * The mapping that matters is `absence.status`, and it fails CLOSED. There are
 * TWO independent ways an action chain can be incomplete, and BOTH must reach
 * the envelope or a trimmed answer reads as a complete one:
 *
 *   1. **Composition holes** — a step this vault could not fill (`unresolved`)
 *      or a surface this tool does not model (`not-modeled`).
 *   2. **Budget omissions** — content the composer DID resolve and then DROPPED
 *      to fit the MCP response cap: whole approval-process chains shed into
 *      `omittedSubjects`, and per-step component rosters capped
 *      (`cappedSteps`). The steps that remain are individually honest, so the
 *      per-step scan in (1) sees nothing wrong — which is exactly why the
 *      omission set has to be passed in rather than derived from `steps`.
 *
 * Either one forces `coverage.status: 'partial'` AND `absence.status:
 * 'not-checked'`. A response that dropped a whole approval process can never
 * claim `proven-none` over the action, however clean its surviving steps are:
 * the shed process might have been the one that fired. This is the same
 * fail-closed law `assertChainStepJustified` enforces per step, applied to the
 * response as a whole.
 *
 * When nothing was dropped and nothing is unfilled:
 *   - ANY `verified-none` step ⇒ `proven-none`.
 *   - otherwise `unknown` — the chain asserted no absence at all.
 */
export const buildActionChainEvidenceEnvelope = (args: {
  readonly action: ActionChainAction;
  readonly steps: readonly ChainStep[];
  readonly trust: TrustSummary;
  readonly disclosures: readonly string[];
  /**
   * Subjects (approval processes) the composer RESOLVED and then dropped whole
   * — per-call cap or response budget. Non-empty forces `partial` /
   * `not-checked`: their steps are not in `steps` at all, so nothing else in
   * this function can see that they existed.
   */
  readonly omittedSubjects: readonly ComponentId[];
  /**
   * Titles of steps whose inline component roster was CAPPED to fit the
   * budget. Non-empty forces `partial` / `not-checked`: the step itself looks
   * `resolved` and carries no hole, but its evidence is provably short.
   */
  readonly cappedSteps: readonly string[];
}): EvidenceEnvelopeV2 => {
  const counts = tallyResolutions(args.steps);
  const claims: EvidenceClaimV2[] = args.steps.map((step) => ({
    claim: `${step.title} — ${step.resolution}`,
    groundedIn: step.components.map((c) => c.componentId),
    confidence: step.resolution === 'resolved' ? 'declared' : 'unknown',
    coverageCaveat:
      step.unresolvedReason ?? step.notModeledReason ?? step.absenceBasis ?? null,
    ruleId: `action-chain:${args.action}:${step.phase}`,
    concept: step.phase,
  }));

  const evidence: EvidenceRefV2[] = [];
  const seen = new Set<string>();
  let evidenceOmitted = 0;
  for (const step of args.steps) {
    for (const c of step.components) {
      if (seen.has(c.componentId)) continue;
      seen.add(c.componentId);
      if (evidence.length >= ACTION_CHAIN_EVIDENCE_REF_CAP) {
        evidenceOmitted += 1;
        continue;
      }
      evidence.push({
        componentId: c.componentId,
        role: c.role,
        ...(c.targetMissing === true
          ? { note: 'named by another component; no node with this id in the vault' }
          : {}),
      });
    }
  }

  const holes = args.steps
    .filter((s) => s.resolution === 'unresolved' || s.resolution === 'not-modeled')
    .map((s) => `${s.phase}: ${s.title}`);

  // Budget omissions, as STRUCTURED `missingCoverage` rows rather than prose —
  // a consumer must be able to tell a trimmed answer from a complete one by
  // reading fields, not by parsing a note.
  const budgetGaps: string[] = [
    ...args.omittedSubjects.map((id) => `budget-omitted-subject: ${id}`),
    ...args.cappedSteps.map((t) => `budget-capped-roster: ${t}`),
  ];
  const missingCoverage = [...holes, ...budgetGaps];
  const incomplete = missingCoverage.length > 0;

  const envelope: EvidenceEnvelopeV2 = {
    envelopeVersion: 2,
    claims,
    evidence,
    coverage: {
      status: incomplete ? 'partial' : 'complete',
      ...(incomplete ? { missingCoverage } : {}),
      message: `${
        holes.length > 0
          ? `${holes.length} of ${args.steps.length} documented steps could not be filled from this vault (${counts.unresolved} unresolved, ${counts['not-modeled']} not modeled by this tool).`
          : 'Every documented step present in this response was filled from vault metadata.'
      }${budgetGaps.length > 0 ? ` RESPONSE BUDGET also removed content that WAS resolved: ${args.omittedSubjects.length} whole subject chain(s) dropped and ${args.cappedSteps.length} step roster(s) capped — see \`missingCoverage\` for each, and the response \`disclosures\` for the recovery calls.` : ''}${evidenceOmitted > 0 ? ` The flat \`evidence\` index is capped at ${ACTION_CHAIN_EVIDENCE_REF_CAP} refs and omits ${evidenceOmitted} more; per-step grounding in \`claims[].groundedIn\` is unaffected.` : ''}`,
    },
    freshness: args.trust.freshness,
    trust: args.trust,
    absence: {
      status: incomplete
        ? 'not-checked'
        : counts['verified-none'] > 0
          ? 'proven-none'
          : 'unknown',
      note: incomplete
        ? `NO absence claim over the whole action is defensible here.${holes.length > 0 ? ` ${holes.length} step(s) are unfilled.` : ''}${budgetGaps.length > 0 ? ` ${args.omittedSubjects.length} resolved subject chain(s) were DROPPED and ${args.cappedSteps.length} component roster(s) CAPPED for response size — a dropped chain may be exactly the one that fires, so the surviving steps' cleanliness proves nothing about the action as a whole.` : ''} Individual \`verified-none\` steps (${counts['verified-none']}) remain individually proven zeros.`
        : counts['verified-none'] > 0
          ? 'Every documented step was checked and nothing was dropped for response size; the empty ones are verified zeros against families this vault provably extracted.'
          : 'This chain asserts no absence.',
    },
    // A POINTER, not a copy. `data.disclosures` already carries every
    // disclosure verbatim; duplicating them here cost ~11 KB on a real org —
    // a quarter of the whole response budget spent saying the same thing twice.
    disclosure: `See \`disclosures\` on this response (${args.disclosures.length} entries) for the verbatim honesty axis of this chain.`,
  };
  assertEvidenceEnvelopeV2(envelope);
  return envelope;
};

/** Build the {@link TrustSummary} every action chain carries. */
export const actionChainTrust = (
  ctx: Context,
  limitations: readonly string[],
  complete: boolean,
): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: 'declared',
  freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
  completeness: {
    status: complete ? 'complete' : 'partial',
    ...(complete ? {} : { missingCoverage: [...limitations] }),
  },
  limitations: [...limitations],
});

/**
 * The refusal for an action this tool does not model.
 *
 * Says the honest thing rather than the terse thing: an unmodeled action is a
 * GAP IN THIS TOOL, not a finding that the action has no automation. Owner
 * change, merge, activation, delete/undelete and login are each a chain of a
 * dozen things in Salesforce; this tool models two of them and refuses the rest
 * by name so nobody reads a refusal as an absence.
 */
export const unknownActionError = (raw: string): McpError => ({
  kind: 'invalid-query',
  message: `\`${raw}\` is not an action this tool models. Modeled actions: ${ACTION_CHAIN_ACTIONS.join(', ')}. Other distinct record ACTIONS — owner change, merge, activation, delete / undelete, login — are each their own chain in Salesforce and are NOT modeled here. That is a GAP IN THIS TOOL, not a claim that those actions run no automation. For the save-order slice of any of them use \`sfi.order_of_execution\` / \`sfi.what_happens_on_save\`.`,
  path: 'action',
});

// ---------------------------------------------------------------------------
// Graph fetch helpers shared by the per-action composers.
//
// Deliberately the SAME two traversals the save-order engine uses
// (`parentOf` out of the object for owned rules, `triggersOn` into the object
// for registered firers), so a component that the save-order tools see is a
// component an action chain sees. A third traversal here would be a place for
// the two views to silently diverge.
// ---------------------------------------------------------------------------

/** Object-owned children (`CustomObject -parentOf-> child`) of the given types. */
export const fetchOwnedChildren = async (
  ctx: Context,
  objectId: ComponentId,
  types: ReadonlySet<ComponentType>,
): Promise<Result<readonly Node[], string>> => {
  const edges = await listEdges(ctx.graph, objectId, {
    direction: 'out',
    edgeType: 'parentOf',
  });
  if (!edges.ok) return err(edges.error.message);
  const nodes = await listNodesByIds(
    ctx.graph,
    edges.value.map((e) => e.toId),
  );
  if (!nodes.ok) return err(nodes.error.message);
  return ok(
    nodes.value
      .filter((n) => types.has(n.type))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
};

/** Firers registered against the object (`firer -triggersOn-> CustomObject`). */
export const fetchRegisteredFirers = async (
  ctx: Context,
  objectId: ComponentId,
  types: ReadonlySet<ComponentType>,
): Promise<Result<readonly Node[], string>> => {
  const edges = await listEdges(ctx.graph, objectId, {
    direction: 'in',
    edgeType: 'triggersOn',
  });
  if (!edges.ok) return err(edges.error.message);
  const nodes = await listNodesByIds(
    ctx.graph,
    edges.value.map((e) => e.fromId),
  );
  if (!nodes.ok) return err(nodes.error.message);
  return ok(
    nodes.value
      .filter((n) => types.has(n.type))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
};

/** Project a graph node into a {@link ChainComponentRef}. */
export const toChainRef = (
  node: Node,
  role: string,
  note?: string,
): ChainComponentRef => ({
  componentId: node.id,
  componentType: node.type,
  apiName: node.apiName,
  role,
  ...(note !== undefined ? { note } : {}),
});
