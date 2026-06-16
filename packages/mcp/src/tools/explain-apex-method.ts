/**
 * Handler for the `sfi.explain_apex_method` MCP tool.
 *
 * v2.0f W1 — the second of three explainer composers (buyer-priority
 * #6: "what does this Flow / Apex method / formula actually do?
 * Explain in English."). Given an ApexClass canonical id (and
 * optionally a method name), return a structured narrative payload
 * Claude composes into the natural-language explanation.
 *
 * Method-level granularity is the v2.7 milestone; v2.0f operates at
 * class level. The `methodName` input parameter is accepted but only
 * surfaced verbatim in the response so callers can pass it through to
 * a future v2.7 method-scoped narrative. The tool does NOT subset the
 * class's outgoing edges by method in v2.0f — that would require an
 * Apex AST (the v2.0a scope was deliberately heuristic-only).
 *
 * The structured payload covers six axes:
 *
 *   1. **Identity** — apiName, apiVersion, status, modifiers
 *      (e.g., `['global', 'with sharing']`), the source's lineCount
 *      and sourceBytes (from the v1.5 properties). For an ApexTrigger,
 *      also `triggerObject` (the SObject it fires on) and `events` (the
 *      DML events it handles); `null`/`[]` for an ApexClass.
 *   2. **Async classifiers** — the v1.5 boolean classifiers
 *      (`isQueueable`, `isSchedulable`, `isBatchable`,
 *      `hasFutureMethod`, `hasInvocableMethod`,
 *      `hasAuraEnabledMethod`, `isRestResource`). Each is surfaced
 *      explicitly so the renderer can pick a per-class narrative
 *      ("this class is queueable + future-method holder" vs "this is
 *      a REST resource").
 *   3. **Test flag** — `isTest` from the v1.5 properties. Test classes
 *      get a distinct narrative branch.
 *   4. **Calls** — every outgoing `callsApex` edge from the class to
 *      another ApexClass / ApexTrigger. Surfaced as
 *      `{ targetId, targetApiName }` rows; targets that point
 *      elsewhere (e.g., to a Flow via dispatchesAsync) are NOT in this
 *      list — see `asyncDispatches` below.
 *   5. **Field access** — every outgoing `readsFrom` / `writesTo`
 *      edge. Surfaced as `{ fieldId, accessType: 'read' | 'write' |
 *      'both' }` rows; a field that the class both reads and writes
 *      collapses to a single `'both'` row.
 *   6. **Quality issues** — surfaced verbatim from
 *      `properties.qualityIssues` if the v2.1 R2 quality-issue
 *      enricher has populated it. v2.0f does NOT compute issues;
 *      missing property surfaces as an empty array (the honesty axis).
 *
 * Implementation notes:
 *   - One `getNodeById(classApiName)` resolves the class. Both
 *     `ApexClass:` and `ApexTrigger:` prefixes are accepted (an
 *     ApexTrigger is a body of Apex code answerable to the same
 *     "explain in English" question); non-matching prefixes surface
 *     as `invalid-query`, unknown well-formed ids surface as
 *     `component-not-found`.
 *   - Three `listEdges` calls fan out the `callsApex`, `readsFrom`,
 *     and `writesTo` axes. Each call narrows by `direction: 'out'`
 *     and `edgeType:` so per-axis filtering happens at the query
 *     layer.
 *   - The `readsFrom` + `writesTo` lists are merged into the
 *     `fieldAccess` axis: a field with both edges shows as
 *     `accessType: 'both'`; otherwise as `'read'` or `'write'`. The
 *     merge runs in memory after the two listEdges calls.
 *   - `qualityIssues` is surfaced via the v2.1 R2 property mirror as the
 *     structured OBJECT array (`{rule, severity, location, explanation}`)
 *     the recognizer emits — the same shape `governor_limit_risks` /
 *     `code_quality_audit` consume. (Earlier this tool read it with a
 *     string-array reader, which dropped every object finding and made the
 *     mirror permanently `[]`.) When the class node doesn't yet carry it
 *     (the v2.0f vault pre-dates v2.1 R2), the property is absent or empty;
 *     the handler surfaces `qualityIssues: []` rather than the absent
 *     case, signalling "we looked and found nothing" per the v2.0
 *     honesty-axis convention.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { annotationsBlockFor, type AnnotationsBlock } from './annotations.js';
import { isUnresolvedFieldReceiver } from './apex-receiver.js';
import { coercePrefix } from './coerce-id.js';
import { mergeInputAliases } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefixes the tool accepts. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/**
 * The verbatim honesty-axis disclosure surfaced in every response.
 * Frozen here so the test suite can assert the exact string and a
 * caller-facing rephrasing during rendering is a code-review concern,
 * not a silent drift.
 */
const DISCLOSURE = 'Structured narrative; Claude composes prose';

const UNRESOLVED_CALLS_SUFFIX =
  ' Unresolved callsApex targets from the heuristic Apex scanner are listed in unresolvedCallTargets — they are not verified vault components.';
const UNRESOLVED_FIELDS_SUFFIX =
  ' Field accesses whose receiver could not be resolved to an object — Apex `this`/`super` members and un-type-resolved local variables (e.g. a loop variable) — are listed in unresolvedFieldAccess as raw `receiver.field` tokens, NOT in fieldAccess; they are not verified object fields.';

/**
 * Zod schema for the `sfi.explain_apex_method` tool input.
 *
 *   - `classApiName`: required, non-empty string. The canonical
 *     ApexClass id (`ApexClass:{ClassName}`) or ApexTrigger id
 *     (`ApexTrigger:{TriggerName}`). Other prefixes surface as
 *     `invalid-query` from the handler.
 *   - `methodName`: optional. Carried verbatim into the response so
 *     callers can pass it through to a future v2.7 method-scoped
 *     narrative. v2.0f does NOT subset by method.
 */
const explainApexMethodInputBaseSchema = z.object({
  classApiName: z.string().min(1),
  methodName: z.string().min(1).optional(),
});

export const explainApexMethodInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [
      { canonical: 'classApiName', aliases: ['componentId', 'classId'] },
    ]),
  explainApexMethodInputBaseSchema,
);

/** Parsed input shape, inferred from `explainApexMethodInputSchema`. */
export type ExplainApexMethodInput = z.infer<typeof explainApexMethodInputSchema>;

/**
 * The v1.5 async / API-surface classifier booleans. Each is surfaced
 * explicitly (not collapsed into a single union) so callers can pick
 * per-classifier rendering branches without re-reading the raw flags.
 */
export interface ExplainApexClassifiers {
  readonly isQueueable: boolean;
  readonly isSchedulable: boolean;
  readonly isBatchable: boolean;
  readonly hasFutureMethod: boolean;
  readonly hasInvocableMethod: boolean;
  readonly hasAuraEnabledMethod: boolean;
  readonly isRestResource: boolean;
}

/**
 * One outgoing `callsApex` target. `targetId` is the canonical id of
 * the called class / trigger; `targetApiName` is the bare ApiName so
 * the renderer can inline "calls MyService" without a separate
 * roundtrip.
 */
export interface ExplainApexCall {
  readonly targetId: ComponentId;
  readonly targetApiName: string;
}

/**
 * One field access. `accessType: 'both'` collapses the case where the
 * class both reads and writes the same field — the renderer can
 * surface "reads + writes Account.Industry__c" as a single row.
 */
export interface ExplainApexFieldAccess {
  readonly fieldId: ComponentId;
  readonly accessType: 'read' | 'write' | 'both';
}

/**
 * One v2.1 R2 quality-issue finding, mirrored verbatim from
 * `properties.qualityIssues[]`. These are OBJECTS (not strings), the same
 * shape `sfi.governor_limit_risks` / `sfi.code_quality_audit` consume.
 */
export interface ExplainApexQualityIssue {
  readonly rule: string;
  readonly severity: string;
  readonly location: string;
  readonly explanation: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ExplainApexMethodOutput {
  readonly classApiName: ComponentId;
  readonly apiName: string;
  readonly methodName: string | null;
  readonly type: ComponentType;
  /**
   * For an ApexTrigger, the SObject it fires on (bare api name, e.g.
   * `Payment__c`) and the DML events it handles (e.g. `['after insert']`) —
   * the defining facts of a trigger. `null` / `[]` for an ApexClass. The tool
   * accepts ApexTrigger ids, so dropping these left "explain this trigger" with
   * no object and no timing — only class-level axes.
   */
  readonly triggerObject: string | null;
  readonly events: readonly string[];
  readonly status: string;
  readonly apiVersion: number | null;
  readonly modifiers: readonly string[];
  readonly lineCount: number;
  readonly sourceBytes: number;
  readonly isTest: boolean;
  readonly classifiers: ExplainApexClassifiers;
  readonly calls: readonly ExplainApexCall[];
  /** Heuristic `callsApex` edges with no matching graph node (scanner-only). */
  readonly unresolvedCallTargets: readonly string[];
  readonly fieldAccess: readonly ExplainApexFieldAccess[];
  /**
   * Heuristic `readsFrom`/`writesTo` edges whose RECEIVER did not resolve to an
   * object — Apex `this`/`super` members (e.g. `this.caseLogId`) and
   * un-type-resolved local variables (e.g. `acc.Status__c` where `acc` is a loop
   * variable). Raw `receiver.field` tokens, scanner-only, NOT real object fields.
   * Segregated out of `fieldAccess` the same way `unresolvedCallTargets` is.
   */
  readonly unresolvedFieldAccess: readonly string[];
  readonly qualityIssues: readonly ExplainApexQualityIssue[];
  readonly disclosure: string;  /** P13-ANNOT-tools: curated annotations for the CLASS (provenance `annotation`); absent when none. */
  readonly annotations?: AnnotationsBlock;
}

/**
 * Pull a boolean property with explicit `false` default. The v1.5
 * extractor always emits each classifier (the unconditionally-present
 * property), but the strict-equals check keeps the response shape
 * stable for malformed inputs (e.g., a hand-edited node).
 */
const readBool = (node: Node, key: string): boolean =>
  node.properties[key] === true;

/**
 * Pull a string property with empty-string default. Used for
 * `status`, modifiers, etc. — defaults that the renderer can read
 * without a presence check.
 */
const readString = (node: Node, key: string): string => {
  const raw = node.properties[key];
  return typeof raw === 'string' ? raw : '';
};

/**
 * Pull a string property as `string | null` — empty/absent → null. Used for
 * `triggerObject` (a trigger's SObject; null for a class, which has none).
 */
const readNullableString = (node: Node, key: string): string | null => {
  const raw = node.properties[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * Pull a number property with 0 default. Used for `lineCount` and
 * `sourceBytes` from the v1.5 properties.
 */
const readNumber = (node: Node, key: string): number => {
  const raw = node.properties[key];
  return typeof raw === 'number' ? raw : 0;
};

/**
 * Pull a string-array property. Falls back to the empty array for
 * absent / malformed values. Used for `modifiers`.
 */
const readStringArray = (node: Node, key: string): readonly string[] => {
  const raw = node.properties[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
};

/**
 * Read the v2.1 R2 quality-issue array from `properties.qualityIssues`.
 * Each finding is an OBJECT (`{rule, severity, location, explanation}`), so
 * the generic string-array reader silently dropped EVERY finding — this tool
 * always reported `qualityIssues: []` even when the recognizer fired (the
 * findings `governor_limit_risks` / `code_quality_audit` surface). Mirror the
 * object shape those tools consume.
 */
const readQualityIssues = (node: Node): readonly ExplainApexQualityIssue[] => {
  const raw = node.properties['qualityIssues'];
  if (!Array.isArray(raw)) return [];
  const out: ExplainApexQualityIssue[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const { rule, severity, location, explanation } = obj;
    if (
      typeof rule === 'string' &&
      typeof severity === 'string' &&
      typeof location === 'string' &&
      typeof explanation === 'string'
    ) {
      out.push({ rule, severity, location, explanation });
    }
  }
  return out;
};

/**
 * Build the `classifiers` block from the v1.5 boolean properties.
 * Each classifier is read explicitly so the response shape stays
 * stable even when the v1.5 extractor's defaults shift.
 */
const buildClassifiers = (node: Node): ExplainApexClassifiers => ({
  isQueueable: readBool(node, 'isQueueable'),
  isSchedulable: readBool(node, 'isSchedulable'),
  isBatchable: readBool(node, 'isBatchable'),
  hasFutureMethod: readBool(node, 'hasFutureMethod'),
  hasInvocableMethod: readBool(node, 'hasInvocableMethod'),
  hasAuraEnabledMethod: readBool(node, 'hasAuraEnabledMethod'),
  isRestResource: readBool(node, 'isRestResource'),
});

/**
 * Strip the canonical-id prefix to surface the bare ApiName the
 * renderer wants. Returns the verbatim id for malformed inputs so the
 * renderer always has SOME handle.
 */
const stripPrefix = (id: ComponentId): string => {
  const colonIdx = id.indexOf(':');
  if (colonIdx < 0) return id;
  return id.slice(colonIdx + 1);
};

/**
 * Collect the class's outgoing `callsApex` edges. Only edges whose
 * target exists in the graph become `calls` rows; heuristic scanner
 * edges to missing ApexClass nodes surface in `unresolvedCallTargets`
 * so callers never treat a phantom id as a real component.
 */
const collectCalls = async (
  ctx: Context,
  classId: ComponentId,
): Promise<
  Result<
    {
      readonly calls: readonly ExplainApexCall[];
      readonly unresolvedCallTargets: readonly string[];
    },
    string
  >
> => {
  const edgesResult = await listEdges(ctx.graph, classId, {
    direction: 'out',
    edgeType: 'callsApex',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const out: ExplainApexCall[] = [];
  const unresolved: string[] = [];
  for (const edge of edgesResult.value) {
    const nodeResult = await getNodeById(ctx.graph, edge.toId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    if (nodeResult.value === null) {
      unresolved.push(stripPrefix(edge.toId));
      continue;
    }
    out.push({
      targetId: edge.toId,
      targetApiName: nodeResult.value.apiName,
    });
  }
  return ok({ calls: out, unresolvedCallTargets: unresolved });
};

/**
 * Collect the class's outgoing `readsFrom` and `writesTo` edges and
 * merge them into one `fieldAccess` row per field id. A field that
 * the class both reads and writes collapses to a single row with
 * `accessType: 'both'`.
 *
 * The merge order is deterministic — fields appear in the order
 * `listEdges` returns them (sorted by `(toId, edgeType)`), with the
 * read-or-write classification updated as more edges are seen.
 */
const collectFieldAccess = async (
  ctx: Context,
  classId: ComponentId,
): Promise<
  Result<
    {
      readonly resolved: readonly ExplainApexFieldAccess[];
      readonly unresolved: readonly string[];
    },
    string
  >
> => {
  const readResult = await listEdges(ctx.graph, classId, {
    direction: 'out',
    edgeType: 'readsFrom',
  });
  if (!readResult.ok) return err(readResult.error.message);
  const writeResult = await listEdges(ctx.graph, classId, {
    direction: 'out',
    edgeType: 'writesTo',
  });
  if (!writeResult.ok) return err(writeResult.error.message);

  // Map from fieldId → access kind. We walk reads first, then writes,
  // promoting any field already present to `'both'` when seen on the
  // write side. The Map preserves insertion order in JavaScript, so
  // the deterministic-order axis is satisfied by walking in the same
  // sequence on every call.
  const access = new Map<ComponentId, 'read' | 'write' | 'both'>();
  for (const edge of readResult.value) {
    access.set(edge.toId, 'read');
  }
  for (const edge of writeResult.value) {
    const current = access.get(edge.toId);
    if (current === 'read') {
      access.set(edge.toId, 'both');
    } else if (current === undefined) {
      access.set(edge.toId, 'write');
    }
  }

  // Segregate unresolved receivers (this/super members, local-var aliases) into
  // their own bucket — they are not real object fields. De-dupe the raw tokens
  // (a resolved `FeedComment.CommentBody` and its alias `comment.CommentBody`
  // both appear; the alias goes here, the resolved one stays in fieldAccess).
  const out: ExplainApexFieldAccess[] = [];
  const unresolved = new Set<string>();
  for (const [fieldId, accessType] of access) {
    if (isUnresolvedFieldReceiver(fieldId)) {
      unresolved.add(stripPrefix(fieldId));
    } else {
      out.push({ fieldId, accessType });
    }
  }
  return ok({ resolved: out, unresolved: [...unresolved] });
};

/**
 * Validate the input id's prefix against the two accepted forms.
 * Returns the matched prefix on success, or null when the id is
 * neither an ApexClass nor an ApexTrigger.
 */
const validatePrefix = (id: string): typeof APEX_CLASS_PREFIX | typeof APEX_TRIGGER_PREFIX | null => {
  if (id.startsWith(APEX_CLASS_PREFIX)) return APEX_CLASS_PREFIX;
  if (id.startsWith(APEX_TRIGGER_PREFIX)) return APEX_TRIGGER_PREFIX;
  return null;
};

/**
 * The `sfi.explain_apex_method` MCP tool. Returns a structured
 * narrative payload for one ApexClass (or ApexTrigger): identity,
 * async classifiers, calls, field access, and quality issues. See
 * the module JSDoc for the cascade and the honesty-axis design.
 *
 * @example
 *   const r = await explainApexMethodHandler(ctx, {
 *     classApiName: 'ApexClass:ContactServices',
 *   });
 *   if (r.ok) console.log(r.value.data.classifiers.isQueueable);
 */
export const explainApexMethodHandler = async (
  ctx: Context,
  input: ExplainApexMethodInput,
): Promise<Result<McpResponse<ExplainApexMethodOutput>, McpError>> => {
  const classApiName = coercePrefix(input.classApiName, [
    APEX_CLASS_PREFIX,
    APEX_TRIGGER_PREFIX,
  ]);
  const matchedPrefix = validatePrefix(classApiName);
  if (matchedPrefix === null) {
    return err({
      kind: 'invalid-query',
      message: `classApiName must be an ApexClass/ApexTrigger id (e.g. '${APEX_CLASS_PREFIX}Foo') or a bare class name (e.g. 'Foo'); got '${input.classApiName}'`,
      path: 'classApiName',
    });
  }
  const classId = classApiName as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, classId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, classId, 'ApexClass or ApexTrigger'),
      path: classId,
    });
  }
  const node = nodeResult.value;

  // Defensive: the prefix already pins the expected type set, but the
  // graph could in principle return a node with a different `type`.
  // Treat that as `component-not-found` since the caller's request
  // cannot be satisfied by what the vault holds.
  if (node.type !== 'ApexClass' && node.type !== 'ApexTrigger') {
    return err({
      kind: 'component-not-found',
      message: `node ${classId} is not an ApexClass or ApexTrigger (type=${node.type})`,
      path: classId,
    });
  }

  const callsResult = await collectCalls(ctx, classId);
  if (!callsResult.ok) {
    return err({ kind: 'internal', message: callsResult.error });
  }
  const fieldAccessResult = await collectFieldAccess(ctx, classId);
  if (!fieldAccessResult.ok) {
    return err({ kind: 'internal', message: fieldAccessResult.error });
  }

  const data: ExplainApexMethodOutput = {
    classApiName: classId,
    apiName: node.apiName,
    methodName: input.methodName ?? null,
    type: node.type,
    triggerObject: readNullableString(node, 'triggerObject'),
    events: readStringArray(node, 'events'),
    status: readString(node, 'status'),
    apiVersion: node.apiVersion,
    modifiers: readStringArray(node, 'modifiers'),
    lineCount: readNumber(node, 'lineCount'),
    sourceBytes: readNumber(node, 'sourceBytes'),
    isTest: readBool(node, 'isTest'),
    classifiers: buildClassifiers(node),
    calls: callsResult.value.calls,
    unresolvedCallTargets: callsResult.value.unresolvedCallTargets,
    fieldAccess: fieldAccessResult.value.resolved,
    unresolvedFieldAccess: fieldAccessResult.value.unresolved,
    qualityIssues: readQualityIssues(node),
    disclosure:
      DISCLOSURE +
      (callsResult.value.unresolvedCallTargets.length > 0
        ? UNRESOLVED_CALLS_SUFFIX
        : '') +
      (fieldAccessResult.value.unresolved.length > 0
        ? UNRESOLVED_FIELDS_SUFFIX
        : ''),
  };

  const annotations = await annotationsBlockFor(ctx, classId);

  return ok({
    data: { ...data, ...(annotations !== undefined ? { annotations } : {}) },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
