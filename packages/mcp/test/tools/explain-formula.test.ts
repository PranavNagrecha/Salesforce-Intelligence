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

// The handler does no graph queries — a Context with an open graph
// store is still required for the McpResponse envelope's vaultState,
// but no seed is needed. We open an empty store and close it at
// teardown.
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
    // `Faculty_Contact__r` is a RELATIONSHIP name, not an object API
    // name. The old code minted `CustomField:Faculty_Contact__r.Faculty_ID__c`,
    // an id that never resolves. The fix keeps the raw path with
    // toId: null and tags it kind: 'relationship'.
    const result = await explainFormulaHandler(ctx, {
      formulaExpression: 'Faculty_Contact__r.Faculty_ID__c',
      parentObjectApiName: 'Course__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refs = result.value.data.fieldReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.path).toBe('Faculty_Contact__r.Faculty_ID__c');
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
