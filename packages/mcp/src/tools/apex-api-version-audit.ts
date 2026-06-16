/**
 * sfi.apex_api_version_audit — Apex on stale API versions.
 *
 * Lists ApexClass + ApexTrigger nodes and reports their API-version
 * distribution, flagging components below a threshold (default 50). Old API
 * versions can pin deprecated runtime behavior and are a common deploy-rot
 * signal. Read-only, offline — reads the `apiVersion` already captured on each
 * node by the extractor (no live org, no re-retrieve).
 */

import type {
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';

const APEX_TYPES = ['ApexClass', 'ApexTrigger'] as const;
const DEFAULT_OLD_THRESHOLD = 50;
const PAGE = 500;
const MAX_PAGES = 40; // hard cap 20k components

export const apexApiVersionAuditInputSchema = z.object({
  /** Components with apiVersion < this are flagged "old" (default 50). */
  threshold: z.number().int().min(1).max(100).optional(),
  /** Max flagged components returned (default 100). */
  limit: z.number().int().min(1).max(500).optional(),
});
export type ApexApiVersionAuditInput = z.infer<typeof apexApiVersionAuditInputSchema>;

export interface ApexVersionEntry {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly apiVersion: number | null;
}
export interface ApexApiVersionAuditOutput {
  readonly threshold: number;
  readonly totalAnalyzed: number;
  readonly oldCount: number;
  readonly oldestVersion: number | null;
  /** apiVersion (or "unknown") -> count. */
  readonly distribution: Readonly<Record<string, number>>;
  readonly oldComponents: readonly ApexVersionEntry[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

const gatherAll = async (ctx: Context, type: 'ApexClass' | 'ApexTrigger'): Promise<Node[]> => {
  const out: Node[] = [];
  let offset = 0;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const r = await listNodesByType(ctx.graph, type, { limit: PAGE, offset });
    if (!r.ok) break;
    out.push(...r.value);
    if (r.value.length < PAGE) break;
    offset += PAGE;
  }
  return out;
};

const versionOf = (n: Node): number | null => {
  const v = (n as { apiVersion?: unknown }).apiVersion;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

export const apexApiVersionAuditHandler = async (
  ctx: Context,
  input: ApexApiVersionAuditInput,
): Promise<Result<McpResponse<ApexApiVersionAuditOutput>, McpError>> => {
  const threshold = input.threshold ?? DEFAULT_OLD_THRESHOLD;
  const limit = input.limit ?? 100;

  const entries: ApexVersionEntry[] = [];
  for (const type of APEX_TYPES) {
    for (const n of await gatherAll(ctx, type)) {
      entries.push({ id: n.id, name: n.apiName, type, apiVersion: versionOf(n) });
    }
  }

  const distribution: Record<string, number> = {};
  for (const e of entries) {
    const k = e.apiVersion === null ? 'unknown' : String(e.apiVersion);
    distribution[k] = (distribution[k] ?? 0) + 1;
  }

  const old = entries
    .filter((e): e is ApexVersionEntry & { apiVersion: number } => e.apiVersion !== null && e.apiVersion < threshold)
    .sort((a, b) => a.apiVersion - b.apiVersion);
  const oldestVersion = old.length > 0 ? old[0]!.apiVersion : null;
  const oldComponents = old.slice(0, limit);

  const trust = offlineTrust(ctx, { status: summarizeCoverage(ctx.manifest).status });
  const table = mdTable(
    ['Component', 'Type', 'API'],
    oldComponents.map((e) => [e.name, e.type, `v${e.apiVersion}`]),
  );
  const rendered =
    `**${old.length}** of ${entries.length} Apex components are on API < ${threshold}` +
    (oldestVersion !== null ? ` (oldest: v${oldestVersion})` : '') +
    `.\n\n${table}\n\n_Offline — old API versions can pin deprecated runtime behavior; verify before bumping._`;

  return ok({
    data: {
      threshold,
      totalAnalyzed: entries.length,
      oldCount: old.length,
      oldestVersion,
      distribution,
      oldComponents,
      trust,
      rendered,
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
