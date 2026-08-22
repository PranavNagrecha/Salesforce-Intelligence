/**
 * Handler for the `sfi.why_field_changed` MCP tool.
 *
 * v2.0e W1 — the field-write-tracing headline. Answers the buyer-
 * priority #1 question: "why did this field get updated?". Walks every
 * incoming `writesTo` edge to the target CustomField and surfaces each
 * writer with its categorisation (declared vs heuristic), the
 * `firesWhen` ConditionalContext gating the write (when one exists),
 * and the trigger event when the writer is an ApexTrigger.
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
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

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
  readonly conditional?: WhyFieldChangedCondition;
  readonly triggerEvent?: string;
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

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhyFieldChangedOutput {
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
  const firstEdge = edgesResult.value[0];
  if (firstEdge === undefined) return ok(undefined);
  const conditionNodeResult = await getNodeById(ctx.graph, firstEdge.toId);
  if (!conditionNodeResult.ok) return err(conditionNodeResult.error.message);
  if (conditionNodeResult.value === null) return ok(undefined);
  const conditionNode = conditionNodeResult.value;
  const expression = conditionNode.properties['expression'];
  return ok({
    conditionContextId: conditionNode.id,
    expression: typeof expression === 'string' ? expression : '',
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
const buildWriter = async (
  ctx: Context,
  edge: Edge,
  writerNode: Node,
): Promise<Result<WhyFieldChangedWriter, string>> => {
  const conditionResult = await surfaceFirstCondition(ctx, writerNode.id);
  if (!conditionResult.ok) return err(conditionResult.error);
  const triggerEvent = surfaceTriggerEvent(writerNode);
  const { runnable, status } = writerRunState(writerNode);
  const base: Omit<WhyFieldChangedWriter, 'conditional' | 'triggerEvent'> = {
    id: writerNode.id,
    type: writerNode.type,
    apiName: writerNode.apiName,
    confidence: edge.confidence,
    runnable,
    source: edge.source,
    ...(status !== undefined ? { status } : {}),
  };
  const withCondition: WhyFieldChangedWriter =
    conditionResult.value === undefined
      ? base
      : { ...base, conditional: conditionResult.value };
  return ok(
    triggerEvent === undefined
      ? withCondition
      : { ...withCondition, triggerEvent },
  );
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
): Promise<Result<WhyFieldChangedWriter, string>> => {
  const source = `flow-field-writers-scan:${supplemental.mechanism}`;
  const nodeResult = await getNodeById(ctx.graph, supplemental.componentId);
  if (!nodeResult.ok) return err(nodeResult.error.message);
  const node = nodeResult.value;
  // A supplemental hit whose Flow node is absent from the graph: fall back to
  // the scan-provided identity with an unknown (conservatively runnable) status.
  if (node === null) {
    return ok({
      id: supplemental.componentId,
      type: 'Flow',
      apiName: supplemental.apiName,
      confidence: 'heuristic',
      runnable: true,
      source,
      mechanism: supplemental.mechanism,
    });
  }
  const { runnable, status } = writerRunState(node);
  return ok({
    id: node.id,
    type: node.type,
    apiName: node.apiName,
    confidence: 'heuristic',
    runnable,
    source,
    mechanism: supplemental.mechanism,
    ...(status !== undefined ? { status } : {}),
  });
};

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

  const writers: WhyFieldChangedWriter[] = [];
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
    writers.push(writerResult.value);
    writerIds.add(writerResult.value.id);
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
      const built = await buildSupplementalWriter(ctx, w);
      if (!built.ok) return err({ kind: 'internal', message: built.error });
      writers.push(built.value);
      writerIds.add(built.value.id);
      supplementalCount += 1;
    }
  }

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
      ...(supplementalScanTruncation !== undefined
        ? { supplementalScanTruncation }
        : {}),
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
