/**
 * Handler for the `sfi.find_dead_code` MCP tool.
 *
 * The v2.2 cross-cutting dead-code surface — composes v2.7's
 * `method_reachability` verdict, entry-point taxonomy, zero-usage
 * classes, and unused CustomField (no incoming edges) into a single
 * cascade verdict per candidate. Answers "what code in this org has
 * no callers?".
 *
 * **Three verdicts:**
 *
 *   - `definitely_dead`: an ApexClass / ApexTrigger with ZERO incoming
 *     USAGE edges (no callers, no triggers, no listeners). For an
 *     ApexClass, this verdict additionally survives a static-type-usage
 *     grep re-check: a class referenced only via a static-field or
 *     type-name usage (`Other.CONST`, `List<Other>`,
 *     `JSON.deserialize(.., List<Other>.class)`) — which the parser does
 *     not model as an inbound edge — is downgraded to `uncertain` rather
 *     than reported dead. For
 *     CustomField, no incoming references at all (no formula refs, no
 *     Apex reads/writes, no Flow record-ops, no layout placements). For an
 *     Activity/Task/Event-family CustomField specifically (a shared
 *     Activity custom field can be materialized as up to three graph
 *     nodes — `CustomField:Activity/Task/Event.<field>` — that are ONE
 *     physical field), this verdict additionally survives an
 *     Activity-polymorphic re-check: when another EXISTING representation
 *     of the same field has a real incoming usage edge this candidate does
 *     not, the candidate is downgraded to `uncertain` instead (see
 *     `ACTIVITY_POLYMORPHIC_DISCLOSURE`).
 *     For a Flow, ONLY when its status is `Obsolete` / `InvalidDraft`
 *     (R2-12): an Active / Draft / unknown-status Flow is NEVER
 *     definitely_dead — Flow edges are all OUTGOING (triggersOn /
 *     listensTo / callsApex / writesTo), so a live flow has ~0 incoming
 *     edges by nature and fires on its own trigger; flagging it dead
 *     would delete running automation. `parentOf` (structural) and
 *     `grantedBy` (Profile / PermissionSet access grants) are NOT usage
 *     and do not keep a component alive — access is not usage, the same
 *     split the field / what-if tools make.
 *   - `likely_dead`: a code component reached only by test classes
 *     (`isTest === true`) or via heuristic-only edges that may be
 *     stripped by dynamic SOQL / reflective access. The v2.7
 *     `method_reachability` `test-only-reachable` verdict cascades
 *     here.
 *     An ASYNC-DISPATCH class (Queueable / Batchable / Schedulable) is
 *     NEVER `likely_dead` and never `definitely_dead` — see `uncertain`.
 *   - `uncertain`: reached by at least one EXTERNAL entry point (REST
 *     resource, AuraEnabled, InvocableMethod, or ApexTrigger — the
 *     platform invokes these directly), an ASYNC-DISPATCH class of any
 *     kind, a class registered dynamically (framework subclass /
 *     `Callable`) — OR an Active / Draft / unknown-status Flow, which is
 *     its OWN entry point (R2-12). Surfaced for completeness in the
 *     result set when `includeUncertain: true`; suppressed by default,
 *     and the `suppressed` block says how many rows that removed.
 *
 *     Every Queueable / Batchable / Schedulable class lands here because
 *     its registration need not exist in metadata at all: an admin who
 *     schedules a class through Setup > Schedule Apex creates a
 *     `CronTrigger` RECORD, and CronTrigger is DATA, not metadata — never
 *     retrieved, no node, no edge, and no refresh can close that gap.
 *     `System.enqueueJob` / `Database.executeBatch` run from anonymous
 *     Apex just as well. So an absent dispatch site is the EXPECTED
 *     reading for a live scheduled job. What the vault CAN see is still
 *     reported in `reasoning`: a production (non-`@isTest`) dispatch site
 *     — including one guarded only by `!Test.isRunningTest()` — means
 *     live at runtime; @isTest-only or absent dispatch is stated as "no
 *     production dispatch site is VISIBLE in this vault".
 *
 * **Entry-point taxonomy** (matches `method-reachability.ts`):
 *   - `ApexTrigger`: triggers ARE entry points.
 *   - `ApexClass` with `isRestResource: true`.
 *   - `ApexClass` with `hasAuraEnabledMethod: true`.
 *   - `ApexClass` with `hasInvocableMethod: true`.
 *   - `ApexClass` with `isQueueable: true` / `isBatchable: true` /
 *     `isSchedulable: true` — an UNPROVEN registration (see `uncertain`),
 *     never a confident dead verdict.
 *
 * **Filter by type:** optional `types` narrows the dead-code scan to
 * one or more ComponentTypes. Default is `['ApexClass', 'ApexTrigger',
 * 'Flow', 'CustomField']` — the four scope-relevant types.
 *
 * **Honesty axis (v2.7 inherited):** dynamic dispatch
 * (`Type.forName(...)`), reflective invocation, framework wiring
 * (TriggerHandler / fflib base classes), managed-package callers, and
 * every registration that lives in DATA rather than metadata — a
 * `CronTrigger` record written by Setup > Schedule Apex, a Custom
 * Metadata dispatch row, anonymous Apex — are INVISIBLE to the graph
 * edges this tool walks, and no refresh changes that. A class genuinely
 * invoked at runtime via one of these mechanisms has zero incoming edges
 * by construction. The recognisable shapes are routed to `uncertain`
 * (async dispatch, framework subclass, `Callable`); the rest can still
 * surface as `definitely_dead` or `likely_dead`. The `boundaries` array
 * surfaces the verbatim disclosure.
 *
 * **Performance (v3.2):** the original implementation issued one
 * `listEdges` plus one `getNodeById` per incoming edge — an N+1
 * pattern that ran ~14000 SQL queries on the Acme fixture
 * (1539 candidates, ~12600 referrer-lookups). v3.2 collapses the
 * cascade into a single CTE that LEFT JOINs candidates to incoming
 * edges and referrers in one round-trip, pushing the entry-point
 * and `isTest` classification into SQL via DuckDB's
 * `json_extract_string`. The result is logically identical to the
 * per-node walk but executes in ~500ms on Acme (down from ~3700ms,
 * a ~7x speedup) and scales linearly with edge count rather than
 * per-edge round-trip cost.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result, splitPathSegments} from '@sf-intelligence/core';
import {
  ACTIVITY_POLYMORPHIC_SLOTS,
  getNodeById,
  type GraphStore,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  ASYNC_DISPATCH_PROPERTY_KEYS,
  CALLABLE_INTERFACE,
  NOT_USAGE_EDGE_TYPES,
  UNPROVEN_REGISTRATION_DISCLOSURE,
} from './apex-reachability.js';
import { buildCoverageCaveat, type CoverageCaveat } from './coverage-trust.js';
import {
  firstNonEmpty,
  mergeInputAliases,
  resolveExistingObjectScope,
  toApexClassId,
  toCustomObjectId,
} from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import {
  buildUnscannedNodesNote,
  censusQualityScanCoverage,
  type QualityScanTypeCoverage,
} from './quality-scan-coverage.js';
import { REPORT_DASHBOARD_USAGE_CAVEAT } from './report-dashboard-usage.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { grepVaultSource } from './search-apex-source.js';
import { soundnessFromNodes, type Soundness } from './soundness.js';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const FIND_DEAD_CODE_TOOL = 'sfi.find_dead_code';

const DEAD_CODE_DISCLOSURE =
  'dead-code detection is heuristic: dynamic dispatch (`Type.forName(...)`), reflective invocation, framework wiring (TriggerHandler / fflib base classes), and managed-package callers are invisible to the graph edges this tool walks. A class genuinely invoked at runtime via one of these mechanisms will surface as `definitely_dead` or `likely_dead`. Verify before deleting.';
const TEST_DISCLOSURE =
  'test classes (properties.isTest === true) are NEVER flagged as dead — they ARE entry points for the test-runner.';
const MANAGED_PACKAGE_DISCLOSURE =
  'managed-package code is not vaulted; callers from managed packages are invisible. A class only called by managed-package code will surface as dead.';
const FLOW_DISCLOSURE =
  'Flow dead-detection (R2-12): a Flow is flagged definitely_dead ONLY when its status is Obsolete or InvalidDraft. An Active, Draft, or unknown-status Flow is NEVER definitely_dead — Flow graph edges are mostly OUTGOING (triggersOn / listensTo / callsApex / writesTo), so a live flow has ~0 incoming edges by nature and fires on its own trigger/schedule; it surfaces as `uncertain` (suppressed unless includeUncertain). R6-02: subflow invocation (flow-calls-flow) IS now modeled as an incoming `references` edge, so an Obsolete/InvalidDraft flow still invoked by another flow as a subflow now reads `uncertain` (it has a live dependent), not definitely_dead — delete the referencing flow first. The still-invisible path is Apex `Flow.Interview` invocation and non-metadata launch points; verify a flow before deleting it.';
const ASYNC_DISPATCH_DISCLOSURE =
  'async-dispatch (Queueable/Batchable/Schedulable) is NEVER reported dead on metadata evidence alone. The dispatch that starts such a class does not have to exist in metadata: an admin who schedules a class through Setup > Schedule Apex creates a `CronTrigger` RECORD, and CronTrigger is DATA, not metadata — it is never retrieved into the vault, mints no node and no edge, and NO refresh can close that gap; `System.enqueueJob` / `Database.executeBatch` / `System.schedule` run from ANONYMOUS Apex (Developer Console, deployment script) just as well. So an absent dispatch site is the EXPECTED reading for a live scheduled job, not evidence against it, and these classes are reported `uncertain` — suppressed unless includeUncertain — never `definitely_dead` and never `likely_dead`. What the vault CAN say is reported in `reasoning`: a PRODUCTION dispatch site (`System.enqueueJob` / `Database.executeBatch` / `System.schedule` from a non-@isTest class, including one guarded only by `!Test.isRunningTest()`) means the class is live at runtime; @isTest-only dispatch and no dispatch at all are both stated as "no production dispatch site is VISIBLE in this vault", which is not the same claim as "none exists". Further blind spots on the visible side: helper-wrapper dispatch (`MyHelper.enqueue(new MyJob())`), reflective dispatch (`Type.forName`), and managed-package dispatchers. Confirm the job in Setup > Scheduled Jobs / Apex Jobs before deleting anything here.';
const CUSTOM_FIELD_DISCLOSURE =
  'CustomField dead-detection: Apex field reads/writes (incl. field-level SOQL in constant strings) are PARSED graph edges on vaults refreshed at 0.1.9+, and Flow assignments, formula references, and layout placements are modeled — so a field referenced only in Apex/Flow no longer reads dead (permission grants stay EXCLUDED: access is not usage). REMAINING blind spots an absence verdict cannot rule out: Flow formula-TEXT references, report columns beyond the usage-ranked pull, list-view filters, DYNAMIC SOQL built at runtime, and reflective access. Cross-check with `sfi.field_360` or `sfi.find_field_anywhere` before deleting any field.';
/**
 * Activity/Task/Event-family CustomField disclosure (D2 parity with
 * `safe_to_delete_field`'s "Polymorphic Activity attribution" limitation). A
 * shared Activity custom field can be materialized as up to three graph nodes
 * — `CustomField:Activity/Task/Event.<field>` — that are ONE physical field.
 * `@sf-intelligence/graph`'s `mintPolymorphicActivityFieldEdges` mirrors a
 * `readsFrom`/`writesTo`/`references` edge onto every EXISTING sibling
 * representation at IMPORT time, but that mirror is a heuristic, name-based
 * alias applied at import — not a live guarantee this tool can lean on
 * blindly: it under-mints on the incremental apply-change-set path (see its
 * docstring), it never ran at all on a vault refreshed before it existed,
 * and it only ever covers those three edge types (a Layout placement or a
 * ListView reference recorded on ONE sibling never propagates to the
 * others). Trusting the precomputed `incoming` join alone would silently
 * inherit whichever of those gaps this vault happens to have, so before
 * `find_dead_code` certifies `definitely_dead` on one of these three nodes,
 * it re-checks the OTHER existing representations' own incoming edges
 * DIRECTLY, at query time — see the "ACTIVITY-POLYMORPHIC re-check" pass
 * below. A definitely_dead verdict that survives the re-check found no
 * incoming usage edge on ANY existing representation of the field. Residual
 * blind spot: a representation that is not itself vaulted as a node (no
 * Activity base node in a describe-snapshot-only vault, say) cannot be
 * cross-checked here. Confirm with `sfi.safe_to_delete_field` before
 * deleting any field in this family.
 */
const ACTIVITY_POLYMORPHIC_DISCLOSURE =
  'Activity-family CustomField re-check: a shared Activity custom field can be materialized as up to three graph nodes — `CustomField:Activity/Task/Event.<field>` — that are ONE physical field (see `sfi.safe_to_delete_field`\'s "Polymorphic Activity attribution" limitation). Before reporting `definitely_dead` on one of these three nodes, this tool queries the OTHER EXISTING representations\' own incoming usage edges directly — not the precomputed import-time mirror alone, which is a heuristic name-based alias that under-mints on the incremental apply-change-set path, is absent entirely on a vault refreshed before it existed, and only ever covers readsFrom/writesTo/references (a Layout placement or ListView reference on one sibling never propagates to the others) — and downgrades to `uncertain` when a sibling has a real dependent this candidate does not. A `definitely_dead` verdict that survives this check found NO incoming usage edge on ANY existing representation of the field. Residual blind spot: a representation that is not itself vaulted as a node cannot be cross-checked. Cross-check with `sfi.safe_to_delete_field` before deleting any field in this family.';
/**
 * THIS TOOL'S verdict framing for an unproven dynamic registration. The claim
 * itself — what the two predicates establish and what they do not — lives ONCE
 * in `apex-reachability.ts` beside the predicates, as
 * {@link UNPROVEN_REGISTRATION_DISCLOSURE}; only the sentence about the
 * `definitely_dead` cascade is local, because only this tool has one.
 */
const UNPROVEN_REGISTRATION_VERDICT_DISCLOSURE =
  'dynamic registration: such a class is reported `uncertain`, never `definitely_dead` — its ' +
  `emptiness is expected, not evidence. ${UNPROVEN_REGISTRATION_DISCLOSURE}`;

/**
 * The Apex SOURCE surface — the corpus the code-quality recognizers run over,
 * and the corpus every dead-code verdict is an absence claim ABOUT. A dead
 * verdict says "no retrieved caller references this"; any ApexClass or
 * ApexTrigger is a potential caller, and whether one of them reaches the
 * component at RUNTIME (dynamic SOQL, `Type.forName`, reflective describe) is
 * knowable only from the `qualityIssues` scan on that caller. A node carrying
 * no scan is therefore an UNREAD referrer, not a clean one.
 */
const APEX_REFERRER_TYPES: readonly ComponentType[] = ['ApexClass', 'ApexTrigger'];

/**
 * Appended after {@link buildUnscannedNodesNote} whenever the census finds an
 * unread Apex node, so the shared sentence ("not checked, NOT clean") is tied to
 * what it means HERE: the unread nodes are the referrer surface this tool's
 * verdicts rest on.
 */
const UNSCANNED_REFERRER_DISCLOSURE =
  'what that gap means for a DELETE verdict: the unread nodes above are part of the CALLER surface every verdict on this response is an absence claim about. The dynamic-Apex signal — the only thing that says whether a caller builds its references at runtime — lives on the scan those nodes never received, so their status is UNKNOWN rather than clean. The `soundness` envelope names them under `quality-scan-not-run` and reports `complete: false` for exactly this reason; do not read a `definitely_dead` row as cleared by them. Re-run `sfi refresh`, then re-run this tool, before deleting.';

/**
 * Fail-CLOSED text for the case the referrer census itself could not be read.
 * An unreadable corpus is an UNKNOWN corpus, never an empty one — the whole
 * defect class this envelope exists to prevent.
 */
const REFERRER_CENSUS_UNREADABLE_NOTE =
  'The Apex referrer surface (ApexClass / ApexTrigger) could not be enumerated on this call, so the code-quality scan coverage of the callers these verdicts are an absence claim about is UNKNOWN. This result is NOT proof anything listed is unreferenced.';
const REFERRER_CENSUS_UNREADABLE_DISCLOSURE =
  `quality-scan coverage UNKNOWN: ${REFERRER_CENSUS_UNREADABLE_NOTE} \`qualityScanCoverage\` is omitted from this response for that reason, and \`soundness\` is reported partial rather than complete.`;

/** Residual-cap disclosure for a pathologically large Apex corpus. */
const REFERRER_SCAN_INCOMPLETE_DISCLOSURE =
  'the Apex referrer census stopped at the residual node-scan cap, so `qualityScanCoverage` counts a PREFIX of the Apex corpus rather than all of it. Nodes behind the cap were neither censused nor considered by the `soundness` envelope.';

const STATIC_TYPE_USAGE_DISCLOSURE =
  'static-type-usage re-check: before an ApexClass is reported definitely_dead its api name is grep-searched (whole-word) across non-test production .cls/.trigger source. A class referenced only via a static-field or type-name usage (`Other.CONST`, `List<Other>`, `JSON.deserialize(.., List<Other>.class)`) — which the parser does NOT model as an inbound graph edge — is downgraded to `uncertain` (suppressed unless includeUncertain) instead of reported dead. Residual blind spots: the grep is line-literal (a class name in a comment or string could over-suppress), and dynamic `Type.forName(\'Other\')` references stay invisible.';

/**
 * The dead-code types whose nodes carry an OBJECT parent in the graph, and are
 * therefore reachable by an object scope.
 *
 * Read off the extractors, not assumed: `custom-field.ts` sets
 * `parentId = CustomObject:{object}` on every field it emits, while
 * `apex-class.ts`, `apex-trigger.ts` and `flow.ts` all emit `parentId: null`
 * (an Apex trigger's object lives on its outgoing `triggersOn` edge, not on a
 * parent link, and a Flow's on `properties.triggerObject`). An object-scoped
 * scan therefore reports NONE of those three families — which is
 * "not attributable to this object", never "this object has no dead Apex", and
 * is disclosed as such rather than shipped as a silent zero.
 */
const OBJECT_PARENTED_TYPES: ReadonlySet<string> = new Set(['CustomField']);

/**
 * OBJECT-SCOPE-NARROWING disclosure. Emitted ONLY on an object-scoped call, and
 * only when the caller asked for a type this scope cannot reach — so the bare
 * org-wide response keeps its exact pre-0.3.3 boundary list.
 */
const objectScopeNarrowingDisclosure = (
  objectScopeParentId: string,
  unreachable: readonly string[],
): string =>
  `object scope \`${objectScopeParentId}\`: the scan is narrowed to components PARENTED BY that object ` +
  `(a \`parent_id\` match). ${unreachable.join(', ')} nodes carry no object parent in this vault's graph, ` +
  'so this object-scoped answer reports none of them — read that as "not attributable to this object", ' +
  'NEVER as "this object has no dead code of that type". Ask without an object scope for the org-wide ' +
  'view of those families, or scope one by `componentId`.';

/** Verdict cascade. */
export type DeadCodeVerdict =
  | 'definitely_dead'
  | 'likely_dead'
  | 'uncertain';

const findDeadCodeInputBaseSchema = z.object({
  /**
   * Optional COMPONENT scope — narrows the scan to ONE component's dead/live
   * verdict. `ApexClass:` / `ApexTrigger:` / `Flow:` / `CustomField:` id. When
   * supplied, `uncertain` is not suppressed (a scoped question wants the actual
   * verdict), an unresolved id is `component-not-found`, and a non-dead-code
   * type prefix is `invalid-query` — never a silent org-wide top-N. Cannot be
   * combined with the `objectId` / `objectApiName` object scope.
   *
   * FIND-DEAD-CODE-IGNORES-CLASSAPINAME: `classApiName` / `apiName` are bare
   * ApexClass-name aliases for this scope — a host asking "is CourseEmailController
   * dead?" passes a bare name, not an `ApexClass:` id. The preprocess coerces
   * them (and a prefix-less `componentId`) to `ApexClass:{name}` so a class-name
   * scope resolves identically to the canonical `componentId`, never falling
   * through to the org-wide list.
   */
  componentId: z.string().min(1).optional(),
  classApiName: z.string().min(1).optional(),
  apiName: z.string().min(1).optional(),
  /**
   * Optional OBJECT scope (interchangeable: canonical `CustomObject:{name}` or
   * a bare api name). Narrows the scan to components PARENTED BY that object —
   * every scanned type, not just fields — and echoes the vault-cased id as
   * `appliedScope.object`. The object must EXIST: an api name no
   * `CustomObject` node matches is `invalid-query`, never a candidate list
   * (FIND-DEAD-CODE-ANSWERS-FOR-NONEXISTENT-OBJECT). Cannot be combined with
   * the `componentId` component scope.
   */
  objectId: z.string().min(1).optional(),
  objectApiName: z.string().min(1).optional(),
  types: z
    .array(
      z.enum([
        'ApexClass',
        'ApexTrigger',
        'Flow',
        'CustomField',
      ]),
    )
    .optional(),
  includeUncertain: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  // CR-22: page cursor for walking the full candidate list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

/** Zod schema for `sfi.find_dead_code`. */
export const findDeadCodeInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    { canonical: 'objectId', aliases: ['objectApiName'] },
    // FIND-DEAD-CODE-IGNORES-CLASSAPINAME: fold the bare-class-name aliases into
    // the canonical componentId (only when componentId is absent) so a host that
    // asks by class name reaches the same component scope as `ApexClass:{name}`.
    { canonical: 'componentId', aliases: ['classApiName', 'apiName'] },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.objectId === 'string' ? o.objectId : '';
    if (id.length > 0 && !id.startsWith('CustomObject:')) {
      o.objectId = toCustomObjectId(id);
    }
    // A prefix-less componentId (from a bare classApiName/apiName alias, or a
    // bare componentId) is an ApexClass name — coerce to `ApexClass:{name}` so
    // it resolves to a real component scope instead of being rejected /
    // silently org-wide. An explicit `Type:` prefix (ApexTrigger:/Flow:/
    // CustomField:/Profile:…) is left untouched for its own resolver branch.
    const cid = typeof o.componentId === 'string' ? o.componentId : '';
    if (cid.length > 0 && !cid.includes(':')) {
      o.componentId = toApexClassId(cid);
    }
  }
  return merged;
}, findDeadCodeInputBaseSchema);

/** Parsed input shape. */
export type FindDeadCodeInput = z.infer<typeof findDeadCodeInputSchema>;

/** One dead-code candidate in the response. */
export interface DeadCodeCandidate {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly verdict: DeadCodeVerdict;
  readonly incomingEdgeCount: number;
  readonly reachedByTestClassOnly: boolean;
  readonly isOwnEntryPoint: boolean;
  readonly reasoning: string;
  readonly confidence: 'heuristic';
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindDeadCodeOutput {
  /**
   * Echoes the scope ACTUALLY applied so a host never assumes a `componentId`
   * it passed was silently stripped (the always-org-wide-top-N bug this closes).
   * `component` is the resolved id in component scope (null otherwise); `object`
   * is the resolved object scope parent id, in the VAULT's exact casing and
   * proven to exist; `mode` names the axis in force. `mode: 'object'` now means
   * every listed row is PARENTED BY that object — it used to ship the org-wide
   * Apex/Flow inventory under the same heading.
   */
  readonly appliedScope: {
    readonly component: string | null;
    readonly object: string | null;
    readonly mode: 'all' | 'component' | 'object';
  };
  readonly candidates: readonly DeadCodeCandidate[];
  /**
   * How many candidates are LISTED — i.e. the length of the filtered set
   * `candidates` pages through. NOT the size of the classified set when
   * `includeUncertain` is false; `byVerdict` carries that, and `suppressed`
   * states the difference.
   */
  readonly totalCount: number;
  /**
   * Verdict tally across the FULL classified candidate set, INCLUDING rows the
   * `includeUncertain` filter withheld from `candidates`.
   *
   * It used to tally the post-filter list, so a default call reported
   * `uncertain: 0` while 91 uncertain rows had been classified and dropped —
   * an UNCHECKED zero in the exact bucket a reader consults to ask "did this
   * tool consider anything it is not telling me about". `suppressed` names the
   * gap between this tally and `totalCount`.
   */
  readonly byVerdict: Readonly<{
    definitely_dead: number;
    likely_dead: number;
    uncertain: number;
  }>;
  /** Component-type tally across the FULL classified set, on the same basis as `byVerdict`. */
  readonly byType: Readonly<Record<string, number>>;
  /**
   * What the `includeUncertain` filter withheld from `candidates`. ALWAYS
   * present, so `uncertainWithheld: 0` is readable as CHECKED — the scan
   * classified no uncertain rows — rather than as an absent field.
   */
  readonly suppressed: {
    /** The filter actually applied (a component-scoped call forces it true). */
    readonly includeUncertain: boolean;
    /** Uncertain candidates classified but NOT listed. `0` when nothing was withheld. */
    readonly uncertainWithheld: number;
    /** Verbatim sentence stating the relationship between the tallies and the listing. */
    readonly note: string;
  };
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  /**
   * Page size applied to this response. Present ONLY on a PAGED response
   * (`truncated` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned candidate. Present only when paged (see `limit`). */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when `truncated`. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more candidates remain). Echo it back as `cursor` to resume. Absent on a
   * complete page so an in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  /**
   * Per-type census of the Apex REFERRER surface: how many ApexClass /
   * ApexTrigger nodes the vault holds, and how many of those carry a
   * `qualityIssues` scan at all. Emitted on EVERY successful response — a
   * clean sweep is exactly the shape a never-scanned corpus produces, so it is
   * the answer that most needs to state how much was actually read. Absent only
   * when the corpus could not be enumerated, in which case `boundaries[]` says
   * so and `soundness` is partial.
   *
   * This is the same block `code_quality_audit` / `crud_fls_audit` /
   * `governor_limit_risks` / `find_hardcoded_values` / `tech_debt_score`
   * publish off the same property; this tool omitted it while being the only
   * one of the family that renders a DELETE verdict.
   */
  readonly qualityScanCoverage?: readonly QualityScanTypeCoverage[];
  /**
   * Static-analysis blind spots over the APEX REFERRER SURFACE (every
   * ApexClass / ApexTrigger in the vault — a superset of the Apex candidates,
   * so a dynamic-Apex CANDIDATE still downgrades it). `complete: false` when
   * any of them uses dynamic Apex (`dynamic-apex`) or carries no code-quality
   * scan at all (`quality-scan-not-run`).
   *
   * Deliberately NOT computed over the rendered page: the certificate must not
   * change when a DISPLAY option changes.
   */
  readonly soundness: Soundness;
  /**
   * Present when a CALLER family this dead-code claim depends on has
   * incomplete coverage (errored retrieve, scoped refresh, or a staged build
   * whose tier has not reached it). "Dead" only means "no retrieved caller
   * references it" — an un-retrieved LWC's `@AuraEnabled` call would fake
   * death. Distinct from `soundness`, which covers dynamic-dispatch blind
   * spots WITHIN retrieved code.
   */
  readonly coverageCaveat?: CoverageCaveat;
}

/**
 * Caller families whose absence can FAKE a dead-code verdict: Apex entry
 * points are invoked from these surfaces, so incomplete coverage of any of
 * them must qualify the claim (P13-STAGED-absence-battery).
 */
const DEAD_CODE_REQUIRED_COVERAGE: readonly string[] = [
  'ApexClass',
  'ApexTrigger',
  'AuraDefinitionBundle',
  'FlexiPage',
  'Flow',
  'LightningComponentBundle',
  'QuickAction',
  'VisualforceComponent',
  'VisualforcePage',
];

const DEFAULT_TYPES: readonly ComponentType[] = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'CustomField',
];

/** Map a component-scope id's canonical `Type:` prefix to its dead-code type. */
const DEAD_CODE_PREFIX_TO_TYPE: Readonly<Record<string, ComponentType>> = {
  'ApexClass:': 'ApexClass',
  'ApexTrigger:': 'ApexTrigger',
  'Flow:': 'Flow',
  'CustomField:': 'CustomField',
};

/**
 * Resolve the optional COMPONENT scope from `componentId`. Returns `null` for
 * org-wide (no scope), the resolved `{ id, type }` for a dead-code component, or
 * an `invalid-query` error for a non-dead-code type prefix. Existence is checked
 * by the caller (a resolvable-but-absent id is `component-not-found`).
 */
const resolveComponentScope = (
  componentId: string | undefined,
): Result<{ id: ComponentId; type: ComponentType } | null, McpError> => {
  if (componentId === undefined) return ok(null);
  for (const [prefix, type] of Object.entries(DEAD_CODE_PREFIX_TO_TYPE)) {
    if (componentId.startsWith(prefix)) {
      return ok({ id: componentId as ComponentId, type });
    }
  }
  return err({
    kind: 'invalid-query',
    message: `componentId must be an ApexClass: / ApexTrigger: / Flow: / CustomField: id; got '${componentId}'`,
    path: 'componentId',
  });
};

/**
 * One row returned by the dead-code CTE — a candidate plus the
 * aggregated counts/flags computed across its incoming non-parentOf
 * edges. The booleans collapse the per-edge JS-side cascade into
 * SQL-side aggregations: `incoming_count` is the total non-parentOf
 * in-degree; `has_non_test_reach` is true iff at least one referrer
 * is non-test (or the referrer node is missing entirely, mirroring
 * the original's sparse-graph fall-through); `has_entry_point_reach`
 * is true iff at least one non-test referrer is itself a recognized
 * entry-point class. `is_test` and `is_own_entry_point` describe the
 * candidate itself.
 */
interface DeadCodeRow {
  readonly id: string;
  readonly type: string;
  readonly api_name: string;
  readonly is_test: boolean;
  readonly is_own_entry_point: boolean;
  /**
   * UNPROVEN dynamic registration: the class extends a base class from another
   * namespace (a managed package / platform framework instantiates its own
   * subclasses), implements an interface qualified by another namespace (e.g.
   * an AuthProvider's `Auth.RegistrationHandler`), or declares the `Callable`
   * dynamic-invocation interface. All are DECLARED properties of the class;
   * none proves the registration is live, because the registration lives in a
   * string literal, a Custom Metadata record, or managed-package code that
   * mints no edge. Maps to `uncertain` — never `definitely_dead`, and never a
   * live verdict either.
   *
   * Kept behaviourally identical to `isFrameworkSubclass` /
   * `isNamespacedInterfaceImplementation` / `isCallableDispatch` in
   * `apex-reachability.ts` by a drift test.
   */
  readonly is_unproven_registration: boolean;
  /**
   * Async-dispatch entry point only (Queueable / Batchable / Schedulable): an
   * ApexClass dispatched by USER code (`System.enqueueJob` / `Database.executeBatch`
   * / `System.schedule`), NOT invoked externally by the platform like REST / Aura /
   * Invocable. Unlike an external entry point, an async-dispatch class is dead when
   * nothing production-side ever dispatches it — so it must be cross-referenced
   * against its inbound `dispatchesAsync` edges rather than blanket-trusted as live.
   * FALSE for external entry points, triggers, flows, fields.
   */
  readonly is_async_dispatch_entry: boolean;
  /**
   * Async-dispatch only: TRUE when at least one inbound `dispatchesAsync` edge
   * comes from a NON-test (`isTest !== true`) caller — a real production dispatch
   * site. A caller guarded by `!Test.isRunningTest()` is still a production class
   * (the guard suppresses the call only during test execution), so it counts here.
   * A class enqueued ONLY from @isTest classes has this FALSE — that test dispatch
   * is rolled back at runtime and does not keep the class alive.
   */
  readonly has_production_dispatch: boolean;
  /** Flow only (R2-12): TRUE when the Flow's status is NOT Obsolete/InvalidDraft
   *  (active, Draft, or unknown/missing status — all treated as in-use). An
   *  active flow fires on its own trigger and has ~0 incoming edges by nature,
   *  so this guards against deleting live automation. FALSE for non-Flow. */
  readonly is_active_entry_point: boolean;
  readonly incoming_count: bigint | number;
  readonly has_non_test_reach: boolean;
  readonly has_entry_point_reach: boolean;
  /** CustomField only: folded `--with-reports` report/dashboard usage. A field
   *  used by a report column/filter or dashboard component is NOT dead even with
   *  zero incoming edges (the usage is a node property, not a graph edge). */
  readonly used_in_analytics: boolean;
}

/**
 * Run the single CTE that drives the v3.2 dead-code scan. Returns
 * one row per candidate in `types`, with the entry-point and
 * test-reach classifiers already aggregated SQL-side. Empty `types`
 * is handled at the caller boundary (`DEFAULT_TYPES` substitution),
 * so this helper assumes at least one type.
 *
 * The CTE shape:
 *   - `candidates` selects the requested types and resolves the
 *     candidate-level `is_test` / `is_own_entry_point` flags from
 *     `properties_json` via `json_extract_string` — no parse step,
 *     no JSON-vs-string ambiguity (DuckDB extracts JSON booleans as
 *     the strings `'true'` / `'false'`).
 *   - `incoming` LEFT JOINs every non-parentOf inbound edge against
 *     the referrer node, resolving the referrer's `from_is_test`
 *     and `from_is_entry` flags. `from_is_null` distinguishes
 *     orphan edges (referrer node deleted) from real referrers; the
 *     original walk treats them as non-test reach, which the
 *     outer aggregation preserves.
 *   - The outer SELECT LEFT JOINs candidates → incoming and
 *     aggregates: `COUNT(i.cid)` returns 0 for candidates with no
 *     incoming edges; `BOOL_OR` collapses the per-edge classifier
 *     to the per-candidate booleans the JS cascade consumes.
 */
/**
 * The `edge_type` exclusions the dead-code CTE applies, GENERATED from
 * {@link NOT_USAGE_EDGE_TYPES}. Exported so a drift test can prove the SQL and
 * the shared TS constant are the same set rather than merely similar — a
 * hand-copied list is the exact drift that let `edgeTypes: ['callsApex']`
 * survive two new edge types.
 */
export const NON_USAGE_EDGE_EXCLUSION_SQL = NOT_USAGE_EDGE_TYPES.map(
  (t) => `        AND e.edge_type <> '${t}'`,
).join('\n');

/**
 * The `is_unproven_registration` CTE predicate. `CALLABLE_INTERFACE` is imported
 * from `apex-reachability.ts` rather than spelled again here, so the interface
 * name cannot drift between the TS predicate and the SQL one.
 *
 * The `implements` LIKE '%.%' clause is the SQL face of
 * `isNamespacedInterfaceImplementation`: `json_extract_string` on an ARRAY
 * path serializes it as text (`["Callable","Auth.RegistrationHandler"]`), so a
 * bare `LIKE '%.%'` over JUST that value is true iff some interface name in
 * the array is dotted — brackets/quotes/commas carry no `.` of their own,
 * same reasoning as the `superclass` clause above it.
 */
export const UNPROVEN_REGISTRATION_SQL = `             COALESCE(
               type = 'ApexClass' AND (
                 COALESCE(json_extract_string(properties_json, '$.superclass') LIKE '%.%', FALSE)
                 OR COALESCE(json_extract_string(properties_json, '$.implements') LIKE '%"${CALLABLE_INTERFACE}"%', FALSE)
                 OR COALESCE(json_extract_string(properties_json, '$.implements') LIKE '%.%', FALSE)
${ASYNC_DISPATCH_PROPERTY_KEYS.map(
  (k) =>
    `                 OR COALESCE(json_extract_string(properties_json, '$.${k}') = 'true', FALSE)`,
).join('\n')}
               ),
               FALSE)`;

const fetchDeadCodeRows = async (
  store: GraphStore,
  types: readonly ComponentType[],
  objectScopeParentId?: string,
  componentScopeId?: string,
): Promise<Result<readonly DeadCodeRow[], string>> => {
  const placeholders = types.map(() => '?').join(', ');
  // FIND-DEAD-CODE-OBJECT-SCOPE-APPLIED-TO-FIELDS-ONLY.
  //
  // This clause used to read `AND (type <> 'CustomField' OR parent_id = ?)` —
  // i.e. it kept EVERY non-CustomField row no matter which object was named.
  // With the default type set that meant an object-scoped call returned the
  // org's entire dead-Apex and dead-Flow inventory under
  // `appliedScope: { object: 'CustomObject:X', mode: 'object' }`. Measured on
  // the demo vault with a scope naming an object that does not exist at all:
  // `candidates: [{ componentId: 'ApexClass:PaymentService', verdict:
  // 'likely_dead' }]`, `byType: { ApexClass: 3, ApexTrigger: 1, Flow: 2 }` —
  // real components, named deletable, attributed to a scope they have nothing
  // to do with, on the tool an architect consults BEFORE deleting.
  //
  // The scope now filters EVERY type by the same `parent_id` match that
  // `unused_components` uses ("a type with no object parent honestly returns
  // empty rather than the org-wide list"). See OBJECT_PARENTED_TYPES for which
  // families that reaches and the disclosure that rides with the narrowing.
  const objectScopeClause = objectScopeParentId !== undefined ? `AND parent_id = ?` : '';
  // Component scope: narrow the candidate set to the single requested node id.
  const componentScopeClause = componentScopeId !== undefined ? `AND id = ?` : '';
  const sql = `
    WITH candidates AS (
      SELECT id, type, api_name,
             COALESCE(
               type = 'ApexClass'
                 AND json_extract_string(properties_json, '$.isTest') = 'true',
               FALSE) AS is_test,
             -- EXTERNAL entry points only: the platform invokes these directly
             -- (REST callout, Lightning/Aura, Flow/Process-Builder dispatch) or
             -- they fire on their own (triggers). They have no in-org caller edge
             -- by nature, so they are blanket-trusted as live. Async-dispatch
             -- classes (Queueable/Batchable/Schedulable) are DELIBERATELY excluded
             -- here — they are dispatched by USER code and are dead when nothing
             -- enqueues them, so they are cross-referenced via is_async_dispatch_entry
             -- + has_production_dispatch below rather than trusted unconditionally.
             COALESCE(
               type = 'ApexTrigger'
                 OR (type = 'ApexClass' AND (
                     COALESCE(json_extract_string(properties_json, '$.isRestResource') = 'true', FALSE)
                     OR COALESCE(json_extract_string(properties_json, '$.hasAuraEnabledMethod') = 'true', FALSE)
                     OR COALESCE(json_extract_string(properties_json, '$.hasInvocableMethod') = 'true', FALSE)
                   )),
               FALSE) AS is_own_entry_point,
             -- UNPROVEN dynamic registration. Same predicates as
             -- isFrameworkSubclass / isNamespacedInterfaceImplementation /
             -- isCallableDispatch in apex-reachability.ts, expressed in SQL
             -- because this tool's cascade is a single CTE (a measured ~7x
             -- speedup that is not worth losing). A behavioural drift test
             -- runs both over the same fixture and asserts they agree.
             -- A dotted superclass OR a dotted implemented-interface name
             -- means the base type lives in ANOTHER namespace, so its owner
             -- instantiates/dispatches the class and no local callsApex edge
             -- can exist.
${UNPROVEN_REGISTRATION_SQL} AS is_unproven_registration,
             -- Async-dispatch entry point: Queueable / Batchable / Schedulable.
             -- Dispatched by user Apex (enqueueJob / executeBatch / schedule), so
             -- a class nothing ever dispatches from PRODUCTION is dead even though
             -- it "implements Queueable" — the textbook dead-queueable signature.
             COALESCE(
               type = 'ApexClass' AND (
                 COALESCE(json_extract_string(properties_json, '$.isQueueable') = 'true', FALSE)
                 OR COALESCE(json_extract_string(properties_json, '$.isBatchable') = 'true', FALSE)
                 OR COALESCE(json_extract_string(properties_json, '$.isSchedulable') = 'true', FALSE)
               ),
               FALSE) AS is_async_dispatch_entry,
             -- Flow only (R2-12): a Flow is its OWN entry point when its status
             -- is NOT inactive. Flow edges are all OUTGOING (triggersOn /
             -- listensTo / callsApex / writesTo), so a live flow naturally has
             -- ~0 incoming edges — counting that as definitely_dead deletes
             -- running automation. Only Obsolete / InvalidDraft flows are dead.
             -- COALESCE the missing/NULL status to '' so an unknown-status flow
             -- PASSES the NOT IN test (=> TRUE => uncertain), NEVER falls
             -- through to incomingCount===0 => definitely_dead. Mirrors
             -- unused-components.ts isInactiveEntryPoint (unknown => in-use).
             COALESCE(
               type = 'Flow'
                 AND COALESCE(json_extract_string(properties_json, '$.status'), '')
                     NOT IN ('Obsolete', 'InvalidDraft'),
               FALSE) AS is_active_entry_point,
             -- CustomField only: folded report/dashboard usage (--with-reports).
             -- Stored as a node property (not an edge), so the in-degree count
             -- below can't see it; a report-only field would read as dead.
             COALESCE(
               type = 'CustomField' AND (
                 json_extract_string(properties_json, '$.usedInReport') = 'true'
                 OR json_extract_string(properties_json, '$.usedInDashboard') = 'true'
               ),
               FALSE) AS used_in_analytics
      FROM nodes
      WHERE type IN (${placeholders})
        -- Standard fields (api name has no __c suffix) are platform fields:
        -- not deletable and not "dead code". Only custom / managed-package
        -- fields (which end in __c) are valid CustomField dead-code candidates
        -- (NI-6: stops IsPartner/IsCustomerPortal/etc. being flagged dead).
        AND NOT (type = 'CustomField' AND api_name NOT LIKE '%\\_\\_c' ESCAPE '\\')
        ${objectScopeClause}
        ${componentScopeClause}
    ),
    incoming AS (
      SELECT e.to_id AS cid,
             COALESCE(
               r.type = 'ApexClass'
                 AND json_extract_string(r.properties_json, '$.isTest') = 'true',
               FALSE) AS from_is_test,
             COALESCE(
               r.type = 'ApexTrigger'
                 OR (r.type = 'ApexClass' AND (
                     COALESCE(json_extract_string(r.properties_json, '$.isRestResource') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.hasAuraEnabledMethod') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.hasInvocableMethod') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.isQueueable') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.isBatchable') = 'true', FALSE)
                     OR COALESCE(json_extract_string(r.properties_json, '$.isSchedulable') = 'true', FALSE)
                   )),
               FALSE) AS from_is_entry,
             -- A PRODUCTION async dispatch: an inbound dispatchesAsync edge
             -- (enqueueJob / executeBatch / schedule) whose caller is NOT an
             -- isTest class. A caller guarded by !Test.isRunningTest() is still
             -- a production class -- the guard suppresses the call only during
             -- tests -- so it counts here. Tells a live Queueable from a dead one.
             COALESCE(
               e.edge_type = 'dispatchesAsync'
                 AND NOT COALESCE(
                   r.type = 'ApexClass'
                     AND json_extract_string(r.properties_json, '$.isTest') = 'true',
                   FALSE),
               FALSE) AS from_is_production_dispatch,
             r.id IS NULL AS from_is_null
      FROM edges e
      LEFT JOIN nodes r ON r.id = e.from_id
      WHERE e.to_id IN (SELECT id FROM candidates)
        -- The non-usage exclusions are GENERATED from NOT_USAGE_EDGE_TYPES, the
        -- same constant method_reachability / test_coverage_gaps / call_graph
        -- walk against, so the four tools cannot drift apart about what "used"
        -- means. parentOf is structural containment; grantedBy is a Profile /
        -- PermissionSet ACCESS grant (Apex class access, field
        -- FLS) and access is not USAGE — a class nobody calls or a field
        -- nothing references is dead even when profiles grant access to it.
        -- Counting grants as reach hid test-only classes (reached only by their
        -- own test + profile grants) as uncertain, and kept grant-only-but-unused
        -- components out of definitely_dead. Same access-vs-usage split the
        -- field / what-if tools make.
${NON_USAGE_EDGE_EXCLUSION_SQL}
    )
    SELECT c.id, c.type, c.api_name, c.is_test, c.is_own_entry_point,
           c.is_unproven_registration,
           c.is_async_dispatch_entry, c.is_active_entry_point, c.used_in_analytics,
           COUNT(i.cid) AS incoming_count,
           COALESCE(BOOL_OR(i.from_is_null OR NOT i.from_is_test), FALSE) AS has_non_test_reach,
           COALESCE(BOOL_OR(NOT i.from_is_test AND i.from_is_entry), FALSE) AS has_entry_point_reach,
           COALESCE(BOOL_OR(i.from_is_production_dispatch), FALSE) AS has_production_dispatch
    FROM candidates c
    LEFT JOIN incoming i ON i.cid = c.id
    GROUP BY c.id, c.type, c.api_name, c.is_test, c.is_own_entry_point, c.is_unproven_registration, c.is_async_dispatch_entry, c.is_active_entry_point, c.used_in_analytics
  `;
  try {
    const params = [
      ...types,
      ...(objectScopeParentId !== undefined ? [objectScopeParentId] : []),
      ...(componentScopeId !== undefined ? [componentScopeId] : []),
    ];
    const reader = await store.connection.runAndReadAll(sql, params);
    const rows = reader.getRowObjectsJS() as unknown as readonly DeadCodeRow[];
    return ok(rows);
  } catch (e) {
    return err((e as Error).message);
  }
};

/**
 * Comparator: verdict rank ASC, componentType ASC, then componentId ASC.
 *
 * This is already a STRICT TOTAL order (CR-22): `componentId` is the node `id`
 * the dead-code CTE groups by (`GROUP BY c.id` — one row per distinct node id),
 * so every candidate has a unique componentId and the final key resolves all
 * ties uniquely. The earlier verdict / componentType keys only coarsen. No
 * additional tiebreak is required for a dup-free / skip-free offset resume.
 */
const compareCandidates = (
  a: DeadCodeCandidate,
  b: DeadCodeCandidate,
): number => {
  // Verdict order: definitely_dead first, then likely_dead, then uncertain.
  const verdictRank = (v: DeadCodeVerdict): number =>
    v === 'definitely_dead' ? 0 : v === 'likely_dead' ? 1 : 2;
  const av = verdictRank(a.verdict);
  const bv = verdictRank(b.verdict);
  if (av !== bv) return av - bv;
  if (a.componentType !== b.componentType)
    return a.componentType < b.componentType ? -1 : 1;
  return a.componentId < b.componentId ? -1 : 1;
};

/** Escape a string for literal use inside a `new RegExp(...)`. */
const escapeForRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Canonical id prefix for a CustomField node. */
const CUSTOM_FIELD_ID_PREFIX = 'CustomField:';

/**
 * Lower-cased set of {@link ACTIVITY_POLYMORPHIC_SLOTS} for O(1) membership
 * testing — reused rather than re-declared so this tool's notion of "is this
 * an Activity/Task/Event-family object" cannot drift from the graph layer's.
 */
const ACTIVITY_POLYMORPHIC_SLOT_SET: ReadonlySet<string> = new Set(
  ACTIVITY_POLYMORPHIC_SLOTS,
);

/**
 * Split a `CustomField:{Object}.{Field}` id into its object + field parts on
 * the FIRST `.`. Returns null when the id is not a well-formed CustomField
 * id (no prefix, or no `.`).
 */
const splitCustomFieldId = (
  id: string,
): { readonly object: string; readonly field: string } | null => {
  if (!id.startsWith(CUSTOM_FIELD_ID_PREFIX)) return null;
  const body = id.slice(CUSTOM_FIELD_ID_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) return null;
  return { object: body.slice(0, dot), field: body.slice(dot + 1) };
};

/**
 * True when `id` is a CustomField on one of the three Activity-polymorphic
 * slots (`Activity` / `Task` / `Event`) — the family a shared Activity custom
 * field can be materialized as. Reuses `ACTIVITY_POLYMORPHIC_SLOTS` from
 * `@sf-intelligence/graph` (the same set `mintPolymorphicActivityFieldEdges`
 * gates its mirror on) rather than a second, hand-rolled notion of the
 * family.
 */
const isActivityPolymorphicFieldId = (id: string): boolean => {
  const parts = splitCustomFieldId(id);
  return parts !== null && ACTIVITY_POLYMORPHIC_SLOT_SET.has(parts.object.toLowerCase());
};

/**
 * For a `definitely_dead` Activity/Task/Event-family CustomField candidate,
 * check whether any OTHER EXISTING representation of the same physical field
 * (case-insensitive field-name match, restricted to the Activity/Task/Event
 * object family — see {@link isActivityPolymorphicFieldId}) has a real
 * incoming USAGE edge (the same `NOT_USAGE_EDGE_TYPES` exclusion the main
 * cascade uses) that this candidate does not.
 *
 * This is a QUERY-TIME cross-check against the sibling nodes' own edges — it
 * does NOT read the candidate's own precomputed `incoming` join, and does NOT
 * assume `mintPolymorphicActivityFieldEdges` already mirrored the dependency
 * onto this candidate (see {@link ACTIVITY_POLYMORPHIC_DISCLOSURE} for why
 * that assumption is unsafe: staleness, incremental under-minting, and the
 * mirror's own 3-edge-type ceiling). A field genuinely dependent-free across
 * every EXISTING representation returns false — this never manufactures a
 * dependency that is not there.
 */
const hasLiveSiblingRepresentation = async (
  store: GraphStore,
  fieldId: string,
): Promise<boolean> => {
  const parts = splitCustomFieldId(fieldId);
  if (parts === null) return false;
  try {
    const reader = await store.connection.runAndReadAll(
      `SELECT 1 AS hit
       FROM nodes n
       JOIN edges e ON e.to_id = n.id
       WHERE n.type = 'CustomField'
         AND lower(n.api_name) = lower(?)
         AND n.id <> ?
         AND (
           lower(n.id) LIKE 'customfield:activity.%'
           OR lower(n.id) LIKE 'customfield:task.%'
           OR lower(n.id) LIKE 'customfield:event.%'
         )
${NON_USAGE_EDGE_EXCLUSION_SQL}
       LIMIT 1`,
      [parts.field, fieldId],
    );
    return reader.getRowObjectsJS().length > 0;
  } catch {
    // A query failure must not fake death — fall back to "no live sibling
    // found" so the candidate's own (already-computed) verdict stands rather
    // than silently downgrading on an error this caller cannot see.
    return false;
  }
};

/**
 * Derive the ApexClass / ApexTrigger api name from a vault source path.
 * Source files are named `{ApiName}.cls` / `{ApiName}.trigger` (flat or
 * DX-nested), so the basename minus the suffix is the referencing component's
 * api name — used to attribute a grep hit to its file and to skip test /
 * self references.
 */
const sourceFileApiName = (vaultRelativePath: string): string => {
  const base = splitPathSegments(vaultRelativePath).at(-1) ?? vaultRelativePath;
  return base.replace(/\.(cls|trigger)$/i, '');
};

/**
 * Lower-cased api names of every ApexClass whose `isTest` property is true.
 * Used to exclude test classes from the static-type-usage re-check: a class
 * referenced only from @isTest code is NOT kept alive (test references do not
 * count as production usage — the same posture the graph cascade takes). Apex
 * identifiers are case-insensitive, so the set is lower-cased for comparison.
 */
const fetchTestClassApiNames = async (
  store: GraphStore,
): Promise<Set<string>> => {
  try {
    const reader = await store.connection.runAndReadAll(
      `SELECT api_name FROM nodes
       WHERE type = 'ApexClass'
         AND json_extract_string(properties_json, '$.isTest') = 'true'`,
    );
    const rows = reader.getRowObjectsJS() as unknown as ReadonlyArray<{
      api_name: string;
    }>;
    return new Set(rows.map((r) => String(r.api_name).toLowerCase()));
  } catch {
    // A query failure must not fake death — fall back to "no known test
    // classes" so a reference in a test file is (conservatively) counted as
    // usage rather than silently dropped.
    return new Set<string>();
  }
};

/**
 * The `sfi.find_dead_code` MCP tool. Scans the requested ComponentTypes
 * for components with zero non-parentOf incoming edges (definitely
 * dead), test-only reach (likely dead), or entry-point reach
 * (uncertain). Test classes and own-entry-point classes are excluded
 * from the dead set.
 *
 * @example
 *   const r = await findDeadCodeHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.byVerdict.definitely_dead);
 */
export const findDeadCodeHandler = async (
  ctx: Context,
  input: FindDeadCodeInput,
): Promise<Result<McpResponse<FindDeadCodeOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;
  // Whether an object scope was ASKED FOR, before any vault lookup — the
  // mutually-exclusive-scopes check below is about the shape of the input, so
  // it must not depend on whether the object turns out to exist.
  const objectScopeRequested =
    firstNonEmpty(input.objectId, input.objectApiName) !== undefined;

  // Optional COMPONENT scope. When supplied, narrow the scan to that ONE node,
  // pin `types` to its type, and surface its verdict even when `uncertain` (a
  // scoped question wants the actual answer, not a suppressed row). An
  // unresolved id is `component-not-found`; a non-dead-code prefix is
  // `invalid-query` — never a silent org-wide top-N. It cannot be combined with
  // the object scope (contradictory narrowings).
  //
  // FIND-DEAD-CODE-IGNORES-CLASSAPINAME: resolve the class-name aliases here as
  // well as in the Zod preprocess, so a bare `classApiName` / `apiName` scopes
  // correctly whether the caller pre-parsed the input or handed the handler a
  // raw object (mirrors how the object scope below reads objectId /
  // objectApiName directly). A bare alias is an ApexClass name →
  // `ApexClass:{name}`.
  const classAlias = firstNonEmpty(input.classApiName, input.apiName);
  const effectiveComponentId =
    firstNonEmpty(input.componentId) ??
    (classAlias !== undefined ? toApexClassId(classAlias) : undefined);
  const componentScopeResult = resolveComponentScope(effectiveComponentId);
  if (!componentScopeResult.ok) return componentScopeResult;
  const componentScope = componentScopeResult.value;
  if (componentScope !== null && objectScopeRequested) {
    return err({
      kind: 'invalid-query',
      message:
        'componentId and objectId/objectApiName are mutually exclusive scopes; pass one',
      path: 'componentId',
    });
  }

  // FIND-DEAD-CODE-ANSWERS-FOR-NONEXISTENT-OBJECT: resolve + VERIFY the object
  // scope against the vault.
  //
  // `resolveObjectScopeParentId` (still the right helper for tools that only
  // need the canonical spelling) is a pure STRING coercion:
  // `objectId ?? objectApiName` → `CustomObject:{name}`, no lookup. So a
  // mistyped object was accepted as a scope, the SQL below filtered on a
  // `parent_id` no node holds, and — together with the fields-only clause this
  // change also closes — the tool shipped org-wide Apex/Flow rows labelled
  // `mode: 'object'` for an object that does not exist. A wrong-CASE but real
  // object had the mirror-image failure: `CustomObject:pAyMeNt__C` matched no
  // parent, so a live object's fields silently vanished from a delete list.
  //
  // The shared resolver fixes both: vault casing for a real object, a named
  // `invalid-query` for one that is absent, and `ok(null)` for the bare
  // org-wide call, whose response stays byte-identical.
  const objectScopeResult = await resolveExistingObjectScope(ctx.graph, {
    objectId: input.objectId,
    objectApiName: input.objectApiName,
  });
  if (!objectScopeResult.ok) return err(objectScopeResult.error);
  const objectScopeParentId = objectScopeResult.value?.componentId;
  if (componentScope !== null) {
    const nodeRes = await getNodeById(ctx.graph, componentScope.id);
    if (!nodeRes.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodeRes.error.message}` });
    }
    if (nodeRes.value === null) {
      return err({
        kind: 'component-not-found',
        message: `no component matches \`${componentScope.id}\` in this vault`,
        path: componentScope.id,
      });
    }
  }

  // A scoped component surfaces its verdict regardless of the uncertain filter.
  const includeUncertain =
    componentScope !== null ? true : (input.includeUncertain ?? false);
  const types =
    componentScope !== null
      ? [componentScope.type]
      : input.types !== undefined && input.types.length > 0
        ? input.types
        : DEFAULT_TYPES;
  const appliedScope: FindDeadCodeOutput['appliedScope'] = {
    component: componentScope?.id ?? null,
    object: objectScopeParentId ?? null,
    mode:
      componentScope !== null
        ? 'component'
        : objectScopeParentId !== undefined
          ? 'object'
          : 'all',
  };

  const rowsResult = await fetchDeadCodeRows(
    ctx.graph,
    types,
    objectScopeParentId,
    componentScope?.id,
  );
  if (!rowsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${rowsResult.error}`,
    });
  }

  let candidates: DeadCodeCandidate[] = [];
  for (const row of rowsResult.value) {
    // Tests are NEVER flagged as dead.
    if (row.is_test) continue;
    // A CustomField used by a report column/filter or dashboard component is in
    // use, even with zero incoming edges — its usage is a folded node property,
    // not a graph edge (only present when refreshed with `--with-reports`).
    // Excluding it here matches `unused_fields_deep` / `safe_to_delete_field`.
    if (row.type === 'CustomField' && row.used_in_analytics) continue;

    const externalEntryPoint = row.is_own_entry_point;
    const asyncDispatchEntry = row.is_async_dispatch_entry;
    // `isOwnEntryPoint` on the candidate stays the broad "is it an entry point"
    // signal callers expect — external (REST/Aura/Invocable/trigger) OR async
    // dispatch (Queueable/Batchable/Schedulable). The dead-vs-live cascade below
    // treats the two kinds DIFFERENTLY (external = always live; async = live only
    // when production-dispatched), but the display flag does not need that split.
    const ownEntryPoint = externalEntryPoint || asyncDispatchEntry;
    // The SQL CTE COALESCEs both aggregates and the per-row entry-point
    // flag to FALSE so zero-row aggregations and missing-property nodes
    // both surface as actual booleans rather than nulls.
    const hasNonTestReach = row.has_non_test_reach;
    const hasEntryPointReach = row.has_entry_point_reach;
    const hasProductionDispatch = row.has_production_dispatch;
    // DuckDB returns COUNT as bigint; the v3.2 caller compares
    // against zero and surfaces the value as a number in the
    // candidate payload, so the cast is safe (no overflow risk for
    // in-degree counts).
    const incomingCount = Number(row.incoming_count);

    let verdict: DeadCodeVerdict;
    let reasoning: string;
    if (row.is_active_entry_point) {
      // R2-12: an active/Draft/unknown-status Flow is its OWN entry point — it
      // fires on its own trigger/schedule and has ~0 incoming edges by nature.
      // Treat exactly like an own-entry-point Apex class: `uncertain`,
      // suppressed unless includeUncertain. NEVER definitely_dead/likely_dead.
      // (Only Obsolete/InvalidDraft flows have is_active_entry_point=FALSE and
      // fall through to the incomingCount===0 => definitely_dead path.)
      verdict = 'uncertain';
      reasoning =
        'Flow fires on its own trigger and is active (or Draft/unknown status); not dead despite no incoming references';
    } else if (asyncDispatchEntry && !externalEntryPoint) {
      // ASYNC-DISPATCH CLASS (Queueable / Batchable / Schedulable) — ALWAYS
      // `uncertain`, never a confident dead verdict.
      //
      // The previous cascade sent these straight to definitely_dead /
      // likely_dead on the claim that such a class "must be enqueued /
      // executed / scheduled by user Apex". That claim is FALSE on the
      // platform. An admin scheduling a class through Setup > Schedule Apex
      // creates a `CronTrigger` record; CronTrigger is DATA, not metadata, so
      // it is never retrieved, never becomes a node, and mints no edge. The
      // same goes for `System.enqueueJob` / `Database.executeBatch` from
      // ANONYMOUS Apex. A metadata walk therefore CANNOT see the registration,
      // and its absence is the expected reading for a live scheduled job.
      // Measured org-wide: 16 of 18 `likely_dead` classes were exactly this.
      //
      // This is the same tier, and the same mechanism, as the other unproven
      // registrations (`is_unproven_registration` — which now covers these
      // three flags too, so the SQL and TS predicates stay pinned together).
      // What the vault CAN observe is kept, in `reasoning`.
      verdict = 'uncertain';
      if (hasProductionDispatch) {
        reasoning =
          'async-dispatch class (Queueable/Batchable/Schedulable) enqueued from at least one production (non-@isTest) dispatch site; live at runtime';
      } else if (hasEntryPointReach) {
        reasoning = 'async-dispatch class reached by a production entry-point caller';
      } else {
        const visible =
          incomingCount === 0
            ? 'No dispatch site of any kind is visible in this vault'
            : !hasNonTestReach
              ? 'The only dispatch sites visible in this vault are @isTest classes (test dispatch is rolled back at runtime)'
              : 'It has non-test inbound references but no recognized production dispatch site';
        reasoning =
          `async-dispatch class (Queueable/Batchable/Schedulable). ${visible} — which is NOT evidence of death: ` +
          'Setup > Schedule Apex registers a class as a `CronTrigger` RECORD (data, never metadata: never retrieved, ' +
          'mints no edge, and no refresh can close that gap), and enqueue/executeBatch also run from anonymous Apex. ' +
          'Not proven live either — check Setup > Scheduled Jobs / Apex Jobs before deleting.';
      }
    } else if (ownEntryPoint || hasEntryPointReach) {
      verdict = 'uncertain';
      reasoning = ownEntryPoint
        ? 'component is its own entry point (REST/Aura/Invocable or trigger); platform invokes it'
        : 'reached by an entry-point class (REST resource / AuraEnabled / InvocableMethod / async-dispatch)';
    } else if (row.is_unproven_registration) {
      // Must sit ABOVE the incomingCount === 0 branch. These classes have zero
      // incoming edges BY CONSTRUCTION — that is the whole point of dynamic
      // registration — so without this branch they fall straight into
      // `definitely_dead`, which is how two tools came to corroborate a wrong
      // answer. `uncertain` is the honest tier: it is suppressed unless
      // includeUncertain, so it does not add noise, and it never asserts the
      // class is live.
      verdict = 'uncertain';
      reasoning =
        'class is BUILT for dynamic registration — it extends a base class from another ' +
        'namespace (a managed package or platform framework instantiates its own subclasses), ' +
        'implements an interface qualified by another namespace (e.g. an AuthProvider\'s ' +
        'Auth.RegistrationHandler), or declares the Callable dynamic-invocation interface. The ' +
        'registration itself lives in a string literal, a Custom Metadata record, or ' +
        'managed-package code and mints no edge, so zero incoming edges is EXPECTED here and is ' +
        'not evidence of death. Not proven live either — confirm the registration in the org ' +
        'before deleting.';
    } else if (incomingCount === 0) {
      verdict = 'definitely_dead';
      reasoning =
        'no incoming non-parentOf edges; no callers, no triggers, no listeners visible to the graph';
    } else if (!hasNonTestReach) {
      verdict = 'likely_dead';
      reasoning =
        'incoming edges only from test classes (isTest === true); not used in production paths visible to the graph';
    } else {
      verdict = 'uncertain';
      reasoning =
        'reached by non-test components but no recognized entry point';
    }

    // NO SUPPRESSION HERE. `candidates` is the FULL candidate set — the set
    // `byVerdict` / `byType` are documented to tally. The `includeUncertain`
    // filter is applied ONCE, further down, to the LISTED slice only. Filtering
    // here is what made the default response report `uncertain: 0` while
    // withholding 91 uncertain rows: an UNCHECKED zero in the one bucket a
    // reader consults to decide whether the tool looked.
    candidates.push({
      componentId: row.id as ComponentId,
      componentType: row.type as ComponentType,
      apiName: row.api_name,
      verdict,
      incomingEdgeCount: incomingCount,
      reachedByTestClassOnly: incomingCount > 0 && !hasNonTestReach,
      isOwnEntryPoint: ownEntryPoint,
      reasoning,
      confidence: 'heuristic',
    });
  }

  // ---- STATIC-TYPE-USAGE re-check (definitely_dead ApexClass only) --------
  // A class used ONLY via a static-field or type-name reference
  // (`Other.CONST`, `List<Other>`, `JSON.deserialize(.., List<Other>.class)`)
  // never becomes an inbound `callsApex` / `references` graph edge, so the CTE
  // sees zero in-degree and wrongly calls it definitely_dead. Grep the vault
  // Apex source for a whole-word reference from a NON-TEST, non-self file; if
  // one exists the class is live-at-compile-time — downgrade to `uncertain`
  // (suppressed unless includeUncertain) and disclose. Scoped to
  // definitely_dead ApexClass candidates so live/entry-point classes and the
  // (already-hedged) likely_dead set cost nothing.
  let staticUsageDowngrades = 0;
  const deadApexClasses = candidates.filter(
    (c) =>
      c.componentType === 'ApexClass' && c.verdict === 'definitely_dead',
  );
  if (deadApexClasses.length > 0) {
    const testClassApiNames = await fetchTestClassApiNames(ctx.graph);
    const staticallyUsed = new Set<ComponentId>();
    for (const candidate of deadApexClasses) {
      const selfLower = candidate.apiName.toLowerCase();
      // limit:1 — existence is all that matters. The pathFilter drops the
      // class's own file (a class references its own name) and every test
      // file, so any surviving match is a production static reference.
      const grep = await grepVaultSource(ctx, {
        query: `\\b${escapeForRegex(candidate.apiName)}\\b`,
        regex: true,
        limit: 1,
        suffixes: ['.cls', '.trigger'],
        pathFilter: (vaultRelativePath) => {
          const refName = sourceFileApiName(vaultRelativePath).toLowerCase();
          if (refName === selfLower) return false; // self-reference
          if (testClassApiNames.has(refName)) return false; // test class
          return true;
        },
      });
      if (grep.ok && grep.value.matches.length > 0) {
        staticallyUsed.add(candidate.componentId);
      }
    }
    if (staticallyUsed.size > 0) {
      candidates = candidates.map((c) =>
        staticallyUsed.has(c.componentId)
          ? {
              ...c,
              verdict: 'uncertain' as const,
              reasoning:
                'referenced by non-test production Apex via a static-field or type-name usage ' +
                '(`Other.CONST`, `List<Other>`, `JSON.deserialize(.., List<Other>.class)`) that the ' +
                'parser does not model as an inbound edge; not dead — delete the referencing code first',
            }
          : c,
      );
      staticUsageDowngrades = staticallyUsed.size;
      // The downgrade to `uncertain` is all that is needed: the ONE
      // `includeUncertain` filter below removes it from the listing, and the
      // tallies keep counting it. Filtering it out a second time here is what
      // made a statically-used class vanish from `byVerdict` as well as from
      // the list.
    }
  }

  // ---- ACTIVITY-POLYMORPHIC re-check (definitely_dead CustomField only) --
  //
  // See {@link ACTIVITY_POLYMORPHIC_DISCLOSURE} for the full rationale. In
  // short: a shared Activity custom field can be materialized as up to three
  // graph nodes (CustomField:Activity/Task/Event.<field>) that are ONE
  // physical field, and `safe_to_delete_field` already discloses this
  // ("Polymorphic Activity attribution") — this tool had zero awareness of
  // it. The import-time mirror (`mintPolymorphicActivityFieldEdges`) is
  // SUPPOSED to copy a real edge onto every existing sibling representation,
  // but that mirror can be missing (a vault refreshed before it existed, or
  // under-mounted on the incremental apply-change-set path) or structurally
  // incomplete (it only ever covers readsFrom/writesTo/references — a Layout
  // placement never propagates). So rather than trust the precomputed
  // `incoming` join alone, a `definitely_dead` CustomField candidate in this
  // family is re-checked directly against its siblings' OWN incoming edges
  // before the verdict is certified. Scoped to `definitely_dead` CustomField
  // candidates whose object is Activity/Task/Event — a small slice of any
  // vault's fields — so every other candidate costs nothing.
  let activityPolymorphicDowngrades = 0;
  const deadActivityFields = candidates.filter(
    (c) =>
      c.componentType === 'CustomField' &&
      c.verdict === 'definitely_dead' &&
      isActivityPolymorphicFieldId(c.componentId),
  );
  if (deadActivityFields.length > 0) {
    const liveViaSibling = new Set<ComponentId>();
    for (const candidate of deadActivityFields) {
      if (await hasLiveSiblingRepresentation(ctx.graph, candidate.componentId)) {
        liveViaSibling.add(candidate.componentId);
      }
    }
    if (liveViaSibling.size > 0) {
      candidates = candidates.map((c) =>
        liveViaSibling.has(c.componentId)
          ? {
              ...c,
              verdict: 'uncertain' as const,
              reasoning:
                'shares this Activity/Task/Event custom field with another EXISTING representation ' +
                '(CustomField:Activity/Task/Event.<field> can be up to three graph nodes for ONE ' +
                'physical field) that has a real incoming usage edge this candidate does not — not ' +
                'dead; the import-time polymorphic mirror either has not run on this vault or does ' +
                'not cover the referring edge type, so this is a live, query-time cross-check rather ' +
                'than a re-assertion of an already-mirrored edge. Confirm with sfi.safe_to_delete_field ' +
                'before deleting.',
            }
          : c,
      );
      activityPolymorphicDowngrades = liveViaSibling.size;
      // Same reasoning as the static-usage downgrade above: the verdict flip
      // to `uncertain` is sufficient — `includeUncertain` and the tallies
      // below both key off `candidates`, not off a second suppression list.
    }
  }

  candidates.sort(compareCandidates);

  // ---- TALLY THE FULL SET, THEN FILTER THE LISTING -----------------------
  // `byVerdict` / `byType` describe every candidate the scan classified,
  // whether or not it is listed. `listed` is what pagination walks.
  const byVerdict = {
    definitely_dead: 0,
    likely_dead: 0,
    uncertain: 0,
  };
  const byType: Record<string, number> = {};
  for (const c of candidates) {
    byVerdict[c.verdict] += 1;
    byType[c.componentType] = (byType[c.componentType] ?? 0) + 1;
  }
  const listed = includeUncertain
    ? candidates
    : candidates.filter((c) => c.verdict !== 'uncertain');
  const uncertainWithheld = candidates.length - listed.length;
  const suppressed: FindDeadCodeOutput['suppressed'] = {
    includeUncertain,
    uncertainWithheld,
    note: includeUncertain
      ? '`includeUncertain` is true, so nothing was withheld: `candidates`, `totalCount`, `byVerdict` and `byType` all describe the same full candidate set.'
      : uncertainWithheld > 0
        ? `\`byVerdict\` and \`byType\` tally the FULL candidate set; \`candidates\` and \`totalCount\` do NOT. ${uncertainWithheld} \`uncertain\` row(s) were classified and then withheld from the listing because \`includeUncertain\` is false. Re-run with \`includeUncertain: true\` to read them — they are the rows whose emptiness is expected rather than damning (dynamic registration, async dispatch, active Flows, static-type usage), so a short list here is not a clean bill of health.`
        : '`includeUncertain` is false, but the scan classified no `uncertain` candidates, so nothing was withheld — `uncertain: 0` here is a CHECKED zero, not a hidden bucket.',
  };

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers every NARROWING arg — includeUncertain (it filters
  // which candidates are in the list, line below `verdict === 'uncertain'`), the
  // canonical objectId scope, and types — so a token minted for one narrowing
  // set can't be replayed against another.
  const fingerprint = argsFingerprint({
    ...(componentScope !== null ? { componentId: componentScope.id } : {}),
    ...(objectScopeParentId !== undefined
      ? { objectId: objectScopeParentId }
      : {}),
    types,
    includeUncertain,
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: FIND_DEAD_CODE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(listed, {
    offset,
    limit,
    keyOf: (c) => c.componentId,
    binding: {
      tool: FIND_DEAD_CODE_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const slice = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  // Paged when truncated OR resumed past 0; only then do we add paging fields,
  // so a whole-fits no-cursor response stays byte-identical to pre-CR-22.
  const isPaged = truncated || offset > 0;

  const boundaries: string[] = [DEAD_CODE_DISCLOSURE];
  // FIND-DEAD-CODE-OBJECT-SCOPE-APPLIED-TO-FIELDS-ONLY: the object scope now
  // narrows EVERY type, so the families it cannot reach must SAY they were not
  // reached — otherwise the narrowing would trade one silent zero (org-wide
  // rows under a scoped heading) for another (no Apex rows, unexplained).
  // Scoped calls only; a bare call's boundary list is untouched.
  if (objectScopeParentId !== undefined) {
    const unreachable = types.filter((t) => !OBJECT_PARENTED_TYPES.has(t));
    if (unreachable.length > 0) {
      boundaries.push(
        objectScopeNarrowingDisclosure(objectScopeParentId, unreachable),
      );
    }
  }
  // R2-12: whenever Flow is in scope, disclose the status-gated Flow rule
  // (active/Draft/unknown flows are never definitely_dead) and the unmodeled
  // subflow-invocation caveat — surfaced regardless of whether any flow landed
  // in the (suppressed) result set, so the honesty is never silently dropped.
  if (types.includes('Flow' as ComponentType)) {
    boundaries.push(FLOW_DISCLOSURE);
  }
  if (candidates.length > 0) {
    boundaries.push(TEST_DISCLOSURE);
    boundaries.push(MANAGED_PACKAGE_DISCLOSURE);
  }
  // When any async-dispatch class (Queueable/Batchable/Schedulable) lands in the
  // result set — at any verdict — disclose the production-dispatch rule and the
  // !Test.isRunningTest() nuance so a "dead queueable" claim is never silent.
  if (
    candidates.some(
      (c) =>
        c.componentType === 'ApexClass' &&
        c.reasoning.startsWith('async-dispatch class'),
    )
  ) {
    boundaries.push(ASYNC_DISPATCH_DISCLOSURE);
  }
  // Disclose the static-type-usage re-check whenever it downgraded a class OR a
  // definitely_dead ApexClass survived it — so a surviving verdict is understood
  // to have passed the grep, and any suppression is transparent.
  if (
    staticUsageDowngrades > 0 ||
    candidates.some(
      (c) =>
        c.componentType === 'ApexClass' && c.verdict === 'definitely_dead',
    )
  ) {
    boundaries.push(STATIC_TYPE_USAGE_DISCLOSURE);
  }
  // UNCONDITIONAL whenever ApexClass is in scope (D-3): this describes what the
  // scanner cannot see, which is true whether or not anything matched. A clean
  // ApexClass sweep is exactly the answer a dynamically-registered class
  // produces, so it is the response that most needs to say so.
  if (types.includes('ApexClass')) {
    boundaries.push(UNPROVEN_REGISTRATION_VERDICT_DISCLOSURE);
  }
  // A CustomField flagged dead is the weakest verdict: Apex/Flow/SOQL field
  // reads are not graph edges, so an in-use field can surface as dead.
  if (
    candidates.some(
      (c) =>
        c.componentType === 'CustomField' &&
        (c.verdict === 'definitely_dead' || c.verdict === 'likely_dead'),
    )
  ) {
    boundaries.push(CUSTOM_FIELD_DISCLOSURE);
    boundaries.push(REPORT_DASHBOARD_USAGE_CAVEAT);
  }
  // Disclose the Activity-polymorphic re-check whenever it downgraded a
  // candidate OR a definitely_dead Activity/Task/Event-family CustomField
  // survived it — so a surviving verdict is understood to have passed the
  // sibling cross-check, and any suppression is transparent (same posture as
  // the static-type-usage disclosure above).
  if (
    activityPolymorphicDowngrades > 0 ||
    candidates.some(
      (c) =>
        c.componentType === 'CustomField' &&
        c.verdict === 'definitely_dead' &&
        isActivityPolymorphicFieldId(c.componentId),
    )
  ) {
    boundaries.push(ACTIVITY_POLYMORPHIC_DISCLOSURE);
  }

  // DEAD-CODE-SOUNDNESS-CERTIFIED-THE-RENDERED-PAGE.
  //
  // This envelope used to be `soundnessFromIds(ctx.graph, listed.map(...))` —
  // `listed` is the POST-suppression listing. The default `includeUncertain:
  // false` withholds precisely the rows that carry the blind-spot signal, so a
  // call whose page was entirely suppressed certified `complete: true` /
  // `staticCoverage: 'full'` over an EMPTY id set, while the identical query one
  // display flag away returned `complete: false` with the blind spots named.
  // `byVerdict` and `byType` were byte-identical across that flip: the analyzed
  // corpus never changed, only the certificate. A certificate that moves with a
  // display option is not a certificate.
  //
  // The corpus is now the APEX REFERRER SURFACE, not the page and not merely the
  // candidate set. "X is dead" is an absence claim about CALLERS; every
  // ApexClass / ApexTrigger is a potential caller whose runtime references the
  // edge walk cannot see. That set is a SUPERSET of the Apex candidates, so it
  // still downgrades the envelope when a candidate class uses dynamic Apex, and
  // it also covers the case the old read missed entirely: a CustomField-only
  // scan, where no Apex row is a candidate at all and every Apex node is
  // nonetheless an invisible potential referrer of the field being called dead.
  const apexReferrerScan = await scanAllNodesOfTypes(ctx.graph, APEX_REFERRER_TYPES);
  let qualityScanCoverage: readonly QualityScanTypeCoverage[] | undefined;
  let soundness: Soundness;
  if (!apexReferrerScan.ok) {
    // Fail CLOSED. An unreadable referrer surface is an UNKNOWN one; certifying
    // completeness over a corpus we could not open is the defect itself.
    soundness = {
      complete: false,
      blindSpots: [
        {
          kind: 'quality-scan-not-run',
          componentIds: [],
          note: REFERRER_CENSUS_UNREADABLE_NOTE,
        },
      ],
      staticCoverage: 'partial',
    };
    boundaries.push(REFERRER_CENSUS_UNREADABLE_DISCLOSURE);
  } else {
    qualityScanCoverage = censusQualityScanCoverage(apexReferrerScan.value.nodes);
    soundness = soundnessFromNodes(apexReferrerScan.value.nodes);
    const unscannedNote = buildUnscannedNodesNote(qualityScanCoverage);
    if (unscannedNote !== undefined) {
      boundaries.push(unscannedNote);
      boundaries.push(UNSCANNED_REFERRER_DISCLOSURE);
    }
    if (apexReferrerScan.value.scanIncomplete) {
      boundaries.push(REFERRER_SCAN_INCOMPLETE_DISCLOSURE);
    }
  }

  // Dead-code is an absence claim about CALLERS: incomplete coverage of any
  // calling surface (errored retrieve, scoped refresh, mid-staged-build
  // pending tiers) must qualify the verdicts.
  const coverageCaveat = buildCoverageCaveat(
    ctx,
    DEAD_CODE_REQUIRED_COVERAGE,
    'Dead-code status',
  );

  return ok({
    data: {
      appliedScope,
      candidates: slice,
      totalCount: listed.length,
      byVerdict,
      byType,
      suppressed,
      boundaries,
      truncated,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + slice.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
      ...(qualityScanCoverage !== undefined ? { qualityScanCoverage } : {}),
      soundness,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
