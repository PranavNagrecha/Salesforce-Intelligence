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

import type { McpError, McpResponse, Node, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';
import { resolveExistingObjectScope } from './input-aliases.js';

const PAGE = 500;
const MAX_PAGES = 40;

export const flowFaultAuditInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
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
  readonly totalFaultableElements: number;
  readonly totalUnhandledElements: number;
  readonly flows: readonly FlowFaultEntry[];
  /**
   * True when `flows` was cut at `limit` (worst-first ordering) —
   * `flowsWithUnhandledFaults` is still the FULL offender count. No cursor:
   * raise `limit` (max 500) to see the dropped tail.
   */
  readonly truncated: boolean;
  /**
   * True when the Flow scan stopped at the internal ceiling
   * (`PAGE * MAX_PAGES` flows) — `totalFlows` and the totals may UNDERCOUNT.
   * Only conceivable on an extreme vault; disclosed rather than silent.
   */
  readonly scanTruncated: boolean;
  readonly trust: TrustSummary;
  readonly rendered: string;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

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
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input);
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
  for (const f of flows) {
    const faultable = num(f.properties['faultableElementCount']) ?? 0;
    const without = num(f.properties['elementsWithoutFault']) ?? 0;
    totalFaultableElements += faultable;
    totalUnhandledElements += without;
    if (f.properties['hasUnhandledFaults'] === true) {
      entries.push({
        id: f.id,
        name: f.apiName,
        faultableElements: faultable,
        elementsWithoutFault: without,
        faultSurface: classifyFaultSurface(f.properties),
      });
    }
  }
  entries.sort((a, b) => b.elementsWithoutFault - a.elementsWithoutFault);

  // Handler cap (P15 oversize-enumeration guard): offender list is sliced at
  // `limit` after worst-first sort; full counts stay honest + the cut is disclosed.
  const truncated = entries.length > limit;

  const trust = offlineTrust(ctx, { status: summarizeCoverage(ctx.manifest).status });
  const table = mdTable(
    ['Flow', 'Unhandled', 'Faultable'],
    entries.slice(0, limit).map((e) => [e.name, e.elementsWithoutFault, e.faultableElements]),
  );
  const truncNote = truncated
    ? `\n_List truncated to the worst ${limit} of ${entries.length} flagged flows — raise \`limit\` (max 500) to see the rest._\n`
    : '';
  const scanNote = scanTruncated
    ? `\n_Flow scan stopped at the internal ${PAGE * MAX_PAGES}-flow ceiling — totals may undercount; narrow the audit or refresh a smaller vault._\n`
    : '';
  const rendered = !propertyAvailable
    ? `Fault coverage is not in this vault yet — run \`/sfi-refresh\` to populate it (the Flow extractor now records it).\n\n${renderFooter(trust)}`
    : `**${entries.length}** of ${flows.length} flows have at least one DML/action element with no fault path ` +
      `(${totalUnhandledElements} of ${totalFaultableElements} faultable elements unhandled).\n\n${table}\n${truncNote}${scanNote}\n` +
      `_Offline — an unhandled fault is **surfaced, not silent**: screen flows show the running user an error screen, ` +
      `and autolaunched/record-triggered flows (including before-save and after-save) raise an unhandled-fault runtime ` +
      `error that rolls back the whole transaction so the triggering save fails with a visible error. Add a fault path ` +
      `to replace that default error with a graceful, retryable message._\n\n${renderFooter(trust)}`;

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
      totalFaultableElements,
      totalUnhandledElements,
      flows: entries.slice(0, limit),
      truncated,
      scanTruncated,
      trust,
      rendered,
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};

const renderFooter = (trust: TrustSummary): string =>
  `_Source: offline snapshot${trust.freshness.snapshotRefreshedAt ? ` · refreshed ${trust.freshness.snapshotRefreshedAt}` : ''}._`;
