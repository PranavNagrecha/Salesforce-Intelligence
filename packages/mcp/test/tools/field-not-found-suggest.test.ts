/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  buildFieldResolveSuggestions,
  fieldIdToResolveQuery,
  fieldNotFoundError,
} from '../../src/tools/field-not-found-suggest.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-11T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-fnf',
};

const makeField = (id: string, apiName: string, parentId: string): Node => ({
  id,
  type: 'CustomField',
  apiName,
  label: apiName,
  parentId,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { dataType: 'Text' },
});

const seed: ExtractionResult = {
  nodes: [
    {
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    },
    makeField('CustomField:Account.Industry', 'Industry', 'CustomObject:Account'),
    makeField('CustomField:Account.AnnualRevenue', 'AnnualRevenue', 'CustomObject:Account'),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fnf-'));
  const opened = await openGraph(join(tempDir, 'fnf.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('fieldIdToResolveQuery', () => {
  it('uses field api name for typical custom fields', () => {
    expect(fieldIdToResolveQuery('CustomField:Account.Revenue__c')).toBe('Revenue__c');
  });

  it('includes object context for short standard-like names', () => {
    expect(fieldIdToResolveQuery('CustomField:Account.Id')).toBe('Account Id');
  });
});

describe('buildFieldResolveSuggestions — FLD-04', () => {
  it('returns ranked CustomField candidates for a mistyped id', async () => {
    const suggestions = await buildFieldResolveSuggestions(
      ctx,
      'CustomField:Account.Industy',
    );
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => s.componentId === 'CustomField:Account.Industry')).toBe(
      true,
    );
  });
});

describe('fieldNotFoundError', () => {
  it('attaches resolveSuggestions on component-not-found', async () => {
    const err = await fieldNotFoundError(
      ctx,
      'CustomField:Account.Industy',
      'no CustomField with id CustomField:Account.Industy',
    );
    expect(err.kind).toBe('component-not-found');
    expect(err.resolveSuggestions?.length).toBeGreaterThan(0);
    expect(err.message).toMatch(/resolveSuggestions/);
  });
});
