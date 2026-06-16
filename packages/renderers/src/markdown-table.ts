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
export const renderValueAsBacktickedString = (value: unknown): string => {
  if (value === null) return '`null`';
  if (typeof value === 'boolean') return value ? '`true`' : '`false`';
  const cell = String(value).replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|');
  return `\`${cell}\``;
};
