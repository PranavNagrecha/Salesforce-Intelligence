/**
 * sfi.flow_fault_audit — Flows whose DML/action elements have no fault path.
 *
 * Reads the fault-coverage the Flow extractor records on each node
 * (`faultableElementCount` / `elementsWithoutFault` / `hasUnhandledFaults`) and
 * flags flows where a faultable element has no fault path. Read-only,
 * offline. A vault built before the extractor captured fault coverage reports
 * `propertyAvailable: false` (re-`/sfi-refresh` to populate) — honest, not zero.
 * Coverage is censused PER FLOW, not probed from one node: a MIXED vault (an
 * incremental refresh) reports `flowsWithFaultCoverage` /
 * `flowsMissingFaultCoverage`, and the flows carrying no coverage property are
 * excluded from every total and named in the rendered boundary rather than
 * counted clean.
 *
 * IMPORTANT — an unhandled fault is NOT silent. Salesforce surfaces it:
 *   - Screen flows show the running user a flow error screen (the interview
 *     halts), they do not fail quietly.
 *   - Autolaunched/record-triggered flows (including before-save and
 *     after-save) raise an unhandled-fault runtime error that rolls back the
 *     whole transaction; the triggering DML fails with a visible error. The
 *     absence of a fault connector makes the fault UNHANDLED (surfaced and
 *     uncaught), not suppressed. A fault is only truly silent when a fault
 *     PATH explicitly swallows the error, which these flows lack.
 * Adding a fault path lets you replace that default surfaced error with a
 * graceful, retryable message — it does not change whether errors surface.
 */

import type {
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { familyWasExtracted } from './absence-disclosure.js';
import { offlineTrust } from './coverage-trust.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { FULL_SCAN_MAX_NODES } from './scan-cap.js';

/**
 * The node property the Flow extractor writes when it measures fault coverage.
 * `packages/extractors/src/flow.ts` writes it UNCONDITIONALLY on the one and
 * only `type: 'Flow'` node site, so its ABSENCE means this flow was extracted
 * before fault coverage existed — never-measured, NOT measured-and-clean. That
 * is the whole reason the census below is per node and reads the KEY
 * (`familyWasExtracted`) rather than probing one node's value.
 */
const FAULT_COVERAGE_PROPERTY = 'faultableElementCount';

/**
 * Residual ceiling on the FULL Flow scan, defaulting to the shared
 * {@link FULL_SCAN_MAX_NODES} (20 000 — the same effective ceiling the
 * hand-rolled 500x40 window loop had, so no vault sees a behaviour change).
 * `SFI_FLOW_FAULT_SCAN_MAX` overrides it so a test can exercise the cap
 * boundary without seeding 20 000 nodes, and an operator on a pathological
 * vault can raise it. Read at CALL time. Mirrors `SFI_FLOW_WRITER_SCAN_MAX` on
 * the sibling flow scan.
 */
const flowFaultScanCeiling = (): number => {
  const v = Number(process.env['SFI_FLOW_FAULT_SCAN_MAX']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : FULL_SCAN_MAX_NODES;
};

/** Tool name the CR-22 continuation cursor is bound to. */
const FLOW_FAULT_AUDIT_TOOL = 'sfi.flow_fault_audit';

/**
 * Per-response byte budget for the `flows` ARRAY alone — the inner bound the
 * CR-22 pager applies while slicing rows. It is NOT the binding constraint:
 * see {@link flowFaultResponseBudgetBytes} for the WHOLE-response budget that
 * actually decides where the page ends.
 */
const FLOW_FAULT_PAYLOAD_BUDGET_BYTES = 30_000;

/**
 * Room left for what the ENVELOPE adds after this handler returns: the
 * `contentPolicy` stamp, `estimatedPayloadBytes`, the disclosed `vaultState`
 * (targetOrg / vaultPath / builderVersion) and a possible `orgDrift` badge.
 * Measured at well under 1 KB today; 2 KB is the headroom so a badge or a long
 * vault path can never be what pushes the envelope over the cap.
 */
const FLOW_FAULT_ENVELOPE_RESERVE_BYTES = 2_048;

/** Floor for the whole-response budget under an absurdly small operator cap. */
const FLOW_FAULT_BUDGET_FLOOR_BYTES = 2_000;

/**
 * Resolve the active global response budget the SAME way `tool-dispatch.ts`'s
 * `responseBudgetBytes` does. DUPLICATED here (rather than imported) on
 * purpose, exactly as `generate-data-dictionary.ts` does: `tool-dispatch.ts`
 * imports this module, so importing back from it would create a module cycle.
 * Must track that resolver's clamp.
 */
const FLOW_FAULT_MAX_RESPONSE_BYTES = 45_000;
const FLOW_FAULT_RESPONSE_BUDGET_DEFAULT_BYTES = 40_000;

/**
 * The byte budget this handler fits its ENTIRE `data` payload to, before the
 * global `jsonResult` guard ever sees it.
 *
 * FLOW-FAULT-AUDIT-RESUME-POINTER-OVERSHOOT — why the whole payload and not
 * just `flows`: the pager was budgeting the `flows` ARRAY at 30 KB, but the
 * response also carries `rendered`, whose markdown table is built from the SAME
 * page and costs roughly as much again. A `limit: 500` call over 234 flagged
 * flows therefore produced a ~65 KB envelope: the pager kept 140 rows and
 * stamped `nextOffset: 140`, then the global guard tail-trimmed `flows` to 70
 * and left the pointer alone. Rows 70–139 were unreachable by ANY call, and the
 * envelope's own note ("the handler's pagination is authoritative") pointed the
 * caller straight at the broken pointer. Budgeting the whole payload means the
 * guard's array trim never engages here, so the pointer can only ever describe
 * rows that were actually delivered.
 */
const flowFaultResponseBudgetBytes = (): number => {
  const raw = process.env['SFI_MAX_RESPONSE_BYTES'];
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  const cap =
    Number.isFinite(parsed) && parsed >= 2_000
      ? Math.min(Math.floor(parsed), FLOW_FAULT_MAX_RESPONSE_BYTES)
      : FLOW_FAULT_RESPONSE_BUDGET_DEFAULT_BYTES;
  return Math.max(
    FLOW_FAULT_BUDGET_FLOOR_BYTES,
    cap - FLOW_FAULT_ENVELOPE_RESERVE_BYTES,
  );
};

const utf8Bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');

export const flowFaultAuditInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  // CR-22 resume knob. `limit` alone was a top-N truncator: the dropped tail
  // was unreachable by ANY argument, and the envelope reducer trimmed rows the
  // response had already claimed were whole. `offset` / `cursor` make the tail
  // reachable and move the cut decision into the handler.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
  // FLOW-FAULT-AUDIT-IGNORES-OBJECT-SCOPE: honor an object scope instead of
  // silently stripping it and returning the org-wide fault inventory. A
  // record-triggered Flow runs ON an object (`properties.triggerObject`), so the
  // audit CAN attribute its findings to it: with a scope the sweep narrows to
  // flows on that object and echoes `appliedScope`. Accepts the interchangeable
  // object identifiers a host/router reaches for.
  objectApiName: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
});
export type FlowFaultAuditInput = z.infer<typeof flowFaultAuditInputSchema>;

/**
 * How an unhandled fault surfaces at runtime, derived from the flow's type:
 *   - `screen`       — Flow (screen): shows the user a flow error screen.
 *   - `transactional` — autolaunched/record-triggered (incl. before/after-save):
 *                       rolls back the transaction and raises a surfaced
 *                       unhandled-fault runtime error; the triggering DML fails.
 *   - `unknown`      — processType not recorded in this vault.
 */
export type FaultSurface = 'screen' | 'transactional' | 'unknown';

export interface FlowFaultEntry {
  readonly id: string;
  readonly name: string;
  /**
   * FLOW-AUDITS-IGNORE-ACTIVATION-STATUS: the Flow's recorded activation status
   * (`Active` / `Draft` / `Obsolete` / `InvalidDraft` / …), or `null` when this
   * vault does not record one. `null` is UNKNOWN — never coerced to `'Active'`.
   */
  readonly status: string | null;
  /**
   * `true` when `status === 'Active'`, `false` for any other RECORDED status,
   * and `null` when `status` is `null`. An unknown status must never collapse
   * to `false`, mirroring `find_dead_code`'s
   * `COALESCE(status,'') NOT IN ('Obsolete','InvalidDraft')` rule that an
   * unknown-status flow is treated as in-use.
   */
  readonly isRunnable: boolean | null;
  readonly faultableElements: number;
  readonly elementsWithoutFault: number;
  readonly faultSurface: FaultSurface;
}
export interface FlowFaultAuditOutput {
  /**
   * Present ONLY on an object-scoped call (FLOW-FAULT-AUDIT-IGNORES-OBJECT-SCOPE)
   * — echoes the object the sweep was narrowed to (record-triggered flows whose
   * `triggerObject` is that object) so a host never reads a scoped answer as
   * org-wide. Absent on the bare call, keeping that response byte-identical.
   * `object` is the canonical `CustomObject:` id; `mode` is always `component`
   * when present (a bare call omits the whole block, i.e. the `all` reading).
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
  /**
   * True when AT LEAST ONE flow in scope carries the fault-coverage property.
   * It is NOT a completeness claim — read it with
   * {@link FlowFaultAuditOutput.flowsMissingFaultCoverage}, which names how
   * many flows in the SAME scope carry none.
   */
  readonly propertyAvailable: boolean;
  readonly totalFlows: number;
  /**
   * Flows in scope that CARRY the fault-coverage property — the ones this
   * audit actually measured. `flowsWithFaultCoverage + flowsMissingFaultCoverage
   * === totalFlows`, always.
   */
  readonly flowsWithFaultCoverage: number;
  /**
   * Flows in scope carrying NO fault-coverage property, so the audit never
   * examined them (FLOW-FAULT-AUDIT-CERTIFIES-COVERAGE-FROM-ONE-NODE). They
   * contribute to no total and to no clean count: a zero for them is NOT
   * CHECKED, never "clean". A `sfi refresh` closes this gap.
   */
  readonly flowsMissingFaultCoverage: number;
  readonly flowsWithUnhandledFaults: number;
  /**
   * FLOW-AUDITS-IGNORE-ACTIVATION-STATUS. Flagged flows whose status is
   * literally `Active` — the ones whose findings are LIVE.
   */
  readonly flowsWithUnhandledFaultsActive: number;
  /**
   * Flagged flows with a RECORDED status that is not `Active` (Obsolete /
   * Draft / InvalidDraft / …) — they cannot run today, so their findings are
   * latent, not live.
   */
  readonly flowsWithUnhandledFaultsNotRunnable: number;
  /**
   * Flagged flows whose status this vault does not record. UNKNOWN, counted
   * separately rather than folded into either side — a zero here is a CHECKED
   * zero (every flagged flow carried a status), not an assumption.
   * `Active + NotRunnable + StatusUnknown === flowsWithUnhandledFaults`.
   */
  readonly flowsWithUnhandledFaultsStatusUnknown: number;
  readonly totalFaultableElements: number;
  readonly totalUnhandledElements: number;
  /** Unhandled elements carried by the `Active` flagged flows only. */
  readonly totalUnhandledElementsActive: number;
  /** The PAGE of flagged flows (not the full set — see `totalCount`). */
  readonly flows: readonly FlowFaultEntry[];
  /**
   * FULL count of flagged flows before paging. Equal to
   * `flowsWithUnhandledFaults`; emitted under the sibling tools' name so a host
   * reads the page boundary the same way everywhere.
   */
  readonly totalCount: number;
  /**
   * True when this PAGE does not reach the end of the flagged list (cut by
   * `limit` OR by the handler's byte budget) — `flowsWithUnhandledFaults` and
   * the element totals are still the FULL-set numbers. Distinct from
   * `scanTruncated`: this is a page boundary, that is a scan ceiling.
   */
  readonly truncated: boolean;
  /**
   * True when the Flow scan stopped at the internal residual ceiling
   * (`FULL_SCAN_MAX_NODES`, or `SFI_FLOW_FAULT_SCAN_MAX`) with STRICTLY MORE
   * flows still behind it — `totalFlows` and the totals may UNDERCOUNT. A vault
   * holding EXACTLY the ceiling is complete, not truncated: `scanAllNodesOfTypes`
   * settles that boundary with a bounded probe rather than assuming a full final
   * page means more remains. Only conceivable on an extreme vault; disclosed
   * rather than silent. A DIFFERENT truncation from `truncated` above; never
   * merge the two.
   */
  readonly scanTruncated: boolean;
  /**
   * Page size ACTUALLY applied — which is the requested `limit` only when the
   * whole response fitted the byte budget at that size. When fitting shrank the
   * page, this is the shrunken size, not the request. Present only on a PAGED
   * response (`truncated` or a resumed `offset > 0`), so a whole-fits call stays
   * byte-identical.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned flow. Present only when paged. */
  readonly offset?: number;
  /**
   * Offset to pass on the next call. Present only when `truncated`, and always
   * `offset + flows.length` — the pointer is derived from the rows this response
   * actually DELIVERS, never from a page the handler intended before something
   * downstream trimmed it (FLOW-FAULT-AUDIT-RESUME-POINTER-OVERSHOOT).
   */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated.
   * Echo it back as `cursor` to resume.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  readonly trust: TrustSummary;
  readonly rendered: string;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * FLOW-AUDITS-IGNORE-ACTIVATION-STATUS — the verbatim activation-status
 * boundary, shared CHARACTER-FOR-CHARACTER by both flow audits
 * (`flow_fault_audit` and `flow_bulkification_audit`) by importing this one
 * constant rather than pasting the prose twice. Unconditional: it describes how
 * the audit reports status, which is true whether or not anything was flagged.
 * Product copy; do not reword.
 */
export const FLOW_ACTIVATION_STATUS_DISCLOSURE =
  'Activation status is reported per row. A flow whose status is Obsolete, Draft, or InvalidDraft does not run in the org today, so its findings are latent, not live. A null status means this vault does not record it — that is UNKNOWN, not Active.';

/**
 * Read a Flow node's recorded activation status. Returns `null` when the vault
 * has no `status` property for it — UNKNOWN, never defaulted to `'Active'`.
 */
export const readFlowStatus = (
  props: Readonly<Record<string, unknown>>,
): string | null => {
  const raw = props['status'];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
};

/**
 * Tri-state runnability. `true` only for a literal `Active`; `false` for any
 * other RECORDED status; `null` when the status is absent. The `null` case is
 * the whole point — an unrecorded status is UNKNOWN, and collapsing it to
 * `false` would assert a flow is switched off on no evidence.
 */
export const flowIsRunnable = (status: string | null): boolean | null =>
  status === null ? null : status === 'Active';

/**
 * Classify how an unhandled fault would surface, from the flow's processType
 * and trigger metadata. Screen flows (`processType: Flow` with no record
 * trigger) show the running user an error screen; everything else that runs
 * inside a save/transaction (autolaunched and record-triggered, including
 * before-save and after-save) surfaces a transaction-rolling-back runtime
 * error. Either way the fault is surfaced, never silent.
 */
export const classifyFaultSurface = (
  props: Readonly<Record<string, unknown>>,
): FaultSurface => {
  const processType =
    typeof props['processType'] === 'string' ? props['processType'] : null;
  const triggerType =
    typeof props['triggerType'] === 'string' ? props['triggerType'] : null;
  if (processType === null) return 'unknown';
  // A record-triggered flow runs inside the triggering DML's transaction.
  if (triggerType !== null && triggerType.startsWith('Record')) {
    return 'transactional';
  }
  // Screen flow: user-driven interview, error shows on a screen.
  if (processType === 'Flow') return 'screen';
  // AutoLaunchedFlow / scheduled / platform-event etc. — run transactionally.
  return 'transactional';
};

export const flowFaultAuditHandler = async (
  ctx: Context,
  input: FlowFaultAuditInput,
): Promise<Result<McpResponse<FlowFaultAuditOutput>, McpError>> => {
  const limit = input.limit ?? 100;

  // FLOW-FAULT-AUDIT-IGNORES-OBJECT-SCOPE: resolve the optional object scope
  // (and verify it exists) BEFORE scanning. `null` = bare org-wide call
  // (byte-identical); a resolved scope narrows the sweep to record-triggered
  // flows on that object; an unresolvable / absent object → `invalid-query`.
  //
  // OBJECT-SCOPE-PREFIX-REFUSAL: this tool has NO reverse mode — it scopes only
  // by OBJECT — so a `componentId` carrying any other prefix (`Flow:`,
  // `ApexClass:`, …) must be REFUSED, never ignored. Ignoring it would fall
  // through to `ok(null)` and silently return the org-wide fault inventory in
  // answer to a question about one component.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input, {
    unhandledPrefix: 'refuse',
  });
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;

  // FLOW-FAULT-AUDIT-SWALLOWS-A-FAILED-SCAN: the scan is the shared
  // `scanAllNodesOfTypes` full-window walk, not a hand-rolled window loop whose
  // only reaction to a graph error was `break`. Two defects go with that loop:
  //   1. a failed page was SWALLOWED — the handler carried on over whatever it
  //      had and returned a fully-formed audit with every honesty field
  //      claiming a complete scan (a first-page failure even rendered "fault
  //      coverage is not in this vault yet — run `/sfi-refresh`", an answer
  //      about the vault's AGE to a broken query). The shared walk propagates
  //      the error and this handler maps it to `internal`, exactly as every
  //      other error path in this file already does.
  //   2. `scanTruncated` came from "the last allowed page came back full",
  //      which is TRUE for an org holding exactly the ceiling even though
  //      nothing is behind it. The shared walk settles that boundary with one
  //      bounded probe (CR-P3) and reports `scanIncomplete` only when STRICTLY
  //      more nodes remain.
  const scanCeiling = flowFaultScanCeiling();
  const scan = await scanAllNodesOfTypes(ctx.graph, ['Flow'], scanCeiling);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }
  const scanTruncated = scan.value.scanIncomplete;
  // Object-scoped: keep only flows that RUN ON the scoped object — a
  // record-triggered flow's `triggerObject` (bare api name). Screen /
  // autolaunched / scheduled flows have no `triggerObject` and are correctly
  // excluded (they don't run on a single object). Bare call: no filter.
  const flows: Node[] = [];
  for (const flow of scan.value.nodes) {
    if (scope !== null && flow.properties['triggerObject'] !== scope.object) {
      continue;
    }
    flows.push(flow);
  }

  // FLOW-FAULT-AUDIT-CERTIFIES-COVERAGE-FROM-ONE-NODE: census fault coverage
  // PER NODE, not with one org-level `.some()`. The old probe let a single flow
  // carrying the property certify every other flow as scanned, so on a mixed
  // vault (an incremental refresh, or a partially re-extracted flow set) the
  // flows with NO coverage key contributed `faultable: 0, without: 0`, never
  // set `hasUnhandledFaults`, and were counted CLEAN. `familyWasExtracted`
  // reads the KEY: an empty/zero value is a measured zero, an absent key is no
  // measurement at all, and the defect was treating those two the same.
  let flowsWithFaultCoverage = 0;
  let flowsMissingFaultCoverage = 0;
  for (const f of flows) {
    if (familyWasExtracted(f.properties, FAULT_COVERAGE_PROPERTY)) {
      flowsWithFaultCoverage += 1;
    } else {
      flowsMissingFaultCoverage += 1;
    }
  }
  // Unchanged meaning: is fault coverage captured in this vault AT ALL? Now
  // derived from the same per-node census, so `propertyAvailable: true` with
  // `flowsMissingFaultCoverage > 0` is the mixed vault stating itself.
  const propertyAvailable = flowsWithFaultCoverage > 0;

  const entries: FlowFaultEntry[] = [];
  let totalFaultableElements = 0;
  let totalUnhandledElements = 0;
  // FLOW-AUDITS-IGNORE-ACTIVATION-STATUS: partition the flagged set by whether
  // the flow can run TODAY. Active / not-runnable / status-unknown are three
  // distinct answers and each gets its own counter — a status the vault does
  // not record is UNKNOWN and is never folded into either of the other two.
  let activeFlowCount = 0;
  let flowsWithUnhandledFaultsActive = 0;
  let flowsWithUnhandledFaultsNotRunnable = 0;
  let flowsWithUnhandledFaultsStatusUnknown = 0;
  let totalUnhandledElementsActive = 0;
  const notRunnableByStatus = new Map<string, number>();
  for (const f of flows) {
    // A flow with no coverage key was never measured. It contributes to
    // NEITHER the totals nor the clean count — it is disclosed by name in
    // `flowsMissingFaultCoverage` and in the rendered boundary below, so its
    // zero can never be read as "checked and clean".
    if (!familyWasExtracted(f.properties, FAULT_COVERAGE_PROPERTY)) continue;
    const faultable = num(f.properties[FAULT_COVERAGE_PROPERTY]) ?? 0;
    const without = num(f.properties['elementsWithoutFault']) ?? 0;
    const status = readFlowStatus(f.properties);
    const isRunnable = flowIsRunnable(status);
    totalFaultableElements += faultable;
    totalUnhandledElements += without;
    if (isRunnable === true) activeFlowCount += 1;
    if (f.properties['hasUnhandledFaults'] === true) {
      if (isRunnable === true) {
        flowsWithUnhandledFaultsActive += 1;
        totalUnhandledElementsActive += without;
      } else if (isRunnable === false) {
        flowsWithUnhandledFaultsNotRunnable += 1;
        notRunnableByStatus.set(
          status as string,
          (notRunnableByStatus.get(status as string) ?? 0) + 1,
        );
      } else {
        flowsWithUnhandledFaultsStatusUnknown += 1;
      }
      entries.push({
        id: f.id,
        name: f.apiName,
        status,
        isRunnable,
        faultableElements: faultable,
        elementsWithoutFault: without,
        faultSurface: classifyFaultSurface(f.properties),
      });
    }
  }
  // Sort: runnable-or-unknown first (an unknown status is treated as in-use,
  // per find_dead_code's precedent), then worst-first, then `id ASC` as a
  // UNIQUE final tiebreak. The tiebreak is not cosmetic — without a total
  // order an offset/cursor resume can skip or duplicate rows.
  const notRunnableRank = (e: FlowFaultEntry): number =>
    e.isRunnable === false ? 1 : 0;
  entries.sort((a, b) => {
    const rankDelta = notRunnableRank(a) - notRunnableRank(b);
    if (rankDelta !== 0) return rankDelta;
    if (b.elementsWithoutFault !== a.elementsWithoutFault) {
      return b.elementsWithoutFault - a.elementsWithoutFault;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // CR-22 paging. The object scope is the only narrowing arg, so a cursor
  // minted org-wide can never be replayed against a scoped call (or vice
  // versa). `limit`/`offset`/`cursor` are excluded from the fingerprint by
  // `argsFingerprint` — asking for a different PAGE of the same query is
  // exactly what a cursor is for.
  const fingerprint = argsFingerprint(
    scope !== null ? { objectId: scope.componentId } : {},
  );
  let pageOffset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: FLOW_FAULT_AUDIT_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    pageOffset = decoded.value.o;
  }
  // ── Page + FIT ─────────────────────────────────────────────────────────
  // Everything below the page boundary is derived from ONE page length, so the
  // pointer, the `flows` array, the markdown table and the prose can never
  // disagree. The page-INDEPENDENT parts are computed once, up front.
  const trust = offlineTrust(ctx, { status: summarizeCoverage(ctx.manifest).status });
  // A DIFFERENT truncation from the page boundary: this one says the SCAN
  // never reached some flows, so the totals themselves may undercount. Two
  // flags, two sentences — never merged.
  const scanNote = scanTruncated
    ? `\n_Flow scan stopped at the internal ${scanCeiling}-flow ceiling — totals may undercount; narrow the audit or refresh a smaller vault._\n`
    : '';
  // The refresh-closable half of the honesty spine: flows this vault never
  // measured. Emitted UNCONDITIONALLY when any exist, so it survives every
  // paging path — the gap is a property of the SCAN, not of the page.
  const coverageGapNote =
    flowsMissingFaultCoverage > 0
      ? `\n_⚠️ NOT CHECKED IN THIS VAULT: ${flowsMissingFaultCoverage} of ${flows.length} flows carry no fault-coverage property, so this audit never examined them. A zero for them is "not checked", NOT "clean" — re-run \`/sfi-refresh\` to close the gap._\n`
      : '';
  const notRunnableBreakdown = [...notRunnableByStatus.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  const notRunnableSentence =
    flowsWithUnhandledFaultsNotRunnable > 0
      ? ` A further **${flowsWithUnhandledFaultsNotRunnable}** flagged flows are not Active ` +
        `(${notRunnableBreakdown}) and cannot run today — they are listed below, marked, and sorted last.`
      : '';
  const statusUnknownSentence =
    flowsWithUnhandledFaultsStatusUnknown > 0
      ? ` A further **${flowsWithUnhandledFaultsStatusUnknown}** flagged flows have NO recorded status in this vault — ` +
        'that is UNKNOWN, not Active; they are listed below, marked `unknown`, and sorted with the Actives.'
      : '';

  const buildOutput = (pageLimit: number): FlowFaultAuditOutput => {
    const paged = paginateLegacy(entries, {
      offset: pageOffset,
      limit: pageLimit,
      byteBudget: FLOW_FAULT_PAYLOAD_BUDGET_BYTES,
      keyOf: (e) => e.id,
      binding: {
        tool: FLOW_FAULT_AUDIT_TOOL,
        vaultHash: ctx.manifest.sourceTreeHash,
        argsFingerprint: fingerprint,
      },
    });
    const page = paged.items;
    // `truncated` is the PAGE boundary and comes from the pager, not from
    // `entries.length > limit`: the byte budget can cut below `limit`, and the
    // old expression reported `truncated: false` while rows were dropped
    // downstream by the envelope reducer.
    const truncated = paged.hasMore;
    const emitCursor = paged.nextCursor !== null;
    const isPaged = truncated || pageOffset > 0;
    const returnedUnhandledElements = page.reduce(
      (sum, e) => sum + e.elementsWithoutFault,
      0,
    );

    // The table is built from the PAGE, so the markdown and the `flows` array are
    // the same list BY CONSTRUCTION — the table can no longer end mid-row.
    const table = mdTable(
      ['Flow', 'Status', 'Unhandled', 'Faultable'],
      page.map((e) => [
        e.name,
        e.status ?? 'unknown',
        e.elementsWithoutFault,
        e.faultableElements,
      ]),
    );
    const pageNote = truncated
      ? `\n_Showing the worst ${page.length} of ${entries.length} flagged flows (${returnedUnhandledElements} of ${totalUnhandledElements} unhandled elements). ` +
        `The remaining ${entries.length - pageOffset - page.length} are reachable — pass the returned nextCursor. ` +
        `Totals above are for the FULL set, not this page._\n`
      : pageOffset > 0
        ? `\n_Showing flagged flows ${pageOffset + 1}–${pageOffset + page.length} of ${entries.length} (final page). ` +
          `Totals above are for the FULL set, not this page._\n`
        : '';
    const rendered = !propertyAvailable
      ? `Fault coverage is not in this vault yet — run \`/sfi-refresh\` to populate it (the Flow extractor now records it).\n\n${renderFooter(trust)}`
      : `**${flowsWithUnhandledFaultsActive}** of ${activeFlowCount} ACTIVE flows have at least one DML/action element with no fault path ` +
        `(${totalUnhandledElementsActive} of ${totalFaultableElements} faultable elements unhandled).` +
        `${notRunnableSentence}${statusUnknownSentence}\n\n${table}\n${pageNote}${scanNote}${coverageGapNote}\n` +
        `_Offline — an unhandled fault is **surfaced, not silent**: screen flows show the running user an error screen, ` +
        `and autolaunched/record-triggered flows (including before-save and after-save) raise an unhandled-fault runtime ` +
        `error that rolls back the whole transaction so the triggering save fails with a visible error. Add a fault path ` +
        `to replace that default error with a graceful, retryable message._\n\n` +
        `_${FLOW_ACTIVATION_STATUS_DISCLOSURE}_\n\n${renderFooter(trust)}`;

    return {
      // appliedScope FIRST + only when scoped, so a bare call omits the whole
      // block and its serialized response stays byte-identical to pre-fix.
      ...(scope !== null
        ? { appliedScope: { object: scope.componentId, mode: 'component' as const } }
        : {}),
      propertyAvailable,
      totalFlows: flows.length,
      flowsWithFaultCoverage,
      flowsMissingFaultCoverage,
      flowsWithUnhandledFaults: entries.length,
      flowsWithUnhandledFaultsActive,
      flowsWithUnhandledFaultsNotRunnable,
      flowsWithUnhandledFaultsStatusUnknown,
      totalFaultableElements,
      totalUnhandledElements,
      totalUnhandledElementsActive,
      flows: page,
      totalCount: entries.length,
      truncated,
      scanTruncated,
      // `limit` echoes the page size ACTUALLY applied, which is what the field
      // claims to be. When the whole-response fit shrank it below the caller's
      // request, saying 500 would misdescribe a 65-row page.
      ...(isPaged ? { limit: pageLimit, offset: pageOffset } : {}),
      ...(truncated ? { nextOffset: pageOffset + page.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
      trust,
      rendered,
    };
  };

  // Largest page that fits the WHOLE-response budget. Binary search rather than
  // a shrink-until-it-fits loop so the answer is the MAXIMUM fitting page (an
  // under-filled page is not wrong, but it costs the caller round-trips), and
  // so the number of `buildOutput` calls is bounded by log2(limit) ≈ 9.
  //
  // A page of 10 rows or fewer is safe unconditionally: the global guard's
  // array trim never cuts an array below TRUNCATE_KEEP_MIN (10), so the floor
  // of this search can never be trimmed underneath the pointer either.
  const budget = flowFaultResponseBudgetBytes();
  let output = buildOutput(limit);
  if (utf8Bytes(output) > budget && output.flows.length > 1) {
    let lo = 1;
    let hi = output.flows.length - 1;
    let best = buildOutput(1);
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = buildOutput(mid);
      if (utf8Bytes(candidate) <= budget) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    output = best;
  }

  return ok({
    data: output,
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};

const renderFooter = (trust: TrustSummary): string =>
  `_Source: offline snapshot${trust.freshness.snapshotRefreshedAt ? ` · refreshed ${trust.freshness.snapshotRefreshedAt}` : ''}._`;
