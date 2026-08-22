/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
import {
  findFormulaReferencesHandler,
  findFormulaReferencesInputSchema,
} from '../../src/tools/find-formula-references.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 1,
    CustomField: 1,
    ValidationRule: 2,
  },
  edges: { parentOf: 1, references: 2 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: 'Account',
  parentId: null,
  sourcePath: 'objects/Account/Account.object-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>,
): Edge => ({
  edgeType: 'references',
  confidence: 'parsed',
  source: 'formula-tokenizer',
  properties: {},
  ...overrides,
});

// Scenario:
//   - Industry__c is the target field.
//   - Two validation rules reference it via formula-tokenizer references
//     edges (those are the rows the tool must return).
//   - Account is the parent (parentOf edge) — must NOT appear; parentOf
//     is a different edge type from references.
//   - DanglingVR is the source of a references edge to a node id that
//     does not exist in `nodes` — exercises the sparse-graph path that
//     resolveReferencer takes when getNodeById returns null.
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      apiName: 'Account',
      label: 'Account',
    }),
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Account.Age__c',
      type: 'CustomField',
      apiName: 'Age__c',
      label: 'Age',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Age__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:Account.UnreferencedField__c',
      type: 'CustomField',
      apiName: 'UnreferencedField__c',
      label: 'Unreferenced Field',
      parentId: 'CustomObject:Account',
      sourcePath:
        'objects/Account/fields/UnreferencedField__c.field-meta.xml',
    }),
    makeNode({
      id: 'ValidationRule:Account.AlphaVR',
      type: 'ValidationRule',
      apiName: 'AlphaVR',
      label: 'AlphaVR',
      parentId: 'CustomObject:Account',
      sourcePath:
        'objects/Account/validationRules/AlphaVR.validationRule-meta.xml',
    }),
    makeNode({
      id: 'ValidationRule:Account.BetaVR',
      type: 'ValidationRule',
      apiName: 'BetaVR',
      label: 'BetaVR',
      parentId: 'CustomObject:Account',
      sourcePath:
        'objects/Account/validationRules/BetaVR.validationRule-meta.xml',
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'extractor:custom-object',
      properties: {},
    }),
    makeEdge({
      fromId: 'ValidationRule:Account.AlphaVR',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
      properties: { tokenizedFromField: 'errorConditionFormula', formulaLength: 42 },
    }),
    makeEdge({
      fromId: 'ValidationRule:Account.AlphaVR',
      toId: 'CustomField:Account.Age__c',
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
      properties: {
        tokenizedFromField: 'errorConditionFormula',
        formulaLength: 12,
      },
    }),
    makeEdge({
      fromId: 'ValidationRule:Account.BetaVR',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
      properties: { tokenizedFromField: 'errorConditionFormula', formulaLength: 64 },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-find-formula-references-'));
  const dbPath = join(tempDir, 'find-formula-references.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('findFormulaReferencesHandler', () => {
  it('returns only the references edges, ignoring the parentOf edge', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Industry__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.referencers.length).toBe(2);
    const ids = result.value.data.referencers.map((r) => r.id);
    expect(ids).toContain('ValidationRule:Account.AlphaVR');
    expect(ids).toContain('ValidationRule:Account.BetaVR');
    // parentOf must not appear.
    expect(ids).not.toContain('CustomObject:Account');
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-27T14:33:08Z');
  });

  it('sorts referencers by id ascending', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Industry__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.referencers.map((r) => r.id);
    // 'AlphaVR' < 'BetaVR' lexicographically.
    expect(ids).toEqual([
      'ValidationRule:Account.AlphaVR',
      'ValidationRule:Account.BetaVR',
    ]);
  });

  it('surfaces the edge source and properties (not the node ones)', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Industry__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const alpha = result.value.data.referencers.find(
      (r) => r.id === 'ValidationRule:Account.AlphaVR',
    );
    expect(alpha).toBeDefined();
    if (alpha === undefined) return;
    expect(alpha.type).toBe('ValidationRule');
    expect(alpha.apiName).toBe('AlphaVR');
    expect(alpha.source).toBe('formula-tokenizer');
    // The edge's properties block flows through verbatim — the test
    // pins the exact keys the formula tokenizer ships.
    expect(alpha.properties).toEqual({
      tokenizedFromField: 'errorConditionFormula',
      formulaLength: 42,
    });
  });

  it('honors the limit parameter', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Industry__c',
      limit: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.referencers.length).toBe(1);
    // Limit is applied AFTER sorting; the smallest id survives.
    expect(result.value.data.referencers[0]!.id).toBe(
      'ValidationRule:Account.AlphaVR',
    );
  });

  // CR-13: truncation honesty. The same silent-slice dishonesty as
  // find_apex_usages — a paged list must disclose the TRUE total + a truncation
  // note + pagination cursors so the full set is reachable.
  it('discloses the true total, hasMore, and a truncation note when paged below the referencer count', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Industry__c',
      limit: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.referencers.length).toBe(1);
    expect(data.totalCount).toBe(2);
    expect(data.offset).toBe(0);
    expect(data.limit).toBe(1);
    expect(data.hasMore).toBe(true);
    expect(data.nextOffset).toBe(1);
    // The truncation note must be present and name the true total.
    expect(data.note).toBeDefined();
    expect(data.note).toContain('2');
  });

  it('pages the full referencer set and omits the note when exhausted (CR-13)', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Industry__c',
      offset: 1,
      limit: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // The second (and last) referencer.
    expect(data.referencers.map((r) => r.id)).toEqual([
      'ValidationRule:Account.BetaVR',
    ]);
    expect(data.totalCount).toBe(2);
    expect(data.offset).toBe(1);
    expect(data.hasMore).toBe(false);
    expect(data.nextOffset).toBe(null);
    // Byte-identical contained case: the `note` key is OMITTED, not undefined.
    expect('note' in data).toBe(false);
  });

  it('leaves the fully-contained case byte-identical: counts present, no note (CR-13 guard)', async () => {
    // Both referencers fit under the default limit → additive scalar fields
    // only, `note` omitted entirely.
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Industry__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.referencers.length).toBe(2);
    expect(data.totalCount).toBe(2);
    expect(data.offset).toBe(0);
    expect(data.hasMore).toBe(false);
    expect(data.nextOffset).toBe(null);
    expect('note' in data).toBe(false);
  });

  it('returns an empty list for a REAL field with no references', async () => {
    // `UnreferencedField__c` now EXISTS in the fixture. An empty referencer
    // list is reserved for exactly this case — a field the vault holds that
    // genuinely has no inbound `references` edge. An id naming no node is a
    // different answer (see the existence-gate suite below).
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.UnreferencedField__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.referencers.length).toBe(0);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });
});

// FIND-FORMULA-REFERENCES-REJECTS-COMPONENTID: a host forwarding sfi.resolve's
// CustomField id (as `componentId`, or a dotted `fieldApiName`) must reach the
// SAME referencer list as the canonical `fieldId`.
describe('findFormulaReferencesHandler — componentId / fieldApiName selectors', () => {
  const FIELD = 'CustomField:Account.Industry__c';

  it('resolves a componentId selector to the SAME result as the canonical fieldId', async () => {
    const canonical = await findFormulaReferencesHandler(ctx, { fieldId: FIELD });
    const viaComponentId = await findFormulaReferencesHandler(ctx, { componentId: FIELD });
    expect(canonical.ok).toBe(true);
    expect(viaComponentId.ok).toBe(true);
    if (!canonical.ok || !viaComponentId.ok) return;
    // Byte-identical payload whichever selector the host supplied.
    expect(viaComponentId.value.data).toEqual(canonical.value.data);
    expect(viaComponentId.value.data.referencers.length).toBe(2);
  });

  it('resolves a dotted fieldApiName selector to the same field', async () => {
    const canonical = await findFormulaReferencesHandler(ctx, { fieldId: FIELD });
    const viaApiName = await findFormulaReferencesHandler(ctx, {
      fieldApiName: 'Account.Industry__c',
    });
    expect(canonical.ok).toBe(true);
    expect(viaApiName.ok).toBe(true);
    if (!canonical.ok || !viaApiName.ok) return;
    expect(viaApiName.value.data).toEqual(canonical.value.data);
  });

  it('rejects a wrong-type componentId with invalid-query (never a silent empty list)', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      componentId: 'ApexClass:SomeClass',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('CustomField');
  });

  it('rejects disagreeing selectors with invalid-query', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: FIELD,
      componentId: 'CustomField:Account.Other__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('different targets');
  });

  it('rejects a call with no selector at all', async () => {
    const result = await findFormulaReferencesHandler(ctx, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('fieldId');
  });
});

describe('findFormulaReferencesHandler — CR-22 continuation cursor', () => {
  const FIELD = 'CustomField:Account.Industry__c';

  it('in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const result = await findFormulaReferencesHandler(ctx, { fieldId: FIELD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('nextCursor' in result.value.data).toBe(false);
    expect('pageInfo' in result.value.data).toBe(false);
  });

  it('emits a cursor on a truncated page and resumes; pages concat with no gaps/dupes', async () => {
    const first = await findFormulaReferencesHandler(ctx, { fieldId: FIELD, limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const d1 = first.value.data;
    expect(d1.referencers.map((r) => r.id)).toEqual(['ValidationRule:Account.AlphaVR']);
    expect(d1.hasMore).toBe(true);
    expect(typeof d1.nextCursor).toBe('string');
    expect(d1.pageInfo?.nextCursor).toBe(d1.nextCursor);

    const second = await findFormulaReferencesHandler(ctx, {
      fieldId: FIELD,
      limit: 1,
      cursor: d1.nextCursor as string,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const d2 = second.value.data;
    expect(d2.referencers.map((r) => r.id)).toEqual(['ValidationRule:Account.BetaVR']);
    expect(d2.hasMore).toBe(false);
    expect('nextCursor' in d2).toBe(false);

    const ids = [...d1.referencers, ...d2.referencers].map((r) => `${r.id}|${r.source}`);
    expect(new Set(ids).size).toBe(2);
  });

  it('rejects a cursor minted for a different fieldId', async () => {
    const first = await findFormulaReferencesHandler(ctx, { fieldId: FIELD, limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.UnreferencedField__c',
      limit: 1,
      cursor: first.value.data.nextCursor as string,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a malformed cursor', async () => {
    const replay = await findFormulaReferencesHandler(ctx, { fieldId: FIELD, cursor: 'xxx' });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.kind).toBe('invalid-query');
  });
});

describe('findFormulaReferencesInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = findFormulaReferencesInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts limit at the upper bound (500)', () => {
    const parsed = findFormulaReferencesInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      limit: 500,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects limit greater than 500', () => {
    const parsed = findFormulaReferencesInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      limit: 501,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects limit=0', () => {
    const parsed = findFormulaReferencesInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      limit: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const parsed = findFormulaReferencesInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      limit: 1.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty fieldId string', () => {
    const parsed = findFormulaReferencesInputSchema.safeParse({ fieldId: '' });
    expect(parsed.success).toBe(false);
  });

  it('accepts a non-negative offset (CR-13 pagination)', () => {
    const parsed = findFormulaReferencesInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      offset: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a negative offset', () => {
    const parsed = findFormulaReferencesInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry__c',
      offset: -1,
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * FIX 1 — the existence gate.
 *
 * Four distinct causes used to produce a byte-identical
 * `{ referencers: [], totalCount: 0 }`, and three of them were lies: a miscased
 * id, a nonexistent field, a node of the wrong type, and a real field that
 * genuinely has no formula references. Only the last one is an empty result.
 */
describe('findFormulaReferencesHandler — existence gate (FIX 1)', () => {
  it('refuses a MISCASED field id instead of answering a false zero', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:account.age__c',
    });
    // The reported input. Pre-fix this returned `{referencers: [], totalCount: 0}`
    // — indistinguishable from a real field with no formula references.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomField:account.age__c');
  });

  it('attaches typo-tolerant resolveSuggestions naming the canonical id', async () => {
    // NOTE on the object-name case: `buildFieldResolveSuggestions` scopes the
    // resolve to `CustomObject:{objectPart}` verbatim, so a miscased OBJECT
    // half scopes to a parent that does not exist and returns no candidates.
    // That is pre-existing shared-helper behaviour every field tool inherits,
    // not something this fix introduces — the refusal above is the fix.
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.age__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    const suggestions = (
      result.error as unknown as {
        readonly resolveSuggestions?: readonly {
          readonly componentId: string;
        }[];
      }
    ).resolveSuggestions;
    expect(suggestions?.[0]?.componentId).toBe('CustomField:Account.Age__c');
    expect(result.error.message).toContain(
      'Typo-tolerant resolve suggestions are attached in `resolveSuggestions`',
    );
  });

  it('refuses a field id that names no node', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Nonexistent__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('names a node that exists but is not a CustomField', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.AlphaVR',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('does NOT read a STANDARD field id as "does not exist"', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Name',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toContain(
      'is a standard-object field that may not be modeled in this vault',
    );
    expect(result.error.message).toContain(
      'This is NOT proof the field is absent from the org.',
    );
  });

  it('leaves the happy path byte-identical — 1 referencer, no coverageCaveat', async () => {
    const result = await findFormulaReferencesHandler(ctx, {
      fieldId: 'CustomField:Account.Age__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.totalCount).toBe(1);
    expect(result.value.data.referencers.map((r) => r.id)).toEqual([
      'ValidationRule:Account.AlphaVR',
    ]);
    expect(result.value.data.coverageCaveat).toBeUndefined();
  });
});

/**
 * FIX 1 (second half) — the empty-result caveat is REACHABLE.
 *
 * `FORMULA_REFERENCE_REQUIRED_COVERAGE` named two families when eleven produce
 * `references` edges into a CustomField, so the already-written disclosure at
 * the empty branch could effectively never fire. Widening the list to the
 * OBSERVED producer set is what makes it reachable.
 */
describe('findFormulaReferencesHandler — empty-result coverage caveat (FIX 1)', () => {
  it('names an uncovered PRODUCER family on a genuinely empty result', async () => {
    const gapCtx: Context = {
      ...ctx,
      manifest: {
        ...FIXTURE_MANIFEST,
        coverage: [
          { type: 'CustomField', requested: true, retrieved: 4, errored: false },
          {
            type: 'ValidationRule',
            requested: true,
            retrieved: 2,
            errored: false,
          },
          { type: 'ListView', requested: true, retrieved: 0, errored: false },
          { type: 'ReportType', requested: true, retrieved: 0, errored: false },
        ],
      } as unknown as typeof FIXTURE_MANIFEST,
    };
    const result = await findFormulaReferencesHandler(gapCtx, {
      fieldId: 'CustomField:Account.UnreferencedField__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.totalCount).toBe(0);
    const caveat = result.value.data.coverageCaveat;
    expect(caveat).toBeDefined();
    expect(caveat?.missingCoverage).toContain('ListView');
    expect(caveat?.missingCoverage).toContain('ReportType');
    expect(caveat?.message).toContain('This is an EMPTY result.');
    expect(caveat?.message).toContain(
      'Treat absence of dependencies in those families as "not checked", not "none".',
    );
  });
});
