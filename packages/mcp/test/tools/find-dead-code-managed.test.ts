/// <reference types="vitest/globals" />

/**
 * DEV-07 — find_dead_code labelled installed managed-package fields
 * `definitely_dead`: they cannot be deleted, and the package code that uses
 * them is never in the vault. All names synthetic.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { findDeadCodeHandler } from '../../src/tools/find-dead-code.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Invoice__c', type: 'CustomObject', apiName: 'Invoice__c' }),
    node({
      id: 'CustomField:Invoice__c.acme__Score__c',
      type: 'CustomField',
      apiName: 'acme__Score__c',
      parentId: 'CustomObject:Invoice__c',
    }),
    node({
      id: 'CustomField:Invoice__c.Notes__c',
      type: 'CustomField',
      apiName: 'Notes__c',
      parentId: 'CustomObject:Invoice__c',
    }),
    node({ id: 'InstalledPackage:acme', type: 'InstalledPackage', apiName: 'acme' }),
  ],
  edges: [],
};

let dir: string;
let graph: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-dead-managed-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  graph = opened.value;
  const imported = await importExtractionResults(graph, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph } as Context;
});

afterAll(async () => {
  await closeGraph(graph);
  rmSync(dir, { recursive: true, force: true });
});

describe('DEV-07 managed-package components are never definitely_dead', () => {
  it('FAIL-BEFORE/PASS-AFTER: a namespaced field is uncertain; the unmanaged one stays definitely_dead', async () => {
    const r = await findDeadCodeHandler(ctx, { types: ['CustomField'], includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.candidates.map((c) => [c.componentId, c]));
    expect(byId.get('CustomField:Invoice__c.acme__Score__c')?.verdict).toBe('uncertain');
    expect(byId.get('CustomField:Invoice__c.acme__Score__c')?.reasoning).toContain('managed-package');
    expect(byId.get('CustomField:Invoice__c.Notes__c')?.verdict).toBe('definitely_dead');
  });

  it('the default (unscoped) listing no longer leads with managed fields', async () => {
    const r = await findDeadCodeHandler(ctx, { types: ['CustomField'] });
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.data.candidates.map((c) => c.componentId)).toEqual(['CustomField:Invoice__c.Notes__c']);
  });
});
