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
type PicklistEntry = string | Record<string, unknown>;

const isPicklistValueObject = (e: unknown): e is Record<string, unknown> =>
  typeof e === 'object' &&
  e !== null &&
  typeof (e as Record<string, unknown>)['value'] === 'string';

/**
 * True when `value` is a picklist-value array that contains AT LEAST ONE
 * `{ value: string, isActive?: boolean, label?, default? }` object entry (the
 * H10 re-extracted shape) and whose remaining entries are bare strings (the
 * legacy shape). This is exactly the set of arrays for which a bare `String()`
 * would emit `[object Object]` for the object entries, so they are diverted to
 * {@link renderPicklistValues}.
 *
 * A vault refreshed across the legacy->object migration can hold a MIXED array
 * (some strings, some objects); both an all-object array and a mixed array are
 * matched here. A pure-string array is DELIBERATELY NOT matched — it has no
 * `[object Object]` problem and stays on the `String()` path so its rendered
 * cell (comma-joined, no spaces) is byte-identical to before this fix, keeping
 * golden / in-budget output stable.
 */
const isPicklistValueArray = (value: unknown): value is ReadonlyArray<PicklistEntry> =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.some(isPicklistValueObject) &&
  value.every((e) => typeof e === 'string' || isPicklistValueObject(e));

/**
 * Render a picklist-value array as a comma-joined value list, suffixing
 * deactivated object entries with `(inactive)` so a reader can tell which
 * values are retained-but-not-selectable rather than current. Handles BOTH
 * entry shapes — bare strings and `{ value, isActive? }` objects — so a mixed
 * array never renders `[object Object]`. Bare-string entries have no activation
 * state, so they carry no suffix.
 */
const renderPicklistValues = (entries: ReadonlyArray<PicklistEntry>): string =>
  entries
    .map((e) => {
      if (typeof e === 'string') return e;
      const v = String(e['value']);
      return e['isActive'] === false ? `${v} (inactive)` : v;
    })
    .join(', ');

/**
 * True when `value` is a login-IP-range array: a non-empty array where every
 * entry is a `{ startAddress: string, endAddress: string }` object (the shape
 * the profile extractor collects into `properties.loginIpRanges`). Rendered
 * through a bare `String()` each entry stringifies to `[object Object]`, so
 * this set is diverted to {@link renderLoginIpRanges}.
 *
 * The guard is checked BEFORE {@link isPicklistValueArray}: IP-range entries
 * carry `startAddress`/`endAddress` while picklist entries carry `value`, so
 * the two shapes are mutually exclusive, but the explicit ordering keeps the
 * intent unambiguous.
 */
const isLoginIpRangeObject = (e: unknown): e is Record<string, string> =>
  typeof e === 'object' &&
  e !== null &&
  typeof (e as Record<string, unknown>)['startAddress'] === 'string' &&
  typeof (e as Record<string, unknown>)['endAddress'] === 'string';

const isLoginIpRangeArray = (value: unknown): value is ReadonlyArray<Record<string, string>> =>
  Array.isArray(value) && value.length > 0 && value.every(isLoginIpRangeObject);

/**
 * Render a login-IP-range array as a comma-joined list of `start-end` pairs
 * (e.g. `10.0.0.1-10.0.0.255, 192.168.1.0-192.168.1.255`) so a security
 * reviewer can read the allowlist directly instead of `[object Object]`.
 */
const renderLoginIpRanges = (entries: ReadonlyArray<Record<string, string>>): string =>
  entries.map((e) => `${String(e['startAddress'])}-${String(e['endAddress'])}`).join(', ');

export const renderValueAsBacktickedString = (value: unknown): string => {
  if (value === null) return '`null`';
  if (typeof value === 'boolean') return value ? '`true`' : '`false`';
  const text = isLoginIpRangeArray(value)
    ? renderLoginIpRanges(value)
    : isPicklistValueArray(value)
      ? renderPicklistValues(value)
      : String(value);
  const cell = text.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|');
  return `\`${cell}\``;
};

/**
 * Escape free-text metadata interpolated into a Markdown HEADING line
 * (`# ...`). Collapses newlines to a single space so a value cannot inject a
 * second heading/block, and backslash-escapes the chars that break heading
 * rendering or inject content: backtick (code-span), pipe (table), asterisk
 * (emphasis), a leading run of `#` (which would shift the heading level or
 * inject a new one), and the link/image/raw-HTML/autolink vectors below.
 *
 * CR-P3-6: a heading is inline context, so an unescaped `[text](url)` renders a
 * live link and `![alt](url)` an auto-loading image beacon. Escaping `[` and
 * `]` (and `!` only when it precedes a `[`) renders the trailing `(url)` inert
 * literal text — no live link, no beacon. `(` and `)` are DELIBERATELY left
 * unescaped: they are inert without a preceding link-text span, and escaping
 * them would corrupt clean labels like `Status (active)`. A bare `!` not before
 * a `[` stays byte-identical. CR-P3-6 (heading raw-HTML/autolink): `<` is also
 * escaped — `<img src=x onerror=...>` is live inline HTML and `<https://evil>`
 * a live autolink inside a heading, the same beacon via a different char (the
 * org alias `targetOrg` and field/object labels are attacker-influenceable).
 *
 * Deliberately does NOT escape underscore — it is inert in a heading and
 * escaping it would corrupt the ubiquitous api-name suffixes (`Foo__c`,
 * `child__r`). Clean values (no special chars) are returned byte-identical.
 */
export const escapeMarkdownHeading = (text: string): string =>
  text
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[`|*[\]<]/g, (c) => `\\${c}`)
    .replace(/!(?=\\?\[)/g, '\\!')
    .replace(/^(#+)/, (m) => m.replace(/#/g, '\\#'));

/**
 * Render free-text metadata as a complete, safe Markdown inline code span —
 * fence included (e.g. for a `**API Name:** ...` line, or a Flow detail
 * value). Collapses newlines to a single space first.
 *
 * CR-16d: an EARLIER version of this helper returned only the inner text and
 * relied on callers to wrap it in a hardcoded single backtick, escaping an
 * embedded backtick with a backslash (`` \` ``). That does NOT work — per
 * CommonMark, backslash escapes are inert inside code spans (a code span
 * closes at the next backtick RUN of the same length as its opening run,
 * full stop), so a value containing a backtick would still split the span
 * early despite the backslash. There is no way to hold an embedded backtick
 * inside a fence that is fixed at one backtick, so this helper now OWNS the
 * fence instead of assuming one: it picks a fence one backtick longer than
 * the longest run of backticks already present in the value (so nothing in
 * the value can ever match the fence length and close it early), and — per
 * spec — pads the content with a single leading/trailing space when the
 * value starts or ends with a backtick (otherwise that boundary backtick
 * would visually fuse with the fence). A value with no backticks gets the
 * minimal one-backtick fence and no padding, so existing SF-identifier
 * output (which never contains a backtick) is byte-identical to before.
 *
 * Pipe/asterisk/hash are inert inside a code span, so they are left
 * untouched — escaping them would corrupt the value.
 */
export const escapeMarkdownInline = (text: string): string => {
  const collapsed = text.replace(/\r\n|\r|\n/g, ' ');
  const backtickRuns = collapsed.match(/`+/g) ?? [];
  const longestRun = Math.max(0, ...backtickRuns.map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding = collapsed.startsWith('`') || collapsed.endsWith('`');
  const content = needsPadding ? ` ${collapsed} ` : collapsed;
  return `${fence}${content}${fence}`;
};

/**
 * Escape free-text metadata interpolated as a Markdown BLOCK (a description
 * paragraph). Intentional newlines and inline prose are PRESERVED; only a
 * line-LEADING structural construct is backslash-escaped so a value cannot
 * inject a heading (`#`), blockquote (`>`), table row / delimiter (`|`), list
 * bullet (`-`/`*`/`+`), code fence (```` ``` ````/`~~~`), a SETEXT underline
 * (a line of only `=` or only `-`, which would promote the PRECEDING prose line
 * to an H1/H2), an ORDERED-LIST leader (`1.` / `10)`), or a RAW-HTML block (a
 * leading `<`, e.g. `<img src=x onerror=...>`). Per-line so multi-line
 * descriptions render as written. Clean prose is returned byte-identical.
 *
 * CR-P3-9: the ordered-list leader escapes only the SEPARATOR (`1.` -> `1\.`)
 * so digits stay legible while the line is no longer a list item; the
 * `\d{1,9}` cap is CommonMark's max marker length and the `(?=\s|$)` lookahead
 * keeps inline `item 1. foo` / `Version 2.0` byte-identical (the digit is not
 * line-leading). The setext check runs FIRST so a `---` line is neutralized as
 * a setext underline (and thematic break) before the bullet rule, which would
 * not match a pure `---` anyway. Thematic-break-only lines built from `***` or
 * `___` are intentionally OUT OF SCOPE — they render a cosmetic `<hr>`, not an
 * injected heading/list/HTML.
 */
export const escapeMarkdownBlockText = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      // (1) Setext underline: a whole line of only `=` or only `-` (optional
      // surrounding whitespace). Escaping the first char stops it promoting the
      // preceding prose line to a heading and neutralizes the `---` break.
      const setext = line.match(/^(\s*)(=+|-+)(\s*)$/);
      if (setext !== null) {
        const [, ws, run, trailing] = setext as unknown as [
          string,
          string,
          string,
          string,
        ];
        return `${ws}\\${run[0]}${run.slice(1)}${trailing}`;
      }
      // (2) Other line-leading tokens, incl. ordered-list leader and raw-HTML
      // opener `<`.
      return line.replace(
        /^(\s*)(\d{1,9}[.)](?=\s|$)|[#>|]|[-*+](?=\s)|```|~~~|<)/,
        (_m, ws, tok) => {
          if (tok === '```' || tok === '~~~') {
            return `${ws}\\${tok[0]}${tok.slice(1)}`;
          }
          // Ordered-list leader (`1.`, `10)`): escape only the separator so
          // the digits read naturally but the line is not a list item.
          const ordered = /^(\d{1,9})([.)])$/.exec(tok);
          if (ordered !== null) {
            return `${ws}${ordered[1]}\\${ordered[2]}`;
          }
          return `${ws}\\${tok}`;
        },
      );
    })
    .join('\n');
