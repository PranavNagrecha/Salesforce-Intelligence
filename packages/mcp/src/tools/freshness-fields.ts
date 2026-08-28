/**
 * Shared accessors for a node's freshness fields — `lastModifiedDate`,
 * `lastModifiedBy`, and `apiVersion`.
 *
 * **Why this exists.** The v0.1-v1.6 baseline writes these as legacy
 * top-level fields on the node (`lastModifiedDate: string | null`,
 * `lastModifiedBy: string | null`, `apiVersion: number | null`). v1.7's
 * Tooling API enricher writes a structured overlay under
 * `properties.lastModifiedDate`, `properties.lastModifiedBy: { id, name }`,
 * and `properties.apiVersion`. Every freshness-facing tool must read BOTH
 * sources with the SAME precedence (properties overlay first, legacy
 * field as fallback) or two tools reporting on the same node can disagree.
 *
 * `sfi.last_modified` and `sfi.changed_since` each held a private copy of
 * this precedence logic, kept in sync only by a JSDoc comment asserting
 * parity ("mirrors the equivalent helper in changed-since.ts") — the
 * house doctrine's R6 anti-pattern: a comment is not a guard. Centralising
 * the read here — the same shape as `field-properties.ts` in this shard —
 * removes the drift risk structurally instead of by convention.
 *
 * Note on `extractLastModifiedBy`'s contract: this module's version
 * returns `null` when NEITHER source carries a value (`sfi.last_modified`
 * distinguishes "we know nothing" from "we know an empty identity").
 * `sfi.changed_since` currently defaults to `{ id: '', name: '' }` at
 * that same site — callers migrating onto this module should coerce
 * `null` to that shape at the call site if they need the non-null
 * default, rather than changing this function's contract.
 */

/**
 * Extract the freshness `lastModifiedDate` for a node. Prefers
 * `properties.lastModifiedDate` (the v1.7 enricher's overlay) and falls
 * back to the legacy top-level `lastModifiedDate` field. Returns `null`
 * when neither source carries a value.
 */
export const extractLastModifiedDate = (
  legacy: string | null,
  properties: Readonly<Record<string, unknown>>,
): string | null => {
  const propsValue = properties['lastModifiedDate'];
  if (typeof propsValue === 'string' && propsValue.length > 0) {
    return propsValue;
  }
  if (typeof legacy === 'string' && legacy.length > 0) {
    return legacy;
  }
  return null;
};

/**
 * Extract the `lastModifiedBy.id` / `.name` pair from a node. Prefers
 * the v1.7 enricher's `properties.lastModifiedBy: { id, name }` overlay
 * and falls back to the legacy string-only top-level `lastModifiedBy`
 * field (treated as the id with an empty name). Returns `null` when
 * neither source carries a value.
 */
export const extractLastModifiedBy = (
  legacy: string | null,
  properties: Readonly<Record<string, unknown>>,
): { id: string; name: string } | null => {
  const propsValue = properties['lastModifiedBy'];
  if (propsValue !== undefined && propsValue !== null && typeof propsValue === 'object') {
    const obj = propsValue as { id?: unknown; name?: unknown };
    const id = typeof obj.id === 'string' ? obj.id : '';
    const name = typeof obj.name === 'string' ? obj.name : '';
    if (id.length > 0 || name.length > 0) {
      return { id, name };
    }
  }
  if (typeof legacy === 'string' && legacy.length > 0) {
    return { id: legacy, name: '' };
  }
  return null;
};

/**
 * Extract the API version for a node. Prefers `properties.apiVersion`
 * (the v1.7 enricher's overlay) and falls back to the legacy top-level
 * `apiVersion: number | null` field on the Node interface. Returns
 * `null` when neither source carries a value.
 */
export const extractApiVersion = (
  legacy: number | null,
  properties: Readonly<Record<string, unknown>>,
): number | null => {
  const propsValue = properties['apiVersion'];
  if (typeof propsValue === 'number' && Number.isFinite(propsValue)) {
    return propsValue;
  }
  if (typeof legacy === 'number' && Number.isFinite(legacy)) {
    return legacy;
  }
  return null;
};
