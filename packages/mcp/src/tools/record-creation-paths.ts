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
 *
 * **Active-status filter (honesty).** A creation path is a RUNTIME path, so an
 * inactive firer (a Draft/Obsolete Flow, an Inactive ApexTrigger) is NOT a live
 * way a record gets created — surfacing it as one invents current behavior from
 * dead metadata. `creators`/`triggers` therefore list only ACTIVE automation
 * (via the shared {@link isActiveSoeFirer} predicate the SOE tools use);
 * inactive firers are segregated into `inactiveCreators`/`inactiveTriggers` with
 * their inactive reason (e.g. `status: Obsolete`) rather than dropped silently.
 * A firer whose node is missing from the graph (a dangling edge) keeps the
 * conservative prior — treated as active and left in the main list.
 */

import type { Edge, McpError, McpResponse, Node, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByIds } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import {
  isActiveSoeFirer,
  recordInactiveSoeFirer,
  sortedInactiveConfigured,
  type InactiveConfiguredFirer,
} from './soe-active.js';

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
  /**
   * Flow record-creators configured on this object but INACTIVE (Draft/Obsolete
   * Flow) — excluded from `creators`/`creatorCount` because they do not run.
   * Segregated (not dropped) so "is this dead creator still around?" stays
   * answerable. Omitted when empty.
   */
  readonly inactiveCreators?: readonly InactiveConfiguredFirer[];
  /**
   * Triggers configured on this object but INACTIVE (Draft/Obsolete Flow,
   * Inactive ApexTrigger) — excluded from `triggers`/`triggerCount` because they
   * do not fire at save. Segregated (not dropped). Omitted when empty.
   */
  readonly inactiveTriggers?: readonly InactiveConfiguredFirer[];
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
  // RECORD-CREATION-PATHS-UNRESOLVED-OBJECT-SCOPE: `objectId` used to be glued
  // together from the raw `objectApiName` string with no existence check, so a
  // made-up or wrong-case object name silently matched zero edges and came
  // back `{creatorCount: 0, triggerCount: 0}` — an UNCHECKED zero a caller
  // could not tell apart from "nothing creates this object". Resolve + verify
  // via the shared object-scope resolver instead (the same one
  // flow_fault_audit / flow_bulkification_audit use): an unresolvable object
  // REFUSES with a named `invalid-query`, and a real object typed in the
  // wrong case is corrected to the vault's exact casing before anything is
  // queried.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input, {
    unhandledPrefix: 'refuse',
  });
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;
  if (scope === null) {
    // Unreachable given `objectApiName` is a required schema field — kept
    // explicit rather than silently falling through to an org-wide read this
    // tool has no concept of.
    return err({
      kind: 'invalid-query',
      message: 'name the object — pass `objectApiName`',
      path: 'objectApiName',
    });
  }
  const objectId = scope.componentId;
  const objectApiName = scope.object;
  const limit = input.limit ?? 100;

  const edgesResult = await listEdges(ctx.graph, objectId, { direction: 'in' });
  if (!edgesResult.ok) {
    return { ok: false, error: { kind: 'internal', message: edgesResult.error.message } };
  }
  const edges: readonly Edge[] = edgesResult.value;

  const allCreators = dedupe(
    edges
      .filter((e) => e.edgeType === 'writesTo' && e.properties['operation'] === 'recordCreate')
      .map((e) => toSource(e.fromId, e.confidence)),
  ).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const allTriggers = dedupe(
    edges.filter((e) => e.edgeType === 'triggersOn').map((e) => toSource(e.fromId, e.confidence)),
  ).sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  // Active-status filter (honesty): a creation path is a runtime path, so a
  // Draft/Obsolete Flow or an Inactive ApexTrigger is NOT a live way records
  // get created — surfacing it invents current behavior from dead metadata.
  // Batch-fetch the firer nodes once and partition each list into active (kept)
  // vs inactive (segregated into a disclosure list, keyed by id via the shared
  // `recordInactiveSoeFirer` collector). A firer id with no node row (dangling
  // edge — e.g. an ApexTrigger the refresh did not model) keeps the
  // conservative prior: treated as active and left in the main list, exactly
  // like `isActiveSoeFirer`'s missing-status fallback.
  const nodesResult = await listNodesByIds(
    ctx.graph,
    [...allCreators, ...allTriggers].map((s) => s.sourceId),
  );
  if (!nodesResult.ok) {
    return { ok: false, error: { kind: 'internal', message: nodesResult.error.message } };
  }
  const byId = new Map<string, Node>(nodesResult.value.map((n) => [n.id, n]));
  const inactiveCreatorCollector = new Map<string, InactiveConfiguredFirer>();
  const inactiveTriggerCollector = new Map<string, InactiveConfiguredFirer>();
  const partition = (
    sources: readonly CreationSource[],
    collector: Map<string, InactiveConfiguredFirer>,
  ): CreationSource[] =>
    sources.filter((s) => {
      const node = byId.get(s.sourceId);
      if (node === undefined) return true; // dangling edge → conservative prior
      if (isActiveSoeFirer(node)) return true;
      recordInactiveSoeFirer(collector, node);
      return false;
    });
  const creators = partition(allCreators, inactiveCreatorCollector);
  const triggers = partition(allTriggers, inactiveTriggerCollector);
  const inactiveCreators = sortedInactiveConfigured(inactiveCreatorCollector);
  const inactiveTriggers = sortedInactiveConfigured(inactiveTriggerCollector);

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
  // Inactive firers are runtime-dead — named separately, never mixed into the
  // live creation surface. One roster line per bucket keeps the omission honest
  // (an admin can still see the Obsolete Case email flow is around) without
  // reading it as current behavior.
  const inactiveNote =
    inactiveCreators.length > 0 || inactiveTriggers.length > 0
      ? `\n_Excluded as inactive (Draft/Obsolete Flow or Inactive trigger — configured but does not run): ` +
        [...inactiveCreators, ...inactiveTriggers]
          .map((i) => `${i.apiName} (${i.inactiveReason})`)
          .join(', ') +
        `._\n`
      : '';
  const rendered =
    `Records of \`${objectApiName}\` are inserted by **${creators.length}** active Flow automation(s); ` +
    `**${triggers.length}** active trigger(s) fire on it.\n\n` +
    (creators.length > 0 ? `### Creates records\n${creatorTable}\n${creatorTruncNote}\n` : '') +
    (triggers.length > 0 ? `### Triggers on save\n${triggerTable}\n${triggerTruncNote}\n` : '') +
    inactiveNote +
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
      ...(inactiveCreators.length > 0 ? { inactiveCreators } : {}),
      ...(inactiveTriggers.length > 0 ? { inactiveTriggers } : {}),
      trust,
      rendered,
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
