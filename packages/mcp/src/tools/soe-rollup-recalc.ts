/**
 * Shared `post-save-rollup-recalc` phase composer for the two SOE tools
 * (`what_happens_on_save`, `order_of_execution`). Per the documented
 * Salesforce order of execution, when a child record is saved (insert,
 * update, delete, OR undelete — a rollup's underlying record set changes on
 * all four, unlike duplicate rules / validation which only evaluate on
 * insert/update) and it is the detail side of a master-detail relationship,
 * every Summary (roll-up summary) field on the PARENT that aggregates this
 * child object recalculates.
 *
 * The mapping is read from the `summaryForeignKey` property the CustomField
 * extractor now captures on `type: Summary` fields (R6-07): a dot-qualified
 * `{ChildObjectApiName}.{ChildFieldApiName}` string naming the master-detail
 * field on the CHILD that points back at the field's own (PARENT) object.
 * This module scans every Summary CustomField in the vault and keeps the
 * ones whose `summaryForeignKey` child-object prefix matches the object
 * being saved — there is no `parentOf`/`triggersOn`-style edge to walk
 * (R6-07 deliberately kept the CustomField extractor change to properties
 * only), so the match is a scan, not an edge traversal.
 *
 * **Cap, disclosed, deliberately ONE level.** Only the immediate parent's
 * rollups are surfaced. A grandparent whose OWN Summary field aggregates the
 * parent object is NOT walked — Salesforce's real order of execution does
 * cascade a parent's roll-up-triggered re-save up to a grandparent, but
 * re-entrant multi-level walks are the same no-re-entrancy boundary the rest
 * of this composition draws (workflow field-update re-triggering, time
 * triggers): expanding it here risks an unbounded walk on a deep
 * master-detail chain. Disclosed verbatim in the tool's `disclosure`.
 */

import type { ComponentId, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdgesForNodes, listNodesByType } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { dlrsRollupWriterDetail } from './dlrs-rollup-writers.js';
import { clampedNodeScanLimit, scanHitCap, scanTruncationNote } from './scan-cap.js';

/**
 * One parent Summary field whose value recalculates when the target child
 * object is saved. `fieldId` / `apiName` identify the rollup field itself
 * (a real `CustomField:{ParentObject}.{Field}` vault node); `parentObjectId`
 * is the object housing it; `summaryOperation` / `summarizedField` are
 * surfaced verbatim from the field's own properties (`summarizedField` is
 * `null` for a `count` operation, which has no source field).
 */
export interface RollupRecalcStep {
  readonly fieldId: ComponentId;
  readonly apiName: string;
  readonly parentObjectId: ComponentId;
  readonly summaryOperation: string | null;
  readonly summarizedField: string | null;
  /**
   * Absent = a native roll-up summary field. `dlrs` = a DLRS rollup definition
   * (`dlrs__LookupRollupSummary2` record, `definitionId`) recalculated by the
   * DLRS child trigger, not the platform rollup phase (WOW-3).
   */
  readonly engine?: 'dlrs';
  readonly definitionId?: ComponentId;
  readonly calculationMode?: string | null;
}

export interface RollupRecalcResult {
  readonly steps: readonly RollupRecalcStep[];
  /** True when the org-wide Summary-field scan hit the node-scan cap — see `scan-cap.ts`. */
  readonly scanTruncated: boolean;
}

const asNullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** The child-object api name a `summaryForeignKey` (`{Child}.{Field}`) names, or `null` if malformed. */
const childObjectOf = (summaryForeignKey: string): string | null => {
  const dot = summaryForeignKey.indexOf('.');
  if (dot <= 0) return null;
  return summaryForeignKey.slice(0, dot);
};

const toRollupStep = (field: Node): RollupRecalcStep | null => {
  if (field.parentId === null) return null;
  const foreignKey = asNullableString(field.properties['summaryForeignKey']);
  if (foreignKey === null) return null;
  return {
    fieldId: field.id,
    apiName: field.apiName,
    parentObjectId: field.parentId,
    summaryOperation: asNullableString(field.properties['summaryOperation']),
    summarizedField: asNullableString(field.properties['summarizedField']),
  };
};

/**
 * Find every parent Summary field that recalculates when
 * `childObjectApiName` is saved. Scans every `type: Summary` CustomField in
 * the vault (bounded by the shared node-scan cap — see `scan-cap.ts`) and
 * keeps the ones whose `summaryForeignKey` child-object prefix matches.
 * Deterministic order by `fieldId`.
 */
export const findRollupRecalcSteps = async (
  ctx: Context,
  childObjectApiName: string,
): Promise<Result<RollupRecalcResult, string>> => {
  const scanLimit = clampedNodeScanLimit();
  const summaryFieldsResult = await listNodesByType(ctx.graph, 'CustomField', {
    propertyStringEquals: { dataType: 'Summary' },
    limit: scanLimit,
  });
  if (!summaryFieldsResult.ok) return err(summaryFieldsResult.error.message);

  const steps: RollupRecalcStep[] = [];
  for (const field of summaryFieldsResult.value) {
    const foreignKey = asNullableString(field.properties['summaryForeignKey']);
    if (foreignKey === null) continue;
    if (childObjectOf(foreignKey) !== childObjectApiName) continue;
    const step = toRollupStep(field);
    if (step !== null) steps.push(step);
  }
  const dlrs = await findDlrsRollupRecalcSteps(ctx, childObjectApiName, scanLimit);
  if (!dlrs.ok) return dlrs;
  steps.push(...dlrs.value.steps);
  const key = (s: RollupRecalcStep): string => `${s.fieldId}|${s.definitionId ?? ''}`;
  steps.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

  return ok({
    steps,
    scanTruncated: scanHitCap(summaryFieldsResult.value.length, scanLimit) || dlrs.value.scanTruncated,
  });
};

/** `typeApiName` spellings a DLRS rollup definition record carries. */
const DLRS_TYPE_NAMES = ['dlrs__LookupRollupSummary2', 'dlrs__LookupRollupSummary2__mdt'] as const;

/**
 * ACTIVE DLRS rollups whose child object is `childObjectApiName` (WOW-3). A
 * DLRS rollup is not a Summary field, so the scan above never saw it and a
 * save on the child read "no rollup recalculation". Read from the extractor's
 * `dlrs-rollup` writesTo edges; an inactive definition recalculates nothing
 * and is left out.
 */
const findDlrsRollupRecalcSteps = async (
  ctx: Context,
  childObjectApiName: string,
  scanLimit: number,
): Promise<Result<RollupRecalcResult, string>> => {
  const ids: ComponentId[] = [];
  let scanTruncated = false;
  for (const typeApiName of DLRS_TYPE_NAMES) {
    const records = await listNodesByType(ctx.graph, 'CustomMetadataRecord', {
      propertyStringEquals: { typeApiName },
      limit: scanLimit,
    });
    if (!records.ok) return err(records.error.message);
    scanTruncated ||= scanHitCap(records.value.length, scanLimit);
    for (const n of records.value) ids.push(n.id);
  }
  if (ids.length === 0) return ok({ steps: [], scanTruncated });
  const edges = await listEdgesForNodes(ctx.graph, ids, { direction: 'out', edgeTypes: ['writesTo'] });
  if (!edges.ok) return err(edges.error.message);
  const steps: RollupRecalcStep[] = [];
  for (const [definitionId, out] of edges.value) {
    for (const edge of out) {
      const detail = dlrsRollupWriterDetail(edge);
      if (detail === undefined || !detail.runnable) continue;
      if (detail.rollup.childObject !== childObjectApiName) continue;
      const target = edge.toId.slice('CustomField:'.length);
      const dot = target.indexOf('.');
      if (!edge.toId.startsWith('CustomField:') || dot <= 0) continue;
      steps.push({
        fieldId: edge.toId,
        apiName: target,
        parentObjectId: `CustomObject:${target.slice(0, dot)}` as ComponentId,
        summaryOperation: detail.rollup.aggregateOperation,
        summarizedField: detail.rollup.fieldToAggregate,
        engine: 'dlrs',
        definitionId,
        calculationMode: detail.rollup.calculationMode,
      });
    }
  }
  return ok({ steps, scanTruncated });
};

/**
 * The one-line action description both SOE tools print for a rollup step. A
 * DLRS step says it runs from the DLRS child trigger (and in which mode), so it
 * is not read as the platform's own rollup phase.
 */
export const describeRollupRecalc = (rollup: RollupRecalcStep): string => {
  const base = `recalculates ${rollup.summaryOperation ?? 'unknown-operation'}(${rollup.summarizedField ?? 'record count'}) on ${rollup.parentObjectId}`;
  if (rollup.engine !== 'dlrs') return base;
  const mode = rollup.calculationMode ?? 'Realtime';
  const when = /^realtime$/i.test(mode)
    ? 'in the DLRS child trigger on this save, i.e. in the Apex trigger phase, not the platform roll-up phase (needs the dlrs trigger deployed on this object)'
    : /^process ?builder$/i.test(mode)
      ? 'on this save only if a Process Builder or Flow calls the DLRS invocable action for it (not modeled here)'
      : `in DLRS ${mode} mode (queued or on demand, not on this save)`;
  return `${base} — DLRS rollup ${rollup.definitionId ?? ''}, ${when}`;
};

/**
 * The disclosure appended to a SOE tool's `disclosure` when the org-wide
 * Summary-field scan behind {@link findRollupRecalcSteps} hit the node-scan
 * cap — the emitted `post-save-rollup-recalc` steps may be INCOMPLETE (an
 * aggregating parent past the cap would not be found). Shared so both SOE
 * tools word it identically.
 */
export const rollupScanTruncationNote = (): string =>
  scanTruncationNote(['CustomField (type: Summary)'], clampedNodeScanLimit());
