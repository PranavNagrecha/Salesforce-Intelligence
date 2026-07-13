/**
 * Shared RFC 4180 CSV encoder for the tabular tools (R6-21).
 *
 * A handful of MCP tools return naturally tabular output (a data dictionary's
 * field rows, a PII inventory, an unused-fields scan) and are also useful as a
 * flat file a caller can drop straight into a spreadsheet. This module is the
 * ONE place that knows how to quote/escape a CSV cell so every `format: 'csv'`
 * tool path produces byte-identical, RFC 4180-compliant output rather than each
 * tool hand-rolling its own (and drifting on edge cases like embedded quotes).
 *
 * Deliberately minimal: quoting follows RFC 4180 §2 (a field is quoted when it
 * contains a comma, a double quote, or a line break; an embedded quote is
 * doubled). No BOM, no alternate delimiters — the tools that consume this need
 * nothing fancier, and a smaller surface is easier to keep byte-stable.
 */

/** A single CSV cell value. `null`/`undefined` render as an empty field. */
export type CsvCell = string | number | boolean | null | undefined;

/** Characters that force RFC 4180 quoting when present anywhere in a field. */
const CSV_SPECIAL_CHARS = /[",\r\n]/;

/**
 * Encode one field per RFC 4180 §2: quote when the value contains a comma, a
 * double quote, or a line break (CR or LF); double any embedded quote.
 * Unquoted otherwise — matches every other value in this codebase's CSV-free
 * columns (ids, counts, booleans) staying readable without noise quoting.
 *
 * @example encodeCsvField('plain') === 'plain'
 * @example encodeCsvField('a,b') === '"a,b"'
 * @example encodeCsvField('say "hi"') === '"say ""hi"""'
 */
export const encodeCsvField = (raw: string): string =>
  CSV_SPECIAL_CHARS.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;

/** Stringify a cell value for CSV: `null`/`undefined` → `''`, booleans/numbers → their literal text. */
const cellToString = (cell: CsvCell): string => {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  return String(cell);
};

/** Encode one CSV row (no trailing line terminator). */
export const encodeCsvRow = (cells: readonly CsvCell[]): string =>
  cells.map((c) => encodeCsvField(cellToString(c))).join(',');

/**
 * Render a full CSV document: a header row followed by one row per entry in
 * `rows`, `\n`-terminated (including a trailing newline after the last row —
 * the POSIX "text file ends in a newline" convention most spreadsheet tools
 * and `wc -l` expect). Rows are emitted in the order given — this module does
 * no sorting; callers own row order.
 */
export const renderCsv = (
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string => [encodeCsvRow(header), ...rows.map(encodeCsvRow)].map((l) => `${l}\n`).join('');

/**
 * Render `#`-prefixed comment lines ahead of a CSV body so disclosures
 * (freshness timestamp, heuristic-confidence caveats, truncation notes)
 * survive even when a caller saves ONLY the `.csv` text and discards the rest
 * of the MCP response envelope. `#` is not part of RFC 4180, but every common
 * CSV consumer (Excel, Google Sheets, `csv` parsers with a comment option)
 * either ignores a `#`-leading line or treats it as a single text cell — never
 * a parse error — so this degrades safely everywhere.
 *
 * A disclosure line containing its own newline is flattened to a single
 * comment line (newlines would otherwise silently end the comment early).
 */
export const renderCsvComments = (disclosures: readonly string[]): string =>
  disclosures.map((d) => `# ${d.replace(/\r?\n/g, ' ')}\n`).join('');

/** A disclosure-prefixed CSV document: comments, then header + rows. */
export const renderCsvWithDisclosures = (
  disclosures: readonly string[],
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string => renderCsvComments(disclosures) + renderCsv(header, rows);

/**
 * The outcome of {@link fitCsvRowsToBudget}: the fitted CSV text plus how many
 * of the caller's rows made it in.
 */
export interface CsvFitResult {
  readonly csv: string;
  readonly totalRows: number;
  readonly keptRows: number;
  readonly truncated: boolean;
}

/**
 * Fit a CSV document (disclosures + header + rows) under `maxBytes`,
 * dropping rows from the TAIL when the full document would overflow — never
 * silently mid-row-truncating the text (the "H7 dishonesty bug" class this
 * codebase's `fitDocumentToBudget` / `slimDataStrings` guard already avoids
 * for markdown; the same discipline applies to CSV). When rows are dropped a
 * `# truncated: …` comment line is appended so a reader who only has the
 * `.csv` file still sees the row count was cut, not just the JSON envelope's
 * `truncated` flag.
 *
 * Pure and deterministic. The common case (already under budget) does exactly
 * one render pass; over-budget inputs shrink by roughly halving the kept-row
 * count each pass (bounded — terminates at 0 kept rows).
 *
 * @example
 *   const fit = fitCsvRowsToBudget(['generated 2026-01-01'], ['id', 'name'], rows, 40_000);
 *   fit.truncated // true when rows.length exceeded what fits
 */
export const fitCsvRowsToBudget = (
  disclosures: readonly string[],
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
  maxBytes: number,
): CsvFitResult => {
  const full = renderCsvWithDisclosures(disclosures, header, rows);
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) {
    return { csv: full, totalRows: rows.length, keptRows: rows.length, truncated: false };
  }

  const truncationNote = (kept: number): string =>
    `truncated: showing ${kept.toString()} of ${rows.length.toString()} rows — narrow the query, page with limit/offset, or raise SFI_MAX_RESPONSE_BYTES for the rest`;

  let kept = rows.length;
  while (kept > 0) {
    const next = kept > 1 ? Math.ceil(kept / 2) : 0;
    kept = next;
    const candidate = renderCsvWithDisclosures(
      [...disclosures, truncationNote(kept)],
      header,
      rows.slice(0, kept),
    );
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      return { csv: candidate, totalRows: rows.length, keptRows: kept, truncated: true };
    }
  }
  // Even zero rows overflow (disclosures alone are too large) — still return a
  // structurally valid, honestly-labeled CSV rather than throwing.
  return {
    csv: renderCsvWithDisclosures([...disclosures, truncationNote(0)], header, []),
    totalRows: rows.length,
    keptRows: 0,
    truncated: rows.length > 0,
  };
};
