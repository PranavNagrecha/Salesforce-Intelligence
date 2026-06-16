/**
 * Handler for the `sfi.process_builder_migration_candidates` MCP tool.
 *
 * The v2.4 "Process Builders are deprecated; which ones still need
 * migration?" surface. Composes over Flow + WorkflowRule + ApprovalProcess
 * nodes — no new extractors required.
 *
 * **Process Builder detection** — Salesforce represents Process Builder
 * as a Flow with `<processType>Workflow</processType>` (per v1.3's
 * documented boundary in PLAN-v1.3). This tool filters Flow nodes by
 * that property; an admin asking "which Process Builders are active?"
 * gets the structurally-correct subset.
 *
 * **WorkflowRule + ApprovalProcess inclusion** — by default the tool
 * also surfaces active WorkflowRule and ApprovalProcess nodes as
 * sibling migration candidates. Admins typically ask "which legacy
 * automation needs migration to Flow?" — a single tool call surfaces
 * the full backlog rather than forcing them to compose two queries.
 *
 * **Complexity classification** — per-firer complexity is heuristic
 * based on outgoing edge counts and time-trigger presence. v2.4
 * defines three tiers:
 *   - `simple`: single decision/criterion, single action.
 *   - `moderate`: multi-criterion or multi-action.
 *   - `complex`: time-triggers, sub-flow calls, or 3+ chained
 *     decisions.
 *
 * The classification is itself a heuristic — a 'simple' rule may
 * carry deeply-coupled business logic; the per-rule `migrationNotes`
 * surface flags this for admins.
 *
 * **Active-only default** — the default is `activeOnly: true`. Inactive
 * rules are deletion candidates, not migration candidates; they're
 * surfaced by `sfi.unused_components` instead. The skill's routing
 * discipline (per PLAN-v2.4 §5) enforces the distinction.
 *
 * **Honesty axis** — the migration tool itself (Setup → Workflow Rules
 * → Migrate to Flow) does not run here. v2.4 produces the inventory
 * plus per-rule guidance; the user runs the migration tool themselves
 * after reviewing the inventory. The `boundaries[]` array surfaces
 * this verbatim.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Inclusive upper bound on `limit`. */
const PROCESS_BUILDER_MAX_LIMIT = 500;
/** Default `limit`. */
const PROCESS_BUILDER_DEFAULT_LIMIT = 100;
/** Internal page-size cap. */
const LIST_PAGE_SIZE = 500;

/**
 * Salesforce's published deadline message for Process Builder
 * retirement. Surfaced verbatim in `summary`.
 */
const PROCESS_BUILDER_RETIREMENT_NOTE =
  'Process Builders are deprecated. Salesforce has paused the formal end-of-life date pending customer migration progress, but all new automation should ship as Flow. Inventory active Process Builders and migrate them in priority order.';

/**
 * Salesforce's published deadline message for WorkflowRule
 * retirement. Surfaced verbatim in `summary`.
 */
const WORKFLOW_RULE_RETIREMENT_NOTE =
  'WorkflowRules are deprecated. Salesforce no longer accepts new WorkflowRule creation in some editions; all new automation should ship as Flow. Inventory active rules and migrate them in priority order.';

/** Verbatim boundary disclosures. */
const BOUNDARIES: readonly string[] = Object.freeze([
  "the complexity classification is heuristic based on edge counts and time-trigger presence; complex business logic in a single-decision Process Builder may rank as 'simple' but require manual review for migration.",
  'the migration tool itself (Setup → Migrate to Flow) does not run here — this tool produces the inventory and per-rule guidance.',
]);

/** Zod schema for the input. */
export const processBuilderMigrationCandidatesInputSchema = z.object({
  includeWorkflowRules: z.boolean().optional(),
  includeApprovalProcesses: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  sortBy: z.enum(['complexity', 'object', 'name']).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PROCESS_BUILDER_MAX_LIMIT)
    .optional(),
});

export type ProcessBuilderMigrationCandidatesInput = z.infer<
  typeof processBuilderMigrationCandidatesInputSchema
>;

type Complexity = 'simple' | 'moderate' | 'complex';

/** One Process Builder candidate. */
export interface ProcessBuilderCandidate {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly parentObjectId: ComponentId | null;
  readonly isActive: boolean;
  readonly processType: 'Workflow';
  readonly complexity: Complexity;
  readonly edgeSummary: {
    readonly writesToCount: number;
    readonly callsApexCount: number;
    readonly sendsEmailCount: number;
    readonly subflowCount: number;
  };
  readonly timeTriggerCount: number;
  readonly migrationNotes: string;
}

/** One WorkflowRule candidate. */
export interface WorkflowRuleCandidate {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly parentObjectId: ComponentId | null;
  readonly isActive: boolean;
  readonly triggerType: string;
  readonly complexity: Complexity;
  readonly criteriaItemCount: number;
  readonly edgeSummary: {
    readonly fieldUpdateCount: number;
    readonly sendsEmailCount: number;
    readonly callsApexCount: number;
    readonly outboundMessageCount: number;
    readonly taskCreationCount: number;
  };
  readonly timeTriggerCount: number;
  readonly migrationNotes: string;
}

/** One ApprovalProcess candidate. */
export interface ApprovalProcessCandidate {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly parentObjectId: ComponentId | null;
  readonly isActive: boolean;
  readonly complexity: Complexity;
  readonly stepCount: number;
  readonly sendsEmailCount: number;
  readonly migrationNotes: string;
}

/** Output payload. */
export interface ProcessBuilderMigrationCandidatesOutput {
  readonly processBuilders: readonly ProcessBuilderCandidate[];
  readonly workflowRules: readonly WorkflowRuleCandidate[];
  readonly approvalProcesses: readonly ApprovalProcessCandidate[];
  readonly totalProcessBuilders: number;
  readonly totalWorkflowRules: number;
  readonly totalApprovalProcesses: number;
  readonly summary: {
    readonly processBuilderRetirementDeadlineNote: string;
    readonly workflowRuleRetirementDeadlineNote: string;
  };
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
}

/**
 * Read a numeric property from a node, defaulting to 0 when absent or
 * non-numeric. Helpful for properties counted by extractors.
 */
const propertyNumber = (node: Node, key: string): number => {
  const v = node.properties[key];
  return typeof v === 'number' ? v : 0;
};

/**
 * Read a boolean property from a node, defaulting to false when
 * absent.
 */
const propertyBoolean = (node: Node, key: string): boolean =>
  node.properties[key] === true;

/**
 * Read a string property from a node, defaulting to '' when absent.
 */
const propertyString = (node: Node, key: string): string => {
  const v = node.properties[key];
  return typeof v === 'string' ? v : '';
};

/** Count outgoing edges of a node by edgeType. */
const countOutgoingEdges = async (
  ctx: Context,
  nodeId: ComponentId,
  edgeType:
    | 'writesTo'
    | 'callsApex'
    | 'sendsEmail'
    | 'references'
    | 'readsFrom',
): Promise<Result<number, string>> => {
  const r = await listEdges(ctx.graph, nodeId, {
    direction: 'out',
    edgeType,
  });
  if (!r.ok) return err(r.error.message);
  return ok(r.value.length);
};

/**
 * Classify a Process Builder's complexity from edge counts + time-
 * trigger / decision counts.
 */
const classifyProcessBuilder = (
  decisionCount: number,
  actionCount: number,
  timeTriggerCount: number,
  subflowCount: number,
): Complexity => {
  if (timeTriggerCount > 0 || subflowCount > 0 || decisionCount >= 3) {
    return 'complex';
  }
  if (decisionCount > 1 || actionCount > 1) return 'moderate';
  return 'simple';
};

/**
 * Classify a WorkflowRule's complexity from criteria-item count, time-
 * trigger count, and aggregate action count.
 */
const classifyWorkflowRule = (
  criteriaItemCount: number,
  timeTriggerCount: number,
  totalActionCount: number,
): Complexity => {
  if (timeTriggerCount > 0 || criteriaItemCount >= 3 || totalActionCount >= 3) {
    return 'complex';
  }
  if (criteriaItemCount > 1 || totalActionCount > 1) return 'moderate';
  return 'simple';
};

/**
 * Classify an ApprovalProcess's complexity from step count + email
 * count.
 */
const classifyApprovalProcess = (
  stepCount: number,
  sendsEmailCount: number,
): Complexity => {
  if (stepCount >= 3) return 'complex';
  if (stepCount > 1 || sendsEmailCount > 1) return 'moderate';
  return 'simple';
};

const migrationNoteForProcessBuilder = (complexity: Complexity): string => {
  if (complexity === 'simple') {
    return 'Single-decision Process Builder — a strong candidate for early migration to a record-triggered Flow. Estimated effort: low.';
  }
  if (complexity === 'moderate') {
    return 'Multi-decision or multi-action Process Builder. Migrate to a single record-triggered Flow with nested decisions or sub-flows. Estimated effort: moderate.';
  }
  return 'Complex Process Builder with time-triggers or sub-flow calls. Manual review required before migration; consider splitting into multiple record-triggered Flows. Estimated effort: high.';
};

const migrationNoteForWorkflowRule = (complexity: Complexity): string => {
  if (complexity === 'simple') {
    return 'Single-criterion, single-action WorkflowRule — straightforward to convert to a record-triggered Flow. Estimated effort: low.';
  }
  if (complexity === 'moderate') {
    return 'Multi-criterion or multi-action WorkflowRule. Migrate to a record-triggered Flow consolidating the criteria. Estimated effort: moderate.';
  }
  return 'Complex WorkflowRule with time-triggers or 3+ actions. Manual review required; consider whether the time-based actions belong in a scheduled Flow. Estimated effort: high.';
};

const migrationNoteForApprovalProcess = (complexity: Complexity): string => {
  if (complexity === 'simple') {
    return 'Simple ApprovalProcess — Salesforce continues to support ApprovalProcess; migration to a Flow-based approval is OPTIONAL but recommended for new automation. Estimated effort: low.';
  }
  if (complexity === 'moderate') {
    return 'Multi-step ApprovalProcess. Flow-based approval routes are recommended for new automation; this can be migrated when the team refactors approval flows. Estimated effort: moderate.';
  }
  return 'Complex ApprovalProcess with 3+ steps. Manual review recommended before migration. Estimated effort: high.';
};

/** Complexity ordering: simple < moderate < complex. */
const complexityRank: Readonly<Record<Complexity, number>> = Object.freeze({
  simple: 0,
  moderate: 1,
  complex: 2,
});

const compareByComplexity = <
  T extends { complexity: Complexity; apiName: string },
>(
  a: T,
  b: T,
): number => {
  const diff = complexityRank[a.complexity] - complexityRank[b.complexity];
  if (diff !== 0) return diff;
  return a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0;
};

const compareByApiName = <T extends { apiName: string }>(a: T, b: T): number =>
  a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0;

const compareByParent = <
  T extends { parentObjectId: ComponentId | null; apiName: string },
>(
  a: T,
  b: T,
): number => {
  const ap = a.parentObjectId ?? '';
  const bp = b.parentObjectId ?? '';
  if (ap !== bp) return ap < bp ? -1 : 1;
  return compareByApiName(a, b);
};

const sortFor = <
  T extends {
    complexity: Complexity;
    apiName: string;
    parentObjectId: ComponentId | null;
  },
>(
  arr: readonly T[],
  sortBy: 'complexity' | 'object' | 'name',
): T[] => {
  const copy = [...arr];
  switch (sortBy) {
    case 'complexity':
      return copy.sort(compareByComplexity);
    case 'object':
      return copy.sort(compareByParent);
    case 'name':
      return copy.sort(compareByApiName);
  }
};

/**
 * The `sfi.process_builder_migration_candidates` MCP tool. See module
 * JSDoc for the Process Builder detection rule, the heuristic
 * complexity tiers, and the honesty axis.
 */
export const processBuilderMigrationCandidatesHandler = async (
  ctx: Context,
  input: ProcessBuilderMigrationCandidatesInput,
): Promise<
  Result<McpResponse<ProcessBuilderMigrationCandidatesOutput>, McpError>
> => {
  const limit = input.limit ?? PROCESS_BUILDER_DEFAULT_LIMIT;
  const includeWorkflowRules = input.includeWorkflowRules ?? true;
  const includeApprovalProcesses = input.includeApprovalProcesses ?? true;
  const activeOnly = input.activeOnly ?? true;
  const sortBy = input.sortBy ?? 'complexity';

  const flowsRes = await listNodesByType(ctx.graph, 'Flow', {
    limit: LIST_PAGE_SIZE,
  });
  if (!flowsRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${flowsRes.error.message}`,
    });
  }

  const processBuilders: ProcessBuilderCandidate[] = [];

  for (const flow of flowsRes.value) {
    const processType = propertyString(flow, 'processType');
    if (processType !== 'Workflow') continue;
    const isActive = propertyBoolean(flow, 'active');
    if (activeOnly && !isActive) continue;
    const decisionCount = propertyNumber(flow, 'decisionCount');
    const actionCount = propertyNumber(flow, 'actionCount');
    const timeTriggerCount = propertyNumber(flow, 'timeTriggerCount');

    const writesRes = await countOutgoingEdges(ctx, flow.id, 'writesTo');
    if (!writesRes.ok) {
      return err({ kind: 'internal', message: writesRes.error });
    }
    const apexRes = await countOutgoingEdges(ctx, flow.id, 'callsApex');
    if (!apexRes.ok) {
      return err({ kind: 'internal', message: apexRes.error });
    }
    const emailRes = await countOutgoingEdges(ctx, flow.id, 'sendsEmail');
    if (!emailRes.ok) {
      return err({ kind: 'internal', message: emailRes.error });
    }
    // Sub-flow count surfaces via outgoing `references` edges to
    // another Flow; v2.0a's Flow extractor emits these.
    const refRes = await countOutgoingEdges(ctx, flow.id, 'references');
    if (!refRes.ok) {
      return err({ kind: 'internal', message: refRes.error });
    }

    const complexity = classifyProcessBuilder(
      decisionCount,
      actionCount,
      timeTriggerCount,
      refRes.value,
    );

    processBuilders.push({
      id: flow.id,
      apiName: flow.apiName,
      parentObjectId: flow.parentId,
      isActive,
      processType: 'Workflow',
      complexity,
      edgeSummary: {
        writesToCount: writesRes.value,
        callsApexCount: apexRes.value,
        sendsEmailCount: emailRes.value,
        subflowCount: refRes.value,
      },
      timeTriggerCount,
      migrationNotes: migrationNoteForProcessBuilder(complexity),
    });
  }

  const workflowRules: WorkflowRuleCandidate[] = [];
  if (includeWorkflowRules) {
    const wrRes = await listNodesByType(ctx.graph, 'WorkflowRule', {
      limit: LIST_PAGE_SIZE,
    });
    if (!wrRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${wrRes.error.message}`,
      });
    }
    for (const wr of wrRes.value) {
      const isActive = propertyBoolean(wr, 'active');
      if (activeOnly && !isActive) continue;
      const triggerType = propertyString(wr, 'triggerType');
      const criteriaItemCount = propertyNumber(wr, 'criteriaItemCount');
      const timeTriggerCount = propertyNumber(wr, 'timeTriggerCount');
      const fieldUpdateCount = propertyNumber(wr, 'fieldUpdateCount');
      const outboundMessageCount = propertyNumber(wr, 'outboundMessageCount');
      const taskCreationCount = propertyNumber(wr, 'taskCreationCount');

      const apexRes = await countOutgoingEdges(ctx, wr.id, 'callsApex');
      if (!apexRes.ok) {
        return err({ kind: 'internal', message: apexRes.error });
      }
      const emailRes = await countOutgoingEdges(ctx, wr.id, 'sendsEmail');
      if (!emailRes.ok) {
        return err({ kind: 'internal', message: emailRes.error });
      }

      const totalActions =
        fieldUpdateCount +
        emailRes.value +
        apexRes.value +
        outboundMessageCount +
        taskCreationCount;
      const complexity = classifyWorkflowRule(
        criteriaItemCount,
        timeTriggerCount,
        totalActions,
      );

      workflowRules.push({
        id: wr.id,
        apiName: wr.apiName,
        parentObjectId: wr.parentId,
        isActive,
        triggerType,
        complexity,
        criteriaItemCount,
        edgeSummary: {
          fieldUpdateCount,
          sendsEmailCount: emailRes.value,
          callsApexCount: apexRes.value,
          outboundMessageCount,
          taskCreationCount,
        },
        timeTriggerCount,
        migrationNotes: migrationNoteForWorkflowRule(complexity),
      });
    }
  }

  const approvalProcesses: ApprovalProcessCandidate[] = [];
  if (includeApprovalProcesses) {
    const apRes = await listNodesByType(ctx.graph, 'ApprovalProcess', {
      limit: LIST_PAGE_SIZE,
    });
    if (!apRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${apRes.error.message}`,
      });
    }
    for (const ap of apRes.value) {
      const isActive = propertyBoolean(ap, 'active');
      if (activeOnly && !isActive) continue;
      const stepCount = propertyNumber(ap, 'stepCount');
      const emailRes = await countOutgoingEdges(ctx, ap.id, 'sendsEmail');
      if (!emailRes.ok) {
        return err({ kind: 'internal', message: emailRes.error });
      }
      const complexity = classifyApprovalProcess(stepCount, emailRes.value);
      approvalProcesses.push({
        id: ap.id,
        apiName: ap.apiName,
        parentObjectId: ap.parentId,
        isActive,
        complexity,
        stepCount,
        sendsEmailCount: emailRes.value,
        migrationNotes: migrationNoteForApprovalProcess(complexity),
      });
    }
  }

  const sortedPbs = sortFor(processBuilders, sortBy);
  const sortedWrs = sortFor(workflowRules, sortBy);
  const sortedAps = sortFor(approvalProcesses, sortBy);

  // Truncate the three lists independently — limit applies per list so
  // a caller asking for the top-100 sees 100 per category rather than a
  // global slice that crowds out one category.
  const truncatedPbs = sortedPbs.length > limit;
  const truncatedWrs = sortedWrs.length > limit;
  const truncatedAps = sortedAps.length > limit;
  const truncated = truncatedPbs || truncatedWrs || truncatedAps;

  return ok({
    data: {
      processBuilders: sortedPbs.slice(0, limit),
      workflowRules: sortedWrs.slice(0, limit),
      approvalProcesses: sortedAps.slice(0, limit),
      totalProcessBuilders: sortedPbs.length,
      totalWorkflowRules: sortedWrs.length,
      totalApprovalProcesses: sortedAps.length,
      summary: {
        processBuilderRetirementDeadlineNote: PROCESS_BUILDER_RETIREMENT_NOTE,
        workflowRuleRetirementDeadlineNote: WORKFLOW_RULE_RETIREMENT_NOTE,
      },
      boundaries: BOUNDARIES,
      truncated,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
