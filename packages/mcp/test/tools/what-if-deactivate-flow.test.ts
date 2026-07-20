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
  whatIfDeactivateFlowHandler,
  whatIfDeactivateFlowInputSchema,
} from '../../src/tools/what-if-deactivate-flow.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    CustomField: 1,
    Flow: 2,
    ApexClass: 1,
    EmailTemplate: 1,
    ConditionalContext: 1,
  },
  edges: {
    triggersOn: 2,
    callsApex: 1,
    writesTo: 1,
    readsFrom: 1,
    sendsEmail: 1,
    firesWhen: 1,
  },
  sourceTreeHash: 'sha256:fixture',
  coverageComputedAt: '2026-05-29T12:00:00.000Z',
  coverage: ['Flow', 'ApexClass', 'CustomObject', 'EmailTemplate'].map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
  })),
};

/** Default node-shape helper. Caller overrides id/type/apiName/etc. */
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

/** Default edge-shape helper. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'parsed',
  source: 'flow-extractor',
  properties: {},
  ...overrides,
});

// =============================================================================
// Suite 1: rich-impact Flow. The Flow has every outgoing edge type the
// composer recognises — triggersOn to an SObject, callsApex to a class,
// writesTo + readsFrom to fields, sendsEmail to a template, plus a
// firesWhen ConditionalContext gating the trigger. Verifies that every
// edge surfaces as an impact (or as the firingConditions list for
// firesWhen) and that the aggregate verdict is `blocking`.
// =============================================================================

const FLOW_RICH_ID = 'Flow:AccountNotify';
const ACCOUNT_OBJ = 'CustomObject:Account';
const APEX_CLS = 'ApexClass:NotificationService';
const FIELD_INDUSTRY = 'CustomField:Account.Industry__c';
const FIELD_REVENUE = 'CustomField:Account.AnnualRevenue';
const EMAIL_TPL = 'EmailTemplate:WelcomeEmail';
const COND_CTX = 'ConditionalContext:Flow:AccountNotify.condition-1';

const richSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_RICH_ID,
      type: 'Flow',
      apiName: 'AccountNotify',
      properties: { status: 'Active', triggerType: 'RecordAfterSave' },
    }),
    makeNode({
      id: ACCOUNT_OBJ,
      type: 'CustomObject',
      apiName: 'Account',
    }),
    makeNode({
      id: APEX_CLS,
      type: 'ApexClass',
      apiName: 'NotificationService',
    }),
    makeNode({
      id: FIELD_INDUSTRY,
      type: 'CustomField',
      apiName: 'Industry__c',
    }),
    makeNode({
      id: FIELD_REVENUE,
      type: 'CustomField',
      apiName: 'AnnualRevenue',
    }),
    makeNode({
      id: EMAIL_TPL,
      type: 'EmailTemplate',
      apiName: 'WelcomeEmail',
    }),
    makeNode({
      id: COND_CTX,
      type: 'ConditionalContext',
      apiName: 'Flow:AccountNotify.condition-1',
      properties: {
        expression: "Industry__c == 'Tech'",
        kind: 'flow-recordtrigger',
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: ACCOUNT_OBJ,
      edgeType: 'triggersOn',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: APEX_CLS,
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: FIELD_INDUSTRY,
      edgeType: 'readsFrom',
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: FIELD_REVENUE,
      edgeType: 'writesTo',
      properties: { operation: 'recordUpdate' },
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: EMAIL_TPL,
      edgeType: 'sendsEmail',
      confidence: 'declared',
    }),
    makeEdge({
      fromId: FLOW_RICH_ID,
      toId: COND_CTX,
      edgeType: 'firesWhen',
      confidence: 'declared',
    }),
  ],
};

// =============================================================================
// Suite 2: bare Flow. No outgoing edges except triggersOn. Surfaces the
// callsApex-only `risky` verdict path when only callsApex is present.
// =============================================================================

const FLOW_BARE_ID = 'Flow:AccountBareCall';
const APEX_BARE = 'ApexClass:UtilService';

const bareSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_BARE_ID,
      type: 'Flow',
      apiName: 'AccountBareCall',
      properties: { status: 'Draft' },
    }),
    makeNode({
      id: APEX_BARE,
      type: 'ApexClass',
      apiName: 'UtilService',
    }),
  ],
  edges: [
    makeEdge({
      fromId: FLOW_BARE_ID,
      toId: APEX_BARE,
      edgeType: 'callsApex',
    }),
  ],
};

// =============================================================================
// Suite 3: empty Flow — exists but has no outgoing edges. Surfaces the
// `safe` verdict path.
// =============================================================================

const FLOW_EMPTY_ID = 'Flow:EmptyFlow';

const emptySeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_EMPTY_ID,
      type: 'Flow',
      apiName: 'EmptyFlow',
      properties: { status: 'Active' },
    }),
  ],
  edges: [],
};

// =============================================================================
// Suite 4 (bug 15): platform-event publish → subscribe. A publisher flow
// writes the event; a subscriber flow listens to it. Deactivating the
// publisher must surface the subscriber (one hop past the event object).
// =============================================================================

const FLOW_PUBLISHER_ID = 'Flow:EventPublisher';
const EVENT_OBJ = 'CustomObject:Order_Event__e';
const FLOW_SUBSCRIBER_ID = 'Flow:EventSubscriber';

const platformEventSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FLOW_PUBLISHER_ID,
      type: 'Flow',
      apiName: 'EventPublisher',
      properties: { status: 'Active' },
    }),
    makeNode({ id: EVENT_OBJ, type: 'CustomObject', apiName: 'Order_Event__e' }),
    makeNode({
      id: FLOW_SUBSCRIBER_ID,
      type: 'Flow',
      apiName: 'EventSubscriber',
      properties: { status: 'Active' },
    }),
  ],
  edges: [
    makeEdge({ fromId: FLOW_PUBLISHER_ID, toId: EVENT_OBJ, edgeType: 'writesTo' }),
    makeEdge({ fromId: FLOW_SUBSCRIBER_ID, toId: EVENT_OBJ, edgeType: 'listensTo' }),
  ],
};

// =============================================================================
// Suite 5 (R6-02): subflow broken callers. A subflow with NO outgoing edges
// would read `safe` to deactivate — the false-"safe" the R6 audit flagged. With
// incoming `references` (referenceKind: 'subflow') edges from parent flows, the
// parents are BROKEN CALLERS on deactivation. An ACTIVE parent flips the verdict
// to `blocking`; an inactive-only parent set surfaces the callers but stops at
// `risky`. A non-subflow incoming `references` (e.g. a FlexiPage embedding the
// flow) is NOT a broken caller — only referenceKind 'subflow' counts.
// =============================================================================

const SUBFLOW_ACTIVE_PARENTS_ID = 'Flow:SharedSubflow';
const PARENT_ACTIVE_1_ID = 'Flow:ParentActiveA';
const PARENT_ACTIVE_2_ID = 'Flow:ParentActiveB';
const FLEXIPAGE_EMBED_ID = 'FlexiPage:HomePage';

const subflowActiveParentsSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: SUBFLOW_ACTIVE_PARENTS_ID,
      type: 'Flow',
      apiName: 'SharedSubflow',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: PARENT_ACTIVE_1_ID,
      type: 'Flow',
      apiName: 'ParentActiveA',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: PARENT_ACTIVE_2_ID,
      type: 'Flow',
      apiName: 'ParentActiveB',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: FLEXIPAGE_EMBED_ID,
      type: 'FlexiPage',
      apiName: 'HomePage',
      properties: {},
    }),
  ],
  edges: [
    makeEdge({
      fromId: PARENT_ACTIVE_1_ID,
      toId: SUBFLOW_ACTIVE_PARENTS_ID,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'subflow', subflowElementName: 'Call_A' },
    }),
    makeEdge({
      fromId: PARENT_ACTIVE_2_ID,
      toId: SUBFLOW_ACTIVE_PARENTS_ID,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'subflow', subflowElementName: 'Call_B' },
    }),
    // A FlexiPage that embeds the flow — an incoming `references` with a
    // NON-subflow referenceKind. Must NOT be counted as a broken caller.
    makeEdge({
      fromId: FLEXIPAGE_EMBED_ID,
      toId: SUBFLOW_ACTIVE_PARENTS_ID,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'flexiPageComponent' },
    }),
  ],
};

const SUBFLOW_OBSOLETE_PARENT_ID = 'Flow:SubflowObsoleteOnly';
const PARENT_OBSOLETE_ID = 'Flow:ParentObsolete';

const subflowObsoleteParentSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: SUBFLOW_OBSOLETE_PARENT_ID,
      type: 'Flow',
      apiName: 'SubflowObsoleteOnly',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: PARENT_OBSOLETE_ID,
      type: 'Flow',
      apiName: 'ParentObsolete',
      properties: { status: 'Obsolete' },
    }),
  ],
  edges: [
    makeEdge({
      fromId: PARENT_OBSOLETE_ID,
      toId: SUBFLOW_OBSOLETE_PARENT_ID,
      edgeType: 'references',
      confidence: 'declared',
      properties: { referenceKind: 'subflow', subflowElementName: 'Call_Old' },
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-what-if-deactivate-flow-'));
  const dbPath = join(tempDir, 'wid.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    richSeed,
    bareSeed,
    emptySeed,
    platformEventSeed,
    subflowActiveParentsSeed,
    subflowObsoleteParentSeed,
  ]);
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

describe('whatIfDeactivateFlowHandler', () => {
  it('surfaces platform-event subscribers when the flow publishes the event (bug 15)', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_PUBLISHER_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sub = result.value.data.impacts.find(
      (i) => i.componentId === FLOW_SUBSCRIBER_ID,
    );
    expect(sub).toBeDefined();
    expect(sub?.category).toBe('metadata-blocker');
    expect(sub?.explanation).toContain('platform event');
  });

  it('emits one impact per recognised outgoing edge type for a rich Flow', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.flowId).toBe(FLOW_RICH_ID);
    expect(data.apiName).toBe('AccountNotify');
    expect(data.status).toBe('Active');
    // Five impacts: triggersOn, callsApex, readsFrom, writesTo, sendsEmail.
    // firesWhen is surfaced via `firingConditions`, NOT impacts.
    expect(data.impacts.length).toBe(5);
    const ids = data.impacts.map((i) => i.componentId).sort();
    expect(ids).toEqual(
      [
        ACCOUNT_OBJ,
        APEX_CLS,
        EMAIL_TPL,
        FIELD_INDUSTRY,
        FIELD_REVENUE,
      ].sort(),
    );
  });

  it('surfaces firesWhen edges as firingConditions, not as impacts', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.firingConditions.length).toBe(1);
    expect(data.firingConditions[0]?.conditionContextId).toBe(COND_CTX);
    expect(data.firingConditions[0]?.expression).toBe("Industry__c == 'Tech'");
    // None of the impacts should be the ConditionalContext.
    for (const impact of data.impacts) {
      expect(impact.componentId).not.toBe(COND_CTX);
    }
  });

  it('classifies the impact categories per the rule table', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    const byId = new Map(data.impacts.map((i) => [i.componentId, i]));
    // triggersOn → metadata-blocker
    expect(byId.get(ACCOUNT_OBJ)?.category).toBe('metadata-blocker');
    // writesTo → metadata-blocker
    expect(byId.get(FIELD_REVENUE)?.category).toBe('metadata-blocker');
    // readsFrom → metadata-blocker
    expect(byId.get(FIELD_INDUSTRY)?.category).toBe('metadata-blocker');
    // sendsEmail → metadata-blocker
    expect(byId.get(EMAIL_TPL)?.category).toBe('metadata-blocker');
    // callsApex → code-needs-update
    expect(byId.get(APEX_CLS)?.category).toBe('code-needs-update');
  });

  it('aggregates verdict to `blocking` when any metadata-blocker impact exists', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.verdict).toBe('blocking');
  });

  it('aggregates verdict to `risky` when only callsApex impacts exist', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_BARE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.impacts.length).toBe(1);
    expect(result.value.data.impacts[0]?.category).toBe('code-needs-update');
    expect(result.value.data.verdict).toBe('risky');
  });

  it('aggregates verdict to `safe` when the Flow has no outgoing edges', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_EMPTY_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.impacts.length).toBe(0);
    expect(result.value.data.firingConditions.length).toBe(0);
    expect(result.value.data.verdict).toBe('safe');
  });

  it('sorts impacts deterministically by (category, componentId)', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Sort key: category ASC, then componentId ASC. code-needs-update
    // comes before metadata-blocker alphabetically.
    const sorted = [...data.impacts].sort((a, b) => {
      if (a.category !== b.category) return a.category < b.category ? -1 : 1;
      if (a.componentId !== b.componentId) {
        return a.componentId < b.componentId ? -1 : 1;
      }
      return 0;
    });
    expect(data.impacts.map((i) => i.componentId)).toEqual(
      sorted.map((i) => i.componentId),
    );
    // code-needs-update items appear before metadata-blocker.
    const codeFirstIdx = data.impacts.findIndex(
      (i) => i.category === 'code-needs-update',
    );
    const blockerFirstIdx = data.impacts.findIndex(
      (i) => i.category === 'metadata-blocker',
    );
    expect(codeFirstIdx).toBeLessThan(blockerFirstIdx);
  });

  it('returns invalid-query for a non-Flow prefix', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: 'ApexClass:NotAFlow',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for a well-formed but unknown flowId', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: 'Flow:NoSuchFlow',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('emits the verbatim honesty-axis disclosure', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('v2.3 what-if analysis');
    expect(result.value.data.disclosure).toContain('Flow.Interview');
    expect(result.value.data.disclosure).toContain('@InvocableMethod');
  });

  it('echoes the manifest vaultState into the response envelope', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-28T10:00:00Z');
  });

  // ---------------------------------------------------------------------------
  // R6-02: subflow broken callers (the incoming side).
  // ---------------------------------------------------------------------------

  it('flips a would-be-safe subflow to `blocking` when an ACTIVE parent calls it', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: SUBFLOW_ACTIVE_PARENTS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // The subflow has NO outgoing edges — pre-R6-02 this read `safe`.
    expect(data.verdict).toBe('blocking');
    const brokenCallers = data.impacts.filter(
      (i) => i.category === 'broken-caller',
    );
    const ids = brokenCallers.map((i) => i.componentId).sort();
    expect(ids).toEqual([PARENT_ACTIVE_1_ID, PARENT_ACTIVE_2_ID].sort());
    for (const bc of brokenCallers) {
      expect(bc.componentType).toBe('Flow');
      expect(bc.confidence).toBe('declared');
      expect(bc.explanation.toLowerCase()).toContain('subflow');
    }
  });

  it('does NOT count a non-subflow incoming reference (FlexiPage) as a broken caller', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: SUBFLOW_ACTIVE_PARENTS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.impacts.map((i) => i.componentId);
    expect(ids).not.toContain(FLEXIPAGE_EMBED_ID);
  });

  it('surfaces an obsolete-only parent as a broken caller but stops at `risky` (not blocking)', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: SUBFLOW_OBSOLETE_PARENT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    const brokenCallers = data.impacts.filter(
      (i) => i.category === 'broken-caller',
    );
    expect(brokenCallers.map((i) => i.componentId)).toEqual([
      PARENT_OBSOLETE_ID,
    ]);
    // The caller is surfaced (transparency) but its Obsolete status means the
    // subflow is not currently invoked at runtime — verdict is `risky`, not
    // `blocking`.
    expect(data.verdict).toBe('risky');
    expect(brokenCallers[0]?.explanation).toContain('Obsolete');
  });

  it('surfaces the OUTGOING subflow call as a metadata-blocker when a parent is deactivated', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: PARENT_ACTIVE_1_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    const childImpact = data.impacts.find(
      (i) => i.componentId === SUBFLOW_ACTIVE_PARENTS_ID,
    );
    expect(childImpact).toBeDefined();
    expect(childImpact?.category).toBe('metadata-blocker');
    // Deactivating the parent stops its subflow invocation → blocking.
    expect(data.verdict).toBe('blocking');
  });

  it('discloses both the new subflow modeling and the still-invisible Apex Flow.Interview path', async () => {
    const result = await whatIfDeactivateFlowHandler(ctx, {
      flowId: SUBFLOW_ACTIVE_PARENTS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const disclosure = result.value.data.disclosure;
    expect(disclosure).toContain('subflow');
    expect(disclosure).toContain('Flow.Interview');
  });
});

describe('whatIfDeactivateFlowInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({
      flowId: FLOW_RICH_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty flowId', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({
      flowId: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a componentId alias in place of flowId', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({
      componentId: FLOW_RICH_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty object at the schema layer (the "name a Flow" check is in the handler)', () => {
    // flowId is now optional because componentId / flowApiName / apiName are
    // interchangeable selectors; the "at least one" requirement is enforced by
    // the handler (invalid-query), not the schema.
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('accepts the empty-prefix case at the schema layer (prefix check is in the handler)', () => {
    const parsed = whatIfDeactivateFlowInputSchema.safeParse({
      flowId: 'NotAFlow',
    });
    expect(parsed.success).toBe(true);
  });
});

// =============================================================================
// N+1 query budget (finding C-1). The outgoing-impact walk,
// collectFiringConditions, and collectBrokenCaller all resolved edge endpoints
// with a `getNodeById` per edge (and the platform-event subscriber walk did a
// per-event listEdges + per-subscriber getNodeById); all are batched. The count
// must NOT scale with the flow's edge fan-out.
// =============================================================================
describe('whatIfDeactivateFlowHandler — bounded graph queries', () => {
  // A wide flow: `fanOut` outgoing callsApex targets, `fanOut` firesWhen
  // conditions, `fanOut` incoming subflow callers, AND `fanOut` subscribers to a
  // platform event this flow publishes (exercises the nested subs walk too).
  const seedWideFlow = async (fanOut: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-widf-budget-'));
    const opened = await openGraph(join(dir, 'widf.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const EVENT = 'CustomObject:WideEvent__e';
    const nodes: Node[] = [
      makeNode({ id: 'Flow:Wide', type: 'Flow', apiName: 'Wide', properties: { status: 'Active' } }),
      makeNode({ id: EVENT, type: 'CustomObject', apiName: 'WideEvent__e' }),
    ];
    const edges: Edge[] = [
      makeEdge({ fromId: 'Flow:Wide', toId: EVENT, edgeType: 'writesTo' }),
    ];
    for (let i = 0; i < fanOut; i += 1) {
      nodes.push(makeNode({ id: `ApexClass:Cls${i}`, type: 'ApexClass', apiName: `Cls${i}` }));
      edges.push(makeEdge({ fromId: 'Flow:Wide', toId: `ApexClass:Cls${i}`, edgeType: 'callsApex' }));
      nodes.push(makeNode({ id: `ConditionalContext:Cond${i}`, type: 'ConditionalContext', apiName: `Cond${i}` }));
      edges.push(makeEdge({ fromId: 'Flow:Wide', toId: `ConditionalContext:Cond${i}`, edgeType: 'firesWhen' }));
      nodes.push(makeNode({ id: `Flow:Parent${i}`, type: 'Flow', apiName: `Parent${i}`, properties: { status: 'Active' } }));
      edges.push(makeEdge({ fromId: `Flow:Parent${i}`, toId: 'Flow:Wide', edgeType: 'references', properties: { referenceKind: 'subflow' } }));
      nodes.push(makeNode({ id: `Flow:Sub${i}`, type: 'Flow', apiName: `Sub${i}`, properties: { status: 'Active' } }));
      edges.push(makeEdge({ fromId: `Flow:Sub${i}`, toId: EVENT, edgeType: 'listensTo' }));
    }
    const imported = await importExtractionResults(s, [{ nodes, edges }]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const wideCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const measured = await measureGraphQueries(s, () =>
      whatIfDeactivateFlowHandler(wideCtx, { flowId: 'Wide' }),
    );
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return measured;
  };

  it('issues a query count independent of the flow edge fan-out', async () => {
    const small = await seedWideFlow(60);
    const large = await seedWideFlow(200);
    expect(small.result.ok).toBe(true);
    expect(large.result.ok).toBe(true);
    expect(large.nodeQueries).toBe(small.nodeQueries);
    expect(large.edgeQueries).toBe(small.edgeQueries);
    // A per-edge getNodeById across the walks would be >=180 node queries at
    // fanOut=200; batched, each walk is one node/edge fetch.
    expect(large.nodeQueries).toBeLessThan(60);
    expect(large.edgeQueries).toBeLessThan(60);
  });
});

// =============================================================================
// GUARD (WHAT-IF-DEACTIVATE-FLOW-REJECTS-COMPONENTID): a dev "if I deactivate
// Flow X, what breaks?" after route_question naturally passes componentId
// (works on get_impact / most tools), but the schema only accepted `flowId` and
// hard-failed `flowId: Required`. componentId / flowApiName / apiName must now
// be interchangeable with flowId (same deactivation impact, byte-equal),
// disagreeing selectors reject, and the resolved id is echoed in appliedScope.
// =============================================================================
describe('whatIfDeactivateFlowHandler — flowId / componentId / flowApiName / apiName alias (guard)', () => {
  it('componentId ≡ flowId ≡ flowApiName ≡ apiName resolve to the same impact (byte-equal data)', async () => {
    const byFlowId = await whatIfDeactivateFlowHandler(ctx, { flowId: FLOW_RICH_ID });
    const byComponentId = await whatIfDeactivateFlowHandler(ctx, { componentId: FLOW_RICH_ID });
    const byFlowApiName = await whatIfDeactivateFlowHandler(ctx, { flowApiName: 'AccountNotify' });
    const byApiName = await whatIfDeactivateFlowHandler(ctx, { apiName: 'AccountNotify' });
    expect(byFlowId.ok && byComponentId.ok && byFlowApiName.ok && byApiName.ok).toBe(true);
    if (!byFlowId.ok || !byComponentId.ok || !byFlowApiName.ok || !byApiName.ok) return;
    const canonical = JSON.stringify(byFlowId.value.data);
    expect(JSON.stringify(byComponentId.value.data)).toBe(canonical);
    expect(JSON.stringify(byFlowApiName.value.data)).toBe(canonical);
    expect(JSON.stringify(byApiName.value.data)).toBe(canonical);
    expect(byComponentId.value.data.appliedScope).toEqual({
      component: FLOW_RICH_ID,
      mode: 'component',
    });
  });

  it('componentId scope is actually honored — a different Flow returns ITS impact', async () => {
    const rich = await whatIfDeactivateFlowHandler(ctx, { componentId: FLOW_RICH_ID });
    const empty = await whatIfDeactivateFlowHandler(ctx, { componentId: FLOW_EMPTY_ID });
    expect(rich.ok && empty.ok).toBe(true);
    if (!rich.ok || !empty.ok) return;
    expect(empty.value.data.flowId).toBe(FLOW_EMPTY_ID);
    expect(empty.value.data.appliedScope.component).toBe(FLOW_EMPTY_ID);
    // Different Flows → different impact payloads: proof the alias is used.
    expect(JSON.stringify(empty.value.data.impacts)).not.toBe(
      JSON.stringify(rich.value.data.impacts),
    );
  });

  it('disagreeing flowId / componentId is invalid-query (never a silent pick)', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, {
      flowId: FLOW_RICH_ID,
      componentId: FLOW_EMPTY_ID,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('no flow selector at all is invalid-query', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});
