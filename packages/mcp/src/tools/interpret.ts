/**
 * Handler for the `sfi.interpret` MCP tool (RM-wire).
 *
 * Surfaces the deterministic reasoning engine ({@link interpret}) as a visible,
 * cited tool. Given ONE component id it:
 *
 *   1. resolves the root `Node` (phantom-aware not-found);
 *   2. assembles a minimal {@link GroundedSlice} — the root node plus every
 *      edge of the types the selected rules bind on (`triggersOn` / `lookupTo` /
 *      `firesWhen`, DERIVED from `CONCEPT_RULES`, not hardcoded) and every one of
 *      those edges' endpoint nodes (REQUIRED — the engine drops an edge endpoint
 *      whose node is absent from the slice). An `edgeSource: 'root-incident'`
 *      AGGREGATE rule (RM-loop, the stacked-flows count) needs no extra hop: it
 *      binds `triggersOn`, so this 1-hop slice already carries the root object,
 *      its incoming `triggersOn` edges, and the firer (`Flow`) endpoint NODES —
 *      whose `status` property is the active filter the engine counts on, and
 *      whose ids are the citation. An `edgeSource: 'root-children-outgoing'`
 *      AGGREGATE rule (the junction-object count) DOES add a second hop: a
 *      master-detail `lookupTo` edge hangs off the object's CHILD FIELD, so the
 *      object node has zero incident ones — it pulls the root's child fields
 *      (via `parentOf`), their outgoing counted edges, and the parent nodes those
 *      edges cite (batched, only when such a rule is selected). For a JOIN rule (RM-loop) it adds a
 *      SECOND hop: the intermediary (`ConditionalContext`) nodes' shared-key
 *      (`fieldRefs`) fields, the second-ground (`writesTo`) edges into those
 *      fields, and the writer nodes — plus the firer's own `triggersOn` edge and
 *      target object node, so a record-triggered Flow firer (whose id has no
 *      object segment) can be same-object scoped, AND each writer's own
 *      `triggersOn` edge (RM-loop PASS 2), so a record-triggered Flow writer can
 *      be PLACED in the save order for the cross-phase upgrade — batched, no N+1,
 *      and only when a join rule is selected;
 *   3. runs each applicable {@link ConceptRule} through the pure engine under a
 *      per-rule coverage adapted from {@link summarizeCoverage};
 *   3b. EPIC-1 — second-pass {@link chainInterpret} over emitted interpretations
 *      (concept-output → concept-input), appending any chained claims; and
 *   4. returns the interpretations VERBATIM alongside an honest `trust` block,
 *      a disclosure, and a rendered Markdown answer.
 *
 * Honesty is load-bearing:
 *   - `provenance` is hardwired `offline_snapshot`; the `disclosure` states this
 *     is DETERMINISTIC reasoning over the offline vault snapshot — no LLM, not a
 *     live read.
 *   - an EMPTY interpretation list renders/discloses "no concept rule fired for
 *     this component (this is NOT a claim that nothing depends on it)" rather
 *     than any absence conclusion.
 *   - a TRUNCATED slice (a hub whose edge count exceeds the cap) forces coverage
 *     to at most `partial`, so an absence rule can never read `complete` over a
 *     clipped slice.
 *
 * This tool is offline and read-only — it never touches the org.
 */

import type {
  ComponentId,
  ConceptRule,
  ConceptSeverity,
  ConfidenceLevel,
  Edge,
  EdgeType,
  Interpretation,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdgesForNodes, listNodesByIds } from '@sf-intelligence/graph';
import { type CoverageSummary, summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import { renderInterpretationsMarkdown } from '../answer-render.js';
import {
  aggregateHasUnresolvedCountedEndpoint,
  CHAINED_RULES,
  chainInterpret,
  COMPOUND_RULES,
  compoundInterpret,
  CONCEPTS,
  CONCEPT_RULES,
  type Coverage,
  type GroundedSlice,
  interpret,
  reconcile,
  SUPERSEDES_RULES,
  weakest,
} from '../knowledge/index.js';
import type { Context } from '../server.js';

import { phantomAwareNotFoundMessage } from './phantom-node.js';

/**
 * Cap on the number of bound-type edges pulled into a single slice. A hub
 * (a heavily-referenced object) can carry thousands of `triggersOn` /
 * `lookupTo` edges; beyond this we mark the slice truncated and hold coverage
 * to `partial` so an absence-based rule can never claim `complete` over a
 * clipped slice. The current five rules are all presence-shaped, so this is a
 * forward-safety guard, not a correctness fix for any shipped rule.
 */
const SLICE_EDGE_CAP = 1_000;

/**
 * Zod schema for the `sfi.interpret` tool input.
 *   - `componentId`: required, non-empty canonical id (e.g.
 *     `CustomField:Account.Amount__c`, `CustomObject:Order__c`).
 *   - `concepts`: optional additive filter — keep only rules whose `concept`
 *     is in this list. An EMPTY array matches NO rule.
 *   - `ruleIds`: optional additive filter — keep only rules whose `id` is in
 *     this list. An EMPTY array matches NO rule.
 */
export const interpretInputSchema = z.object({
  componentId: z.string().min(1),
  concepts: z.array(z.string()).optional(),
  ruleIds: z.array(z.string()).optional(),
});

/** Parsed input shape. */
export type InterpretInput = z.infer<typeof interpretInputSchema>;

/** EPIC-5: one ranked proactive-risk row derived from an interpretation. */
export interface ProactiveRiskRow {
  readonly ruleId: string;
  readonly concept: string;
  readonly severity: ConceptSeverity;
  readonly confidence: ConfidenceLevel;
  readonly riskScore: number;
  readonly claimPreview: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface InterpretOutput {
  readonly componentId: ComponentId;
  readonly componentType: string;
  /** The engine's interpretations, VERBATIM — claims are never reshaped here. */
  readonly interpretations: readonly Interpretation[];
  /** EPIC-5: top proactive risks ranked by severity × confidence (max 5). */
  readonly proactiveRisks?: readonly ProactiveRiskRow[];
  readonly rulesConsidered: number;
  readonly rulesFired: number;
  readonly sliceTruncated: boolean;
  readonly trust: TrustSummary;
  /** Present only when the aggregate coverage is not `complete`. */
  readonly coverageCaveat?: string;
  readonly disclosure: string;
  readonly rendered: string;
}

/** Base disclosure — always present. */
const BASE_DISCLOSURE =
  'Deterministic concept-rule reasoning over the offline vault snapshot — NOT a live org read and NOT an LLM inference. ' +
  'Each interpretation is a curated structural rule fired against the graph slice assembled for this component; it cites ' +
  'the exact component ids it is grounded in, and its confidence is the weakest of the rule ceiling and its matched edges — ' +
  'never asserted above its ground. An absence-based conclusion is only as strong as the coverage of the families it depends on.';

/** Appended when NO rule fired — the honest non-absence framing. */
const EMPTY_DISCLOSURE_NOTE =
  ' No concept rule fired for this component: this is NOT a claim that nothing depends on it — only that no curated reasoning ' +
  'rule matched the graph slice assembled for it.';

/**
 * Cap on the second-hop join expansion: the number of shared keys X pulled from
 * the intermediary nodes, and the number of second-ground (`writesTo`) edges
 * fetched into them. A firer normally gates on a handful of fields, so this is a
 * forward-safety net; exceeding it marks the slice truncated (holding coverage
 * to at most `partial`) and under-reports couplings rather than scanning
 * unboundedly — presence-shaped, so a missed coupling is disclosed, never a
 * false absence.
 */
const JOIN_FANOUT_CAP = 1_000;

/** EPIC-5 severity × confidence ranking for proactive risk surfacing. */
const SEVERITY_RANK: Readonly<Record<ConceptSeverity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const CONFIDENCE_SCORE: Readonly<Record<ConfidenceLevel, number>> = {
  declared: 3,
  parsed: 2,
  heuristic: 1,
};

const rankProactiveRisks = (
  interpretations: readonly Interpretation[],
  topN = 5,
): readonly ProactiveRiskRow[] =>
  interpretations
    .filter(
      (i): i is Interpretation & { confidence: ConfidenceLevel } =>
        i.confidence !== 'unknown' && i.supersededBy === undefined,
    )
    .map((i) => {
      const severity: ConceptSeverity = CONCEPTS[i.concept]?.severity ?? 'medium';
      const riskScore = SEVERITY_RANK[severity] * CONFIDENCE_SCORE[i.confidence];
      return {
        ruleId: i.ruleId,
        concept: i.concept,
        severity,
        confidence: i.confidence,
        riskScore,
        claimPreview: i.claim.length > 160 ? `${i.claim.slice(0, 157)}…` : i.claim,
      };
    })
    .sort(
      (a, b) =>
        b.riskScore - a.riskScore ||
        a.concept.localeCompare(b.concept) ||
        a.ruleId.localeCompare(b.ruleId),
    )
    .slice(0, topN);

/** Distinct edge types the given rules BIND on (derived, not hardcoded). */
const boundEdgeTypes = (rules: readonly ConceptRule[]): EdgeType[] => {
  const set = new Set<EdgeType>();
  for (const rule of rules) {
    if (rule.bind.edgeType !== undefined) set.add(rule.bind.edgeType);
    if (rule.bind.dualEdge !== undefined) {
      set.add(rule.bind.dualEdge.edgeTypeA);
      set.add(rule.bind.dualEdge.edgeTypeB);
    }
    // EC-8 — node-shaped anti-joins (C17) bind no present edgeType; the absent
    // side (e.g. writesTo) must still be fetched into the 1-hop slice.
    if (rule.bind.antiJoin !== undefined) {
      set.add(rule.bind.antiJoin.absentEdgeType);
      if (rule.bind.edgeType !== undefined) set.add(rule.bind.edgeType);
    }
    // EC-9 — set-difference JOIN: both include and subtract edge types.
    if (rule.bind.setDifference !== undefined) {
      set.add(rule.bind.setDifference.includeEdgeType);
      set.add(rule.bind.setDifference.subtractEdgeType);
    }
    if (rule.bind.crossObjectCascade !== undefined) {
      set.add(rule.bind.crossObjectCascade.writerTriggerEdge);
      set.add(rule.bind.crossObjectCascade.writeEdge);
    }
  }
  return [...set];
};

/** Distinct second-ground edge types the given rules' JOIN sub-predicates bind on. */
const joinWriteEdgeTypes = (rules: readonly ConceptRule[]): EdgeType[] => {
  const set = new Set<EdgeType>();
  for (const rule of rules) {
    if (rule.bind.join !== undefined) set.add(rule.bind.join.writeEdgeType);
  }
  return [...set];
};

/**
 * Map the vault {@link CoverageSummary} onto the engine's {@link Coverage}.
 * `caveat` is null exactly when the (post-truncation) status is `complete`,
 * else a string naming the missing families and any truncation. When the slice
 * was truncated a `complete` status is forced down to `partial` so an
 * absence-shaped rule can never conclude "none/safe" over a clipped slice.
 */
export const adaptCoverage = (summary: CoverageSummary, truncated: boolean): Coverage => {
  const status: Coverage['status'] =
    truncated && summary.status === 'complete' ? 'partial' : summary.status;
  if (status === 'complete') return { status, caveat: null };
  const missing =
    summary.missingCoverage.length > 0
      ? `not fully modeled: ${summary.missingCoverage.join(', ')}`
      : '';
  const clip = truncated ? 'graph slice truncated at the hub cap' : '';
  const detail = [missing, clip].filter((s) => s.length > 0).join('; ');
  return {
    status,
    caveat: `coverage is ${status}${detail.length > 0 ? ` — ${detail}` : ''}.`,
  };
};

/**
 * The `sfi.interpret` MCP tool. Assembles a grounded slice for one component
 * and surfaces the reasoning engine's cited interpretations, coverage-honest.
 *
 * @example
 *   const r = await interpretHandler(ctx, {
 *     componentId: 'CustomField:Account.Amount__c',
 *   });
 *   if (r.ok) console.log(r.value.data.interpretations);
 */
export const interpretHandler = async (
  ctx: Context,
  input: InterpretInput,
): Promise<Result<McpResponse<InterpretOutput>, McpError>> => {
  const componentId = input.componentId as ComponentId;

  // (a) resolve the root node — phantom-aware not-found.
  const rootRes = await getNodeById(ctx.graph, componentId);
  if (!rootRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${rootRes.error.message}`,
    });
  }
  if (rootRes.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, componentId, 'component'),
      path: componentId,
    });
  }
  const rootNode = rootRes.value;

  // (c) select applicable rules (all, narrowed by the additive filters). An
  // empty filter ARRAY matches none; an omitted filter is unconstrained.
  const conceptFilter = input.concepts;
  const ruleIdFilter = input.ruleIds;
  const selectedRules = CONCEPT_RULES.filter(
    (rule) =>
      (conceptFilter === undefined || conceptFilter.includes(rule.concept)) &&
      (ruleIdFilter === undefined || ruleIdFilter.includes(rule.id)),
  );

  // (b) assemble the slice — targeted + batched, no N+1. Fetch only the edge
  // types the selected rules bind on, then every endpoint node those edges
  // touch (endpoint nodes are REQUIRED: the engine drops an edge endpoint whose
  // node is absent from `slice.nodes`).
  const edgeTypes = boundEdgeTypes(selectedRules);
  let edges: readonly Edge[] = [];
  let sliceTruncated = false;
  if (edgeTypes.length > 0) {
    const edgeRes = await listEdgesForNodes(ctx.graph, [componentId], {
      direction: 'both',
      edgeTypes,
    });
    if (!edgeRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${edgeRes.error.message}`,
      });
    }
    const incident = edgeRes.value.get(componentId) ?? [];
    if (incident.length > SLICE_EDGE_CAP) {
      sliceTruncated = true;
      edges = incident.slice(0, SLICE_EDGE_CAP);
    } else {
      edges = incident;
    }
  }

  const endpointIds = new Set<ComponentId>();
  for (const edge of edges) {
    if (edge.fromId !== componentId) endpointIds.add(edge.fromId);
    if (edge.toId !== componentId) endpointIds.add(edge.toId);
  }
  const endpointRes = await listNodesByIds(ctx.graph, [...endpointIds]);
  if (!endpointRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${endpointRes.error.message}`,
    });
  }

  // Base (1-hop) slice: the root + its bound-type edges + those edges' endpoint
  // nodes. Non-join rules reason over exactly this, unchanged.
  const sliceNodes: Node[] = [rootNode, ...endpointRes.value];
  const sliceEdges: Edge[] = [...edges];

  // (b2) Second hop — ONLY for JOIN rules. The 1-hop slice already contains the
  // firer's via-edges (`firesWhen`, pulled by `boundEdgeTypes`) and their
  // intermediary (`ConditionalContext`) endpoint nodes, but NOT the writers of
  // the fields those intermediaries gate on. Expand: read each intermediary's
  // shared-key array (`fieldRefs`) → fetch the second-ground (`writesTo`) edges
  // INTO those keys → pull the writer + key nodes. Batched (one edge query, one
  // node query); no N+1. This runs only when a join rule is selected, so
  // non-join queries keep the exact 1-hop behavior above.
  const joinRules = selectedRules.filter((rule) => rule.bind.join !== undefined);
  if (joinRules.length > 0) {
    const nodeById = new Map<ComponentId, Node>(sliceNodes.map((n) => [n.id, n]));
    const throughTypes = new Set(joinRules.map((r) => r.bind.join!.throughType));
    const viaEdgeTypes = new Set(
      joinRules.flatMap((r) => (r.bind.edgeType !== undefined ? [r.bind.edgeType] : [])),
    );
    const keyArrayProps = [...new Set(joinRules.map((r) => r.bind.join!.throughKeyArray))];

    // FIX 2 — a record-triggered Flow firer's id carries no object segment; the
    // engine derives its same-object scope from the firer's `triggersOn` edge
    // (`Flow --triggersOn--> CustomObject`). When the status-code rule is also
    // selected, `triggersOn` is already a bound edge type and the 1-hop pulled
    // that edge + its object node; fetch them here only when it is NOT (a
    // join-only `ruleIds`/`concepts` selection) so the join is self-sufficient.
    if (!edgeTypes.includes('triggersOn' as EdgeType)) {
      const trigRes = await listEdgesForNodes(ctx.graph, [componentId], {
        direction: 'out',
        edgeTypes: ['triggersOn' as EdgeType],
      });
      if (!trigRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${trigRes.error.message}`,
        });
      }
      const objIds = new Set<ComponentId>();
      for (const trigEdge of trigRes.value.get(componentId) ?? []) {
        sliceEdges.push(trigEdge);
        if (!nodeById.has(trigEdge.toId)) objIds.add(trigEdge.toId);
      }
      if (objIds.size > 0) {
        const objRes = await listNodesByIds(ctx.graph, [...objIds]);
        if (!objRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${objRes.error.message}`,
          });
        }
        for (const objNode of objRes.value) {
          sliceNodes.push(objNode);
          nodeById.set(objNode.id, objNode);
        }
      }
    }

    // Shared keys X reached from F through its intermediary nodes.
    const keyIds = new Set<ComponentId>();
    for (const edge of sliceEdges) {
      if (edge.fromId !== componentId) continue;
      if (!viaEdgeTypes.has(edge.edgeType)) continue;
      const through = nodeById.get(edge.toId);
      if (through === undefined || !throughTypes.has(through.type)) continue;
      for (const prop of keyArrayProps) {
        const arr = through.properties[prop];
        if (!Array.isArray(arr)) continue;
        for (const raw of arr) {
          if (typeof raw === 'string' && keyIds.size < JOIN_FANOUT_CAP) {
            keyIds.add(raw as ComponentId);
          } else if (typeof raw === 'string') {
            sliceTruncated = true; // key fan-out capped
          }
        }
      }
    }

    const writeEdgeTypes = joinWriteEdgeTypes(joinRules);
    if (keyIds.size > 0 && writeEdgeTypes.length > 0) {
      const writeRes = await listEdgesForNodes(ctx.graph, [...keyIds], {
        direction: 'in',
        edgeTypes: writeEdgeTypes,
      });
      if (!writeRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${writeRes.error.message}`,
        });
      }
      const writerIds = new Set<ComponentId>();
      for (const keyId of keyIds) {
        for (const writeEdge of writeRes.value.get(keyId) ?? []) {
          if (sliceEdges.length >= edges.length + JOIN_FANOUT_CAP) {
            sliceTruncated = true; // second-ground edge fan-out capped
            break;
          }
          sliceEdges.push(writeEdge);
          writerIds.add(writeEdge.fromId);
        }
      }
      // Pull the key (X) + writer (W) nodes not already resolved in the slice —
      // the engine drops any endpoint whose node is absent, so both are REQUIRED
      // for a coupling to be cited.
      const needNodeIds = [...new Set<ComponentId>([...keyIds, ...writerIds])].filter(
        (id) => !nodeById.has(id),
      );
      if (needNodeIds.length > 0) {
        const joinNodesRes = await listNodesByIds(ctx.graph, needNodeIds);
        if (!joinNodesRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${joinNodesRes.error.message}`,
          });
        }
        sliceNodes.push(...joinNodesRes.value);
      }

      // RM-loop PASS 2 — pull each writer W's OUTGOING `triggersOn` edge so the
      // engine can PLACE a record-triggered Flow writer in the save order
      // (its before/after-save timing lives on that edge's `triggerType`, and a
      // Flow id carries no timing). The firer F's own `triggersOn` edge is
      // already in the slice (via the 1-hop status-code binding or the join-only
      // block above), so only the writers need it here. ONE batched query (no
      // N+1); the CustomObject targets are NOT pulled as nodes — the engine reads
      // only the edge's `triggerType`, never the target node. ApexTrigger / rule
      // / approval writers place from their own node, so a Flow-less writer just
      // has no `triggersOn` edge and is placed (or left unplaceable) accordingly.
      if (writerIds.size > 0) {
        const writerTrigRes = await listEdgesForNodes(ctx.graph, [...writerIds], {
          direction: 'out',
          edgeTypes: ['triggersOn' as EdgeType],
        });
        if (!writerTrigRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${writerTrigRes.error.message}`,
          });
        }
        for (const writerId of writerIds) {
          for (const trigEdge of writerTrigRes.value.get(writerId) ?? []) {
            sliceEdges.push(trigEdge);
          }
        }
      }
    }
  }

  // (b3) Second hop — ONLY for AGGREGATE rules that count edges off the root
  // OBJECT's OWN fields (`edgeSource: 'root-children-outgoing'`, e.g. the
  // junction-object rule counting distinct master-detail parents). The 1-hop
  // slice pulls edges INCIDENT to the object node, but a master-detail `lookupTo`
  // edge hangs off the object's CHILD FIELD, so the object node carries ZERO of
  // them. Expand: pull the root's child fields (via `parentOf`), then their
  // OUTGOING counted edges + the parent nodes those edges cite. Batched (one edge
  // query per hop, one node query); runs only when such a rule is selected, so
  // every other query keeps the exact 1-hop behavior above.
  const childOutgoingAggRules = selectedRules.filter(
    (rule) => rule.bind.aggregate?.edgeSource === 'root-children-outgoing',
  );
  if (childOutgoingAggRules.length > 0) {
    const nodeById = new Map<ComponentId, Node>(sliceNodes.map((n) => [n.id, n]));
    const countedEdgeTypes = [
      ...new Set(
        childOutgoingAggRules.flatMap((r) =>
          r.bind.edgeType !== undefined ? [r.bind.edgeType] : [],
        ),
      ),
    ];
    // 1) the root object's child fields (CustomObject --parentOf--> CustomField).
    const childRes = await listEdgesForNodes(ctx.graph, [componentId], {
      direction: 'out',
      edgeTypes: ['parentOf' as EdgeType],
    });
    if (!childRes.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${childRes.error.message}` });
    }
    const childFieldIds = new Set<ComponentId>();
    for (const childEdge of childRes.value.get(componentId) ?? []) {
      childFieldIds.add(childEdge.toId);
    }
    // 2) those fields' OUTGOING counted edges (lookupTo) + the field/parent nodes
    // each cited edge needs (the engine drops an edge whose endpoint node is
    // absent, so the child field — for the `parentId === root` test — and the
    // parent object — the citation — are both REQUIRED).
    if (childFieldIds.size > 0 && countedEdgeTypes.length > 0) {
      const fieldEdgeRes = await listEdgesForNodes(ctx.graph, [...childFieldIds], {
        direction: 'out',
        edgeTypes: countedEdgeTypes,
      });
      if (!fieldEdgeRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${fieldEdgeRes.error.message}`,
        });
      }
      const needIds = new Set<ComponentId>();
      for (const fieldId of childFieldIds) {
        for (const fieldEdge of fieldEdgeRes.value.get(fieldId) ?? []) {
          if (sliceEdges.length >= edges.length + JOIN_FANOUT_CAP) {
            sliceTruncated = true; // child-field edge fan-out capped
            break;
          }
          sliceEdges.push(fieldEdge);
          needIds.add(fieldEdge.fromId);
          needIds.add(fieldEdge.toId);
        }
      }
      const needNodeIds = [...needIds].filter((id) => !nodeById.has(id));
      if (needNodeIds.length > 0) {
        const aggNodesRes = await listNodesByIds(ctx.graph, needNodeIds);
        if (!aggNodesRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${aggNodesRes.error.message}`,
          });
        }
        sliceNodes.push(...aggNodesRes.value);
      }
    }
  }

  // (b4) Second hop — ONLY for EC-8 anti-join rules. Two shapes:
  //   - sameFromToPresentObject (C15 arm1): present field FLS grants are in the
  //     1-hop slice; pull each grantor's OUTGOING grantedBy edges so the engine
  //     can see whether the parent object also has allowEdit.
  //   - sameFromToRoot (C15 arm2): present object CRUD grants are NOT incident to
  //     a field root — fetch grantedBy INTO CustomObject:{objectOf(root)}.
  //   - sameTo + absentFromPhaseIn (C17): present is the field node; 1-hop already
  //     pulled incoming writesTo; pull each writer's triggersOn for phase placement.
  const antiJoinRules = selectedRules.filter((rule) => rule.bind.antiJoin !== undefined);
  if (antiJoinRules.length > 0) {
    const nodeById = new Map<ComponentId, Node>(sliceNodes.map((n) => [n.id, n]));
    const needEdgeTypes = [
      ...new Set(antiJoinRules.map((r) => r.bind.antiJoin!.absentEdgeType)),
    ];
    const needsPhase = antiJoinRules.some(
      (r) => r.bind.antiJoin!.absentFromPhaseIn !== undefined,
    );
    const needsPresentObject = antiJoinRules.some(
      (r) => r.bind.antiJoin!.correlate === 'sameFromToPresentObject',
    );
    const needsRootObjectPresent = antiJoinRules.some(
      (r) => r.bind.antiJoin!.correlate === 'sameFromToRoot',
    );

    // C15 arm2 — object grants into the field's parent object.
    if (needsRootObjectPresent) {
      const objMatch = /^[A-Za-z][A-Za-z0-9_]*:([^.]+)\./.exec(componentId);
      if (objMatch !== null) {
        const parentObjId = `CustomObject:${objMatch[1]}` as ComponentId;
        const objGrantRes = await listEdgesForNodes(ctx.graph, [parentObjId], {
          direction: 'in',
          edgeTypes: needEdgeTypes,
        });
        if (!objGrantRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${objGrantRes.error.message}`,
          });
        }
        const grantorIds = new Set<ComponentId>();
        for (const gEdge of objGrantRes.value.get(parentObjId) ?? []) {
          if (sliceEdges.length >= edges.length + JOIN_FANOUT_CAP) {
            sliceTruncated = true;
            break;
          }
          sliceEdges.push(gEdge);
          grantorIds.add(gEdge.fromId);
        }
        const needIds = [...grantorIds, parentObjId].filter((id) => !nodeById.has(id));
        if (needIds.length > 0) {
          const nRes = await listNodesByIds(ctx.graph, needIds);
          if (!nRes.ok) {
            return err({
              kind: 'internal',
              message: `graph query failed: ${nRes.error.message}`,
            });
          }
          for (const n of nRes.value) {
            sliceNodes.push(n);
            nodeById.set(n.id, n);
          }
        }
      }
    }

    // C15 arm1 — from each present grantor, pull outgoing absentEdgeType edges
    // (object grants) + the parent object node.
    if (needsPresentObject) {
      const grantorIds = new Set<ComponentId>();
      for (const edge of sliceEdges) {
        if (edge.toId === componentId) grantorIds.add(edge.fromId);
        if (edge.fromId === componentId) grantorIds.add(edge.toId);
      }
      if (grantorIds.size > 0) {
        const outRes = await listEdgesForNodes(ctx.graph, [...grantorIds], {
          direction: 'out',
          edgeTypes: needEdgeTypes,
        });
        if (!outRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${outRes.error.message}`,
          });
        }
        const objIds = new Set<ComponentId>();
        for (const grantorId of grantorIds) {
          for (const gEdge of outRes.value.get(grantorId) ?? []) {
            if (sliceEdges.length >= edges.length + JOIN_FANOUT_CAP) {
              sliceTruncated = true;
              break;
            }
            sliceEdges.push(gEdge);
            objIds.add(gEdge.toId);
          }
        }
        const needIds = [...objIds].filter((id) => !nodeById.has(id));
        if (needIds.length > 0) {
          const nRes = await listNodesByIds(ctx.graph, needIds);
          if (!nRes.ok) {
            return err({
              kind: 'internal',
              message: `graph query failed: ${nRes.error.message}`,
            });
          }
          for (const n of nRes.value) {
            sliceNodes.push(n);
            nodeById.set(n.id, n);
          }
        }
      }
    }

    // C17 — pull writers' triggersOn so phaseOfAutomation can place before-save.
    if (needsPhase) {
      const writerIds = new Set<ComponentId>();
      for (const edge of sliceEdges) {
        if (needEdgeTypes.includes(edge.edgeType) && edge.toId === componentId) {
          writerIds.add(edge.fromId);
        }
      }
      if (writerIds.size > 0) {
        const trigRes = await listEdgesForNodes(ctx.graph, [...writerIds], {
          direction: 'out',
          edgeTypes: ['triggersOn' as EdgeType],
        });
        if (!trigRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${trigRes.error.message}`,
          });
        }
        for (const writerId of writerIds) {
          for (const trigEdge of trigRes.value.get(writerId) ?? []) {
            sliceEdges.push(trigEdge);
          }
        }
      }
    }
  }

  // (b5) Second hop — ONLY for EC-11 crossObjectCascade rules (D3). The 1-hop
  // slice pulls the writer's OUTGOING writerTriggerEdge + writeEdge, but the
  // INCOMING automation on the TARGET object B (triggersOn / firesWhen from a
  // firer ≠ W) is NOT incident to W — it hangs off CustomObject:B. Expand: from
  // each cross-object write target, resolve object B → fetch INCOMING
  // targetIncomingEdgeTypes edges + their firer nodes. Batched; runs only when
  // such a rule is selected.
  const cascadeRules = selectedRules.filter(
    (rule) => rule.bind.crossObjectCascade !== undefined,
  );
  if (cascadeRules.length > 0) {
    const nodeById = new Map<ComponentId, Node>(sliceNodes.map((n) => [n.id, n]));
    const writeEdgeTypes = new Set(
      cascadeRules.map((r) => r.bind.crossObjectCascade!.writeEdge),
    );
    const incomingTypes = [
      ...new Set(
        cascadeRules.flatMap((r) => r.bind.crossObjectCascade!.targetIncomingEdgeTypes),
      ),
    ];
    const FIELD_OBJECT_RE = /^[A-Za-z][A-Za-z0-9_]*:([^.]+)\./;
    const CUSTOM_OBJECT_RE = /^CustomObject:(.+)$/;
    const targetObjIds = new Set<ComponentId>();
    for (const edge of sliceEdges) {
      if (edge.fromId !== componentId) continue;
      if (!writeEdgeTypes.has(edge.edgeType)) continue;
      const fieldMatch = FIELD_OBJECT_RE.exec(edge.toId);
      if (fieldMatch !== null) {
        targetObjIds.add(`CustomObject:${fieldMatch[1]}` as ComponentId);
        continue;
      }
      if (CUSTOM_OBJECT_RE.test(edge.toId)) targetObjIds.add(edge.toId);
    }
    if (targetObjIds.size > 0 && incomingTypes.length > 0) {
      const inRes = await listEdgesForNodes(ctx.graph, [...targetObjIds], {
        direction: 'in',
        edgeTypes: incomingTypes,
      });
      if (!inRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${inRes.error.message}`,
        });
      }
      const firerIds = new Set<ComponentId>();
      for (const objId of targetObjIds) {
        for (const inEdge of inRes.value.get(objId) ?? []) {
          if (inEdge.fromId === componentId) continue;
          if (sliceEdges.length >= edges.length + JOIN_FANOUT_CAP) {
            sliceTruncated = true;
            break;
          }
          sliceEdges.push(inEdge);
          firerIds.add(inEdge.fromId);
        }
      }
      const needIds = [...firerIds].filter((id) => !nodeById.has(id));
      if (needIds.length > 0) {
        const firerRes = await listNodesByIds(ctx.graph, needIds);
        if (!firerRes.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${firerRes.error.message}`,
          });
        }
        sliceNodes.push(...firerRes.value);
      }
    }
  }

  const slice: GroundedSlice = { nodes: sliceNodes, edges: sliceEdges };

  // (d)+(e) per-rule coverage → interpret → flatten (claims VERBATIM).
  const interpretations: Interpretation[] = [];
  for (const rule of selectedRules) {
    const coverage = adaptCoverage(
      summarizeCoverage(ctx.manifest, rule.dependsOnCoverage),
      sliceTruncated,
    );
    // FIX 1 — pass the queried root so a node-shaped rule reasons about THIS
    // component only, never a neighbor the 2-hop join expansion dragged in.
    interpretations.push(...interpret(rule, slice, coverage, componentId));
  }

  // EPIC-1 — second pass: bind ChainedRules over emitted interpretations
  // (concept-output → concept-input). One pass only; chain outputs are not
  // re-fed. Citations are the union of matched priors; confidence is weakest().
  interpretations.push(...chainInterpret(interpretations, CHAINED_RULES));

  // EPIC-2 — third pass: bind CompoundRules over the emitted interpretations
  // (first-pass + chained), firing only where ≥2 required concepts CO-FIRE ON
  // ONE ANCHOR. Emits one reconciled compound per shared anchor citing the union
  // of the priors that cite that anchor at weakest(). One pass only; compound
  // outputs are not re-fed. Delivers net-access-intersection (widen ∩ narrow →
  // one per-object posture).
  interpretations.push(...compoundInterpret(interpretations, COMPOUND_RULES));

  // EPIC-3 — fourth pass: reconcile superseded weaker claims after first-pass +
  // chain + compound. Demotes (stamps supersededBy) or drops redundant broader
  // interpretations when a stronger co-fires with anchor/topic overlap. Never
  // rewrites claim or groundedIn on demoted priors.
  const interpretationsReconciled = reconcile(interpretations, SUPERSEDES_RULES);

  const rulesFired = new Set(interpretationsReconciled.map((i) => i.ruleId)).size;
  const proactiveRisks = rankProactiveRisks(interpretationsReconciled);

  // Aggregate coverage over the union of the selected rules' dependencies —
  // drives the trust block + the top-level coverage caveat.
  const unionCoverageTypes = [
    ...new Set(selectedRules.flatMap((rule) => rule.dependsOnCoverage)),
  ];
  const aggSummary = summarizeCoverage(ctx.manifest, unionCoverageTypes);
  const aggCoverage = adaptCoverage(aggSummary, sliceTruncated);

  // #2 — a bound counted junction endpoint (a master-detail PARENT) NOT retrieved
  // into the vault makes the distinct-parent count UNDER-report: a real two-master
  // junction can go silently undetected — no citation, no interpretation, so no
  // per-rule caveat ever surfaces. "complete coverage" must never sit beside such
  // a silent non-detection, so when a `root-children-outgoing` aggregate rule drops
  // a phantom counted endpoint, hold the aggregate completeness OFF `complete` and
  // disclose the miss EVEN WHEN no rule fired. This touches only the TOP-LEVEL
  // trust/coverage block; the per-rule interpretation objects (incl. any co-selected
  // automation-collision claim) are byte-unchanged.
  const junctionEndpointUnresolved = childOutgoingAggRules.some((rule) =>
    aggregateHasUnresolvedCountedEndpoint(rule, slice, componentId),
  );
  const junctionMissNote: string | null = junctionEndpointUnresolved
    ? 'A master-detail parent of this object was not retrieved into the vault, so junction ' +
      '(two-master) detection may be incomplete — a real many-to-many junction can go undetected here.'
    : null;
  const completenessStatus: Coverage['status'] =
    junctionEndpointUnresolved && aggCoverage.status === 'complete' ? 'partial' : aggCoverage.status;
  // The rendered / top-level caveat carries BOTH the general coverage caveat and
  // the junction-miss note (either may be null).
  const topCoverageCaveat: string | null =
    aggCoverage.caveat !== null && junctionMissNote !== null
      ? `${aggCoverage.caveat} ${junctionMissNote}`
      : (aggCoverage.caveat ?? junctionMissNote);

  // Overall confidence: the WEAKEST across fired interpretations. Any `unknown`
  // (an absence rule under non-complete coverage) makes the whole `unknown`; no
  // interpretation at all is `unknown` by construction.
  const firedConfidences = interpretationsReconciled.map((i) => i.confidence);
  const overallConfidence: ConfidenceLevel | 'unknown' =
    firedConfidences.length === 0 || firedConfidences.some((c) => c === 'unknown')
      ? 'unknown'
      : weakest(...(firedConfidences as ConfidenceLevel[]));

  const limitations = [
    'Deterministic concept-rule reasoning over the offline vault snapshot — not a live read, no LLM.',
    ...(aggCoverage.caveat !== null ? [aggCoverage.caveat] : []),
    ...(junctionMissNote !== null ? [junctionMissNote] : []),
  ];

  const trust: TrustSummary = {
    provenance: 'offline_snapshot',
    confidence: overallConfidence,
    freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
    completeness: {
      status: completenessStatus,
      ...(aggSummary.missingCoverage.length > 0
        ? { missingCoverage: aggSummary.missingCoverage }
        : {}),
    },
    limitations,
  };

  const disclosure =
    interpretationsReconciled.length === 0
      ? BASE_DISCLOSURE + EMPTY_DISCLOSURE_NOTE
      : BASE_DISCLOSURE;

  const rendered = renderInterpretationsMarkdown({
    componentId,
    componentType: rootNode.type,
    interpretations: interpretationsReconciled,
    sliceTruncated,
    ...(topCoverageCaveat !== null ? { coverageCaveat: topCoverageCaveat } : {}),
    trust,
  });

  const data: InterpretOutput = {
    componentId,
    componentType: rootNode.type,
    interpretations: interpretationsReconciled,
    ...(proactiveRisks.length > 0 ? { proactiveRisks } : {}),
    rulesConsidered:
      selectedRules.length +
      CHAINED_RULES.length +
      COMPOUND_RULES.length +
      SUPERSEDES_RULES.length,
    rulesFired,
    sliceTruncated,
    trust,
    ...(topCoverageCaveat !== null ? { coverageCaveat: topCoverageCaveat } : {}),
    disclosure,
    rendered,
  };

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
