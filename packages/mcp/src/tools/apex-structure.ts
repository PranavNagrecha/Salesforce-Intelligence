/**
 * Handler for the `sfi.apex_structure` MCP tool — the APEX half of the
 * "explain it properly" pair whose Flow half is `sfi.flow_graph(walkthrough)`.
 *
 * A developer handed an unfamiliar Apex class asks five things, in this order:
 * **what does it do, how does it run, what does it touch, what is risky about
 * it, and what would a reviewer say?** No existing tool answers them together,
 * and none of them answers the first at all:
 *
 *   - `sfi.explain_apex_method` narrates the CLASS from graph node properties.
 *     It has no method inventory — no signatures, no visibility, no per-method
 *     annotations, no inner types. ("Method-level granularity" is a deferred
 *     milestone in its own header.)
 *   - `sfi.call_graph` / `sfi.method_reachability` walk BETWEEN classes.
 *   - `sfi.code_quality_audit` / `sfi.governor_limit_risks` sweep the ORG for
 *     recognizer findings; neither reads the class.
 *   - `sfi.find_dead_code` / `sfi.apex_test_coverage` answer usage, not shape.
 *
 * This tool parses the `.cls` / `.trigger` ON DEMAND with the ANTLR Apex
 * grammar the repo already vendors, and composes — never re-implements — the
 * answers the other tools own:
 *
 *   | section       | composed from                                          |
 *   | ------------- | ------------------------------------------------------ |
 *   | `structure`   | NEW — `parseApexStructure` (packages/parsers)           |
 *   | `meta.sharing`| `explain_apex_method`'s `buildSharingSemantics`         |
 *   | `entryPoints` | `sfi.method_reachability` + the parsed annotations      |
 *   | `tests`       | `sfi.method_reachability`'s `reachingTestClasses`       |
 *   | `review`      | `properties.qualityIssues[]` (the 19-rule recognizer    |
 *   |               | catalog) PLUS eight AST-only checks it cannot express   |
 *   | `touches`     | the vault's own `readsFrom` / `writesTo` edges          |
 *
 * ## The honesty spine
 *
 * 1. **A parse failure yields `structure: null`, never an empty structure.**
 *    "The parser could not read this file" and "this file declares nothing"
 *    must never render the same. `parse.reason` says which happened.
 * 2. **Absent is `null` with a reason, never `false` / `0` / `[]`.** A vault
 *    that predates the async classifiers reports
 *    `entryPoints.runsInSeparateTransaction: null` with the reason, not
 *    `false`. `meta.lineCount` is `null` on a vault that never recorded it.
 *    `meta.sharing.declared` is `null` when NO keyword was written — the
 *    single most consequential null in the payload, because Apex does not
 *    default a no-keyword class to `without sharing`.
 * 3. **Every zero is labelled CHECKED or UNCHECKED.** Each zero-able section
 *    carries `checked` plus a `note` saying what its emptiness means, and a
 *    `coverageCaveat` attaches whenever the manifest says the ApexClass /
 *    ApexTrigger families are not fully retrieved.
 * 4. **Dynamic Apex is a stated blind spot.** Any `Database.query(...)`,
 *    `Type.forName(...)` or `Schema.getGlobalDescribe()` site puts a verbatim
 *    line in `boundaries[]` and drops `review.completeness` to `partial`.
 * 5. **Parsed vs heuristic is carried per finding.** The eight AST checks are
 *    `confidence: 'parsed'`; the mirrored recognizer findings stay
 *    `'heuristic'` verbatim; a finding that turns on a declaration keyword is
 *    `'declared'`.
 * 6. **Capped lists report the TRUE total and flip `truncated`.** Every list
 *    is a `{ items, total, truncated }` triple — silent capping is a bug here.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentId,
  ComponentType,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, resolveComponents } from '@sf-intelligence/graph';
import type {
  ApexCallSite,
  ApexDmlSite,
  ApexInnerType,
  ApexMemberNode,
  ApexMethodNode,
  ApexQuerySite,
  ApexTypeStructure,
} from '@sf-intelligence/parsers';
import { parseApexStructure } from '@sf-intelligence/parsers';
import { z } from 'zod';

import type { Context } from '../server.js';

import { isUnresolvedFieldReceiver } from './apex-receiver.js';
import { buildCoverageCaveat, type CoverageCaveat } from './coverage-trust.js';
import {
  buildSharingSemantics,
  type ExplainApexClassifiers,
  type ExplainApexSharingSemantics,
} from './explain-apex-method.js';
import {
  methodReachabilityHandler,
  type EntryPointKind,
  type ReachabilityVerdict,
} from './method-reachability.js';

const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/** Body sections the `include` knob can select. `meta` / `parse` are always kept. */
const INCLUDE_SECTIONS = [
  'methods',
  'members',
  'innerTypes',
  'dataAccess',
  'entryPoints',
  'touches',
  'review',
  'tests',
] as const;

type IncludeSection = (typeof INCLUDE_SECTIONS)[number];

/** Per-section emission caps. A cut list keeps its TRUE total (see {@link CappedList}). */
const CAPS = {
  methods: 120,
  members: 80,
  innerTypes: 40,
  sites: 60,
  objects: 60,
  fields: 80,
  unresolvedFields: 40,
  findings: 100,
  inbound: 50,
  tests: 50,
} as const;

/** Tool-local byte budget, under the dispatcher's 45 000 guard. */
const BODY_BUDGET_BYTES = 36_000;

/**
 * A list that may have been cut. `total` is the count BEFORE the cap, always —
 * a caller reading `items.length` and `total` together can tell a complete
 * three-item list from the first three of nine hundred.
 */
export interface CappedList<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
}

const cap = <T>(rows: readonly T[], limit: number): CappedList<T> => ({
  items: rows.length > limit ? rows.slice(0, limit) : [...rows],
  total: rows.length,
  truncated: rows.length > limit,
});

const emptyCapped = <T>(): CappedList<T> => ({ items: [], total: 0, truncated: false });

/**
 * Empty a list WITHOUT losing what it held. A section dropped by `include`, by
 * `method` narrowing, or by the byte budget must not come back reading
 * `total: 0, truncated: false` — that is indistinguishable from "this class has
 * none", which is the exact lie the capped-list contract exists to prevent.
 * The true count survives and `truncated` flips.
 */
const blank = <T>(list: CappedList<T>): CappedList<T> => ({
  items: [],
  total: list.total,
  truncated: list.total > 0,
});

/** How the caller's `classRef` was resolved. */
export interface ApexClassRef {
  readonly requested: string;
  readonly resolvedForm: 'canonical-id' | 'api-name';
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly type: ComponentType;
}

/** Identity facts, every one read from the vault node or the parsed source. */
export interface ApexStructureMeta {
  readonly apiName: string;
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  /** Declared kind from the SOURCE — a `.cls` can hold an interface or an enum. */
  readonly kind: ApexTypeStructure['kind'] | null;
  /** `null` when the metadata carried no `<status>` — never defaulted to Active. */
  readonly status: string | null;
  /** `null` when the metadata carried no `<apiVersion>`. */
  readonly apiVersion: number | null;
  /** `null` when the vault node never recorded it (pre-v1.5 vault) — never 0. */
  readonly lineCount: number | null;
  readonly sourceBytes: number | null;
  readonly isTest: boolean | null;
  readonly modifiers: readonly string[] | null;
  readonly annotations: readonly string[] | null;
  readonly superclass: string | null;
  readonly interfaces: readonly string[] | null;
  /** Trigger only. `object: null` when the grammar yielded no SObject name. */
  readonly trigger: {
    readonly object: string | null;
    readonly events: readonly string[];
  } | null;
  /**
   * Sharing ENFORCEMENT semantics, composed from `explain_apex_method`'s
   * single implementation. `declared: null` means no keyword was written —
   * which is NOT `without sharing`; read `effectiveModel` and `note`.
   */
  readonly sharing: ExplainApexSharingSemantics;
  /** Where the sharing keyword was read from, or that the type cannot declare one. */
  readonly sharingSource: 'parsed-source' | 'node-modifiers' | 'trigger-system-context';
  /**
   * Every `meta` field that came back `null` BECAUSE the vault did not record
   * it, each with the reason. This is what keeps a null readable: without it a
   * caller cannot tell "this class has no superclass" from "nobody looked".
   * Empty when every fact was available.
   */
  readonly absent: readonly { readonly field: string; readonly reason: string }[];
}

/** Why the structure block is or is not present. */
export interface ApexParseReport {
  readonly status: 'parsed' | 'parse-failed' | 'source-unavailable';
  readonly errors: readonly string[];
  readonly parseMs: number | null;
  /** Verbatim reason. Non-empty on every non-`parsed` status. */
  readonly reason: string;
}

/** The parsed body of the file. `null` on the whole block when the parse failed. */
export interface ApexStructureBody {
  readonly methods: CappedList<ApexMethodNode>;
  readonly members: CappedList<ApexMemberNode>;
  readonly innerTypes: CappedList<ApexInnerType>;
  readonly dataAccess: ApexDataAccess;
  readonly loopCount: number;
  readonly statementCount: number;
  /**
   * Verbatim: what `visibilityDeclared: false` on a member means. Surfaced so
   * a host never reads the language default as a modifier that was written.
   */
  readonly visibilityNote: string;
}

/** SOQL / SOSL / DML / callout / async / dynamic sites with line numbers. */
export interface ApexDataAccess {
  readonly soql: CappedList<ApexQuerySite>;
  readonly sosl: CappedList<ApexQuerySite>;
  readonly dml: CappedList<ApexDmlSite>;
  readonly callouts: CappedList<ApexCallSite>;
  readonly asyncDispatch: CappedList<ApexCallSite>;
  readonly dynamicApex: CappedList<ApexCallSite>;
  /** Distinct object names read from every query's `FROM` clause. */
  readonly queriedObjects: readonly string[];
  readonly note: string;
}

/** One entry point that can reach this component. */
export interface ApexDeclaredEntryPoint {
  readonly kind:
    | 'aura-enabled'
    | 'invocable'
    | 'rest-resource'
    | 'webservice'
    | 'queueable'
    | 'batchable'
    | 'schedulable'
    | 'future'
    | 'trigger'
    | 'test-method';
  /** The method or declaration that exposes it — `null` for a class-level fact. */
  readonly viaMember: string | null;
  readonly detail: string;
  readonly confidence: 'parsed' | 'declared';
}

/** One upstream component that reaches this one. */
export interface ApexInboundCaller {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly type: ComponentType;
  readonly edgeType: string;
  readonly confidence: string;
}

/** "How does it run" — declared surface + who reaches it + transaction shape. */
export interface ApexEntryPoints {
  readonly checked: boolean;
  readonly declared: CappedList<ApexDeclaredEntryPoint>;
  readonly inbound: CappedList<ApexInboundCaller>;
  /** Entry points reached upstream, composed verbatim from `method_reachability`. */
  readonly reachableFrom: CappedList<{
    readonly id: ComponentId;
    readonly apiName: string;
    readonly kind: EntryPointKind;
    readonly depth: number;
  }>;
  readonly reachabilityVerdict: ReachabilityVerdict | null;
  /**
   * `true` / `false` when the vault carries the async classifiers; `null` on a
   * vault that predates them — the fact was NOT CHECKED, and reporting `false`
   * would assert a synchronous class that was never examined.
   */
  readonly runsInSeparateTransaction: boolean | null;
  readonly asyncBoundaries: readonly string[];
  readonly note: string;
}

/** "What does it touch" — objects and fields, from the vault's own edges. */
export interface ApexTouches {
  readonly checked: boolean;
  readonly objects: CappedList<{
    readonly object: string;
    readonly access: 'read' | 'write' | 'both';
    readonly fieldCount: number;
  }>;
  readonly fields: CappedList<{
    readonly fieldId: ComponentId;
    readonly accessType: 'read' | 'write' | 'both';
    readonly confidence: string;
  }>;
  /**
   * Edges whose RECEIVER never resolved to an object (`this.x`, an untyped
   * local). Raw tokens, segregated so they are never read as real fields —
   * the same split `explain_apex_method` makes.
   */
  readonly unresolvedFieldAccess: CappedList<string>;
  readonly note: string;
}

/** One review finding. */
export interface ApexReviewFinding {
  readonly rule: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /**
   * `parsed` — proved from the AST. `heuristic` — a regex recognizer's shape
   * match, mirrored verbatim from the extraction-time catalog. `declared` —
   * read from a declaration keyword plus vault metadata.
   */
  readonly confidence: 'parsed' | 'heuristic' | 'declared';
  readonly location: string;
  readonly line: number | null;
  readonly method: string | null;
  readonly explanation: string;
  readonly source: 'code-quality-patterns' | 'apex_structure';
}

/** "What would a reviewer say" — composed catalog findings plus AST-only checks. */
export interface ApexReview {
  readonly checked: boolean;
  readonly findings: CappedList<ApexReviewFinding>;
  readonly summary: {
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly info: number;
    readonly parsed: number;
    readonly heuristic: number;
    readonly declared: number;
  };
  /** `partial` whenever a blind spot (dynamic Apex, parse failure) applies. */
  readonly completeness: 'checked' | 'partial' | 'not-checked';
  /** The AST-only rule ids this tool evaluates. Named so an empty list reads as CHECKED. */
  readonly rulesEvaluatedHere: readonly string[];
  readonly note: string;
}

/** "Is it tested" — composed from `method_reachability`. */
export interface ApexTests {
  readonly checked: boolean;
  readonly isTestClass: boolean | null;
  readonly coveringTestClasses: CappedList<{
    readonly id: ComponentId;
    readonly apiName: string;
    readonly depth: number;
  }>;
  readonly note: string;
}

/** What narrowing was applied, so a partial view is never mistaken for the whole. */
export interface ApexStructureNarrowing {
  readonly applied: 'include' | 'method' | 'budget';
  readonly include?: readonly IncludeSection[];
  readonly method?: string;
  readonly omittedSections?: readonly string[];
  readonly truncated: boolean;
  readonly recoverWith?: string;
}

/** The success payload. */
export interface ApexStructureOutput {
  readonly classRef: ApexClassRef;
  readonly meta: ApexStructureMeta;
  readonly parse: ApexParseReport;
  readonly structure: ApexStructureBody | null;
  readonly entryPoints: ApexEntryPoints;
  readonly touches: ApexTouches;
  readonly review: ApexReview;
  readonly tests: ApexTests;
  readonly boundaries: readonly string[];
  readonly coverageCaveat?: CoverageCaveat;
  readonly narrowing?: ApexStructureNarrowing;
  readonly disclosure: string;
}

/**
 * Zod schema for `sfi.apex_structure`. `.strict()` — a mistyped argument is
 * REJECTED, never silently dropped, so a caller can never believe a narrowing
 * was applied that the tool ignored.
 */
export const apexStructureInputSchema = z
  .object({
    /** `ApexClass:Foo` / `ApexTrigger:Foo` / a bare `Foo` (both types tried). */
    classRef: z.string().min(1),
    /** Return only these body sections. `meta` / `parse` are always kept. */
    include: z.array(z.enum(INCLUDE_SECTIONS)).optional(),
    /** Narrow every section to ONE method by name. */
    method: z.string().min(1).optional(),
  })
  .strict();

export type ApexStructureInput = z.infer<typeof apexStructureInputSchema>;

const DISCLOSURE =
  'Parsed structure of ONE Apex file plus the review a reviewer would raise on it. AST-grade for what the file DECLARES (methods, signatures, visibility, annotations, inner types, sharing keyword) and for every SOQL / SOSL / DML / callout / async-dispatch site with its line and whether it sits inside a loop BODY. NOT a compiler and NOT cross-file: a superclass, an implemented interface, and any helper class this one calls are OUTSIDE what was read, so a method that delegates its DML to a helper shows zero DML sites here. Findings carry their own confidence — `parsed` was proved from the syntax tree, `heuristic` is a regex recognizer\'s shape match mirrored verbatim from extraction, `declared` reads a declaration keyword. Absence is never a claim: every zero-able section carries `checked` and a note, a parse failure yields `structure: null` rather than an empty structure, and dynamic Apex puts its blind spot in `boundaries[]`.';

const VISIBILITY_NOTE =
  'A member with `visibilityDeclared: false` had NO access modifier written. Apex defaults such a member to `private`, so `visibility` reports the language default — it is a language rule applied here, not a modifier read from the source.';

const DATA_ACCESS_NOTE =
  'Sites are the ones written IN THIS FILE. A query or DML performed by a helper class this one calls is not here (single-file parse). `inLoopBody` is true only for a site inside the loop\'s BODY: a `for (X x : [SELECT ...])` header query runs ONCE and is correctly reported false. Callout detection resolves `Http.send` when the receiver is `new Http()` or a variable declared `Http` in this file, plus `WebServiceCallout.invoke` — a callout made through a wrapper class is invisible.';

const DYNAMIC_APEX_BOUNDARY =
  'This code uses dynamic Apex (see `structure.dataAccess.dynamicApex[]`): the query, type, or field is a runtime STRING, so a static reader cannot see through it. Objects, fields, and call targets reached that way are absent from every section of this answer, and no section of this answer is a complete picture of what this code touches.';

const SINGLE_FILE_BOUNDARY =
  'Single-file parse: nothing is known here about a superclass, an implemented interface, or any class this one calls. Cross-class behaviour is `sfi.call_graph` / `sfi.downstream_effects`.';

const HEURISTIC_MIRROR_BOUNDARY =
  'Findings with `confidence: "heuristic"` are mirrored verbatim from the extraction-time regex recognizer catalog (`properties.qualityIssues[]`). They recognise a SHAPE and cannot prove intent — a custom security helper, a framework base class, or an assertion wrapper produces false positives there. They are NOT re-derived from the syntax tree.';

// ---------------------------------------------------------------------------
// node property readers — absent is null, never a default
// ---------------------------------------------------------------------------

const hasProp = (node: Node, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(node.properties, key);

const readNullableString = (node: Node, key: string): string | null => {
  const raw = node.properties[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

const readNullableNumber = (node: Node, key: string): number | null => {
  const raw = node.properties[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

const readNullableBool = (node: Node, key: string): boolean | null => {
  const raw = node.properties[key];
  return typeof raw === 'boolean' ? raw : null;
};

const readStringArrayOrNull = (node: Node, key: string): readonly string[] | null => {
  const raw = node.properties[key];
  if (!Array.isArray(raw)) return null;
  return raw.filter((v): v is string => typeof v === 'string');
};

/** The seven async / API-surface classifier keys the v1.5 extractor writes. */
const CLASSIFIER_KEYS = [
  'isQueueable',
  'isSchedulable',
  'isBatchable',
  'hasFutureMethod',
  'hasInvocableMethod',
  'hasAuraEnabledMethod',
  'isRestResource',
] as const;

const buildClassifiers = (node: Node): ExplainApexClassifiers => ({
  isQueueable: node.properties['isQueueable'] === true,
  isSchedulable: node.properties['isSchedulable'] === true,
  isBatchable: node.properties['isBatchable'] === true,
  hasFutureMethod: node.properties['hasFutureMethod'] === true,
  hasInvocableMethod: node.properties['hasInvocableMethod'] === true,
  hasAuraEnabledMethod: node.properties['hasAuraEnabledMethod'] === true,
  isRestResource: node.properties['isRestResource'] === true,
});

/** True when the vault node carries the classifier family at all. */
const classifiersAvailable = (node: Node): boolean =>
  CLASSIFIER_KEYS.some((key) => hasProp(node, key));

/**
 * Sharing semantics for an ApexTrigger.
 *
 * `explain_apex_method`'s `buildSharingSemantics` reasons about a CLASS, and
 * applying it to a trigger produces a wrong security answer: it reports
 * `inherits-caller`, but a trigger has no Apex caller to inherit from — the
 * platform's DML invokes it, and Salesforce runs triggers in SYSTEM CONTEXT.
 * So the trigger case is answered here rather than by widening a helper whose
 * contract is class-shaped.
 *
 * `declared: null` means the keyword DOES NOT EXIST for this component type,
 * which is a different null from a class that simply omitted one — the note
 * says which.
 */
const TRIGGER_SHARING: ExplainApexSharingSemantics = {
  declared: null,
  effectiveModel: 'system-context',
  runsAsSystem: true,
  note: 'An Apex trigger CANNOT declare a sharing keyword — `declared: null` here means the keyword does not exist for this component type, not that one was omitted. Triggers execute in SYSTEM CONTEXT: record sharing, object CRUD, and field-level security are NOT enforced for the running user, and any class the trigger calls that declares no sharing keyword inherits that system context. To enforce sharing for the work a trigger does, move the logic into a `with sharing` handler class and call that.',
};

/** Read the sharing keyword out of a modifiers array (the extractor's shape). */
const sharingFromModifiers = (
  modifiers: readonly string[] | null,
): ApexTypeStructure['sharing'] => {
  for (const m of modifiers ?? []) {
    const norm = m.trim().toLowerCase();
    if (norm === 'with sharing') return 'with sharing';
    if (norm === 'without sharing') return 'without sharing';
    if (norm === 'inherited sharing') return 'inherited sharing';
  }
  return null;
};

// ---------------------------------------------------------------------------
// classRef resolution
// ---------------------------------------------------------------------------

interface ResolvedApexRef {
  readonly ref: ApexClassRef;
  readonly node: Node;
}

/**
 * Resolve `classRef` to ONE ApexClass / ApexTrigger node.
 *
 * A canonical id is looked up directly. A bare name is tried as `ApexClass:`
 * then `ApexTrigger:` — the two namespaces do not collide in practice, and a
 * name that exists in both would resolve to the class, which is the shape a
 * caller writing a bare name means. A miss falls back to the fuzzy resolver
 * ONLY to name near-misses in the error; it never silently picks one.
 */
const resolveApexRef = async (
  ctx: Context,
  classRef: string,
): Promise<Result<ResolvedApexRef, McpError>> => {
  const requested = classRef.trim();
  const colon = requested.indexOf(':');
  const candidates: ComponentId[] = [];
  let resolvedForm: ApexClassRef['resolvedForm'] = 'api-name';

  if (colon > 0) {
    if (
      !requested.startsWith(APEX_CLASS_PREFIX) &&
      !requested.startsWith(APEX_TRIGGER_PREFIX)
    ) {
      return err({
        kind: 'invalid-query',
        message: `classRef must be an ApexClass: / ApexTrigger: id or a bare Apex name; got '${requested}'. For a Flow use sfi.flow_graph, for a formula field use sfi.explain_formula.`,
        path: 'classRef',
      });
    }
    resolvedForm = 'canonical-id';
    candidates.push(requested as ComponentId);
  } else {
    candidates.push(
      `${APEX_CLASS_PREFIX}${requested}` as ComponentId,
      `${APEX_TRIGGER_PREFIX}${requested}` as ComponentId,
    );
  }

  for (const id of candidates) {
    const found = await getNodeById(ctx.graph, id);
    if (!found.ok) {
      return err({
        kind: 'internal',
        message: `graph lookup failed for ${id}: ${found.error.message}`,
        path: 'classRef',
      });
    }
    if (found.value !== null) {
      return ok({
        ref: {
          requested,
          resolvedForm,
          componentId: found.value.id,
          apiName: found.value.apiName,
          type: found.value.type,
        },
        node: found.value,
      });
    }
  }

  // Not found. Name the near-misses so the caller can retry — never guess one.
  let suggestion = '';
  const fuzzy = await resolveComponents(ctx.graph, requested, {
    types: ['ApexClass', 'ApexTrigger'],
    limit: 5,
  });
  if (fuzzy.ok && fuzzy.value.candidates.length > 0) {
    suggestion = ` Closest Apex names in this vault: ${fuzzy.value.candidates
      .map((c) => c.id)
      .join(', ')}.`;
  }
  return err({
    kind: 'component-not-found',
    message: `no ApexClass or ApexTrigger named '${requested}' in this vault.${suggestion}`,
    path: 'classRef',
  });
};

// ---------------------------------------------------------------------------
// review — the eight AST-only checks
// ---------------------------------------------------------------------------

/**
 * The rule ids this tool evaluates from the syntax tree. Named in the payload
 * so an EMPTY findings list reads as "these eight were checked and none fired"
 * rather than "nothing was looked at".
 *
 * Every one is a shape the extraction-time regex catalog cannot express,
 * because each needs either statement ORDER, loop-BODY membership, or the type
 * of an expression — none of which survive a regex pass. Nothing here
 * duplicates a catalog rule: `soql-in-loop`, `dml-in-loop`,
 * `swallowed-exception` (empty catch), `hardcoded-id`, `without-sharing-no-
 * comment`, `dynamic-apex` and the rest are MIRRORED from the catalog, not
 * re-derived.
 */
const AST_RULES = [
  'callout-in-loop',
  'async-dispatch-in-loop',
  'dml-before-callout',
  'database-partial-result-discarded',
  'soql-assigned-to-single-sobject',
  'no-sharing-declared-on-entry-point',
  'without-sharing-external-entry-point',
  'trigger-logic-in-trigger-body',
] as const;

const finding = (
  rule: string,
  severity: ApexReviewFinding['severity'],
  confidence: ApexReviewFinding['confidence'],
  line: number | null,
  method: string | null,
  explanation: string,
): ApexReviewFinding => ({
  rule,
  severity,
  confidence,
  location: line === null ? 'class' : `line ${line}`,
  line,
  method,
  explanation,
  source: 'apex_structure',
});

/**
 * Run the AST-only review checks over a parsed structure.
 *
 * `externallyReachable` and `hasExternalAnnotation` come from the vault +
 * the parsed annotations; they gate the two sharing checks, which are the only
 * ones that need a fact from outside the file.
 */
const runAstChecks = (
  structure: ApexTypeStructure,
  opts: {
    readonly externalEntryKinds: readonly string[];
    readonly isTest: boolean;
  },
): readonly ApexReviewFinding[] => {
  const findings: ApexReviewFinding[] = [];

  for (const site of structure.calloutSites) {
    if (!site.inLoopBody) continue;
    findings.push(
      finding(
        'callout-in-loop',
        'critical',
        'parsed',
        site.line,
        site.inMethod,
        `An HTTP callout sits inside the body of the loop that starts at line ${site.loopLine ?? '?'}. Apex allows 100 callouts per transaction and each one blocks for its own timeout, so this scales the transaction's wall time and its callout count with the collection size. Move the callout out of the loop, or batch the work.`,
      ),
    );
  }

  for (const site of structure.asyncDispatchSites) {
    if (!site.inLoopBody) continue;
    findings.push(
      finding(
        'async-dispatch-in-loop',
        'high',
        'parsed',
        site.line,
        site.inMethod,
        `An async job is dispatched inside the body of the loop that starts at line ${site.loopLine ?? '?'} (${site.kind}). A transaction may only queue 50 async jobs; a collection larger than that throws a LimitException. Enqueue once with the whole collection instead.`,
      ),
    );
  }

  // DML before a callout in the SAME method body: the runtime rejects a
  // callout once the transaction holds uncommitted DML.
  const dmlByMethod = new Map<string, number>();
  for (const site of structure.dmlSites) {
    if (site.inMethod === null) continue;
    const seen = dmlByMethod.get(site.inMethod);
    if (seen === undefined || site.line < seen) dmlByMethod.set(site.inMethod, site.line);
  }
  for (const site of structure.calloutSites) {
    if (site.inMethod === null) continue;
    const firstDml = dmlByMethod.get(site.inMethod);
    if (firstDml === undefined || firstDml >= site.line) continue;
    findings.push(
      finding(
        'dml-before-callout',
        'high',
        'parsed',
        site.line,
        site.inMethod,
        `DML runs at line ${firstDml} and a callout at line ${site.line} in the same method. Apex refuses a callout once the transaction holds uncommitted DML ("You have uncommitted work pending"). Do the callout first, or move it behind an async boundary (@future(callout=true) / Queueable implements Database.AllowsCallouts).`,
      ),
    );
  }

  for (const site of structure.dmlSites) {
    if (site.form !== 'database-method') continue;
    if (site.allOrNone !== false || site.resultDiscarded !== true) continue;
    findings.push(
      finding(
        'database-partial-result-discarded',
        'high',
        'parsed',
        site.line,
        site.inMethod,
        `Database.${site.operation}(..., false) runs in partial-success mode and returns a result per row, but the returned result is discarded here. Rows that failed fail SILENTLY — no exception, no log. Assign the result and inspect isSuccess() / getErrors().`,
      ),
    );
  }

  // An inline query assigned straight to a single sObject throws
  // QueryException on 0 rows — the classic missing null guard.
  for (const site of structure.soqlSites) {
    if (!site.assignedToSingleSObject) continue;
    findings.push(
      finding(
        'soql-assigned-to-single-sobject',
        // Downgraded inside a test class: the same shape there is usually a
        // deliberate "the record must exist" assertion, and reporting 100+
        // mediums across a test suite buries the production instances that
        // matter. Surfaced either way — the severity is the calibration, not a
        // suppression.
        opts.isTest ? 'low' : 'medium',
        'parsed',
        site.line,
        site.inMethod,
        `An inline SOQL result is assigned directly to a single sObject variable. When the query returns no rows this throws System.QueryException ("List has no rows for assignment"), which no null check can catch. Query into a List and test isEmpty() first.${opts.isTest ? ' Reported at low severity because this is a test class, where the throw is often the intended assertion.' : ''}`,
      ),
    );
  }

  // Sharing on an externally-invoked surface. Both variants are about what the
  // ABSENCE or the presence of the keyword MEANS for record enforcement.
  if (opts.externalEntryKinds.length > 0 && !opts.isTest) {
    const surfaces = opts.externalEntryKinds.join(', ');
    if (structure.sharing === 'without sharing') {
      findings.push(
        finding(
          'without-sharing-external-entry-point',
          'high',
          'declared',
          null,
          null,
          `The class declares \`without sharing\` AND is invoked directly by an external caller (${surfaces}). Record-level sharing is not enforced for those callers, so any record this code queries or writes is reachable regardless of the running user's sharing. Confirm that is deliberate; if it is, say so in a comment, and add explicit CRUD/FLS checks — the sharing keyword does not provide them.`,
        ),
      );
    } else if (structure.sharing === null) {
      findings.push(
        finding(
          'no-sharing-declared-on-entry-point',
          'high',
          'declared',
          null,
          null,
          `No sharing keyword is declared on a class invoked directly by an external caller (${surfaces}). A no-keyword class INHERITS its caller's context — but the platform is the caller here, and it has no sharing context to inherit, so record sharing ends up NOT enforced. Declare \`with sharing\` to enforce it explicitly.`,
        ),
      );
    }
  }

  if (structure.kind === 'trigger') {
    const bodySoql = structure.soqlSites.filter((s) => s.inMethod === null).length;
    const bodyDml = structure.dmlSites.filter((s) => s.inMethod === null).length;
    if (bodySoql + bodyDml > 0) {
      findings.push(
        finding(
          'trigger-logic-in-trigger-body',
          'low',
          'parsed',
          null,
          null,
          `The trigger body performs data access directly (${bodySoql} SOQL, ${bodyDml} DML) rather than delegating to a handler class. This is a convention, not a defect: logic in the trigger body cannot be unit-tested in isolation, cannot be bypassed by a recursion guard held in the handler, and has to be re-read on every context. Move the work into a handler class the trigger calls.`,
        ),
      );
    }
  }

  return findings;
};

/** Mirror `properties.qualityIssues[]` — verbatim, and always `heuristic`. */
const mirrorCatalogFindings = (node: Node): readonly ApexReviewFinding[] => {
  const raw = node.properties['qualityIssues'];
  if (!Array.isArray(raw)) return [];
  const out: ApexReviewFinding[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const { rule, severity, location, explanation } = obj;
    if (
      typeof rule !== 'string' ||
      typeof severity !== 'string' ||
      typeof location !== 'string' ||
      typeof explanation !== 'string'
    ) {
      continue;
    }
    const lineMatch = /line\s*(\d+)/.exec(location);
    const methodMatch = /method:([^:]+):/.exec(location);
    out.push({
      rule,
      severity: (['critical', 'high', 'medium', 'low', 'info'] as const).includes(
        severity as ApexReviewFinding['severity'],
      )
        ? (severity as ApexReviewFinding['severity'])
        : 'info',
      confidence: 'heuristic',
      location,
      line: lineMatch === undefined || lineMatch === null ? null : Number(lineMatch[1]),
      method: methodMatch?.[1] ?? null,
      explanation,
      source: 'code-quality-patterns',
    });
  }
  return out;
};

const SEVERITY_ORDER: Readonly<Record<ApexReviewFinding['severity'], number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

// ---------------------------------------------------------------------------
// touches — from the vault's own edges
// ---------------------------------------------------------------------------

type AccessType = 'read' | 'write' | 'both';

const mergeAccess = (a: AccessType | undefined, b: AccessType): AccessType =>
  a === undefined || a === b ? b : 'both';

const buildTouches = (
  outgoing: readonly Edge[],
  edgesAvailable: boolean,
): ApexTouches => {
  if (!edgesAvailable) {
    return {
      checked: false,
      objects: emptyCapped(),
      fields: emptyCapped(),
      unresolvedFieldAccess: emptyCapped(),
      note: 'NOT CHECKED — the field-access edges could not be read from the graph. This empty list is the absence of a query result, not the absence of field access.',
    };
  }
  const fieldAccess = new Map<string, { access: AccessType; confidence: string }>();
  const unresolved = new Set<string>();
  for (const edge of outgoing) {
    if (edge.edgeType !== 'readsFrom' && edge.edgeType !== 'writesTo') continue;
    const access: AccessType = edge.edgeType === 'readsFrom' ? 'read' : 'write';
    if (isUnresolvedFieldReceiver(edge.toId)) {
      unresolved.add(edge.toId.slice('CustomField:'.length));
      continue;
    }
    const prior = fieldAccess.get(edge.toId);
    fieldAccess.set(edge.toId, {
      access: mergeAccess(prior?.access, access),
      confidence: edge.confidence,
    });
  }

  const byObject = new Map<string, { access: AccessType; fields: Set<string> }>();
  for (const [fieldId, info] of fieldAccess) {
    const rest = fieldId.startsWith('CustomField:')
      ? fieldId.slice('CustomField:'.length)
      : fieldId;
    const dot = rest.indexOf('.');
    if (dot < 0) continue;
    const objectName = rest.slice(0, dot);
    const entry = byObject.get(objectName) ?? {
      access: info.access,
      fields: new Set<string>(),
    };
    entry.access = mergeAccess(entry.access, info.access);
    entry.fields.add(rest.slice(dot + 1));
    byObject.set(objectName, entry);
  }

  const objects = [...byObject.entries()]
    .map(([object, entry]) => ({
      object,
      access: entry.access,
      fieldCount: entry.fields.size,
    }))
    .sort((a, b) => b.fieldCount - a.fieldCount || a.object.localeCompare(b.object));

  const fields = [...fieldAccess.entries()]
    .map(([fieldId, info]) => ({
      fieldId: fieldId as ComponentId,
      accessType: info.access,
      confidence: info.confidence,
    }))
    .sort((a, b) => a.fieldId.localeCompare(b.fieldId));

  return {
    checked: true,
    objects: cap(objects, CAPS.objects),
    fields: cap(fields, CAPS.fields),
    unresolvedFieldAccess: cap([...unresolved].sort(), CAPS.unresolvedFields),
    note:
      objects.length === 0
        ? 'CHECKED and empty — this component has no readsFrom / writesTo edge in the vault. That is not proof it touches nothing: dynamic Apex, reflective field access (obj.get(...)), and fields reached only through a helper class produce no edge here.'
        : 'Objects and fields come from the vault\'s readsFrom / writesTo edges, whose per-edge `confidence` is carried through. Fields whose receiver never resolved to an object are segregated into unresolvedFieldAccess and are raw tokens, not components.',
  };
};

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

/** Annotation / interface names that make a class externally invocable. */
const EXTERNAL_ANNOTATION_KINDS: readonly {
  readonly test: RegExp;
  readonly kind: ApexDeclaredEntryPoint['kind'];
  readonly detail: string;
}[] = [
  {
    test: /^@auraenabled\b/i,
    kind: 'aura-enabled',
    detail: 'callable from an LWC / Aura component by any user who can load it',
  },
  {
    test: /^@invocablemethod\b/i,
    kind: 'invocable',
    detail: 'callable from Flow / Process Builder as an Apex action',
  },
  {
    test: /^@restresource\b/i,
    kind: 'rest-resource',
    detail: 'exposed at an /services/apexrest endpoint',
  },
  {
    test: /^@future\b/i,
    kind: 'future',
    detail: 'runs in its OWN asynchronous transaction, as the system',
  },
];

const buildDeclaredEntryPoints = (
  structure: ApexTypeStructure | null,
  node: Node,
): readonly ApexDeclaredEntryPoint[] => {
  const out: ApexDeclaredEntryPoint[] = [];
  if (structure === null) return out;

  if (structure.kind === 'trigger') {
    out.push({
      kind: 'trigger',
      viaMember: null,
      detail: `fires on ${structure.trigger?.object ?? 'an SObject the parser could not read'} for: ${(structure.trigger?.events ?? []).join(', ') || 'no event the parser could read'}`,
      confidence: 'parsed',
    });
  }

  for (const annotation of structure.annotations) {
    for (const rule of EXTERNAL_ANNOTATION_KINDS) {
      if (rule.test.test(annotation)) {
        out.push({
          kind: rule.kind,
          viaMember: null,
          detail: `class-level ${annotation} — ${rule.detail}`,
          confidence: 'parsed',
        });
      }
    }
  }
  for (const method of structure.methods) {
    for (const annotation of method.annotations) {
      for (const rule of EXTERNAL_ANNOTATION_KINDS) {
        if (rule.test.test(annotation)) {
          out.push({
            kind: rule.kind,
            viaMember: method.name,
            detail: `${annotation} on ${method.signature} — ${rule.detail}`,
            confidence: 'parsed',
          });
        }
      }
    }
    if (method.isWebService) {
      out.push({
        kind: 'webservice',
        viaMember: method.name,
        detail: `webservice ${method.name} — exposed as a SOAP API operation`,
        confidence: 'parsed',
      });
    }
  }

  for (const iface of structure.interfaces) {
    const norm = iface.toLowerCase();
    if (norm === 'queueable') {
      out.push({
        kind: 'queueable',
        viaMember: null,
        detail: 'implements Queueable — executes in its OWN transaction once enqueued',
        confidence: 'parsed',
      });
    } else if (norm === 'schedulable') {
      out.push({
        kind: 'schedulable',
        viaMember: null,
        detail: 'implements Schedulable — the scheduler invokes it in its own transaction',
        confidence: 'parsed',
      });
    } else if (norm.startsWith('database.batchable')) {
      out.push({
        kind: 'batchable',
        viaMember: null,
        detail:
          'implements Database.Batchable — start / each execute / finish each run in a SEPARATE transaction',
        confidence: 'parsed',
      });
    }
  }

  if (node.properties['isTest'] === true) {
    out.push({
      kind: 'test-method',
      viaMember: null,
      detail: 'a test class — the test runner is its entry point',
      confidence: 'declared',
    });
  }
  return out;
};

/** Entry-point kinds that mean an EXTERNAL caller reaches the code directly. */
const EXTERNAL_KINDS: ReadonlySet<ApexDeclaredEntryPoint['kind']> = new Set([
  'aura-enabled',
  'invocable',
  'rest-resource',
  'webservice',
]);

// ---------------------------------------------------------------------------
// narrowing + budget
// ---------------------------------------------------------------------------

const withStructure = (
  out: ApexStructureOutput,
  fn: (s: ApexStructureBody) => ApexStructureBody,
): ApexStructureOutput =>
  out.structure === null ? out : { ...out, structure: fn(out.structure) };

const EMPTY_SECTIONS: Readonly<{
  [K in IncludeSection]: (out: ApexStructureOutput) => ApexStructureOutput;
}> = {
  methods: (o) => withStructure(o, (s) => ({ ...s, methods: blank(s.methods) })),
  members: (o) => withStructure(o, (s) => ({ ...s, members: blank(s.members) })),
  innerTypes: (o) =>
    withStructure(o, (s) => ({ ...s, innerTypes: blank(s.innerTypes) })),
  dataAccess: (o) =>
    withStructure(o, (s) => ({
      ...s,
      dataAccess: {
        soql: blank(s.dataAccess.soql),
        sosl: blank(s.dataAccess.sosl),
        dml: blank(s.dataAccess.dml),
        callouts: blank(s.dataAccess.callouts),
        asyncDispatch: blank(s.dataAccess.asyncDispatch),
        dynamicApex: blank(s.dataAccess.dynamicApex),
        queriedObjects: [],
        note: s.dataAccess.note,
      },
    })),
  entryPoints: (o) => ({
    ...o,
    entryPoints: {
      ...o.entryPoints,
      declared: blank(o.entryPoints.declared),
      inbound: blank(o.entryPoints.inbound),
      reachableFrom: blank(o.entryPoints.reachableFrom),
    },
  }),
  touches: (o) => ({
    ...o,
    touches: {
      ...o.touches,
      objects: blank(o.touches.objects),
      fields: blank(o.touches.fields),
      unresolvedFieldAccess: blank(o.touches.unresolvedFieldAccess),
    },
  }),
  review: (o) => ({
    ...o,
    review: { ...o.review, findings: blank(o.review.findings) },
  }),
  tests: (o) => ({
    ...o,
    tests: { ...o.tests, coveringTestClasses: blank(o.tests.coveringTestClasses) },
  }),
};

/**
 * Apply `include`: empty every UNSELECTED section and name each one in
 * `narrowing.omittedSections`. A section is never silently dropped, because a
 * silently-emptied section reads as "this class has none".
 */
const applyInclude = (
  out: ApexStructureOutput,
  include: readonly IncludeSection[],
): ApexStructureOutput => {
  const keep = new Set(include);
  const omitted: IncludeSection[] = [];
  let current = out;
  for (const section of INCLUDE_SECTIONS) {
    if (keep.has(section)) continue;
    current = EMPTY_SECTIONS[section](current);
    omitted.push(section);
  }
  return {
    ...current,
    narrowing: {
      applied: 'include',
      include,
      omittedSections: omitted,
      truncated: omitted.length > 0,
      recoverWith: 'call sfi.apex_structure again without `include` for the full body',
    },
  };
};

/**
 * Apply `method`: keep only that method's row, its sites, and its findings.
 * Returns `null` when the parsed structure declares no such method — the
 * caller turns that into `invalid-query` rather than an empty success that
 * would read as "that method has nothing in it".
 */
const applyMethodNarrowing = (
  out: ApexStructureOutput,
  method: string,
): ApexStructureOutput | null => {
  if (out.structure === null) return null;
  const wanted = out.structure.methods.items.filter(
    (m) => m.name.toLowerCase() === method.toLowerCase(),
  );
  if (wanted.length === 0) return null;
  const names = new Set(wanted.map((m) => m.name.toLowerCase()));
  const inMethod = (site: { readonly inMethod: string | null }): boolean =>
    site.inMethod !== null && names.has(site.inMethod.toLowerCase());
  const da = out.structure.dataAccess;
  return {
    ...out,
    structure: {
      ...out.structure,
      methods: cap(wanted, CAPS.methods),
      members: blank(out.structure.members),
      innerTypes: blank(out.structure.innerTypes),
      dataAccess: {
        ...da,
        soql: cap(da.soql.items.filter(inMethod), CAPS.sites),
        sosl: cap(da.sosl.items.filter(inMethod), CAPS.sites),
        dml: cap(da.dml.items.filter(inMethod), CAPS.sites),
        callouts: cap(da.callouts.items.filter(inMethod), CAPS.sites),
        asyncDispatch: cap(da.asyncDispatch.items.filter(inMethod), CAPS.sites),
        dynamicApex: cap(da.dynamicApex.items.filter(inMethod), CAPS.sites),
      },
    },
    review: {
      ...out.review,
      findings: cap(
        out.review.findings.items.filter(
          (f) => f.method !== null && names.has(f.method.toLowerCase()),
        ),
        CAPS.findings,
      ),
      note: `${out.review.note} NARROWED to method '${method}': class-level findings (sharing, api version, trigger shape) are NOT in this list — call without \`method\` for them.`,
    },
    narrowing: {
      applied: 'method',
      method,
      omittedSections: ['members', 'innerTypes'],
      truncated: true,
      recoverWith:
        'call sfi.apex_structure again without `method` for the whole class',
    },
  };
};

/** Sections a budget overrun may shed, in the order they are given up. */
const SHEDDABLE: readonly IncludeSection[] = [
  'members',
  'touches',
  'dataAccess',
  'innerTypes',
  'entryPoints',
  'tests',
];

const byteLength = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Shed whole sections, largest first, until the payload fits — and DISCLOSE
 * every shed section plus the call that returns it. `methods` and `review` are
 * never shed: they are the answer.
 */
const fitToBudget = (out: ApexStructureOutput): ApexStructureOutput => {
  if (byteLength(out) <= BODY_BUDGET_BYTES) return out;
  let current = out;
  const omitted: IncludeSection[] = [];
  while (byteLength(current) > BODY_BUDGET_BYTES) {
    let biggest: IncludeSection | null = null;
    let biggestBytes = 0;
    for (const section of SHEDDABLE) {
      if (omitted.includes(section)) continue;
      const before = byteLength(current);
      const after = byteLength(EMPTY_SECTIONS[section](current));
      if (before - after > biggestBytes) {
        biggest = section;
        biggestBytes = before - after;
      }
    }
    if (biggest === null) break;
    current = EMPTY_SECTIONS[biggest](current);
    omitted.push(biggest);
  }
  // LAST RESORT. `methods` and `review.findings` are the answer, so they are
  // shed LAST and never wholesale — they are TRIMMED, which keeps the true
  // `total` and flips `truncated`. A 1300-line class blew the 40 KB dispatcher
  // guard even with every optional section dropped, and the oversize envelope
  // that produced answered nothing at all; a disclosed short list answers most
  // of the question and names the call that returns the rest.
  let trimmed = false;
  const shrink = <T>(list: CappedList<T>, keep: number): CappedList<T> => ({
    items: list.items.slice(0, keep),
    total: list.total,
    truncated: list.total > keep,
  });
  while (byteLength(current) > BODY_BUDGET_BYTES) {
    const methodCount = current.structure?.methods.items.length ?? 0;
    const findingCount = current.review.findings.items.length;
    if (methodCount <= 5 && findingCount <= 10) break;
    trimmed = true;
    current = {
      ...withStructure(current, (s) => ({
        ...s,
        methods: shrink(s.methods, Math.max(5, Math.floor(methodCount / 2))),
      })),
      review: {
        ...current.review,
        findings: shrink(
          current.review.findings,
          Math.max(10, Math.floor(findingCount / 2)),
        ),
      },
    };
  }

  const prior = current.narrowing;
  const priorOmitted = prior?.omittedSections ?? [];
  const ordered = SHEDDABLE.filter((s) => omitted.includes(s));
  const merged = [...priorOmitted, ...ordered.filter((s) => !priorOmitted.includes(s))];
  const sectionAdvice =
    ordered.length === 0
      ? ''
      : ` call sfi.apex_structure again with include: [${ordered
          .map((s) => `'${s}'`)
          .join(', ')}] for the omitted section(s) in full;`;
  const trimAdvice = trimmed
    ? ' the methods and review lists were TRIMMED to fit (their `total` is the real count) — call with `method: "<name>"` for one method at a time.'
    : '';
  return {
    ...current,
    narrowing: {
      ...(prior ?? {}),
      applied: prior?.applied ?? 'budget',
      ...(merged.length > 0 ? { omittedSections: merged } : {}),
      truncated: true,
      recoverWith: `this class did not fit in one response;${sectionAdvice}${trimAdvice}`.trim(),
    },
  };
};

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

/**
 * The `sfi.apex_structure` MCP tool. Resolves `classRef`, reads + parses the
 * source on demand, and returns the structure, how it runs, what it touches,
 * the review, and the tests — each labelled with what it did and did not check.
 *
 * @example
 *   const r = await apexStructureHandler(ctx, { classRef: 'AccountService' });
 *   if (r.ok) for (const m of r.value.data.structure?.methods.items ?? []) {
 *     console.log(m.signature);
 *   }
 */
export const apexStructureHandler = async (
  ctx: Context,
  input: ApexStructureInput,
): Promise<Result<McpResponse<ApexStructureOutput>, McpError>> => {
  const resolution = await resolveApexRef(ctx, input.classRef);
  if (!resolution.ok) return err(resolution.error);
  const { ref, node } = resolution.value;

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  // ---- source + parse ------------------------------------------------------
  let parse: ApexParseReport = {
    status: 'source-unavailable',
    errors: [],
    parseMs: null,
    reason: '',
  };
  let structure: ApexTypeStructure | null = null;
  if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) {
    parse = {
      status: 'source-unavailable',
      errors: [],
      parseMs: null,
      reason: `the vault node for ${ref.componentId} records no source path, so the file could not be read. Re-run /sfi-refresh. Nothing below is derived from source.`,
    };
  } else {
    let source: string | null = null;
    try {
      source = await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
    } catch {
      parse = {
        status: 'source-unavailable',
        errors: [],
        parseMs: null,
        reason: `the source file recorded for ${ref.componentId} could not be read (missing or unreadable). Re-run /sfi-refresh. Nothing below is derived from source.`,
      };
    }
    if (source !== null) {
      const result = await parseApexStructure(source, {
        kind: ref.type === 'ApexTrigger' ? 'trigger' : 'class',
      });
      if (result.parsed && result.structure !== null) {
        structure = result.structure;
        parse = {
          status: 'parsed',
          errors: [],
          parseMs: Math.round(result.parseMs * 10) / 10,
          reason: '',
        };
      } else {
        parse = {
          status: 'parse-failed',
          errors: result.parseErrors,
          parseMs: Math.round(result.parseMs * 10) / 10,
          reason: `the Apex grammar could not parse ${ref.componentId}, so structure is null rather than empty — no method, member, or data-access fact below comes from source. First error: ${result.parseErrors[0] ?? 'unknown'}.`,
        };
      }
    }
  }

  // ---- meta ----------------------------------------------------------------
  const nodeModifiers = readStringArrayOrNull(node, 'modifiers');
  const isTrigger = ref.type === 'ApexTrigger';
  const sharingSource: ApexStructureMeta['sharingSource'] = isTrigger
    ? 'trigger-system-context'
    : structure === null
      ? 'node-modifiers'
      : 'parsed-source';
  const declaredSharing =
    structure === null ? sharingFromModifiers(nodeModifiers) : (structure.sharing ?? null);
  const classifiers = buildClassifiers(node);

  // Which meta facts are null because the vault never recorded them. A null the
  // caller cannot explain is indistinguishable from a fabricated zero.
  const absent: { field: string; reason: string }[] = [];
  const notRecorded = (field: string): string =>
    `\`${field}\` is null because this vault node does not carry it — the value is UNKNOWN, not false / 0 / empty. Re-run /sfi-refresh; if it stays absent, the extractor that built this vault does not record it for ${ref.type}.`;
  const unparsed = (field: string): string =>
    `\`${field}\` is null because the source did not parse (see parse.reason) and the vault node does not carry it either — UNKNOWN, not empty.`;
  const metaFacts: readonly (readonly [string, unknown])[] = [
    ['status', readNullableString(node, 'status')],
    ['apiVersion', node.apiVersion],
    ['lineCount', readNullableNumber(node, 'lineCount')],
    ['sourceBytes', readNullableNumber(node, 'sourceBytes')],
    ['isTest', readNullableBool(node, 'isTest')],
  ];
  for (const [field, value] of metaFacts) {
    if (value === null) absent.push({ field, reason: notRecorded(field) });
  }
  if (structure === null) {
    const nodeAnnotations = readStringArrayOrNull(node, 'annotations');
    const unparsedFacts: readonly (readonly [string, unknown])[] = [
      ['kind', null],
      ['modifiers', nodeModifiers],
      ['annotations', nodeAnnotations],
      ['superclass', readNullableString(node, 'superclass')],
      ['interfaces', readStringArrayOrNull(node, 'implements')],
    ];
    for (const [field, value] of unparsedFacts) {
      if (value === null) absent.push({ field, reason: unparsed(field) });
    }
  }

  const meta: ApexStructureMeta = {
    apiName: ref.apiName,
    componentId: ref.componentId,
    type: ref.type,
    kind: structure?.kind ?? null,
    status: readNullableString(node, 'status'),
    apiVersion: node.apiVersion,
    lineCount: readNullableNumber(node, 'lineCount'),
    sourceBytes: readNullableNumber(node, 'sourceBytes'),
    isTest: readNullableBool(node, 'isTest'),
    modifiers: structure?.modifiers ?? nodeModifiers,
    annotations: structure?.annotations ?? readStringArrayOrNull(node, 'annotations'),
    superclass: structure?.superclass ?? readNullableString(node, 'superclass'),
    interfaces: structure?.interfaces ?? readStringArrayOrNull(node, 'implements'),
    trigger:
      structure?.trigger ??
      (ref.type === 'ApexTrigger'
        ? {
            object: readNullableString(node, 'triggerObject'),
            events: readStringArrayOrNull(node, 'events') ?? [],
          }
        : null),
    sharing: isTrigger
      ? TRIGGER_SHARING
      : buildSharingSemantics(declaredSharing, classifiers),
    sharingSource,
    absent,
  };

  // ---- entry points + tests (composed from method_reachability) -------------
  const reachability = await methodReachabilityHandler(ctx, {
    componentId: ref.componentId,
  });
  const reachabilityData = reachability.ok ? reachability.value.data : null;

  const declaredEntryPoints = buildDeclaredEntryPoints(structure, node);
  const externalEntryKinds = [
    ...new Set(
      declaredEntryPoints.filter((e) => EXTERNAL_KINDS.has(e.kind)).map((e) => e.kind),
    ),
  ];

  const inboundResult = await listEdges(ctx.graph, ref.componentId, {
    direction: 'in',
  });
  const inboundEdges = inboundResult.ok ? inboundResult.value : [];
  const USAGE_EDGES = new Set(['callsApex', 'dispatchesAsync', 'triggersOn', 'exposes']);
  const inbound: ApexInboundCaller[] = inboundEdges
    .filter((e) => USAGE_EDGES.has(e.edgeType))
    .map((e) => ({
      id: e.fromId,
      apiName: e.fromId.slice(e.fromId.indexOf(':') + 1),
      type: e.fromId.slice(0, e.fromId.indexOf(':')) as ComponentType,
      edgeType: e.edgeType,
      confidence: e.confidence,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const asyncBoundaries: string[] = [];
  if (classifiers.isQueueable) asyncBoundaries.push('Queueable');
  if (classifiers.isBatchable) asyncBoundaries.push('Database.Batchable');
  if (classifiers.isSchedulable) asyncBoundaries.push('Schedulable');
  if (classifiers.hasFutureMethod) asyncBoundaries.push('@future');
  const classifiersKnown = classifiersAvailable(node);

  const entryPoints: ApexEntryPoints = {
    checked: true,
    declared: cap(declaredEntryPoints, CAPS.inbound),
    inbound: cap(inbound, CAPS.inbound),
    reachableFrom: cap(reachabilityData?.entryPoints ?? [], CAPS.inbound),
    reachabilityVerdict: reachabilityData?.verdict ?? null,
    // A TRIGGER's transaction shape is a LANGUAGE fact, not a vault fact: it
    // runs inside the DML transaction that fired it, always. Reporting `null`
    // here (because trigger nodes carry no async classifiers) would hide a fact
    // that is knowable without the vault — the mirror of the sharing case.
    runsInSeparateTransaction: isTrigger
      ? false
      : classifiersKnown
        ? asyncBoundaries.length > 0
        : null,
    asyncBoundaries,
    note: isTrigger
      ? `A trigger runs INSIDE the transaction of the DML that fired it — that is a platform rule, not a vault reading, so runsInSeparateTransaction is false rather than null here. Work it hands to a SEPARATE transaction shows up as \`structure.dataAccess.asyncDispatch\` sites, not as an async boundary on the trigger itself. \`declared\` is read from the source; \`reachableFrom\` is composed verbatim from sfi.method_reachability and \`inbound\` lists the DIRECT incoming usage edges with their confidence.${reachability.ok ? '' : ' The reachability walk FAILED for this component, so `reachableFrom` and `reachabilityVerdict` were NOT checked.'}`
      : classifiersKnown
      ? `\`declared\` is read from the source annotations and interfaces; \`reachableFrom\` is composed verbatim from sfi.method_reachability (upstream callsApex, depth 3) and \`inbound\` lists the DIRECT incoming usage edges with their confidence. An empty declared+inbound pair means no MODELED caller — dynamic dispatch (Type.forName), reflective invocation, framework base classes, and managed-package callers produce no edge, so it is not proof nothing calls this.${reachability.ok ? '' : ' The reachability walk FAILED for this component, so `reachableFrom` and `reachabilityVerdict` were NOT checked.'}`
      : 'runsInSeparateTransaction is NULL: this vault node carries none of the async classifier properties (isQueueable / isBatchable / isSchedulable / hasFutureMethod), so the transaction shape was NOT CHECKED. Re-run /sfi-refresh to populate them. It was not reported false.',
  };

  const tests: ApexTests = {
    checked: reachability.ok,
    isTestClass: readNullableBool(node, 'isTest'),
    coveringTestClasses: cap(reachabilityData?.reachingTestClasses ?? [], CAPS.tests),
    note: !reachability.ok
      ? 'NOT CHECKED — the upstream reachability walk failed, so this empty list is a missing query result, not an absence of tests.'
      : (reachabilityData?.reachingTestClasses.length ?? 0) === 0
        ? 'CHECKED and empty — no test class reaches this component over callsApex within 3 hops. Treat that as "no static test reference found", not "0% coverage": the authoritative number comes from running the org\'s Apex tests, and a test that reaches it via a deeper chain or by reflection is invisible here.'
        : 'Composed verbatim from sfi.method_reachability: test classes that reach this component over upstream callsApex within 3 hops. Static reference coverage, NOT runtime line coverage — a test that references the class does not necessarily exercise all of it.',
  };

  // ---- touches -------------------------------------------------------------
  const outgoingResult = await listEdges(ctx.graph, ref.componentId, {
    direction: 'out',
  });
  const touches = buildTouches(
    outgoingResult.ok ? outgoingResult.value : [],
    outgoingResult.ok,
  );

  // ---- review --------------------------------------------------------------
  const catalogFindings = mirrorCatalogFindings(node);
  const catalogAvailable = Array.isArray(node.properties['qualityIssues']);
  const astFindings =
    structure === null
      ? []
      : runAstChecks(structure, {
          externalEntryKinds,
          isTest: node.properties['isTest'] === true,
        });
  const allFindings = [...catalogFindings, ...astFindings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.rule.localeCompare(b.rule),
  );

  const summary = {
    critical: allFindings.filter((f) => f.severity === 'critical').length,
    high: allFindings.filter((f) => f.severity === 'high').length,
    medium: allFindings.filter((f) => f.severity === 'medium').length,
    low: allFindings.filter((f) => f.severity === 'low').length,
    info: allFindings.filter((f) => f.severity === 'info').length,
    parsed: allFindings.filter((f) => f.confidence === 'parsed').length,
    heuristic: allFindings.filter((f) => f.confidence === 'heuristic').length,
    declared: allFindings.filter((f) => f.confidence === 'declared').length,
  };

  const usesDynamicApex =
    (structure?.dynamicApexSites.length ?? 0) > 0 ||
    catalogFindings.some((f) => f.rule === 'dynamic-apex');

  const reviewCompleteness: ApexReview['completeness'] =
    structure === null && !catalogAvailable
      ? 'not-checked'
      : structure === null || !catalogAvailable || usesDynamicApex
        ? 'partial'
        : 'checked';

  const review: ApexReview = {
    checked: reviewCompleteness !== 'not-checked',
    findings: cap(allFindings, CAPS.findings),
    summary,
    completeness: reviewCompleteness,
    rulesEvaluatedHere: AST_RULES,
    note:
      reviewCompleteness === 'not-checked'
        ? 'NOT CHECKED — the source did not parse AND this vault node carries no qualityIssues property, so NOTHING was reviewed. An empty findings list here means nothing was looked at.'
        : `${structure === null ? 'PARTIAL — the source did not parse, so only the extraction-time recognizer findings are present and the eight AST checks did not run. ' : ''}${catalogAvailable ? '' : 'PARTIAL — this vault node carries no qualityIssues property (refresh predates the recognizer catalog), so only the eight AST checks ran. '}${usesDynamicApex ? 'PARTIAL — this code uses dynamic Apex, so no static review of it can be complete. ' : ''}rulesEvaluatedHere names the checks THIS tool runs from the syntax tree; an empty findings list means those were evaluated and none fired. The org-wide sweep of the same recognizer catalog is sfi.code_quality_audit.`,
  };

  // ---- boundaries ----------------------------------------------------------
  const boundaries: string[] = [SINGLE_FILE_BOUNDARY];
  if (usesDynamicApex) boundaries.push(DYNAMIC_APEX_BOUNDARY);
  if (catalogFindings.length > 0) boundaries.push(HEURISTIC_MIRROR_BOUNDARY);
  if (structure === null && parse.reason.length > 0) boundaries.push(parse.reason);
  if (astFindings.some((f) => f.rule === 'dml-before-callout')) {
    boundaries.push(
      'The dml-before-callout check compares statement ORDER inside ONE method body. A callout made in a helper method invoked after DML, or a loop that repeats a callout-then-DML pair across iterations, is not evaluated.',
    );
  }

  // ---- assemble ------------------------------------------------------------
  const body: ApexStructureBody | null =
    structure === null
      ? null
      : {
          methods: cap(structure.methods, CAPS.methods),
          members: cap(structure.members, CAPS.members),
          innerTypes: cap(structure.innerTypes, CAPS.innerTypes),
          dataAccess: {
            soql: cap(structure.soqlSites, CAPS.sites),
            sosl: cap(structure.soslSites, CAPS.sites),
            dml: cap(structure.dmlSites, CAPS.sites),
            callouts: cap(structure.calloutSites, CAPS.sites),
            asyncDispatch: cap(structure.asyncDispatchSites, CAPS.sites),
            dynamicApex: cap(structure.dynamicApexSites, CAPS.sites),
            queriedObjects: [
              ...new Set(
                [...structure.soqlSites, ...structure.soslSites].flatMap(
                  (s) => s.objects,
                ),
              ),
            ].sort(),
            note: DATA_ACCESS_NOTE,
          },
          loopCount: structure.loopCount,
          statementCount: structure.statementCount,
          visibilityNote: VISIBILITY_NOTE,
        };

  const coverageCaveat = buildCoverageCaveat(
    ctx,
    ['ApexClass', 'ApexTrigger'],
    'The callers, tests, and field access reported for this component',
  );

  const base: ApexStructureOutput = {
    classRef: ref,
    meta,
    parse,
    structure: body,
    entryPoints,
    touches,
    review,
    tests,
    boundaries,
    ...(coverageCaveat === undefined ? {} : { coverageCaveat }),
    disclosure: DISCLOSURE,
  };

  if (input.method !== undefined) {
    const narrowed = applyMethodNarrowing(base, input.method);
    if (narrowed === null) {
      const known = (body?.methods.items ?? []).map((m) => m.name).slice(0, 20);
      return err({
        kind: 'invalid-query',
        message:
          body === null
            ? `cannot narrow to method '${input.method}': ${parse.reason}`
            : `no method named '${input.method}' in ${ref.apiName}. Declared methods: ${known.join(', ') || '(none)'}`,
        path: 'method',
      });
    }
    return ok({ data: fitToBudget(narrowed), vaultState });
  }
  if (input.include !== undefined) {
    return ok({ data: fitToBudget(applyInclude(base, input.include)), vaultState });
  }
  return ok({ data: fitToBudget(base), vaultState });
};
