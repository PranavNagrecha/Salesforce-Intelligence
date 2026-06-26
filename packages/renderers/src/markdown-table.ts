/**
 * Shared Markdown-table cell rendering for the component / apex / flow
 * renderers.
 *
 * Extracted because all three carried a byte-identical copy of this helper, and
 * the same escaping bug — a multi-line CustomField `formula` using the `||`
 * operator corrupting the Properties table — had to be fixed in each one
 * separately (the classic parallel-bug-from-duplication). One copy now, so a
 * future escaping fix is written once.
 */

/**
 * Render a property value as a backtick-wrapped Markdown table cell.
 *
 * Booleans and `null` get their own literal; any other value is stringified,
 * has its newlines collapsed to a single space, and its pipes backslash-escaped
 * so a free-text value (e.g. a multi-line formula that uses `||`) cannot break
 * the surrounding Markdown table's row or columns. GFM renders a
 * backslash-escaped `\|` as a literal pipe even inside a code span.
 */
/**
 * True when `value` is an array of picklist-value objects (H10 shape:
 * `{ value: string, isActive?: boolean, label?, default? }`). A bare `String()`
 * on such an array renders `[object Object]` in the body Properties table, so
 * it gets the human-readable join in {@link renderPicklistValues} instead.
 */
const isPicklistValueArray = (
  value: unknown,
): value is ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as Record<string, unknown>)['value'] === 'string',
  );

/**
 * Render an H10 picklist-value object array as a comma-joined value list,
 * suffixing deactivated entries with `(inactive)` so a reader can tell which
 * values are retained-but-not-selectable rather than current.
 */
const renderPicklistValues = (
  entries: ReadonlyArray<Record<string, unknown>>,
): string =>
  entries
    .map((e) => {
      const v = String(e['value']);
      return e['isActive'] === false ? `${v} (inactive)` : v;
    })
    .join(', ');

export const renderValueAsBacktickedString = (value: unknown): string => {
  if (value === null) return '`null`';
  if (typeof value === 'boolean') return value ? '`true`' : '`false`';
  const text = isPicklistValueArray(value)
    ? renderPicklistValues(value)
    : String(value);
  const cell = text.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|');
  return `\`${cell}\``;
};
