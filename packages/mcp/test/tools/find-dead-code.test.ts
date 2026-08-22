/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import { EDGE_TYPES } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  isAsyncDispatchRegistration,
  isUnprovenRegistration,
  NOT_USAGE_EDGE_TYPES,
  USAGE_EDGE_TYPES,
} from '../../src/tools/apex-reachability.js';
import {
  findDeadCodeHandler,
  findDeadCodeInputSchema,
  NON_USAGE_EDGE_EXCLUSION_SQL,
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

// =============================================================================
// Async-dispatch (Queueable / Batchable / Schedulable) verdicts.
//
// This block used to pin `likely_dead` for @isTest-only dispatch and
// `definitely_dead` for no dispatch at all, on the stated reason that such a
// class "must be enqueued/executed/scheduled by user Apex". That reason is
// FALSE on the platform: an admin scheduling a class through Setup > Schedule
// Apex creates a `CronTrigger` RECORD, and CronTrigger is data, not metadata —
// never retrieved, no node, no edge, no refresh can close the gap — and
// enqueueJob / executeBatch run from anonymous Apex too. Measured org-wide, 16
// of the 18 classes this tool called `likely_dead` were Schedulable or
// Batchable.
//
// The invariant those tests guarded — that implementing the interface is not
// itself liveness, and that production dispatch is distinguishable from
// @isTest-only dispatch — is KEPT: it now lives in `reasoning` and in the
// suppression, not in a confident dead verdict.
// =============================================================================
describe('findDeadCodeHandler — dead async-dispatch (Queueable) detection', () => {
  let qDir: string;
  let qStore: GraphStore;
  let qCtx: Context;

  beforeAll(async () => {
    qDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fdc-queueable-'));
    const opened = await openGraph(join(qDir, 'fdc-q.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    qStore = opened.value;
    const qSeed: ExtractionResult = {
      nodes: [
        // Queueable enqueued from a PRODUCTION (non-test) class → live.
        makeNode({
          id: 'ApexClass:LiveQueueable',
          type: 'ApexClass',
          apiName: 'LiveQueueable',
          properties: { isTest: false, isQueueable: true },
        }),
        // Production dispatcher (non-@isTest) — its enqueue is guarded only by
        // `!Test.isRunningTest()`, a genuine production runtime path.
        makeNode({
          id: 'ApexClass:DispatcherHelper',
          type: 'ApexClass',
          apiName: 'DispatcherHelper',
          properties: { isTest: false },
        }),
        // Queueable enqueued ONLY from an @isTest class → likely_dead (test
        // dispatch is rolled back at runtime; no production dispatch site).
        makeNode({
          id: 'ApexClass:TestOnlyQueueable',
          type: 'ApexClass',
          apiName: 'TestOnlyQueueable',
          properties: { isTest: false, isQueueable: true },
        }),
        makeNode({
          id: 'ApexClass:TestOnlyQueueableTest',
          type: 'ApexClass',
          apiName: 'TestOnlyQueueableTest',
          properties: { isTest: true },
        }),
        // Queueable never enqueued anywhere → definitely_dead (the textbook
        // dead-queueable signature: implements the interface but no dispatch).
        makeNode({
          id: 'ApexClass:OrphanQueueable',
          type: 'ApexClass',
          apiName: 'OrphanQueueable',
          properties: { isTest: false, isQueueable: true },
        }),
        // Control: a REST entry point with no callers is STILL live — the
        // platform invokes it externally; async-dispatch reasoning must not
        // bleed into external entry points.
        makeNode({
          id: 'ApexClass:RestEndpoint',
          type: 'ApexClass',
          apiName: 'RestEndpoint',
          properties: { isTest: false, isRestResource: true },
        }),
        // CONTROL, the other direction: a PLAIN class — no interfaces, no
        // superclass, no incoming edges — must still be found dead. Sits in
        // this fixture on purpose, so the async amnesty and the dead-code
        // detection are asserted against the same graph.
        makeNode({
          id: 'ApexClass:PlainOrphanUtil',
          type: 'ApexClass',
          apiName: 'PlainOrphanUtil',
          properties: { isTest: false },
        }),
      ],
      edges: [
        // DispatcherHelper -> LiveQueueable : production async dispatch.
        makeEdge({
          fromId: 'ApexClass:DispatcherHelper',
          toId: 'ApexClass:LiveQueueable',
          edgeType: 'dispatchesAsync',
          confidence: 'declared',
          source: 'apex-class',
          properties: { dispatchMechanism: 'enqueueJob' },
        }),
        // TestOnlyQueueableTest -> TestOnlyQueueable : test-only async dispatch.
        makeEdge({
          fromId: 'ApexClass:TestOnlyQueueableTest',
          toId: 'ApexClass:TestOnlyQueueable',
          edgeType: 'dispatchesAsync',
          confidence: 'declared',
          source: 'apex-class',
          properties: { dispatchMechanism: 'enqueueJob' },
        }),
      ],
    };
    const imp = await importExtractionResults(qStore, [qSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    qCtx = { vaultRoot: qDir, manifest: MANIFEST, graph: qStore };
  });

  afterAll(async () => {
    await closeGraph(qStore);
    rmSync(qDir, { recursive: true, force: true });
  });

  it('a Queueable enqueued from a production (non-test) dispatch site is NOT dead', async () => {
    const r = await findDeadCodeHandler(qCtx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const live = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:LiveQueueable',
    );
    expect(live?.verdict).toBe('uncertain');
    // and it is suppressed (never dead) in the default result.
    const rDefault = await findDeadCodeHandler(qCtx, {});
    expect(rDefault.ok).toBe(true);
    if (!rDefault.ok) return;
    expect(
      rDefault.value.data.candidates.find(
        (c) => c.componentId === 'ApexClass:LiveQueueable',
      ),
    ).toBeUndefined();
  });

  it('a Queueable enqueued ONLY from an @isTest class is uncertain, never likely_dead', async () => {
    // WAS `likely_dead`. A class whose only VISIBLE dispatch is a test can
    // still be the thing an admin scheduled in Setup, and that registration is
    // a CronTrigger record no metadata walk sees. The observation is kept —
    // `reachedByTestClassOnly` still true, and the reasoning says which
    // dispatch sites ARE visible — only the confident verdict is gone.
    const r = await findDeadCodeHandler(qCtx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.candidates.find(
      (x) => x.componentId === 'ApexClass:TestOnlyQueueable',
    );
    expect(c?.verdict).toBe('uncertain');
    expect(c?.reachedByTestClassOnly).toBe(true);
    expect(c?.reasoning).toContain('@isTest classes');
    expect(c?.reasoning).toContain('CronTrigger');
    // …and it is WITHHELD from the default listing rather than reported dead.
    const rDefault = await findDeadCodeHandler(qCtx, {});
    expect(rDefault.ok).toBe(true);
    if (!rDefault.ok) return;
    expect(
      rDefault.value.data.candidates.find(
        (x) => x.componentId === 'ApexClass:TestOnlyQueueable',
      ),
    ).toBeUndefined();
  });

  it('a Queueable that is never enqueued anywhere is uncertain, never definitely_dead', async () => {
    // WAS `definitely_dead` — "the textbook dead-queueable signature". It is
    // also the exact signature of a Queueable enqueued from anonymous Apex or a
    // Batchable started by a scheduled job, neither of which is metadata.
    const r = await findDeadCodeHandler(qCtx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.candidates.find(
      (x) => x.componentId === 'ApexClass:OrphanQueueable',
    );
    expect(c?.verdict).toBe('uncertain');
    expect(c?.incomingEdgeCount).toBe(0);
    expect(c?.reasoning).toContain('No dispatch site of any kind is visible');
    expect(c?.reasoning).toContain('NOT evidence of death');
  });

  it('CONTROL: a plain class with no interfaces and no in-edges is STILL definitely_dead', async () => {
    // The async amnesty must not become a blanket amnesty. If this flips, the
    // tool has stopped finding dead code and the fix has gone too wide.
    const r = await findDeadCodeHandler(qCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.candidates.find(
      (x) => x.componentId === 'ApexClass:PlainOrphanUtil',
    );
    expect(c?.verdict).toBe('definitely_dead');
    expect(c?.incomingEdgeCount).toBe(0);
  });

  it('an external REST entry point with no callers stays live (not async-dead)', async () => {
    const r = await findDeadCodeHandler(qCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.candidates.find(
        (c) => c.componentId === 'ApexClass:RestEndpoint',
      ),
    ).toBeUndefined();
  });

  it('discloses the async-dispatch rule — and the CronTrigger reason — even on the DEFAULT call that lists none of them', async () => {
    // The default call withholds every async row, so this boundary is the only
    // thing telling a reader the tool looked at them. It must ride on the
    // response whether or not any async class is LISTED.
    const r = await findDeadCodeHandler(qCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain(
      'async-dispatch (Queueable/Batchable/Schedulable) is NEVER reported dead on metadata evidence alone',
    );
    expect(joined).toContain('CronTrigger');
    expect(joined).toContain('DATA, not metadata');
    expect(joined).toContain('NO refresh can close that gap');
    expect(joined).toContain('!Test.isRunningTest()');
    // No async class is listed at all on this call.
    expect(
      r.value.data.candidates.filter((c) =>
        c.reasoning.startsWith('async-dispatch class'),
      ),
    ).toEqual([]);
  });
});

// A class used ONLY via a static-field / type-name reference (`Other.CONST`,
// `List<Other>`, `JSON.deserialize(.., List<Other>.class)`) never becomes an
// inbound graph edge, so the CTE sees zero in-degree and would wrongly call it
// definitely_dead. The tool grep-re-checks non-test production source before
// reporting an ApexClass dead. GENERIC synthetic fixtures — no org identifiers.
describe('findDeadCodeHandler — static-type-usage re-check (DEAD-CODE-MISSES-STATIC-TYPE-USAGE)', () => {
  let sDir: string;
  let sStore: GraphStore;
  let sCtx: Context;

  const writeCls = (dir: string, apiName: string, body: string): void =>
    writeFileSync(join(dir, `${apiName}.cls`), body, 'utf8');

  beforeAll(async () => {
    sDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fdc-static-'));
    const opened = await openGraph(join(sDir, 'fdc-static.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    sStore = opened.value;

    const sSeed: ExtractionResult = {
      nodes: [
        // Zero inbound edges, but referenced by production OrderService via a
        // static field + type name → NOT dead.
        makeNode({
          id: 'ApexClass:PricingCalculator',
          type: 'ApexClass',
          apiName: 'PricingCalculator',
          properties: { isTest: false },
        }),
        // Zero inbound edges, referenced by production IntegrationGateway only
        // through `JSON.deserialize(.., List<PayloadShape>.class)` → NOT dead.
        makeNode({
          id: 'ApexClass:PayloadShape',
          type: 'ApexClass',
          apiName: 'PayloadShape',
          properties: { isTest: false },
        }),
        // Zero inbound edges AND referenced nowhere in source → definitely_dead
        // (control: the grep must find nothing and leave the verdict alone).
        makeNode({
          id: 'ApexClass:TrulyDeadHelper',
          type: 'ApexClass',
          apiName: 'TrulyDeadHelper',
          properties: { isTest: false },
        }),
        // Zero inbound edges, referenced ONLY from an @isTest class →
        // definitely_dead (a test reference is not production usage).
        makeNode({
          id: 'ApexClass:TestReferencedOnly',
          type: 'ApexClass',
          apiName: 'TestReferencedOnly',
          properties: { isTest: false },
        }),
        // Production referrers — kept live by an entry-point trigger so they do
        // not themselves clutter the dead set.
        makeNode({
          id: 'ApexClass:OrderService',
          type: 'ApexClass',
          apiName: 'OrderService',
          properties: { isTest: false },
        }),
        makeNode({
          id: 'ApexClass:IntegrationGateway',
          type: 'ApexClass',
          apiName: 'IntegrationGateway',
          properties: { isTest: false },
        }),
        makeNode({
          id: 'ApexTrigger:AppTrigger',
          type: 'ApexTrigger',
          apiName: 'AppTrigger',
          properties: { isTest: false },
        }),
        // The test class that references TestReferencedOnly. Test classes are
        // never dead themselves and must be EXCLUDED as production referrers.
        makeNode({
          id: 'ApexClass:LegacyScenarioTest',
          type: 'ApexClass',
          apiName: 'LegacyScenarioTest',
          properties: { isTest: true },
        }),
      ],
      edges: [
        makeEdge({
          fromId: 'ApexTrigger:AppTrigger',
          toId: 'ApexClass:OrderService',
          edgeType: 'callsApex',
        }),
        makeEdge({
          fromId: 'ApexTrigger:AppTrigger',
          toId: 'ApexClass:IntegrationGateway',
          edgeType: 'callsApex',
        }),
      ],
    };
    const imp = await importExtractionResults(sStore, [sSeed]);
    if (!imp.ok) throw new Error(imp.error.message);

    // Vault source tree: `{vaultRoot}/source/classes/*.cls`.
    const classesDir = join(sDir, 'source', 'classes');
    mkdirSync(classesDir, { recursive: true });
    writeCls(
      classesDir,
      'OrderService',
      `public class OrderService {\n` +
        `  public static Decimal total() {\n` +
        `    Decimal rate = PricingCalculator.STANDARD_RATE;\n` +
        `    List<PricingCalculator> tiers = new List<PricingCalculator>();\n` +
        `    return rate;\n` +
        `  }\n}`,
    );
    writeCls(
      classesDir,
      'IntegrationGateway',
      `public class IntegrationGateway {\n` +
        `  public void handle(String payload) {\n` +
        `    List<PayloadShape> rows =\n` +
        `      (List<PayloadShape>) JSON.deserialize(payload, List<PayloadShape>.class);\n` +
        `  }\n}`,
    );
    // Self-only file — the class references its own name in the declaration; the
    // re-check must exclude the candidate's own source file.
    writeCls(
      classesDir,
      'TrulyDeadHelper',
      `public class TrulyDeadHelper {\n  public void noop() {}\n}`,
    );
    writeCls(
      classesDir,
      'TestReferencedOnly',
      `public class TestReferencedOnly {\n  public static Integer x() { return 1; }\n}`,
    );
    writeCls(
      classesDir,
      'PricingCalculator',
      `public class PricingCalculator {\n  public static Decimal STANDARD_RATE = 1.0;\n}`,
    );
    writeCls(
      classesDir,
      'PayloadShape',
      `public class PayloadShape {\n  public Id recordId;\n}`,
    );
    // Only reference to TestReferencedOnly lives in a TEST class → excluded.
    writeCls(
      classesDir,
      'LegacyScenarioTest',
      `@isTest\npublic class LegacyScenarioTest {\n` +
        `  @isTest static void t() { Integer n = TestReferencedOnly.x(); }\n}`,
    );

    sCtx = { vaultRoot: sDir, manifest: MANIFEST, graph: sStore };
  });

  afterAll(async () => {
    await closeGraph(sStore);
    rmSync(sDir, { recursive: true, force: true });
  });

  it('does NOT flag a class used only via a static-field/type-name reference as definitely_dead', async () => {
    const r = await findDeadCodeHandler(sCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Suppressed (downgraded to uncertain) → absent from the default result set.
    expect(
      r.value.data.candidates.find(
        (c) => c.componentId === 'ApexClass:PricingCalculator',
      ),
    ).toBeUndefined();
  });

  it('does NOT flag a class referenced only via JSON.deserialize(.., List<X>.class) as dead', async () => {
    const r = await findDeadCodeHandler(sCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.candidates.find(
        (c) => c.componentId === 'ApexClass:PayloadShape',
      ),
    ).toBeUndefined();
  });

  it('STILL flags a class referenced nowhere in source as definitely_dead (control)', async () => {
    const r = await findDeadCodeHandler(sCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dead = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:TrulyDeadHelper',
    );
    expect(dead?.verdict).toBe('definitely_dead');
  });

  it('STILL flags a class referenced ONLY from a test class as definitely_dead (test refs are not production usage)', async () => {
    const r = await findDeadCodeHandler(sCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dead = r.value.data.candidates.find(
      (c) => c.componentId === 'ApexClass:TestReferencedOnly',
    );
    expect(dead?.verdict).toBe('definitely_dead');
  });

  it('surfaces the downgraded class as `uncertain` with static-usage reasoning under includeUncertain', async () => {
    const r = await findDeadCodeHandler(sCtx, { includeUncertain: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.candidates.find(
      (x) => x.componentId === 'ApexClass:PricingCalculator',
    );
    expect(c?.verdict).toBe('uncertain');
    expect(c?.reasoning).toContain('static-field or type-name');
  });

  it('discloses the static-type-usage re-check in boundaries', async () => {
    const r = await findDeadCodeHandler(sCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toContain(
      'static-type-usage re-check',
    );
  });
});

// =============================================================================
// GUARD (FIND-DEAD-CODE-IGNORES-COMPONENT-SCOPE): "is {class} dead?" passes a
// componentId, but it was Zod-stripped and every call returned the same org-wide
// top-N candidate list. A component scope must now return ONLY that node's
// verdict (surfacing `uncertain` too, which the org-wide view suppresses) plus
// appliedScope; the bare call stays org-wide. Pre-fix a scoped call equals the
// org-wide payload, so the per-node-count / verdict assertions are RED.
describe('findDeadCodeHandler — component scope (guard)', () => {
  it('bare call is org-wide with appliedScope mode: all', async () => {
    const r = await findDeadCodeHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({ component: null, object: null, mode: 'all' });
    expect(r.value.data.totalCount).toBeGreaterThan(1);
  });

  it('componentId scope returns ONLY that class (differs from bare org list)', async () => {
    const r = await findDeadCodeHandler(ctx, { componentId: 'ApexClass:OrphanedHelper' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(1);
    expect(r.value.data.candidates[0]?.componentId).toBe('ApexClass:OrphanedHelper');
    expect(r.value.data.candidates[0]?.verdict).toBe('definitely_dead');
    expect(r.value.data.appliedScope).toEqual({
      component: 'ApexClass:OrphanedHelper',
      object: null,
      mode: 'component',
    });
  });

  it('a scoped uncertain (entry-point) class surfaces its verdict (org-wide suppresses it)', async () => {
    const bare = await findDeadCodeHandler(ctx, {});
    const scoped = await findDeadCodeHandler(ctx, { componentId: 'ApexClass:PublicRestApi' });
    expect(bare.ok && scoped.ok).toBe(true);
    if (!bare.ok || !scoped.ok) return;
    // Org-wide default suppresses uncertain — PublicRestApi is NOT in the bare list...
    expect(bare.value.data.candidates.map((c) => c.componentId)).not.toContain(
      'ApexClass:PublicRestApi',
    );
    // ...but the scoped question returns it (verdict uncertain).
    expect(scoped.value.data.totalCount).toBe(1);
    expect(scoped.value.data.candidates[0]?.componentId).toBe('ApexClass:PublicRestApi');
    expect(scoped.value.data.candidates[0]?.verdict).toBe('uncertain');
  });

  it('CustomField component scope works', async () => {
    const r = await findDeadCodeHandler(ctx, { componentId: 'CustomField:Account.Stale__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.candidates.map((c) => c.componentId)).toEqual([
      'CustomField:Account.Stale__c',
    ]);
    expect(r.value.data.appliedScope.mode).toBe('component');
  });

  it('an unresolved component id is component-not-found (not a silent org-wide list)', async () => {
    const r = await findDeadCodeHandler(ctx, { componentId: 'ApexClass:GhostClass' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('a non-dead-code type prefix is invalid-query', async () => {
    const r = await findDeadCodeHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('componentId + object scope together is invalid-query (mutually exclusive)', async () => {
    const r = await findDeadCodeHandler(ctx, {
      componentId: 'ApexClass:OrphanedHelper',
      objectApiName: 'Account',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

// =============================================================================
// GUARD (FIND-DEAD-CODE-IGNORES-CLASSAPINAME): the `componentId` scope path was
// closed earlier, but a bare `classApiName` / `apiName` (a dev asking "is
// CourseEmailController dead?" by NAME) was Zod-stripped and fell through to the
// org-wide list. The bare class-name aliases must now coerce to `ApexClass:{name}`
// and resolve to the SAME component scope as the canonical componentId.
describe('findDeadCodeHandler — classApiName / apiName alias (guard)', () => {
  it('classApiName resolves to the same component scope as componentId', async () => {
    const byComponentId = await findDeadCodeHandler(ctx, {
      componentId: 'ApexClass:OrphanedHelper',
    });
    const byClassApiName = await findDeadCodeHandler(ctx, {
      classApiName: 'OrphanedHelper',
    });
    expect(byComponentId.ok && byClassApiName.ok).toBe(true);
    if (!byComponentId.ok || !byClassApiName.ok) return;
    // NOT the org-wide list — one candidate, that class, mode component.
    expect(byClassApiName.value.data.totalCount).toBe(1);
    expect(byClassApiName.value.data.candidates[0]?.componentId).toBe(
      'ApexClass:OrphanedHelper',
    );
    expect(byClassApiName.value.data.candidates[0]?.verdict).toBe('definitely_dead');
    expect(byClassApiName.value.data.appliedScope).toEqual({
      component: 'ApexClass:OrphanedHelper',
      object: null,
      mode: 'component',
    });
    expect(byClassApiName.value.data.appliedScope).toEqual(
      byComponentId.value.data.appliedScope,
    );
  });

  it('apiName resolves identically to classApiName', async () => {
    const byApiName = await findDeadCodeHandler(ctx, { apiName: 'OrphanedHelper' });
    expect(byApiName.ok).toBe(true);
    if (!byApiName.ok) return;
    expect(byApiName.value.data.candidates.map((c) => c.componentId)).toEqual([
      'ApexClass:OrphanedHelper',
    ]);
    expect(byApiName.value.data.appliedScope.mode).toBe('component');
  });

  it('an unresolved classApiName is component-not-found (not a silent org-wide list)', async () => {
    const r = await findDeadCodeHandler(ctx, { classApiName: 'GhostClass' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });
});

// =============================================================================
// DRIFT GUARD. `find_dead_code`'s single CTE is a measured ~7x speedup over a
// per-node TS walk, so the IMPLEMENTATION stays split from the shared walker —
// but the DEFINITION of "usage" must not. This is the test that stops the next
// allow-list: `edgeTypes: ['callsApex']` survived two new edge types
// (`dispatchesAsync` in v1.5, the Apex-scanner `references`) precisely because
// nothing tied it to a single source.
// =============================================================================
describe('find_dead_code — non-usage edge-type drift guard', () => {
  it('the CTE exclusions are GENERATED from NOT_USAGE_EDGE_TYPES, one per member and no others', () => {
    const lines = NON_USAGE_EDGE_EXCLUSION_SQL.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(NOT_USAGE_EDGE_TYPES.length);
    for (const t of NOT_USAGE_EDGE_TYPES) {
      expect(NON_USAGE_EDGE_EXCLUSION_SQL).toContain(`AND e.edge_type <> '${t}'`);
    }
    // No exclusion for anything that IS usage — that would be the allow-list
    // creeping back in through the SQL side.
    for (const t of USAGE_EDGE_TYPES) {
      expect(NON_USAGE_EDGE_EXCLUSION_SQL).not.toContain(`<> '${t}'`);
    }
  });

  it('USAGE_EDGE_TYPES and NOT_USAGE_EDGE_TYPES partition the contracts EDGE_TYPES tuple exactly', () => {
    // Derivation, not a hand-copied list: a new EdgeType added to contracts
    // lands in USAGE_EDGE_TYPES automatically and is wrong in the SAFE
    // direction (counted as usage) rather than silently calling code dead.
    expect([...USAGE_EDGE_TYPES, ...NOT_USAGE_EDGE_TYPES].sort()).toEqual([...EDGE_TYPES].sort());
    expect(USAGE_EDGE_TYPES.filter((t) => (NOT_USAGE_EDGE_TYPES as readonly string[]).includes(t))).toEqual([]);
  });
});

// =============================================================================
// DYNAMIC-REGISTRATION ENTRY POINTS. Unifying the usage walk made
// method_reachability and find_dead_code AGREE — which is the goal, except that
// on 4 real classes they agreed on `dead` when all four are live. Corroboration
// of a wrong answer is worse than disagreement, because a reader trusts it.
//
// The two shapes, both DECLARED node properties, neither producing any edge:
//   - a base class in ANOTHER namespace (`hed.TDTM_Runnable`), registered only
//     as a string literal inside a managed framework's registration API
//   - `implements Callable`, dispatched from a Custom Metadata record
// =============================================================================
describe('find_dead_code — unproven dynamic registration is uncertain, never definitely_dead', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-fdc-dyn-'));
    const opened = await openGraph(join(dir, 'fdc.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const st = opened.value;
    const imported = await importExtractionResults(st, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const out = await run({ vaultRoot: dir, manifest: MANIFEST, graph: st } as Context);
    await closeGraph(st);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  /** Zero in-edges on all three — that is the point: registration mints none. */
  const seedDynamic: ExtractionResult = {
    nodes: [
      makeNode({
        type: 'ApexClass',
        id: 'ApexClass:WidgetAffiliationHandler',
        apiName: 'WidgetAffiliationHandler',
        properties: { isTest: false, superclass: 'pkg.TriggerRunnable' },
      }),
      makeNode({
        type: 'ApexClass',
        id: 'ApexClass:WidgetAddressHelper',
        apiName: 'WidgetAddressHelper',
        properties: { isTest: false, implements: ['Callable'] },
      }),
      makeNode({
        type: 'ApexClass',
        id: 'ApexClass:PlainOrphanHelper',
        apiName: 'PlainOrphanHelper',
        properties: { isTest: false },
      }),
      // FIX 3 (APEX-REACHABILITY-DOTTED-INTERFACE): registered via `implements`
      // ONLY — no `superclass` at all — the shape a superclass-only check misses.
      makeNode({
        type: 'ApexClass',
        id: 'ApexClass:CustomSsoRegistrationHandler',
        apiName: 'CustomSsoRegistrationHandler',
        properties: { isTest: false, implements: ['Auth.RegistrationHandler'] },
      }),
    ],
    edges: [],
  };

  const verdictsFor = async () => {
    const r = await withStore(seedDynamic, (c) =>
      findDeadCodeHandler(c, { types: ['ApexClass'], includeUncertain: true, limit: 500 }),
    );
    if (!r.ok) throw new Error(`handler failed: ${r.error.message}`);
    return new Map(r.value.data.candidates.map((x) => [x.componentId, x.verdict]));
  };

  it('a namespaced-superclass subclass is uncertain, not definitely_dead', async () => {
    expect((await verdictsFor()).get('ApexClass:WidgetAffiliationHandler')).toBe('uncertain');
  });

  it('a Callable implementor is uncertain, not definitely_dead', async () => {
    expect((await verdictsFor()).get('ApexClass:WidgetAddressHelper')).toBe('uncertain');
  });

  it('a class implementing a NAMESPACED interface (Auth.RegistrationHandler) is uncertain, not definitely_dead', async () => {
    // The exact shape FIX 3 closes: an AuthProvider record registers the
    // implementing class by type — outside the metadata graph exactly like a
    // dotted superclass, but declared via `implements`, not `superclass`, so
    // the pre-fix `isFrameworkSubclass` (superclass-only) never saw it and this
    // class fell through to `definitely_dead`.
    expect((await verdictsFor()).get('ApexClass:CustomSsoRegistrationHandler')).toBe(
      'uncertain',
    );
  });

  it('CONTROL: a plain class with zero in-edges is STILL definitely_dead', async () => {
    // The classifiers must not become a blanket amnesty. If this ever flips,
    // the predicate has gone too wide and the tool has stopped finding dead code.
    expect((await verdictsFor()).get('ApexClass:PlainOrphanHelper')).toBe('definitely_dead');
  });

  it('the boundary naming the blind spot rides on EVERY ApexClass scan, clean or not', async () => {
    const r = await withStore(
      { nodes: [makeNode({ type: 'ApexClass', id: 'ApexClass:Solo', apiName: 'Solo', properties: { isTest: false } })], edges: [] },
      (c) => findDeadCodeHandler(c, { types: ['ApexClass'], limit: 500 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.some((b) => b.includes('dynamic registration:'))).toBe(true);
  });

  it('DRIFT GUARD: the SQL predicate and the TS predicates agree class-for-class', async () => {
    // Behavioural parity, not string matching. find_dead_code keeps its single
    // CTE (a measured ~7x speedup); the DEFINITION is what must not drift.
    const nodes = [
      { id: 'ApexClass:WidgetAffiliationHandler', props: { isTest: false, superclass: 'pkg.TriggerRunnable' } },
      { id: 'ApexClass:WidgetAddressHelper', props: { isTest: false, implements: ['Callable'] } },
      { id: 'ApexClass:PlainOrphanHelper', props: { isTest: false } },
      { id: 'ApexClass:LocalBaseSubclass', props: { isTest: false, superclass: 'LocalBase' } },
      { id: 'ApexClass:ComparableImpl', props: { isTest: false, implements: ['Comparable'] } },
      // FIX 3 (APEX-REACHABILITY-DOTTED-INTERFACE): an AuthProvider-registered
      // handler implementing a NAMESPACED interface — registered outside the
      // metadata graph exactly like the framework-subclass case, but only via
      // `implements`, never `superclass`.
      {
        id: 'ApexClass:CustomSsoRegistrationHandler',
        props: { isTest: false, implements: ['Auth.RegistrationHandler'] },
      },
      // The three async-dispatch shapes now carried by the SAME rule.
      { id: 'ApexClass:NightlyRollupSchedule', props: { isTest: false, isSchedulable: true, implements: ['Schedulable'] } },
      { id: 'ApexClass:ArchiveSweepBatch', props: { isTest: false, isBatchable: true, implements: ['Database.Batchable<SObject>'] } },
      { id: 'ApexClass:NotifyQueueJob', props: { isTest: false, isQueueable: true, implements: ['Queueable'] } },
    ];
    const seed: ExtractionResult = {
      nodes: nodes.map((n) => makeNode({ type: 'ApexClass', id: n.id, apiName: n.id.split(':')[1] as string, properties: n.props })),
      edges: [],
    };
    const r = await withStore(seed, (c) =>
      findDeadCodeHandler(c, { types: ['ApexClass'], includeUncertain: true, limit: 500 }),
    );
    if (!r.ok) throw new Error('handler failed');
    const sqlSaysUncertain = new Set(
      r.value.data.candidates.filter((x) => x.verdict === 'uncertain').map((x) => x.componentId),
    );
    for (const n of nodes) {
      const node = makeNode({ type: 'ApexClass', id: n.id, apiName: n.id.split(':')[1] as string, properties: n.props });
      // ONE predicate, not a re-derivation: `isUnprovenRegistration` is the
      // TS face of the CTE's `is_unproven_registration` column.
      const tsSays = isUnprovenRegistration(node);
      expect(
        sqlSaysUncertain.has(n.id as never),
        `${n.id}: TS predicate says ${tsSays}, SQL cascade says ${sqlSaysUncertain.has(n.id as never)}`,
      ).toBe(tsSays);
    }
  });

  it('REUSE GUARD: async dispatch rides the SAME unproven-registration rule, not a second one', async () => {
    // `isAsyncDispatchRegistration` must be reachable THROUGH the shared
    // predicate. If someone re-forks a parallel classifier for async classes,
    // one of these two halves stops agreeing with the other.
    const sched = makeNode({
      type: 'ApexClass',
      id: 'ApexClass:NightlyRollupSchedule',
      apiName: 'NightlyRollupSchedule',
      properties: { isTest: false, isSchedulable: true },
    });
    expect(isAsyncDispatchRegistration(sched)).toBe(true);
    expect(isUnprovenRegistration(sched)).toBe(true);
    const plain = makeNode({
      type: 'ApexClass',
      id: 'ApexClass:PlainOrphanHelper',
      apiName: 'PlainOrphanHelper',
      properties: { isTest: false },
    });
    expect(isAsyncDispatchRegistration(plain)).toBe(false);
    expect(isUnprovenRegistration(plain)).toBe(false);
  });
});

// =============================================================================
// F9 — the tallies describe the FULL classified set; the LISTING is filtered,
// and the response says so.
//
// Pre-fix, `byVerdict` was computed after the `includeUncertain` filter had
// already dropped rows, so a default org-wide call reported
// `{definitely_dead: 0, likely_dead: 18, uncertain: 0}` while 91 uncertain
// candidates had been classified and withheld — an UNCHECKED zero in the one
// bucket that answers "is there anything you are not showing me".
// =============================================================================
describe('find_dead_code — byVerdict tallies the FULL set, `suppressed` names the filter', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-fdc-tally-'));
    const opened = await openGraph(join(dir, 'fdc.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const st = opened.value;
    const imported = await importExtractionResults(st, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const out = await run({ vaultRoot: dir, manifest: MANIFEST, graph: st } as Context);
    await closeGraph(st);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  /** One plain dead class + three classes that can only ever be `uncertain`. */
  const seedMixed: ExtractionResult = {
    nodes: [
      makeNode({
        type: 'ApexClass',
        id: 'ApexClass:PlainOrphanHelper',
        apiName: 'PlainOrphanHelper',
        properties: { isTest: false },
      }),
      makeNode({
        type: 'ApexClass',
        id: 'ApexClass:NightlyRollupSchedule',
        apiName: 'NightlyRollupSchedule',
        properties: { isTest: false, isSchedulable: true },
      }),
      makeNode({
        type: 'ApexClass',
        id: 'ApexClass:ArchiveSweepBatch',
        apiName: 'ArchiveSweepBatch',
        properties: { isTest: false, isBatchable: true },
      }),
      makeNode({
        type: 'ApexClass',
        id: 'ApexClass:WidgetAddressHelper',
        apiName: 'WidgetAddressHelper',
        properties: { isTest: false, implements: ['Callable'] },
      }),
    ],
    edges: [],
  };

  it('the DEFAULT call counts the withheld uncertain rows instead of reporting `uncertain: 0`', async () => {
    const r = await withStore(seedMixed, (c) =>
      findDeadCodeHandler(c, { types: ['ApexClass'], limit: 500 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Pre-fix this read `uncertain: 0` with `totalCount: 1`.
    expect(d.byVerdict).toEqual({
      definitely_dead: 1,
      likely_dead: 0,
      uncertain: 3,
    });
    expect(d.byType).toEqual({ ApexClass: 4 });
    // The LISTING is still filtered — one row, the genuinely dead one.
    expect(d.totalCount).toBe(1);
    expect(d.candidates.map((c) => c.componentId)).toEqual([
      'ApexClass:PlainOrphanHelper',
    ]);
    expect(d.suppressed.includeUncertain).toBe(false);
    expect(d.suppressed.uncertainWithheld).toBe(3);
    expect(d.suppressed.note).toContain('tally the FULL candidate set');
    expect(d.suppressed.note).toContain('withheld from the listing');
  });

  it('`includeUncertain: true` lists everything and says nothing was withheld', async () => {
    const r = await withStore(seedMixed, (c) =>
      findDeadCodeHandler(c, {
        types: ['ApexClass'],
        includeUncertain: true,
        limit: 500,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.byVerdict).toEqual({
      definitely_dead: 1,
      likely_dead: 0,
      uncertain: 3,
    });
    expect(d.totalCount).toBe(4);
    expect(d.suppressed.includeUncertain).toBe(true);
    expect(d.suppressed.uncertainWithheld).toBe(0);
    expect(d.suppressed.note).toContain('nothing was withheld');
  });

  it('a zero in `uncertainWithheld` is CHECKED: no uncertain rows existed to withhold', async () => {
    const r = await withStore(
      {
        nodes: [
          makeNode({
            type: 'ApexClass',
            id: 'ApexClass:PlainOrphanHelper',
            apiName: 'PlainOrphanHelper',
            properties: { isTest: false },
          }),
        ],
        edges: [],
      },
      (c) => findDeadCodeHandler(c, { types: ['ApexClass'], limit: 500 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.byVerdict.uncertain).toBe(0);
    expect(d.suppressed.uncertainWithheld).toBe(0);
    expect(d.suppressed.includeUncertain).toBe(false);
    expect(d.suppressed.note).toContain('CHECKED zero');
  });
});
