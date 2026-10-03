import { XMLParser, XMLValidator } from 'fast-xml-parser';

/**
 * Shared XML plumbing for the OmniStudio model (`./process.ts`,
 * `./data-mapper.ts`). Same parser options the per-type extractors use, with
 * ONE deliberate difference: `trimValues: false`. The model must keep element
 * names and keys exactly as written — a name or key with a leading or trailing
 * space IS a defect (it never matches the key a reader expects), so trimming
 * on parse would erase the evidence.
 */

/** Result of parsing one OmniStudio XML document. */
export type XmlParse =
  | { readonly ok: true; readonly root: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/**
 * Validate then parse `xmlText` and return the object under `rootElement`.
 * Validation runs first because fast-xml-parser's `parse()` silently truncates
 * on mismatched tags.
 */
export const parseOmniXml = (xmlText: string, rootElement: string): XmlParse => {
  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return { ok: false, message: `malformed XML: ${validation.err.msg}` };
  }
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    processEntities: { maxTotalExpansions: 1_000_000 },
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlText) as Record<string, unknown>;
  } catch (cause: unknown) {
    return {
      ok: false,
      message: `XML parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const root = unwrapSingle(parsed[rootElement]);
  if (typeof root !== 'object' || root === null) {
    return { ok: false, message: `expected <${rootElement}> root` };
  }
  return { ok: true, root: root as Record<string, unknown> };
};

/** Unwrap fast-xml-parser's array-or-scalar shape for a single-occurrence child. */
export const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Normalize a repeatable child into an array. */
export const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * The element's text EXACTLY as written (no trimming), or `null` when absent
 * or empty. `xsi:nil` elements parse as `{}` and read as `null`.
 */
export const rawText = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null || typeof v === 'object') return null;
  const s = String(v);
  return s.length > 0 ? s : null;
};

/** The element's text trimmed, or `null` when absent / blank. */
export const trimmedText = (value: unknown): string | null => {
  const s = rawText(value);
  if (s === null) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
};

/** `true` only for a (trimmed, case-insensitive) `true`. */
export const xmlBool = (value: unknown): boolean => {
  const v = unwrapSingle(value);
  if (typeof v === 'boolean') return v;
  return typeof v === 'string' && v.trim().toLowerCase() === 'true';
};

/** A finite number, or `null`. */
export const xmlNumber = (value: unknown): number | null => {
  const s = trimmedText(value);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Parse result of one embedded JSON blob (`propertySetConfig` and friends). */
export interface JsonBlob {
  readonly value: Readonly<Record<string, unknown>> | null;
  /** Present only when the blob was non-empty and failed to parse. */
  readonly error: string | null;
}

/**
 * Parse an HTML-entity-escaped JSON object blob. fast-xml-parser has already
 * decoded the entities, so this is a plain `JSON.parse`. A blank blob is
 * `{ value: null, error: null }`; a malformed one keeps its error so the model
 * can say WHY an element's settings are unknown rather than treat them as empty.
 */
export const parseJsonBlob = (raw: unknown): JsonBlob => {
  const v = unwrapSingle(raw);
  if (v === undefined || v === null) return { value: null, error: null };
  if (typeof v === 'object') return { value: v as Record<string, unknown>, error: null };
  const text = String(v).trim();
  if (text.length === 0) return { value: null, error: null };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, error: null };
    }
    return { value: null, error: 'not a JSON object' };
  } catch (cause: unknown) {
    return { value: null, error: cause instanceof Error ? cause.message : String(cause) };
  }
};

/**
 * Locate the 1-based line of every `<openTag>` block's `<name>` child, in
 * document (pre-) order, by a streaming scan of the pretty-printed XML the
 * Metadata API writes (one tag per line).
 *
 * fast-xml-parser reports no positions, so the model pairs the i-th block here
 * with the i-th element of its own pre-order walk and checks the names agree;
 * a mismatch (an unusual layout) yields `null` lines rather than wrong ones.
 */
export const scanBlockNameLines = (
  xmlText: string,
  openTags: readonly string[],
): readonly {
  readonly name: string | null;
  /** Line of the block's own `<name>` (its start line when it has none). */
  readonly line: number;
  /** Line of the block's opening tag. */
  readonly startLine: number;
}[] => {
  const lines = xmlText.split(/\r?\n/);
  const stack: { start: number; name: string | null; nameLine: number | null; order: number }[] = [];
  const blocks: { start: number; name: string | null; nameLine: number | null; order: number }[] = [];
  let order = 0;
  const openRe = new RegExp(`^\\s*<(${openTags.join('|')})>\\s*$`);
  const closeRe = new RegExp(`^\\s*</(${openTags.join('|')})>\\s*$`);
  const nameRe = /^\s*<name>([\s\S]*?)<\/name>\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (openRe.test(line)) {
      stack.push({ start: i + 1, name: null, nameLine: null, order: order++ });
      continue;
    }
    if (closeRe.test(line)) {
      const block = stack.pop();
      if (block !== undefined) blocks.push(block);
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== undefined && top.nameLine === null) {
      const m = nameRe.exec(line);
      if (m !== null) {
        top.name = decodeXmlText(m[1] ?? '');
        top.nameLine = i + 1;
      }
    }
  }
  return blocks
    .sort((a, b) => a.order - b.order)
    .map((b) => ({ name: b.name, line: b.nameLine ?? b.start, startLine: b.start }));
};

/** Decode the five predefined XML entities (enough for element names). */
const decodeXmlText = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
