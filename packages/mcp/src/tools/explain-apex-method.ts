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
 * METHOD-SCOPE-NEVER-APPLIED: the bare echo used to be the ONLY trace of
 * that, which reads as "honoured" — the payload underneath still described
 * the whole class, so mirrored `qualityIssues[].location` line numbers
 * pointed at methods the caller never asked about. The echo now travels with
 * a typed {@link ExplainApexMethodScope} block (`applied: false`) and, when a
 * method WAS named, a verbatim `disclosure` paragraph that says the line
 * numbers are class-wide and names `sfi.apex_structure` as the tool whose
 * `method` parameter actually narrows.
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
 *     mirror permanently `[]`.) When the node carries no `qualityIssues` KEY
 *     at all it was never scanned, and `qualityIssues: []` alone said "we
 *     looked and found nothing" about a node nothing looked at — on a real
 *     vault, all 22 ApexTriggers. The array shape is kept (callers depend on
 *     it) but the `disclosure` now carries
 *     {@link QUALITY_NOT_SCANNED_SUFFIX} on that path, so an empty mirror
 *     reads as NOT CHECKED rather than CLEAN
 *     (QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS).
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
import {
  apexReceiverDemotionCounts,
  apexReceiverDemotionNote,
  apexReceiverNotCheckedNote,
  apexReceiverTokens,
  classifyApexTarget,
  resolveApexReceivers,
  type ApexReceiverDemotionCounts,
  type ApexUnresolvedTarget,
} from './apex-receiver.js';
import { coercePrefix } from './coerce-id.js';
import {
  buildReservedConceptReasoning,
  CONCEPT_REASONING_SKIPPED_NOTE,
  CONCEPT_REASONING_UNAVAILABLE_NOTE,
  type ConceptReasoningEnvelope,
} from './concept-reasoning.js';
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
/**
 * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Appended when the resolved node
 * carries no `qualityIssues` KEY at all — it was never scanned, so the empty
 * `qualityIssues` array is "not checked", never "clean".
 */
const QUALITY_NOT_SCANNED_SUFFIX =
  ' This component carries no `qualityIssues` property, so the code-quality recognizers never ran over its source: the empty `qualityIssues` array below is NOT CHECKED, not clean. This vault predates the extractor that scans this component type — re-run `sfi refresh` to close the gap.';

const UNRESOLVED_FIELDS_SUFFIX =
  ' Field accesses whose receiver could not be resolved to an object — Apex `this`/`super` members and un-type-resolved local variables (e.g. a loop variable) — are listed in unresolvedFieldAccess as raw `receiver.field` tokens, NOT in fieldAccess; they are not verified object fields.';

/**
 * APEX-RECEIVER-VERIFIED. `fieldAccess` used to be whatever the Apex scanner's
 * TEXTUAL receiver split produced, checked against nothing: an Apex class name,
 * an inner DTO, a `__r` traversal, and a describe token (`Contact.fields`) all
 * read as real object fields. Every receiver is now verified against the vault
 * in one batched query before its id is claimed. This names that check ran, so
 * a caller can tell a verified list from the old unverified one.
 */
const RECEIVER_VERIFIED_SUFFIX =
  ' Every `readsFrom`/`writesTo` receiver behind fieldAccess is VERIFIED against this vault: a `CustomField:` id is claimed ONLY when its receiver names an SObject node here. Anything else is a raw token in unresolvedFieldAccess with a typed reason (see unresolvedFieldAccessReasons) — demoted and named, never dropped and never claimed.';

/**
 * METHOD-SCOPE-NEVER-APPLIED. The tool named `methodName` in its signature,
 * echoed it back at the top of the payload, and then narrowed NOTHING: on a
 * ~580-line class every mirrored `qualityIssues[].location` line number landed
 * in some OTHER method than the one asked about, and no field of the response
 * said the narrowing had been declined. The echo alone reads as "honoured".
 *
 * It cannot be honoured here. This tool narrates the class from graph NODE
 * PROPERTIES, and an ApexClass node carries no per-method line ranges — only
 * `sfi.apex_structure`, which re-parses the source with the Apex grammar, has
 * a `line`/`endLine` span per method. So the fix is DISCLOSURE, not analysis:
 * {@link ExplainApexMethodOutput.methodScope} is the typed half a machine
 * consumer cannot skip, and this suffix is the half a host reads aloud.
 */
const METHOD_SCOPE_NARROWER_TOOL = 'sfi.apex_structure';

/** Why {@link ExplainApexMethodScope.applied} is always `false`. */
const METHOD_SCOPE_NOT_APPLIED_REASON =
  'this tool narrates the class from graph node properties, which carry no per-method line ranges, so it cannot subset any section by method';

const methodScopeNotAppliedSuffix = (classId: string, methodName: string): string =>
  ` METHOD SCOPE NOT APPLIED: you passed methodName '${methodName}' and it was NOT used to narrow this answer — it is echoed back verbatim only (see \`methodScope.applied: false\`). EVERY section below describes the WHOLE class: lineCount, calls, fieldAccess, qualityIssues and conceptReasoning. In particular the \`location\` line numbers on qualityIssues are CLASS-WIDE and will usually fall inside OTHER methods — do NOT report them as findings in '${methodName}'. Reason: ${METHOD_SCOPE_NOT_APPLIED_REASON}. For method-level granularity — each method with its line/endLine span and each SOQL/DML site attributed to its enclosing method — call \`${METHOD_SCOPE_NARROWER_TOOL}\` with { classRef: '${classId}', method: '${methodName}' } — an unknown method name is refused there, naming the methods the class DOES declare.`;

/**
 * Zod schema for the `sfi.explain_apex_method` tool input.
 *
 *   - `classApiName`: required, non-empty string. The canonical
 *     ApexClass id (`ApexClass:{ClassName}`) or ApexTrigger id
 *     (`ApexTrigger:{TriggerName}`). Other prefixes surface as
 *     `invalid-query` from the handler.
 *   - `methodName`: optional. ACCEPTED BUT NEVER APPLIED — carried verbatim
 *     into the response so callers can pass it through to a future v2.7
 *     method-scoped narrative. Nothing is subset by method, and the response
 *     says so in the typed `methodScope` block and in `disclosure` rather than
 *     letting the echo read as "honoured".
 */
const explainApexMethodInputBaseSchema = z.object({
  classApiName: z.string().min(1),
  methodName: z.string().min(1).optional(),
  // Concept-rule reasoning; DEFAULTS TRUE (opt-OUT). See `conceptReasoning`.
  includeConceptReasoning: z.boolean().optional(),
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
 * Authoritative sharing-enforcement semantics for a class, composed
 * deterministically from the declared sharing keyword (`modifiers`) and the
 * async classifiers — NOT a runtime trace. This block exists to head off the
 * single most common Apex misconception: that a top-level class with NO
 * sharing keyword "defaults to `without sharing`". It does not — an
 * unannotated top-level class INHERITS THE CALLER'S sharing context. The
 * platform truth a sharing question must carry:
 *
 *   - `declared` — the source sharing keyword (`with sharing` /
 *     `without sharing` / `inherited sharing`) or `null` when none is
 *     declared. Read from the class node's `properties.sharingModel` (the
 *     extractor's own read of the class DECLARATION — see
 *     {@link readDeclaredSharingFromNode}), never from the `.cls-meta.xml`.
 *   - `effectiveModel` — what enforcement actually applies:
 *       • a declared keyword maps to itself;
 *       • NO keyword on a SYNCHRONOUS entry inherits the caller's context
 *         (`inherits-caller`), so it can be with- OR without-sharing depending
 *         on who called it — it is NOT `without sharing` by default;
 *       • NO keyword on an ASYNC entry (batch / schedulable / queueable /
 *         future) that the PLATFORM invokes runs in `system-context` — there
 *         is no Apex caller whose sharing context can be inherited, and async
 *         Apex executes in system mode, so record sharing ends up NOT enforced
 *         (because of system-context execution, NOT because "without sharing
 *         is the default").
 *   - `runsAsSystem` — true when the class is async-entry (batch / schedulable
 *     / queueable / future). Async Apex runs as the SYSTEM, never impersonating
 *     the user who submitted or scheduled the job.
 *   - `note` — a verbatim platform-semantics line the renderer surfaces so the
 *     answer never falls back on the "no keyword = without sharing" myth.
 */
export interface ExplainApexSharingSemantics {
  readonly declared: 'with sharing' | 'without sharing' | 'inherited sharing' | null;
  readonly effectiveModel:
    | 'with sharing'
    | 'without sharing'
    | 'inherited sharing'
    | 'inherits-caller'
    | 'system-context';
  readonly runsAsSystem: boolean;
  readonly note: string;
}

/**
 * The sharing keyword was NOT READ — a third state, distinct from both "a
 * keyword is declared" and "no keyword is declared".
 *
 * Same vocabulary as `sfi.apex_structure`'s `ApexSharingNotRead`
 * (`effectiveModel: 'not-read'`), so the two tools cannot answer the same
 * question in two different languages. It arises when the vault node carries
 * NEITHER `properties.sharingModel` NOR a sharing keyword inside
 * `properties.modifiers`: nothing in this answer looked at the class
 * declaration. Reporting `inherits-caller` there would be a WRONG SECURITY
 * ANSWER — a `without sharing` class on such a node presents identically — so
 * no enforcement model is asserted at all.
 */
export interface ExplainApexSharingNotRead {
  readonly declared: null;
  readonly effectiveModel: 'not-read';
  /**
   * Derived from the vault's async classifiers, which are independent of the
   * class declaration — `null` when the node carries none of them either, so
   * the `false` a bare boolean would show is never an unchecked zero.
   */
  readonly runsAsSystem: boolean | null;
  readonly note: string;
}

/** The sharing block: the composed semantics, or the NOT-READ state. */
export type ExplainApexSharing = ExplainApexSharingSemantics | ExplainApexSharingNotRead;

/**
 * Where the sharing keyword was read from — the same axis
 * `sfi.apex_structure` exposes as `meta.sharingSource`, with one extra member
 * for the property this tool reads (`apex_structure` reaches the same fact
 * through its own source parse).
 *
 *   - `node-sharing-model`      — `properties.sharingModel`, the extractor's
 *     structured read of the class declaration. The normal path.
 *   - `node-modifiers`          — legacy layout: the keyword was joined into
 *     `properties.modifiers` (e.g. `['global', 'with sharing']`).
 *   - `trigger-system-context`  — an ApexTrigger, which CANNOT declare one.
 *   - `not-read`                — nothing carried it; see
 *     {@link ExplainApexSharingNotRead}.
 */
export type ExplainApexSharingSource =
  | 'node-sharing-model'
  | 'node-modifiers'
  | 'trigger-system-context'
  | 'not-read';

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

/**
 * What the `methodName` input actually did to this answer — nothing.
 *
 * Present on EVERY response (not only when a method was named), because a
 * caller diffing two responses has to be able to read the scope off the payload
 * without inferring it from which keys are missing.
 *
 * `applied` is the literal type `false`, not `boolean`: it is a compile-time
 * promise that no code path here can claim a narrowing it did not perform.
 * When method-level granularity actually lands, widening this type is the
 * deliberate edit that makes the claim.
 */
export interface ExplainApexMethodScope {
  /** The `methodName` the caller passed, verbatim. `null` when none was. */
  readonly requested: string | null;
  /** ALWAYS false — see {@link METHOD_SCOPE_NOT_APPLIED_REASON}. */
  readonly applied: false;
  /** What every section of this payload describes. Always the whole class. */
  readonly scope: 'class';
  /** Why `applied` is false. Always populated, whether or not one was asked for. */
  readonly reason: string;
  /** The tool that DOES narrow to one method (its `method` parameter). */
  readonly narrowerTool: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ExplainApexMethodOutput {
  readonly classApiName: ComponentId;
  readonly apiName: string;
  /**
   * The requested method name, echoed verbatim. READ
   * {@link ExplainApexMethodOutput.methodScope} BESIDE IT: this echo does NOT
   * mean the answer was narrowed to that method. It never is.
   */
  readonly methodName: string | null;
  /**
   * METHOD-SCOPE-NEVER-APPLIED — the typed statement that `methodName` narrowed
   * nothing, so a machine consumer cannot skip past it the way it can skip
   * prose. `applied` is always `false` and `scope` is always `'class'`.
   */
  readonly methodScope: ExplainApexMethodScope;
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
  /**
   * Deterministic sharing-enforcement semantics (see
   * {@link ExplainApexSharingSemantics}). Always present so a "does this run
   * with sharing?" question is answered from platform rules, not the
   * "no keyword = without sharing" misconception. When NOTHING carried the
   * keyword the block is {@link ExplainApexSharingNotRead} — a third state, not
   * a guessed `inherits-caller`.
   */
  readonly sharingSemantics: ExplainApexSharing;
  /**
   * Which input the sharing keyword was read from (or that nothing read it).
   * Matches `sfi.apex_structure`'s `meta.sharingSource` vocabulary so a caller
   * comparing the two tools sees one axis, not two.
   */
  readonly sharingSource: ExplainApexSharingSource;
  readonly calls: readonly ExplainApexCall[];
  /** Heuristic `callsApex` edges with no matching graph node (scanner-only). */
  readonly unresolvedCallTargets: readonly string[];
  readonly fieldAccess: readonly ExplainApexFieldAccess[];
  /**
   * `readsFrom`/`writesTo` edges whose RECEIVER is not an SObject in this vault.
   * Raw `receiver.field` tokens, NOT component ids and NOT object fields —
   * segregated out of `fieldAccess` the same way `unresolvedCallTargets` is.
   *
   * Originally this held only the shapes a LEXICAL test could catch (Apex
   * `this`/`super` members, lowercase locals like `acc.Status__c`). It now also
   * holds every receiver the vault says is not an SObject: an Apex class or
   * trigger name, an inner DTO, a `__r` traversal, a describe token
   * (`Contact.fields`). Those used to reach `fieldAccess` as if they were real
   * fields. Read {@link ExplainApexMethodOutput.unresolvedFieldAccessReasons}
   * for WHY each one is here — the tokens alone cannot say.
   */
  readonly unresolvedFieldAccess: readonly string[];
  /**
   * The same tokens as `unresolvedFieldAccess`, each with the typed reason it
   * was demoted. Kept beside the string list (rather than replacing it) because
   * callers pin that list's shape.
   *
   * `receiver-not-in-vault` is the one tier that cannot be read either way: it
   * mixes a real standard SObject this vault did not retrieve with an Apex
   * system type and an inner class, and nothing here separates them.
   */
  readonly unresolvedFieldAccessReasons: readonly ApexUnresolvedTarget[];
  /**
   * Did the receiver verification actually RUN? `checked: false` means the
   * batched vault lookup FAILED, so `fieldAccess` is empty because nothing
   * could be verified — never because the class touches no fields. `demoted`
   * is `null` on that path (no census exists), and every target appears in
   * `unresolvedFieldAccess` with reason `receiver-not-verified`.
   */
  readonly receiverVerification: {
    readonly checked: boolean;
    /** Why the check did not run. `null` when it did. */
    readonly reason: string | null;
    /** Per-reason census of demoted targets. `null` when `checked` is false. */
    readonly demoted: ApexReceiverDemotionCounts | null;
  };
  readonly qualityIssues: readonly ExplainApexQualityIssue[];
  readonly disclosure: string;  /** P13-ANNOT-tools: curated annotations for the CLASS (provenance `annotation`); absent when none. */
  readonly annotations?: AnnotationsBlock;
  /**
   * REASONING-REACHABILITY — deterministic concept-rule claims about THIS class
   * or trigger, on the shared `EvidenceEnvelopeV2` contract plus a
   * `completeness` report that keeps "checked and found nothing" distinct from
   * "never checked". DEFAULT ON — absent only when the caller passed
   * `includeConceptReasoning: false`, or the reasoning read failed (in which
   * case the block is omitted rather than the answer failed).
   *
   * ApexClass is the single largest anchor in the concept model — 26 of the 133
   * node-shaped rules bind on it (sharing posture, async boundaries, external
   * API surface, injection / governor quality defects, test quality) — so an
   * "explain this class" answer without them would be leaving the product's own
   * analysis on the floor.
   *
   * Read `completeness.noRuleCoversComponentType` FIRST: when true, no concept
   * rule applies to this component type and an empty `claims` list means
   * NOTHING WAS CHECKED — never "clean".
   */
  readonly conceptReasoning?: ConceptReasoningEnvelope;
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

/** The three sharing keywords a top-level Apex class may declare. */
type DeclaredSharing = 'with sharing' | 'without sharing' | 'inherited sharing';

/** Recognise a sharing keyword in whatever casing/whitespace a vault stored. */
const asDeclaredSharing = (raw: unknown): DeclaredSharing | null => {
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().toLowerCase();
  if (norm === 'with sharing') return 'with sharing';
  if (norm === 'without sharing') return 'without sharing';
  if (norm === 'inherited sharing') return 'inherited sharing';
  return null;
};

/**
 * Read the declared sharing keyword out of the class's `modifiers`. Kept for
 * the LEGACY vault layout, where the extractor joined the keyword into the
 * modifier list (e.g. `['global', 'with sharing']`). The current extractor
 * does NOT: it splits the class header into `modifiers` (access/abstract/
 * virtual only) and `sharingModel` (the keyword), so a keyword-carrying
 * `modifiers` array is now the exception, not the rule.
 */
const readDeclaredSharing = (modifiers: readonly string[]): DeclaredSharing | null => {
  for (const m of modifiers) {
    const found = asDeclaredSharing(m);
    if (found !== null) return found;
  }
  return null;
};

/** What a sharing read found, and where it found it. */
interface SharingRead {
  readonly declared: DeclaredSharing | null;
  readonly source: ExplainApexSharingSource;
  /**
   * A `sharingModel` value present on the node that is not one of the three
   * platform keywords. Named verbatim in the NOT-READ note rather than
   * silently coerced to "no keyword declared".
   */
  readonly unrecognizedValue: string | null;
}

/**
 * Read the class's DECLARED sharing keyword off the vault node.
 *
 * SHARING-KEYWORD-LIVES-IN-SHARINGMODEL. The extractor writes the keyword to
 * `properties.sharingModel` and leaves it OUT of `properties.modifiers`
 * (`apex-header-parser` collects the two separately). Reading only `modifiers`
 * therefore answered `declared: null` for EVERY class that declares a keyword —
 * including every `without sharing` class, the security-relevant direction,
 * which was reported as inheriting the caller's context when it does not.
 *
 * Cascade, keyword-first so a keyword found ANYWHERE wins:
 *   1. `properties.sharingModel` holds a keyword → that, `node-sharing-model`.
 *   2. `properties.modifiers` holds one (legacy layout) → that, `node-modifiers`.
 *   3. `properties.sharingModel` is present and explicitly `null` → the
 *      extractor READ the declaration and found no keyword: `declared: null`,
 *      `node-sharing-model`. This is the real "no keyword" case.
 *   4. otherwise → `not-read`. NEITHER property carried the keyword, so the
 *      declaration was never looked at and no model is asserted.
 */
const readDeclaredSharingFromNode = (node: Node): SharingRead => {
  const raw = node.properties['sharingModel'];
  const fromProperty = asDeclaredSharing(raw);
  if (fromProperty !== null) {
    return { declared: fromProperty, source: 'node-sharing-model', unrecognizedValue: null };
  }
  const fromModifiers = readDeclaredSharing(readStringArray(node, 'modifiers'));
  if (fromModifiers !== null) {
    return { declared: fromModifiers, source: 'node-modifiers', unrecognizedValue: null };
  }
  if (raw === null) {
    return { declared: null, source: 'node-sharing-model', unrecognizedValue: null };
  }
  return {
    declared: null,
    source: 'not-read',
    unrecognizedValue: raw === undefined ? null : JSON.stringify(raw),
  };
};

/**
 * Sharing semantics for an ApexTrigger. A trigger CANNOT declare a sharing
 * keyword, so `declared: null` here means "the keyword does not exist for this
 * component type", not "one was omitted" — and `inherits-caller` would be a
 * wrong security answer, because the platform's DML invokes a trigger with no
 * Apex caller to inherit from. Byte-identical to `sfi.apex_structure`'s
 * `TRIGGER_SHARING`, so the two tools answer this with one voice.
 */
const TRIGGER_SHARING: ExplainApexSharingSemantics = {
  declared: null,
  effectiveModel: 'system-context',
  runsAsSystem: true,
  note: 'An Apex trigger CANNOT declare a sharing keyword — `declared: null` here means the keyword does not exist for this component type, not that one was omitted. Triggers execute in SYSTEM CONTEXT: record sharing, object CRUD, and field-level security are NOT enforced for the running user, and any class the trigger calls that declares no sharing keyword inherits that system context. To enforce sharing for the work a trigger does, move the logic into a `with sharing` handler class and call that.',
};

/** The v1.5 classifier property keys, in one place for the presence check. */
const CLASSIFIER_KEYS = [
  'isQueueable',
  'isSchedulable',
  'isBatchable',
  'hasFutureMethod',
  'hasInvocableMethod',
  'hasAuraEnabledMethod',
  'isRestResource',
] as const;

/** True when the vault node carries the classifier family at all. */
const classifiersAvailable = (node: Node): boolean =>
  CLASSIFIER_KEYS.some((key) => Object.hasOwn(node.properties, key));

/**
 * The sharing block for a CLASS whose keyword NOBODY READ. Mirrors
 * `sfi.apex_structure`'s `sharingNotRead` state and vocabulary.
 */
const sharingNotRead = (
  runsAsSystem: boolean | null,
  unrecognizedValue: string | null,
): ExplainApexSharingNotRead => ({
  declared: null,
  effectiveModel: 'not-read',
  runsAsSystem,
  note:
    `NOT READ — the sharing keyword was not read from ANYWHERE for this class: this vault node carries no \`sharingModel\` property and no sharing keyword inside \`modifiers\`.${
      unrecognizedValue === null
        ? ''
        : ` The node's \`sharingModel\` value ${unrecognizedValue} is not one of the three platform keywords, so it was NOT interpreted.`
    } This is NOT "no keyword is declared" and NOT \`inherits-caller\`: a \`without sharing\` class on such a node presents exactly like this, so no enforcement model is asserted here. Read the \`.cls\` directly, or re-run /sfi-refresh so the node carries \`sharingModel\`.${
      runsAsSystem === null
        ? ' `runsAsSystem` is null for the same reason class of absence: this node carries none of the async classifier properties either, so whether the platform runs this as the system was NOT CHECKED.'
        : ' `runsAsSystem` IS known — it comes from the vault\'s async classifiers, which do not depend on the class declaration.'
    }`,
});

/** Verbatim disclosure suffix appended when the sharing keyword was NOT READ. */
const SHARING_NOT_READ_SUFFIX =
  ' The sharing keyword was NOT READ for this component (see `sharingSemantics.effectiveModel: "not-read"` and `sharingSource`): the vault node carries neither `sharingModel` nor a keyword-bearing `modifiers` array, so no enforcement model is asserted — this is NOT "no keyword is declared".';

/**
 * Compose the authoritative {@link ExplainApexSharingSemantics} block from the
 * declared sharing keyword and the async classifiers. Deterministic, no graph
 * reads. Encodes the platform rules so a sharing question is never answered
 * with the "no keyword = without sharing" myth.
 */
/**
 * Exported so `sfi.apex_structure` composes THIS sharing reasoning rather than
 * restating it. The "no keyword ≠ without sharing" platform truth must have
 * exactly one implementation — two copies would drift, and a drifted security
 * answer is worse than no answer.
 */
export const buildSharingSemantics = (
  declared: 'with sharing' | 'without sharing' | 'inherited sharing' | null,
  classifiers: ExplainApexClassifiers,
): ExplainApexSharingSemantics => {
  const runsAsSystem =
    classifiers.isBatchable ||
    classifiers.isSchedulable ||
    classifiers.isQueueable ||
    classifiers.hasFutureMethod;

  if (declared !== null) {
    const note =
      `Class declares \`${declared}\`, so record sharing is enforced per that keyword regardless of caller.` +
      (runsAsSystem
        ? ' Note: as async Apex (batch/schedulable/queueable/future) it still runs in SYSTEM context as the system — it does NOT impersonate the user who submitted or scheduled it — and CRUD/FLS are NOT enforced unless the code checks them explicitly (WITH SECURITY_ENFORCED / Security.stripInaccessible / Schema describe).'
        : ' CRUD/FLS are NOT enforced by the sharing keyword — they need explicit checks (WITH SECURITY_ENFORCED / Security.stripInaccessible / Schema describe).');
    return { declared, effectiveModel: declared, runsAsSystem, note };
  }

  // No sharing keyword declared.
  if (runsAsSystem) {
    return {
      declared: null,
      effectiveModel: 'system-context',
      runsAsSystem: true,
      note:
        'No sharing keyword is declared. A no-keyword top-level class does NOT default to `without sharing` — it inherits the caller\'s sharing context. But this class is async Apex (batch/schedulable/queueable/future): the platform invokes it with no Apex caller context to inherit AND async Apex runs in SYSTEM context, so record sharing ends up NOT enforced — because of system-context execution, NOT because "without sharing is the default". It runs as the system, never as the user who submitted/scheduled it. To enforce sharing, declare `with sharing`. IMPORTANT: sharing enforcement and CRUD/FLS are INDEPENDENT security layers — system-context execution means record sharing is not enforced, but object/field CRUD/FLS checks are a separate mechanism that applies regardless of the sharing model unless the code explicitly skips them (WITH SECURITY_ENFORCED / Security.stripInaccessible / Schema describe).',
    };
  }
  return {
    declared: null,
    effectiveModel: 'inherits-caller',
    runsAsSystem: false,
    note:
      'No sharing keyword is declared. A no-keyword top-level class does NOT default to `without sharing` — it INHERITS THE CALLER\'S sharing context, so enforcement is with- or without-sharing depending on the entry point that invoked it. To pin enforcement, declare `with sharing` or `without sharing` explicitly. CRUD/FLS are a separate concern and need explicit checks regardless.',
  };
};

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
      readonly unresolvedReasons: readonly ApexUnresolvedTarget[];
      /** False when the receiver-verification query failed; `reason` says why. */
      readonly checked: boolean;
      readonly checkFailureReason: string | null;
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

  // APEX-RECEIVER-VERIFIED. Ask the vault ONCE what every receiver token IS,
  // then keep in `fieldAccess` only the ids whose receiver names an SObject
  // NODE here. The old lexical test caught `this.x` and lowercase locals and
  // nothing else, so an Apex class name, an inner DTO, a `__r` traversal and a
  // describe token all reached `fieldAccess` as if they were object fields.
  //
  // A FAILED probe is reported, never worked around: falling back to the
  // lexical guess is the defect. Everything is demoted with
  // `receiver-not-verified` and `checked` goes false.
  const probe = await resolveApexReceivers(ctx.graph, apexReceiverTokens(access.keys()));
  const index = probe.ok ? probe.value : null;

  // De-dupe the raw tokens (a resolved `FeedComment.CommentBody` and its alias
  // `comment.CommentBody` both appear; the alias goes here, the resolved one
  // stays in fieldAccess). First reason wins — the tiers are disjoint per id.
  const out: ExplainApexFieldAccess[] = [];
  const unresolved = new Map<string, ApexUnresolvedTarget>();
  for (const [fieldId, accessType] of access) {
    const verdict = classifyApexTarget(fieldId, index);
    if (verdict.resolved) {
      out.push({ fieldId, accessType });
      continue;
    }
    if (!unresolved.has(verdict.unresolved.token)) {
      unresolved.set(verdict.unresolved.token, verdict.unresolved);
    }
  }
  return ok({
    resolved: out,
    unresolved: [...unresolved.keys()],
    unresolvedReasons: [...unresolved.values()],
    checked: probe.ok,
    checkFailureReason: probe.ok ? null : probe.error,
  });
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

  const modifiers = readStringArray(node, 'modifiers');
  const classifiers = buildClassifiers(node);
  // SHARING-KEYWORD-LIVES-IN-SHARINGMODEL — the keyword comes off the node's
  // `sharingModel` property (legacy vaults: `modifiers`), and an ApexTrigger
  // cannot declare one at all. A node carrying neither is NOT-READ, never a
  // guessed `inherits-caller`.
  const sharingRead =
    node.type === 'ApexTrigger'
      ? ({
          declared: null,
          source: 'trigger-system-context',
          unrecognizedValue: null,
        } as const satisfies SharingRead)
      : readDeclaredSharingFromNode(node);
  const sharingSemantics: ExplainApexSharing =
    sharingRead.source === 'trigger-system-context'
      ? TRIGGER_SHARING
      : sharingRead.source === 'not-read'
        ? sharingNotRead(
            classifiersAvailable(node)
              ? classifiers.isBatchable ||
                classifiers.isSchedulable ||
                classifiers.isQueueable ||
                classifiers.hasFutureMethod
              : null,
            sharingRead.unrecognizedValue,
          )
        : buildSharingSemantics(sharingRead.declared, classifiers);
  const data: ExplainApexMethodOutput = {
    classApiName: classId,
    apiName: node.apiName,
    methodName: input.methodName ?? null,
    methodScope: {
      requested: input.methodName ?? null,
      applied: false,
      scope: 'class',
      reason: METHOD_SCOPE_NOT_APPLIED_REASON,
      narrowerTool: METHOD_SCOPE_NARROWER_TOOL,
    },
    type: node.type,
    triggerObject: readNullableString(node, 'triggerObject'),
    events: readStringArray(node, 'events'),
    status: readString(node, 'status'),
    apiVersion: node.apiVersion,
    modifiers,
    lineCount: readNumber(node, 'lineCount'),
    sourceBytes: readNumber(node, 'sourceBytes'),
    isTest: readBool(node, 'isTest'),
    classifiers,
    sharingSemantics,
    sharingSource: sharingRead.source,
    calls: callsResult.value.calls,
    unresolvedCallTargets: callsResult.value.unresolvedCallTargets,
    fieldAccess: fieldAccessResult.value.resolved,
    unresolvedFieldAccess: fieldAccessResult.value.unresolved,
    unresolvedFieldAccessReasons: fieldAccessResult.value.unresolvedReasons,
    receiverVerification: {
      checked: fieldAccessResult.value.checked,
      reason: fieldAccessResult.value.checkFailureReason,
      demoted: fieldAccessResult.value.checked
        ? apexReceiverDemotionCounts(fieldAccessResult.value.unresolvedReasons)
        : null,
    },
    qualityIssues: readQualityIssues(node),
    disclosure:
      DISCLOSURE +
      (callsResult.value.unresolvedCallTargets.length > 0
        ? UNRESOLVED_CALLS_SUFFIX
        : '') +
      (fieldAccessResult.value.unresolved.length > 0
        ? UNRESOLVED_FIELDS_SUFFIX
        : '') +
      // The verification axis rides `disclosure` because this tool has no
      // `boundaries[]`. It is ALWAYS said — a demotion census of zero has to
      // read as CHECKED-and-nothing-demoted, and a failed probe has to read as
      // NOT CHECKED. Silence would collapse the two.
      (fieldAccessResult.value.checked
        ? RECEIVER_VERIFIED_SUFFIX +
          apexReceiverDemotionNote(
            apexReceiverDemotionCounts(fieldAccessResult.value.unresolvedReasons),
            'fieldAccess',
            'unresolvedFieldAccess',
          )
        : apexReceiverNotCheckedNote(
            fieldAccessResult.value.checkFailureReason ?? 'reason not reported',
            'fieldAccess',
          )) +
      (Object.hasOwn(node.properties, 'qualityIssues')
        ? ''
        : QUALITY_NOT_SCANNED_SUFFIX) +
      (sharingRead.source === 'not-read' ? SHARING_NOT_READ_SUFFIX : '') +
      // Said ONLY when a method was actually named. A caller who asked no
      // method-scoped question is not misreading anything, and adding the
      // paragraph to every response would train hosts to skip it.
      (input.methodName !== undefined
        ? methodScopeNotAppliedSuffix(classId, input.methodName)
        : ''),
  };

  const annotations = await annotationsBlockFor(ctx, classId);

  // REASONING-REACHABILITY — the class node is already resolved, so this costs
  // one bound-type edge query + one endpoint node query (both capped). A failed
  // read omits the block rather than failing an otherwise complete answer.
  const reservedReasoning =
    input.includeConceptReasoning === false
      ? null
      : await buildReservedConceptReasoning(ctx, classId, { rootNode: node });
  const conceptReasoning: ConceptReasoningEnvelope | null =
    reservedReasoning?.envelope ?? null;
  // R3 — every path must SAY what happened to the reasoning layer. Absence of
  // the block is not evidence of absence, so neither an opt-out nor a failed
  // read may be silent. This tool has no `boundaries[]`, so it rides the
  // `disclosure` string (appended, never replacing the pinned honesty axis).
  const conceptNote =
    conceptReasoning !== null
      ? ` Concept reasoning: ${conceptReasoning.completeness.summary}`
      : input.includeConceptReasoning === false
        ? ` ${CONCEPT_REASONING_SKIPPED_NOTE}`
        : ` ${CONCEPT_REASONING_UNAVAILABLE_NOTE(classId)}`;

  return ok({
    data: {
      ...data,
      disclosure: data.disclosure + conceptNote,
      ...(annotations !== undefined ? { annotations } : {}),
      ...(conceptReasoning !== null ? { conceptReasoning } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
