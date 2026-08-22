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
  explainFormulaHandler,
  explainFormulaInputSchema,
} from '../../src/tools/explain-formula.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

// FIX 3 / FIX 13: the handler now ASKS the graph rather than guessing, so the
// fixture must hold the field nodes the formulas reference. A single-segment
// reference whose node is absent is reported `not-in-vault` instead of getting
// a minted id — which is the whole point — so a positive control needs a real
// node behind it.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-explain-formula-'));
  const dbPath = join(tempDir, 'explain-formula.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const seeded = await importExtractionResults(store, [
    {
      nodes: [
        makeFieldNode({ id: 'CustomField:Account.Industry__c' }),
        makeFieldNode({ id: 'CustomField:Account.Status__c' }),
        makeFieldNode({ id: 'CustomField:Opportunity.Discount__c' }),
        makeFieldNode({ id: 'CustomField:Lead.Discount__c' }),
        makeFieldNode({ id: 'CustomField:User.Email' }),
        makeFieldNode({
          id: 'CustomField:Contact.Advisor_Email__c',
          properties: { formula: 'Advisor__r.Email', dataType: 'Text' },
        }),
        makeFieldNode({
          id: 'CustomField:Contact.Stale_Advisor_Email__c',
          properties: { formula: 'Advisor__r.Email', dataType: 'Text' },
        }),
        makeFieldNode({
          id: 'CustomField:Account.Ghost_Holder__c',
          properties: { formula: 'Ghost__c', dataType: 'Text' },
        }),
      ],
      edges: [
        // The refresh's relationship-resolver output. `traversalPath` is
        // byte-identical to the tokenizer's `ref.path` — that exact match is
        // what makes the join deterministic instead of heuristic.
        {
          fromId: 'CustomField:Contact.Advisor_Email__c',
          toId: 'CustomField:User.Email',
          edgeType: 'references',
          confidence: 'parsed',
          source: 'relationship-resolver',
          properties: {
            referenceKind: 'formulaRelationshipTraversal',
            traversalPath: 'Advisor__r.Email',
          },
        },
      ],
    },
  ]);
  if (!seeded.ok) {
    throw new Error(`seed import failed: ${seeded.error.message}`);
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

describe('explainFormulaHandler', () => {
  it('surfaces functions with signatures, fields, literals, and depth for a conditional formula', async () => {
    const result = await explainFormulaHandler(ctx, {
      // Salesforce formulas use single-quoted strings (the tokenizer's
      // COMMENT_OR_STRING regex matches `'…'`); double-quoted text is
      // parsed as identifier-path candidates.
      formulaExpression: "IF(ISBLANK(Industry__c), 'Unknown', Industry__c)",
      parentObjectApiName: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Functions: IF + ISBLANK. Both get signatures from the curated
    // lookup.
    const functionNames = data.functions.map((f) => f.name).sort();
    expect(functionNames).toEqual(['IF', 'ISBLANK']);
    // Each signature is non-empty (the renderer renders verbatim).
    for (const fn of data.functions) {
      expect(fn.signature.length).toBeGreaterThan(0);
    }
    // Field references: just `Industry__c` (deduplicated even though
    // it appears twice in the expression).
    expect(data.fieldReferences.length).toBe(1);
    expect(data.fieldReferences[0]?.path).toBe('Industry__c');
    // With parentObjectApiName: 'Account', single-segment refs
    // resolve to the canonical id.
    expect(data.fieldReferences[0]?.toId).toBe(
      'CustomField:Account.Industry__c',
    );
    // Literals: one string literal (`"Unknown"`).
    const stringLiterals = data.literals.filter((l) => l.type === 'string');
    expect(stringLiterals.length).toBe(1);
    // Conditional logic: IF + ISBLANK is conditional (IF is in the
    // set; ISBLANK isn't but IF alone trips the signal).
    expect(data.hasConditionalLogic).toBe(true);
    // Nesting depth: IF( ISBLANK( … ), …, … ) → max depth 2.
    expect(data.nestingDepth).toBe(2);
    // No parseError on a successful tokenize.
    expect(data.parseError).toBeUndefined();
    expect(data.disclosure).toBe('Structured narrative; Claude composes prose');
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('leaves toId null for single-segment refs when parentObjectApiName is absent', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: "IF(ISBLANK(Industry__c), 'Unknown', Industry__c)",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refs = result.value.data.fieldReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.path).toBe('Industry__c');
    // No parent context → toId is null.
    expect(refs[0]?.toId).toBeNull();
  });

  it('treats a dotted standard-relationship path as a relationship traversal (no minted id)', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'Owner.Account.Name',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refs = result.value.data.fieldReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.path).toBe('Owner.Account.Name');
    // `Owner` is a relationship name (→ User), not an object API name; minting
    // `CustomField:Owner.Account.Name` (a three-segment, never-resolving id)
    // was the bug. A cross-object traversal surfaces with toId: null and
    // kind: 'relationship', matching the __r case.
    expect(refs[0]?.toId).toBeNull();
    expect(refs[0]?.kind).toBe('relationship');
  });

  it('does NOT mint a CustomField id for a __r relationship-traversal path', async () => {
    // `Widget_Contact__r` is a RELATIONSHIP name, not an object API
    // name. The old code minted `CustomField:Widget_Contact__r.Widget_ID__c`,
    // an id that never resolves. The fix keeps the raw path with
    // toId: null and tags it kind: 'relationship'.
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'Widget_Contact__r.Widget_ID__c',
      parentObjectApiName: 'Course__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refs = result.value.data.fieldReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.path).toBe('Widget_Contact__r.Widget_ID__c');
    expect(refs[0]?.toId).toBeNull();
    expect(refs[0]?.kind).toBe('relationship');
  });

  it('does NOT mint a CustomField id for a standard relationship traversal (CreatedBy/Manager)', async () => {
    // A non-`__r` dotted path is ALSO a cross-object relationship traversal:
    // the leading segment is a relationship name that differs from the target
    // object (CreatedBy / Manager → User), and a multi-hop path cannot form a
    // valid two-segment CustomField id. Real acme formulas use exactly
    // this shape (`CreatedBy.Manager.LastName`, `CreatedBy.UserRole.Name`). It
    // must follow the same honest handling as the __r case — toId: null,
    // kind: 'relationship' — not a dangling `CustomField:CreatedBy.Manager.LastName`.
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'CreatedBy.Manager.LastName',
      parentObjectApiName: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refs = result.value.data.fieldReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.path).toBe('CreatedBy.Manager.LastName');
    expect(refs[0]?.toId).toBeNull();
    expect(refs[0]?.kind).toBe('relationship');
  });

  it('surfaces $User globals in the globalReferences category instead of dropping them', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: "IF($User.IsActive, Status__c, 'Inactive')",
      parentObjectApiName: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // $User.IsActive is a global, NOT a field reference.
    const fieldPaths = data.fieldReferences.map((r) => r.path);
    expect(fieldPaths).not.toContain('$User.IsActive');
    // It surfaces on the dedicated global axis with category 'global'.
    expect(data.globalReferences).toEqual([
      { path: '$User.IsActive', category: 'global' },
    ]);
    // The real field reference still resolves with parent scope.
    const status = data.fieldReferences.find((r) => r.path === 'Status__c');
    expect(status?.toId).toBe('CustomField:Account.Status__c');
  });

  it('marks a simple non-conditional formula as hasConditionalLogic: false', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'AnnualRevenue + 1000',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // No function calls → empty functions array.
    expect(data.functions).toEqual([]);
    expect(data.hasConditionalLogic).toBe(false);
    // No parens → 0 nesting depth.
    expect(data.nestingDepth).toBe(0);
    // One numeric literal (`1000`).
    const numericLiterals = data.literals.filter((l) => l.type === 'number');
    expect(numericLiterals.length).toBe(1);
  });

  it('counts deeply nested parens correctly', async () => {
    // 4 nested parens; the inner-most CASE counts as depth 4.
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'IF(AND(OR(NOT(IsActive), IsBlocked), HasNotes), 1, 0)',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.nestingDepth).toBe(4);
    // hasConditionalLogic fires for IF, AND, OR, NOT.
    expect(result.value.data.hasConditionalLogic).toBe(true);
  });

  it('does not let a double-quoted string literal leak field refs or inflate nesting depth', async () => {
    // A real (double-quoted) Salesforce text literal whose contents include
    // words and a paren. The words must NOT surface as field references, and
    // the `(` inside the string must NOT inflate nestingDepth.
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'IF(Balance__c > 0, "Owed (USD)", "Paid")',
      parentObjectApiName: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    const fieldPaths = data.fieldReferences.map((r) => r.path);
    // Only the real field — NOT "Owed", "USD", or "Paid".
    expect(fieldPaths).toEqual(['Balance__c']);
    // The `(` lives inside a string literal, so depth is 1 (the IF call),
    // not 2 — proving strings are stripped before the paren walk.
    expect(data.nestingDepth).toBe(1);
    // Both text literals were counted as string literals.
    const stringLiterals = data.literals.filter((l) => l.type === 'string');
    expect(stringLiterals.length).toBe(2);
  });

  it('surfaces parseError for an invalid formula but keeps partial structure', async () => {
    // Unbalanced paren — the tokenizer fails fast. The handler still
    // returns ok() with parseError set and partial structure (empty
    // functions, empty refs, empty literals).
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: "IF(ISBLANK(Industry__c, 'Unknown', Industry__c)",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.parseError).toBeDefined();
    expect(data.functions).toEqual([]);
    expect(data.fieldReferences).toEqual([]);
    expect(data.literals).toEqual([]);
    expect(data.hasConditionalLogic).toBe(false);
    // The nesting-depth counter runs independently — for this
    // unbalanced expression, two open parens never close, so the
    // counter sees a depth of 2 before EOF.
    expect(data.nestingDepth).toBe(2);
  });

  it('surfaces parseError for an unterminated string literal', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: "TEXT('Unclosed",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.parseError).toContain('unterminated');
  });

  it('preserves the verbatim expression in the output', async () => {
    const expression = "CONTAINS(Description__c, 'important')";
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: expression,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.expression).toBe(expression);
  });

  it('handles a formula with only literals (no functions, no fields)', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: '1 + 2 + 3',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.functions).toEqual([]);
    expect(data.fieldReferences).toEqual([]);
    const numericLiterals = data.literals.filter((l) => l.type === 'number');
    expect(numericLiterals.length).toBe(3);
  });
});

describe('explainFormulaInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = explainFormulaInputSchema.safeParse({
      formulaExpression: 'TRUE',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional parentObjectApiName', () => {
    const parsed = explainFormulaInputSchema.safeParse({
      formulaExpression: 'Industry__c',
      parentObjectApiName: 'Account',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty formulaExpression string', () => {
    const parsed = explainFormulaInputSchema.safeParse({
      formulaExpression: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a missing formulaExpression when fieldId is present', () => {
    // Both formulaExpression and fieldId are optional at the schema level;
    // the handler enforces the at-least-one-required constraint at runtime.
    const parsed = explainFormulaInputSchema.safeParse({
      fieldId: 'CustomField:Account.AnnualRevenue__c',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty object (schema is permissive; handler rejects at runtime)', () => {
    // The schema allows both to be absent; the handler returns invalid-query.
    const parsed = explainFormulaInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('accepts fieldId as the sole required input', () => {
    const parsed = explainFormulaInputSchema.safeParse({
      fieldId: 'CustomField:Opportunity.Discount__c',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty fieldId string', () => {
    const parsed = explainFormulaInputSchema.safeParse({
      fieldId: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty parentObjectApiName string', () => {
    const parsed = explainFormulaInputSchema.safeParse({
      formulaExpression: 'TRUE',
      parentObjectApiName: '',
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fieldId path — FLD-03
// ---------------------------------------------------------------------------

/** Build a minimal Node for seeding in fieldId-path tests. */
const makeFieldNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: overrides.id.slice(overrides.id.lastIndexOf('.') + 1),
  label: null,
  parentId: null,
  sourcePath: 'source/x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

describe('explainFormulaHandler — fieldId path (FLD-03)', () => {
  it('resolves a formula expression from a vault field node and runs analysis', async () => {
    // Seed a CustomField with a formula property into the graph.
    const formulaFieldId = 'CustomField:Opportunity.DiscountLabel__c';
    const formulaText = "IF(Discount__c > 0, TEXT(Discount__c) & '%', 'None')";
    const seed: ExtractionResult = {
      nodes: [
        makeFieldNode({
          id: formulaFieldId,
          properties: { formula: formulaText, dataType: 'Text' },
        }),
      ],
      edges: [],
    };
    const imp = await importExtractionResults(store, [seed]);
    if (!imp.ok) throw new Error(`importExtractionResults failed: ${imp.error.message}`);

    const result = await explainFormulaHandler(ctx, { fieldId: formulaFieldId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // The resolved expression is the vault field's formula text verbatim.
    expect(data.expression).toBe(formulaText);
    // IF is a conditional function — hasConditionalLogic must be true.
    expect(data.hasConditionalLogic).toBe(true);
    // Parent object (Opportunity) is inferred from the fieldId; single-segment
    // refs should resolve to CustomField:Opportunity.{ref}.
    const discountRef = data.fieldReferences.find((r) => r.path === 'Discount__c');
    expect(discountRef).toBeDefined();
    expect(discountRef?.toId).toBe('CustomField:Opportunity.Discount__c');
    // No parseError on a valid formula.
    expect(data.parseError).toBeUndefined();
    expect(data.disclosure).toBe('Structured narrative; Claude composes prose');
  });

  it('returns component-not-found when the fieldId is not in the vault', async () => {
    const result = await explainFormulaHandler(ctx, {
      fieldId: 'CustomField:Account.NonExistentFormula__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('returns component-not-found when the field has no formula property', async () => {
    // Seed a stored (non-formula) field.
    const storedFieldId = 'CustomField:Contact.StoredText__c';
    const seed: ExtractionResult = {
      nodes: [
        makeFieldNode({
          id: storedFieldId,
          properties: { dataType: 'Text' /* no formula */ },
        }),
      ],
      edges: [],
    };
    const imp = await importExtractionResults(store, [seed]);
    if (!imp.ok) throw new Error(`importExtractionResults failed: ${imp.error.message}`);

    const result = await explainFormulaHandler(ctx, { fieldId: storedFieldId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toMatch(/formula/i);
  });

  it('returns invalid-query when neither formulaExpression nor fieldId is supplied', async () => {
    const result = await explainFormulaHandler(ctx, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns invalid-query when fieldId does not start with CustomField:', async () => {
    const result = await explainFormulaHandler(ctx, {
      fieldId: 'CustomObject:Opportunity',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('explicit parentObjectApiName overrides the inferred parent from fieldId', async () => {
    // Use the previously seeded DiscountLabel__c field (formula = Discount__c ref)
    // but override parentObjectApiName to 'Lead'. Single-segment refs should
    // now resolve to CustomField:Lead.Discount__c instead of
    // CustomField:Opportunity.Discount__c.
    const formulaFieldId = 'CustomField:Opportunity.DiscountLabel__c';
    const result = await explainFormulaHandler(ctx, {
      fieldId: formulaFieldId,
      parentObjectApiName: 'Lead',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const discountRef = result.value.data.fieldReferences.find(
      (r) => r.path === 'Discount__c',
    );
    expect(discountRef?.toId).toBe('CustomField:Lead.Discount__c');
  });
});

/**
 * FIX 11 — `explain_formula` emits the literal values the tokenizer already
 * had. Three `{value: null}` rows told the reader there were three numeric
 * literals while refusing to say what any of them were.
 */
describe('explainFormulaHandler — literal values (FIX 11)', () => {
  it('emits numeric literal VALUES, not null placeholders', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'IF(Amount__c > 2000, 2000, 1)',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.literals).toEqual([
      { value: 2000, type: 'number' },
      { value: 2000, type: 'number' },
      { value: 1, type: 'number' },
    ]);
  });

  it('emits string literal text with quotes stripped', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: "TEXT(Status__c) = 'Completed'",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.data.literals.filter((l) => l.type === 'string'),
    ).toEqual([{ value: 'Completed', type: 'string' }]);
  });

  it("unescapes the doubled-quote form ('it''s' -> it's)", async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: "IF(TRUE, 'it''s', 'no')",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.data.literals
        .filter((l) => l.type === 'string')
        .map((l) => l.value),
    ).toEqual(["it's", 'no']);
  });
});

/**
 * FIX 3 + FIX 13 — the resolver ASKS the graph instead of guessing.
 *
 * Both defects were the same defect. A dotted path returned a bare
 * `toId: null` even when the refresh had already resolved the relationship
 * hop; a single segment minted `CustomField:{parent}.{path}` without ever
 * checking that node existed. Every `toId` now names a real node or is `null`
 * with a stated reason.
 */
describe('explainFormulaHandler — relationship + existence resolution (FIX 3/13)', () => {
  it('reads the resolved relationship edge instead of returning a bare null', async () => {
    const result = await explainFormulaHandler(ctx, {
      fieldId: 'CustomField:Contact.Advisor_Email__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ref = result.value.data.fieldReferences.find(
      (r) => r.path === 'Advisor__r.Email',
    );
    // Pre-fix: { toId: null, kind: 'relationship' } — the edge was ignored.
    expect(ref?.toId).toBe('CustomField:User.Email');
    expect(ref?.resolution).toBe('resolved');
    expect(ref?.confidence).toBe('parsed');
    expect(ref?.kind).toBe('relationship');
    expect(ref?.note).toBeUndefined();
  });

  it('reports relationship-unresolved on a STALE-shaped vault with no resolver edges', async () => {
    // The load-bearing case: a builder-0.1.11 vault emits ZERO
    // relationship-resolver edges. The fix must READ the map, never assume it
    // is populated — so an empty map has to degrade honestly.
    const result = await explainFormulaHandler(ctx, {
      fieldId: 'CustomField:Contact.Stale_Advisor_Email__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ref = result.value.data.fieldReferences.find(
      (r) => r.path === 'Advisor__r.Email',
    );
    expect(ref?.toId).toBeNull();
    expect(ref?.resolution).toBe('relationship-unresolved');
    expect(ref?.note).toBe(
      'This reference traverses the relationship `Advisor__r`. This vault holds no resolved target for it — the relationship-to-object mapping is produced by the refresh, and this vault\'s refresh did not produce one for this path. The field it lands on is NOT KNOWN; it is not "none".',
    );
  });

  it('never mints an id that names no node (FIX 13)', async () => {
    const result = await explainFormulaHandler(ctx, {
      fieldId: 'CustomField:Account.Ghost_Holder__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ref = result.value.data.fieldReferences.find(
      (r) => r.path === 'Ghost__c',
    );
    // Pre-fix: { toId: 'CustomField:Account.Ghost__c' } — an id naming nothing.
    expect(ref?.toId).toBeNull();
    expect(ref?.resolution).toBe('not-in-vault');
    expect(ref?.candidateId).toBe('CustomField:Account.Ghost__c');
    expect(ref?.note).toBe(
      '`CustomField:Account.Ghost__c` is the id this single-segment reference would resolve to, but no node with that id exists in this vault. The field may be a standard field the Metadata API does not emit separately, or it may not have been retrieved. This is NOT proof the field is absent from the org.',
    );
  });

  it('resolves a single segment whose node DOES exist', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'ISBLANK(Industry__c)',
      parentObjectApiName: 'Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ref = result.value.data.fieldReferences[0];
    expect(ref?.toId).toBe('CustomField:Account.Industry__c');
    expect(ref?.resolution).toBe('resolved');
    expect(ref?.confidence).toBe('declared');
  });

  it('reports no-parent-scope when nothing scopes a single segment', async () => {
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'ISBLANK(Industry__c)',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ref = result.value.data.fieldReferences[0];
    expect(ref?.toId).toBeNull();
    expect(ref?.resolution).toBe('no-parent-scope');
    expect(ref?.note).toBe(
      'No `parentObjectApiName` was supplied and no `fieldId` was passed, so this single-segment reference cannot be scoped to an object. Pass `fieldId` or `parentObjectApiName` for a canonical id.',
    );
  });
});
