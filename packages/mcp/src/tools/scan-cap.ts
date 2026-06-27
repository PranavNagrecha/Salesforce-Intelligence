/**
 * P12-HONESTY-scan-cap-disclosure — `listNodesByType` caps at a fixed ceiling,
 * so a per-type scan that comes back AT the cap may have more behind it. Tools
 * that enumerate grantors / assignments (`who_can_access_object`,
 * `layout_assignments`, `app_access`, peers) must disclose that they may have
 * stopped short (`scanTruncated` + a `boundaryNote`), never imply a complete
 * enumeration. The cap is env-overridable so a test can exercise the truncated
 * path without inserting 500+ nodes (a real org rarely has that many profiles).
 */

/**
 * The graph layer's hard ceiling on a single `listNodesByType` page
 * (`LIST_MAX_LIMIT`). A `limit` over this is REJECTED with a `query-failed`
 * error, so every scan-cap caller must clamp `nodeScanLimit()` to it via
 * {@link clampedNodeScanLimit} before passing it to the graph.
 */
export const NODE_SCAN_HARD_CAP = 500;

/**
 * The per-type node-scan ceiling, as configured. `SFI_NODE_SCAN_LIMIT`
 * overrides (tests / operators). NOTE: this is UNCLAMPED — an operator can set
 * it above {@link NODE_SCAN_HARD_CAP}. Callers that feed it to
 * `listNodesByType` MUST use {@link clampedNodeScanLimit} instead, or the graph
 * rejects the over-limit page (CR-RV10).
 */
export const nodeScanLimit = (): number => {
  const v = Number(process.env['SFI_NODE_SCAN_LIMIT']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 500;
};

/**
 * The per-type scan limit actually safe to pass to `listNodesByType` — the
 * configured {@link nodeScanLimit} clamped to {@link NODE_SCAN_HARD_CAP}
 * (CR-RV10). Using this everywhere a scan fetch happens means an operator who
 * sets `SFI_NODE_SCAN_LIMIT > 500` gets a 500-row scan (cursor pages the rest)
 * rather than a hard `internal` error.
 */
export const clampedNodeScanLimit = (): number =>
  Math.min(nodeScanLimit(), NODE_SCAN_HARD_CAP);

/**
 * Hard ceiling on the TOTAL nodes a multi-window full scan will walk per type,
 * across all its windows. A B3 tool that scans a whole ComponentType by paging
 * `listNodesByType` with an advancing SQL `OFFSET` (to reach node 501+ that a
 * single capped page can't) bounds the walk here so a pathological type can't
 * make one request scan unboundedly. Generous (the CI scale budget is 10k
 * nodes); a type past this still discloses `scanTruncated`.
 */
export const FULL_SCAN_MAX_NODES = 20_000;

/** True when a per-type scan returned at/above the cap — possibly truncated. */
export const scanHitCap = (
  returnedCount: number,
  limit: number = clampedNodeScanLimit(),
): boolean => returnedCount >= limit;

/**
 * The disclosure appended to a tool's `boundaryNote` when a scan was capped.
 * `effectiveLimit` is the number of nodes ACTUALLY fetched per page — pass the
 * clamped value the tool used (`clampedNodeScanLimit()`), NOT the raw
 * `nodeScanLimit()`, so the disclosed figure matches the real fetch even when
 * an operator set `SFI_NODE_SCAN_LIMIT` above the hard cap (CR-RV10 honesty).
 * Defaults to `clampedNodeScanLimit()` for callers that fetched at the clamp.
 */
export const scanTruncationNote = (
  truncatedTypes: readonly string[],
  effectiveLimit: number = clampedNodeScanLimit(),
): string =>
  `⚠️ Scan capped at ${effectiveLimit} nodes per type; ${[...new Set(truncatedTypes)].sort().join(' / ')} hit the cap, so this enumeration may be INCOMPLETE (scanTruncated) — narrow the query, page with the returned cursor, or raise SFI_NODE_SCAN_LIMIT.`;
