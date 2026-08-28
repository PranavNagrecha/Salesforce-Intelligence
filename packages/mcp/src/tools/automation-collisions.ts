/**
 * Handler for the `sfi.automation_collisions` MCP tool.
 *
 * The "is my org fighting itself?" tool for ONE object. `automation_build_advisor`
 * (see `automation-build-advisor.ts`, the closest sibling) flags OBJECT-level
 * hazards — multiple record-triggered Flows on one object, mixed Apex+Flow
 * automation. It does NOT look at what those automations actually WRITE, so it
 * misses two silent failure modes:
 *
 *   1. **Field-level write collisions** — two or more DISTINCT automations
 *      (record-triggered Flow, ApexTrigger, WorkflowRule) writing the SAME
 *      field on the SAME object. Salesforce does not arbitrate between them;
 *      whichever runs last in the (often unordered) sequence wins, silently
 *      discarding the other's write. Grouped per execution PATH: save-timing
 *      writers (before-save / after-save / post-save) collide with each other,
 *      while a before-delete Flow runs on the DELETE path and collides ONLY
 *      with another before-delete Flow — never with a save-timing writer.
 *   2. **Save-recursion cycles** — an automation on object O writes a field
 *      back onto O itself (the classic workflow-field-update / after-trigger
 *      re-trigger), or writes a field on object P whose own automation writes
 *      a field back onto O — a potential infinite-loop / governor-limit risk
 *      the platform only partially guards against.
 *
 * Composition:
 *   - Gathers the object's incoming `triggersOn` edges (record-triggered
 *     Flows, ApexTriggers, WorkflowRules — the SAME gathering approach as
 *     `automation_build_advisor`) and each firer's outgoing `writesTo` edges.
 *   - **Collisions**: groups same-object field writes by (target `CustomField`
 *     id, execution PATH — save vs delete); 2+ distinct writer components in
 *     one (field, path) bucket is a finding. A before-delete Flow buckets on
 *     the DELETE path, disjoint from save-timing writers.
 *   - **Cycles**: a bounded (depth-capped) walk over `triggersOn` +
 *     `writesTo` edges, starting at the queried object, looking for a write
 *     path that returns to the object it started from. A same-object
 *     self-write (X triggersOn O and writesTo a field on O) is the depth-1
 *     special case and the most common real-world shape.
 *
 * **Honesty axis** (load-bearing, see BOUNDARY_* below):
 *   - Every listed component is a real vault node reached via `triggersOn` /
 *     `writesTo` edges — never a fabricated execution trace.
 *   - An object the vault holds in NEITHER form (no `CustomObject:` node and
 *     no `triggersOn` edge) is REFUSED, not answered: on a "what will break"
 *     tool an empty report reads as "nothing will", so an unchecked zero must
 *     never wear a checked zero's clothes. An object reached by edges alone
 *     still answers, with a boundary saying its own metadata was never
 *     retrieved.
 *   - Field-update / entry CONDITIONS are NOT evaluated: two writers with
 *     mutually exclusive criteria are still listed as a collision.
 *   - Confidence varies per writer (a Flow / WorkflowRule field write that
 *     NAMES its field in the XML is `parsed`; ApexTrigger writes are
 *     `heuristic` static analysis). A finding carries the WEAKEST confidence
 *     among its contributing writers, labeled explicitly.
 *   - A Flow that assigns fields into an SObject VARIABLE and commits it with
 *     a bare `<inputReference>` writes real fields the vault cannot enumerate
 *     offline (the extractor marks that edge `fieldsEnumerable: false`). Such
 *     a writer can never appear in `collisions` or `cycles` — there is no
 *     field name to group or chain it by — so it is listed in
 *     `unenumerableFieldWrites` and `summary.fieldWriteCoverage` drops to
 *     `partial`. The field names are NOT guessed from `<assignToReference>`:
 *     a variable can be assigned and never committed, or typed to a different
 *     SObject, and either guess manufactures a collision that does not exist.
 *   - Only automation wired directly via `triggersOn` on an object is walked
 *     — ApprovalProcess field updates and Apex writes performed by a HELPER
 *     CLASS called FROM a trigger (rather than the trigger itself) are out of
 *     scope for this v1.
 *   - Salesforce's own recursion guards — a record-triggered Flow's "do not
 *     re-trigger the flow that started this update" setting, and the
 *     platform's workflow-rule re-evaluation limits — are NOT captured by the
 *     extractors and are therefore NOT evaluated here. A listed cycle is a
 *     POTENTIAL loop the org's structure allows, not proof it fires.
 *   - A same-object write from a BEFORE-save automation (before-trigger,
 *     before-save Flow) is excluded from cycle detection: it folds into the
 *     record's single pending INSERT/UPDATE rather than causing a second
 *     save, so it is not a recursion candidate. A BEFORE-delete Flow is
 *     excluded from cycle detection entirely — it runs on the DELETE path,
 *     not the save order-of-execution, so it is never a save-recursion hop
 *     (two before-delete Flows writing one field are a delete-path COLLISION,
 *     not a cycle).
 */

import type {
  ComponentId,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdges,
  QUERY_GRAPH_MAX_LIMIT,
  runGraphQuery,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { isUnresolvedFieldReceiver } from './apex-receiver.js';
import { resolveObjectAliasInVault } from './input-aliases.js';
import {
  argsFingerprint,
  paginate,
  type PaginateBinding,
  type PaginateResult,
} from './page-cursor.js';
import { responseReductionCap } from './response-budget.js';
import { isActiveSoeFirer } from './soe-active.js';

/** Default and max number of collisions / cycles returned per list. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Bytes this tool reserves for everything in `data` that is NOT one of the
 * four paged lists (`collisions`, `cycles`, `unenumerableFieldWrites`,
 * `externalWriters`): `object`, `appliedScope`, the two booleans, `summary`,
 * and the seven-plus `boundaries` strings (~8 KB of prose on a worst-case
 * answer — the external-writer disclosure alone is a paragraph).
 */
const NON_LIST_RESERVE_BYTES = 10_000;

/**
 * The byte budget the two findings lists share, DERIVED from the global
 * response budget rather than declared beside it.
 *
 * AUTOMATION-COLLISIONS-TWO-LISTS-ONE-ENVELOPE. `collisions` and `cycles` were
 * each paged against `paginate`'s default 38 000-byte budget while both travel
 * in ONE envelope the global guard reduces to {@link responseReductionCap}
 * (38 976 by default). A densely-automated object therefore produced ~78 KB of
 * `data`, and `jsonResult` tail-trimmed the SECOND list — while `cyclesTruncated`
 * and the `boundaries` count (which `tool-dispatch` protects from that trim)
 * still described the list before the trim. A per-list budget that is bigger
 * than the whole envelope is not a budget; deriving the shared one from
 * `response-budget.ts` keeps it correct at every value of
 * `SFI_MAX_RESPONSE_BYTES` instead of pinning a constant that drifts.
 */
const listsByteBudget = (): number =>
  Math.max(2_000, responseReductionCap() - NON_LIST_RESERVE_BYTES);

/**
 * The truncation disclosure for one findings list.
 *
 * Two things it must not get wrong, both of which it used to:
 *
 *   - the count is the number of rows ACTUALLY SHIPPED (`page.items.length`),
 *     never `limit`. `collisionsTruncated` fires on a BYTE trim as well as a
 *     limit cut, and a byte-trimmed page is SHORTER than `limit` — so the old
 *     sentence read "truncated to 200 of 150 fields" above an 89-row list, a
 *     count that is not even arithmetically possible;
 *   - "raise `limit`" is only true when `limit` is what cut the page. On a byte
 *     trim a bigger `limit` returns exactly the same rows, so the advice points
 *     at the one knob that cannot help.
 */
const truncationNote = (
  label: string,
  unit: string,
  page: PaginateResult<unknown>,
  total: number,
): string => {
  const shipped = page.items.length;
  return page.byteTrimmed
    ? `${label} truncated to ${shipped} of ${total} ${unit} — this response hit its BYTE budget, not \`limit\`, so raising \`limit\` returns the same rows; narrow the question to a less densely-automated object.`
    : `${label} truncated to ${shipped} of ${total} ${unit} — raise \`limit\` (max ${MAX_LIMIT}) to see more.`;
};

/** Bounded-walk knobs for the recursion-cycle search (see BOUNDARY_DEPTH_CAP). */
const CYCLE_DEPTH_CAP = 4;
const CYCLE_EXPLORE_CAP = 300;

const TOOL_NAME = 'sfi.automation_collisions';

/** The `triggersOn` firer families this tool walks — mirrors `automation_build_advisor`. */
type AutomationKind = 'Flow' | 'ApexTrigger' | 'WorkflowRule';

/**
 * When (relative to the database write) a firer's writes take effect. The
 * SAVE-path timings — `before`/`after` (before-save / after-save Flow or Apex
 * trigger), `post-save` (WorkflowRule), `unknown` — all run during a record
 * SAVE. `before-delete` runs on the DELETE path and can NEVER co-execute with
 * any of them (see {@link pathOfTiming}). Mirrors the reasoning engine's 3-way
 * trigger context (`knowledge/reason.ts` `triggerContextOf`).
 */
type WriteTiming = 'before' | 'after' | 'post-save' | 'before-delete' | 'unknown';

/**
 * The execution PATH a {@link WriteTiming} runs on. Every save-timing
 * (`before`/`after` save, `post-save` workflow, `unknown`) runs on the SAVE
 * path; `before-delete` runs on the DELETE path. Two writers can collide only
 * when they share a path: a before-delete Flow (DELETE path) can NEVER race a
 * save-timing writer, so it buckets separately — folding it into a save bucket
 * (the pre-fix behaviour) fabricated false "save collisions" between an
 * after-save Flow and a before-delete Flow. Mirrors the DISJOINT trigger
 * contexts in `knowledge/reason.ts` (`triggerContextOf`).
 */
type CollisionPath = 'save' | 'delete';

/** Map a firer's {@link WriteTiming} to the execution path its writes race on. */
const pathOfTiming = (timing: WriteTiming): CollisionPath =>
  timing === 'before-delete' ? 'delete' : 'save';

/**
 * Zod schema for the `sfi.automation_collisions` tool input. Name the object
 * ANY way the router / a sibling tool would (L2 Alias OS): the bare `object`
 * (the canonical key), `objectApiName`, `objectId`, or a `CustomObject:`
 * `componentId`. Exactly one target must survive resolution — disagreeing
 * aliases are an `invalid-query` (never a silent pick), and the resolved scope
 * is echoed as `appliedScope`.
 *
 * The named object must be PRESENT in the vault, as a `CustomObject:` node OR
 * as the target of at least one `triggersOn` edge. One that is neither is a
 * named `invalid-query`, because an empty collision report reads as "nothing
 * here collides". Resolution is case-insensitive and `appliedScope` carries the
 * vault's own casing.
 */
export const automationCollisionsInputSchema = z
  .object({
    object: z.string().min(1).optional(),
    objectApiName: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .refine(
    (i) =>
      i.object !== undefined ||
      i.objectApiName !== undefined ||
      i.objectId !== undefined ||
      i.componentId !== undefined,
    {
      message:
        'name the object — pass `object` (e.g. "Account"), `objectApiName`, `objectId`, or a `CustomObject:` `componentId`',
      path: ['object'],
    },
  );

export type AutomationCollisionsInput = z.infer<typeof automationCollisionsInputSchema>;

/** One automation writing a field a collision/cycle finding names. */
export interface AutomationWriter {
  readonly componentId: ComponentId;
  readonly componentType: AutomationKind;
  readonly active: boolean;
  /** The `writesTo` edge's own confidence — `parsed` (Flow/WorkflowRule XML) or `heuristic` (Apex scanner). */
  readonly confidence: ConfidenceLevel;
  /**
   * Firing timing relative to the database write, when modeled; `'unknown'`
   * otherwise. `'before-delete'` runs on the DELETE path, not the save path.
   */
  readonly timing: WriteTiming;
}

/**
 * A field with 2+ distinct automations writing it on the SAME execution path.
 * `collisionPath: 'save'` groups save-timing writers (before-save / after-save
 * / post-save workflow); `collisionPath: 'delete'` groups before-delete Flows
 * that race on the DELETE path. The two paths are DISJOINT — a before-delete
 * write is never reported as colliding with a save-timing write.
 */
export interface FieldCollision {
  readonly fieldId: ComponentId;
  readonly fieldApiName: string;
  /**
   * Which execution path the colliding writers race on. A `'delete'` collision
   * is a DELETE-path (before-delete) collision — never a save collision.
   */
  readonly collisionPath: CollisionPath;
  readonly writers: readonly AutomationWriter[];
  readonly activeWriterCount: number;
  /** The WEAKEST confidence across `writers` — a heuristic Apex write drags the whole finding down. */
  readonly weakestConfidence: ConfidenceLevel;
  readonly severity: 'info' | 'medium' | 'high';
}

/**
 * A write the vault RECORDS but whose FIELD IDENTITY it could not resolve: a
 * Flow `<recordCreates>` / `<recordUpdates>` whose target is a record VARIABLE
 * (`<inputReference>Var</inputReference>` with no `<inputAssignments>`). The
 * fields the Flow assigned into that variable really are written to the
 * record; the extractor cannot enumerate them offline, so it emits one
 * OBJECT-level `writesTo` edge marked `wholeRecord` / `fieldsEnumerable:
 * false`.
 *
 * Every row here is a writer that CANNOT appear in {@link
 * AutomationCollisionsOutput.collisions} or {@link
 * AutomationCollisionsOutput.cycles}, because no field name exists to group or
 * chain it by. A row is therefore the machine-readable reason an empty
 * `collisions` list on this object is NOT a checked zero.
 *
 * The field names are deliberately NOT reconstructed from
 * `<assignToReference>`: a variable can be assigned and never committed, or be
 * typed to a DIFFERENT SObject, and both shapes occur in real orgs — guessing
 * would trade a disclosed gap for fabricated collisions.
 */
export interface UnenumerableFieldWrite {
  readonly automationId: ComponentId;
  readonly automationType: AutomationKind;
  /** The object whose `triggersOn` edge reached this firer (always the queried object). */
  readonly fromObject: string;
  /** The object written as a whole record. */
  readonly toObject: string;
  /**
   * `true` when {@link toObject} is the object this call asked about — the
   * case that blinds `collisions` (and a depth-1 self-write `cycle`).
   * `false` for a write onto a DIFFERENT object, which blinds the recursion
   * walk's first hop out of this object instead.
   */
  readonly onQueriedObject: boolean;
  /** `'recordUpdate'` or `'recordCreate'`; `null` when the edge does not say. */
  readonly operation: string | null;
  /** The Flow variable committed, when the edge records it; `null` otherwise. */
  readonly inputReference: string | null;
  readonly active: boolean;
  readonly timing: WriteTiming;
  /** The execution path this write would have raced on, had its fields been known. */
  readonly collisionPath: CollisionPath;
  /** The object-level edge's own confidence. */
  readonly confidence: ConfidenceLevel;
}

/**
 * One component that writes a field on the queried object from OUTSIDE the
 * `triggersOn` automation this tool scans — an Apex class called from any
 * trigger or invoked by a Flow, a Flow record-triggered on a DIFFERENT object,
 * an ApprovalProcess field update, a batch job.
 *
 * Such a component can NEVER appear in {@link
 * AutomationCollisionsOutput.collisions}: the collision grouper only ever sees
 * writers reached through this object's own `triggersOn` edges. Publishing the
 * component here is what stops `fieldsWithMultipleWriters: 0` from reading as
 * "nothing writes this field twice".
 *
 * Its execution TIMING and PATH are deliberately NOT modeled. The vault knows
 * this component writes the field; it does not know from which entry point, in
 * which order, or whether it can co-execute with a scanned writer — and
 * inventing a timing to force it into a `collisionPath` bucket would trade a
 * disclosed gap for a fabricated collision.
 */
export interface ExternalWriter {
  readonly componentId: ComponentId;
  /** The vault node's own type (`ApexClass`, `Flow`, `ApprovalProcess`, …), or `'unknown'` when the writer has no node. */
  readonly componentType: string;
  /** The WEAKEST confidence across this component's `writesTo` edges into the field. */
  readonly confidence: ConfidenceLevel;
  /**
   * `'active'` / `'inactive'` read from the activation property the node
   * actually CARRIES (`status` / `active` / `isActive`); `'not-modeled'` when
   * it carries none.
   *
   * R1: the verdict is decided by whether the node carries the property, never
   * by a default. The shared `isActiveSoeFirer` predicate answers `true` for
   * any type it does not model, so publishing its answer for, say, an
   * ApexClass would print a DEFAULTED `active: true` as if it were checked.
   * On every type that predicate DOES model the two agree, and a drift test in
   * `test/tools/automation-collisions.test.ts` pins that agreement.
   */
  readonly activation: 'active' | 'inactive' | 'not-modeled';
  /**
   * `true` ONLY when the vault explicitly marks the component a test class
   * (`isTest: true`) — a test-only writer cannot write the field in the org's
   * production state, the same distinction `why_field_changed` draws with
   * `runnable: false`. A component whose type has no test concept is `false`.
   */
  readonly testOnly: boolean;
}

/**
 * One field on the queried object that at least one component writes from
 * outside the `triggersOn` scan. `writers` lists ONLY those outside writers;
 * `scannedWriterCount` says how many of the scanned automations write it too,
 * so a caller can see the whole picture without a second call.
 */
export interface ExternalWriterField {
  readonly fieldId: ComponentId;
  readonly fieldApiName: string;
  /** Distinct writers of this field that WERE in the scanned `triggersOn` set. */
  readonly scannedWriterCount: number;
  /** Distinct writers from outside that set — one per row in {@link writers}. */
  readonly externalWriterCount: number;
  /** `scannedWriterCount + externalWriterCount`: every distinct component the vault records writing this field. */
  readonly totalWriterCount: number;
  readonly writers: readonly ExternalWriter[];
}

/** One hop in a recursion-cycle path: an automation writing from one object onto another (or itself). */
export interface RecursionHop {
  readonly automationId: ComponentId;
  readonly automationType: AutomationKind;
  readonly fromObject: string;
  readonly toObject: string;
  readonly fieldId: ComponentId;
  readonly active: boolean;
  readonly confidence: ConfidenceLevel;
}

/** A potential save-recursion loop: `self-write` (depth 1, same object) or `multi-object` (2+ hops). */
export interface RecursionCycle {
  readonly kind: 'self-write' | 'multi-object';
  readonly path: readonly RecursionHop[];
  readonly weakestConfidence: ConfidenceLevel;
  readonly allActive: boolean;
  readonly severity: 'info' | 'medium' | 'high';
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface AutomationCollisionsOutput {
  readonly object: string;
  /**
   * Echoes the object scope ACTUALLY resolved so a host never assumes an alias
   * it passed (`objectApiName` / `objectId` / `componentId`) was honored — the
   * silent Zod-strip that surfaced as `object: Required` was the bug this
   * closes. `componentId` is the canonical `CustomObject:` id; `object` is its
   * bare api name.
   */
  readonly appliedScope: {
    readonly componentId: string;
    readonly object: string;
  };
  /**
   * Whether the vault holds this object in SOME form — a `CustomObject:` node
   * of its own, or at least one `triggersOn` edge pointing at it. Same meaning
   * as `automation_build_advisor`'s field of the same name, over the same firer
   * set, deliberately.
   *
   * It is always `true` in a successful response: an object present in NEITHER
   * form is refused with `invalid-query` before this payload is built, because
   * an empty collision report reads as "nothing here collides" and must never
   * be returned for an object that was never found. The narrower case — reached
   * by edges alone, with the object's own metadata never retrieved — is
   * disclosed in `boundaries`.
   */
  readonly objectModeled: boolean;
  readonly collisions: readonly FieldCollision[];
  readonly cycles: readonly RecursionCycle[];
  /**
   * Writes this tool could NOT resolve to a field — see
   * {@link UnenumerableFieldWrite}. Empty means every write from every scanned
   * firer resolved to a named field, so `collisions` and `cycles` are built on
   * a complete field-write surface for this object. Non-empty means they are
   * not, and `summary.fieldWriteCoverage` reads `'partial'`.
   */
  readonly unenumerableFieldWrites: readonly UnenumerableFieldWrite[];
  /**
   * Every field on this object written by a component OUTSIDE the `triggersOn`
   * automation scanned above — see {@link ExternalWriterField}. Built by
   * reading every `writesTo` edge that lands on a field of this object, so it
   * does not depend on the object's fields having nodes of their own.
   *
   * Empty (with `summary.externalWriterSweepComplete: true`) is a CHECKED
   * zero: the sweep ran and found nobody. Non-empty means `collisions` and
   * `cycles` describe a SUBSET of this object's writers, and
   * `summary.fieldsWithMultipleWritersAnySource` is the count the question
   * "is anything already fighting over a field here?" actually wants.
   */
  readonly externalWriters: readonly ExternalWriterField[];
  readonly summary: {
    readonly automationsScanned: number;
    readonly fieldsWithMultipleWriters: number;
    readonly cyclesFound: number;
    readonly collisionsTruncated: boolean;
    readonly cyclesTruncated: boolean;
    /** How many {@link UnenumerableFieldWrite} rows were found (before any truncation). */
    readonly unenumerableFieldWriteCount: number;
    /** True when `unenumerableFieldWrites` itself was cut by `limit` or the byte budget. */
    readonly unenumerableFieldWritesTruncated: boolean;
    /**
     * `'complete'` — every write from every scanned firer resolved to a named
     * field, so an empty `collisions` list is a CHECKED zero.
     * `'partial'`  — at least one firer writes through a record-variable DML
     * whose fields the vault cannot enumerate, so `collisions` and `cycles`
     * are a LOWER BOUND and an empty list is not proof of absence.
     *
     * A machine consumer that reads only `collisions.length` must read this
     * too: it is the one key that distinguishes "nothing collides" from
     * "nothing that could be checked collides".
     */
    readonly fieldWriteCoverage: 'complete' | 'partial';
    /**
     * Distinct components writing a field on this object WITHOUT being wired
     * via `triggersOn` on it — the writers `collisions` and `cycles`
     * structurally cannot see. `0` with
     * {@link externalWriterSweepComplete} `true` is a checked zero.
     */
    readonly externalWriterCount: number;
    /** Fields with at least one such writer — the length of `externalWriters` before truncation. */
    readonly fieldsWithExternalWriters: number;
    /**
     * Fields on this object with 2+ DISTINCT writers counting BOTH sets,
     * per FIELD (not per (field, path) bucket like
     * {@link fieldsWithMultipleWriters}, which counts only the scanned
     * subset and can count one field twice when it collides on both paths).
     *
     * This is the number a "will my new automation collide?" question is
     * asking for. It is a LOWER BOUND when
     * {@link externalWriterSweepComplete} is false.
     */
    readonly fieldsWithMultipleWritersAnySource: number;
    /** True when `externalWriters` itself was cut by `limit` or the byte budget. */
    readonly externalWritersTruncated: boolean;
    /**
     * True when EVERY `writesTo` edge landing on a field of this object was
     * read. False when the sweep hit its query ceiling, in which case
     * `externalWriterCount` and `fieldsWithMultipleWritersAnySource` are
     * FLOORS, not totals.
     */
    readonly externalWriterSweepComplete: boolean;
  };
  readonly boundaries: readonly string[];
}

/** Strongest -> weakest. Mirrors `hybrid-trust.ts`'s rank, scoped locally to writesTo-edge confidence. */
const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  declared: 0,
  parsed: 1,
  heuristic: 2,
};

/** The weaker (more cautious) of two writesTo-edge confidence tiers. */
const weaker = (a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel =>
  CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;

const byComponentId = (a: { componentId: ComponentId }, b: { componentId: ComponentId }): number =>
  a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0;

/** Canonical `CustomObject:` id prefix — the object-level `writesTo` target. */
const OBJECT_ID_PREFIX = 'CustomObject:';

/** Parse the object api name out of a `CustomField:{Object}.{Field}` canonical id. */
const OBJECT_FROM_FIELD_RE = /^CustomField:([^.]+)\./;
const objectOfFieldId = (fieldId: ComponentId): string | null =>
  OBJECT_FROM_FIELD_RE.exec(fieldId)?.[1] ?? null;

/** One `triggersOn` firer resolved against the object it targets, with active + timing derived. */
interface FirerDescriptor {
  readonly id: ComponentId;
  readonly type: AutomationKind;
  readonly active: boolean;
  readonly timing: WriteTiming;
}

/**
 * Gather the `triggersOn` firers for one object — record-triggered Flows,
 * ApexTriggers, WorkflowRules — the SAME edge family `automation_build_advisor`
 * walks. Reused both for the queried object and for every object reached
 * during the recursion-cycle walk.
 */
const gatherFirersForObject = async (
  ctx: Context,
  objectApiName: string,
): Promise<Result<readonly FirerDescriptor[], string>> => {
  const objectId: ComponentId = `CustomObject:${objectApiName}`;
  const inResult = await listEdges(ctx.graph, objectId, {
    direction: 'in',
    edgeType: 'triggersOn',
  });
  if (!inResult.ok) return err(inResult.error.message);

  const firers: FirerDescriptor[] = [];
  for (const triggerEdge of inResult.value) {
    const nodeResult = await getNodeById(ctx.graph, triggerEdge.fromId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    const firerNode = nodeResult.value;
    if (firerNode === null) continue;

    if (firerNode.type === 'Flow') {
      // Map the record-trigger `triggerType` 3 ways — mirroring the reasoning
      // engine's `triggerContextOf` (`knowledge/reason.ts`) and the extractor's
      // `RECORD_TRIGGER_TYPES` (`extractors/src/flow.ts`, the only 3 types that
      // emit a `triggersOn` edge): RecordBeforeSave -> before-save,
      // RecordAfterSave -> after-save, RecordBeforeDelete -> before-delete (the
      // DELETE path). An absent/unknown value is `'unknown'` — NEVER folded into
      // a save bucket, so a non-save trigger can never read as a save timing.
      // (The pre-fix `=== 'RecordBeforeSave' ? 'before' : 'after'` collapse
      // mislabeled a before-delete Flow as after-SAVE, fabricating false save
      // collisions with save-timing flows on the same field.)
      const triggerType = triggerEdge.properties['triggerType'];
      const timing: WriteTiming =
        triggerType === 'RecordBeforeSave'
          ? 'before'
          : triggerType === 'RecordAfterSave'
            ? 'after'
            : triggerType === 'RecordBeforeDelete'
              ? 'before-delete'
              : 'unknown';
      firers.push({
        id: firerNode.id,
        type: 'Flow',
        active: isActiveSoeFirer(firerNode),
        timing,
      });
    } else if (firerNode.type === 'ApexTrigger') {
      const events = firerNode.properties['events'];
      const eventList = Array.isArray(events) ? events : [];
      const hasBefore = eventList.some((e) => typeof e === 'string' && e.startsWith('before '));
      const hasAfter = eventList.some((e) => typeof e === 'string' && e.startsWith('after '));
      // A trigger that fires in BOTH timings can write in either handler; the
      // scanner's writesTo edge does not carry per-event attribution, so a
      // trigger with any `after` handler is conservatively treated as `after`
      // (the recursion-relevant case) rather than silently downgraded to
      // `before`. Pure before-only triggers are `before`; neither -> `unknown`.
      const timing: WriteTiming = hasAfter ? 'after' : hasBefore ? 'before' : 'unknown';
      firers.push({
        id: firerNode.id,
        type: 'ApexTrigger',
        active: isActiveSoeFirer(firerNode),
        timing,
      });
    } else if (firerNode.type === 'WorkflowRule') {
      // Workflow field updates always run in the post-save-workflows SOE phase.
      firers.push({
        id: firerNode.id,
        type: 'WorkflowRule',
        active: isActiveSoeFirer(firerNode),
        timing: 'post-save',
      });
    }
  }
  return ok(firers);
};

/** One field-level `writesTo` edge from a firer. */
interface ResolvedFieldWrite {
  readonly toId: ComponentId;
  readonly confidence: ConfidenceLevel;
}

/**
 * One write this tool KNOWS a firer performs and whose FIELD IDENTITY the
 * vault could not resolve — see {@link UnenumerableFieldWrite}. Pre-projection
 * shape: the firer's identity is attached by the caller, which knows which
 * object's `triggersOn` edge reached it.
 */
interface UnenumerableWriteEdge {
  readonly toObject: string;
  readonly operation: string | null;
  readonly inputReference: string | null;
  readonly confidence: ConfidenceLevel;
}

/**
 * The extractor's typed marker for a whole-record DML: `<recordCreates>` /
 * `<recordUpdates>` whose target is a record VARIABLE `<inputReference>` with
 * no `<inputAssignments>` to enumerate (`extractors/src/flow.ts`
 * `buildObjectDmlProps`). It is a POSITIVE marker set only on that path — an
 * ordinary DML edge omits it entirely — so this predicate tests for the value
 * `false`, never for absence. (R1's inverse: absence here means "ordinary
 * DML", not "never scanned".)
 */
const isWholeRecordDmlEdge = (properties: Record<string, unknown>): boolean =>
  properties['fieldsEnumerable'] === false;

/**
 * Gather a firer's writes, split into the two things they can be.
 *
 * FLOW-RECORD-VARIABLE-DML-IS-AN-UNCERTIFIED-BLIND-SPOT. This used to be one
 * list, built by `continue`-ing past every non-`CustomField:` edge under the
 * comment "object-level writesTo (recordCreate) — not a field write". For a
 * Flow that assigns fields into an SObject variable and then commits it with a
 * bare `<inputReference>`, that object-level edge is the ONLY record the graph
 * holds of a real, field-level write — the extractor stamps it
 * `wholeRecord: true` / `fieldsEnumerable: false` precisely to say "fields
 * written here, identity unknown". Dropping it silently deleted the disclosure
 * the extractor had already paid for, and the tool then certified the opposite
 * in `boundaries` ("Flow ... field writes are `parsed` from declared XML").
 * The writes are returned separately so the handler can list the collisions it
 * PROVED and, alongside them, the writes it could not resolve — never fold one
 * into the other, and never fabricate a field name for the second kind.
 *
 * A record-VARIABLE `<recordDeletes>` carries the identical markers but
 * assigns no fields, so it is not an unenumerable field write and is excluded:
 * flagging it would manufacture a blind spot that does not exist.
 *
 * Field-level edges still drop heuristic-scanner writes to an UNRESOLVED
 * receiver (`this.x`, a lowercase local-var alias) — the same segregation
 * `what_happens_on_save` / `field_provenance` apply — so a parse artifact
 * never reads as a real field write.
 */
const gatherFieldWritesForFirer = async (
  ctx: Context,
  firerId: ComponentId,
): Promise<
  Result<
    {
      readonly fieldWrites: readonly ResolvedFieldWrite[];
      readonly unenumerable: readonly UnenumerableWriteEdge[];
    },
    string
  >
> => {
  const edgesResult = await listEdges(ctx.graph, firerId, {
    direction: 'out',
    edgeType: 'writesTo',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const fieldWrites: ResolvedFieldWrite[] = [];
  const unenumerable: UnenumerableWriteEdge[] = [];
  for (const writeEdge of edgesResult.value) {
    if (!writeEdge.toId.startsWith('CustomField:')) {
      const operation = writeEdge.properties['operation'];
      if (!isWholeRecordDmlEdge(writeEdge.properties) || operation === 'recordDelete') continue;
      const toObject = writeEdge.toId.startsWith(OBJECT_ID_PREFIX)
        ? writeEdge.toId.slice(OBJECT_ID_PREFIX.length)
        : null;
      if (toObject === null || toObject.length === 0) continue;
      const inputReference = writeEdge.properties['inputReference'];
      unenumerable.push({
        toObject,
        operation: typeof operation === 'string' ? operation : null,
        inputReference: typeof inputReference === 'string' ? inputReference : null,
        confidence: writeEdge.confidence,
      });
      continue;
    }
    if (isUnresolvedFieldReceiver(writeEdge.toId)) continue;
    fieldWrites.push({ toId: writeEdge.toId, confidence: writeEdge.confidence });
  }
  return ok({ fieldWrites, unenumerable });
};

/**
 * The activation properties a node can CARRY, strongest signal first. A node
 * that carries none has no activation concept at all (an ApexClass in an older
 * vault), and its state must read `'not-modeled'` rather than a defaulted
 * `true`.
 */
const ACTIVATION_PROPERTY_KEYS = ['status', 'active', 'isActive'] as const;

/**
 * The activation state of a component the vault holds, decided by the property
 * the node CARRIES (R1). See {@link ExternalWriter.activation} for why
 * `isActiveSoeFirer` is not consulted directly here: it returns `true` for
 * every type it does not model, which would publish a default as a check.
 * A drift test pins that this agrees with that predicate on every type it does.
 */
const activationOf = (node: Node | null): ExternalWriter['activation'] => {
  if (node === null) return 'not-modeled';
  for (const key of ACTIVATION_PROPERTY_KEYS) {
    const value = node.properties[key];
    // A string state is the extractors' `status` vocabulary (`Active`,
    // `Draft`, `Obsolete`, `Inactive`, `Deleted`); a boolean is the
    // `active` / `isActive` element. Anything else is not an activation.
    if (typeof value === 'string') return value === 'Active' ? 'active' : 'inactive';
    if (typeof value === 'boolean') return value ? 'active' : 'inactive';
  }
  return 'not-modeled';
};

/** What {@link gatherExternalFieldWriters} found, plus the honesty of its own reach. */
interface ExternalWriterSweep {
  /** Fields with at least one writer outside the scanned `triggersOn` set. */
  readonly fields: readonly ExternalWriterField[];
  /** Distinct components across every row of {@link fields}. */
  readonly writerCount: number;
  /** Fields with 2+ distinct writers counting BOTH sets, per field. */
  readonly fieldsWithMultipleWritersAnySource: number;
  /** True when every matching `writesTo` edge was read (no query-ceiling cut). */
  readonly complete: boolean;
  /** How many edges were read, and how many matched — for the truncation sentence. */
  readonly edgesRead: number;
  readonly edgesMatched: number;
}

/**
 * AUTOMATION-COLLISIONS-CONFIDENT-ZERO-OVER-A-ONE-NINTH-CORPUS.
 *
 * Read EVERY `writesTo` edge that lands on a field of the queried object and
 * report the writers that the `triggersOn` scan structurally cannot see.
 *
 * The measured defect: a standard object with exactly ONE record-triggered
 * Flow wired to it answered `collisions: []`, `fieldsWithMultipleWriters: 0`,
 * `collisionsTruncated: false`, `automationsScanned: 1` — while the graph held
 * EIGHT fields on it with 2-5 distinct `writesTo` writers each, among them
 * live Apex service classes and Flows triggered on OTHER objects. A sibling
 * tool named all of them on the same vault in the same session. The envelope
 * published no count of what the scan had excluded, so "I checked and found
 * none" and "I could only check one ninth of it" were indistinguishable.
 *
 * Why an edge query rather than the object's field NODES: on a real vault ~20%
 * of `writesTo` field edges point at a field the retrieve never modeled, so a
 * sweep built on `scanAllNodesOfTypes(['CustomField'], { parentId })` would
 * have missed one write in five and called the rest complete. The edge table
 * is the arbiter.
 *
 * `LIKE` has no `ESCAPE` clause here and `_` is a LIKE wildcard — which every
 * real api name is full of — so the pattern is a deliberate SUPERSET filter
 * and every row is re-checked against the exact prefix. `totalCount` is exact
 * (the compiler runs a `count(*)` with the same WHERE), so a sweep cut by the
 * query ceiling reports itself instead of shipping a short list as a total.
 */
const gatherExternalFieldWriters = async (
  ctx: Context,
  objectApiName: string,
  scannedFirerIds: ReadonlySet<string>,
): Promise<Result<ExternalWriterSweep, string>> => {
  const fieldPrefix = `CustomField:${objectApiName}.`;
  const queried = await runGraphQuery(ctx.graph, {
    select: 'edges',
    where: [
      { column: 'edgeType', op: '=', value: 'writesTo' },
      { column: 'toId', op: 'LIKE', value: `${fieldPrefix}%` },
    ],
    limit: QUERY_GRAPH_MAX_LIMIT,
  });
  if (!queried.ok) return err(queried.error.message);

  interface WriterBucket {
    readonly fieldId: ComponentId;
    readonly scanned: Set<string>;
    readonly external: Map<string, ConfidenceLevel>;
  }
  const buckets = new Map<string, WriterBucket>();
  for (const row of queried.value.rows) {
    const writeEdge = row as Edge;
    // The LIKE pattern is a superset (see JSDoc) — the exact prefix decides.
    if (!writeEdge.toId.startsWith(fieldPrefix)) continue;
    // Same parse-artifact filter the scanned path applies, so a `this.x`
    // receiver never reads as a real field write on either side.
    if (isUnresolvedFieldReceiver(writeEdge.toId)) continue;
    const bucket =
      buckets.get(writeEdge.toId) ??
      ({
        fieldId: writeEdge.toId,
        scanned: new Set<string>(),
        external: new Map<string, ConfidenceLevel>(),
      } satisfies WriterBucket);
    // R3 self-match: a scanned firer is NEVER its own external writer.
    if (scannedFirerIds.has(writeEdge.fromId)) {
      bucket.scanned.add(writeEdge.fromId);
    } else {
      const seen = bucket.external.get(writeEdge.fromId);
      bucket.external.set(
        writeEdge.fromId,
        seen === undefined ? writeEdge.confidence : weaker(seen, writeEdge.confidence),
      );
    }
    buckets.set(writeEdge.toId, bucket);
  }

  const nodeCache = new Map<string, Node | null>();
  const distinctExternal = new Set<string>();
  const fields: ExternalWriterField[] = [];
  let multiWriterFields = 0;
  for (const bucket of buckets.values()) {
    if (bucket.scanned.size + bucket.external.size >= 2) multiWriterFields += 1;
    if (bucket.external.size === 0) continue;
    const writers: ExternalWriter[] = [];
    for (const [writerId, confidence] of bucket.external) {
      distinctExternal.add(writerId);
      let writerNode = nodeCache.get(writerId);
      if (writerNode === undefined) {
        const nodeResult = await getNodeById(ctx.graph, writerId as ComponentId);
        // A graph read that FAILED is never a clean "not modeled" — fail loud.
        if (!nodeResult.ok) return err(nodeResult.error.message);
        writerNode = nodeResult.value;
        nodeCache.set(writerId, writerNode);
      }
      writers.push({
        componentId: writerId as ComponentId,
        componentType: writerNode?.type ?? 'unknown',
        confidence,
        activation: activationOf(writerNode),
        testOnly: writerNode?.properties['isTest'] === true,
      });
    }
    writers.sort(byComponentId);
    fields.push({
      fieldId: bucket.fieldId,
      fieldApiName: bucket.fieldId.startsWith(fieldPrefix)
        ? bucket.fieldId.slice(fieldPrefix.length)
        : bucket.fieldId,
      scannedWriterCount: bucket.scanned.size,
      externalWriterCount: bucket.external.size,
      totalWriterCount: bucket.scanned.size + bucket.external.size,
      writers,
    });
  }
  // Most-contended field first, then a stable name order.
  fields.sort((a, b) =>
    a.totalWriterCount !== b.totalWriterCount
      ? b.totalWriterCount - a.totalWriterCount
      : a.fieldApiName < b.fieldApiName
        ? -1
        : a.fieldApiName > b.fieldApiName
          ? 1
          : 0,
  );

  return ok({
    fields,
    writerCount: distinctExternal.size,
    fieldsWithMultipleWritersAnySource: multiWriterFields,
    complete: !queried.value.hasMore,
    edgesRead: queried.value.returnedCount,
    edgesMatched: queried.value.totalCount,
  });
};

const collisionSeverity = (
  activeWriterCount: number,
  weakestConfidence: ConfidenceLevel,
): FieldCollision['severity'] => {
  if (activeWriterCount >= 2) return weakestConfidence === 'heuristic' ? 'medium' : 'high';
  if (activeWriterCount === 1) return 'medium'; // a dormant writer would collide if reactivated
  return 'info'; // every contributing writer is inactive today
};

const cycleSeverity = (
  allActive: boolean,
  weakestConfidence: ConfidenceLevel,
): RecursionCycle['severity'] => {
  if (!allActive) return 'info'; // the loop cannot fire until every hop is reactivated
  return weakestConfidence === 'heuristic' ? 'medium' : 'high';
};

const collisionSort = (a: FieldCollision, b: FieldCollision): number => {
  const rank = (c: FieldCollision): number => (c.severity === 'high' ? 0 : c.severity === 'medium' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.fieldApiName !== b.fieldApiName) return a.fieldApiName < b.fieldApiName ? -1 : 1;
  // Deterministic tiebreaker when the same field collides on BOTH paths.
  return a.collisionPath < b.collisionPath ? -1 : a.collisionPath > b.collisionPath ? 1 : 0;
};

const cycleSort = (a: RecursionCycle, b: RecursionCycle): number => {
  const rank = (c: RecursionCycle): number => (c.severity === 'high' ? 0 : c.severity === 'medium' ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  const aKey = a.path[0]?.automationId ?? '';
  const bKey = b.path[0]?.automationId ?? '';
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
};

/**
 * Bounded BFS from `originObject` over `triggersOn` -> `writesTo` edges,
 * looking for a field-write path that returns to `originObject`. Depth
 * capped at {@link CYCLE_DEPTH_CAP} hops; a same-object write from a
 * BEFORE-save firer is excluded (folds into the pending save), and a
 * before-DELETE firer is skipped entirely (it runs on the DELETE path, not the
 * save order-of-execution this walk models — see module JSDoc). Defensively
 * capped at {@link CYCLE_EXPLORE_CAP} firer expansions so a densely-automated
 * org cannot make one call scan unboundedly.
 */
const findRecursionCycles = async (
  ctx: Context,
  originObject: string,
  originFirers: readonly FirerDescriptor[],
): Promise<Result<{ readonly cycles: readonly RecursionCycle[]; readonly exploreCapHit: boolean }, string>> => {
  const cycles: RecursionCycle[] = [];
  const seenCycleKeys = new Set<string>();
  const firerCache = new Map<string, readonly FirerDescriptor[]>([[originObject, originFirers]]);
  let explored = 0;
  let capHit = false;

  interface QueueItem {
    readonly currentObject: string;
    readonly path: readonly RecursionHop[];
  }
  const queue: QueueItem[] = [{ currentObject: originObject, path: [] }];

  while (queue.length > 0 && !capHit) {
    const item = queue.shift();
    if (item === undefined) break;
    if (item.path.length >= CYCLE_DEPTH_CAP) continue;

    let firers = firerCache.get(item.currentObject);
    if (firers === undefined) {
      const firersResult = await gatherFirersForObject(ctx, item.currentObject);
      if (!firersResult.ok) return err(firersResult.error);
      firers = firersResult.value;
      firerCache.set(item.currentObject, firers);
    }

    for (const firer of firers) {
      // A before-DELETE firer runs on the DELETE path, not the save
      // order-of-execution this walk models — its writes never form a
      // save-recursion hop (neither a re-entrant same-object save nor a
      // save-order chain), so it is skipped entirely. This keeps before-delete
      // its own context: a delete-path write is never chained into a
      // save-recursion cycle. (Two before-delete Flows writing one field are a
      // delete-path COLLISION, surfaced in `collisions[]`, not a cycle.)
      if (firer.timing === 'before-delete') continue;
      if (explored >= CYCLE_EXPLORE_CAP) {
        capHit = true;
        break;
      }
      explored += 1;
      const writesResult = await gatherFieldWritesForFirer(ctx, firer.id);
      if (!writesResult.ok) return err(writesResult.error);

      // A record-variable whole-record write is a hop this walk CANNOT take —
      // it has no field id to chain by. The origin object's own unresolved
      // writes are reported to the caller from the handler (they are the ones
      // that also blind `collisions`); deeper ones are covered by the standing
      // boundary sentence rather than a per-hop row, because a row naming an
      // object the caller never asked about is noise, not disclosure.
      for (const write of writesResult.value.fieldWrites) {
        const targetObject = objectOfFieldId(write.toId);
        if (targetObject === null) continue;
        const sameObjectHop = targetObject === item.currentObject;
        // A before-save write to $Record folds into the single pending save —
        // it never causes a second, re-entrant save of the same object.
        if (sameObjectHop && firer.timing === 'before') continue;

        const hop: RecursionHop = {
          automationId: firer.id,
          automationType: firer.type,
          fromObject: item.currentObject,
          toObject: targetObject,
          fieldId: write.toId,
          active: firer.active,
          confidence: write.confidence,
        };
        const newPath = [...item.path, hop];

        if (targetObject === originObject) {
          const key = newPath.map((h) => `${h.automationId}>${h.fieldId}`).join('|');
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            const allActive = newPath.every((h) => h.active);
            const weakestConf = newPath.reduce<ConfidenceLevel>(
              (acc, h) => weaker(acc, h.confidence),
              'declared',
            );
            cycles.push({
              kind: newPath.length === 1 ? 'self-write' : 'multi-object',
              path: newPath,
              weakestConfidence: weakestConf,
              allActive,
              severity: cycleSeverity(allActive, weakestConf),
            });
          }
          // Don't extend past a closed loop — further hops from the origin
          // are already explored as fresh queue entries from the top.
          continue;
        }
        queue.push({ currentObject: targetObject, path: newPath });
      }
    }
  }

  return ok({ cycles, exploreCapHit: capHit });
};

const STATIC_BOUNDARIES: readonly string[] = Object.freeze([
  'Every listed automation is a real vault node reached via `triggersOn` / `writesTo` edges — not a fabricated execution trace. Field-update and entry CONDITIONS on Flows, WorkflowRules, and ApexTriggers are NOT evaluated: two writers with mutually exclusive criteria are still listed as a collision.',
  'Field-write collisions are partitioned by EXECUTION PATH (`collisionPath`): save-timing writers (before-save / after-save Flow or trigger, post-save WorkflowRule) collide with one another on the SAVE path, while a before-delete Flow runs on the DELETE path and collides ONLY with another before-delete Flow. A before-delete Flow is NEVER reported as colliding with a save-timing writer — a `collisionPath: "delete"` finding is a DELETE-path collision, never a save collision.',
  'Confidence varies per writer: a Flow or WorkflowRule field write that names its field in the XML (`<inputAssignments>`, a workflow field update) is `parsed`; ApexTrigger writes are `heuristic` static analysis (regex/AST field-access scanning) that may include false positives or miss dynamic/reflective writes. Every collision and cycle finding carries the WEAKEST confidence among its contributing writers. NOT every Flow field write names its field: a Flow that assigns fields into an SObject VARIABLE and commits it with a bare `<inputReference>` (a record-variable DML, no `<inputAssignments>`) writes real fields that are NOT enumerable offline — the vault marks that edge `fieldsEnumerable: false` — those writers are absent from `collisions` and `cycles` by construction and are listed instead in `unenumerableFieldWrites`, with `summary.fieldWriteCoverage` reading `partial` whenever any exist on this object.',
  'SCAN SCOPE — `collisions` and `cycles` cover ONLY automation wired directly via `triggersOn` on this object (record-triggered Flow, ApexTrigger, WorkflowRule). EVERY other writer is outside them: an Apex class called from any trigger or invoked by a Flow, a Flow or trigger record-triggered on a DIFFERENT object that writes this one, an ApprovalProcess field update, a batch/queueable job. `summary.fieldsWithMultipleWriters` therefore counts multi-writer fields WITHIN that scanned subset — it is a property of the subset, not of the object. The `externalWriters[]` sweep reads every `writesTo` edge landing on a field of this object and names the writers that subset cannot see; `summary.fieldsWithMultipleWritersAnySource` is the object-wide count.',
  '`collisionsTruncated` / `cyclesTruncated` describe LIST LENGTH ONLY — whether this response cut rows it had already found. Neither is a statement about scan coverage: `false` never means "everything that writes this object was examined". Read `summary.externalWriterCount`, `summary.externalWriterSweepComplete` and `summary.fieldWriteCoverage` for that.',
  `Recursion cycles are a BOUNDED graph walk: depth capped at ${CYCLE_DEPTH_CAP} hops from the queried object, and at most ${CYCLE_EXPLORE_CAP} automation expansions. Salesforce's own recursion guards — a record-triggered Flow's "do not re-trigger the flow that started this update" setting, and the platform's workflow-rule re-evaluation limits — are NOT captured by the extractors and are NOT evaluated here. A listed cycle is a POTENTIAL loop the org's structure allows, not proof it fires at runtime.`,
  'A same-object write from a BEFORE-save automation (before-trigger, before-save Flow) is excluded from cycle detection — it modifies the record before the single pending INSERT/UPDATE rather than causing a second save. A before-DELETE Flow is excluded from cycle detection entirely: it runs on the DELETE path, not the save order-of-execution, so it is never a save-recursion hop. Only AFTER-trigger / after-save-Flow / post-save-workflow writes back to the same object are flagged as potential recursion.',
]);

/**
 * The `sfi.automation_collisions` MCP tool. See module JSDoc for the
 * composition and honesty axis.
 *
 * @example
 *   const r = await automationCollisionsHandler(ctx, { object: 'Account' });
 *   if (r.ok) for (const c of r.value.data.collisions) console.log(c.fieldApiName, c.writers);
 */
export const automationCollisionsHandler = async (
  ctx: Context,
  input: AutomationCollisionsInput,
): Promise<Result<McpResponse<AutomationCollisionsOutput>, McpError>> => {
  // L2 Alias OS: resolve the object from any of object / objectApiName /
  // objectId / CustomObject: componentId. Disagreeing aliases -> invalid-query.
  //
  // `resolveObjectAliasInVault` — resolveObjectAlias + `canonicalizeObjectScope`
  // — rather than the bare sync resolver, so the id is rewritten to the VAULT's
  // exact casing. Salesforce api names are case-insensitive, and the sync
  // resolver built `CustomObject:collide__c` from a lower-cased request, which
  // `gatherFirersForObject` then matched exactly and found nothing: a real
  // object typed in the wrong case used to come back as a clean "no collisions
  // on this object". Two objects differing ONLY by case are refused, never
  // silently picked (case-insensitive RESOLUTION, never case-insensitive
  // IDENTITY).
  //
  // Deliberately NOT `resolveExistingObjectScope`, the sibling tools' resolver:
  // it refuses any object with no `CustomObject:` node, and this tool can
  // legitimately answer for one that has none — a standard object whose
  // automation the refresh retrieved and whose own metadata it did not is
  // reachable through `triggersOn` edges alone. `canonicalizeObjectScope`
  // documents exactly that split ("some answer from edges when the object has
  // no node of its own"), leaving the existence verdict to the caller. This
  // tool's verdict is taken below, once BOTH the node lookup and the firer
  // gather have run.
  const scopeResult = await resolveObjectAliasInVault(ctx.graph, input, {
    required: true,
    bareComponentIdIsObject: true,
    unhandledPrefix: 'refuse',
  });
  if (!scopeResult.ok) return err(scopeResult.error);
  if (scopeResult.value === null) {
    return err({
      kind: 'invalid-query',
      message:
        'name the object — pass `object`, `objectApiName`, `objectId`, or a `CustomObject:` `componentId`',
      path: 'object',
    });
  }
  const objectApiName = scopeResult.value.object;
  const objectId = scopeResult.value.componentId as ComponentId;
  const appliedScope = {
    componentId: scopeResult.value.componentId,
    object: objectApiName,
  };

  const objNodeResult = await getNodeById(ctx.graph, objectId);
  if (!objNodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${objNodeResult.error.message}` });
  }

  const firersResult = await gatherFirersForObject(ctx, objectApiName);
  if (!firersResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${firersResult.error}` });
  }
  const firers = firersResult.value;

  // AUTOMATION-COLLISIONS-ANSWERS-FOR-AN-OBJECT-IT-NEVER-FOUND. An object the
  // vault holds in NEITHER form — no `CustomObject:` node AND no `triggersOn`
  // edge pointing at it — was not checked, and saying so is the only honest
  // answer. What a caller saw before: `ok`, `collisions: []`, `cycles: []`,
  // `automationsScanned: 0` and the full six-item `boundaries` block, i.e. the
  // confident report shape, in answer to "what already fights over this
  // object?". On a "what will break" tool an empty answer reads as "nothing
  // will". The only disclosure was `objectModeled: false`, a flag this tool's
  // MCP description never mentions, so no host had reason to consult it: "there
  // is no such object" and "this object's automation does not collide" came
  // back indistinguishable. That is the UNCHECKED zero wearing a CHECKED zero's
  // clothes the 0.3.2 changelog closed on `sfi.unused_fields_deep`.
  //
  // The gate is edges-OR-node on purpose. Refusing on the node alone would trade
  // this silent wrong answer for a loud one on every standard object whose
  // automation was retrieved while its own metadata was not — a real capability
  // the `objectModeled` flag was written to support.
  if (objNodeResult.value === null && firers.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        `no object named '${objectApiName}' exists in this vault (resolved to ${objectId}): ` +
        'it has no CustomObject node and no automation triggers on it. Refusing rather than ' +
        'returning an empty collision report, which reads as "nothing here collides" — verify ' +
        'the object api name, or run /sfi-refresh if the vault may be stale.',
      path: 'object',
    });
  }

  // Unchanged: "the vault holds this object in SOME form". Past the gate above
  // it is always true, because its false case is now a refusal — kept, and kept
  // with this exact meaning, because `automation_build_advisor` publishes the
  // same `objectModeled` key over the same firer set and was gated the same way
  // in this release. Narrowing it here to "has a CustomObject node" would make
  // two sibling tools answer "is this object modeled?" differently about the
  // same object, which is the drift this repo keeps paying for.
  //
  // The narrower fact — the object was reached through its automation's edges
  // while its OWN metadata was never retrieved — is real and still worth
  // saying, so it is disclosed in `boundaries` below, where this tool puts its
  // honesty, rather than by overloading a shared key.
  const objectModeled = objNodeResult.value !== null || firers.length > 0;
  const objectNodeRetrieved = objNodeResult.value !== null;

  // --- Field-level write collisions (same-object writes only) ---
  // Writers are bucketed by (execution PATH, field): a before-delete Flow runs
  // on the DELETE path and can NEVER race a save-timing writer, so it collides
  // ONLY with another before-delete Flow on the same field — never with a
  // save-timing (before-save / after-save / post-save) writer. Two before-delete
  // Flows writing one field DO collide (undefined delete-path order); a
  // before-delete + a save writer do not. Folding the two paths together (the
  // pre-fix behaviour) fabricated false "save collisions".
  interface FieldWriterBucket {
    readonly path: CollisionPath;
    readonly fieldId: ComponentId;
    readonly writers: AutomationWriter[];
  }
  const fieldWriters = new Map<string, FieldWriterBucket>();
  // Writes the vault records but cannot resolve to a field name. Collected in
  // the SAME pass as the collision buckets so the two can never disagree about
  // which firers were examined.
  const allUnenumerable: UnenumerableFieldWrite[] = [];
  for (const firer of firers) {
    const writesResult = await gatherFieldWritesForFirer(ctx, firer.id);
    if (!writesResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${writesResult.error}` });
    }
    const path = pathOfTiming(firer.timing);
    for (const unresolved of writesResult.value.unenumerable) {
      allUnenumerable.push({
        automationId: firer.id,
        automationType: firer.type,
        fromObject: objectApiName,
        toObject: unresolved.toObject,
        onQueriedObject: unresolved.toObject === objectApiName,
        operation: unresolved.operation,
        inputReference: unresolved.inputReference,
        active: firer.active,
        timing: firer.timing,
        collisionPath: path,
        confidence: unresolved.confidence,
      });
    }
    for (const write of writesResult.value.fieldWrites) {
      if (objectOfFieldId(write.toId) !== objectApiName) continue;
      const key = `${path}\u0000${write.toId}`;
      const bucket = fieldWriters.get(key) ?? { path, fieldId: write.toId, writers: [] };
      if (!bucket.writers.some((w) => w.componentId === firer.id)) {
        bucket.writers.push({
          componentId: firer.id,
          componentType: firer.type,
          active: firer.active,
          confidence: write.confidence,
          timing: firer.timing,
        });
      }
      fieldWriters.set(key, bucket);
    }
  }

  const fieldPrefix = `CustomField:${objectApiName}.`;
  const allCollisions: FieldCollision[] = [];
  for (const bucket of fieldWriters.values()) {
    if (bucket.writers.length < 2) continue;
    const sortedWriters = [...bucket.writers].sort(byComponentId);
    const weakestConfidence = sortedWriters.reduce<ConfidenceLevel>(
      (acc, w) => weaker(acc, w.confidence),
      'declared',
    );
    const activeWriterCount = sortedWriters.filter((w) => w.active).length;
    allCollisions.push({
      fieldId: bucket.fieldId,
      fieldApiName: bucket.fieldId.startsWith(fieldPrefix)
        ? bucket.fieldId.slice(fieldPrefix.length)
        : bucket.fieldId,
      collisionPath: bucket.path,
      writers: sortedWriters,
      activeWriterCount,
      weakestConfidence,
      severity: collisionSeverity(activeWriterCount, weakestConfidence),
    });
  }
  allCollisions.sort(collisionSort);

  // --- Who ELSE writes this object's fields (the triggersOn scan cannot see) ---
  // Runs for every answer, including the ones with zero collisions: a zero is
  // only worth publishing next to what was not looked at.
  const externalResult = await gatherExternalFieldWriters(
    ctx,
    objectApiName,
    new Set(firers.map((f) => f.id)),
  );
  if (!externalResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${externalResult.error}` });
  }
  const externalSweep = externalResult.value;

  // Deterministic order: writes onto the QUERIED object first (they are the
  // ones that blind `collisions`), then by automation, then by target object.
  allUnenumerable.sort((a, b) => {
    if (a.onQueriedObject !== b.onQueriedObject) return a.onQueriedObject ? -1 : 1;
    if (a.automationId !== b.automationId) return a.automationId < b.automationId ? -1 : 1;
    return a.toObject < b.toObject ? -1 : a.toObject > b.toObject ? 1 : 0;
  });

  // --- Save-recursion cycles ---
  const cyclesResult = await findRecursionCycles(ctx, objectApiName, firers);
  if (!cyclesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${cyclesResult.error}` });
  }
  const allCycles = [...cyclesResult.value.cycles].sort(cycleSort);

  // --- Byte-budget + limit the two findings lists (CR-22 `paginate`, no
  // resumable cursor exposed — this tool's input contract is intentionally
  // just `{ object, limit }`; a truncated list tells the caller to narrow the
  // object or raise `limit` rather than page with a cursor). ---
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const binding: PaginateBinding = {
    tool: TOOL_NAME,
    vaultHash: ctx.manifest.sourceTreeHash,
    argsFingerprint: argsFingerprint({ object: objectApiName }),
  };
  // ONE budget across BOTH lists (see `listsByteBudget`). `collisions` is paged
  // against half of it — a floor, so a fat collisions list can never starve
  // `cycles` to nothing — and `cycles` then claims the WHOLE remainder,
  // reclaiming whatever `collisions` left unspent. Both pages together are
  // therefore under the shared budget by construction, so the global
  // `jsonResult` guard has nothing left to tail-trim behind a `truncated: false`.
  const sharedBudget = listsByteBudget();
  // `unenumerableFieldWrites` is paged FIRST and off a small dedicated slice.
  // It is the list that says the other two are incomplete, so it must never be
  // the one a fat findings list squeezes out of the envelope — a disclosure
  // that disappears exactly when there is most to disclose is worse than none.
  const unenumerablePage = paginate(allUnenumerable, {
    limit,
    binding,
    byteBudget: Math.max(1_000, Math.floor(sharedBudget / 4)),
  });
  const unenumerableBytes = Buffer.byteLength(JSON.stringify(unenumerablePage.items), 'utf8');
  // `externalWriters` is paged next, off a third of what is left. It is the
  // other list that says `collisions` is a subset rather than the answer, so
  // like `unenumerableFieldWrites` it must not be the list a fat findings page
  // squeezes out of the envelope.
  const disclosureBudget = Math.max(2_000, sharedBudget - unenumerableBytes);
  const externalPage = paginate(externalSweep.fields, {
    limit,
    binding,
    byteBudget: Math.max(1_000, Math.floor(disclosureBudget / 3)),
  });
  const externalBytes = Buffer.byteLength(JSON.stringify(externalPage.items), 'utf8');
  const findingsBudget = Math.max(2_000, disclosureBudget - externalBytes);
  const collisionsPage = paginate(allCollisions, {
    limit,
    binding,
    byteBudget: Math.max(1_000, Math.floor(findingsBudget / 2)),
  });
  const collisionsBytes = Buffer.byteLength(JSON.stringify(collisionsPage.items), 'utf8');
  const cyclesPage = paginate(allCycles, {
    limit,
    binding,
    byteBudget: Math.max(1_000, findingsBudget - collisionsBytes),
  });
  const collisionsTruncated = collisionsPage.pageInfo.hasMore || collisionsPage.byteTrimmed;
  const cyclesTruncated = cyclesPage.pageInfo.hasMore || cyclesPage.byteTrimmed;
  const unenumerableTruncated =
    unenumerablePage.pageInfo.hasMore || unenumerablePage.byteTrimmed;
  const externalWritersTruncated = externalPage.pageInfo.hasMore || externalPage.byteTrimmed;

  const boundaries: string[] = [...STATIC_BOUNDARIES];
  if (!objectNodeRetrieved) {
    boundaries.push(
      `'${objectApiName}' has NO CustomObject node in this vault — it was reached only through the \`triggersOn\` edges of the automation that fires on it, so its own metadata (fields, sharing model, record types) was not retrieved. The collisions and cycles below are real edges; a field this report does not name may simply be one the vault never modeled. Include the object in the next \`/sfi-refresh\` before reading any absence here as "nothing else writes it".`,
    );
  }
  if (cyclesResult.value.exploreCapHit) {
    boundaries.push(
      `The recursion walk hit its defensive ${CYCLE_EXPLORE_CAP}-expansion cap before exhausting every path on this densely-automated object graph — some longer or more branching cycles may exist beyond what is listed.`,
    );
  }
  if (collisionsTruncated) {
    boundaries.push(truncationNote('Collisions', 'fields', collisionsPage, allCollisions.length));
  }
  if (cyclesTruncated) {
    boundaries.push(truncationNote('Cycles', 'cycles', cyclesPage, allCycles.length));
  }
  if (allUnenumerable.length > 0) {
    const onObject = allUnenumerable.filter((u) => u.onQueriedObject).length;
    const offObject = allUnenumerable.length - onObject;
    const flowCount = new Set(allUnenumerable.map((u) => u.automationId)).size;
    boundaries.push(
      `FIELD-WRITE COVERAGE IS PARTIAL on this object (\`summary.fieldWriteCoverage: "partial"\`). ` +
        `${flowCount} of the ${firers.length} scanned automation(s) commit a record VARIABLE ` +
        '(`<inputReference>` with no `<inputAssignments>`), so the vault marks that write ' +
        '`fieldsEnumerable: false` and holds NO field-level edge for it. ' +
        `${onObject} such write(s) land on this object and ${offObject} on another; every one is ` +
        'listed in `unenumerableFieldWrites` with the Flow and the variable it commits. Those ' +
        'writers CANNOT appear in `collisions` or `cycles` — there is no field name to group or ' +
        'chain them by — so both lists are a LOWER BOUND here and an empty `collisions` is NOT ' +
        'proof that nothing fights over a field. Open the named Flow(s) and read the ' +
        '`<assignToReference>` targets on the committed variable to close the gap by hand.',
    );
  }
  if (externalSweep.writerCount > 0) {
    const liveExternal = new Set(
      externalSweep.fields.flatMap((f) =>
        f.writers.filter((w) => w.activation !== 'inactive' && !w.testOnly).map((w) => w.componentId),
      ),
    ).size;
    boundaries.push(
      `${externalSweep.writerCount} component(s) write a field on '${objectApiName}' WITHOUT being wired via \`triggersOn\` on it — across ${externalSweep.fields.length} field(s), ${liveExternal} of them neither inactive nor test-only. They are listed in \`externalWriters\` and are NOT in \`collisions\` or \`cycles\`, which cover only the ${firers.length} automation(s) in \`automationsScanned\`. ` +
        `\`fieldsWithMultipleWriters: ${allCollisions.length}\` is a property of that scanned subset; counting every writer the vault records, ${externalSweep.fieldsWithMultipleWritersAnySource} field(s) on this object already have 2+ DISTINCT writers (\`summary.fieldsWithMultipleWritersAnySource\`). ` +
        'Their firing TIMING and execution PATH are not modeled — they do not trigger on this object — so this tool cannot say whether one races a scanned writer, only that the field is already written from more than one place. Run `sfi.why_field_changed` on a named field for every writer with its runnability before adding another one.',
    );
  } else if (externalSweep.complete) {
    // The zero is only a CHECKED zero when the sweep actually reached the end
    // of the edge list. A sweep cut by the query ceiling that happened to find
    // no outside writer takes the branch below instead — claiming a checked
    // zero over a partial read is the exact failure this whole change exists
    // to close.
    boundaries.push(
      `Every \`writesTo\` edge landing on a field of '${objectApiName}' was read (${externalSweep.edgesRead} edge(s)): no component outside the ${firers.length} automation(s) scanned above writes a field on this object. This zero is a CHECKED zero, not an unexamined one.`,
    );
  }
  if (!externalSweep.complete) {
    boundaries.push(
      `The external-writer sweep read ${externalSweep.edgesRead} of the ${externalSweep.edgesMatched} \`writesTo\` edges landing on this object's fields (query ceiling ${QUERY_GRAPH_MAX_LIMIT}), so \`externalWriterCount: ${externalSweep.writerCount}\` and \`fieldsWithMultipleWritersAnySource: ${externalSweep.fieldsWithMultipleWritersAnySource}\` are FLOORS, not totals — a field this report does not name may still have an outside writer, and a ZERO here is NOT a checked zero.`,
    );
  }
  if (externalWritersTruncated) {
    boundaries.push(
      truncationNote('External writers', 'fields', externalPage, externalSweep.fields.length),
    );
  }
  if (unenumerableTruncated) {
    boundaries.push(
      truncationNote(
        'Unenumerable field writes',
        'writes',
        unenumerablePage,
        allUnenumerable.length,
      ),
    );
  }

  return ok({
    data: {
      object: objectApiName,
      appliedScope,
      objectModeled,
      collisions: collisionsPage.items,
      cycles: cyclesPage.items,
      unenumerableFieldWrites: unenumerablePage.items,
      externalWriters: externalPage.items,
      summary: {
        automationsScanned: firers.length,
        fieldsWithMultipleWriters: allCollisions.length,
        cyclesFound: allCycles.length,
        collisionsTruncated,
        cyclesTruncated,
        unenumerableFieldWriteCount: allUnenumerable.length,
        unenumerableFieldWritesTruncated: unenumerableTruncated,
        fieldWriteCoverage: allUnenumerable.length > 0 ? 'partial' : 'complete',
        externalWriterCount: externalSweep.writerCount,
        fieldsWithExternalWriters: externalSweep.fields.length,
        fieldsWithMultipleWritersAnySource: externalSweep.fieldsWithMultipleWritersAnySource,
        externalWritersTruncated,
        externalWriterSweepComplete: externalSweep.complete,
      },
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
