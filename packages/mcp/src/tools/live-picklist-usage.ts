/**
 * P6-live-picklist-usage — which picklist values are actually USED in production.
 *
 * The vault knows the values a picklist DEFINES (its value set); only the live
 * org knows which of those values records actually carry. This hybrid tool
 * fuses them: a live `GROUP BY` over the field's distribution, cross-referenced
 * against the vault's defined values to surface:
 *   - `usage` — each value with its live record count (top-N, ordered desc);
 *   - `unusedDefinedValues` — values the picklist defines that NO record uses
 *     (cleanup candidates / restrict-to-active candidates);
 *   - `undefinedUsedValues` — values records carry that the picklist no longer
 *     defines (legacy data, or `restricted=false` free entry).
 *
 * Honesty rules: counts only, never a record row. Honest empty when the object
 * has no records or the field is never populated. Without consent it returns
 * the defined values with a caveat (`offline_snapshot`) — the value set still
 * answers, the usage just isn't filled in. For a MultiselectPicklist a record
 * holds several values at once, so per-value counts OVERLAP (a record counts
 * toward every value in its combo); the note flags this.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { z } from 'zod';

import type { Context } from '../server.js';

import { readFieldDataType } from './field-properties.js';
import { hybridTrust, type HybridStaleness } from './hybrid-trust.js';
import { assertSoqlIdentifier, checkVaultStaleness, resolveLiveAccess } from './live-plane.js';
import { runLiveQuery } from './live-session.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { normalizePicklistValues } from './picklist-values.js';

const PICKLIST_TYPES = new Set<string>(['Picklist', 'MultiselectPicklist']);
const CUSTOM_FIELD_PREFIX = 'CustomField:';

export const livePicklistUsageInputSchema = z.object({
  fieldId: z.string().min(1),
  /** Cap on the distinct values returned in `usage` (default 50). */
  limit: z.number().int().min(1).max(200).optional(),
  liveEnabled: z.boolean().optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LivePicklistUsageInput = z.infer<typeof livePicklistUsageInputSchema>;

export interface PicklistValueUsage {
  readonly value: string;
  readonly count: number;
  /** True when the value is in the picklist's current value set. */
  readonly defined: boolean;
}

export interface LivePicklistUsageOutput {
  readonly fieldId: ComponentId;
  readonly objectApiName: string;
  readonly fieldApiName: string;
  readonly fieldType: string;
  readonly definedValues: readonly string[];
  readonly consentPresent: boolean;
  /** Per-value live usage, ordered by count desc. `null` when not consented. */
  readonly usage: readonly PicklistValueUsage[] | null;
  /** Defined values no record uses (only when consented). */
  readonly unusedDefinedValues: readonly string[];
  /** Values records carry that the picklist no longer defines. */
  readonly undefinedUsedValues: readonly string[];
  /** Records where the field is blank/null. `null` when not consented. */
  readonly blankCount: number | null;
  readonly totalRecords: number | null;
  /** True when there is no usage to report (no records / never populated). */
  readonly isEmpty: boolean;
  readonly multiselectNote?: string;
  readonly staleness?: HybridStaleness;
  readonly trust: TrustSummary;
  readonly interpretation: string;
}

/** Parse a `CustomField:{Object}.{Field}` id into object + field. */
const splitFieldId = (id: string): { object: string; field: string } | null => {
  if (!id.startsWith(CUSTOM_FIELD_PREFIX)) return null;
  const scoped = id.slice(CUSTOM_FIELD_PREFIX.length);
  const dot = scoped.indexOf('.');
  if (dot <= 0 || dot === scoped.length - 1) return null;
  return { object: scoped.slice(0, dot), field: scoped.slice(dot + 1) };
};

/**
 * The field's DEFINED value strings, read via the shared H10 normalizer so both
 * the legacy bare-string shape (old vaults) and the new object shape
 * `{value,isActive,…}` (re-extracted vaults) yield the value set — the old
 * `typeof === 'string'` filter emptied the defined set on a re-extracted vault.
 * Both active and inactive defined values are returned (an inactive value can
 * still appear in live data, so the cross-reference must know about it).
 */
const readDefinedValues = (node: Node): readonly string[] => {
  const normalized = normalizePicklistValues(node.properties['picklistValues']);
  return normalized === null ? [] : normalized.map((entry) => entry.value);
};

const offlineTrust = (ctx: Context): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: 'declared',
  freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
  completeness: { status: 'complete' },
  limitations: [
    'Defined picklist values only — live usage not included because the live plane is not enabled. Pass liveEnabled:true or grant consent to see which values records actually use.',
  ],
});

/**
 * `sfi.live_picklist_usage` — live value distribution for a picklist field,
 * cross-referenced against the vault's defined value set.
 */
export const livePicklistUsageHandler = async (
  ctx: Context,
  input: LivePicklistUsageInput,
  exec?: ExecCommand,
): Promise<Result<McpResponse<LivePicklistUsageOutput>, McpError>> => {
  const fieldId = input.fieldId as ComponentId;
  if (!fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${fieldId}'`,
      path: 'fieldId',
    });
  }

  const nodeResult = await getNodeById(ctx.graph, fieldId);
  if (!nodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      path: fieldId,
    });
  }
  const fieldNode = nodeResult.value;
  const fieldType = readFieldDataType(fieldNode);
  if (!PICKLIST_TYPES.has(fieldType)) {
    return err({
      kind: 'invalid-query',
      message: `field ${fieldId} has type '${fieldType}'; expected Picklist or MultiselectPicklist`,
      path: fieldId,
    });
  }
  const isMultiselect = fieldType === 'MultiselectPicklist';
  const definedValues = readDefinedValues(fieldNode);

  const parts = splitFieldId(fieldId);
  const objOk = parts !== null ? assertSoqlIdentifier(parts.object, 'object') : null;
  const fieldOk = parts !== null ? assertSoqlIdentifier(parts.field, 'field') : null;
  const objectApiName = parts?.object ?? '';
  const fieldApiName = parts?.field ?? fieldNode.apiName;

  const org = input.orgAlias?.trim() || ctx.manifest.sourceOrg;
  const access = await resolveLiveAccess(org, input.liveEnabled);

  // No consent (or an unparseable id) → defined values only, with the caveat.
  if (!access.allowed || objOk === null || fieldOk === null || !objOk.ok || !fieldOk.ok) {
    return ok({
      data: {
        fieldId,
        objectApiName,
        fieldApiName,
        fieldType,
        definedValues,
        consentPresent: access.allowed,
        usage: null,
        unusedDefinedValues: [],
        undefinedUsedValues: [],
        blankCount: null,
        totalRecords: null,
        isEmpty: false,
        trust: offlineTrust(ctx),
        interpretation: access.allowed
          ? `The field is a ${fieldType} defining ${definedValues.length} value(s); its object/field name could not be parsed for a live query.`
          : `The field is a ${fieldType} defining ${definedValues.length} value(s). Enable the live plane to see which values records actually use.`,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const limit = input.limit ?? 50;
  const soql = `SELECT ${fieldOk.value}, COUNT(Id) cnt FROM ${objOk.value} GROUP BY ${fieldOk.value} ORDER BY COUNT(Id) DESC LIMIT ${limit}`;
  const r = await runLiveQuery(org, ['data', 'query', '--query', soql], exec);
  if (!r.ok) return r;
  const records =
    (r.value.value as { result?: { records?: readonly Record<string, unknown>[] } }).result
      ?.records ?? [];

  // Aggregate per individual value (splitting MultiselectPicklist combos).
  const counts = new Map<string, number>();
  let blankCount = 0;
  for (const row of records) {
    const raw = row[fieldOk.value];
    const count = Number(row['cnt'] ?? row['expr0'] ?? 0);
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      blankCount += count;
      continue;
    }
    const values = isMultiselect ? String(raw).split(';').map((v) => v.trim()) : [String(raw)];
    for (const v of values) {
      if (v === '') continue;
      counts.set(v, (counts.get(v) ?? 0) + count);
    }
  }

  const definedSet = new Set(definedValues);
  const usage: PicklistValueUsage[] = [...counts.entries()]
    .map(([value, count]) => ({ value, count, defined: definedSet.has(value) }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
  const usedSet = new Set(counts.keys());
  const unusedDefinedValues = definedValues.filter((v) => !usedSet.has(v));
  const undefinedUsedValues = [...usedSet].filter((v) => !definedSet.has(v)).sort();
  const totalRecords = usage.reduce((s, u) => s + u.count, 0) + blankCount;
  const isEmpty = totalRecords === 0 || usage.length === 0;

  const stale = await checkVaultStaleness(org, ctx.manifest.refreshedAt, exec);
  const staleness: HybridStaleness | undefined = stale.ok
    ? {
        vaultStale: stale.value.vaultStale,
        driftCount: stale.value.driftCount,
        checkedTypes: stale.value.checkedTypes,
        warning: stale.value.warning,
      }
    : undefined;

  const interpretation = isEmpty
    ? `No records use this picklist (${totalRecords} record(s); ${blankCount} blank). All ${definedValues.length} defined value(s) are currently unused.`
    : `${usage.length} value(s) in use across ${totalRecords} record(s)` +
      (blankCount > 0 ? ` (${blankCount} blank)` : '') +
      `. ${unusedDefinedValues.length} defined value(s) are unused` +
      (undefinedUsedValues.length > 0
        ? `; ${undefinedUsedValues.length} value(s) in the data are not in the current value set.`
        : '.');

  const multiselectNote = isMultiselect
    ? 'MultiselectPicklist: a record can hold several values, so per-value counts OVERLAP (a record counts toward every value in its combo) and may sum to more than the record total.'
    : undefined;

  const trust = hybridTrust({
    vaultRefreshedAt: ctx.manifest.refreshedAt,
    liveQueriedAt: r.value.queriedAt,
    vaultConfidence: 'declared',
    completeness: { status: 'complete' },
    limitations: [
      ...(staleness !== undefined && staleness.warning !== null ? [staleness.warning] : []),
      ...(multiselectNote !== undefined ? [multiselectNote] : []),
    ],
    ...(staleness !== undefined ? { staleness } : {}),
  });

  return ok({
    data: {
      fieldId,
      objectApiName,
      fieldApiName,
      fieldType,
      definedValues,
      consentPresent: true,
      usage,
      unusedDefinedValues,
      undefinedUsedValues,
      blankCount,
      totalRecords,
      isEmpty,
      ...(multiselectNote !== undefined ? { multiselectNote } : {}),
      ...(staleness !== undefined ? { staleness } : {}),
      trust,
      interpretation,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
