/// <reference types="vitest/globals" />

/**
 * I3b (structural honesty — empty ≠ none): the seven graph-traversal tools
 * (`get_impact`, `get_edges`, `get_subgraph`, `find_component_usages`,
 * `find_code_usages`, `find_apex_usages`, `find_formula_references`) must NOT
 * let the host narrate an EMPTY dependency / usage result as a proven absence.
 * When the result is empty AND the families that would have produced an edge
 * are not fully covered by the vault, each tool attaches a `coverageCaveat`
 * naming the not-checked families.
 *
 * The three invariants exercised per tool:
 *   (1) EMPTY result + PARTIAL coverage  → caveat present, names missing families.
 *   (2) EMPTY result + COMPLETE coverage → NO caveat (a real "none").
 *   (3) NON-EMPTY result                 → NO caveat (unchanged output).
 * Plus the legacy-vault guard: a manifest with NO coverage rows never
 * false-flags an empty result.
 */

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
import { buildCoverageCaveat } from '../../src/tools/coverage-trust.js';
import { findApexUsagesHandler } from '../../src/tools/find-apex-usages.js';
import { findCodeUsagesHandler } from '../../src/tools/find-code-usages.js';
import { findComponentUsagesHandler } from '../../src/tools/find-component-usages.js';
import { findFormulaReferencesHandler } from '../../src/tools/find-formula-references.js';
import { getEdgesHandler } from '../../src/tools/get-edges.js';
import { getImpactHandler } from '../../src/tools/get-impact.js';
import { getSubgraphHandler } from '../../src/tools/get-subgraph.js';

// ---------------------------------------------------------------------------
// Coverage-row helpers. A row that is requested + retrieved:0 + NOT
// retrieveConfirmed reads as PARTIAL (case (c) in summarizeCoverage) — that is
// what fires the empty-caveat. retrieved:1 (or retrieveConfirmed:true) reads as
// COMPLETE. The full family set spans every list the tools require.
// ---------------------------------------------------------------------------

/** Every family the four required-coverage lists reference. */
const ALL_FAMILIES = [
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'ValidationRule',
  'WorkflowRule',
  'Layout',
  'FlexiPage',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'QuickAction',
  'CustomField',
  'CustomObject',
  'Report',
  'Dashboard',
  'ListView',
] as const;

const coveredRow = (type: string): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 1,
  errored: false,
  neverModeled: false,
});

const partialRow = (type: string): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 0,
  errored: false,
  neverModeled: false,
  // retrieveConfirmed intentionally unset → "not retrieved / dropped" → partial.
});

/** All families covered → an empty result is a real "none". */
const COMPLETE_COVERAGE: readonly CoverageEntry[] = ALL_FAMILIES.map(coveredRow);

/** Apex families NOT retrieved, the rest covered → empty result = not-checked. */
const PARTIAL_COVERAGE: readonly CoverageEntry[] = ALL_FAMILIES.map((t) =>
  t === 'ApexClass' || t === 'ApexTrigger' || t === 'Flow'
    ? partialRow(t)
    : coveredRow(t),
);

const manifestWith = (coverage: readonly CoverageEntry[] | undefined): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 2 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
  ...(coverage !== undefined ? { coverage, coverageComputedAt: '2026-05-29T12:00:00.000Z' } : {}),
});

// ---------------------------------------------------------------------------
// Minimal graph: an ISOLATED field (no edges → empty for every tool) plus a
// CONNECTED field (one Apex readsFrom + one formula references) so the
// non-empty path is exercised too.
// ---------------------------------------------------------------------------

const ISOLATED_FIELD = 'CustomField:Account.Lonely__c';
const CONNECTED_FIELD = 'CustomField:Account.Busy__c';
const APEX_A = 'ApexClass:AlphaService';
const FORMULA_FIELD = 'CustomField:Account.Formula__c';

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'X__c',
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
  confidence: 'parsed',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

const SEED: ExtractionResult = {
  nodes: [
    makeNode({ id: ISOLATED_FIELD, apiName: 'Lonely__c' }),
    makeNode({ id: CONNECTED_FIELD, apiName: 'Busy__c' }),
    makeNode({ id: APEX_A, type: 'ApexClass', apiName: 'AlphaService' }),
    makeNode({ id: FORMULA_FIELD, apiName: 'Formula__c' }),
  ],
  edges: [
    // Connected field gets one incoming Apex readsFrom …
    makeEdge({ fromId: APEX_A, toId: CONNECTED_FIELD, edgeType: 'readsFrom' }),
    // … and one incoming formula references edge.
    makeEdge({
      fromId: FORMULA_FIELD,
      toId: CONNECTED_FIELD,
      edgeType: 'references',
      source: 'formula-tokenizer',
    }),
  ],
};

let dir: string;
let store: GraphStore;

const ctxWith = (coverage: readonly CoverageEntry[] | undefined): Context => ({
  vaultRoot: dir,
  manifest: manifestWith(coverage),
  graph: store,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-empty-caveat-'));
  const opened = await openGraph(join(dir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [SEED]);
  if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// get_edges
// ===========================================================================

describe('I3b empty≠none — get_edges', () => {
  it('EMPTY + partial coverage → caveat naming the not-retrieved families', async () => {
    const r = await getEdgesHandler(ctxWith(PARTIAL_COVERAGE), { nodeId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.status).toBe('partial');
    expect(r.value.data.coverageCaveat?.missingCoverage).toEqual(
      expect.arrayContaining(['ApexClass', 'ApexTrigger', 'Flow']),
    );
  });

  it('EMPTY + complete coverage → NO caveat (a real "none")', async () => {
    const r = await getEdgesHandler(ctxWith(COMPLETE_COVERAGE), { nodeId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('EMPTY + legacy vault (no coverage rows) → NO caveat (never false-flag)', async () => {
    const r = await getEdgesHandler(ctxWith(undefined), { nodeId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('NON-EMPTY → NO caveat (unchanged output)', async () => {
    const r = await getEdgesHandler(ctxWith(PARTIAL_COVERAGE), { nodeId: CONNECTED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBeGreaterThan(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });
});

// ===========================================================================
// get_impact
// ===========================================================================

describe('I3b empty≠none — get_impact', () => {
  it('EMPTY impact + partial coverage → caveat', async () => {
    const r = await getImpactHandler(ctxWith(PARTIAL_COVERAGE), { componentId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.impact.edges.length).toBe(0);
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toEqual(
      expect.arrayContaining(['ApexClass']),
    );
  });

  it('EMPTY impact + complete coverage → NO caveat', async () => {
    const r = await getImpactHandler(ctxWith(COMPLETE_COVERAGE), { componentId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('NON-EMPTY impact → NO caveat', async () => {
    const r = await getImpactHandler(ctxWith(PARTIAL_COVERAGE), { componentId: CONNECTED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.impact.edges.length).toBeGreaterThan(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });
});

// ===========================================================================
// get_subgraph
// ===========================================================================

describe('I3b empty≠none — get_subgraph', () => {
  it('isolated root + partial coverage → caveat', async () => {
    const r = await getSubgraphHandler(ctxWith(PARTIAL_COVERAGE), { rootId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.edges.length).toBe(0);
    expect(r.value.data.coverageCaveat).toBeDefined();
  });

  it('isolated root + complete coverage → NO caveat', async () => {
    const r = await getSubgraphHandler(ctxWith(COMPLETE_COVERAGE), { rootId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('connected root → NO caveat', async () => {
    const r = await getSubgraphHandler(ctxWith(PARTIAL_COVERAGE), { rootId: CONNECTED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.edges.length).toBeGreaterThan(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });
});

// ===========================================================================
// find_apex_usages
// ===========================================================================

describe('I3b empty≠none — find_apex_usages', () => {
  it('EMPTY usages + partial coverage → caveat + boundary line names families', async () => {
    const r = await findApexUsagesHandler(ctxWith(PARTIAL_COVERAGE), { targetId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toEqual(
      expect.arrayContaining(['ApexClass', 'ApexTrigger']),
    );
    // The caveat message is also surfaced in boundaries[] for the prose host.
    expect(r.value.data.boundaries.some((b) => b.includes('EMPTY result'))).toBe(true);
  });

  it('EMPTY usages + complete coverage → NO caveat', async () => {
    const r = await findApexUsagesHandler(ctxWith(COMPLETE_COVERAGE), { targetId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
    expect(r.value.data.boundaries.some((b) => b.includes('EMPTY result'))).toBe(false);
  });

  it('NON-EMPTY usages → NO caveat', async () => {
    const r = await findApexUsagesHandler(ctxWith(PARTIAL_COVERAGE), { targetId: CONNECTED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.usages.length).toBeGreaterThan(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });
});

// ===========================================================================
// find_code_usages
// ===========================================================================

describe('I3b empty≠none — find_code_usages', () => {
  it('EMPTY usages + partial coverage → caveat', async () => {
    const r = await findCodeUsagesHandler(ctxWith(PARTIAL_COVERAGE), { targetId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.usages.length).toBe(0);
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toEqual(
      expect.arrayContaining(['ApexClass', 'ApexTrigger']),
    );
  });

  it('EMPTY usages + complete coverage → NO caveat', async () => {
    const r = await findCodeUsagesHandler(ctxWith(COMPLETE_COVERAGE), { targetId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('NON-EMPTY usages → NO caveat', async () => {
    const r = await findCodeUsagesHandler(ctxWith(PARTIAL_COVERAGE), { targetId: CONNECTED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.usages.length).toBeGreaterThan(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });
});

// ===========================================================================
// find_formula_references
// ===========================================================================

describe('I3b empty≠none — find_formula_references', () => {
  it('EMPTY referencers + partial coverage (CustomField not retrieved) → caveat', async () => {
    // Make CustomField/ValidationRule the not-retrieved families for this tool.
    const coverage = ALL_FAMILIES.map((t) =>
      t === 'CustomField' || t === 'ValidationRule' ? partialRow(t) : coveredRow(t),
    );
    const r = await findFormulaReferencesHandler(ctxWith(coverage), { fieldId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.missingCoverage).toEqual(
      expect.arrayContaining(['CustomField', 'ValidationRule']),
    );
  });

  it('EMPTY referencers + complete coverage → NO caveat', async () => {
    const r = await findFormulaReferencesHandler(ctxWith(COMPLETE_COVERAGE), {
      fieldId: ISOLATED_FIELD,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('NON-EMPTY referencers → NO caveat', async () => {
    const coverage = ALL_FAMILIES.map((t) =>
      t === 'CustomField' ? partialRow(t) : coveredRow(t),
    );
    const r = await findFormulaReferencesHandler(ctxWith(coverage), { fieldId: CONNECTED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.referencers.length).toBeGreaterThan(0);
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });
});

// ===========================================================================
// find_component_usages (empty = no graph AND no grep evidence)
// ===========================================================================

describe('I3b empty≠none — find_component_usages', () => {
  it('NO static evidence + partial coverage → caveat', async () => {
    // A short api name (<3 chars) skips the grep tier, so the isolated field's
    // empty graph tier is the whole answer — but the api name here is long, and
    // the throwaway vault has no source dir, so grep returns nothing either.
    const r = await findComponentUsagesHandler(ctxWith(PARTIAL_COVERAGE), {
      componentId: ISOLATED_FIELD,
      includeGrep: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.hasStaticEvidence).toBe(false);
    expect(r.value.data.coverageCaveat).toBeDefined();
  });

  it('NO static evidence + complete coverage → NO caveat', async () => {
    const r = await findComponentUsagesHandler(ctxWith(COMPLETE_COVERAGE), {
      componentId: ISOLATED_FIELD,
      includeGrep: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });

  it('HAS static evidence → NO caveat', async () => {
    const r = await findComponentUsagesHandler(ctxWith(PARTIAL_COVERAGE), {
      componentId: CONNECTED_FIELD,
      includeGrep: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.hasStaticEvidence).toBe(true);
    expect(r.value.data.coverageCaveat).toBeUndefined();
  });
});

// ===========================================================================
// COVERAGE-CAVEAT-SENTENCE-UNGRAMMATICAL — the RENDERED sentence, per caller.
//
// The caveat message is the product's central honesty sentence: it is what a
// host reads aloud on every empty dependency answer. It was composed by
// splicing a caller-supplied `purpose` in front of a fixed
// `" cannot be confirmed because …"` tail, and the traversal caller supplied a
// two-sentence blob ending in a VERB, so all four graph-traversal tools
// rendered, verbatim:
//
//   … can only be asserted for the dependency families the vault actually
//   retrieved cannot be confirmed because the vault has incomplete coverage
//   for: …
//
// Broken English, on the one sentence the product's credibility rests on.
// These tests pin the WHOLE rendered sentence for four callers (get_edges,
// get_impact, get_subgraph, find_component_usages) — the family list is the
// only part read from the payload, because that part is data. Any future
// caller that hands a verb-final blob to the composer fails here.
// ===========================================================================

/** The exact sentence every empty-traversal caveat must render, in full. */
const expectedEmptyTraversalMessage = (families: readonly string[]): string =>
  'This is an EMPTY result. "Nothing references / uses this" cannot be' +
  ' confirmed because the vault has incomplete coverage for: ' +
  `${families.join(', ')}. Treat absence of dependencies in those families as` +
  ' "not checked", not "none".';

/**
 * Grammar invariants that hold for EVERY caveat message, whoever composed it:
 * the claim verb appears exactly once, and the words immediately before it are
 * the noun-phrase subject — not the tail of a finished sentence.
 */
const assertReadsAsOneSentence = (message: string): void => {
  const occurrences = message.split(' cannot be confirmed').length - 1;
  expect(occurrences).toBe(1);
  const subject = message.slice(0, message.indexOf(' cannot be confirmed'));
  // A verb-final subject ("… the vault actually retrieved cannot be confirmed")
  // is the exact defect; a noun-phrase subject never ends in a past participle.
  expect(subject).not.toMatch(/\b(retrieved|asserted|found|checked|modeled)$/);
  // The subject must not itself be a completed sentence spliced in front of the
  // verb: a full stop is allowed ONLY as the preamble's terminator, i.e. never
  // in the final clause that reaches the verb.
  const finalClause = subject.slice(subject.lastIndexOf('. ') + 1).trim();
  expect(finalClause).not.toMatch(/\.$/);
};

describe('COVERAGE-CAVEAT-SENTENCE — the rendered sentence reads as English', () => {
  it('get_edges renders the whole sentence grammatically', async () => {
    const r = await getEdgesHandler(ctxWith(PARTIAL_COVERAGE), { nodeId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const caveat = r.value.data.coverageCaveat;
    expect(caveat).toBeDefined();
    if (caveat === undefined) return;
    expect(caveat.message).toBe(expectedEmptyTraversalMessage(caveat.missingCoverage));
    assertReadsAsOneSentence(caveat.message);
  });

  it('get_impact renders the whole sentence grammatically', async () => {
    const r = await getImpactHandler(ctxWith(PARTIAL_COVERAGE), { componentId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const caveat = r.value.data.coverageCaveat;
    expect(caveat).toBeDefined();
    if (caveat === undefined) return;
    expect(caveat.message).toBe(expectedEmptyTraversalMessage(caveat.missingCoverage));
    assertReadsAsOneSentence(caveat.message);
  });

  it('get_subgraph renders the whole sentence grammatically', async () => {
    const r = await getSubgraphHandler(ctxWith(PARTIAL_COVERAGE), { rootId: ISOLATED_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const caveat = r.value.data.coverageCaveat;
    expect(caveat).toBeDefined();
    if (caveat === undefined) return;
    expect(caveat.message).toBe(expectedEmptyTraversalMessage(caveat.missingCoverage));
    assertReadsAsOneSentence(caveat.message);
  });

  it('find_component_usages renders it in BOTH coverageCaveat and boundaries[]', async () => {
    const r = await findComponentUsagesHandler(ctxWith(PARTIAL_COVERAGE), {
      componentId: ISOLATED_FIELD,
      includeGrep: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const caveat = r.value.data.coverageCaveat;
    expect(caveat).toBeDefined();
    if (caveat === undefined) return;
    const expected = expectedEmptyTraversalMessage(caveat.missingCoverage);
    expect(caveat.message).toBe(expected);
    assertReadsAsOneSentence(caveat.message);
    // The prose host reads `boundaries`, not `coverageCaveat` — the same
    // sentence must be grammatical there too.
    expect(r.value.data.boundaries).toContain(expected);
  });

  it('a NOUN-PHRASE purpose (the destructive suite) is unchanged by the split slots', async () => {
    // Every non-traversal caller passes a bare noun phrase; the composed
    // sentence must stay byte-identical to its pre-fix form.
    const caveat = buildCoverageCaveat(
      ctxWith(PARTIAL_COVERAGE),
      ['ApexClass', 'Flow'],
      'Deletion safety',
    );
    expect(caveat).toBeDefined();
    if (caveat === undefined) return;
    expect(caveat.message).toBe(
      'Deletion safety cannot be confirmed because the vault has incomplete' +
        ` coverage for: ${caveat.missingCoverage.join(', ')}. Treat absence of` +
        ' dependencies in those families as "not checked", not "none".',
    );
    assertReadsAsOneSentence(caveat.message);
  });
});
