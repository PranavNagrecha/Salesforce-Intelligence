/**
 * Shared helpers for P4-C5 `callsApex` edge method metadata.
 *
 * The apex-scanner aggregates call sites per target class into one edge
 * carrying `properties.methods[]` (complete set of invoked target methods).
 * Composite tools use these helpers to filter walks at the root hop.
 */

/** Read target methods from a `callsApex` edge (P4-C5). */
export const edgeMethods = (edge: {
  readonly properties: Readonly<Record<string, unknown>>;
}): readonly string[] => {
  const m = edge.properties['methods'];
  if (Array.isArray(m)) {
    const strs = m.filter((x): x is string => typeof x === 'string');
    return [...new Set(strs)].sort();
  }
  const scalar = edge.properties['methodName'];
  return typeof scalar === 'string' && scalar.length > 0 ? [scalar] : [];
};

/** True when the edge invokes `methodName` on its target class. */
export const edgeCallsMethod = (
  edge: { readonly properties: Readonly<Record<string, unknown>> },
  methodName: string,
): boolean => edgeMethods(edge).includes(methodName);
