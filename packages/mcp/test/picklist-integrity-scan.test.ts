/// <reference types="vitest/globals" />

/**
 * Unit tests for `sfi.picklist_integrity_scan`: the PURE classifier
 * ({@link classifyPicklistLiterals}) + near-match helper, AND the vault-facing
 * REFERENCE-EXTRACTION layer ({@link extractCriteriaValues},
 * {@link extractQuotedFieldLiterals}, {@link referencesFromEdgeSource}).
 *
 * Every fixture is SYNTHETIC — hand-built normalized value sets, condition
 * mirrors, and edges; no vault, no DuckDB, no org identifiers (only Account /
 * Status__c and generic placeholder values).
 *
 * The extraction-layer suite exists because the prior build shipped a broken
 * extractor (0/19 precision on the real vault: booleans, field references,
 * formula-mirror garbage, un-split multi-value criteria, and free-text
 * assignments to unrestricted picklists were all mis-flagged). These tests pin
 * that each of those shapes yields NO orphaned finding, while a genuine typo
 * against a RESTRICTED picklist still IS flagged.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ComponentId,
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

import type { Context } from '../src/server.js';
import {
  classifyPicklistLiterals,
  closestDefinedValue,
  extractCriteriaValues,
  extractQuotedFieldLiterals,
  picklistIntegrityScanHandler,
  referencesFromEdgeSource,
  type PicklistLiteralReference,
} from '../src/tools/picklist-integrity-scan.js';
import type { NormalizedPicklistValue } from '../src/tools/picklist-values.js';

const value = (
  v: string,
  isActive: boolean,
  extra: Partial<NormalizedPicklistValue> = {},
): NormalizedPicklistValue => ({ value: v, isActive, ...extra });

/** A source literal reference against a placeholder component. */
const ref = (
  literal: string,
  overrides: Partial<PicklistLiteralReference> = {},
): PicklistLiteralReference => ({
  literal,
  source: 'apex',
  location: 'body',
  componentId: 'ApexClass:StatusService' as ComponentId,
  confidence: 'parsed',
  ...overrides,
});

// A field with three active values plus one deactivated value.
const DEFINED: readonly NormalizedPicklistValue[] = [
  value('Draft', true),
  value('Active', true),
  value('Closed', true),
  value('Legacy', false),
];

describe('classifyPicklistLiterals', () => {
  it('flags an orphaned literal HIGH with a sensible near-match', () => {
    // "Activ" is a typo of the active value "Active" — no defined value matches.
    const findings = classifyPicklistLiterals(DEFINED, [ref('Activ')]);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    if (finding === undefined) throw new Error('expected one finding');
    expect(finding.kind).toBe('orphaned');
    expect(finding.severity).toBe('high');
    expect(finding.nearMatch).toBe('Active');
    expect(finding.literal).toBe('Activ');
    expect(finding.references).toHaveLength(1);
    expect(finding.references[0]?.componentId).toBe('ApexClass:StatusService');
  });

  it('leaves near-match null for an orphan with no close defined value', () => {
    const findings = classifyPicklistLiterals(DEFINED, [ref('Zzzqqq')]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('orphaned');
    expect(findings[0]?.nearMatch).toBeNull();
  });

  it('flags an inactive-only literal MEDIUM with no near-match', () => {
    // "Legacy" is a DEFINED but deactivated value — referenced but not selectable.
    const findings = classifyPicklistLiterals(DEFINED, [ref('Legacy')]);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    if (finding === undefined) throw new Error('expected one finding');
    expect(finding.kind).toBe('inactive-only');
    expect(finding.severity).toBe('medium');
    expect(finding.nearMatch).toBeNull();
  });

  it('does NOT flag a literal that matches an active value (case-insensitive)', () => {
    const findings = classifyPicklistLiterals(DEFINED, [
      ref('Active'),
      ref('draft'), // different casing still matches the active "Draft"
    ]);
    expect(findings).toEqual([]);
  });

  it('handles a field with no references cleanly (zero findings)', () => {
    expect(classifyPicklistLiterals(DEFINED, [])).toEqual([]);
  });

  it('flags a field-level default pointing at an absent value', () => {
    const findings = classifyPicklistLiterals(DEFINED, [
      ref('Pending', {
        source: 'default',
        location: 'field default value',
        componentId: 'CustomField:Account.Status__c' as ComponentId,
        confidence: 'declared',
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('orphaned');
    expect(findings[0]?.references[0]?.source).toBe('default');
  });

  it('groups multiple citations of the same literal into one finding', () => {
    const findings = classifyPicklistLiterals(DEFINED, [
      ref('Withdrawn', { componentId: 'ApexClass:A' as ComponentId }),
      ref('Withdrawn', {
        source: 'validation-rule',
        location: 'errorConditionFormula',
        componentId: 'ValidationRule:Account.Check' as ComponentId,
        confidence: 'parsed',
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.references).toHaveLength(2);
  });

  it('deduplicates identical citations (same component/source/location)', () => {
    const dup = ref('Ghost');
    const findings = classifyPicklistLiterals(DEFINED, [dup, { ...dup }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.references).toHaveLength(1);
  });

  it('orders findings severity-first (orphaned before inactive-only)', () => {
    const findings = classifyPicklistLiterals(DEFINED, [
      ref('Legacy'), // inactive-only, MEDIUM
      ref('Bogus'), // orphaned, HIGH
    ]);
    expect(findings.map((f) => f.kind)).toEqual(['orphaned', 'inactive-only']);
  });
});

describe('closestDefinedValue', () => {
  it('returns the closest value when spelling is within threshold', () => {
    expect(closestDefinedValue('Widthdrawn', [value('Withdrawn', true)])).toBe(
      'Withdrawn',
    );
  });

  it('returns null when nothing is close enough', () => {
    expect(
      closestDefinedValue('Xyz', [value('Withdrawn', true), value('Draft', true)]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EXTRACTION-LAYER tests — the layer that shipped broken (0/19 on the vault).
// ---------------------------------------------------------------------------

describe('extractCriteriaValues (declarative criteria operand filtering)', () => {
  it('drops a BOOLEAN operand (IsNull false / IsChanged true)', () => {
    // `IsNull` / `IsChanged` take a boolean RHS — not a picklist value.
    expect(extractCriteriaValues('$Record.Status__c IsNull false', 'Status__c')).toEqual([]);
    expect(extractCriteriaValues('$Record.Status__c IsChanged true', 'Status__c')).toEqual([]);
  });

  it('drops a FIELD-REFERENCE / merge-field operand (field-to-field compare)', () => {
    // `$Record__Prior.X NotEqualTo $Record.X` is a before/after field compare.
    expect(
      extractCriteriaValues('$Record__Prior.Status__c NotEqualTo $Record.Status__c', 'Status__c'),
    ).toEqual([]);
    expect(
      extractCriteriaValues('$Record.Status__c EqualTo $Record.Other__c', 'Status__c'),
    ).toEqual([]);
    expect(
      extractCriteriaValues('$Record.Status__c EqualTo {!$Record.Other__c}', 'Status__c'),
    ).toEqual([]);
  });

  it('COMMA-SPLITS a multi-value criterion into each defined value', () => {
    expect(
      extractCriteriaValues('$Record.Status__c EqualTo Closed,Cancelled/Pass', 'Status__c'),
    ).toEqual(['Closed', 'Cancelled/Pass']);
  });

  it('keeps a genuine unquoted value, including spaces / slashes / hyphens', () => {
    expect(extractCriteriaValues('$Record.Status__c EqualTo Withdrawn', 'Status__c')).toEqual([
      'Withdrawn',
    ]);
    expect(extractCriteriaValues('$Record.StageName EqualTo 10 - Discovery', 'StageName')).toEqual([
      '10 - Discovery',
    ]);
    expect(extractCriteriaValues('$Record.Type EqualTo MOA/AA', 'Type')).toEqual(['MOA/AA']);
  });

  it('only reads the clause that references the target field', () => {
    const expr = '$Record.Type EqualTo CEP AND $Record.Status__c EqualTo Open';
    expect(extractCriteriaValues(expr, 'Status__c')).toEqual(['Open']);
    expect(extractCriteriaValues(expr, 'Type')).toEqual(['CEP']);
  });
});

/** Build a synthetic firer Node carrying a `properties.conditions` mirror. */
const firerNode = (
  overrides: Partial<Node> & { properties: Record<string, unknown> },
): Node => ({
  id: 'Flow:Demo' as ComponentId,
  type: 'Flow',
  apiName: 'Demo',
  label: 'Demo',
  parentId: null,
  sourcePath: 'flows/Demo.flow-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  ...overrides,
});

/** A `writesTo` edge that assigns a LITERAL value to the field. */
const literalWriteEdge = (assignedValue: string): Edge => ({
  fromId: 'Flow:Demo' as ComponentId,
  toId: 'CustomField:Account.Status__c' as ComponentId,
  edgeType: 'writesTo',
  confidence: 'declared',
  source: 'flow-extractor',
  properties: { assignedValueKind: 'literal', assignedValue },
});

/** A non-writing edge (a plain reference), used to drive text-property scans. */
const referencesEdge = (): Edge => ({
  fromId: 'Flow:Demo' as ComponentId,
  toId: 'CustomField:Account.Status__c' as ComponentId,
  edgeType: 'references',
  confidence: 'declared',
  source: 'flow-extractor',
  properties: {},
});

const DEFINED4: readonly NormalizedPicklistValue[] = [
  value('Draft', true),
  value('Open', true),
  value('Closed', true),
  value('Cancelled/Pass', true),
];

describe('referencesFromEdgeSource (vault-facing extraction) + classifier', () => {
  it('a formula-kind condition mirror uses the QUOTED extractor, not criteria garbage', () => {
    // Raw formula text: the broken build ran the unquoted criteria extractor on
    // this and captured `!= 'Cancelled/Pass` / `Offer'),Ispickval(...` garbage.
    const node = firerNode({
      properties: {
        conditions: [
          {
            kind: 'formula',
            expression:
              "AND(ISPICKVAL($Record.Status__c,'Closed'), $Record.Status__c != 'Cancelled/Pass')",
          },
        ],
      },
    });
    const refs = referencesFromEdgeSource(referencesEdge(), node, 'Status__c');
    // Only the two clean quoted literals — both DEFINED — are extracted.
    expect([...refs].map((r) => r.literal).sort()).toEqual(['Cancelled/Pass', 'Closed']);
    expect(refs.every((r) => r.kind === 'comparison')).toBe(true);
    // Neither is orphaned; no operator/quote garbage leaks through.
    expect(classifyPicklistLiterals(DEFINED4, refs)).toEqual([]);
  });

  it('boolean + field-ref + multi-value criteria mirrors yield NO orphaned finding', () => {
    const node = firerNode({
      properties: {
        conditions: [
          { kind: 'flow-decision', expression: '$Record.Status__c IsNull false' },
          { kind: 'flow-decision', expression: '$Record.Status__c IsChanged true' },
          {
            kind: 'flow-decision',
            expression: '$Record__Prior.Status__c NotEqualTo $Record.Status__c',
          },
          { kind: 'flow-decision', expression: '$Record.Status__c EqualTo Closed,Cancelled/Pass' },
        ],
      },
    });
    const refs = referencesFromEdgeSource(referencesEdge(), node, 'Status__c');
    // Only the two comma-split DEFINED values survive extraction.
    expect([...refs].map((r) => r.literal).sort()).toEqual(['Cancelled/Pass', 'Closed']);
    expect(classifyPicklistLiterals(DEFINED4, refs)).toEqual([]);
  });

  it('an assignment to an UNRESTRICTED picklist is NOT flagged orphaned', () => {
    // Free-text write to an unrestricted picklist (the Task-subject false-positive
    // class): a literal assignment of a value outside the set is legitimate.
    const refs = referencesFromEdgeSource(
      literalWriteEdge('Contact Student, Application Submitted'),
      firerNode({ properties: {} }),
      'Status__c',
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.kind).toBe('assignment');
    // fieldRestricted === false → suppressed.
    expect(classifyPicklistLiterals(DEFINED4, refs, { fieldRestricted: false })).toEqual([]);
    // Unknown restrictedness → still suppressed (assignment-only, can't prove a defect).
    expect(classifyPicklistLiterals(DEFINED4, refs)).toEqual([]);
  });

  it('an assignment of an ORPHANED value to a RESTRICTED picklist IS flagged', () => {
    const refs = referencesFromEdgeSource(
      literalWriteEdge('Widthdrawn'),
      firerNode({ properties: {} }),
      'Status__c',
    );
    const findings = classifyPicklistLiterals(DEFINED4, refs, { fieldRestricted: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('orphaned');
    expect(findings[0]?.severity).toBe('high');
  });

  it('a genuine typo in a COMPARISON against a RESTRICTED picklist IS flagged HIGH with a near-match', () => {
    // `ISPICKVAL($Record.Status__c,'Closd')` — a typo of the defined `Closed`.
    const node = firerNode({
      properties: {
        conditions: [
          { kind: 'formula', expression: "ISPICKVAL($Record.Status__c,'Closd')" },
        ],
      },
    });
    const refs = referencesFromEdgeSource(referencesEdge(), node, 'Status__c');
    const findings = classifyPicklistLiterals(DEFINED4, refs, { fieldRestricted: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('orphaned');
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.literal).toBe('Closd');
    expect(findings[0]?.nearMatch).toBe('Closed');
  });

  it('the same typo COMPARISON is flagged even at UNKNOWN restrictedness (a dead branch)', () => {
    const node = firerNode({
      properties: {
        conditions: [{ kind: 'formula', expression: "ISPICKVAL($Record.Status__c,'Closd')" }],
      },
    });
    const refs = referencesFromEdgeSource(referencesEdge(), node, 'Status__c');
    // No fieldRestricted supplied → a comparison that cannot match is still flagged.
    const findings = classifyPicklistLiterals(DEFINED4, refs);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('orphaned');
  });

  it('and is SUPPRESSED when the field is known UNRESTRICTED', () => {
    const node = firerNode({
      properties: {
        conditions: [{ kind: 'formula', expression: "ISPICKVAL($Record.Status__c,'Closd')" }],
      },
    });
    const refs = referencesFromEdgeSource(referencesEdge(), node, 'Status__c');
    expect(classifyPicklistLiterals(DEFINED4, refs, { fieldRestricted: false })).toEqual([]);
  });
});

describe('extractQuotedFieldLiterals (VR / formula mirror)', () => {
  it('extracts ISPICKVAL / equality literals adjacent to the field only', () => {
    const formula =
      "AND(ISPICKVAL(Status__c,'Closed'), TEXT(Status__c) == 'Open', Other__c == 'Ignored')";
    expect([...extractQuotedFieldLiterals(formula, 'Status__c')].sort()).toEqual([
      'Closed',
      'Open',
    ]);
  });

  it('does not attribute a bare literal that is not adjacent to the field', () => {
    // `'Somewhere'` is not compared against Status__c — it must not be captured.
    expect(extractQuotedFieldLiterals("String x = 'Somewhere';", 'Status__c')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R6 — handler-level paging. Adopts `paginateLegacy` (page-cursor.ts) instead
// of open-coding slice + truncated + nextOffset, so a truncated page also
// carries a `nextCursor` bound to this tool + the vault's `sourceTreeHash` —
// closing the gap the census flagged: a raw `offset` carried forward has
// nothing checking it belongs to THIS vault snapshot.
// ---------------------------------------------------------------------------
describe('picklistIntegrityScanHandler — R6 paging (paginateLegacy adoption)', () => {
  const FIXTURE_MANIFEST: VaultManifest = {
    version: '0.1.0',
    refreshedAt: '2026-06-29T00:00:00Z',
    sourceOrg: 'me@example.com',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:fixture-pis-v1',
  };

  const makePicklistField = (
    apiName: string,
    // A bare-token default that matches NEITHER defined value — every field
    // yields exactly one `orphaned`/`default` finding, no edges required.
    defaultLiteral: string,
  ): Node => ({
    id: `CustomField:Account.${apiName}` as ComponentId,
    type: 'CustomField',
    apiName,
    label: null,
    parentId: 'CustomObject:Account' as ComponentId,
    sourcePath: 'unused.field-meta.xml',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      dataType: 'Picklist',
      picklistValues: [
        { value: 'Draft', isActive: true },
        { value: 'Active', isActive: true },
      ],
      defaultValue: defaultLiteral,
    },
  });

  // Three picklist fields, api names ascending so fieldId sort is predictable
  // (A < B < C), each with one orphaned-default finding.
  const seed: ExtractionResult = {
    nodes: [
      makePicklistField('AStatus__c', 'Missing'),
      makePicklistField('BStatus__c', 'Missing'),
      makePicklistField('CStatus__c', 'Missing'),
    ],
    edges: [],
  };

  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pis-'));
    const opened = await openGraph(join(tempDir, 'pis.db'));
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

  it('sanity: three seeded fields each yield exactly one orphaned-default finding', async () => {
    const r = await picklistIntegrityScanHandler(ctx, { limit: 500 });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.totalFieldCount).toBe(3);
    expect(r.value.data.totalFindingCount).toBe(3);
    expect(r.value.data.truncated).toBe(false);
    // Pre-fix and post-fix both: a whole-fits page emits no cursor.
    expect(r.value.data.nextCursor).toBeUndefined();
  });

  it('FAIL-BEFORE/PASS-AFTER: a truncated page carries a nextCursor bound to this vault', async () => {
    const r = await picklistIntegrityScanHandler(ctx, { limit: 1 });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.nextOffset).toBe(1);
    // BEFORE the fix (open-coded slice/truncated/nextOffset): `nextCursor` is
    // never set on the output type nor emitted at runtime — this assertion is
    // exactly what fails against the pre-fix code.
    expect(typeof r.value.data.nextCursor).toBe('string');
    expect(r.value.data.pageInfo?.hasMore).toBe(true);
  });

  it('ROUND TRIP: paging with the returned cursor reaches every field with no dup/skip', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const r = await picklistIntegrityScanHandler(
        ctx,
        cursor === undefined ? { limit: 1 } : { limit: 1, cursor },
      );
      if (!r.ok) throw new Error(r.error.message);
      for (const f of r.value.data.fields) seen.push(f.apiName);
      if (!r.value.data.truncated) break;
      const next = r.value.data.nextCursor;
      if (next === undefined) throw new Error('truncated page emitted no cursor');
      cursor = next;
    }
    expect(seen).toEqual(['AStatus__c', 'BStatus__c', 'CStatus__c']);
  });

  it('FAIL-BEFORE/PASS-AFTER: a cursor minted against a DIFFERENT vault snapshot is rejected, not silently replayed', async () => {
    const first = await picklistIntegrityScanHandler(ctx, { limit: 1 });
    if (!first.ok) throw new Error(first.error.message);
    const cursor = first.value.data.nextCursor;
    if (cursor === undefined) throw new Error('expected a cursor on a truncated page');

    // Simulate a refresh: same graph contents, but a DIFFERENT
    // `sourceTreeHash` — the identity `decodeCursor` binds against. BEFORE the
    // fix there is no cursor at all, so this class of bug (an `offset` carried
    // forward across a refresh, unchecked) cannot even be expressed — the
    // handler just accepts whatever offset it is given.
    const refreshedCtx: Context = {
      ...ctx,
      manifest: { ...FIXTURE_MANIFEST, sourceTreeHash: 'sha256:fixture-pis-v2-refreshed' },
    };
    const replayed = await picklistIntegrityScanHandler(refreshedCtx, {
      limit: 1,
      cursor,
    });
    expect(replayed.ok).toBe(false);
    if (replayed.ok) throw new Error('expected rejection');
    expect(replayed.error.kind).toBe('invalid-query');
  });

  it('an offset beyond the end still returns cleanly with no cursor (whole-fits final page)', async () => {
    const r = await picklistIntegrityScanHandler(ctx, { limit: 500, offset: 2 });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.data.fields).toHaveLength(1);
    expect(r.value.data.fields[0]?.apiName).toBe('CStatus__c');
    expect(r.value.data.truncated).toBe(false);
    expect(r.value.data.nextCursor).toBeUndefined();
  });
});
