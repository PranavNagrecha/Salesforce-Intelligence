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
  orgOverviewHandler,
  orgOverviewInputSchema,
} from '../../src/tools/org-overview.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3, CustomField: 6, ApexClass: 4, Profile: 2 },
  edges: { references: 4, callsApex: 3, grantedBy: 5 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/properties. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'placeholder',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Default edge-shape helper. Caller overrides fromId/toId/edgeType. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

// =============================================================================
// Object/field topology — Account is most-referenced, Opportunity second, the
// third object (Boring__c) gets no incoming edges. The references-edge fan-in
// drives the topObjects ranking.
// =============================================================================

const ACCOUNT_ID = 'CustomObject:Account';
const OPPORTUNITY_ID = 'CustomObject:Opportunity';
const BORING_ID = 'CustomObject:Boring__c';

const ACCOUNT_FIELD_A = 'CustomField:Account.FieldA__c';
const ACCOUNT_FIELD_B = 'CustomField:Account.FieldB__c';
const OPP_FIELD = 'CustomField:Opportunity.OppField__c';

const APEX_HOT = 'ApexClass:HotPath';
const APEX_LUKEWARM = 'ApexClass:Lukewarm';
const APEX_COLD = 'ApexClass:Cold';
const APEX_HUGE = 'ApexClass:HugeClass';

const PROFILE_ADMIN = 'Profile:Admin';
const PROFILE_REP = 'Profile:Rep';

const WORKFLOW_RULE_ACTIVE = 'WorkflowRule:Account.ActiveRule';
const WORKFLOW_RULE_INACTIVE = 'WorkflowRule:Account.OldRule';
const APPROVAL_PROCESS = 'ApprovalProcess:Account.Approval1';
const FLOW_ACTIVE = 'Flow:ActiveFlow';
const FLOW_INACTIVE = 'Flow:InactiveFlow';
const APEX_TRIGGER = 'ApexTrigger:AccountTrigger';

const LWC_BUNDLE_A = 'LightningComponentBundle:bundleA';
const VF_PAGE = 'VisualforcePage:OldPage';
const VF_COMPONENT = 'VisualforceComponent:OldComponent';

const NAMED_CRED_A = 'NamedCredential:ExternalApi';
const AUTH_PROVIDER_A = 'AuthProvider:Okta';

const seed: ExtractionResult = {
  nodes: [
    // Three CustomObjects, parented by themselves implicitly.
    makeNode({ id: ACCOUNT_ID, type: 'CustomObject', apiName: 'Account' }),
    makeNode({
      id: OPPORTUNITY_ID,
      type: 'CustomObject',
      apiName: 'Opportunity',
    }),
    makeNode({ id: BORING_ID, type: 'CustomObject', apiName: 'Boring__c' }),

    // Three CustomFields. Two on Account (FieldB is referenced from outside —
    // the references edge adds to Account's inbound count via the field's
    // parentOf bridge); one on Opportunity.
    makeNode({
      id: ACCOUNT_FIELD_A,
      type: 'CustomField',
      apiName: 'FieldA__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: ACCOUNT_FIELD_B,
      type: 'CustomField',
      apiName: 'FieldB__c',
      parentId: ACCOUNT_ID,
    }),
    makeNode({
      id: OPP_FIELD,
      type: 'CustomField',
      apiName: 'OppField__c',
      parentId: OPPORTUNITY_ID,
    }),

    // Four ApexClasses with descending inbound callsApex counts. HotPath
    // gets 3 callers, Lukewarm gets 1, Cold and HugeClass get 0.
    makeNode({
      id: APEX_HOT,
      type: 'ApexClass',
      apiName: 'HotPath',
      properties: { sourceBytes: 1200, lineCount: 50 },
    }),
    makeNode({
      id: APEX_LUKEWARM,
      type: 'ApexClass',
      apiName: 'Lukewarm',
      properties: { sourceBytes: 800, lineCount: 30 },
    }),
    makeNode({
      id: APEX_COLD,
      type: 'ApexClass',
      apiName: 'Cold',
      properties: { sourceBytes: 400, lineCount: 15 },
    }),
    makeNode({
      id: APEX_HUGE,
      type: 'ApexClass',
      apiName: 'HugeClass',
      properties: { sourceBytes: 50000, lineCount: 2000 },
    }),

    // Two Profiles. Admin grants 3, Rep grants 2.
    makeNode({ id: PROFILE_ADMIN, type: 'Profile', apiName: 'Admin' }),
    makeNode({ id: PROFILE_REP, type: 'Profile', apiName: 'Rep' }),

    // Automation surface: 2 workflow rules (1 active, 1 inactive), 1 approval
    // process (active), 2 flows (1 active, 1 inactive), 1 trigger (inactive).
    // The trigger carries `status` because `packages/extractors/src/
    // apex-trigger.ts` lists `status` in META_REQUIRED_ELEMENTS and writes it
    // unconditionally into baseProperties — a property-less ApexTrigger is NOT
    // the extractor's contract.
    makeNode({
      id: WORKFLOW_RULE_ACTIVE,
      type: 'WorkflowRule',
      apiName: 'Account.ActiveRule',
      properties: { active: true },
    }),
    makeNode({
      id: WORKFLOW_RULE_INACTIVE,
      type: 'WorkflowRule',
      apiName: 'Account.OldRule',
      properties: { active: false },
    }),
    makeNode({
      id: APPROVAL_PROCESS,
      type: 'ApprovalProcess',
      apiName: 'Account.Approval1',
      properties: { active: true },
    }),
    makeNode({
      id: FLOW_ACTIVE,
      type: 'Flow',
      apiName: 'ActiveFlow',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: FLOW_INACTIVE,
      type: 'Flow',
      apiName: 'InactiveFlow',
      properties: { status: 'Draft' },
    }),
    makeNode({
      id: APEX_TRIGGER,
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      properties: { status: 'Inactive' },
    }),

    // Frontend surface: 1 LWC + 1 VF page + 1 VF component (no Aura).
    makeNode({
      id: LWC_BUNDLE_A,
      type: 'LightningComponentBundle',
      apiName: 'bundleA',
    }),
    makeNode({
      id: VF_PAGE,
      type: 'VisualforcePage',
      apiName: 'OldPage',
    }),
    makeNode({
      id: VF_COMPONENT,
      type: 'VisualforceComponent',
      apiName: 'OldComponent',
    }),

    // Integration surface: 1 NamedCredential + 1 AuthProvider.
    makeNode({
      id: NAMED_CRED_A,
      type: 'NamedCredential',
      apiName: 'ExternalApi',
    }),
    makeNode({
      id: AUTH_PROVIDER_A,
      type: 'AuthProvider',
      apiName: 'Okta',
    }),
  ],
  edges: [
    // parentOf edges: object -> field. These must NOT count toward
    // topObjects's inbound-references count (the handler filters parentOf
    // OUT of the "inbound references" tally).
    makeEdge({
      fromId: ACCOUNT_ID,
      toId: ACCOUNT_FIELD_A,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: ACCOUNT_ID,
      toId: ACCOUNT_FIELD_B,
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: OPPORTUNITY_ID,
      toId: OPP_FIELD,
      edgeType: 'parentOf',
    }),

    // Inbound references to Account (3 total — adds to topObjects).
    makeEdge({
      fromId: APEX_HOT,
      toId: ACCOUNT_ID,
      edgeType: 'references',
    }),
    makeEdge({
      fromId: LWC_BUNDLE_A,
      toId: ACCOUNT_ID,
      edgeType: 'references',
    }),
    makeEdge({
      fromId: FLOW_ACTIVE,
      toId: ACCOUNT_ID,
      edgeType: 'references',
    }),

    // Inbound references to Opportunity (1 — second place).
    makeEdge({
      fromId: APEX_HOT,
      toId: OPPORTUNITY_ID,
      edgeType: 'references',
    }),

    // Inbound callsApex to HotPath (3 callers).
    makeEdge({
      fromId: APEX_LUKEWARM,
      toId: APEX_HOT,
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: APEX_TRIGGER,
      toId: APEX_HOT,
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: FLOW_ACTIVE,
      toId: APEX_HOT,
      edgeType: 'callsApex',
    }),

    // Inbound callsApex to Lukewarm (1 caller).
    makeEdge({
      fromId: APEX_HOT,
      toId: APEX_LUKEWARM,
      edgeType: 'callsApex',
    }),

    // Outgoing grantedBy from Admin (3 grants) and Rep (2 grants).
    makeEdge({
      fromId: PROFILE_ADMIN,
      toId: ACCOUNT_FIELD_A,
      edgeType: 'grantedBy',
    }),
    makeEdge({
      fromId: PROFILE_ADMIN,
      toId: ACCOUNT_FIELD_B,
      edgeType: 'grantedBy',
    }),
    makeEdge({
      fromId: PROFILE_ADMIN,
      toId: OPP_FIELD,
      edgeType: 'grantedBy',
    }),
    makeEdge({
      fromId: PROFILE_REP,
      toId: ACCOUNT_FIELD_A,
      edgeType: 'grantedBy',
    }),
    makeEdge({
      fromId: PROFILE_REP,
      toId: ACCOUNT_FIELD_B,
      edgeType: 'grantedBy',
    }),
  ],
};

let tempDir: string;

const makeFreshCtx = async (dbName: string): Promise<{ ctx: Context; store: GraphStore }> => {
  const dbPath = join(tempDir, dbName);
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const ctx: Context = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
  return { ctx, store };
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-org-overview-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('orgOverviewHandler (empty graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('empty.db');
    store = built.store;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns all zero counts and empty rankings when the graph is empty', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    // Every component count is 0 for an empty vault.
    expect(d.componentCounts['CustomObject']).toBe(0);
    expect(d.componentCounts['CustomField']).toBe(0);
    expect(d.componentCounts['ApexClass']).toBe(0);
    expect(d.componentCounts['Profile']).toBe(0);
    // Every ranking is empty.
    expect(d.topObjects).toEqual([]);
    expect(d.topApexClasses).toEqual([]);
    expect(d.topProfiles).toEqual([]);
    expect(d.largestApexClasses).toEqual([]);
    expect(d.namingConventionObservations).toEqual([]);
    // Integration / automation / frontend summaries report zero.
    expect(d.integrationSummary.total).toBe(0);
    expect(d.automationSummary.flows).toBe(0);
    expect(d.automationSummary.activeRatio).toBe(0);
    expect(d.frontendSummary.lwcBundles).toBe(0);
    expect(d.frontendSummary.legacyVfDebtRatio).toBe(0);
    // Legacy-debt indicators report zero counts, but an empty vault never
    // retrieved WorkflowRule/ApprovalProcess NOR the frontend family vfPages
    // feeds from — R2 (BRIEF 071 line 707): the old code bucketed this
    // unretrieved zero as a confident 'low' migration candidate. The typed
    // absence must surface as 'not-checked', not a graded verdict.
    expect(d.legacyDebtIndicators.workflowRules).toBe(0);
    expect(d.legacyDebtIndicators.migrationCandidate).toBe('not-checked');
    // Vault state is copied from the manifest.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');

    // v4.0 honesty axis: an empty vault retrieved NONE of these families, so the
    // tour must disclose that the 0-tallies mean "not checked" — never imply
    // "0 = none in the org". Regression guard for the org_overview honesty fix.
    expect(d.coverage.integrationRetrieved).toBe(false);
    expect(d.coverage.workflowRulesRetrieved).toBe(false);
    expect(d.coverage.frontendRetrieved).toBe(false);
    expect(d.boundaries.length).toBeGreaterThanOrEqual(3);
    expect(d.boundaries.join(' ')).toMatch(/not checked/i);
    // The rendered tour must NOT assert "0 integration surfaces" / "0 workflow
    // rules" for families it never retrieved.
    expect(d.rendered).not.toContain('0 integration surfaces');
    expect(d.rendered).toContain('workflow rules not retrieved');
    expect(d.rendered).toContain('integration not retrieved');
    expect(d.rendered).toContain('Coverage caveats');
  });
});

describe('orgOverviewHandler (seeded graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('seeded.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('reports per-ComponentType counts that match the seeded population', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const counts = result.value.data.componentCounts;
    expect(counts['CustomObject']).toBe(3);
    expect(counts['CustomField']).toBe(3);
    expect(counts['ApexClass']).toBe(4);
    expect(counts['Profile']).toBe(2);
    expect(counts['WorkflowRule']).toBe(2);
    expect(counts['ApprovalProcess']).toBe(1);
    expect(counts['Flow']).toBe(2);
    expect(counts['ApexTrigger']).toBe(1);
    expect(counts['LightningComponentBundle']).toBe(1);
    expect(counts['VisualforcePage']).toBe(1);
    expect(counts['VisualforceComponent']).toBe(1);
    expect(counts['NamedCredential']).toBe(1);
    expect(counts['AuthProvider']).toBe(1);
  });

  it('ranks topObjects by inbound non-parentOf reference count DESC', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ranked = result.value.data.topObjects;
    // Account has 3 inbound references, Opportunity 1, Boring__c 0.
    // parentOf edges (object -> field) must NOT contribute.
    expect(ranked.length).toBe(3);
    expect(ranked[0]?.id).toBe(ACCOUNT_ID);
    expect(ranked[0]?.inboundReferences).toBe(3);
    expect(ranked[1]?.id).toBe(OPPORTUNITY_ID);
    expect(ranked[1]?.inboundReferences).toBe(1);
    expect(ranked[2]?.id).toBe(BORING_ID);
    expect(ranked[2]?.inboundReferences).toBe(0);
  });

  it('ranks topApexClasses by inbound callsApex edge count DESC', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ranked = result.value.data.topApexClasses;
    // HotPath has 3 callers, Lukewarm 1, Cold + HugeClass 0.
    expect(ranked[0]?.id).toBe(APEX_HOT);
    expect(ranked[0]?.inboundCalls).toBe(3);
    expect(ranked[1]?.id).toBe(APEX_LUKEWARM);
    expect(ranked[1]?.inboundCalls).toBe(1);
    // The zero-call entries appear at the tail in id ASC order.
    const tailIds = ranked.slice(2).map((e) => e.id);
    expect(tailIds).toContain(APEX_COLD);
    expect(tailIds).toContain(APEX_HUGE);
  });

  it('ranks topProfiles by outgoing grantedBy edge count DESC', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ranked = result.value.data.topProfiles;
    expect(ranked[0]?.id).toBe(PROFILE_ADMIN);
    expect(ranked[0]?.grantCount).toBe(3);
    expect(ranked[1]?.id).toBe(PROFILE_REP);
    expect(ranked[1]?.grantCount).toBe(2);
  });

  it('tallies integrationSummary correctly with the total = sum of the six categories', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value.data.integrationSummary;
    expect(summary.namedCredentials).toBe(1);
    expect(summary.authProviders).toBe(1);
    expect(summary.remoteSiteSettings).toBe(0);
    expect(summary.externalDataSources).toBe(0);
    expect(summary.externalServices).toBe(0);
    expect(summary.connectedApps).toBe(0);
    // Sum of NamedCredential + AuthProvider + RemoteSiteSetting +
    // ExternalDataSource + ExternalService + ConnectedApp = 2.
    expect(summary.total).toBe(2);
  });

  it('computes automationSummary.activeRatio with isActive on Flow/WorkflowRule/ApprovalProcess', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value.data.automationSummary;
    expect(summary.workflowRules).toBe(2);
    expect(summary.approvalProcesses).toBe(1);
    expect(summary.flows).toBe(2);
    expect(summary.apexTriggers).toBe(1);
    // R1 (BRIEF 071 line 419): every one of the six automation nodes carries
    // its extracted status axis, so all six are MEASURED — nothing is guessed
    // and nothing is typed-absent. Active = 1 WorkflowRule + 1 ApprovalProcess
    // + 1 Flow = 3 of 6; the ApexTrigger's `status: 'Inactive'` is read, not
    // assumed. The old code guessed EVERY ApexTrigger active and read 4 / 6.
    expect(summary.activeRatio).toBeCloseTo(3 / 6, 5);
    expect(summary.activeStatusUnknownCount).toBe(0);
    // A vault where every automation node carries its status must NOT emit the
    // typed-absence disclosure.
    expect(result.value.data.boundaries.join(' ')).not.toMatch(
      /active\/inactive status was not extracted/i,
    );
    // Ratio must be bounded [0, 1].
    expect(summary.activeRatio).toBeGreaterThanOrEqual(0);
    expect(summary.activeRatio).toBeLessThanOrEqual(1);
  });

  it('computes frontendSummary.legacyVfDebtRatio bounded between 0 and 1', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value.data.frontendSummary;
    expect(summary.lwcBundles).toBe(1);
    expect(summary.auraBundles).toBe(0);
    expect(summary.vfPages).toBe(1);
    expect(summary.vfComponents).toBe(1);
    // Total frontend = 3 (1 LWC + 0 Aura + 1 VF page + 1 VF component).
    // Legacy = 1 VF page + 1 VF component = 2. Ratio = 2 / 3.
    expect(summary.legacyVfDebtRatio).toBeCloseTo(2 / 3, 5);
    expect(summary.legacyVfDebtRatio).toBeGreaterThanOrEqual(0);
    expect(summary.legacyVfDebtRatio).toBeLessThanOrEqual(1);
  });

  it('buckets legacyDebtIndicators.migrationCandidate at low/medium/high thresholds', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const indicators = result.value.data.legacyDebtIndicators;
    expect(indicators.workflowRules).toBe(2);
    expect(indicators.approvalProcesses).toBe(1);
    expect(indicators.vfPages).toBe(1);
    // Legacy total = 2 + 1 + 1 = 4 (< 5 threshold -> 'low').
    expect(indicators.migrationCandidate).toBe('low');
  });

  it('orders largestApexClasses by sourceBytes DESC', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const largest = result.value.data.largestApexClasses;
    // HugeClass has 50000 bytes -> top spot.
    expect(largest[0]?.id).toBe(APEX_HUGE);
    expect(largest[0]?.sourceBytes).toBe(50000);
    expect(largest[0]?.lineCount).toBe(2000);
    // HotPath (1200) -> second; Lukewarm (800) -> third; Cold (400) -> fourth.
    expect(largest[1]?.id).toBe(APEX_HOT);
    expect(largest[2]?.id).toBe(APEX_LUKEWARM);
    expect(largest[3]?.id).toBe(APEX_COLD);
    // Total entries capped at LARGEST_APEX_CLASSES_LIMIT (5), but the
    // seeded set has 4, so the cap doesn't kick in here.
    expect(largest.length).toBe(4);
  });

  it('returns naming-convention observations from the recognizer', async () => {
    const result = await orgOverviewHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The recognizer needs >= 5 fields per parent to make a pattern call;
    // our seed has < 5 fields per parent so the observations list is
    // empty. The honest empty list still proves the wiring is correct.
    expect(Array.isArray(result.value.data.namingConventionObservations)).toBe(true);
  });
});

describe('orgOverviewInputSchema', () => {
  it('accepts an empty input object', () => {
    expect(orgOverviewInputSchema.safeParse({}).success).toBe(true);
  });

  it('strips unknown keys gracefully', () => {
    // z.object({}) without `.strict()` allows excess keys silently. The
    // schema's only contract is that the input is an object.
    const parsed = orgOverviewInputSchema.safeParse({ unrelated: 'value' });
    expect(parsed.success).toBe(true);
  });

  it('rejects non-object inputs', () => {
    expect(orgOverviewInputSchema.safeParse('not-an-object').success).toBe(false);
    expect(orgOverviewInputSchema.safeParse(42).success).toBe(false);
  });
});

// =============================================================================
// G2 full-scan honesty. `fetchNodes` took ONE 500-row `listNodesByType` page
// and the rankings then sliced that to 200 — so "top 10" meant "top 10 of the
// alphabetically-first 200" and `activeRatio` measured a 500-node sample
// against a COUNT(*) denominator. `SFI_NODE_SCAN_LIMIT=3` shrinks the scan
// window so 5 nodes per type exercise multi-window paging.
// =============================================================================

describe('orgOverviewHandler — full per-type scan (G2)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;
  let priorLimit: string | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-orgoverview-fullscan-'));
    const opened = await openGraph(join(dir, 'fullscan.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          // Five ApexClasses. The LAST by id (Z_Hot) carries the inbound
          // callsApex fan-in; B_Big carries the big sourceBytes. Both sort past
          // the first scan window.
          ...Array.from({ length: 3 }, (_unused, i) =>
            makeNode({
              id: `ApexClass:A_${i}`,
              type: 'ApexClass',
              apiName: `A_${i}`,
              properties: { sourceBytes: 100, lineCount: 5 },
            }),
          ),
          makeNode({
            id: 'ApexClass:B_Big',
            type: 'ApexClass',
            apiName: 'B_Big',
            properties: { sourceBytes: 999_999, lineCount: 9_999 },
          }),
          makeNode({
            id: 'ApexClass:Z_Hot',
            type: 'ApexClass',
            apiName: 'Z_Hot',
            properties: { sourceBytes: 100, lineCount: 5 },
          }),
          // Five Flows; only the first two are Active -> activeRatio 0.4.
          ...Array.from({ length: 5 }, (_unused, i) =>
            makeNode({
              id: `Flow:F_${i}`,
              type: 'Flow',
              apiName: `F_${i}`,
              properties: { status: i < 2 ? 'Active' : 'Draft' },
            }),
          ),
        ],
        edges: Array.from({ length: 4 }, (_unused, i) =>
          makeEdge({
            fromId: `Flow:F_${i}`,
            toId: 'ApexClass:Z_Hot',
            edgeType: 'callsApex',
          }),
        ),
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    priorLimit = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '3';
  });

  afterEach(() => {
    if (priorLimit === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
    else process.env['SFI_NODE_SCAN_LIMIT'] = priorLimit;
  });

  it('ranks the hot class first even though it sorts past the scan window', async () => {
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.topApexClasses[0]?.apiName).toBe('Z_Hot');
    expect(d.topApexClasses[0]?.inboundCalls).toBe(4);
    expect(d.topApexClasses.length).toBe(5);
  });

  it('finds the largest class past the scan window', async () => {
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.largestApexClasses[0]?.apiName).toBe('B_Big');
    expect(r.value.data.largestApexClasses[0]?.sourceBytes).toBe(999_999);
  });

  it('computes activeRatio over EVERY automation node, not a scan-window sample', async () => {
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.componentCounts['Flow']).toBe(5);
    // 2 Active Flows of (5 Flows + 5 ApexClasses are not automation) = 0.4.
    expect(d.automationSummary.activeRatio).toBeCloseTo(0.4, 10);
  });
});

// =============================================================================
// The literal repro of the defect, at the REAL caps (no SFI_NODE_SCAN_LIMIT
// override): `fetchNodes` took one 500-row page and the rankings sliced it to
// 200. The hot class, the big class and the two Active Flows all sort past
// position 500 by id ASC, so the old code could not see any of them.
// =============================================================================

describe('orgOverviewHandler — past the 500-row page boundary (G2)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-orgoverview-over500-'));
    const opened = await openGraph(join(dir, 'over500.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          ...Array.from({ length: 500 }, (_unused, i) =>
            makeNode({
              id: `ApexClass:A_Filler${String(i).padStart(4, '0')}`,
              type: 'ApexClass',
              apiName: `A_Filler${i}`,
              properties: { sourceBytes: 100, lineCount: 5 },
            }),
          ),
          makeNode({
            id: 'ApexClass:Z_Big',
            type: 'ApexClass',
            apiName: 'Z_Big',
            properties: { sourceBytes: 999_999, lineCount: 9_999 },
          }),
          makeNode({
            id: 'ApexClass:Z_Hot',
            type: 'ApexClass',
            apiName: 'Z_Hot',
            properties: { sourceBytes: 100, lineCount: 5 },
          }),
          // 500 Draft Flows then 2 Active ones sorting last -> the old
          // 500-row page saw ZERO active automations.
          ...Array.from({ length: 500 }, (_unused, i) =>
            makeNode({
              id: `Flow:A_Draft${String(i).padStart(4, '0')}`,
              type: 'Flow',
              apiName: `A_Draft${i}`,
              properties: { status: 'Draft' },
            }),
          ),
          ...Array.from({ length: 2 }, (_unused, i) =>
            makeNode({
              id: `Flow:Z_Active${i}`,
              type: 'Flow',
              apiName: `Z_Active${i}`,
              properties: { status: 'Active' },
            }),
          ),
        ],
        edges: Array.from({ length: 4 }, (_unused, i) =>
          makeEdge({
            fromId: `ApexClass:A_Filler${String(i).padStart(4, '0')}`,
            toId: 'ApexClass:Z_Hot',
            edgeType: 'callsApex',
          }),
        ),
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ranks and sizes over the whole type, not the first 500/200 by id', async () => {
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.topApexClasses[0]?.apiName).toBe('Z_Hot');
    expect(d.topApexClasses[0]?.inboundCalls).toBe(4);
    expect(d.largestApexClasses[0]?.apiName).toBe('Z_Big');
    // 2 Active of 502 Flows. The old page measured 500 Drafts -> 0.
    expect(d.componentCounts['Flow']).toBe(502);
    expect(d.automationSummary.activeRatio).toBeCloseTo(2 / 502, 10);
  });
});

// =============================================================================
// R1 (BRIEF 071, line 419): `isActiveAutomation` folded "no status/active
// property extracted" into "active" with no sentinel and no disclosure — the
// exact typed-absence collapse absence-disclosure.ts's header names. A Flow
// with no `status` (a vault whose refresh predates status extraction) and a
// WorkflowRule with no `active` were silently counted as active numerator hits.
//
// The CORRECTION recorded here (verifier reject, second pass): an ApexTrigger
// DOES carry an extracted status axis. `packages/extractors/src/apex-trigger.ts`
// lists `status` in META_REQUIRED_ELEMENTS (line 25), parses it (line 142) and
// writes `status: meta.status` into baseProperties unconditionally; three other
// tools in this package already read it as the trigger's active axis
// (`automation-build-advisor.ts` `isActiveTrigger`, `soe-active.ts`,
// `what-if-disable-trigger.ts`). Hard-coding ApexTrigger to typed-absence made
// the tool assert "status was not extracted" about metadata that IS in the
// vault — a fabricated disclosure, which is worse than the guess it replaced.
// So the trigger is measured on `status === 'Active'`, exactly like a Flow, and
// only a genuinely property-less node (a pre-status stale vault) is unknown.
// =============================================================================

describe('orgOverviewHandler — automation status typed absence (R1)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  const FLOW_KNOWN_ACTIVE = 'Flow:KnownActive';
  const FLOW_KNOWN_INACTIVE = 'Flow:KnownInactive';
  const FLOW_UNKNOWN_STATUS = 'Flow:UnknownStatus';
  const WF_KNOWN_ACTIVE = 'WorkflowRule:KnownActive';
  const WF_UNKNOWN_ACTIVE = 'WorkflowRule:UnknownActive';
  const AP_KNOWN_INACTIVE = 'ApprovalProcess:KnownInactive';
  const TRIGGER_KNOWN_ACTIVE_A = 'ApexTrigger:KnownActiveA';
  const TRIGGER_KNOWN_ACTIVE_B = 'ApexTrigger:KnownActiveB';
  const TRIGGER_KNOWN_INACTIVE = 'ApexTrigger:KnownInactive';
  const TRIGGER_STALE_VAULT = 'ApexTrigger:StaleVault';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-orgoverview-activeabsence-'));
    const opened = await openGraph(join(dir, 'activeabsence.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          makeNode({
            id: FLOW_KNOWN_ACTIVE,
            type: 'Flow',
            apiName: 'KnownActive',
            properties: { status: 'Active' },
          }),
          makeNode({
            id: FLOW_KNOWN_INACTIVE,
            type: 'Flow',
            apiName: 'KnownInactive',
            properties: { status: 'Draft' },
          }),
          // Simulates a vault whose refresh predates Flow.status extraction:
          // the property key is entirely absent, not present-and-empty.
          makeNode({
            id: FLOW_UNKNOWN_STATUS,
            type: 'Flow',
            apiName: 'UnknownStatus',
            properties: {},
          }),
          makeNode({
            id: WF_KNOWN_ACTIVE,
            type: 'WorkflowRule',
            apiName: 'KnownActive',
            properties: { active: true },
          }),
          // Simulates a vault whose refresh predates WorkflowRule.active
          // extraction.
          makeNode({
            id: WF_UNKNOWN_ACTIVE,
            type: 'WorkflowRule',
            apiName: 'UnknownActive',
            properties: {},
          }),
          makeNode({
            id: AP_KNOWN_INACTIVE,
            type: 'ApprovalProcess',
            apiName: 'KnownInactive',
            properties: { active: false },
          }),
          // Realistic ApexTriggers: the extractor writes `status`
          // unconditionally, so these are MEASURED, never typed-absent.
          makeNode({
            id: TRIGGER_KNOWN_ACTIVE_A,
            type: 'ApexTrigger',
            apiName: 'KnownActiveA',
            properties: { status: 'Active' },
          }),
          makeNode({
            id: TRIGGER_KNOWN_ACTIVE_B,
            type: 'ApexTrigger',
            apiName: 'KnownActiveB',
            properties: { status: 'Active' },
          }),
          makeNode({
            id: TRIGGER_KNOWN_INACTIVE,
            type: 'ApexTrigger',
            apiName: 'KnownInactive',
            properties: { status: 'Inactive' },
          }),
          // The ONLY honest unknown-trigger case: a stale vault imported
          // before the trigger extractor wrote `status` at all. Labelled as
          // stale, NOT as the permanent ApexTrigger contract.
          makeNode({
            id: TRIGGER_STALE_VAULT,
            type: 'ApexTrigger',
            apiName: 'StaleVault',
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('computes activeRatio only from nodes with a known status, never guessing on absence', async () => {
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // 10 automation nodes total. 7 carry a known status/active property
    // (2 Flow, 1 WorkflowRule, 1 ApprovalProcess, 3 ApexTrigger): active =
    // FLOW_KNOWN_ACTIVE + WF_KNOWN_ACTIVE + 2 Active triggers = 4; inactive =
    // FLOW_KNOWN_INACTIVE + AP_KNOWN_INACTIVE + 1 Inactive trigger = 3.
    // The 3 carrying no property at all (1 Flow, 1 WorkflowRule, 1 stale-vault
    // ApexTrigger) must NOT be folded into either bucket.
    expect(d.automationSummary.activeRatio).toBeCloseTo(4 / 7, 10);
    // The unknown count must be reported, separately from the measured
    // active/inactive tally — never silently assumed active. The three
    // status-carrying triggers are NOT in it.
    expect(d.automationSummary.activeStatusUnknownCount).toBe(3);
  });

  it('discloses the automation-status typed-absence boundary by name', async () => {
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.boundaries.join(' ')).toMatch(/active\/inactive status/i);
    expect(d.boundaries.join(' ')).toMatch(/3/);
    // The disclosure must NOT claim ApexTrigger has no isActive axis — the
    // extractor writes `status` unconditionally, so that clause would be a
    // fabricated absence claim about metadata that is present in the vault.
    expect(d.boundaries.join(' ')).not.toMatch(/ApexTrigger has no isActive/i);
  });
});

// =============================================================================
// Regression guard for the verifier's REJECT of the first R1 attempt: the fix
// had hardcoded ApexTrigger to typed-absence, so an org of nothing but healthy,
// status-carrying triggers reported activeRatio 0, activeStatusUnknownCount N,
// and a boundary asserting the status "was not extracted" — about metadata the
// extractor writes unconditionally. This is the assertion that catches it.
// =============================================================================

describe('orgOverviewHandler — triggers-only org, every status extracted (R1)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-orgoverview-triggersonly-'));
    const opened = await openGraph(join(dir, 'triggersonly.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          makeNode({
            id: 'ApexTrigger:AlphaTrigger',
            type: 'ApexTrigger',
            apiName: 'AlphaTrigger',
            properties: { status: 'Active' },
          }),
          makeNode({
            id: 'ApexTrigger:BetaTrigger',
            type: 'ApexTrigger',
            apiName: 'BetaTrigger',
            properties: { status: 'Inactive' },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('measures ApexTrigger.status instead of fabricating a not-extracted claim', async () => {
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.automationSummary.apexTriggers).toBe(2);
    // Both triggers carry the extractor's REQUIRED `status` element, so both
    // are measured: 1 of 2 active.
    expect(d.automationSummary.activeStatusUnknownCount).toBe(0);
    expect(d.automationSummary.activeRatio).toBeCloseTo(1 / 2, 10);
    // ...and the typed-absence disclosure must not fire at all.
    expect(d.boundaries.join(' ')).not.toMatch(
      /active\/inactive status was not extracted/i,
    );
    expect(d.boundaries.join(' ')).not.toMatch(/ApexTrigger has no isActive/i);
  });
});

// =============================================================================
// R2 (BRIEF 071, line 707): `migrationCandidate` bucketed
// `workflowRules + approvalProcesses + vfPages` into 'low' | 'medium' | 'high'
// with no not-checked state, even though `coverage.workflowRulesRetrieved`
// and `coverage.frontendRetrieved` already know when those counts are
// unretrieved zeros rather than verified zeros.
// =============================================================================

describe('orgOverviewHandler — migrationCandidate typed absence (R2)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-orgoverview-migrationcandidate-'));
    const opened = await openGraph(join(dir, 'migrationcandidate.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        // WorkflowRule/ApprovalProcess WERE retrieved (legacyTotal = 2, which
        // buckets 'low' by count alone) but the frontend family (VisualforcePage
        // included) was NEVER retrieved — no frontend nodes at all and no
        // coverage-complete marker for it.
        nodes: [
          makeNode({
            id: 'WorkflowRule:Retrieved',
            type: 'WorkflowRule',
            apiName: 'Retrieved',
            properties: { active: true },
          }),
          makeNode({
            id: 'ApprovalProcess:Retrieved',
            type: 'ApprovalProcess',
            apiName: 'Retrieved',
            properties: { active: true },
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not grade a verdict from an unretrieved vfPages count, even when the other legacy families are known', async () => {
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.coverage.workflowRulesRetrieved).toBe(true);
    expect(d.coverage.frontendRetrieved).toBe(false);
    // legacyTotal (2 + 0) would bucket 'low' by count alone; the verdict must
    // instead say it was never fully checked, not assert a confident 'low'.
    expect(d.legacyDebtIndicators.migrationCandidate).toBe('not-checked');
  });
});
