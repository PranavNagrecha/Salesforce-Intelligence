/**
 * Shared `duplicate-rules` phase composer for the two SOE tools
 * (`what_happens_on_save`, `order_of_execution`). Duplicate rules run AFTER
 * before-triggers and custom validation, BEFORE the record is saved to the
 * database — per the documented Salesforce order of execution (step 7 of the
 * platform's own numbered list: system validation → before-save flows →
 * before triggers → validation rules → **duplicate rules** → save). A `Block`
 * action stops the save; `Allow`/`Alert`/`Report` do not.
 */

import type { ComponentId, ComponentType, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/** Allowed ComponentType set for a `fetchParentedFirers`-style DuplicateRule fetch. */
export const DUPLICATE_RULE_TYPES: ReadonlySet<ComponentType> = new Set([
  'DuplicateRule',
]);

/**
 * A resolved `duplicate-rules` phase entry — the DuplicateRule firer plus its
 * effective per-event behavior. `matchingRules` are the canonical
 * `MatchingRule:` ids the rule's `references` edges point at (the field +
 * method comparison recipe); `operations` is the rule's effective
 * `DuplicateRuleOperation` set for THIS event (`Allow`/`Block`/`Alert`/
 * `Report`, deduped); `blocksOnSave` is the derived "does this stop the save"
 * answer callers actually want.
 */
export interface DuplicateRuleStep {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly operations: readonly string[];
  readonly blocksOnSave: boolean;
  readonly matchingRules: readonly ComponentId[];
}

const toStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Resolve a DuplicateRule node's effective `DuplicateRuleOperation` set
 * (`Allow`/`Block`/`Alert`/`Report`) for a given DML event.
 *
 * Duplicate rules evaluate ONLY on insert/update — Salesforce does not run
 * them on delete/undelete — so this returns `[]` for those events, and the
 * caller EXCLUDES the rule from that event's phase (mirroring how
 * `workflowMatchesEvent`/`flowMatchesEvent` gate the other phases: a rule
 * that does not evaluate on an event is not a step on that event's chain).
 * `upsert` is the union of the insert + update operation sets (the platform
 * treats upsert as insert-or-update).
 *
 * `operationsOnInsert`/`operationsOnUpdate` (the modern, possibly-multi-value
 * arrays) are authoritative when non-empty. A rule extracted from an org that
 * only populated the deprecated single-value `actionOnInsert`/`actionOnUpdate`
 * (pre-Winter-'14 shape) falls back to that scalar so it is not silently
 * dropped — every real-vault sample seen carries a non-empty operations array
 * alongside a vestigial `actionOnInsert: 'Allow'`, but the fallback keeps an
 * older-shaped org honest too.
 */
export const resolveDuplicateRuleOperations = (
  node: Node,
  event: 'insert' | 'update' | 'upsert' | 'delete' | 'undelete',
): readonly string[] => {
  const insertOps = toStringArray(node.properties['operationsOnInsert']);
  const updateOps = toStringArray(node.properties['operationsOnUpdate']);
  const legacyInsert = node.properties['actionOnInsert'];
  const legacyUpdate = node.properties['actionOnUpdate'];
  const effectiveInsert =
    insertOps.length > 0
      ? insertOps
      : typeof legacyInsert === 'string'
        ? [legacyInsert]
        : [];
  const effectiveUpdate =
    updateOps.length > 0
      ? updateOps
      : typeof legacyUpdate === 'string'
        ? [legacyUpdate]
        : [];
  if (event === 'insert') return effectiveInsert;
  if (event === 'update') return effectiveUpdate;
  if (event === 'upsert') return [...new Set([...effectiveInsert, ...effectiveUpdate])];
  return [];
};

/**
 * Build the `duplicate-rules` phase entry for one DuplicateRule firer +
 * event. Returns `null` when the rule does not evaluate on this event
 * (`resolveDuplicateRuleOperations` returned `[]`) — the caller skips
 * emitting a step for it, exactly like the workflow/flow event gates.
 */
export const buildDuplicateRuleStep = async (
  ctx: Context,
  firer: Node,
  event: 'insert' | 'update' | 'upsert' | 'delete' | 'undelete',
): Promise<Result<DuplicateRuleStep | null, string>> => {
  const operations = resolveDuplicateRuleOperations(firer, event);
  if (operations.length === 0) return ok(null);
  const edgesResult = await listEdges(ctx.graph, firer.id, {
    direction: 'out',
    edgeType: 'references',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const matchingRules = [...edgesResult.value.map((e) => e.toId)].sort();
  return ok({
    componentId: firer.id,
    apiName: firer.apiName,
    operations,
    blocksOnSave: operations.includes('Block'),
    matchingRules,
  });
};
