/**
 * Handler for the `sfi.flow_graph` MCP tool (spec §4).
 *
 * `sfi.explain_flow` returns a LOSSY narrative (decisions renamed to
 * `condition-N`, conditions collapsed to the literal word `"and"`, ZERO
 * connectors, no assignments/formulas). `flow_graph` fixes *comprehension*:
 * it returns a FAITHFUL structural projection of a Flow's declared metadata —
 * every canvas element with its REAL `<name>`, its `<label>` and the flow
 * author's own `<description>`, the full element-to-element connector graph
 * (`from → to → kind`), decision rules, assignment items, record-op filters,
 * screen fields, action input/output parameters, loops, formulas, variables,
 * subflows, and the `<start>` element including entry filters + scheduled paths.
 * With `walkthrough: true` it also returns an ORDERED element-by-element walk of
 * the declared connector graph — the "what happens when this flow runs, step by
 * step" answer — as a MODE of this tool rather than a 212th roster entry.
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
 * Honesty spine (spec §4.3): real names always, faithful but NOT lossless, and
 * no DATA inference — whether a branch executes is data-dependent and stays
 * `flow_trace`'s job. The gap is MEASURED per flow, not implied: element bodies
 * this parser does not model land in `unmodeled[]`, and every `<Flow>` container
 * carrying no datum into the payload lands in `unprojected[]` with its count.
 * The verbatim {@link DISCLOSURE} claims neither completeness nor losslessness.
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
  Screen,
  Subflow,
  UnprojectedContainer,
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
  'screens',
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
  "Faithful structural projection of the Flow's declared metadata (element graph with each element's author description, decisions, assignments, record ops, filters, screens and their fields, action parameters, loops, formulas, variables). NOT lossless, and the gap is measured for THIS flow rather than implied: element types whose body is not modeled are named in unmodeled[] (their identity and connectors ARE projected), and every TOP-LEVEL <Flow> container carrying no datum into this payload is counted in unprojected[]. unprojected[] measures top-level containers ONLY — a field dropped from INSIDE a container that IS projected (a subflow's input/output assignments, a record op's output reference) appears in neither list. No runtime inference. Claude composes the answer.";

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
 *   - `walkthrough`: optional MODE — also return `walkthrough[]`, the ordered
 *     element-by-element walk of the declared connector graph from `<start>`.
 *     Omitted/false leaves the response byte-identical to a call without it.
 */
export const flowGraphInputSchema = z.object({
  flowRef: z.string().min(1),
  include: z.array(z.enum(INCLUDE_SECTIONS)).optional(),
  element: z.string().min(1).optional(),
  walkthrough: z.boolean().optional(),
});

/** Parsed input shape, inferred from {@link flowGraphInputSchema}. */
export type FlowGraphInput = z.infer<typeof flowGraphInputSchema>;

/** Identity + status facts read from the graph node (spec §4.1 `meta`). */
export interface FlowGraphMeta {
  readonly apiName: string;
  readonly label: string | null;
  /**
   * The flow-level `<description>` from the Flow source — the author's own
   * "what is this flow for". Read from the projected XML, not the graph node,
   * so it is available even on a vault whose node properties omit it.
   */
  readonly description: string | null;
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
  readonly applied: 'include' | 'element' | 'walkthrough';
  readonly include?: readonly IncludeSection[];
  readonly element?: string;
  readonly omittedSections?: readonly string[];
  /** Always `true` — a narrowed response is a partial view of the full graph. */
  readonly truncated: boolean;
  /**
   * Present on `applied: 'walkthrough'` — how to get the shed sections back.
   * A shed section is never silently gone: it is named in `omittedSections`
   * AND this line says the exact call that returns it.
   */
  readonly recoverWith?: string;
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
  readonly screens: readonly Screen[];
  readonly formulas: readonly Formula[];
  readonly variables: readonly Variable[];
  readonly subflows: readonly Subflow[];
  readonly actions: readonly ActionCall[];
  readonly unmodeled: readonly string[];
  readonly unprojected: readonly UnprojectedContainer[];
  readonly disclosure: string;
  readonly narrowing?: FlowGraphNarrowing;
  /** Present ONLY when `walkthrough: true` was requested. */
  readonly walkthrough?: FlowWalkthrough;
}

/**
 * One visit in the ordered element-by-element walk. `detail` names the body
 * section holding this element's typed row (join by `name`), so a host reads
 * "step 4 is the decision `Is_the_decision_Denied` — its rules are in
 * `decisions[]`" without re-indexing the payload.
 */
export interface WalkthroughStep {
  readonly step: number;
  /**
   * PATH LENGTH from `<start>` — the number of edges walked to reach this step,
   * NOT the number of branch points crossed. `<start>` is 0. A real flow of 65
   * steps reaches `depth: 32` across 6 actual branch points, so indenting a
   * rendering by this value produces a staircase, not a tree.
   */
  readonly depth: number;
  readonly name: string;
  readonly type: FlowElement['type'] | 'unresolved';
  readonly label: string | null;
  /** The flow author's own `<description>` for this element, when they wrote one. */
  readonly description: string | null;
  readonly detail:
    | 'decisions'
    | 'assignments'
    | 'recordOps'
    | 'loops'
    | 'screens'
    | 'actions'
    | 'subflows'
    | null;
  /** The edge that reached this element — null for `<start>`. */
  readonly via: {
    readonly from: string;
    readonly kind: Connector['kind'];
    readonly ruleName?: string;
    readonly scheduledPathName?: string;
    readonly isGoTo?: true;
  } | null;
  /** Already walked earlier — a loop-back / reconnect. NOT expanded again. */
  readonly revisit?: true;
  /** No outgoing connector: this branch of the flow ends here. */
  readonly endsBranch?: true;
  /** A `<targetReference>` naming an element that does not exist in this Flow. */
  readonly unresolvedTarget?: true;
}

/**
 * The ordered walk plus everything the walk can honestly say about itself.
 *
 * `steps[]` is a DEPTH-FIRST traversal of the DECLARED connector graph, so a
 * decision's branches appear as nested subtrees rather than a flat list. The
 * order WITHIN an element's outgoing edges is the declared evaluation order
 * (a decision's `<rules>` before its `<defaultConnector>`; a loop's
 * `nextValue` body before `noMoreValues`; a `faultConnector` last), not a
 * prediction: only ONE branch of a decision runs per interview and WHICH one is
 * data-dependent — that is `sfi.flow_trace`'s question, with a record state.
 *
 * `unreachable[]` is every element with no path from `<start>` over the declared
 * connectors. It is a structural fact, not a "dead element" verdict: an element
 * can be reachable only through an unmodeled element's inner branching (which
 * this projection does not carry), so treat it as a lead, not a deletion notice.
 */
export interface FlowWalkthrough {
  readonly steps: readonly WalkthroughStep[];
  readonly elementCount: number;
  readonly visitedCount: number;
  readonly unreachable: readonly string[];
  /** True when the step cap stopped the walk before it finished. */
  readonly truncated: boolean;
  readonly disclosure: string;
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

/**
 * Compose the §4.1 `meta` block from the resolved graph node, plus the
 * flow-level `<description>` the projection read out of the source XML.
 */
const buildMeta = (node: Node, description: string | null): FlowGraphMeta => ({
  apiName: node.apiName,
  label: readLabel(node),
  description,
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
 * The verbatim walkthrough disclosure. Emitted ONLY on the `walkthrough: true`
 * path so every other response stays byte-identical. Frozen so the tests assert
 * the exact string and a caller-side rephrasing is a code-review concern.
 */
const WALKTHROUGH_DISCLOSURE =
  'Declaration-order traversal of the DECLARED connector graph, not an execution trace. Branches are expanded depth-first in declared evaluation order (a decision\'s rules before its default, a loop body before its exit, fault paths last); only ONE branch of a decision actually runs per interview and which one is data-dependent — call sfi.flow_trace with a record state for that. Loop-backs and reconnects are marked revisit and not re-expanded. unreachable[] means no path from <start> over the declared connectors; an element reachable only through an unmodeled element\'s inner branching would appear there too, so it is a lead, not a dead-element verdict.';

/** Hard cap on emitted walkthrough rows; a longer walk is truncated + disclosed. */
const WALKTHROUGH_MAX_STEPS = 400;

/**
 * Branch expansion order for one element's outgoing connectors. Lower sorts
 * first. This is the DECLARED evaluation order Salesforce documents (a
 * decision evaluates its `<rules>` in order and falls through to
 * `<defaultConnector>`; a loop runs its `nextValue` body before taking
 * `noMoreValues`; a `<faultConnector>` is the error path), NOT a prediction of
 * which branch a given record takes.
 */
const CONNECTOR_ORDER: Readonly<Record<Connector['kind'], number>> = {
  immediate: 0,
  rule: 1,
  nextValue: 2,
  default: 3,
  noMoreValues: 4,
  scheduled: 5,
  fault: 6,
};

/**
 * Which typed body section holds an element type's detail row (joined by
 * `name`). `null` for element types with no detail array of their own — the
 * `<start>` sentinel, `end`, and `unmodeled` bodies.
 */
const DETAIL_SECTION: Readonly<
  Record<FlowElement['type'], WalkthroughStep['detail']>
> = {
  decision: 'decisions',
  assignment: 'assignments',
  recordCreate: 'recordOps',
  recordUpdate: 'recordOps',
  recordLookup: 'recordOps',
  recordDelete: 'recordOps',
  loop: 'loops',
  screen: 'screens',
  action: 'actions',
  subflow: 'subflows',
  wait: null,
  start: null,
  end: null,
  unmodeled: null,
};

/**
 * Build the ordered element-by-element walk of the declared connector graph
 * (the `walkthrough: true` mode).
 *
 * Depth-first from `<start>` so a decision's branches read as nested subtrees
 * rather than an interleaved list; the order within one element's outgoing
 * edges is {@link CONNECTOR_ORDER}. Every element is EXPANDED at most once — a
 * second arrival emits a `revisit` row and stops, which is what makes a
 * loop-back or a `<isGoTo>` reconnect terminate instead of running forever.
 *
 * PURE over the projection: no vault reads, no data evaluation, no branch
 * prediction. What it cannot say it says — an element the walk never reaches is
 * `unreachable`, a `<targetReference>` with no element row is
 * `unresolvedTarget`, and hitting {@link WALKTHROUGH_MAX_STEPS} sets
 * `truncated`.
 */
const buildWalkthrough = (graph: FlowGraph): FlowWalkthrough => {
  const byName = new Map(graph.elements.map((e) => [e.name, e]));
  const outgoing = new Map<string, Connector[]>();
  for (const c of graph.connectors) {
    const list = outgoing.get(c.from);
    if (list === undefined) outgoing.set(c.from, [c]);
    else list.push(c);
  }
  for (const list of outgoing.values()) {
    // Stable sort: equal kinds keep metadata declaration order.
    list.sort((a, b) => CONNECTOR_ORDER[a.kind] - CONNECTOR_ORDER[b.kind]);
  }

  const steps: WalkthroughStep[] = [];
  const expanded = new Set<string>();
  let truncated = false;

  interface Frame {
    readonly name: string;
    readonly depth: number;
    readonly via: WalkthroughStep['via'];
  }
  // The <start> sentinel is the element index's own row for <start>; when a
  // malformed Flow has no start row at all the walk still runs from whatever
  // the start connector names, so a graph is never silently empty.
  const root = graph.elements.find((e) => e.type === 'start')?.name ?? null;
  const stack: Frame[] =
    root !== null
      ? [{ name: root, depth: 0, via: null }]
      : graph.start.connector === null
        ? []
        : [
            {
              name: graph.start.connector.to,
              depth: 0,
              via: { from: '$start', kind: 'immediate' },
            },
          ];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (steps.length >= WALKTHROUGH_MAX_STEPS) {
      truncated = true;
      break;
    }
    const element = byName.get(frame.name);
    const step = steps.length + 1;
    if (element === undefined) {
      steps.push({
        step,
        depth: frame.depth,
        name: frame.name,
        type: 'unresolved',
        label: null,
        description: null,
        detail: null,
        via: frame.via,
        unresolvedTarget: true,
      });
      continue;
    }
    const base: WalkthroughStep = {
      step,
      depth: frame.depth,
      name: element.name,
      type: element.type,
      label: element.label,
      description: element.description ?? null,
      detail: DETAIL_SECTION[element.type],
      via: frame.via,
    };
    if (expanded.has(element.name)) {
      steps.push({ ...base, revisit: true });
      continue;
    }
    expanded.add(element.name);
    const edges = outgoing.get(element.name) ?? [];
    steps.push(edges.length === 0 ? { ...base, endsBranch: true } : base);
    // Push in reverse so the sorted first edge pops first.
    for (let i = edges.length - 1; i >= 0; i -= 1) {
      const edge = edges[i] as Connector;
      stack.push({
        name: edge.to,
        depth: frame.depth + 1,
        via: {
          from: edge.from,
          kind: edge.kind,
          ...(edge.ruleName !== undefined ? { ruleName: edge.ruleName } : {}),
          ...(edge.scheduledPathName !== undefined
            ? { scheduledPathName: edge.scheduledPathName }
            : {}),
          ...(edge.isGoTo === true ? { isGoTo: true as const } : {}),
        },
      });
    }
  }

  const unreachable = graph.elements
    .filter((e) => !expanded.has(e.name))
    .map((e) => e.name);
  return {
    steps,
    elementCount: graph.elements.length,
    visitedCount: expanded.size,
    unreachable,
    truncated,
    disclosure: WALKTHROUGH_DISCLOSURE,
  };
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
    screens: sectionEmpty('screens'),
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
    screens: byFocal(graph.screens),
    formulas: byFocal(graph.formulas),
    variables: byFocal(graph.variables),
    subflows: byFocal(graph.subflows),
    actions: byFocal(graph.actions),
    narrowing: { applied: 'element', element, truncated: true },
  };
};

/**
 * Tool-local byte budget for a `walkthrough: true` response, held under the
 * central 40 KB response guard so the shed happens HERE — where the tool knows
 * which sections the walk supersedes — instead of at the guard, which would
 * tail-truncate `elements[]` and leave the walk pointing at rows it dropped.
 */
const WALKTHROUGH_BODY_BUDGET_BYTES = 36_000;

/**
 * The body sections a walkthrough response may shed to fit, LARGEST FIRST so
 * the loss is minimal: one big section goes rather than three small ones.
 * `connectors` is here because the walk's per-step `via` edge already carries
 * every traversed edge; `screens`, `formulas` and `variables` because they carry
 * the payload's only unbounded free text (rich-text `fieldText`, formula
 * expressions). The sections that answer "what does this element DO" —
 * `elements`, `decisions`, `assignments`, `recordOps`, `actions`, `subflows` —
 * are never shed, because the walk points into them.
 */
const WALKTHROUGH_SHEDDABLE = [
  'connectors',
  'screens',
  'formulas',
  'variables',
] as const;

type SheddableSection = (typeof WALKTHROUGH_SHEDDABLE)[number];

/**
 * Fit a walkthrough response inside the tool-local budget by shedding whole
 * body sections, largest first, and DISCLOSE every shed section plus the exact
 * call that returns it. A response that already fits is returned untouched with
 * no `narrowing` block at all — the common case for the many small flows in a
 * real org, so most walkthroughs are complete.
 *
 * When even the full shed list is not enough (a very large flow), the response
 * is returned as-is with the shed disclosed; the central guard is the backstop
 * and it also discloses. Silence is never an option on either path.
 */
const fitWalkthrough = (graph: FlowGraph): FlowGraph => {
  const bytes = (g: FlowGraph): number =>
    Buffer.byteLength(JSON.stringify(g), 'utf8');
  if (bytes(graph) <= WALKTHROUGH_BODY_BUDGET_BYTES) return graph;
  let current = graph;
  const omitted: SheddableSection[] = [];
  while (bytes(current) > WALKTHROUGH_BODY_BUDGET_BYTES) {
    let biggest: SheddableSection | null = null;
    let biggestBytes = 0;
    for (const section of WALKTHROUGH_SHEDDABLE) {
      if (current[section].length === 0) continue;
      const size = Buffer.byteLength(JSON.stringify(current[section]), 'utf8');
      if (size > biggestBytes) {
        biggest = section;
        biggestBytes = size;
      }
    }
    if (biggest === null) break;
    current = { ...current, [biggest]: [] };
    omitted.push(biggest);
  }
  const prior = graph.narrowing;
  if (omitted.length === 0) {
    // Nothing was sheddable and the payload is still over budget. Saying
    // nothing here hands the caller an oversize response whose only signal is
    // the CENTRAL guard's tail-truncation — the outcome this budget exists to
    // prevent. Disclose it as its own outcome.
    return {
      ...current,
      narrowing: {
        ...(prior ?? {}),
        applied: prior?.applied ?? 'walkthrough',
        truncated: true,
        recoverWith: `this flow does not fit alongside the ordered walk even with every optional section dropped; call sfi.flow_graph with element: '<name>' for one element's subgraph, or without walkthrough for the body alone`,
      },
    };
  }
  // Report the shed in the tool's own section order, not the order they
  // happened to be dropped in, so the disclosure reads the same for a given
  // outcome regardless of which section was biggest.
  const ordered = WALKTHROUGH_SHEDDABLE.filter((sec) => omitted.includes(sec));
  // MERGE, never replace (W2B-REVIEW F3). When `include` or `element` already
  // wrote a narrowing block, overwriting it erased BOTH that block's own
  // omissions and its `recoverWith` — and, worse, a section the caller
  // explicitly asked for could come back `[]` while `omittedSections` said
  // nothing was omitted, which reads as "this flow has none".
  const priorOmitted = prior?.omittedSections ?? [];
  const mergedOmitted = [
    ...priorOmitted,
    ...ordered.filter((sec) => !priorOmitted.includes(sec)),
  ];
  return {
    ...current,
    narrowing: {
      ...(prior ?? {}),
      applied: prior?.applied ?? 'walkthrough',
      omittedSections: mergedOmitted,
      truncated: true,
      recoverWith: `this flow's body did not fit alongside the ordered walk; call sfi.flow_graph again with include: [${ordered
        .map((o) => `'${o}'`)
        .join(', ')}] (and no walkthrough) for the omitted section(s) in full`,
    },
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

  const base: FlowGraph = {
    flowRef: resolved,
    meta: buildMeta(node, projection.description),
    start: projection.start,
    elements: projection.elements,
    connectors: projection.connectors,
    decisions: projection.decisions,
    assignments: projection.assignments,
    recordOps: projection.recordOps,
    loops: projection.loops,
    screens: projection.screens,
    formulas: projection.formulas,
    variables: projection.variables,
    subflows,
    actions: projection.actions,
    unmodeled: projection.unmodeled,
    unprojected: projection.unprojected,
    disclosure: DISCLOSURE,
  };

  // The walkthrough is computed on the FULL graph (an ordered walk of half a
  // graph would be a lie), and attached only when asked for — so a call without
  // `walkthrough` is byte-identical to one made before this mode existed.
  //
  // The BUDGET is applied LAST, after §4.4 narrowing (W2B-REVIEW F3): fitting
  // first shed sections that the narrowing step then re-reported as present but
  // empty. Fitting last also means a narrowed call usually has nothing to shed,
  // because narrowing already removed the bulk.
  const full: FlowGraph =
    input.walkthrough === true
      ? { ...base, walkthrough: buildWalkthrough(base) }
      : base;
  const fit = (g: FlowGraph): FlowGraph =>
    input.walkthrough === true ? fitWalkthrough(g) : g;

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
    return ok({ data: fit(narrowed), vaultState });
  }
  if (input.include !== undefined) {
    return ok({ data: fit(applyIncludeNarrowing(full, input.include)), vaultState });
  }

  return ok({ data: fit(full), vaultState });
};
