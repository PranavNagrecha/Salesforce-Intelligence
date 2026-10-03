/**
 * Record-delete impact core (spec F7) — what happens to an object's children
 * when one of its records is deleted, and what server-side automation runs on
 * that delete. Shared by `sfi.record_delete_impact` and the Edit Block audit's
 * `DELETE_WITHOUT_GUARD` check.
 *
 * Children: every relationship field (`lookupTo` edge) that points at the
 * object, with the platform's delete behavior —
 *
 *   - master-detail             → DELETED_WITH_PARENT (platform rule)
 *   - lookup, Cascade           → DELETED_WITH_PARENT
 *   - lookup, Restrict          → BLOCKS_DELETE (the parent delete is refused)
 *   - lookup, SetNull           → ORPHANED (the child survives with a blank parent)
 *   - custom lookup, undeclared → ORPHANED via the documented default (SetNull),
 *                                 unless the lookup is required (then UNKNOWN)
 *   - standard relationship     → UNKNOWN: its behavior is defined per object by
 *                                 the platform, not by retrieved metadata
 *
 * A child that is deleted with its parent takes its own children with it, so
 * the walk follows DELETED_WITH_PARENT edges (bounded depth, cycle-safe).
 *
 * Guards: before/after-delete Apex triggers and delete-triggered flows on the
 * object. Validation rules never run on delete, and records removed by a
 * cascade do not fire their own delete triggers (Salesforce: "cascading delete
 * operations" do not invoke triggers), so only the deleted object's own
 * delete automation counts.
 */

import { readFile } from 'node:fs/promises';

import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByIds, listNodesByType } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

import { familyWasExtracted } from './absence-disclosure.js';
import { isActiveSoeFirer } from './soe-active.js';
import { findRollupRecalcSteps, type RollupRecalcStep } from './soe-rollup-recalc.js';

/** The text items of a list value (anything else holds none). */
const textItems = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** What deleting the parent does to one relationship field's records. */
export type DeleteEffect = 'ORPHANED' | 'DELETED_WITH_PARENT' | 'BLOCKS_DELETE' | 'UNKNOWN';

/** Where the delete behavior was read from. */
export type ConstraintSource = 'declared' | 'platform-rule' | 'platform-default' | 'not-in-metadata';

/** One relationship field pointing at a deleted object. */
export interface DeleteChild {
  /** The relationship field (`CustomField:<Child>.<Field>`). */
  readonly field: string;
  readonly childObject: string;
  /** The object whose delete reaches this field (the requested object at depth 1). */
  readonly parentObject: string;
  readonly relationshipType: string;
  readonly deleteConstraint: string | null;
  readonly constraintSource: ConstraintSource;
  readonly effect: DeleteEffect;
  readonly required: boolean;
  readonly confidence: 'declared' | 'parsed' | 'inferred';
  readonly unknownReason?: string;
  /** 1 = points at the requested object; 2+ = reached through a cascade. */
  readonly depth: number;
  /** The cascade path: relationship fields from the requested object down to `parentObject`. */
  readonly via: readonly string[];
  readonly sourcePath: string | null;
  /** Line of `<deleteConstraint>` (or of `<type>` for a master-detail) in the field file. */
  readonly line: number | null;
}

/** One automation that runs when a record of the object is deleted. */
export interface DeleteGuard {
  readonly componentId: string;
  readonly kind: 'apex-trigger' | 'record-triggered-flow';
  /** Apex: the delete events (`before delete`, `after delete`); Flow: its trigger type. */
  readonly when: readonly string[];
  readonly active: boolean;
  readonly sourcePath: string | null;
}

/** A roll-up summary that recalculates because records disappear. */
export interface DeleteRollup extends RollupRecalcStep {
  /** The object whose records disappear (the requested object, or a cascaded child). */
  readonly becauseOf: string;
}

/** The core result. */
export interface DeleteImpactCore {
  readonly objectId: string;
  readonly object: string;
  readonly children: readonly DeleteChild[];
  readonly guards: readonly DeleteGuard[];
  readonly inactiveGuards: readonly DeleteGuard[];
  /**
   * `none` — no delete automation on the object; `present` — at least one
   * active guard; `unknown` — an Apex trigger on the object whose events were
   * not recorded (an older vault), so a delete trigger cannot be ruled out.
   */
  readonly guardStatus: 'none' | 'present' | 'unknown';
  /** Active validation rules on the object — listed because they do NOT run on delete. */
  readonly validationRules: number;
  readonly rollups: readonly DeleteRollup[];
  readonly rollupScanTruncated: boolean;
  /** True when the cascade walk stopped at {@link MAX_CASCADE_DEPTH} with more to follow. */
  readonly cascadeTruncated: boolean;
}

/** How deep the cascade walk follows DELETED_WITH_PARENT edges. */
export const MAX_CASCADE_DEPTH = 4;

const DELETE_EVENTS = new Set(['before delete', 'after delete']);

const apiNameOf = (id: string): string => id.slice(id.indexOf(':') + 1);

/** Read `<deleteConstraint>` (and the line it sits on) from the field file. */
const readConstraintFromSource = async (
  ctx: Context,
  node: Node,
): Promise<{ constraint: string | null; line: number | null; typeLine: number | null }> => {
  if (node.sourcePath === null || node.sourcePath.length === 0) return { constraint: null, line: null, typeLine: null };
  let text: string;
  try {
    text = await readFile(resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath), 'utf-8');
  } catch {
    return { constraint: null, line: null, typeLine: null };
  }
  const lines = text.split('\n');
  let constraint: string | null = null;
  let line: number | null = null;
  let typeLine: number | null = null;
  lines.forEach((l, i) => {
    const m = /<deleteConstraint>\s*([A-Za-z]+)\s*<\/deleteConstraint>/.exec(l);
    if (m !== null && line === null) {
      constraint = m[1] ?? null;
      line = i + 1;
    }
    if (typeLine === null && /<type>\s*MasterDetail\s*<\/type>/.test(l)) typeLine = i + 1;
  });
  return { constraint, line, typeLine };
};

const effectOf = (
  field: Node,
  relationshipType: string,
  constraint: string | null,
): Pick<DeleteChild, 'effect' | 'constraintSource' | 'confidence' | 'unknownReason'> => {
  if (relationshipType === 'MasterDetail') {
    return { effect: 'DELETED_WITH_PARENT', constraintSource: 'platform-rule', confidence: 'declared' };
  }
  if (constraint !== null) {
    const c = constraint.toLowerCase();
    if (c === 'cascade') return { effect: 'DELETED_WITH_PARENT', constraintSource: 'declared', confidence: 'declared' };
    if (c === 'restrict') return { effect: 'BLOCKS_DELETE', constraintSource: 'declared', confidence: 'declared' };
    if (c === 'setnull') return { effect: 'ORPHANED', constraintSource: 'declared', confidence: 'declared' };
    return {
      effect: 'UNKNOWN',
      constraintSource: 'declared',
      confidence: 'declared',
      unknownReason: `unrecognised deleteConstraint '${constraint}'`,
    };
  }
  if (!field.apiName.endsWith('__c')) {
    return {
      effect: 'UNKNOWN',
      constraintSource: 'not-in-metadata',
      confidence: 'inferred',
      unknownReason: 'a standard relationship: what the platform does to these records on delete is defined per object, not in the retrieved metadata',
    };
  }
  if (field.properties['required'] === true) {
    return {
      effect: 'UNKNOWN',
      constraintSource: 'not-in-metadata',
      confidence: 'inferred',
      unknownReason: 'a required lookup cannot be cleared, so it must be Restrict or Cascade, but the retrieved metadata declares neither',
    };
  }
  return { effect: 'ORPHANED', constraintSource: 'platform-default', confidence: 'parsed' };
};

/**
 * Compute the delete impact of `objectApiName` (which must exist in the vault).
 * Deterministic: children sorted by depth then field id; guards by id.
 */
export const computeDeleteImpact = async (
  ctx: Context,
  objectApiName: string,
): Promise<Result<DeleteImpactCore, { message: string }>> => {
  const objectId = `CustomObject:${objectApiName}`;
  const children: DeleteChild[] = [];
  const visited = new Set<string>([objectApiName]);
  let frontier: { object: string; via: readonly string[] }[] = [{ object: objectApiName, via: [] }];
  let cascadeTruncated = false;
  for (let depth = 1; frontier.length > 0; depth += 1) {
    if (depth > MAX_CASCADE_DEPTH) {
      cascadeTruncated = true;
      break;
    }
    const next: { object: string; via: readonly string[] }[] = [];
    for (const parent of frontier) {
      const inbound = await listEdges(ctx.graph, `CustomObject:${parent.object}` as ComponentId, { direction: 'in', edgeType: 'lookupTo' });
      if (!inbound.ok) return { ok: false, error: { message: inbound.error.message } };
      const edges = [...inbound.value].sort((a, b) => (a.fromId < b.fromId ? -1 : a.fromId > b.fromId ? 1 : 0));
      const fieldNodes = await listNodesByIds(ctx.graph, edges.map((e) => e.fromId as ComponentId));
      if (!fieldNodes.ok) return { ok: false, error: { message: fieldNodes.error.message } };
      const byId = new Map(fieldNodes.value.map((n) => [n.id, n]));
      const seenField = new Set<string>();
      for (const edge of edges) {
        if (seenField.has(edge.fromId)) continue;
        seenField.add(edge.fromId);
        const field = byId.get(edge.fromId);
        if (field === undefined || field.type !== 'CustomField') continue;
        const relationshipType = String(edge.properties['relationshipType'] ?? field.properties['dataType'] ?? 'Lookup');
        const fromSource = await readConstraintFromSource(ctx, field);
        const declared =
          (typeof edge.properties['deleteConstraint'] === 'string' ? (edge.properties['deleteConstraint'] as string) : null) ??
          (typeof field.properties['deleteConstraint'] === 'string' ? (field.properties['deleteConstraint'] as string) : null) ??
          fromSource.constraint;
        const childObject = field.parentId === null ? apiNameOf(field.id).split('.')[0] ?? '' : apiNameOf(field.parentId);
        const e = effectOf(field, relationshipType, relationshipType === 'MasterDetail' ? null : declared);
        children.push({
          field: field.id,
          childObject,
          parentObject: parent.object,
          relationshipType,
          deleteConstraint: relationshipType === 'MasterDetail' ? null : declared,
          ...e,
          required: field.properties['required'] === true,
          depth,
          via: parent.via,
          sourcePath: field.sourcePath,
          line: relationshipType === 'MasterDetail' ? fromSource.typeLine : fromSource.line,
        });
        if (e.effect === 'DELETED_WITH_PARENT' && !visited.has(childObject)) {
          visited.add(childObject);
          next.push({ object: childObject, via: [...parent.via, field.id] });
        }
      }
    }
    frontier = next;
  }
  children.sort((a, b) => a.depth - b.depth || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

  // --- guards ------------------------------------------------------------------
  const trig = await listEdges(ctx.graph, objectId as ComponentId, { direction: 'in', edgeType: 'triggersOn' });
  if (!trig.ok) return { ok: false, error: { message: trig.error.message } };
  const firers = await listNodesByIds(ctx.graph, [...new Set(trig.value.map((e) => e.fromId as ComponentId))]);
  if (!firers.ok) return { ok: false, error: { message: firers.error.message } };
  const firerById = new Map(firers.value.map((n) => [n.id, n]));
  const guards: DeleteGuard[] = [];
  const inactiveGuards: DeleteGuard[] = [];
  let eventsMissing = false;
  for (const edge of [...trig.value].sort((a: Edge, b: Edge) => (a.fromId < b.fromId ? -1 : 1))) {
    const node = firerById.get(edge.fromId);
    const active = node === undefined ? true : isActiveSoeFirer(node);
    let guard: DeleteGuard | null = null;
    if (edge.fromId.startsWith('ApexTrigger:')) {
      // A trigger edge that never recorded its events cannot rule a delete
      // trigger out: that is unknown, not "no delete trigger".
      if (!familyWasExtracted(edge.properties, 'events')) {
        if (active) eventsMissing = true;
        continue;
      }
      const onDelete = textItems(edge.properties['events']).filter((x) => DELETE_EVENTS.has(x.toLowerCase()));
      if (onDelete.length > 0) guard = { componentId: edge.fromId, kind: 'apex-trigger', when: onDelete, active, sourcePath: node?.sourcePath ?? null };
    } else if (edge.fromId.startsWith('Flow:')) {
      if (edge.properties['recordTriggerType'] === 'Delete') {
        guard = {
          componentId: edge.fromId,
          kind: 'record-triggered-flow',
          when: [String(edge.properties['triggerType'] ?? 'RecordBeforeDelete')],
          active,
          sourcePath: node?.sourcePath ?? null,
        };
      }
    }
    if (guard === null) continue;
    (active ? guards : inactiveGuards).push(guard);
  }
  const guardStatus: DeleteImpactCore['guardStatus'] = guards.length > 0 ? 'present' : eventsMissing ? 'unknown' : 'none';

  const vrs = await listNodesByType(ctx.graph, 'ValidationRule', { parentId: objectId as ComponentId, limit: 500 });
  const validationRules = vrs.ok ? vrs.value.filter((n) => isActiveSoeFirer(n)).length : 0;

  // --- roll-ups -------------------------------------------------------------------
  const deletedObjects = [objectApiName, ...children.filter((c) => c.effect === 'DELETED_WITH_PARENT').map((c) => c.childObject)];
  const deletedSet = new Set(deletedObjects);
  const rollups: DeleteRollup[] = [];
  let rollupScanTruncated = false;
  for (const obj of [...new Set(deletedObjects)]) {
    const r = await findRollupRecalcSteps(ctx, obj);
    if (!r.ok) return { ok: false, error: { message: r.error } };
    rollupScanTruncated ||= r.value.scanTruncated;
    for (const step of r.value.steps) {
      // A roll-up on an object that is itself deleted in this cascade is gone, not recalculated.
      if (deletedSet.has(apiNameOf(step.parentObjectId))) continue;
      rollups.push({ ...step, becauseOf: obj });
    }
  }
  rollups.sort((a, b) => (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : a.becauseOf.localeCompare(b.becauseOf)));

  return ok({
    objectId,
    object: objectApiName,
    children,
    guards,
    inactiveGuards,
    guardStatus,
    validationRules,
    rollups,
    rollupScanTruncated,
    cascadeTruncated,
  });
};
