/**
 * Shared helper for report / dashboard field-usage signals.
 *
 * Reports and Dashboards are folder-based and high-volume, so the refresh
 * `--with-reports` pass does NOT persist a node per report — instead it folds
 * each report/dashboard's field usage onto the referenced `CustomField` as the
 * `usedInReport` / `usedInDashboard` boolean properties (see the CLI's
 * `foldReportDashboardUsageIntoFields`). Because that usage is a node *property*
 * rather than an incoming edge, every edge-walking field tool (`field_360`,
 * `find_field_anywhere`, `safe_to_delete_field`, `unused_fields_deep`, …) must
 * read it explicitly. This module centralizes that read + the honesty caveat.
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
 * True when the field is used by at least one report column / filter or a
 * dashboard component (per the folded `--with-reports` signal).
 */
export const isUsedInReportOrDashboard = (node: Node): boolean => {
  const u = reportDashboardUsage(node);
  return u.usedInReport || u.usedInDashboard;
};

/**
 * Honesty caveat surfaced by field tools when report/dashboard usage is NOT in
 * the vault. Reports/Dashboards are folder-based + high-volume, so they are off
 * by default; without the opt-in pull a report-only field can read as unused.
 */
export const REPORT_DASHBOARD_USAGE_CAVEAT =
  'report column / filter and dashboard component usage is folded onto CustomField nodes from the default capped reports pull (top 500 by usage; beyond-cap members stay pending). Fields with no folded `usedInReport` / `usedInDashboard` stamp may still be used only in reports or dashboards outside that cap — run `sfi refresh --with-reports` for a full uncapped pull, or `sfi refresh --no-reports` to skip entirely.';
