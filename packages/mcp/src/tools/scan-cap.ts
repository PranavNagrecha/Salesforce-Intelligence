/**
 * P12-HONESTY-scan-cap-disclosure — `listNodesByType` caps at a fixed ceiling,
 * so a per-type scan that comes back AT the cap may have more behind it. Tools
 * that enumerate grantors / assignments (`who_can_access_object`,
 * `layout_assignments`, `app_access`, peers) must disclose that they may have
 * stopped short (`scanTruncated` + a `boundaryNote`), never imply a complete
 * enumeration. The cap is env-overridable so a test can exercise the truncated
 * path without inserting 500+ nodes (a real org rarely has that many profiles).
 */

/** The per-type node-scan ceiling. `SFI_NODE_SCAN_LIMIT` overrides (tests). */
export const nodeScanLimit = (): number => {
  const v = Number(process.env['SFI_NODE_SCAN_LIMIT']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 500;
};

/** True when a per-type scan returned at/above the cap — possibly truncated. */
export const scanHitCap = (returnedCount: number, limit: number = nodeScanLimit()): boolean =>
  returnedCount >= limit;

/** The disclosure appended to a tool's `boundaryNote` when a scan was capped. */
export const scanTruncationNote = (truncatedTypes: readonly string[]): string =>
  `⚠️ Scan capped at ${nodeScanLimit()} nodes per type; ${[...new Set(truncatedTypes)].sort().join(' / ')} hit the cap, so this enumeration may be INCOMPLETE (scanTruncated) — narrow the query or raise SFI_NODE_SCAN_LIMIT.`;
