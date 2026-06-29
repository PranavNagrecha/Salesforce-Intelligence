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
  findDeadCodeHandler,
  findDeadCodeInputSchema,
} from '../../src/tools/find-dead-code.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-fdc',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    makeNode({
      id: 'CustomObject:Payment__c',
      type: 'CustomObject',
      apiName: 'Payment__c',
    }),
    // Definitely dead class — no incoming edges.
    makeNode({
      id: 'ApexClass:OrphanedHelper',
      type: 'ApexClass',
      apiName: 'OrphanedHelper',
      properties: { isTest: false },
    }),
    // Likely-dead class — only test classes reach it.
    makeNode({
      id: 'ApexClass:TestOnlyService',
      type: 'ApexClass',
      apiName: 'TestOnlyService',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:TestOnlyServiceTest',
      type: 'ApexClass',
      apiName: 'TestOnlyServiceTest',
      properties: { isTest: true },
    }),
    // Uncertain: own REST entry point.
    makeNode({
      id: 'ApexClass:PublicRestApi',
      type: 'ApexClass',
      apiName: 'PublicRestApi',
      properties: { isTest: false, isRestResource: true },
    }),
    // Uncertain: reached by an entry-point class.
    makeNode({
      id: 'ApexClass:BusinessLogic',
      type: 'ApexClass',
      apiName: 'BusinessLogic',
      properties: { isTest: false },
    }),
    // Test class — should NEVER be flagged as dead.
    makeNode({
      id: 'ApexClass:UnrelatedTest',
      type: 'ApexClass',
      apiName: 'UnrelatedTest',
      properties: { isTest: true },
    }),
    // Dead CustomField — no references.
    makeNode({
      id: 'CustomField:Account.Stale__c',
      type: 'CustomField',
      apiName: 'Account.Stale__c',
      parentId: 'CustomObject:Account',
    }),
    makeNode({
      id: 'CustomField:Payment__c.Orphan__c',
      type: 'CustomField',
      apiName: 'Orphan__c',
      parentId: 'CustomObject:Payment__c',
    }),
    // Standard field (no __c) with no references — must NOT be flagged dead (NI-6):
    // platform fields are not deletable and are not "dead code".
    makeNode({
      id: 'CustomField:Account.IsPartner',
      type: 'CustomField',
      apiName: 'Account.IsPartner',
      parentId: 'CustomObject:Account',
    }),
    // Live CustomField — referenced by BusinessLogic.
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Account.Industry__c',
      parentId: 'CustomObject:Account',
    }),
    // Trigger — own entry point.
    makeNode({
      id: 'ApexTrigger:AccountTrigger',
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      properties: { isTest: false },
    }),
    // Dead flow — no incoming references AND Obsolete status (R2-12: only
    // Obsolete/InvalidDraft flows may fall through to definitely_dead).
    makeNode({
      id: 'Flow:UnusedFlow',
      type: 'Flow',
      apiName: 'UnusedFlow',
      properties: { status: 'Obsolete' },
    }),
    // R2-12: an ACTIVE flow with ZERO incoming edges must NOT be definitely_dead
    // — Flow edges are all OUTGOING (triggersOn/listensTo/callsApex/writesTo),
    // so in-degree is ~0 by nature. An Active flow fires on its own trigger.
    makeNode({
      id: 'Flow:ActiveOrphanFlow',
      type: 'Flow',
      apiName: 'ActiveOrphanFlow',
      properties: { status: 'Active' },
    }),
    // R2-12: a flow with NO status property at all → unknown → treated as
    // active (never confidently dead). The destructive false-positive guard.
    makeNode({
      id: 'Flow:StatuslessOrphanFlow',
      type: 'Flow',
      apiName: 'StatuslessOrphanFlow',
      properties: {},
    }),
    // Profile that GRANTS ACCESS (grantedBy) to code/fields — access is NOT usage.
    makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    // Class reached only by a profile access grant + its own test → likely_dead
    // (F6: the grant must not count as a non-test "reacher").
    makeNode({
      id: 'ApexClass:GrantedTestOnlyService',
      type: 'ApexClass',
      apiName: 'GrantedTestOnlyService',
      properties: { isTest: false },
    }),
    makeNode({
      id: 'ApexClass:GrantedTestOnlyServiceTest',
      type: 'ApexClass',
      apiName: 'GrantedTestOnlyServiceTest',
      properties: { isTest: true },
    }),
    // Class whose ONLY incoming edge is a profile access grant → definitely_dead (F6).
    makeNode({
      id: 'ApexClass:GrantedButUnused',
      type: 'ApexClass',
      apiName: 'GrantedButUnused',
      properties: { isTest: false },
    }),
    // CustomField whose ONLY incoming edge is an FLS grant → definitely_dead (F6).
    makeNode({
      id: 'CustomField:Account.GrantedOnly__c',
      type: 'CustomField',
      apiName: 'Account.GrantedOnly__c',
      parentId: 'CustomObject:Account',
    }),
    // CustomField with NO incoming edges but folded report/dashboard usage
    // (`--with-reports`). It is in USE (a report column / dashboard component),
    // so it must NOT be flagged dead even though its in-degree is zero.
    makeNode({
      id: 'CustomField:Account.ReportOnly__c',
      type: 'CustomField',
      apiName: 'Account.ReportOnly__c',
      parentId: 'CustomObject:Account',
      properties: { usedInReport: true, usedInDashboard: false },
    }),
  ],
  edges: [
    // TestOnlyServiceTest -> TestOnlyService (test-only reach)
    makeEdge({
      fromId: 'ApexClass:TestOnlyServiceTest',
      toId: 'ApexClass:TestOnlyService',
      edgeType: 'callsApex',
    }),
    // PublicRestApi -> BusinessLogic (entry-point reach)
    makeEdge({
      fromId: 'ApexClass:PublicRestApi',
      toId: 'ApexClass:BusinessLogic',
      edgeType: 'callsApex',
    }),
    // BusinessLogic -> Industry__c (live read)
    makeEdge({
      fromId: 'ApexClass:BusinessLogic',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'readsFrom',
    }),
    // Profile access grants (grantedBy) — ACCESS, not usage; must be excluded.
    makeEdge({
      fromId: 'Profile:Admin',
      toId: 'ApexClass:GrantedTestOnlyService',
      edgeType: 'grantedBy',
      confidence: 'declared',
      source: 'profile-extractor',
    }),
    makeEdge({
      fromId: 'ApexClass:GrantedTestOnlyServiceTest',
      toId: 'ApexClass:GrantedTestOnlyService',
      edgeType: 'references',
      properties: { mechanism: 'instantiation' },
    }),
    makeEdge({
      fromId: 'Profile:Admin',
      toId: 'ApexClass:GrantedButUnused',
      edgeType: 'grantedBy',
      confidence: 'declared',
      source: 'profile-extractor',
    }),
    makeEdge({
      fromId: 'Profile:Admin',
      toId: 'CustomField:Account.GrantedOnly__c',
      edgeType: 'grantedBy',
      confidence: 'declared',
      source: 'profile-extractor',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fdc-'));
  const opened = await openGraph(join(tempDir, 'fdc.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('findDeadCodeHandler', () => {
  it('flags OrphanedHelper as definitely_dead', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const orphan = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:OrphanedHelper',
    );
    expect(orphan?.verdict).toBe('definitely_dead');
  });

  it('narrows CustomField dead-code candidates via objectId', async () => {
    const scoped = await findDeadCodeHandler(ctx, {
      objectId: 'CustomObject:Payment__c',
      types: ['CustomField'],
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    for (const c of scoped.value.data.candidates) {
      expect(c.componentId.startsWith('CustomField:Payment__c.')).toBe(true);
    }
    expect(
      scoped.value.data.candidates.some(
        (c) => c.componentId === 'CustomField:Payment__c.Orphan__c',
      ),
    ).toBe(true);
  });

  it('discloses the POST-AST-FLIP CustomField truth: parsed Apex edges, residual blind spots named (P14-USAGE-dead-code-false-positive)', async () => {
    // Stale__c is a CustomField with no inbound edges → flagged definitely_dead.
    // Pre-0.1.9 the disclosure claimed Apex/Flow/SOQL refs were "NOT modeled
    // as graph edges" — INVERTED once the parsed Apex pass became the default
    // (a field referenced only in Apex no longer reads dead). The boundary
    // must state the modeled-now reality AND the residual blind spots
    // (Flow formula text, report tails, dynamic SOQL, reflection).
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stale = r.value.data.candidates.find(
      (c) => c.componentId === 'CustomField:Account.Stale__c',
    );
    expect(stale?.verdict).toBe('definitely_dead');
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('sfi.field_360');
    // The new truth markers…
    expect(joined).toMatch(/PARSED graph edges/);
    expect(joined).toMatch(/DYNAMIC SOQL built at runtime/);
    // …and the inverted claim is GONE.
    expect(joined).not.toMatch(/are NOT modeled as graph edges/);
  });

  it('F6: a class reached only by a profile grant + its own test is likely_dead (grant is not usage)', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.candidates.find(
      (x) => x.componentId === 'ApexClass:GrantedTestOnlyService',
    );
    expect(c?.verdict).toBe('likely_dead');
    expect(c?.reachedByTestClassOnly).toBe(true);
    // The grantedBy edge is excluded; only the test `references` edge counts.
    expect(c?.incomingEdgeCount).toBe(1);
  });

  it('F6: a class whose only incoming edge is a profile access grant is definitely_dead', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.candidates.find(
      (x) => x.componentId === 'ApexClass:GrantedButUnused',
    );
    expect(c?.verdict).toBe('definitely_dead');
    expect(c?.incomingEdgeCount).toBe(0); // grant excluded → zero usage edges
  });

  it('F6: a CustomField whose only incoming edge is an FLS grant is definitely_dead', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.candidates.find(
      (x) => x.componentId === 'CustomField:Account.GrantedOnly__c',
    );
    expect(c?.verdict).toBe('definitely_dead');
    expect(c?.incomingEdgeCount).toBe(0);
  });

  it('flags TestOnlyService as likely_dead', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tos = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:TestOnlyService',
    );
    expect(tos?.verdict).toBe('likely_dead');
    expect(tos?.reachedByTestClassOnly).toBe(true);
  });

  it('flags Stale__c CustomField as definitely_dead', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stale = r.value.data.candidates.find(
      (c) => c.componentId === 'CustomField:Account.Stale__c',
    );
    expect(stale?.verdict).toBe('definitely_dead');
  });

  it('does NOT flag a report/dashboard-used field as dead, and discloses the caveat', async () => {
    // ReportOnly__c has zero incoming edges but carries the folded
    // `usedInReport` property — it is in use by a report, so it must be
    // excluded from the dead set (parity with unused_fields_deep /
    // safe_to_delete_field), and the boundaries must carry the --with-reports
    // caveat so a vault refreshed WITHOUT reports does not over-report.
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reportOnly = r.value.data.candidates.find(
      (c) => c.componentId === 'CustomField:Account.ReportOnly__c',
    );
    expect(reportOnly).toBeUndefined();
    expect(
      r.value.data.boundaries.some((b) => b.includes('--with-reports')),
    ).toBe(true);
    // sanity: a truly-dead field is still flagged (exclusion is not blanket).
    expect(
      r.value.data.candidates.some(
        (c) => c.componentId === 'CustomField:Account.Stale__c',
      ),
    ).toBe(true);
  });

  it('does NOT flag standard fields (no __c) as dead (NI-6)', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const std = r.value.data.candidates.find(
      (c) => c.componentId === 'CustomField:Account.IsPartner',
    );
    expect(std).toBeUndefined();
    // sanity: a real custom dead field is still flagged
    const stale = r.value.data.candidates.find(
      (c) => c.componentId === 'CustomField:Account.Stale__c',
    );
    expect(stale?.verdict).toBe('definitely_dead');
  });

  it('flags an Obsolete flow with no incoming refs as definitely_dead', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flow = r.value.data.candidates.find(
      (c) => c.componentId === 'Flow:UnusedFlow',
    );
    expect(flow?.verdict).toBe('definitely_dead');
  });

  it('R2-12: an ACTIVE flow with 0 incoming edges is NOT definitely_dead (suppressed as uncertain)', async () => {
    // Default (includeUncertain=false): an active orphan flow must be SUPPRESSED
    // from the result set entirely — never definitely_dead/likely_dead.
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flow = r.value.data.candidates.find(
      (c) => c.componentId === 'Flow:ActiveOrphanFlow',
    );
    expect(flow).toBeUndefined();
  });

  it('R2-12: an ACTIVE orphan flow surfaces as uncertain when includeUncertain', async () => {
    const r = await findDeadCodeHandler(ctx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flow = r.value.data.candidates.find(
      (c) => c.componentId === 'Flow:ActiveOrphanFlow',
    );
    expect(flow?.verdict).toBe('uncertain');
  });

  it('R2-12: a status-LESS orphan flow is treated as active, never definitely_dead', async () => {
    const r = await findDeadCodeHandler(ctx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flow = r.value.data.candidates.find(
      (c) => c.componentId === 'Flow:StatuslessOrphanFlow',
    );
    expect(flow?.verdict).toBe('uncertain');
    // And it must NOT appear at all in the default (suppressed) result.
    const rDefault = await findDeadCodeHandler(ctx, {});
    expect(rDefault.ok).toBe(true);
    if (!rDefault.ok) return;
    expect(
      rDefault.value.data.candidates.find(
        (c) => c.componentId === 'Flow:StatuslessOrphanFlow',
      ),
    ).toBeUndefined();
  });

  it('does NOT flag test classes as dead', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:UnrelatedTest',
    );
    expect(t).toBeUndefined();
  });

  it('does NOT flag PublicRestApi (own REST entry point) as dead by default', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rest = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:PublicRestApi',
    );
    expect(rest).toBeUndefined();
  });

  it('does NOT flag triggers as dead (own entry point)', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const trig = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexTrigger:AccountTrigger',
    );
    expect(trig).toBeUndefined();
  });

  it('does NOT flag BusinessLogic (reached by entry point) by default', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bl = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:BusinessLogic',
    );
    expect(bl).toBeUndefined();
  });

  it('surfaces uncertain candidates when includeUncertain=true', async () => {
    const r = await findDeadCodeHandler(ctx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bl = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:BusinessLogic',
    );
    expect(bl?.verdict).toBe('uncertain');
    const rest = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:PublicRestApi',
    );
    expect(rest?.verdict).toBe('uncertain');
    expect(rest?.isOwnEntryPoint).toBe(true);
  });

  it('counts byVerdict accurately', async () => {
    const r = await findDeadCodeHandler(ctx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.byVerdict.definitely_dead).toBeGreaterThanOrEqual(3);
    expect(r.value.data.byVerdict.likely_dead).toBeGreaterThanOrEqual(1);
    expect(r.value.data.byVerdict.uncertain).toBeGreaterThanOrEqual(2);
  });

  it('every candidate carries confidence: heuristic', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const c of r.value.data.candidates) {
      expect(c.confidence).toBe('heuristic');
    }
  });

  it('surfaces the dead-code, test-class, and managed-package disclosures', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('dynamic dispatch');
    expect(joined).toContain('test classes');
    expect(joined).toContain('managed-package');
  });

  it('narrows by types filter', async () => {
    const r = await findDeadCodeHandler(ctx, {
      types: ['CustomField'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const c of r.value.data.candidates) {
      expect(c.componentType).toBe('CustomField');
    }
  });

  it('sorts candidates by verdict (definitely_dead first)', async () => {
    const r = await findDeadCodeHandler(ctx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    let sawLikely = false;
    let sawUncertain = false;
    for (const c of r.value.data.candidates) {
      if (c.verdict === 'definitely_dead') {
        if (sawLikely || sawUncertain) {
          throw new Error(
            'definitely_dead should come before likely_dead / uncertain',
          );
        }
      }
      if (c.verdict === 'likely_dead') sawLikely = true;
      if (c.verdict === 'uncertain') sawUncertain = true;
    }
    expect(true).toBe(true);
  });

  it('truncates to limit and flips truncated=true', async () => {
    const r = await findDeadCodeHandler(ctx, { limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.candidates.length).toBeLessThanOrEqual(1);
    expect(r.value.data.truncated).toBe(true);
  });

  it('byType counter reflects per-type distribution', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.byType['ApexClass']).toBeGreaterThanOrEqual(1);
    expect(r.value.data.byType['CustomField']).toBeGreaterThanOrEqual(1);
    expect(r.value.data.byType['Flow']).toBeGreaterThanOrEqual(1);
  });

  it("reasoning explains why each candidate is in the dead bucket", async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const c of r.value.data.candidates) {
      expect(c.reasoning.length).toBeGreaterThan(0);
    }
  });

  it('reports incomingEdgeCount matching the non-parentOf in-degree', async () => {
    // v3.2 result-parity sentinel: the SQL CTE aggregates the same
    // counts the per-node `listEdges` walk used to compute. Verify
    // the known seed cases line up:
    //   - OrphanedHelper has zero non-parentOf incoming edges.
    //   - TestOnlyService has exactly one (from TestOnlyServiceTest).
    //   - Stale__c has zero incoming (no formula refs, no Apex reads).
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const orphan = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:OrphanedHelper',
    );
    expect(orphan?.incomingEdgeCount).toBe(0);
    const tos = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:TestOnlyService',
    );
    expect(tos?.incomingEdgeCount).toBe(1);
    const stale = r.value.data.candidates.find(
      (c) => c.componentId === 'CustomField:Account.Stale__c',
    );
    expect(stale?.incomingEdgeCount).toBe(0);
  });

  it('reports incomingEdgeCount > 0 with hasEntryPointReach for BusinessLogic', async () => {
    // BusinessLogic is reached by PublicRestApi (an own-REST class).
    // The CTE must aggregate that single edge into incomingEdgeCount=1
    // AND has_entry_point_reach=true, otherwise the cascade would
    // mis-classify it as definitely_dead.
    const r = await findDeadCodeHandler(ctx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bl = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:BusinessLogic',
    );
    expect(bl?.verdict).toBe('uncertain');
    expect(bl?.incomingEdgeCount).toBe(1);
    expect(bl?.isOwnEntryPoint).toBe(false);
  });

  it('treats sparse-graph orphan edges as non-test reach', async () => {
    // The original per-node walk falls through to `hasNonTestReach = true`
    // when the referrer node is missing (sparse-graph case). The v3.2
    // CTE preserves that semantics via `from_is_null OR NOT from_is_test`.
    // We seed a fresh store with an orphan edge pointing at a candidate
    // and assert the verdict cascades to `uncertain` (would be includeUncertain
    // because no entry-point reach) rather than `definitely_dead`.
    const sparseDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fdc-sparse-'));
    const sparseOpen = await openGraph(join(sparseDir, 'fdc-sparse.db'));
    if (!sparseOpen.ok) throw new Error(sparseOpen.error.message);
    const sparseStore = sparseOpen.value;
    try {
      const sparseSeed: ExtractionResult = {
        nodes: [
          makeNode({
            id: 'ApexClass:HasOrphanReferrer',
            type: 'ApexClass',
            apiName: 'HasOrphanReferrer',
            properties: { isTest: false },
          }),
        ],
        edges: [
          // fromId refers to a node that does NOT exist in the nodes
          // table — the sparse-graph case the original walk guards.
          makeEdge({
            fromId: 'ApexClass:GhostCaller',
            toId: 'ApexClass:HasOrphanReferrer',
            edgeType: 'callsApex',
          }),
        ],
      };
      const sparseImp = await importExtractionResults(sparseStore, [
        sparseSeed,
      ]);
      if (!sparseImp.ok) throw new Error(sparseImp.error.message);
      const sparseCtx: Context = {
        vaultRoot: sparseDir,
        manifest: MANIFEST,
        graph: sparseStore,
      };
      const r = await findDeadCodeHandler(sparseCtx, {
        includeUncertain: true,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const orphaned = r.value.data.candidates.find(
        (c) => c.componentId === 'ApexClass:HasOrphanReferrer',
      );
      // hasNonTestReach=true (sparse-graph fall-through), no entry
      // point → 'uncertain'. Crucially NOT 'definitely_dead'.
      expect(orphaned?.verdict).toBe('uncertain');
      expect(orphaned?.incomingEdgeCount).toBe(1);
    } finally {
      await closeGraph(sparseStore);
      rmSync(sparseDir, { recursive: true, force: true });
    }
  });
});

describe('findDeadCodeInputSchema', () => {
  it('accepts empty input', () => {
    expect(findDeadCodeInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a valid types array', () => {
    expect(
      findDeadCodeInputSchema.safeParse({ types: ['ApexClass', 'Flow'] })
        .success,
    ).toBe(true);
  });

  it('rejects unknown type', () => {
    expect(
      findDeadCodeInputSchema.safeParse({ types: ['Profile'] }).success,
    ).toBe(false);
  });

  it('rejects limit above 500', () => {
    expect(findDeadCodeInputSchema.safeParse({ limit: 501 }).success).toBe(
      false,
    );
  });

  it('accepts offset and cursor (CR-22)', () => {
    expect(
      findDeadCodeInputSchema.safeParse({ offset: 5, cursor: 'abc' }).success,
    ).toBe(true);
  });
});

// =============================================================================
// CR-22 B4 — output-axis cursor. A truncated page emits an opaque nextCursor
// that resumes with no gaps / no dupes; a whole-fits no-cursor call is
// byte-identical (no limit/offset/nextCursor/pageInfo fields) while the
// always-present `truncated` field stays.
// =============================================================================
describe('findDeadCodeHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits paging fields but keeps `truncated`', async () => {
    const r = await findDeadCodeHandler(ctx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    // The top-level `truncated` is part of today's golden — always emitted.
    expect('truncated' in d).toBe(true);
    expect(d['truncated']).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await findDeadCodeHandler(ctx, {
      includeUncertain: true,
      limit: 500,
    });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.candidates.map((c) => c.componentId);
    expect(fullOrder.length).toBeGreaterThan(2);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof findDeadCodeHandler>> =
        await findDeadCodeHandler(
          ctx,
          cursor !== undefined
            ? { includeUncertain: true, limit: 2, cursor }
            : { includeUncertain: true, limit: 2 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const c of page.value.data.candidates) seen.push(c.componentId);
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 50) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted with includeUncertain=true replayed at false', async () => {
    const first = await findDeadCodeHandler(ctx, {
      includeUncertain: true,
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    const replay = await findDeadCodeHandler(ctx, {
      includeUncertain: false,
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('rejects a cursor minted for a different types filter', async () => {
    const first = await findDeadCodeHandler(ctx, {
      includeUncertain: true,
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') return;
    const replay = await findDeadCodeHandler(ctx, {
      includeUncertain: true,
      types: ['CustomField'],
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });

  it('byVerdict/byType stay full-set totals across pages', async () => {
    const full = await findDeadCodeHandler(ctx, {
      includeUncertain: true,
      limit: 500,
    });
    const page = await findDeadCodeHandler(ctx, {
      includeUncertain: true,
      limit: 1,
    });
    expect(full.ok && page.ok).toBe(true);
    if (!full.ok || !page.ok) return;
    expect(page.value.data.byVerdict).toEqual(full.value.data.byVerdict);
    expect(page.value.data.byType).toEqual(full.value.data.byType);
    expect(page.value.data.totalCount).toBe(full.value.data.totalCount);
  });
});

describe('findDeadCodeHandler — coverage caveat (P13-STAGED-absence-battery)', () => {
  const CALLER_FAMILIES = [
    'ApexClass', 'ApexTrigger', 'AuraDefinitionBundle', 'FlexiPage', 'Flow',
    'LightningComponentBundle', 'QuickAction', 'VisualforceComponent',
    'VisualforcePage',
  ];
  const completeCoverage = (): VaultManifest => ({
    ...MANIFEST,
    coverage: CALLER_FAMILIES.map((type) => ({
      type, requested: true, retrieved: 1, errored: false, neverModeled: false,
    })),
  });

  it('carries an unknown-coverage caveat when the manifest has no coverage rows', async () => {
    const result = await findDeadCodeHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.coverageCaveat).toBeDefined();
  });

  it('omits the caveat when every caller family is covered', async () => {
    const result = await findDeadCodeHandler(
      { ...ctx, manifest: completeCoverage() },
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.coverageCaveat).toBeUndefined();
  });

  it('names pending caller families mid-staged-build (un-retrieved LWC could fake death)', async () => {
    const base = completeCoverage();
    const staged = {
      ...base,
      coverage: (base.coverage ?? []).map((row) =>
        row.type === 'LightningComponentBundle'
          ? { ...row, retrieved: 0, pending: true }
          : row,
      ),
      staged: { tier: 1, totalTiers: 3, pendingTypes: ['LightningComponentBundle'] },
    };
    const result = await findDeadCodeHandler({ ...ctx, manifest: staged }, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.coverageCaveat?.missingCoverage).toEqual([
      'LightningComponentBundle',
    ]);
  });
});
