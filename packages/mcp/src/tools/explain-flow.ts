/**
 * Handler for the `sfi.explain_flow` MCP tool.
 *
 * v2.0f W1 — the first of three explainer composers (buyer-priority #6:
 * "what does this Flow / Apex method / formula actually do? Explain in
 * English."). Given a Flow canonical id, return a structured narrative
 * payload Claude composes into the natural-language explanation.
 *
 * The tool does NOT compose the prose itself — the caller (an LLM, the
 * separate explainer skill, etc.) reads the structured blocks and
 * decides how to surface them. This keeps the tool deterministic and
 * the renderer-side rephrasing a code-review concern rather than a
 * silent drift between the structured payload and the rendered
 * narrative. The `disclosure` field carries the verbatim signal:
 * "Structured narrative; Claude composes prose".
 *
 * The structured payload covers five axes:
 *
 *   1. **Identity** — apiName, label, status, processType.
 *   2. **Trigger info** — `triggerType` (e.g., `RecordAfterSave`,
 *      `Scheduled`), the `triggerObject` (the `CustomObject:{ApiName}`
 *      the Flow listens to, when one exists), and the gating
 *      `firesWhen` ConditionalContext list (v2.0a's record-trigger /
 *      decision conditions, from the Flow's outgoing `firesWhen`
 *      edges).
 *   3. **Action calls** — the Flow's outgoing `callsApex` edges
 *      (`<actionCalls>` elements with `actionType=apex`).
 *   3b. **Subflow calls** (R6-02) — the Flow's outgoing `references`
 *      edges with `referenceKind: 'subflow'` (`<subflows>` elements).
 *      Each names the target `Flow:{flowName}` and whether it resolves
 *      in the vault (a dangling managed/uncaptured subflow surfaces
 *      `resolved: false`, never fabricated). Previously subflow calls
 *      were unmodeled and thus invisible to this narrative; the only
 *      STILL-invisible path is the Apex `Flow.Interview` invocation (not
 *      a declared `<subflows>` edge), disclosed via the run-mode note.
 *   4. **Record lookups** — the Flow's outgoing `readsFrom` edges
 *      (`<recordLookups>` elements). The targets are
 *      `CustomObject:{ApiName}` ids; we collapse the per-lookup edges
 *      into one row per (object, filterCount) so the narrative renders
 *      "looks up Account (3 filters)" rather than three rows for the
 *      same object.
 *   5. **Record writes** — the Flow's OBJECT-level outgoing `writesTo`
 *      edges (`<recordCreates>` / `<recordUpdates>` / `<recordDeletes>`,
 *      including R7-W1 whole-record `<inputReference>` DML). The
 *      `operation` discriminator on each edge surfaces as the per-row
 *      `'create' | 'update' | 'delete'` action. FIELD-level writes (DML
 *      `<inputAssignments>` and R7-W2 before-save `$Record.<Field>`
 *      assignments) are excluded from this object-granular axis — they are a
 *      `field_lineage` / `field_360` concern.
 *   6. **Decisions** — the v2.0a `properties.conditions[]` mirror,
 *      surfaced as `{ decisionName, conditions }` pairs. The
 *      `decisionName` is the firer's real element name (a Flow decision's
 *      `<name>` + rule `<name>`, from the mirror's `sourceName`), falling
 *      back to the synthetic ConditionalContext apiName
 *      (e.g., `Flow:Account_Notify.condition-2`) when none was captured;
 *      the `conditions` array is the rendered expression text.
 *
 * Cross-reference to `sfi.flow_graph` (spec §9 Q2 — KEEP + cross-ref,
 * decided non-destructively): this tool is deliberately a SUMMARY over
 * six narrative axes (identity, trigger info, action/subflow calls,
 * record lookups/writes, decisions) — it does NOT enumerate every
 * element or the element-to-element connector graph. `sfi.flow_graph`
 * is the lossless structural projection (every element by its real
 * name, the full connector graph from→to→kind, loop next-value/no-
 * more-values edges, formula expressions, variable declarations). The
 * `seeAlso` field on the output makes this explicit so a caller asking
 * "what's the full structure" / "what are the branches" / "show me the
 * connectors" is routed to `flow_graph` instead of over-trusting this
 * narrative as exhaustive.
 *
 * Implementation notes:
 *   - One `getNodeById(flowId)` resolves the Flow. `Flow:` prefix is
 *     enforced at the handler boundary; non-`Flow:` ids surface as
 *     `invalid-query`, unknown well-formed ids surface as
 *     `component-not-found`. This mirrors the v2.0a/v2.0b prefix-axis
 *     convention every other component-id-parameterised tool uses.
 *   - Five `listEdges` calls fan out the trigger, action, lookup,
 *     write, and condition axes. Each call narrows by `direction:
 *     'out'` and `edgeType:` so the per-axis filtering happens at the
 *     query layer rather than in memory.
 *   - The Flow's `properties.conditions` mirror (the v2.0a synthetic
 *     ConditionalContext metadata stamped onto the Flow node) is the
 *     source of truth for the `decisions` axis. The mirror entries
 *     carry `kind`, `expression`, `conditionContextId`, and (for Flow
 *     decisions) `sourceName`; we surface `expression` directly and use
 *     `sourceName` as the decisionName — falling back to the synthetic
 *     apiName — so callers see the real decision name yet can still
 *     cross-reference back to the ConditionalContext nodes via the id.
 *   - Sparse-graph misses (an outgoing edge whose target was dropped
 *     between extractions) are silently skipped — matches every other
 *     composition tool's tolerance pattern. Missing edges do NOT
 *     surface as warnings; the renderer simply sees fewer rows.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByIds } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { annotationsBlockFor, type AnnotationsBlock } from './annotations.js';
import { coercePrefix } from './coerce-id.js';

/** Canonical id prefix for the Flow node type. */
const FLOW_PREFIX = 'Flow:';

/**
 * The verbatim honesty-axis disclosure surfaced in every response.
 * Frozen here so the test suite can assert the exact string and a
 * caller-facing rephrasing during rendering is a code-review concern,
 * not a silent drift. The shape is identical to the v2.0e narrator's
 * disclosure axis (a single load-bearing sentence) but with the
 * v2.0f explainer-tier wording.
 */
const DISCLOSURE = 'Structured narrative; Claude composes prose';

/**
 * Cross-reference note (spec §9 Q2) surfaced verbatim on every response.
 * Points structure/connector questions at `sfi.flow_graph` — this tool's
 * six narrative axes are a SUMMARY, not the complete element/connector
 * graph, and this note says so explicitly rather than leaving a caller to
 * assume the narrative is exhaustive. Frozen here for the same reason as
 * {@link DISCLOSURE}: a caller-facing rephrasing is a code-review concern,
 * not a silent drift between what the tool claims and what it returns.
 */
const SEE_ALSO_FLOW_GRAPH =
  'This is a SUMMARY narrative (trigger info, action/subflow calls, record lookups/writes, decisions) — it does NOT enumerate every element or the element-to-element connector graph. For the full structure (every element by real name, the complete from→to→kind connector graph, decision rule branches, loops, formulas, and variables), call sfi.flow_graph(flowRef) instead.';

/**
 * Zod schema for the `sfi.explain_flow` tool input.
 *
 *   - `flowId`: required, non-empty string. The canonical Flow id
 *     (`Flow:{ApiName}`). Non-`Flow:` prefixes surface as
 *     `invalid-query` from the handler; unknown but well-formed ids
 *     surface as `component-not-found`.
 */
export const explainFlowInputSchema = z.object({
  flowId: z.string().min(1),
});

/** Parsed input shape, inferred from `explainFlowInputSchema`. */
export type ExplainFlowInput = z.infer<typeof explainFlowInputSchema>;

/**
 * One condition gating the Flow. Mirrors the v2.0a synthetic
 * `ConditionalContext` axis: each entry carries the synthetic
 * conditionContextId so callers can cross-reference back to the
 * gating node, and the parsed expression text so the renderer can
 * inline the predicate without an extra graph traversal.
 */
export interface ExplainFlowTriggerCondition {
  readonly conditionContextId: ComponentId;
  readonly expression: string;
  /**
   * The fields this firing condition evaluates, surfaced verbatim from the
   * ConditionalContext node's `fieldRefs` (e.g.
   * `CustomField:Account.Industry__c`, or raw flow-context paths like
   * `CustomField:$Record.StageName`). Without them a real record-trigger /
   * decision row is just the bare connector (`"and"`), which says nothing
   * about WHAT gates the flow. The sibling tools `order_of_execution` and
   * `what_happens_on_save` read this same node property; this keeps the
   * trigger axis consistent with them and with the v2.0f decision axis
   * (`ExplainFlowDecision.fieldReferences`).
   */
  readonly fieldReferences: readonly ComponentId[];
}

/**
 * The Flow's start-info block. `triggerType` mirrors the Flow node's
 * `properties.triggerType` (e.g., `RecordAfterSave`, `Scheduled`,
 * `PlatformEvent`); `triggerObject` is the resolved
 * `CustomObject:{ApiName}` id from the Flow's outgoing `triggersOn`
 * edge (when one exists). `conditions` is the list of every
 * `firesWhen` ConditionalContext the Flow points at — the gating
 * conditions for the trigger phase.
 */
export interface ExplainFlowTriggerInfo {
  readonly triggerType: string;
  readonly triggerObject: ComponentId | null;
  readonly conditions: readonly ExplainFlowTriggerCondition[];
}

/**
 * One action call the Flow makes.
 *
 * For apex-typed calls (`actionType: 'apex'`): `targetId` is the
 * `ApexClass:{ApiName}` canonical id the `<actionCalls>` element references;
 * `targetType` is `'ApexClass'` (resolved from the graph node when it exists).
 *
 * For non-apex action types (`actionType: 'activateSessionPermSet'`,
 * `'emailAlert'`, `'emailSimple'`, `'flow'`, etc.): `targetId` is the bare
 * `actionName` from the XML (no graph node exists for them — emitting a
 * `callsApex` edge to an ApexClass would be a lie); `targetType` is the
 * `actionType` string. The `actionType` field is ALWAYS present so consumers
 * can branch on it:
 *   - `'apex'` → the Apex class `targetId` references exists in the graph.
 *   - `'activateSessionPermSet'` → a TRANSIENT session-permission activation,
 *     no PermissionSetAssignment row is inserted, so an "orphaned grant"
 *     scenario is structurally impossible.
 *   - other values → platform-managed action (email, flow call, etc.).
 */
export interface ExplainFlowActionCall {
  readonly targetId: ComponentId | string;
  readonly targetType: string;
  /**
   * The raw `<actionType>` value from the flow XML (e.g. `'apex'`,
   * `'activateSessionPermSet'`, `'emailAlert'`). Always present so the consumer
   * can identify non-apex action types even when no graph edge exists.
   */
  readonly actionType: string;
}

/**
 * One subflow this Flow invokes (R6-02). Sourced from the Flow's outgoing
 * `references` edges whose `properties.referenceKind === 'subflow'` — the
 * declared `<subflows>` calls. `targetFlowId` is the `Flow:{ApiName}` canonical
 * id; `targetFlowName` is the bare ApiName; `subflowElementName` is the calling
 * `<subflows><name>` (may be `null`). `resolved` is `true` when the target Flow
 * node exists in the vault and `false` when it is dangling-by-design (a
 * managed-package or otherwise uncaptured subflow) — surfaced honestly rather
 * than fabricated, so the renderer can say "calls an uncaptured subflow".
 */
export interface ExplainFlowSubflowCall {
  readonly targetFlowId: ComponentId;
  readonly targetFlowName: string;
  readonly subflowElementName: string | null;
  readonly resolved: boolean;
}

/**
 * One record lookup. `object` is the bare `CustomObject` ApiName
 * (without the `CustomObject:` prefix) the lookup targets;
 * `filterCount` is the number of distinct lookups the Flow emits
 * against this object (collapsed across multiple
 * `<recordLookups>` blocks against the same object).
 */
export interface ExplainFlowRecordLookup {
  readonly object: string;
  readonly filterCount: number;
}

/**
 * One OBJECT-level record write. `object` is the bare CustomObject ApiName the
 * write targets; `operation` is the kind of DML the Flow performs
 * (`'create'` for `<recordCreates>`, `'update'` for `<recordUpdates>`,
 * `'delete'` for `<recordDeletes>`). A whole-record `<inputReference>` DML
 * (R7-W1) surfaces here as its object row (the fields are not enumerable;
 * that limitation lives on the underlying edge's `disclosure` property).
 *
 * This axis is object-granular: FIELD-level writes (DML `<inputAssignments>`
 * and the R7-W2 before-save `$Record.<Field>` assignment) are NOT listed here —
 * see {@link collectRecordWrites}. Query `field_lineage` / `field_360` for the
 * per-field writer detail.
 */
export interface ExplainFlowRecordWrite {
  readonly object: string;
  readonly operation: 'create' | 'update' | 'delete';
}

/**
 * One decision in the Flow body. The `decisionName` is the firer's REAL
 * element name when the extractor captured one — for a Flow decision, the
 * `<decisions><name>` + matched `<rules><name>` (e.g.
 * `My_Decision (My_Outcome)`), surfaced verbatim from the mirror
 * entry's `sourceName`. It falls back to the synthetic ConditionalContext
 * apiName (e.g., `Flow:Account_Notify.condition-2`) only when no name was
 * captured (an older vault, or a nameless firer surface). `conditions`
 * carries the rendered expression text from the mirror entry.
 * Multi-condition decisions surface every expression in the array.
 * `fieldReferences` carries the fields the decision actually evaluates —
 * without them the row would say nothing about WHAT the flow branches on.
 */
export interface ExplainFlowDecision {
  readonly decisionName: string;
  readonly conditions: readonly string[];
  /**
   * Raw flow-context field paths the decision evaluates (e.g.
   * `CustomField:$Record.StageName`, `CustomField:$Record__Prior.StageName`),
   * surfaced verbatim from the mirror entry's `fieldRefs`. `$Record` is the
   * triggering record; `$Record__Prior` is its pre-update snapshot.
   */
  readonly fieldReferences: readonly string[];
}

/**
 * The Flow's runtime execution context — the load-bearing facts a caller needs
 * to answer "what user / sharing context does this Flow run in, and what
 * happens when a step faults". Surfaced so the host composes the answer from
 * the DECLARED metadata instead of fabricating platform-semantics inferences
 * (the two common fabrications: "a subflow inherits the calling flow's
 * context", and "$User in a triggered flow resolves to the integration/system
 * user" — both wrong; see `runModeNote`).
 */
export interface ExplainFlowExecutionContext {
  /**
   * The Flow's declared `<runInMode>` verbatim (e.g.
   * `SystemModeWithoutSharing`, `SystemModeWithSharing`, `DefaultMode`), or
   * `null` when the metadata omits it. `DefaultMode` (and a missing value for
   * most flow types) means the Flow runs in the running USER's context and
   * enforces that user's CRUD/FLS/sharing; the System modes run with full
   * access and bypass FLS/CRUD (sharing depends on the With/Without variant).
   */
  readonly runInMode: string | null;
  /**
   * True when one or more DML/lookup-capable elements have no
   * `<faultConnector>` (an unhandled fault path). An unhandled fault in an
   * autolaunched/record-triggered flow running synchronously inside the
   * triggering transaction rolls back the ENTIRE transaction (including the
   * triggering record's save), not just the flow.
   */
  readonly hasUnhandledFaults: boolean;
  /** Count of fault-capable elements with no fault connector (0 when all handled). */
  readonly unhandledFaultElementCount: number;
  /**
   * Verbatim platform-semantics note correcting the two common fabrications.
   * Always present so the host never substitutes a wrong inference.
   */
  readonly runModeNote: string;
  /**
   * A DETERMINATE, structured answer to "if this flow faults at an unhandled
   * element, does that roll back the triggering transaction?" — composed from
   * `hasUnhandledFaults` and the trigger type, so the host never has to (and
   * never gets to) DECLINE this question as "not captured". `null` only when
   * the flow has no unhandled fault path (`hasUnhandledFaults: false`).
   */
  readonly faultRollback: FaultRollbackVerdict | null;
  /**
   * Present only when `runInMode` is `SystemModeWithoutSharing`. Surfaces the
   * security implication that this mode bypasses the ENTIRE Salesforce sharing
   * stack — including Restriction Rules — so the flow can read and write records
   * that Restriction Rules would otherwise hide from the running user (or any
   * user). Absent for `SystemModeWithSharing` and `DefaultMode` because those
   * modes respect the sharing stack.
   *
   * This is a load-bearing security fact: an LLM host must not suppress or
   * soften it when it is present.
   */
  readonly sharingBypassNote?: string;
}

/**
 * Whether an unhandled fault in THIS flow rolls back the originating
 * transaction, with the rationale.
 *
 * `rollsBackTransaction: true` for any flow whose unhandled-fault element runs
 * synchronously inside the originating transaction:
 *   - record-triggered before/after-save and autolaunched/scheduled/platform-
 *     event flows that fault in the SAME transaction as the triggering save;
 *   - a user-driven screen flow — the fault rolls back all DML performed since
 *     the last screen navigation (the current screen-segment transaction) and
 *     shows the running user a flow error screen.
 *
 * `rollsBackTransaction: false` for an unhandled fault in a POST-COMMIT ASYNC
 * path (an `AsyncAfterCommit` scheduled path on a record-triggered flow): that
 * interview runs in a SEPARATE asynchronous transaction after the triggering
 * save has already committed, so it cannot roll the committed save back. The
 * fault is not user-visible — it silently aborts the async interview (discarding
 * its intended work, e.g. a task or email) and emails only the admin / Apex-
 * exception recipient.
 */
export interface FaultRollbackVerdict {
  readonly rollsBackTransaction: boolean;
  readonly statement: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ExplainFlowOutput {
  readonly flowId: ComponentId;
  readonly apiName: string;
  readonly label: string;
  readonly status: string;
  readonly processType: string;
  readonly executionContext: ExplainFlowExecutionContext;
  readonly triggerInfo: ExplainFlowTriggerInfo;
  readonly actionCalls: readonly ExplainFlowActionCall[];
  /**
   * R6-02: the subflows this Flow invokes (declared `<subflows>` calls). Empty
   * when the Flow calls no subflows. A dangling target (`resolved: false`) is a
   * managed/uncaptured subflow — named, never fabricated.
   */
  readonly subflowCalls: readonly ExplainFlowSubflowCall[];
  readonly recordLookups: readonly ExplainFlowRecordLookup[];
  readonly recordWrites: readonly ExplainFlowRecordWrite[];
  readonly decisions: readonly ExplainFlowDecision[];
  readonly disclosure: string;
  /**
   * P4-flow-conditions runtime-evaluation flag. The trigger and decision
   * `conditions` are the STATICALLY-DECLARED criteria from the Flow metadata —
   * NOT a runtime trace. Whether a given path actually executes is
   * data-dependent at runtime and is not evaluated here. Always present so a
   * host never reads a declared condition as "this path runs".
   */
  readonly conditionsRuntimeNote: string;
  /**
   * Cross-reference to `sfi.flow_graph` (spec §9 Q2). Always present, verbatim
   * — see {@link SEE_ALSO_FLOW_GRAPH}. States plainly that this narrative is a
   * SUMMARY over six axes, not the complete element/connector graph, and names
   * the tool that returns the lossless structural projection.
   */
  readonly seeAlso: string;
  /** P13-ANNOT-tools: curated annotations (provenance `annotation`); absent when none. */
  readonly annotations?: AnnotationsBlock;
}

/** Verbatim P4-flow-conditions runtime-evaluation heuristic flag. */
const CONDITIONS_RUNTIME_NOTE =
  'Decision and trigger conditions are the statically-declared criteria from the Flow metadata (heuristic) — NOT a runtime trace. Whether a given path executes is data-dependent at runtime and is not evaluated here; treat the conditions as the declared rules, not proof a branch runs.';

/**
 * Verbatim platform-semantics note for the execution-context block. Corrects
 * the two recurring run-mode fabrications and states the load-bearing rules:
 *   - A CALLED SUBFLOW runs in its OWN declared `runInMode`, independent of the
 *     calling flow's context — it does NOT inherit the parent's user context.
 *   - A record-triggered flow runs as the user whose DML triggered the save;
 *     `$User` (and `$User.Id` in validation rules/formulas) resolves to that
 *     RUNNING user, never automatically the integration/system user.
 *   - `DefaultMode` (and the default for screen flows) enforces the running
 *     user's CRUD/FLS/sharing; license type does not define a separate FLS.
 *   - An unhandled fault in a synchronous autolaunched/record-triggered flow
 *     rolls back the WHOLE triggering transaction, not just the flow.
 */
const RUN_MODE_NOTE =
  'Run-mode semantics (Salesforce platform rules, not a runtime trace): a CALLED SUBFLOW executes in its OWN declared runInMode, independent of the calling flow — it does NOT inherit the parent flow\'s user context. A record-triggered flow runs as the user whose DML triggered the save; $User (incl. $User.Id referenced by validation rules/formulas) resolves to that RUNNING user, never automatically the integration or system user. DefaultMode (and screen-flow default) runs in the running user\'s context and enforces that user\'s CRUD/FLS/sharing — there is no separate license-type FLS. SystemModeWithoutSharing/WithSharing run with full field access (bypassing FLS/CRUD); sharing depends on the With/Without variant. An unhandled fault (hasUnhandledFaults) in a synchronous autolaunched/record-triggered flow rolls back the ENTIRE triggering transaction, including the record save, not just the flow. A Draft/inactive flow cannot be invoked as a subflow by an active parent at runtime until activated.';

/**
 * Read the Flow's declared `runInMode` property. Returns `null` when the
 * metadata omits it (the extractor stamps `null` for flows without a
 * `<runInMode>` element).
 */
const readRunInMode = (node: Node): string | null => {
  const raw = node.properties['runInMode'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/** Read a non-negative integer flow property, defaulting to 0. */
const readFlowNonNegInt = (node: Node, key: string): number => {
  const raw = node.properties[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : 0;
};

/**
 * Build the execution-context block from the Flow node's extracted
 * `runInMode` / fault-coverage properties (see flow.ts extractor).
 *
 * When the node's in-graph properties do not carry the async-path markers
 * (vault built before bundle-4), this function falls back to scanning the
 * source `.flow-meta.xml` file via {@link readAsyncAfterCommitFromSource}.
 * The `vaultRoot` is only accessed on that fallback path; no I/O is done when
 * the in-graph properties are present and sufficient.
 */
const buildExecutionContext = async (
  node: Node,
  vaultRoot: string,
): Promise<ExplainFlowExecutionContext> => {
  const hasUnhandledFaults = node.properties['hasUnhandledFaults'] === true;
  let faultRollback: FaultRollbackVerdict | null = null;
  if (hasUnhandledFaults) {
    // Check in-graph properties first (fast, no I/O).
    const asyncFromGraph = hasAsyncAfterCommitPath(node);
    // Source-file fallback for vaults built before bundle-4 that lack the
    // scheduledPathTypes / runAsyncAfterCommit properties.
    const isAsync =
      asyncFromGraph ||
      (!asyncFromGraph &&
        (await readAsyncAfterCommitFromSource(vaultRoot, node)));
    faultRollback = buildFaultRollback(node, isAsync);
  }
  const runInMode = readRunInMode(node);
  return {
    runInMode,
    hasUnhandledFaults,
    unhandledFaultElementCount: readFlowNonNegInt(node, 'elementsWithoutFault'),
    runModeNote: RUN_MODE_NOTE,
    faultRollback,
    ...(runInMode === 'SystemModeWithoutSharing' && {
      sharingBypassNote:
        'SECURITY: This flow runs in SystemModeWithoutSharing, which bypasses the ENTIRE Salesforce sharing stack — including OWD, sharing rules, manual shares, AND Restriction Rules. It can read and write records that Restriction Rules would hide from any user. Review all DML/SOQL elements for unintended data exposure.',
    }),
  };
};

/**
 * Detect whether the flow has an `AsyncAfterCommit` scheduled path — a
 * record-triggered flow path that runs in a SEPARATE asynchronous transaction
 * AFTER the triggering save has committed. An unhandled fault on such a path
 * cannot roll back the already-committed save.
 *
 * Three property shapes are accepted (the extractor surfaces one or more):
 *
 *   1. `runAsyncAfterCommit: true` — the convenience boolean stamped by the
 *      extractor when at least one `<scheduledPaths><pathType>` is
 *      `AsyncAfterCommit` (bundle-4 / extractor v2).
 *   2. `scheduledPathTypes: string[]` — the canonical extractor array (e.g.
 *      `['AsyncAfterCommit']`). Checked before the legacy `scheduledPaths`
 *      shape so that vaults built with the current extractor fast-path here.
 *   3. `scheduledPaths` array — object-per-path shape used by older vault
 *      builds or test fixtures (`[{ pathType: 'AsyncAfterCommit' }]`); also
 *      accepts bare string entries.
 *   4. Scalar `pathType` directly on the node (uncommon, kept for compat).
 *
 * When none of the above properties are present (vault built before bundle-4),
 * the caller should supply the absolute source-file path so that this function
 * can fall back to a raw XML substring scan — see {@link readAsyncAfterCommitFromSource}.
 *
 * The `pathType` marker Salesforce uses for the immediate post-commit async
 * path is `AsyncAfterCommit`.
 */
const ASYNC_AFTER_COMMIT = 'AsyncAfterCommit';

const hasAsyncAfterCommitPath = (node: Node): boolean => {
  if (node.properties['runAsyncAfterCommit'] === true) return true;
  const scalar = node.properties['pathType'];
  if (typeof scalar === 'string' && scalar === ASYNC_AFTER_COMMIT) return true;
  // scheduledPathTypes: string[] — the canonical extractor property (bundle-4).
  const pathTypes = node.properties['scheduledPathTypes'];
  if (Array.isArray(pathTypes)) {
    for (const pt of pathTypes) {
      if (typeof pt === 'string' && pt === ASYNC_AFTER_COMMIT) return true;
    }
  }
  // scheduledPaths: object-per-path or string array — older vault builds / test fixtures.
  const paths = node.properties['scheduledPaths'];
  if (Array.isArray(paths)) {
    for (const entry of paths) {
      if (typeof entry === 'string' && entry === ASYNC_AFTER_COMMIT) return true;
      if (typeof entry === 'object' && entry !== null) {
        const pt = (entry as Record<string, unknown>)['pathType'];
        if (typeof pt === 'string' && pt === ASYNC_AFTER_COMMIT) return true;
      }
    }
  }
  return false;
};

/**
 * Source-file XML fallback for detecting `AsyncAfterCommit` scheduled paths
 * when the vault was built with an older extractor that did not stamp
 * `scheduledPathTypes` / `runAsyncAfterCommit` onto the node. Reads the raw
 * `.flow-meta.xml` file and performs a fast substring search for the
 * `<pathType>AsyncAfterCommit</pathType>` element that Salesforce emits in
 * `<start><scheduledPaths>` for the immediate post-commit async path.
 *
 * This is a READ-ONLY, fire-and-forget fallback: any I/O failure silently
 * returns `false` (safe: the caller will then fall through to the synchronous
 * verdict, which errs on the cautious side for rollback analysis). The check
 * does not re-parse the XML; the substring `AsyncAfterCommit` is unique enough
 * in a flow file that a raw text scan is both fast and unambiguous.
 *
 * Call ONLY after {@link hasAsyncAfterCommitPath} returns `false` — i.e. when
 * all in-graph property checks have already failed. The `sourcePath` on the
 * node is vault-root-relative (e.g.
 * `source/main/default/flows/My_Flow.flow-meta.xml`); `vaultRoot` is the
 * absolute path to the `org-kb/` directory so the two can be joined.
 */
const readAsyncAfterCommitFromSource = async (
  vaultRoot: string,
  node: Node,
): Promise<boolean> => {
  if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) {
    return false;
  }
  try {
    const absPath = join(vaultRoot, node.sourcePath);
    const xml = await readFile(absPath, 'utf-8');
    return xml.includes(`<pathType>${ASYNC_AFTER_COMMIT}</pathType>`);
  } catch {
    // I/O error (file missing, permission, etc.) — safe to ignore.
    return false;
  }
};

/**
 * Compose the determinate fault-rollback verdict from the flow's trigger type
 * and execution timing.
 *
 *   - A POST-COMMIT ASYNC path (`AsyncAfterCommit` scheduled path on a
 *     record-triggered flow) runs in its OWN async transaction after the
 *     triggering save has committed → it CANNOT roll the committed save back
 *     (`rollsBackTransaction: false`); the fault silently aborts the async
 *     interview and emails only the admin / Apex-exception recipient.
 *   - A screen flow's unhandled fault rolls back the DML performed in the
 *     CURRENT screen segment (since the last screen navigation) and shows the
 *     user a flow error screen (`rollsBackTransaction: true`).
 *   - Record-triggered (before/after-save) and autolaunched/scheduled/platform-
 *     event flows that fault synchronously inside the triggering transaction
 *     roll the WHOLE transaction back (the triggering DML fails too).
 *
 * @param isAsync - Whether this flow has an AsyncAfterCommit scheduled path.
 *   Pre-computed by the caller (combining in-graph property checks and the
 *   source-file XML fallback) so this function stays pure and synchronous.
 */
const buildFaultRollback = (node: Node, isAsync: boolean): FaultRollbackVerdict => {
  const triggerType =
    typeof node.properties['triggerType'] === 'string'
      ? (node.properties['triggerType'] as string)
      : null;
  const processType =
    typeof node.properties['processType'] === 'string'
      ? (node.properties['processType'] as string)
      : null;
  // Post-commit async path: a separate async transaction that runs AFTER the
  // triggering save committed. An unhandled fault here cannot undo the commit —
  // it silently aborts the async interview and notifies only the admin.
  if (isAsync) {
    return {
      rollsBackTransaction: false,
      statement:
        'This flow has an asynchronous post-commit path (an AsyncAfterCommit scheduled path) with an unhandled fault. ' +
        'That path runs in a SEPARATE asynchronous transaction AFTER the triggering record save has already committed, so an unhandled fault there does NOT roll back the committed save — the save stands. ' +
        'The fault is not user-visible: it silently aborts the async interview (discarding the work it intended to do, e.g. an intended task or email) and emails only the admin / Apex-exception recipient. ' +
        '(Contrast with a synchronous predecessor running in the same transaction, which WOULD roll the triggering save back.)',
    };
  }
  // Screen flow: user-driven interview. An unhandled fault still rolls back the
  // DML performed since the last screen navigation (the current screen segment),
  // and shows the running user a flow error screen.
  const isScreenFlow =
    processType === 'Flow' &&
    (triggerType === null || triggerType === 'None');
  if (isScreenFlow) {
    return {
      rollsBackTransaction: true,
      statement:
        'This is a screen (user-driven) flow with an unhandled fault path. ' +
        'An unhandled fault rolls back ALL DML performed since the last screen navigation — the current screen-segment transaction (e.g. a ContentDocumentLink insert and a record update done on the same screen roll back together) — and shows the running user a flow error screen. ' +
        'Work committed by earlier screens (before the last navigation) is already saved and is not affected. ' +
        'A screen flow runs in DefaultMode (the running user\'s context) when runInMode is null, so permission gaps surface as faults at the DML/query steps, not at in-memory decision elements.',
    };
  }
  // Scheduled (autolaunched-on-a-schedule) flow: there is no triggering user
  // DML transaction. An unhandled fault aborts that scheduled run's transaction
  // (rolling back the DML it performed in that run) and emails the admin /
  // last-modifier; it is not user-visible and the flow simply runs again on its
  // next scheduled interval. Keep rollsBackTransaction=true (the run's own DML
  // is rolled back) but DON'T claim a triggering-record save failed — there is
  // none on a schedule-launched run.
  if (triggerType === 'Scheduled') {
    return {
      rollsBackTransaction: true,
      statement:
        'This is a scheduled (autolaunched) flow with an unhandled fault path (no fault connector). ' +
        'A scheduled run is not launched by a user DML transaction, so there is no triggering record save to fail. ' +
        'An unhandled fault rolls back the DML that run performed and aborts the run; it does NOT surface to an end user — the platform emails the flow error to the admin / last modifier, and the flow runs again on its next scheduled interval.',
    };
  }
  const phase =
    triggerType === 'RecordAfterSave'
      ? 'after-save record-triggered'
      : triggerType === 'RecordBeforeSave'
        ? 'before-save record-triggered'
        : triggerType !== null && triggerType.startsWith('Record')
          ? 'record-triggered'
          : 'autolaunched/scheduled';
  return {
    rollsBackTransaction: true,
    statement:
      `This is a synchronous ${phase} flow with an unhandled fault path (no fault connector). ` +
      'If it faults at an unhandled element, the platform raises a surfaced unhandled-fault runtime error that rolls back the ENTIRE originating transaction — the triggering record save fails too, not just the flow; any records the flow created in the same transaction are never committed.',
  };
};

/**
 * Pull the Flow's `label` property. The extractor stamps the label
 * into both `properties.label` and the node's top-level `label`
 * field; the former is the canonical source of truth (the node-level
 * value is sometimes null for ApiName-only flows). Falls back to the
 * apiName so the renderer always has a human-readable handle.
 */
const readFlowLabel = (node: Node): string => {
  const raw = node.properties['label'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (node.label !== null && node.label.length > 0) return node.label;
  return node.apiName;
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
 * Pull the Flow's `processType` property (e.g., `AutoLaunchedFlow`,
 * `Flow`, `RecordTriggered`). Empty-string fallback for malformed
 * inputs.
 */
const readFlowProcessType = (node: Node): string => {
  const raw = node.properties['processType'];
  return typeof raw === 'string' ? raw : '';
};

/**
 * Pull the Flow's `triggerType` property (e.g., `RecordAfterSave`,
 * `PlatformEvent`, `Scheduled`). Returns the empty string when the
 * Flow has no start-trigger (a standard non-triggered Flow has
 * `triggerType: null` in its properties).
 */
const readFlowTriggerType = (node: Node): string => {
  const raw = node.properties['triggerType'];
  return typeof raw === 'string' ? raw : '';
};

/**
 * Find the Flow's `triggersOn` target — the `CustomObject:{ApiName}`
 * the Flow listens to. Returns `null` for Flows without a record
 * context (a standard non-triggered Flow). Sparse-graph misses
 * (the edge exists but the target was dropped) surface as null too.
 */
const findTriggerObject = async (
  ctx: Context,
  flowId: ComponentId,
): Promise<Result<ComponentId | null, string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'triggersOn',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const firstEdge = edgesResult.value[0];
  if (firstEdge === undefined) return ok(null);
  return ok(firstEdge.toId);
};

/**
 * Surface every `firesWhen` ConditionalContext the Flow points at.
 * Each entry carries the synthetic conditionContextId, the parsed
 * expression text, and the `fieldRefs` the condition evaluates — the
 * scalar fast-path that lets the renderer inline the predicate (and the
 * fields it gates on) without an extra graph traversal.
 *
 * Sparse-graph misses (an edge whose target ConditionalContext was
 * dropped) are silently skipped.
 */
const collectTriggerConditions = async (
  ctx: Context,
  flowId: ComponentId,
): Promise<Result<readonly ExplainFlowTriggerCondition[], string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'firesWhen',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  // ONE batched fetch of every firesWhen target, replacing the per-edge
  // `getNodeById` N+1. The per-edge Map lookup preserves edge order (this
  // output is NOT re-sorted) and the null-skip.
  const nodesResult = await listNodesByIds(
    ctx.graph,
    edgesResult.value.map((e) => e.toId),
  );
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const byId = new Map(nodesResult.value.map((n) => [n.id, n]));
  const out: ExplainFlowTriggerCondition[] = [];
  for (const edge of edgesResult.value) {
    const conditionNode = byId.get(edge.toId);
    if (conditionNode === undefined) continue;
    const expressionRaw = conditionNode.properties['expression'];
    // Surface the fields the condition evaluates (the ConditionalContext
    // node's `fieldRefs`) — without them a record-trigger / decision row is
    // just the bare connector ("and"). The sibling tools order_of_execution
    // and what_happens_on_save read this same node property.
    const rawFieldRefs = conditionNode.properties['fieldRefs'];
    const fieldReferences: readonly ComponentId[] = Array.isArray(rawFieldRefs)
      ? rawFieldRefs.filter((v): v is ComponentId => typeof v === 'string')
      : [];
    out.push({
      conditionContextId: conditionNode.id,
      expression: typeof expressionRaw === 'string' ? expressionRaw : '',
      fieldReferences,
    });
  }
  return ok(out);
};

/**
 * Strip the `CustomObject:` prefix from a canonical id to surface the
 * bare ApiName the renderer wants. Non-`CustomObject:` ids pass
 * through verbatim (the renderer can decide what to do with them);
 * the empty string is returned for malformed inputs so the response
 * shape stays stable.
 */
const stripObjectPrefix = (id: ComponentId): string => {
  const colonIdx = id.indexOf(':');
  if (colonIdx < 0) return id;
  return id.slice(colonIdx + 1);
};

/**
 * A single action-call summary as written to `properties.actionCalls` by the
 * extractor (bundle-4a). A nullable-string pair matching the extractor's
 * `FlowActionCallSummary` interface without importing that package.
 */
interface ActionCallSummary {
  readonly actionType: string | null;
  readonly actionName: string | null;
}

/**
 * Read the `properties.actionCalls` summary list from a Flow node (stamped by
 * the extractor's `collectActionCallSummaries` call). Returns an empty array
 * when the property is absent (vault built before bundle-4a).
 */
const readActionCallSummariesFromNode = (node: Node): ActionCallSummary[] => {
  const raw = node.properties['actionCalls'];
  if (!Array.isArray(raw)) return [];
  const out: ActionCallSummary[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const actionType =
      typeof obj['actionType'] === 'string' ? obj['actionType'] : null;
    const actionName =
      typeof obj['actionName'] === 'string' ? obj['actionName'] : null;
    out.push({ actionType, actionName });
  }
  return out;
};

/**
 * Source-file XML fallback for collecting `<actionCalls>` summaries when
 * the vault was built with an older extractor that did not stamp
 * `properties.actionCalls`. Reads the raw `.flow-meta.xml` file and extracts
 * all `<actionType>` / `<actionName>` pairs via a lightweight regex scan (no
 * re-parse of the full XML — fast and sufficient for action-call identification).
 *
 * Any I/O failure silently returns an empty array (safe: the caller falls back
 * to a `callsApex`-edge-only answer, which is already the pre-fix behaviour).
 *
 * Call ONLY after `readActionCallSummariesFromNode` returns `[]` — i.e. when
 * `properties.actionCalls` is absent from the in-graph node.
 */
const readActionCallSummariesFromSource = async (
  vaultRoot: string,
  node: Node,
): Promise<ActionCallSummary[]> => {
  if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) {
    return [];
  }
  try {
    const absPath = join(vaultRoot, node.sourcePath);
    const xml = await readFile(absPath, 'utf-8');
    // Split on <actionCalls> blocks and extract actionType + actionName per block.
    const out: ActionCallSummary[] = [];
    // Each <actionCalls>…</actionCalls> block is a single action call element.
    const blockPattern = /<actionCalls>([\s\S]*?)<\/actionCalls>/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = blockPattern.exec(xml)) !== null) {
      const block = blockMatch[1] ?? '';
      const typeMatch = /<actionType>([^<]*)<\/actionType>/.exec(block);
      const nameMatch = /<actionName>([^<]*)<\/actionName>/.exec(block);
      out.push({
        actionType: typeMatch?.[1]?.trim() ?? null,
        actionName: nameMatch?.[1]?.trim() ?? null,
      });
    }
    return out;
  } catch {
    // I/O error or parse failure — safe to ignore, return empty.
    return [];
  }
};

/**
 * Collect the Flow's outgoing `callsApex` edges and project each into an
 * `ExplainFlowActionCall` row. The `targetType` is resolved from the target
 * node when it exists; sparse-graph misses default to the target id's prefix
 * (e.g., `ApexClass:Foo` → `'ApexClass'`).
 *
 * ALSO surfaces non-apex action types (e.g. `activateSessionPermSet`,
 * `emailAlert`, `flow`) that the extractor records in `properties.actionCalls`
 * but never emits a `callsApex` edge for. The merge strategy:
 *
 *   1. Query `callsApex` edges → one row per apex call (with a resolved
 *      `targetId` in `ApexClass:{ApiName}` form).
 *   2. Read the `properties.actionCalls` summary list from the node (or fall
 *      back to a raw XML scan for pre-bundle-4a vaults).
 *   3. For every summary whose `actionType` is NOT `'apex'`, push a row where
 *      `targetId` is the bare `actionName` (no graph node exists for these
 *      types) and `targetType` is the `actionType` string.
 *   4. Apex entries in the summary list are SKIPPED — they are already covered
 *      by the `callsApex` edge rows (which carry a richer resolved `targetId`).
 *
 * Source order is preserved: apex calls (from edges, sorted by toId per the
 * graph contract) come first, followed by non-apex calls in source order.
 */
const collectActionCalls = async (
  ctx: Context,
  flowId: ComponentId,
  node: Node,
): Promise<Result<readonly ExplainFlowActionCall[], string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'callsApex',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  // ONE batched fetch of every callsApex target, replacing the per-edge
  // `getNodeById` N+1. Edge order is preserved; a missing node keeps the old
  // `prefixOf(edge.toId)` targetType fallback.
  const nodesResult = await listNodesByIds(
    ctx.graph,
    edgesResult.value.map((e) => e.toId),
  );
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const byId = new Map(nodesResult.value.map((n) => [n.id, n]));
  const out: ExplainFlowActionCall[] = [];
  for (const edge of edgesResult.value) {
    const target = byId.get(edge.toId);
    const targetType = target !== undefined ? target.type : prefixOf(edge.toId);
    out.push({ targetId: edge.toId, targetType, actionType: 'apex' });
  }

  // Merge non-apex action calls from the node properties (or source-file
  // fallback). These are action types the extractor recognised as faultable
  // but never emits a `callsApex` edge for (e.g. activateSessionPermSet).
  let summaries = readActionCallSummariesFromNode(node);
  if (summaries.length === 0) {
    // Vault built before bundle-4a — fall back to raw XML scan.
    summaries = await readActionCallSummariesFromSource(ctx.vaultRoot, node);
  }
  for (const s of summaries) {
    if (s.actionType === 'apex') continue; // Already covered by callsApex edges.
    if (s.actionType === null) continue;
    out.push({
      targetId: s.actionName ?? '',
      targetType: s.actionType,
      actionType: s.actionType,
    });
  }

  return ok(out);
};

/**
 * R6-02: collect the Flow's outgoing subflow calls. Walks outgoing `references`
 * edges filtered to `properties.referenceKind === 'subflow'` (the declared
 * `<subflows>` calls the flow extractor now emits) and projects each into an
 * `ExplainFlowSubflowCall`. `resolved` reflects whether the target `Flow:{name}`
 * node exists in the vault — a dangling (managed / uncaptured) subflow is
 * surfaced with `resolved: false` rather than dropped or fabricated.
 *
 * Before R6-02 subflow calls were unmodeled, so `explain_flow` could not name a
 * nested flow at all; this axis closes that gap. The still-invisible path is
 * Apex `Flow.Interview.start()` invocation (not a declared `<subflows>` edge) —
 * disclosed via the run-mode note, unchanged here.
 */
const collectSubflowCalls = async (
  ctx: Context,
  flowId: ComponentId,
): Promise<Result<readonly ExplainFlowSubflowCall[], string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'references',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  // ONE batched fetch of every subflow target, replacing the per-edge
  // `getNodeById` N+1. Edge order (filtered to subflow references) is preserved;
  // `resolved` reflects Map presence, matching the old `!== null` check.
  const subflowEdges = edgesResult.value.filter(
    (e) => e.properties['referenceKind'] === 'subflow',
  );
  const nodesResult = await listNodesByIds(
    ctx.graph,
    subflowEdges.map((e) => e.toId),
  );
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const resolvedIds = new Set(nodesResult.value.map((n) => n.id));
  const out: ExplainFlowSubflowCall[] = [];
  for (const edge of subflowEdges) {
    const elementNameRaw = edge.properties['subflowElementName'];
    out.push({
      targetFlowId: edge.toId,
      targetFlowName: stripObjectPrefix(edge.toId),
      subflowElementName:
        typeof elementNameRaw === 'string' ? elementNameRaw : null,
      resolved: resolvedIds.has(edge.toId),
    });
  }
  return ok(out);
};

/**
 * Extract the canonical-id prefix (the substring before the first
 * colon). Used as the targetType fallback for sparse-graph misses.
 */
const prefixOf = (id: ComponentId): string => {
  const colonIdx = id.indexOf(':');
  return colonIdx < 0 ? '' : id.slice(0, colonIdx);
};

/**
 * Collect the Flow's outgoing `readsFrom` edges (the
 * `<recordLookups>` block) and collapse them by target object.
 * Multiple lookups against the same object surface as one row with
 * `filterCount` incremented per matching edge. The renderer reads
 * `filterCount` to render "Account (3 lookups)" rather than three
 * separate "Account" rows.
 */
const collectRecordLookups = async (
  ctx: Context,
  flowId: ComponentId,
): Promise<Result<readonly ExplainFlowRecordLookup[], string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'readsFrom',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const edge of edgesResult.value) {
    // R6-11: FIELD-level dataflow-source reads (operation 'dataflowSource',
    // toId CustomField:...) are lineage plumbing, not record lookups —
    // folding them in here would render a field id as a bogus "object" row.
    if (edge.properties?.['operation'] === 'dataflowSource') continue;
    const object = stripObjectPrefix(edge.toId);
    if (!counts.has(object)) order.push(object);
    counts.set(object, (counts.get(object) ?? 0) + 1);
  }
  const out: ExplainFlowRecordLookup[] = [];
  for (const object of order) {
    out.push({ object, filterCount: counts.get(object) ?? 0 });
  }
  return ok(out);
};

/**
 * Classify a `writesTo` edge by its `operation` property into the
 * three documented Flow record-write kinds. Defaults to `'update'`
 * when the property is absent or malformed — `<recordUpdates>` is the
 * most common Flow write shape, and the renderer can spot a missing
 * property by cross-referencing the edge's source extractor.
 */
const classifyWriteOperation = (
  edge: Edge,
): 'create' | 'update' | 'delete' => {
  const op = edge.properties?.['operation'];
  if (op === 'recordCreate') return 'create';
  if (op === 'recordDelete') return 'delete';
  return 'update';
};

/**
 * Collect the Flow's OBJECT-level outgoing `writesTo` edges and project each
 * into an `ExplainFlowRecordWrite` row. Unlike record lookups we do NOT
 * collapse same-object writes — multiple `<recordCreates>` against
 * the same object are surfaced as separate rows so the renderer can
 * show distinct create steps. The order matches the underlying edge
 * list (sorted by `(toId, edgeType)` per `listEdges`'s contract).
 *
 * FIELD-level `writesTo` edges (targets prefixed `CustomField:` — the DML
 * `<inputAssignments>` field writes and the R7-W2 before-save `$Record.<Field>`
 * assignment writes) are DELIBERATELY excluded here: this axis is object-
 * granular ("does the flow create/update/delete this object?"), and folding a
 * `CustomField:Obj.Field` id into the `object` slot would misclassify a field
 * write as a bogus object row. The per-field detail is a field-lineage /
 * field_360 concern; mirrors {@link collectRecordLookups}'s exclusion of the
 * `dataflowSource` field reads.
 */
const collectRecordWrites = async (
  ctx: Context,
  flowId: ComponentId,
): Promise<Result<readonly ExplainFlowRecordWrite[], string>> => {
  const edgesResult = await listEdges(ctx.graph, flowId, {
    direction: 'out',
    edgeType: 'writesTo',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const out: ExplainFlowRecordWrite[] = [];
  for (const edge of edgesResult.value) {
    // Object-granular axis: skip FIELD-level writes (CustomField targets).
    if (!edge.toId.startsWith('CustomObject:')) continue;
    out.push({
      object: stripObjectPrefix(edge.toId),
      operation: classifyWriteOperation(edge),
    });
  }
  return ok(out);
};

/**
 * Pull the synthetic ConditionalContext apiName from a mirror entry's
 * conditionContextId. The id shape is
 * `ConditionalContext:{ParentId}.condition-{N}`; the apiName is
 * everything after the first colon. Returns the verbatim id for
 * malformed inputs so the renderer always has SOME handle.
 */
const decisionNameOf = (conditionContextId: string): string => {
  const colonIdx = conditionContextId.indexOf(':');
  if (colonIdx < 0) return conditionContextId;
  return conditionContextId.slice(colonIdx + 1);
};

/**
 * Read the v2.0a `properties.conditions[]` mirror from the Flow node
 * and surface each entry as an `ExplainFlowDecision`. The mirror is
 * the source of truth for the decision-narrative axis — walking the
 * `firesWhen` edges would require a separate roundtrip per decision,
 * and the mirror was designed exactly for this read pattern.
 *
 * Each mirror entry carries `expression` (the rendered predicate);
 * the `conditions` array is `[expression]` since the mirror is one-
 * entry-per-condition. Multi-condition decisions appear as multiple
 * mirror entries — each surfaces as its own decision row.
 */
const collectDecisions = (node: Node): readonly ExplainFlowDecision[] => {
  const mirror = node.properties['conditions'];
  if (!Array.isArray(mirror)) return [];
  const out: ExplainFlowDecision[] = [];
  for (const entry of mirror) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const conditionContextId = obj['conditionContextId'];
    const expression = obj['expression'];
    if (typeof conditionContextId !== 'string') continue;
    // Prefer the firer's REAL element name (a Flow decision's `<name>` + rule
    // `<name>`, captured into the mirror as `sourceName`) over the synthetic
    // `condition-N` handle. Fall back to the synthetic apiName when the source
    // never captured a name (a criteria / formula / record-trigger firer, or
    // an older vault built before this fix).
    const sourceName = obj['sourceName'];
    const decisionName =
      typeof sourceName === 'string' && sourceName.length > 0
        ? sourceName
        : decisionNameOf(conditionContextId);
    const expressionText = typeof expression === 'string' ? expression : '';
    // Surface the fields the decision evaluates (mirror entry `fieldRefs`).
    // Dropping them left every decision row as a bare connector ("and").
    const rawRefs = obj['fieldRefs'];
    const fieldReferences = Array.isArray(rawRefs)
      ? rawRefs.filter((r): r is string => typeof r === 'string')
      : [];
    out.push({
      decisionName,
      conditions: [expressionText],
      fieldReferences,
    });
  }
  return out;
};

/**
 * The `sfi.explain_flow` MCP tool. Returns a structured narrative
 * payload for one Flow: identity, trigger info, body sections
 * (action calls, record lookups, record writes), and the v2.0a
 * decision conditions. See the module JSDoc for the cascade and the
 * honesty-axis design.
 *
 * DEFERS to `sfi.flow_graph` for full structure: this is a SUMMARY over
 * six narrative axes, not every element or the connector graph. The
 * `seeAlso` field on the output says so explicitly (spec §9 Q2).
 *
 * @example
 *   const r = await explainFlowHandler(ctx, { flowId: 'Flow:Account_Notify' });
 *   if (r.ok) {
 *     console.log(r.value.data.triggerInfo.triggerType);
 *     for (const action of r.value.data.actionCalls) {
 *       console.log(action.targetId);
 *     }
 *   }
 */
/**
 * Common automation/code types a caller might mistake for a Flow. "Explain
 * flow AccountTrigger" is really an ApexTrigger; a bare class name an ApexClass.
 * Probed in order when a Flow lookup misses so the error can point at the real
 * component instead of a dead end.
 */
const ALTERNATE_TYPE_PREFIXES = [
  'ApexTrigger',
  'ApexClass',
  'WorkflowRule',
  'ValidationRule',
] as const;

/** Return the canonical id of a same-named node under another common type, or null. */
const findAlternateTypeId = async (
  ctx: Context,
  bareName: string,
): Promise<ComponentId | null> => {
  for (const prefix of ALTERNATE_TYPE_PREFIXES) {
    const candidate = `${prefix}:${bareName}` as ComponentId;
    const r = await getNodeById(ctx.graph, candidate);
    if (r.ok && r.value !== null) return candidate;
  }
  return null;
};

export const explainFlowHandler = async (
  ctx: Context,
  input: ExplainFlowInput,
): Promise<Result<McpResponse<ExplainFlowOutput>, McpError>> => {
  const coercedFlowId = coercePrefix(input.flowId, [FLOW_PREFIX]);
  if (!coercedFlowId.startsWith(FLOW_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `flowId must be a Flow id (e.g. '${FLOW_PREFIX}My_Flow') or a bare flow name (e.g. 'My_Flow'); got '${input.flowId}'`,
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
    // The name may belong to another type — "AccountTrigger" is an ApexTrigger,
    // not a Flow. Point the caller at the real component instead of a dead end.
    const bareName = flowId.slice(FLOW_PREFIX.length);
    const alt = await findAlternateTypeId(ctx, bareName);
    return err({
      kind: 'component-not-found',
      message: alt
        ? `no Flow named '${bareName}', but '${alt}' exists — it is a ${alt.slice(0, alt.indexOf(':'))}, not a Flow. explain_flow only handles Flows; use get_component (or the matching trigger/apex tool) for '${alt}'.`
        : `no Flow with id ${flowId}`,
      path: flowId,
    });
  }
  const node = nodeResult.value;

  // Defensive: the prefix already pins the expected type, but the
  // graph round-trip could in principle return a node with a
  // different `type`. Treat that as `component-not-found` since the
  // caller's request cannot be satisfied by what the vault holds.
  if (node.type !== 'Flow') {
    return err({
      kind: 'component-not-found',
      message: `node ${flowId} is not a Flow (type=${node.type})`,
      path: flowId,
    });
  }

  const triggerObjectResult = await findTriggerObject(ctx, flowId);
  if (!triggerObjectResult.ok) {
    return err({ kind: 'internal', message: triggerObjectResult.error });
  }
  const conditionsResult = await collectTriggerConditions(ctx, flowId);
  if (!conditionsResult.ok) {
    return err({ kind: 'internal', message: conditionsResult.error });
  }
  const actionCallsResult = await collectActionCalls(ctx, flowId, node);
  if (!actionCallsResult.ok) {
    return err({ kind: 'internal', message: actionCallsResult.error });
  }
  const subflowCallsResult = await collectSubflowCalls(ctx, flowId);
  if (!subflowCallsResult.ok) {
    return err({ kind: 'internal', message: subflowCallsResult.error });
  }
  const recordLookupsResult = await collectRecordLookups(ctx, flowId);
  if (!recordLookupsResult.ok) {
    return err({ kind: 'internal', message: recordLookupsResult.error });
  }
  const recordWritesResult = await collectRecordWrites(ctx, flowId);
  if (!recordWritesResult.ok) {
    return err({ kind: 'internal', message: recordWritesResult.error });
  }

  const data: ExplainFlowOutput = {
    flowId,
    apiName: node.apiName,
    label: readFlowLabel(node),
    status: readFlowStatus(node),
    processType: readFlowProcessType(node),
    executionContext: await buildExecutionContext(node, ctx.vaultRoot),
    triggerInfo: {
      triggerType: readFlowTriggerType(node),
      triggerObject: triggerObjectResult.value,
      conditions: conditionsResult.value,
    },
    actionCalls: actionCallsResult.value,
    subflowCalls: subflowCallsResult.value,
    recordLookups: recordLookupsResult.value,
    recordWrites: recordWritesResult.value,
    decisions: collectDecisions(node),
    disclosure: DISCLOSURE,
    conditionsRuntimeNote: CONDITIONS_RUNTIME_NOTE,
    seeAlso: SEE_ALSO_FLOW_GRAPH,
  };
  const annotations = await annotationsBlockFor(ctx, node.id);

  return ok({
    data: { ...data, ...(annotations !== undefined ? { annotations } : {}) },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
