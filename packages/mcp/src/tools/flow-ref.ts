/**
 * Shared Flow-reference resolver — the single front door both `sfi.flow_graph`
 * and `sfi.flow_trace` use to turn ANY caller-supplied `flowRef` into one
 * canonical Flow node (spec §3).
 *
 * A `flowRef` arrives in one of three shapes, and this resolver is the ONLY
 * place that reconciles them, so the two tools never re-implement (and never
 * drift on) the id/name axis:
 *
 *   1. **Canonical component id** (`Flow:My_Flow`) — a direct `getNodeById`.
 *      `resolvedForm: 'canonical-id'`, `matchConfidence: 'exact'`.
 *   2. **Bare API name** (`My_Flow`) — normalized to `Flow:My_Flow` via
 *      {@link coercePrefix} and looked up exactly; on a miss it falls back to
 *      the typo-tolerant `resolveComponents` fuzzy resolver SCOPED to Flows.
 *      `resolvedForm: 'api-name'`, `matchConfidence: 'exact'` on the direct hit
 *      or `'fuzzy'` on the fallback single winner.
 *   3. **Salesforce record id** (`301…` FlowDefinition / `300…` Flow version) —
 *      the offline vault stores flows keyed by API name and has NO record ids,
 *      so this path resolves an id ONLY through a Tooling-API-enriched
 *      `meta/flow-id-index.json` (or a manifest-carried map). When that index
 *      does not exist the resolver **fails closed** with an actionable
 *      `invalid-query` (never a guess). `resolvedForm: 'record-id'`.
 *
 * **Ambiguity is a SUCCESS, not an error.** Mirroring `sfi.resolve`
 * (`resolve.ts`), when a bare name fuzzily matches MORE than one Flow the
 * resolver does NOT pick one — it returns an `ok()` envelope tagged
 * `outcome: 'ambiguous'` carrying the ranked `candidates[]` so the host LLM (or
 * the user) disambiguates. There is deliberately NO `ambiguous-flow` McpError
 * kind (the `McpError.kind` union is closed); disclosure over guessing is the
 * whole product thesis.
 *
 * The four `McpError` outcomes this resolver DOES return:
 *   - `invalid-query` — a wrong `Type:` prefix (e.g. `CustomObject:Account`) or
 *     a record id with no id→apiName index (fail-closed).
 *   - `component-not-found` — a well-formed reference that resolves to nothing,
 *     or to a non-Flow node (reusing `explain_flow`'s helpful "…but 'X' exists
 *     — it is a Y, not a Flow" wording when a same-named non-Flow exists).
 *   - `internal` — an underlying graph-query failure.
 *
 * The tools branch on the returned `Result`:
 * ```ts
 * const r = await resolveFlowRef(ctx, input.flowRef);
 * if (!r.ok) return err(r.error);                 // invalid-query / not-found / internal
 * if (r.value.outcome === 'ambiguous') {          // surface candidates, do not proceed
 *   return okAmbiguous(r.value.candidates);
 * }
 * const { resolved, node } = r.value;             // outcome === 'resolved'
 * ```
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentId,
  ComponentType,
  McpError,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, resolveComponents } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';

/** Canonical id prefix for the Flow node type. */
const FLOW_PREFIX = 'Flow:';

/**
 * Salesforce record-id shape for a Flow reference. KeyPrefix `301` =
 * `FlowDefinition`, `300` = `Flow` (version); the 15-char base id may carry a
 * 3-char case-safe suffix (the 18-char form). A Salesforce API name can never
 * match this (api names must start with a letter), so there is no collision
 * with the bare-name path.
 */
const RECORD_ID_PATTERN = /^30[01][A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

/** The `{vaultRoot}`-relative id→apiName index the Tooling-API enrichment writes. */
const FLOW_ID_INDEX_RELPATH = join('meta', 'flow-id-index.json');

/**
 * The verbatim fail-closed message for a record id with no id→apiName index.
 * Frozen here so the test suite can assert it exactly and a rephrasing is a
 * code-review concern, not a silent drift. Points the caller at the two ways to
 * get an id-resolvable vault, and at the always-available API-name path.
 */
export const RECORD_ID_NO_INDEX_MESSAGE =
  'Flow record ids need a Tooling-API-enriched vault (`sfi refresh --with-tooling-api`) or the live plane; pass the Flow API name instead.';

/** Component types a caller might mistake for a Flow (mirrors `explain_flow`). */
const ALTERNATE_TYPE_PREFIXES = [
  'ApexTrigger',
  'ApexClass',
  'WorkflowRule',
  'ValidationRule',
] as const;

/** Type scope for the fuzzy fallback — Flows only. */
const FLOW_TYPE_SCOPE: readonly ComponentType[] = ['Flow'];

/**
 * One ranked Flow candidate surfaced on a fuzzy/ambiguous resolution. A faithful
 * projection of the graph resolver's candidate (`resolveComponents`) down to the
 * three fields a caller needs to disambiguate or to record the near-miss.
 */
export interface FlowRefCandidate {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly score: number;
}

/**
 * How a `flowRef` resolved (spec §3). Returned inside every consuming tool's
 * `data.flowRef`. `candidates` is present ONLY on a fuzzy single winner (the one
 * candidate) — the ambiguous case never reaches this shape (see
 * {@link FlowRefResolution}).
 */
export interface ResolvedFlowRef {
  /** The raw input, echoed back verbatim. */
  readonly requested: string;
  readonly resolvedForm: 'canonical-id' | 'api-name' | 'record-id';
  /** Canonical id (`Flow:{ApiName}`). */
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly label: string | null;
  readonly matchConfidence: 'exact' | 'fuzzy';
  /** Present only on a fuzzy resolution (the ranked near-misses). */
  readonly candidates?: readonly FlowRefCandidate[];
}

/**
 * The resolver landed on exactly one Flow. `node` is the resolved graph node so
 * the caller does not re-fetch it.
 */
export interface FlowRefResolved {
  readonly outcome: 'resolved';
  readonly resolved: ResolvedFlowRef;
  readonly node: Node;
}

/**
 * A bare name fuzzily matched MORE than one Flow. The resolver does NOT pick —
 * it hands the ranked `candidates[]` back so the caller (or user) disambiguates,
 * mirroring `sfi.resolve`'s `ambiguous` disposition. A SUCCESS envelope, never
 * an McpError.
 */
export interface FlowRefAmbiguous {
  readonly outcome: 'ambiguous';
  readonly requested: string;
  readonly candidates: readonly FlowRefCandidate[];
}

/** The success (`ok`) payload: a resolved Flow OR an ambiguity to surface. */
export type FlowRefResolution = FlowRefResolved | FlowRefAmbiguous;

/** Read a Flow's display label — `properties.label`, then the node label, else null. */
const readLabel = (node: Node): string | null => {
  const raw = node.properties['label'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return node.label;
};

/** Extract the canonical-id prefix (the substring before the first colon). */
const prefixOf = (id: ComponentId): string => {
  const colonIdx = id.indexOf(':');
  return colonIdx < 0 ? '' : id.slice(0, colonIdx);
};

/**
 * Return the canonical id of a same-named node under another common automation /
 * code type, or null. Lets a Flow miss point at the real component — "explain
 * flow AccountTrigger" is really an `ApexTrigger:AccountTrigger` — instead of a
 * dead end. Mirrors `explain_flow`'s `findAlternateTypeId`.
 */
const findAlternateTypeId = async (
  ctx: Context,
  bareName: string,
): Promise<ComponentId | null> => {
  for (const prefix of ALTERNATE_TYPE_PREFIXES) {
    const candidate = `${prefix}:${bareName}` as ComponentId;
    // eslint-disable-next-line no-await-in-loop -- bounded by ALTERNATE_TYPE_PREFIXES (4).
    const r = await getNodeById(ctx.graph, candidate);
    if (r.ok && r.value !== null) return candidate;
  }
  return null;
};

/**
 * Build the `component-not-found` error for a Flow miss, adding `explain_flow`'s
 * helpful "…but 'X' exists — it is a Y, not a Flow" wording when a same-named
 * non-Flow component exists.
 */
const notFoundError = async (
  ctx: Context,
  flowId: ComponentId,
  bareName: string,
): Promise<McpError> => {
  const alt = await findAlternateTypeId(ctx, bareName);
  return {
    kind: 'component-not-found',
    message: alt
      ? `no Flow named '${bareName}', but '${alt}' exists — it is a ${prefixOf(alt)}, not a Flow. flow_graph / flow_trace only handle Flows; use the matching component tool for '${alt}'.`
      : `no Flow with id ${flowId}`,
    path: flowId,
  };
};

/**
 * Read the id→apiName index the Tooling-API enrichment produces, or `null` when
 * absent. Precedence: a manifest-carried `flowIdIndex` map, then the on-disk
 * `meta/flow-id-index.json`. A malformed / non-object payload is treated as
 * absent (fail-closed), never a partial guess. Only the record-id path touches
 * this — no I/O on the common name/id paths.
 */
const readFlowIdIndex = async (
  ctx: Context,
): Promise<Readonly<Record<string, string>> | null> => {
  const fromManifest = (ctx.manifest as unknown as Record<string, unknown>)[
    'flowIdIndex'
  ];
  if (
    fromManifest !== null &&
    typeof fromManifest === 'object' &&
    !Array.isArray(fromManifest)
  ) {
    return fromManifest as Readonly<Record<string, string>>;
  }
  let raw: string;
  try {
    raw = await readFile(join(ctx.vaultRoot, FLOW_ID_INDEX_RELPATH), 'utf-8');
  } catch {
    return null; // File absent / unreadable → treat as no index.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // Malformed JSON → fail closed rather than guess.
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Readonly<Record<string, string>>;
};

/**
 * Fetch a Flow node by canonical id and validate it. Returns:
 *   - `ok(node)` — the node exists and is a Flow.
 *   - `ok(null)` — no such node (caller decides: fuzzy fallback vs not-found).
 *   - `err(McpError)` — a graph failure (`internal`) or a wrong-type hit
 *     (`component-not-found`), which the caller surfaces verbatim.
 */
const fetchFlowNode = async (
  ctx: Context,
  flowId: ComponentId,
): Promise<Result<Node | null, McpError>> => {
  const nodeResult = await getNodeById(ctx.graph, flowId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) return ok(null);
  const node = nodeResult.value;
  // Defensive: the `Flow:` prefix pins the type, but a graph round-trip could in
  // principle return a differently-typed node. Treat that as not-found — the
  // request cannot be satisfied by what the vault holds.
  if (node.type !== 'Flow') {
    return err({
      kind: 'component-not-found',
      message: `node ${flowId} is not a Flow (type=${node.type})`,
      path: flowId,
    });
  }
  return ok(node);
};

/** Assemble the `resolved` success envelope for a single Flow node. */
const resolvedEnvelope = (
  requested: string,
  resolvedForm: ResolvedFlowRef['resolvedForm'],
  matchConfidence: ResolvedFlowRef['matchConfidence'],
  node: Node,
  candidates?: readonly FlowRefCandidate[],
): FlowRefResolved => ({
  outcome: 'resolved',
  resolved: {
    requested,
    resolvedForm,
    componentId: node.id,
    apiName: node.apiName,
    label: readLabel(node),
    matchConfidence,
    ...(candidates !== undefined ? { candidates } : {}),
  },
  node,
});

/**
 * Resolve a record id (`300…` / `301…`) through the id→apiName index. Fails
 * closed (`invalid-query`) when no index exists — the offline vault has no
 * record ids and this resolver never guesses one.
 */
const resolveRecordId = async (
  ctx: Context,
  flowRef: string,
): Promise<Result<FlowRefResolution, McpError>> => {
  const index = await readFlowIdIndex(ctx);
  if (index === null) {
    return err({
      kind: 'invalid-query',
      message: RECORD_ID_NO_INDEX_MESSAGE,
      path: 'flowRef',
    });
  }
  const apiName = index[flowRef];
  if (typeof apiName !== 'string' || apiName.length === 0) {
    // The index exists (enrichment ran) but this id is not in it → a genuine
    // not-found for the record id, distinct from the fail-closed no-index case.
    return err({
      kind: 'component-not-found',
      message: `no Flow with record id ${flowRef} in the id index`,
      path: 'flowRef',
    });
  }
  const flowId = `${FLOW_PREFIX}${apiName}` as ComponentId;
  const nodeResult = await fetchFlowNode(ctx, flowId);
  if (!nodeResult.ok) return err(nodeResult.error);
  if (nodeResult.value === null) {
    return err(await notFoundError(ctx, flowId, apiName));
  }
  return ok(resolvedEnvelope(flowRef, 'record-id', 'exact', nodeResult.value));
};

/**
 * Resolve a `flowRef` to one canonical Flow node, or to an ambiguity envelope.
 *
 * See the module JSDoc for the full contract. In brief: record ids fail closed
 * without a Tooling-API index; a `Flow:`-prefixed id resolves exactly; a bare
 * name resolves exactly then falls back to a Flow-scoped fuzzy search, whose
 * >1-candidate result is returned as an `ambiguous` success (never auto-picked).
 *
 * @example
 *   const r = await resolveFlowRef(ctx, 'My_Flow');
 *   if (r.ok && r.value.outcome === 'resolved') use(r.value.node);
 */
export const resolveFlowRef = async (
  ctx: Context,
  flowRef: string,
): Promise<Result<FlowRefResolution, McpError>> => {
  // 1. Record id (`300…` / `301…`) — index-only, fail-closed without one.
  if (RECORD_ID_PATTERN.test(flowRef)) {
    return resolveRecordId(ctx, flowRef);
  }

  // 2. Prefix coercion — a bare name becomes `Flow:{name}`; a wrong `Type:`
  //    prefix passes through unchanged so the gate below rejects it precisely.
  const coerced = coercePrefix(flowRef, [FLOW_PREFIX]);
  if (!coerced.startsWith(FLOW_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `flowRef must be a Flow id (e.g. '${FLOW_PREFIX}My_Flow'), a bare flow name (e.g. 'My_Flow'), or a Flow record id; got '${flowRef}'`,
      path: 'flowRef',
    });
  }
  const flowId = coerced as ComponentId;
  const bareName = flowId.slice(FLOW_PREFIX.length);
  // Whether the caller typed the canonical id or a bare name — the two paths
  // differ only in `resolvedForm` and in whether a miss falls back to fuzzy.
  const wasPrefixed = flowRef.startsWith(FLOW_PREFIX);
  const resolvedForm: ResolvedFlowRef['resolvedForm'] = wasPrefixed
    ? 'canonical-id'
    : 'api-name';

  // 3. Exact lookup on the canonical id.
  const exact = await fetchFlowNode(ctx, flowId);
  if (!exact.ok) return err(exact.error);
  if (exact.value !== null) {
    return ok(resolvedEnvelope(flowRef, resolvedForm, 'exact', exact.value));
  }

  // 4a. A canonical id that misses is a definitive not-found (no fuzzy guessing
  //     on an exact id the caller pinned).
  if (wasPrefixed) {
    return err(await notFoundError(ctx, flowId, bareName));
  }

  // 4b. Bare-name miss → typo-tolerant fuzzy fallback, scoped to Flows. Mirror
  //     resolve.ts's disposition: 'exact' → one confident winner (return it),
  //     'ambiguous' → surface candidates without picking, 'none' → not-found.
  const fuzzy = await resolveComponents(ctx.graph, bareName, {
    types: FLOW_TYPE_SCOPE,
  });
  if (!fuzzy.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${fuzzy.error.message}`,
    });
  }
  const candidates: readonly FlowRefCandidate[] = fuzzy.value.candidates.map(
    (c) => ({ componentId: c.id, apiName: c.apiName, score: c.score }),
  );

  // Any 'ambiguous' disposition with at least one candidate is surfaced for
  // confirmation — never auto-picked, but never silently dropped either (a lone
  // low-coverage fuzzy hit is still a real Flow the caller may have meant).
  if (fuzzy.value.disposition === 'ambiguous' && candidates.length >= 1) {
    return ok({ outcome: 'ambiguous', requested: flowRef, candidates });
  }

  const top = fuzzy.value.candidates[0];
  if (fuzzy.value.disposition === 'exact' && top !== undefined) {
    const node = await fetchFlowNode(ctx, top.id);
    if (!node.ok) return err(node.error);
    if (node.value !== null) {
      return ok(
        resolvedEnvelope(flowRef, 'api-name', 'fuzzy', node.value, [
          { componentId: top.id, apiName: top.apiName, score: top.score },
        ]),
      );
    }
  }

  // disposition 'none' (nothing matched confidently), or a stale top whose node
  // vanished — an honest not-found, with the same-named-non-Flow hint.
  return err(await notFoundError(ctx, flowId, bareName));
};
