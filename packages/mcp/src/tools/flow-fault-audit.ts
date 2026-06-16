/**
 * sfi.flow_fault_audit — Flows whose DML/action elements have no fault path.
 *
 * Reads the fault-coverage the Flow extractor records on each node
 * (`faultableElementCount` / `elementsWithoutFault` / `hasUnhandledFaults`) and
 * flags flows where a runtime error would halt the interview silently. Read-only,
 * offline. A vault built before the extractor captured fault coverage reports
 * `propertyAvailable: false` (re-`/sfi-refresh` to populate) — honest, not zero.
 */

import type { McpError, McpResponse, Node, TrustSummary } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';

const PAGE = 500;
const MAX_PAGES = 40;

export const flowFaultAuditInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});
export type FlowFaultAuditInput = z.infer<typeof flowFaultAuditInputSchema>;

export interface FlowFaultEntry {
  readonly id: string;
  readonly name: string;
  readonly faultableElements: number;
  readonly elementsWithoutFault: number;
}
export interface FlowFaultAuditOutput {
  readonly propertyAvailable: boolean;
  readonly totalFlows: number;
  readonly flowsWithUnhandledFaults: number;
  readonly totalFaultableElements: number;
  readonly totalUnhandledElements: number;
  readonly flows: readonly FlowFaultEntry[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export const flowFaultAuditHandler = async (
  ctx: Context,
  input: FlowFaultAuditInput,
): Promise<Result<McpResponse<FlowFaultAuditOutput>, McpError>> => {
  const limit = input.limit ?? 100;
  const flows: Node[] = [];
  let offset = 0;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const r = await listNodesByType(ctx.graph, 'Flow', { limit: PAGE, offset });
    if (!r.ok) break;
    flows.push(...r.value);
    if (r.value.length < PAGE) break;
    offset += PAGE;
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
      entries.push({ id: f.id, name: f.apiName, faultableElements: faultable, elementsWithoutFault: without });
    }
  }
  entries.sort((a, b) => b.elementsWithoutFault - a.elementsWithoutFault);

  const trust = offlineTrust(ctx, { status: summarizeCoverage(ctx.manifest).status });
  const table = mdTable(
    ['Flow', 'Unhandled', 'Faultable'],
    entries.slice(0, limit).map((e) => [e.name, e.elementsWithoutFault, e.faultableElements]),
  );
  const rendered = !propertyAvailable
    ? `Fault coverage is not in this vault yet — run \`/sfi-refresh\` to populate it (the Flow extractor now records it).\n\n${renderFooter(trust)}`
    : `**${entries.length}** of ${flows.length} flows have at least one DML/action element with no fault path ` +
      `(${totalUnhandledElements} of ${totalFaultableElements} faultable elements unhandled).\n\n${table}\n\n` +
      `_Offline — an unhandled fault lets a runtime error halt the interview silently; add a fault path._\n\n${renderFooter(trust)}`;

  return ok({
    data: {
      propertyAvailable,
      totalFlows: flows.length,
      flowsWithUnhandledFaults: entries.length,
      totalFaultableElements,
      totalUnhandledElements,
      flows: entries.slice(0, limit),
      trust,
      rendered,
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};

const renderFooter = (trust: TrustSummary): string =>
  `_Source: offline snapshot${trust.freshness.snapshotRefreshedAt ? ` · refreshed ${trust.freshness.snapshotRefreshedAt}` : ''}._`;
