/// <reference types="vitest/globals" />

import type { Node } from '@sf-intelligence/contracts';
import { ok, err, type Result } from '@sf-intelligence/core';

import type {
  Dependency,
  ToolingApiClient,
  ToolingApiError,
} from '../src/client.js';
import {
  enrichLastModified,
  type EnrichmentOptions,
} from '../src/enrich.js';

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'src/path.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

interface QueryCall {
  readonly soql: string;
}

const stubClient = (
  queryResponses: ReadonlyArray<Result<readonly Record<string, unknown>[], ToolingApiError>>,
): { readonly client: ToolingApiClient; readonly calls: QueryCall[] } => {
  const calls: QueryCall[] = [];
  let i = 0;
  const client: ToolingApiClient = {
    query: async (soql: string) => {
      calls.push({ soql });
      const r = queryResponses[i++];
      if (r === undefined) {
        throw new Error(`stubClient: no response queued for query call ${i}`);
      }
      return r as Result<readonly never[], ToolingApiError>;
    },
    getDependencies: async () => ok([] as readonly Dependency[]),
  };
  return { client, calls };
};

describe('enrichLastModified — ApexClass happy path', () => {
  it('issues one SOQL query per type and folds rows back to per-node enrichments', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' }),
      makeNode({ id: 'ApexClass:Bar', type: 'ApexClass', apiName: 'Bar' }),
    ];
    const { client, calls } = stubClient([
      ok([
        {
          Id: '01p1',
          Name: 'Foo',
          LastModifiedDate: '2026-04-12T14:33:08.000Z',
          LastModifiedById: '005aa',
          LastModifiedBy: { Name: 'Alice' },
          ApiVersion: 60.0,
        },
        {
          Id: '01p2',
          Name: 'Bar',
          LastModifiedDate: '2026-05-10T09:00:00.000Z',
          LastModifiedById: '005bb',
          LastModifiedBy: { Name: 'Bob' },
          ApiVersion: '61.0',
        },
      ]),
    ]);
    const opts: EnrichmentOptions = {
      client,
      types: ['ApexClass'],
      rateLimitPauseMs: 0,
    };
    const result = await enrichLastModified(opts, nodes);
    expect(result.enrichedCount).toBe(2);
    expect(result.errors).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.soql).toContain('FROM ApexClass');
    expect(calls[0]!.soql).toContain("WHERE Name IN ('Foo', 'Bar')");
    const foo = result.enrichments.find((e) => e.componentId === 'ApexClass:Foo');
    expect(foo).toBeDefined();
    expect(foo!.lastModifiedDate).toBe('2026-04-12T14:33:08.000Z');
    expect(foo!.lastModifiedBy.id).toBe('005aa');
    expect(foo!.lastModifiedBy.name).toBe('Alice');
    expect(foo!.apiVersion).toBe(60.0);
    const bar = result.enrichments.find((e) => e.componentId === 'ApexClass:Bar');
    expect(bar!.apiVersion).toBe(61.0);
  });
});

describe('enrichLastModified — Flow uses FlowDefinitionView', () => {
  it('queries FlowDefinitionView by DeveloperName and maps the response back via DeveloperName', async () => {
    const nodes = [
      makeNode({ id: 'Flow:My_Flow', type: 'Flow', apiName: 'My_Flow' }),
    ];
    const { client, calls } = stubClient([
      ok([
        {
          Id: '301',
          DeveloperName: 'My_Flow',
          MasterLabel: 'My Flow',
          LastModifiedDate: '2026-04-01T00:00:00.000Z',
          LastModifiedById: '005aa',
          LastModifiedBy: { Name: 'A' },
          ApiVersion: 60.0,
        },
      ]),
    ]);
    const result = await enrichLastModified(
      { client, types: ['Flow'], rateLimitPauseMs: 0 },
      nodes,
    );
    expect(result.enrichedCount).toBe(1);
    expect(calls[0]!.soql).toContain('FROM FlowDefinitionView');
    expect(calls[0]!.soql).toContain("WHERE DeveloperName IN ('My_Flow')");
  });
});

describe('enrichLastModified — CustomField __c suffix handling', () => {
  it('queries by the bare developer name (no __c) and reconstructs the canonical id with __c', async () => {
    const nodes = [
      makeNode({
        id: 'CustomField:Account.Industry__c',
        type: 'CustomField',
        apiName: 'Industry__c',
      }),
    ];
    const { client, calls } = stubClient([
      ok([
        {
          Id: '00N',
          DeveloperName: 'Industry',
          TableEnumOrId: 'Account',
          LastModifiedDate: '2026-04-01T00:00:00.000Z',
          LastModifiedById: '005',
          LastModifiedBy: { Name: 'A' },
        },
      ]),
    ]);
    const result = await enrichLastModified(
      { client, types: ['CustomField'], rateLimitPauseMs: 0 },
      nodes,
    );
    expect(result.enrichedCount).toBe(1);
    expect(calls[0]!.soql).toContain("WHERE DeveloperName IN ('Industry')");
    expect(result.enrichments[0]!.componentId).toBe('CustomField:Account.Industry__c');
  });
});

describe('enrichLastModified — ValidationRule split on final dot', () => {
  it('queries by the rule name (post-dot) and reconstructs via EntityDefinitionId', async () => {
    const nodes = [
      makeNode({
        id: 'ValidationRule:Account.Require_Phone',
        type: 'ValidationRule',
        apiName: 'Account.Require_Phone',
      }),
    ];
    const { client, calls } = stubClient([
      ok([
        {
          Id: '03d',
          ValidationName: 'Require_Phone',
          EntityDefinitionId: 'Account',
          LastModifiedDate: '2026-04-01T00:00:00.000Z',
          LastModifiedById: '005',
          LastModifiedBy: { Name: 'A' },
        },
      ]),
    ]);
    const result = await enrichLastModified(
      { client, types: ['ValidationRule'], rateLimitPauseMs: 0 },
      nodes,
    );
    expect(result.enrichedCount).toBe(1);
    expect(calls[0]!.soql).toContain("WHERE ValidationName IN ('Require_Phone')");
  });
});

describe('enrichLastModified — per-type query failure surfaces per-node errors', () => {
  it('attaches the per-type SOQL error to every node in the failing batch', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' }),
      makeNode({ id: 'ApexClass:Bar', type: 'ApexClass', apiName: 'Bar' }),
    ];
    const { client } = stubClient([
      err({
        kind: 'query-failed',
        message: 'INVALID_FIELD',
      }),
    ]);
    const result = await enrichLastModified(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
    );
    expect(result.enrichedCount).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.error).toContain('INVALID_FIELD');
  });
});

describe('enrichLastModified — managed-package and unknown rows are silently dropped', () => {
  it('drops rows whose canonical id does not match a vault node', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' }),
    ];
    const { client } = stubClient([
      ok([
        {
          Id: '01p1',
          Name: 'Foo',
          LastModifiedDate: '2026-04-01T00:00:00.000Z',
          LastModifiedById: '005',
          LastModifiedBy: { Name: 'A' },
          ApiVersion: 60.0,
        },
        {
          Id: '01p2',
          Name: 'ManagedPackageInternal',
          LastModifiedDate: '2026-04-01T00:00:00.000Z',
          LastModifiedById: '005',
          LastModifiedBy: { Name: 'A' },
          ApiVersion: 60.0,
        },
      ]),
    ]);
    const result = await enrichLastModified(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
    );
    expect(result.enrichedCount).toBe(1);
    expect(result.errors).toEqual([]);
  });
});

describe('enrichLastModified — type not in dispatch table', () => {
  it('emits one error per node for a type the v1.7 R2 dispatch table does not cover', async () => {
    const nodes = [
      makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    ];
    const { client, calls } = stubClient([]);
    const result = await enrichLastModified(
      { client, types: ['Profile'], rateLimitPauseMs: 0 },
      nodes,
    );
    expect(result.enrichedCount).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain('dispatch table');
    expect(calls).toHaveLength(0);
  });
});

describe('enrichLastModified — rate-limit pause is honored between batched queries', () => {
  it('sleeps the configured ms between successive queries', async () => {
    const nodes = Array.from({ length: 250 }, (_, i) =>
      makeNode({
        id: `ApexClass:Foo${i}`,
        type: 'ApexClass',
        apiName: `Foo${i}`,
      }),
    );
    // Two batches of 200 + 50 = two SOQL queries.
    const { client } = stubClient([
      ok([]),
      ok([]),
    ]);
    const sleepMs: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepMs.push(ms);
    };
    await enrichLastModified(
      { client, types: ['ApexClass'], rateLimitPauseMs: 123, sleep },
      nodes,
    );
    expect(sleepMs).toEqual([123]);
  });

  it('does not sleep before the first query', async () => {
    const { client } = stubClient([ok([])]);
    const sleepMs: number[] = [];
    await enrichLastModified(
      {
        client,
        types: ['ApexClass'],
        rateLimitPauseMs: 999,
        sleep: async (ms: number) => {
          sleepMs.push(ms);
        },
      },
      [makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' })],
    );
    expect(sleepMs).toEqual([]);
  });
});

describe('enrichLastModified — passes through types not in the request set', () => {
  it('skips nodes whose type was not requested', async () => {
    const nodes = [
      makeNode({ id: 'ApexClass:Foo', type: 'ApexClass', apiName: 'Foo' }),
      makeNode({ id: 'Layout:Account-Standard', type: 'Layout', apiName: 'Account-Standard' }),
    ];
    const { client, calls } = stubClient([
      ok([
        {
          Id: '01p',
          Name: 'Foo',
          LastModifiedDate: '2026-04-01T00:00:00.000Z',
          LastModifiedById: '005',
          LastModifiedBy: { Name: 'A' },
          ApiVersion: 60.0,
        },
      ]),
    ]);
    const result = await enrichLastModified(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      nodes,
    );
    expect(result.enrichedCount).toBe(1);
    expect(calls).toHaveLength(1); // No Layout query issued.
  });
});

describe('enrichLastModified — empty input set', () => {
  it('returns a zero-enrichment result without issuing any queries', async () => {
    const { client, calls } = stubClient([]);
    const result = await enrichLastModified(
      { client, types: ['ApexClass'], rateLimitPauseMs: 0 },
      [],
    );
    expect(result.enrichedCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(calls).toEqual([]);
  });
});
