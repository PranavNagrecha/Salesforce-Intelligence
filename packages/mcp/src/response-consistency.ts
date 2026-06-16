/**
 * Schema-consistency analysis for the MCP tool surface (P11-api-response-consistency).
 *
 * Programmatic (non-LLM) consumers need a predictable tool surface, but the
 * same "the component this tool targets" concept is spelled three different
 * ways across the roster — `componentId`, `fieldId`, and a bare `id` — and new
 * tools keep inventing more. 0.1.7 is published, so RENAMING an existing key is
 * a breaking change; instead this analysis is **additive and detect-only**: it
 * grandfathers the id-keys that already shipped (a committed baseline) and fails
 * only when a NEW tool (or a changed schema) introduces a non-canonical id key.
 * That contains the drift without breaking anyone, and steers new tools to the
 * canonical key. See ADR-007.
 *
 * Pure and deterministic — it inspects declared input schemas only, no I/O — so
 * both the gate scanner (`scripts/check-response-consistency.mjs`) and the unit
 * test share this one implementation.
 */

/** The standard input key for "the component a tool targets". New tools use this. */
export const CANONICAL_ID_KEY = 'componentId';

/** An input property name is "id-ish" if it is `id` or ends in `Id`. */
export const isIdKey = (name: string): boolean => /(?:^id$|Id$)/.test(name);

/** Minimal shape this analysis needs from a V01_TOOLS entry. */
export interface ToolLike {
  readonly name: string;
  readonly inputSchema?: { readonly properties?: Readonly<Record<string, unknown>> };
}

/**
 * The grandfathered surface: every non-canonical id key that already shipped,
 * mapped to the exact tools allowed to use it. Anything outside this set (and
 * not the canonical key) is new drift.
 */
export interface ConsistencyBaseline {
  readonly canonicalKey: string;
  /** key name → sorted list of tool names permitted to use it today. */
  readonly allowed: Readonly<Record<string, readonly string[]>>;
}

/** One id-key usage that is neither canonical nor grandfathered. */
export interface ConsistencyViolation {
  readonly tool: string;
  readonly key: string;
  readonly message: string;
}

export interface ConsistencyReport {
  /** Every id-ish input key → the tools that declare it (the full drift picture). */
  readonly idKeyMap: Record<string, string[]>;
  /** New, non-grandfathered id-key usages — non-empty means the gate fails. */
  readonly violations: ConsistencyViolation[];
}

/** Collect the id-ish input property names a tool declares. */
const idKeysOf = (tool: ToolLike): string[] =>
  Object.keys(tool.inputSchema?.properties ?? {}).filter(isIdKey);

/**
 * Analyse the roster's input id-keys against the baseline.
 *
 * A usage is allowed when the key is the canonical key (any tool may use it) or
 * the exact (key, tool) pair is grandfathered in the baseline. Everything else
 * is a violation — a new tool inventing a key, or an existing tool growing a new
 * id key. Regenerate the baseline (with justification) to intentionally admit a
 * genuinely-distinct id concept.
 *
 * @example
 *   const { violations } = analyzeIdKeyConsistency(V01_TOOLS, baseline);
 *   if (violations.length) process.exit(1);
 */
export const analyzeIdKeyConsistency = (
  tools: readonly ToolLike[],
  baseline: ConsistencyBaseline,
): ConsistencyReport => {
  const idKeyMap: Record<string, string[]> = {};
  const violations: ConsistencyViolation[] = [];
  for (const tool of tools) {
    for (const key of idKeysOf(tool)) {
      (idKeyMap[key] ??= []).push(tool.name);
      if (key === baseline.canonicalKey) continue;
      const grandfathered = baseline.allowed[key]?.includes(tool.name) ?? false;
      if (grandfathered) continue;
      violations.push({
        tool: tool.name,
        key,
        message:
          `${tool.name} declares non-canonical id key \`${key}\`. ` +
          `Use \`${baseline.canonicalKey}\` for the component a tool targets, ` +
          `or — if \`${key}\` is a genuinely distinct concept — add it to the ` +
          `response-consistency baseline with a justification.`,
      });
    }
  }
  for (const list of Object.values(idKeyMap)) list.sort();
  return { idKeyMap, violations };
};

/** Regenerate a baseline that grandfathers the roster's CURRENT id-key usage. */
export const buildBaseline = (tools: readonly ToolLike[]): ConsistencyBaseline => {
  const allowed: Record<string, string[]> = {};
  for (const tool of tools) {
    for (const key of idKeysOf(tool)) {
      if (key === CANONICAL_ID_KEY) continue;
      (allowed[key] ??= []).push(tool.name);
    }
  }
  for (const list of Object.values(allowed)) list.sort();
  return { canonicalKey: CANONICAL_ID_KEY, allowed };
};

// ============================================================================
// Phase 2 (P11-api-response-output-shape): the OUTPUT surface.
//
// Phase 1 above is static — it reads declared INPUT schemas. Tools declare no
// output schema, so the OUTPUT shape can only be observed by running each tool
// and inspecting its real response. The harness captures, per tool, the keys of
// its output "rows" (the elements of the first object-array under `data`); this
// analysis flags the same canonical-id drift on the OUTPUT side that phase 1
// catches on the input side — a row that identifies a component with a
// non-canonical id key (`id` / `fieldId` …) instead of `componentId`. Same
// additive, detect-only, baseline-grandfathered contract as phase 1.
// ============================================================================

/** One tool's observed output-row shape (keys of the first object-array rows). */
export interface OutputShapeSample {
  readonly tool: string;
  readonly rowKeys: readonly string[];
}

/** The grandfathered OUTPUT id-key surface (non-canonical row id-keys per tool). */
export interface OutputShapeBaseline {
  readonly canonicalKey: string;
  readonly allowed: Readonly<Record<string, readonly string[]>>;
}

export interface OutputShapeReport {
  /** Every id-ish OUTPUT-row key → the tools that emit it. */
  readonly outputIdKeyMap: Record<string, string[]>;
  /** New, non-grandfathered output id-key usages — non-empty means the gate fails. */
  readonly violations: ConsistencyViolation[];
}

/** Collect the id-ish keys present in a sample's output rows. */
const outputIdKeysOf = (sample: OutputShapeSample): string[] =>
  [...new Set(sample.rowKeys)].filter(isIdKey);

/**
 * Analyse observed output-row id-keys against the baseline. A row id-key is
 * allowed when it is the canonical key or the exact (key, tool) pair is
 * grandfathered; anything else is a NEW tool (or changed output) emitting a
 * non-canonical id key in its rows — steer it to `componentId`, or admit the
 * distinct concept by regenerating the baseline.
 */
export const analyzeOutputShape = (
  samples: readonly OutputShapeSample[],
  baseline: OutputShapeBaseline,
): OutputShapeReport => {
  const outputIdKeyMap: Record<string, string[]> = {};
  const violations: ConsistencyViolation[] = [];
  for (const sample of samples) {
    for (const key of outputIdKeysOf(sample)) {
      (outputIdKeyMap[key] ??= []).push(sample.tool);
      if (key === baseline.canonicalKey) continue;
      if (baseline.allowed[key]?.includes(sample.tool) ?? false) continue;
      violations.push({
        tool: sample.tool,
        key,
        message:
          `${sample.tool} emits a non-canonical id key \`${key}\` in its output rows. ` +
          `Use \`${baseline.canonicalKey}\` for the component a row identifies, ` +
          `or — if \`${key}\` is a genuinely distinct concept — add it to the ` +
          `output-shape baseline with a justification.`,
      });
    }
  }
  for (const list of Object.values(outputIdKeyMap)) list.sort();
  return { outputIdKeyMap, violations };
};

/** Regenerate an output-shape baseline grandfathering the CURRENT row id-keys. */
export const buildOutputShapeBaseline = (
  samples: readonly OutputShapeSample[],
): OutputShapeBaseline => {
  const allowed: Record<string, string[]> = {};
  for (const sample of samples) {
    for (const key of outputIdKeysOf(sample)) {
      if (key === CANONICAL_ID_KEY) continue;
      if (!(allowed[key] ??= []).includes(sample.tool)) allowed[key].push(sample.tool);
    }
  }
  for (const list of Object.values(allowed)) list.sort();
  return { canonicalKey: CANONICAL_ID_KEY, allowed };
};
