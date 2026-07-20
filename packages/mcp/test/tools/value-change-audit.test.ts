/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { valueChangeAuditHandler } from '../../src/tools/value-change-audit.js';

const REQUIRED = ['CustomField', 'ValidationRule', 'Flow', 'ApexClass', 'ApexTrigger', 'WorkflowRule', 'Layout', 'SharingRule', 'DuplicateRule'];
const completeCoverage = (types: readonly string[]): readonly CoverageEntry[] =>
  types.map((type) => ({ type, requested: true, retrieved: 1, errored: false, neverModeled: false }));

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0', refreshedAt: '2026-06-01T00:00:00Z', sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 6 }, edges: { parentOf: 6 },
  sourceTreeHash: 'sha256:fixture', coverageComputedAt: '2026-06-01T00:00:00.000Z',
  coverage: completeCoverage(REQUIRED),
};

const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject', apiName: 'User', label: null, parentId: null, sourcePath: 'x.xml',
  lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const makeEdge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

const USER = 'CustomObject:User';
const fld = (name: string, props: Record<string, unknown>): Node =>
  makeNode({ id: `CustomField:User.${name}`, type: 'CustomField', apiName: name, parentId: USER, properties: props });

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: USER, apiName: 'User' }),
    fld('Username', { dataType: 'Text' }),                                  // idLookup -> critical
    fld('Member_ID__c', { dataType: 'Text', externalId: true }),          // ext-id -> high
    fld('Code__c', { dataType: 'Text', unique: true }),                    // unique -> medium
    fld('Alias', { dataType: 'Text' }),                                    // catalog low -> candidate via catalog
    fld('Doubled__c', { dataType: 'Number', formula: 'X * 2' }),           // derived -> NOT candidate
    fld('Notes__c', { dataType: 'LongTextArea' }),                         // plain low -> NOT candidate
  ],
  edges: [
    makeEdge({ fromId: USER, toId: 'CustomField:User.Username', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Member_ID__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Code__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Alias', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Doubled__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Notes__c', edgeType: 'parentOf' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-vca-'));
  const opened = await openGraph(join(tempDir, 'vca.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('valueChangeAuditHandler', () => {
  it('auto-detects value-sensitive fields, excluding derived and plain fields', async () => {
    const r = await valueChangeAuditHandler(ctx, { object: 'User' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.autoDetected).toBe(true);
    expect(d.scannedFieldCount).toBe(6);
    const fields = d.rows.map((x) => x.field).sort();
    expect(fields).toEqual(['Alias', 'Code__c', 'Member_ID__c', 'Username']);
    expect(fields).not.toContain('Doubled__c');
    expect(fields).not.toContain('Notes__c');
  });

  it('ranks critical first and counts the summary', async () => {
    const r = await valueChangeAuditHandler(ctx, { object: 'User' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rows[0]!.field).toBe('Username');
    expect(r.value.data.rows[0]!.overallSeverity).toBe('critical');
    expect(r.value.data.summary.critical).toBe(1);
    expect(r.value.data.summary.high).toBe(1);
  });

  it('audits an explicit field list and reports unknowns in notFound', async () => {
    const r = await valueChangeAuditHandler(ctx, { object: 'User', fields: ['Username', 'Nonexistent__c'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.autoDetected).toBe(false);
    expect(r.value.data.rows.map((x) => x.field)).toEqual(['Username']);
    expect(r.value.data.notFound).toEqual(['Nonexistent__c']);
  });

  it('inlines buckets only in detail verbosity', async () => {
    const summary = await valueChangeAuditHandler(ctx, { object: 'User', fields: ['Member_ID__c'] });
    const detail = await valueChangeAuditHandler(ctx, { object: 'User', fields: ['Member_ID__c'], verbosity: 'detail' });
    expect(summary.ok && detail.ok).toBe(true);
    if (!summary.ok || !detail.ok) return;
    expect(summary.value.data.rows[0]!.buckets).toBeUndefined();
    expect(detail.value.data.rows[0]!.buckets).toBeDefined();
  });

  // ---- CR-22 cursor ----------------------------------------------------

  it('whole-fits call omits nextCursor/pageInfo (golden-identical)', async () => {
    const r = await valueChangeAuditHandler(ctx, { object: 'User' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('nextCursor' in r.value.data).toBe(false);
    expect('pageInfo' in r.value.data).toBe(false);
    expect(r.value.data.truncated).toBe(false);
  });

  it('limit=N truncates to N + emits nextCursor; summary stays full', async () => {
    const r = await valueChangeAuditHandler(ctx, { object: 'User', limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rows.length).toBe(2);
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.nextCursor).toBeDefined();
    expect(r.value.data.pageInfo?.totalCount).toBe(4);
    // summary is over ALL rows, not the page.
    expect(r.value.data.summary.critical).toBe(1);
    expect(r.value.data.summary.high).toBe(1);
  });

  it('resume with returned cursor yields the next rows with no dup/skip', async () => {
    const page1 = await valueChangeAuditHandler(ctx, { object: 'User', limit: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    const cursor = page1.value.data.nextCursor;
    expect(cursor).toBeDefined();
    const page2 = await valueChangeAuditHandler(ctx, { object: 'User', limit: 2, cursor });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    const all = [...page1.value.data.rows, ...page2.value.data.rows].map((x) => x.field).sort();
    expect(all).toEqual(['Alias', 'Code__c', 'Member_ID__c', 'Username']);
    expect(page2.value.data.pageInfo?.hasMore ?? false).toBe(false);
  });

  it('rejects a cursor minted for a different object/fields/verbosity', async () => {
    const page1 = await valueChangeAuditHandler(ctx, { object: 'User', limit: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    const cursor = page1.value.data.nextCursor!;
    // Different verbosity → different fingerprint → stale.
    const stale = await valueChangeAuditHandler(ctx, { object: 'User', limit: 2, cursor, verbosity: 'detail' });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('invalid-query');
  });

  // VALUE-CHANGE-AUDIT-REJECTS-NATURAL-FIELD-ARGS: accept a `fieldId`
  // (CustomField:Object.Field → object+field) and the objectApiName/fieldApiName
  // aliases instead of hard-failing on `object Required`.
  describe('natural field/object selectors', () => {
    it('fieldId (CustomField:Object.Field) resolves object+field to the SAME result as {object, fields}', async () => {
      const canonical = await valueChangeAuditHandler(ctx, { object: 'User', fields: ['Username'] });
      const viaFieldId = await valueChangeAuditHandler(ctx, { fieldId: 'CustomField:User.Username' });
      expect(canonical.ok && viaFieldId.ok).toBe(true);
      if (!canonical.ok || !viaFieldId.ok) return;
      expect(viaFieldId.value.data).toEqual(canonical.value.data);
    });

    it('objectApiName + fieldApiName resolve to the SAME result as {object, fields}', async () => {
      const canonical = await valueChangeAuditHandler(ctx, { object: 'User', fields: ['Username'] });
      const viaAliases = await valueChangeAuditHandler(ctx, { objectApiName: 'User', fieldApiName: 'Username' });
      expect(canonical.ok && viaAliases.ok).toBe(true);
      if (!canonical.ok || !viaAliases.ok) return;
      expect(viaAliases.value.data).toEqual(canonical.value.data);
    });

    it('objectApiName alone auto-detects, byte-identical to {object}', async () => {
      const canonical = await valueChangeAuditHandler(ctx, { object: 'User' });
      const viaAlias = await valueChangeAuditHandler(ctx, { objectApiName: 'User' });
      expect(canonical.ok && viaAlias.ok).toBe(true);
      if (!canonical.ok || !viaAlias.ok) return;
      expect(viaAlias.value.data).toEqual(canonical.value.data);
    });

    it('naming no object returns a named invalid-query (never a silent/empty answer)', async () => {
      const r = await valueChangeAuditHandler(ctx, { fieldApiName: 'Username' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('invalid-query');
    });

    it('a fieldId whose parent disagrees with an explicit object is a named invalid-query (never a silent mismatch)', async () => {
      const r = await valueChangeAuditHandler(ctx, { object: 'Account', fieldId: 'CustomField:User.Username' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('invalid-query');
    });

    it('the canonical {object, fields} call output is unchanged (byte-identical)', async () => {
      const r = await valueChangeAuditHandler(ctx, { object: 'User', fields: ['Username'] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.object).toBe('User');
      expect(r.value.data.autoDetected).toBe(false);
      expect(r.value.data.rows.map((x) => x.field)).toEqual(['Username']);
    });
  });
});
