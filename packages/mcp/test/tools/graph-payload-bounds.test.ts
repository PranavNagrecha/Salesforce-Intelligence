/// <reference types="vitest/globals" />

import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';

import {
  enforceGraphPayloadBudget,
  estimateGraphPayloadBytes,
  GRAPH_MAX_PAYLOAD_BYTES,
} from '../../src/tools/graph-payload-bounds.js';

const makeNode = (id: string, properties: Record<string, unknown> = {}): Node => ({
  id: id as ComponentId,
  type: 'CustomObject',
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const makeEdge = (fromId: string, toId: string): Edge => ({
  fromId: fromId as ComponentId,
  toId: toId as ComponentId,
  edgeType: 'references',
  confidence: 'parsed',
  source: 'unit-test',
  properties: {},
});

// =============================================================================
// CR-RV7: enforceGraphPayloadBudget is the SINGLE chokepoint both get_impact and
// get_subgraph flow through. It must drop DANGLING edges (an endpoint absent
// from the returned `nodes`) on BOTH paths — the under-budget early return AND
// the trim path. The trim path already filtered; the early return did NOT, which
// let dangling edges escape on the common light-hub case. These unit tests pin
// the fix at the shared chokepoint so the two tools cannot drift.
// =============================================================================

describe('enforceGraphPayloadBudget — CR-RV7 dangling-edge filtering', () => {
  const ROOT = 'CustomObject:A' as ComponentId;

  it('early-return path: drops a dangling edge (endpoint absent from nodes), trimmed:false', () => {
    const nodes = [makeNode('CustomObject:A'), makeNode('CustomObject:B')];
    // A->B is self-contained; A->C dangles (C is not in nodes).
    const edges = [makeEdge('CustomObject:A', 'CustomObject:B'), makeEdge('CustomObject:A', 'CustomObject:C')];
    // Sanity: the (unfiltered) slice is well under budget so we take the early
    // return, NOT the trim path.
    expect(estimateGraphPayloadBytes({ nodes, edges })).toBeLessThanOrEqual(
      GRAPH_MAX_PAYLOAD_BYTES,
    );

    const result = enforceGraphPayloadBudget(ROOT, nodes, edges);

    expect(result.trimmed).toBe(false); // early-return branch
    // FAIL-BEFORE: the early return passed `edges` through unfiltered, so the
    // A->C dangling edge survived.
    const ids = new Set(result.nodes.map((n) => n.id));
    const dangling = result.edges.filter((e) => !ids.has(e.fromId) || !ids.has(e.toId));
    expect(dangling).toEqual([]);
    // The self-contained edge is kept; the dangling one is dropped.
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.toId).toBe('CustomObject:B');
  });

  it('early-return path: a fully self-contained under-budget slice is unchanged (no false drop)', () => {
    const nodes = [makeNode('CustomObject:A'), makeNode('CustomObject:B')];
    const edges = [makeEdge('CustomObject:A', 'CustomObject:B')];

    const result = enforceGraphPayloadBudget(ROOT, nodes, edges);

    expect(result.trimmed).toBe(false);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual(edges[0]);
  });

  it('early-return path: >200 light nodes with a clipped-node dangling edge still emits 0 dangling (mechanism a)', () => {
    // Mechanism (a): the caller sliced its node list to a cap but its edge list
    // references a clipped node. Build a small-but-many node set that stays under
    // budget, plus an edge to a node id NOT in the returned set. (In get_impact
    // a 200-node hub always exceeds the byte budget and takes the trim path;
    // the unit level lets us isolate the early-return branch directly.)
    const nodes: Node[] = [makeNode('CustomObject:A')];
    const edges: Edge[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `CustomObject:N${String(i).padStart(3, '0')}`;
      nodes.push(makeNode(id));
      edges.push(makeEdge(id, 'CustomObject:A'));
    }
    // One edge from a CLIPPED node (never added to `nodes`) — the dangler.
    edges.push(makeEdge('CustomObject:CLIPPED', 'CustomObject:A'));
    expect(estimateGraphPayloadBytes({ nodes, edges })).toBeLessThanOrEqual(
      GRAPH_MAX_PAYLOAD_BYTES,
    );

    const result = enforceGraphPayloadBudget(ROOT, nodes, edges);

    expect(result.trimmed).toBe(false);
    const ids = new Set(result.nodes.map((n) => n.id));
    const dangling = result.edges.filter((e) => !ids.has(e.fromId) || !ids.has(e.toId));
    expect(dangling).toEqual([]);
    expect(result.edges.some((e) => e.fromId === 'CustomObject:CLIPPED')).toBe(false);
    // All 40 self-contained edges survive.
    expect(result.edges).toHaveLength(40);
  });

  it('trim path: still filters dangling edges after byte-trim (regression guard)', () => {
    // Force the trim path: many heavy nodes so the slice exceeds the budget.
    const big = 'x'.repeat(2_000);
    const nodes: Node[] = [makeNode('CustomObject:A', { blob: big })];
    const edges: Edge[] = [];
    for (let i = 0; i < 60; i++) {
      const id = `CustomObject:H${String(i).padStart(3, '0')}`;
      nodes.push(makeNode(id, { blob: big }));
      edges.push(makeEdge(id, 'CustomObject:A'));
    }
    // A dangling edge to a node that does not exist at all.
    edges.push(makeEdge('CustomObject:GHOST', 'CustomObject:A'));
    expect(estimateGraphPayloadBytes({ nodes, edges })).toBeGreaterThan(
      GRAPH_MAX_PAYLOAD_BYTES,
    );

    const result = enforceGraphPayloadBudget(ROOT, nodes, edges);

    expect(result.trimmed).toBe(true); // trim path
    const ids = new Set(result.nodes.map((n) => n.id));
    const dangling = result.edges.filter((e) => !ids.has(e.fromId) || !ids.has(e.toId));
    expect(dangling).toEqual([]);
    expect(result.edges.some((e) => e.fromId === 'CustomObject:GHOST')).toBe(false);
    // The root is always kept.
    expect(result.nodes.some((n) => n.id === 'CustomObject:A')).toBe(true);
    // The final slice fits the budget.
    expect(estimateGraphPayloadBytes({ nodes: result.nodes, edges: result.edges })).toBeLessThanOrEqual(
      GRAPH_MAX_PAYLOAD_BYTES,
    );
  });
});
