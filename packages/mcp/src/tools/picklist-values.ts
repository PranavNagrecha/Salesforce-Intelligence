/**
 * Shared normalizer for a CustomField node's `properties.picklistValues`
 * across the MCP picklist consumers (explain_field, field_meaning,
 * live_picklist_usage).
 *
 * BACK-COMPAT (H10): `properties.picklistValues` changed from a bare `string[]`
 * (pre-CR-10 vaults) to an object `Array<{value,isActive,label?,default?}>`
 * (re-extracted vaults). The three consumers each previously did a
 * `typeof entry === 'string'` filter that SILENTLY DROPPED object entries — so
 * on a re-extracted vault they reported ZERO picklist values for affected
 * fields (worse than a crash). This normalizer tolerates BOTH shapes:
 *
 *   - a bare string element  → an ACTIVE value `{value, isActive: true}`
 *   - an object element       → carries explicit `isActive`; an object whose
 *                               `isActive` is absent is treated as ACTIVE
 *
 * The universal rule "absent/string ⇒ active" means old vaults never crash and
 * never under-report (string ⇒ active), and new vaults are never silently
 * dropped. Inactive values are RETAINED so callers can mark them
 * retained-but-not-selectable; existing records may still hold them.
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { getNodeById, listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/** One normalized picklist value. `label` / `default` carried when present. */
export interface NormalizedPicklistValue {
  readonly value: string;
  readonly isActive: boolean;
  readonly label?: string;
  readonly default?: boolean;
}

/**
 * Normalize a single `picklistValues` element. Returns `null` for an
 * empty/unusable entry (empty value string, or an object with no string
 * `value`/`fullName`) so callers can skip it rather than emit a blank row.
 */
export const normalizePicklistValue = (
  entry: unknown,
): NormalizedPicklistValue | null => {
  if (typeof entry === 'string') {
    return entry.length > 0 ? { value: entry, isActive: true } : null;
  }
  if (typeof entry !== 'object' || entry === null) return null;
  const obj = entry as Record<string, unknown>;
  const value =
    typeof obj['value'] === 'string'
      ? obj['value']
      : typeof obj['fullName'] === 'string'
        ? (obj['fullName'] as string)
        : '';
  if (value.length === 0) return null;
  // absent isActive ⇒ active (true); explicit false ⇒ inactive.
  const isActive = obj['isActive'] === false ? false : true;
  const label = typeof obj['label'] === 'string' ? obj['label'] : undefined;
  const out: NormalizedPicklistValue = { value, isActive };
  return {
    ...out,
    ...(label !== undefined ? { label } : {}),
    ...(typeof obj['default'] === 'boolean' ? { default: obj['default'] } : {}),
  };
};

/**
 * Normalize a raw `properties.picklistValues` value. Returns `null` when the
 * property is absent or not an array (preserving the "this is not a picklist /
 * no inline values" signal); otherwise returns the normalized entries (which
 * may be an empty array for a real zero-value inline definition).
 */
export const normalizePicklistValues = (
  raw: unknown,
): readonly NormalizedPicklistValue[] | null => {
  if (!Array.isArray(raw)) return null;
  const out: NormalizedPicklistValue[] = [];
  for (const entry of raw) {
    const normalized = normalizePicklistValue(entry);
    if (normalized !== null) out.push(normalized);
  }
  return out;
};


/**
 * For a GlobalValueSet-driven picklist (inline values null), follow the
 * field's outgoing `usesValueSet` edge to the GlobalValueSet node and return
 * its declared `properties.values` (P14-USAGE-gvs-edge — the edge and the
 * values both land on vaults refreshed at 0.1.10+). Returns `null` when the
 * edge or the target node is absent (pre-0.1.10 vault, or the value set was
 * not retrieved) — the caller falls back to the honesty note, and must NOT
 * read that `null` as "this field has no values".
 *
 * CR-10b: the GlobalValueSet extractor now emits the same H10 object shape
 * `{value, isActive, label?, default?}` as the CustomField inline picklist
 * reader, with an honestly-captured `isActive` (a deactivated GVS value is
 * RETAINED, not filtered — see `global-value-set.ts`). Routing through the
 * shared `normalizePicklistValues` gets that shape for free AND stays
 * backward-compatible with a pre-CR-10b vault's bare-string `values` (each
 * string normalizes to `{value, isActive: true}`), so an un-refreshed vault
 * degrades to the old behavior instead of returning nothing.
 *
 * Lifted here from `explain-field.ts` (where it was private) so
 * `what_if_remove_picklist_value` can check a caller-supplied value against
 * the DECLARED value set instead of rendering a destructive verdict for a
 * value the field does not have. One reader, two callers.
 */
export const resolveGlobalValueSetValues = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<{
  values: readonly NormalizedPicklistValue[];
  valueSetId: string;
} | null> => {
  const edgesRes = await listEdges(ctx.graph, fieldId, { direction: 'out' });
  if (!edgesRes.ok) return null;
  const edge = edgesRes.value.find((e) => e.edgeType === 'usesValueSet');
  if (edge === undefined) return null;
  const gvsRes = await getNodeById(ctx.graph, edge.toId);
  if (!gvsRes.ok || gvsRes.value === null) return null;
  const normalized = normalizePicklistValues(gvsRes.value.properties['values']);
  if (normalized === null) return null;
  return { values: normalized, valueSetId: edge.toId };
};
