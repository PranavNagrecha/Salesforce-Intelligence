/**
 * A summary sentence that states a count or a percentage is built from the
 * row array it describes, never from a separate counter or another
 * denominator. `integration_map` said "Active RemoteSiteSettings … 20 in this
 * org" while counting every row, active or not; `org_overview` printed a
 * percentage next to one family that was computed across four. Filter once,
 * then print `count`, `total` and `percent` from the same result.
 */

/** The filtered rows and the two numbers a sentence may print about them. */
export interface RowSummary<T> {
  readonly rows: readonly T[];
  /** `rows.length`. */
  readonly count: number;
  /** Length of the array the predicate ran over. */
  readonly total: number;
}

/** Whole-percent `count / total`; `null` over zero rows (not measured, never "0%"). */
export const percent = (count: number, total: number): number | null =>
  total === 0 ? null : Math.round((count / total) * 100);

export const summarize = <T>(
  all: readonly T[],
  predicate: (row: T) => boolean,
): RowSummary<T> => {
  const rows = all.filter(predicate);
  return { rows, count: rows.length, total: all.length };
};
