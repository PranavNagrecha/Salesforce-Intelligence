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
import { VALUE_LITERAL_READER_COVERAGE } from '../../src/tools/coverage-trust.js';
import { valueChangeAuditHandler } from '../../src/tools/value-change-audit.js';
import { whatIfRemovePicklistValueHandler } from '../../src/tools/what-if-remove-picklist-value.js';

// FIX 9: ONE shared family list (`VALUE_LITERAL_READER_COVERAGE`) for every
// value-literal reader. `value_change_audit` and `what_if_remove_picklist_value`
// answered the same coverage question with two hand-copied lists that
// disagreed; this is their union.
// FIX-3 (coverage-spine): imported directly (not hand-copied) so this fixture
// can never silently drift from the real list again — the earlier hand-copy
// is exactly how a fabricated `ConditionalContext` coverage row (a row NO
// real vault ever has — see coverage-trust.ts) went undetected here.
const REQUIRED: readonly string[] = VALUE_LITERAL_READER_COVERAGE;
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
    // FIX 9 cross-tool guard: a real picklist so the SAME manifest can be put
    // through `what_if_remove_picklist_value` and compared set-for-set.
    fld('Stage__c', { dataType: 'Picklist', picklistValues: ['Open', 'Closed'] }),
  ],
  edges: [
    makeEdge({ fromId: USER, toId: 'CustomField:User.Username', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Member_ID__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Code__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Alias', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Doubled__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Notes__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: USER, toId: 'CustomField:User.Stage__c', edgeType: 'parentOf' }),
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
    // 7 fields scanned since the FIX 9 cross-tool guard added `Stage__c`.
    expect(d.scannedFieldCount).toBe(7);
    const fields = d.rows.map((x) => x.field).sort();
    expect(fields).toEqual(['Alias', 'Code__c', 'Member_ID__c', 'Username']);
    expect(fields).not.toContain('Doubled__c');
    expect(fields).not.toContain('Notes__c');
    expect(fields).not.toContain('Stage__c');
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

/**
 * FIX 9 — `value_change_audit` stopped reporting `complete` while its own prose
 * named uncovered families.
 *
 * Its private `VALUE_CHANGE_REQUIRED_COVERAGE` named nine families;
 * `what_if_remove_picklist_value`'s private `PICKLIST_VALUE_COVERAGE` named a
 * different ten. Same question, same field, two answers. Both now read the one
 * shared `VALUE_LITERAL_READER_COVERAGE` through the one shared
 * `buildCoverageCaveat`.
 */
describe('valueChangeAuditHandler — shared value-literal coverage (FIX 9)', () => {
  const gapManifest = (): VaultManifest =>
    ({
      ...FIXTURE_MANIFEST,
      coverage: REQUIRED.map((type) =>
        type === 'ListView' || type === 'Report'
          ? { type, requested: true, retrieved: 0, errored: false, neverModeled: false }
          : { type, requested: true, retrieved: 1, errored: false, neverModeled: false },
      ),
    }) as VaultManifest;

  it('reports partial and names the uncovered families', async () => {
    const gapCtx: Context = { ...ctx, manifest: gapManifest() };
    const r = await valueChangeAuditHandler(gapCtx, { object: 'User' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Pre-fix: `complete`, no caveat — ListView/Report were not in the list.
    expect(r.value.data.trust.completeness.status).toBe('partial');
    const caveat = r.value.data.coverageCaveat;
    expect(caveat).toBeDefined();
    expect(caveat?.missingCoverage).toContain('ListView');
    expect(caveat?.missingCoverage).toContain('Report');
    expect(caveat?.message).toBe(
      `Value-change audit completeness cannot be confirmed because the vault has incomplete coverage for: ${caveat?.missingCoverage.join(
        ', ',
      )}. Treat absence of dependencies in those families as "not checked", not "none".`,
    );
  });

  it('keeps `complete` reachable on a fully covered vault', async () => {
    const r = await valueChangeAuditHandler(ctx, { object: 'User' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.trust.completeness.status).toBe('complete');
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('names the SAME missing families as what_if_remove_picklist_value', async () => {
    // The finding's actual complaint: two tools, one question, two answers.
    // This is the regression that stops the lists drifting apart again.
    const gapCtx: Context = { ...ctx, manifest: gapManifest() };
    const audit = await valueChangeAuditHandler(gapCtx, { object: 'User' });
    const picklist = await whatIfRemovePicklistValueHandler(gapCtx, {
      fieldId: 'CustomField:User.Stage__c',
      value: 'Open',
    });
    expect(audit.ok).toBe(true);
    expect(picklist.ok).toBe(true);
    if (!audit.ok || !picklist.ok) return;
    expect(new Set(picklist.value.data.coverageCaveat?.missingCoverage)).toEqual(
      new Set(audit.value.data.coverageCaveat?.missingCoverage),
    );
  });
});

// =============================================================================
// VALUE-CHANGE-AUDIT-ANSWERS-FOR-AN-OBJECT-IT-NEVER-FOUND (0.3.3).
//
// The object was resolved by the SYNC `resolveObjectAlias`, which canonicalises
// the name but never asks the vault whether that object exists. Ask about
// `Zzz_Nonexistent_Object_9x7__c` and `listObjectFields` returned nothing, so
// the tool answered `ok` with `scannedFieldCount: 0`, `rows: []` and an
// all-zero `summary` — indistinguishable from "no field on this object is
// value-sensitive", i.e. "changing these values breaks nothing". The unchecked
// zero the 0.3.2 changelog named for `unused_fields_deep`, on a "what will
// break" tool.
// =============================================================================
describe('valueChangeAuditHandler — unresolvable object scope', () => {
  const PHANTOM = 'Zzz_Nonexistent_Object_9x7__c';

  it('refuses an object that exists nowhere in the vault, never reports an empty audit', async () => {
    const r = await valueChangeAuditHandler(ctx, { object: PHANTOM });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain(PHANTOM);
  });

  it('refuses the phantom named through objectApiName and through a fieldId parent', async () => {
    for (const args of [
      { objectApiName: PHANTOM },
      { fieldId: `CustomField:${PHANTOM}.Key__c` },
    ]) {
      const r = await valueChangeAuditHandler(ctx, args);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('invalid-query');
    }
  });

  it('a REAL object in the wrong case still answers, echoed in the vault casing', async () => {
    const lower = await valueChangeAuditHandler(ctx, { object: 'user' });
    const exact = await valueChangeAuditHandler(ctx, { object: 'User' });
    expect(lower.ok && exact.ok).toBe(true);
    if (!lower.ok || !exact.ok) return;
    expect(lower.value.data.object).toBe('User');
    expect(lower.value.data.scannedFieldCount).toBe(exact.value.data.scannedFieldCount);
    expect(lower.value.data.rows.map((r) => r.field)).toEqual(
      exact.value.data.rows.map((r) => r.field),
    );
  });

  it('refuses the phantom even when explicit `fields` are named (no all-zero summary + notFound)', async () => {
    const r = await valueChangeAuditHandler(ctx, {
      object: PHANTOM,
      fields: ['Key__c', 'Username'],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain(PHANTOM);
  });

  it('a wrong-case object builds its `CustomField:` ids in the VAULT casing, not the caller\'s', async () => {
    const r = await valueChangeAuditHandler(ctx, { object: 'user', fields: ['Username'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The pre-fix build made `CustomField:user.Username`, which no node carries,
    // so a real field landed in `notFound` — a "this field does not exist"
    // answer about a field that does.
    expect(r.value.data.notFound).toBeUndefined();
    expect(r.value.data.rows.map((x) => x.fieldId)).toEqual(['CustomField:User.Username']);
  });

  it('REGRESSION: the canonical `{object: "User"}` call is untouched by the existence gate', async () => {
    const r = await valueChangeAuditHandler(ctx, { object: 'User' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.object).toBe('User');
    expect(r.value.data.autoDetected).toBe(true);
    expect(r.value.data.scannedFieldCount).toBe(7);
    expect(r.value.data.rows.map((x) => x.field).sort()).toEqual([
      'Alias',
      'Code__c',
      'Member_ID__c',
      'Username',
    ]);
  });
});
