/**
 * REPORT-TYPE COLUMNS — the one reader of custom ReportType `<columns>`.
 *
 * The extractor stamps every ReportType node `columnsModeled: false`: a field
 * that is only an explicit column of a custom report type has NO inbound edge.
 * `unused_fields_deep`, `safe_to_delete_field` and `field_360` all need that
 * fact, and when each read it (or did not) on its own they gave three verdicts
 * for the same field (ADM-5). They now share this scan.
 *
 * Read from the retrieved report-type source files; bounded and disclosed.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Context } from '../server.js';

import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { FULL_SCAN_MAX_NODES } from './scan-cap.js';

/**
 * One ReportType file's columns, keyed `Table.Field`.
 *
 * A `<table>` holding a DOT is a relationship PATH out of the base object
 * (`Base.Children__r`), whose last segment is a relationship api name, not an
 * object api name; a `<field>` holding a DOT is a lookup traversal
 * (`Owner__r.Region__c`). Neither can be attributed to an object, so those
 * columns are never attributed — matching on the bare field name would PROTECT
 * an unrelated same-named field — but their terminal field names are kept in
 * `unattributedNames`, so a field with that name is told its report-type use
 * was NOT checked (never "not a column").
 */
export const reportTypeColumnKeys = (
  xml: string,
): {
  readonly keys: readonly string[];
  readonly unattributed: number;
  readonly unattributedNames: readonly string[];
} => {
  const keys: string[] = [];
  const unattributedNames: string[] = [];
  let unattributed = 0;
  const columnBlock = /<columns>([\s\S]*?)<\/columns>/g;
  let block: RegExpExecArray | null;
  while ((block = columnBlock.exec(xml)) !== null) {
    const body = block[1] ?? '';
    const field = /<field>([^<]+)<\/field>/.exec(body)?.[1];
    const table = /<table>([^<]+)<\/table>/.exec(body)?.[1];
    if (field === undefined || table === undefined) continue;
    if (table.includes('.') || field.includes('.')) {
      unattributed += 1;
      unattributedNames.push(field.slice(field.lastIndexOf('.') + 1).toLowerCase());
      continue;
    }
    keys.push(`${table}.${field}`);
  }
  return { keys, unattributed, unattributedNames };
};

export type ReportTypeColumnScan =
  | { readonly status: 'failed' }
  | { readonly status: 'no-report-types' }
  | {
      readonly status: 'ok';
      /** `Object.Field` → ReportType ids that list it as an explicit column. */
      readonly columns: ReadonlyMap<string, readonly string[]>;
      readonly read: number;
      /** Read + unreadable (+ a capped walk is flagged by `incomplete`). */
      readonly total: number;
      readonly incomplete: boolean;
      readonly unattributedColumns: number;
      /** Lower-cased terminal field name of an unattributed column → ReportType ids. */
      readonly unattributedByName: ReadonlyMap<string, readonly string[]>;
    };

/** Walk every vaulted ReportType once and index its attributable columns. */
export const scanReportTypeColumns = async (ctx: Context): Promise<ReportTypeColumnScan> => {
  const reportTypes = await scanAllNodesOfTypes(ctx.graph, ['ReportType'], FULL_SCAN_MAX_NODES);
  if (!reportTypes.ok) return { status: 'failed' };
  if (reportTypes.value.nodes.length === 0) return { status: 'no-report-types' };
  const columns = new Map<string, string[]>();
  let read = 0;
  let unreadable = 0;
  let unattributedColumns = 0;
  const unattributedByName = new Map<string, string[]>();
  for (const rt of reportTypes.value.nodes) {
    if (typeof rt.sourcePath !== 'string' || rt.sourcePath.length === 0) {
      unreadable += 1;
      continue;
    }
    let xml: string;
    try {
      xml = await readFile(join(ctx.vaultRoot, rt.sourcePath), 'utf-8');
    } catch {
      unreadable += 1;
      continue;
    }
    read += 1;
    const parsed = reportTypeColumnKeys(xml);
    unattributedColumns += parsed.unattributed;
    for (const name of new Set(parsed.unattributedNames)) {
      const list = unattributedByName.get(name);
      if (list === undefined) unattributedByName.set(name, [rt.id]);
      else list.push(rt.id);
    }
    for (const key of new Set(parsed.keys)) {
      const list = columns.get(key);
      if (list === undefined) columns.set(key, [rt.id]);
      else list.push(rt.id);
    }
  }
  return {
    status: 'ok',
    columns,
    read,
    total: reportTypes.value.nodes.length,
    incomplete: reportTypes.value.scanIncomplete || unreadable > 0,
    unattributedColumns,
    unattributedByName,
  };
};

/**
 * ReportType ids (sorted) holding an UNATTRIBUTED column (relationship-path
 * table or lookup-traversal field) whose terminal field name is
 * `fieldApiName` — it may be this field, and that cannot be told.
 */
export const reportTypesWithUnattributedColumnNamed = (
  scan: ReportTypeColumnScan,
  fieldApiName: string,
): readonly string[] =>
  scan.status === 'ok'
    ? [...(scan.unattributedByName.get(fieldApiName.toLowerCase()) ?? [])].sort()
    : [];

/** ReportType ids (sorted) that list `objectApiName.fieldApiName` as a column. */
export const reportTypesWithColumn = (
  scan: ReportTypeColumnScan,
  objectApiName: string,
  fieldApiName: string,
): readonly string[] =>
  scan.status === 'ok'
    ? [...(scan.columns.get(`${objectApiName}.${fieldApiName}`) ?? [])].sort()
    : [];

/**
 * One sentence shared by the per-field tools: what a report-type column means
 * for deletion. Same wording everywhere so the tools cannot drift.
 */
export const reportTypeColumnNote = (reportTypeIds: readonly string[]): string =>
  `Explicit column of ${reportTypeIds.length} custom report type(s) (${reportTypeIds.slice(0, 5).join(', ')}${reportTypeIds.length > 5 ? ', …' : ''}), read from report-type source (no graph edge exists for it). Deleting the field removes that column and breaks saved reports that show, filter or group on it — check those reports before deleting.`;

/**
 * The per-field tools' disclosure when the scan could not fully answer for
 * `fieldApiName`: `null` only for a complete `ok` scan in which no
 * unattributed column carries that field name. Shared so `safe_to_delete_field`
 * and `field_360` say the same thing `unused_fields_deep` does — a failed or
 * partial scan, or a same-named column on a relationship path, is "not
 * checked", never "not a column".
 */
export const reportTypeScanGap = (
  scan: ReportTypeColumnScan,
  fieldApiName: string,
): string | null => {
  if (scan.status === 'failed') {
    return 'Custom report-type columns were NOT checked: the ReportType walk failed on this call. A field used only as a report-type column has no graph edge, so its absence from the dependents above is "not checked".';
  }
  if (scan.status === 'no-report-types') {
    return 'No ReportType is in this vault, so custom report-type columns were NOT checked (a column-only use has no graph edge). Refresh with the ReportType family to check them.';
  }
  const parts: string[] = [];
  if (scan.incomplete) {
    parts.push(
      `Custom report-type columns were checked in ${scan.read} of ${scan.total} ReportType(s); a column in the unread rest was NOT checked.`,
    );
  }
  const sameNamed = reportTypesWithUnattributedColumnNamed(scan, fieldApiName);
  if (sameNamed.length > 0) {
    parts.push(
      `${sameNamed.length} custom report type(s) (${sameNamed.slice(0, 5).join(', ')}${sameNamed.length > 5 ? ', …' : ''}) list a column named \`${fieldApiName}\` reached through a relationship path (a \`Base.Child__r\` table or a lookup-traversal field). Such a column cannot be attributed to an object, so it may be THIS field: its report-type use was NOT checked.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
};
