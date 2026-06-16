/// <reference types="vitest/globals" />

import type { Edge, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import type {
  Dependency,
  ToolingApiClient,
  ToolingApiError,
} from '../src/client.js';
import {
  enrichDependencies,
  type DependencyEnrichmentOptions,
} from '../src/enrich-dependencies.js';

const makeNode = (
  overrides: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>,
): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'src/path.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'parsed',
  source: 'test',
  properties: {},
  ...overrides,
});

interface GetDepsCall {
  readonly componentId: string;
}

const stubClient = (
  responses: ReadonlyArray<Result<readonly Dependency[], ToolingApiError>>,
): {
  readonly client: ToolingApiClient;
  readonly calls: GetDepsCall[];
} => {
  const calls: GetDepsCall[] = [];
  let i = 0;
  const client: ToolingApiClient = {
    query: async () => ok([] as readonly never[]),
    getDependencies: async (componentId: string) => {
      calls.push({ componentId });
      const r = responses[i++];
      if (r === undefined) {
        throw new Error(`stubClient: no response queued for getDependencies call ${i}`);
      }
      return r;
    },
  };
  return { client, calls };
};

describe('enrichDependencies — confirmation of pre-existing edge', () => {
  it('marks the pre-existing edge index when the API confirms the (fromId, toId) pair', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:AccountTriggerHandler', type: 'ApexClass', apiName: 'AccountTriggerHandler' }),
      makeNode({ id: 'CustomField:Account.Industry__c', type: 'CustomField', apiName: 'Industry__c' }),
    ];
    const edges: Edge[] = [
      makeEdge({
        fromId: 'ApexClass:AccountTriggerHandler',
        toId: 'CustomField:Account.Industry__c',
        edgeType: 'readsFrom',
        confidence: 'heuristic',
        source: 'apex-source-scanner',
      }),
    ];
    const { client, calls } = stubClient([
      ok([
        {
          Id: 'dep-1',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'AccountTriggerHandler',
          RefMetadataComponentId: '00N',
          RefMetadataComponentType: 'CustomField',
          RefMetadataComponentName: 'Account.Industry__c',
        },
      ]),
    ]);
    const result = await enrichDependencies(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
      edges,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.componentId).toBe('ApexClass:AccountTriggerHandler');
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0]!.edgeIndex).toBe(0);
    expect(result.newEdges).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('enrichDependencies — emits new dependsOnFromApi edge when no pre-existing match', () => {
  it('produces a declared-confidence edge with tooling-api-dependency source and isApiOnly properties', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:AccountTriggerHandler', type: 'ApexClass', apiName: 'AccountTriggerHandler' }),
      makeNode({ id: 'ApexClass:HelperUtil', type: 'ApexClass', apiName: 'HelperUtil' }),
    ];
    const edges: Edge[] = []; // No pre-existing edges.
    const { client } = stubClient([
      ok([
        {
          Id: 'dep-1',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'AccountTriggerHandler',
          RefMetadataComponentId: '01q',
          RefMetadataComponentType: 'ApexClass',
          RefMetadataComponentName: 'HelperUtil',
        },
      ]),
      ok([]), // No deps for HelperUtil.
    ]);
    const result = await enrichDependencies(
      {
        client,
        types: ['ApexClass'],
        rateLimitPauseMs: 0,
        toolingApiRefreshedAt: '2026-05-28T10:00:00.000Z',
      },
      nodes,
      edges,
    );
    expect(result.newEdges).toHaveLength(1);
    expect(result.newEdges[0]!.fromId).toBe('ApexClass:AccountTriggerHandler');
    expect(result.newEdges[0]!.toId).toBe('ApexClass:HelperUtil');
    expect(result.newEdges[0]!.edgeType).toBe('dependsOnFromApi');
    expect(result.newEdges[0]!.confidence).toBe('declared');
    expect(result.newEdges[0]!.source).toBe('tooling-api-dependency');
    expect(result.newEdges[0]!.properties).toEqual({
      apiReportedType: 'ApexClass',
      isApiOnly: true,
      toolingApiRefreshedAt: '2026-05-28T10:00:00.000Z',
    });
    expect(result.confirmations).toEqual([]);
  });
});

describe('enrichDependencies — both confirmation AND new edges in one response', () => {
  it('routes each API row to confirmation or new-edge based on pre-existing edge presence', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:AccountTriggerHandler', type: 'ApexClass', apiName: 'AccountTriggerHandler' }),
      makeNode({ id: 'CustomField:Account.Industry__c', type: 'CustomField', apiName: 'Industry__c' }),
      makeNode({ id: 'CustomField:Account.HiddenInternalCalc__c', type: 'CustomField', apiName: 'HiddenInternalCalc__c' }),
      makeNode({ id: 'ApexClass:HelperUtil', type: 'ApexClass', apiName: 'HelperUtil' }),
    ];
    const edges: Edge[] = [
      // Pre-existing edge — should be confirmed.
      makeEdge({
        fromId: 'ApexClass:AccountTriggerHandler',
        toId: 'CustomField:Account.Industry__c',
        edgeType: 'readsFrom',
        confidence: 'parsed',
      }),
    ];
    const { client } = stubClient([
      ok([
        {
          Id: 'dep-1',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'AccountTriggerHandler',
          RefMetadataComponentId: '00N',
          RefMetadataComponentType: 'CustomField',
          RefMetadataComponentName: 'Account.Industry__c',
        },
        // Dynamic Apex reference — only the API knows about it.
        {
          Id: 'dep-2',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'AccountTriggerHandler',
          RefMetadataComponentId: '00O',
          RefMetadataComponentType: 'CustomField',
          RefMetadataComponentName: 'Account.HiddenInternalCalc__c',
        },
        // Reflective call — only the API knows about it.
        {
          Id: 'dep-3',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'AccountTriggerHandler',
          RefMetadataComponentId: '01q',
          RefMetadataComponentType: 'ApexClass',
          RefMetadataComponentName: 'HelperUtil',
        },
      ]),
      // No deps for HelperUtil (also an ApexClass node — the enricher
      // queries every node whose type is in the requested set).
      ok([]),
    ]);
    const result = await enrichDependencies(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
      edges,
    );
    // One confirmation (the readsFrom edge).
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0]!.edgeIndex).toBe(0);
    // Two new edges (the API-only dependencies).
    expect(result.newEdges).toHaveLength(2);
    const newToIds = result.newEdges.map((e) => e.toId).sort();
    expect(newToIds).toEqual([
      'ApexClass:HelperUtil',
      'CustomField:Account.HiddenInternalCalc__c',
    ]);
    // Confidence preservation contract: every new edge carries
    // `declared`, mirroring the API IS the declaration. None of the
    // confirmations changed the pre-existing edge — that's the
    // caller's job; the result is the index pointer only.
    for (const newEdge of result.newEdges) {
      expect(newEdge.confidence).toBe('declared');
      expect(newEdge.edgeType).toBe('dependsOnFromApi');
    }
  });
});

describe('enrichDependencies — multiple pre-existing edges for the same pair both get confirmed', () => {
  it('returns one confirmation per pre-existing edge with the matching (fromId, toId)', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' }),
      makeNode({ id: 'CustomField:Account.Bar__c', type: 'CustomField', apiName: 'Bar__c' }),
    ];
    // A class that BOTH reads from AND writes to the same field —
    // two edges, different types.
    const edges: Edge[] = [
      makeEdge({
        fromId: 'ApexClass:Foo',
        toId: 'CustomField:Account.Bar__c',
        edgeType: 'readsFrom',
        confidence: 'parsed',
      }),
      makeEdge({
        fromId: 'ApexClass:Foo',
        toId: 'CustomField:Account.Bar__c',
        edgeType: 'writesTo',
        confidence: 'parsed',
      }),
    ];
    const { client } = stubClient([
      ok([
        {
          Id: 'dep-1',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'Foo',
          RefMetadataComponentId: '00N',
          RefMetadataComponentType: 'CustomField',
          RefMetadataComponentName: 'Account.Bar__c',
        },
      ]),
    ]);
    const result = await enrichDependencies(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
      edges,
    );
    // Per the vendored doc's "matches on (fromId, toId) regardless
    // of edgeType" rule, both edges are confirmed.
    expect(result.confirmations).toHaveLength(2);
    const indices = result.confirmations.map((c) => c.edgeIndex).sort();
    expect(indices).toEqual([0, 1]);
    expect(result.newEdges).toEqual([]);
  });
});

describe('enrichDependencies — per-source error isolation', () => {
  it('records a per-node error when the API query for a single source fails, continues other nodes', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Failing', type: 'ApexClass', apiName: 'Failing' }),
      makeNode({ id: 'ApexClass:Working', type: 'ApexClass', apiName: 'Working' }),
      makeNode({ id: 'ApexClass:Target', type: 'ApexClass', apiName: 'Target' }),
    ];
    const { client } = stubClient([
      err({ kind: 'query-failed', message: 'INVALID_FIELD' }),
      ok([
        {
          Id: 'dep-1',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'Working',
          RefMetadataComponentId: '01q',
          RefMetadataComponentType: 'ApexClass',
          RefMetadataComponentName: 'Target',
        },
      ]),
      ok([]),
    ]);
    const result = await enrichDependencies(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
      [],
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.componentId).toBe('ApexClass:Failing');
    expect(result.errors[0]!.error).toContain('INVALID_FIELD');
    // The Working node's enrichment continued — one new edge.
    expect(result.newEdges).toHaveLength(1);
    expect(result.newEdges[0]!.fromId).toBe('ApexClass:Working');
    expect(result.newEdges[0]!.toId).toBe('ApexClass:Target');
  });
});

describe('enrichDependencies — rate-limit pause is honored between successive queries', () => {
  it('sleeps the configured ms between queries but not before the first', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:A', type: 'ApexClass', apiName: 'A' }),
      makeNode({ id: 'ApexClass:B', type: 'ApexClass', apiName: 'B' }),
      makeNode({ id: 'ApexClass:C', type: 'ApexClass', apiName: 'C' }),
    ];
    const { client } = stubClient([ok([]), ok([]), ok([])]);
    const sleepMs: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepMs.push(ms);
    };
    await enrichDependencies(
      { client, types: ['ApexClass'], rateLimitPauseMs: 123, sleep },
      nodes,
      [],
    );
    // Three queries → two sleeps (before queries 2 and 3, not before query 1).
    expect(sleepMs).toEqual([123, 123]);
  });
});

describe('enrichDependencies — types filter skips out-of-scope nodes', () => {
  it('does not issue an API query for nodes whose type is not in the requested set', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' }),
      makeNode({ id: 'Layout:Account-Standard', type: 'Layout', apiName: 'Account-Standard' }),
    ];
    const { client, calls } = stubClient([ok([])]);
    const result = await enrichDependencies(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
      [],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.componentId).toBe('ApexClass:Foo');
    expect(result.newEdges).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('enrichDependencies — rows with unknown target id are dropped', () => {
  it('skips API rows whose target id does not resolve to a vault node', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' }),
      // Note: ApexClass:KnownTarget IS in the vault.
      makeNode({ id: 'ApexClass:KnownTarget', type: 'ApexClass', apiName: 'KnownTarget' }),
    ];
    const { client } = stubClient([
      ok([
        // First row: target is a known vault node — should land.
        {
          Id: 'dep-1',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'Foo',
          RefMetadataComponentId: '01q',
          RefMetadataComponentType: 'ApexClass',
          RefMetadataComponentName: 'KnownTarget',
        },
        // Second row: target is managed-package internal — vault
        // has no such node. Per the vendored doc, the row is skipped
        // (no dangling-id synthesis in v1.7).
        {
          Id: 'dep-2',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'Foo',
          RefMetadataComponentId: '99x',
          RefMetadataComponentType: 'ApexClass',
          RefMetadataComponentName: 'acme__InternalManagedClass',
        },
      ]),
      ok([]),
    ]);
    const result = await enrichDependencies(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
      [],
    );
    // Only one new edge (the known-target row); the managed-package
    // row is silently skipped.
    expect(result.newEdges).toHaveLength(1);
    expect(result.newEdges[0]!.toId).toBe('ApexClass:KnownTarget');
    expect(result.errors).toEqual([]);
  });
});

describe('enrichDependencies — empty input set', () => {
  it('returns an empty result without issuing any queries', async () => {
    const { client, calls } = stubClient([]);
    const result = await enrichDependencies(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      [],
      [],
    );
    expect(calls).toEqual([]);
    expect(result.confirmations).toEqual([]);
    expect(result.newEdges).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('enrichDependencies — toolingApiRefreshedAt omitted when option missing', () => {
  it('omits the toolingApiRefreshedAt property when no timestamp is supplied', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' }),
      makeNode({ id: 'ApexClass:Bar', type: 'ApexClass', apiName: 'Bar' }),
    ];
    const { client } = stubClient([
      ok([
        {
          Id: 'dep-1',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'Foo',
          RefMetadataComponentId: '01q',
          RefMetadataComponentType: 'ApexClass',
          RefMetadataComponentName: 'Bar',
        },
      ]),
      ok([]),
    ]);
    const opts: DependencyEnrichmentOptions = {
      client,
      types: ['ApexClass'],
      rateLimitPauseMs: 0,
    };
    const result = await enrichDependencies(opts, nodes, []);
    expect(result.newEdges).toHaveLength(1);
    expect(result.newEdges[0]!.properties).toEqual({
      apiReportedType: 'ApexClass',
      isApiOnly: true,
    });
    // The toolingApiRefreshedAt key is NOT present.
    expect('toolingApiRefreshedAt' in result.newEdges[0]!.properties).toBe(false);
  });
});

describe('enrichDependencies — duplicate API rows for the same (from, to) emit only one new edge', () => {
  it('dedupes new edges by (fromId, toId) so a single source receives at most one edge per target', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' }),
      makeNode({ id: 'ApexClass:Bar', type: 'ApexClass', apiName: 'Bar' }),
    ];
    const { client } = stubClient([
      ok([
        {
          Id: 'dep-1',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'Foo',
          RefMetadataComponentId: '01q',
          RefMetadataComponentType: 'ApexClass',
          RefMetadataComponentName: 'Bar',
        },
        // Duplicate row — same pair.
        {
          Id: 'dep-2',
          MetadataComponentId: '01p',
          MetadataComponentType: 'ApexClass',
          MetadataComponentName: 'Foo',
          RefMetadataComponentId: '01q',
          RefMetadataComponentType: 'ApexClass',
          RefMetadataComponentName: 'Bar',
        },
      ]),
      ok([]),
    ]);
    const result = await enrichDependencies(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
      [],
    );
    expect(result.newEdges).toHaveLength(1);
  });
});
