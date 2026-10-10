/**
 * Handler for the `sfi.why_field_changed` MCP tool.
 *
 * v2.0e W1 — the field-write-tracing headline. Answers the buyer-
 * priority #1 question: "why did this field get updated?". Walks every
 * incoming `writesTo` edge to the target CustomField and surfaces each
 * writer with its categorisation (declared vs heuristic), the
 * `firesWhen` ConditionalContext gating the write (when one exists),
 * and the trigger event when the writer is an ApexTrigger.
 * Workflow field updates that set the field but that no rule or approval
 * process fires are listed apart (`unreferencedFieldUpdates`), never as writers.
 *
 * Writer categorisation:
 *   - **declared** writers: producers whose metadata declaration IS
 *     the write contract — Flow recordCreates/Updates (`writesTo` at
 *     `declared` confidence), WorkflowRule field-update actions
 *     (`writesTo` at `declared` confidence), and ApprovalProcess
 *     actions. The platform will refuse to deploy these without the
 *     target field.
 *   - **heuristic** writers: producers whose write was inferred from
 *     a source scan rather than a metadata declaration — ApexClass /
 *     ApexTrigger writes emitted by the v0.3 Apex scanner with
 *     `source: 'apex-scanner'` and `confidence: 'heuristic'`. These
 *     may include false positives (dynamic SOQL, reflective access);
 *     callers should spot-check before acting on them.
 *
 * Implementation notes:
 *   - One `listEdges(fieldId, { direction: 'in', edgeType: 'writesTo' })`
 *     call retrieves every candidate edge; `getNodeById` resolves each
 *     `fromId` to a writer node. Sparse-graph misses are dropped
 *     silently (matches `safe-to-delete-field`'s tolerance).
 *   - For each writer, the handler fetches the writer's outgoing
 *     `firesWhen` ConditionalContext (when one exists) to expose the
 *     gating condition. Multi-condition writers (a Flow with several
 *     decisions, a WorkflowRule whose condition is a formula) surface
 *     their FIRST condition — callers wanting the full list re-query
 *     via `sfi.get_edges`.
 *   - For ApexTrigger writers, the handler ALSO fetches the trigger's
 *     `events` property and surfaces it on the writer entry. Apex
 *     scanner emits writes from triggers without per-event scoping,
 *     so the trigger's overall event list IS the per-write event
 *     surface.
 *   - The honesty axis is the categorisation itself: `declared`
 *     writers are deterministic; `heuristic` writers are flagged so
 *     the caller can show the confidence boundary to the user.
 *   - **Field scope resolution** (WHY-FIELD-CHANGED-REJECTS-COMPONENTID):
 *     the tool traces exactly ONE field. The field is named via
 *     `fieldId`, a `componentId` (`CustomField:{Object}.{Field}` → that
 *     field; `CustomObject:{Object}` → that object, which scopes the
 *     resolution but is NOT a field on its own), or `objectApiName` +
 *     `fieldApiName`. Aliases route through `resolveWhyFieldScope`
 *     (mirroring `governor_limit_risks.resolveScopeId` and the
 *     `input-aliases.ts` `resolveObjectAlias`/`resolveFieldAlias`
 *     resolvers). A `componentId` that names an object with no field, a
 *     non-CustomField/-CustomObject prefix, or disagreeing aliases is a
 *     NAMED `invalid-query` — the tool NEVER silently strips the scope
 *     nor falls back to an org-wide answer. `appliedScope` echoes the
 *     resolved field, and is emitted ONLY when a scope alias
 *     (`componentId`/`objectApiName`/`fieldApiName`) was passed, so a
 *     bare `{ fieldId }` call stays byte-identical to the prior shape.
 */

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import {
  edgeLiteralValues,
  edgeReferenceValues,
  edgeValueKinds,
  edgeValueTiming,
  err,
  ok,
  type Result,
  type WriteValueTiming,
} from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { dlrsRollupWriterDetail, type DlrsRollupWriterDetail } from './dlrs-rollup-writers.js';
import {
  classifyWriteForValue,
  flowSourceMaySetReason,
  literalEqualsValue,
  resolveFieldValue,
  type ResolvedFieldValue,
  type WriteValueEvidence,
} from './field-value-filter.js';
import {
  scanSupplementalFlowFieldWriters,
  type SupplementalFlowFieldWriter,
} from './flow-field-writers-scan.js';
import {
  firstNonEmpty,
  parseFieldParentObjectApiName,
  toObjectApiName,
} from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { isActiveSoeFirer } from './soe-active.js';
import { classifyAfterSaveFlowTiming } from './soe-flow-timing.js';
import {
  findUnreferencedFieldUpdates,
  UNREFERENCED_FIELD_UPDATES_NOTE,
  type UnreferencedFieldUpdate,
} from './unreferenced-field-updates.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/**
 * The verbatim honesty-axis disclosure surfaced in every response.
 * Frozen here so the test suite can assert the exact string and so a
 * caller-facing rephrasing during rendering is a code-review concern,
 * not a silent drift.
 */
const DISCLOSURE =
  "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Each writer carries a runnable flag and its declared status: a non-Active Flow (Obsolete/Draft/Inactive/InvalidDraft), an Inactive trigger, an inactive rule, or a TEST class (isTest, status:test-only) is listed with runnable:false and could NOT have written the field in the org's current production state — it is never the sole live suspect. Active-Flow field writes made via an SObject-variable assignment (assignToReference) that the graph did not stamp as a primary writesTo edge are folded in from a supplemental source scan at heuristic confidence (source: flow-field-writers-scan:*); that scan pages EVERY Flow in the vault, and when it stops short (residual ceiling SFI_FLOW_WRITER_SCAN_MAX, or a graph error) supplementalScanTruncation names how many Flows were scanned of how many exist, so an un-scanned writer reads as not checked rather than absent. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.";

/**
 * Zod schema for the `sfi.why_field_changed` tool input. The tool traces ONE
 * field; the field is named via any of the interchangeable identifiers a
 * router / host reaches for (L2 Alias OS — WHY-FIELD-CHANGED-REJECTS-COMPONENTID):
 *
 *   - `fieldId`: the canonical CustomField id (`CustomField:{Object}.{Field}`)
 *     or a bare `<Object>.<Field>` short form. Non-CustomField prefixes surface
 *     as `invalid-query` from the handler; unknown but well-formed ids surface
 *     as `component-not-found`.
 *   - `componentId`: alias — a `CustomField:` id resolves to that field; a
 *     `CustomObject:` id (or a bare object name) scopes the object but must be
 *     paired with a field; any other `Type:` prefix is `invalid-query`.
 *   - `objectApiName` + `fieldApiName`: the object/field pair a support host
 *     splits the ask into. `fieldApiName` also accepts a dotted `<Object>.<Field>`.
 *
 * At least one identifier is required; an object with no field, or disagreeing
 * aliases, is a NAMED `invalid-query` — never a silent org-wide fallback.
 */
export const whyFieldChangedInputSchema = z
  .object({
    fieldId: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    objectApiName: z.string().min(1).optional(),
    fieldApiName: z.string().min(1).optional(),
    /**
     * Optional: "what sets it to X?" Picklist values are checked against the
     * value set (case-insensitive); checkboxes take true/false. `valueFilter`
     * groups writers into definitelySets / maySet (why) / cannotSet; cannotSet
     * writers are dropped from `writers`.
     */
    value: z.string().min(1).optional(),
  })
  .refine(
    (i) =>
      i.fieldId !== undefined ||
      i.componentId !== undefined ||
      i.objectApiName !== undefined ||
      i.fieldApiName !== undefined,
    {
      message:
        'name the field — pass `fieldId`, a `CustomField:{Object}.{Field}` `componentId`, or `objectApiName` + `fieldApiName`',
      path: ['fieldId'],
    },
  );

/** Parsed input shape, inferred from `whyFieldChangedInputSchema`. */
export type WhyFieldChangedInput = z.infer<typeof whyFieldChangedInputSchema>;

/**
 * One writer's condition reference. Carries the synthetic
 * ConditionalContext id and the parsed expression — the scalar fast-
 * path that lets a caller render "WorkflowRule X writes to this field
 * WHEN (Type = 'Tier 1')" without an extra graph traversal.
 */
export interface WhyFieldChangedCondition {
  readonly conditionContextId: ComponentId;
  readonly expression: string;
  /**
   * Record-triggered entry criteria only: `true` = fires only on the save
   * that CHANGES the record to meet them (not on every save while they hold).
   */
  readonly onlyWhenChangedToMeet?: boolean;
}

/**
 * One writer in the response. `id` / `type` / `apiName` identify the
 * writer node; `confidence` surfaces the edge-level confidence
 * (declared vs parsed vs heuristic — the categorisation axis);
 * `conditional` references the ConditionalContext gating the write
 * (when one exists); `triggerEvent` is the ApexTrigger's `events`
 * property concatenated when the writer is a trigger.
 */
export interface WhyFieldChangedWriter {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly confidence: ConfidenceLevel;
  /**
   * Whether this writer can actually fire in the org's current state — a Flow
   * whose status is Active (or absent), a trigger that is not Inactive, a rule
   * that is active. A `runnable: false` writer is disclosed but is never the
   * sole live suspect for a field change (WHY-FIELD-CHANGED-MISSES-ASSIGNMENT-WRITERS).
   */
  readonly runnable: boolean;
  /** The writer's declared status/active token when the vault captures one (Flow status, ApexTrigger status, or Active/Inactive from an `active`/`isActive` flag). */
  readonly status?: string;
  /** The extractor/scan that surfaced this writer (`flow-extractor`, `apex-scanner`, `flow-field-writers-scan:assignToReference`, …). */
  readonly source: string;
  /** For supplemental Flow assignment-scan writers only: the write mechanism the source scan matched. */
  readonly mechanism?: SupplementalFlowFieldWriter['mechanism'];
  /** Present when the writer is a DLRS rollup definition (source `dlrs-rollup`). */
  readonly rollup?: DlrsRollupWriterDetail['rollup'];
  /** A workflow field update fired by a time trigger: it runs later, not in the save. */
  readonly timeTriggered?: true;
  /** The rule writes this field both in the save and from a time trigger: the literals the time trigger writes (later). */
  readonly timeTriggeredValues?: readonly string[];
  readonly conditional?: WhyFieldChangedCondition;
  readonly triggerEvent?: string;
  /** The literal value(s) this writer sets, when the metadata states them. */
  readonly assignedValues?: readonly string[];
  /** The variable / formula / field the value comes from, when not a literal. */
  readonly assignedFrom?: string;
  /** How the write happens (`recordUpdate`, `beforeSaveFieldAssignment`, …). */
  readonly operation?: string;
  /** Present with a `value` filter: `writes-value` (definitelySets) or `unknown` (maySet). */
  readonly valueMatch?: 'writes-value' | 'unknown';
  /** Source-scan writer whose target object could not be resolved — a lead. */
  readonly objectUnverified?: true;
}

/**
 * Echoes the field scope ACTUALLY resolved so a host never assumes a
 * `componentId` / `objectApiName` / `fieldApiName` alias it passed was silently
 * stripped (the always-`fieldId`-required bug this closes —
 * WHY-FIELD-CHANGED-REJECTS-COMPONENTID). `component` is the resolved canonical
 * `CustomField:` id; `mode` is always `'component'` — this tool has no org-wide
 * mode, so an unresolvable scope is a NAMED `invalid-query`, never a fallback.
 */
export interface WhyFieldChangedAppliedScope {
  readonly component: ComponentId;
  readonly mode: 'component';
}

/**
 * "What sets the field to V?" Every writer lands in exactly one group:
 * `definitelySets` (its metadata states V as a literal; `firesWhen` says when
 * it runs), `maySet` (the value is computed or not captured — `why`), or
 * `cannotSet` (it writes only the listed other values). `writers` keeps the
 * first two with full detail.
 */
export interface WhyFieldChangedValueFilter {
  /** The value as asked. */
  readonly value: string;
  /** The value compared: the declared picklist spelling, or `true`/`false` for a checkbox — when it differs from `value`. */
  readonly matchedValue?: string;
  /** Picklists only: whether the value is `active`, `inactive`, or `not-checked` against the value set. */
  readonly valueSetState?: 'active' | 'inactive' | 'not-checked';
  readonly note?: string;
  readonly definitelySets: readonly {
    readonly id: ComponentId;
    readonly runnable: boolean;
    readonly firesWhen: string;
  }[];
  readonly maySet: readonly { readonly id: ComponentId; readonly runnable: boolean; readonly why: string }[];
  readonly cannotSet: readonly { readonly id: ComponentId; readonly sets: readonly string[] }[];
  /** Writers dropped from `writers` (= `cannotSet.length`). */
  readonly excludedWriters: number;
  readonly disclosure: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhyFieldChangedOutput {
  /** Present with a `value` filter: every writer sorted against that value. */
  readonly valueFilter?: WhyFieldChangedValueFilter;
  readonly fieldId: ComponentId;
  /**
   * Present ONLY when a scope alias (`componentId` / `objectApiName` /
   * `fieldApiName`) was passed. Omitted for a bare `{ fieldId }` call so that
   * response stays byte-identical to the pre-scope shape.
   */
  readonly appliedScope?: WhyFieldChangedAppliedScope;
  readonly writers: readonly WhyFieldChangedWriter[];
  readonly summary: {
    readonly declaredCount: number;
    readonly heuristicCount: number;
    /** Writers that can fire in the org's current state (status Active/absent). */
    readonly runnableCount: number;
    /** Writers listed but disclosed as non-runnable (Obsolete/Draft/Inactive automation). */
    readonly nonRunnableCount: number;
    /** Writers folded in from the supplemental Flow assignment source scan (not primary `writesTo` edges). */
    readonly supplementalCount: number;
  };
  /**
   * Set only when writers exist but NONE are runnable — the field's only
   * candidate writers are non-Active automation, so this tool must not present
   * dead automation as the live cause of a change.
   */
  readonly note?: string;
  /**
   * FLOW-WRITER-SCAN-CAPS-AT-500: present ONLY when the supplemental Flow
   * writer scan did NOT reach every Flow in the vault (it stopped at its
   * residual ceiling, or the graph query failed). While the scan read one
   * fixed 500-node page its return type carried no truncation signal at all,
   * so a writer living past Flow 500 was silently absent and this tool could
   * not say so. When present, `writers` is possibly INCOMPLETE on the
   * supplemental axis — absence of an assignment-writer is "not checked",
   * never proven "none".
   */
  readonly supplementalScanTruncation?: {
    /** Flow nodes actually scanned (N). */
    readonly scannedFlows: number;
    /** Total Flow nodes in the vault (M). */
    readonly totalFlows: number;
    readonly note: string;
  };
  /** A03: field updates that set this field but that nothing fires. Not writers. */
  readonly unreferencedFieldUpdates?: {
    readonly note: string;
    readonly items: readonly UnreferencedFieldUpdate[];
  };
  readonly disclosure: string;
}

/** A resolved field scope: the canonical field id, plus whether a scope alias drove it. */
interface ResolvedWhyFieldScope {
  readonly fieldId: ComponentId;
  /**
   * True when a scope alias (`componentId` / `objectApiName` / `fieldApiName`)
   * was passed. Gates `appliedScope` emission so a bare `{ fieldId }` call keeps
   * the pre-scope byte-identical shape.
   */
  readonly scoped: boolean;
}

/** Classification of one raw identity string: a field-id candidate or an object scope. */
type ClassifiedIdentity =
  | { readonly kind: 'field'; readonly fieldId: string }
  | { readonly kind: 'object'; readonly object: string };

/**
 * Classify one raw identity string. `CustomField:…` → field; `CustomObject:…`
 * or a bare single token → object; a bare dotted `Object.Field` → field short
 * form; any OTHER `Type:` prefix (`Flow:`, `ApexClass:`, …) → `invalid-query`
 * (this tool traces a field, not those). `path` names the source arg so the
 * error points the host at the exact key it passed.
 */
const classifyIdentity = (
  raw: string,
  path: string,
): Result<ClassifiedIdentity, McpError> => {
  if (raw.startsWith(CUSTOM_FIELD_PREFIX)) {
    return ok({ kind: 'field', fieldId: raw });
  }
  if (raw.startsWith('CustomObject:')) {
    return ok({ kind: 'object', object: raw.slice('CustomObject:'.length) });
  }
  if (raw.includes(':')) {
    return err({
      kind: 'invalid-query',
      message: `'${raw}' is not a CustomField or CustomObject id — why_field_changed traces ONE field's writers; pass a 'CustomField:{Object}.{Field}' id (or objectApiName + fieldApiName)`,
      path,
    });
  }
  // No prefix: a dotted `Object.Field` is a field short form; a bare single
  // token names an object (this tool's fields are always object-qualified).
  if (raw.includes('.')) {
    return ok({ kind: 'field', fieldId: `${CUSTOM_FIELD_PREFIX}${raw}` });
  }
  return ok({ kind: 'object', object: raw });
};

/**
 * Resolve the single target field from the interchangeable identifiers a router
 * / host may pass (`fieldId`, `componentId`, `objectApiName` + `fieldApiName`).
 * Mirrors `governor_limit_risks.resolveScopeId` (precedence + NEVER a silent
 * strip) and the `input-aliases.ts` `resolveObjectAlias`/`resolveFieldAlias`
 * one-distinct-target discipline. Exactly one distinct field → `ok`; a
 * `componentId`/`objectApiName` that names only an object → `invalid-query`
 * asking for the field; disagreeing field or object aliases → `invalid-query`
 * naming them; a non-CustomField/-CustomObject prefix → `invalid-query`. There
 * is NO org-wide mode: an unresolvable scope is a named error, never a fallback.
 */
const resolveWhyFieldScope = (
  input: WhyFieldChangedInput,
): Result<ResolvedWhyFieldScope, McpError> => {
  const rawFieldId = firstNonEmpty(input.fieldId);
  const rawComponentId = firstNonEmpty(input.componentId);
  const rawObjectApiName = firstNonEmpty(input.objectApiName);
  const rawFieldApiName = firstNonEmpty(input.fieldApiName);
  const scoped =
    rawComponentId !== undefined ||
    rawObjectApiName !== undefined ||
    rawFieldApiName !== undefined;

  const fieldCandidates: string[] = [];
  let objectScope: string | undefined;

  // Adopt an object scope, refusing a second object that disagrees.
  const takeObject = (obj: string, path: string): McpError | null => {
    if (objectScope !== undefined && objectScope !== obj) {
      return {
        kind: 'invalid-query',
        message: `object aliases name different objects (${objectScope}, ${obj}); pass exactly one object`,
        path,
      };
    }
    objectScope = obj;
    return null;
  };

  // fieldId (canonical) — classified so a wrong `Type:` prefix is a NAMED error.
  if (rawFieldId !== undefined) {
    const c = classifyIdentity(rawFieldId, 'fieldId');
    if (!c.ok) return c;
    if (c.value.kind === 'field') fieldCandidates.push(c.value.fieldId);
    else {
      const e = takeObject(c.value.object, 'fieldId');
      if (e !== null) return err(e);
    }
  }

  // componentId alias — CustomField → field; CustomObject / bare → object scope.
  if (rawComponentId !== undefined) {
    const c = classifyIdentity(rawComponentId, 'componentId');
    if (!c.ok) return c;
    if (c.value.kind === 'field') fieldCandidates.push(c.value.fieldId);
    else {
      const e = takeObject(c.value.object, 'componentId');
      if (e !== null) return err(e);
    }
  }

  // objectApiName alias — always an object (strip a `CustomObject:` prefix).
  if (rawObjectApiName !== undefined) {
    const e = takeObject(toObjectApiName(rawObjectApiName), 'objectApiName');
    if (e !== null) return err(e);
  }

  // fieldApiName alias — a `CustomField:` id / dotted `Object.Field` is a field;
  // a bare field name needs an object scope to become a canonical field id.
  if (rawFieldApiName !== undefined) {
    if (rawFieldApiName.startsWith(CUSTOM_FIELD_PREFIX)) {
      fieldCandidates.push(rawFieldApiName);
    } else if (rawFieldApiName.includes('.')) {
      fieldCandidates.push(`${CUSTOM_FIELD_PREFIX}${rawFieldApiName}`);
    } else if (objectScope !== undefined) {
      fieldCandidates.push(
        `${CUSTOM_FIELD_PREFIX}${objectScope}.${rawFieldApiName}`,
      );
    } else {
      return err({
        kind: 'invalid-query',
        message: `fieldApiName '${rawFieldApiName}' has no object — pass objectApiName (or a CustomObject componentId), or a dotted '<Object>.<Field>' / 'CustomField:<Object>.<Field>'`,
        path: 'fieldApiName',
      });
    }
  }

  const distinct = [...new Set(fieldCandidates)];
  if (distinct.length > 1) {
    return err({
      kind: 'invalid-query',
      message: `field aliases name different fields (${distinct.join(', ')}); pass exactly one field`,
      path: 'fieldId',
    });
  }
  if (distinct.length === 0) {
    if (objectScope !== undefined) {
      return err({
        kind: 'invalid-query',
        message: `\`${objectScope}\` names an OBJECT, but why_field_changed traces ONE field — name the field (\`fieldApiName\`, or a \`CustomField:${objectScope}.<Field>\` id). It does NOT answer org-wide / whole-object.`,
        path: 'fieldId',
      });
    }
    return err({
      kind: 'invalid-query',
      message:
        'name the field — pass `fieldId`, a `CustomField:{Object}.{Field}` `componentId`, or `objectApiName` + `fieldApiName`',
      path: 'fieldId',
    });
  }

  const fieldId = distinct[0] as string;
  // When an object was ALSO named, it must agree with the field's own object —
  // never silently ignore a mismatched object scope.
  if (objectScope !== undefined) {
    const parentObj = parseFieldParentObjectApiName(fieldId);
    if (parentObj !== null && parentObj !== objectScope) {
      return err({
        kind: 'invalid-query',
        message: `object scope \`${objectScope}\` disagrees with the field's object \`${parentObj}\` (${fieldId}); pass one consistent scope`,
        path: 'objectApiName',
      });
    }
  }
  return ok({ fieldId: fieldId as ComponentId, scoped });
};

/**
 * Surface the first `firesWhen` ConditionalContext for a writer
 * node. Returns `undefined` when the writer has no `firesWhen`
 * edges. The condition carries the synthetic id and the parsed
 * expression — enough for the caller to render the gating predicate
 * without an extra round trip.
 */
const surfaceFirstCondition = async (
  ctx: Context,
  writerId: ComponentId,
): Promise<Result<WhyFieldChangedCondition | undefined, string>> => {
  const edgesResult = await listEdges(ctx.graph, writerId, {
    direction: 'out',
    edgeType: 'firesWhen',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  // Prefer the record-trigger ENTRY criteria (the condition that decides
  // whether the writer runs at all) over the first decision.
  let chosen: Node | null = null;
  for (const e of edgesResult.value) {
    const n = await getNodeById(ctx.graph, e.toId);
    if (!n.ok) return err(n.error.message);
    if (n.value === null) continue;
    if (chosen === null) chosen = n.value;
    if (n.value.properties['kind'] === 'flow-recordtrigger') {
      chosen = n.value;
      break;
    }
  }
  if (chosen === null) return ok(undefined);
  const expression = chosen.properties['expression'];
  const onlyWhenChanged = chosen.properties['entryRequiresRecordChange'];
  return ok({
    conditionContextId: chosen.id,
    expression: typeof expression === 'string' ? expression : '',
    ...(onlyWhenChanged === true ? { onlyWhenChangedToMeet: true } : {}),
  });
};

/**
 * For an ApexTrigger writer, surface the trigger's lifecycle events
 * as a comma-separated string (e.g., `'before insert, after update'`).
 * Returns `undefined` for non-trigger writers, or when the trigger
 * node lacks an `events` property in its properties block.
 */
const surfaceTriggerEvent = (writerNode: Node): string | undefined => {
  if (writerNode.type !== 'ApexTrigger') return undefined;
  const events = writerNode.properties['events'];
  if (!Array.isArray(events) || events.length === 0) return undefined;
  const stringEvents = events.filter((e): e is string => typeof e === 'string');
  if (stringEvents.length === 0) return undefined;
  return stringEvents.join(', ');
};

/**
 * Whether a writer node can actually fire in the org's current state, plus its
 * declared status token when the vault captures one. Runnability reuses the
 * shared `isActiveSoeFirer` predicate (Flow status Active/absent, trigger not
 * Inactive, rule active) so a non-Active Flow / inactive rule is never
 * presented as a live writer.
 */
const writerRunState = (node: Node): { runnable: boolean; status?: string } => {
  // WHY-FIELD-CHANGED-TEST-WRITERS-MARKED-RUNNABLE — a TEST class (`isTest === true`,
  // the unconditionally-present ApexClass boolean) writes the field only while a
  // test executes; it is NEVER a live production writer. `isActiveSoeFirer` has no
  // ApexClass branch, so a test class would otherwise fall through to the
  // conservative `runnable: true` prior and be presented as a live automation
  // writer. Mark it non-runnable and disclose it as `test-only` (named, not hidden)
  // so it is listed for completeness but is never the sole live suspect.
  if (node.properties['isTest'] === true) {
    return { runnable: false, status: 'test-only' };
  }
  const runnable = isActiveSoeFirer(node);
  const props = node.properties;
  const statusProp = props['status'];
  if (typeof statusProp === 'string') return { runnable, status: statusProp };
  const active = props['active'];
  if (typeof active === 'boolean') return { runnable, status: active ? 'Active' : 'Inactive' };
  const isActive = props['isActive'];
  if (typeof isActive === 'boolean') return { runnable, status: isActive ? 'Active' : 'Inactive' };
  return { runnable };
};

/**
 * Compose one `WhyFieldChangedWriter` entry from a single
 * `writesTo` edge + its resolved source node. Surfaces the
 * ConditionalContext, the trigger event, the edge confidence, the
 * writer's runnable state/status, and the emitting source; returns
 * null when the writer node has gone missing (sparse-graph tolerance).
 */
/** A writer entry plus what its metadata states about the value it writes. */
interface BuiltWriter {
  readonly writer: WhyFieldChangedWriter;
  readonly evidence: WriteValueEvidence;
  /** The writer node, when the graph holds it (for `firesWhen`). */
  readonly node: Node | null;
  /** Which written values a time trigger writes (later) vs the save. */
  readonly timing: WriteValueTiming;
}

const NO_TIMING: WriteValueTiming = { timeTriggered: 'none', timeTriggeredValues: [], immediateValues: [] };

const buildWriter = async (
  ctx: Context,
  edge: Edge,
  writerNode: Node,
): Promise<Result<BuiltWriter, string>> => {
  const conditionResult = await surfaceFirstCondition(ctx, writerNode.id);
  if (!conditionResult.ok) return err(conditionResult.error);
  const triggerEvent = surfaceTriggerEvent(writerNode);
  const dlrs = dlrsRollupWriterDetail(edge);
  const { runnable, status } = dlrs ?? writerRunState(writerNode);
  const literals = edgeLiteralValues(edge);
  const operation = edge.properties['operation'];
  const references = edgeReferenceValues(edge);
  const reference = references.length > 0 ? references.join(', ') : undefined;
  const timing = edgeValueTiming(edge);
  const base: Omit<WhyFieldChangedWriter, 'conditional' | 'triggerEvent'> = {
    id: writerNode.id,
    type: writerNode.type,
    apiName: writerNode.apiName,
    confidence: edge.confidence,
    runnable,
    source: edge.source,
    ...(status !== undefined ? { status } : {}),
    ...(dlrs !== undefined ? { rollup: dlrs.rollup } : {}),
    ...(timing.timeTriggered === 'all' ? { timeTriggered: true as const } : {}),
    ...(timing.timeTriggered === 'partly' ? { timeTriggeredValues: timing.timeTriggeredValues } : {}),
    ...(literals.length > 0 ? { assignedValues: literals } : {}),
    ...(reference !== undefined ? { assignedFrom: reference } : {}),
    ...(typeof operation === 'string' ? { operation } : {}),
  };
  const withCondition: WhyFieldChangedWriter =
    conditionResult.value === undefined
      ? base
      : { ...base, conditional: conditionResult.value };
  return ok({
    writer: triggerEvent === undefined ? withCondition : { ...withCondition, triggerEvent },
    evidence: {
      literals,
      references,
      kinds: edgeValueKinds(edge),
      writerType: writerNode.type,
      source: edge.source,
      ...(typeof operation === 'string' ? { operation } : {}),
    },
    node: writerNode,
    timing,
  });
};

/**
 * Compose a `WhyFieldChangedWriter` for a supplemental Flow field writer the
 * graph did not stamp as a primary `writesTo` edge (SObject-variable
 * `assignToReference` / non-$Record `recordUpdates` — the same scan
 * `sfi.field_360` folds in). Heuristic confidence; runnable state resolved from
 * the Flow node's declared status when the node is present in the graph.
 */
const buildSupplementalWriter = async (
  ctx: Context,
  supplemental: SupplementalFlowFieldWriter,
): Promise<Result<BuiltWriter, string>> => {
  const source = `flow-field-writers-scan:${supplemental.mechanism}`;
  const nodeResult = await getNodeById(ctx.graph, supplemental.componentId);
  if (!nodeResult.ok) return err(nodeResult.error.message);
  const node = nodeResult.value;
  const evidence: WriteValueEvidence = { literals: [], references: [], kinds: [], writerType: 'Flow', source };
  // A supplemental hit whose Flow node is absent from the graph: fall back to
  // the scan-provided identity with an unknown (conservatively runnable) status.
  if (node === null) {
    return ok({ node: null, evidence, timing: NO_TIMING, writer: {
      id: supplemental.componentId,
      type: 'Flow',
      apiName: supplemental.apiName,
      confidence: 'heuristic',
      runnable: true,
      source,
      mechanism: supplemental.mechanism,
      ...(supplemental.objectScope === 'unresolved' ? { objectUnverified: true as const } : {}),
    } });
  }
  const { runnable, status } = writerRunState(node);
  return ok({ node, evidence, timing: NO_TIMING, writer: {
    id: node.id,
    type: node.type,
    apiName: node.apiName,
    confidence: 'heuristic',
    runnable,
    source,
    mechanism: supplemental.mechanism,
    ...(status !== undefined ? { status } : {}),
    ...(supplemental.objectScope === 'unresolved' ? { objectUnverified: true as const } : {}),
  } });
};

/** What a value-filtered answer can and cannot see. */
const VALUE_DISCLOSURE =
  'definitelySets = the metadata states this exact value as a literal write; firesWhen lists its entry conditions (not evaluated against any record). maySet = the writer CAN set it but the value is computed or not captured (Flow variable / formula, workflow formula, picklist next/previous, DLRS rollup, Apex, whose assigned values the vault does not capture) — check those by hand. cannotSet = every write the vault attributes to it states another value (a Flow source file is re-checked for the asked value). Not modeled at all: managed-package code and automation, dynamic Apex, integrations / API loads, data imports, and manual edits — an empty definitelySets is not proof nothing sets the value.';

const FLOW_RECORD_EVENTS: Readonly<Record<string, string>> = {
  Create: 'create',
  Update: 'update',
  CreateAndUpdate: 'create or update',
  Delete: 'delete',
};

const FLOW_PHASES: Readonly<Record<string, string>> = {
  RecordBeforeSave: 'before-save',
  RecordAfterSave: 'after-save',
  RecordBeforeDelete: 'before-delete',
};

const FLOW_PROCESS_KINDS: Readonly<Record<string, string>> = {
  Flow: 'screen',
  AutoLaunchedFlow: 'autolaunched',
};

const WORKFLOW_TRIGGERS: Readonly<Record<string, string>> = {
  onCreateOnly: 'on create only',
  onCreateOrTriggeringUpdate: 'on create, and on an edit that changes the record to meet the criteria',
  onAllChanges: 'on create and on every edit while the criteria hold',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * When a record-triggered Flow's writes run relative to the save, from the
 * node's scheduled-path facts (the same classifier the order-of-execution
 * tools use). Null when it has no scheduled path. Which element sits on which
 * path is not modeled, so a Flow with both an immediate and a scheduled path
 * says the write MAY be delayed.
 */
const flowScheduledPathNote = (node: Node): string | null => {
  const p = node.properties;
  const types = Array.isArray(p['scheduledPathTypes']) ? p['scheduledPathTypes'].length : 0;
  const count = Math.max(types, typeof p['scheduledPathCount'] === 'number' ? p['scheduledPathCount'] : 0);
  const timing = classifyAfterSaveFlowTiming(node);
  if (timing === 'unknown') {
    return 'whether this write runs in the save or on a scheduled path is not recorded in this vault (rebuild it to resolve)';
  }
  if (count === 0) return null;
  // Time-offset paths carry no <pathType>; typed ones are run-after-commit.
  const delayed = count - types;
  const kind = delayed > 0 ? ` (${delayed.toString()} time-delayed)` : ' (async, after the save commits)';
  if (timing === 'async-only') {
    return `runs only on its ${count.toString()} scheduled path(s)${kind}, NOT in the save`;
  }
  return `has ${count.toString()} scheduled path(s)${kind}; this write may run on one rather than in the save (not modeled per element)`;
};

/**
 * Where the asked value is written relative to the save, for a writer whose
 * key folded an in-the-save write with a time-triggered one (a workflow rule
 * with an immediate and a time-triggered update of the same field), or whose
 * every write is time-triggered. Empty when every write is in the save.
 */
const valueTimingNote = (entries: readonly BuiltWriter[], target: ResolvedFieldValue): string => {
  let timed = false;
  let immediate = false;
  for (const b of entries) {
    const t = b.timing;
    if (t.timeTriggered === 'all') timed = true;
    else if (t.timeTriggered === 'partly') {
      const inTimed = t.timeTriggeredValues.some((v) => literalEqualsValue(v, target));
      const inSave = t.immediateValues.some((v) => literalEqualsValue(v, target));
      if (inTimed) timed = true;
      if (inSave) immediate = true;
      // Matched through a value neither list holds (e.g. a global constant):
      // the timing of that write is not known — say it may be delayed.
      if (!inTimed && !inSave) timed = immediate = true;
    } else immediate = true;
  }
  if (timed && !immediate) return 'this value is written by a time trigger — later, NOT in the save';
  if (timed) return 'this value is written in the save and/or later by a time trigger';
  const partly = entries.some((b) => b.timing.timeTriggered === 'partly');
  return partly ? "this value is written in the save; the rule's time trigger writes other value(s) later" : '';
};

/**
 * When a definite writer runs, in one sentence: the Flow trigger (phase,
 * object, events), whether it runs on a scheduled path, and its entry
 * criteria; the workflow rule's evaluation setting and criteria and whether
 * the value is written by a time trigger; the trigger's events. Conditions are
 * rendered from the same ConditionalContext expressions `conditional` carries
 * — listed, never evaluated. Decision outcomes inside a Flow are counted, not
 * walked.
 */
const describeWhenWriterFires = async (
  ctx: Context,
  entries: readonly BuiltWriter[],
  target: ResolvedFieldValue,
): Promise<string> => {
  const { node, writer } = entries[0] as BuiltWriter;
  if (node === null) return 'not determined — the writer is not in the graph';
  const criteria = writer.conditional?.expression;
  const timingNote = valueTimingNote(entries, target);
  const timed = timingNote.length > 0 ? ` (${timingNote})` : '';
  if (node.type === 'Flow') {
    const parts: string[] = [];
    const trig = await listEdges(ctx.graph, node.id, { direction: 'out', edgeType: 'triggersOn' });
    const triggersOn = trig.ok ? trig.value[0] : undefined;
    const triggerType = str(triggersOn?.properties['triggerType']) ?? str(node.properties['triggerType']);
    const conds = await listEdges(ctx.graph, node.id, { direction: 'out', edgeType: 'firesWhen' });
    const entry: string[] = [];
    let onlyWhenChanged = false;
    let outcomes = 0;
    if (conds.ok) {
      for (const e of conds.value) {
        const cc = await getNodeById(ctx.graph, e.toId);
        if (!cc.ok || cc.value === null) continue;
        const kind = cc.value.properties['kind'];
        if (kind === 'flow-recordtrigger') {
          const expr = str(cc.value.properties['expression']);
          if (expr !== null) entry.push(expr);
          if (cc.value.properties['entryRequiresRecordChange'] === true) onlyWhenChanged = true;
        } else if (kind === 'flow-decision') outcomes += 1;
      }
    }
    if (triggerType !== null && triggerType.startsWith('Record') && triggersOn !== undefined) {
      const phase = FLOW_PHASES[triggerType] ?? 'record-triggered';
      const events = FLOW_RECORD_EVENTS[str(triggersOn.properties['recordTriggerType']) ?? ''] ?? 'save';
      parts.push(`${phase} Flow on ${triggersOn.toId.replace(/^CustomObject:/, '')} ${events}`);
      if (triggerType === 'RecordAfterSave') {
        const scheduled = flowScheduledPathNote(node);
        if (scheduled !== null) parts.push(scheduled);
      }
      parts.push(
        entry.length > 0
          ? `entry criteria: ${entry.join(' AND ')}${onlyWhenChanged ? ' (only when a save changes the record to meet them)' : ''}`
          : 'no entry criteria recorded (not proof it runs on every save)',
      );
    } else {
      const kind =
        triggerType === 'Scheduled'
          ? 'scheduled'
          : triggerType === 'PlatformEvent'
            ? 'platform-event'
            : (FLOW_PROCESS_KINDS[str(node.properties['processType']) ?? ''] ?? 'non-record-triggered');
      parts.push(`${kind} Flow — runs when launched (by a user, caller, schedule, or event), not on a record save`);
    }
    if (outcomes > 0) {
      parts.push(`${outcomes.toString()} decision outcome(s) inside the Flow may further gate this write (not evaluated)`);
    }
    return parts.join('; ');
  }
  if (node.type === 'WorkflowRule') {
    const when = WORKFLOW_TRIGGERS[str(node.properties['triggerType']) ?? ''] ?? 'workflow rule';
    return `workflow rule, evaluated ${when}${criteria !== undefined && criteria.length > 0 ? `; criteria: ${criteria}` : ''}${timed}`;
  }
  if (node.type === 'ApprovalProcess') {
    return `approval-process step action (submit / approve / reject / recall — which step is not modeled)${criteria !== undefined && criteria.length > 0 ? `; entry criteria: ${criteria}` : ''}`;
  }
  if (node.type === 'ApexTrigger') return `Apex trigger (${writer.triggerEvent ?? 'events not recorded'})`;
  return `${node.type}${criteria !== undefined && criteria.length > 0 ? `; condition: ${criteria}` : ''}${timed}`;
};

/** Writers sorted against one value (see {@link WhyFieldChangedValueFilter}). */
interface ValueSort {
  readonly writers: WhyFieldChangedWriter[];
  readonly definitelySets: WhyFieldChangedValueFilter['definitelySets'][number][];
  readonly maySet: WhyFieldChangedValueFilter['maySet'][number][];
  readonly cannotSet: WhyFieldChangedValueFilter['cannotSet'][number][];
}

/**
 * Sort every writer against the asked value. A writer reached through several
 * edges (e.g. two Apex passes) is judged once: any definite literal wins, then
 * any computed / uncaptured value, else the union of the other literals.
 */
const sortWritersByValue = async (
  ctx: Context,
  built: readonly BuiltWriter[],
  target: ResolvedFieldValue,
  fieldApiName: string,
): Promise<ValueSort> => {
  const byId = new Map<ComponentId, BuiltWriter[]>();
  for (const b of built) {
    const list = byId.get(b.writer.id);
    if (list === undefined) byId.set(b.writer.id, [b]);
    else list.push(b);
  }
  const out: ValueSort = { writers: [], definitelySets: [], maySet: [], cannotSet: [] };
  for (const [id, entries] of byId) {
    const verdicts = entries.map((b) => classifyWriteForValue(b.evidence, target));
    const runnable = entries.some((b) => b.writer.runnable);
    if (verdicts.some((v) => v.group === 'definitely')) {
      const definite = entries.filter((_, i) => verdicts[i]?.group === 'definitely');
      out.definitelySets.push({ id, runnable, firesWhen: await describeWhenWriterFires(ctx, definite, target) });
      for (const b of entries) out.writers.push({ ...b.writer, valueMatch: 'writes-value' });
      continue;
    }
    const whys = [...new Set(verdicts.flatMap((v) => (v.group === 'may' ? [v.why] : [])))];
    // `cannot` is a negative claim: a Flow's source is re-checked for the value
    // in a write the graph did not attribute to this field.
    const flowNode = entries.find((b) => b.node?.type === 'Flow')?.node ?? null;
    if (whys.length === 0 && flowNode !== null) {
      const reason = await flowSourceMaySetReason(ctx, flowNode, fieldApiName, target);
      if (reason !== null) whys.push(reason);
    }
    if (whys.length > 0) {
      out.maySet.push({ id, runnable, why: whys.join('; ') });
      for (const b of entries) out.writers.push({ ...b.writer, valueMatch: 'unknown' });
      continue;
    }
    const sets = [...new Set(verdicts.flatMap((v) => (v.group === 'cannot' ? v.sets : [])))];
    out.cannotSet.push({ id, sets });
  }
  const byIdOrder = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  out.definitelySets.sort(byIdOrder);
  out.maySet.sort(byIdOrder);
  out.cannotSet.sort(byIdOrder);
  return out;
};

const buildValueFilter = (
  asked: string,
  target: ResolvedFieldValue,
  sort: ValueSort,
): WhyFieldChangedValueFilter => ({
  value: asked,
  ...(target.value !== asked ? { matchedValue: target.value } : {}),
  ...(target.valueSetState !== undefined ? { valueSetState: target.valueSetState } : {}),
  ...(target.note !== undefined ? { note: target.note } : {}),
  definitelySets: sort.definitelySets,
  maySet: sort.maySet,
  cannotSet: sort.cannotSet,
  excludedWriters: sort.cannotSet.length,
  disclosure: VALUE_DISCLOSURE,
});

/**
 * The `sfi.why_field_changed` MCP tool. Returns every writer of the
 * given field with its confidence categorisation, the gating
 * condition (when one exists), and (for ApexTrigger writers) the
 * lifecycle event list. See the module JSDoc for the categorisation
 * design and the honesty axis.
 *
 * @example
 *   const r = await whyFieldChangedHandler(ctx, {
 *     fieldId: 'CustomField:Account.Industry__c',
 *   });
 *   if (r.ok) for (const w of r.value.data.writers) {
 *     console.log(w.apiName, w.confidence);
 *   }
 */
export const whyFieldChangedHandler = async (
  ctx: Context,
  input: WhyFieldChangedInput,
): Promise<Result<McpResponse<WhyFieldChangedOutput>, McpError>> => {
  // Resolve the single target field from `fieldId` / `componentId` /
  // `objectApiName` + `fieldApiName`. An object-only or mis-prefixed scope is a
  // NAMED `invalid-query`, never a silent org-wide fallback
  // (WHY-FIELD-CHANGED-REJECTS-COMPONENTID).
  const scopeResult = resolveWhyFieldScope(input);
  if (!scopeResult.ok) return scopeResult;
  const { fieldId, scoped } = scopeResult.value;

  const nodeResult = await getNodeById(ctx.graph, fieldId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      path: fieldId,
    });
  }
  const node = nodeResult.value;

  const edgesResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
    edgeType: 'writesTo',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  // "What sets it to V?": check V against the field BEFORE scanning, so an
  // undeclared picklist value or a non-boolean checkbox value is refused fast.
  let target: ResolvedFieldValue | undefined;
  if (input.value !== undefined) {
    const resolved = await resolveFieldValue(ctx, node, fieldId, input.value);
    if (!resolved.ok) return resolved;
    target = resolved.value;
  }

  const built: BuiltWriter[] = [];
  const writerIds = new Set<ComponentId>();
  for (const edge of edgesResult.value) {
    const fromResult = await getNodeById(ctx.graph, edge.fromId);
    if (!fromResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${fromResult.error.message}`,
      });
    }
    if (fromResult.value === null) continue;
    const writerResult = await buildWriter(ctx, edge, fromResult.value);
    if (!writerResult.ok) {
      return err({ kind: 'internal', message: writerResult.error });
    }
    built.push(writerResult.value);
    writerIds.add(writerResult.value.writer.id);
  }

  // Fold in Active-Flow field writers made via SObject-variable assignment
  // (`assignToReference`) that the graph never stamped as a primary `writesTo`
  // edge — the SAME supplemental scan `sfi.field_360.writers` uses. Without
  // this, an Active closer Flow that assigns the field is invisible while a
  // dead Obsolete Flow can be the sole cited suspect
  // (WHY-FIELD-CHANGED-MISSES-ASSIGNMENT-WRITERS).
  const parentObjectApi =
    node.parentId !== null && node.parentId.startsWith('CustomObject:')
      ? node.parentId.slice('CustomObject:'.length)
      : fieldId.slice(CUSTOM_FIELD_PREFIX.length).split('.')[0] ?? '';
  let supplementalCount = 0;
  let supplementalScanTruncation: WhyFieldChangedOutput['supplementalScanTruncation'];
  if (parentObjectApi.length > 0) {
    const supplemental = await scanSupplementalFlowFieldWriters(
      ctx,
      parentObjectApi,
      node.apiName,
    );
    if (supplemental.truncated) {
      supplementalScanTruncation = {
        scannedFlows: supplemental.scannedCount,
        totalFlows: supplemental.totalCount,
        note: `The supplemental Flow writer scan covered ${supplemental.scannedCount.toString()} of ${supplemental.totalCount.toString()} Flow node(s) (full-scan ceiling, SFI_FLOW_WRITER_SCAN_MAX) — an SObject-variable / recordUpdates writer in the un-scanned tail is NOT in \`writers\`. Treat the supplemental axis as NOT CHECKED past that point, never as "no such writer".`,
      };
    }
    for (const w of supplemental.writers) {
      if (writerIds.has(w.componentId)) continue;
      const b = await buildSupplementalWriter(ctx, w);
      if (!b.ok) return err({ kind: 'internal', message: b.error });
      built.push(b.value);
      writerIds.add(b.value.writer.id);
      supplementalCount += 1;
    }
  }

  const unreferencedItems =
    parentObjectApi.length > 0
      ? await findUnreferencedFieldUpdates(ctx, parentObjectApi, node.apiName)
      : [];

  const valueSort = target === undefined ? undefined : await sortWritersByValue(ctx, built, target, fieldId.slice(fieldId.indexOf('.') + 1));
  const writers: WhyFieldChangedWriter[] =
    valueSort === undefined ? built.map((b) => b.writer) : valueSort.writers;

  let declaredCount = 0;
  let heuristicCount = 0;
  let runnableCount = 0;
  let nonRunnableCount = 0;
  for (const writer of writers) {
    if (writer.confidence === 'heuristic') {
      heuristicCount += 1;
    } else {
      // `declared` and `parsed` both count as declared for this
      // categorisation. The parsed confidence ships from the v0.2
      // formula tokenizer; the field is still extracted from
      // metadata, not inferred from a body scan.
      declaredCount += 1;
    }
    if (writer.runnable) runnableCount += 1;
    else nonRunnableCount += 1;
  }

  // Deterministic order by id so the response is stable across runs.
  const sortedWriters = [...writers].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  // When candidate writers exist but NONE can run, the field's only suspects are
  // dead automation — say so plainly rather than let a host read the Obsolete
  // Flow as the live cause.
  const note =
    sortedWriters.length > 0 && runnableCount === 0
      ? 'Every candidate writer is non-runnable (Obsolete/Draft/Inactive automation or test-only Apex) — none could have written this field in the org\'s current production state. The change may predate their deactivation, or come from a writer plane not modeled here (Apex dataflow, live-only automation, manual edit).'
      : undefined;

  return ok({
    data: {
      // Emit `appliedScope` ONLY when a scope alias drove resolution, so a bare
      // `{ fieldId }` call stays byte-identical to the pre-scope response shape.
      ...(scoped
        ? {
            appliedScope: {
              component: fieldId,
              mode: 'component' as const,
            },
          }
        : {}),
      fieldId,
      writers: sortedWriters,
      summary: {
        declaredCount,
        heuristicCount,
        runnableCount,
        nonRunnableCount,
        supplementalCount,
      },
      ...(note !== undefined ? { note } : {}),
      ...(valueSort !== undefined && input.value !== undefined && target !== undefined
        ? { valueFilter: buildValueFilter(input.value, target, valueSort) }
        : {}),
      ...(supplementalScanTruncation !== undefined
        ? { supplementalScanTruncation }
        : {}),
      ...(unreferencedItems.length > 0
        ? {
            unreferencedFieldUpdates: {
              note: UNREFERENCED_FIELD_UPDATES_NOTE,
              items: unreferencedItems,
            },
          }
        : {}),
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
