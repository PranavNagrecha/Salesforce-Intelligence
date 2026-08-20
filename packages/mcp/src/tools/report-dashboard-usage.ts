/**
 * Shared helper for report / dashboard field-usage signals.
 *
 * The refresh folds each report/dashboard's field usage onto the referenced
 * `CustomField` as the `usedInReport` / `usedInDashboard` boolean properties
 * (see the CLI's `applyReportDashboardPersistence`). Because that usage is a
 * node *property* rather than an incoming edge, every edge-walking field tool
 * (`field_360`, `find_field_anywhere`, `safe_to_delete_field`,
 * `unused_fields_deep`, …) must read it explicitly. This module centralizes
 * that read + the honesty caveat.
 *
 * REPORT-DASHBOARD-GRAPH-PERSISTENCE: the same pass ALSO persists the
 * Report/Dashboard nodes themselves (redacted through a property allow-list,
 * capped per type), which it previously deleted. So the richer report shape
 * R6-24 parses — filter criteria (field/operator/value-PRESENCE, never the
 * literal), `booleanFilter`, groupings, buckets, crossFilters, chart, format,
 * plus `fieldRefs` — now reaches the graph, along with
 * `report -> source object / report type` and `dashboard -> component report`
 * edges. `Report:{Folder}/{Name}` is an inspectable component.
 *
 * What it deliberately does NOT persist is the analytics -> `CustomField`
 * edge layer: measured at real-org scale (4,277 reports) those were 64,155 of
 * 68,513 rows — 94% — for an answer THESE PROPERTIES already give. So the
 * folded properties remain the AUTHORITY for the field-side question, and are
 * what these tools must cite: the fold covers every EXTRACTED report, the node
 * set is capped, and an edge layer under a cap would answer "how many things
 * reference this field" differently for two identical fields depending on
 * where their report's name sorted.
 *
 * Report filter LITERALS never reach the graph or the rendered Markdown (see
 * `PERSISTED_REPORT_PROPERTY_KEYS` in the CLI), so "what VALUE does this
 * report filter for" stays a permanent `dataNotAvailable` boundary for every
 * tool — by design, not by omission. (Scope note: the raw retrieved XML under
 * `org-kb/source/` is untouched by that redaction and still contains the
 * literals; no tool reads it, but "never persisted anywhere" would overclaim.)
 *
 * Finding #36: "which reports break if I change this field" was structurally
 * unanswerable from the boolean alone — it says "used in a report" but never
 * WHICH one. The fold ALSO stamps a capped, sorted list of the referencing
 * report/dashboard api-names (`usedInReports` / `usedInDashboards`, first 50)
 * plus a truncation total (`usedInReportsTruncated` /
 * `usedInDashboardsTruncated`) when the field is referenced by more than the
 * cap. `reportDashboardUsageDetail` reads that richer shape;
 * `reportDashboardUsage` stays as the boolean-only read for existing callers
 * (back-compat).
 */

import type { Node } from '@sf-intelligence/contracts';

export interface ReportDashboardUsage {
  readonly usedInReport: boolean;
  readonly usedInDashboard: boolean;
}

/** Read the folded report/dashboard usage flags off a CustomField node. */
export const reportDashboardUsage = (node: Node): ReportDashboardUsage => ({
  usedInReport: node.properties['usedInReport'] === true,
  usedInDashboard: node.properties['usedInDashboard'] === true,
});

/**
 * Finding #36: the capped, named report/dashboard usage detail — which
 * specific reports/dashboards reference this field, not just "a report".
 */
export interface ReportDashboardUsageDetail extends ReportDashboardUsage {
  /** Capped (first 50), sorted api-names of referencing reports. */
  readonly reportNames: readonly string[];
  /** True total when `reportNames` was truncated by the fold-time cap; absent otherwise. */
  readonly reportsTruncatedTotal?: number;
  /** Capped (first 50), sorted api-names of referencing dashboards. */
  readonly dashboardNames: readonly string[];
  /** True total when `dashboardNames` was truncated by the fold-time cap; absent otherwise. */
  readonly dashboardsTruncatedTotal?: number;
}

/** Read a `string[]` node property, tolerating absence/malformed data (never throw on a stale vault). */
const readStringArrayProperty = (node: Node, key: string): readonly string[] => {
  const v = node.properties[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

/** Read a numeric node property, tolerating absence/malformed data. */
const readNumberProperty = (node: Node, key: string): number | undefined => {
  const v = node.properties[key];
  return typeof v === 'number' ? v : undefined;
};

/**
 * Read the folded report/dashboard usage NAMES (Finding #36) off a
 * `CustomField` node — the capped list produced by
 * `applyReportDashboardPersistence`, plus the true total when truncated.
 * A vault refreshed before this property existed simply has empty name
 * arrays even when the boolean flags are `true` — callers should fall back
 * to the boolean-only "used in a report" phrasing in that case (see
 * `field-360.ts`'s boundary construction) rather than treating an empty
 * list as "not truncated, zero reports".
 */
export const reportDashboardUsageDetail = (node: Node): ReportDashboardUsageDetail => {
  const reportsTruncatedTotal = readNumberProperty(node, 'usedInReportsTruncated');
  const dashboardsTruncatedTotal = readNumberProperty(node, 'usedInDashboardsTruncated');
  return {
    ...reportDashboardUsage(node),
    reportNames: readStringArrayProperty(node, 'usedInReports'),
    ...(reportsTruncatedTotal !== undefined ? { reportsTruncatedTotal } : {}),
    dashboardNames: readStringArrayProperty(node, 'usedInDashboards'),
    ...(dashboardsTruncatedTotal !== undefined ? { dashboardsTruncatedTotal } : {}),
  };
};

/**
 * True when the field is used by at least one report column / filter or a
 * dashboard component (per the folded `--with-reports` signal).
 */
export const isUsedInReportOrDashboard = (node: Node): boolean => {
  const u = reportDashboardUsage(node);
  return u.usedInReport || u.usedInDashboard;
};

/**
 * Format one family clause for "which reports/dashboards" prose.
 * When the capped name list is empty (pre-Finding-#36 vault), returns the
 * bare label so callers keep the boolean-only phrasing.
 */
export const formatNamedUsageClause = (
  label: string,
  names: readonly string[],
  truncatedTotal: number | undefined,
): string => {
  if (names.length === 0) return label;
  const truncationNote =
    truncatedTotal !== undefined
      ? `, +${truncatedTotal - names.length} more beyond the 50-name cap`
      : '';
  return `${label} (${names.join(', ')}${truncationNote})`;
};

/**
 * R6-24-WIRE / Finding #36: evidence lines for delete-proposal XML comments
 * that NAME the reports/dashboards a field deletion would break — not just
 * the folded boolean. Returns `[]` when the field has no folded usage.
 *
 * - Names present → `would break report(s) (A, B) and dashboard(s) (C)`.
 * - Boolean only (pre-#36 vault) → discloses that names need a re-refresh.
 */
export const formatReportDashboardBreakEvidence = (
  detail: ReportDashboardUsageDetail,
  opts?: { readonly fieldId?: string },
): readonly string[] => {
  if (!detail.usedInReport && !detail.usedInDashboard) return [];
  const where = [
    detail.usedInReport
      ? formatNamedUsageClause(
          'report(s)',
          detail.reportNames,
          detail.reportsTruncatedTotal,
        )
      : null,
    detail.usedInDashboard
      ? formatNamedUsageClause(
          'dashboard(s)',
          detail.dashboardNames,
          detail.dashboardsTruncatedTotal,
        )
      : null,
  ].filter((x): x is string => x !== null);
  const prefix = opts?.fieldId !== undefined ? `${opts.fieldId} — ` : '';
  const hasNames =
    detail.reportNames.length > 0 || detail.dashboardNames.length > 0;
  if (!hasNames) {
    return [
      `${prefix}would break folded report/dashboard usage (boolean only — names not in vault; re-run \`sfi refresh\` / \`sfi refresh --with-reports\` to populate)`,
    ];
  }
  return [`${prefix}would break ${where.join(' and ')}`];
};

/**
 * Honesty caveat surfaced by field tools when report/dashboard usage is NOT in
 * the vault. Reports/Dashboards are folder-based + high-volume, so the default
 * pull is usage-ranked and CAPPED; beyond that cap a report-only field can read
 * as unused. Scoped to the FIELD-USAGE question — the separate node
 * persistence cap (which bounds how many per-report NODES the graph holds, not
 * how many reports the field-usage fold covers) discloses itself through the
 * Report/Dashboard coverage rows going `pending`.
 */
export const REPORT_DASHBOARD_USAGE_CAVEAT =
  'report column / filter and dashboard component usage is folded onto CustomField nodes from the default capped reports pull (top 500 by usage; beyond-cap members stay pending). Fields with no folded `usedInReport` / `usedInDashboard` stamp may still be used only in reports or dashboards outside that cap — run `sfi refresh --with-reports` for a full uncapped pull, or `sfi refresh --no-reports` to skip entirely.';
