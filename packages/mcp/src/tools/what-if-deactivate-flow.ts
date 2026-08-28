/**
 * Handler for the `sfi.what_if_deactivate_flow` MCP tool.
 *
 * v2.3 R2b — the first of three component-level what-if composers.
 * Given a Flow canonical id (`Flow:{ApiName}`), enumerates the
 * downstream impact of deactivating the Flow: every outgoing edge the
 * Flow has becomes a potential lost-effect when the Flow no longer
 * fires. Pairs with R2a's field-level tools (`what_if_change_field_type`,
 * `what_if_remove_picklist_value`, `what_if_make_field_required`) and
 * R2c's profile-level tools (`what_if_merge_profiles`,
 * `what_if_split_profile`) to complete the v2.3 what-if catalogue.
 *
 * **What deactivation breaks.** Deactivating a Flow means none of its
 * actions run anymore. The composer walks each outgoing edge type the
 * Flow emits and projects a per-edge `WhatIfImpactItem`:
 *
 *   | Edge (direction) | What it represented | Impact category    | Verdict   |
 *   |------------------|---------------------|--------------------|-----------|
 *   | triggersOn (out) | The object the Flow listened to | NOT an impact — `entryPoints` | — |
 *   | listensTo (out)  | Platform Event the Flow subscribes to | NOT an impact — `entryPoints` | — |
 *   | callsApex (out)  | Apex action calls the Flow made | code-needs-update | risky |
 *   | readsFrom (out)  | Record lookups the Flow performed | input-only | NONE |
 *   | writesTo (out)   | Record writes (creates/updates/deletes) | metadata-blocker | blocking |
 *   | sendsEmail (out) | Email templates the Flow sent     | metadata-blocker | blocking |
 *   | references/subflow (out) | Subflows THIS Flow invokes    | metadata-blocker | blocking |
 *   | references/subflow (IN)  | Parent Flows that invoke THIS Flow as a subflow | broken-caller | blocking if any Active |
 *
 * **An entry point is not a dependent.** `triggersOn` (and `listensTo`,
 * if the extractor ever mints one from a Flow) is the Flow's OWN START
 * — where the runtime hands control TO it — not something downstream of
 * it. Classifying it `blocking` made the verdict near-unconditional for
 * every record-triggered Flow. It is RECATEGORISED into `entryPoints`,
 * never dropped: the same identity is still in the response.
 *
 * **`readsFrom` is an INPUT, not an effect.** A Get Records lookup is
 * an input to this Flow, not a downstream consequence of it: the record
 * / field is unchanged and nothing downstream of it is affected.
 * Rating it `metadata-blocker` / `blocking` was the sharpest instance
 * of the category error. It is surfaced with `category: 'input-only'`
 * and contributes NOTHING to the verdict.
 *
 * R6-02 adds the INCOMING side. Before it the composer walked only
 * OUTGOING edges, so a subflow called by N parents had zero surfaced
 * dependents and read `safe` to deactivate — a wrong destructive verdict.
 * The incoming `references` edges (confidence `declared`, `referenceKind:
 * 'subflow'`) are now walked: each parent Flow is a BROKEN CALLER whose
 * subflow-call step fails at runtime on deactivation. Only
 * `referenceKind: 'subflow'` counts — a FlexiPage that merely EMBEDS the
 * flow, or any `grantedBy` / `parentOf` edge, is access/structure, not a
 * broken subflow caller (access ≠ usage).
 *
 * Outgoing structural edges (`parentOf`, `firesWhen`) are NOT impacts:
 * they describe the Flow's own composition, not its downstream effect.
 * `firesWhen` IS surfaced separately in the response's `firingConditions`
 * field — those are the conditions under which the Flow currently fires
 * (the conditions the deactivation would silence), and the caller may
 * want to render them so the user understands what gating logic is
 * being removed.
 *
 * **Two axes: runtime state and dependency structure.** The response
 * carries BOTH, because they answer different questions.
 *
 *   - `structuralVerdict` is what the dependency structure says, over
 *     the VERDICT-BEARING impacts only (`input-only` excluded). Cascade,
 *     mirroring R2a's `WhatIfChangeFieldType`:
 *       * `safe` when there is no verdict-bearing impact at all — counting
 *         `unresolvedImpacts` as well, so an unresolvable dependent can never
 *         be answered with `safe` — and then `notProvenHarmless` states what
 *         that `safe` does and does not prove, because `safe` alone
 *         over-claims.
 *       * `blocking` if ANY `metadata-blocker` impact appears (record
 *         writes / email sends / subflow invocations would silently
 *         stop), OR any `broken-caller` is an ACTIVE parent Flow (R6-02:
 *         a live parent breaks at runtime).
 *       * `risky` if no blocker but at least one `code-needs-update`
 *         impact, or a `broken-caller` whose parents are all inactive.
 *       * `unknown` is reserved (never returned by this tool).
 *   - `verdict` is the HEADLINE and consults `runtimeState`: a Flow that
 *     does not run today (Draft / Obsolete / InvalidDraft) gets
 *     `already-inactive`, because telling the caller "deactivating this
 *     would break things" about automation that is already off is false.
 *     Measured org-wide, 67 of 71 non-Active Flows read `blocking`.
 *     `already-inactive` asserts the one true thing (it is already off)
 *     WITHOUT claiming the second (nothing depends on it) — the
 *     dependents stay in `impacts` and in `structuralVerdict`.
 *   - `runtimeState.currentlyRunning` is `null`, never `false`, when the
 *     vault records no status: absence is UNKNOWN, not "off".
 *
 * This is the reasoning the tool ALREADY applies to its callers ("this
 * parent is Obsolete, so it is not currently running"), applied at last
 * to its own subject. Only `structuralVerdict` is coverage-downgraded;
 * being switched off is not a coverage-dependent claim.
 *
 * **Honesty axis.** v2.3 applies a fail-conservative approach when
 * disclosing impact. Deactivation does NOT delete the Flow — its
 * definition remains in the org and a later reactivation restores every
 * effect listed. Apex code that conditionally invokes the Flow's outputs
 * (via `Flow.Interview` or an `@InvocableMethod` chain) remains invisible
 * to the heuristic walker — the subflow modeling is DECLARED `<subflows>`
 * metadata only, not the Apex `Flow.Interview` invocation path; the caller
 * should spot-check Apex callers via `sfi.find_code_usages` targeting the
 * Flow id.
 *
 * Implementation notes:
 *   - `flowId` is required to start with `Flow:`. Other prefixes return
 *     `invalid-query` at the handler boundary. The Zod schema can only
 *     enforce non-emptiness; the prefix check lives in this module.
 *   - Unknown ids resolve to `component-not-found`. The graph cannot
 *     distinguish "Flow never existed" from "Flow was deleted between
 *     vault refresh and tool invocation".
 *   - For each outgoing edge, the batched node fetch resolves the downstream
 *     node's identity (`type`, `apiName`). An edge whose target is NOT a node
 *     in this vault (the importer's `targetMissing` marker, read via the
 *     shared `edgeTargetMissing`) is NEVER dropped: it is diverted to
 *     `unresolvedImpacts` (or, for an entry point, kept in `entryPoints` with
 *     `targetMissing: true`) and it is graded into the verdict alongside the
 *     resolvable rows. Dropping it — the old behaviour, justified only by a
 *     comment claiming parity with unnamed peers — made a Flow whose impact
 *     edges all left the vault report `impacts: []`, which `aggregateVerdict`
 *     turns into the literal word `safe`.
 *   - The `firingConditions` array is sourced from the Flow's outgoing
 *     `firesWhen` edges (the v2.0a ConditionalContext primitive). Each
 *     entry carries the synthetic conditionContextId and the parsed
 *     expression so the renderer can inline the gating predicate
 *     without an extra graph roundtrip.
 *   - Impacts are sorted by `(category, componentId)` ASC for
 *     deterministic output. The category tiebreaker keeps related
 *     blockers grouped together when the renderer flattens the list.
 */

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  Edge,
  EdgeType,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
  resolveComponents,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  edgeTargetMissing,
  unresolvedTargetsDisclosure,
} from './absence-disclosure.js';
import { coercePrefix } from './coerce-id.js';
import {
  attachCoverageToWhatIf,
  type CoverageCaveat,
  FLOW_DEACTIVATION_REQUIRED_COVERAGE,
  type Verdict,
} from './coverage-trust.js';
import { firstNonEmpty } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix for the Flow node type. */
const FLOW_PREFIX = 'Flow:';

/**
 * One finding category in the `WhatIfImpactItem` shape, mirroring
 * R2a's `what-if-change-field-type.ts` definition. The composer module
 * uses the same union across every v2.3 tool so the
 * `architect-what-if-analysis` skill can group by category uniformly.
 *
 * `broken-caller` is a Flow-deactivation-specific EXTENSION of the shared
 * union (R6-02): it names an INCOMING dependent — a parent Flow that invokes
 * THIS Flow as a subflow and would break at runtime on deactivation. It is
 * distinct from `metadata-blocker` (which names this Flow's own OUTGOING
 * effects that stop). A `broken-caller` from an ACTIVE parent forces the
 * headline verdict to `blocking`; see {@link aggregateVerdict}.
 */
type Category =
  | 'metadata-blocker'
  | 'code-needs-update'
  | 'integration-touch'
  | 'test-class-update'
  | 'invisible-risk'
  | 'configuration-only'
  | 'broken-caller'
  /**
   * A dependency THIS Flow consumes (a record / field it reads), not a
   * dependent on it. Surfaced for completeness and EXCLUDED from the verdict
   * — see {@link isVerdictBearing}.
   */
  | 'input-only';

/**
 * One impact entry in the response's `impacts` array. Mirrors the
 * `WhatIfImpactItem` interface in R2a's `what-if-change-field-type.ts`
 * — scoped to the fields v2.3 R2 populates. The full R1b contract
 * (with `location` + `suggestedAction`) is deferred to the R1b plan
 * worker.
 */
export interface WhatIfImpactItem {
  readonly category: Category;
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly confidence: ConfidenceLevel;
  readonly explanation: string;
}

/**
 * One condition currently gating the Flow's firing. Sourced from the
 * Flow's outgoing `firesWhen` edges (the v2.0a ConditionalContext
 * primitive). Each entry carries the synthetic conditionContextId and
 * the parsed expression so the renderer can inline the predicate
 * without an extra graph traversal. The caller may render this list
 * before the impacts to set context ("the Flow currently fires when
 * X; deactivating it stops these effects").
 */
export interface WhatIfDeactivateFlowFiringCondition {
  readonly conditionContextId: ComponentId;
  readonly expression: string;
}

/**
 * One ENTRY POINT of the Flow — where the runtime hands control TO it.
 * `triggersOn` (the SObject the record-triggered Flow starts on) and
 * `listensTo` (a Platform Event subscription) used to be reported as
 * `impacts`, which pinned the verdict: an entry point is not a dependent.
 * They are recategorised here rather than dropped, so the identity a caller
 * used to read out of `impacts` is still in the response. A row whose target
 * is not a node in this vault is kept too, flagged `targetMissing`.
 */
export interface WhatIfEntryPoint {
  readonly kind: 'triggersOn' | 'listensTo';
  readonly componentId: ComponentId;
  readonly note: string;
  /**
   * True when the entry-point target is not a node in this vault — a standard
   * object outside the retrieve scope, or a managed-package Platform Event.
   * ALWAYS written: a row without the key would make "resolved" and "never
   * resolvable" render the same. The row is emitted either way, because a
   * record-triggered Flow whose trigger object is out of vault previously
   * reported `entryPoints: []` — indistinguishable from an autolaunched Flow
   * that genuinely has no entry point.
   */
  readonly targetMissing: boolean;
}

/**
 * One impact whose target component is NOT a node in this vault: a
 * managed-package Apex action, an EmailTemplate the refresh never retrieved, a
 * packaged subflow, or a caller/subscriber outside the retrieve scope.
 *
 * The EDGE is declared and real — deactivating the Flow stops that effect
 * whether or not the target can be named here — so these rows are NEVER
 * dropped and they bear on the verdict exactly as their resolvable twins do.
 * They are kept OUT of `impacts` because `componentType` / `apiName` are
 * genuinely unknown, and a fabricated identity would send the caller to
 * `resolve` / `get_component` on an id that dead-ends.
 *
 * Before this shape existed, all three walks (`out`, broken-caller, the
 * platform-event second hop) dropped the edge at a `node === undefined` guard,
 * so a Flow whose every impact edge left the vault produced `impacts: []` and
 * the aggregate verdict `safe` — a destructive answer manufactured by not
 * looking. `sfi.user_ability` and `sfi.downstream_effects` already solve the
 * identical case by marking the row; this mirrors them.
 */
export interface WhatIfUnresolvedImpact {
  readonly category: Category;
  /** The edge endpoint id, verbatim. `resolve` on it returns not-found. */
  readonly componentId: ComponentId;
  readonly edgeType: EdgeType;
  readonly confidence: ConfidenceLevel;
  /** Always `true` on this array — see {@link edgeTargetMissing}. */
  readonly targetMissing: true;
  readonly explanation: string;
}

/**
 * The RUNTIME-STATE axis — does this Flow run in the org today? Separate from
 * the dependency structure because they are different questions.
 *
 *   - `status` is the vault's recorded status, or `null` when the vault does
 *     not carry one. Never `''` — an empty string reads as a value.
 *   - `currentlyRunning` is `true` / `false` only when the status says so, and
 *     `null` when it is absent or unrecognised. NEVER a fabricated `false`.
 *   - `note` states, in one sentence, what that means for the verdict.
 */
export interface WhatIfRuntimeState {
  readonly status: string | null;
  readonly currentlyRunning: boolean | null;
  readonly note: string;
}

/**
 * The headline verdict vocabulary for this tool: the shared what-if
 * {@link Verdict} plus `already-inactive`.
 *
 * `already-inactive` is a FOURTH word on purpose. `safe` already means "no
 * impacts at all" and is coverage-downgraded to `review`, so reusing it would
 * make an inactive-but-heavily-depended-on Flow read identically to a
 * genuinely inert one. `already-inactive` asserts only that the Flow does not
 * run today; what depends on it is reported by `structuralVerdict` and
 * `impacts`.
 */
export type FlowDeactivateVerdict = Verdict | 'already-inactive';

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfDeactivateFlowOutput {
  /**
   * Echoes the Flow scope ACTUALLY resolved so a host that passed a
   * `componentId` / `flowApiName` / `apiName` alias sees it was honored, not
   * silently stripped. Always `component` mode — the tool is single-Flow.
   */
  readonly appliedScope: {
    readonly component: ComponentId;
    readonly mode: 'component';
  };
  readonly flowId: ComponentId;
  readonly apiName: string;
  readonly status: string;
  readonly firingConditions: readonly WhatIfDeactivateFlowFiringCondition[];
  /** Where the runtime enters this Flow. NOT impacts — see {@link WhatIfEntryPoint}. */
  readonly entryPoints: readonly WhatIfEntryPoint[];
  readonly impacts: readonly WhatIfImpactItem[];
  /**
   * Impacts whose target is not a node in this vault. ALWAYS present (empty
   * when every target resolved) so an absent key can never be read as "none".
   * These rows DO move the verdict — see {@link WhatIfUnresolvedImpact}.
   */
  readonly unresolvedImpacts: readonly WhatIfUnresolvedImpact[];
  /**
   * The shared unresolved-target sentence, present exactly when at least one
   * `unresolvedImpacts` row or one `targetMissing` entry point exists.
   */
  readonly unresolvedTargetsNote?: string;
  /** Does it run today? Its own axis; see {@link WhatIfRuntimeState}. */
  readonly runtimeState: WhatIfRuntimeState;
  /** HEADLINE. `already-inactive` when the Flow does not run today. */
  readonly verdict: FlowDeactivateVerdict;
  /** What the dependency structure says, independent of runtime state. */
  readonly structuralVerdict: Verdict;
  /**
   * Present exactly when there is no verdict-bearing impact. States what that
   * `safe` does NOT prove, because an empty result is a statement about the
   * edge types walked, not a proof of harmlessness.
   */
  readonly notProvenHarmless?: string;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

/**
 * The verbatim disclosure surfaced in every response. Frozen so the
 * test suite can assert the exact string; rephrasing during rendering
 * is a code-review concern, not silent drift. The phrasing mirrors
 * R2a's `what-if-change-field-type.ts` disclosure to keep the v2.3
 * tool surface uniform.
 */
const DISCLOSURE =
  "v2.3 what-if analysis is composition over the v2.2 vault state. Deactivating a Flow stops the downstream effects listed in impacts; entries with category 'input-only' are dependencies the Flow CONSUMES (records / fields it reads) and stop nothing downstream, and entryPoints names where the Flow starts rather than anything it affects; the Flow's definition remains in the org and a later reactivation restores the effects. R6-02: parent Flows that invoke this Flow as a subflow (declared <subflows> calls) are now surfaced as broken-caller impacts — an ACTIVE parent forces a blocking verdict because its subflow-call step fails at runtime. Apex code that invokes the Flow via Flow.Interview or @InvocableMethod chains is STILL invisible to the heuristic walker, as are non-metadata launch points (quick actions, buttons, screen-flow entry); review callers via sfi.find_code_usages targeting the Flow id before relying on this finding.";

/**
 * Verbatim: what a `safe` structural verdict does NOT prove. Emitted whenever
 * there is no verdict-bearing impact, because `safe` on its own over-claims —
 * absence of a modelled edge is a statement about the edge types walked.
 */
const NOT_PROVEN_HARMLESS =
  'No downstream effect is visible in this vault. That is a statement about the edge types walked (writesTo, callsApex, dispatchesAsync, sendsEmail, subflow references), not a proof that disabling is harmless — dynamic dispatch, managed-package callers, and framework wiring are invisible here.';

/** Verbatim: the vault records no activation status, so "runs today" is UNKNOWN. */
const UNKNOWN_RUNTIME_STATE_NOTE =
  "This component's activation status is not recorded in this vault, so whether it runs today is UNKNOWN — not assumed active and not assumed inactive. Treat the verdict as the structural answer only, and confirm the status in the org.";

/**
 * The Flow's own ENTRY POINTS, mapped to the verbatim `entryPoints` note. An
 * edge type in this table is where the runtime hands control TO the Flow, so
 * it is never an impact — it is recategorised, not dropped.
 */
const ENTRY_POINT_NOTES: Readonly<Record<string, string>> = Object.freeze({
  triggersOn:
    'the object this Flow starts on; deactivating removes the record-trigger here',
  listensTo:
    'the Platform Event this Flow subscribes to; deactivating removes the subscription here',
});

/** The `entryPoints` note for an edge type, or `undefined` when it is a real impact. */
const entryPointNoteFor = (edgeType: string): string | undefined =>
  ENTRY_POINT_NOTES[edgeType];

/**
 * Zod schema for the `sfi.what_if_deactivate_flow` tool input.
 *
 *   - `flowId` / `componentId` / `flowApiName` / `apiName`: the Flow to analyse,
 *     interchangeable (a host naturally reaches for `componentId: Flow:…` as on
 *     `get_impact` and most tools). At least one is required; disagreeing
 *     selectors are `invalid-query` (never a silent pick). Each accepts three
 *     forms:
 *       1. Canonical Flow id (`Flow:{ApiName}`) — looked up directly.
 *       2. Bare API name (`{ApiName}`) — coerced to `Flow:{ApiName}`.
 *       3. Flow label or partial name (e.g. `"Consent Flow"`) — when the
 *          direct lookup finds nothing, the handler does an internal fuzzy
 *          search (resolveComponents filtered to `Flow` type) and returns
 *          a single-match auto-resolve, a multiple-candidates list, or a
 *          no-match error as appropriate.
 */
export const whatIfDeactivateFlowInputSchema = z.object({
  flowId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  flowApiName: z.string().min(1).optional(),
  apiName: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from the Zod schema. */
export type WhatIfDeactivateFlowInput = z.infer<
  typeof whatIfDeactivateFlowInputSchema
>;

/**
 * Resolve the single RAW flow selector from the interchangeable `flowId` /
 * `componentId` / `flowApiName` / `apiName` args — the alias residual this
 * closes (a host naturally passes `componentId: Flow:…`). Conflict detection is
 * over the `Flow:`-coerced forms (so `flowId: "My_Flow"` and `componentId:
 * "Flow:My_Flow"` agree), but the returned value is the RAW selector by
 * precedence so the handler's downstream fuzzy label/partial resolution still
 * sees the caller's original string. Disagreeing selectors → `invalid-query`
 * (never a silent pick); none → `invalid-query`.
 */
const resolveFlowSelector = (
  input: WhatIfDeactivateFlowInput,
): Result<string, McpError> => {
  const raws = [input.flowId, input.componentId, input.flowApiName, input.apiName]
    .map((v) => firstNonEmpty(v))
    .filter((v): v is string => v !== undefined);
  if (raws.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'name the Flow — pass `flowId` (e.g. "Flow:My_Flow"), `componentId`, `flowApiName`, or `apiName` (a bare api name or flow label also works)',
      path: 'flowId',
    });
  }
  const distinct = [...new Set(raws.map((v) => coercePrefix(v, [FLOW_PREFIX])))];
  if (distinct.length > 1) {
    return err({
      kind: 'invalid-query',
      message: `flow selectors name different targets (${distinct.join(', ')}); pass exactly one of flowId / componentId / flowApiName / apiName`,
      path: 'flowId',
    });
  }
  return ok(raws[0] as string);
};

/**
 * Strip the canonical-id prefix to surface the bare ApiName the
 * renderer wants. Malformed ids (no colon) pass through verbatim so
 * the response shape stays stable.
 */
const stripPrefix = (id: ComponentId): string => {
  const colonIdx = id.indexOf(':');
  return colonIdx < 0 ? id : id.slice(colonIdx + 1);
};

/**
 * Pull the Flow's `status` property. The Flow extractor enforces the
 * `Active` / `Draft` / `Obsolete` / `InvalidDraft` enum at extraction
 * time; the empty-string fallback shouldn't fire in practice but keeps
 * the response shape stable for malformed inputs.
 */
const readFlowStatus = (node: Node): string => {
  const raw = node.properties['status'];
  return typeof raw === 'string' ? raw : '';
};

/**
 * Classify one outgoing edge into a `(category, verdict)` pair. The
 * rule table is documented in the module JSDoc above. Entry-point edge
 * types ({@link ENTRY_POINT_NOTES}) never reach this function.
 * `writesTo` and `sendsEmail` are metadata-declared (the Flow XML names
 * them literally) and are real downstream effects, so the verdict is
 * `blocking`; `callsApex` is `code-needs-update` because the called
 * Apex class may have side effects the Flow's deactivation now skips;
 * `readsFrom` is `input-only` — a record the Flow CONSUMES, surfaced but
 * never verdict-bearing. Unknown edge types fall through to
 * `configuration-only` / `risky` so the caller still sees the finding
 * rather than the tool silently dropping it.
 */
const classifyOutgoingEdge = (
  edge: Edge,
): { category: Category; verdict: Verdict } => {
  switch (edge.edgeType) {
    case 'callsApex':
      return { category: 'code-needs-update', verdict: 'risky' };
    case 'readsFrom':
      // `input-only` carries no verdict; see {@link isVerdictBearing}.
      return { category: 'input-only', verdict: 'safe' };
    case 'writesTo':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    case 'sendsEmail':
      return { category: 'metadata-blocker', verdict: 'blocking' };
    case 'references':
      // R6-02: an OUTGOING subflow reference (`referenceKind: 'subflow'`) is
      // this Flow invoking ANOTHER Flow. Deactivating this Flow silently stops
      // that subflow (and every effect it performs) from running in this Flow's
      // path — a metadata-blocker, same tier as a lost DML/trigger. Non-subflow
      // `references` fall through to the generic configuration-only bucket.
      if (edge.properties['referenceKind'] === 'subflow') {
        return { category: 'metadata-blocker', verdict: 'blocking' };
      }
      return { category: 'configuration-only', verdict: 'risky' };
    default:
      return { category: 'configuration-only', verdict: 'risky' };
  }
};

/**
 * The verb for an outgoing edge type, shared by the resolvable and the
 * unresolvable explanation builders so the two sentences cannot drift.
 */
const outgoingVerb = (edgeType: EdgeType): string =>
  edgeType === 'writesTo'
    ? 'writes to'
    : edgeType === 'callsApex'
      ? 'calls'
      : edgeType === 'sendsEmail'
        ? 'sends email via'
        : 'references';

/**
 * Synthesise the per-finding `explanation` string. The phrasing
 * mirrors R2a's `what-if-change-field-type.ts` `buildExplanation` so
 * the renderer can rely on a uniform "the Flow does X to component Y"
 * shape across the v2.3 surface.
 */
const buildExplanation = (
  toNode: Node,
  edge: Edge,
  flowApiName: string,
): string => {
  // R6-02: an outgoing subflow reference reads as "invokes subflow" so the
  // renderer distinguishes a nested-Flow call from a generic reference.
  if (
    edge.edgeType === 'references' &&
    edge.properties['referenceKind'] === 'subflow'
  ) {
    return `Flow '${flowApiName}' invokes subflow '${toNode.apiName}'; deactivating the Flow stops that subflow from running in this path.`;
  }
  // A read is an INPUT to this Flow, not an action with downstream
  // consequences. The old sentence ("…stops this action.") was factually
  // wrong: deactivating the Flow removes the read, and that is all.
  if (edge.edgeType === 'readsFrom') {
    return `Flow '${flowApiName}' reads ${toNode.type} '${toNode.apiName}'. Deactivating the Flow removes that read; '${toNode.apiName}' itself is unchanged and nothing downstream of it is affected. Listed because it is a dependency of this Flow, not a dependent on it.`;
  }
  return `Flow '${flowApiName}' ${outgoingVerb(edge.edgeType)} ${toNode.type} '${toNode.apiName}'; deactivating the Flow stops this action.`;
};

/**
 * The `explanation` for an OUTGOING edge whose target is not a node here. It
 * names the id verbatim (never a fabricated apiName), says why the lookup
 * dead-ends, and states that the effect stops anyway — the edge is declared.
 */
const buildUnresolvedOutgoingExplanation = (
  edge: Edge,
  flowApiName: string,
): string => {
  const subflow =
    edge.edgeType === 'references' &&
    edge.properties['referenceKind'] === 'subflow';
  const action = subflow
    ? `invokes subflow '${edge.toId}'`
    : `${outgoingVerb(edge.edgeType)} '${edge.toId}'`;
  const consequence =
    edge.edgeType === 'readsFrom'
      ? 'Deactivating the Flow removes that read; nothing downstream of it is affected (listed as a dependency of this Flow, not a dependent on it).'
      : 'Deactivating the Flow stops this action.';
  return (
    `Flow '${flowApiName}' ${action}, which is NOT a node in this vault ` +
    '(`targetMissing`) — a managed-package component, or one this refresh did ' +
    `not retrieve. The edge is DECLARED and real. ${consequence} The target's ` +
    'type and api name cannot be reported here, so this row is in ' +
    '`unresolvedImpacts` rather than `impacts`.'
  );
};

/**
 * Build the response's `unresolvedTargetsNote`, or `undefined` when every
 * target resolved. The impact half is the shared
 * {@link unresolvedTargetsDisclosure} contract sentence so this tool cannot
 * drift from `user_ability` / `downstream_effects`; the entry-point half is
 * appended only when it applies, because a "0 …" sentence is itself a false
 * statement.
 */
const buildUnresolvedTargetsNote = (
  unresolvedImpactCount: number,
  unresolvedEntryPointCount: number,
): string | undefined => {
  const parts: string[] = [];
  if (unresolvedImpactCount > 0) {
    parts.push(
      unresolvedTargetsDisclosure({
        count: unresolvedImpactCount,
        targetKind: 'impact-edge',
        targetNoun: 'edge',
        surface: '`unresolvedImpacts`',
      }) +
        ' They are carried in `unresolvedImpacts`, EXCLUDED from `impacts` ' +
        '(their type / api name are unknown), and they DO bear on the verdict ' +
        '— the declared effect stops on deactivation whether or not the ' +
        'target can be named here.',
    );
  }
  if (unresolvedEntryPointCount > 0) {
    parts.push(
      `${unresolvedEntryPointCount} entryPoints row(s) name a component that is ` +
        'NOT in this vault (`targetMissing`) — typically a standard object or ' +
        'Platform Event outside the retrieve scope. The row is kept so an ' +
        'out-of-vault trigger cannot read as "this Flow has no entry point".',
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
};

/**
 * TRUE when an impact is a DEPENDENT of this Flow — something downstream that
 * stops. `input-only` entries are dependencies the Flow CONSUMES and are
 * excluded: they are reported, but they never move the verdict.
 *
 * Takes the CATEGORY-bearing shape rather than `WhatIfImpactItem` so the
 * resolvable rows and the `targetMissing` rows are graded by ONE predicate. An
 * unresolvable target is still a real declared effect; grading it separately
 * is how `impacts: []` became the word `safe`.
 */
const isVerdictBearing = (impact: { readonly category: Category }): boolean =>
  impact.category !== 'input-only';

/**
 * Aggregate the verdict-bearing impacts into the STRUCTURAL severity. The
 * cascade mirrors R2a's `aggregateVerdict`:
 *   - no verdict-bearing impact → `safe` (plus `notProvenHarmless`).
 *   - any `metadata-blocker` → `blocking`.
 *   - any non-blocker `code-needs-update` / `integration-touch` → `risky`.
 *   - only `configuration-only` / `broken-caller` → `risky` (the finding
 *     still warrants attention even though the deploy itself won't fail).
 *
 * R6-02: `broken-caller` impacts (parent Flows that call THIS Flow as a
 * subflow) fall through to `risky` HERE — the escalation to `blocking` for
 * an ACTIVE parent is applied by the caller
 * ({@link whatIfDeactivateFlowFromNode}) via `escalateForActiveCallers`,
 * because whether a parent is currently live depends on its `status`, which
 * this category-only cascade does not carry. A subflow whose only callers are
 * inactive (Draft / Obsolete) is surfaced but stays `risky`, not `safe`.
 */
const aggregateVerdict = (
  impacts: readonly { readonly category: Category }[],
): Verdict => {
  const dependents = impacts.filter(isVerdictBearing);
  if (dependents.length === 0) return 'safe';
  for (const impact of dependents) {
    if (impact.category === 'metadata-blocker') return 'blocking';
  }
  for (const impact of dependents) {
    if (
      impact.category === 'code-needs-update' ||
      impact.category === 'integration-touch'
    ) {
      return 'risky';
    }
  }
  return 'risky';
};

/**
 * Resolve the RUNTIME-STATE axis from the Flow's recorded status.
 *
 * The Flow extractor writes the `Active` / `Draft` / `Obsolete` /
 * `InvalidDraft` enum. Anything else — an absent property, an empty string, an
 * unrecognised value — yields `currentlyRunning: null` with the UNKNOWN note.
 * A fabricated `false` here would assert "this Flow is off" on the strength of
 * a missing property, which is exactly the absence-as-fact error this tool
 * exists to avoid.
 *
 * @param dependentCount the number of VERDICT-BEARING impacts — the things
 *   that would be affected if the Flow were reactivated.
 */
const resolveRuntimeState = (
  status: string,
  dependentCount: number,
): WhatIfRuntimeState => {
  if (status === 'Active') {
    return {
      status,
      currentlyRunning: true,
      note: 'This Flow is Active — it runs in the org today, so the headline verdict is the structural verdict.',
    };
  }
  if (status === 'Draft' || status === 'Obsolete' || status === 'InvalidDraft') {
    return {
      status,
      currentlyRunning: false,
      note: `This Flow is ${status} — it does not run in the org today, so deactivating it changes no runtime behaviour. structuralVerdict below describes what WOULD stop if it were Active. That is NOT a claim that nothing depends on it: ${dependentCount} dependent(s) are listed in impacts, and they will be affected if it is ever reactivated.`,
    };
  }
  return {
    status: status.length > 0 ? status : null,
    currentlyRunning: null,
    note: UNKNOWN_RUNTIME_STATE_NOTE,
  };
};

/**
 * Escalate a computed verdict to `blocking` when at least one broken caller is
 * an ACTIVE parent Flow (R6-02). An active parent invokes this subflow in a
 * currently-running path, so deactivating the subflow breaks that parent at
 * runtime — the verdict must not sit below `blocking`. Non-active parents
 * (Draft / Obsolete / InvalidDraft) are still surfaced as `broken-caller`
 * impacts but do not force the escalation here.
 */
const escalateForActiveCallers = (
  verdict: Verdict,
  hasActiveBrokenCaller: boolean,
): Verdict => (hasActiveBrokenCaller ? 'blocking' : verdict);

/**
 * Comparator for the deterministic impact sort. Sort first by
 * `category` ASC then by `componentId` ASC so related blockers stay
 * grouped in the rendered output.
 */
interface SortableImpact {
  readonly category: Category;
  readonly componentId: ComponentId;
}

const compareImpacts = (a: SortableImpact, b: SortableImpact): number => {
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  return 0;
};

/**
 * Surface every `firesWhen` ConditionalContext the Flow points at.
 * Each entry carries the synthetic conditionContextId and the parsed
 * expression text. Sparse-graph misses (an edge whose target
 * ConditionalContext was dropped) are silently skipped. Mirrors
 * `explain-flow.ts`'s `collectTriggerConditions` shape so callers can
 * reuse the same renderer code for both tools.
 */
const collectFiringConditions = async (
  ctx: Context,
  flowId: ComponentId,
): Promise<Result<readonly WhatIfDeactivateFlowFiringCondition[], string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'firesWhen',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  // ONE batched fetch of every firesWhen target, replacing the per-edge
  // `getNodeById` N+1. Edge order is preserved (this output is not re-sorted).
  const nodesResult = await listNodesByIds(
    ctx.graph,
    edgesResult.value.map((e) => e.toId),
  );
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const byId = new Map(nodesResult.value.map((n) => [n.id, n]));
  const out: WhatIfDeactivateFlowFiringCondition[] = [];
  for (const edge of edgesResult.value) {
    const node = byId.get(edge.toId);
    if (node === undefined) continue;
    const expressionRaw = node.properties['expression'];
    out.push({
      conditionContextId: node.id,
      expression: typeof expressionRaw === 'string' ? expressionRaw : '',
    });
  }
  return ok(out);
};

/** Result of the incoming broken-caller walk. */
interface BrokenCallerScan {
  readonly impacts: readonly WhatIfImpactItem[];
  /**
   * Callers whose SOURCE node is not in this vault. The subflow-call edge is
   * declared, so the caller exists and breaks; only its identity and its
   * `status` are unknown here. Never dropped — a subflow whose only parent is
   * out of vault used to read `safe`.
   */
  readonly unresolved: readonly WhatIfUnresolvedImpact[];
  /** True when at least one broken caller has `status === 'Active'`. */
  readonly hasActiveBrokenCaller: boolean;
}

/**
 * Read a Flow node's `status` property (`Active` / `Draft` / `Obsolete` /
 * `InvalidDraft`), defaulting to `'unknown'` so the explanation never renders
 * an empty status.
 */
const readCallerStatus = (node: Node): string => {
  const raw = node.properties['status'];
  return typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
};

/**
 * R6-02: the INCOMING side. Walk `references` edges pointing AT this Flow and
 * keep only the ones a PARENT Flow emitted to invoke it as a subflow
 * (`properties.referenceKind === 'subflow'`). Each such parent is a BROKEN
 * CALLER on deactivation — deactivating this subflow makes the parent's
 * subflow-call step fail at runtime.
 *
 * Honesty (access ≠ usage): only `references` edges with `referenceKind:
 * 'subflow'` are counted. Other incoming edge types (`grantedBy`, `parentOf`,
 * `firesWhen`) and non-subflow `references` (e.g. a FlexiPage that merely
 * EMBEDS the flow) are NOT broken callers and are excluded — matching the
 * find_component_usages access-vs-usage discipline.
 *
 * Every parent caller is surfaced as a `broken-caller` impact (full
 * transparency, with the parent's `status` in the explanation), but only an
 * ACTIVE parent sets `hasActiveBrokenCaller` — the signal
 * {@link escalateForActiveCallers} uses to force `blocking`. A subflow whose
 * only callers are inactive is surfaced but does not read `safe`.
 *
 * Sparse-graph misses (an edge whose source node was dropped) and non-Flow
 * sources (a malformed subflow edge) are skipped defensively.
 */
const collectBrokenCallers = async (
  ctx: Context,
  flowId: ComponentId,
  flowApiName: string,
): Promise<Result<BrokenCallerScan, string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  // ONE batched fetch of every subflow caller, replacing the per-edge
  // `getNodeById` N+1. Filter to subflow references first, then batch their
  // sources; edge order is preserved (final response re-sorts by compareImpacts).
  const subflowEdges = edgesResult.value.filter(
    (e) => e.properties['referenceKind'] === 'subflow',
  );
  const parentNodesResult = await listNodesByIds(
    ctx.graph,
    subflowEdges.map((e) => e.fromId),
  );
  if (!parentNodesResult.ok) return err(parentNodesResult.error.message);
  const parentById = new Map(parentNodesResult.value.map((n) => [n.id, n]));
  const impacts: WhatIfImpactItem[] = [];
  const unresolved: WhatIfUnresolvedImpact[] = [];
  let hasActiveBrokenCaller = false;
  for (const edge of subflowEdges) {
    const parentNode = parentById.get(edge.fromId);
    if (parentNode === undefined) {
      // The caller's node is not in this vault (a packaged parent Flow, or one
      // outside the retrieve scope). The `<subflows>` call is DECLARED, so the
      // caller is real and it breaks on deactivation — dropping it is how a
      // called subflow reported zero dependents and the word `safe`. Its
      // `status` is unreadable, so it never escalates to `blocking`; the
      // explanation says so rather than implying the parent is inactive.
      unresolved.push({
        category: 'broken-caller',
        componentId: edge.fromId,
        edgeType: edge.edgeType,
        confidence: edge.confidence,
        targetMissing: true,
        explanation:
          `'${edge.fromId}' invokes '${flowApiName}' as a subflow, but that ` +
          'caller is NOT a node in this vault (`targetMissing`) — a ' +
          'managed-package Flow, or one this refresh did not retrieve. The ' +
          'subflow call is DECLARED, so deactivating ' +
          `'${flowApiName}' makes it fail; the caller's activation status is ` +
          'UNKNOWN here, so this does not escalate the verdict to blocking on ' +
          'its own. Confirm the caller in the org.',
      });
      continue;
    }
    if (parentNode.type !== 'Flow') continue; // defensive: subflow callers are Flows
    const status = readCallerStatus(parentNode);
    if (status === 'Active') hasActiveBrokenCaller = true;
    const activeNote =
      status === 'Active'
        ? 'this parent is Active, so deactivation breaks it at runtime'
        : `this parent is ${status}, so it is not currently running — verify before relying on it`;
    impacts.push({
      category: 'broken-caller',
      componentId: parentNode.id,
      componentType: parentNode.type,
      apiName: parentNode.apiName,
      confidence: edge.confidence,
      explanation:
        `Flow '${parentNode.apiName}' (${status}) invokes '${flowApiName}' as a subflow; ` +
        `deactivating '${flowApiName}' makes that subflow call fail — ${activeNote}.`,
    });
  }
  return ok({ impacts, unresolved, hasActiveBrokenCaller });
};

/**
 * Core impact-analysis logic given an already-resolved Flow node and its
 * canonical id. Extracted so the fuzzy-resolution path can delegate here
 * without duplicating the edge-walk.
 */
const whatIfDeactivateFlowFromNode = async (
  ctx: Context,
  flowId: ComponentId,
  flowNode: Node,
): Promise<Result<McpResponse<WhatIfDeactivateFlowOutput>, McpError>> => {
  // Walk every outgoing edge; each non-structural one is a potential
  // impact.
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  // ONE batched fetch of every non-structural outgoing target, replacing the
  // per-edge `getNodeById` N+1. The per-edge Map lookup preserves edge order
  // (the impacts are re-sorted by compareImpacts below) and the sparse-graph
  // null-skip.
  const outTargetsResult = await listNodesByIds(
    ctx.graph,
    edgesResult.value
      .filter((e) => e.edgeType !== 'parentOf' && e.edgeType !== 'firesWhen')
      .map((e) => e.toId),
  );
  if (!outTargetsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${outTargetsResult.error.message}`,
    });
  }
  const outTargetById = new Map(outTargetsResult.value.map((n) => [n.id, n]));

  const impacts: WhatIfImpactItem[] = [];
  const unresolvedImpacts: WhatIfUnresolvedImpact[] = [];
  const entryPoints: WhatIfEntryPoint[] = [];
  for (const edge of edgesResult.value) {
    // Structural edges: `parentOf` is the Flow's container relationship,
    // `firesWhen` is the gating-condition primitive surfaced separately
    // in `firingConditions`. Neither is a downstream impact.
    if (edge.edgeType === 'parentOf' || edge.edgeType === 'firesWhen') continue;
    const toNode = outTargetById.get(edge.toId);
    // The edge names a component this vault holds no node for: a
    // managed-package action, an EmailTemplate the refresh never retrieved, a
    // packaged subflow. The importer stamps `targetMissing` on such an edge
    // (`edgeTargetMissing` is the shared authority); the Map miss additionally
    // covers a vault built before the marker existed. The EDGE is declared and
    // real, so the row is DIVERTED, never dropped — dropping it is what turned
    // a Flow whose impacts all left the vault into the word `safe`.
    const targetMissing = toNode === undefined || edgeTargetMissing(edge);
    const entryNote = entryPointNoteFor(edge.edgeType);
    if (targetMissing) {
      if (entryNote !== undefined) {
        // An entry point is not a dependent and never moves the verdict, but
        // it is still surfaced: an out-of-vault trigger object must not render
        // as "this Flow has no entry point".
        entryPoints.push({
          kind: edge.edgeType as WhatIfEntryPoint['kind'],
          componentId: edge.toId,
          note: entryNote,
          targetMissing: true,
        });
        continue;
      }
      unresolvedImpacts.push({
        category: classifyOutgoingEdge(edge).category,
        componentId: edge.toId,
        edgeType: edge.edgeType,
        confidence: edge.confidence,
        targetMissing: true,
        explanation: buildUnresolvedOutgoingExplanation(edge, flowNode.apiName),
      });
      continue;
    }
    // The Flow's OWN entry points are recategorised here, not dropped.
    if (entryNote !== undefined) {
      entryPoints.push({
        kind: edge.edgeType as WhatIfEntryPoint['kind'],
        componentId: toNode.id,
        note: entryNote,
        targetMissing: false,
      });
      continue;
    }
    const { category } = classifyOutgoingEdge(edge);
    impacts.push({
      category,
      componentId: toNode.id,
      componentType: toNode.type,
      apiName: toNode.apiName,
      confidence: edge.confidence,
      explanation: buildExplanation(toNode, edge, flowNode.apiName),
    });
  }

  // Second hop (bug 15): if this flow PUBLISHES a platform event (a `writesTo`
  // edge to a `__e` object — a recordCreate on the event), deactivating it
  // stops that event from firing, so every flow / trigger that SUBSCRIBES to
  // the event (an incoming `listensTo` edge) loses its trigger. Those
  // subscribers are not reachable by the single outgoing-edge walk above —
  // they sit one hop past the event object — so surface them explicitly.
  // Entry-point ids are included so the second hop dedupes EXACTLY as it did
  // when `triggersOn` / `listensTo` targets still sat in `impacts`.
  const seenSubscribers = new Set<string>([
    ...impacts.map((i) => i.componentId),
    ...unresolvedImpacts.map((i) => i.componentId),
    ...entryPoints.map((e) => e.componentId),
  ]);
  // Batched second hop. Collect the published-event objects in outer-edge order,
  // fetch ALL their incoming listensTo edges in ONE `listEdgesForNodes`, then
  // resolve the distinct subscriber nodes in ONE `listNodesByIds` — replacing
  // the per-event `listEdges` + per-subscriber `getNodeById` double N+1. The two
  // passes reproduce the old dedup EXACTLY: pass 1 walks events (then each
  // event's listensTo bucket, sorted by the same total order `listEdges`
  // returned) applying the identical `fromId === flowId` / `seenSubscribers`
  // skips, recording the FIRST event that surfaces each subscriber so the
  // per-event `eventApiName` in the explanation is unchanged; pass 2 resolves
  // those ids (a null id is dropped just like the old null-skip) and emits.
  const eventEdges = edgesResult.value.filter(
    (e) =>
      e.edgeType === 'writesTo' &&
      e.toId.startsWith('CustomObject:') &&
      e.toId.endsWith('__e'),
  );
  const listensToBatch = await listEdgesForNodes(
    ctx.graph,
    eventEdges.map((e) => e.toId),
    { direction: 'in', edgeTypes: ['listensTo'] },
  );
  if (!listensToBatch.ok) {
    return err({ kind: 'internal', message: listensToBatch.error.message });
  }
  const pendingSubscribers: { fromId: ComponentId; eventApiName: string }[] = [];
  for (const edge of eventEdges) {
    const eventApiName = edge.toId.slice('CustomObject:'.length);
    for (const sub of listensToBatch.value.get(edge.toId) ?? []) {
      if (sub.fromId === flowId || seenSubscribers.has(sub.fromId)) continue;
      seenSubscribers.add(sub.fromId);
      pendingSubscribers.push({ fromId: sub.fromId, eventApiName });
    }
  }
  const subNodesResult = await listNodesByIds(
    ctx.graph,
    pendingSubscribers.map((p) => p.fromId),
  );
  if (!subNodesResult.ok) {
    return err({ kind: 'internal', message: subNodesResult.error.message });
  }
  const subNodeById = new Map(subNodesResult.value.map((n) => [n.id, n]));
  for (const { fromId, eventApiName } of pendingSubscribers) {
    const subNode = subNodeById.get(fromId);
    if (subNode === undefined) {
      // A subscriber outside this vault (managed-package Flow or trigger on
      // the event). The `listensTo` subscription is declared, so it does lose
      // its trigger — surfaced, never dropped, so `impacts` cannot report a
      // confident zero for a published event that only external code consumes.
      unresolvedImpacts.push({
        category: 'metadata-blocker',
        componentId: fromId,
        edgeType: 'listensTo',
        confidence: 'heuristic',
        targetMissing: true,
        explanation:
          `'${fromId}' subscribes to the platform event ${eventApiName}, ` +
          'which this flow publishes, but that subscriber is NOT a node in ' +
          'this vault (`targetMissing`) — a managed-package component, or one ' +
          'this refresh did not retrieve. Deactivating this flow stops the ' +
          'event, so the subscriber will no longer be triggered by it.',
      });
      continue;
    }
    impacts.push({
      category: 'metadata-blocker',
      componentId: subNode.id,
      componentType: subNode.type,
      apiName: subNode.apiName,
      confidence: 'heuristic',
      explanation:
        `Subscribes to the platform event ${eventApiName}, which this flow ` +
        `publishes. Deactivating this flow stops that event, so this ` +
        `subscriber will no longer be triggered by it.`,
    });
  }

  // R6-02: the INCOMING side. Parent Flows that invoke THIS Flow as a subflow
  // are broken callers on deactivation — the single outgoing-edge walk above is
  // blind to them, which is exactly why a called subflow used to read `safe`.
  const brokenCallersResult = await collectBrokenCallers(
    ctx,
    flowId,
    flowNode.apiName,
  );
  if (!brokenCallersResult.ok) {
    return err({ kind: 'internal', message: brokenCallersResult.error });
  }
  impacts.push(...brokenCallersResult.value.impacts);
  unresolvedImpacts.push(...brokenCallersResult.value.unresolved);

  const sortedImpacts = [...impacts].sort(compareImpacts);
  const sortedUnresolvedImpacts = [...unresolvedImpacts].sort(compareImpacts);
  const sortedEntryPoints = [...entryPoints].sort((a, b) =>
    a.kind !== b.kind
      ? a.kind < b.kind
        ? -1
        : 1
      : a.componentId < b.componentId
        ? -1
        : a.componentId > b.componentId
          ? 1
          : 0,
  );

  const firingConditionsResult = await collectFiringConditions(ctx, flowId);
  if (!firingConditionsResult.ok) {
    return err({ kind: 'internal', message: firingConditionsResult.error });
  }

  // The STRUCTURAL axis is what gets coverage-downgraded: "nothing depends on
  // this" is a coverage-dependent claim. "It is already switched off" is not,
  // so the headline `already-inactive` is never downgraded.
  // The unresolvable rows are graded alongside the resolvable ones: the edge
  // is declared, so the effect stops whether or not the target can be named.
  // Grading only `sortedImpacts` is precisely how "we could not resolve any of
  // them" was answered with the word `safe`.
  const rawVerdict = escalateForActiveCallers(
    aggregateVerdict([...sortedImpacts, ...sortedUnresolvedImpacts]),
    brokenCallersResult.value.hasActiveBrokenCaller,
  );
  const coverage = attachCoverageToWhatIf(
    ctx,
    FLOW_DEACTIVATION_REQUIRED_COVERAGE,
    'Flow deactivation impact',
    rawVerdict,
  );
  const structuralVerdict = coverage.verdict as Verdict;

  const status = readFlowStatus(flowNode);
  // Counts BOTH halves: `notProvenHarmless` claims "no downstream effect is
  // visible in this vault", which is false the moment one unresolvable
  // dependent exists.
  const dependentCount =
    sortedImpacts.filter(isVerdictBearing).length +
    sortedUnresolvedImpacts.filter(isVerdictBearing).length;
  const unresolvedEntryPointCount = sortedEntryPoints.filter(
    (e) => e.targetMissing,
  ).length;
  const unresolvedTargetsNote = buildUnresolvedTargetsNote(
    sortedUnresolvedImpacts.length,
    unresolvedEntryPointCount,
  );
  const runtimeState = resolveRuntimeState(status, dependentCount);
  // `currentlyRunning === null` (status unknown) deliberately does NOT take
  // this branch: an unrecorded status is not evidence the Flow is off.
  const verdict: FlowDeactivateVerdict =
    runtimeState.currentlyRunning === false
      ? 'already-inactive'
      : structuralVerdict;

  // The deactivation tool surfaces a stripped apiName for caller
  // convenience (so the renderer can render "Flow X" rather than
  // "Flow:X"). The node's own `apiName` field already carries this,
  // but we run it through `stripPrefix` as a defensive guard against
  // extractor drift.
  const apiName =
    flowNode.apiName.length > 0 ? flowNode.apiName : stripPrefix(flowId);

  return ok({
    data: {
      appliedScope: { component: flowId, mode: 'component' },
      flowId,
      apiName,
      status,
      firingConditions: firingConditionsResult.value,
      entryPoints: sortedEntryPoints,
      impacts: sortedImpacts,
      unresolvedImpacts: sortedUnresolvedImpacts,
      ...(unresolvedTargetsNote !== undefined ? { unresolvedTargetsNote } : {}),
      runtimeState,
      verdict,
      structuralVerdict,
      ...(dependentCount === 0
        ? { notProvenHarmless: NOT_PROVEN_HARMLESS }
        : {}),
      ...(coverage.coverageCaveat !== undefined
        ? { coverageCaveat: coverage.coverageCaveat }
        : {}),
      trust: coverage.trust,
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * The `sfi.what_if_deactivate_flow` MCP tool. Given a Flow id, label, or
 * partial name, returns the structured downstream impact, the current firing
 * conditions, an aggregated severity verdict, and the verbatim boundary
 * disclosure. See the module JSDoc for the classification rules.
 *
 * When a non-canonical input is passed (e.g. a flow label like "Consent Flow"
 * or a partial api name), the handler attempts an internal fuzzy resolution
 * via `resolveComponents` filtered to Flow type before falling through to
 * `component-not-found`.
 *
 * @example
 *   const r = await whatIfDeactivateFlowHandler(ctx, {
 *     flowId: 'Flow:Account_Notify',
 *   });
 *   if (r.ok) console.log(r.value.data.verdict, r.value.data.impacts.length);
 */
export const whatIfDeactivateFlowHandler = async (
  ctx: Context,
  input: WhatIfDeactivateFlowInput,
): Promise<Result<McpResponse<WhatIfDeactivateFlowOutput>, McpError>> => {
  // Resolve the single RAW flow selector from the interchangeable flowId /
  // componentId / flowApiName / apiName args (never silently stripping one).
  const selectorRes = resolveFlowSelector(input);
  if (!selectorRes.ok) return selectorRes;
  const rawFlow = selectorRes.value;

  const coercedFlowId = coercePrefix(rawFlow, [FLOW_PREFIX]);
  if (!coercedFlowId.startsWith(FLOW_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `flowId must be a Flow id (e.g. '${FLOW_PREFIX}My_Flow'), a bare flow api name, or a flow label; got '${rawFlow}'`,
      path: 'flowId',
    });
  }

  const flowId = coercedFlowId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, flowId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    // Canonical `Flow:ApiName` that misses is a hard not-found — do NOT fuzzy
    // retry on the full id string (would false-positive match unrelated flows).
    if (rawFlow.startsWith(FLOW_PREFIX)) {
      return err({
        kind: 'component-not-found',
        message: `No flow found with id '${flowId}'. Use sfi.list_components with type Flow to see available flows.`,
        path: 'flowId',
      });
    }
    // Bare api name / label / partial name: fuzzy resolve via resolveComponents.
    const fuzzyResult = await resolveComponents(ctx.graph, rawFlow, {
      types: ['Flow'],
      limit: 5,
    });
    if (!fuzzyResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${fuzzyResult.error.message}`,
      });
    }
    const { disposition, candidates } = fuzzyResult.value;
    if (disposition === 'none' || candidates.length === 0) {
      return err({
        kind: 'component-not-found',
        message: `No flow found matching '${rawFlow}'. Use sfi.list_components with type Flow to see available flows.`,
        path: 'flowId',
      });
    }
    if (disposition === 'ambiguous' || candidates.length > 1) {
      const list = candidates
        .map((c) => `  • ${c.id}${c.label ? ` (${c.label})` : ''}`)
        .join('\n');
      return err({
        kind: 'invalid-query',
        message: `Multiple flows match '${rawFlow}'. Specify one of:\n${list}`,
        path: 'flowId',
      });
    }
    // disposition === 'exact' and exactly one candidate — auto-resolve.
    const resolvedId = candidates[0]!.id as ComponentId;
    const resolvedNodeResult = await getNodeById(ctx.graph, resolvedId);
    if (!resolvedNodeResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${resolvedNodeResult.error.message}`,
      });
    }
    if (resolvedNodeResult.value === null) {
      return err({
        kind: 'component-not-found',
        message: await phantomAwareNotFoundMessage(ctx, resolvedId, 'Flow'),
        path: resolvedId,
      });
    }
    const resolvedFlowNode = resolvedNodeResult.value;
    if (resolvedFlowNode.type !== 'Flow') {
      return err({
        kind: 'component-not-found',
        message: `resolved node ${resolvedId} is not a Flow (type=${resolvedFlowNode.type})`,
        path: 'flowId',
      });
    }
    return whatIfDeactivateFlowFromNode(ctx, resolvedId, resolvedFlowNode);
  }

  const flowNode = nodeResult.value;

  // Defensive: the prefix pins the expected type, but the graph
  // round-trip could in principle return a different `type`. Treat
  // that as `component-not-found` since the caller's request cannot
  // be satisfied by what the vault holds.
  if (flowNode.type !== 'Flow') {
    return err({
      kind: 'component-not-found',
      message: `node ${flowId} is not a Flow (type=${flowNode.type})`,
      path: flowId,
    });
  }

  return whatIfDeactivateFlowFromNode(ctx, flowId, flowNode);
};
