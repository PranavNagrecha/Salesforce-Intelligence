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
