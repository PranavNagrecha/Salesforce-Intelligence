/**
 * Handler for the `sfi.governor_limit_risks` MCP tool.
 *
 * The v2.1 Apex-specific narrowing for governor-limit-relevant
 * patterns — the "performance / scale" subset of the v2.1 quality
 * recognizer catalog. Composes over the `properties.qualityIssues[]`
 * arrays the v2.1 `code-quality-patterns` recognizer family populates
 * for every ApexClass / ApexTrigger node at extraction time; filters
 * those findings down to the three rules in the governor-limit
 * subset, groups them by class, and (when the parent class is the
 * target of an incoming `callsApex` edge from an ApexTrigger) surfaces
 * the trigger as additional context.
 *
 * **Governor-limit rule subset** — the three rules below are the
 * governor-limit-relevant slice of the recognizer catalog in
 * `packages/patterns/src/code-quality-patterns.ts`:
 *   - `soql-in-loop` — SOQL inside a loop body. Risks the
 *     100-SOQL-per-transaction governor limit.
 *   - `dml-in-loop` — DML inside a loop body. Risks the
 *     150-DML-per-transaction governor limit.
 *   - `database-upsert-no-options` — `Database.upsert(...)` called
 *     without options. Risks partial-failure silent-success.
 *
 * **Trigger-context surface** — when an ApexClass with one of the
 * three rules above is the target of an incoming `callsApex` edge
 * from an `ApexTrigger:*` node, the response carries that trigger
 * as `triggerContext`: the class's findings should be treated as
 * even higher priority because the trigger's per-DML invocation
 * multiplies the limit risk. Multiple trigger callers surface as a
 * sorted-ASC list; classes with no trigger caller surface
 * `triggerContext: []`.
 *
 * **Honesty axis** (mirroring v2.1 R3 §4 disclosures):
 *   - Pattern recognition is heuristic — every finding carries
 *     `confidence: 'heuristic'`. Static SOQL/DML inside a static
 *     method called from a loop is invisible to the scanner;
 *     reflective access (`Database.query('SELECT ...')`) is stripped
 *     before pattern passes. The `boundaries` array makes this
 *     verbatim.
 *   - Trigger context is heuristic-confidence — the `callsApex` edge
 *     itself can be `parsed` (declared by Flow / LWC `apex:` imports)
 *     or `heuristic` (apex-scanner inference). The tool does not
 *     surface the per-edge confidence on the trigger-context list;
 *     callers wanting that detail should use `sfi.find_code_usages`.
 *   - D-3: the two disclosures above are UNCONDITIONAL. A zero-finding
 *     response is the false-clean shape, so it is the one that most
 *     needs to say how the scanner works — gating them on
 *     `classes.length > 0` silenced them exactly there.
 *   - D-3 on the LIMIT axis: this tool is NAMED for governor limits and
 *     models three static loop recognizers. `limitCoverage` names the
 *     three it checks and the seven it never examines (heap size, Apex
 *     CPU time, callouts, query rows, DML rows, future / queueable
 *     invocations, email invocations), so `totalRiskCount: 0` is
 *     readable as CHECKED for the three and UNCHECKED for the rest. It
 *     rides on every response, single-class scope included; the prose
 *     note is org-wide only. Runtime limits are closed by
 *     `sfi.explain_debug_log`, not by any refresh.
 *   - `qualityScanCoverage` rides on every response too, so
 *     `classes: []` reads as "N nodes were read and scanned, none
 *     matched" rather than as an unfalsifiable clean bill.
 *   - CR-22-B6: `entryPaths` is bounded (depth `ENTRY_PATH_MAX_DEPTH`=6,
 *     `ENTRY_PATH_MAX_PATHS`=12 paths) — previously JSDoc-only. A class
 *     entry now carries `entryPathsTruncated: true` (present only when
 *     true) when its real fan-in of callers exceeds what the walk
 *     explored, and the response `boundaries` gets a matching
 *     "showing... N" disclosure whenever ANY class in the (full,
 *     pre-page) result hit the cap.
 *
 * Implementation notes:
 *   - Walks both `ApexClass` and `ApexTrigger` ComponentTypes; the
 *     `database-upsert-no-options` rule fires on either, while the
 *     two `-in-loop` rules fire on both class bodies and trigger
 *     bodies.
 *   - `limit` defaults to 100 and is capped at 500 by Zod. The slice
 *     is over CLASSES, not individual findings, so a class with 7
 *     SOQL-in-loop findings counts as 1 entry in the limit budget.
 *   - The response is sorted by class id ASC inside each ApexClass /
 *     ApexTrigger grouping; per-finding ordering inside a class
 *     follows the recognizer's source-position sort.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { partitionByBaseline } from './finding-suppression.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import {
  buildNotCheckedLimitsNote,
  buildUnscannedNodesNote,
  censusQualityScanCoverage,
  NOT_CHECKED_GOVERNOR_LIMITS,
  type NotCheckedLimit,
  type QualityScanTypeCoverage,
} from './quality-scan-coverage.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';
import { soundnessFromDynamicApexIds, type Soundness } from './soundness.js';

const GOVERNOR_LIMIT_TOOL = 'sfi.governor_limit_risks';

/** Inclusive upper bound on `limit`. */
const GOVERNOR_LIMIT_MAX_LIMIT = 500;
/** Default `limit`. */
const GOVERNOR_LIMIT_DEFAULT_LIMIT = 100;

/**
 * The three rule ids in the v2.1 governor-limit subset. A hard
 * mapping inside the tool; the broader catalog access is via
 * `sfi.code_quality_audit`.
 */
const GOVERNOR_LIMIT_RULES: ReadonlySet<string> = new Set([
  'soql-in-loop',
  'dml-in-loop',
  'database-upsert-no-options',
]);

/** ComponentTypes the governor-limit subset can fire on. */
const SCANNED_TYPES: readonly ComponentType[] = [
  'ApexClass',
  'ApexTrigger',
];

/** The five-tier severity scale used by the v2.1 catalog. */
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

const SEVERITY_SET: ReadonlySet<string> = new Set([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

/** Verbatim governor-limit boundary disclosure. */
const GOVERNOR_LIMIT_HEURISTIC_DISCLOSURE =
  'pattern recognition is heuristic — every finding carries confidence: heuristic. Static SOQL / DML inside a static method called from a loop is invisible to the scanner; dynamic SOQL strings (Database.query(...)) are stripped before pattern passes.';
const GOVERNOR_LIMIT_TRIGGER_CONTEXT_DISCLOSURE =
  'trigger-context callers are listed when the class is the target of an incoming callsApex edge from an ApexTrigger. The per-edge confidence is NOT surfaced in this tool; use sfi.find_code_usages for the per-edge detail.';

/**
 * Zod schema for the `sfi.governor_limit_risks` tool input.
 *
 *   - `componentId` (`ApexClass:{name}` / `ApexTrigger:{name}`) / `classApiName`
 *     / `apiName`: optional CLASS SCOPE. When supplied the audit returns ONLY
 *     that class's governor-limit findings (+ `appliedScope`); an unresolved id
 *     is `component-not-found` and a non-Apex type prefix is `invalid-query` —
 *     never a silent org-wide fallback. Omit all three for the org-wide audit.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100 inside
 *     the handler. The slice is over classes, not individual findings.
 */
export const governorLimitRisksInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  classApiName: z.string().min(1).optional(),
  apiName: z.string().min(1).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(GOVERNOR_LIMIT_MAX_LIMIT)
    .optional(),
  // CR-22: class-level page cursor for walking the full audit when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type GovernorLimitRisksInput = z.infer<
  typeof governorLimitRisksInputSchema
>;

/** One finding inside a per-class entry. */
export interface GovernorLimitRiskFinding {
  readonly rule: string;
  readonly severity: Severity;
  readonly location: string;
  readonly explanation: string;
}

/** One per-class entry. */
export interface GovernorLimitRisksClassEntry {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly risks: readonly GovernorLimitRiskFinding[];
  /**
   * ApexTriggers whose `callsApex` edge targets this class. Empty
   * array when no trigger caller exists. Sorted by id ASC.
   */
  readonly triggerContext: readonly ComponentId[];
  /**
   * P4-graph-sast: the entry-point PATHS that reach this risky class, each an
   * ordered `[entryPoint, ..., thisClass]` list walked backwards over incoming
   * `callsApex` edges to an ApexTrigger / Flow entry point (or the top of the
   * Apex chain). So a governor-limit finding cites WHERE it runs from — e.g.
   * `[ApexTrigger:AccountTrigger, ApexClass:AccountHandler, thisClass]` — not
   * just the class in isolation. Bounded (depth 6, 12 paths); cycle-safe.
   */
  readonly entryPaths: readonly (readonly ComponentId[])[];
  /**
   * CR-22-B6: TRUE when the bounded walk (depth `ENTRY_PATH_MAX_DEPTH`=6,
   * `ENTRY_PATH_MAX_PATHS`=12) found MORE entry-point paths than it explored —
   * the cap was previously JSDoc-only (see `entryPaths` above), so a class
   * with a wide fan-in of callers silently read as if `entryPaths` were the
   * complete inventory. Present ONLY when true, so a class with genuinely
   * ≤12 real entry paths keeps its pre-existing shape.
   */
  readonly entryPathsTruncated?: boolean;
}

/** Output payload. */
export interface GovernorLimitRisksOutput {
  /**
   * Echoes the scope ACTUALLY applied so a host never assumes a class selector
   * it passed was silently stripped (the always-org-wide bug this closes).
   * `component` is the resolved `ApexClass:`/`ApexTrigger:` id in class scope,
   * null org-wide; `mode` names the axis in force.
   */
  readonly appliedScope: {
    readonly component: string | null;
    readonly mode: 'all' | 'component';
  };
  readonly classes: readonly GovernorLimitRisksClassEntry[];
  /** Per-class entry count BEFORE the `limit` slice. */
  readonly totalClassCount: number;
  /** Total findings across all classes (FULL, pre-slice). */
  readonly totalRiskCount: number;
  /** Risks acknowledged in org-kb/meta/baseline.json (excluded from classes). */
  readonly suppressedRiskCount: number;
  /** Per-rule counter across the FULL matched set. */
  readonly byRule: Readonly<Record<string, number>>;
  /**
   * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. Per-type count of nodes read vs
   * nodes that actually carry a `qualityIssues` scan.
   *
   * D-3: emitted UNCONDITIONALLY. It used to appear only when some node in
   * scope was never scanned, which left the clean case — `classes: []` with no
   * census — indistinguishable from a scope nobody read. `ApexClass 1/1` is
   * exactly the sentence a zero-finding answer needs: it converts "no findings"
   * from unfalsifiable into "1 class was read and scanned, and none matched".
   */
  readonly qualityScanCoverage: readonly QualityScanTypeCoverage[];
  /**
   * D-3 on the LIMIT axis. This tool is named for governor LIMITS and models
   * exactly three static loop recognizers; every other governor limit is never
   * examined. `checkedRules` names what a zero DOES cover, `notChecked` names
   * what it does not. Emitted unconditionally — including on a single-class
   * scope, because the unexamined limits are just as unexamined for one class
   * as for the org.
   */
  readonly limitCoverage: {
    readonly checkedRules: readonly string[];
    readonly notChecked: readonly NotCheckedLimit[];
  };
  /**
   * Verbatim honesty disclosures. Never empty: the two scanner-behaviour
   * disclosures describe HOW this tool reads source and are true whether or not
   * anything matched, so they live OUTSIDE the zero-findings gate.
   */
  readonly boundaries: readonly string[];
  /** True when the class-level slice was trimmed to `limit`. */
  readonly truncated: boolean;
  /** Static-analysis blind spots: `complete: false` when a scanned class uses dynamic Apex. */
  readonly soundness: Soundness;
  /**
   * Page size applied. Present only on a PAGED response (`truncated` or a
   * resumed `offset > 0`); omitted on a whole-fits no-cursor call so that
   * response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned class. Present only when paged. */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when `truncated`. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated.
   * Echo it back as `cursor` to resume. Absent on a complete page.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

const GOVERNOR_LIMIT_TOOL_NAME = 'sfi.governor_limit_risks';

const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/**
 * Resolve the optional CLASS SCOPE from `componentId` / `classApiName` /
 * `apiName` (precedence in that order). `componentId` may be an
 * `ApexClass:`/`ApexTrigger:` id; bare `classApiName`/`apiName` coerce to
 * `ApexClass:{name}`. A value carrying a non-Apex type prefix is `invalid-query`.
 * `undefined` (no selector) → org-wide (returns `null`).
 */
const resolveScopeId = (
  input: GovernorLimitRisksInput,
): Result<ComponentId | null, McpError> => {
  const raw = input.componentId ?? input.classApiName ?? input.apiName;
  if (raw === undefined) return ok(null);
  if (raw.startsWith(APEX_CLASS_PREFIX) || raw.startsWith(APEX_TRIGGER_PREFIX)) {
    return ok(raw as ComponentId);
  }
  if (raw.includes(':')) {
    return err({
      kind: 'invalid-query',
      message: `'${raw}' is not an ApexClass / ApexTrigger — pass a bare class api name or an 'ApexClass:{name}' / 'ApexTrigger:{name}' id`,
      path: 'componentId',
    });
  }
  return ok(`${APEX_CLASS_PREFIX}${raw}` as ComponentId);
};

interface QualityIssueLike {
  readonly rule: string;
  readonly severity: Severity;
  readonly location: string;
  readonly explanation: string;
}

const coerceIssue = (raw: unknown): QualityIssueLike | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rule = obj['rule'];
  const severity = obj['severity'];
  const location = obj['location'];
  const explanation = obj['explanation'];
  if (
    typeof rule !== 'string' ||
    typeof severity !== 'string' ||
    typeof location !== 'string' ||
    typeof explanation !== 'string'
  ) {
    return null;
  }
  if (!SEVERITY_SET.has(severity)) return null;
  return {
    rule,
    severity: severity as Severity,
    location,
    explanation,
  };
};

/** Comparator for the per-class slice: id ASC. */
const compareClassById = (
  a: GovernorLimitRisksClassEntry,
  b: GovernorLimitRisksClassEntry,
): number => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0);

/**
 * Collect the ApexTrigger ids whose outgoing `callsApex` edges target
 * the given class id. Returns an empty array when the class has no
 * incoming `callsApex` from a trigger.
 */
const collectTriggerCallers = async (
  ctx: Context,
  classId: ComponentId,
): Promise<Result<readonly ComponentId[], string>> => {
  const r = await listEdges(ctx.graph, classId, {
    direction: 'in',
    edgeType: 'callsApex',
  });
  if (!r.ok) return err(r.error.message);
  const callers: ComponentId[] = [];
  for (const edge of r.value as readonly Edge[]) {
    if (edge.fromId.startsWith('ApexTrigger:')) callers.push(edge.fromId);
  }
  return ok([...callers].sort());
};

/** Bounds for the P4-graph-sast entry-path walk. */
const ENTRY_PATH_MAX_DEPTH = 6;
const ENTRY_PATH_MAX_PATHS = 12;

/** {@link collectEntryPaths}'s result: the bounded path list plus whether the cap cut the search short. */
interface EntryPathsResult {
  readonly paths: readonly (readonly ComponentId[])[];
  /**
   * CR-22-B6: true when the walk hit `ENTRY_PATH_MAX_PATHS` (or `errored`)
   * BEFORE genuinely exhausting every caller — i.e. more real entry-point
   * paths exist than were explored. The walk's own early-exit guards cap
   * `paths` DURING collection, so a plain post-hoc `out.length > cap` check
   * can never fire (out.length is already ≤ cap by construction) — this
   * flag is set at the exact two call sites where the cap causes real work
   * to be skipped, which is the only honest signal.
   */
  readonly truncated: boolean;
}

/**
 * Walk backwards over incoming `callsApex` edges from `classId` to collect the
 * entry-point PATHS that reach it (P4-graph-sast). Each path is ordered
 * `[entryPoint, ..., classId]`. A path terminates at an ApexTrigger / Flow
 * (recognised entry points) or at the top of the Apex chain (a class with no
 * caller — itself a potential entry point such as a REST / Batchable class).
 * Bounded by depth and path count; the `trail` membership test makes it
 * cycle-safe.
 */
const collectEntryPaths = async (
  ctx: Context,
  classId: ComponentId,
): Promise<Result<EntryPathsResult, string>> => {
  const paths: ComponentId[][] = [];
  let errored: string | null = null;
  // CR-22-B6: set at the two spots where the ENTRY_PATH_MAX_PATHS cap
  // actually skips unexplored work — the only reliable "more paths exist"
  // signal (see EntryPathsResult).
  let hitCap = false;

  // `trail` is class-first: [classId, caller, callerOfCaller, ...].
  const walk = async (
    node: ComponentId,
    trail: readonly ComponentId[],
  ): Promise<void> => {
    if (errored !== null) return;
    if (paths.length >= ENTRY_PATH_MAX_PATHS) {
      hitCap = true;
      return;
    }
    if (trail.length >= ENTRY_PATH_MAX_DEPTH) {
      paths.push([...trail].reverse());
      return;
    }
    const r = await listEdges(ctx.graph, node, {
      direction: 'in',
      edgeType: 'callsApex',
    });
    if (!r.ok) {
      errored = r.error.message;
      return;
    }
    const callers = [
      ...new Set(
        (r.value as readonly Edge[])
          .map((e) => e.fromId)
          .filter((id) => !trail.includes(id)),
      ),
    ].sort();
    if (callers.length === 0) {
      // Top of the chain — `node` is itself the entry point.
      paths.push([...trail].reverse());
      return;
    }
    for (const from of callers) {
      if (paths.length >= ENTRY_PATH_MAX_PATHS) {
        hitCap = true;
        break;
      }
      if (from.startsWith('ApexTrigger:') || from.startsWith('Flow:')) {
        paths.push([...trail, from].reverse());
      } else {
        await walk(from, [...trail, from]);
      }
    }
  };

  await walk(classId, [classId]);
  if (errored !== null) return err(errored);
  const seen = new Set<string>();
  const out: ComponentId[][] = [];
  for (const p of paths) {
    const k = p.join('>');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  out.sort((a, b) => (a.join('>') < b.join('>') ? -1 : 1));
  return ok({ paths: out.slice(0, ENTRY_PATH_MAX_PATHS), truncated: hitCap });
};

/**
 * The `sfi.governor_limit_risks` MCP tool. Composes over the v2.1
 * `qualityIssues` property mirror for ApexClass / ApexTrigger nodes
 * and narrows to the three governor-limit-relevant rules. See the
 * module JSDoc for the rule subset, the trigger-context surface, and
 * the honesty boundaries.
 *
 * @example
 *   const r = await governorLimitRisksHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.totalRiskCount);
 */
export const governorLimitRisksHandler = async (
  ctx: Context,
  input: GovernorLimitRisksInput,
): Promise<Result<McpResponse<GovernorLimitRisksOutput>, McpError>> => {
  const limit = input.limit ?? GOVERNOR_LIMIT_DEFAULT_LIMIT;

  // Optional CLASS SCOPE. When supplied, audit ONLY that class (skip the org
  // scan); an unresolved id is `component-not-found`, a non-Apex type prefix is
  // `invalid-query` — never a silent org-wide fallback.
  const scopeResult = resolveScopeId(input);
  if (!scopeResult.ok) return scopeResult;
  const scopeId = scopeResult.value;

  const perClass = new Map<ComponentId, GovernorLimitRisksClassEntry>();
  const byRule: Record<string, number> = {};
  // Classes whose governor-risk scan is undermined by dynamic Apex (a SOQL/DML
  // hidden inside a Database.query string is invisible to the static recognizer).
  const dynamicApexIds = new Set<ComponentId>();
  let totalRiskCount = 0;
  let suppressedRiskCount = 0;

  // Class-scope: fetch just the one node; org-wide: scan EVERY ApexClass /
  // ApexTrigger (CR-22 B3 — page the SQL OFFSET forward so risky classes on node
  // 501+ are reachable). The output `classes` is the COMPLETE matched list, paged
  // on the output axis below.
  let nodesToProcess: readonly Node[];
  let scanIncomplete = false;
  let incompleteTypes: readonly string[] = [];
  if (scopeId !== null) {
    const nodeRes = await getNodeById(ctx.graph, scopeId);
    if (!nodeRes.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodeRes.error.message}` });
    }
    if (nodeRes.value === null) {
      return err({
        kind: 'component-not-found',
        message: `no ApexClass / ApexTrigger matches \`${scopeId}\` in this vault`,
        path: scopeId,
      });
    }
    if (!SCANNED_TYPES.includes(nodeRes.value.type)) {
      return err({
        kind: 'invalid-query',
        message: `\`${scopeId}\` is a ${nodeRes.value.type}, not an ApexClass / ApexTrigger — governor-limit risks are Apex-only`,
        path: 'componentId',
      });
    }
    nodesToProcess = [nodeRes.value];
  } else {
    const scan = await scanAllNodesOfTypes(ctx.graph, SCANNED_TYPES);
    if (!scan.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
    }
    nodesToProcess = scan.value.nodes;
    scanIncomplete = scan.value.scanIncomplete;
    incompleteTypes = scan.value.incompleteTypes;
  }
  for (const node of nodesToProcess) {
    const raw = (node as Node).properties['qualityIssues'];
    if (!Array.isArray(raw)) continue;
    const risks: GovernorLimitRiskFinding[] = [];
    for (const rawIssue of raw) {
      const issue = coerceIssue(rawIssue);
      if (issue === null) continue;
      if (issue.rule === 'dynamic-apex') dynamicApexIds.add(node.id);
      if (!GOVERNOR_LIMIT_RULES.has(issue.rule)) continue;
      risks.push({
        rule: issue.rule,
        severity: issue.severity,
        location: issue.location,
        explanation: issue.explanation,
      });
    }
    const partitioned = await partitionByBaseline(
      ctx,
      GOVERNOR_LIMIT_TOOL,
      node.id,
      risks,
    );
    suppressedRiskCount += partitioned.suppressedCount;
    for (const issue of partitioned.active) {
      byRule[issue.rule] = (byRule[issue.rule] ?? 0) + 1;
      totalRiskCount += 1;
    }
    if (partitioned.active.length === 0) continue;

    // Resolve trigger context for ApexClass entries only.
    // ApexTriggers' own qualityIssues are reported in-place; an
    // ApexTrigger doesn't have a "trigger caller" upstream.
    let triggerContext: readonly ComponentId[] = [];
    let entryPaths: readonly (readonly ComponentId[])[] = [];
    let entryPathsTruncated = false;
    if (node.type === 'ApexClass') {
      const tcRes = await collectTriggerCallers(ctx, node.id);
      if (!tcRes.ok) {
        return err({ kind: 'internal', message: tcRes.error });
      }
      triggerContext = tcRes.value;
      // P4-graph-sast: the entry-point paths that reach this risky class.
      const epRes = await collectEntryPaths(ctx, node.id);
      if (!epRes.ok) {
        return err({ kind: 'internal', message: epRes.error });
      }
      entryPaths = epRes.value.paths;
      entryPathsTruncated = epRes.value.truncated;
    }

    perClass.set(node.id, {
      componentId: node.id,
      type: node.type,
      apiName: node.apiName,
      risks: [...partitioned.active],
      triggerContext,
      entryPaths,
      ...(entryPathsTruncated ? { entryPathsTruncated: true } : {}),
    });
  }

  // The output key is the perClass map key (componentId), so every entry has a
  // UNIQUE componentId — compareClassById is already a STRICT TOTAL order; no
  // extra tiebreak is needed for a dup/skip-proof resume.
  const classes = [...perClass.values()].sort(compareClassById);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // Bind the fingerprint to the class scope so a cursor minted for a scoped call
  // cannot resume against the (differently-shaped) org-wide list, and vice versa.
  const fingerprint = argsFingerprint(
    scopeId !== null ? { componentId: scopeId } : {},
  );
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: GOVERNOR_LIMIT_TOOL_NAME,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(classes, {
    offset,
    limit,
    keyOf: (entry) => entry.componentId,
    binding: {
      tool: GOVERNOR_LIMIT_TOOL_NAME,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const slice = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  // D-3: a zero must be readable as CHECKED or UNCHECKED, and a zero-finding
  // response is the shape that most needs to say what was not scanned. These
  // two describe HOW the scanner reads Apex source — true whether or not a
  // finding qualified — so they are UNCONDITIONAL. Gating them on
  // `classes.length > 0` meant the false-clean answer was the one answer that
  // explained nothing about itself.
  const boundaries: string[] = [
    GOVERNOR_LIMIT_HEURISTIC_DISCLOSURE,
    GOVERNOR_LIMIT_TRIGGER_CONTEXT_DISCLOSURE,
  ];

  // The LIMIT axis of the same principle. The machine-readable block rides on
  // every response (see `limitCoverage` on the output interface); the prose
  // note is org-wide only, mirroring `code-quality-audit.ts`'s
  // `NOT_APEX_TYPES` guard — a caller who named one class is asking about that
  // class, and the block already carries the same facts for them.
  const limitCoverage = {
    checkedRules: [...GOVERNOR_LIMIT_RULES],
    notChecked: NOT_CHECKED_GOVERNOR_LIMITS,
  };
  const notCheckedLimitsNote =
    scopeId === null
      ? buildNotCheckedLimitsNote(NOT_CHECKED_GOVERNOR_LIMITS)
      : undefined;
  if (notCheckedLimitsNote !== undefined) boundaries.push(notCheckedLimitsNote);

  // QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS. `detectCodeQualityIssues` ran from
  // the ApexClass extractor ONLY, so on a vault built before the trigger
  // extractor was wired every ApexTrigger answers `classes: []`, `boundaries:
  // []` — byte-identical to a clean trigger, and a trigger's per-DML invocation
  // is exactly where a SOQL-in-loop hurts most. Lives OUTSIDE the zero-findings
  // gate because the zero-finding response IS the false-clean one. It
  // disappears entirely once the vault is refreshed.
  const qualityScanCoverage = censusQualityScanCoverage(nodesToProcess);
  const unscannedNote = buildUnscannedNodesNote(qualityScanCoverage);
  if (unscannedNote !== undefined) {
    boundaries.push(unscannedNote);
    // The `soundness` envelope below is read off the SAME property: a node with
    // no `qualityIssues` key cannot carry the `dynamic-apex` signal either, so
    // say that here rather than let `complete: true` read as a proven-clean
    // static analysis of an unscanned node.
    boundaries.push(
      'The `soundness` envelope is derived from the same `qualityIssues` property: a node that carries no scan cannot carry the `dynamic-apex` signal, so `complete: true` covers only the nodes named as scanned above.',
    );
  }

  // Residual scan-incompleteness only fires for a PATHOLOGICAL type past
  // FULL_SCAN_MAX_NODES — the normal full scan reaches node 501+ and completes.
  // Lives OUTSIDE the zero-findings gate because risky classes could be among
  // the unscanned residual tail.
  if (scanIncomplete) {
    boundaries.push(
      scanTruncationNote(incompleteTypes, clampedNodeScanLimit()),
    );
  }
  // CR-22-B6: the ENTRY_PATH_MAX_PATHS(=12)/ENTRY_PATH_MAX_DEPTH(=6) walk cap
  // was previously JSDoc-only — a class with a wide fan-in of callers showed
  // exactly 12 entry paths with no signal that more existed. Reflects the
  // FULL (pre-page) `classes` list so it fires regardless of which page a
  // caller is viewing.
  if (classes.some((c) => c.entryPathsTruncated === true)) {
    boundaries.push(
      `Entry-path walk capped: one or more classes have MORE entry-point paths reaching them than the ${ENTRY_PATH_MAX_PATHS.toString()} shown (bounded depth ${ENTRY_PATH_MAX_DEPTH.toString()}) — see that class's \`entryPathsTruncated\` flag. The listed \`entryPaths\` are a representative sample, not the full call-path inventory.`,
    );
  }

  // Emit paging fields ONLY on a paged response (truncated OR resumed offset>0),
  // so a whole-fits no-cursor call stays byte-identical to pre-CR-22.
  const isPaged = truncated || offset > 0;

  return ok({
    data: {
      appliedScope: {
        component: scopeId,
        mode: scopeId !== null ? 'component' : 'all',
      },
      classes: slice,
      totalClassCount: classes.length,
      totalRiskCount,
      suppressedRiskCount,
      byRule,
      qualityScanCoverage,
      limitCoverage,
      boundaries,
      truncated,
      soundness: soundnessFromDynamicApexIds([...dynamicApexIds]),
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + slice.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
