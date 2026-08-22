/**
 * sfi.flow_fault_audit — Flows whose DML/action elements have no fault path.
 *
 * Reads the fault-coverage the Flow extractor records on each node
 * (`faultableElementCount` / `elementsWithoutFault` / `hasUnhandledFaults`) and
 * flags flows where a faultable element has no fault path. Read-only,
 * offline. A vault built before the extractor captured fault coverage reports
 * `propertyAvailable: false` (re-`/sfi-refresh` to populate) — honest, not zero.
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
import { listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const PAGE = 500;
const MAX_PAGES = 40;

/** Tool name the CR-22 continuation cursor is bound to. */
const FLOW_FAULT_AUDIT_TOOL = 'sfi.flow_fault_audit';

/**
 * Per-response byte budget for the `flows` page. The HANDLER makes the cut and
 * reports it, so the global envelope reducer never sees an over-budget payload
 * and can never silently drop rows the response claimed were complete.
 */
const FLOW_FAULT_PAYLOAD_BUDGET_BYTES = 30_000;

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
  readonly propertyAvailable: boolean;
  readonly totalFlows: number;
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
   * True when the Flow scan stopped at the internal ceiling
   * (`PAGE * MAX_PAGES` flows) — `totalFlows` and the totals may UNDERCOUNT.
   * Only conceivable on an extreme vault; disclosed rather than silent. A
   * DIFFERENT truncation from `truncated` above; never merge the two.
   */
  readonly scanTruncated: boolean;
  /**
   * Page size applied. Present only on a PAGED response (`truncated` or a
   * resumed `offset > 0`), so a whole-fits call stays byte-identical.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned flow. Present only when paged. */
  readonly offset?: number;
  /** Offset to pass on the next call. Present only when `truncated`. */
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

  const flows: Node[] = [];
  let offset = 0;
  // scanTruncated: the last allowed page came back full, so flows beyond the
  // PAGE * MAX_PAGES ceiling (if any) were never scanned — disclose, don't hide.
  let scanTruncated = false;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const r = await listNodesByType(ctx.graph, 'Flow', { limit: PAGE, offset });
    if (!r.ok) break;
    // Object-scoped: keep only flows that RUN ON the scoped object — a
    // record-triggered flow's `triggerObject` (bare api name). Screen /
    // autolaunched / scheduled flows have no `triggerObject` and are correctly
    // excluded (they don't run on a single object). Bare call: no filter.
    for (const flow of r.value) {
      if (scope !== null && flow.properties['triggerObject'] !== scope.object) {
        continue;
      }
      flows.push(flow);
    }
    if (r.value.length < PAGE) break;
    offset += PAGE;
    if (i === MAX_PAGES - 1) scanTruncated = true;
  }

  // Is fault coverage even captured in this vault? (Pre-change vaults have none.)
  const propertyAvailable = flows.some(
    (f) => num(f.properties['faultableElementCount']) !== null,
  );

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
    const faultable = num(f.properties['faultableElementCount']) ?? 0;
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
  const paged = paginateLegacy(entries, {
    offset: pageOffset,
    limit,
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

  const trust = offlineTrust(ctx, { status: summarizeCoverage(ctx.manifest).status });
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
  // A DIFFERENT truncation from the page boundary above: this one says the SCAN
  // never reached some flows, so the totals themselves may undercount. Two
  // flags, two sentences — never merged.
  const scanNote = scanTruncated
    ? `\n_Flow scan stopped at the internal ${PAGE * MAX_PAGES}-flow ceiling — totals may undercount; narrow the audit or refresh a smaller vault._\n`
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
  const rendered = !propertyAvailable
    ? `Fault coverage is not in this vault yet — run \`/sfi-refresh\` to populate it (the Flow extractor now records it).\n\n${renderFooter(trust)}`
    : `**${flowsWithUnhandledFaultsActive}** of ${activeFlowCount} ACTIVE flows have at least one DML/action element with no fault path ` +
      `(${totalUnhandledElementsActive} of ${totalFaultableElements} faultable elements unhandled).` +
      `${notRunnableSentence}${statusUnknownSentence}\n\n${table}\n${pageNote}${scanNote}\n` +
      `_Offline — an unhandled fault is **surfaced, not silent**: screen flows show the running user an error screen, ` +
      `and autolaunched/record-triggered flows (including before-save and after-save) raise an unhandled-fault runtime ` +
      `error that rolls back the whole transaction so the triggering save fails with a visible error. Add a fault path ` +
      `to replace that default error with a graceful, retryable message._\n\n` +
      `_${FLOW_ACTIVATION_STATUS_DISCLOSURE}_\n\n${renderFooter(trust)}`;

  return ok({
    data: {
      // appliedScope FIRST + only when scoped, so a bare call omits the whole
      // block and its serialized response stays byte-identical to pre-fix.
      ...(scope !== null
        ? { appliedScope: { object: scope.componentId, mode: 'component' as const } }
        : {}),
      propertyAvailable,
      totalFlows: flows.length,
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
      ...(isPaged ? { limit, offset: pageOffset } : {}),
      ...(truncated ? { nextOffset: pageOffset + page.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
      trust,
      rendered,
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};

const renderFooter = (trust: TrustSummary): string =>
  `_Source: offline snapshot${trust.freshness.snapshotRefreshedAt ? ` · refreshed ${trust.freshness.snapshotRefreshedAt}` : ''}._`;
