/**
 * Collision-safe Mermaid node-id sanitizer, shared by every mermaid-emitting
 * renderer that needs a diagram-legal identifier for a real Salesforce
 * component id / api name (R6-19). Mermaid identifiers only tolerate
 * `[A-Za-z0-9_]`; canonical component ids carry `:` (the type prefix) and
 * `.` (a `CustomField:{Object}.{Field}` id), and api names occasionally
 * carry a managed-package namespace prefix (`ns__Object__c`) — none of
 * which are mermaid-identifier-safe on their own.
 *
 * A naive per-string regex replace (`x.replace(/[^A-Za-z0-9_]/g, '_')`) can
 * collide two DIFFERENT source strings onto the SAME sanitized code (e.g.
 * `Foo-Bar` and `Foo.Bar` both become `Foo_Bar`), which would silently merge
 * two distinct diagram nodes into one. {@link buildSafeMermaidIdMap} tracks
 * used codes and appends a numeric suffix on collision, so every distinct
 * input string gets a distinct output code.
 */

/**
 * Build a `rawValue -> mermaid-safe id` map for every distinct string in
 * `values`. Pure and deterministic: iterating the SAME input array always
 * yields the SAME map. Callers pass the id/label a diagram node stands for
 * (a canonical component id, an api name, …); the returned map's values are
 * used as the diagram's node identifiers, while the raw strings stay
 * available for the diagram's LABELS (which mermaid double-quotes and does
 * not restrict to identifier characters).
 */
export const buildSafeMermaidIdMap = (
  values: readonly string[],
): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const raw of values) {
    if (map.has(raw)) continue;
    let base = raw.replace(/[^A-Za-z0-9_]/g, '_');
    if (base.length === 0) base = '_';
    // Mermaid ids may not start with a digit in every parser version; guard
    // defensively rather than rely on lenient behavior.
    if (/^[0-9]/.test(base)) base = `_${base}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix.toString()}`;
      suffix += 1;
    }
    used.add(candidate);
    map.set(raw, candidate);
  }
  return map;
};

/**
 * Escape a value for use inside a mermaid double-quoted `"label"`. Collapses
 * newlines (which would otherwise break the diagram's line-oriented syntax)
 * and replaces an embedded `"` with `'` (a real double-quote would close the
 * label early and corrupt the rest of the line) — the same defensive intent
 * as `packages/mcp`'s `escapeCell` helpers, specialized for mermaid's quoting
 * rule rather than a Markdown table cell's.
 */
export const safeMermaidLabel = (raw: string): string =>
  raw.replace(/\r?\n/g, ' ').replace(/"/g, "'");
