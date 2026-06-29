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
  processBuilderMigrationCandidatesHandler,
  processBuilderMigrationCandidatesInputSchema,
} from '../../src/tools/process-builder-migration-candidates.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Flow: 2, WorkflowRule: 3, ApprovalProcess: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Flow',
  apiName: 'Anonymous',
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

const PB_LEAD = 'Flow:Lead_Score_Update';
const PB_AUTOLAUNCH = 'Flow:NotAProcessBuilder';
const WR_SIMPLE = 'WorkflowRule:Account.Notify_On_Industry_Change';
const WR_COMPLEX = 'WorkflowRule:Opportunity.Discount_Approval_Trigger';
const WR_INACTIVE = 'WorkflowRule:Account.OldInactive';
const AP_APPROVAL = 'ApprovalProcess:Opportunity.BigDeal';

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PB_LEAD,
      type: 'Flow',
      apiName: 'Lead_Score_Update',
      properties: {
        processType: 'Workflow',
        active: true,
        decisionCount: 3,
        actionCount: 2,
        timeTriggerCount: 0,
      },
    }),
    makeNode({
      id: PB_AUTOLAUNCH,
      type: 'Flow',
      apiName: 'NotAProcessBuilder',
      properties: {
        processType: 'AutoLaunchedFlow',
        active: true,
      },
    }),
    makeNode({
      id: WR_SIMPLE,
      type: 'WorkflowRule',
      apiName: 'Account.Notify_On_Industry_Change',
      properties: {
        active: true,
        triggerType: 'onCreateOnly',
        criteriaItemCount: 1,
        conditions: [
          {
            kind: 'criteria',
            conditionContextId:
              'ConditionalContext:WorkflowRule:Account.Notify_On_Industry_Change.condition-0',
            expression: 'Industry equals Technology',
            fieldRefs: ['CustomField:Account.Industry'],
          },
        ],
        timeTriggerCount: 0,
        fieldUpdateCount: 0,
      },
    }),
    makeNode({
      id: WR_COMPLEX,
      type: 'WorkflowRule',
      apiName: 'Opportunity.Discount_Approval_Trigger',
      properties: {
        active: true,
        triggerType: 'onAllChanges',
        criteriaItemCount: 3,
        conditions: [
          {
            kind: 'criteria',
            conditionContextId:
              'ConditionalContext:WorkflowRule:Opportunity.Discount_Approval_Trigger.condition-0',
            expression: 'A equals 1 AND B equals 2 AND C equals 3',
            fieldRefs: [
              'CustomField:Opportunity.A',
              'CustomField:Opportunity.B',
              'CustomField:Opportunity.C',
            ],
          },
        ],
        timeTriggerCount: 1,
        fieldUpdateCount: 2,
        outboundMessageCount: 0,
        taskCreationCount: 0,
      },
    }),
    makeNode({
      id: WR_INACTIVE,
      type: 'WorkflowRule',
      apiName: 'Account.OldInactive',
      properties: {
        active: false,
        triggerType: 'onCreateOnly',
        criteriaItemCount: 0,
        conditions: [],
      },
    }),
    makeNode({
      id: AP_APPROVAL,
      type: 'ApprovalProcess',
      apiName: 'Opportunity.BigDeal',
      properties: { active: true, stepCount: 2 },
    }),
  ],
  edges: [
    makeEdge({
      fromId: PB_LEAD,
      toId: 'CustomField:Lead.Score__c',
      edgeType: 'writesTo',
    }),
    makeEdge({
      fromId: WR_SIMPLE,
      toId: 'EmailTemplate:Notify',
      edgeType: 'sendsEmail',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-pbmc-'));
  const dbPath = join(tempDir, 'pbmc.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('processBuilderMigrationCandidatesHandler', () => {
  it('lists active Process Builders only when processType=Workflow', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pbIds = result.value.data.processBuilders.map((p) => p.id);
    expect(pbIds).toContain(PB_LEAD);
    expect(pbIds).not.toContain(PB_AUTOLAUNCH);
  });

  it('classifies a 3-decision PB as complex due to decisionCount >= 3', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pb = result.value.data.processBuilders.find((p) => p.id === PB_LEAD);
    expect(pb?.complexity).toBe('complex');
  });

  it('classifies a single-criterion WR as simple', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wr = result.value.data.workflowRules.find((w) => w.id === WR_SIMPLE);
    expect(wr?.complexity).toBe('simple');
  });

  it('classifies a multi-criterion, time-trigger WR as complex', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wr = result.value.data.workflowRules.find((w) => w.id === WR_COMPLEX);
    expect(wr?.complexity).toBe('complex');
  });

  it('excludes inactive rules by default (activeOnly: true)', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.workflowRules.map((w) => w.id);
    expect(ids).not.toContain(WR_INACTIVE);
  });

  it('includes inactive rules when activeOnly=false', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {
      activeOnly: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.workflowRules.map((w) => w.id);
    expect(ids).toContain(WR_INACTIVE);
  });

  it('emits the retirement-deadline notes verbatim', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.data.summary.processBuilderRetirementDeadlineNote,
    ).toMatch(/Process Builders are deprecated/);
    expect(
      result.value.data.summary.workflowRuleRetirementDeadlineNote,
    ).toMatch(/WorkflowRules are deprecated/);
  });

  it('emits the verbatim "migration tool not bundled" boundary disclosure', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.boundaries.join(' ')).toMatch(
      /migration tool itself .*does not run here/,
    );
  });

  it('sorts WRs by complexity by default (simple first)', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wrs = result.value.data.workflowRules;
    expect(wrs[0]?.complexity).toBe('simple');
  });

  it('surfaces ApprovalProcess candidates when includeApprovalProcesses is true (default)', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.approvalProcesses.map((a) => a.id);
    expect(ids).toContain(AP_APPROVAL);
  });

  it('excludes ApprovalProcesses when includeApprovalProcesses=false', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {
      includeApprovalProcesses: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.approvalProcesses.length).toBe(0);
  });

  // ---- CR-22 cursor ----------------------------------------------------

  it('whole-fits omits cursor block + scanTruncated (byte-identical golden)', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('nextCursor' in result.value.data).toBe(false);
    expect('pageInfo' in result.value.data).toBe(false);
    expect('otherSections' in result.value.data).toBe(false);
    expect('scanTruncated' in result.value.data).toBe(false);
    expect(result.value.data.truncated).toBe(false);
  });

  it('paging the largest list (workflowRules) emits nextCursor + discloses the others', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx, { limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.designatedList).toBe('workflowRules');
    expect(result.value.data.workflowRules.length).toBe(1);
    expect(result.value.data.nextCursor).toBeDefined();
    const others = result.value.data.otherSections ?? [];
    expect(others.map((s) => s.listId).sort()).toEqual(['approvalProcesses', 'processBuilders']);
    expect(result.value.data.totalWorkflowRules).toBe(2);
  });

  it('resume walks the designated list with no dup/skip', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i += 1) {
      const r = await processBuilderMigrationCandidatesHandler(ctx, {
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const w of r.value.data.workflowRules) seen.push(w.id);
      cursor = r.value.data.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen.sort()).toEqual([WR_COMPLEX, WR_SIMPLE].sort());
  });

  it('rejects a cursor minted for a different sortBy', async () => {
    const p1 = await processBuilderMigrationCandidatesHandler(ctx, { limit: 1 });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const cursor = p1.value.data.nextCursor!;
    const stale = await processBuilderMigrationCandidatesHandler(ctx, { limit: 1, cursor, sortBy: 'name' });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('invalid-query');
  });
});

describe('processBuilderMigrationCandidatesInputSchema', () => {
  it('accepts empty input', () => {
    expect(
      processBuilderMigrationCandidatesInputSchema.safeParse({}).success,
    ).toBe(true);
  });

  it('rejects invalid sortBy', () => {
    expect(
      processBuilderMigrationCandidatesInputSchema.safeParse({
        sortBy: 'invalid',
      }).success,
    ).toBe(false);
  });

  it('rejects limit above 500', () => {
    expect(
      processBuilderMigrationCandidatesInputSchema.safeParse({ limit: 501 })
        .success,
    ).toBe(false);
  });
});

// CR-CAP-11b — the three per-rule action-type counts now feed totalActions
// directly (the producer emits them; before, propertyNumber silently read 0).
// Self-contained graph so it does not perturb the shared seed's pagination
// counts above.
describe('CR-CAP-11b — action-type counts drive WorkflowRule complexity', () => {
  const WR_ACTIONS = 'WorkflowRule:Opportunity.Three_Action_Rule';
  const WR_EMAIL_ONLY = 'WorkflowRule:Account.Email_Only_Rule';
  const seed11b: ExtractionResult = {
    nodes: [
      makeNode({
        id: WR_ACTIONS,
        type: 'WorkflowRule',
        apiName: 'Opportunity.Three_Action_Rule',
        properties: {
          active: true,
          triggerType: 'onAllChanges',
          criteriaItemCount: 0,
          timeTriggerCount: 0,
          // 2 + 1 + 0 = 3 actions via the action-type counts ALONE (no edges).
          fieldUpdateCount: 2,
          outboundMessageCount: 1,
          taskCreationCount: 0,
        },
      }),
      makeNode({
        id: WR_EMAIL_ONLY,
        type: 'WorkflowRule',
        apiName: 'Account.Email_Only_Rule',
        properties: {
          active: true,
          triggerType: 'onCreateOnly',
          criteriaItemCount: 0,
          timeTriggerCount: 0,
          fieldUpdateCount: 0,
          outboundMessageCount: 0,
          taskCreationCount: 0,
        },
      }),
    ],
    edges: [
      makeEdge({
        fromId: WR_EMAIL_ONLY,
        toId: 'EmailTemplate:Notify',
        edgeType: 'sendsEmail',
      }),
    ],
  };

  let dir11b: string;
  let store11b: GraphStore;
  let ctx11b: Context;

  beforeAll(async () => {
    dir11b = mkdtempSync(join(tmpdir(), 'sfi-mcp-pbmc-11b-'));
    const opened = await openGraph(join(dir11b, 'pbmc11b.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store11b = opened.value;
    const imported = await importExtractionResults(store11b, [seed11b]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx11b = { vaultRoot: dir11b, manifest: FIXTURE_MANIFEST, graph: store11b };
  });

  afterAll(async () => {
    await closeGraph(store11b);
    rmSync(dir11b, { recursive: true, force: true });
  });

  it('classifies a rule with 2 field updates + 1 outbound message (no edges) as complex', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx11b, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wr = result.value.data.workflowRules.find((w) => w.id === WR_ACTIONS);
    expect(wr?.complexity).toBe('complex');
    expect(wr?.edgeSummary.fieldUpdateCount).toBe(2);
    expect(wr?.edgeSummary.outboundMessageCount).toBe(1);
    expect(wr?.edgeSummary.taskCreationCount).toBe(0);
  });

  it('classifies a rule with all action-type counts 0 + one sendsEmail edge as simple', async () => {
    const result = await processBuilderMigrationCandidatesHandler(ctx11b, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wr = result.value.data.workflowRules.find(
      (w) => w.id === WR_EMAIL_ONLY,
    );
    expect(wr?.complexity).toBe('simple');
    expect(wr?.edgeSummary.sendsEmailCount).toBe(1);
    expect(wr?.edgeSummary.fieldUpdateCount).toBe(0);
  });
});
