/**
 * sfi.record_creation_paths — "how do records of this object get created?"
 *
 * The Phase D record-creation trace. For an object, lists every automation that
 * INSERTS records of it (flows/apex whose `writesTo` edge is tagged
 * `operation: recordCreate`) plus the triggers that fire on it — so an admin
 * answering "how did this record get here?" sees the creation surface, not just
 * "what writes a field". Read-only, offline. Creators are FLOW record-creates
 * only: Apex DML inserts (`insert x;` static AND `Database.insert` dynamic) are
 * NOT modeled, so an object created only by Apex reports 0 creators.
 */

import type { Edge, McpError, McpResponse, TrustSummary } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { listEdges } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';

export const recordCreationPathsInputSchema = z.object({
  /** Object API name (e.g. `Case`) or canonical id (`CustomObject:Case`). */
  objectApiName: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
});
export type RecordCreationPathsInput = z.infer<typeof recordCreationPathsInputSchema>;

export interface CreationSource {
  readonly sourceId: string;
  readonly sourceType: string;
  readonly name: string;
  readonly confidence: string;
}
export interface RecordCreationPathsOutput {
  readonly objectApiName: string;
  readonly objectId: string;
  readonly creatorCount: number;
  readonly creators: readonly CreationSource[];
  /**
   * True when `creators` was cut at `limit` — `creatorCount` is still the FULL
   * count. No cursor: raise `limit` (max 500) to see the dropped tail.
   */
  readonly creatorsTruncated: boolean;
  readonly triggerCount: number;
  readonly triggers: readonly CreationSource[];
  /** True when `triggers` was cut at `limit` — `triggerCount` stays the full count. */
  readonly triggersTruncated: boolean;
  readonly trust: TrustSummary;
  readonly rendered: string;
}

const toSource = (id: string, confidence: string): CreationSource => {
  const idx = id.indexOf(':');
  return {
    sourceId: id,
    sourceType: idx > 0 ? id.slice(0, idx) : 'Unknown',
    name: idx > 0 ? id.slice(idx + 1) : id,
    confidence,
  };
};
const dedupe = (sources: readonly CreationSource[]): CreationSource[] => {
  const seen = new Set<string>();
  const out: CreationSource[] = [];
  for (const s of sources) {
    if (!seen.has(s.sourceId)) {
      seen.add(s.sourceId);
      out.push(s);
    }
  }
  return out;
};

export const recordCreationPathsHandler = async (
  ctx: Context,
  input: RecordCreationPathsInput,
): Promise<Result<McpResponse<RecordCreationPathsOutput>, McpError>> => {
  const objectId = input.objectApiName.includes(':')
    ? input.objectApiName
    : `CustomObject:${input.objectApiName}`;
  const objectApiName = objectId.slice(objectId.indexOf(':') + 1);
  const limit = input.limit ?? 100;

  const edgesResult = await listEdges(ctx.graph, objectId, { direction: 'in' });
  if (!edgesResult.ok) {
    return { ok: false, error: { kind: 'internal', message: edgesResult.error.message } };
  }
  const edges: readonly Edge[] = edgesResult.value;

  const creators = dedupe(
    edges
      .filter((e) => e.edgeType === 'writesTo' && e.properties['operation'] === 'recordCreate')
      .map((e) => toSource(e.fromId, e.confidence)),
  ).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const triggers = dedupe(
    edges.filter((e) => e.edgeType === 'triggersOn').map((e) => toSource(e.fromId, e.confidence)),
  ).sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  // Handler cap (P15 oversize-enumeration guard): hub objects can fan out —
  // slice both lists at `limit` but ALWAYS report the full counts and disclose
  // the cut. No cursor; the caller raises `limit` (max 500) to see the tail.
  const creatorsTruncated = creators.length > limit;
  const triggersTruncated = triggers.length > limit;

  const trust = offlineTrust(ctx, { status: summarizeCoverage(ctx.manifest).status });
  const creatorTable = mdTable(
    ['Creator', 'Type', 'Confidence'],
    creators.slice(0, limit).map((c) => [c.name, c.sourceType, c.confidence]),
  );
  const triggerTable = mdTable(
    ['Trigger', 'Type'],
    triggers.slice(0, limit).map((t) => [t.name, t.sourceType]),
  );
  const creatorTruncNote = creatorsTruncated
    ? `\n_Creator list truncated to ${limit} of ${creators.length} — raise \`limit\` (max 500) to see the rest._\n`
    : '';
  const triggerTruncNote = triggersTruncated
    ? `\n_Trigger list truncated to ${limit} of ${triggers.length} — raise \`limit\` (max 500) to see the rest._\n`
    : '';
  const rendered =
    `Records of \`${objectApiName}\` are inserted by **${creators.length}** Flow automation(s); ` +
    `**${triggers.length}** trigger(s) fire on it.\n\n` +
    (creators.length > 0 ? `### Creates records\n${creatorTable}\n${creatorTruncNote}\n` : '') +
    (triggers.length > 0 ? `### Triggers on save\n${triggerTable}\n${triggerTruncNote}\n` : '') +
    `_Offline static analysis surfaces **Flow** record-creates + triggers only. Apex DML inserts ` +
    `(\`insert x;\` static AND \`Database.insert\` dynamic) are NOT modeled, so an object created only ` +
    `by Apex reports **0 creators** — cross-check Apex (e.g. \`grep "new ${objectApiName}"\`) before ` +
    `concluding nothing creates it._`;

  return ok({
    data: {
      objectApiName,
      objectId,
      creatorCount: creators.length,
      creators: creators.slice(0, limit),
      creatorsTruncated,
      triggerCount: triggers.length,
      triggers: triggers.slice(0, limit),
      triggersTruncated,
      trust,
      rendered,
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
