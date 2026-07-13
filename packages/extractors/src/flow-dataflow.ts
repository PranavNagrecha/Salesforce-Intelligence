/**
 * R6-11 — field-level dataflow tracing through a Flow's assignment chain.
 *
 * The flow extractor (`flow.ts`) has always emitted FIELD-level `writesTo`
 * edges for DML `<inputAssignments>`, but the assigned `<value>` was captured
 * only as an opaque `assignedValue` string. This module traces a
 * reference-valued assignment BACK through the flow's internal plumbing —
 * `<assignments>` items, `<variables>`, `<formulas>`, `<recordLookups>`
 * outputs, `<loops>` — to the record FIELDS the value was read from, so
 * `sfi.field_lineage` can chain a written field to the flow's input fields
 * instead of dead-ending at the Flow node.
 *
 * Honesty contract (the design's spine):
 *
 *   - `declared` confidence ONLY for chains the XML states outright: a direct
 *     `$Record.Field` / `$Record__Prior.Field` reference, a single-record
 *     lookup's output field (`Get_X.Field`, `<outputAssignments>`,
 *     `<outputReference>`), or such a source carried through variable hops
 *     that are each assigned EXACTLY ONCE with operator `Assign`.
 *   - `heuristic` for anything traced through a formula expression, a loop
 *     element (per-iteration indirection), or a non-`Assign` operator
 *     (`Add` etc. — the field feeds the value but is not a clean copy).
 *   - Everything else is UNRESOLVED and counted, never guessed: variables
 *     assigned more than once (statically ambiguous), relationship
 *     traversals (`$Record.Parent__r.Name` — the offline vault cannot join
 *     the relationship to an object), collection references, action/subflow/
 *     screen outputs, flow input variables (caller-supplied), and chains
 *     deeper than {@link FLOW_DATAFLOW_TRACE_DEPTH_CAP} (capped + flagged).
 *   - Non-`$Record` globals (`$Flow.*`, `$User.*`, `$Label.*`, …) are
 *     runtime context, not record fields: they contribute no source field
 *     and are NOT counted as unresolved (the trace resolved them — to
 *     "not a field").
 */

/** Confidence labels a traced source field can carry (subset of the edge
 * `ConfidenceLevel` union — `parsed` is deliberately absent: a trace is
 * either stated outright by the XML chain or inferred through indirection). */
export type DataflowConfidence = 'declared' | 'heuristic';

/**
 * Maximum number of indirection hops (variable → variable, variable →
 * formula, …) a single value trace follows before giving up. Chains deeper
 * than this are disclosed via `depthCapped` + one unresolved count — a
 * five-hop assignment relay is already rare in real flows, and an unbounded
 * walk could loop on pathological XML even with cycle detection.
 */
export const FLOW_DATAFLOW_TRACE_DEPTH_CAP = 5;

/**
 * The `properties.operation` marker on the FIELD-level `readsFrom` edges
 * this tracer derives (Flow → source CustomField). Distinguishes them from
 * the object-level `recordLookup` / `recordUpdate` read edges so consumers
 * that enumerate a flow's lookups (e.g. `explain_flow`) can filter them out,
 * while field-usage consumers pick them up like the apex-scanner's
 * field-level `readsFrom` edges.
 */
export const DATAFLOW_SOURCE_OPERATION = 'dataflowSource';

/** One resolved source field: `{Object}.{Field}` plus its trace confidence. */
export interface TracedSourceField {
  readonly field: string;
  readonly confidence: DataflowConfidence;
}

/** The outcome of tracing ONE value reference. */
export interface DataflowTrace {
  /** Resolved source fields, deduped, in first-seen order. */
  readonly sources: readonly TracedSourceField[];
  /** References that could NOT be resolved to a field — disclosed, never guessed. */
  readonly unresolvedCount: number;
  /** True when the walk hit {@link FLOW_DATAFLOW_TRACE_DEPTH_CAP}. */
  readonly depthCapped: boolean;
}

/** A `<variables>` declaration relevant to tracing. */
interface FlowVariableInfo {
  readonly objectType: string | null;
  readonly isCollection: boolean;
  readonly isInput: boolean;
}

/** A `<recordLookups>` element's trace-relevant surface. */
interface FlowLookupInfo {
  readonly object: string | null;
  readonly getFirstRecordOnly: boolean;
  readonly outputReference: string | null;
  readonly outputAssignments: ReadonlyArray<{
    readonly assignToReference: string;
    readonly field: string;
  }>;
}

/** One `<assignmentItems>` write, keyed by its full `assignToReference`. */
interface FlowAssignmentWrite {
  readonly operator: string;
  /** The `<value>` as an element reference, or null when it was a literal. */
  readonly reference: string | null;
}

/** The per-flow index the tracer resolves references against. */
export interface FlowDataflowIndex {
  readonly variables: ReadonlyMap<string, FlowVariableInfo>;
  readonly formulas: ReadonlyMap<string, string>;
  readonly lookups: ReadonlyMap<string, FlowLookupInfo>;
  /** Loop element name → its `<collectionReference>`. */
  readonly loops: ReadonlyMap<string, string | null>;
  /** Full `assignToReference` string → every write against it, in source order. */
  readonly assignmentWrites: ReadonlyMap<string, readonly FlowAssignmentWrite[]>;
  /** The `<start><object>` when `$Record` names a concrete SObject, else null. */
  readonly recordObject: string | null;
}

// ---------------------------------------------------------------------------
// XML shape helpers — local copies of flow.ts's tiny fast-xml-parser
// normalizers (each extractor module keeps its own, per the repo idiom).
// ---------------------------------------------------------------------------

const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const toNonEmptyString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

const asObject = (value: unknown): Record<string, unknown> | null => {
  const v = unwrapSingle(value);
  return typeof v === 'object' && v !== null
    ? (v as Record<string, unknown>)
    : null;
};

/**
 * Read an `<assignmentItems><value>` (or any Flow value wrapper) as an
 * element reference. Returns the reference string for
 * `<elementReference>`-wrapped values and `null` for literal wrappers
 * (`stringValue` etc.) or missing values — literals terminate a trace
 * cleanly with zero field sources.
 */
const valueAsReference = (value: unknown): string | null => {
  const obj = asObject(value);
  if (obj === null) return null;
  return toNonEmptyString(obj['elementReference']);
};

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

/**
 * Build the per-flow reference index the tracer resolves against. Pure and
 * defensive: malformed elements are skipped (the caller's extraction-warning
 * machinery already covers structural noise; the tracer just resolves less).
 *
 * @param rootObj The parsed `<Flow>` root.
 * @param recordObject The SObject `$Record` names for this flow — the
 *   `<start><object>` of a record-scoped flow — or null when `$Record` has
 *   no statically-known type (autolaunched/screen flows).
 */
export const buildFlowDataflowIndex = (
  rootObj: Record<string, unknown>,
  recordObject: string | null,
): FlowDataflowIndex => {
  const variables = new Map<string, FlowVariableInfo>();
  for (const raw of toArray(rootObj['variables'])) {
    const v = asObject(raw);
    if (v === null) continue;
    const name = toNonEmptyString(v['name']);
    if (name === null) continue;
    variables.set(name, {
      objectType: toNonEmptyString(v['objectType']),
      isCollection: String(unwrapSingle(v['isCollection'])) === 'true',
      isInput: String(unwrapSingle(v['isInput'])) === 'true',
    });
  }

  const formulas = new Map<string, string>();
  for (const raw of toArray(rootObj['formulas'])) {
    const f = asObject(raw);
    if (f === null) continue;
    const name = toNonEmptyString(f['name']);
    const expression = toNonEmptyString(f['expression']);
    if (name === null || expression === null) continue;
    formulas.set(name, expression);
  }

  const lookups = new Map<string, FlowLookupInfo>();
  for (const raw of toArray(rootObj['recordLookups'])) {
    const l = asObject(raw);
    if (l === null) continue;
    const name = toNonEmptyString(l['name']);
    if (name === null) continue;
    const outputAssignments: Array<{ assignToReference: string; field: string }> = [];
    for (const oaRaw of toArray(l['outputAssignments'])) {
      const oa = asObject(oaRaw);
      if (oa === null) continue;
      const assignToReference = toNonEmptyString(oa['assignToReference']);
      const field = toNonEmptyString(oa['field']);
      if (assignToReference === null || field === null) continue;
      outputAssignments.push({ assignToReference, field });
    }
    lookups.set(name, {
      object: toNonEmptyString(l['object']),
      getFirstRecordOnly: String(unwrapSingle(l['getFirstRecordOnly'])) === 'true',
      outputReference: toNonEmptyString(l['outputReference']),
      outputAssignments,
    });
  }

  const loops = new Map<string, string | null>();
  for (const raw of toArray(rootObj['loops'])) {
    const l = asObject(raw);
    if (l === null) continue;
    const name = toNonEmptyString(l['name']);
    if (name === null) continue;
    loops.set(name, toNonEmptyString(l['collectionReference']));
  }

  const assignmentWrites = new Map<string, FlowAssignmentWrite[]>();
  for (const raw of toArray(rootObj['assignments'])) {
    const a = asObject(raw);
    if (a === null) continue;
    for (const itemRaw of toArray(a['assignmentItems'])) {
      const item = asObject(itemRaw);
      if (item === null) continue;
      const target = toNonEmptyString(item['assignToReference']);
      if (target === null) continue;
      const operator = toNonEmptyString(item['operator']) ?? 'Assign';
      const reference = valueAsReference(item['value']);
      const writes = assignmentWrites.get(target) ?? [];
      writes.push({ operator, reference });
      assignmentWrites.set(target, writes);
    }
  }

  return { variables, formulas, lookups, loops, assignmentWrites, recordObject };
};

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

/** Mutable accumulator threaded through one top-level trace. */
interface TraceAccumulator {
  /** field → best confidence seen (declared beats heuristic). */
  readonly sources: Map<string, DataflowConfidence>;
  unresolvedCount: number;
  depthCapped: boolean;
  /** References currently on the resolution stack (cycle guard). */
  readonly visiting: Set<string>;
}

const addSource = (
  acc: TraceAccumulator,
  field: string,
  confidence: DataflowConfidence,
): void => {
  const existing = acc.sources.get(field);
  if (existing === 'declared') return;
  if (existing === undefined || confidence === 'declared') {
    acc.sources.set(field, confidence);
  }
};

/** Extract `{!token}` references from a Flow formula expression. */
const formulaTokens = (expression: string): string[] => {
  const out: string[] = [];
  const re = /\{!([^}]+)\}/g;
  for (let m = re.exec(expression); m !== null; m = re.exec(expression)) {
    const token = m[1]?.trim();
    if (token !== undefined && token.length > 0) out.push(token);
  }
  return out;
};

/**
 * Resolve ONE reference string. `demoted` is true once the chain has passed
 * through any indirection that downgrades confidence (formula, loop,
 * non-Assign operator) — every field found below that point is `heuristic`.
 */
const resolveRef = (
  index: FlowDataflowIndex,
  acc: TraceAccumulator,
  ref: string,
  depth: number,
  demoted: boolean,
): void => {
  if (depth > FLOW_DATAFLOW_TRACE_DEPTH_CAP) {
    acc.depthCapped = true;
    acc.unresolvedCount += 1;
    return;
  }
  if (acc.visiting.has(ref)) {
    // Reference cycle (a variable chain that loops) — statically unresolvable.
    acc.unresolvedCount += 1;
    return;
  }
  acc.visiting.add(ref);
  try {
    resolveRefInner(index, acc, ref, depth, demoted);
  } finally {
    acc.visiting.delete(ref);
  }
};

const confidenceOf = (demoted: boolean): DataflowConfidence =>
  demoted ? 'heuristic' : 'declared';

const resolveRefInner = (
  index: FlowDataflowIndex,
  acc: TraceAccumulator,
  ref: string,
  depth: number,
  demoted: boolean,
): void => {
  // --- $Record / $Record__Prior --------------------------------------------
  if (ref === '$Record' || ref === '$Record__Prior') {
    // A whole-record reference used as a VALUE — not a field source.
    acc.unresolvedCount += 1;
    return;
  }
  if (ref.startsWith('$Record.') || ref.startsWith('$Record__Prior.')) {
    const rest = ref.slice(ref.indexOf('.') + 1);
    if (rest.includes('.')) {
      // Relationship traversal ($Record.Parent__r.Name): the offline vault
      // cannot resolve the relationship to an object — disclosed.
      acc.unresolvedCount += 1;
      return;
    }
    if (index.recordObject === null) {
      acc.unresolvedCount += 1;
      return;
    }
    addSource(acc, `${index.recordObject}.${rest}`, confidenceOf(demoted));
    return;
  }
  // --- Other globals ($Flow.*, $User.*, $Label.*, …) -------------------------
  if (ref.startsWith('$')) {
    // Runtime context, not a record field: resolved to "no field source".
    return;
  }

  const dotIdx = ref.indexOf('.');
  const head = dotIdx < 0 ? ref : ref.slice(0, dotIdx);
  const rest = dotIdx < 0 ? null : ref.slice(dotIdx + 1);

  // --- Record lookup outputs (storeOutputAutomatically) ---------------------
  const lookup = index.lookups.get(head);
  if (lookup !== undefined) {
    if (rest === null || rest.includes('.') || lookup.object === null) {
      // Whole record/collection value, deeper traversal, or an object-less
      // lookup — not a resolvable single field.
      acc.unresolvedCount += 1;
      return;
    }
    if (!lookup.getFirstRecordOnly) {
      // A collection lookup's `.field` cannot name one record's field.
      acc.unresolvedCount += 1;
      return;
    }
    addSource(acc, `${lookup.object}.${rest}`, confidenceOf(demoted));
    return;
  }

  // --- Loop elements ---------------------------------------------------------
  const loopCollection = index.loops.get(head);
  if (loopCollection !== undefined) {
    if (rest === null || rest.includes('.')) {
      acc.unresolvedCount += 1;
      return;
    }
    // The loop element's object comes from its collection: a lookup's target
    // object or a collection variable's objectType. Per-iteration indirection
    // is ALWAYS heuristic.
    const srcLookup = loopCollection === null ? undefined : index.lookups.get(loopCollection);
    const srcVar = loopCollection === null ? undefined : index.variables.get(loopCollection);
    const object = srcLookup?.object ?? srcVar?.objectType ?? null;
    if (object === null) {
      acc.unresolvedCount += 1;
      return;
    }
    addSource(acc, `${object}.${rest}`, 'heuristic');
    return;
  }

  // --- Formulas ---------------------------------------------------------------
  const formula = index.formulas.get(head);
  if (formula !== undefined) {
    if (rest !== null) {
      acc.unresolvedCount += 1;
      return;
    }
    // Every field reached through a formula expression is heuristic — the
    // value is derived, not copied.
    for (const token of formulaTokens(formula)) {
      resolveRef(index, acc, token, depth + 1, true);
    }
    return;
  }

  // --- Variables ---------------------------------------------------------------
  const variable = index.variables.get(head);
  if (variable !== undefined) {
    resolveVariableRef(index, acc, head, rest, variable, depth, demoted);
    return;
  }

  // --- Unknown head (action output, screen field, subflow output, …) -----------
  acc.unresolvedCount += 1;
};

/**
 * Resolve a variable reference (`var` or `var.Field`). Writers are gathered
 * from `<assignments>` items and record-lookup outputs; EXACTLY ONE writer
 * resolves, anything else is ambiguous and disclosed.
 */
const resolveVariableRef = (
  index: FlowDataflowIndex,
  acc: TraceAccumulator,
  name: string,
  rest: string | null,
  variable: FlowVariableInfo,
  depth: number,
  demoted: boolean,
): void => {
  if (rest !== null && rest.includes('.')) {
    acc.unresolvedCount += 1;
    return;
  }
  if (variable.isCollection) {
    // Collection contents are built across iterations — not statically a
    // single record's field.
    acc.unresolvedCount += 1;
    return;
  }

  if (rest === null) {
    // Scalar variable: writers are direct assignment items plus lookup
    // <outputAssignments> targeting it.
    const assignWrites = index.assignmentWrites.get(name) ?? [];
    const lookupWrites: Array<{ object: string | null; field: string }> = [];
    for (const l of index.lookups.values()) {
      for (const oa of l.outputAssignments) {
        if (oa.assignToReference === name) {
          lookupWrites.push({ object: l.object, field: oa.field });
        }
      }
    }
    const total = assignWrites.length + lookupWrites.length;
    if (total !== 1) {
      // 0 writers (flow input / populated by an unmodeled surface) or >1
      // (statically ambiguous) — disclosed either way.
      acc.unresolvedCount += 1;
      return;
    }
    if (lookupWrites.length === 1) {
      const w = lookupWrites[0];
      if (w === undefined || w.object === null) {
        acc.unresolvedCount += 1;
        return;
      }
      addSource(acc, `${w.object}.${w.field}`, confidenceOf(demoted));
      return;
    }
    const w = assignWrites[0];
    if (w === undefined) {
      acc.unresolvedCount += 1;
      return;
    }
    if (w.reference === null) return; // literal — clean zero-source terminal
    resolveRef(index, acc, w.reference, depth + 1, demoted || w.operator !== 'Assign');
    return;
  }

  // Record-variable subfield (`var.Field`): field-level assignment writers
  // take precedence (they overwrite wholesale population); fall back to
  // wholesale writers (lookup outputReference / whole-variable assignment)
  // and re-project the field through them.
  const fieldWrites = index.assignmentWrites.get(`${name}.${rest}`) ?? [];
  if (fieldWrites.length > 1) {
    acc.unresolvedCount += 1;
    return;
  }
  if (fieldWrites.length === 1) {
    const w = fieldWrites[0];
    if (w === undefined) {
      acc.unresolvedCount += 1;
      return;
    }
    if (w.reference === null) return; // literal into the subfield
    resolveRef(index, acc, w.reference, depth + 1, demoted || w.operator !== 'Assign');
    return;
  }

  // Wholesale writers.
  const wholesale: string[] = [];
  for (const [lookupName, l] of index.lookups) {
    if (l.outputReference === name) wholesale.push(lookupName);
  }
  const wholeVarWrites = index.assignmentWrites.get(name) ?? [];
  if (wholesale.length + wholeVarWrites.length !== 1) {
    acc.unresolvedCount += 1;
    return;
  }
  if (wholesale.length === 1) {
    const l = wholesale[0] === undefined ? undefined : index.lookups.get(wholesale[0]);
    if (l === undefined || l.object === null || !l.getFirstRecordOnly) {
      acc.unresolvedCount += 1;
      return;
    }
    addSource(acc, `${l.object}.${rest}`, confidenceOf(demoted));
    return;
  }
  const w = wholeVarWrites[0];
  if (w === undefined || w.reference === null) {
    acc.unresolvedCount += 1;
    return;
  }
  // Re-project the subfield through the wholesale source (`otherVar` →
  // `otherVar.Field`, `$Record` → `$Record.Field`, `Get_X` → `Get_X.Field`).
  resolveRef(index, acc, `${w.reference}.${rest}`, depth + 1, demoted || w.operator !== 'Assign');
};

/**
 * Trace one value reference (a DML `<inputAssignments><value>`
 * `<elementReference>`) back to the record fields it derives from.
 *
 * @example
 *   const index = buildFlowDataflowIndex(rootObj, 'Contact');
 *   const trace = traceValueReference(index, '$Record.Email');
 *   // trace.sources => [{ field: 'Contact.Email', confidence: 'declared' }]
 */
export const traceValueReference = (
  index: FlowDataflowIndex,
  ref: string,
): DataflowTrace => {
  const acc: TraceAccumulator = {
    sources: new Map(),
    unresolvedCount: 0,
    depthCapped: false,
    visiting: new Set(),
  };
  resolveRef(index, acc, ref.trim(), 1, false);
  return {
    sources: [...acc.sources.entries()].map(([field, confidence]) => ({
      field,
      confidence,
    })),
    unresolvedCount: acc.unresolvedCount,
    depthCapped: acc.depthCapped,
  };
};
