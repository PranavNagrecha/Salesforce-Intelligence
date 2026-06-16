/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  type GraphStore,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  namingConventionReportHandler,
} from '../../src/tools/naming-convention-report.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, CustomField: 25 },
  edges: {},
  sourceTreeHash: 'sha256:naming-convention-fixture',
};

// Builders mirror the patterns package's own test fixtures so the seed
// shape stays consistent across recognizer and MCP-tool tests.
const parentObject = (apiName: string): Node => ({
  id: `CustomObject:${apiName}`,
  type: 'CustomObject',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: `objects/${apiName}/${apiName}.object-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const field = (parent: string, apiName: string): Node => ({
  id: `CustomField:${parent}.${apiName}`,
  type: 'CustomField',
  apiName,
  label: apiName,
  parentId: `CustomObject:${parent}`,
  sourcePath: `objects/${parent}/fields/${apiName}.field-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { dataType: 'Text' },
});

let tempDir: string;

// Each scenario owns its own DB file so seeds don't bleed across cases.
const makeCtx = async (
  dbName: string,
  nodes: readonly Node[],
): Promise<{ ctx: Context; store: GraphStore }> => {
  const opened = await openGraph(join(tempDir, dbName));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const imported = await importExtractionResults(store, [
    { nodes, edges: [] },
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  const ctx: Context = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
  return { ctx, store };
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-naming-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('namingConventionReportHandler: default scope (all)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const nodes: Node[] = [parentObject('Account')];
    for (let i = 0; i < 20; i++) {
      nodes.push(field('Account', `Acc_Field${i.toString()}__c`));
    }
    const built = await makeCtx('default-scope.db', nodes);
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns prefix observation for Account when called with no scope', async () => {
    const result = await namingConventionReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prefixObs = result.value.data.observations.find((o) =>
      o.statement.includes('prefix'),
    );
    expect(prefixObs).toBeDefined();
    if (prefixObs === undefined) return;
    expect(prefixObs.kind).toBe('naming-convention');
    expect(prefixObs.scope).toBe('CustomField:Account.*');
    expect(prefixObs.confidence).toBe('heuristic');
    expect(prefixObs.evidence.matching).toBe(20);
    expect(prefixObs.evidence.total).toBe(20);
    // Vault-state envelope copies straight from the manifest, letting
    // clients diff against the source-tree hash they have on hand.
    expect(result.value.vaultState.sourceTreeHash).toBe(
      'sha256:naming-convention-fixture',
    );
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-27T14:33:08Z');
  });
});

describe('namingConventionReportHandler: scoped to one object', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const nodes: Node[] = [
      parentObject('Account'),
      parentObject('Opportunity'),
    ];
    for (let i = 0; i < 20; i++) {
      nodes.push(field('Account', `Acc_Field${i.toString()}__c`));
    }
    for (let i = 0; i < 20; i++) {
      nodes.push(field('Opportunity', `OPP_Field${i.toString()}__c`));
    }
    const built = await makeCtx('scoped.db', nodes);
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns only Account observations when scoped to CustomField:Account.*', async () => {
    const result = await namingConventionReportHandler(ctx, {
      scope: 'CustomField:Account.*',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.observations.length).toBeGreaterThan(0);
    for (const obs of result.value.data.observations) {
      expect(obs.scope).toBe('CustomField:Account.*');
    }
  });
});

describe('namingConventionReportHandler: no patterns detected', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    // Only 3 fields — under the recognizer's MIN_GROUP_SIZE of 5. The
    // recognizer should stay silent.
    const nodes: Node[] = [
      parentObject('Account'),
      field('Account', 'Acc_Foo__c'),
      field('Account', 'Acc_Bar__c'),
      field('Account', 'Acc_Baz__c'),
    ];
    const built = await makeCtx('no-patterns.db', nodes);
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns an empty observations array when no group meets the minimum size', async () => {
    const result = await namingConventionReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.observations).toEqual([]);
    expect(result.value.vaultState.sourceTreeHash).toBe(
      'sha256:naming-convention-fixture',
    );
  });
});

describe('namingConventionReportHandler: invalid scope', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const nodes: Node[] = [parentObject('Account')];
    for (let i = 0; i < 10; i++) {
      nodes.push(field('Account', `Acc_F${i.toString()}__c`));
    }
    const built = await makeCtx('invalid-scope.db', nodes);
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('maps PatternError.invalid-scope to McpError.invalid-query', async () => {
    const result = await namingConventionReportHandler(ctx, {
      scope: 'NotAValidScope',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('NotAValidScope');
  });
});

describe('namingConventionReportHandler: determinism', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const nodes: Node[] = [parentObject('Account')];
    for (let i = 0; i < 12; i++) {
      nodes.push(field('Account', `Acc_F${i.toString()}__c`));
    }
    const built = await makeCtx('determinism.db', nodes);
    ctx = built.ctx;
    store = built.store;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns byte-identical responses across two calls with the same input', async () => {
    const first = await namingConventionReportHandler(ctx, {});
    const second = await namingConventionReportHandler(ctx, {});
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // JSON serialization is a cheap byte-equality probe and matches how the
    // dispatch layer ships the response over the wire.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
