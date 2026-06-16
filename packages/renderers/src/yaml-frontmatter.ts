/**
 * Byte-stable YAML frontmatter serializer.
 *
 * Renderer output is committed to Git, so the same input must serialize to
 * the same bytes on every machine and every run. We hand-roll the
 * serialization for the small YAML subset we actually use (string keys,
 * scalars, nested maps, block-style sequences of primitives, arrays of
 * plain-object mappings, and one-level-deeper inner scalar arrays inside
 * those mappings — the v2.0a `conditionsMirror` shape) rather than depend
 * on a third-party package whose output may drift across versions.
 */

// Characters that, if present anywhere in a string, force double-quoting.
// These are YAML special characters or whitespace/control characters that
// would otherwise change the parsed meaning.
const SPECIAL_CHARS = new Set([
  '"',
  "'",
  '\n',
  '\r',
  '\t',
  '[',
  ']',
  '{',
  '}',
  '#',
  '&',
  '*',
  '!',
  '|',
  '>',
  '%',
  '@',
  '`',
]);

// Characters that force quoting only when they appear as the FIRST character
// of an unquoted scalar (YAML uses leading indicators to choose a scalar
// style; we sidestep this by quoting).
const LEADING_SPECIAL_CHARS = new Set([
  '-',
  '?',
  ':',
  ',',
  '[',
  ']',
  '{',
  '}',
  '&',
  '*',
  '!',
  '|',
  '>',
  "'",
  '"',
  '%',
  '@',
  '`',
]);

// Reserved bare-word literals that YAML 1.1 would interpret as boolean/null.
// Case-insensitive — we lowercase before comparing.
const RESERVED_LITERALS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']);

const needsQuoting = (value: string): boolean => {
  if (value === '') return true;
  if (/^\s|\s$/.test(value)) return true;
  if (RESERVED_LITERALS.has(value.toLowerCase())) return true;
  const firstChar = value[0];
  if (firstChar !== undefined && LEADING_SPECIAL_CHARS.has(firstChar)) return true;
  for (const char of value) {
    if (SPECIAL_CHARS.has(char)) return true;
  }
  if (value.includes(',')) return true;
  if (value.includes(': ')) return true;
  return false;
};

const quoteString = (value: string): string => {
  let escaped = '';
  for (const char of value) {
    if (char === '\\') {
      escaped += '\\\\';
    } else if (char === '"') {
      escaped += '\\"';
    } else if (char === '\n') {
      escaped += '\\n';
    } else if (char === '\r') {
      escaped += '\\r';
    } else if (char === '\t') {
      escaped += '\\t';
    } else {
      escaped += char;
    }
  }
  return `"${escaped}"`;
};

const serializeScalar = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`yaml-frontmatter: non-finite number not supported: ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    return needsQuoting(value) ? quoteString(value) : value;
  }
  throw new Error(`yaml-frontmatter: unsupported scalar type: ${typeof value}`);
};

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Stricter check used only when classifying array elements: rejects class
// instances and any other object whose prototype isn't `Object.prototype` or
// `null`. The map-level `isPlainObject` stays permissive because the rest
// of the renderer only ever feeds it plain object literals from the
// extractors; tightening it would be an out-of-scope behavior change.
const isPlainObjectLiteral = (
  value: unknown,
): value is Readonly<Record<string, unknown>> => {
  if (!isPlainObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// Serialize an inner array-of-scalars value sitting inside an
// array-of-objects element (the depth-4 path). The caller has already
// emitted the owning `key:` line at `fieldIndent`; this helper emits the
// block-sequence items one level deeper at `fieldIndent + '  '`. Element
// order is preserved (no sort), matching the top-level scalar-array rule.
//
// Inner-array elements must be scalars. An object element would push to
// depth 5+ and a nested array (e.g. `[[1]]`) would push to depth 5 as
// well — both throw with a depth-limit error rather than mis-render.
const serializeInnerScalarArray = (
  items: readonly unknown[],
  fieldIndent: string,
): string => {
  // Pre-scan: every inner-array element must be a scalar. Arrays-of-arrays
  // and arrays-of-objects both push past depth 4 and are rejected with a
  // depth-limit error. The renderer's deeper-nesting refusal is by design
  // — beyond depth 4 the YAML output collapses into unreadable indentation
  // soup, and the extractor surface does not emit those shapes.
  for (const item of items) {
    if (Array.isArray(item)) {
      throw new Error(
        `yaml-frontmatter: nested arrays inside arrays of objects are not supported (depth limit 4)`,
      );
    }
    if (typeof item === 'object' && item !== null) {
      throw new Error(
        `yaml-frontmatter: nested objects inside inner arrays are not supported (depth limit 4)`,
      );
    }
  }
  const itemIndent = `${fieldIndent}  `;
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`${itemIndent}- ${serializeScalar(item)}`);
  }
  return lines.join('\n');
};

// Serialize a YAML block-style sequence of mapping fields (one `field:
// value` per line, indented to align under the leading `- `). The first
// field carries the `- ` prefix; remaining fields are indented two extra
// spaces to land under the first field's column. Keys are sorted
// alphabetically inside each object so the output is byte-stable across
// runs (matches the surrounding map sort rule).
//
// Field values may be scalars (string, number, boolean, null) OR an array
// of scalars (the depth-4 path). The v2.0a `conditionsMirror` shape pushes
// the depth ceiling up to 4 (outer key -> array -> object -> inner array
// -> scalar) so a firer's mirror can carry the `fieldRefs: ComponentId[]`
// canonical id list per `ConditionalContextSemantics.md` §"The
// `properties.conditions[]` property mirror". Empty inner arrays render
// inline as `[]`; inner-array element order is preserved (no sort).
//
// Nested objects inside an element still throw — depth-4 admits exactly
// one new shape (inner array of scalars), nothing wider. Beyond depth-4
// the YAML output's readability collapses; the renderer should fail
// loudly rather than emit unreadable nesting.
const serializeArrayOfObjects = (
  items: readonly Readonly<Record<string, unknown>>[],
  depth: number,
): string => {
  const indent = '  '.repeat(depth);
  // First field of each object lands after `- `; subsequent fields land at
  // `indent + '  '` so they align under the first field's column.
  const fieldIndent = `${indent}  `;
  const lines: string[] = [];
  for (const item of items) {
    const keys = Object.keys(item).sort();
    let first = true;
    for (const key of keys) {
      const value = item[key];
      if (isPlainObject(value)) {
        // Depth-4 ceiling: a nested object inside the array element would
        // push to depth 5+, which the renderer deliberately does not
        // handle (extractor surface does not emit those shapes; reject
        // early rather than mis-render).
        throw new Error(
          `yaml-frontmatter: nested objects inside arrays of objects are not supported (depth limit 4)`,
        );
      }
      const prefix = first ? `${indent}- ` : fieldIndent;
      if (Array.isArray(value)) {
        // Inner-array path (depth-4). Empty arrays collapse to inline `[]`
        // for symmetry with the top-level empty-array rule. Non-empty
        // arrays emit the owning `key:` line at the field's indent, then
        // a block-sequence one level deeper.
        if (value.length === 0) {
          lines.push(`${prefix}${key}: []`);
        } else {
          lines.push(`${prefix}${key}:`);
          lines.push(serializeInnerScalarArray(value, fieldIndent));
        }
      } else {
        lines.push(`${prefix}${key}: ${serializeScalar(value)}`);
      }
      first = false;
    }
  }
  return lines.join('\n');
};

// Serialize a YAML block-style sequence. The leading `- ` lives at `depth`
// indent; the caller is responsible for emitting the owning `key:` line, so
// we never produce that line ourselves. Empty arrays are handled by the
// call site (inline `[]`) and never reach this function.
//
// The array must be uniform: every element is either a scalar (string,
// number, boolean, null) or every element is a plain object. Arrays of
// arrays, arrays of class instances, and mixed scalar+object arrays all
// throw; a clear throw beats silently mis-rendering a future extractor's
// output.
const serializeArray = (items: readonly unknown[], depth: number): string => {
  // Pre-scan to classify the array's element kind and reject heterogeneous
  // or unsupported shapes before emitting any output.
  let hasObject = false;
  let hasScalar = false;
  for (const item of items) {
    if (Array.isArray(item)) {
      throw new Error(
        `yaml-frontmatter: nested arrays are not supported`,
      );
    }
    if (typeof item === 'object' && item !== null) {
      // Use the stricter prototype check here: class instances and other
      // non-literal objects (Date, Map, Set, etc.) can't be safely emitted
      // with `Object.keys` and must be rejected.
      if (!isPlainObjectLiteral(item)) {
        throw new Error(
          `yaml-frontmatter: array items must be plain objects or scalars`,
        );
      }
      hasObject = true;
    } else {
      hasScalar = true;
    }
  }
  if (hasObject && hasScalar) {
    throw new Error(
      `yaml-frontmatter: arrays of mixed scalars and objects are not supported`,
    );
  }
  if (hasObject) {
    return serializeArrayOfObjects(
      items as readonly Readonly<Record<string, unknown>>[],
      depth,
    );
  }
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`${indent}- ${serializeScalar(item)}`);
  }
  return lines.join('\n');
};

const serializeMap = (data: Readonly<Record<string, unknown>>, depth: number): string => {
  const indent = '  '.repeat(depth);
  const keys = Object.keys(data).sort();
  const lines: string[] = [];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${indent}${key}: []`);
      } else {
        lines.push(`${indent}${key}:`);
        // Block-sequence elements are indented one level deeper than the
        // owning key (YAML 1.2 §8.2.1): a 2-space step per level matches the
        // map indentation already in use.
        lines.push(serializeArray(value, depth + 1));
      }
    } else if (isPlainObject(value)) {
      lines.push(`${indent}${key}:`);
      lines.push(serializeMap(value, depth + 1));
    } else {
      lines.push(`${indent}${key}: ${serializeScalar(value)}`);
    }
  }
  return lines.join('\n');
};

/**
 * Serialize a flat or nested map to YAML frontmatter (body only, no `---`
 * delimiters). Output is byte-stable: same input produces the same bytes,
 * every time, on every machine.
 *
 * Keys are sorted alphabetically at every level. Strings are emitted bare
 * unless they would parse ambiguously (special characters, reserved
 * literals, leading whitespace, etc.), in which case they are double-quoted
 * and escaped per the YAML 1.2 quoted-scalar grammar.
 *
 * Array values are emitted as block-style sequences (`- item` per line)
 * indented one level deeper than the owning key; element order is
 * preserved (no sort). Empty arrays collapse to inline `[]`. Arrays of
 * primitives, arrays of plain objects (keys sorted alphabetically inside
 * each object), and arrays of plain objects whose fields include inner
 * scalar-only arrays are supported. Nested arrays of arrays, mixed
 * scalar+object arrays, nested objects inside array elements, and
 * anything deeper than depth-4 (outer key -> array -> object -> inner
 * array -> scalar) all throw.
 *
 * The returned string has no leading or trailing newline; the caller is
 * expected to wrap it as `'---\\n' + serializeFrontmatter(data) + '\\n---\\n'`.
 *
 * @example
 *   serializeFrontmatter({ name: 'Account', count: 42, active: true });
 *   // => 'active: true\\ncount: 42\\nname: Account'
 *
 * @example
 *   serializeFrontmatter({ events: ['beforeInsert', 'afterUpdate'] });
 *   // => 'events:\\n  - beforeInsert\\n  - afterUpdate'
 */
export const serializeFrontmatter = (data: Readonly<Record<string, unknown>>): string =>
  serializeMap(data, 0);
