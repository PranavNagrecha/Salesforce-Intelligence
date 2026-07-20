/**
 * Handler for the `sfi.flow_graph` MCP tool (spec §4).
 *
 * `sfi.explain_flow` returns a LOSSY narrative (decisions renamed to
 * `condition-N`, conditions collapsed to the literal word `"and"`, ZERO
 * connectors, no assignments/formulas). `flow_graph` fixes *comprehension*:
 * it returns a FAITHFUL, LOSSLESS structural projection of a Flow's declared
 * metadata — every canvas element with its REAL `<name>`, the full
 * element-to-element connector graph (`from → to → kind`), decision rules,
 * assignment items, record-op filters, loops, formulas, variables, subflows,
 * actions, and the `<start>` element including entry filters + scheduled paths.
 *
 * The heavy lifting lives in the extractors package
 * ({@link parseFlowGraphSource}); this tool is the thin MCP wrapper that:
 *   1. resolves ANY `flowRef` (canonical id / bare name / record id) to one
 *      Flow node via the shared {@link resolveFlowRef} — surfacing an AMBIGUOUS
 *      bare-name match as a SUCCESS envelope (candidates, never a silent pick),
 *   2. reads the Flow's source `.flow-meta.xml` ON DEMAND from the vault (the
 *      `flow-field-writers-scan` pattern — nothing is persisted),
 *   3. projects it with `parseFlowGraphSource`,
 *   4. composes the {@link FlowGraph} — the projection plus the `meta` block
 *      read from the graph node and the `flowRef` resolution echo,
 *   5. overlays vault resolution onto each subflow's `resolved` flag (the pure
 *      parser can only ever report `false`; the tool layer knows the vault),
 *   6. applies the §4.4 narrowing knobs (`include` / `element`) and DISCLOSES
 *      any narrowing — sections are never silently dropped.
 *
 * Honesty spine (spec §4.3): real names always, lossless, NO inference
 * (reachability / dead-branch / ordering are the host LLM's or `flow_trace`'s
 * job), and honest gaps land in `unmodeled[]`. The verbatim {@link DISCLOSURE}
 * makes NO completeness claim.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import type {
  ActionCall,
  Assignment,
  Connector,
  Decision,
  FlowElement,
  FlowGraphProjection,
  FlowStart,
  Formula,
  Loop,
  RecordOp,
  Subflow,
  Variable,
} from '@sf-intelligence/extractors';
import { parseFlowGraphSource } from '@sf-intelligence/extractors';
import { listNodesByIds } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  resolveFlowRef,
  type FlowRefCandidate,
  type ResolvedFlowRef,
} from './flow-ref.js';

/**
 * The body sections the `include` knob can select (spec §4.4). `meta`, `start`,
 * `flowRef`, and `unmodeled` are ALWAYS kept; `elements` and `subflows` are not
 * selectable and are dropped (and disclosed) under `include`-narrowing.
 */
const INCLUDE_SECTIONS = [
  'connectors',
  'decisions',
  'assignments',
  'recordOps',
  'formulas',
  'variables',
  'loops',
  'actions',
] as const;

type IncludeSection = (typeof INCLUDE_SECTIONS)[number];

/**
 * The verbatim honesty disclosure surfaced on every response. Frozen here so
 * the test suite can assert the exact string and a caller-side rephrasing is a
 * code-review concern, not a silent drift. It makes NO completeness / false-
 * complete claim — the honest gap list is `unmodeled[]`.
 */
const DISCLOSURE =
  "Faithful lossless structural projection of the Flow's declared metadata (element graph, decisions, assignments, record ops, filters, loops, formulas, variables). No runtime inference — element types not modeled are listed in unmodeled[]. Claude composes the answer.";

/** The disclosure carried on an ambiguous-flowRef success envelope. */
const AMBIGUOUS_DISCLOSURE =
  'flowRef matched more than one Flow. No graph was projected — pick one candidate and call again with its canonical id. Disclosure over guessing.';

/**
 * Zod schema for `sfi.flow_graph`.
 *   - `flowRef`: required, non-empty. A canonical `Flow:{ApiName}` id, a bare
 *     Flow API name, or a Flow record id (see {@link resolveFlowRef}).
 *   - `include`: optional narrowing — return only these body sections (plus the
 *     always-kept meta/start/flowRef/unmodeled). Omit for the full graph.
 *   - `element`: optional narrowing — return the subgraph for ONE element (the
 *     element + its immediate incoming/outgoing connectors + neighbors).
 */
export const flowGraphInputSchema = z.object({
  flowRef: z.string().min(1),
  include: z.array(z.enum(INCLUDE_SECTIONS)).optional(),
  element: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from {@link flowGraphInputSchema}. */
export type FlowGraphInput = z.infer<typeof flowGraphInputSchema>;

/** Identity + status facts read from the graph node (spec §4.1 `meta`). */
export interface FlowGraphMeta {
  readonly apiName: string;
  readonly label: string | null;
  readonly processType: string;
  readonly status: string;
  readonly apiVersion: number | null;
  readonly runInMode: string | null;
}

/**
 * What narrowing (§4.4) was applied, so a caller never mistakes a narrowed
 * response for the whole graph. Present ONLY when `include` or `element` was
 * supplied. `omittedSections` names every body section emptied by the narrowing
 * — the "never silently drop" contract.
 */
export interface FlowGraphNarrowing {
  readonly applied: 'include' | 'element';
  readonly include?: readonly IncludeSection[];
  readonly element?: string;
  readonly omittedSections?: readonly string[];
  /** Always `true` — a narrowed response is a partial view of the full graph. */
  readonly truncated: boolean;
}

/**
 * The faithful structural projection (spec §4.1): the extractor's
 * {@link FlowGraphProjection} plus the `flowRef` resolution echo and the `meta`
 * block the MCP layer composes from the graph node. `connectors[]` is the
 * authoritative element graph; the per-element `connectsTo` fields are
 * conveniences. `narrowing` is present only when a knob narrowed the response.
 */
export interface FlowGraph {
  readonly flowRef: ResolvedFlowRef;
  readonly meta: FlowGraphMeta;
  readonly start: FlowStart;
  readonly elements: readonly FlowElement[];
  readonly connectors: readonly Connector[];
  readonly decisions: readonly Decision[];
  readonly assignments: readonly Assignment[];
  readonly recordOps: readonly RecordOp[];
  readonly loops: readonly Loop[];
  readonly formulas: readonly Formula[];
  readonly variables: readonly Variable[];
  readonly subflows: readonly Subflow[];
  readonly actions: readonly ActionCall[];
  readonly unmodeled: readonly string[];
  readonly disclosure: string;
  readonly narrowing?: FlowGraphNarrowing;
}

/**
 * A bare name that fuzzily matched MORE than one Flow. Surfaced as a SUCCESS
 * envelope carrying the ranked candidates so the host LLM (or user)
 * disambiguates — mirrors `sfi.resolve`'s `ambiguous` disposition. The tool
 * does NOT pick one and projects NO graph.
 */
export interface FlowGraphAmbiguous {
  readonly flowRef: {
    readonly requested: string;
    readonly resolvedForm: 'api-name';
  };
  readonly ambiguous: true;
  readonly candidates: readonly FlowRefCandidate[];
  readonly disclosure: string;
}

/** The success payload: a projected graph OR an ambiguity to surface. */
export type FlowGraphOutput = FlowGraph | FlowGraphAmbiguous;

/** Read the Flow's display label — `properties.label`, then node label, else null. */
const readLabel = (node: Node): string | null => {
  const raw = node.properties['label'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return node.label;
};

/** Read a string property, defaulting to the empty string for malformed inputs. */
const readStringProp = (node: Node, key: string): string => {
  const raw = node.properties[key];
  return typeof raw === 'string' ? raw : '';
};

/** Read the Flow's declared `runInMode` (null when the metadata omits it). */
const readRunInMode = (node: Node): string | null => {
  const raw = node.properties['runInMode'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/** Compose the §4.1 `meta` block from the resolved graph node. */
const buildMeta = (node: Node): FlowGraphMeta => ({
  apiName: node.apiName,
  label: readLabel(node),
  processType: readStringProp(node, 'processType'),
  status: readStringProp(node, 'status'),
  apiVersion: node.apiVersion,
  runInMode: readRunInMode(node),
});

/**
 * Overlay vault resolution onto each subflow's `resolved` flag. The pure parser
 * always reports `resolved: false` (it has no graph to check the target
 * against); the tool layer knows the vault, so a subflow whose `Flow:{name}`
 * target node exists is honestly marked `resolved: true`. A dangling
 * (managed / uncaptured) subflow stays `resolved: false` — surfaced, never
 * fabricated. Batched with ONE `listNodesByIds` so the query count does not
 * scale with the subflow fan-out.
 */
const resolveSubflows = async (
  ctx: Context,
  subflows: readonly Subflow[],
): Promise<readonly Subflow[]> => {
  if (subflows.length === 0) return subflows;
  const targetIds = subflows
    .map((s) => s.targetFlowId)
    .filter((id): id is ComponentId => id.length > 0) as ComponentId[];
  if (targetIds.length === 0) return subflows;
  const nodesResult = await listNodesByIds(ctx.graph, targetIds);
  const resolvedIds = nodesResult.ok
    ? new Set(nodesResult.value.filter((n) => n.type === 'Flow').map((n) => n.id))
    : new Set<string>();
  return subflows.map((s) => ({ ...s, resolved: resolvedIds.has(s.targetFlowId) }));
};

/**
 * Apply the `include` knob (§4.4): empty only the named-but-unselected body
 * sections; every emptied section is listed in `narrowing.omittedSections` so
 * nothing is silently dropped. `elements` and `subflows` are NOT in the `include`
 * enum — they are structural (the element index that makes connector endpoints
 * interpretable, and the small subflow-identity list), so they are ALWAYS kept.
 * Only the eight selectable body sections can be emptied.
 */
const applyIncludeNarrowing = (
  graph: FlowGraph,
  include: readonly IncludeSection[],
): FlowGraph => {
  const keep = new Set<IncludeSection>(include);
  const omitted: string[] = [];
  const sectionEmpty = <K extends IncludeSection>(
    key: K,
  ): readonly FlowGraph[K][number][] => {
    if (keep.has(key)) return graph[key] as readonly FlowGraph[K][number][];
    omitted.push(key);
    return [];
  };
  return {
    ...graph,
    // elements + subflows fall through from `...graph` — always kept.
    connectors: sectionEmpty('connectors'),
    decisions: sectionEmpty('decisions'),
    assignments: sectionEmpty('assignments'),
    recordOps: sectionEmpty('recordOps'),
    loops: sectionEmpty('loops'),
    formulas: sectionEmpty('formulas'),
    variables: sectionEmpty('variables'),
    actions: sectionEmpty('actions'),
    narrowing: {
      applied: 'include',
      include,
      omittedSections: omitted,
      truncated: omitted.length > 0,
    },
  };
};

/**
 * Apply the `element` knob (§4.4): return the subgraph for ONE canvas element —
 * the element itself, its immediate connectors (both incoming `to` and outgoing
 * `from`), and the neighbor elements those connectors touch, plus the focal
 * element's own typed detail (its decision / assignment / record-op / loop /
 * action / subflow row). Returns `null` when no element with that `name` exists
 * (the caller then surfaces `invalid-query`).
 */
const applyElementNarrowing = (
  graph: FlowGraph,
  element: string,
): FlowGraph | null => {
  const byName = new Map(graph.elements.map((e) => [e.name, e]));
  const focal = byName.get(element);
  if (focal === undefined) return null;
  const connectors = graph.connectors.filter(
    (c) => c.from === element || c.to === element,
  );
  // Focal element + every neighbor a touching connector references (dedup).
  const neighborNames = new Set<string>([element]);
  for (const c of connectors) {
    neighborNames.add(c.from);
    neighborNames.add(c.to);
  }
  const elements = [...neighborNames]
    .map((n) => byName.get(n))
    .filter((e): e is FlowElement => e !== undefined);
  const byFocal = <T extends { readonly name: string }>(
    rows: readonly T[],
  ): readonly T[] => rows.filter((r) => r.name === element);
  return {
    ...graph,
    elements,
    connectors,
    decisions: byFocal(graph.decisions),
    assignments: byFocal(graph.assignments),
    recordOps: byFocal(graph.recordOps),
    loops: byFocal(graph.loops),
    formulas: byFocal(graph.formulas),
    variables: byFocal(graph.variables),
    subflows: byFocal(graph.subflows),
    actions: byFocal(graph.actions),
    narrowing: { applied: 'element', element, truncated: true },
  };
};

/**
 * The `sfi.flow_graph` MCP tool. Resolves `flowRef`, reads + projects the Flow
 * source on demand, and returns the faithful structural graph (or an ambiguity
 * envelope). See the module JSDoc for the cascade and the honesty spine.
 *
 * @example
 *   const r = await flowGraphHandler(ctx, { flowRef: 'My_Flow' });
 *   if (r.ok && !('ambiguous' in r.value.data)) {
 *     for (const c of r.value.data.connectors) console.log(c.from, '→', c.to, c.kind);
 *   }
 */
export const flowGraphHandler = async (
  ctx: Context,
  input: FlowGraphInput,
): Promise<Result<McpResponse<FlowGraphOutput>, McpError>> => {
  const resolution = await resolveFlowRef(ctx, input.flowRef);
  if (!resolution.ok) return err(resolution.error);

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  // Ambiguity is a SUCCESS: surface the candidates, project NO graph.
  if (resolution.value.outcome === 'ambiguous') {
    return ok({
      data: {
        flowRef: {
          requested: resolution.value.requested,
          resolvedForm: 'api-name' as const,
        },
        ambiguous: true as const,
        candidates: resolution.value.candidates,
        disclosure: AMBIGUOUS_DISCLOSURE,
      },
      vaultState,
    });
  }

  const { resolved, node } = resolution.value;

  // Read the Flow source ON DEMAND (nothing persisted). A missing/unreadable
  // source is an internal error — the vault node exists but its source file
  // does not, which a re-refresh fixes.
  if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) {
    return err({
      kind: 'internal',
      message: `no source path captured for ${resolved.componentId} (re-run /sfi-refresh)`,
      path: resolved.componentId,
    });
  }
  let xml: string;
  try {
    xml = await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
  } catch {
    return err({
      kind: 'internal',
      message: `could not read Flow source for ${resolved.componentId} (source file missing or unreadable — re-run /sfi-refresh)`,
      path: resolved.componentId,
    });
  }

  const projectionResult = parseFlowGraphSource(xml);
  if (!projectionResult.ok) {
    return err({
      kind: 'internal',
      message: `failed to parse Flow source for ${resolved.componentId}: ${projectionResult.error.message}`,
      path: resolved.componentId,
    });
  }
  const projection: FlowGraphProjection = projectionResult.value;

  const subflows = await resolveSubflows(ctx, projection.subflows);

  const full: FlowGraph = {
    flowRef: resolved,
    meta: buildMeta(node),
    start: projection.start,
    elements: projection.elements,
    connectors: projection.connectors,
    decisions: projection.decisions,
    assignments: projection.assignments,
    recordOps: projection.recordOps,
    loops: projection.loops,
    formulas: projection.formulas,
    variables: projection.variables,
    subflows,
    actions: projection.actions,
    unmodeled: projection.unmodeled,
    disclosure: DISCLOSURE,
  };

  // §4.4 narrowing. `element` (the more specific subgraph knob) takes
  // precedence over `include` when both are supplied.
  if (input.element !== undefined) {
    const narrowed = applyElementNarrowing(full, input.element);
    if (narrowed === null) {
      return err({
        kind: 'invalid-query',
        message: `no element named '${input.element}' in Flow ${resolved.apiName}; use a canvas element <name> from the full graph's elements[]`,
        path: 'element',
      });
    }
    return ok({ data: narrowed, vaultState });
  }
  if (input.include !== undefined) {
    return ok({ data: applyIncludeNarrowing(full, input.include), vaultState });
  }

  return ok({ data: full, vaultState });
};
