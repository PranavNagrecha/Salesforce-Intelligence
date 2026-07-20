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
  ComponentType,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { countNodesByType, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEnumerationCoverageCaveatFor,
  type CoverageCaveat,
} from './coverage-trust.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
  type SectionDisclosure,
} from './page-cursor.js';

/** Per-response byte budget for the designated list's page. */
const PROCESS_BUILDER_BYTE_BUDGET = 38_000;

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
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`; carries the resume offset + which list it
  // advances. Omit = today's behavior.
  cursor: z.string().min(1).optional(),
  // PROCESS-BUILDER-MIGRATION-IGNORES-OBJECT-SCOPE: honor an object scope
  // instead of silently returning the whole-org candidate inventory. Every
  // candidate is a WorkflowRule / ApprovalProcess (parented to a CustomObject)
  // or a Process Builder, so the inventory CAN be narrowed to one object: with a
  // scope each list keeps only candidates whose `parentObjectId` matches, and
  // `appliedScope` is echoed. Accepts the interchangeable object identifiers.
  objectApiName: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
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
  /**
   * Present ONLY on an object-scoped call
   * (PROCESS-BUILDER-MIGRATION-IGNORES-OBJECT-SCOPE) — echoes the object each
   * list was narrowed to (candidates whose `parentObjectId` is that object) so a
   * host never reads a scoped answer as org-wide. Absent on the bare call,
   * keeping that response byte-identical. `object` is the canonical
   * `CustomObject:` id; `mode` is always `component` when present.
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
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
  /**
   * coverage-aware-zero (CR): present when the manifest reports any included
   * automation family (Flow / WorkflowRule / ApprovalProcess) was NOT retrieved.
   * An empty list / zero total under this caveat is "not retrieved, re-refresh",
   * NOT a proven "no migration candidates". `missingCoverage` names exactly the
   * unretrieved families. Absent on a legacy (no-coverage) vault and when every
   * included family retrieved clean, so existing goldens do not move.
   */
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * CR-RV12: TRUE when the >500 node SCAN cap (LIST_PAGE_SIZE) dropped Flow /
   * WorkflowRule / ApprovalProcess nodes BEFORE filtering — so the lists and
   * total* counts under-count that type. Present ONLY when actually true so a
   * ≤500-node org's golden does not move.
   */
  readonly scanTruncated?: boolean;
  /** CR-RV12: true org-wide counts per scanned type (only when a scan was capped). */
  readonly trueTypeCounts?: {
    readonly flows?: number;
    readonly workflowRules?: number;
    readonly approvalProcesses?: number;
  };
  /**
   * CR-22 opaque continuation token, present ONLY when the designated list
   * overflowed `limit`/the byte budget. Echo it back as `cursor` to resume;
   * absent on a whole-fits page so the response is byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata for the designated list; truncation only. */
  readonly pageInfo?: PageInfo;
  /** Which list the cursor advances; truncation only. */
  readonly designatedList?: string;
  /** The two non-designated lists, disclosed with their full counts; truncation only. */
  readonly otherSections?: readonly SectionDisclosure[];
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

/** Final tiebreak on the unique ComponentId so every per-list order is TOTAL —
 *  apiName is NOT globally unique (id `Flow:Lead_Score_Update` vs apiName
 *  `Lead_Score_Update`), so an offset cursor resume could dup/skip at an
 *  equal-apiName boundary without this. */
const compareById = <T extends { id: ComponentId }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const compareByComplexity = <
  T extends { id: ComponentId; complexity: Complexity; apiName: string },
>(
  a: T,
  b: T,
): number => {
  const diff = complexityRank[a.complexity] - complexityRank[b.complexity];
  if (diff !== 0) return diff;
  if (a.apiName !== b.apiName) return a.apiName < b.apiName ? -1 : 1;
  return compareById(a, b);
};

const compareByApiName = <T extends { id: ComponentId; apiName: string }>(
  a: T,
  b: T,
): number => {
  if (a.apiName !== b.apiName) return a.apiName < b.apiName ? -1 : 1;
  return compareById(a, b);
};

const compareByParent = <
  T extends { id: ComponentId; parentObjectId: ComponentId | null; apiName: string },
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
    id: ComponentId;
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

  // PROCESS-BUILDER-MIGRATION-IGNORES-OBJECT-SCOPE: resolve the optional object
  // scope (and verify it exists). `null` = bare org-wide call (byte-identical);
  // a resolved scope narrows each list to candidates on that object; an
  // unresolvable / absent object → `invalid-query`.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, input);
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;

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

  // Object-scoped: keep only candidates PARENTED to the scoped object
  // (`parentObjectId` is a `CustomObject:` id for WorkflowRule / ApprovalProcess,
  // and for a Process Builder Flow when the vault captured it; null otherwise, so
  // an unattributed candidate is correctly excluded under scope). Bare: no filter.
  const onScope = <T extends { parentObjectId: ComponentId | null }>(
    arr: readonly T[],
  ): readonly T[] =>
    scope === null ? arr : arr.filter((c) => c.parentObjectId === scope.componentId);

  const sortedPbs = sortFor(onScope(processBuilders), sortBy);
  const sortedWrs = sortFor(onScope(workflowRules), sortBy);
  const sortedAps = sortFor(onScope(approvalProcesses), sortBy);

  // KEEP pre-CR-22 `truncated` semantics byte-for-byte (any list over limit);
  // the cursor block is layered on top, emitted only when the designated list
  // is actually paged.
  const truncatedPbs = sortedPbs.length > limit;
  const truncatedWrs = sortedWrs.length > limit;
  const truncatedAps = sortedAps.length > limit;
  const truncated = truncatedPbs || truncatedWrs || truncatedAps;

  // CR-RV12: the per-type scans above are capped at LIST_PAGE_SIZE, so a
  // >500-node type silently under-counts BEFORE filtering. Compare TRUE counts
  // against the cap; surface scanTruncated + true counts ONLY for the scanned,
  // capped types so a ≤500-node org's golden does not move.
  const trueTypeCounts: { flows?: number; workflowRules?: number; approvalProcesses?: number } = {};
  let scanTruncated = false;
  const countType = async (type: ComponentType): Promise<Result<number, McpError>> => {
    const c = await countNodesByType(ctx.graph, type);
    if (!c.ok) return err({ kind: 'internal', message: `graph query failed: ${c.error.message}` });
    return ok(c.value);
  };
  {
    const c = await countType('Flow');
    if (!c.ok) return err(c.error);
    if (c.value > LIST_PAGE_SIZE) { scanTruncated = true; trueTypeCounts.flows = c.value; }
  }
  if (includeWorkflowRules) {
    const c = await countType('WorkflowRule');
    if (!c.ok) return err(c.error);
    if (c.value > LIST_PAGE_SIZE) { scanTruncated = true; trueTypeCounts.workflowRules = c.value; }
  }
  if (includeApprovalProcesses) {
    const c = await countType('ApprovalProcess');
    if (!c.ok) return err(c.error);
    if (c.value > LIST_PAGE_SIZE) { scanTruncated = true; trueTypeCounts.approvalProcesses = c.value; }
  }

  // CR-22 section cursor over the three lists in a STABLE order. Page the
  // largest (most-likely-oversized) by default; on resume the handler feeds
  // token.listId back as designatedListId (paginateSection does NOT cross-check).
  const TOOL = 'sfi.process_builder_migration_candidates';
  const fingerprint = argsFingerprint({
    includeWorkflowRules,
    includeApprovalProcesses,
    activeOnly,
    sortBy,
    // Bind the cursor to the object scope so a token minted for a scoped page
    // can never resume against a different (or org-wide) result. The key is
    // added ONLY when scoped — a bare call omits it so its fingerprint (and the
    // nextCursor it mints) stays byte-identical to pre-fix (argsFingerprint
    // skips undefined but NOT null, so a spread — not `?? null` — is required).
    ...(scope !== null ? { object: scope.componentId } : {}),
  });
  const sections: readonly PageableSection<
    ProcessBuilderCandidate | WorkflowRuleCandidate | ApprovalProcessCandidate
  >[] = [
    { listId: 'processBuilders', items: sortedPbs },
    { listId: 'workflowRules', items: sortedWrs },
    { listId: 'approvalProcesses', items: sortedAps },
  ];
  // Default designated = largest by length, stable order tiebreak.
  let designatedListId = 'processBuilders';
  let best = sortedPbs.length;
  if (sortedWrs.length > best) { designatedListId = 'workflowRules'; best = sortedWrs.length; }
  if (sortedAps.length > best) { designatedListId = 'approvalProcesses'; best = sortedAps.length; }
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
    if (decoded.value.listId !== undefined) designatedListId = decoded.value.listId;
  }

  const pagedResult = paginateSection(sections, designatedListId, {
    offset,
    limit,
    byteBudget: PROCESS_BUILDER_BYTE_BUDGET,
    keyOf: (c) => c.id,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
  });
  if (!pagedResult.ok) return err(pagedResult.error);
  const paged = pagedResult.value;
  const emitCursor = paged.pageInfo.nextCursor !== null;

  // coverage-aware-zero: caveat over the automation families this call actually
  // scanned. Flow is always scanned (Process Builder = Flow with processType
  // Workflow); WorkflowRule / ApprovalProcess only when their toggle is on.
  const coverageTypes = [
    'Flow',
    ...(includeWorkflowRules ? ['WorkflowRule'] : []),
    ...(includeApprovalProcesses ? ['ApprovalProcess'] : []),
  ];
  const coverageCaveat = buildEnumerationCoverageCaveatFor(
    ctx,
    coverageTypes,
    'The migration-candidate inventory',
  );

  const pbPage =
    designatedListId === 'processBuilders'
      ? (paged.items as readonly ProcessBuilderCandidate[])
      : sortedPbs.slice(0, limit);
  const wrPage =
    designatedListId === 'workflowRules'
      ? (paged.items as readonly WorkflowRuleCandidate[])
      : sortedWrs.slice(0, limit);
  const apPage =
    designatedListId === 'approvalProcesses'
      ? (paged.items as readonly ApprovalProcessCandidate[])
      : sortedAps.slice(0, limit);

  return ok({
    data: {
      // appliedScope FIRST + only when scoped, so a bare call omits the whole
      // block and its serialized response stays byte-identical to pre-fix.
      ...(scope !== null
        ? { appliedScope: { object: scope.componentId, mode: 'component' as const } }
        : {}),
      processBuilders: pbPage,
      workflowRules: wrPage,
      approvalProcesses: apPage,
      totalProcessBuilders: sortedPbs.length,
      totalWorkflowRules: sortedWrs.length,
      totalApprovalProcesses: sortedAps.length,
      summary: {
        processBuilderRetirementDeadlineNote: PROCESS_BUILDER_RETIREMENT_NOTE,
        workflowRuleRetirementDeadlineNote: WORKFLOW_RULE_RETIREMENT_NOTE,
      },
      boundaries: BOUNDARIES,
      truncated,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(scanTruncated ? { scanTruncated: true, trueTypeCounts } : {}),
      ...(emitCursor
        ? {
            nextCursor: paged.pageInfo.nextCursor as string,
            pageInfo: paged.pageInfo,
            designatedList: paged.listId,
            otherSections: paged.otherSections,
          }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
