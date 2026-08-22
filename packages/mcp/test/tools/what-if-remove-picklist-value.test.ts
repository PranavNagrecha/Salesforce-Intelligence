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
import {
  whatIfRemovePicklistValueHandler,
  whatIfRemovePicklistValueInputSchema,
} from '../../src/tools/what-if-remove-picklist-value.js';

const completeCoverage = (types: readonly string[]): readonly CoverageEntry[] =>
  types.map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
  }));

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 2 },
  edges: { parentOf: 2, references: 2, firesWhen: 1 },
  sourceTreeHash: 'sha256:fixture',
  coverageComputedAt: '2026-05-29T12:00:00.000Z',
  // FIX 9: the shared `VALUE_LITERAL_READER_COVERAGE` list — this tool and
  // `value_change_audit` now name the SAME families for the same field.
  // FIX-3 (coverage-spine): imported directly (not hand-copied) so this
  // fixture can never silently drift from the real list again — the earlier
  // hand-copy is exactly how a fabricated `ConditionalContext` coverage row
  // (a row NO real vault ever has — see coverage-trust.ts) went undetected.
  coverage: completeCoverage([...VALUE_LITERAL_READER_COVERAGE]),
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

const ACCOUNT_OBJ = 'CustomObject:Account';
const PICK_FIELD = 'CustomField:Account.Industry';
const INACTIVE_PICK_FIELD = 'CustomField:Account.Legacy_Stage__c';
const UNRESOLVED_PICK_FIELD = 'CustomField:Account.Unresolved_Stage__c';
const TEXT_FIELD = 'CustomField:Account.NotPicklist';
const VR_ID = 'ValidationRule:Account.Tech_Special';
const VR_NO_MATCH_ID = 'ValidationRule:Account.OtherCheck';
const FLOW_ID = 'Flow:SetIndustry';
const FLOW_COND_ID =
  'ConditionalContext:Flow:SetIndustry.condition-0';
const APEX_ID = 'ApexClass:IndustryService';
const APEX_NO_MATCH_ID = 'ApexClass:UnrelatedService';
// R2-1: a flow that ASSIGNS the value as a literal (blocking) vs. one that
// assigns it via an elementReference (NON-match — not statically resolvable).
const FLOW_ASSIGN_LITERAL_ID = 'Flow:StampIndustryLiteral';
const FLOW_ASSIGN_REF_ID = 'Flow:StampIndustryRef';

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: ACCOUNT_OBJ, apiName: 'Account' }),
    makeNode({
      id: PICK_FIELD,
      type: 'CustomField',
      apiName: 'Industry',
      parentId: ACCOUNT_OBJ,
      // FIX 7: a real declared value set, so the tool can tell a typo from a
      // value that genuinely has no impacts.
      properties: {
        dataType: 'Picklist',
        picklistValues: ['Tech', 'Banking', 'Finance'],
      },
    }),
    // FIX 7: a value set whose only entry is DEACTIVATED.
    makeNode({
      id: INACTIVE_PICK_FIELD,
      type: 'CustomField',
      apiName: 'Legacy_Stage__c',
      parentId: ACCOUNT_OBJ,
      properties: {
        dataType: 'Picklist',
        picklistValues: [{ value: 'Legacy', isActive: false }],
      },
    }),
    // FIX 7: a picklist whose value set the vault could NOT resolve — no
    // inline values and no GlobalValueSet edge.
    makeNode({
      id: UNRESOLVED_PICK_FIELD,
      type: 'CustomField',
      apiName: 'Unresolved_Stage__c',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Picklist' },
    }),
    makeNode({
      id: TEXT_FIELD,
      type: 'CustomField',
      apiName: 'NotPicklist',
      parentId: ACCOUNT_OBJ,
      properties: { dataType: 'Text' },
    }),
    makeNode({
      id: VR_ID,
      type: 'ValidationRule',
      apiName: 'Account.Tech_Special',
      parentId: ACCOUNT_OBJ,
      properties: {
        // Formula references the value 'Tech' as a literal.
        errorConditionFormula: "ISPICKVAL(Industry, 'Tech')",
      },
    }),
    makeNode({
      id: VR_NO_MATCH_ID,
      type: 'ValidationRule',
      apiName: 'Account.OtherCheck',
      parentId: ACCOUNT_OBJ,
      properties: {
        errorConditionFormula: "ISPICKVAL(Industry, 'Finance')",
      },
    }),
    makeNode({
      id: FLOW_ID,
      type: 'Flow',
      apiName: 'SetIndustry',
    }),
    makeNode({
      id: FLOW_COND_ID,
      type: 'ConditionalContext',
      apiName: 'Flow:SetIndustry.condition-0',
      parentId: FLOW_ID,
      properties: {
        kind: 'flow-decision',
        expression: "Industry == 'Tech'",
        fieldRefs: [PICK_FIELD],
      },
    }),
    makeNode({
      id: APEX_ID,
      type: 'ApexClass',
      apiName: 'IndustryService',
      properties: {
        stringLiterals: ["'Tech'", "'Other'"],
      },
    }),
    makeNode({
      id: APEX_NO_MATCH_ID,
      type: 'ApexClass',
      apiName: 'UnrelatedService',
      properties: {
        stringLiterals: ["'Hello'"],
      },
    }),
    // Flow that assigns the field the literal 'Tech' — no condition text,
    // so it is invisible to the haystack scan; only the edge's
    // assignedValue surfaces it.
    makeNode({
      id: FLOW_ASSIGN_LITERAL_ID,
      type: 'Flow',
      apiName: 'StampIndustryLiteral',
    }),
    // Flow that assigns the field via an elementReference (a variable) —
    // must NOT match even though the reference name happens to resolve to
    // a $Record path that could contain 'Tech'.
    makeNode({
      id: FLOW_ASSIGN_REF_ID,
      type: 'Flow',
      apiName: 'StampIndustryRef',
    }),
  ],
  edges: [
    makeEdge({ fromId: ACCOUNT_OBJ, toId: PICK_FIELD, edgeType: 'parentOf' }),
    makeEdge({ fromId: ACCOUNT_OBJ, toId: TEXT_FIELD, edgeType: 'parentOf' }),
    // VR with the literal references the field.
    makeEdge({
      fromId: VR_ID,
      toId: PICK_FIELD,
      edgeType: 'references',
      source: 'validation-rule-extractor',
    }),
    // VR without the literal also references the field (no match).
    makeEdge({
      fromId: VR_NO_MATCH_ID,
      toId: PICK_FIELD,
      edgeType: 'references',
      source: 'validation-rule-extractor',
    }),
    // Flow + firesWhen routing through a ConditionalContext.
    makeEdge({
      fromId: FLOW_ID,
      toId: PICK_FIELD,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
      confidence: 'parsed',
    }),
    makeEdge({
      fromId: FLOW_ID,
      toId: FLOW_COND_ID,
      edgeType: 'firesWhen',
    }),
    // Apex class with the literal reads from the field.
    makeEdge({
      fromId: APEX_ID,
      toId: PICK_FIELD,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
      confidence: 'heuristic',
    }),
    // Apex class without the literal also reads from the field (no match).
    makeEdge({
      fromId: APEX_NO_MATCH_ID,
      toId: PICK_FIELD,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
      confidence: 'heuristic',
    }),
    // R2-1: flow writesTo edge assigning the literal 'Tech' — must match.
    makeEdge({
      fromId: FLOW_ASSIGN_LITERAL_ID,
      toId: PICK_FIELD,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      confidence: 'parsed',
      properties: {
        operation: 'recordUpdate',
        assignedValue: 'Tech',
        assignedValueKind: 'literal',
      },
    }),
    // R2-1: flow writesTo edge assigning the value via elementReference —
    // assignedValue text equals 'Tech' but kind is 'reference', so it must
    // NOT match (avoids false-positive on $Record/variable assignments).
    makeEdge({
      fromId: FLOW_ASSIGN_REF_ID,
      toId: PICK_FIELD,
      edgeType: 'writesTo',
      source: 'flow-extractor',
      confidence: 'parsed',
      properties: {
        operation: 'recordUpdate',
        assignedValue: 'Tech',
        assignedValueKind: 'reference',
      },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-wi-rpv-'));
  const dbPath = join(tempDir, 'wi-rpv.db');
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

describe('whatIfRemovePicklistValueHandler', () => {
  it('rejects a non-CustomField prefix with invalid-query', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: 'Flow:NotAField',
      value: 'Tech',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('fieldId');
  });

  it('returns component-not-found for an unknown CustomField id', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: 'CustomField:Account.DoesNotExist',
      value: 'Tech',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('rejects a non-Picklist field with invalid-query', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: TEXT_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('surfaces ValidationRule whose formula contains the literal value', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).toContain(VR_ID);
  });

  it('skips ValidationRule whose formula does NOT contain the value', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).not.toContain(VR_NO_MATCH_ID);
  });

  it('surfaces Flow whose firesWhen ConditionalContext references the value', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).toContain(FLOW_ID);
  });

  it('surfaces ApexClass with the literal in its stringLiterals AND a readsFrom edge', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).toContain(APEX_ID);
  });

  it('skips ApexClass whose stringLiterals do not contain the value', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).not.toContain(APEX_NO_MATCH_ID);
  });

  it('classifies categories correctly per source type', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(
      result.value.data.impacts.map((i) => [i.componentId, i]),
    );
    expect(byId.get(VR_ID)?.category).toBe('metadata-blocker');
    expect(byId.get(FLOW_ID)?.category).toBe('metadata-blocker');
    expect(byId.get(APEX_ID)?.category).toBe('code-needs-update');
  });

  it('aggregates verdict as blocking when a metadata-blocker is present', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
    expect(result.value.data.compatibility).toBe('breaking');
  });

  it('returns review/safe when a DECLARED value has no impacts', async () => {
    // `Banking` is declared on the field and appears in no component text —
    // the only case where an empty impact list is an honest answer.
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Banking',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.impacts.length).toBe(0);
    expect(result.value.data.compatibility).toBe('review');
    expect(result.value.data.verdict).toBe('safe');
    expect(result.value.data.valueState).toBe('active');
  });

  it('sorts impacts by componentId ASC for deterministic output', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('carries the verbatim boundary disclosure', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('Variable-based picklist comparisons');
    expect(result.value.data.disclosure).toContain('obj.get');
  });

  it('echoes fieldId and value in the response', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldId).toBe(PICK_FIELD);
    expect(result.value.data.value).toBe('Tech');
    expect(result.value.data.fieldType).toBe('Picklist');
  });

  // Regression lock: the extractor writes the field's data type under
  // `properties.dataType`, not `properties.type`. Reading the wrong key
  // resolved every field's type to '' / 'Unknown', so the picklist guard
  // rejected real picklists with a bogus "has type 'Unknown'" error. The
  // fixtures above seed `dataType`, matching real vault output.
  it('resolves the picklist type from properties.dataType (not "Unknown")', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    // A real Picklist must pass the guard, not be rejected as 'Unknown'.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.fieldType).toBe('Picklist');
  });

  it('surfaces a Flow that assigns the value as a LITERAL via its writesTo edge (R2-1)', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(
      result.value.data.impacts.map((i) => [i.componentId, i]),
    );
    expect(byId.has(FLOW_ASSIGN_LITERAL_ID)).toBe(true);
    // A Flow source classifies as a metadata-blocker, so the verdict is blocking.
    expect(byId.get(FLOW_ASSIGN_LITERAL_ID)?.category).toBe('metadata-blocker');
    expect(result.value.data.verdict).toBe('blocking');
  });

  it('does NOT match a Flow that assigns the value via an elementReference (R2-1 honesty)', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).not.toContain(FLOW_ASSIGN_REF_ID);
  });

  it('discloses that elementReference (variable/formula) flow assignments are not statically resolvable', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('elementReference');
    expect(result.value.data.disclosure).toContain('<stringValue>');
  });

  it('reports the real resolved type in the non-Picklist rejection message', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: TEXT_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    // The message must name the resolved type ('Text' from dataType),
    // not the pre-fix 'Unknown' that the wrong property key produced.
    expect(result.error.message).toContain("has type 'Text'");
  });
});

describe('whatIfRemovePicklistValueInputSchema', () => {
  it('accepts a well-formed input', () => {
    const parsed = whatIfRemovePicklistValueInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
      value: 'Tech',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty fieldId', () => {
    const parsed = whatIfRemovePicklistValueInputSchema.safeParse({
      fieldId: '',
      value: 'Tech',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty value', () => {
    const parsed = whatIfRemovePicklistValueInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
      value: '',
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * FIX 7 — check the value exists before rendering a destructive verdict.
 *
 * This is a `what_if_*` tool: a typo'd value used to return a `review` verdict
 * byte-identical to a real value's, and the caller's next action is a metadata
 * delete. Every other honesty rule in this product exists to prevent exactly
 * that.
 */
describe('whatIfRemovePicklistValueHandler — value existence gate (FIX 7)', () => {
  it('refuses a value the field does not declare', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tehc',
    });
    // Pre-fix: ok, `compatibility: 'review'`, `verdict: 'safe'` — identical to
    // a real value that happens to have no impacts.
    //
    // NOTE on the missing "Did you mean": the suggestion engine is the shared
    // `detectPicklistLiteralMismatch` / `suggestClosest`, which scores by
    // substring containment and token overlap. A TRANSPOSITION ('Tehc' vs
    // 'Tech') scores zero there, so no suggestion is offered. That is
    // pre-existing shared-helper behaviour, and writing a second matcher here
    // was explicitly out of scope — the refusal is the fix.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toBe(
      '`Tehc` is not a declared value on `CustomField:Account.Industry`. Declared values: Tech, Banking, Finance. Pass a declared value, or call `sfi.explain_field` on this field to list the value set. No impact scan was run.',
    );
  });

  it('offers the shared did-you-mean when the suggester can score the typo', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Techno',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Did you mean 'Tech'?");
    expect(result.error.message).toContain('No impact scan was run.');
  });

  it('still scans an INACTIVE value, and says the delete is not a deactivation', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: INACTIVE_PICK_FIELD,
      value: 'Legacy',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.valueState).toBe('inactive');
    expect(result.value.data.declaredValues).toEqual(['Legacy']);
    expect(result.value.data.boundaries).toContain(
      '`Legacy` is already INACTIVE on this field: it cannot be selected on new records, but existing records may still hold it. Removing it from the value set is a metadata delete, not a deactivation — the impact below is the impact of the DELETE.',
    );
    expect(result.value.data.verdict).toBeDefined();
  });

  it('never silently proceeds as though an unresolvable value set was checked', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: UNRESOLVED_PICK_FIELD,
      value: 'Anything',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.valueState).toBe('not-checked');
    expect(result.value.data.declaredValues).toBeNull();
    expect(result.value.data.boundaries).toContain(
      "This field's value set is not inline in the vault — commonly a GlobalValueSet reference this refresh did not resolve. Whether `Anything` is a declared value was NOT CHECKED, and the impact scan below assumes it exists. Confirm the value in Setup before acting.",
    );
  });

  it('leaves a real ACTIVE value byte-identical apart from the additive keys', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'Tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.valueState).toBe('active');
    expect(result.value.data.declaredValues).toEqual([
      'Tech',
      'Banking',
      'Finance',
    ]);
    expect(result.value.data.boundaries).toBeUndefined();
    expect(result.value.data.impacts.length).toBeGreaterThan(0);
  });

  it('matches case-insensitively but echoes the caller spelling verbatim', async () => {
    const result = await whatIfRemovePicklistValueHandler(ctx, {
      fieldId: PICK_FIELD,
      value: 'tech',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.valueState).toBe('active');
    expect(result.value.data.value).toBe('tech');
  });
});
